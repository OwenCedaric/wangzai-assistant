param(
    [string]$Version = '1.0.3-beta.1',
    [string]$ServerUrl = 'https://license.example.invalid:10000',
    [string]$CoreServerUrl = 'https://license.example.invalid:10001',
    [string]$ReleaseTag = '20260820-thin'
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
throw '旧 1.0.3 测试构建已废弃：它会把 local-api 源码和服务端用户 SQLite 架构带回发布物。请改用 build-test-release-v2.ps1。'
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$managementRoot = 'C:\MANAGEMENT'
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $workspaceRoot "artifacts\test-release-$ReleaseTag"))
$artifactsRoot = [IO.Path]::GetFullPath((Join-Path $workspaceRoot 'artifacts'))
$stageRoot = [IO.Path]::GetFullPath((Join-Path $artifactsRoot ".test-release-stage-$ReleaseTag"))
$stageDesktop = Join-Path $stageRoot 'desktop'
$stageFrontend = Join-Path $stageRoot 'frontend'
$publicBundle = Join-Path $managementRoot 'test-runtime\public-bundle'
$credentials = Join-Path $managementRoot 'test-runtime\private\tester-accounts.csv'
$coreConfigPath = Join-Path $workspaceRoot 'artifacts\test-core-runtime\private\test-core.config.json'

if (
    -not $releaseRoot.StartsWith($artifactsRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
    -not $stageRoot.StartsWith($artifactsRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
) {
    throw "测试发布目录越界：$releaseRoot"
}
if (Test-Path -LiteralPath $releaseRoot) {
    Remove-Item -LiteralPath $releaseRoot -Recurse -Force
}
if (Test-Path -LiteralPath $stageRoot) {
    Remove-Item -LiteralPath $stageRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $releaseRoot, $stageDesktop, $stageFrontend | Out-Null

$protectedMetadata = Join-Path $publicBundle 'desktop-protected-compute.json'
if (-not (Test-Path -LiteralPath $protectedMetadata -PathType Leaf)) {
    throw "测试版受保护计算公共包不存在：$protectedMetadata"
}
if (-not (Test-Path -LiteralPath $credentials -PathType Leaf)) {
    throw "测试账号文件不存在：$credentials"
}
if (-not (Test-Path -LiteralPath $coreConfigPath -PathType Leaf)) {
    throw "测试核心服务器配置不存在，请先运行 tools/test-release/start-test-core.ps1：$coreConfigPath"
}
$coreConfig = Get-Content -LiteralPath $coreConfigPath -Raw -Encoding utf8 | ConvertFrom-Json
if ($coreConfig.publicUrl -ne $CoreServerUrl) {
    throw "核心服务器公网地址不匹配：$($coreConfig.publicUrl)"
}
try {
    $coreHealth = Invoke-RestMethod -Uri "$CoreServerUrl/health" -TimeoutSec 15
    if ($coreHealth.ok -ne $true -or $coreHealth.service -ne 'wangzai-test-core-gateway') {
        throw '核心服务器健康响应无效。'
    }
} catch {
    throw "测试核心服务器不可用：$CoreServerUrl；$($_.Exception.Message)"
}

$protected = Get-Content -LiteralPath $protectedMetadata -Raw -Encoding utf8 | ConvertFrom-Json
if ($protected.serverBaseUrl -ne $ServerUrl) {
    throw "公共签名配置地址不匹配：$($protected.serverBaseUrl)"
}

$protectedFiles = @(
    'desktop\package.json',
    'desktop\src\main.js',
    'desktop\resources\distribution.json'
)
$beforeHashes = @{}
foreach ($relative in $protectedFiles) {
    $beforeHashes[$relative] = (Get-FileHash -LiteralPath (Join-Path $workspaceRoot $relative) -Algorithm SHA256).Hash
}

Write-Output '构建当前前端静态包...'
& npm.cmd --prefix (Join-Path $workspaceRoot 'frontend') run build:package
if ($LASTEXITCODE -ne 0) { throw '前端构建失败。' }

$cefRoot = Join-Path $workspaceRoot 'desktop\native\Wangzai.CefBrowserHost'
$cefPublishExe = Join-Path $cefRoot 'publish\Wangzai.CefBrowserHost.exe'
$newestCefSource = Get-ChildItem -LiteralPath $cefRoot -Recurse -File -Include '*.cs', '*.csproj' |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
if (-not (Test-Path -LiteralPath $cefPublishExe) -or (Get-Item -LiteralPath $cefPublishExe).LastWriteTime -lt $newestCefSource.LastWriteTime) {
    Write-Output '构建当前 CEF 原生宿主...'
    & node.exe (Join-Path $workspaceRoot 'desktop\scripts\build-cef-host.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'CEF 原生宿主构建失败。' }
} else {
    Write-Output 'CEF publish 已是当前源码版本，直接用于测试包。'
}

Write-Output '复制测试版独立构建工作区...'
$desktopSource = Join-Path $workspaceRoot 'desktop'
& robocopy.exe $desktopSource $stageDesktop /E /XD node_modules dist /XF '*.log' '*.dmp' | Out-Null
if ($LASTEXITCODE -ge 8) { throw "desktop staging 复制失败：$LASTEXITCODE" }
& robocopy.exe (Join-Path $desktopSource 'node_modules') (Join-Path $stageDesktop 'node_modules') /E /XD '.v8-cache' '.cache' | Out-Null
if ($LASTEXITCODE -ge 8) { throw "desktop node_modules 复制失败：$LASTEXITCODE" }

& robocopy.exe (Join-Path $workspaceRoot 'frontend\dist-package') (Join-Path $stageFrontend 'dist-package') /E | Out-Null
if ($LASTEXITCODE -ge 8) { throw "frontend dist 复制失败：$LASTEXITCODE" }
New-Item -ItemType Directory -Force -Path (Join-Path $stageFrontend 'scripts') | Out-Null
Copy-Item -LiteralPath (Join-Path $workspaceRoot 'frontend\scripts\purchase-search-bridge.mjs') -Destination (Join-Path $stageFrontend 'scripts\purchase-search-bridge.mjs')
& robocopy.exe (Join-Path $workspaceRoot 'frontend\scripts\purchase-bridge') (Join-Path $stageFrontend 'scripts\purchase-bridge') /E | Out-Null
if ($LASTEXITCODE -ge 8) { throw "purchase bridge 复制失败：$LASTEXITCODE" }

$stagePackagePath = Join-Path $stageDesktop 'package.json'
$package = Get-Content -LiteralPath $stagePackagePath -Raw -Encoding utf8 | ConvertFrom-Json
$package.name = 'wangzai-desktop-test'
$package.version = $Version
$package.description = '旺崽助手 Windows 薄客户端测试版（核心业务在服务器执行）'
$package.build.appId = 'com.wangzai.assistant.desktop.test'
$package.build.productName = '旺崽助手测试版'
$package.build.directories.output = 'dist'
$package.build.win.executableName = '旺崽助手测试版'
$package.build.win.target = @([pscustomobject]@{ target = 'portable'; arch = @('x64') })
$package.build.portable.artifactName = '旺崽助手测试版-${version}-便携版-${arch}.${ext}'
$package.build.extraResources = @($package.build.extraResources | Where-Object {
    -not ([string]$_.to).StartsWith('local-api', [StringComparison]::OrdinalIgnoreCase)
})
$package | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $stagePackagePath -Encoding utf8

$stageMainPath = Join-Path $stageDesktop 'src\main.js'
$mainSource = (Get-Content -LiteralPath $stageMainPath -Raw -Encoding utf8) -replace "`r`n", "`n"
$mainSource = $mainSource.Replace(
    'const APP_ID = "com.wangzai.assistant.desktop";',
    'const APP_ID = "com.wangzai.assistant.desktop.test";'
)
$profileAnchor = @'
if (process.env.WANGZAI_DESKTOP_DATA_DIR) {
  app.setPath("userData", path.resolve(process.env.WANGZAI_DESKTOP_DATA_DIR));
}
'@
$profileReplacement = @'
if (app.isPackaged && !process.env.WANGZAI_DESKTOP_DATA_DIR) {
  app.setPath("userData", path.join(app.getPath("appData"), "wangzai-desktop-test"));
}
if (process.env.WANGZAI_DESKTOP_DATA_DIR) {
  app.setPath("userData", path.resolve(process.env.WANGZAI_DESKTOP_DATA_DIR));
}
'@
if (-not $mainSource.Contains($profileAnchor)) {
    throw '测试版 profile 隔离插入点不存在。'
}
$mainSource = $mainSource.Replace($profileAnchor, $profileReplacement)
Set-Content -LiteralPath $stageMainPath -Value $mainSource -Encoding utf8

$originalDistribution = Get-Content -LiteralPath (Join-Path $workspaceRoot 'desktop\resources\distribution.json') -Raw -Encoding utf8 | ConvertFrom-Json
$configureArgs = @(
    (Join-Path $stageDesktop 'scripts\configure-distribution.mjs'),
    '--mode=enforce',
    "--server=$ServerUrl",
    '--project=wangzai_desktop',
    '--no-channel',
    "--campaign=closed-beta-$ReleaseTag",
    "--key-sha256=$($originalDistribution.offline_key_sha256)",
    '--issuer=license-center',
    '--audience=license-center-clients',
    "--protected-bundle=$publicBundle",
    '--protected-config-key-id=protected-compute-config-v1'
)
& node.exe @configureArgs
if ($LASTEXITCODE -ne 0) { throw '测试版 License 分发配置失败。' }
$stageDistributionPath = Join-Path $stageDesktop 'resources\distribution.json'
$stageDistribution = Get-Content -LiteralPath $stageDistributionPath -Raw -Encoding utf8 | ConvertFrom-Json
$stageDistribution | Add-Member -NotePropertyName thin_client -NotePropertyValue $true -Force
$stageDistribution | Add-Member -NotePropertyName core_service_url -NotePropertyValue $CoreServerUrl -Force
$stageDistribution | Add-Member -NotePropertyName core_client_id -NotePropertyValue ([string]$coreConfig.clientId) -Force
$stageDistribution | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $stageDistributionPath -Encoding utf8

Push-Location $stageDesktop
try {
    & node.exe scripts\seal-license-manifest.mjs
    if ($LASTEXITCODE -ne 0) { throw '测试版 License manifest 封装失败。' }
    & node.exe --check src\main.js
    if ($LASTEXITCODE -ne 0) { throw '测试版主进程语法检查失败。' }
    & .\node_modules\.bin\electron-builder.cmd --win portable --x64
    if ($LASTEXITCODE -ne 0) { throw '测试版便携包构建失败。' }
    $unpackedResources = Join-Path $stageDesktop 'dist\win-unpacked\resources'
    if (Test-Path -LiteralPath (Join-Path $unpackedResources 'local-api')) {
        throw '薄客户端错误携带了 local-api 业务源码。'
    }
    $asarList = & .\node_modules\.bin\asar.cmd list (Join-Path $unpackedResources 'app.asar')
    if ($LASTEXITCODE -ne 0) { throw '无法检查薄客户端 app.asar。' }
    if ($asarList -match '(?i)local-api[\\/]|test-core-gateway|server-execution') {
        throw '薄客户端 app.asar 检测到服务器业务实现。'
    }
    $sourceMaps = Get-ChildItem -LiteralPath (Join-Path $stageDesktop 'dist\win-unpacked') -Recurse -File -Filter '*.map'
    if ($sourceMaps) { throw '薄客户端仍携带 source map。' }
    $smokeData = Join-Path $stageRoot 'thin-smoke-profile'
    New-Item -ItemType Directory -Force -Path $smokeData | Out-Null
    $previousDataDir = $env:WANGZAI_DESKTOP_DATA_DIR
    $previousBridgePort = $env:PURCHASE_SEARCH_BRIDGE_PORT
    try {
        $env:WANGZAI_DESKTOP_DATA_DIR = $smokeData
        $env:PURCHASE_SEARCH_BRIDGE_PORT = '3898'
        $smokeExe = Join-Path $stageDesktop 'dist\win-unpacked\旺崽助手测试版.exe'
        $smoke = Start-Process -FilePath $smokeExe -ArgumentList '--smoke-test' -WindowStyle Hidden -PassThru
        if (-not $smoke.WaitForExit(120000)) {
            Stop-Process -Id $smoke.Id -Force -ErrorAction SilentlyContinue
            throw '薄客户端启动验收超时。'
        }
        if ($smoke.ExitCode -ne 0) { throw "薄客户端启动验收失败：$($smoke.ExitCode)" }
    } finally {
        $env:WANGZAI_DESKTOP_DATA_DIR = $previousDataDir
        $env:PURCHASE_SEARCH_BRIDGE_PORT = $previousBridgePort
    }
} finally {
    Pop-Location
}

$portable = Get-ChildItem -LiteralPath (Join-Path $stageDesktop 'dist') -File -Filter '*.exe' |
    Where-Object { $_.Name -like '*便携版*' } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
if (-not $portable) { throw '没有找到测试版便携包。' }
$releaseBinary = Join-Path $releaseRoot $portable.Name
Copy-Item -LiteralPath $portable.FullName -Destination $releaseBinary
Copy-Item -LiteralPath $credentials -Destination (Join-Path $releaseRoot '测试账号-请拆分发送.csv')

$notes = @"
旺崽助手测试版 $Version

服务器：本机独立测试服务器
公网地址：$ServerUrl
测试数据库：独立副本，不连接开发数据库
测试版数据目录：%APPDATA%\wangzai-desktop-test

发送测试人员：
1. 发送便携版 EXE。
2. 从“测试账号-请拆分发送.csv”每人分配一行账号，不要把整张表群发。
3. 你的电脑必须保持开机、联网，Tailscale 与测试服务器必须运行。
4. 测试版初始无店铺、无设备、无订单、无浏览器登录状态。
5. 核心业务源码只部署在服务器；客户端包不含 local-api/src。
6. 页面响应缓存按测试账号隔离保存在测试人员自己的 %APPDATA%\wangzai-desktop-test\thin-client-cache。
7. 以前发出的测试账号继续使用同一测试授权数据库，无需重新注册或重新激活。
"@
Set-Content -LiteralPath (Join-Path $releaseRoot '测试说明.txt') -Value $notes -Encoding utf8
$hash = Get-FileHash -LiteralPath $releaseBinary -Algorithm SHA256
Set-Content -LiteralPath (Join-Path $releaseRoot 'SHA256.txt') -Value "$($hash.Hash)  $($portable.Name)" -Encoding utf8

foreach ($relative in $protectedFiles) {
    $after = (Get-FileHash -LiteralPath (Join-Path $workspaceRoot $relative) -Algorithm SHA256).Hash
    if ($after -ne $beforeHashes[$relative]) {
        throw "开发版文件被构建流程修改：$relative"
    }
}

Write-Output "测试版完成：$releaseBinary"
Write-Output "SHA256：$($hash.Hash)"

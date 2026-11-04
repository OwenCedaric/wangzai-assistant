param(
  [string]$ProfileDirectory = "",
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$NodeArguments
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

if ([string]::IsNullOrWhiteSpace($ProfileDirectory)) {
  $ProfileDirectory = Join-Path $env:APPDATA "wangzai-desktop"
}
$profileRoot = [IO.Path]::GetFullPath($ProfileDirectory)
$localStatePath = Join-Path $profileRoot "Local State"
$sessionPath = Join-Path $profileRoot "license\license-session.bin"
if (-not (Test-Path -LiteralPath $localStatePath) -or -not (Test-Path -LiteralPath $sessionPath)) {
  throw "当前桌面账号资料不完整，请先保持软件登录。"
}

$localState = Get-Content -LiteralPath $localStatePath -Encoding utf8 -Raw | ConvertFrom-Json
$wrappedKey = [Convert]::FromBase64String([string]$localState.os_crypt.encrypted_key)
if ($wrappedKey.Length -le 5 -or [Text.Encoding]::ASCII.GetString($wrappedKey, 0, 5) -ne "DPAPI") {
  throw "当前设备的安全存储主密钥格式无效。"
}
$protectedKey = $wrappedKey[5..($wrappedKey.Length - 1)]
$masterKey = [Security.Cryptography.ProtectedData]::Unprotect(
  $protectedKey,
  $null,
  [Security.Cryptography.DataProtectionScope]::CurrentUser
)
$blob = [IO.File]::ReadAllBytes($sessionPath)
if ($blob.Length -le 31 -or [Text.Encoding]::ASCII.GetString($blob, 0, 3) -ne "v10") {
  throw "当前桌面授权会话格式无效。"
}
$nonce = $blob[3..14]
$ciphertext = $blob[15..($blob.Length - 17)]
$tag = $blob[($blob.Length - 16)..($blob.Length - 1)]
$plaintext = New-Object byte[] $ciphertext.Length
$aes = [Security.Cryptography.AesGcm]::new($masterKey, 16)
$aes.Decrypt($nonce, $ciphertext, $tag, $plaintext, $null)
$session = [Text.Encoding]::UTF8.GetString($plaintext) | ConvertFrom-Json
$token = [string]$session.licenseAccessToken
if ([string]::IsNullOrWhiteSpace($token)) {
  throw "当前桌面登录没有可用的受保护计算授权，请先保持软件登录。"
}

$previousToken = $env:WANGZAI_PROTECTED_COMPUTE_ACCESS_TOKEN
$previousScope = $env:WANGZAI_PROTECTED_COMPUTE_USER_SCOPE
$previousDataDirectory = $env:WANGZAI_DESKTOP_DATA_DIR
try {
  $env:WANGZAI_PROTECTED_COMPUTE_ACCESS_TOKEN = $token
  $env:WANGZAI_PROTECTED_COMPUTE_USER_SCOPE = [string]($session.user.id ?? $session.user.email ?? "authenticated-user")
  $env:WANGZAI_DESKTOP_DATA_DIR = $profileRoot
  & node (Join-Path $PSScriptRoot "verify-live-collection-pricing.mjs") @NodeArguments
  exit $LASTEXITCODE
}
finally {
  $env:WANGZAI_PROTECTED_COMPUTE_ACCESS_TOKEN = $previousToken
  $env:WANGZAI_PROTECTED_COMPUTE_USER_SCOPE = $previousScope
  $env:WANGZAI_DESKTOP_DATA_DIR = $previousDataDirectory
  [Array]::Clear($masterKey, 0, $masterKey.Length)
  [Array]::Clear($plaintext, 0, $plaintext.Length)
  $token = ""
}

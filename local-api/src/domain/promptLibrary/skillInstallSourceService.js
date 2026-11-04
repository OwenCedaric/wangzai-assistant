import { createHash } from "node:crypto";
import path from "node:path";

const { posix } = path;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_SKILL_BYTES = 256 * 1024;
const MAX_REFERENCE_BYTES = 160 * 1024;
const MAX_PACKAGE_BYTES = 1024 * 1024;
const MAX_REFERENCE_FILES = 24;
const READABLE_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
]);
const EXECUTABLE_EXTENSIONS = new Set([
  ".bat",
  ".cmd",
  ".com",
  ".exe",
  ".js",
  ".mjs",
  ".ps1",
  ".py",
  ".sh",
]);

function skillInstallError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function cleanSegment(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized || !/^[A-Za-z0-9._-]+$/u.test(normalized)) {
    throw skillInstallError("SKILL_INSTALL_URL_INVALID", `${label}不正确。`);
  }
  return normalized;
}

function cleanRepositoryPath(value = "") {
  const decoded = String(value || "")
    .split("/")
    .map((segment) => decodeURIComponent(segment))
    .filter(Boolean)
    .join("/");
  const normalized = posix.normalize(decoded || ".").replace(/^\.\//u, "");
  if (normalized === ".") return "";
  if (
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    posix.isAbsolute(normalized)
  ) {
    throw skillInstallError(
      "SKILL_INSTALL_URL_INVALID",
      "Skill 仓库路径不正确。",
    );
  }
  return normalized;
}

export function parseGitHubSkillUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw skillInstallError(
      "SKILL_INSTALL_URL_INVALID",
      "Skill 链接格式不正确。",
    );
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw skillInstallError(
      "SKILL_INSTALL_URL_INVALID",
      "Skill 链接必须使用不含账号信息的 HTTPS 地址。",
    );
  }

  const parts = url.pathname.split("/").filter(Boolean);
  let owner;
  let repository;
  let ref = "";
  let packagePath = "";
  let skillPath = "";

  if (url.hostname.toLowerCase() === "github.com") {
    if (parts.length < 2)
      throw skillInstallError(
        "SKILL_INSTALL_URL_INVALID",
        "GitHub Skill 链接缺少仓库名。",
      );
    owner = cleanSegment(parts[0], "GitHub 用户名");
    repository = cleanSegment(
      parts[1].replace(/\.git$/iu, ""),
      "GitHub 仓库名",
    );
    if (parts[2] === "tree") {
      ref = cleanSegment(parts[3], "GitHub 分支");
      packagePath = cleanRepositoryPath(parts.slice(4).join("/"));
    } else if (parts[2] === "blob") {
      ref = cleanSegment(parts[3], "GitHub 分支");
      skillPath = cleanRepositoryPath(parts.slice(4).join("/"));
      if (posix.basename(skillPath).toLowerCase() !== "skill.md") {
        throw skillInstallError(
          "SKILL_INSTALL_URL_INVALID",
          "链接必须指向 Skill 仓库、目录或 SKILL.md。",
        );
      }
      packagePath =
        posix.dirname(skillPath) === "." ? "" : posix.dirname(skillPath);
    } else if (parts.length > 2) {
      throw skillInstallError(
        "SKILL_INSTALL_URL_INVALID",
        "暂不支持这个 GitHub 仓库地址格式。",
      );
    }
  } else if (url.hostname.toLowerCase() === "raw.githubusercontent.com") {
    if (parts.length < 4)
      throw skillInstallError(
        "SKILL_INSTALL_URL_INVALID",
        "SKILL.md 原始链接不完整。",
      );
    owner = cleanSegment(parts[0], "GitHub 用户名");
    repository = cleanSegment(parts[1], "GitHub 仓库名");
    ref = cleanSegment(parts[2], "GitHub 分支");
    skillPath = cleanRepositoryPath(parts.slice(3).join("/"));
    if (posix.basename(skillPath).toLowerCase() !== "skill.md") {
      throw skillInstallError(
        "SKILL_INSTALL_URL_INVALID",
        "原始链接必须指向 SKILL.md。",
      );
    }
    packagePath =
      posix.dirname(skillPath) === "." ? "" : posix.dirname(skillPath);
  } else {
    throw skillInstallError(
      "SKILL_INSTALL_URL_INVALID",
      "目前只支持 GitHub Skill 链接。",
    );
  }

  return {
    owner,
    repository,
    ref,
    packagePath,
    skillPath: skillPath || posix.join(packagePath, "SKILL.md"),
    sourceUrl: `https://github.com/${owner}/${repository}${packagePath ? `/tree/${ref || "main"}/${packagePath}` : ""}`,
  };
}

function requestHeaders() {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "Wangzai-Skill-Installer/1.0",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function fetchText(fetchImpl, url, { timeoutMs, maximumBytes, label }) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: requestHeaders(),
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      if (attempt < 3) continue;
      throw skillInstallError(
        "SKILL_INSTALL_SOURCE_UNAVAILABLE",
        `${label}下载失败，请检查网络后重试。`,
      );
    }
    if (!response?.ok) {
      const status = Number(response?.status) || 0;
      if ([408, 425, 429].includes(status) || status >= 500) {
        if (attempt < 3) continue;
      }
      const code =
        status === 404
          ? "SKILL_INSTALL_NOT_FOUND"
          : "SKILL_INSTALL_SOURCE_UNAVAILABLE";
      throw skillInstallError(
        code,
        status === 404 ? `${label}不存在。` : `${label}暂时无法下载。`,
      );
    }
    const content = await response.text();
    if (Buffer.byteLength(content, "utf8") > maximumBytes) {
      throw skillInstallError(
        "SKILL_INSTALL_PACKAGE_TOO_LARGE",
        `${label}体积过大，已停止安装。`,
      );
    }
    return content;
  }
  throw skillInstallError(
    "SKILL_INSTALL_SOURCE_UNAVAILABLE",
    `${label}暂时无法下载。`,
  );
}

async function fetchJson(fetchImpl, url, options) {
  const text = await fetchText(fetchImpl, url, options);
  try {
    return JSON.parse(text);
  } catch {
    throw skillInstallError(
      "SKILL_INSTALL_SOURCE_INVALID",
      `${options.label}返回格式不正确。`,
    );
  }
}

function rawFileUrl(source, ref, filePath) {
  return `https://raw.githubusercontent.com/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repository)}/${encodeURIComponent(ref)}/${filePath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

function packageRelativePath(filePath, packagePath) {
  if (!packagePath) return filePath;
  return filePath.startsWith(`${packagePath}/`)
    ? filePath.slice(packagePath.length + 1)
    : "";
}

function extractRelativeMarkdownLinks(markdown, skillPath) {
  const basePath = posix.dirname(skillPath);
  return [
    ...String(markdown || "").matchAll(
      /\]\((?!https?:|#|mailto:)([^)#?]+\.(?:md|markdown))(?:#[^)]+)?\)/giu,
    ),
  ]
    .map((match) => cleanRepositoryPath(posix.join(basePath, match[1])))
    .filter(Boolean);
}

function packageDigest(markdown, referenceFiles) {
  const hash = createHash("sha256");
  hash.update(markdown, "utf8");
  referenceFiles.forEach((file) => {
    hash.update(`\n${file.path}\n`, "utf8");
    hash.update(file.content, "utf8");
  });
  return hash.digest("hex");
}

export function createSkillInstallSourceService({
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== "function")
    throw new TypeError("fetchImpl is required");

  return {
    async resolve(input = {}) {
      const parsed = parseGitHubSkillUrl(input.url);
      let ref = parsed.ref;
      if (!ref) {
        const repository = await fetchJson(
          fetchImpl,
          `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repository)}`,
          { timeoutMs, maximumBytes: 128 * 1024, label: "GitHub 仓库信息" },
        );
        ref = cleanSegment(
          repository?.default_branch || "main",
          "GitHub 默认分支",
        );
      }

      const skillPath = parsed.skillPath;
      const markdown = await fetchText(
        fetchImpl,
        rawFileUrl(parsed, ref, skillPath),
        {
          timeoutMs,
          maximumBytes: MAX_SKILL_BYTES,
          label: "SKILL.md",
        },
      );
      if (!/^---[\s\S]*?\n---/u.test(markdown) || !/^#\s+/mu.test(markdown)) {
        throw skillInstallError(
          "SKILL_INSTALL_SOURCE_INVALID",
          "SKILL.md 缺少基础说明，无法安全安装。",
        );
      }

      let manifest = [];
      try {
        const tree = await fetchJson(
          fetchImpl,
          `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repository)}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
          { timeoutMs, maximumBytes: 2 * 1024 * 1024, label: "Skill 文件清单" },
        );
        manifest = (Array.isArray(tree?.tree) ? tree.tree : [])
          .filter((item) => item?.type === "blob")
          .map((item) => ({
            path: cleanRepositoryPath(item.path),
            size: Number(item.size) || 0,
            sha: String(item.sha || ""),
          }))
          .filter(
            (item) =>
              !parsed.packagePath ||
              item.path.startsWith(`${parsed.packagePath}/`),
          );
      } catch (error) {
        if (!String(error?.code || "").startsWith("SKILL_INSTALL_"))
          throw error;
        manifest = [];
      }

      const linkedFiles = extractRelativeMarkdownLinks(markdown, skillPath);
      const readableManifestFiles = manifest
        .filter((item) => item.path !== skillPath)
        .filter((item) =>
          READABLE_EXTENSIONS.has(posix.extname(item.path).toLowerCase()),
        )
        .filter((item) => item.size <= MAX_REFERENCE_BYTES)
        .slice(0, MAX_REFERENCE_FILES)
        .map((item) => item.path);
      const referencePaths = [
        ...new Set([...linkedFiles, ...readableManifestFiles]),
      ]
        .filter((filePath) => filePath !== skillPath)
        .slice(0, MAX_REFERENCE_FILES);

      const linkedFileSet = new Set(linkedFiles);
      const referenceFiles = [];
      const missingRequiredReferences = [];
      for (let start = 0; start < referencePaths.length; start += 4) {
        const batch = referencePaths.slice(start, start + 4);
        const settledBatch = await Promise.allSettled(
          batch.map(async (filePath) => ({
            path: packageRelativePath(filePath, parsed.packagePath) || filePath,
            content: await fetchText(
              fetchImpl,
              rawFileUrl(parsed, ref, filePath),
              {
                timeoutMs,
                maximumBytes: MAX_REFERENCE_BYTES,
                label: filePath,
              },
            ),
          })),
        );
        settledBatch.forEach((result, index) => {
          if (result.status === "fulfilled") referenceFiles.push(result.value);
          else if (linkedFileSet.has(batch[index]))
            missingRequiredReferences.push(batch[index]);
        });
      }
      if (missingRequiredReferences.length) {
        throw skillInstallError(
          "SKILL_INSTALL_REFERENCE_MISSING",
          `Skill 必需引用文件没有完整下载：${missingRequiredReferences.join("、")}。`,
        );
      }
      const totalBytes =
        Buffer.byteLength(markdown, "utf8") +
        referenceFiles.reduce(
          (sum, file) => sum + Buffer.byteLength(file.content, "utf8"),
          0,
        );
      if (totalBytes > MAX_PACKAGE_BYTES) {
        throw skillInstallError(
          "SKILL_INSTALL_PACKAGE_TOO_LARGE",
          "Skill 文档包体积过大，已停止安装。",
        );
      }

      const executableFiles = manifest
        .map(
          (item) =>
            packageRelativePath(item.path, parsed.packagePath) || item.path,
        )
        .filter((filePath) =>
          EXECUTABLE_EXTENSIONS.has(posix.extname(filePath).toLowerCase()),
        );

      return {
        ok: true,
        source: {
          fileName: "SKILL.md",
          installType: "github-skill",
          sourceUrl: parsed.sourceUrl.replace("/tree/main/", `/tree/${ref}/`),
          repository: `${parsed.owner}/${parsed.repository}`,
          ref,
          packagePath: parsed.packagePath,
          markdown,
          referenceFiles,
          manifest: manifest.map((item) => ({
            path:
              packageRelativePath(item.path, parsed.packagePath) || item.path,
            size: item.size,
            sha: item.sha,
          })),
          executableFiles,
          sourceHash: packageDigest(markdown, referenceFiles),
        },
      };
    },
  };
}

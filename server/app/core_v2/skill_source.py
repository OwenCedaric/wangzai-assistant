from __future__ import annotations

import hashlib
import json
import posixpath
import re
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import quote, unquote, urlparse

import httpx

MAX_SKILL_BYTES = 256 * 1024
MAX_REFERENCE_BYTES = 160 * 1024
MAX_PACKAGE_BYTES = 1024 * 1024
MAX_REFERENCE_FILES = 24
READABLE_EXTENSIONS = {".md", ".markdown", ".txt", ".json", ".yaml", ".yml"}
EXECUTABLE_EXTENSIONS = {".bat", ".cmd", ".com", ".exe", ".js", ".mjs", ".ps1", ".py", ".sh"}
RETRYABLE_STATUSES = {408, 425, 429}


@dataclass(slots=True)
class SkillSourceFailure(Exception):
    code: str
    message: str
    status_code: int = 400

    def __str__(self) -> str:
        return self.message


def _fail(code: str, message: str, status_code: int = 400) -> SkillSourceFailure:
    return SkillSourceFailure(code=code, message=message, status_code=status_code)


def _segment(value: str, label: str) -> str:
    normalized = str(value or "").strip()
    if not normalized or re.fullmatch(r"[A-Za-z0-9._-]+", normalized) is None:
        raise _fail("SKILL_INSTALL_URL_INVALID", f"{label}不正确。")
    return normalized


def _repository_path(value: str) -> str:
    try:
        decoded = "/".join(unquote(part) for part in str(value or "").split("/") if part)
    except ValueError as exc:
        raise _fail("SKILL_INSTALL_URL_INVALID", "Skill 仓库路径不正确。") from exc
    normalized = posixpath.normpath(decoded or ".").removeprefix("./")
    if normalized == ".":
        return ""
    if (
        normalized == ".."
        or normalized.startswith("../")
        or "/../" in normalized
        or normalized.startswith("/")
    ):
        raise _fail("SKILL_INSTALL_URL_INVALID", "Skill 仓库路径不正确。")
    return normalized


def parse_github_skill_url(value: str) -> dict[str, str]:
    parsed_url = urlparse(str(value or "").strip())
    if parsed_url.scheme != "https" or parsed_url.username or parsed_url.password:
        raise _fail("SKILL_INSTALL_URL_INVALID", "Skill 链接必须使用不含账号信息的 HTTPS 地址。")
    parts = [part for part in parsed_url.path.split("/") if part]
    host = (parsed_url.hostname or "").lower()
    ref = ""
    package_path = ""
    skill_path = ""
    if host == "github.com":
        if len(parts) < 2:
            raise _fail("SKILL_INSTALL_URL_INVALID", "GitHub Skill 链接缺少仓库名。")
        owner = _segment(parts[0], "GitHub 用户名")
        repository = _segment(re.sub(r"\.git$", "", parts[1], flags=re.I), "GitHub 仓库名")
        if len(parts) > 2 and parts[2] == "tree":
            if len(parts) < 4:
                raise _fail("SKILL_INSTALL_URL_INVALID", "GitHub 分支不正确。")
            ref = _segment(parts[3], "GitHub 分支")
            package_path = _repository_path("/".join(parts[4:]))
        elif len(parts) > 2 and parts[2] == "blob":
            if len(parts) < 5:
                raise _fail("SKILL_INSTALL_URL_INVALID", "GitHub Skill 文件地址不完整。")
            ref = _segment(parts[3], "GitHub 分支")
            skill_path = _repository_path("/".join(parts[4:]))
            if PurePosixPath(skill_path).name.lower() != "skill.md":
                raise _fail(
                    "SKILL_INSTALL_URL_INVALID", "链接必须指向 Skill 仓库、目录或 SKILL.md。"
                )
            parent = str(PurePosixPath(skill_path).parent)
            package_path = "" if parent == "." else parent
        elif len(parts) > 2:
            raise _fail("SKILL_INSTALL_URL_INVALID", "暂不支持这个 GitHub 仓库地址格式。")
    elif host == "raw.githubusercontent.com":
        if len(parts) < 4:
            raise _fail("SKILL_INSTALL_URL_INVALID", "SKILL.md 原始链接不完整。")
        owner = _segment(parts[0], "GitHub 用户名")
        repository = _segment(parts[1], "GitHub 仓库名")
        ref = _segment(parts[2], "GitHub 分支")
        skill_path = _repository_path("/".join(parts[3:]))
        if PurePosixPath(skill_path).name.lower() != "skill.md":
            raise _fail("SKILL_INSTALL_URL_INVALID", "原始链接必须指向 SKILL.md。")
        parent = str(PurePosixPath(skill_path).parent)
        package_path = "" if parent == "." else parent
    else:
        raise _fail("SKILL_INSTALL_URL_INVALID", "目前只支持 GitHub Skill 链接。")
    return {
        "owner": owner,
        "repository": repository,
        "ref": ref,
        "package_path": package_path,
        "skill_path": skill_path or posixpath.join(package_path, "SKILL.md"),
    }


def _headers() -> dict[str, str]:
    return {
        "Accept": "application/vnd.github+json",
        "User-Agent": "Wangzai-Skill-Installer/2.0",
        "X-GitHub-Api-Version": "2022-11-28",
    }


def _text(client: httpx.Client, url: str, maximum_bytes: int, label: str) -> str:
    for attempt in range(3):
        try:
            response = client.get(url, headers=_headers(), follow_redirects=True)
        except (httpx.TimeoutException, httpx.NetworkError) as exc:
            if attempt < 2:
                continue
            raise _fail(
                "SKILL_INSTALL_SOURCE_UNAVAILABLE", f"{label}下载失败，请检查网络后重试。", 502
            ) from exc
        if not response.is_success:
            if (
                response.status_code in RETRYABLE_STATUSES or response.status_code >= 500
            ) and attempt < 2:
                continue
            if response.status_code == 404:
                raise _fail("SKILL_INSTALL_NOT_FOUND", f"{label}不存在。", 404)
            raise _fail("SKILL_INSTALL_SOURCE_UNAVAILABLE", f"{label}暂时无法下载。", 502)
        content = response.content
        if len(content) > maximum_bytes:
            raise _fail("SKILL_INSTALL_PACKAGE_TOO_LARGE", f"{label}体积过大，已停止安装。")
        try:
            return content.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise _fail("SKILL_INSTALL_SOURCE_INVALID", f"{label}不是 UTF-8 文本。") from exc
    raise _fail("SKILL_INSTALL_SOURCE_UNAVAILABLE", f"{label}暂时无法下载。", 502)


def _json(client: httpx.Client, url: str, maximum_bytes: int, label: str) -> dict[str, Any]:
    try:
        value = json.loads(_text(client, url, maximum_bytes, label))
    except json.JSONDecodeError as exc:
        raise _fail("SKILL_INSTALL_SOURCE_INVALID", f"{label}返回格式不正确。") from exc
    if not isinstance(value, dict):
        raise _fail("SKILL_INSTALL_SOURCE_INVALID", f"{label}返回格式不正确。")
    return value


def _raw_url(source: dict[str, str], ref: str, file_path: str) -> str:
    encoded_path = "/".join(quote(part, safe="") for part in file_path.split("/"))
    repository_root = (
        f"https://raw.githubusercontent.com/{quote(source['owner'], safe='')}"
        f"/{quote(source['repository'], safe='')}"
    )
    return f"{repository_root}/{quote(ref, safe='')}/{encoded_path}"


def _repository_api_url(source: dict[str, str]) -> str:
    return (
        f"https://api.github.com/repos/{quote(source['owner'], safe='')}"
        f"/{quote(source['repository'], safe='')}"
    )


def _package_relative(file_path: str, package_path: str) -> str:
    prefix = f"{package_path}/" if package_path else ""
    return file_path[len(prefix) :] if prefix and file_path.startswith(prefix) else file_path


def _markdown_links(markdown: str, skill_path: str) -> list[str]:
    base = posixpath.dirname(skill_path)
    matches = re.findall(
        r"\]\((?!https?:|#|mailto:)([^)#?]+\.(?:md|markdown))(?:#[^)]+)?\)", markdown, flags=re.I
    )
    return [_repository_path(posixpath.join(base, item)) for item in matches]


def resolve_github_skill_source(
    payload: object,
    *,
    client: httpx.Client | None = None,
    timeout_seconds: float = 20.0,
) -> dict[str, Any]:
    source_url = str(payload.get("url") if isinstance(payload, dict) else "")
    source = parse_github_skill_url(source_url)
    owns_client = client is None
    active = client or httpx.Client(timeout=httpx.Timeout(timeout_seconds))
    try:
        ref = source["ref"]
        if not ref:
            repository = _json(
                active,
                _repository_api_url(source),
                128 * 1024,
                "GitHub 仓库信息",
            )
            ref = _segment(str(repository.get("default_branch") or "main"), "GitHub 默认分支")
        markdown = _text(
            active, _raw_url(source, ref, source["skill_path"]), MAX_SKILL_BYTES, "SKILL.md"
        )
        if (
            re.match(r"^---[\s\S]*?\n---", markdown) is None
            or re.search(r"^#\s+", markdown, flags=re.M) is None
        ):
            raise _fail("SKILL_INSTALL_SOURCE_INVALID", "SKILL.md 缺少基础说明，无法安全安装。")
        manifest: list[dict[str, Any]] = []
        try:
            tree = _json(
                active,
                f"{_repository_api_url(source)}/git/trees/{quote(ref, safe='')}?recursive=1",
                2 * 1024 * 1024,
                "Skill 文件清单",
            )
            for item in tree.get("tree") if isinstance(tree.get("tree"), list) else []:
                if not isinstance(item, dict) or item.get("type") != "blob":
                    continue
                file_path = _repository_path(str(item.get("path") or ""))
                if source["package_path"] and not file_path.startswith(
                    f"{source['package_path']}/"
                ):
                    continue
                manifest.append(
                    {
                        "path": file_path,
                        "size": int(item.get("size") or 0),
                        "sha": str(item.get("sha") or ""),
                    }
                )
        except SkillSourceFailure:
            manifest = []
        linked = _markdown_links(markdown, source["skill_path"])
        readable = [
            item["path"]
            for item in manifest
            if item["path"] != source["skill_path"]
            and PurePosixPath(item["path"]).suffix.lower() in READABLE_EXTENSIONS
            and item["size"] <= MAX_REFERENCE_BYTES
        ][:MAX_REFERENCE_FILES]
        reference_paths = list(dict.fromkeys([*linked, *readable]))[:MAX_REFERENCE_FILES]
        reference_files: list[dict[str, str]] = []
        missing_required: list[str] = []
        linked_set = set(linked)
        for file_path in reference_paths:
            try:
                content = _text(
                    active, _raw_url(source, ref, file_path), MAX_REFERENCE_BYTES, file_path
                )
                reference_files.append(
                    {
                        "path": _package_relative(file_path, source["package_path"]),
                        "content": content,
                    }
                )
            except SkillSourceFailure:
                if file_path in linked_set:
                    missing_required.append(file_path)
        if missing_required:
            raise _fail(
                "SKILL_INSTALL_REFERENCE_MISSING",
                f"Skill 必需引用文件没有完整下载：{'、'.join(missing_required)}。",
            )
        total_bytes = len(markdown.encode("utf-8")) + sum(
            len(item["content"].encode("utf-8")) for item in reference_files
        )
        if total_bytes > MAX_PACKAGE_BYTES:
            raise _fail("SKILL_INSTALL_PACKAGE_TOO_LARGE", "Skill 文档包体积过大，已停止安装。")
        digest = hashlib.sha256()
        digest.update(markdown.encode("utf-8"))
        for item in reference_files:
            digest.update(f"\n{item['path']}\n".encode())
            digest.update(item["content"].encode("utf-8"))
        relative_manifest = [
            {
                "path": _package_relative(item["path"], source["package_path"]),
                "size": item["size"],
                "sha": item["sha"],
            }
            for item in manifest
        ]
        executable_files = [
            item["path"]
            for item in relative_manifest
            if PurePosixPath(item["path"]).suffix.lower() in EXECUTABLE_EXTENSIONS
        ]
        canonical_url = f"https://github.com/{source['owner']}/{source['repository']}"
        if source["package_path"]:
            canonical_url += f"/tree/{ref}/{source['package_path']}"
        return {
            "ok": True,
            "source": {
                "fileName": "SKILL.md",
                "installType": "github-skill",
                "sourceUrl": canonical_url,
                "repository": f"{source['owner']}/{source['repository']}",
                "ref": ref,
                "packagePath": source["package_path"],
                "markdown": markdown,
                "referenceFiles": reference_files,
                "manifest": relative_manifest,
                "executableFiles": executable_files,
                "sourceHash": digest.hexdigest(),
            },
        }
    finally:
        if owns_client:
            active.close()

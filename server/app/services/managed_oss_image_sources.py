from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import socket
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from email.utils import format_datetime
from ipaddress import ip_address
from typing import Any
from urllib.parse import quote, urlencode, urljoin, urlsplit

import httpx

from app.config import Settings
from app.models.oss_management import OssManagementConfiguration
from app.services.errors import DomainError
from app.services.oss_management import configuration_object_credentials

MAX_SOURCE_IMAGE_BYTES = 20 * 1024 * 1024
SOURCE_URL_TTL_SECONDS = 15 * 60
TEMPORARY_PREFIX = "wangzai/temp/model-sources/v1"
MAX_SOURCE_REDIRECTS = 3
OSS_UPLOAD_MAX_ATTEMPTS = 3
OSS_UPLOAD_RETRY_DELAYS_SECONDS = (0.2, 0.6)
SUPPORTED_SOURCE_TYPES = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
}


@dataclass(frozen=True, slots=True)
class StagedManagedOssSources:
    urls: list[str]
    object_keys: list[str]


def _decode_data_url(value: str) -> tuple[bytes, str] | None:
    prefixes = {
        f"data:{content_type};base64,": content_type
        for content_type in SUPPORTED_SOURCE_TYPES
    }
    for prefix, content_type in prefixes.items():
        if value.startswith(prefix):
            try:
                data = base64.b64decode(value[len(prefix) :], validate=True)
            except (ValueError, binascii.Error) as exc:
                raise DomainError("参考图片内容无效", status_code=422) from exc
            if not 1 <= len(data) <= MAX_SOURCE_IMAGE_BYTES:
                raise DomainError("参考图片大小不符合要求", status_code=422)
            return data, content_type
    return None


def _safe_segment(value: object, fallback: str) -> str:
    normalized = "".join(
        character
        for character in str(value or "").strip()
        if character.isascii() and (character.isalnum() or character in "_-")
    )[:96]
    return normalized or fallback


def _default_resolver(hostname: str) -> list[str]:
    return sorted(
        {
            row[4][0]
            for row in socket.getaddrinfo(hostname, 443, type=socket.SOCK_STREAM)
        }
    )


def _detect_content_type(data: bytes) -> str:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return ""


class AliyunManagedOssImageSourceStager:
    """Server-only temporary source staging for every account and shop.

    The desktop sends image bytes.  Only this management service owns the OSS
    credentials, creates the regional signed URL consumed by the paid image
    provider, and removes the temporary object after the provider call.
    """

    def __init__(
        self,
        config: OssManagementConfiguration,
        settings: Settings,
        *,
        client: httpx.Client | None = None,
        now: Any = lambda: datetime.now(UTC),
        require_active: bool = True,
        resolver: Any = _default_resolver,
        sleep: Any = time.sleep,
    ) -> None:
        if require_active and config.status != "active":
            raise DomainError("管理端统一OSS尚未验证", status_code=503)
        access_key_id, access_key_secret = configuration_object_credentials(
            config, settings
        )
        endpoint_host = (urlsplit(config.endpoint).hostname or "").lower()
        if not endpoint_host:
            raise DomainError("管理端统一OSS区域地址无效", status_code=503)
        self.config = config
        self.access_key_id = access_key_id
        self.access_key_secret = access_key_secret
        self.regional_host = f"{config.bucket}.{endpoint_host}"
        if self.regional_host not in settings.paid_source_image_allowed_host_set:
            raise DomainError(
                "管理端统一OSS尚未加入图片模型安全白名单，请联系管理员更新服务配置",
                status_code=503,
            )
        self.client = client or httpx.Client(
            timeout=httpx.Timeout(30),
            follow_redirects=False,
            trust_env=False,
        )
        self._owns_client = client is None
        self._now = now
        self._resolver = resolver
        self._sleep = sleep

    def close(self) -> None:
        if self._owns_client:
            self.client.close()

    def _canonical_resource(self, object_key: str) -> str:
        return f"/{self.config.bucket}/{object_key}"

    def _object_url(self, object_key: str) -> str:
        encoded = quote(object_key, safe="/-_.~")
        return f"https://{self.regional_host}/{encoded}"

    def _authorization(
        self,
        method: str,
        object_key: str,
        *,
        content_md5: str = "",
        content_type: str = "",
        date: str,
        oss_headers: dict[str, str] | None = None,
    ) -> str:
        canonical_headers = "".join(
            f"{key.lower()}:{' '.join(str(value).strip().split())}\n"
            for key, value in sorted((oss_headers or {}).items())
            if key.lower().startswith("x-oss-")
        )
        string_to_sign = (
            f"{method}\n{content_md5}\n{content_type}\n{date}\n"
            f"{canonical_headers}{self._canonical_resource(object_key)}"
        )
        signature = base64.b64encode(
            hmac.new(
                self.access_key_secret.encode(),
                string_to_sign.encode(),
                hashlib.sha1,
            ).digest()
        ).decode()
        return f"OSS {self.access_key_id}:{signature}"

    def _put(self, object_key: str, data: bytes, content_type: str) -> None:
        date = format_datetime(self._now().astimezone(UTC), usegmt=True)
        content_md5 = base64.b64encode(hashlib.md5(data).digest()).decode()
        oss_headers = {"x-oss-server-side-encryption": "AES256"}
        headers = {
            "Authorization": self._authorization(
                "PUT",
                object_key,
                content_md5=content_md5,
                content_type=content_type,
                date=date,
                oss_headers=oss_headers,
            ),
            "Cache-Control": "private, max-age=0, no-store",
            "Content-MD5": content_md5,
            "Content-Type": content_type,
            "Date": date,
            **oss_headers,
        }
        last_network_error: Exception | None = None
        for attempt in range(OSS_UPLOAD_MAX_ATTEMPTS):
            try:
                response = self.client.put(self._object_url(object_key), content=data, headers=headers)
            except (httpx.TimeoutException, httpx.NetworkError) as exc:
                last_network_error = exc
                response = None
            if response is not None and response.is_success:
                return
            retryable_status = response is not None and (
                response.status_code in {408, 425, 429} or response.status_code >= 500
            )
            if response is not None and not retryable_status:
                raise DomainError("管理端统一OSS拒绝了参考图上传", status_code=502)
            if attempt + 1 < OSS_UPLOAD_MAX_ATTEMPTS:
                self._sleep(OSS_UPLOAD_RETRY_DELAYS_SECONDS[attempt])
        raise DomainError("管理端统一OSS上传暂时不可用", status_code=503) from last_network_error

    def _delete(self, object_key: str) -> None:
        date = format_datetime(self._now().astimezone(UTC), usegmt=True)
        headers = {
            "Authorization": self._authorization(
                "DELETE", object_key, date=date
            ),
            "Date": date,
        }
        response = self.client.delete(self._object_url(object_key), headers=headers)
        if response.status_code not in {200, 204, 404}:
            raise DomainError("管理端统一OSS临时图片清理失败", status_code=502)

    def _signed_get_url(self, object_key: str) -> str:
        expires = int(self._now().timestamp()) + SOURCE_URL_TTL_SECONDS
        string_to_sign = f"GET\n\n\n{expires}\n{self._canonical_resource(object_key)}"
        signature = base64.b64encode(
            hmac.new(
                self.access_key_secret.encode(),
                string_to_sign.encode(),
                hashlib.sha1,
            ).digest()
        ).decode()
        query = urlencode(
            {
                "OSSAccessKeyId": self.access_key_id,
                "Expires": str(expires),
                "Signature": signature,
            }
        )
        return f"{self._object_url(object_key)}?{query}"

    def _is_managed_signed_url(self, value: str) -> bool:
        parsed = urlsplit(value)
        return (
            parsed.scheme == "https"
            and (parsed.hostname or "").lower() == self.regional_host
            and "OSSAccessKeyId=" in parsed.query
            and "Expires=" in parsed.query
            and "Signature=" in parsed.query
        )

    def _assert_public_source_url(self, value: str) -> str:
        parsed = urlsplit(value)
        try:
            port = parsed.port
        except ValueError as exc:
            raise DomainError("参考图片地址无效", status_code=422) from exc
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or port not in {None, 443}
            or parsed.fragment
        ):
            raise DomainError("参考图片必须使用公开HTTPS地址", status_code=422)
        try:
            addresses = self._resolver(parsed.hostname.lower())
        except (OSError, ValueError) as exc:
            raise DomainError("参考图片地址暂时无法解析", status_code=503) from exc
        if not addresses:
            raise DomainError("参考图片地址暂时无法解析", status_code=503)
        try:
            if any(not ip_address(address).is_global for address in addresses):
                raise DomainError("参考图片不能指向本机或内网", status_code=422)
        except ValueError as exc:
            raise DomainError("参考图片地址无效", status_code=422) from exc
        return value

    def _download_external_source(self, value: str) -> tuple[bytes, str]:
        current = value
        for redirects in range(MAX_SOURCE_REDIRECTS + 1):
            current = self._assert_public_source_url(current)
            try:
                response = self.client.get(current, follow_redirects=False)
            except (httpx.TimeoutException, httpx.NetworkError) as exc:
                raise DomainError("参考图片暂时无法读取", status_code=503) from exc
            if 300 <= response.status_code < 400:
                location = response.headers.get("location", "").strip()
                if not location or redirects >= MAX_SOURCE_REDIRECTS:
                    raise DomainError("参考图片重定向无效", status_code=422)
                current = urljoin(current, location)
                continue
            content_type = response.headers.get("content-type", "").split(";", 1)[0].lower()
            try:
                declared_length = int(
                    response.headers.get("content-length", "0") or "0"
                )
            except ValueError:
                declared_length = MAX_SOURCE_IMAGE_BYTES + 1
            data = response.content
            if (
                not response.is_success
                or content_type not in SUPPORTED_SOURCE_TYPES
                or declared_length > MAX_SOURCE_IMAGE_BYTES
                or not 1 <= len(data) <= MAX_SOURCE_IMAGE_BYTES
                or _detect_content_type(data) != content_type
            ):
                raise DomainError("参考图片格式或大小不符合要求", status_code=422)
            return data, content_type
        raise DomainError("参考图片重定向无效", status_code=422)

    def stage(
        self,
        values: list[str],
        *,
        user_id: int,
        project_id: int,
        shop_id: str,
        request_id: str,
    ) -> StagedManagedOssSources:
        scope_hash = hashlib.sha256(f"{user_id}\0{project_id}".encode()).hexdigest()[:24]
        shop_hash = hashlib.sha256(shop_id.encode()).hexdigest()[:20]
        request_hash = hashlib.sha256(request_id.encode()).hexdigest()[:24]
        date_path = self._now().astimezone(UTC).strftime("%Y/%m/%d")
        urls: list[str] = []
        object_keys: list[str] = []
        try:
            for index, raw in enumerate(values):
                value = str(raw or "").strip()
                decoded = _decode_data_url(value)
                if decoded is None:
                    if self._is_managed_signed_url(value):
                        urls.append(value)
                        continue
                    decoded = self._download_external_source(value)
                data, content_type = decoded
                extension = SUPPORTED_SOURCE_TYPES[content_type]
                content_hash = hashlib.sha256(data).hexdigest()[:24]
                object_key = "/".join(
                    (
                        TEMPORARY_PREFIX,
                        scope_hash,
                        shop_hash,
                        date_path,
                        _safe_segment(request_hash, "request"),
                        f"{index}-{content_hash}.{extension}",
                    )
                )
                self._put(object_key, data, content_type)
                object_keys.append(object_key)
                urls.append(self._signed_get_url(object_key))
            return StagedManagedOssSources(urls=urls, object_keys=object_keys)
        except Exception:
            self.cleanup(object_keys)
            raise

    def cleanup(self, object_keys: list[str]) -> None:
        for object_key in object_keys:
            try:
                self._delete(object_key)
            except DomainError:
                # The object lives under a dedicated temporary prefix. A bucket
                # lifecycle rule remains the final recovery path after a
                # transient delete failure.
                continue

    def verify_read_write_delete(self) -> None:
        pixel = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        )
        staged = self.stage(
            [f"data:image/png;base64,{base64.b64encode(pixel).decode()}"],
            user_id=0,
            project_id=0,
            shop_id="admin-connection-test",
            request_id=f"verify-{self._now().timestamp()}",
        )
        try:
            response = self.client.get(staged.urls[0])
            if not response.is_success or response.content != pixel:
                raise DomainError("管理端统一OSS读写校验失败", status_code=502)
        finally:
            for object_key in staged.object_keys:
                self._delete(object_key)


def build_managed_oss_image_source_stager(
    config: OssManagementConfiguration,
    settings: Settings,
    *,
    client: httpx.Client | None = None,
    require_active: bool = True,
    resolver: Any = _default_resolver,
    sleep: Any = time.sleep,
) -> AliyunManagedOssImageSourceStager:
    return AliyunManagedOssImageSourceStager(
        config,
        settings,
        client=client,
        require_active=require_active,
        resolver=resolver,
        sleep=sleep,
    )

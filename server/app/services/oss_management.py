from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
from collections import defaultdict
from datetime import UTC, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Protocol
from urllib.parse import quote, urlsplit
from uuid import uuid4

import httpx
from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.offline import load_offline_private_key
from app.config import Settings
from app.models.oss_management import OssManagementConfiguration
from app.schemas.oss_management import OssConfigurationUpdate
from app.services.errors import DomainError

ALIYUN_BILLING_ENDPOINT = "https://business.aliyuncs.com/"
ALIYUN_BILLING_VERSION = "2017-12-14"
GIB = Decimal(1024**3)
BUCKET_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$")
REGION_PATTERN = re.compile(r"^oss-[a-z0-9]+(?:-[a-z0-9]+)*$")
ACCELERATE_HOSTS = frozenset(
    {"oss-accelerate.aliyuncs.com", "oss-accelerate-overseas.aliyuncs.com"}
)


class OssUsageClient(Protocol):
    def query_hourly(self, start_time: datetime, end_time: datetime) -> list[dict[str, Any]]: ...


def _percent(value: str) -> str:
    return quote(value, safe="~")


def _encryption_key(settings: Settings) -> bytes:
    if not settings.api_pool_encryption_key:
        raise DomainError("OSS密钥加密尚未配置", status_code=503)
    try:
        return settings.api_pool_encryption_key.encode("ascii")
    except UnicodeEncodeError as exc:
        raise DomainError("OSS密钥加密配置无效", status_code=503) from exc


def _encrypt(settings: Settings, value: str) -> str:
    try:
        return Fernet(_encryption_key(settings)).encrypt(value.encode()).decode("ascii")
    except (TypeError, ValueError) as exc:
        raise DomainError("OSS密钥加密配置无效", status_code=503) from exc


def _decrypt(settings: Settings, value: str) -> str:
    try:
        return Fernet(_encryption_key(settings)).decrypt(value.encode("ascii")).decode()
    except (InvalidToken, UnicodeError, TypeError, ValueError) as exc:
        raise DomainError("OSS密钥无法解密", status_code=503) from exc


def _fingerprint(settings: Settings, access_key_id: str, access_key_secret: str) -> str:
    digest = hmac.new(
        settings.api_pool_fingerprint_secret.encode(),
        f"{access_key_id}\0{access_key_secret}".encode(),
        hashlib.sha256,
    ).hexdigest()
    return f"sha256:{digest}"


def _masked_access_key_id(value: str) -> str:
    if len(value) <= 10:
        return f"••••{value[-4:]}"
    return f"{value[:4]}••••{value[-4:]}"


def _normalize_runtime_region(value: str) -> str:
    region = value.strip().lower()
    if not region.startswith("oss-"):
        region = f"oss-{region}"
    if not REGION_PATTERN.fullmatch(region):
        raise DomainError("OSS地域格式不正确", status_code=422)
    return region


def _billing_region(runtime_region: str) -> str:
    return runtime_region.removeprefix("oss-")


def _normalize_aliyun_endpoint(
    value: str,
    *,
    acceleration: bool = False,
    runtime_region: str | None = None,
) -> str:
    text = value.strip()
    parsed = urlsplit(text)
    host = (parsed.hostname or "").lower()
    if (
        parsed.scheme != "https"
        or not host
        or parsed.username
        or parsed.password
        or parsed.port not in {None, 443}
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise DomainError("OSS地址必须是无路径、无参数的阿里云HTTPS地址", status_code=422)
    if acceleration:
        if host not in ACCELERATE_HOSTS:
            raise DomainError("OSS加速地址必须使用阿里云官方加速域名", status_code=422)
    elif not runtime_region or host != f"{runtime_region}.aliyuncs.com":
        raise DomainError("OSS区域地址必须与所选地域完全一致", status_code=422)
    return f"https://{host}"


def normalize_configuration(payload: OssConfigurationUpdate) -> dict[str, Any]:
    bucket = payload.bucket.strip().lower()
    region = _normalize_runtime_region(payload.region)
    if not BUCKET_PATTERN.fullmatch(bucket):
        raise DomainError("Bucket名称格式不正确", status_code=422)
    accelerate_endpoint = None
    if payload.acceleration_enabled:
        if not payload.accelerate_endpoint:
            raise DomainError("开启传输加速时必须填写加速地址", status_code=422)
        accelerate_endpoint = _normalize_aliyun_endpoint(
            payload.accelerate_endpoint, acceleration=True
        )
    elif payload.accelerate_endpoint:
        accelerate_endpoint = _normalize_aliyun_endpoint(
            payload.accelerate_endpoint, acceleration=True
        )
    return {
        "name": payload.name.strip(),
        "region": region,
        "bucket": bucket,
        "endpoint": _normalize_aliyun_endpoint(
            payload.endpoint, runtime_region=region
        ),
        "accelerate_endpoint": accelerate_endpoint,
        "acceleration_enabled": payload.acceleration_enabled,
        "storage_price_cny_per_gb_month": payload.storage_price_cny_per_gb_month,
        "network_out_price_cny_per_gb": payload.network_out_price_cny_per_gb,
        "acceleration_price_cny_per_gb": payload.acceleration_price_cny_per_gb,
    }


def get_configuration(db: Session) -> OssManagementConfiguration | None:
    return db.scalar(select(OssManagementConfiguration).where(OssManagementConfiguration.id == 1))


def save_configuration(
    db: Session,
    settings: Settings,
    payload: OssConfigurationUpdate,
) -> OssManagementConfiguration:
    values = normalize_configuration(payload)
    current = get_configuration(db)
    access_key_id = payload.access_key_id.strip() if payload.access_key_id else ""
    access_key_secret = payload.access_key_secret.strip() if payload.access_key_secret else ""
    object_access_key_id = (
        payload.object_access_key_id.strip() if payload.object_access_key_id else ""
    )
    object_access_key_secret = (
        payload.object_access_key_secret.strip()
        if payload.object_access_key_secret
        else ""
    )
    if bool(access_key_id) != bool(access_key_secret):
        raise DomainError("AccessKey ID和Secret必须一起填写", status_code=422)
    if current is None and not access_key_id:
        raise DomainError("首次配置必须填写只读RAM AccessKey", status_code=422)
    if bool(object_access_key_id) != bool(object_access_key_secret):
        raise DomainError("图片读写AccessKey ID和Secret必须一起填写", status_code=422)
    if current is None and not object_access_key_id:
        raise DomainError("首次配置必须填写管理端图片读写AccessKey", status_code=422)
    if current is None:
        current = OssManagementConfiguration(id=1, runtime_revision=1, **values)
        db.add(current)
    else:
        current.runtime_revision += 1
        for key, value in values.items():
            setattr(current, key, value)
    if access_key_id:
        current.access_key_id_ciphertext = _encrypt(settings, access_key_id)
        current.access_key_secret_ciphertext = _encrypt(settings, access_key_secret)
        current.access_key_fingerprint = _fingerprint(
            settings, access_key_id, access_key_secret
        )
        current.masked_access_key_id = _masked_access_key_id(access_key_id)
    if object_access_key_id:
        current.object_access_key_id_ciphertext = _encrypt(
            settings, object_access_key_id
        )
        current.object_access_key_secret_ciphertext = _encrypt(
            settings, object_access_key_secret
        )
        current.object_access_key_fingerprint = _fingerprint(
            settings, object_access_key_id, object_access_key_secret
        )
        current.masked_object_access_key_id = _masked_access_key_id(
            object_access_key_id
        )
    current.status = "pending"
    current.last_error_code = None
    db.flush()
    return current


def configuration_public(config: OssManagementConfiguration | None) -> dict[str, Any]:
    if config is None:
        return {"configured": False, "status": "unconfigured"}
    return {
        "configured": True,
        "name": config.name,
        "region": config.region,
        "bucket": config.bucket,
        "endpoint": config.endpoint,
        "accelerate_endpoint": config.accelerate_endpoint,
        "acceleration_enabled": config.acceleration_enabled,
        "runtime_revision": config.runtime_revision,
        "masked_access_key_id": config.masked_access_key_id,
        "masked_object_access_key_id": config.masked_object_access_key_id,
        "status": config.status,
        "last_verified_at": config.last_verified_at,
        "last_usage_sync_at": config.last_usage_sync_at,
        "last_error_code": config.last_error_code,
        "storage_price_cny_per_gb_month": config.storage_price_cny_per_gb_month,
        "network_out_price_cny_per_gb": config.network_out_price_cny_per_gb,
        "acceleration_price_cny_per_gb": config.acceleration_price_cny_per_gb,
    }


class AliyunOssUsageClient:
    def __init__(
        self,
        access_key_id: str,
        access_key_secret: str,
        *,
        client: httpx.Client | None = None,
    ) -> None:
        self.access_key_id = access_key_id
        self.access_key_secret = access_key_secret
        self.client = client or httpx.Client(
            timeout=httpx.Timeout(20), follow_redirects=False, trust_env=False
        )
        self._owns_client = client is None

    def close(self) -> None:
        if self._owns_client:
            self.client.close()

    def _signed_params(self, values: dict[str, str]) -> dict[str, str]:
        params = {
            "AccessKeyId": self.access_key_id,
            "Action": "QueryUserOmsData",
            "Format": "JSON",
            "SignatureMethod": "HMAC-SHA1",
            "SignatureNonce": uuid4().hex,
            "SignatureVersion": "1.0",
            "Timestamp": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "Version": ALIYUN_BILLING_VERSION,
            **values,
        }
        canonical = "&".join(
            f"{_percent(key)}={_percent(str(params[key]))}" for key in sorted(params)
        )
        string_to_sign = f"POST&%2F&{_percent(canonical)}"
        signature = base64.b64encode(
            hmac.new(
                f"{self.access_key_secret}&".encode(),
                string_to_sign.encode(),
                hashlib.sha1,
            ).digest()
        ).decode()
        return {**params, "Signature": signature}

    def query_hourly(self, start_time: datetime, end_time: datetime) -> list[dict[str, Any]]:
        marker = ""
        seen_markers: set[str] = set()
        records: list[dict[str, Any]] = []
        while True:
            values = {
                "Table": "oss",
                "DataType": "Hour",
                "StartTime": start_time.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "EndTime": end_time.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "PageSize": "200",
            }
            if marker:
                values["Marker"] = marker
            try:
                response = self.client.post(
                    ALIYUN_BILLING_ENDPOINT,
                    data=self._signed_params(values),
                    headers={"Accept": "application/json", "User-Agent": "license-center/1.1"},
                )
            except (httpx.TimeoutException, httpx.NetworkError) as exc:
                raise DomainError("阿里云OSS用量接口暂时不可用", status_code=503) from exc
            if response.status_code < 200 or response.status_code >= 300:
                raise DomainError("阿里云拒绝了OSS用量查询", status_code=502)
            try:
                payload = response.json()
            except (ValueError, json.JSONDecodeError) as exc:
                raise DomainError("阿里云OSS用量返回格式无效", status_code=502) from exc
            if payload.get("Success") is not True or payload.get("Code") != "Success":
                raise DomainError("OSS用量权限验证失败，请检查只读RAM权限", status_code=502)
            data = payload.get("Data") if isinstance(payload.get("Data"), dict) else {}
            page = data.get("OmsData") if isinstance(data.get("OmsData"), list) else []
            records.extend(item for item in page if isinstance(item, dict))
            next_marker = str(data.get("Marker") or "").strip()
            if not next_marker:
                return records
            if next_marker in seen_markers:
                raise DomainError("阿里云OSS用量分页游标重复", status_code=502)
            seen_markers.add(next_marker)
            marker = next_marker


def build_usage_client(
    config: OssManagementConfiguration,
    settings: Settings,
) -> AliyunOssUsageClient:
    access_key_id, access_key_secret = configuration_credentials(config, settings)
    return AliyunOssUsageClient(
        access_key_id,
        access_key_secret,
    )


def configuration_credentials(
    config: OssManagementConfiguration,
    settings: Settings,
) -> tuple[str, str]:
    """Decrypt the server-owned OSS credential without exposing it to an API."""

    return (
        _decrypt(settings, config.access_key_id_ciphertext),
        _decrypt(settings, config.access_key_secret_ciphertext),
    )


def configuration_object_credentials(
    config: OssManagementConfiguration,
    settings: Settings,
) -> tuple[str, str]:
    """Read the server-only object credential used by every account and shop."""

    if not (
        config.object_access_key_id_ciphertext
        and config.object_access_key_secret_ciphertext
    ):
        raise DomainError("管理端统一OSS图片读写密钥尚未配置", status_code=503)
    return (
        _decrypt(settings, config.object_access_key_id_ciphertext),
        _decrypt(settings, config.object_access_key_secret_ciphertext),
    )


def _integer(record: dict[str, Any], key: str) -> int:
    try:
        value = int(record.get(key) or 0)
    except (TypeError, ValueError):
        return 0
    return max(value, 0)


def _money(value: Decimal) -> Decimal:
    return value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def aggregate_usage(
    config: OssManagementConfiguration,
    records: list[dict[str, Any]],
    hours: int,
) -> dict[str, Any]:
    relevant = [
        row
        for row in records
        if str(row.get("Bucket") or "") == config.bucket
        and str(row.get("Region") or "") == _billing_region(config.region)
    ]
    points: dict[str, dict[str, Any]] = defaultdict(
        lambda: {
            "start_time": "",
            "end_time": "",
            "storage_bytes": 0,
            "network_in_bytes": 0,
            "network_out_bytes": 0,
            "acceleration_in_bytes": 0,
            "acceleration_out_bytes": 0,
            "get_requests": 0,
            "put_requests": 0,
            "image_process_bytes": 0,
        }
    )
    for row in relevant:
        start = str(row.get("StartTime") or "")
        end = str(row.get("EndTime") or "")
        key = start or end
        point = points[key]
        point["start_time"] = start
        point["end_time"] = end
        point["storage_bytes"] += _integer(row, "Storage") + _integer(row, "StorageZRS")
        point["network_in_bytes"] += _integer(row, "NetworkIn")
        point["network_out_bytes"] += _integer(row, "NetworkOut")
        point["acceleration_in_bytes"] += sum(
            _integer(row, name) for name in ("AccM2MIn", "AccM2OIn", "AccO2MIn", "AccO2OIn")
        )
        point["acceleration_out_bytes"] += sum(
            _integer(row, name)
            for name in ("AccM2MOut", "AccM2OOut", "AccO2MOut", "AccO2OOut")
        )
        point["get_requests"] += _integer(row, "GetRequest")
        point["put_requests"] += _integer(row, "PutRequest")
        point["image_process_bytes"] += _integer(row, "ProcessImgSize")
    ordered = [points[key] for key in sorted(points)]
    current_storage = ordered[-1]["storage_bytes"] if ordered else 0
    totals = {
        name: sum(point[name] for point in ordered)
        for name in (
            "network_in_bytes",
            "network_out_bytes",
            "acceleration_in_bytes",
            "acceleration_out_bytes",
            "get_requests",
            "put_requests",
            "image_process_bytes",
        )
    }
    storage_cost = Decimal(current_storage) / GIB * Decimal(
        config.storage_price_cny_per_gb_month
    )
    network_cost = Decimal(totals["network_out_bytes"]) / GIB * Decimal(
        config.network_out_price_cny_per_gb
    )
    acceleration_cost = Decimal(
        totals["acceleration_in_bytes"] + totals["acceleration_out_bytes"]
    ) / GIB * Decimal(config.acceleration_price_cny_per_gb)
    return {
        "bucket": config.bucket,
        "region": config.region,
        "hours": hours,
        "sample_count": len(ordered),
        "current_storage_bytes": current_storage,
        **totals,
        "estimated_storage_monthly_cny": _money(storage_cost),
        "estimated_period_network_out_cny": _money(network_cost),
        "estimated_period_acceleration_cny": _money(acceleration_cost),
        "estimated_total_cny": _money(storage_cost + network_cost + acceleration_cost),
        "data_delay_note": (
            "阿里云小时计量有延迟，24小时前数据完整性更高；"
            "费用为目录价估算，不等于最终账单。"
        ),
        "points": ordered,
    }


def usage_range(hours: int, now: datetime | None = None) -> tuple[datetime, datetime]:
    if hours < 1 or hours > 24 * 90:
        raise DomainError("OSS用量查询范围必须在1小时到90天之间", status_code=422)
    end = (now or datetime.now(UTC)).astimezone(UTC).replace(microsecond=0)
    return end - timedelta(hours=hours), end


def signed_runtime_configuration(
    config: OssManagementConfiguration,
    settings: Settings,
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    if config.status != "active":
        raise DomainError("OSS运行配置尚未验证", status_code=404)
    private_key = load_offline_private_key(settings)
    if private_key is None:
        raise DomainError("OSS运行配置签名不可用", status_code=503)
    issued_at = (now or datetime.now(UTC)).astimezone(UTC).replace(microsecond=0)
    payload = {
        "contract": "wangzai-oss-runtime-config/v1",
        "config_version": config.runtime_revision,
        "signing_key_id": settings.offline_signing_key_id,
        "issued_at": issued_at.isoformat().replace("+00:00", "Z"),
        "region": config.region,
        "bucket": config.bucket,
        "endpoint": config.endpoint,
        "acceleration_enabled": config.acceleration_enabled,
        "accelerate_endpoint": (
            config.accelerate_endpoint if config.acceleration_enabled else None
        ),
    }
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    signature = base64.urlsafe_b64encode(private_key.sign(canonical.encode())).rstrip(b"=")
    return {**payload, "signature": signature.decode("ascii")}

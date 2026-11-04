from __future__ import annotations

from typing import Any
from urllib.parse import urljoin, urlparse

import httpx

from app.schemas.core_v2 import OzonShopConnectionTestRequest


class OzonConnectionFailure(Exception):
    def __init__(self, code: str, message: str, *, status_code: int = 502) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def _validated_base_url(value: str) -> str:
    parsed = urlparse(str(value).strip())
    if parsed.scheme != "https" or parsed.hostname != "api-seller.ozon.ru":
        raise OzonConnectionFailure(
            "OZON_SERVER_CONFIGURATION_INVALID",
            "Ozon Seller API 地址配置无效。",
            status_code=503,
        )
    return f"https://{parsed.hostname}"


def _payload(response: httpx.Response) -> dict[str, Any] | list[Any] | None:
    try:
        value = response.json()
    except ValueError as exc:
        raise OzonConnectionFailure(
            "OZON_RESPONSE_INVALID",
            "Ozon 返回了无法识别的数据。",
        ) from exc
    return value if isinstance(value, (dict, list)) else None


def _request(
    client: httpx.Client,
    base_url: str,
    path: str,
    headers: dict[str, str],
) -> dict[str, Any] | list[Any] | None:
    try:
        response = client.post(urljoin(f"{base_url}/", path.lstrip("/")), headers=headers, json={})
    except (httpx.TimeoutException, httpx.NetworkError) as exc:
        raise OzonConnectionFailure(
            "OZON_NETWORK_UNAVAILABLE",
            "暂时无法连接 Ozon，请稍后重试。",
        ) from exc
    payload = _payload(response)
    if response.status_code in (401, 403) or (
        isinstance(payload, dict) and str(payload.get("code", "")) == "5"
    ):
        raise OzonConnectionFailure(
            "OZON_AUTHENTICATION_FAILED",
            "API Key 无效、已撤销或与当前 Client ID 不匹配。",
            status_code=401,
        )
    if not response.is_success:
        raise OzonConnectionFailure(
            "OZON_CONNECTION_TEST_FAILED",
            f"Ozon 连接测试失败（HTTP {response.status_code}）。",
        )
    return payload


def execute_shop_connection_test(
    payload: OzonShopConnectionTestRequest,
    *,
    base_url: str,
    timeout_seconds: int,
    client: httpx.Client | None = None,
) -> dict[str, Any]:
    """Run two read-only Ozon checks without persisting credentials or results."""

    resolved_base_url = _validated_base_url(base_url)
    headers = {
        "Client-Id": payload.client_id.strip(),
        "Api-Key": payload.api_key.get_secret_value().strip(),
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "Wangzai-Core-V2/1",
    }
    owned_client = client is None
    active_client = client or httpx.Client(
        timeout=httpx.Timeout(timeout_seconds),
        follow_redirects=False,
        trust_env=False,
    )
    try:
        roles = _request(active_client, resolved_base_url, "/v1/roles", headers)
        seller_info = _request(active_client, resolved_base_url, "/v1/seller/info", headers)
    finally:
        if owned_client:
            active_client.close()
        headers.clear()
    return {
        "ok": True,
        "connected": True,
        "message": "Ozon 店铺连接正常。",
        "checks": {
            "roles": {"ok": True, "endpoint": "shop.roles", "data": roles},
            "sellerInfo": {"ok": True, "endpoint": "shop.sellerInfo", "data": seller_info},
        },
        "roles": roles,
        "seller_info": seller_info,
    }

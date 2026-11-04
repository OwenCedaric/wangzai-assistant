from __future__ import annotations

import base64
import hashlib
import json
import os
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx
from cryptography.fernet import Fernet, InvalidToken

from app.config import Settings


class CrossBorderFailure(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        status_code: int = 400,
        response_data: Any = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.response_data = response_data


ENDPOINTS: dict[str, dict[str, Any]] = {
    "auth.queryAuthorization": {
        "risk": "read",
        "path": "/erpapi/user/queryauthorization",
        "format": "form",
    },
    "warehouse.cooperationStorehouse": {
        "risk": "read",
        "path": "/erpapi/storehouse/cooperationStorehouse",
        "format": "form",
    },
    "warehouse.searchStorehouseSection": {
        "risk": "read",
        "path": "/erpapi/storehouse/searchStorehouseSection",
        "format": "form",
    },
    "order.search": {"risk": "read", "path": "/erpapi/orderlist/search", "format": "form"},
    "order.status": {"risk": "read", "path": "/erpapi/orderlist/status", "format": "form"},
    "order.outInfo": {"risk": "read", "path": "/erpapi/order/get_order_out_info", "format": "form"},
    "order.create": {"risk": "write", "path": "/erpapi/order/createOrder", "format": "json"},
    "order.update": {"risk": "write", "path": "/erpapi/order/updateOrder", "format": "form"},
    "order.updateSheet": {
        "risk": "write",
        "path": "/erpapi/order/updateOrderSheet",
        "format": "form",
    },
    "order.updatePackage": {
        "risk": "write",
        "path": "/erpapi/order/updateOrderPackage",
        "format": "form",
    },
    "order.cancel": {"risk": "write", "path": "/erpapi/order/cancelOrder", "format": "form"},
    "order.syncStatus": {
        "risk": "write",
        "path": "/erpapi/ordersync/order_update",
        "format": "json",
    },
    "order.associate": {
        "risk": "write",
        "path": "/erpapi/orderassociation/association_order_account",
        "format": "json",
    },
}

_TOKEN_LOCK = threading.RLock()
_TOKEN_CACHE: dict[str, str] = {}


def _now() -> datetime:
    return datetime.now(UTC)


def _fernet(settings: Settings, purpose: str) -> Fernet:
    material = f"{purpose}\0{settings.jwt_secret_key}".encode()
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(material).digest()))


def _state_path(settings: Settings) -> Path:
    return Path(settings.cross_border_token_state_file).resolve()


def _secret(settings: Settings) -> str:
    secret = str(settings.cross_border_company_secret or "").strip()
    if not secret:
        raise CrossBorderFailure(
            "CROSS_BORDER_SERVER_SECRET_REQUIRED",
            "服务器尚未配置跨境巴士企业 API。",
            503,
        )
    return secret


def _secret_fingerprint(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def _load_token_state(settings: Settings, secret: str) -> dict[str, str]:
    key = _secret_fingerprint(secret)
    path = _state_path(settings)
    if (
        _TOKEN_CACHE.get("fingerprint") == key
        and _TOKEN_CACHE.get("_state_path") == str(path)
        and _TOKEN_CACHE.get("access_token")
    ):
        return dict(_TOKEN_CACHE)
    if not path.is_file():
        return {"fingerprint": key}
    try:
        decrypted = _fernet(settings, "cross-border-token-state/v1").decrypt(path.read_bytes())
        state = json.loads(decrypted)
    except (OSError, InvalidToken, json.JSONDecodeError, TypeError):
        return {"fingerprint": key}
    if state.get("fingerprint") != key:
        return {"fingerprint": key}
    _TOKEN_CACHE.clear()
    _TOKEN_CACHE.update({str(k): str(v) for k, v in state.items() if v is not None})
    _TOKEN_CACHE["_state_path"] = str(path)
    return dict(_TOKEN_CACHE)


def _save_token_state(settings: Settings, state: dict[str, str]) -> None:
    path = _state_path(settings)
    path.parent.mkdir(parents=True, exist_ok=True)
    persisted = {key: value for key, value in state.items() if not key.startswith("_")}
    payload = json.dumps(persisted, ensure_ascii=False, separators=(",", ":")).encode()
    encrypted = _fernet(settings, "cross-border-token-state/v1").encrypt(payload)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{uuid4().hex}.tmp")
    try:
        with temporary.open("xb") as handle:
            handle.write(encrypted)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    _TOKEN_CACHE.clear()
    _TOKEN_CACHE.update(state)
    _TOKEN_CACHE["_state_path"] = str(path)


def _response_payload(response: httpx.Response) -> Any:
    try:
        data = response.json()
    except (ValueError, json.JSONDecodeError):
        data = None
    if data is not None and "\ufffd" not in json.dumps(data, ensure_ascii=False):
        return data
    try:
        return json.loads(response.content.decode("gb18030"))
    except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
        return data


def _response_message(data: Any) -> str:
    if not isinstance(data, dict):
        return ""
    return str(data.get("message") or data.get("msg") or "").strip()[:300]


def _request_json(
    client: httpx.Client,
    settings: Settings,
    path: str,
    *,
    headers: dict[str, str] | None = None,
    body: dict[str, Any] | None = None,
    form: bool = False,
) -> Any:
    try:
        response = client.post(
            f"{settings.cross_border_api_base_url.rstrip('/')}{path}",
            headers={"Accept": "application/json", **(headers or {})},
            json=None if form else (body or {}),
            data=(body or {}) if form else None,
            timeout=settings.cross_border_api_timeout_seconds,
        )
    except httpx.TimeoutException as exc:
        raise CrossBorderFailure("CROSS_BORDER_TIMEOUT", "跨境巴士接口请求超时。", 504) from exc
    except httpx.HTTPError as exc:
        raise CrossBorderFailure(
            "CROSS_BORDER_NETWORK_ERROR", "跨境巴士网络连接失败。", 502
        ) from exc
    data = _response_payload(response)
    if response.status_code in (401, 403):
        raise CrossBorderFailure(
            "CROSS_BORDER_TOKEN_REJECTED",
            _response_message(data) or "跨境巴士企业授权已失效。",
            401,
            data,
        )
    if response.status_code >= 400:
        raise CrossBorderFailure(
            "CROSS_BORDER_HTTP_ERROR", f"跨境巴士接口返回 HTTP {response.status_code}。", 502
        )
    if isinstance(data, dict) and "code" in data and int(data.get("code") or 0) != 1:
        message = str(data.get("message") or data.get("msg") or "跨境巴士接口拒绝请求。")
        raise CrossBorderFailure("CROSS_BORDER_API_ERROR", message[:300], 400, data)
    return data


def _read_value(data: Any, key: str) -> str:
    if not isinstance(data, dict):
        return ""
    nested = data.get("data") if isinstance(data.get("data"), dict) else {}
    return str(data.get(key) or nested.get(key) or "").strip()


def _enterprise_token(
    settings: Settings, client: httpx.Client, *, refresh: bool = False
) -> dict[str, str]:
    secret = _secret(settings)
    with _TOKEN_LOCK:
        state = _load_token_state(settings, secret)
        if state.get("access_token") and not refresh:
            return state
        expires_token = state.get("expires_token", "")
        if expires_token:
            path = "/erpapi/token/refresh"
            body = {"client_secret": secret, "expires_token": expires_token}
        else:
            path = "/erpapi/token/index"
            body = {"client_secret": secret}
        try:
            data = _request_json(client, settings, path, body=body)
        except CrossBorderFailure as exc:
            if expires_token or "已经生成" in exc.message or "Token" in exc.message:
                data = _request_json(
                    client,
                    settings,
                    "/erpapi/token/resettoken",
                    body={"client_secret": secret},
                )
            else:
                raise
        access_token = _read_value(data, "access_token")
        if not access_token:
            raise CrossBorderFailure(
                "CROSS_BORDER_ACCESS_TOKEN_MISSING", "跨境巴士未返回企业 Token。", 502
            )
        next_state = {
            "fingerprint": _secret_fingerprint(secret),
            "access_token": access_token,
            "expires_token": _read_value(data, "expires_token") or expires_token,
            "updated_at": _now().isoformat(),
        }
        _save_token_state(settings, next_state)
        return next_state


def _decrypt_grant_payload(settings: Settings, authorization_ref: str) -> dict[str, Any]:
    try:
        raw = _fernet(settings, "cross-border-user-grant/v1").decrypt(authorization_ref.encode())
        payload = json.loads(raw)
    except (InvalidToken, json.JSONDecodeError, TypeError, ValueError) as exc:
        raise CrossBorderFailure(
            "CROSS_BORDER_GRANT_INVALID", "跨境巴士服务器授权无效，请重新授权。", 401
        ) from exc
    return payload


def _grant_payload(settings: Settings, authorization_ref: str) -> dict[str, Any]:
    payload = _decrypt_grant_payload(settings, authorization_ref)
    if datetime.fromisoformat(str(payload.get("expires_at"))) <= _now():
        raise CrossBorderFailure(
            "CROSS_BORDER_GRANT_EXPIRED", "跨境巴士服务器授权已过期，请重新授权。", 401
        )
    return payload


def _assert_grant(payload: dict[str, Any], *, user_id: int, project_code: str) -> str:
    if (
        int(payload.get("user_id") or 0) != int(user_id)
        or payload.get("project_code") != project_code
    ):
        raise CrossBorderFailure(
            "CROSS_BORDER_GRANT_SCOPE_MISMATCH", "跨境巴士授权不属于当前账号。", 403
        )
    app_uid = str(payload.get("app_uid") or "").strip()
    if not app_uid:
        raise CrossBorderFailure("CROSS_BORDER_GRANT_INVALID", "跨境巴士授权缺少用户标识。", 401)
    return app_uid


def authorize_user(
    settings: Settings,
    *,
    user_id: int,
    project_code: str,
    account_ref: str,
    user_name: str,
    password: str,
    previous_authorization_ref: str = "",
    known_app_uid: str = "",
    client: httpx.Client | None = None,
) -> dict[str, Any]:
    owned = client is None
    active_client = client or httpx.Client(follow_redirects=False)
    try:
        secret = _secret(settings)
        token = _enterprise_token(settings, active_client)
        try:
            data = _request_json(
                active_client,
                settings,
                "/erpapi/user/authorization",
                headers={"k-client-secret": secret, "authorization": token["access_token"]},
                body={"user_name": user_name, "password": password},
            )
            app_uid = _read_value(data, "app_uid")
        except CrossBorderFailure as exc:
            if "用户已授权" not in exc.message:
                raise
            app_uid = _read_value(exc.response_data, "app_uid")
            if not app_uid:
                app_uid = str(known_app_uid or "").strip()
            if not app_uid and previous_authorization_ref:
                previous = _decrypt_grant_payload(settings, previous_authorization_ref)
                if (
                    int(previous.get("user_id") or 0) != int(user_id)
                    or previous.get("project_code") != project_code
                    or previous.get("account_ref") != account_ref
                ):
                    raise CrossBorderFailure(
                        "CROSS_BORDER_GRANT_SCOPE_MISMATCH",
                        "跨境巴士旧授权不属于当前账号。",
                        403,
                    ) from exc
                app_uid = str(previous.get("app_uid") or "").strip()
            if not app_uid:
                raise CrossBorderFailure(
                    "CROSS_BORDER_EXISTING_AUTHORIZATION_ID_REQUIRED",
                    "该账号已在跨境巴士授权，需要迁移原授权后再使用。",
                    409,
                ) from exc
            _request_json(
                active_client,
                settings,
                "/erpapi/user/queryauthorization",
                headers={
                    "k-client-secret": secret,
                    "authorization": token["access_token"],
                    "k-app-uid": app_uid,
                },
                body={"app_user_id": app_uid},
                form=True,
            )
        if not app_uid:
            raise CrossBorderFailure(
                "CROSS_BORDER_APP_UID_MISSING", "跨境巴士授权响应缺少用户标识。", 502
            )
        expires_at = _now() + timedelta(seconds=settings.cross_border_grant_ttl_seconds)
        grant = {
            "contract": "cross-border-user-grant/v1",
            "grant_id": str(uuid4()),
            "user_id": user_id,
            "project_code": project_code,
            "account_ref": account_ref,
            "app_uid": app_uid,
            "issued_at": _now().isoformat(),
            "expires_at": expires_at.isoformat(),
        }
        authorization_ref = (
            _fernet(settings, "cross-border-user-grant/v1")
            .encrypt(json.dumps(grant, separators=(",", ":")).encode())
            .decode()
        )
        return {
            "ok": True,
            "authorized": True,
            "authorization_ref": authorization_ref,
            "account_ref": account_ref,
            "expires_at": expires_at.isoformat(),
            "message": "跨境巴士服务器授权成功。",
        }
    finally:
        if owned:
            active_client.close()


def request_endpoint(
    settings: Settings,
    *,
    user_id: int,
    project_code: str,
    authorization_ref: str,
    endpoint_key: str,
    body: dict[str, Any],
    expected_risk: str,
    client: httpx.Client | None = None,
) -> dict[str, Any]:
    endpoint = ENDPOINTS.get(endpoint_key)
    if endpoint is None or endpoint["risk"] != expected_risk:
        raise CrossBorderFailure(
            "CROSS_BORDER_ENDPOINT_FORBIDDEN", "跨境巴士接口不在允许范围内。", 400
        )
    grant = _grant_payload(settings, authorization_ref)
    app_uid = _assert_grant(grant, user_id=user_id, project_code=project_code)
    owned = client is None
    active_client = client or httpx.Client(follow_redirects=False)
    try:
        secret = _secret(settings)
        token = _enterprise_token(settings, active_client)
        headers = {
            "k-client-secret": secret,
            "authorization": token["access_token"],
            "k-app-uid": app_uid,
        }
        try:
            data = _request_json(
                active_client,
                settings,
                endpoint["path"],
                headers=headers,
                body=body,
                form=endpoint["format"] == "form",
            )
        except CrossBorderFailure as exc:
            if exc.code != "CROSS_BORDER_TOKEN_REJECTED":
                raise
            token = _enterprise_token(settings, active_client, refresh=True)
            headers["authorization"] = token["access_token"]
            data = _request_json(
                active_client,
                settings,
                endpoint["path"],
                headers=headers,
                body=body,
                form=endpoint["format"] == "form",
            )
        return {"ok": True, "endpoint_key": endpoint_key, "data": data}
    finally:
        if owned:
            active_client.close()


def revoke_user_authorization(
    settings: Settings,
    *,
    user_id: int,
    project_code: str,
    account_ref: str,
    authorization_ref: str,
    client: httpx.Client | None = None,
) -> dict[str, Any]:
    grant = _decrypt_grant_payload(settings, authorization_ref)
    if (
        int(grant.get("user_id") or 0) != int(user_id)
        or grant.get("project_code") != project_code
        or grant.get("account_ref") != account_ref
    ):
        raise CrossBorderFailure(
            "CROSS_BORDER_GRANT_SCOPE_MISMATCH",
            "跨境巴士授权不属于当前账号。",
            403,
        )
    app_uid = str(grant.get("app_uid") or "").strip()
    if not app_uid:
        raise CrossBorderFailure(
            "CROSS_BORDER_GRANT_INVALID",
            "跨境巴士服务器授权缺少用户标识。",
            401,
        )
    owned = client is None
    active_client = client or httpx.Client(follow_redirects=False)
    try:
        secret = _secret(settings)
        token = _enterprise_token(settings, active_client)
        headers = {
            "k-client-secret": secret,
            "authorization": token["access_token"],
            "k-app-uid": app_uid,
        }
        data = _request_json(
            active_client,
            settings,
            "/erpapi/user/unauthorization",
            headers=headers,
            body={"app_user_id": app_uid},
        )
        try:
            _request_json(
                active_client,
                settings,
                "/erpapi/user/queryauthorization",
                headers=headers,
                body={"app_user_id": app_uid},
                form=True,
            )
        except CrossBorderFailure as exc:
            if exc.code != "CROSS_BORDER_API_ERROR":
                raise
        else:
            raise CrossBorderFailure(
                "CROSS_BORDER_REVOKE_READBACK_FAILED",
                "跨境巴士仍返回已授权，解除结果未通过回读。",
                409,
            )
        return {
            "ok": True,
            "revoked": True,
            "account_ref": account_ref,
            "message": _response_message(data) or "跨境巴士授权已解除。",
        }
    finally:
        if owned:
            active_client.close()


def create_write_preview(
    settings: Settings,
    *,
    user_id: int,
    project_code: str,
    authorization_ref: str,
    endpoint_key: str,
    body: dict[str, Any],
    request_id: str,
) -> dict[str, Any]:
    endpoint = ENDPOINTS.get(endpoint_key)
    if endpoint is None or endpoint["risk"] != "write":
        raise CrossBorderFailure(
            "CROSS_BORDER_WRITE_ENDPOINT_REQUIRED", "请选择允许写入的跨境巴士接口。", 400
        )
    grant = _grant_payload(settings, authorization_ref)
    _assert_grant(grant, user_id=user_id, project_code=project_code)
    preview = {
        "contract": "cross-border-write-preview/v1",
        "user_id": user_id,
        "project_code": project_code,
        "authorization_ref_sha256": hashlib.sha256(authorization_ref.encode()).hexdigest(),
        "endpoint_key": endpoint_key,
        "body": body,
        "request_id": request_id,
        "expires_at": (_now() + timedelta(minutes=5)).isoformat(),
    }
    token = (
        _fernet(settings, "cross-border-write-preview/v1")
        .encrypt(json.dumps(preview, separators=(",", ":")).encode())
        .decode()
    )
    return {
        "ok": True,
        "preview_token": token,
        "requires_confirmation": True,
        "endpoint_key": endpoint_key,
        "expires_at": preview["expires_at"],
    }


def confirm_write(
    settings: Settings,
    *,
    user_id: int,
    project_code: str,
    authorization_ref: str,
    preview_token: str,
    client: httpx.Client | None = None,
) -> dict[str, Any]:
    try:
        raw = _fernet(settings, "cross-border-write-preview/v1").decrypt(preview_token.encode())
        preview = json.loads(raw)
    except (InvalidToken, json.JSONDecodeError, TypeError, ValueError) as exc:
        raise CrossBorderFailure(
            "CROSS_BORDER_PREVIEW_INVALID", "跨境巴士写入预览无效，请重新预览。", 409
        ) from exc
    if datetime.fromisoformat(str(preview.get("expires_at"))) <= _now():
        raise CrossBorderFailure("CROSS_BORDER_PREVIEW_EXPIRED", "跨境巴士写入预览已过期。", 409)
    if (
        int(preview.get("user_id") or 0) != int(user_id)
        or preview.get("project_code") != project_code
        or preview.get("authorization_ref_sha256")
        != hashlib.sha256(authorization_ref.encode()).hexdigest()
    ):
        raise CrossBorderFailure(
            "CROSS_BORDER_PREVIEW_SCOPE_MISMATCH", "跨境巴士写入预览不属于当前账号。", 403
        )
    return request_endpoint(
        settings,
        user_id=user_id,
        project_code=project_code,
        authorization_ref=authorization_ref,
        endpoint_key=str(preview.get("endpoint_key") or ""),
        body=preview.get("body") if isinstance(preview.get("body"), dict) else {},
        expected_risk="write",
        client=client,
    )


def public_endpoints() -> list[dict[str, str]]:
    return [{"key": key, "risk": value["risk"]} for key, value in sorted(ENDPOINTS.items())]


def reset_enterprise_token_state(settings: Settings) -> None:
    with _TOKEN_LOCK:
        _TOKEN_CACHE.clear()
        _state_path(settings).unlink(missing_ok=True)

from __future__ import annotations

from typing import Any
from urllib.parse import urljoin, urlparse

import httpx


class SmartReplyOzonFailure(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        retryable: bool = False,
        ambiguous_write: bool = False,
        status_code: int = 502,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable
        self.ambiguous_write = ambiguous_write
        self.status_code = status_code


def _validated_base_url(value: str) -> str:
    parsed = urlparse(str(value or "").strip())
    if parsed.scheme != "https" or parsed.hostname != "api-seller.ozon.ru":
        raise SmartReplyOzonFailure(
            "SMART_REPLY_OZON_CONFIGURATION_INVALID",
            "Ozon Seller API 地址配置无效。",
            status_code=503,
        )
    return f"https://{parsed.hostname}"


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _message_text(message: dict[str, Any]) -> str:
    data = message.get("data")
    rows = data if isinstance(data, list) else [data]
    text = "\n".join(
        str(value).strip()
        for value in rows
        if isinstance(value, (str, int, float)) and str(value).strip()
    )
    return " ".join(text.split())


def _is_seller_message(message: dict[str, Any]) -> bool:
    user = _dict(message.get("user"))
    return str(user.get("type") or "").strip().lower() in {"seller", "support"}


class SmartReplyOzonClient:
    def __init__(
        self,
        *,
        client_id: str,
        api_key: str,
        base_url: str,
        timeout_seconds: int,
        client: httpx.Client | None = None,
    ) -> None:
        self.base_url = _validated_base_url(base_url)
        self.headers = {
            "Client-Id": str(client_id).strip(),
            "Api-Key": str(api_key).strip(),
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "Wangzai-Smart-Reply/1",
        }
        self._owned_client = client is None
        self.client = client or httpx.Client(
            timeout=httpx.Timeout(timeout_seconds),
            follow_redirects=False,
            trust_env=False,
        )

    def close(self) -> None:
        self.headers.clear()
        if self._owned_client:
            self.client.close()

    def __enter__(self):
        return self

    def __exit__(self, _exc_type, _exc, _traceback):
        self.close()

    def _post(
        self,
        path: str,
        body: dict[str, Any],
        *,
        write: bool = False,
    ) -> dict[str, Any]:
        try:
            response = self.client.post(
                urljoin(f"{self.base_url}/", path.lstrip("/")),
                headers=self.headers,
                json=body,
            )
        except (httpx.TimeoutException, httpx.NetworkError) as exc:
            raise SmartReplyOzonFailure(
                (
                    "SMART_REPLY_OZON_WRITE_RESULT_UNKNOWN"
                    if write
                    else "SMART_REPLY_OZON_NETWORK_UNAVAILABLE"
                ),
                (
                    "发送请求已离开服务器，但没有收到 Ozon 回执；为避免重复发送，已转人工确认。"
                    if write
                    else "暂时无法连接 Ozon，任务会按规则重试。"
                ),
                retryable=not write,
                ambiguous_write=write,
            ) from exc
        try:
            payload = response.json()
        except ValueError as exc:
            raise SmartReplyOzonFailure(
                "SMART_REPLY_OZON_RESPONSE_INVALID",
                "Ozon 返回了无法识别的数据。",
                ambiguous_write=write,
            ) from exc
        result = _dict(payload)
        if response.status_code in {401, 403}:
            raise SmartReplyOzonFailure(
                "SMART_REPLY_OZON_AUTHENTICATION_FAILED",
                "当前店铺的 Ozon API Key 无效、已撤销或没有聊天权限。",
                status_code=401,
            )
        if response.status_code == 429 or response.status_code >= 500:
            raise SmartReplyOzonFailure(
                (
                    "SMART_REPLY_OZON_RATE_LIMITED"
                    if response.status_code == 429
                    else "SMART_REPLY_OZON_TEMPORARY_FAILURE"
                ),
                "Ozon 当前限流或暂时不可用。",
                retryable=not write,
                ambiguous_write=write,
            )
        if not response.is_success:
            code = str(result.get("code") or result.get("error") or "")[:60]
            raise SmartReplyOzonFailure(
                f"SMART_REPLY_OZON_HTTP_{response.status_code}",
                f"Ozon 拒绝了请求（HTTP {response.status_code}{f'，{code}' if code else ''}）。",
                status_code=response.status_code,
            )
        return result

    def verify(self) -> None:
        self._post("/v1/roles", {})
        self._post("/v1/seller/info", {})

    def read_posting(self, posting_number: str) -> tuple[dict[str, Any], str]:
        last_error: SmartReplyOzonFailure | None = None
        for path, source in (
            ("/v3/posting/fbs/get", "FBS"),
            ("/v2/posting/fbo/get", "FBO"),
        ):
            try:
                payload = self._post(path, {"posting_number": posting_number})
            except SmartReplyOzonFailure as exc:
                if exc.status_code in {400, 404}:
                    last_error = exc
                    continue
                raise
            result = payload.get("result")
            if isinstance(result, dict) and result:
                return result, source
            if payload.get("posting_number"):
                return payload, source
        raise SmartReplyOzonFailure(
            "SMART_REPLY_POSTING_NOT_FOUND",
            "Ozon 没有返回这笔订单，任务会保留失败记录。",
            status_code=404,
        ) from last_error

    def has_return_or_refund(self, posting_number: str) -> bool:
        payload = self._post(
            "/v1/returns/list",
            {
                "filter": {"posting_numbers": [posting_number]},
                "limit": 1,
                "last_id": 0,
            },
        )
        result = payload.get("result")
        if isinstance(result, dict):
            rows = result.get("returns")
        else:
            rows = payload.get("returns")
        return bool(isinstance(rows, list) and rows)

    def start_chat(self, posting_number: str) -> str:
        payload = self._post(
            "/v1/chat/start",
            {"posting_number": posting_number},
            write=True,
        )
        result = payload.get("result")
        chat_id = str(result.get("chat_id") if isinstance(result, dict) else "").strip()
        if not chat_id:
            raise SmartReplyOzonFailure(
                "SMART_REPLY_CHAT_ID_MISSING",
                "Ozon 没有返回买家会话编号，未发送消息。",
            )
        return chat_id

    def send_message(self, chat_id: str, text: str) -> str | None:
        payload = self._post(
            "/v1/chat/send/message",
            {"chat_id": chat_id, "text": text},
            write=True,
        )
        result = payload.get("result")
        if isinstance(result, dict):
            value = result.get("message_id") or result.get("id")
        else:
            value = result
        return str(value).strip()[:160] if value not in (None, "") else None

    def history(self, chat_id: str) -> list[dict[str, Any]]:
        payload = self._post(
            "/v3/chat/history",
            {"chat_id": chat_id, "limit": 30, "direction": "Backward"},
        )
        messages = payload.get("messages")
        if messages is None and isinstance(payload.get("result"), dict):
            messages = payload["result"].get("messages")
        return [item for item in messages or [] if isinstance(item, dict)]


def history_confirms_message(
    messages: list[dict[str, Any]],
    *,
    message_id: str | None,
    text: str,
) -> tuple[bool, str | None]:
    expected_text = " ".join(str(text or "").split())
    for message in messages:
        current_id = str(message.get("message_id") or message.get("id") or "").strip()
        current_text = _message_text(message) or " ".join(
            str(message.get("text") or message.get("message") or "").split()
        )
        if message_id and current_id == message_id:
            return True, current_id
        if expected_text and _is_seller_message(message) and current_text == expected_text:
            return True, current_id or message_id
    return False, message_id

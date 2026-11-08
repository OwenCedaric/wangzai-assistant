"""Small, dependency-free JSON transport for License Center."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen

from .errors import (
    APIError,
    AuthenticationError,
    ConfigurationError,
    ResponseFormatError,
    TransportError,
)


class Transport(Protocol):
    def request(
        self,
        method: str,
        path: str,
        *,
        json_body: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> Mapping[str, Any]: ...


def _error_from_response(status: int, body: object) -> APIError:
    message = "Request rejected"
    code: str | None = None
    details: Any = None
    if isinstance(body, Mapping):
        raw_detail = body.get("detail")
        if isinstance(raw_detail, Mapping):
            message = str(raw_detail.get("message") or raw_detail.get("detail") or message)
            code_value = raw_detail.get("code") or raw_detail.get("error_code")
            code = str(code_value) if code_value else None
        elif isinstance(raw_detail, list):
            locations = []
            for item in raw_detail:
                if not isinstance(item, Mapping) or not isinstance(item.get("loc"), list):
                    continue
                locations.append(".".join(str(part) for part in item["loc"]))
            message = "Request validation failed"
            if locations:
                message += f": {', '.join(locations)}"
            code = "validation_error"
        elif raw_detail is not None:
            message = str(raw_detail)
        else:
            message = str(body.get("message") or body.get("error") or message)
            code_value = body.get("code") or body.get("error_code")
            code = str(code_value) if code_value else None
        # Validation payloads can echo submitted credentials under ``input``,
        # so the SDK intentionally retains neither the payload nor its values.
        details = None
    error_type = AuthenticationError if status in {401, 403} else APIError
    return error_type(status_code=status, message=message, error_code=code, details=details)


class UrllibTransport:
    """HTTPS JSON transport built on the Python standard library."""

    def __init__(
        self,
        base_url: str,
        *,
        timeout: float = 10.0,
        allow_insecure_http: bool = False,
        user_agent: str = "license-center-python-sdk/1.1",
    ) -> None:
        parsed = urlparse(base_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ConfigurationError("base_url must be an absolute HTTP(S) URL")
        local_hosts = {"localhost", "127.0.0.1", "::1"}
        if (
            parsed.scheme == "http"
            and parsed.hostname not in local_hosts
            and not allow_insecure_http
        ):
            raise ConfigurationError(
                "Plain HTTP is only allowed for localhost unless explicitly enabled"
            )
        if timeout <= 0:
            raise ConfigurationError("timeout must be greater than zero")
        self._base_url = base_url.rstrip("/") + "/"
        self._timeout = timeout
        self._user_agent = user_agent

    def request(
        self,
        method: str,
        path: str,
        *,
        json_body: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> Mapping[str, Any]:
        url = urljoin(self._base_url, path.lstrip("/"))
        request_headers = {
            "Accept": "application/json",
            "User-Agent": self._user_agent,
        }
        request_headers.update(headers or {})
        body: bytes | None = None
        if json_body is not None:
            body = json.dumps(json_body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            request_headers["Content-Type"] = "application/json; charset=utf-8"
        request = Request(url, data=body, headers=request_headers, method=method.upper())
        try:
            with urlopen(request, timeout=self._timeout) as response:  # noqa: S310 - URL validated above
                raw = response.read()
        except HTTPError as exc:
            raw = exc.read()
            parsed_body: object = {}
            if raw:
                try:
                    parsed_body = json.loads(raw.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    parsed_body = {}
            raise _error_from_response(exc.code, parsed_body) from None
        except (URLError, TimeoutError, OSError) as exc:
            raise TransportError(f"Unable to reach License Center: {type(exc).__name__}") from exc
        if not raw:
            return {}
        try:
            parsed_body = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ResponseFormatError("License Center returned invalid JSON") from exc
        if not isinstance(parsed_body, Mapping):
            raise ResponseFormatError("License Center response must be a JSON object")
        return dict(parsed_body)

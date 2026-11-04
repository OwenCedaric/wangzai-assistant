from __future__ import annotations

import base64
import hashlib
import hmac
import json
from datetime import UTC, datetime
from urllib.parse import quote, urlencode
from uuid import uuid4

from app.config import Settings
from app.services.errors import DomainError
from app.services.payments.http import HttpTransport, UrllibHttpTransport


def _percent(value: str) -> str:
    return quote(value, safe="~")


class AliyunSmsProvider:
    name = "aliyun"

    def __init__(self, settings: Settings, *, transport: HttpTransport | None = None) -> None:
        self.settings = settings
        self.transport = transport or UrllibHttpTransport()

    def send_verification_code(self, phone: str, code: str) -> str | None:
        params = {
            "AccessKeyId": self.settings.sms_access_key or "",
            "Action": "SendSms",
            "Format": "JSON",
            "PhoneNumbers": phone,
            "RegionId": self.settings.sms_region_id,
            "SignName": self.settings.sms_sign_name or "",
            "SignatureMethod": "HMAC-SHA1",
            "SignatureNonce": uuid4().hex,
            "SignatureVersion": "1.0",
            "TemplateCode": self.settings.sms_template_code or "",
            "TemplateParam": json.dumps({"code": code}, separators=(",", ":")),
            "Timestamp": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "Version": "2017-05-25",
        }
        canonical = "&".join(f"{_percent(key)}={_percent(params[key])}" for key in sorted(params))
        string_to_sign = f"POST&%2F&{_percent(canonical)}"
        signature = base64.b64encode(
            hmac.new(
                f"{self.settings.sms_secret_key or ''}&".encode(),
                string_to_sign.encode(),
                hashlib.sha1,
            ).digest()
        ).decode()
        body = urlencode({**params, "Signature": signature}).encode()
        response = self.transport.request(
            "POST",
            self.settings.sms_api_endpoint,
            headers={
                "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
                "Accept": "application/json",
                "User-Agent": "license-center/1.1",
            },
            body=body,
        )
        if not 200 <= response.status_code < 300:
            raise DomainError("SMS provider rejected the request", status_code=502)
        try:
            result = json.loads(response.body)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise DomainError("SMS provider returned invalid data", status_code=502) from exc
        if result.get("Code") != "OK":
            raise DomainError("SMS provider rejected the verification message", status_code=502)
        request_id = result.get("RequestId")
        return str(request_id) if request_id else None

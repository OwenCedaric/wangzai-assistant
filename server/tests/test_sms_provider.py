from __future__ import annotations

import base64
import hashlib
import hmac
import json
from urllib.parse import parse_qs, quote

import pytest

from app.config import Settings
from app.services.errors import DomainError
from app.services.payments.http import HttpResponse
from app.services.sms.aliyun import AliyunSmsProvider
from app.services.sms.providers import build_sms_provider, sms_provider_status


def _percent(value: str) -> str:
    return quote(value, safe="~")


class SmsTransport:
    def __init__(self, response: dict[str, object]) -> None:
        self.response = response
        self.params: dict[str, str] = {}

    def request(self, method, url, *, headers, body, timeout=10):
        del url, headers, timeout
        assert method == "POST"
        self.params = {key: values[0] for key, values in parse_qs(body.decode()).items()}
        signature = self.params.pop("Signature")
        canonical = "&".join(
            f"{_percent(key)}={_percent(self.params[key])}" for key in sorted(self.params)
        )
        expected = base64.b64encode(
            hmac.new(
                b"aliyun-test-secret&",
                f"POST&%2F&{_percent(canonical)}".encode(),
                hashlib.sha1,
            ).digest()
        ).decode()
        assert hmac.compare_digest(signature, expected)
        return HttpResponse(200, {}, json.dumps(self.response).encode())


def test_aliyun_sms_request_is_signed_and_contains_template_code() -> None:
    settings = Settings(
        sms_provider="aliyun",
        sms_access_key="aliyun-test-key",
        sms_secret_key="aliyun-test-secret",
        sms_sign_name="授权中心",
        sms_template_code="SMS_123456",
    )
    transport = SmsTransport({"Code": "OK", "RequestId": "request-001"})
    provider = AliyunSmsProvider(settings, transport=transport)
    assert provider.send_verification_code("13800138000", "654321") == "request-001"
    assert transport.params["PhoneNumbers"] == "13800138000"
    assert transport.params["TemplateCode"] == "SMS_123456"
    assert json.loads(transport.params["TemplateParam"]) == {"code": "654321"}


def test_aliyun_sms_provider_error_fails_closed() -> None:
    settings = Settings(
        sms_provider="aliyun",
        sms_access_key="aliyun-test-key",
        sms_secret_key="aliyun-test-secret",
        sms_sign_name="授权中心",
        sms_template_code="SMS_123456",
    )
    provider = AliyunSmsProvider(
        settings,
        transport=SmsTransport({"Code": "isv.BUSINESS_LIMIT_CONTROL", "RequestId": "x"}),
    )
    with pytest.raises(DomainError, match="rejected"):
        provider.send_verification_code("13800138000", "654321")


def test_sms_provider_configuration_is_fail_closed() -> None:
    configured, _ = sms_provider_status(Settings(sms_provider="aliyun"))
    assert configured is False
    with pytest.raises(RuntimeError, match="credentials"):
        build_sms_provider(Settings(sms_provider="aliyun"))

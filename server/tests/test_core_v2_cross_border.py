from __future__ import annotations

import json

import httpx

from app.config import Settings
from app.core_v2.cross_border import (
    CrossBorderFailure,
    authorize_user,
    confirm_write,
    create_write_preview,
    public_endpoints,
    request_endpoint,
    revoke_user_authorization,
)


def test_server_registry_includes_official_order_association_and_status_sync() -> None:
    endpoints = {item["key"]: item["risk"] for item in public_endpoints()}
    assert endpoints["order.associate"] == "write"
    assert endpoints["order.syncStatus"] == "write"


def _settings(tmp_path) -> Settings:
    return Settings(
        _env_file=None,
        jwt_secret_key="cross-border-tests-jwt-secret-key-material",
        cross_border_company_secret="enterprise-company-secret-marker",
        cross_border_company_secret_file=None,
        cross_border_token_state_file=str(tmp_path / "enterprise-token.enc"),
        cross_border_grant_ttl_seconds=3600,
    )


def test_server_authorizes_user_and_never_returns_enterprise_credentials(tmp_path) -> None:
    observed: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content or b"{}")
        observed.append({"path": request.url.path, "headers": dict(request.headers), "body": body})
        if request.url.path == "/erpapi/token/index":
            return httpx.Response(
                200,
                json={
                    "code": 1,
                    "data": {
                        "access_token": "enterprise-token",
                        "expires_token": "enterprise-refresh",
                    },
                },
            )
        if request.url.path == "/erpapi/user/authorization":
            assert request.headers["k-client-secret"] == "enterprise-company-secret-marker"
            assert request.headers["authorization"] == "enterprise-token"
            assert body == {"user_name": "bus-user", "password": "bus-password"}
            return httpx.Response(200, json={"code": 1, "data": {"app_uid": "authorized-app-uid"}})
        raise AssertionError(request.url.path)

    settings = _settings(tmp_path)
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        result = authorize_user(
            settings,
            user_id=7,
            project_code="wangzai_desktop_v2_test",
            account_ref="cross-border-account-1",
            user_name="bus-user",
            password="bus-password",
            client=client,
        )

    assert result["authorized"] is True
    assert result["authorization_ref"]
    public_text = json.dumps(result, ensure_ascii=False)
    assert "enterprise-company-secret-marker" not in public_text
    assert "enterprise-token" not in public_text
    assert "enterprise-refresh" not in public_text
    assert "authorized-app-uid" not in public_text
    assert "bus-password" not in public_text
    assert len(observed) == 2
    assert (tmp_path / "enterprise-token.enc").is_file()
    encrypted_state = (tmp_path / "enterprise-token.enc").read_bytes()
    assert b"enterprise-token" not in encrypted_state
    assert b"enterprise-refresh" not in encrypted_state


def test_existing_enterprise_token_response_is_decoded_and_reset(tmp_path) -> None:
    paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        if request.url.path == "/erpapi/token/index":
            payload = json.dumps(
                {"code": 0, "message": "您已经生成Token,请使用expires_token获取最新Token"},
                ensure_ascii=False,
            ).encode("gb18030")
            return httpx.Response(
                401,
                content=payload,
                headers={"content-type": "application/json; charset=utf-8"},
            )
        if request.url.path == "/erpapi/token/resettoken":
            return httpx.Response(
                200,
                json={
                    "code": 1,
                    "data": {
                        "access_token": "reset-access-token",
                        "expires_token": "reset-expires-token",
                    },
                },
            )
        if request.url.path == "/erpapi/user/authorization":
            assert request.headers["authorization"] == "reset-access-token"
            return httpx.Response(
                200,
                json={"code": 1, "data": {"app_uid": "reset-app-uid"}},
            )
        raise AssertionError(request.url.path)

    settings = _settings(tmp_path)
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        result = authorize_user(
            settings,
            user_id=7,
            project_code="wangzai_desktop_v2_test",
            account_ref="cross-border-account-existing-token",
            user_name="bus-user",
            password="bus-password",
            client=client,
        )

    assert result["authorized"] is True
    assert paths == [
        "/erpapi/token/index",
        "/erpapi/token/resettoken",
        "/erpapi/user/authorization",
    ]
    encrypted_state = (tmp_path / "enterprise-token.enc").read_bytes()
    assert b"reset-access-token" not in encrypted_state
    assert b"reset-expires-token" not in encrypted_state


def test_existing_user_authorization_uses_returned_app_uid_without_a_previous_grant(
    tmp_path,
) -> None:
    paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        if request.url.path == "/erpapi/token/index":
            return httpx.Response(200, json={"code": 1, "data": {"access_token": "token-c"}})
        if request.url.path == "/erpapi/user/authorization":
            return httpx.Response(
                200,
                json={"code": 2, "message": "用户已授权", "app_uid": "app-c"},
            )
        if request.url.path == "/erpapi/user/queryauthorization":
            assert request.headers["k-app-uid"] == "app-c"
            return httpx.Response(200, json={"code": 1, "message": "用户授权正常"})
        raise AssertionError(request.url.path)

    settings = _settings(tmp_path)
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        authorization = authorize_user(
            settings,
            user_id=7,
            project_code="wangzai_desktop_v2_test",
            account_ref="cross-border-account-existing-user",
            user_name="bus-user",
            password="bus-password",
            client=client,
        )

    assert authorization["authorized"] is True
    assert paths == [
        "/erpapi/token/index",
        "/erpapi/user/authorization",
        "/erpapi/user/queryauthorization",
    ]


def test_revoke_uses_the_opaque_grant_and_requires_failed_authorization_readback(tmp_path) -> None:
    paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        if request.url.path == "/erpapi/token/index":
            return httpx.Response(200, json={"code": 1, "data": {"access_token": "token-r"}})
        if request.url.path == "/erpapi/user/authorization":
            return httpx.Response(200, json={"code": 1, "app_uid": "app-r"})
        if request.url.path == "/erpapi/user/unauthorization":
            assert request.headers["k-app-uid"] == "app-r"
            return httpx.Response(200, json={"code": 1, "message": "解除授权成功"})
        if request.url.path == "/erpapi/user/queryauthorization":
            return httpx.Response(200, json={"code": 2, "message": "用户未授权"})
        raise AssertionError(request.url.path)

    settings = _settings(tmp_path)
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        authorization = authorize_user(
            settings,
            user_id=7,
            project_code="wangzai_desktop_v2_test",
            account_ref="cross-border-account-revoke",
            user_name="bus-user",
            password="bus-password",
            client=client,
        )
        result = revoke_user_authorization(
            settings,
            user_id=7,
            project_code="wangzai_desktop_v2_test",
            account_ref="cross-border-account-revoke",
            authorization_ref=authorization["authorization_ref"],
            client=client,
        )

    assert result["revoked"] is True
    assert "app-r" not in json.dumps(result)
    assert paths == [
        "/erpapi/token/index",
        "/erpapi/user/authorization",
        "/erpapi/user/unauthorization",
        "/erpapi/user/queryauthorization",
    ]


def test_read_and_confirm_write_use_the_server_grant_and_exact_endpoint_registry(tmp_path) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path == "/erpapi/token/index":
            return httpx.Response(
                200,
                json={"code": 1, "data": {"access_token": "token-a", "expires_token": "refresh-a"}},
            )
        if request.url.path == "/erpapi/user/authorization":
            return httpx.Response(200, json={"code": 1, "data": {"app_uid": "app-a"}})
        assert request.headers["k-client-secret"] == "enterprise-company-secret-marker"
        assert request.headers["authorization"] == "token-a"
        assert request.headers["k-app-uid"] == "app-a"
        if request.url.path == "/erpapi/orderlist/search":
            return httpx.Response(
                200, json={"code": 1, "data": {"list": [{"order_id": "order-1"}]}}
            )
        if request.url.path == "/erpapi/order/createOrder":
            return httpx.Response(200, json={"code": 1, "data": {"order_id": "created-1"}})
        raise AssertionError(request.url.path)

    settings = _settings(tmp_path)
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        authorization = authorize_user(
            settings,
            user_id=7,
            project_code="wangzai_desktop_v2_test",
            account_ref="cross-border-account-1",
            user_name="bus-user",
            password="bus-password",
            client=client,
        )
        read = request_endpoint(
            settings,
            user_id=7,
            project_code="wangzai_desktop_v2_test",
            authorization_ref=authorization["authorization_ref"],
            endpoint_key="order.search",
            body={"order_number": "order-1"},
            expected_risk="read",
            client=client,
        )
        preview = create_write_preview(
            settings,
            user_id=7,
            project_code="wangzai_desktop_v2_test",
            authorization_ref=authorization["authorization_ref"],
            endpoint_key="order.create",
            body={"order_number": "order-2"},
            request_id="request-1",
        )
        written = confirm_write(
            settings,
            user_id=7,
            project_code="wangzai_desktop_v2_test",
            authorization_ref=authorization["authorization_ref"],
            preview_token=preview["preview_token"],
            client=client,
        )

    assert read["data"]["data"]["list"][0]["order_id"] == "order-1"
    assert preview["requires_confirmation"] is True
    assert written["data"]["data"]["order_id"] == "created-1"
    assert [request.url.path for request in requests] == [
        "/erpapi/token/index",
        "/erpapi/user/authorization",
        "/erpapi/orderlist/search",
        "/erpapi/order/createOrder",
    ]


def test_grant_is_bound_to_the_exact_user_and_project(tmp_path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/erpapi/token/index":
            return httpx.Response(200, json={"code": 1, "data": {"access_token": "token-b"}})
        return httpx.Response(200, json={"code": 1, "data": {"app_uid": "app-b"}})

    settings = _settings(tmp_path)
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        authorization = authorize_user(
            settings,
            user_id=7,
            project_code="wangzai_desktop_v2_test",
            account_ref="account-b",
            user_name="user-b",
            password="password-b",
            client=client,
        )
        try:
            request_endpoint(
                settings,
                user_id=8,
                project_code="wangzai_desktop_v2_test",
                authorization_ref=authorization["authorization_ref"],
                endpoint_key="order.search",
                body={},
                expected_risk="read",
                client=client,
            )
        except CrossBorderFailure as exc:
            assert exc.code == "CROSS_BORDER_GRANT_SCOPE_MISMATCH"
        else:
            raise AssertionError("cross-user grant replay was accepted")


def test_missing_server_enterprise_secret_fails_before_network(tmp_path) -> None:
    settings = _settings(tmp_path)
    settings.cross_border_company_secret = None
    called = False

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal called
        called = True
        return httpx.Response(500)

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        try:
            authorize_user(
                settings,
                user_id=1,
                project_code="test",
                account_ref="account",
                user_name="user",
                password="password",
                client=client,
            )
        except CrossBorderFailure as exc:
            assert exc.code == "CROSS_BORDER_SERVER_SECRET_REQUIRED"
        else:
            raise AssertionError("missing enterprise secret was accepted")
    assert called is False


def test_admin_saves_enterprise_secret_only_to_the_server_file(
    client,
    admin_headers,
    tmp_path,
) -> None:
    secret_path = tmp_path / "cross-border-company-secret"
    settings = client.app.state.settings
    settings.cross_border_company_secret = None
    settings.cross_border_company_secret_file = str(secret_path)
    settings.cross_border_token_state_file = str(tmp_path / "token-state.enc")
    denied = client.put(
        "/api/admin/cross-border-provider/secret",
        json={"company_secret": "server-company-secret-marker"},
    )
    assert denied.status_code == 401
    saved = client.put(
        "/api/admin/cross-border-provider/secret",
        headers=admin_headers,
        json={"company_secret": "server-company-secret-marker"},
    )
    assert saved.status_code == 200, saved.text
    assert "server-company-secret-marker" not in saved.text
    assert secret_path.read_text(encoding="utf-8").strip() == "server-company-secret-marker"
    status = client.get(
        "/api/admin/cross-border-provider/status",
        headers=admin_headers,
    )
    assert status.status_code == 200
    assert status.json()["configured"] is True


def test_cross_border_core_routes_require_login(client) -> None:
    requests = [
        (
            "/api/core-v2/cross-border/authorize",
            {"account_ref": "account-1", "user_name": "user", "password": "password"},
        ),
        (
            "/api/core-v2/cross-border/revoke",
            {"account_ref": "account-1", "authorization_ref": "x" * 64},
        ),
    ]
    for path, payload in requests:
        response = client.post(path, json=payload)
        assert response.status_code == 401

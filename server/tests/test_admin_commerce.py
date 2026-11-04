from fastapi.testclient import TestClient

from tests.helpers import create_catalog


def test_admin_agent_channel_commission_rule_crud(
    client: TestClient, admin_headers: dict[str, str]
) -> None:
    catalog = create_catalog(client, admin_headers)
    project_id = catalog["project"]["id"]
    plan_id = catalog["plan"]["id"]
    created = client.post(
        "/api/admin/agents",
        headers=admin_headers,
        json={
            "code": "CRUD_AGENT",
            "name": "CRUD 代理",
            "default_commission_rate_bps": 800,
            "project_ids": [project_id],
        },
    )
    assert created.status_code == 201, created.text
    agent = created.json()
    assert agent["project_ids"] == [project_id]

    updated = client.put(
        f"/api/admin/agents/{agent['id']}",
        headers=admin_headers,
        json={"contact_name": "联系人", "default_commission_rate_bps": 900},
    )
    assert updated.status_code == 200
    assert updated.json()["default_commission_rate_bps"] == 900

    channel_response = client.post(
        "/api/admin/channels",
        headers=admin_headers,
        json={
            "agent_id": agent["id"],
            "project_id": project_id,
            "code": "CRUD_CHANNEL",
            "name": "CRUD 渠道",
        },
    )
    assert channel_response.status_code == 201
    channel = channel_response.json()
    first_token = channel["distribution_token"]
    rotated = client.post(
        f"/api/admin/channels/{channel['id']}/rotate-token", headers=admin_headers
    )
    assert rotated.status_code == 200
    assert rotated.json()["distribution_token"] != first_token
    listed_channels = client.get("/api/admin/channels", headers=admin_headers)
    assert first_token not in listed_channels.text
    assert rotated.json()["distribution_token"] not in listed_channels.text

    rule_response = client.post(
        "/api/admin/commission-rules",
        headers=admin_headers,
        json={
            "agent_id": agent["id"],
            "project_id": project_id,
            "plan_id": plan_id,
            "rate_bps": 1200,
        },
    )
    assert rule_response.status_code == 201, rule_response.text
    rule = rule_response.json()
    assert (
        client.put(
            f"/api/admin/commission-rules/{rule['id']}",
            headers=admin_headers,
            json={"rate_bps": 1300},
        ).json()["rate_bps"]
        == 1300
    )
    assert (
        client.get(
            f"/api/admin/commission-rules?agent_id={agent['id']}", headers=admin_headers
        ).json()["total"]
        == 1
    )

    status = client.get("/api/admin/payment-config/status", headers=admin_headers)
    assert status.status_code == 200
    development = next(
        item for item in status.json()["providers"] if item["provider"] == "development"
    )
    assert development["configured"] is True
    assert development["enabled"] is True
    assert client.get("/api/admin/agents/dashboard", headers=admin_headers).status_code == 200

    assert (
        client.delete(
            f"/api/admin/commission-rules/{rule['id']}", headers=admin_headers
        ).status_code
        == 204
    )
    assert (
        client.delete(f"/api/admin/channels/{channel['id']}", headers=admin_headers).status_code
        == 204
    )
    assert (
        client.delete(f"/api/admin/agents/{agent['id']}", headers=admin_headers).status_code == 204
    )

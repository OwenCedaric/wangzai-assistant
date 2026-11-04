import json

import pytest
from sqlalchemy import func, select

from app.annual_registration_policy import load_annual_registration_policy
from app.config import Settings
from app.models import ShopIntroRedemption
from tests.helpers import create_cards, create_catalog, create_user, login_user
from tests.test_password_registration import desktop_auth_body
from tests.test_shop_card_rules import _activate


def test_selected_annual_batch_registers_and_other_batches_keep_original_rules(
    client, admin_headers,
):
    catalog = create_catalog(client, admin_headers)
    annual = client.post('/api/admin/plans', headers=admin_headers, json={
        'product_id': catalog['product']['id'], 'name': 'Annual registration fixture',
        'price': '600.00', 'sale_price_cent': 60000, 'license_role': 'shop_standard_annual',
        'duration_days': 365, 'max_devices': 1, 'max_shops': 1,
        'permission_ids': [p['id'] for p in catalog['permissions']],
    })
    assert annual.status_code == 201
    selected = create_cards(client, admin_headers, annual.json()['id'], quantity=3)
    other = create_cards(client, admin_headers, annual.json()['id'], quantity=1)
    monthly = create_cards(client, admin_headers, catalog['plan']['id'], quantity=1)
    settings = client.app.state.settings
    settings.registration_annual_batches = {'ozon_helper': [selected['id'], monthly['id']]}
    for card in [other['codes'][0], monthly['codes'][0]]:
        denied = client.post('/api/auth/register', json=desktop_auth_body(card_key=card))
        assert denied.status_code == 409
    good = client.post('/api/auth/register', json=desktop_auth_body(card_key=selected['codes'][0]))
    assert good.status_code == 201, good.text
    assert good.json()['entitlement']['license_role'] == 'shop_standard_annual'
    assert good.json()['entitlement']['valid'] is True
    reused = client.post('/api/auth/register', json=desktop_auth_body(
        email='other@example.com', card_key=selected['codes'][0]))
    assert reused.status_code == 409
    settings.registration_annual_batches = {'another_project': [selected['id']]}
    wrong_scope = client.post('/api/auth/register', json=desktop_auth_body(
        email='other@example.com', card_key=selected['codes'][1]))
    assert wrong_scope.status_code == 409
    create_user(client, admin_headers)
    activated = _activate(client, login_user(client), selected['codes'][2])
    assert activated.status_code == 200 and activated.json()['valid']
    with client.app.state.session_factory() as db:
        assert db.scalar(select(func.count(ShopIntroRedemption.id))) == 0


@pytest.mark.parametrize('raw', ['{', '{"project_code":"ozon_helper","batch_ids":[true]}',
    '{"project_code":"ozon_helper","batch_ids":[1,1]}',
    '{"project_code":"ozon_helper","batch_ids":[0]}',
    '{"project_code":"ozon_helper","batch_ids":[1],"extra":true}'])
def test_invalid_policy_fails_closed(tmp_path, raw):
    file = tmp_path / 'policy.json'
    file.write_text(raw, encoding='utf8')
    result = load_annual_registration_policy(Settings(_env_file=None), file)
    assert result.registration_annual_batches == {}


def test_valid_and_missing_policy_preserve_other_settings(tmp_path):
    base = Settings(_env_file=None)
    file = tmp_path / 'policy.json'
    assert load_annual_registration_policy(base, file) is base
    file.write_text(json.dumps({'project_code': 'ozon_helper', 'batch_ids': [14]}), encoding='utf8')
    changed = load_annual_registration_policy(base, file)
    assert changed.registration_annual_batches == {'ozon_helper': [14]}
    assert all(getattr(base, k) == getattr(changed, k) for k in type(base).model_fields
               if k != 'registration_annual_batches')

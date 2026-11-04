from __future__ import annotations

import argparse
import base64
import json
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

from app.config import Settings
from app.services.payments.alipay import AlipayWebPaymentProvider

PROJECT_ROOT = Path(__file__).resolve().parents[2]
SECRET_DIR = PROJECT_ROOT / "deploy" / "secrets"
PRODUCTION_GATEWAY = "https://openapi.alipay.com/gateway.do"


def _read_secret(name: str) -> str:
    value = (SECRET_DIR / name).read_text(encoding="utf-8").strip()
    if not value:
        raise RuntimeError(f"Production secret file is empty: {name}")
    return value


def _settings() -> Settings:
    return Settings(
        _env_file=None,
        app_env="development",
        payment_default_provider="alipay",
        payment_gateway_mode="direct",
        payment_development_enabled=False,
        alipay_app_id=_read_secret("alipay_production_app_id"),
        alipay_private_pkcs_key=_read_secret(
            "alipay_production_private_pkcs_key"
        ),
        alipay_alipay_public_key=_read_secret(
            "alipay_production_alipay_public_key"
        ),
        alipay_notify_url="https://production-callback.invalid/api/payments/alipay/notify",
        alipay_gateway_url=PRODUCTION_GATEWAY,
    )


def _verify_checkout_batch(provider: AlipayWebPaymentProvider, count: int) -> None:
    public_key = provider.private_key.public_key()
    expires_at = datetime.now(UTC) + timedelta(minutes=15)
    seen_orders: set[str] = set()
    for index in range(count):
        order_no = f"PRODCHECK{datetime.now(UTC):%Y%m%d%H%M%S}{index:04d}"
        order = SimpleNamespace(
            order_no=order_no,
            amount_cent=1,
            plan_name_snapshot=f"production configuration check {index}",
            expires_at=expires_at,
        )
        checkout = provider.create_checkout(order)
        parsed = urlsplit(checkout.code_url)
        params = {key: values[0] for key, values in parse_qs(parsed.query).items()}
        if (parsed.scheme, parsed.netloc, parsed.path) != (
            "https",
            "openapi.alipay.com",
            "/gateway.do",
        ):
            raise RuntimeError("Checkout URL did not use the official production gateway")
        if params.get("method") != "alipay.trade.page.pay":
            raise RuntimeError("Checkout method is invalid")
        if params.get("app_id") != provider.settings.alipay_app_id:
            raise RuntimeError("Checkout APPID is invalid")
        if params.get("notify_url") != provider.settings.alipay_notify_url:
            raise RuntimeError("Checkout callback URL is missing")
        biz_content = json.loads(params["biz_content"])
        if biz_content.get("product_code") != "FAST_INSTANT_TRADE_PAY":
            raise RuntimeError("Checkout product code is invalid")
        if biz_content.get("out_trade_no") != order_no or order_no in seen_orders:
            raise RuntimeError("Checkout order number is invalid or duplicated")
        seen_orders.add(order_no)
        signature = base64.b64decode(params.pop("sign"), validate=True)
        signed_content = "&".join(f"{key}={params[key]}" for key in sorted(params))
        public_key.verify(
            signature,
            signed_content.encode(),
            padding.PKCS1v15(),
            hashes.SHA256(),
        )


def _verify_public_keys(provider: AlipayWebPaymentProvider) -> None:
    app_public = serialization.load_der_public_key(
        base64.b64decode(_read_secret("alipay_production_app_public_key"), validate=True)
    )
    if app_public.public_numbers() != provider.private_key.public_key().public_numbers():
        raise RuntimeError("Stored application public key does not match the private key")
    if provider.public_key.key_size != 2048:
        raise RuntimeError("Alipay public key is not RSA 2048")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Verify the saved Alipay production key exchange without charging"
    )
    parser.add_argument("--checkout-count", type=int, default=128)
    args = parser.parse_args()
    if not 1 <= args.checkout_count <= 1000:
        parser.error("--checkout-count must be between 1 and 1000")
    try:
        provider = AlipayWebPaymentProvider(_settings())
        _verify_public_keys(provider)
        _verify_checkout_batch(provider, args.checkout_count)
    except Exception as exc:
        print(f"Alipay production configuration verification failed: {exc}", file=sys.stderr)
        return 1
    print(
        json.dumps(
            {
                "verified": True,
                "signed_checkouts": args.checkout_count,
                "gateway": "official-production",
                "network_calls": 0,
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

from __future__ import annotations

import argparse
import base64
import json
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding

from app.config import Settings
from app.services.payments.alipay import AlipayWebPaymentProvider

PROJECT_ROOT = Path(__file__).resolve().parents[2]
SECRET_DIR = PROJECT_ROOT / "deploy" / "secrets"
SANDBOX_GATEWAY = "https://openapi-sandbox.dl.alipaydev.com/gateway.do"


def _read_secret(name: str) -> str:
    value = (SECRET_DIR / name).read_text(encoding="utf-8").strip()
    if not value:
        raise RuntimeError(f"Sandbox secret file is empty: {name}")
    return value


def _settings() -> Settings:
    return Settings(
        _env_file=None,
        app_env="development",
        payment_default_provider="alipay",
        payment_gateway_mode="direct",
        payment_development_enabled=False,
        alipay_app_id=_read_secret("alipay_sandbox_app_id"),
        alipay_private_pkcs_key=_read_secret("alipay_sandbox_private_pkcs_key"),
        alipay_alipay_public_key=_read_secret("alipay_sandbox_alipay_public_key"),
        alipay_notify_url="https://sandbox-callback.invalid/api/payments/alipay/notify",
        alipay_gateway_url=SANDBOX_GATEWAY,
    )


def _verify_checkout_batch(provider: AlipayWebPaymentProvider, count: int) -> None:
    seen_orders: set[str] = set()
    public_key = provider.private_key.public_key()
    expires_at = datetime.now(UTC) + timedelta(minutes=15)
    for index in range(count):
        order_no = f"SBOX{datetime.now(UTC):%Y%m%d%H%M%S}{index:04d}"
        order = SimpleNamespace(
            order_no=order_no,
            amount_cent=1,
            plan_name_snapshot=f"积分沙箱验证 {index}",
            expires_at=expires_at,
        )
        checkout = provider.create_checkout(order)
        parsed = urlsplit(checkout.code_url)
        params = {key: values[0] for key, values in parse_qs(parsed.query).items()}
        if (parsed.scheme, parsed.netloc, parsed.path) != (
            "https",
            "openapi-sandbox.dl.alipaydev.com",
            "/gateway.do",
        ):
            raise RuntimeError("Checkout URL did not use the official sandbox gateway")
        if params.get("method") != "alipay.trade.page.pay":
            raise RuntimeError("Checkout method is invalid")
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


def _verify_live_queries(provider: AlipayWebPaymentProvider, count: int) -> None:
    for index in range(count):
        order = SimpleNamespace(
            order_no=f"SBOXQUERY{datetime.now(UTC):%Y%m%d%H%M%S%f}{index}",
            amount_cent=1,
            currency="CNY",
        )
        result = provider.query(order, SimpleNamespace())
        if result.status != "pending":
            raise RuntimeError("A nonexistent sandbox order returned an unexpected status")


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify the official Alipay sandbox setup")
    parser.add_argument("--checkout-count", type=int, default=128)
    parser.add_argument("--live-query-count", type=int, default=3)
    args = parser.parse_args()
    if not 1 <= args.checkout_count <= 1000:
        parser.error("--checkout-count must be between 1 and 1000")
    if not 0 <= args.live_query_count <= 20:
        parser.error("--live-query-count must be between 0 and 20")
    try:
        provider = AlipayWebPaymentProvider(_settings())
        _verify_checkout_batch(provider, args.checkout_count)
        _verify_live_queries(provider, args.live_query_count)
    except Exception as exc:
        print(f"Alipay sandbox verification failed: {exc}", file=sys.stderr)
        return 1
    print(
        json.dumps(
            {
                "verified": True,
                "signed_checkouts": args.checkout_count,
                "live_signed_queries": args.live_query_count,
                "gateway": "official-sandbox",
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

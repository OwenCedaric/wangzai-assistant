"""Phone registration and online purchase example for License Center SDK 1.1."""

from __future__ import annotations

import os

from license_sdk import License


def main() -> None:
    client = License(
        app=os.environ.get("LICENSE_PROJECT_CODE", "your_project_code"),
        version=os.environ.get("LICENSE_CLIENT_VERSION", "1.0.0"),
        base_url=os.environ.get("LICENSE_CENTER_URL", "http://127.0.0.1:8000"),
        device_code=os.environ.get("LICENSE_DEVICE_CODE"),
        channel_code=os.environ.get("LICENSE_CHANNEL_CODE"),
        distribution_token=os.environ.get("LICENSE_DISTRIBUTION_TOKEN"),
    )
    phone = input("手机号：").strip()
    challenge = client.send_sms_code(phone)
    development_hint = challenge.development_code
    if development_hint:
        print(f"开发环境验证码：{development_hint}")
    client.verify_sms_code(phone, input("验证码：").strip())

    plans = client.list_store_plans()
    if not plans.items:
        raise RuntimeError("当前项目没有可在线购买的套餐")
    order = client.create_order(plans.items[0].id)
    checkout = client.start_payment(order.id, provider="wechat")
    print(f"请扫码支付：{checkout.qr_code_url or checkout.code_url}")

    activated = client.wait_for_fulfillment_and_activate(order.id, timeout=300)
    print(f"激活成功，有效期至：{activated.license_status.expire}")


if __name__ == "__main__":
    main()

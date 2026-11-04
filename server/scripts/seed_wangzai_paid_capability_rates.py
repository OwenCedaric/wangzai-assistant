from __future__ import annotations

import argparse
import sys
from datetime import UTC, datetime
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select

from app.config import get_settings  # noqa: E402
from app.database import build_engine, build_session_factory  # noqa: E402
from app.models import Project  # noqa: E402
from app.models.paid_capabilities import PaidCapabilityRateCard  # noqa: E402
from app.paid_capabilities.registry import get_paid_capability  # noqa: E402
from app.paid_capabilities.wangzai_rates import wangzai_rate_specs  # noqa: E402


def _comparable(rate: PaidCapabilityRateCard) -> dict[str, object]:
    fields = (
        "capability",
        "version",
        "price_version",
        "provider_code",
        "provider_model",
        "input_micros_per_million",
        "output_micros_per_million",
        "cached_input_micros_per_million",
        "fixed_cost_micros",
        "unit_cost_micros",
        "unit_sell_price_micros",
        "provider_multiplier_ppm",
        "customer_multiplier_ppm",
        "risk_buffer_basis_points",
        "target_margin_basis_points",
        "minimum_margin_basis_points",
        "points_per_cny",
        "currency",
    )
    return {field: getattr(rate, field) for field in fields}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--replace-active-text",
        action="store_true",
        help="以新的不可变版本替换所有旺崽文本模型价卡",
    )
    args = parser.parse_args()
    settings = get_settings()
    engine = build_engine(settings.database_url, echo=settings.sql_echo)
    session_factory = build_session_factory(engine)
    created = 0
    replaced = 0
    skipped = 0
    try:
        with session_factory() as db:
            project = db.scalar(
                select(Project).where(Project.code == "wangzai_desktop").with_for_update()
            )
            if project is None:
                raise SystemExit("Project wangzai_desktop does not exist")
            for spec in wangzai_rate_specs():
                if args.replace_active_text and not str(spec["capability"]).startswith("text."):
                    continue
                descriptor = get_paid_capability(spec["capability"], spec["version"])
                expected_provider = {
                    "text": "builtin-text",
                    "image": "builtin-image",
                    "seerfar": "seerfar",
                }[descriptor.provider_kind]
                if spec["provider_code"] != expected_provider:
                    raise SystemExit(f"Provider mismatch for {spec['capability']}")

                existing = db.scalar(
                    select(PaidCapabilityRateCard).where(
                        PaidCapabilityRateCard.project_id == project.id,
                        PaidCapabilityRateCard.capability == spec["capability"],
                        PaidCapabilityRateCard.version == spec["version"],
                        PaidCapabilityRateCard.price_version == spec["price_version"],
                        PaidCapabilityRateCard.provider_model == spec["provider_model"],
                    )
                )
                expected = {
                    key: value
                    for key, value in spec.items()
                    if key not in {"effective_from", "effective_until"}
                }
                if existing is not None:
                    if _comparable(existing) != expected or existing.status != "active":
                        raise SystemExit(f"Immutable rate drift detected for {spec['capability']}")
                    skipped += 1
                    continue

                active_rows = list(
                    db.scalars(
                        select(PaidCapabilityRateCard)
                        .where(
                        PaidCapabilityRateCard.project_id == project.id,
                        PaidCapabilityRateCard.capability == spec["capability"],
                        PaidCapabilityRateCard.version == spec["version"],
                        PaidCapabilityRateCard.provider_model == spec["provider_model"],
                        PaidCapabilityRateCard.status == "active",
                        )
                        .with_for_update()
                    ).all()
                )
                if active_rows and not (
                    args.replace_active_text and str(spec["capability"]).startswith("text.")
                ):
                    raise SystemExit(
                        f"An active rate already exists for {spec['capability']}; "
                        "disable it through the audited admin API before replacing it"
                    )
                effective_spec = dict(spec)
                if active_rows:
                    effective_from = datetime.now(UTC)
                    effective_spec["effective_from"] = effective_from
                    for active in active_rows:
                        active.status = "disabled"
                        if (
                            active.effective_until is None
                            or active.effective_until > effective_from
                        ):
                            active.effective_until = effective_from
                        replaced += 1
                db.add(
                    PaidCapabilityRateCard(
                        project_id=project.id,
                        status="active",
                        **effective_spec,
                    )
                )
                created += 1
            db.commit()
    finally:
        engine.dispose()
    print(
        "wangzai_desktop paid rates ready: "
        f"created={created}, replaced={replaced}, skipped={skipped}"
    )


if __name__ == "__main__":
    main()

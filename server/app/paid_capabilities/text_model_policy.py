from __future__ import annotations

from typing import Literal

AllowedTextModel = Literal["gpt-5.6-terra", "gpt-5.6-sol"]
AllowedReasoningEffort = Literal["low", "medium", "high"]

ALLOWED_TEXT_MODELS: tuple[str, ...] = (
    "gpt-5.6-terra",
    "gpt-5.6-sol",
)
ALLOWED_REASONING_EFFORTS: tuple[str, ...] = ("low", "medium", "high")
DEFAULT_TEXT_MODEL: AllowedTextModel = "gpt-5.6-terra"
DEFAULT_REASONING_EFFORT: AllowedReasoningEffort = "medium"


def text_model_is_allowed(value: object) -> bool:
    return str(value or "").strip() in ALLOWED_TEXT_MODELS


def reasoning_effort_is_allowed(value: object) -> bool:
    return str(value or "").strip() in ALLOWED_REASONING_EFFORTS

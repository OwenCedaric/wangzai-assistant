from __future__ import annotations

from app.paid_capabilities.image_model_policy import (
    APPROVED_IMAGE_API_BASE_URL,
    APPROVED_IMAGE_MODEL,
    image_provider_is_allowed,
)


def test_image_policy_allows_only_fixed_endpoint_and_model() -> None:
    assert image_provider_is_allowed(APPROVED_IMAGE_API_BASE_URL, APPROVED_IMAGE_MODEL)
    assert image_provider_is_allowed(f'{APPROVED_IMAGE_API_BASE_URL}/', APPROVED_IMAGE_MODEL)
    assert not image_provider_is_allowed(
        'https://direct.images.example.invalid/v1', APPROVED_IMAGE_MODEL
    )
    assert not image_provider_is_allowed(
        'https://images.example.invalid/v1/extra', APPROVED_IMAGE_MODEL
    )
    assert not image_provider_is_allowed(APPROVED_IMAGE_API_BASE_URL, 'gpt-image-2-adobe')
    assert not image_provider_is_allowed(APPROVED_IMAGE_API_BASE_URL, 'gemini-banana')

"""Operator-selected annual-card batches may also create a new account."""
import json
import logging
import stat
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, StrictInt, field_validator


class AnnualRegistrationPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid")
    project_code: str = Field(pattern=r"^[a-z][a-z0-9_.-]{1,63}$")
    batch_ids: list[StrictInt] = Field(max_length=100)

    @field_validator("batch_ids")
    @classmethod
    def valid_ids(cls, value):
        if any(item <= 0 for item in value) or len(set(value)) != len(value):
            raise ValueError("Invalid batch selection")
        return value


def load_annual_registration_policy(settings, file: Path):
    try:
        info = file.lstat()
    except FileNotFoundError:
        return settings
    except OSError:
        return settings.model_copy(update={"registration_annual_batches": {}})
    try:
        if (not stat.S_ISREG(info.st_mode) or file.is_symlink()
                or info.st_nlink != 1 or not 0 < info.st_size <= 16384):
            raise ValueError("Unsafe policy file")
        raw = file.read_bytes()
        if len(raw) > 16384:
            raise ValueError("Oversized policy")
        policy = AnnualRegistrationPolicy.model_validate(json.loads(raw))
        return settings.model_copy(update={"registration_annual_batches": {
            policy.project_code: policy.batch_ids,
        }})
    except (OSError, ValueError):
        logging.getLogger(__name__).warning(
            "Annual registration policy rejected; exception disabled",
        )
        return settings.model_copy(update={"registration_annual_batches": {}})


def permits_annual_registration(settings, project_code, batch_id, license_role):
    return (license_role == "shop_standard_annual"
            and batch_id in settings.registration_annual_batches.get(project_code, []))

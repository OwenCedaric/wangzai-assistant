from __future__ import annotations

import json
import logging
import stat
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictStr, field_validator

logger = logging.getLogger(__name__)


class PilotRuntimeSettings(BaseModel):
    """Only the new stateless compute/update settings may override the base service."""

    model_config = ConfigDict(extra="forbid")
    private_profit_core_file: StrictStr = Field(min_length=1, max_length=4096)
    private_profit_core_sha256: StrictStr = Field(pattern=r"^[a-f0-9]{64}$")
    private_profit_node_executable: StrictStr = Field(min_length=1, max_length=4096)
    client_updates_enabled: StrictBool
    client_update_bundle_file: StrictStr = Field(min_length=1, max_length=4096)
    client_update_project_code: StrictStr = Field(pattern=r"^[A-Za-z0-9._-]{1,128}$")
    client_update_app_id: StrictStr = Field(pattern=r"^[A-Za-z0-9._-]{1,128}$")
    client_update_channel: StrictStr = Field(pattern=r"^[A-Za-z0-9_-]{1,40}$")

    @field_validator(
        "private_profit_core_file", "private_profit_node_executable", "client_update_bundle_file",
    )
    @classmethod
    def absolute_path(cls, value: str) -> str:
        if not Path(value).is_absolute():
            raise ValueError("pilot runtime paths must be absolute")
        return value


def _disable_pilot(base, error):
    logger.warning("Private pilot configuration rejected; pilot disabled (%s)",
                   type(error).__name__)
    return base.model_copy(update={
        "private_profit_core_file": None,
        "private_profit_core_sha256": "",
        "private_profit_node_executable": None,
        "client_updates_enabled": False,
        "client_update_bundle_file": None,
    })


def load_pilot_runtime_settings(base, config_path: Path):
    """Missing file preserves all base settings. Invalid file disables only pilot features.

    Never print input values: a malformed file might contain unrelated credentials.
    This is read once by the existing cached startup settings loader, not a hot reload.
    """
    try:
        info = config_path.lstat()
    except FileNotFoundError:
        return base
    except OSError as error:
        return _disable_pilot(base, error)
    try:
        if (
            not stat.S_ISREG(info.st_mode)
            or config_path.is_symlink()
            or info.st_nlink != 1
            or not 0 < info.st_size <= 16 * 1024
        ):
            raise ValueError("invalid pilot configuration file")
        raw = config_path.read_bytes()
        if len(raw) > 16 * 1024:
            raise ValueError("pilot configuration exceeds limit")
        overlay = PilotRuntimeSettings.model_validate(json.loads(raw))
        return base.model_copy(update=overlay.model_dump())
    except (OSError, ValueError) as error:
        return _disable_pilot(base, error)

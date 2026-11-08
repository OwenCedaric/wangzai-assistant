from __future__ import annotations

import secrets
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / ".runtime"
SOURCE = RUNTIME / "jeepay-source"
UI = RUNTIME / "jeepay-ui"
ENV_FILE = Path(__file__).with_name(".env")
PATCH_DIR = Path(__file__).with_name("patches")

REPOSITORIES = (
    (
        SOURCE,
        "https://github.com/jeequan/jeepay.git",
        "ba37111934c9c04183cc6cbdbdafc7f38941fa4b",
    ),
    (
        UI,
        "https://github.com/jeequan/jeepay-ui.git",
        "17d057db22ae45babc15bd7cb43e5f73756dd080",
    ),
)


def run(*args: str, cwd: Path | None = None) -> str:
    result = subprocess.run(
        args,
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    return result.stdout.strip()


def prepare_repository(path: Path, url: str, commit: str) -> None:
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        run("git", "clone", url, str(path))
        run("git", "checkout", "--detach", commit, cwd=path)
    actual = run("git", "rev-parse", "HEAD", cwd=path)
    if actual != commit:
        raise RuntimeError(
            f"{path} is at {actual}; expected pinned commit {commit}. "
            "Review the source before changing the pin."
        )


def apply_security_patches() -> None:
    for patch in sorted(PATCH_DIR.glob("*.patch")):
        check = subprocess.run(
            ["git", "apply", "--check", str(patch)],
            cwd=SOURCE,
            capture_output=True,
        )
        if check.returncode == 0:
            run("git", "apply", str(patch), cwd=SOURCE)
            continue
        already_applied = subprocess.run(
            ["git", "apply", "--reverse", "--check", str(patch)],
            cwd=SOURCE,
            capture_output=True,
        )
        if already_applied.returncode != 0:
            raise RuntimeError(f"Security patch cannot be applied cleanly: {patch.name}")


def prepare_environment() -> None:
    values: dict[str, str] = {}
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                values[key] = value
    generated = {
        "MYSQL_ROOT_PASSWORD": secrets.token_hex(32),
        "JEEPAY_DB_PASSWORD": secrets.token_hex(32),
        "JEEPAY_REDIS_PASSWORD": secrets.token_hex(32),
        "JEEPAY_MANAGER_JWT_SECRET": secrets.token_hex(32),
        "JEEPAY_MERCHANT_JWT_SECRET": secrets.token_hex(32),
        "JEEPAY_MANAGER_ADMIN_USERNAME": "jeepay",
        "JEEPAY_MANAGER_ADMIN_PASSWORD": "Jp!" + secrets.token_urlsafe(24),
    }
    for key, value in generated.items():
        values.setdefault(key, value)
    ENV_FILE.write_text(
        "\n".join(f"{key}={value}" for key, value in values.items()) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    for repository in REPOSITORIES:
        prepare_repository(*repository)
    apply_security_patches()
    prepare_environment()
    print("Jeepay sources are pinned and the private environment is ready.")


if __name__ == "__main__":
    main()

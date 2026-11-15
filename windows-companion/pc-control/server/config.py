"""
config.py — load and expose plugin configuration from config.yaml.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import yaml

_CONFIG: dict[str, Any] | None = None


def _find_config_path() -> Path:
    """Resolve config path: env var override → sibling config.yaml."""
    env = os.environ.get("PC_CONTROL_CONFIG")
    if env:
        p = Path(env)
        if p.is_file():
            return p
    # Default: same directory as this file
    return Path(__file__).parent / "config.yaml"


def load_config() -> dict[str, Any]:
    global _CONFIG
    if _CONFIG is not None:
        return _CONFIG
    path = _find_config_path()
    with open(path, "r", encoding="utf-8") as fh:
        _CONFIG = yaml.safe_load(fh) or {}
    return _CONFIG


def get(section: str, key: str | None = None, default: Any = None) -> Any:
    cfg = load_config()
    section_data = cfg.get(section, {})
    if key is None:
        return section_data
    return section_data.get(key, default)


def is_dry_run() -> bool:
    return bool(get("security", "dry_run", False))


def is_readonly_mode() -> bool:
    return get("security", "mode", "active") == "readonly"


def get_log_dir() -> Path:
    env = os.environ.get("PC_CONTROL_LOG_DIR")
    if env:
        d = Path(env)
    else:
        audit_cfg = get("audit", default={})
        d = Path(__file__).parent / audit_cfg.get("log_dir", "logs")
    d.mkdir(parents=True, exist_ok=True)
    return d


def get_blocked_paths() -> list[str]:
    return get("files", "blocked_paths", [])


def get_destructive_patterns() -> list[str]:
    return get("terminal", "destructive_patterns", [])

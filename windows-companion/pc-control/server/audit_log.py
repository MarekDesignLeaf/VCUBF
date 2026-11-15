"""
audit_log.py — append-only JSONL audit log for every tool invocation.
"""
from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from config import get, get_log_dir


def _log_path() -> Path:
    audit_cfg = get("audit", default={})
    return get_log_dir() / audit_cfg.get("log_file", "audit.jsonl")


def log_action(
    tool_name: str,
    params: dict[str, Any],
    result: Any = None,
    error: str | None = None,
    level: str = "safe",
    dry_run: bool = False,
) -> None:
    """Append one JSONL entry to the audit log."""
    if not get("audit", "enabled", True):
        return

    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "epoch": time.time(),
        "tool": tool_name,
        "level": level,
        "dry_run": dry_run,
        "params": params,
        "result_summary": _summarise(result),
        "error": error,
    }
    with open(_log_path(), "a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, ensure_ascii=False, default=str) + "\n")


def _summarise(value: Any, max_len: int = 300) -> str | None:
    if value is None:
        return None
    text = json.dumps(value, default=str, ensure_ascii=False)
    if len(text) > max_len:
        return text[:max_len] + "…"
    return text


def read_recent_log(n: int = 50) -> list[dict]:
    """Return the last n audit entries as a list of dicts."""
    path = _log_path()
    if not path.exists():
        return []
    lines = path.read_text(encoding="utf-8").splitlines()
    entries = []
    for line in lines[-n:]:
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return entries

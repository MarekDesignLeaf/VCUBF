"""
security.py — action classification (safe / sensitive / destructive)
and confirmation helpers.
"""
from __future__ import annotations

from enum import Enum
from typing import Any

from config import get_destructive_patterns, is_readonly_mode


class ActionLevel(str, Enum):
    SAFE = "safe"
    SENSITIVE = "sensitive"
    DESTRUCTIVE = "destructive"


# ─── Tool-level default classification ──────────────────────────────────────

_TOOL_LEVELS: dict[str, ActionLevel] = {
    # Read-only
    "get_system_status": ActionLevel.SAFE,
    "list_windows": ActionLevel.SAFE,
    "take_screenshot": ActionLevel.SAFE,
    "list_files": ActionLevel.SAFE,
    "read_file": ActionLevel.SAFE,
    "get_processes": ActionLevel.SAFE,
    "open_project": ActionLevel.SAFE,
    "read_terminal_output": ActionLevel.SAFE,
    "analyse_build_error": ActionLevel.SAFE,
    # Potentially impactful
    "focus_window": ActionLevel.SENSITIVE,
    "click": ActionLevel.SENSITIVE,
    "type_text": ActionLevel.SENSITIVE,
    "press_keys": ActionLevel.SENSITIVE,
    "scroll": ActionLevel.SENSITIVE,
    "launch_app": ActionLevel.SENSITIVE,
    "close_app": ActionLevel.SENSITIVE,
    "write_file": ActionLevel.SENSITIVE,
    "copy_file": ActionLevel.SENSITIVE,
    "create_directory": ActionLevel.SENSITIVE,
    "run_command": ActionLevel.SENSITIVE,   # may be upgraded to DESTRUCTIVE
    # Irreversible
    "move_file": ActionLevel.DESTRUCTIVE,
    "delete_file": ActionLevel.DESTRUCTIVE,
    "create_backup": ActionLevel.SAFE,
    "restore_backup": ActionLevel.DESTRUCTIVE,
}


def classify_tool(tool_name: str, params: dict[str, Any] | None = None) -> ActionLevel:
    """
    Return the ActionLevel for a tool invocation.
    For run_command, inspect the command string for destructive patterns.
    """
    base = _TOOL_LEVELS.get(tool_name, ActionLevel.SENSITIVE)

    if tool_name == "run_command" and params:
        cmd = str(params.get("command", "")).lower()
        for pattern in get_destructive_patterns():
            if pattern.lower() in cmd:
                return ActionLevel.DESTRUCTIVE

    return base


def check_readonly(tool_name: str) -> str | None:
    """
    If the server is in readonly mode and the tool writes/executes,
    return an error message. Otherwise return None.
    """
    if not is_readonly_mode():
        return None
    level = classify_tool(tool_name)
    if level != ActionLevel.SAFE:
        return (
            f"🔒 Plugin is in read-only mode. "
            f"'{tool_name}' ({level.value}) is blocked. "
            "To enable active control, set security.mode=active in config.yaml."
        )
    return None


def confirmation_prompt(tool_name: str, params: dict[str, Any], impact: str = "") -> str:
    """
    Return a human-readable confirmation request string.
    The MCP server returns this as a structured error so Claude can
    surface it to the user before proceeding.
    """
    level = classify_tool(tool_name, params)
    lines = [
        f"⚠️  Confirmation required [{level.value.upper()}]",
        f"Tool   : {tool_name}",
        f"Params : {params}",
    ]
    if impact:
        lines.append(f"Impact : {impact}")
    lines.append("Reply 'confirm' to proceed or 'cancel' to abort.")
    return "\n".join(lines)

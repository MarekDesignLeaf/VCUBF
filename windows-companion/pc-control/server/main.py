"""
main.py — pc-control MCP server entry point.

Registers all tools and enforces the security/audit pipeline on every call.
Runs as a stdio MCP server via FastMCP.
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

# Ensure server directory is on the path so imports work when launched by MCP
sys.path.insert(0, str(Path(__file__).parent))

from fastmcp import FastMCP

import audit_log
import config as cfg
import security as sec
import system_tools as sys_t
import file_tools as file_t
import app_tools as app_t
import gui_tools as gui_t
import terminal_tools as term_t

mcp = FastMCP(
    name="pc-control",
    instructions=(
        "Secure Windows computer-control plugin. "
        "All actions are audited. Sensitive and destructive actions require "
        "user confirmation before execution. "
        "Use dry_run=True to preview commands without executing them."
    ),
)


# ─── Helper: audit wrapper ────────────────────────────────────────────────────

def _run(tool_name: str, fn, params: dict[str, Any]) -> dict[str, Any]:
    """
    1. Check readonly mode
    2. Check dry-run global flag
    3. Execute fn(**params)
    4. Write audit entry
    """
    # Readonly guard
    err = sec.check_readonly(tool_name)
    if err:
        return {"success": False, "error": err}

    # Global dry-run: return early without executing
    if cfg.is_dry_run() and sec.classify_tool(tool_name, params) != sec.ActionLevel.SAFE:
        result = {
            "success": True,
            "dry_run": True,
            "tool": tool_name,
            "params": params,
            "note": "Global dry_run=true — action was NOT executed.",
        }
        audit_log.log_action(tool_name, params, result,
                             level=sec.classify_tool(tool_name, params).value,
                             dry_run=True)
        return result

    try:
        result = fn(**params)
    except Exception as exc:
        result = {"success": False, "error": str(exc)}
        audit_log.log_action(tool_name, params, error=str(exc),
                             level=sec.classify_tool(tool_name, params).value)
        return result

    audit_log.log_action(
        tool_name, params, result,
        level=sec.classify_tool(tool_name, params).value,
    )
    return result


# ─── System tools ─────────────────────────────────────────────────────────────

@mcp.tool()
def get_system_status() -> dict:
    """Return CPU, RAM, disk, OS version, username, drives, and uptime."""
    return _run("get_system_status", sys_t.get_system_status, {})


@mcp.tool()
def get_processes(name_filter: str = "") -> dict:
    """List running processes. Optionally filter by name substring."""
    return _run("get_processes", sys_t.get_processes, {"name_filter": name_filter})


@mcp.tool()
def list_windows() -> dict:
    """List all visible top-level windows with title, hwnd, and PID."""
    return _run("list_windows", lambda: sys_t.list_windows(), {})


@mcp.tool()
def focus_window(hwnd: int | None = None, title_contains: str = "") -> dict:
    """Bring a window to the foreground by hwnd or title substring."""
    return _run("focus_window", sys_t.focus_window,
                {"hwnd": hwnd, "title_contains": title_contains})


# ─── File tools ──────────────────────────────────────────────────────────────

@mcp.tool()
def list_files(directory: str, pattern: str = "*", recursive: bool = False) -> dict:
    """List files in a directory. Supports glob patterns and recursive search."""
    return _run("list_files", file_t.list_files,
                {"directory": directory, "pattern": pattern, "recursive": recursive})


@mcp.tool()
def read_file(path: str, encoding: str = "utf-8") -> dict:
    """Read a text file and return its contents (max 5 MB by default)."""
    return _run("read_file", file_t.read_file,
                {"path": path, "encoding": encoding})


@mcp.tool()
def write_file(path: str, content: str, encoding: str = "utf-8") -> dict:
    """Write text content to a file. Auto-creates a .bak backup first."""
    return _run("write_file", file_t.write_file,
                {"path": path, "content": content, "encoding": encoding})


@mcp.tool()
def copy_file(source: str, destination: str) -> dict:
    """Copy a file or directory tree to a new location."""
    return _run("copy_file", file_t.copy_file,
                {"source": source, "destination": destination})


@mcp.tool()
def move_file(source: str, destination: str) -> dict:
    """Move or rename a file/directory. Creates a backup first."""
    return _run("move_file", file_t.move_file,
                {"source": source, "destination": destination})


@mcp.tool()
def delete_file(path: str, permanent: bool = False) -> dict:
    """
    Delete a file or folder.
    By default moves it to a _deleted_ folder (recoverable).
    Set permanent=True only after explicit user confirmation.
    """
    return _run("delete_file", file_t.delete_file,
                {"path": path, "permanent": permanent})


@mcp.tool()
def create_directory(path: str) -> dict:
    """Create a directory and all necessary parents."""
    return _run("create_directory", file_t.create_directory, {"path": path})


@mcp.tool()
def search_files(root: str, pattern: str, content_search: str = "") -> dict:
    """Search for files by glob pattern, optionally filtering by content."""
    return _run("search_files", file_t.search_files,
                {"root": root, "pattern": pattern, "content_search": content_search})


@mcp.tool()
def create_backup(path: str) -> dict:
    """Create a timestamped backup of a file."""
    return _run("create_backup", file_t.create_backup, {"path": path})


@mcp.tool()
def restore_backup(backup_path: str, target_path: str) -> dict:
    """Restore a backup file to its original location."""
    return _run("restore_backup", file_t.restore_backup,
                {"backup_path": backup_path, "target_path": target_path})


# ─── App tools ───────────────────────────────────────────────────────────────

@mcp.tool()
def launch_app(name: str, args: str = "", working_dir: str = "") -> dict:
    """Launch an application by name or executable path."""
    return _run("launch_app", app_t.launch_app,
                {"name": name, "args": args, "working_dir": working_dir})


@mcp.tool()
def close_app(name: str = "", pid: int | None = None, force: bool = False) -> dict:
    """
    Close an application by name or PID.
    force=True requires explicit user confirmation (destructive).
    """
    return _run("close_app", app_t.close_app,
                {"name": name, "pid": pid, "force": force})


@mcp.tool()
def is_app_running(name: str) -> dict:
    """Check if an application is currently running."""
    return _run("is_app_running", app_t.is_app_running, {"name": name})


@mcp.tool()
def open_project(project_path: str, editor: str = "auto") -> dict:
    """Open a project directory in VS Code or another editor."""
    return _run("open_project", app_t.open_project,
                {"project_path": project_path, "editor": editor})


# ─── GUI tools ───────────────────────────────────────────────────────────────

@mcp.tool()
def take_screenshot(region: dict | None = None) -> dict:
    """
    Capture the screen or a region.
    Returns base64-encoded PNG data.
    region: {"left": x, "top": y, "width": w, "height": h}
    """
    return _run("take_screenshot", gui_t.take_screenshot, {"region": region})


@mcp.tool()
def click(x: int, y: int, button: str = "left", double: bool = False) -> dict:
    """Click at screen coordinates."""
    return _run("click", gui_t.click,
                {"x": x, "y": y, "button": button, "double": double})


@mcp.tool()
def type_text(text: str, interval: float = 0.02) -> dict:
    """Type a string of text into the focused window character by character."""
    return _run("type_text", gui_t.type_text,
                {"text": text, "interval": interval})


@mcp.tool()
def type_text_fast(text: str) -> dict:
    """Paste longer text quickly via clipboard (faster than type_text)."""
    return _run("type_text_fast", gui_t.type_text_fast, {"text": text})


@mcp.tool()
def press_keys(keys: str) -> dict:
    """
    Press keyboard shortcuts.
    Examples: 'ctrl+c', 'alt+f4', 'ctrl+a,ctrl+c', 'enter', 'escape'.
    Separate independent combos with commas.
    """
    return _run("press_keys", gui_t.press_keys, {"keys": keys})


@mcp.tool()
def scroll(x: int, y: int, clicks: int = 3, direction: str = "down") -> dict:
    """Scroll at screen coordinates. direction: 'up' or 'down'."""
    return _run("scroll", gui_t.scroll,
                {"x": x, "y": y, "clicks": clicks, "direction": direction})


@mcp.tool()
def get_mouse_position() -> dict:
    """Return the current mouse cursor position."""
    return _run("get_mouse_position", gui_t.get_mouse_position, {})


@mcp.tool()
def move_mouse(x: int, y: int, duration: float = 0.2) -> dict:
    """Move the mouse cursor without clicking."""
    return _run("move_mouse", gui_t.move_mouse,
                {"x": x, "y": y, "duration": duration})


# ─── Terminal tools ──────────────────────────────────────────────────────────

@mcp.tool()
def run_command(
    command: str,
    shell_type: str = "auto",
    timeout: int | None = None,
    working_dir: str = "",
    dry_run: bool = False,
) -> dict:
    """
    Run a PowerShell or CMD command.
    shell_type: 'powershell' | 'cmd' | 'auto'.
    Set dry_run=True to preview without executing.
    Destructive commands (del, rm, format, registry changes, etc.)
    require user confirmation before calling this tool.
    """
    params = {
        "command": command,
        "shell_type": shell_type,
        "timeout": timeout,
        "working_dir": working_dir,
        "dry_run": dry_run,
    }
    return _run("run_command", term_t.run_command, params)


@mcp.tool()
def start_process(command: str, shell_type: str = "auto", working_dir: str = "") -> dict:
    """Start a long-running background process. Returns its PID."""
    return _run("start_process", term_t.start_process,
                {"command": command, "shell_type": shell_type, "working_dir": working_dir})


@mcp.tool()
def read_terminal_output(pid: int, timeout: float = 1.0) -> dict:
    """Read buffered output from a background process by PID."""
    return _run("read_terminal_output", term_t.read_terminal_output,
                {"pid": pid, "timeout": timeout})


@mcp.tool()
def analyse_build_error(output: str) -> dict:
    """Parse build/compiler output to extract structured errors and warnings."""
    return _run("analyse_build_error", term_t.analyse_build_error, {"output": output})


# ─── Audit log access ────────────────────────────────────────────────────────

@mcp.tool()
def get_audit_log(n: int = 50) -> dict:
    """Return the last n entries from the audit log."""
    entries = audit_log.read_recent_log(n)
    return {"success": True, "entries": entries, "count": len(entries)}


# ─── Entry point ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    mcp.run()

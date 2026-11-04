"""
main.py — pc-control MCP server entry point.

Every tool is declared through registry.pc_tool, which audits each call,
enforces read-only and dry-run modes, sets the MCP annotations and records the
capability entry that pc_capabilities and the server instructions are
generated from. Runs as a stdio MCP server via FastMCP.
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
import asyncio
import inspect
import os

import pc_engine
from registry import REGISTRY, instructions, pc_tool
from status import VERSION, collect_status
SAFE, SENSITIVE, DESTRUCTIVE = sec.ActionLevel.SAFE, sec.ActionLevel.SENSITIVE, sec.ActionLevel.DESTRUCTIVE

mcp = FastMCP(name="pc-control", instructions="pc-control", version=VERSION)


# ─── Meta ────────────────────────────────────────────────────────────────────

@pc_tool(mcp, category="meta", level=SAFE, audited=False,
         use_when="Start of a session, or whenever unsure which tool fits or what is allowed right now.")
def pc_capabilities() -> dict:
    """Describe every pc-control tool (category, safety level, purpose, when to use it) and the current settings.

    Reads nothing on the PC and changes nothing.
    """
    browser_cfg = cfg.get("browser") or {}
    return {
        "success": True,
        "version": VERSION,
        "settings": {
            "mode": cfg.get("security", "mode", "active"),
            "dry_run": cfg.is_dry_run(),
            "screenshots_allowed": bool(cfg.get("gui", "allow_screenshots", False)),
            "browser_mode": browser_cfg.get("mode", "auto"),
            "browser_channel": browser_cfg.get("channel", "msedge"),
            "browser_cdp_url": browser_cfg.get("cdp_url", "http://127.0.0.1:9222"),
            "password_fill_allowed": bool(browser_cfg.get("allow_password_fill", False)),
            "browser_eval_allowed": bool(browser_cfg.get("allow_eval", False)),
            "blocked_resources": browser_cfg.get("block_resources", []),
        },
        "levels": {
            "safe": "runs at once",
            "sensitive": "tell the user what you will do first",
            "destructive": "explicit yes from the user with the exact impact",
        },
        "tools": [spec.as_dict() for spec in REGISTRY.values()],
        "browser_step_reference": pc_engine.BROWSER_STEP_REFERENCE,
        "engine_version": pc_engine.ENGINE_VERSION,
        "instructions": mcp.instructions,
    }


@pc_tool(mcp, category="meta", level=SAFE, audited=False,
         use_when="A tool fails, the connection seems broken, or before relying on the browser or UI Automation tools.")
def pc_status() -> dict:
    """Read-only health check: version, Python, operating system, installed packages, config, audit log folder, browser and UI Automation availability, and the exact problems with how to fix them.

    Changes nothing: no install, no start, no write.
    """
    return collect_status(server_running=True)


# ─── Browser, web and Windows apps: the shared engine ────────────────────────
#
# These tools are generated from pc_engine.TOOLS, the catalogue PC Control Plus
# (the ChatGPT connector) exposes too: same names, parameters, levels and
# guidance. Nothing about them is written here by hand.

def _browser_setting(key: str, default: Any) -> Any:
    env = os.environ.get(f"PC_CONTROL_BROWSER_{key.upper()}")
    if env is not None:
        if isinstance(default, bool):
            return env.lower() in ("1", "true", "yes")
        if isinstance(default, int):
            return int(env)
        return env
    return cfg.get("browser", key, default)


def _default_profile() -> str:
    override = os.environ.get("PC_CONTROL_BROWSER_PROFILE") or cfg.get("browser", "profile_dir", "")
    if override:
        return str(override)
    if sys.platform == "win32" and os.environ.get("LOCALAPPDATA"):
        return str(Path(os.environ["LOCALAPPDATA"]) / "VCUBF" / "Alfonzo" / "pc-control" / "browser-profile")
    return str(Path.home() / ".cache" / "vcubf-alfonzo" / "pc-control" / "browser-profile")


ENGINE = pc_engine.Engine(pc_engine.EngineSettings(
    mode=_browser_setting("mode", "auto"),
    cdp_endpoint=_browser_setting("cdp_url", "http://127.0.0.1:9222"),
    channel=_browser_setting("channel", "msedge"),
    executable_path=_browser_setting("executable_path", ""),
    profile_dir=_default_profile(),
    headless=_browser_setting("headless", False),
    default_timeout_ms=_browser_setting("default_timeout_ms", 5000),
    navigation_timeout_ms=_browser_setting("navigation_timeout_ms", 20000),
    max_snapshot_elements=_browser_setting("max_snapshot_elements", 120),
    block_resources=tuple(cfg.get("browser", "block_resources", []) or ()),
    allow_password_fill=bool(cfg.get("browser", "allow_password_fill", False)),
    allow_eval=bool(cfg.get("browser", "allow_eval", False)),
    url_guard=pc_engine.blocked_domain_guard(cfg.get("browser", "blocked_domains", []) or []),
))

_KINDS = {"str": str, "int": int, "bool": bool, "list": list[dict], "dict": dict}
_LEVELS = {"safe": SAFE, "sensitive": SENSITIVE}


def _engine_tool(spec: pc_engine.ToolSpec):
    """An async MCP tool whose signature is exactly the catalogue's parameters."""
    async def tool(**kwargs):
        return await asyncio.to_thread(ENGINE.call, spec.name, kwargs)

    parameters = []
    for param in spec.params:
        kind = _KINDS[param.kind]
        if param.required:
            parameters.append(inspect.Parameter(param.name, inspect.Parameter.KEYWORD_ONLY, annotation=kind))
        else:
            annotation = kind | None if param.default is None else kind
            parameters.append(inspect.Parameter(param.name, inspect.Parameter.KEYWORD_ONLY, default=param.default, annotation=annotation))
    tool.__name__ = tool.__qualname__ = spec.name
    tool.__doc__ = spec.summary
    tool.__signature__ = inspect.Signature(parameters, return_annotation=dict)
    tool.__annotations__ = {param.name: param.annotation for param in parameters} | {"return": dict}
    return pc_tool(
        mcp, category=spec.group, level=_LEVELS[spec.level], use_when=spec.use_when,
        level_for=(lambda params, name=spec.name: _LEVELS[pc_engine.tool_level(name, params)]) if spec.name == "browser_tabs" else None,
        redact=lambda params, name=spec.name: pc_engine.audit_args(name, params),
    )(tool)


for _spec in pc_engine.TOOLS.values():
    _engine_tool(_spec)


# ─── System tools ────────────────────────────────────────────────────────────

@pc_tool(mcp, category="system", level=SAFE, use_when="Check CPU, memory, disks, OS and uptime.")
def get_system_status() -> dict:
    """Return CPU, RAM, disk, OS version, username, drives, and uptime."""
    return sys_t.get_system_status()


@pc_tool(mcp, category="system", level=SAFE, use_when="Find running processes, optionally by name.")
def get_processes(name_filter: str = "") -> dict:
    """List running processes. Optionally filter by name substring."""
    return {"success": True, "processes": sys_t.get_processes(name_filter=name_filter)}


@pc_tool(mcp, category="system", level=SAFE, use_when="List visible windows by Win32 handle (ui_windows gives the same with process names).")
def list_windows() -> dict:
    """List all visible top-level windows with title, hwnd, and PID."""
    return {"success": True, "windows": sys_t.list_windows()}


@pc_tool(mcp, category="system", level=SENSITIVE, use_when="Bring a window to the front before keyboard input.")
def focus_window(hwnd: int | None = None, title_contains: str = "") -> dict:
    """Bring a window to the foreground by hwnd or title substring."""
    return sys_t.focus_window(hwnd=hwnd, title_contains=title_contains)


# ─── File tools ──────────────────────────────────────────────────────────────

@pc_tool(mcp, category="files", level=SAFE, use_when="See what is in a folder.")
def list_files(directory: str, pattern: str = "*", recursive: bool = False) -> dict:
    """List files in a directory. Supports glob patterns and recursive search."""
    return file_t.list_files(directory=directory, pattern=pattern, recursive=recursive)


@pc_tool(mcp, category="files", level=SAFE, use_when="Read a text file.")
def read_file(path: str, encoding: str = "utf-8") -> dict:
    """Read a text file and return its contents (max 5 MB by default)."""
    return file_t.read_file(path=path, encoding=encoding)


@pc_tool(mcp, category="files", level=SENSITIVE, use_when="Write or replace a text file (a .bak backup is made first).")
def write_file(path: str, content: str, encoding: str = "utf-8") -> dict:
    """Write text content to a file. Auto-creates a .bak backup first."""
    return file_t.write_file(path=path, content=content, encoding=encoding)


@pc_tool(mcp, category="files", level=SENSITIVE, use_when="Copy a file or folder.")
def copy_file(source: str, destination: str) -> dict:
    """Copy a file or directory tree to a new location."""
    return file_t.copy_file(source=source, destination=destination)


@pc_tool(mcp, category="files", level=DESTRUCTIVE, use_when="Move or rename a file or folder, after the user's explicit yes.")
def move_file(source: str, destination: str) -> dict:
    """Move or rename a file/directory. Creates a backup first."""
    return file_t.move_file(source=source, destination=destination)


@pc_tool(mcp, category="files", level=DESTRUCTIVE, use_when="Delete a file or folder, after the user's explicit yes; recoverable unless permanent=True.")
def delete_file(path: str, permanent: bool = False) -> dict:
    """Delete a file or folder.

    By default moves it to a _deleted_ folder (recoverable). Set permanent=True only after explicit user confirmation.
    """
    return file_t.delete_file(path=path, permanent=permanent)


@pc_tool(mcp, category="files", level=SENSITIVE, use_when="Create a folder.")
def create_directory(path: str) -> dict:
    """Create a directory and all necessary parents."""
    return file_t.create_directory(path=path)


@pc_tool(mcp, category="files", level=SAFE, use_when="Find files by name pattern or by content.")
def search_files(root: str, pattern: str, content_search: str = "") -> dict:
    """Search for files by glob pattern, optionally filtering by content."""
    return file_t.search_files(root=root, pattern=pattern, content_search=content_search)


@pc_tool(mcp, category="files", level=SAFE, use_when="Back up a file before changing it.")
def create_backup(path: str) -> dict:
    """Create a timestamped backup of a file."""
    return file_t.create_backup(path=path)


@pc_tool(mcp, category="files", level=DESTRUCTIVE, use_when="Put a backup back, after the user's explicit yes (overwrites the target).")
def restore_backup(backup_path: str, target_path: str) -> dict:
    """Restore a backup file to its original location."""
    return file_t.restore_backup(backup_path=backup_path, target_path=target_path)


# ─── App tools ───────────────────────────────────────────────────────────────

@pc_tool(mcp, category="apps", level=SENSITIVE, use_when="Start an application; then ui_snapshot(window=\"exe:<name>.exe\").")
def launch_app(name: str, args: str = "", working_dir: str = "") -> dict:
    """Launch an application by name or executable path."""
    return app_t.launch_app(name=name, args=args, working_dir=working_dir)


@pc_tool(mcp, category="apps", level=SENSITIVE, use_when="Close an application; force=True only after the user's explicit yes.")
def close_app(name: str = "", pid: int | None = None, force: bool = False) -> dict:
    """Close an application by name or PID.

    force=True requires explicit user confirmation (destructive).
    """
    return app_t.close_app(name=name, pid=pid, force=force)


@pc_tool(mcp, category="apps", level=SAFE, use_when="Check whether an application is running.")
def is_app_running(name: str) -> dict:
    """Check if an application is currently running."""
    return app_t.is_app_running(name=name)


@pc_tool(mcp, category="apps", level=SAFE, use_when="Open a project folder in VS Code or another editor.")
def open_project(project_path: str, editor: str = "auto") -> dict:
    """Open a project directory in VS Code or another editor."""
    return app_t.open_project(project_path=project_path, editor=editor)


# ─── Coordinate fallback (legacy GUI tools) ──────────────────────────────────

@pc_tool(mcp, category="gui_fallback", level=SAFE,
         use_when="Never as a first step. Only if the user asks for an image, or ui_snapshot and browser_snapshot cannot see the content; off unless gui.allow_screenshots is true.")
def take_screenshot(region: dict | None = None) -> dict:
    """Capture the screen or a region as base64 PNG (switched off by default; use ui_snapshot or browser_snapshot instead).

    region: {"left": x, "top": y, "width": w, "height": h}
    """
    if not cfg.get("gui", "allow_screenshots", False):
        return {"success": False, "error": "Screenshots are switched off (gui.allow_screenshots: false). Use ui_snapshot for Windows apps or browser_snapshot for web pages: they return the controls as text with refs."}
    return gui_t.take_screenshot(region=region)


@pc_tool(mcp, category="gui_fallback", level=SENSITIVE, use_when="Only for a control that ui_act cannot reach; coordinates must come from a known layout.")
def click(x: int, y: int, button: str = "left", double: bool = False) -> dict:
    """Click at screen coordinates."""
    return gui_t.click(x=x, y=y, button=button, double=double)


@pc_tool(mcp, category="gui_fallback", level=SENSITIVE, use_when="Type ASCII text key by key into the focused window (ui_act type is faster and keeps diacritics).")
def type_text(text: str, interval: float = 0.02) -> dict:
    """Type a string of text into the focused window character by character."""
    return gui_t.type_text(text=text, interval=interval)


@pc_tool(mcp, category="gui_fallback", level=SENSITIVE, use_when="Paste longer text into the focused window.")
def type_text_fast(text: str) -> dict:
    """Paste longer text quickly via clipboard (faster than type_text)."""
    return gui_t.type_text_fast(text=text)


@pc_tool(mcp, category="gui_fallback", level=SENSITIVE, use_when="Send a shortcut to the focused window (ui_act keys does the same for a named window).")
def press_keys(keys: str) -> dict:
    """Press keyboard shortcuts.

    Examples: 'ctrl+c', 'alt+f4', 'ctrl+a,ctrl+c', 'enter', 'escape'. Separate independent combos with commas.
    """
    return gui_t.press_keys(keys=keys)


@pc_tool(mcp, category="gui_fallback", level=SENSITIVE, use_when="Scroll an app that UI Automation does not scroll by itself.")
def scroll(x: int, y: int, clicks: int = 3, direction: str = "down") -> dict:
    """Scroll at screen coordinates. direction: 'up' or 'down'."""
    return gui_t.scroll(x=x, y=y, clicks=clicks, direction=direction)


@pc_tool(mcp, category="gui_fallback", level=SAFE, use_when="Read where the mouse is.")
def get_mouse_position() -> dict:
    """Return the current mouse cursor position."""
    return gui_t.get_mouse_position()


@pc_tool(mcp, category="gui_fallback", level=SENSITIVE, use_when="Move the mouse without clicking (hover menus).")
def move_mouse(x: int, y: int, duration: float = 0.2) -> dict:
    """Move the mouse cursor without clicking."""
    return gui_t.move_mouse(x=x, y=y, duration=duration)


# ─── Terminal tools ──────────────────────────────────────────────────────────

@pc_tool(mcp, category="terminal", level=SENSITIVE,
         use_when="Run a PowerShell/CMD command; preview with dry_run=True; destructive patterns need the user's explicit yes.")
def run_command(command: str, shell_type: str = "auto", timeout: int | None = None, working_dir: str = "", dry_run: bool = False) -> dict:
    """Run a PowerShell or CMD command.

    shell_type: 'powershell' | 'cmd' | 'auto'. Set dry_run=True to preview without executing. Destructive commands
    (del, rm, format, registry changes, etc.) require user confirmation before calling this tool.
    """
    return term_t.run_command(command=command, shell_type=shell_type, timeout=timeout, working_dir=working_dir, dry_run=dry_run)


@pc_tool(mcp, category="terminal", level=SENSITIVE, use_when="Start a long-running process (dev server, build watcher).")
def start_process(command: str, shell_type: str = "auto", working_dir: str = "") -> dict:
    """Start a long-running background process. Returns its PID."""
    return term_t.start_process(command=command, shell_type=shell_type, working_dir=working_dir)


@pc_tool(mcp, category="terminal", level=SAFE, use_when="Read output of a process started with start_process.")
def read_terminal_output(pid: int, timeout: float = 1.0) -> dict:
    """Read buffered output from a background process by PID."""
    return term_t.read_terminal_output(pid=pid, timeout=timeout)


@pc_tool(mcp, category="terminal", level=SAFE, use_when="Turn compiler or build output into structured errors.")
def analyse_build_error(output: str) -> dict:
    """Parse build/compiler output to extract structured errors and warnings."""
    return term_t.analyse_build_error(output=output)


# ─── Audit log access ────────────────────────────────────────────────────────

@pc_tool(mcp, category="audit", level=SAFE, audited=False, use_when="Show the user what the plugin did recently.")
def get_audit_log(n: int = 50) -> dict:
    """Return the last n entries from the audit log."""
    entries = audit_log.read_recent_log(n)
    return {"success": True, "entries": entries, "count": len(entries)}


mcp.instructions = instructions(VERSION)


# ─── Entry point ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    try:
        mcp.run(show_banner=False)
    except TypeError:  # older FastMCP without the banner switch
        mcp.run()

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
from browser import steps as browser_steps
from browser.engine import SESSION as BROWSER, BrowserError
from desktop_ui import DESKTOP, redact_ui_steps
from registry import REGISTRY, instructions, pc_tool
from web_fetch import web_fetch as fetch_page

VERSION = "0.2.0"
SAFE, SENSITIVE, DESTRUCTIVE = sec.ActionLevel.SAFE, sec.ActionLevel.SENSITIVE, sec.ActionLevel.DESTRUCTIVE

mcp = FastMCP(name="pc-control", instructions="pc-control", version=VERSION)


def _redact_steps(params: dict[str, Any]) -> dict[str, Any]:
    return {**params, "steps": browser_steps.redact_steps(params.get("steps"))}


def _redact_ui(params: dict[str, Any]) -> dict[str, Any]:
    return {**params, "steps": redact_ui_steps(params.get("steps"))}


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
        "browser_step_reference": browser_steps.__doc__,
        "instructions": mcp.instructions,
    }


# ─── Browser ─────────────────────────────────────────────────────────────────

@pc_tool(mcp, category="browser", level=SAFE,
         use_when="Open a web page to read or operate it (JavaScript pages, logged-in sites). First call for any browser task.")
async def browser_open(url: str, query: str = "", new_tab: bool = False, include_text: bool = False) -> dict:
    """Open a URL in the persistent browser and return its snapshot: title, URL, headings and every control as one line with a ref, e.g. [e12] button "Send".

    query narrows the controls to those containing all given words (instead of scrolling). include_text adds the
    page's readable text. Refs work in browser_act until the page is replaced.
    """
    await BROWSER.goto(url, new_tab=new_tab)
    return {"success": True, "url": BROWSER.page.url,
            "snapshot": await BROWSER.snapshot(query=query, mode="both" if include_text else "interactive")}


@pc_tool(mcp, category="browser", level=SAFE,
         use_when="Find a control on the current page (with query) or re-read it after the user changed something themselves.")
async def browser_snapshot(query: str = "", limit: int = 120, include_text: bool = False) -> dict:
    """Return the current page's controls as lines with refs ([e12] link "Pricing" → /pricing), headings and optionally text.

    Off-screen controls are included; no scrolling is needed. query="add to cart" returns only matching controls.
    """
    page = await BROWSER.ensure()
    return {"success": True, "url": page.url,
            "snapshot": await BROWSER.snapshot(query=query, limit=limit, mode="both" if include_text else "interactive")}


@pc_tool(mcp, category="browser", level=SENSITIVE, redact=_redact_steps,
         use_when="Click, fill, select, press keys, wait or navigate on the current page; batch every step you already know into one call.")
async def browser_act(steps: list[dict], snapshot: str = "auto", query: str = "") -> dict:
    """Run a list of browser steps in one call, stop at the first failure, and return what was done plus a fresh snapshot.

    Steps (one operation each; TARGET is a ref like "e12" or a locator {"role":"button","name":"Send"} |
    {"text":"Sign in"} | {"label":"E-mail"} | {"placeholder":"Search"} | {"css":"..."} | {"test_id":"..."}):
    {"click": T} {"dblclick": T} {"hover": T} {"fill": T, "value": "text"} {"type": T, "value": "text"} {"clear": T}
    {"select": T, "value"|"label": "..."} {"check": T} {"uncheck": T} {"upload": T, "files": ["C:/..."]}
    {"press": "Enter"} or {"press": "Control+A", "target": T} {"goto": "https://..."} {"back": true} {"reload": true}
    {"scroll": T | "top" | "bottom"} {"wait_for": {"text"|"gone"|"url"|"target"|"state"|"ms": ...}}
    snapshot="none" skips the snapshot; query narrows it. Password fields are refused unless allowed in config.
    """
    return await BROWSER.act(steps, snapshot=snapshot, query=query)


@pc_tool(mcp, category="browser", level=SAFE,
         use_when="Read the text of the current page (article, results, order summary) as light Markdown.")
async def browser_read(max_chars: int = 8000) -> dict:
    """Return the readable text of the current page (main content, headings, lists, table rows) without controls."""
    frames = await BROWSER.snapshot_data(mode="text", max_text=max_chars)
    return {"success": True, "url": BROWSER.page.url, "title": frames[0].get("title") if frames else "",
            "text": "\n".join(frame.get("text", "") for frame in frames if frame.get("text"))}


@pc_tool(mcp, category="browser", level=SAFE,
         use_when="Pull structured data from the current page: repeated items (products, results, rows), tables or links.")
async def browser_extract(items: str = "", fields: dict | None = None, tables: bool = False, links: bool = False,
                          link_filter: str = "", limit: int = 100) -> dict:
    """Extract data from the current page straight from the DOM in one call.

    items: CSS selector of repeated containers; fields: {"name": "css", "price": ".price", "url": "a@href"} read inside
    each container (or once from the page without items). "@attr" reads an attribute; URLs become absolute.
    tables=True returns visible tables as headers and rows; links=True returns links (filtered by link_filter).
    """
    data = await BROWSER.extract({"items": items, "fields": fields or {}, "tables": tables, "links": links,
                                  "linkFilter": link_filter, "limit": limit})
    return {"success": True, **data}


def _tabs_level(params: dict[str, Any]) -> sec.ActionLevel:
    return SAFE if params.get("action", "list") in ("list", "switch", "new") else SENSITIVE


@pc_tool(mcp, category="browser", level=SAFE, level_for=_tabs_level,
         use_when="List, open, switch or close browser tabs.")
async def browser_tabs(action: str = "list", index: int | None = None, url: str = "") -> dict:
    """List tabs, or action="new" (optional url), "switch" or "close" by index. The current tab is marked."""
    return await BROWSER.tabs(action=action, index=index, url=url)


@pc_tool(mcp, category="browser", level=SENSITIVE,
         use_when="Only when no other browser tool can read a value; switched off unless browser.allow_eval is true.")
async def browser_eval(expression: str) -> dict:
    """Evaluate a JavaScript expression or function in the current page and return its JSON result."""
    return {"success": True, "result": await BROWSER.evaluate(expression)}


@pc_tool(mcp, category="browser", level=SAFE,
         use_when="End of a browser task, or to restart a stuck browser session.")
async def browser_close() -> dict:
    """Close the browser this plugin launched, or disconnect from the user's own browser without closing it."""
    if BROWSER.context is None:
        return {"success": True, "note": "no browser session was open"}
    return await BROWSER.close()


# ─── Web without a browser ───────────────────────────────────────────────────

@pc_tool(mcp, category="web", level=SAFE,
         use_when="Read a public page quickly when nothing has to be clicked and no login is needed.")
async def web_fetch(url: str, max_chars: int = 20000, include_links: bool = False) -> dict:
    """Fetch a URL over HTTP and return it as Markdown (title, text, optional links) without starting a browser."""
    return await fetch_page(url, max_chars=max_chars, include_links=include_links)


# ─── Windows apps through UI Automation ──────────────────────────────────────

@pc_tool(mcp, category="desktop", level=SAFE,
         use_when="Find which application windows are open before ui_snapshot.")
async def ui_windows() -> dict:
    """List top-level windows as UI Automation sees them: title, process, pid and hwnd."""
    return await DESKTOP.windows()


@pc_tool(mcp, category="desktop", level=SAFE,
         use_when="Read a Windows app's controls before acting; with query to find one control in a big window.")
async def ui_snapshot(window: str = "foreground", query: str = "", limit: int = 150) -> dict:
    """Return one window's controls as lines with refs, e.g. [u12] Button "Save" id=SaveBtn, [u5] Edit "File name" value="".

    window: "foreground", a title substring, "exe:notepad.exe" or an hwnd. query keeps only matching controls.
    Visible text (labels, status bar) is listed after the controls. No screenshot is taken.
    """
    return await DESKTOP.snapshot(window=window, query=query, limit=limit)


@pc_tool(mcp, category="desktop", level=SENSITIVE, redact=_redact_ui,
         use_when="Operate a Windows app: press buttons, fill fields, tick boxes, choose items, send shortcuts; batch the steps.")
async def ui_act(steps: list[dict], window: str = "foreground", snapshot: str = "auto", query: str = "") -> dict:
    """Run UI Automation steps on one window in one call and return what was done plus a fresh snapshot.

    TARGET is a ref from ui_snapshot ("u12") or a locator {"name": "Save", "role": "Button", "id": "...", "exact": true, "nth": 0}.
    Steps: {"click": T} (Invoke/Select/Toggle pattern, physical click only as fallback) {"set_value": T, "value": "text"}
    {"type": T, "value": "text"} or {"type": true, "value": "..."} into the focused control (clipboard, keeps diacritics)
    {"check": T} {"uncheck": T} {"toggle": T} {"select": T, "item": "Item name"} {"expand": T} {"collapse": T}
    {"focus": T} {"keys": "ctrl+s"} {"wait_for": {"name": "Saved"}, "timeout_ms": 5000}
    """
    return await DESKTOP.act(steps=steps, window=window, snapshot=snapshot, query=query)


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

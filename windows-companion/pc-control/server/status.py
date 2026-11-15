"""
status.py — read-only health check of the pc-control plugin, standard library only.

Used by the pc_status tool and by launch.py when the server's own packages are
missing. It never installs, starts, writes or changes anything: it looks up
packages without importing them, checks paths with os.access, and asks the
browser debugging port one GET with a short timeout.
"""
from __future__ import annotations

import importlib.metadata
import importlib.util
import json
import os
import platform
import sys
import urllib.request
from pathlib import Path
from typing import Any

VERSION = "0.3.2"
SERVER_DIR = Path(__file__).parent
PLUGIN_DIR = SERVER_DIR.parent

# module name → (pip package, what it is for, needed on Windows only)
PACKAGES: dict[str, tuple[str, str, bool]] = {
    "fastmcp": ("fastmcp", "MCP server (required to start)", False),
    "yaml": ("PyYAML", "configuration (required to start)", False),
    "psutil": ("psutil", "system status and processes", False),
    "playwright": ("playwright", "browser_* tools", False),
    "uiautomation": ("uiautomation", "ui_* tools (Windows UI Automation)", True),
    "pyautogui": ("pyautogui", "keys, typing and coordinate fallback", False),
    "pyperclip": ("pyperclip", "typing with diacritics through the clipboard", False),
    "win32gui": ("pywin32", "list_windows / focus_window", True),
}
REQUIRED_TO_START = ("fastmcp", "yaml")


def _package(module: str) -> dict[str, Any]:
    pip_name, purpose, windows_only = PACKAGES[module]
    found = importlib.util.find_spec(module) is not None
    version = None
    if found:
        try:
            version = importlib.metadata.version(pip_name)
        except importlib.metadata.PackageNotFoundError:
            version = "?"
    return {"module": module, "package": pip_name, "purpose": purpose, "installed": found, "version": version,
            "needed_here": not windows_only or sys.platform == "win32"}


def _config_path() -> Path:
    env = os.environ.get("PC_CONTROL_CONFIG")
    return Path(env) if env else SERVER_DIR / "config.yaml"


def _read_config() -> tuple[dict[str, Any], str | None]:
    path = _config_path()
    if not path.is_file():
        return {}, f"config file not found: {path}"
    if importlib.util.find_spec("yaml") is None:
        return {}, None
    try:
        import yaml
        return yaml.safe_load(path.read_text(encoding="utf-8")) or {}, None
    except Exception as exc:
        return {}, f"config file cannot be read: {exc}"


def _log_dir(config: dict[str, Any]) -> Path:
    env = os.environ.get("PC_CONTROL_LOG_DIR")
    if env:
        return Path(env)
    return SERVER_DIR / (config.get("audit", {}) or {}).get("log_dir", "logs")


def _writable(path: Path) -> bool:
    probe = path
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent
    return os.access(probe, os.W_OK)


def _cdp(url: str) -> dict[str, Any]:
    try:
        with urllib.request.urlopen(url.rstrip("/") + "/json/version", timeout=0.7) as response:
            data = json.loads(response.read().decode("utf-8"))
        return {"answers": True, "browser": data.get("Browser")}
    except Exception as exc:
        return {"answers": False, "detail": type(exc).__name__}


def _browser_executables() -> dict[str, str | None]:
    if sys.platform != "win32":
        return {}
    roots = [os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles"), os.environ.get("LOCALAPPDATA")]
    found: dict[str, str | None] = {"msedge": None, "chrome": None}
    for root in filter(None, roots):
        for key, relative in (("msedge", "Microsoft/Edge/Application/msedge.exe"), ("chrome", "Google/Chrome/Application/chrome.exe")):
            candidate = Path(root) / relative
            if found[key] is None and candidate.is_file():
                found[key] = str(candidate)
    return found


def _environment() -> dict[str, Any]:
    container = Path("/.dockerenv").exists() or bool(os.environ.get("KUBERNETES_SERVICE_HOST")) or bool(os.environ.get("CLAUDE_CODE_REMOTE"))
    return {
        "os": platform.platform(),
        "is_windows": sys.platform == "win32",
        "looks_like_cloud_container": container and sys.platform != "win32",
        "python": sys.version.split()[0],
        "python_executable": sys.executable,
        "plugin_dir": str(PLUGIN_DIR),
    }


def collect_status(server_running: bool) -> dict[str, Any]:
    """Everything needed to tell why a tool group works or does not, without changing anything."""
    env = _environment()
    packages = [_package(module) for module in PACKAGES]
    config, config_error = _read_config()
    browser_cfg = config.get("browser", {}) or {}
    cdp_url = os.environ.get("PC_CONTROL_BROWSER_CDP_URL") or browser_cfg.get("cdp_url", "http://127.0.0.1:9222")
    log_dir = _log_dir(config)
    installed = {item["module"]: item["installed"] for item in packages}
    executables = _browser_executables()
    channel = os.environ.get("PC_CONTROL_BROWSER_CHANNEL") or browser_cfg.get("channel", "msedge")
    cdp = _cdp(cdp_url)

    groups = {
        "server": all(installed[module] for module in REQUIRED_TO_START),
        "browser": installed["playwright"] and (cdp["answers"] or channel == "chromium" or bool(executables.get(channel)) or not env["is_windows"]),
        "web_fetch": True,  # standard library
        "desktop_ui": env["is_windows"] and installed["uiautomation"],
        "keyboard_and_typing": installed["pyautogui"] and installed["pyperclip"],
        "system": installed["psutil"],
    }

    problems: list[str] = []
    missing = [item["package"] for item in packages if item["needed_here"] and not item["installed"]]
    if env["looks_like_cloud_container"]:
        problems.append(
            "This server runs in a cloud container, not on the owner's Windows PC. It cannot control that PC from here; "
            "run Claude (Desktop or Code) on the PC itself with this plugin and Install-PcControl.ps1."
        )
    elif not env["is_windows"]:
        problems.append("Not Windows: ui_* tools and Windows window tools are unavailable here.")
    if missing:
        command = ("powershell -ExecutionPolicy Bypass -File \"" + str(PLUGIN_DIR / "Install-PcControl.ps1") + "\"") if env["is_windows"] \
            else f"{sys.executable} -m pip install " + " ".join(sorted(set(missing)))
        problems.append(f"Missing packages for {sys.executable}: {', '.join(sorted(set(missing)))}. Install with: {command}")
    if config_error:
        problems.append(config_error)
    if not _writable(log_dir):
        problems.append(f"Audit log folder is not writable: {log_dir}")
    if env["is_windows"] and installed["playwright"] and not cdp["answers"] and channel != "chromium" and not executables.get(channel):
        problems.append(f"browser.channel is {channel}, but it was not found and nothing answers at {cdp_url}.")

    return {
        "success": True,
        "server_running": server_running,
        "version": VERSION,
        "ready": groups["server"] and not problems,
        "environment": env,
        "tool_groups_usable": groups,
        "packages": packages,
        "config": {"path": str(_config_path()), "error": config_error, "mode": (config.get("security", {}) or {}).get("mode"),
                   "dry_run": (config.get("security", {}) or {}).get("dry_run")},
        "audit_log_dir": {"path": str(log_dir), "writable": _writable(log_dir)},
        "browser": {"mode": os.environ.get("PC_CONTROL_BROWSER_MODE") or browser_cfg.get("mode", "auto"), "channel": channel,
                    "cdp_url": cdp_url, "cdp": cdp, "executables": executables},
        "problems": problems,
        "note": "Read-only check: nothing was installed, started, written or changed.",
    }

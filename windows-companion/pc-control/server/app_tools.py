"""
app_tools.py — launch, close, and inspect applications.
"""
from __future__ import annotations

import subprocess
import time
from pathlib import Path
from typing import Any

import psutil


# Known app launch mappings (name → executable / command)
APP_ALIASES: dict[str, str] = {
    "chrome": "chrome.exe",
    "google chrome": "chrome.exe",
    "edge": "msedge.exe",
    "microsoft edge": "msedge.exe",
    "firefox": "firefox.exe",
    "vscode": "code",
    "visual studio code": "code",
    "notepad": "notepad.exe",
    "notepad++": "notepad++.exe",
    "explorer": "explorer.exe",
    "file explorer": "explorer.exe",
    "word": "WINWORD.EXE",
    "excel": "EXCEL.EXE",
    "outlook": "OUTLOOK.EXE",
    "powerpoint": "POWERPNT.EXE",
    "cmd": "cmd.exe",
    "powershell": "powershell.exe",
    "terminal": "wt.exe",
    "windows terminal": "wt.exe",
    "android studio": "studio64.exe",
    "calculator": "calc.exe",
    "paint": "mspaint.exe",
    "task manager": "taskmgr.exe",
}


def launch_app(name: str, args: str = "", working_dir: str = "") -> dict[str, Any]:
    """
    Launch an installed application by name or executable path.
    Optionally pass arguments and a working directory.
    """
    exe = APP_ALIASES.get(name.lower(), name)
    cmd = [exe] + (args.split() if args else [])
    cwd = working_dir or None
    try:
        proc = subprocess.Popen(
            cmd, cwd=cwd,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
        )
        time.sleep(0.5)  # brief pause to let the window appear
        return {"success": True, "app": exe, "pid": proc.pid, "args": args}
    except FileNotFoundError:
        return {"success": False, "error": f"Executable not found: '{exe}'. "
                "Check the name or provide the full path."}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


def close_app(name: str = "", pid: int | None = None, force: bool = False) -> dict[str, Any]:
    """
    Close a running application by name substring or PID.
    force=True sends SIGKILL (destructive — requires confirmation).
    """
    killed = []
    errors = []
    for proc in psutil.process_iter(["pid", "name"]):
        try:
            match = (pid is not None and proc.info["pid"] == pid) or \
                    (name and name.lower() in (proc.info["name"] or "").lower())
            if not match:
                continue
            if force:
                proc.kill()
            else:
                proc.terminate()
            proc.wait(timeout=5)
            killed.append({"pid": proc.info["pid"], "name": proc.info["name"]})
        except (psutil.NoSuchProcess, psutil.AccessDenied) as exc:
            errors.append(str(exc))
        except psutil.TimeoutExpired:
            errors.append(f"Process {proc.info['pid']} did not exit in time.")

    return {
        "success": len(killed) > 0,
        "killed": killed,
        "errors": errors,
        "method": "force-kill" if force else "graceful-terminate",
    }


def is_app_running(name: str) -> dict[str, Any]:
    """Check whether an application is currently running."""
    found = []
    for proc in psutil.process_iter(["pid", "name", "status"]):
        try:
            if name.lower() in (proc.info["name"] or "").lower():
                found.append({"pid": proc.info["pid"],
                              "name": proc.info["name"],
                              "status": proc.info["status"]})
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    return {"running": len(found) > 0, "instances": found}


def open_project(project_path: str, editor: str = "auto") -> dict[str, Any]:
    """
    Open a project directory in the appropriate editor (VS Code by default).
    Detects project type from the directory contents.
    """
    p = Path(project_path)
    if not p.exists():
        return {"success": False, "error": f"Path not found: {project_path}"}

    project_type = _detect_project_type(p)

    if editor == "auto":
        editor = _pick_editor(project_type)

    cmd_map = {
        "vscode": ["code", str(p)],
        "android studio": [APP_ALIASES.get("android studio", "studio64.exe"),
                           str(p)],
        "explorer": ["explorer.exe", str(p)],
    }
    cmd = cmd_map.get(editor.lower(), ["code", str(p)])

    try:
        subprocess.Popen(cmd)
        return {
            "success": True,
            "project_path": str(p.resolve()),
            "project_type": project_type,
            "editor": editor,
        }
    except Exception as exc:
        return {"success": False, "error": str(exc)}


def _detect_project_type(path: Path) -> str:
    markers = {
        "flutter": ["pubspec.yaml"],
        "android": ["build.gradle", "AndroidManifest.xml"],
        "nodejs": ["package.json"],
        "python": ["setup.py", "pyproject.toml", "requirements.txt"],
        "dotnet": ["*.csproj", "*.sln"],
        "rust": ["Cargo.toml"],
        "go": ["go.mod"],
        "java": ["pom.xml", "build.gradle"],
    }
    for ptype, files in markers.items():
        for pattern in files:
            if list(path.glob(pattern)):
                return ptype
    return "generic"


def _pick_editor(project_type: str) -> str:
    if project_type == "android":
        return "android studio"
    return "vscode"

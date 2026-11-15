"""
system_tools.py — OS status, running processes, open windows.
"""
from __future__ import annotations

import platform
from typing import Any

import psutil


def get_system_status() -> dict[str, Any]:
    """Return CPU, RAM, disk, OS version, username, and uptime."""
    mem = psutil.virtual_memory()
    disk = psutil.disk_usage("/")
    cpu_freq = psutil.cpu_freq()

    status = {
        "os": platform.system(),
        "os_version": platform.version(),
        "os_release": platform.release(),
        "machine": platform.machine(),
        "hostname": platform.node(),
        "username": _get_username(),
        "cpu": {
            "physical_cores": psutil.cpu_count(logical=False),
            "logical_cores": psutil.cpu_count(logical=True),
            "usage_percent": psutil.cpu_percent(interval=0.5),
            "frequency_mhz": round(cpu_freq.current, 1) if cpu_freq else None,
        },
        "ram": {
            "total_gb": round(mem.total / 1e9, 2),
            "available_gb": round(mem.available / 1e9, 2),
            "used_percent": mem.percent,
        },
        "disk": {
            "total_gb": round(disk.total / 1e9, 2),
            "free_gb": round(disk.free / 1e9, 2),
            "used_percent": disk.percent,
        },
        "disks": _get_all_disks(),
        "boot_time": _format_boot_time(),
    }
    return status


def _get_username() -> str:
    try:
        import os
        return os.environ.get("USERNAME") or os.environ.get("USER") or "unknown"
    except Exception:
        return "unknown"


def _get_all_disks() -> list[dict]:
    disks = []
    for part in psutil.disk_partitions(all=False):
        try:
            usage = psutil.disk_usage(part.mountpoint)
            disks.append({
                "device": part.device,
                "mountpoint": part.mountpoint,
                "fstype": part.fstype,
                "total_gb": round(usage.total / 1e9, 2),
                "free_gb": round(usage.free / 1e9, 2),
                "used_percent": usage.percent,
            })
        except PermissionError:
            pass
    return disks


def _format_boot_time() -> str:
    from datetime import datetime
    bt = psutil.boot_time()
    return datetime.fromtimestamp(bt).isoformat()


def get_processes(name_filter: str = "") -> list[dict]:
    """
    List running processes. Optionally filter by name substring.
    Returns pid, name, status, cpu%, mem_mb, username.
    """
    procs = []
    for p in psutil.process_iter(["pid", "name", "status", "username",
                                   "cpu_percent", "memory_info"]):
        try:
            info = p.info
            if name_filter and name_filter.lower() not in (info["name"] or "").lower():
                continue
            mem_mb = round(info["memory_info"].rss / 1e6, 1) if info["memory_info"] else 0
            procs.append({
                "pid": info["pid"],
                "name": info["name"],
                "status": info["status"],
                "username": info["username"],
                "cpu_percent": info["cpu_percent"],
                "mem_mb": mem_mb,
            })
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    return sorted(procs, key=lambda x: x["mem_mb"], reverse=True)


def list_windows() -> list[dict]:
    """
    List visible top-level windows (Windows only).
    Returns title, hwnd, pid, and whether the window is currently active.
    """
    try:
        import win32gui
        import win32process

        results = []
        active_hwnd = win32gui.GetForegroundWindow()

        def callback(hwnd, _):
            if win32gui.IsWindowVisible(hwnd):
                title = win32gui.GetWindowText(hwnd)
                if title:
                    _, pid = win32process.GetWindowThreadProcessId(hwnd)
                    results.append({
                        "hwnd": hwnd,
                        "title": title,
                        "pid": pid,
                        "is_active": hwnd == active_hwnd,
                    })

        win32gui.EnumWindows(callback, None)
        return results
    except ImportError:
        return [{"error": "pywin32 not installed — run: pip install pywin32"}]
    except Exception as exc:
        return [{"error": str(exc)}]


def focus_window(hwnd: int | None = None, title_contains: str = "") -> dict:
    """
    Bring a window to the foreground by hwnd or by a title substring.
    """
    try:
        import win32gui
        import win32con

        if hwnd is None and title_contains:
            hwnd = win32gui.FindWindow(None, None)
            found = None

            def cb(h, _):
                nonlocal found
                t = win32gui.GetWindowText(h)
                if title_contains.lower() in t.lower():
                    found = h

            win32gui.EnumWindows(cb, None)
            hwnd = found

        if hwnd is None:
            return {"success": False, "error": "Window not found"}

        win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        win32gui.SetForegroundWindow(hwnd)
        return {"success": True, "hwnd": hwnd,
                "title": win32gui.GetWindowText(hwnd)}
    except ImportError:
        return {"success": False, "error": "pywin32 not installed"}
    except Exception as exc:
        return {"success": False, "error": str(exc)}

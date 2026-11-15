"""Native Windows UI Automation for PC Control Plus (no screenshots).

Calls UIAutomationCore through the open-source uiautomation Python wrapper.
All control traversal and patterns execute in the calling COM thread. Call
uiautomation.UIAutomationInitializerInThread() in worker threads.
"""
from __future__ import annotations

import ctypes
import os
import time
from ctypes import wintypes

MAX_NODES = 180
MAX_DEPTH = 5
MAX_WINDOWS = 48


def _windows():
    if os.name != "nt":
        raise RuntimeError("Windows UI Automation requires Windows")
    user32 = ctypes.windll.user32
    result = []
    CALLBACK = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def add(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        if length < 1:
            return True
        title = ctypes.create_unicode_buffer(min(1024, length + 1))
        user32.GetWindowTextW(hwnd, title, len(title))
        if not title.value.strip():
            return True
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        result.append({"handle": int(hwnd), "title": title.value[:220],
                       "pid": int(pid.value)})
        return len(result) < MAX_WINDOWS

    callback = CALLBACK(add)
    user32.EnumWindows(callback, 0)
    return result


def windows_list():
    return _windows()


def _control(handle):
    if os.name != "nt":
        raise RuntimeError("Windows only")
    value = int(handle)
    if value <= 0 or not ctypes.windll.user32.IsWindow(value):
        raise ValueError("Window handle is invalid or closed")
    import uiautomation as auto
    return auto.ControlFromHandle(value)


def _prop(control, name, default=""):
    try:
        value = getattr(control, name)
        return value if value is not None else default
    except Exception:
        return default


def _descriptor(control, path, depth):
    password = bool(_prop(control, "IsPassword", False))
    return {
        "path": path,
        "depth": depth,
        "name": "" if password else str(_prop(control, "Name"))[:180],
        "automation_id": str(_prop(control, "AutomationId"))[:130],
        "control_type": str(_prop(control, "ControlTypeName"))[:75],
        "class_name": str(_prop(control, "ClassName"))[:100],
        "enabled": bool(_prop(control, "IsEnabled", False)),
        "password": password,
    }


def tree(handle, depth=4, limit=140):
    """Bounded, structured accessibility tree for one top-level window."""
    root = _control(handle)
    depth = min(MAX_DEPTH, max(0, int(depth)))
    limit = min(MAX_NODES, max(1, int(limit)))
    queue = [(root, [], 0)]
    nodes = []
    while queue and len(nodes) < limit:
        control, path, level = queue.pop(0)
        record = _descriptor(control, path, level)
        nodes.append(record)
        if level < depth:
            try:
                children = control.GetChildren()
                for idx, child in enumerate(children[:60]):
                    queue.append((child, path + [idx], level + 1))
            except Exception:
                continue
    return {"handle": int(handle), "nodes": nodes, "truncated": bool(queue),
            "depth": depth, "count": len(nodes)}


def _resolve(handle, path):
    current = _control(handle)
    if not isinstance(path, list) or len(path) > 12:
        raise ValueError("Path must be an array of at most 12 indices")
    for idx in path:
        if not isinstance(idx, int) or isinstance(idx, bool) or not 0 <= idx < 100:
            raise ValueError("Invalid UIA child index")
        children = current.GetChildren()
        if idx >= len(children):
            raise ValueError("UI changed; refresh the accessibility tree")
        current = children[idx]
    return current


def execute(handle, actions):
    """Invoke native UI Automation patterns, not mouse or image coordinates."""
    if not isinstance(actions, list) or not 1 <= len(actions) <= 8:
        raise ValueError("Expected 1 to 8 UI automation actions")
    results = []
    for action in actions:
        op = str(action.get("action", "")).lower()
        if op not in ("invoke", "set_value", "toggle", "select", "expand",
                      "collapse", "focus", "close"):
            raise ValueError("Unsupported UI Automation action")
        path = action.get("path", [])
        control = _resolve(handle, path)
        if _prop(control, "IsPassword", False):
            raise PermissionError("Password fields are not handled by the agent")
        if not _prop(control, "IsEnabled", False) and op != "focus":
            raise ValueError("Control is disabled")
        expected = str(action.get("expected_name", "")).strip()
        current_name = str(_prop(control, "Name", "")).strip()
        if expected and expected != current_name:
            raise ValueError("UI changed: control name differs; refresh the tree")
        if op == "invoke":
            pattern = control.GetInvokePattern()
            if pattern is None:
                raise ValueError("This control does not support InvokePattern")
            pattern.Invoke()
        elif op == "set_value":
            value = str(action.get("value", ""))
            if len(value) > 4000:
                raise ValueError("Value exceeds 4000 characters")
            pattern = control.GetValuePattern()
            if pattern is None:
                raise ValueError("This control does not support ValuePattern")
            pattern.SetValue(value)
        elif op == "toggle":
            pattern = control.GetTogglePattern()
            if pattern is None:
                raise ValueError("This control does not support TogglePattern")
            pattern.Toggle()
        elif op == "select":
            pattern = control.GetSelectionItemPattern()
            if pattern is None:
                raise ValueError("This control does not support SelectionItemPattern")
            pattern.Select()
        elif op in ("expand", "collapse"):
            pattern = control.GetExpandCollapsePattern()
            if pattern is None:
                raise ValueError("This control does not support ExpandCollapsePattern")
            getattr(pattern, op.capitalize())()
        elif op == "focus":
            control.SetFocus()
        elif op == "close":
            if path:
                raise ValueError("Close operation is only for the window root")
            pattern = control.GetWindowPattern()
            if pattern is None:
                raise ValueError("WindowPattern not available")
            pattern.Close()
        results.append({"action": op, "path": path, "ok": True})
    return {"handle": int(handle), "actions": results}


def wait_for(handle, name="", control_type="", timeout=10.0):
    """Poll the accessibility tree locally, without asking an AI model per poll."""
    if not name and not control_type:
        raise ValueError("Specify a name or control type")
    deadline = time.monotonic() + min(20.0, max(0.1, float(timeout)))
    while time.monotonic() < deadline:
        snapshot = tree(handle, depth=4, limit=140)
        matches = [n for n in snapshot["nodes"]
                   if (not name or name.casefold() in n["name"].casefold())
                   and (not control_type or control_type.casefold() == n["control_type"].casefold())]
        if matches:
            return {"found": True, "matches": matches[:10]}
        time.sleep(0.3)
    return {"found": False, "matches": []}

"""
desktop_ui.py — control Windows applications through UI Automation, without
screenshots or screen coordinates.

Every Windows app built on Win32, WinForms, WPF, UWP/WinUI, Qt (with
accessibility) or Electron/Chromium exposes its controls to UI Automation, the
API screen readers use. ui_snapshot reads that tree of one window and returns
one compact line per control with a ref ("u12"); ui_act acts on refs or on
locators ({"name": "Save", "role": "Button"}) through the control's own
patterns: Invoke for buttons and menu items, Value for edit boxes, Toggle for
check boxes, SelectionItem for list and tab items, ExpandCollapse for combo
boxes and tree items. A physical click is only the last fallback.

The logic here is backend independent: UiNode is a small interface, the real
one (UiaNode) wraps the `uiautomation` package on Windows, and the tests use a
fake tree. All UI Automation calls run on one dedicated COM thread.
"""
from __future__ import annotations

import asyncio
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Protocol

INTERACTIVE_TYPES = {
    "Button", "SplitButton", "Edit", "CheckBox", "RadioButton", "ComboBox", "List", "ListItem", "MenuItem",
    "TabItem", "Hyperlink", "TreeItem", "DataItem", "Slider", "Spinner", "Document", "MenuBar", "Menu", "Tab",
    "DataGrid", "Table", "ScrollBar", "Thumb", "Calendar", "Custom",
}
# Read for context, not for acting.
CONTEXT_TYPES = {"Text", "Header", "HeaderItem", "StatusBar", "TitleBar", "ToolTip", "Group", "Pane", "Window"}
SKIP_TYPES = {"ScrollBar", "Thumb", "TitleBar"}

MAX_UI_STEPS = 30
UI_OPS = ("click", "set_value", "type", "toggle", "check", "uncheck", "select", "expand", "collapse", "focus", "keys", "wait_for")
TARGET_OPTIONAL = ("keys", "type")


class UiError(RuntimeError):
    pass


class UiNode(Protocol):
    control_type: str
    name: str
    automation_id: str
    class_name: str

    def key(self) -> tuple: ...
    def children(self) -> list["UiNode"]: ...
    def patterns(self) -> set[str]: ...
    def value(self) -> str | None: ...
    def toggle_state(self) -> str | None: ...
    def expanded(self) -> bool | None: ...
    def selected(self) -> bool | None: ...
    def enabled(self) -> bool: ...
    def offscreen(self) -> bool: ...
    def invoke(self) -> None: ...
    def toggle(self) -> None: ...
    def set_value(self, text: str) -> None: ...
    def select(self) -> None: ...
    def expand(self) -> None: ...
    def collapse(self) -> None: ...
    def focus(self) -> None: ...
    def click(self) -> None: ...


class UiBackend(Protocol):
    def windows(self) -> list[UiNode]: ...
    def foreground(self) -> UiNode | None: ...
    def window_by_handle(self, hwnd: int) -> UiNode | None: ...
    def window_info(self, node: UiNode) -> dict[str, Any]: ...
    def send_keys(self, keys: str) -> None: ...
    def type_text(self, text: str) -> None: ...


# ─── Tree reading ────────────────────────────────────────────────────────────

def _clean(text: Any, limit: int = 80) -> str:
    value = re.sub(r"\s+", " ", str(text or "")).strip()
    return value if len(value) <= limit else value[: limit - 1] + "…"


@dataclass
class UiSession:
    """Refs stay stable for the same control while the server runs."""
    refs_by_key: dict[tuple, str] = field(default_factory=dict)
    nodes_by_ref: dict[str, UiNode] = field(default_factory=dict)
    window_by_ref: dict[str, UiNode] = field(default_factory=dict)
    seq: int = 0

    def ref_for(self, node: UiNode, window: UiNode) -> str:
        key = node.key()
        ref = self.refs_by_key.get(key)
        if ref is None:
            self.seq += 1
            ref = f"u{self.seq}"
            self.refs_by_key[key] = ref
        self.nodes_by_ref[ref] = node
        self.window_by_ref[ref] = window
        return ref


def describe_node(node: UiNode, ref: str) -> dict[str, Any]:
    item: dict[str, Any] = {"ref": ref, "role": node.control_type, "name": _clean(node.name)}
    if node.automation_id:
        item["id"] = _clean(node.automation_id, 60)
    patterns = node.patterns()
    if "value" in patterns:
        value = node.value()
        if value is not None:
            item["value"] = _clean(value, 60)
    state = node.toggle_state() if "toggle" in patterns else None
    if state is not None:
        item["toggle"] = state
    expanded = node.expanded() if "expand_collapse" in patterns else None
    if expanded is not None:
        item["expanded"] = expanded
    if "selection_item" in patterns and node.selected():
        item["selected"] = True
    if not node.enabled():
        item["disabled"] = True
    return item


def format_ui_element(item: dict[str, Any]) -> str:
    line = f"[{item['ref']}] {item['role']}"
    if item.get("name"):
        line += f' "{item["name"]}"'
    if item.get("id"):
        line += f" id={item['id']}"
    if "value" in item:
        line += f' value="{item["value"]}"'
    if "toggle" in item:
        line += f" {item['toggle']}"
    if "expanded" in item:
        line += " expanded" if item["expanded"] else " collapsed"
    if item.get("selected"):
        line += " selected"
    if item.get("disabled"):
        line += " disabled"
    return line


def _matches_words(item: dict[str, Any], words: list[str]) -> bool:
    if not words:
        return True
    hay = " ".join(str(item.get(key, "")) for key in ("role", "name", "id", "value")).lower()
    return all(word in hay for word in words)


def walk(root: UiNode, max_depth: int, max_nodes: int) -> Iterable[tuple[UiNode, int]]:
    """Depth-first, document order, bounded so a huge tree never stalls a call."""
    stack: list[tuple[UiNode, int]] = [(root, 0)]
    visited = 0
    while stack and visited < max_nodes:
        node, depth = stack.pop()
        visited += 1
        yield node, depth
        if depth >= max_depth or node.control_type in SKIP_TYPES:
            continue
        try:
            children = node.children()
        except Exception:
            continue
        for child in reversed(children):
            stack.append((child, depth + 1))


def snapshot_window(session: UiSession, window: UiNode, query: str = "", limit: int = 150, max_depth: int = 25,
                    max_nodes: int = 4000, include_text: bool = True) -> dict[str, Any]:
    words = _clean(query, 200).lower().split()
    elements: list[dict[str, Any]] = []
    texts: list[str] = []
    total = 0
    for node, depth in walk(window, max_depth, max_nodes):
        if node is window:
            continue
        kind = node.control_type
        try:
            if node.offscreen() and kind not in ("ListItem", "TreeItem", "DataItem", "MenuItem", "TabItem"):
                continue
        except Exception:
            continue
        if kind in INTERACTIVE_TYPES:
            if kind in ("Custom", "List", "Tab", "Menu", "MenuBar", "DataGrid", "Table") and not node.name:
                continue
            item = describe_node(node, session.ref_for(node, window))
            if not _matches_words(item, words):
                continue
            total += 1
            if len(elements) < limit:
                elements.append(item)
        elif include_text and kind in ("Text", "Header", "HeaderItem", "StatusBar") and node.name and len(texts) < 60:
            text = _clean(node.name, 160)
            if not words or all(word in text.lower() for word in words):
                texts.append(text)
    return {"elements": elements, "texts": texts, "total": total, "truncated": total > len(elements)}


def format_ui_snapshot(info: dict[str, Any], data: dict[str, Any], query: str = "") -> str:
    lines = [f"Window: {info.get('title') or '(untitled)'}  [{info.get('process', '?')} pid={info.get('pid', '?')} hwnd={info.get('hwnd', '?')}]"]
    shown, total = len(data["elements"]), data["total"]
    lines.append(f"Controls{' matching ' + repr(query) if query else ''}: {shown} shown of {total}" + (" (narrow with query=...)" if shown < total else ""))
    lines.extend(format_ui_element(item) for item in data["elements"])
    if data.get("texts"):
        lines.append("Text: " + " · ".join(data["texts"]))
    return "\n".join(lines)


# ─── Finding windows and controls ────────────────────────────────────────────

def find_window(backend: UiBackend, window: Any) -> UiNode:
    if window in (None, "", "foreground"):
        node = backend.foreground()
        if node is None:
            raise UiError("no foreground window")
        return node
    if isinstance(window, int) or (isinstance(window, str) and window.isdigit()):
        node = backend.window_by_handle(int(window))
        if node is None:
            raise UiError(f"no window with hwnd {window}")
        return node
    text = str(window).strip()
    candidates = backend.windows()
    if text.lower().startswith("exe:"):
        process = text[4:].lower()
        for node in candidates:
            if str(backend.window_info(node).get("process", "")).lower() == process:
                return node
        raise UiError(f"no window of process {process}; launch it first (launch_app)")
    lowered = text.lower()
    exact = [node for node in candidates if node.name.lower() == lowered]
    if exact:
        return exact[0]
    partial = [node for node in candidates if lowered in node.name.lower()]
    if partial:
        return partial[0]
    titles = ", ".join(f'"{_clean(node.name, 50)}"' for node in candidates if node.name)[:600]
    raise UiError(f'no window titled like "{text}". Open windows: {titles}')


def _locator_matches(node: UiNode, spec: dict[str, Any]) -> bool:
    exact = bool(spec.get("exact", False))
    if "role" in spec and node.control_type.lower() != str(spec["role"]).lower().removesuffix("control"):
        return False
    if "id" in spec and node.automation_id != spec["id"]:
        return False
    if "class" in spec and node.class_name != spec["class"]:
        return False
    if "name" in spec:
        wanted = str(spec["name"]).strip().lower()
        actual = (node.name or "").strip().lower()
        if exact and actual != wanted:
            return False
        if not exact and wanted not in actual:
            return False
    return True


def parse_ui_target(raw: Any, where: str) -> dict[str, Any] | str:
    if isinstance(raw, str):
        if re.fullmatch(r"u\d+", raw.strip()):
            return raw.strip()
        raise UiError(f"{where}: '{raw}' is not a ref like u12; use a locator such as {{\"name\": \"Save\", \"role\": \"Button\"}}")
    if isinstance(raw, dict):
        if not any(key in raw for key in ("name", "id", "role")):
            raise UiError(f"{where}: a locator needs name, id or role")
        unknown = set(raw) - {"name", "id", "role", "class", "exact", "nth"}
        if unknown:
            raise UiError(f"{where}: unknown locator keys {sorted(unknown)}")
        return dict(raw)
    raise UiError(f"{where}: a target is a ref like \"u12\" or a locator object")


def parse_ui_steps(raw_steps: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_steps, list) or not raw_steps:
        raise UiError("steps must be a non-empty list")
    if len(raw_steps) > MAX_UI_STEPS:
        raise UiError(f"at most {MAX_UI_STEPS} steps per call")
    steps = []
    for index, raw in enumerate(raw_steps):
        where = f"step {index + 1}"
        if not isinstance(raw, dict):
            raise UiError(f"{where}: each step is an object such as {{\"click\": \"u12\"}}")
        ops = [op for op in UI_OPS if op in raw]
        if len(ops) != 1:
            raise UiError(f"{where}: exactly one operation of {', '.join(UI_OPS)}")
        op = ops[0]
        unknown = set(raw) - {op, "value", "item", "timeout_ms"}
        if unknown:
            raise UiError(f"{where}: unknown keys {sorted(unknown)}")
        step: dict[str, Any] = {"op": op}
        if op == "keys":
            if not isinstance(raw["keys"], str) or not raw["keys"].strip():
                raise UiError(f"{where}: keys needs a combination such as ctrl+s or enter")
            step["value"] = raw["keys"].strip()
        elif op == "wait_for":
            step["target"] = parse_ui_target(raw["wait_for"], where)
            if isinstance(step["target"], str):
                raise UiError(f"{where}: wait_for needs a locator, not a ref")
            timeout = raw.get("timeout_ms", 5000)
            if not isinstance(timeout, int) or not 100 <= timeout <= 30000:
                raise UiError(f"{where}: timeout_ms must be 100–30000")
            step["timeout_ms"] = timeout
        elif op == "type":
            if not isinstance(raw.get("value"), str):
                raise UiError(f"{where}: type needs value (text)")
            step["value"] = raw["value"]
            if raw["type"] not in (None, True, ""):
                step["target"] = parse_ui_target(raw["type"], where)
        else:
            step["target"] = parse_ui_target(raw[op], where)
            if op == "set_value":
                if not isinstance(raw.get("value"), str):
                    raise UiError(f"{where}: set_value needs value (text)")
                step["value"] = raw["value"]
            if op == "select" and "item" in raw:
                if not isinstance(raw["item"], str) or not raw["item"].strip():
                    raise UiError(f"{where}: item must be the item's name")
                step["item"] = raw["item"]
        steps.append(step)
    return steps


def redact_ui_steps(raw_steps: Any) -> Any:
    if not isinstance(raw_steps, list):
        return raw_steps
    return [
        {**raw, "value": f"<{len(raw['value'])} chars>"} if isinstance(raw, dict) and isinstance(raw.get("value"), str) and ("set_value" in raw or "type" in raw) else raw
        for raw in raw_steps
    ]


def find_control(session: UiSession, window: UiNode, target: dict[str, Any] | str, max_nodes: int = 6000) -> UiNode:
    if isinstance(target, str):
        node = session.nodes_by_ref.get(target)
        if node is None:
            raise UiError(f"{target} is unknown; take ui_snapshot of the window first")
        return node
    nth = int(target.get("nth", 0))
    seen = 0
    for node, _ in walk(window, 40, max_nodes):
        if node is window:
            continue
        if _locator_matches(node, target):
            if seen == nth:
                session.ref_for(node, window)
                return node
            seen += 1
    raise UiError(f"no control matching {target} in this window; check ui_snapshot(query=...)")


# ─── Acting ──────────────────────────────────────────────────────────────────

def activate(node: UiNode) -> str:
    """Click without coordinates: the control's own pattern, physical click last."""
    patterns = node.patterns()
    if "invoke" in patterns:
        node.invoke()
        return "invoked"
    if "selection_item" in patterns:
        node.select()
        return "selected"
    if "toggle" in patterns:
        node.toggle()
        return "toggled"
    if "expand_collapse" in patterns:
        if node.expanded():
            node.collapse()
            return "collapsed"
        node.expand()
        return "expanded"
    node.click()
    return "clicked"


def set_toggle(node: UiNode, wanted: str) -> str:
    if "toggle" not in node.patterns():
        raise UiError(f'"{node.name}" cannot be checked (no Toggle pattern)')
    for _ in range(3):
        if node.toggle_state() == wanted:
            return wanted
        node.toggle()
    if node.toggle_state() != wanted:
        raise UiError(f'"{node.name}" did not become {wanted}')
    return wanted


def select_item(session: UiSession, window: UiNode, node: UiNode, item: str | None, backend: UiBackend) -> str:
    if item is None:
        if "selection_item" in node.patterns():
            node.select()
            return "selected"
        return activate(node)
    if "expand_collapse" in node.patterns():
        node.expand()
    wanted = item.strip().lower()
    for child, _ in walk(node, 6, 800):
        if child is node:
            continue
        if child.control_type in ("ListItem", "MenuItem", "TreeItem", "DataItem", "TabItem") and (child.name or "").strip().lower() == wanted:
            if "selection_item" in child.patterns():
                child.select()
            else:
                activate(child)
            if "expand_collapse" in node.patterns() and node.expanded():
                try:
                    node.collapse()
                except Exception:
                    pass
            return f"selected {item}"
    if "value" in node.patterns():
        node.set_value(item)
        return f"set {item}"
    raise UiError(f'"{item}" is not an item of "{node.name}"')


def run_ui_steps(backend: UiBackend, session: UiSession, window: UiNode, steps: list[dict[str, Any]],
                 sleep: Callable[[float], None] = time.sleep) -> tuple[list[str], dict[str, Any] | None]:
    done: list[str] = []
    for index, step in enumerate(steps):
        op = step["op"]
        try:
            if op == "keys":
                window.focus()
                backend.send_keys(step["value"])
                done.append(f"keys {step['value']}")
                continue
            if op == "wait_for":
                deadline = time.monotonic() + step["timeout_ms"] / 1000
                while True:
                    try:
                        find_control(session, window, step["target"])
                        break
                    except UiError:
                        if time.monotonic() >= deadline:
                            raise UiError(f"timed out waiting for {step['target']}")
                        sleep(0.15)
                done.append("waited")
                continue
            if op == "type" and "target" not in step:
                backend.type_text(step["value"])
                done.append(f"typed {len(step['value'])} chars")
                continue
            node = find_control(session, window, step["target"])
            if not node.enabled():
                raise UiError(f'"{node.name}" is disabled')
            if op == "click":
                done.append(f"{activate(node)} {node.control_type} \"{_clean(node.name, 40)}\"")
            elif op == "set_value":
                if "value" in node.patterns():
                    node.set_value(step["value"])
                else:
                    node.focus()
                    backend.send_keys("ctrl+a")
                    backend.type_text(step["value"])
                done.append(f"set value of \"{_clean(node.name, 40)}\"")
            elif op == "type":
                node.focus()
                backend.type_text(step["value"])
                done.append(f"typed {len(step['value'])} chars into \"{_clean(node.name, 40)}\"")
            elif op == "toggle":
                node.toggle()
                done.append(f"toggled \"{_clean(node.name, 40)}\"")
            elif op in ("check", "uncheck"):
                done.append(f"\"{_clean(node.name, 40)}\" {set_toggle(node, 'on' if op == 'check' else 'off')}")
            elif op == "select":
                done.append(select_item(session, window, node, step.get("item"), backend))
            elif op == "expand":
                node.expand()
                done.append(f"expanded \"{_clean(node.name, 40)}\"")
            elif op == "collapse":
                node.collapse()
                done.append(f"collapsed \"{_clean(node.name, 40)}\"")
            elif op == "focus":
                node.focus()
                done.append(f"focused \"{_clean(node.name, 40)}\"")
        except Exception as exc:
            return done, {"step": index + 1, "op": op, "error": str(exc).split("\n")[0][:300]}
    return done, None


# ─── The real backend (Windows) ──────────────────────────────────────────────

_TOGGLE = {0: "off", 1: "on", 2: "indeterminate"}


class UiaNode:
    """A uiautomation.Control behind the UiNode interface."""

    def __init__(self, control: Any) -> None:
        self.c = control
        self.control_type = str(getattr(control, "ControlTypeName", "")).removesuffix("Control")
        self.name = str(getattr(control, "Name", "") or "")
        self.automation_id = str(getattr(control, "AutomationId", "") or "")
        self.class_name = str(getattr(control, "ClassName", "") or "")
        self._patterns: set[str] | None = None

    def key(self) -> tuple:
        try:
            return tuple(self.c.GetRuntimeId())
        except Exception:
            return (self.control_type, self.name, self.automation_id, id(self.c))

    def children(self) -> list["UiaNode"]:
        return [UiaNode(child) for child in self.c.GetChildren()]

    def patterns(self) -> set[str]:
        if self._patterns is None:
            import uiautomation as auto
            found = set()
            for name, pattern_id in (("invoke", auto.PatternId.InvokePattern), ("value", auto.PatternId.ValuePattern),
                                     ("toggle", auto.PatternId.TogglePattern), ("selection_item", auto.PatternId.SelectionItemPattern),
                                     ("expand_collapse", auto.PatternId.ExpandCollapsePattern)):
                try:
                    if self.c.GetPattern(pattern_id):
                        found.add(name)
                except Exception:
                    pass
            self._patterns = found
        return self._patterns

    def value(self) -> str | None:
        try:
            return self.c.GetValuePattern().Value
        except Exception:
            return None

    def toggle_state(self) -> str | None:
        try:
            return _TOGGLE.get(self.c.GetTogglePattern().ToggleState)
        except Exception:
            return None

    def expanded(self) -> bool | None:
        try:
            return self.c.GetExpandCollapsePattern().ExpandCollapseState in (1, 2)
        except Exception:
            return None

    def selected(self) -> bool | None:
        try:
            return bool(self.c.GetSelectionItemPattern().IsSelected)
        except Exception:
            return None

    def enabled(self) -> bool:
        try:
            return bool(self.c.IsEnabled)
        except Exception:
            return True

    def offscreen(self) -> bool:
        try:
            return bool(self.c.IsOffscreen)
        except Exception:
            return False

    def invoke(self) -> None:
        self.c.GetInvokePattern().Invoke()

    def toggle(self) -> None:
        self.c.GetTogglePattern().Toggle()

    def set_value(self, text: str) -> None:
        self.c.GetValuePattern().SetValue(text)

    def select(self) -> None:
        self.c.GetSelectionItemPattern().Select()

    def expand(self) -> None:
        self.c.GetExpandCollapsePattern().Expand()

    def collapse(self) -> None:
        self.c.GetExpandCollapsePattern().Collapse()

    def focus(self) -> None:
        self.c.SetFocus()

    def click(self) -> None:
        self.c.Click(simulateMove=False, waitTime=0)


class UiaBackend:
    def __init__(self) -> None:
        import uiautomation as auto
        self.auto = auto
        auto.SetGlobalSearchTimeout(2)

    def windows(self) -> list[UiNode]:
        return [UiaNode(child) for child in self.auto.GetRootControl().GetChildren() if getattr(child, "Name", "")]

    def foreground(self) -> UiNode | None:
        control = self.auto.GetForegroundControl()
        return UiaNode(control.GetTopLevelControl() or control) if control else None

    def window_by_handle(self, hwnd: int) -> UiNode | None:
        control = self.auto.ControlFromHandle(hwnd)
        return UiaNode(control) if control else None

    def window_info(self, node: UiNode) -> dict[str, Any]:
        control = node.c  # type: ignore[attr-defined]
        info: dict[str, Any] = {"title": node.name, "hwnd": getattr(control, "NativeWindowHandle", None), "pid": getattr(control, "ProcessId", None)}
        try:
            import psutil
            info["process"] = psutil.Process(info["pid"]).name()
        except Exception:
            info["process"] = "?"
        return info

    def send_keys(self, keys: str) -> None:
        import pyautogui
        for combo in (part.strip() for part in keys.split(",")):
            parts = [piece.strip() for piece in combo.split("+") if piece.strip()]
            if len(parts) == 1:
                pyautogui.press(parts[0])
            elif parts:
                pyautogui.hotkey(*parts)

    def type_text(self, text: str) -> None:
        # Clipboard paste: instant, and keeps Czech diacritics that key-by-key typing loses.
        import pyautogui
        import pyperclip
        previous = None
        try:
            previous = pyperclip.paste()
        except Exception:
            pass
        pyperclip.copy(text)
        pyautogui.hotkey("ctrl", "v")
        if previous is not None:
            time.sleep(0.05)
            try:
                pyperclip.copy(previous)
            except Exception:
                pass


# ─── The service the MCP tools call ──────────────────────────────────────────

def _com_thread_init() -> None:
    if sys.platform == "win32":
        import uiautomation as auto
        _com_thread_init.keep = auto.UIAutomationInitializerInThread()  # type: ignore[attr-defined]


class DesktopUi:
    def __init__(self, backend_factory: Callable[[], UiBackend] | None = None) -> None:
        self._factory = backend_factory or UiaBackend
        self._backend: UiBackend | None = None
        self.session = UiSession()
        # One COM thread for every UI Automation call.
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="uia", initializer=_com_thread_init if backend_factory is None else None)

    def backend(self) -> UiBackend:
        if self._backend is None:
            if self._factory is UiaBackend and sys.platform != "win32":
                raise UiError("Windows UI Automation is only available on Windows.")
            try:
                self._backend = self._factory()
            except ImportError as exc:
                raise UiError("The uiautomation package is missing. Run Install-PcControl.ps1 (pip install uiautomation).") from exc
        return self._backend

    async def _call(self, fn: Callable[[], Any]) -> Any:
        return await asyncio.get_running_loop().run_in_executor(self._executor, fn)

    def snapshot_sync(self, window: Any = "foreground", query: str = "", limit: int = 150, include_text: bool = True) -> dict[str, Any]:
        backend = self.backend()
        node = find_window(backend, window)
        info = backend.window_info(node)
        data = snapshot_window(self.session, node, query=query, limit=limit, include_text=include_text)
        return {"success": True, "window": info, "snapshot": format_ui_snapshot(info, data, query), "total": data["total"]}

    def act_sync(self, steps: Any, window: Any = "foreground", snapshot: str = "auto", query: str = "") -> dict[str, Any]:
        parsed = parse_ui_steps(steps)
        backend = self.backend()
        node = find_window(backend, window)
        done, failure = run_ui_steps(backend, self.session, node, parsed)
        result: dict[str, Any] = {"success": failure is None, "done": done}
        if failure:
            result["failed"] = failure
            result["skipped"] = len(parsed) - len(done) - 1
        if snapshot != "none":
            time.sleep(0.15)  # let the app redraw its tree after the last action
            try:
                after = find_window(backend, window if window not in (None, "", "foreground") else "foreground")
                info = backend.window_info(after)
                result["snapshot"] = format_ui_snapshot(info, snapshot_window(self.session, after, query=query), query)
            except UiError as exc:
                result["snapshot"] = f"(window not available after the actions: {exc})"
        return result

    def windows_sync(self) -> dict[str, Any]:
        backend = self.backend()
        return {"success": True, "windows": [backend.window_info(node) for node in backend.windows()]}

    async def snapshot(self, **kwargs: Any) -> dict[str, Any]:
        return await self._call(lambda: self.snapshot_sync(**kwargs))

    async def act(self, **kwargs: Any) -> dict[str, Any]:
        return await self._call(lambda: self.act_sync(**kwargs))

    async def windows(self) -> dict[str, Any]:
        return await self._call(self.windows_sync)


DESKTOP = DesktopUi()

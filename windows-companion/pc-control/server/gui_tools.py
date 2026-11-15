"""
gui_tools.py — screen capture, mouse, keyboard, and window interactions.
"""
from __future__ import annotations

import base64
import io
import time
from typing import Any

from config import get


def _pause() -> None:
    time.sleep(get("gui", "action_pause", 0.1))


def take_screenshot(region: dict | None = None) -> dict[str, Any]:
    """
    Capture the screen (or a region) and return as base64-encoded PNG.
    region: {"left": x, "top": y, "width": w, "height": h}
    """
    try:
        import mss
        import mss.tools
        from PIL import Image

        with mss.mss() as sct:
            monitor = region if region else sct.monitors[0]
            raw = sct.grab(monitor)
            img = Image.frombytes("RGB", raw.size, raw.bgra, "raw", "BGRX")
            quality = get("gui", "screenshot_quality", 85)
            buf = io.BytesIO()
            img.save(buf, format="PNG", optimize=True)
            b64 = base64.b64encode(buf.getvalue()).decode()

        return {
            "success": True,
            "format": "png",
            "width": raw.size[0],
            "height": raw.size[1],
            "data_base64": b64,
        }
    except ImportError:
        return {"success": False,
                "error": "mss or Pillow not installed. Run: pip install mss Pillow"}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


def click(x: int, y: int, button: str = "left", double: bool = False) -> dict[str, Any]:
    """Click at screen coordinates."""
    try:
        import pyautogui
        pyautogui.FAILSAFE = get("gui", "failsafe", True)
        _pause()
        if double:
            pyautogui.doubleClick(x, y, button=button)
        else:
            pyautogui.click(x, y, button=button)
        return {"success": True, "x": x, "y": y, "button": button, "double": double}
    except ImportError:
        return {"success": False, "error": "pyautogui not installed"}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


def type_text(text: str, interval: float = 0.02) -> dict[str, Any]:
    """Type a string of text into the currently focused window."""
    try:
        import pyautogui
        pyautogui.FAILSAFE = get("gui", "failsafe", True)
        _pause()
        pyautogui.typewrite(text, interval=interval)
        return {"success": True, "chars_typed": len(text)}
    except ImportError:
        return {"success": False, "error": "pyautogui not installed"}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


def type_text_fast(text: str) -> dict[str, Any]:
    """
    Type longer text quickly using the clipboard (avoids key-by-key delays).
    Requires pyperclip.
    """
    try:
        import pyperclip
        import pyautogui
        pyperclip.copy(text)
        _pause()
        pyautogui.hotkey("ctrl", "v")
        return {"success": True, "chars_pasted": len(text)}
    except ImportError:
        return {"success": False,
                "error": "pyperclip or pyautogui not installed"}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


def press_keys(keys: str) -> dict[str, Any]:
    """
    Press a keyboard shortcut.
    Format: 'ctrl+c', 'alt+f4', 'win+d', 'enter', 'escape', etc.
    Multiple keys separated by '+' are treated as a hotkey combo.
    Separate multiple independent presses with ',' (e.g., 'ctrl+a,ctrl+c').
    """
    try:
        import pyautogui
        pyautogui.FAILSAFE = get("gui", "failsafe", True)
        _pause()
        combos = [k.strip() for k in keys.split(",")]
        for combo in combos:
            parts = [p.strip() for p in combo.split("+")]
            if len(parts) == 1:
                pyautogui.press(parts[0])
            else:
                pyautogui.hotkey(*parts)
            _pause()
        return {"success": True, "keys": keys}
    except ImportError:
        return {"success": False, "error": "pyautogui not installed"}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


def scroll(x: int, y: int, clicks: int = 3, direction: str = "down") -> dict[str, Any]:
    """Scroll at screen coordinates. direction: 'up' or 'down'."""
    try:
        import pyautogui
        pyautogui.FAILSAFE = get("gui", "failsafe", True)
        _pause()
        amount = -clicks if direction == "down" else clicks
        pyautogui.scroll(amount, x=x, y=y)
        return {"success": True, "x": x, "y": y,
                "clicks": clicks, "direction": direction}
    except ImportError:
        return {"success": False, "error": "pyautogui not installed"}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


def get_mouse_position() -> dict[str, Any]:
    """Return the current mouse cursor position."""
    try:
        import pyautogui
        pos = pyautogui.position()
        return {"success": True, "x": pos.x, "y": pos.y}
    except ImportError:
        return {"success": False, "error": "pyautogui not installed"}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


def move_mouse(x: int, y: int, duration: float = 0.2) -> dict[str, Any]:
    """Move the mouse cursor to coordinates without clicking."""
    try:
        import pyautogui
        pyautogui.moveTo(x, y, duration=duration)
        return {"success": True, "x": x, "y": y}
    except ImportError:
        return {"success": False, "error": "pyautogui not installed"}
    except Exception as exc:
        return {"success": False, "error": str(exc)}

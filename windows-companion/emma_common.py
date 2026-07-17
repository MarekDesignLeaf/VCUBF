"""Shared local helpers for the single Windows Emma Voice v2 runtime.

This module deliberately contains only local configuration, secure token access
and small audio-buffer helpers.  It has no microphone loop, wake listener or
legacy launcher, so Voice v2 can be installed without the former Emma runtime.
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import urllib.error
import urllib.request


RATE = 24_000
PLAYBACK_FRAME_MS = 20
PLAYBACK_FRAME_BYTES = RATE * 2 * PLAYBACK_FRAME_MS // 1_000
PLAYBACK_PREBUFFER_MS = 160
PLAYBACK_PREBUFFER_BYTES = RATE * 2 * PLAYBACK_PREBUFFER_MS // 1_000

LANGUAGE_NAMES = {
    "en-GB": "English (United Kingdom)",
    "en-US": "English (United States)",
    "cs-CZ": "Czech",
    "pl-PL": "Polish",
    "fr-FR": "French",
    "de-DE": "German",
    "es-ES": "Spanish",
    "it-IT": "Italian",
}

APP_DIR = Path(os.environ["LOCALAPPDATA"]) / "VCUBF" / "Emma"
CONFIG_PATH = APP_DIR / "config.json"
TOKEN_PATH = APP_DIR / "token.bin"
LIVE_PATH = APP_DIR / "emma-live.json"


class DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]


class PcmPlaybackBuffer:
    """Small deterministic jitter buffer for 24 kHz mono PCM16 output."""

    def __init__(
        self,
        frame_bytes: int = PLAYBACK_FRAME_BYTES,
        prebuffer_bytes: int = PLAYBACK_PREBUFFER_BYTES,
    ):
        self.frame_bytes = frame_bytes
        self.prebuffer_bytes = prebuffer_bytes
        self.data = bytearray()
        self.finished = False
        self.started = False

    def append(self, payload: bytes) -> None:
        if payload:
            self.data.extend(payload)
        if len(self.data) >= self.prebuffer_bytes:
            self.started = True

    def finish(self) -> None:
        self.finished = True
        if self.data:
            self.started = True

    def clear(self) -> None:
        self.data.clear()
        self.finished = False
        self.started = False

    def rebuffer(self) -> None:
        self.started = False

    def take_frame(self) -> bytes | None:
        if not self.started:
            return None
        if len(self.data) >= self.frame_bytes:
            frame = bytes(self.data[:self.frame_bytes])
            del self.data[:self.frame_bytes]
            return frame
        if self.finished and self.data:
            frame = bytes(self.data)
            self.data.clear()
            return frame + (b"\x00" * (self.frame_bytes - len(frame)))
        return None

    @property
    def drained(self) -> bool:
        return self.finished and not self.data


def write_live_preview(role: str = "", text: str = "", status: str = "Emma Voice v2 active") -> None:
    """Expose the latest transcript text; microphone audio is never stored."""
    try:
        APP_DIR.mkdir(parents=True, exist_ok=True)
        temporary = LIVE_PATH.with_suffix(".tmp")
        temporary.write_text(
            json.dumps({"role": role, "text": text.strip()[:8000], "status": status}, ensure_ascii=False),
            encoding="utf-8",
        )
        temporary.replace(LIVE_PATH)
    except OSError:
        pass


def unprotect_dpapi(data: bytes) -> bytes:
    source = ctypes.create_string_buffer(data)
    in_blob = DATA_BLOB(len(data), ctypes.cast(source, ctypes.POINTER(ctypes.c_byte)))
    out_blob = DATA_BLOB()
    if not ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(in_blob), None, None, None, None, 0, ctypes.byref(out_blob)
    ):
        raise ctypes.WinError()
    try:
        return ctypes.string_at(out_blob.pbData, out_blob.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(out_blob.pbData)


def load_config() -> dict:
    with CONFIG_PATH.open("r", encoding="utf-8-sig") as handle:
        return json.load(handle)


def save_config_language(language: str) -> None:
    """Persist a backend-confirmed language without losing local settings."""
    config = load_config()
    config["Language"] = language
    temporary = CONFIG_PATH.with_suffix(".tmp")
    temporary.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(CONFIG_PATH)


def load_token() -> str:
    return unprotect_dpapi(TOKEN_PATH.read_bytes()).decode("utf-8")


def backend_json(method: str, path: str, body: dict | None = None) -> dict:
    config = load_config()
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(
        config.get("ServerUrl", "https://backend-production-7952.up.railway.app").rstrip("/") + path,
        data=data,
        method=method,
        headers={"Authorization": f"Bearer {load_token()}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = response.read().decode("utf-8").strip()
        return json.loads(payload) if payload else {}


def backend_command_json(method: str, path: str, body: dict | None = None) -> dict:
    """Return structured validation failures rather than hiding them."""
    try:
        return backend_json(method, path, body)
    except urllib.error.HTTPError as exc:
        payload = exc.read().decode("utf-8", errors="replace").strip()
        try:
            parsed = json.loads(payload) if payload else {}
        except json.JSONDecodeError:
            raise
        if isinstance(parsed, dict) and parsed:
            parsed.setdefault("ok", False)
            parsed.setdefault("httpStatus", exc.code)
            return parsed
        raise


def build_backend_history(entries: list[dict], current_text: str) -> list[dict]:
    """Build the six prior turns accepted by /command/assistant."""
    ordered = sorted(entries, key=lambda entry: int(entry.get("sequence", 0)))
    current = current_text.strip()
    for index in range(len(ordered) - 1, -1, -1):
        entry = ordered[index]
        if entry.get("role") == "user" and str(entry.get("content") or "").strip() == current:
            del ordered[index]
            break
    return [
        {"role": str(entry["role"]), "content": str(entry["content"])[:800]}
        for entry in ordered[-6:]
        if entry.get("role") in {"user", "assistant"} and str(entry.get("content") or "").strip()
    ]

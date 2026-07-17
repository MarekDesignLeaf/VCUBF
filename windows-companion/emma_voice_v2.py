"""Emma Voice v2 — provider-based Windows voice runtime for VCUF Secretary.

Voice v2 is the only installed Windows listener. When configured, it uses local
Picovoice Porcupine detection for the wake word (with a Deepgram VAD fallback),
Qualcomm NPU Whisper STT (with a Deepgram fallback) and ElevenLabs PCM streaming
TTS, while every business operation still goes through the authenticated,
permission-checked and audited Secretary API.

No microphone audio is written to disk.  Only final transcript text is sent to
Secretary and retained there.  Provider credentials are read from named
environment variables, never from the VCUF config file or source tree.
"""

from __future__ import annotations

import argparse
import asyncio
from array import array
import base64
from collections import deque
import ctypes
from dataclasses import dataclass
from difflib import SequenceMatcher
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import threading
import time
from typing import Any
from urllib.parse import urlencode
import urllib.error
import urllib.request

from aec_audio_processing import AudioProcessor
import pyaudio
import websockets

try:
    import pvporcupine
except ImportError:  # Reported by diagnostics; Deepgram remains available.
    pvporcupine = None

from emma_common import (
    APP_DIR,
    LANGUAGE_NAMES,
    PcmPlaybackBuffer,
    backend_command_json,
    backend_json,
    build_backend_history,
    load_config,
    save_config_language,
    write_live_preview,
)


RUNTIME_NAME = "Emma Voice v2"
RATE = 24_000
CHANNELS = 1
SAMPLE_WIDTH = 2
INPUT_FRAME_MS = 20
INPUT_FRAME_BYTES = RATE * SAMPLE_WIDTH * INPUT_FRAME_MS // 1_000
# WebRTC AEC consumes exact 10 ms blocks at the selected sample rate. Keep
# capture at 20 ms for efficient Deepgram streaming, but split it into these
# 10 ms frames before AEC and use the same frame size for the reverse signal.
AEC_FRAME_BYTES = RATE * SAMPLE_WIDTH * 10 // 1_000
PLAYBACK_FRAME_BYTES = AEC_FRAME_BYTES
PLAYBACK_PREBUFFER_BYTES = RATE * SAMPLE_WIDTH * 160 // 1_000
MAX_SESSION_SECONDS = 180
IDLE_AFTER_RESPONSE_SECONDS = 25
V2_CONFIG_PATH = APP_DIR / "voice-v2.json"
V2_LOG_PATH = APP_DIR / "emma-voice-v2.log"
PLAYBACK_END = object()
PLAYBACK_STOP = object()


def log(message: str) -> None:
    APP_DIR.mkdir(parents=True, exist_ok=True)
    with V2_LOG_PATH.open("a", encoding="utf-8") as handle:
        handle.write(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {message}\n")


def default_v2_config() -> dict[str, Any]:
    return {
        "version": 2,
        "wake": {
            "provider": "deepgram_vad",
            "word": "Emma",
            "accessKeyEnv": "PICOVOICE_ACCESS_KEY",
            "keywordPath": "",
            "sensitivity": 0.65,
            "speechThreshold": 450,
            "preRollMs": 600,
            "silenceMs": 1_100,
            "maxSegmentMs": 8_000,
        },
        "stt": {
            "provider": "deepgram",
            "fallbackProvider": "deepgram",
            "apiKeyEnv": "DEEPGRAM_API_KEY",
            "model": "nova-3",
            "languageMode": "selected",
            "endpointingMs": 250,
            # Deepgram accepts utterance_end_ms from 1000 to 5000 ms.
            "utteranceEndMs": 1_000,
            "npu": {
                "pythonPath": "",
                "appPath": "",
                "modelSize": "base",
                "speechThreshold": 300,
                "preRollMs": 320,
                "silenceMs": 700,
                "minSpeechMs": 180,
                "maxSegmentMs": 15_000,
            },
        },
        "tts": {
            "provider": "elevenlabs",
            "apiKeyEnv": "ELEVENLABS_API_KEY",
            "voiceId": "",
            "model": "eleven_flash_v2_5",
            "outputFormat": "pcm_24000",
        },
        "session": {
            "followUpSeconds": 25,
            "maxSeconds": MAX_SESSION_SECONDS,
        },
    }


def merge_defaults(defaults: dict[str, Any], supplied: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in defaults.items():
        incoming = supplied.get(key)
        if isinstance(value, dict):
            result[key] = merge_defaults(value, incoming if isinstance(incoming, dict) else {})
        else:
            result[key] = incoming if incoming is not None else value
    for key, value in supplied.items():
        if key not in result:
            result[key] = value
    return result


def load_v2_config() -> dict[str, Any]:
    if not V2_CONFIG_PATH.exists():
        return default_v2_config()
    try:
        raw = json.loads(V2_CONFIG_PATH.read_text(encoding="utf-8-sig"))
        return merge_defaults(default_v2_config(), raw if isinstance(raw, dict) else {})
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Voice v2 configuration is invalid: {type(exc).__name__}") from exc


def environment_value(name: str) -> str:
    return os.environ.get(name.strip(), "").strip()


def configured_value(value: object) -> bool:
    """Reject the explicit placeholders in the checked-in V2 example file."""
    text = str(value or "").strip()
    return bool(text) and not text.upper().startswith("SET_")


def node_picovoice_available() -> bool:
    node_path = Path(os.environ.get("PICOVOICE_NODE_PATH", "").strip())
    modules_path = Path(os.environ.get("PICOVOICE_NODE_MODULES", "").strip())
    sidecar_path = Path(__file__).with_name("picovoice_wake.js")
    return (
        node_path.is_file()
        and sidecar_path.is_file()
        and (modules_path / "@picovoice" / "porcupine-node").is_dir()
        and (modules_path / "@picovoice" / "pvrecorder-node").is_dir()
    )


def companion_is_running(parent_pid: int = 0, stop_file: Path | None = None) -> bool:
    """Treat the visible tray wrapper as the owner of this one V2 session."""
    if stop_file and stop_file.exists():
        return False
    if parent_pid <= 0:
        return True
    if os.name == "nt":
        # ``os.kill(pid, 0)`` is not a POSIX-style probe on Windows: it can
        # terminate the target process. Query the process exit code instead.
        process_query_limited_information = 0x1000
        still_active = 259
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.argtypes = (ctypes.c_ulong, ctypes.c_bool, ctypes.c_ulong)
        kernel32.OpenProcess.restype = ctypes.c_void_p
        kernel32.GetExitCodeProcess.argtypes = (ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong))
        kernel32.GetExitCodeProcess.restype = ctypes.c_bool
        kernel32.CloseHandle.argtypes = (ctypes.c_void_p,)
        kernel32.CloseHandle.restype = ctypes.c_bool
        handle = kernel32.OpenProcess(process_query_limited_information, False, parent_pid)
        if not handle:
            return False
        exit_code = ctypes.c_ulong()
        try:
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                return False
            return exit_code.value == still_active
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(parent_pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False


def current_wake_profile(config: dict[str, Any]) -> tuple[str, str]:
    """Load the persisted Secretary language before every wake-word wait."""
    common = load_config()
    language = str(common.get("Language") or "").strip()
    if language not in LANGUAGE_NAMES:
        # Never silently fall back to English after the application language
        # was changed. Deepgram receives the exact selected BCP-47 language.
        raise RuntimeError("WAKE_LANGUAGE_INVALID")
    word = str(common.get("WakeWord") or config["wake"].get("word") or "Emma").strip()
    if not word or len(word) > 64:
        raise RuntimeError("WAKE_WORD_INVALID")
    return language, word


def wake_vad_settings(config: dict[str, Any]) -> tuple[int, int, int, int]:
    wake = config["wake"]
    try:
        threshold = int(wake.get("speechThreshold", 450))
        pre_roll_ms = int(wake.get("preRollMs", 600))
        silence_ms = int(wake.get("silenceMs", 1_100))
        max_segment_ms = int(wake.get("maxSegmentMs", 8_000))
    except (TypeError, ValueError) as exc:
        raise RuntimeError("DEEPGRAM_WAKE_SETTINGS_INVALID") from exc
    if not 80 <= threshold <= 12_000 or not 100 <= pre_roll_ms <= 2_000 or not 300 <= silence_ms <= 4_000 or not 1_000 <= max_segment_ms <= 15_000:
        raise RuntimeError("DEEPGRAM_WAKE_SETTINGS_INVALID")
    return threshold, pre_roll_ms, silence_ms, max_segment_ms


def picovoice_wake_settings(config: dict[str, Any]) -> tuple[str, str, float]:
    wake = config["wake"]
    access_key_env = str(wake.get("accessKeyEnv") or "PICOVOICE_ACCESS_KEY").strip()
    raw_keyword_path = os.path.expandvars(str(wake.get("keywordPath") or "").strip())
    keyword_path = Path(raw_keyword_path).expanduser() if raw_keyword_path else Path()
    try:
        sensitivity = float(wake.get("sensitivity", 0.65))
    except (TypeError, ValueError) as exc:
        raise RuntimeError("PICOVOICE_SENSITIVITY_INVALID") from exc
    if not access_key_env:
        raise RuntimeError("PICOVOICE_ACCESS_KEY_ENV_INVALID")
    if not 0.0 <= sensitivity <= 1.0:
        raise RuntimeError("PICOVOICE_SENSITIVITY_INVALID")
    return access_key_env, str(keyword_path) if raw_keyword_path else "", sensitivity


def stream_timing_settings(config: dict[str, Any]) -> tuple[int, int]:
    """Validate the timing values accepted by Deepgram's streaming endpoint."""
    stt = config["stt"]
    try:
        endpointing_ms = int(stt["endpointingMs"])
        utterance_end_ms = int(stt["utteranceEndMs"])
    except (KeyError, TypeError, ValueError) as exc:
        raise RuntimeError("DEEPGRAM_STREAM_TIMING_INVALID") from exc
    if not 10 <= endpointing_ms <= 5_000 or not 1_000 <= utterance_end_ms <= 5_000:
        raise RuntimeError("DEEPGRAM_STREAM_TIMING_INVALID")
    return endpointing_ms, utterance_end_ms


def npu_whisper_settings(config: dict[str, Any]) -> dict[str, Any]:
    """Resolve and validate the isolated Qualcomm Whisper runtime."""
    npu = config["stt"].get("npu") or {}
    local_app_data = Path(os.environ.get("LOCALAPPDATA", str(APP_DIR.parent)))
    default_app = local_app_data / "VCUBF" / "Emma" / "npu-whisper" / "fetch" / "whisper_windows_py"
    raw_app = os.path.expandvars(str(npu.get("appPath") or "").strip())
    app_path = Path(raw_app).expanduser() if raw_app else default_app
    raw_python = os.path.expandvars(str(npu.get("pythonPath") or "").strip())
    python_path = Path(raw_python).expanduser() if raw_python else app_path / ".venv" / "Scripts" / "python.exe"
    sidecar_path = Path(__file__).with_name("npu_whisper_sidecar.py")
    try:
        threshold = int(npu.get("speechThreshold", 300))
        pre_roll_ms = int(npu.get("preRollMs", 320))
        silence_ms = int(npu.get("silenceMs", 700))
        min_speech_ms = int(npu.get("minSpeechMs", 180))
        max_segment_ms = int(npu.get("maxSegmentMs", 15_000))
    except (TypeError, ValueError) as exc:
        raise RuntimeError("NPU_WHISPER_VAD_SETTINGS_INVALID") from exc
    if not 80 <= threshold <= 12_000:
        raise RuntimeError("NPU_WHISPER_VAD_SETTINGS_INVALID")
    if not 100 <= pre_roll_ms <= 2_000 or not 300 <= silence_ms <= 4_000:
        raise RuntimeError("NPU_WHISPER_VAD_SETTINGS_INVALID")
    if not 100 <= min_speech_ms <= 2_000 or not 1_000 <= max_segment_ms <= 30_000:
        raise RuntimeError("NPU_WHISPER_VAD_SETTINGS_INVALID")
    return {
        "pythonPath": python_path,
        "appPath": app_path,
        "sidecarPath": sidecar_path,
        "modelSize": str(npu.get("modelSize") or "base").strip(),
        "speechThreshold": threshold,
        "preRollMs": pre_roll_ms,
        "silenceMs": silence_ms,
        "minSpeechMs": min_speech_ms,
        "maxSegmentMs": max_segment_ms,
    }


def npu_whisper_available(config: dict[str, Any]) -> tuple[bool, str]:
    try:
        settings = npu_whisper_settings(config)
    except RuntimeError as exc:
        return False, str(exc)
    required = [
        settings["pythonPath"],
        settings["sidecarPath"],
        settings["appPath"] / "models" / "encoder.onnx",
        settings["appPath"] / "models" / "decoder.onnx",
    ]
    missing = [str(path) for path in required if not Path(path).is_file()]
    return (not missing, "" if not missing else "NPU_WHISPER_RUNTIME_MISSING")


def language_code(language: str, mode: str) -> str:
    if mode == "auto":
        return "multi"
    return language.split("-", 1)[0].lower() or "en"


def localized_runtime_status(language: str, state: str, wake_word: str = "Emma") -> str:
    """Text shown in the private live monitor must follow the active language."""
    locale = language.split("-", 1)[0].lower()
    messages = {
        "cs": {"waiting": f"Emma Voice v2 čeká na oslovení {wake_word}", "active": "Emma Voice v2 je aktivní — nyní mluvte", "thinking": "Emma Voice v2 přemýšlí", "speaking": "Emma Voice v2 mluví", "ended": "Relace Emma Voice v2 skončila", "stopped": "Emma Voice v2 byla zastavena"},
        "pl": {"waiting": f"Emma Voice v2 czeka na słowo {wake_word}", "active": "Emma Voice v2 jest aktywna — mów teraz", "thinking": "Emma Voice v2 myśli", "speaking": "Emma Voice v2 mówi", "ended": "Sesja Emma Voice v2 zakończona", "stopped": "Emma Voice v2 została zatrzymana"},
        "fr": {"waiting": f"Emma Voice v2 attend le mot {wake_word}", "active": "Emma Voice v2 est active — parlez maintenant", "thinking": "Emma Voice v2 réfléchit", "speaking": "Emma Voice v2 parle", "ended": "La session Emma Voice v2 est terminée", "stopped": "Emma Voice v2 est arrêtée"},
        "de": {"waiting": f"Emma Voice v2 wartet auf {wake_word}", "active": "Emma Voice v2 ist aktiv — sprechen Sie jetzt", "thinking": "Emma Voice v2 denkt nach", "speaking": "Emma Voice v2 spricht", "ended": "Die Emma-Voice-v2-Sitzung ist beendet", "stopped": "Emma Voice v2 wurde beendet"},
        "es": {"waiting": f"Emma Voice v2 espera la palabra {wake_word}", "active": "Emma Voice v2 está activa — hable ahora", "thinking": "Emma Voice v2 está pensando", "speaking": "Emma Voice v2 está hablando", "ended": "La sesión de Emma Voice v2 ha terminado", "stopped": "Emma Voice v2 se ha detenido"},
        "it": {"waiting": f"Emma Voice v2 attende la parola {wake_word}", "active": "Emma Voice v2 è attiva — parli ora", "thinking": "Emma Voice v2 sta pensando", "speaking": "Emma Voice v2 sta parlando", "ended": "La sessione Emma Voice v2 è terminata", "stopped": "Emma Voice v2 è stata arrestata"},
        "en": {"waiting": f"Emma Voice v2 is waiting for {wake_word}", "active": "Emma Voice v2 active — speak now", "thinking": "Emma Voice v2 is thinking", "speaking": "Emma Voice v2 is speaking", "ended": "Emma Voice v2 session ended", "stopped": "Emma Voice v2 stopped"},
    }
    return messages.get(locale, messages["en"]).get(state, messages["en"].get(state, RUNTIME_NAME))


def normalized_text(value: str) -> str:
    return " ".join("".join(character.lower() if character.isalnum() else " " for character in value).split())


def contains_wake_word(transcript: str, wake_word: str) -> bool:
    phrase = normalized_text(wake_word)
    heard = normalized_text(transcript)
    if not phrase or not heard:
        return False
    accepted = {phrase}
    # Czech address of the default name is naturally "Emmo". It is still the
    # same configured wake word, not a language fallback or a second assistant.
    if phrase == "emma":
        accepted.add("emmo")
    return any(f" {candidate} " in f" {heard} " for candidate in accepted)


def wake_command_tail(transcript: str, wake_word: str) -> str:
    """Keep a command spoken directly after the wake word, if there is one."""
    candidates = [wake_word]
    if normalized_text(wake_word) == "emma":
        candidates.append("Emmo")
    pattern = "|".join(re.escape(candidate) for candidate in candidates if candidate.strip())
    match = re.search(rf"(?i)(?<!\w)(?:{pattern})(?!\w)", transcript)
    return transcript[match.end():].lstrip(" ,.:;!?-–—") if match else ""


def pcm_mean_amplitude(raw: bytes) -> int:
    """Return a cheap local VAD signal for signed 16-bit PCM audio."""
    samples = array("h")
    samples.frombytes(raw[: len(raw) - (len(raw) % SAMPLE_WIDTH)])
    if not samples:
        return 0
    return sum(abs(sample) for sample in samples) // len(samples)


def looks_like_self_echo(heard: str, assistant: str) -> bool:
    heard_normalized = normalized_text(heard)
    assistant_normalized = normalized_text(assistant)
    if not heard_normalized or not assistant_normalized:
        return False
    if min(len(heard_normalized), len(assistant_normalized)) >= 3 and (
        heard_normalized in assistant_normalized or assistant_normalized in heard_normalized
    ):
        return True
    if min(len(heard_normalized), len(assistant_normalized)) < 8:
        return False
    return SequenceMatcher(None, heard_normalized, assistant_normalized).ratio() >= 0.64


def self_test() -> bool:
    defaults = default_v2_config()
    merged = merge_defaults(defaults, {"stt": {"model": "nova-3-test"}})
    return (
        merged["stt"]["model"] == "nova-3-test"
        and merged["tts"]["outputFormat"] == "pcm_24000"
        and language_code("cs-CZ", "selected") == "cs"
        and language_code("cs-CZ", "auto") == "multi"
        and contains_wake_word("Emmo, otevři kontakty", "Emma")
        and wake_command_tail("Emma, otevři kontakty", "Emma") == "otevři kontakty"
        and contains_wake_word("Emma, otevři kontakty", "Emma")
        and pcm_mean_amplitude(b"\x00\x00\x00\x00") == 0
        and pcm_mean_amplitude(b"\x10\x00\xf0\xff") == 16
        and stream_timing_settings(defaults) == (250, 1_000)
        and companion_is_running(os.getpid())
        and looks_like_self_echo("hello there", "Hello there, how can I help?")
        and not looks_like_self_echo("stop now", "Hello there, how can I help?")
    )


def provider_status(config: dict[str, Any]) -> dict[str, Any]:
    stt = config["stt"]
    tts = config["tts"]
    requested_stt_provider = str(stt.get("provider") or "deepgram").strip()
    try:
        language, wake_word = current_wake_profile(config)
        profile_error = ""
    except RuntimeError as exc:
        language, wake_word, profile_error = "", "", str(exc)
    try:
        wake_vad_settings(config)
        vad_error = ""
    except RuntimeError as exc:
        vad_error = str(exc)
    try:
        stream_timing_settings(config)
        timing_error = ""
    except RuntimeError as exc:
        timing_error = str(exc)
    npu_ready, npu_error = npu_whisper_available(config)
    try:
        picovoice_key_env, picovoice_keyword_path, _ = picovoice_wake_settings(config)
        picovoice_error = ""
    except RuntimeError as exc:
        picovoice_key_env, picovoice_keyword_path, picovoice_error = "", "", str(exc)
    requested_wake_provider = str(config["wake"].get("provider") or "deepgram_vad")
    deepgram_wake_ready = bool(wake_word) and not profile_error and not vad_error
    picovoice_wake_ready = (
        bool(wake_word)
        and not profile_error
        and not picovoice_error
        and (pvporcupine is not None or node_picovoice_available())
        and bool(picovoice_key_env and environment_value(picovoice_key_env))
        and bool(picovoice_keyword_path and Path(picovoice_keyword_path).is_file())
    )
    if requested_wake_provider == "picovoice_porcupine" and picovoice_wake_ready:
        effective_wake_provider = "picovoice_porcupine"
        wake_fallback_reason = ""
    elif requested_wake_provider == "picovoice_porcupine" and deepgram_wake_ready:
        effective_wake_provider = "deepgram_vad"
        wake_fallback_reason = profile_error or picovoice_error or "PICOVOICE_MODEL_OR_KEY_UNAVAILABLE"
    elif requested_wake_provider == "deepgram_vad" and deepgram_wake_ready:
        effective_wake_provider = "deepgram_vad"
        wake_fallback_reason = ""
    else:
        effective_wake_provider = ""
        wake_fallback_reason = "WAKE_PROVIDER_NOT_READY"
    deepgram_ready = bool(environment_value(str(stt["apiKeyEnv"]))) and not timing_error
    if requested_stt_provider == "npu_whisper" and npu_ready:
        effective_stt_provider = "npu_whisper"
        stt_fallback_reason = ""
    elif requested_stt_provider == "npu_whisper" and deepgram_ready:
        effective_stt_provider = "deepgram"
        stt_fallback_reason = npu_error or "NPU_WHISPER_UNAVAILABLE"
    elif requested_stt_provider == "deepgram" and deepgram_ready:
        effective_stt_provider = "deepgram"
        stt_fallback_reason = ""
    else:
        effective_stt_provider = ""
        stt_fallback_reason = "STT_PROVIDER_NOT_READY"
    configured = {
        "wake": {
            "requestedProvider": requested_wake_provider,
            "effectiveProvider": effective_wake_provider,
            "providerConfigured": bool(effective_wake_provider),
            "language": language,
            "wakeWordPresent": bool(wake_word),
            "vadSettingsValid": not vad_error,
            "packageInstalled": pvporcupine is not None,
            "nodeSidecarInstalled": node_picovoice_available(),
            "picovoiceAccessKeyPresent": bool(picovoice_key_env and environment_value(picovoice_key_env)),
            "keywordModelConfigured": bool(picovoice_keyword_path),
            "keywordModelPresent": bool(picovoice_keyword_path and Path(picovoice_keyword_path).is_file()),
            "picovoiceSettingsValid": not picovoice_error,
            "fallbackActive": bool(wake_fallback_reason and effective_wake_provider),
            "fallbackReason": wake_fallback_reason,
            "configurationError": profile_error or vad_error or picovoice_error,
        },
        "deepgram": {
            "provider": "deepgram",
            "apiKeyPresent": bool(environment_value(str(stt["apiKeyEnv"]))),
            "model": stt["model"],
            "streamTimingValid": not timing_error,
            "configurationError": timing_error,
        },
        "npuWhisper": {
            "requestedProvider": requested_stt_provider,
            "effectiveProvider": effective_stt_provider,
            "providerConfigured": bool(effective_stt_provider),
            "runtimePresent": npu_ready,
            "executionProvider": "QNNExecutionProvider" if npu_ready else "",
            "device": "Qualcomm Hexagon NPU" if npu_ready else "",
            "fallbackActive": bool(stt_fallback_reason and effective_stt_provider),
            "fallbackReason": stt_fallback_reason,
            "configurationError": npu_error,
        },
        "elevenlabs": {
            "provider": tts["provider"],
            "apiKeyPresent": bool(environment_value(str(tts["apiKeyEnv"]))),
            "voiceIdPresent": configured_value(tts.get("voiceId")),
            "model": tts["model"],
            "outputFormat": tts["outputFormat"],
        },
    }
    ready = (
        configured["wake"]["providerConfigured"]
        and configured["wake"]["wakeWordPresent"]
        and configured["npuWhisper"]["providerConfigured"]
        and (
            configured["wake"]["effectiveProvider"] != "deepgram_vad"
            or configured["deepgram"]["apiKeyPresent"]
        )
        and configured["elevenlabs"]["apiKeyPresent"]
        and configured["elevenlabs"]["voiceIdPresent"]
    )
    return {"runtime": RUNTIME_NAME, "ready": ready, "providers": configured}


class DuplexSpeaker:
    """PCM playback thread that feeds exact far-end audio to WebRTC AEC."""

    def __init__(self, audio: pyaudio.PyAudio, aec: AudioProcessor, aec_lock: threading.Lock):
        self.audio = audio
        self.aec = aec
        self.aec_lock = aec_lock
        self.queue: queue.Queue[bytes | object] = queue.Queue()
        self.reset = threading.Event()
        self.stop = threading.Event()
        self.active = threading.Event()
        self.finished = threading.Event()
        self.thread: threading.Thread | None = None
        self.stream = None

    def start(self) -> None:
        self.thread = threading.Thread(target=self._worker, name="emma-v2-playback", daemon=True)
        self.thread.start()

    def enqueue(self, payload: bytes) -> None:
        if payload:
            self.finished.clear()
            self.active.set()
            self.queue.put_nowait(payload)

    def finish(self) -> None:
        self.queue.put_nowait(PLAYBACK_END)

    def interrupt(self) -> None:
        self.reset.set()
        self.active.clear()
        self.finished.set()
        while True:
            try:
                self.queue.get_nowait()
            except queue.Empty:
                break

    def close(self) -> None:
        self.stop.set()
        self.queue.put_nowait(PLAYBACK_STOP)
        if self.thread:
            self.thread.join(timeout=2)
        if self.stream:
            try:
                self.stream.stop_stream()
                self.stream.close()
            except Exception:
                pass

    def _worker(self) -> None:
        self.stream = self.audio.open(
            format=pyaudio.paInt16,
            channels=CHANNELS,
            rate=RATE,
            output=True,
            frames_per_buffer=PLAYBACK_FRAME_BYTES // SAMPLE_WIDTH,
        )
        try:
            delay_ms = max(20, min(300, int(self.stream.get_output_latency() * 1_000) + 30))
            self.aec.set_stream_delay(delay_ms)
            log(f"v2 acoustic echo cancellation active; delay={delay_ms}ms")
        except Exception as exc:
            log(f"v2 AEC delay detection failed: {type(exc).__name__}")
        buffer = PcmPlaybackBuffer(
            frame_bytes=PLAYBACK_FRAME_BYTES,
            prebuffer_bytes=PLAYBACK_PREBUFFER_BYTES,
        )
        while not self.stop.is_set():
            if self.reset.is_set():
                buffer.clear()
                self.reset.clear()
                continue
            frame = buffer.take_frame()
            if frame is None:
                try:
                    item = self.queue.get(timeout=0.05)
                except queue.Empty:
                    if buffer.drained:
                        self.active.clear()
                        self.finished.set()
                    continue
                if item is PLAYBACK_STOP:
                    return
                if item is PLAYBACK_END:
                    buffer.finish()
                    continue
                if isinstance(item, bytes):
                    buffer.append(item)
                continue
            if self.reset.is_set():
                continue
            with self.aec_lock:
                self.aec.process_reverse_stream(frame)
            self.stream.write(frame, exception_on_underflow=False)


class ElevenLabsPcmTts:
    def __init__(self, config: dict[str, Any]):
        self.api_key = environment_value(str(config["apiKeyEnv"]))
        self.voice_id = str(config["voiceId"]).strip()
        self.model = str(config["model"]).strip()
        self.output_format = str(config["outputFormat"]).strip()

    def stream(self, text: str, language: str, speaker: DuplexSpeaker, generation: int, current_generation: callable) -> None:
        if not self.api_key or not self.voice_id:
            raise RuntimeError("ELEVENLABS_NOT_CONFIGURED")
        query = urlencode({"output_format": self.output_format, "enable_logging": "false"})
        request = urllib.request.Request(
            f"https://api.elevenlabs.io/v1/text-to-speech/{self.voice_id}/stream?{query}",
            data=json.dumps({
                "text": text[:4_000],
                "model_id": self.model,
                "language_code": language.split("-", 1)[0].lower(),
            }).encode("utf-8"),
            method="POST",
            headers={"xi-api-key": self.api_key, "Content-Type": "application/json", "Accept": "audio/pcm"},
        )
        with urllib.request.urlopen(request, timeout=45) as response:
            while current_generation() == generation:
                chunk = response.read(PLAYBACK_FRAME_BYTES * 8)
                if not chunk:
                    break
                speaker.enqueue(chunk)
        if current_generation() == generation:
            speaker.finish()


class NpuWhisperClient:
    """One persistent in-memory Whisper model backed by Qualcomm QNN."""

    def __init__(self, config: dict[str, Any]):
        self.settings = npu_whisper_settings(config)
        self.process: subprocess.Popen[str] | None = None
        self.responses: queue.Queue[dict[str, Any]] = queue.Queue()
        self.reader: threading.Thread | None = None
        self.lock = threading.Lock()
        self.sequence = 0
        self.log_handle = None

    def _reader(self) -> None:
        if not self.process or not self.process.stdout:
            return
        for line in self.process.stdout:
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(payload, dict):
                self.responses.put(payload)
        self.responses.put({"type": "eof", "error": "NPU_WHISPER_PROCESS_ENDED"})

    def _next_response(self, timeout: float) -> dict[str, Any]:
        try:
            return self.responses.get(timeout=timeout)
        except queue.Empty as exc:
            raise RuntimeError("NPU_WHISPER_TIMEOUT") from exc

    def start(self) -> None:
        if self.process and self.process.poll() is None:
            return
        while True:
            try:
                self.responses.get_nowait()
            except queue.Empty:
                break
        settings = self.settings
        self.log_handle = (APP_DIR / "npu-whisper.log").open("a", encoding="utf-8")
        creation_flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        self.process = subprocess.Popen(
            [
                str(settings["pythonPath"]),
                str(settings["sidecarPath"]),
                "--app-root",
                str(settings["appPath"]),
                "--model-size",
                str(settings["modelSize"]),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self.log_handle,
            text=True,
            encoding="utf-8",
            bufsize=1,
            creationflags=creation_flags,
        )
        self.reader = threading.Thread(target=self._reader, name="emma-npu-whisper-output", daemon=True)
        self.reader.start()
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            response = self._next_response(max(0.1, deadline - time.monotonic()))
            if response.get("type") == "ready" and response.get("provider") == "QNNExecutionProvider":
                log("v2 NPU Whisper ready via QNNExecutionProvider")
                return
            if response.get("type") in {"fatal", "eof"}:
                raise RuntimeError(str(response.get("error") or "NPU_WHISPER_START_FAILED"))
        raise RuntimeError("NPU_WHISPER_START_TIMEOUT")

    def transcribe(self, pcm16: bytes, sample_rate: int = RATE) -> tuple[str, int]:
        with self.lock:
            self.start()
            if not self.process or not self.process.stdin or self.process.poll() is not None:
                raise RuntimeError("NPU_WHISPER_NOT_RUNNING")
            self.sequence += 1
            request_id = self.sequence
            request = {
                "id": request_id,
                "sample_rate": sample_rate,
                "pcm16": base64.b64encode(pcm16).decode("ascii"),
            }
            self.process.stdin.write(json.dumps(request, separators=(",", ":")) + "\n")
            self.process.stdin.flush()
            deadline = time.monotonic() + 25
            while time.monotonic() < deadline:
                response = self._next_response(max(0.1, deadline - time.monotonic()))
                if response.get("type") in {"fatal", "eof"}:
                    raise RuntimeError(str(response.get("error") or "NPU_WHISPER_PROCESS_ENDED"))
                if response.get("id") != request_id:
                    continue
                if response.get("type") == "error":
                    raise RuntimeError(str(response.get("error") or "NPU_WHISPER_TRANSCRIPTION_FAILED"))
                if response.get("type") == "transcription":
                    return str(response.get("text") or "").strip(), int(response.get("elapsed_ms") or 0)
            raise RuntimeError("NPU_WHISPER_TRANSCRIPTION_TIMEOUT")

    def close(self) -> None:
        process, self.process = self.process, None
        if process:
            try:
                if process.stdin:
                    process.stdin.close()
                process.wait(timeout=3)
            except Exception:
                process.kill()
                try:
                    process.wait(timeout=3)
                except Exception:
                    pass
        if self.log_handle:
            self.log_handle.close()
            self.log_handle = None


class DeepgramWakeWord:
    """Privacy-gated cloud wake detection for languages Windows cannot recognise."""

    def __init__(self, config: dict[str, Any], parent_pid: int = 0, stop_file: Path | None = None):
        self.config = config
        self.parent_pid = parent_pid
        self.stop_file = stop_file

    def url(self, language: str, wake_word: str) -> str:
        stt = self.config["stt"]
        query = {
            "model": str(stt["model"]),
            "language": language_code(language, str(stt["languageMode"])),
            "encoding": "linear16",
            "sample_rate": str(RATE),
            "channels": str(CHANNELS),
            "interim_results": "true",
            "punctuate": "true",
            "smart_format": "true",
            "endpointing": "300",
            "vad_events": "true",
            # Wake verification is transient. Do not opt the VAD-triggered
            # snippets into the provider's model-improvement programme.
            "mip_opt_out": "true",
        }
        if "nova-3" in str(stt["model"]).lower():
            query["keyterm"] = wake_word
        return "wss://api.deepgram.com/v1/listen?" + urlencode(query)

    async def publish_listening_state(self) -> None:
        """Keep the Secretary UI truthful while V2 waits for the wake word."""
        try:
            await asyncio.to_thread(
                backend_json,
                "PUT",
                "/command/voice-state",
                {"status": "listening", "mode": "wake_word", "listening": True},
            )
        except Exception as exc:
            log(f"v2 wake state error: {type(exc).__name__}")

    async def listening_heartbeat(self) -> None:
        """Refresh the 15-second backend presence lease without blocking audio."""
        while companion_is_running(self.parent_pid, self.stop_file):
            await self.publish_listening_state()
            await asyncio.sleep(5)

    async def transcribe_segment(
        self,
        stream: Any,
        pre_roll: list[bytes],
        language: str,
        wake_word: str,
        threshold: int,
        silence_ms: int,
        max_segment_ms: int,
    ) -> str | None:
        api_key = environment_value(str(self.config["stt"]["apiKeyEnv"]))
        detected = asyncio.Event()
        command_tail = ""

        async with websockets.connect(
            self.url(language, wake_word),
            additional_headers={"Authorization": f"Token {api_key}"},
            max_size=2 * 1024 * 1024,
        ) as websocket:
            async def receive_results() -> None:
                nonlocal command_tail
                async for raw in websocket:
                    if isinstance(raw, bytes):
                        continue
                    try:
                        event = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    if event.get("type") != "Results" or not event.get("is_final"):
                        continue
                    alternatives = ((event.get("channel") or {}).get("alternatives") or [])
                    transcript = str((alternatives[0] if alternatives else {}).get("transcript") or "")
                    if contains_wake_word(transcript, wake_word):
                        command_tail = wake_command_tail(transcript, wake_word)
                        detected.set()
                        return

            receiver = asyncio.create_task(receive_results())
            try:
                for payload in pre_roll:
                    await websocket.send(payload)
                silence_frames = 0
                max_silence_frames = max(1, (silence_ms + INPUT_FRAME_MS - 1) // INPUT_FRAME_MS)
                started = time.monotonic()
                while not detected.is_set() and time.monotonic() - started < max_segment_ms / 1_000:
                    if not companion_is_running(self.parent_pid, self.stop_file):
                        return None
                    raw = await asyncio.to_thread(stream.read, INPUT_FRAME_BYTES // SAMPLE_WIDTH, False)
                    await websocket.send(raw)
                    if pcm_mean_amplitude(raw) >= threshold:
                        silence_frames = 0
                    else:
                        silence_frames += 1
                    if silence_frames >= max_silence_frames:
                        break
                if not detected.is_set():
                    await websocket.send(json.dumps({"type": "Finalize"}))
                    try:
                        await asyncio.wait_for(receiver, timeout=1.2)
                    except asyncio.TimeoutError:
                        pass
                return command_tail if detected.is_set() else None
            finally:
                if not receiver.done():
                    receiver.cancel()
                await asyncio.gather(receiver, return_exceptions=True)

    async def wait(self) -> str:
        language, wake_word = current_wake_profile(self.config)
        threshold, pre_roll_ms, silence_ms, max_segment_ms = wake_vad_settings(self.config)
        api_key = environment_value(str(self.config["stt"]["apiKeyEnv"]))
        if not api_key:
            raise RuntimeError("DEEPGRAM_NOT_CONFIGURED")
        audio = pyaudio.PyAudio()
        stream = None
        heartbeat: asyncio.Task[None] | None = None
        try:
            stream = audio.open(
                format=pyaudio.paInt16,
                channels=CHANNELS,
                rate=RATE,
                input=True,
                frames_per_buffer=INPUT_FRAME_BYTES // SAMPLE_WIDTH,
            )
            heartbeat = asyncio.create_task(self.listening_heartbeat())
            write_live_preview(status=localized_runtime_status(language, "waiting", wake_word))
            log(f"v2 Deepgram VAD wake listener started ({language}, {wake_word})")
            pre_roll_frames = max(1, (pre_roll_ms + INPUT_FRAME_MS - 1) // INPUT_FRAME_MS)
            pre_roll: deque[bytes] = deque(maxlen=pre_roll_frames)
            while True:
                if not companion_is_running(self.parent_pid, self.stop_file):
                    return None
                raw = await asyncio.to_thread(stream.read, INPUT_FRAME_BYTES // SAMPLE_WIDTH, False)
                pre_roll.append(raw)
                if pcm_mean_amplitude(raw) < threshold:
                    continue
                activation_command = await self.transcribe_segment(
                    stream,
                    list(pre_roll),
                    language,
                    wake_word,
                    threshold,
                    silence_ms,
                    max_segment_ms,
                )
                if activation_command is not None:
                    log("v2 Deepgram wake word detected")
                    return activation_command
                write_live_preview(status=localized_runtime_status(language, "waiting", wake_word))
        finally:
            if heartbeat:
                heartbeat.cancel()
                await asyncio.gather(heartbeat, return_exceptions=True)
            if stream:
                try:
                    stream.stop_stream()
                    stream.close()
                except Exception:
                    pass
            audio.terminate()


class PicovoiceWakeWord:
    """Fully local, low-latency wake-word detection using a custom .ppn file."""

    def __init__(self, config: dict[str, Any], parent_pid: int = 0, stop_file: Path | None = None):
        self.config = config
        self.parent_pid = parent_pid
        self.stop_file = stop_file

    async def publish_listening_state(self) -> None:
        try:
            await asyncio.to_thread(
                backend_json,
                "PUT",
                "/command/voice-state",
                {"status": "listening", "mode": "wake_word", "listening": True},
            )
        except Exception as exc:
            log(f"v2 wake state error: {type(exc).__name__}")

    async def listening_heartbeat(self) -> None:
        while companion_is_running(self.parent_pid, self.stop_file):
            await self.publish_listening_state()
            await asyncio.sleep(5)

    async def wait_with_node(self, keyword_path: str, sensitivity: float) -> str | None:
        node_path = os.environ["PICOVOICE_NODE_PATH"]
        modules_path = os.environ["PICOVOICE_NODE_MODULES"]
        sidecar_path = str(Path(__file__).with_name("picovoice_wake.js"))
        environment = os.environ.copy()
        environment["NODE_PATH"] = modules_path
        creation_flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        process = await asyncio.create_subprocess_exec(
            node_path,
            sidecar_path,
            keyword_path,
            str(sensitivity),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=environment,
            creationflags=creation_flags,
        )
        try:
            while companion_is_running(self.parent_pid, self.stop_file):
                if process.stdout is None:
                    raise RuntimeError("PICOVOICE_NODE_STDOUT_UNAVAILABLE")
                try:
                    raw_line = await asyncio.wait_for(process.stdout.readline(), timeout=1.0)
                except asyncio.TimeoutError:
                    if process.returncode is not None:
                        raise RuntimeError("PICOVOICE_NODE_EXITED")
                    continue
                line = raw_line.decode("utf-8", errors="replace").strip()
                if line == "DETECTED":
                    log("v2 Picovoice Node wake word detected")
                    return ""
                if not line and process.returncode is not None:
                    error_name = ""
                    if process.stderr is not None:
                        error_name = (await process.stderr.read()).decode("utf-8", errors="replace").strip()[:160]
                    raise RuntimeError(error_name or "PICOVOICE_NODE_EXITED")
            return None
        finally:
            if process.returncode is None:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), timeout=2.0)
                except asyncio.TimeoutError:
                    process.kill()
                    await process.wait()

    async def wait(self) -> str | None:
        language, wake_word = current_wake_profile(self.config)
        access_key_env, keyword_path, sensitivity = picovoice_wake_settings(self.config)
        access_key = environment_value(access_key_env)
        if not access_key:
            raise RuntimeError("PICOVOICE_ACCESS_KEY_NOT_CONFIGURED")
        if not keyword_path or not Path(keyword_path).is_file():
            raise RuntimeError("PICOVOICE_KEYWORD_MODEL_NOT_FOUND")

        heartbeat: asyncio.Task[None] | None = asyncio.create_task(self.listening_heartbeat())
        write_live_preview(status=localized_runtime_status(language, "waiting", wake_word))
        if node_picovoice_available():
            try:
                log(f"v2 Picovoice Node wake listener started ({language}, {wake_word})")
                return await self.wait_with_node(keyword_path, sensitivity)
            finally:
                heartbeat.cancel()
                await asyncio.gather(heartbeat, return_exceptions=True)

        if pvporcupine is None:
            heartbeat.cancel()
            await asyncio.gather(heartbeat, return_exceptions=True)
            raise RuntimeError("PICOVOICE_PACKAGE_NOT_INSTALLED")

        porcupine = pvporcupine.create(
            access_key=access_key,
            keyword_paths=[keyword_path],
            sensitivities=[sensitivity],
        )
        audio = pyaudio.PyAudio()
        stream = None
        try:
            stream = audio.open(
                format=pyaudio.paInt16,
                channels=CHANNELS,
                rate=porcupine.sample_rate,
                input=True,
                frames_per_buffer=porcupine.frame_length,
            )
            log(f"v2 Picovoice wake listener started ({language}, {wake_word})")
            while companion_is_running(self.parent_pid, self.stop_file):
                raw = await asyncio.to_thread(stream.read, porcupine.frame_length, False)
                samples = array("h")
                samples.frombytes(raw)
                if porcupine.process(samples) >= 0:
                    log("v2 Picovoice wake word detected")
                    return ""
            return None
        finally:
            heartbeat.cancel()
            await asyncio.gather(heartbeat, return_exceptions=True)
            if stream:
                try:
                    stream.stop_stream()
                    stream.close()
                except Exception:
                    pass
            audio.terminate()
            porcupine.delete()


@dataclass
class TranscriptStore:
    conversation_id: str | None = None
    sequence: int = 1
    history: deque[dict[str, Any] | None] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        self.history = deque(maxlen=20)

    async def start(self) -> None:
        result = await asyncio.to_thread(backend_json, "POST", "/command/voice-conversations", {"mode": "realtime"})
        self.conversation_id = str(result["id"])

    async def append(self, role: str, content: str, source_event_id: str) -> None:
        value = content.strip()
        if not value:
            return
        item = {"role": role, "content": value[:800], "sequence": self.sequence}
        self.history.append(item)
        if self.conversation_id:
            try:
                await asyncio.to_thread(
                    backend_json,
                    "POST",
                    f"/command/voice-conversations/{self.conversation_id}/messages",
                    {"role": role, "content": value[:8_000], "sequence": self.sequence, "source_event_id": source_event_id[:200]},
                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                # Voice interaction must remain available when the optional
                # transcript sync is temporarily unavailable. The in-memory
                # turn remains in history and a later turn can still succeed.
                log(f"v2 transcript sync error: {type(exc).__name__}")
        self.sequence += 1

    async def end(self, status: str) -> None:
        if not self.conversation_id:
            return
        identifier, self.conversation_id = self.conversation_id, None
        await asyncio.to_thread(backend_json, "POST", f"/command/voice-conversations/{identifier}/end", {"status": status})


class VoiceSessionV2:
    def __init__(
        self,
        config: dict[str, Any],
        parent_pid: int = 0,
        stop_file: Path | None = None,
        npu_whisper: NpuWhisperClient | None = None,
    ):
        self.config = config
        self.parent_pid = parent_pid
        self.stop_file = stop_file
        self.common_config = load_config()
        self.language = str(self.common_config.get("Language", "en-GB"))
        if self.language not in LANGUAGE_NAMES:
            raise RuntimeError("VOICE_SESSION_LANGUAGE_INVALID")
        self.audio = pyaudio.PyAudio()
        self.aec_lock = threading.Lock()
        self.aec = AudioProcessor(enable_aec=True, enable_ns=True, ns_level=2, enable_agc=False, enable_vad=False)
        self.aec.set_stream_format(RATE, CHANNELS, RATE, CHANNELS)
        self.aec.set_reverse_stream_format(RATE, CHANNELS)
        self.speaker = DuplexSpeaker(self.audio, self.aec, self.aec_lock)
        self.tts = ElevenLabsPcmTts(config["tts"])
        self.transcript = TranscriptStore()
        self.stop = asyncio.Event()
        self.turn_task: asyncio.Task | None = None
        self.generation = 0
        self.last_assistant_text = ""
        self.last_activity = time.monotonic()
        self.input_stream = None
        self.pending_parts: list[str] = []
        self.npu_whisper = npu_whisper

    def current_generation(self) -> int:
        return self.generation

    def deepgram_url(self) -> str:
        stt = self.config["stt"]
        endpointing_ms, utterance_end_ms = stream_timing_settings(self.config)
        query = {
            "model": str(stt["model"]),
            "language": language_code(self.language, str(stt["languageMode"])),
            "encoding": "linear16",
            "sample_rate": str(RATE),
            "channels": str(CHANNELS),
            "interim_results": "true",
            "punctuate": "true",
            "smart_format": "true",
            "vad_events": "true",
            "endpointing": str(endpointing_ms),
            "utterance_end_ms": str(utterance_end_ms),
        }
        return "wss://api.deepgram.com/v1/listen?" + urlencode(query)

    def process_microphone_audio(self, raw: bytes) -> bytes:
        complete = len(raw) - (len(raw) % AEC_FRAME_BYTES)
        processed: list[bytes] = []
        with self.aec_lock:
            for offset in range(0, complete, AEC_FRAME_BYTES):
                processed.append(self.aec.process_stream(raw[offset:offset + AEC_FRAME_BYTES]))
        if complete < len(raw):
            processed.append(raw[complete:])
        return b"".join(processed)

    async def update_state(self, status: str, listening: bool, transcript: str = "", response: str = "") -> None:
        payload: dict[str, Any] = {"status": status, "mode": "realtime", "listening": listening}
        if transcript:
            payload["last_transcript"] = transcript[:2_000]
        if response:
            payload["last_response"] = response[:4_000]
        try:
            await asyncio.to_thread(backend_json, "PUT", "/command/voice-state", payload)
        except Exception as exc:
            log(f"v2 voice state error: {type(exc).__name__}")

    async def microphone_sender(self, ws: websockets.ClientConnection) -> None:
        self.input_stream = self.audio.open(
            format=pyaudio.paInt16,
            channels=CHANNELS,
            rate=RATE,
            input=True,
            frames_per_buffer=INPUT_FRAME_BYTES // SAMPLE_WIDTH,
        )
        while not self.stop.is_set():
            try:
                raw = await asyncio.to_thread(self.input_stream.read, INPUT_FRAME_BYTES // SAMPLE_WIDTH, False)
                await ws.send(self.process_microphone_audio(raw))
            except Exception as exc:
                if not self.stop.is_set():
                    log(f"v2 microphone error: {type(exc).__name__}: {str(exc)[:300]}")
                self.stop.set()

    async def npu_microphone_segmenter(self, segments: asyncio.Queue[bytes]) -> None:
        if not self.npu_whisper:
            raise RuntimeError("NPU_WHISPER_NOT_CONFIGURED")
        settings = self.npu_whisper.settings
        threshold = int(settings["speechThreshold"])
        pre_roll_frames = max(1, int(settings["preRollMs"]) // INPUT_FRAME_MS)
        silence_frames_required = max(1, int(settings["silenceMs"]) // INPUT_FRAME_MS)
        min_speech_frames = max(1, int(settings["minSpeechMs"]) // INPUT_FRAME_MS)
        max_segment_frames = max(1, int(settings["maxSegmentMs"]) // INPUT_FRAME_MS)
        pre_roll: deque[bytes] = deque(maxlen=pre_roll_frames)
        active_frames: list[bytes] = []
        speech_frames = 0
        silence_frames = 0
        self.input_stream = self.audio.open(
            format=pyaudio.paInt16,
            channels=CHANNELS,
            rate=RATE,
            input=True,
            frames_per_buffer=INPUT_FRAME_BYTES // SAMPLE_WIDTH,
        )
        while not self.stop.is_set():
            try:
                raw = await asyncio.to_thread(self.input_stream.read, INPUT_FRAME_BYTES // SAMPLE_WIDTH, False)
                processed = self.process_microphone_audio(raw)
                loud = pcm_mean_amplitude(processed) >= threshold
                if not active_frames:
                    pre_roll.append(processed)
                    if loud:
                        active_frames = list(pre_roll)
                        speech_frames = 1
                        silence_frames = 0
                    continue
                active_frames.append(processed)
                if loud:
                    speech_frames += 1
                    silence_frames = 0
                else:
                    silence_frames += 1
                reached_end = silence_frames >= silence_frames_required and speech_frames >= min_speech_frames
                reached_limit = len(active_frames) >= max_segment_frames
                if reached_end or reached_limit:
                    await segments.put(b"".join(active_frames))
                    active_frames = []
                    speech_frames = 0
                    silence_frames = 0
                    pre_roll.clear()
            except Exception as exc:
                if not self.stop.is_set():
                    log(f"v2 NPU microphone error: {type(exc).__name__}: {str(exc)[:300]}")
                self.stop.set()

    async def npu_transcription_receiver(self, segments: asyncio.Queue[bytes]) -> None:
        if not self.npu_whisper:
            raise RuntimeError("NPU_WHISPER_NOT_CONFIGURED")
        while not self.stop.is_set():
            segment = await segments.get()
            try:
                text, elapsed_ms = await asyncio.to_thread(self.npu_whisper.transcribe, segment, RATE)
                log(f"v2 NPU transcription completed in {elapsed_ms}ms")
                if text:
                    await self.handle_transcript(text)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log(f"v2 NPU transcription error: {type(exc).__name__}: {str(exc)[:300]}")
                self.stop.set()

    async def handle_transcript(self, text: str) -> None:
        heard = text.strip()
        if not heard:
            return
        self.last_activity = time.monotonic()
        if self.speaker.active.is_set() and looks_like_self_echo(heard, self.last_assistant_text):
            log("v2 ignored transcript matching Emma playback")
            return
        if self.speaker.active.is_set():
            self.generation += 1
            self.speaker.interrupt()
            log("v2 assistant playback interrupted by validated transcript")
        if self.turn_task and not self.turn_task.done():
            self.turn_task.cancel()
        self.turn_task = asyncio.create_task(self.execute_turn(heard))

    async def execute_turn(self, heard: str) -> None:
        generation = self.generation
        await self.update_state("thinking", False, transcript=heard)
        try:
            await self.transcript.append("user", heard, f"v2-user-{self.transcript.sequence}")
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log(f"v2 local transcript error: {type(exc).__name__}")
        write_live_preview("user", heard, localized_runtime_status(self.language, "thinking"))
        try:
            result = await asyncio.to_thread(
                backend_command_json,
                "POST",
                "/command/assistant",
                {
                    "text": heard,
                    "input_method": "voice_transcript",
                    "language": self.language,
                    "history": build_backend_history(list(self.transcript.history), heard),
                },
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log(f"v2 business request error: {type(exc).__name__}")
            result = {"ok": False, "message": self.localized_error_message()}
        # Command responses can carry a record, a list or no data at all.
        # Only a record is allowed to request a language transition; treating
        # a list (for example from "show clients") as a record used to abort
        # the entire voice turn with AttributeError before Emma could speak.
        result_data = result.get("data") if isinstance(result, dict) else None
        selected_language = result_data.get("voiceLanguage") if isinstance(result_data, dict) else None
        if selected_language in LANGUAGE_NAMES and selected_language != self.language:
            self.language = selected_language
            save_config_language(selected_language)
            # The persisted transcript remains available, but old-language
            # turns must not bias the next response after a language switch.
            self.transcript.history.clear()
            log(f"v2 language changed to {selected_language}")
        message = self.result_message(result)
        if not message or generation != self.generation:
            return
        self.last_assistant_text = message
        try:
            await self.transcript.append("assistant", message, f"v2-assistant-{self.transcript.sequence}")
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log(f"v2 local transcript error: {type(exc).__name__}")
        write_live_preview("assistant", message, localized_runtime_status(self.language, "speaking"))
        await self.update_state("speaking", True, response=message)
        self.speaker.active.set()
        try:
            await asyncio.to_thread(self.tts.stream, message, self.language, self.speaker, generation, self.current_generation)
            while generation == self.generation and not self.speaker.finished.is_set() and not self.stop.is_set():
                await asyncio.sleep(0.03)
        except asyncio.CancelledError:
            raise
        except urllib.error.HTTPError as exc:
            # Provider failures must be distinguishable in the local log
            # without logging credentials or the spoken text.
            log(f"v2 tts HTTP error: {exc.code}")
        except (OSError, urllib.error.URLError) as exc:
            log(f"v2 tts error: {type(exc).__name__}")
        finally:
            if generation == self.generation:
                self.speaker.active.clear()
                self.last_activity = time.monotonic()
                await self.update_state("listening", True)

    def localized_error_message(self) -> str:
        messages = {
            "cs": "Teď se mi nepodařilo spojit se službou Secretary. Zkuste to prosím znovu.",
            "pl": "Nie udało mi się teraz połączyć z usługą Secretary. Spróbuj ponownie.",
            "fr": "Je n’ai pas pu joindre le service Secretary. Veuillez réessayer.",
            "de": "Ich konnte den Secretary-Dienst gerade nicht erreichen. Bitte versuchen Sie es erneut.",
            "es": "No he podido conectar con el servicio Secretary. Inténtelo de nuevo.",
            "it": "Non sono riuscita a contattare il servizio Secretary. Riprovi.",
            "en": "I could not reach the Secretary service just now. Please try again.",
        }
        return messages.get(self.language.split("-", 1)[0].lower(), messages["en"])

    def result_message(self, result: object) -> str:
        """Never describe a successful Secretary command as a connection failure."""
        if not isinstance(result, dict):
            return self.localized_error_message()
        explicit = str(result.get("message") or "").strip()
        if explicit:
            return explicit
        if not result.get("ok"):
            return self.localized_error_message()
        action = result.get("uiAction")
        if isinstance(action, dict) and action.get("kind") == "navigate":
            label = str(action.get("label") or "").strip()
            if label:
                prefixes = {
                    "cs": "Otevírám",
                    "pl": "Otwieram",
                    "fr": "J’ouvre",
                    "de": "Ich öffne",
                    "es": "Abriendo",
                    "it": "Apro",
                    "en": "Opening",
                }
                prefix = prefixes.get(self.language.split("-", 1)[0].lower(), prefixes["en"])
                return f"{prefix}: {label}."
        completed = {
            "cs": "Požadavek byl úspěšně dokončen.",
            "pl": "Polecenie zostało wykonane.",
            "fr": "La demande a été exécutée.",
            "de": "Die Anfrage wurde ausgeführt.",
            "es": "La solicitud se completó correctamente.",
            "it": "La richiesta è stata completata.",
            "en": "The request completed successfully.",
        }
        return completed.get(self.language.split("-", 1)[0].lower(), completed["en"])

    async def deepgram_receiver(self, ws: websockets.ClientConnection) -> None:
        async for raw in ws:
            if isinstance(raw, bytes):
                continue
            try:
                event = json.loads(raw)
            except json.JSONDecodeError:
                continue
            event_type = event.get("type")
            if event_type == "Results":
                alternatives = ((event.get("channel") or {}).get("alternatives") or [])
                transcript = str((alternatives[0] if alternatives else {}).get("transcript") or "").strip()
                if transcript and event.get("is_final"):
                    self.pending_parts.append(transcript)
                if event.get("speech_final"):
                    completed = " ".join(self.pending_parts).strip()
                    self.pending_parts.clear()
                    await self.handle_transcript(completed)
            elif event_type == "UtteranceEnd" and self.pending_parts:
                completed = " ".join(self.pending_parts).strip()
                self.pending_parts.clear()
                await self.handle_transcript(completed)

    async def heartbeat(self) -> None:
        while not self.stop.is_set():
            await asyncio.sleep(2)
            if not companion_is_running(self.parent_pid, self.stop_file):
                self.stop.set()
                continue
            if self.turn_task and self.turn_task.done():
                completed_turn, self.turn_task = self.turn_task, None
                try:
                    completed_turn.result()
                except asyncio.CancelledError:
                    pass
                except Exception as exc:
                    log(f"v2 turn error: {type(exc).__name__}")
            try:
                state = await asyncio.to_thread(backend_json, "GET", "/command/voice-state")
                if state.get("pendingControl") in {"pause", "end_conversation"}:
                    self.stop.set()
                    continue
            except Exception:
                pass
            idle_seconds = int(self.config["session"]["followUpSeconds"])
            if not self.speaker.active.is_set() and time.monotonic() - self.last_activity > idle_seconds:
                log("v2 follow-up window ended")
                self.stop.set()
                continue
            await self.update_state("speaking" if self.speaker.active.is_set() else "listening", not self.speaker.active.is_set())

    async def run_deepgram_transport(self, initial_transcript: str, started: float) -> None:
        api_key = environment_value(str(self.config["stt"]["apiKeyEnv"]))
        if not api_key:
            raise RuntimeError("DEEPGRAM_NOT_CONFIGURED")
        async with websockets.connect(
            self.deepgram_url(),
            additional_headers={"Authorization": f"Token {api_key}"},
            max_size=8 * 1024 * 1024,
        ) as ws:
            sender = asyncio.create_task(self.microphone_sender(ws))
            receiver = asyncio.create_task(self.deepgram_receiver(ws))
            heartbeat = asyncio.create_task(self.heartbeat())
            if initial_transcript.strip():
                await self.handle_transcript(initial_transcript)
            while not self.stop.is_set() and time.monotonic() - started < int(self.config["session"]["maxSeconds"]):
                await asyncio.sleep(0.1)
            for task in (sender, receiver, heartbeat):
                task.cancel()
            await asyncio.gather(sender, receiver, heartbeat, return_exceptions=True)
            try:
                await ws.send(json.dumps({"type": "CloseStream"}))
            except Exception:
                pass

    async def run_npu_transport(self, initial_transcript: str, started: float) -> None:
        if not self.npu_whisper:
            raise RuntimeError("NPU_WHISPER_NOT_CONFIGURED")
        segments: asyncio.Queue[bytes] = asyncio.Queue(maxsize=3)
        sender = asyncio.create_task(self.npu_microphone_segmenter(segments))
        receiver = asyncio.create_task(self.npu_transcription_receiver(segments))
        heartbeat = asyncio.create_task(self.heartbeat())
        if initial_transcript.strip():
            await self.handle_transcript(initial_transcript)
        while not self.stop.is_set() and time.monotonic() - started < int(self.config["session"]["maxSeconds"]):
            for task in (sender, receiver):
                if task.done():
                    error = task.exception()
                    if error:
                        raise error
                    self.stop.set()
            await asyncio.sleep(0.05)
        for task in (sender, receiver, heartbeat):
            task.cancel()
        await asyncio.gather(sender, receiver, heartbeat, return_exceptions=True)

    async def run(self, initial_transcript: str = "") -> None:
        self.speaker.start()
        try:
            await self.transcript.start()
            await self.update_state("listening", True)
            write_live_preview(status=localized_runtime_status(self.language, "active"))
            started = time.monotonic()
            stt_provider = "npu_whisper" if self.npu_whisper else "deepgram"
            log(f"v2 session started with language {self.language}; stt={stt_provider}")
            if self.npu_whisper:
                await self.run_npu_transport(initial_transcript, started)
            else:
                await self.run_deepgram_transport(initial_transcript, started)
        except Exception:
            await self.update_state("error", False)
            raise
        finally:
            self.generation += 1
            self.speaker.interrupt()
            if self.turn_task and not self.turn_task.done():
                self.turn_task.cancel()
                await asyncio.gather(self.turn_task, return_exceptions=True)
            await self.transcript.end("completed" if not self.stop.is_set() else "interrupted")
            self.speaker.close()
            if self.input_stream:
                try:
                    self.input_stream.stop_stream()
                    self.input_stream.close()
                except Exception:
                    pass
            self.audio.terminate()
            write_live_preview(status=localized_runtime_status(self.language, "ended"))
            log("v2 session ended")


async def run_voice_v2(parent_pid: int = 0, stop_file: str = "") -> None:
    config = load_v2_config()
    language, _ = current_wake_profile(config)
    status = provider_status(config)
    if not status["ready"]:
        missing = [
            f"{name}.{field}"
            for name, details in status["providers"].items()
            for field, value in details.items()
            if field in {"apiKeyPresent", "voiceIdPresent", "wakeWordPresent"} and value is False
        ]
        if not status["providers"]["wake"]["providerConfigured"]:
            missing.append("wake.providerConfigured")
        raise RuntimeError("VOICE_V2_NOT_CONFIGURED: " + ", ".join(missing))
    sentinel = Path(stop_file).resolve() if stop_file.strip() else None
    effective_provider = str(status["providers"]["wake"]["effectiveProvider"])
    wake = (
        PicovoiceWakeWord(config, parent_pid, sentinel)
        if effective_provider == "picovoice_porcupine"
        else DeepgramWakeWord(config, parent_pid, sentinel)
    )
    npu_whisper: NpuWhisperClient | None = None
    if status["providers"]["npuWhisper"]["effectiveProvider"] == "npu_whisper":
        candidate = NpuWhisperClient(config)
        try:
            await asyncio.to_thread(candidate.start)
            npu_whisper = candidate
        except Exception as exc:
            candidate.close()
            if not status["providers"]["deepgram"]["apiKeyPresent"]:
                raise
            log(f"v2 NPU Whisper startup failed; using Deepgram fallback: {type(exc).__name__}: {str(exc)[:200]}")
    try:
        while companion_is_running(parent_pid, sentinel):
            try:
                activation_command = await wake.wait()
            except Exception as exc:
                if isinstance(wake, PicovoiceWakeWord):
                    # A malformed/incompatible model or a transient licence
                    # check must not leave the desktop assistant deaf.
                    log(f"v2 Picovoice wake failure; using Deepgram fallback: {type(exc).__name__}")
                    wake = DeepgramWakeWord(config, parent_pid, sentinel)
                    continue
                raise
            if activation_command is None:
                break
            try:
                await VoiceSessionV2(config, parent_pid, sentinel, npu_whisper).run(activation_command)
            except Exception as exc:
                # A transient network/provider failure returns to the wake
                # listener rather than creating a second process or session.
                log(f"v2 session failure: {type(exc).__name__}: {str(exc)[:300]}")
                await asyncio.sleep(1)
    finally:
        if npu_whisper:
            await asyncio.to_thread(npu_whisper.close)
        try:
            await asyncio.to_thread(
                backend_json,
                "PUT",
                "/command/voice-state",
                {"status": "offline", "mode": "wake_word", "listening": False},
            )
        except Exception as exc:
            log(f"v2 shutdown state error: {type(exc).__name__}")
        current_language, _ = current_wake_profile(config)
        write_live_preview(status=localized_runtime_status(current_language, "stopped"))
        log("v2 runtime stopped")


def run_text_request(text: str) -> dict[str, Any]:
    common = load_config()
    language = str(common.get("Language", "en-GB"))
    return backend_command_json(
        "POST",
        "/command/assistant",
        {"text": text, "input_method": "voice_transcript", "language": language, "history": []},
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=RUNTIME_NAME)
    parser.add_argument("--diagnostic", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--run", action="store_true")
    parser.add_argument("--parent-pid", type=int, default=0)
    parser.add_argument("--stop-file", default="")
    parser.add_argument("--text", help="Send one text turn through the authenticated Secretary tool layer.")
    args = parser.parse_args()
    if args.self_test:
        print(json.dumps({"status": "ok" if self_test() else "failed", "runtime": RUNTIME_NAME}))
        return 0 if self_test() else 1
    if args.diagnostic:
        config = load_v2_config()
        print(json.dumps({**provider_status(config), "selfTest": self_test(), "configPath": str(V2_CONFIG_PATH)}, ensure_ascii=False))
        return 0 if self_test() else 1
    if args.text:
        print(json.dumps(run_text_request(args.text), ensure_ascii=False))
        return 0
    if args.run:
        asyncio.run(run_voice_v2(args.parent_pid, str(args.stop_file)))
        return 0
    parser.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())

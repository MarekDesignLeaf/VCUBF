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
import io
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import threading
import unicodedata
import time
from typing import Any
from urllib.parse import urlencode
import urllib.error
import urllib.request
import wave

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
    request_token,
    save_config_language,
    write_live_preview,
)


RUNTIME_NAME = "Emma Voice v2"
RATE = 24_000
NATIVE_WINDOWS_OUTPUT_RATE = 48_000
CHANNELS = 1
SAMPLE_WIDTH = 2
INPUT_FRAME_MS = 20
INPUT_FRAME_BYTES = RATE * SAMPLE_WIDTH * INPUT_FRAME_MS // 1_000
# WebRTC AEC consumes exact 10 ms blocks at the selected sample rate. Keep
# capture at 20 ms for efficient Deepgram streaming, but split it into these
# 10 ms frames before AEC and use the same frame size for the reverse signal.
AEC_FRAME_BYTES = RATE * SAMPLE_WIDTH * 10 // 1_000
# PortAudio's blocking Windows output is not reliable when Python feeds it in
# 10 ms writes.  Keep WebRTC AEC at its required 10 ms cadence, but submit four
# AEC frames to the audio device at once and retain enough network jitter
# buffer to survive normal ElevenLabs streaming variation.
PLAYBACK_DEVICE_FRAME_MS = 40
PLAYBACK_FRAME_BYTES = RATE * SAMPLE_WIDTH * PLAYBACK_DEVICE_FRAME_MS // 1_000
PLAYBACK_PREBUFFER_MS = 320
PLAYBACK_PREBUFFER_BYTES = RATE * SAMPLE_WIDTH * PLAYBACK_PREBUFFER_MS // 1_000
MAX_SESSION_SECONDS = 180
IDLE_AFTER_RESPONSE_SECONDS = 25
V2_CONFIG_PATH = APP_DIR / "voice-v2.json"
V2_LOG_PATH = APP_DIR / "emma-voice-v2.log"
PLAYBACK_END = object()
PLAYBACK_STOP = object()
POST_PLAYBACK_ECHO_GUARD_SECONDS = 0.75
DELAYED_SELF_ECHO_WINDOW_SECONDS = 12.0
BARGE_IN_MIN_RMS = 750.0
BARGE_IN_MIN_PEAK = 2_400
BARGE_IN_MAX_DYNAMIC_RMS = 1_800.0
BARGE_IN_MAX_DYNAMIC_PEAK = 6_000
BARGE_IN_OUTPUT_RMS_RATIO = 0.22
BARGE_IN_OUTPUT_PEAK_RATIO = 0.20
BARGE_IN_CONFIRM_FRAMES = 10
BARGE_IN_CANDIDATE_HOLD_SECONDS = 2.2
MAX_SPOKEN_RESPONSE_CHARS = 900
MAX_TTS_AUDIO_SECONDS = 45
MAX_TTS_PCM_BYTES = RATE * SAMPLE_WIDTH * MAX_TTS_AUDIO_SECONDS


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
            "deviceName": "",
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
            "provider": "openai",
            "apiKeyEnv": "ELEVENLABS_API_KEY",
            "voiceId": "",
            "model": "eleven_flash_v2_5",
            "outputFormat": "pcm_24000",
            "deviceName": "",
            "fallbackProvider": "openai",
            "fallbackApiKeyEnv": "OPENAI_API_KEY",
            "fallbackModel": "tts-1",
            "fallbackVoice": "nova",
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


def backend_transcribe_pcm(pcm16: bytes, sample_rate: int, wake_word: str = "") -> str:
    """Use Secretary's authenticated STT fallback without writing audio to disk."""
    memory = io.BytesIO()
    with wave.open(memory, "wb") as output:
        output.setnchannels(CHANNELS)
        output.setsampwidth(SAMPLE_WIDTH)
        output.setframerate(sample_rate)
        output.writeframes(pcm16)
    config = load_config()
    query = urlencode({"wake_word": wake_word}) if wake_word else ""
    url = config.get("ServerUrl", "http://localhost:4000").rstrip("/") + "/command/transcribe"
    if query:
        url += "?" + query
    request = urllib.request.Request(
        url,
        data=memory.getvalue(),
        method="POST",
        headers={
            "Authorization": f"Bearer {request_token(config)}",
            "Content-Type": "audio/wav",
        },
    )
    with urllib.request.urlopen(request, timeout=18) as response:
        payload = json.loads(response.read().decode("utf-8"))
    return str(payload.get("text") or "").strip()


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


class ListeningStateHeartbeat:
    """Publish wake-listener presence independently from the audio event loop.

    Wake detection can spend an arbitrary amount of time inside a native or
    subprocess audio read.  A dedicated thread keeps the backend's 15-second
    presence lease truthful even if that event loop is temporarily occupied.
    """

    def __init__(
        self,
        parent_pid: int = 0,
        stop_file: Path | None = None,
        audio_ready: threading.Event | None = None,
    ):
        self.parent_pid = parent_pid
        self.stop_file = stop_file
        self.audio_ready = audio_ready or threading.Event()
        self.stop_event = threading.Event()
        self.paused = threading.Event()
        self.thread: threading.Thread | None = None

    def start(self) -> None:
        if self.thread and self.thread.is_alive():
            return
        self.stop_event.clear()
        self.thread = threading.Thread(target=self._run, name="emma-v2-state-heartbeat", daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.stop_event.set()
        if self.thread and self.thread is not threading.current_thread():
            self.thread.join(timeout=2.0)
        self.thread = None

    def _run(self) -> None:
        while not self.stop_event.is_set() and companion_is_running(self.parent_pid, self.stop_file):
            try:
                listening = self.audio_ready.is_set() and not self.paused.is_set()
                state = backend_json(
                    "PUT",
                    "/command/voice-state",
                    {
                        "status": "listening" if listening else ("paused" if self.paused.is_set() else "offline"),
                        "mode": "wake_word",
                        "listening": listening,
                    },
                )
                control = state.get("pendingControl") if isinstance(state, dict) else None
                if control == "pause":
                    self.paused.set()
                    backend_json(
                        "PUT",
                        "/command/voice-state",
                        {"status": "paused", "mode": "wake_word", "listening": False, "ack_control": "pause"},
                    )
                    log("v2 wake listening paused by acknowledged control")
                elif control == "resume":
                    self.paused.clear()
                    backend_json(
                        "PUT",
                        "/command/voice-state",
                        {
                            "status": "listening" if self.audio_ready.is_set() else "offline",
                            "mode": "wake_word",
                            "listening": self.audio_ready.is_set(),
                            "ack_control": "resume",
                        },
                    )
                    log("v2 wake listening resumed by acknowledged control")
                elif control == "end_conversation":
                    # There is no active conversation in wake mode. Consume a
                    # stale/repeated end request once so it cannot terminate
                    # every future session immediately after activation.
                    backend_json(
                        "PUT",
                        "/command/voice-state",
                        {
                            "status": "listening" if listening else ("paused" if self.paused.is_set() else "offline"),
                            "mode": "wake_word",
                            "listening": listening,
                            "ack_control": "end_conversation",
                        },
                    )
                    log("v2 stale end-conversation control acknowledged in wake mode")
            except Exception as exc:
                log(f"v2 wake state error: {type(exc).__name__}: {str(exc)[:240]}")
            self.stop_event.wait(1.0)


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


def picovoice_wake_settings(config: dict[str, Any]) -> tuple[str, str, float, str]:
    wake = config["wake"]
    access_key_env = str(wake.get("accessKeyEnv") or "PICOVOICE_ACCESS_KEY").strip()
    raw_keyword_path = os.path.expandvars(str(wake.get("keywordPath") or "").strip())
    keyword_path = Path(raw_keyword_path).expanduser() if raw_keyword_path else Path()
    device_name = str(wake.get("deviceName") or "").strip()
    try:
        sensitivity = float(wake.get("sensitivity", 0.65))
    except (TypeError, ValueError) as exc:
        raise RuntimeError("PICOVOICE_SENSITIVITY_INVALID") from exc
    if not access_key_env:
        raise RuntimeError("PICOVOICE_ACCESS_KEY_ENV_INVALID")
    if not 0.0 <= sensitivity <= 1.0:
        raise RuntimeError("PICOVOICE_SENSITIVITY_INVALID")
    return access_key_env, str(keyword_path) if raw_keyword_path else "", sensitivity, device_name


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
        accepted.update({"emmo", "ema"})
    return any(f" {candidate} " in f" {heard} " for candidate in accepted)


def consonant_skeleton(word: str) -> str:
    """The word without vowels: what survives a small model mishearing it."""
    return "".join(character for character in word if character.isalpha() and character not in "aeiouy")


def similar_wake_token(heard: str, expected: str) -> bool:
    if not heard or not expected:
        return False
    if heard == expected:
        return True
    if heard.startswith(expected[:2]) or expected.startswith(heard[:2]):
        return True
    # One edit apart: "ema" for "emma", "emo" for "emma".
    if abs(len(heard) - len(expected)) <= 1:
        shorter, longer = sorted((heard, expected), key=len)
        if any(longer[:index] + longer[index + 1:] == shorter for index in range(len(longer))):
            return True
    # Same consonants in the same order: "mmo" for "emma", measured on this
    # hardware. Vowels are what a small model loses first.
    skeleton = consonant_skeleton(expected)
    return bool(skeleton) and consonant_skeleton(heard) == skeleton


def wake_word_plausible(transcript: str, wake_word: str) -> bool:
    """Could this local transcript be the wake word, allowing for a small model?

    Whisper-base writes "Emma" as "MMO", "Ema" or "Emo" — measured on this
    hardware. Porcupine has already matched the acoustic keyword; the local
    verifier exists only to catch a transcript that is clearly *other* speech,
    so it compares loosely and gives the benefit of the doubt.
    """
    phrase = folded_text(wake_word)
    heard = folded_text(transcript)
    if not phrase or not heard:
        return True
    if contains_wake_word(transcript, wake_word):
        return True
    # Only the opening of the utterance can be the wake word; a similar sound
    # later in a sentence is ordinary speech.
    opening = heard.split()[:2]
    return any(
        similar_wake_token(spoken, expected)
        for spoken in opening
        for expected in phrase.split()
    )


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


def pcm_levels(raw: bytes) -> tuple[float, int]:
    samples = array("h")
    samples.frombytes(raw[: len(raw) - (len(raw) % SAMPLE_WIDTH)])
    if not samples:
        return 0.0, 0
    energy = sum(int(sample) * int(sample) for sample in samples)
    return (energy / len(samples)) ** 0.5, max(abs(int(sample)) for sample in samples)


def upsample_pcm16_2x(raw: bytes) -> bytes:
    """Convert ElevenLabs 24 kHz PCM to native 48 kHz Windows PCM.

    Linear interpolation avoids delegating sample-rate conversion to the old
    MME compatibility layer used by the default HDMI/TV endpoint.
    """
    samples = array("h")
    samples.frombytes(raw[: len(raw) - (len(raw) % SAMPLE_WIDTH)])
    if not samples:
        return b""
    output = array("h", [0]) * (len(samples) * 2)
    for index, sample in enumerate(samples):
        output[index * 2] = sample
        if index + 1 < len(samples):
            output[index * 2 + 1] = (int(sample) + int(samples[index + 1])) // 2
        else:
            output[index * 2 + 1] = sample
    return output.tobytes()


def preferred_windows_output(
    audio: pyaudio.PyAudio,
    config: dict[str, Any],
) -> tuple[int, int | None, str]:
    """Use the current Windows WASAPI endpoint at its native 48 kHz rate."""
    requested = str((config.get("tts") or {}).get("deviceName") or "").strip().lower()
    try:
        host = audio.get_host_api_info_by_type(pyaudio.paWASAPI)
        candidate_indices: list[int] = []
        if requested:
            for index in range(audio.get_device_count()):
                device = audio.get_device_info_by_index(index)
                if (
                    int(device.get("hostApi") or -1) == int(host["index"])
                    and int(device.get("maxOutputChannels") or 0) >= CHANNELS
                    and requested in str(device.get("name") or "").lower()
                ):
                    candidate_indices.append(index)
        candidate_indices.append(int(host["defaultOutputDevice"]))
        for device_index in dict.fromkeys(candidate_indices):
            device = audio.get_device_info_by_index(device_index)
            try:
                audio.is_format_supported(
                    NATIVE_WINDOWS_OUTPUT_RATE,
                    output_device=device_index,
                    output_channels=CHANNELS,
                    output_format=pyaudio.paInt16,
                )
                return NATIVE_WINDOWS_OUTPUT_RATE, device_index, str(device.get("name") or "WASAPI")
            except Exception:
                continue
        raise RuntimeError("NO_COMPATIBLE_WASAPI_OUTPUT")
    except Exception:
        try:
            device = audio.get_default_output_device_info()
            return RATE, None, str(device.get("name") or "default")
        except Exception:
            return RATE, None, "default"


def preferred_windows_input(
    audio: pyaudio.PyAudio,
    config: dict[str, Any],
    sample_rate: int,
) -> tuple[int | None, str]:
    """Keep wake detection and the active conversation on one microphone."""
    requested = str((config.get("wake") or {}).get("deviceName") or "").strip().lower()
    candidates: list[tuple[int, str]] = []
    for index in range(audio.get_device_count()):
        try:
            device = audio.get_device_info_by_index(index)
            if int(device.get("maxInputChannels") or 0) < 1:
                continue
            name = str(device.get("name") or "")
            if requested and requested not in name.lower():
                continue
            candidates.append((index, name))
        except Exception:
            continue
    for index, name in candidates:
        try:
            audio.is_format_supported(
                sample_rate,
                input_device=index,
                input_channels=CHANNELS,
                input_format=pyaudio.paInt16,
            )
            return index, name
        except Exception:
            continue
    if requested:
        raise RuntimeError(f"CONFIGURED_MICROPHONE_UNAVAILABLE: {requested}")
    try:
        default = audio.get_default_input_device_info()
        return int(default["index"]), str(default.get("name") or "Windows default")
    except Exception:
        return None, "Windows default"


def barge_in_thresholds(output_rms: float, output_peak: int) -> tuple[float, int]:
    """Port the proven v1 near-end policy to Voice v2."""
    required_rms = max(
        BARGE_IN_MIN_RMS,
        min(BARGE_IN_MAX_DYNAMIC_RMS, output_rms * BARGE_IN_OUTPUT_RMS_RATIO),
    )
    required_peak = max(
        BARGE_IN_MIN_PEAK,
        min(BARGE_IN_MAX_DYNAMIC_PEAK, int(output_peak * BARGE_IN_OUTPUT_PEAK_RATIO)),
    )
    return required_rms, required_peak


def playback_buffer_self_test() -> bool:
    buffer = PcmPlaybackBuffer(frame_bytes=8, prebuffer_bytes=24)
    buffer.append(b"a" * 24)
    if buffer.take_frame() != b"a" * 8:
        return False
    buffer.rebuffer()
    if buffer.take_frame() is not None:
        return False
    buffer.append(b"b" * 8)
    if buffer.take_frame() != b"a" * 8:
        return False
    buffer.finish()
    return buffer.take_frame() == b"a" * 8 and buffer.take_frame() == b"b" * 8 and buffer.drained


# --- Implausible transcripts -------------------------------------------------
#
# Whisper and every cloud recogniser answer *something* for any audio, and what
# they answer for a fan, a keyboard or a door is stock filler: a bracketed
# sound tag, a subtitle credit, or a stray full stop.  None of it was ever
# spoken, so none of it may reach the command parser.  The check is a fixed
# list plus three shape rules, never a guess about meaning.

IMPLAUSIBLE_TRANSCRIPTS = {
    "titulky vytvoril johnyx",
    "titulky vytvoril jirka kovac",
    "titulky vytvorila komunita amara org",
    "preklad a titulky",
    "dekuji za pozornost",
    "konec",
    "pokracovani priste",
    "subtitles by the amara org community",
    "thanks for watching",
    "thank you for watching",
    "you",
    "bye",
}

# A bracketed tag is Whisper describing a sound, never a spoken command:
# [hudba], (music), *cough*, [MUZIĘ].
BRACKETED_SOUND_TAG = re.compile(r"^[\[\(\*][^\]\)\*]{0,40}[\]\)\*][\s.!?]*$")

#: Confirmations and interruptions: short, fixed words in every supported
#: language. The local model transcribes these reliably even when it garbles a
#: full sentence, and they are the words that dominate a conversation, so
#: handling them on the NPU is what makes Emma feel instant.
LOCAL_DECISION_WORDS = {
    "ano", "ne", "jo", "potvrd", "potvrzuji", "zrus", "zrusit", "stop", "prestan", "konec",
    "yes", "no", "confirm", "confirmed", "cancel", "stop", "abort",
    "tak", "nie", "potwierdzam", "anuluj", "przestan",
    "oui", "non", "confirme", "annule", "arrete",
    "ja", "nein", "bestatige", "abbrechen", "halt",
    "si", "confirmo", "cancela", "para",
    "conferma", "annulla", "ferma",
}

#: Local Whisper below this mean token probability is not trusted on its own.
#: Measured on this hardware: real speech scores 0.64-0.73, keyboard noise 0.28.
LOCAL_CONFIDENCE_FLOOR = 0.45


def local_result_is_actionable(text: str, confidence: float) -> bool:
    """May this local transcript be acted on without the accurate model?

    Only for a short confirmation or interruption, and only when the model was
    sure. Whisper-base transcribes "ano" and "stop" dependably; it garbles a
    full Czech sentence ("ukaž klienty" came back as "ukáš klienty"), and a
    garbled command is worse than a slightly slower accurate one.
    """
    if confidence < LOCAL_CONFIDENCE_FLOOR:
        return False
    words = folded_text(text).split()
    if not words or len(words) > 2:
        return False
    return all(word in LOCAL_DECISION_WORDS for word in words)


def folded_text(value: str) -> str:
    """Lower-case, punctuation-free and without diacritics, for fixed matching."""
    normalized = normalized_text(value)
    return "".join(
        character
        for character in unicodedata.normalize("NFKD", normalized)
        if not unicodedata.combining(character)
    )


def implausible_transcript(text: str) -> str:
    """Return the reason this text cannot be a spoken command, or ""."""
    stripped = text.strip()
    if not stripped:
        return "EMPTY"
    if BRACKETED_SOUND_TAG.match(stripped):
        return "SOUND_TAG"
    normalized = normalized_text(stripped)
    if not normalized:
        return "PUNCTUATION_ONLY"
    # Compared without diacritics, because the same invented credit comes back
    # as "vytvořil" or "vytvoril" depending on the recogniser and the language.
    if folded_text(stripped) in IMPLAUSIBLE_TRANSCRIPTS:
        return "KNOWN_HALLUCINATION"
    words = normalized.split()
    # A single letter or syllable is what the decoder emits when it has nothing.
    if len(normalized) < 3 and len(words) <= 1:
        return "TOO_SHORT"
    # "ano ano ano ano ano" is a decode loop, not a person speaking.
    if len(words) >= 4 and len(set(words)) == 1:
        return "REPETITION_LOOP"
    return ""


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


def is_explicit_stop(heard: str, language: str) -> bool:
    normalized = normalized_text(heard)
    phrases = {
        "cs": {"stop", "přestaň", "ticho", "nemluv"},
        "pl": {"stop", "przestań", "cisza", "nie mów"},
        "fr": {"stop", "arrête", "silence", "tais toi"},
        "de": {"stopp", "hör auf", "ruhe", "sei still"},
        "es": {"para", "detente", "silencio", "callate"},
        "it": {"stop", "fermati", "silenzio", "stai zitta"},
        "en": {"stop", "be quiet", "silence", "stop talking"},
    }
    locale = language.split("-", 1)[0].lower()
    return normalized in phrases.get(locale, phrases["en"])


def bounded_spoken_response(message: str, language: str) -> tuple[str, bool]:
    """Keep the full response on screen while making speech safely bounded."""
    value = message.strip()
    if len(value) <= MAX_SPOKEN_RESPONSE_CHARS:
        return value, False
    boundary = max(
        value.rfind(". ", 0, MAX_SPOKEN_RESPONSE_CHARS),
        value.rfind("! ", 0, MAX_SPOKEN_RESPONSE_CHARS),
        value.rfind("? ", 0, MAX_SPOKEN_RESPONSE_CHARS),
        value.rfind("\n", 0, MAX_SPOKEN_RESPONSE_CHARS),
    )
    if boundary < MAX_SPOKEN_RESPONSE_CHARS // 2:
        boundary = MAX_SPOKEN_RESPONSE_CHARS
    else:
        boundary += 1
    suffixes = {
        "cs": " Zbytek je zobrazený na obrazovce. Řekněte pokračuj a přečtu další část.",
        "pl": " Reszta jest widoczna na ekranie. Powiedz kontynuuj, a przeczytam kolejną część.",
        "fr": " La suite est affichée à l’écran. Dites continue pour entendre la partie suivante.",
        "de": " Der Rest wird auf dem Bildschirm angezeigt. Sagen Sie weiter für den nächsten Teil.",
        "es": " El resto aparece en pantalla. Diga continúa para escuchar la parte siguiente.",
        "it": " Il resto è visualizzato sullo schermo. Dica continua per ascoltare la parte successiva.",
        "en": " The rest is shown on screen. Say continue to hear the next part.",
    }
    locale = language.split("-", 1)[0].lower()
    return value[:boundary].rstrip() + suffixes.get(locale, suffixes["en"]), True


def classify_playback_transcript(
    heard: str,
    assistant: str,
    language: str,
    wake_word: str,
    speaking: bool,
    echo_guard: bool,
) -> tuple[str, str]:
    """Decide whether microphone text may become a user turn.

    Keeping this decision independent from audio and network code makes the
    anti-self-reply guarantee deterministic and directly testable.
    """
    if speaking:
        if is_explicit_stop(heard, language):
            return "stop", ""
        if looks_like_self_echo(heard, assistant):
            return "ignore", ""
        if not contains_wake_word(heard, wake_word):
            return "ignore", ""
        command = wake_command_tail(heard, wake_word)
        return ("command", command) if command else ("wake_only", "")
    if echo_guard and not contains_wake_word(heard, wake_word):
        return "ignore", ""
    return "normal", heard


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
        and len(upsample_pcm16_2x(b"\x00\x00\xe8\x03")) == 8
        and barge_in_thresholds(0, 0) == (750.0, 2_400)
        and barge_in_thresholds(5_000, 16_000) == (1_100.0, 3_200)
        and playback_buffer_self_test()
        and "".join(ElevenLabsPcmTts.chunks("a" * 7_001)) == "a" * 7_001
        and stream_timing_settings(defaults) == (250, 1_000)
        and companion_is_running(os.getpid())
        and looks_like_self_echo("hello there", "Hello there, how can I help?")
        and not looks_like_self_echo("stop now", "Hello there, how can I help?")
        and is_explicit_stop("Přestaň", "cs-CZ")
        and classify_playback_transcript(
            "Né, a nezapisé vytči.",
            "Kontakt jsem vytvořila.",
            "cs-CZ",
            "Emma",
            True,
            False,
        ) == ("ignore", "")
        and classify_playback_transcript(
            "Emma, otevři kontakty",
            "Otevírám kalendář.",
            "cs-CZ",
            "Emma",
            True,
            False,
        ) == ("command", "otevři kontakty")
        and classify_playback_transcript(
            "přestaň", "Dlouhá odpověď", "cs-CZ", "Emma", True, False
        ) == ("stop", "")
        and classify_playback_transcript(
            "doznívající ozvěna", "Dlouhá odpověď", "cs-CZ", "Emma", False, True
        ) == ("ignore", "")
        and classify_playback_transcript(
            "otevři kontakty", "", "cs-CZ", "Emma", False, False
        ) == ("normal", "otevři kontakty")
        and bounded_spoken_response("Krátká odpověď.", "cs-CZ") == ("Krátká odpověď.", False)
        and bounded_spoken_response("A" * 1_000, "cs-CZ")[1]
        and len(bounded_spoken_response("A" * 1_000, "cs-CZ")[0]) < 1_000
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
        picovoice_key_env, picovoice_keyword_path, _, picovoice_device_name = picovoice_wake_settings(config)
        picovoice_error = ""
    except RuntimeError as exc:
        picovoice_key_env, picovoice_keyword_path, picovoice_device_name, picovoice_error = "", "", "", str(exc)
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
            "microphone": picovoice_device_name or "Windows default",
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
            "provider": "elevenlabs",
            "apiKeyPresent": bool(environment_value(str(tts["apiKeyEnv"]))),
            "voiceIdPresent": configured_value(tts.get("voiceId")),
            "model": tts["model"],
            "outputFormat": tts["outputFormat"],
        },
        "openaiTtsFallback": {
            "provider": str(tts.get("fallbackProvider") or "openai"),
            "apiKeyPresent": bool(environment_value(str(tts.get("fallbackApiKeyEnv") or "OPENAI_API_KEY"))),
            "model": str(tts.get("fallbackModel") or "tts-1"),
            "voice": str(tts.get("fallbackVoice") or "nova"),
        },
        "speech": {
            "requestedProvider": str(tts.get("provider") or "openai"),
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
        and (
            (configured["elevenlabs"]["apiKeyPresent"] and configured["elevenlabs"]["voiceIdPresent"])
            or configured["openaiTtsFallback"]["apiKeyPresent"]
        )
    )
    return {"runtime": RUNTIME_NAME, "ready": ready, "providers": configured}


class DuplexSpeaker:
    """PCM playback thread that feeds exact far-end audio to WebRTC AEC."""

    def __init__(
        self,
        audio: pyaudio.PyAudio,
        aec: AudioProcessor,
        aec_lock: threading.Lock,
        config: dict[str, Any],
    ):
        self.audio = audio
        self.aec = aec
        self.aec_lock = aec_lock
        self.config = config
        self.queue: queue.Queue[bytes | object] = queue.Queue()
        self.reset = threading.Event()
        self.stop = threading.Event()
        self.active = threading.Event()
        self.finished = threading.Event()
        self.last_output_at = 0.0
        self.recent_output_rms = 0.0
        self.recent_output_peak = 0
        self.starvation_count = 0
        self.slow_write_count = 0
        self.frames_written = 0
        self.thread: threading.Thread | None = None
        self.stream = None
        self.ready = threading.Event()
        self.worker_error = ""

    def start(self) -> None:
        self.thread = threading.Thread(target=self._worker, name="emma-v2-playback", daemon=True)
        self.thread.start()
        if not self.ready.wait(timeout=4.0):
            raise RuntimeError("AUDIO_OUTPUT_START_TIMEOUT")
        if self.worker_error:
            raise RuntimeError(self.worker_error)

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

    def echo_guard_active(self) -> bool:
        return self.active.is_set() or (
            self.last_output_at > 0
            and time.monotonic() - self.last_output_at < POST_PLAYBACK_ECHO_GUARD_SECONDS
        )

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
        if self.frames_written or self.starvation_count or self.slow_write_count:
            log(
                "v2 playback summary: "
                f"frames={self.frames_written}, starvation={self.starvation_count}, "
                f"slow_writes={self.slow_write_count}"
            )

    def _worker(self) -> None:
        try:
            self._run_worker()
        except Exception as exc:
            self.worker_error = f"AUDIO_OUTPUT_FAILED_{type(exc).__name__}: {str(exc)[:200]}"
            log(f"v2 playback error: {self.worker_error}")
        finally:
            self.ready.set()
            self.active.clear()
            self.finished.set()

    def _run_worker(self) -> None:
        # Keep the Python feeder above ordinary UI/background work. This is a
        # dedicated blocking audio thread, never the application event loop.
        if os.name == "nt":
            try:
                ctypes.windll.kernel32.SetThreadPriority(
                    ctypes.windll.kernel32.GetCurrentThread(),
                    2,  # THREAD_PRIORITY_HIGHEST
                )
            except Exception:
                pass
        output_rate, output_device_index, output_device_name = preferred_windows_output(self.audio, self.config)
        output_multiplier = output_rate // RATE
        self.stream = self.audio.open(
            format=pyaudio.paInt16,
            channels=CHANNELS,
            rate=output_rate,
            output=True,
            output_device_index=output_device_index,
            frames_per_buffer=(PLAYBACK_FRAME_BYTES // SAMPLE_WIDTH) * output_multiplier,
        )
        self.ready.set()
        log(f"v2 playback device: {output_device_name}; rate={output_rate}; api={'WASAPI' if output_device_index is not None else 'default'}")
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
            # Keep filling the jitter buffer while audio is playing.  The old
            # loop only consumed queued network chunks after the current
            # buffer was empty, which made every HTTP chunk boundary capable
            # of becoming an audible gap.
            while True:
                try:
                    queued_item = self.queue.get_nowait()
                except queue.Empty:
                    break
                if queued_item is PLAYBACK_STOP:
                    return
                if queued_item is PLAYBACK_END:
                    buffer.finish()
                elif isinstance(queued_item, bytes):
                    buffer.append(queued_item)
            frame = buffer.take_frame()
            if frame is None:
                try:
                    item = self.queue.get(timeout=0.05)
                except queue.Empty:
                    if buffer.drained:
                        self.active.clear()
                        self.finished.set()
                    elif buffer.started:
                        # A streaming network response may briefly starve. Do
                        # not resume one frame at a time; rebuild the jitter
                        # buffer first so speech remains continuous.
                        self.starvation_count += 1
                        buffer.rebuffer()
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
                # WebRTC AEC accepts exact 10 ms reverse-stream frames even
                # though Windows receives a more stable 40 ms device write.
                for offset in range(0, len(frame), AEC_FRAME_BYTES):
                    aec_frame = frame[offset:offset + AEC_FRAME_BYTES]
                    if len(aec_frame) == AEC_FRAME_BYTES:
                        self.aec.process_reverse_stream(aec_frame)
                rms, peak = pcm_levels(frame)
                self.recent_output_rms = (self.recent_output_rms * 0.80) + (rms * 0.20)
                self.recent_output_peak = max(int(self.recent_output_peak * 0.85), peak)
            write_started = time.monotonic()
            device_frame = upsample_pcm16_2x(frame) if output_multiplier == 2 else frame
            self.stream.write(device_frame, exception_on_underflow=False)
            write_elapsed = time.monotonic() - write_started
            if write_elapsed > (PLAYBACK_DEVICE_FRAME_MS / 1_000) * 2.5:
                self.slow_write_count += 1
            self.frames_written += 1
            self.last_output_at = time.monotonic()


class ElevenLabsPcmTts:
    def __init__(self, config: dict[str, Any]):
        self.api_key = environment_value(str(config["apiKeyEnv"]))
        self.voice_id = str(config["voiceId"]).strip()
        self.model = str(config["model"]).strip()
        self.output_format = str(config["outputFormat"]).strip()

    @staticmethod
    def chunks(text: str, limit: int = 3_500) -> list[str]:
        remaining = text.strip()
        result: list[str] = []
        while len(remaining) > limit:
            split_at = max(
                remaining.rfind(". ", 0, limit),
                remaining.rfind("! ", 0, limit),
                remaining.rfind("? ", 0, limit),
                remaining.rfind("\n", 0, limit),
                remaining.rfind(" ", 0, limit),
            )
            if split_at < limit // 2:
                split_at = limit
            else:
                split_at += 1
            result.append(remaining[:split_at].strip())
            remaining = remaining[split_at:].strip()
        if remaining:
            result.append(remaining)
        return result

    def stream(self, text: str, language: str, speaker: DuplexSpeaker, generation: int, current_generation: callable) -> None:
        if not self.api_key or not self.voice_id:
            raise RuntimeError("ELEVENLABS_NOT_CONFIGURED")
        request_started = time.monotonic()
        first_audio_logged = False
        rendered_audio = bytearray()
        audio_limit_reached = False
        query = urlencode({"output_format": self.output_format, "enable_logging": "false"})
        for text_chunk in self.chunks(text):
            if current_generation() != generation:
                return
            request = urllib.request.Request(
                f"https://api.elevenlabs.io/v1/text-to-speech/{self.voice_id}/stream?{query}",
                data=json.dumps({
                    "text": text_chunk,
                    "model_id": self.model,
                    "language_code": language.split("-", 1)[0].lower(),
                }).encode("utf-8"),
                method="POST",
                headers={"xi-api-key": self.api_key, "Content-Type": "application/json", "Accept": "audio/pcm"},
            )
            with urllib.request.urlopen(request, timeout=15) as response:
                read_available = getattr(response, "read1", response.read)
                while current_generation() == generation:
                    # `HTTPResponse.read(n)` may wait for all n bytes. `read1`
                    # returns currently available PCM sooner and lets the
                    # playback thread maintain a continuous jitter buffer.
                    chunk = read_available(PLAYBACK_FRAME_BYTES * 8)
                    if not chunk:
                        break
                    if not first_audio_logged:
                        first_audio_logged = True
                        log(f"v2 TTS first PCM received in {int((time.monotonic() - request_started) * 1_000)}ms")
                    remaining = MAX_TTS_PCM_BYTES - len(rendered_audio)
                    if remaining <= 0:
                        audio_limit_reached = True
                        break
                    rendered_audio.extend(chunk[:remaining])
                    if len(chunk) > remaining or len(rendered_audio) >= MAX_TTS_PCM_BYTES:
                        audio_limit_reached = True
                        break
            if audio_limit_reached:
                log(f"v2 TTS provider output capped at {MAX_TTS_AUDIO_SECONDS}s")
                break
        if current_generation() == generation:
            if not rendered_audio:
                raise RuntimeError("ELEVENLABS_EMPTY_AUDIO")
            # ElevenLabs returns several seconds of PCM in a few hundred
            # milliseconds. Queue it as one continuous buffer so network and
            # Python scheduling cannot create audible boundaries.
            speaker.enqueue(bytes(rendered_audio))
            speaker.finish()
            log(
                "v2 TTS ready for uninterrupted playback in "
                f"{int((time.monotonic() - request_started) * 1_000)}ms; bytes={len(rendered_audio)}"
            )


class OpenAIPcmTts:
    """24 kHz PCM fallback using the OpenAI Audio Speech endpoint."""

    def __init__(self, config: dict[str, Any]):
        self.api_key = environment_value(str(config.get("fallbackApiKeyEnv") or "OPENAI_API_KEY"))
        self.model = str(config.get("fallbackModel") or "tts-1").strip()
        self.voice = str(config.get("fallbackVoice") or "nova").strip()

    def stream(self, text: str, language: str, speaker: DuplexSpeaker, generation: int, current_generation: callable) -> None:
        if not self.api_key:
            raise RuntimeError("OPENAI_TTS_NOT_CONFIGURED")
        request_started = time.monotonic()
        request = urllib.request.Request(
            "https://api.openai.com/v1/audio/speech",
            data=json.dumps({
                "model": self.model,
                "voice": self.voice,
                "input": text,
                "response_format": "pcm",
            }).encode("utf-8"),
            method="POST",
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
                "Accept": "application/octet-stream",
            },
        )
        rendered_audio = bytearray()
        with urllib.request.urlopen(request, timeout=30) as response:
            read_available = getattr(response, "read1", response.read)
            while current_generation() == generation:
                chunk = read_available(PLAYBACK_FRAME_BYTES * 8)
                if not chunk:
                    break
                remaining = MAX_TTS_PCM_BYTES - len(rendered_audio)
                if remaining <= 0:
                    break
                rendered_audio.extend(chunk[:remaining])
        if current_generation() != generation:
            return
        if not rendered_audio:
            raise RuntimeError("OPENAI_TTS_EMPTY_AUDIO")
        speaker.enqueue(bytes(rendered_audio))
        speaker.finish()
        log(
            "v2 OpenAI TTS fallback ready for uninterrupted playback in "
            f"{int((time.monotonic() - request_started) * 1_000)}ms; bytes={len(rendered_audio)}"
        )


class ResilientPcmTts:
    """Use one speaker pipeline and fail over before any PCM is queued."""

    def __init__(self, config: dict[str, Any]):
        requested = str(config.get("provider") or "elevenlabs").strip().lower()
        if requested == "openai":
            self.primary = OpenAIPcmTts(config)
            self.fallback = ElevenLabsPcmTts(config)
            self.primary_name = "OpenAI"
            self.fallback_name = "ElevenLabs"
        else:
            self.primary = ElevenLabsPcmTts(config)
            self.fallback = OpenAIPcmTts(config)
            self.primary_name = "ElevenLabs"
            self.fallback_name = "OpenAI"

    def stream(self, text: str, language: str, speaker: DuplexSpeaker, generation: int, current_generation: callable) -> None:
        try:
            self.primary.stream(text, language, speaker, generation, current_generation)
            return
        except urllib.error.HTTPError as exc:
            log(f"v2 {self.primary_name} TTS unavailable ({exc.code}); switching to {self.fallback_name}")
        except (OSError, urllib.error.URLError, RuntimeError) as exc:
            log(f"v2 {self.primary_name} TTS unavailable ({type(exc).__name__}); switching to {self.fallback_name}")
        if current_generation() == generation:
            self.fallback.stream(text, language, speaker, generation, current_generation)


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

    def transcribe(
        self, pcm16: bytes, sample_rate: int = RATE, language: str = ""
    ) -> tuple[str, int, float, str]:
        """Return (text, elapsed_ms, confidence, reason).

        ``reason`` is ``NO_SPEECH`` when the sidecar's voice gate answered
        without running the model; ``confidence`` is the mean probability of
        the tokens Whisper chose, so a weak result can be re-checked by the
        accurate provider instead of being executed or silently dropped.
        """
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
            if language:
                request["language"] = language.split("-", 1)[0].lower()
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
                    return (
                        str(response.get("text") or "").strip(),
                        int(response.get("elapsed_ms") or 0),
                        float(response.get("confidence") or 0.0),
                        str(response.get("reason") or ""),
                    )
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
        audio_ready = threading.Event()
        heartbeat = ListeningStateHeartbeat(self.parent_pid, self.stop_file, audio_ready)
        try:
            input_device_index, input_device_name = preferred_windows_input(audio, self.config, RATE)
            stream = audio.open(
                format=pyaudio.paInt16,
                channels=CHANNELS,
                rate=RATE,
                input=True,
                input_device_index=input_device_index,
                frames_per_buffer=INPUT_FRAME_BYTES // SAMPLE_WIDTH,
            )
            # A stream handle alone does not prove that capture is producing
            # frames. Publish listening=true only after the first real frame.
            heartbeat.start()
            write_live_preview(status=localized_runtime_status(language, "waiting", wake_word))
            log(f"v2 Deepgram VAD wake listener started ({language}, {wake_word})")
            pre_roll_frames = max(1, (pre_roll_ms + INPUT_FRAME_MS - 1) // INPUT_FRAME_MS)
            pre_roll: deque[bytes] = deque(maxlen=pre_roll_frames)
            while True:
                if not companion_is_running(self.parent_pid, self.stop_file):
                    return None
                raw = await asyncio.to_thread(stream.read, INPUT_FRAME_BYTES // SAMPLE_WIDTH, False)
                if not audio_ready.is_set():
                    audio_ready.set()
                    log(f"v2 Deepgram microphone audio confirmed: {input_device_name}")
                if heartbeat.paused.is_set():
                    pre_roll.clear()
                    continue
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
            heartbeat.close()
            if stream:
                try:
                    stream.stop_stream()
                    stream.close()
                except Exception:
                    pass
            audio.terminate()


class PicovoiceWakeWord:
    """Fully local, low-latency wake-word detection using a custom .ppn file."""

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
        self.npu_whisper = npu_whisper

    async def verify_detection(self, pcm16: bytes, sample_rate: int, wake_word: str) -> str | None:
        """Reject an acoustically detected false wake when local STT disproves it.

        Empty verification remains accepted because a short isolated wake word
        may be omitted by Whisper. A non-empty, clearly different transcript is
        rejected so ordinary room speech cannot silently start a conversation.
        """
        if not self.npu_whisper:
            return ""
        if not pcm16:
            log("v2 Picovoice wake accepted without verification audio")
            return ""
        try:
            transcript, elapsed_ms, _confidence, reason = await asyncio.to_thread(
                self.npu_whisper.transcribe,
                pcm16,
                sample_rate,
            )
            if reason == "NO_SPEECH":
                # The wake detector fired on something the voice gate does not
                # consider speech at all; treat it as unverified rather than
                # confirmed, exactly as an empty transcript is treated below.
                log("v2 Picovoice wake accepted without speech in verification audio")
                return ""
        except Exception as exc:
            log(f"v2 Picovoice wake accepted after verifier error: {type(exc).__name__}: {str(exc)[:160]}")
            return ""
        if not transcript.strip():
            log(f"v2 Picovoice wake accepted after empty verifier result ({elapsed_ms}ms)")
            return ""
        if wake_word_plausible(transcript, wake_word):
            log(f"v2 Picovoice wake confirmed by NPU in {elapsed_ms}ms")
            return wake_command_tail(transcript, wake_word)
        if _confidence < LOCAL_CONFIDENCE_FLOOR:
            # The local model was unsure about what it heard, so it is in no
            # position to overrule the acoustic detector.
            log(f"v2 Picovoice wake accepted; verifier unsure (confidence {_confidence:.2f})")
            return ""
        log(f"v2 Picovoice false wake rejected by local verifier ({elapsed_ms}ms)")
        return None

    async def wait_with_node(
        self,
        keyword_path: str,
        sensitivity: float,
        wake_word: str,
        device_name: str,
        audio_ready: threading.Event,
        heartbeat: ListeningStateHeartbeat,
    ) -> tuple[str, str]:
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
            device_name,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=environment,
            creationflags=creation_flags,
            limit=256 * 1024,
        )
        audio_report_count = 0
        sidecar_ready = False
        started_at = time.monotonic()
        last_audio_at = started_at
        try:
            while companion_is_running(self.parent_pid, self.stop_file):
                if process.stdout is None:
                    raise RuntimeError("PICOVOICE_NODE_STDOUT_UNAVAILABLE")
                now = time.monotonic()
                if not sidecar_ready and now - started_at > 8.0:
                    raise RuntimeError("PICOVOICE_NODE_START_TIMEOUT")
                if sidecar_ready and now - last_audio_at > 5.0:
                    raise RuntimeError("PICOVOICE_MICROPHONE_STALLED")
                try:
                    raw_line = await asyncio.wait_for(process.stdout.readline(), timeout=1.0)
                except asyncio.TimeoutError:
                    if process.returncode is not None:
                        raise RuntimeError("PICOVOICE_NODE_EXITED")
                    continue
                if not raw_line:
                    # Closed stdout means the sidecar has exited or is exiting.
                    # ``returncode`` stays None until the child is reaped, so
                    # reading it alone turned this into a busy wait: readline
                    # returned end-of-file immediately and forever, the start
                    # timeout above was never reached, and a wake word that
                    # failed to initialise left Emma silent instead of falling
                    # back to Deepgram.
                    try:
                        await asyncio.wait_for(process.wait(), timeout=2.0)
                    except asyncio.TimeoutError:
                        pass
                    error_name = ""
                    if process.stderr is not None:
                        error_name = (await process.stderr.read()).decode("utf-8", errors="replace").strip()[:160]
                    raise RuntimeError(error_name or "PICOVOICE_NODE_EXITED")
                line = raw_line.decode("utf-8", errors="replace").strip()
                if line.startswith("READY"):
                    sidecar_ready = True
                    last_audio_at = time.monotonic()
                    log(f"v2 Picovoice sidecar {line}")
                    continue
                if line.startswith("AUDIO"):
                    last_audio_at = time.monotonic()
                    audio_report_count += 1
                    if not audio_ready.is_set():
                        audio_ready.set()
                        log(f"v2 Picovoice microphone audio confirmed: {line}")
                    elif audio_report_count % 10 == 0:
                        log(f"v2 Picovoice microphone level: {line}")
                    continue
                if line.startswith("DETECTED"):
                    if heartbeat.paused.is_set():
                        log("v2 ignored Picovoice detection while listening is paused")
                        continue
                    encoded_audio = line.partition(" ")[2].strip()
                    try:
                        verification_audio = base64.b64decode(encoded_audio, validate=True) if encoded_audio else b""
                    except ValueError:
                        verification_audio = b""
                    command = await self.verify_detection(verification_audio, 16_000, wake_word)
                    if command is not None:
                        log("v2 Picovoice Node wake word detected and confirmed")
                        return "accepted", command
                    return "rejected", ""
            return "stopped", ""
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
        access_key_env, keyword_path, sensitivity, device_name = picovoice_wake_settings(self.config)
        access_key = environment_value(access_key_env)
        if not access_key:
            raise RuntimeError("PICOVOICE_ACCESS_KEY_NOT_CONFIGURED")
        if not keyword_path or not Path(keyword_path).is_file():
            raise RuntimeError("PICOVOICE_KEYWORD_MODEL_NOT_FOUND")

        audio_ready = threading.Event()
        heartbeat = ListeningStateHeartbeat(self.parent_pid, self.stop_file, audio_ready)
        heartbeat.start()
        write_live_preview(status=localized_runtime_status(language, "waiting", wake_word))
        if node_picovoice_available():
            try:
                while companion_is_running(self.parent_pid, self.stop_file):
                    log(f"v2 Picovoice Node wake listener started ({language}, {wake_word})")
                    result, command = await self.wait_with_node(
                        keyword_path,
                        sensitivity,
                        wake_word,
                        device_name,
                        audio_ready,
                        heartbeat,
                    )
                    if result == "accepted":
                        return command
                    if result == "stopped":
                        return None
                    write_live_preview(status=localized_runtime_status(language, "waiting", wake_word))
                    await asyncio.sleep(0.1)
                return None
            finally:
                heartbeat.close()

        if pvporcupine is None:
            heartbeat.close()
            raise RuntimeError("PICOVOICE_PACKAGE_NOT_INSTALLED")

        porcupine = pvporcupine.create(
            access_key=access_key,
            keyword_paths=[keyword_path],
            sensitivities=[sensitivity],
        )
        audio = pyaudio.PyAudio()
        stream = None
        buffered_frames: deque[bytes] = deque(
            maxlen=max(1, int((porcupine.sample_rate * 2.2) / porcupine.frame_length))
        )
        try:
            input_device_index, input_device_name = preferred_windows_input(
                audio,
                self.config,
                porcupine.sample_rate,
            )
            stream = audio.open(
                format=pyaudio.paInt16,
                channels=CHANNELS,
                rate=porcupine.sample_rate,
                input=True,
                input_device_index=input_device_index,
                frames_per_buffer=porcupine.frame_length,
            )
            audio_ready.set()
            log(
                f"v2 Picovoice wake listener started ({language}, {wake_word}); "
                f"microphone={input_device_name}"
            )
            while companion_is_running(self.parent_pid, self.stop_file):
                raw = await asyncio.to_thread(stream.read, porcupine.frame_length, False)
                if heartbeat.paused.is_set():
                    buffered_frames.clear()
                    continue
                buffered_frames.append(raw)
                samples = array("h")
                samples.frombytes(raw)
                if porcupine.process(samples) >= 0:
                    command = await self.verify_detection(
                        b"".join(buffered_frames), porcupine.sample_rate, wake_word
                    )
                    if command is not None:
                        log("v2 Picovoice wake word detected and confirmed")
                        return command
                    write_live_preview(status=localized_runtime_status(language, "waiting", wake_word))
            return None
        finally:
            heartbeat.close()
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
        self.input_device_index, self.input_device_name = preferred_windows_input(self.audio, config, RATE)
        self.aec_lock = threading.Lock()
        self.aec = AudioProcessor(enable_aec=True, enable_ns=True, ns_level=2, enable_agc=False, enable_vad=False)
        self.aec.set_stream_format(RATE, CHANNELS, RATE, CHANNELS)
        self.aec.set_reverse_stream_format(RATE, CHANNELS)
        self.speaker = DuplexSpeaker(self.audio, self.aec, self.aec_lock, config)
        self.tts = ResilientPcmTts(config["tts"])
        self.transcript = TranscriptStore()
        self.stop = asyncio.Event()
        self.turn_task: asyncio.Task | None = None
        self.generation = 0
        self.last_assistant_text = ""
        self.recent_assistant_texts: deque[str] = deque(maxlen=6)
        self.last_activity = time.monotonic()
        self.input_stream = None
        self.pending_parts: list[str] = []
        self.npu_whisper = npu_whisper
        self.near_end_frames = 0
        self.barge_in_candidate_until = 0.0
        self.barge_in_interrupted_until = 0.0
        self.transcript_tasks: set[asyncio.Task[None]] = set()
        self.completed_normally = False

    def persist_transcript(self, role: str, content: str, source_event_id: str) -> None:
        """Persist text concurrently so storage latency never delays speech."""
        task = asyncio.create_task(self.transcript.append(role, content, source_event_id))
        self.transcript_tasks.add(task)

        def completed(finished: asyncio.Task[None]) -> None:
            self.transcript_tasks.discard(finished)
            try:
                finished.result()
            except asyncio.CancelledError:
                pass
            except Exception as exc:
                log(f"v2 transcript persistence error: {type(exc).__name__}: {str(exc)[:200]}")

        task.add_done_callback(completed)

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

    def admit_microphone_frame(self, processed: bytes) -> bool:
        """Keep Emma's loudspeaker out of STT while preserving true barge-in."""
        if not self.speaker.active.is_set():
            self.near_end_frames = 0
            self.barge_in_candidate_until = 0.0
            return True
        now = time.monotonic()
        candidate_was_active = now < self.barge_in_candidate_until
        required_rms, required_peak = barge_in_thresholds(
            self.speaker.recent_output_rms,
            self.speaker.recent_output_peak,
        )
        longest_run = self.near_end_frames
        consecutive = self.near_end_frames
        complete = len(processed) - (len(processed) % AEC_FRAME_BYTES)
        for offset in range(0, complete, AEC_FRAME_BYTES):
            rms, peak = pcm_levels(processed[offset:offset + AEC_FRAME_BYTES])
            if rms >= required_rms and peak >= required_peak:
                consecutive += 1
                longest_run = max(longest_run, consecutive)
            else:
                consecutive = 0
        self.near_end_frames = consecutive
        if longest_run >= BARGE_IN_CONFIRM_FRAMES:
            self.near_end_frames = 0
            self.barge_in_candidate_until = now + BARGE_IN_CANDIDATE_HOLD_SECONDS
            if not candidate_was_active:
                # Stop output before waiting for STT endpointing. This is the
                # actual barge-in path: the user's first confirmed near-end
                # syllables stop Emma, and the remaining utterance is then
                # transcribed in silence. Incrementing generation also stops
                # the in-flight TTS download from re-enqueueing old speech.
                self.generation += 1
                self.speaker.interrupt()
                self.last_activity = now
                self.barge_in_interrupted_until = now + 4.0
                log(
                    "v2 playback interrupted immediately by near-end speech; "
                    "candidate admitted for transcript validation "
                    f"(rms>={required_rms:.0f}, peak>={required_peak})"
                )
            return True
        return candidate_was_active

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
            input_device_index=self.input_device_index,
            frames_per_buffer=INPUT_FRAME_BYTES // SAMPLE_WIDTH,
        )
        log(f"v2 session microphone: {self.input_device_name}")
        while not self.stop.is_set():
            try:
                raw = await asyncio.to_thread(self.input_stream.read, INPUT_FRAME_BYTES // SAMPLE_WIDTH, False)
                processed = self.process_microphone_audio(raw)
                # Always send the AEC-cleaned near-end stream. While Emma is
                # speaking, transcripts are a control channel only: the
                # classifier accepts an explicit stop or a wake-word-addressed
                # replacement and rejects everything else. Sending silence
                # here made "stop" impossible whenever the energy detector
                # did not fire first.
                self.admit_microphone_frame(processed)
                await ws.send(processed)
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
            input_device_index=self.input_device_index,
            frames_per_buffer=INPUT_FRAME_BYTES // SAMPLE_WIDTH,
        )
        log(f"v2 session microphone: {self.input_device_name}")
        while not self.stop.is_set():
            try:
                raw = await asyncio.to_thread(self.input_stream.read, INPUT_FRAME_BYTES // SAMPLE_WIDTH, False)
                processed = self.process_microphone_audio(raw)
                pre_roll.append(processed)
                if not self.admit_microphone_frame(processed):
                    active_frames = []
                    speech_frames = 0
                    silence_frames = 0
                    continue
                loud = pcm_mean_amplitude(processed) >= threshold
                if not active_frames:
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
                text, elapsed_ms, confidence, reason = await asyncio.to_thread(
                    self.npu_whisper.transcribe,
                    segment,
                    RATE,
                    self.language,
                )
                if reason == "NO_SPEECH":
                    # The voice gate answered without waking the model: the
                    # segment was a door, a fan or a breath.
                    continue
                log(
                    f"v2 NPU transcription completed in {elapsed_ms}ms "
                    f"(confidence {confidence:.2f})"
                )
                rejection = implausible_transcript(text) if text else ""
                if rejection:
                    # A recognised noise artefact must not get a second chance
                    # to become a command through cloud transcription.
                    log(f"v2 local transcript ignored ({rejection})")
                    continue
                if text and local_result_is_actionable(text, confidence):
                    # A confident "ano" or "stop": answer straight from the NPU.
                    await self.handle_transcript(text)
                    continue
                # Anything longer is a real instruction, and the small local
                # model garbles those. The accurate model decides, so the user
                # neither loses the command nor gets a misheard one executed.
                log(f"v2 local transcript verified by accurate STT (confidence {confidence:.2f})")
                verified = await asyncio.to_thread(backend_transcribe_pcm, segment, RATE)
                if verified:
                    await self.handle_transcript(verified)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log(f"v2 NPU transcription error: {type(exc).__name__}: {str(exc)[:300]}")
                try:
                    fallback_text = await asyncio.to_thread(
                        backend_transcribe_pcm,
                        segment,
                        RATE,
                    )
                    log("v2 authenticated STT fallback completed")
                    if fallback_text:
                        await self.handle_transcript(fallback_text)
                except Exception as fallback_exc:
                    # One malformed/noisy segment must not end the entire
                    # conversation. Keep listening for the next utterance.
                    log(
                        "v2 STT fallback error: "
                        f"{type(fallback_exc).__name__}: {str(fallback_exc)[:240]}"
                    )

    async def handle_transcript(self, text: str) -> None:
        heard = text.strip()
        if not heard:
            return
        # Every provider reaches the parser through here, so this is the single
        # place that has to hold: invented filler never becomes a command.
        reason = implausible_transcript(heard)
        if reason:
            log(f"v2 transcript ignored ({reason}): {heard[:60]}")
            return
        self.last_activity = time.monotonic()
        speaking = self.speaker.active.is_set()
        delayed_echo_window = (
            self.speaker.last_output_at > 0
            and time.monotonic() - self.speaker.last_output_at < DELAYED_SELF_ECHO_WINDOW_SECONDS
        )
        if delayed_echo_window and any(
            looks_like_self_echo(heard, assistant)
            for assistant in self.recent_assistant_texts
        ):
            # Streaming STT can finalize room echo several seconds after the
            # speaker stopped. Compare against several previous responses,
            # because a self-reply loop may already have replaced the latest
            # response before that delayed transcript arrives.
            log("v2 ignored delayed transcript matching recent Emma speech")
            return
        wake_word = str(load_config().get("WakeWord") or "Emma")
        barge_in_capture = time.monotonic() < self.barge_in_interrupted_until
        action, command = classify_playback_transcript(
            heard,
            self.last_assistant_text,
            self.language,
            wake_word,
            speaking,
            self.speaker.echo_guard_active() and not barge_in_capture,
        )
        if barge_in_capture:
            self.barge_in_interrupted_until = 0.0
            self.barge_in_candidate_until = 0.0
            self.near_end_frames = 0
            if is_explicit_stop(heard, self.language):
                action, command = "stop", ""
            elif contains_wake_word(heard, wake_word):
                command = wake_command_tail(heard, wake_word)
                action = "command" if command else "wake_only"
            else:
                # Acoustic energy alone cannot distinguish the user from a
                # distorted loudspeaker echo. Only an explicit stop phrase or
                # a wake-word-addressed replacement command is safe here.
                log("v2 ignored non-addressed barge-in transcript")
                self.stop.set()
                return
        if action == "stop":
            self.generation += 1
            self.speaker.interrupt()
            self.last_assistant_text = ""
            log("v2 assistant playback stopped by explicit interruption")
            await self.update_state("listening", True, transcript=heard)
            write_live_preview("user", heard, localized_runtime_status(self.language, "active"))
            self.stop.set()
            return
        if action == "ignore":
            log(
                "v2 ignored microphone transcript during Emma playback/echo guard: "
                + heard[:120]
            )
            return
        if action in {"command", "wake_only"}:
            self.generation += 1
            self.speaker.interrupt()
            heard = command
            log("v2 assistant playback interrupted by wake-word-addressed transcript")
            if not heard:
                self.last_assistant_text = ""
                await self.update_state("listening", True)
                self.stop.set()
                return
        if self.turn_task and not self.turn_task.done():
            self.turn_task.cancel()
        self.turn_task = asyncio.create_task(self.execute_turn(heard))

    async def execute_turn(self, heard: str) -> None:
        generation = self.generation
        # Recognition stays physically available while the command is being
        # resolved, so a newer utterance can replace a slow or mistaken one.
        await self.update_state("thinking", True, transcript=heard)
        self.persist_transcript("user", heard, f"v2-user-{self.transcript.sequence}")
        # Let append update the in-memory ordered history before building the
        # command context, while its network persistence continues in parallel.
        await asyncio.sleep(0)
        write_live_preview("user", heard, localized_runtime_status(self.language, "thinking"))
        business_started = time.monotonic()
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
        finally:
            log(f"v2 business response completed in {int((time.monotonic() - business_started) * 1_000)}ms")
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
            if generation == self.generation:
                self.stop.set()
            return
        self.last_assistant_text = message
        self.recent_assistant_texts.append(message)
        self.persist_transcript("assistant", message, f"v2-assistant-{self.transcript.sequence}")
        write_live_preview("assistant", message, localized_runtime_status(self.language, "speaking"))
        await self.update_state("speaking", True, response=message)
        self.speaker.active.set()
        spoken_message, spoken_was_bounded = bounded_spoken_response(message, self.language)
        if spoken_was_bounded:
            log(
                "v2 spoken response bounded while complete text remains visible: "
                f"full_chars={len(message)}, spoken_chars={len(spoken_message)}"
            )
        try:
            await asyncio.to_thread(self.tts.stream, spoken_message, self.language, self.speaker, generation, self.current_generation)
            while generation == self.generation and not self.speaker.finished.is_set() and not self.stop.is_set():
                await asyncio.sleep(0.03)
            if self.speaker.worker_error:
                raise RuntimeError(self.speaker.worker_error)
        except asyncio.CancelledError:
            raise
        except urllib.error.HTTPError as exc:
            # Provider failures must be distinguishable in the local log
            # without logging credentials or the spoken text.
            log(f"v2 tts HTTP error: {exc.code}")
            self.speaker.interrupt()
        except (OSError, urllib.error.URLError) as exc:
            log(f"v2 tts error: {type(exc).__name__}")
            self.speaker.interrupt()
        except RuntimeError as exc:
            log(f"v2 audio output error: {str(exc)[:240]}")
            self.speaker.interrupt()
        finally:
            if generation == self.generation:
                self.speaker.active.clear()
                self.last_activity = time.monotonic()
                if self.speaker.worker_error:
                    await self.update_state("error", False)
                else:
                    await self.update_state("listening", True)
                # One activation owns exactly one business turn. Returning to
                # the local wake listener here makes delayed room echo unable
                # to become an unaddressed follow-up command.
                self.completed_normally = True
                self.stop.set()

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
                # Stop is the only control accepted from an interim result.
                # This interrupts playback before endpointing while the final
                # transcript is prevented from becoming a second command by
                # the one-shot session stop event.
                if (
                    transcript
                    and not event.get("is_final")
                    and self.speaker.active.is_set()
                    and is_explicit_stop(transcript, self.language)
                ):
                    self.pending_parts.clear()
                    await self.handle_transcript(transcript)
                    continue
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
                control = state.get("pendingControl")
                if control == "end_conversation":
                    await asyncio.to_thread(
                        backend_json,
                        "PUT",
                        "/command/voice-state",
                        {
                            "status": "offline",
                            "mode": "realtime",
                            "listening": False,
                            "ack_control": "end_conversation",
                        },
                    )
                    log("v2 active conversation ended by acknowledged control")
                    self.stop.set()
                    continue
                if control == "pause":
                    # Leave pause pending for the wake listener. It owns the
                    # durable paused state and will acknowledge it immediately
                    # after this active session has closed.
                    self.stop.set()
                    continue
                if control == "resume":
                    await asyncio.to_thread(
                        backend_json,
                        "PUT",
                        "/command/voice-state",
                        {"status": "listening", "mode": "realtime", "listening": True, "ack_control": "resume"},
                    )
            except Exception:
                pass
            idle_seconds = int(self.config["session"]["followUpSeconds"])
            if not self.speaker.active.is_set() and time.monotonic() - self.last_activity > idle_seconds:
                log("v2 follow-up window ended")
                self.stop.set()
                continue
            # The microphone remains available for acoustic barge-in while
            # Emma speaks. `status` describes output; `listening` describes the
            # actual microphone availability.
            await self.update_state("speaking" if self.speaker.active.is_set() else "listening", True)

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
            if self.transcript_tasks:
                try:
                    await asyncio.wait_for(
                        asyncio.gather(*tuple(self.transcript_tasks), return_exceptions=True),
                        timeout=2.0,
                    )
                except asyncio.TimeoutError:
                    for task in tuple(self.transcript_tasks):
                        task.cancel()
            await self.transcript.end("completed" if self.completed_normally else "interrupted")
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
    npu_whisper: NpuWhisperClient | None = None
    npu_candidate: NpuWhisperClient | None = None
    npu_start_task: asyncio.Task[None] | None = None
    # Keep the local NPU as Picovoice's private wake-verification engine even
    # when Deepgram streaming owns high-accuracy command transcription.
    if status["providers"]["npuWhisper"]["runtimePresent"]:
        # Loading the Qualcomm Whisper graph can take tens of seconds on a
        # cold start. Do it in parallel: Porcupine begins listening at once,
        # and a command spoken during warm-up uses the configured Deepgram
        # fallback. Every later session automatically receives the ready NPU.
        npu_candidate = NpuWhisperClient(config)
        npu_start_task = asyncio.create_task(asyncio.to_thread(npu_candidate.start))
    effective_provider = str(status["providers"]["wake"]["effectiveProvider"])
    wake = (
        PicovoiceWakeWord(config, parent_pid, sentinel, npu_whisper)
        if effective_provider == "picovoice_porcupine"
        else DeepgramWakeWord(config, parent_pid, sentinel)
    )

    if npu_start_task and npu_candidate:
        def attach_npu_when_ready(task: asyncio.Task[None]) -> None:
            nonlocal npu_whisper
            try:
                task.result()
            except Exception as exc:
                if not status["providers"]["deepgram"]["apiKeyPresent"]:
                    log(f"v2 NPU Whisper startup failed without STT fallback: {type(exc).__name__}: {str(exc)[:200]}")
                else:
                    log(f"v2 NPU Whisper startup failed; using Deepgram fallback: {type(exc).__name__}: {str(exc)[:200]}")
                return
            npu_whisper = npu_candidate
            if isinstance(wake, PicovoiceWakeWord):
                wake.npu_whisper = npu_whisper

        npu_start_task.add_done_callback(attach_npu_when_ready)
    try:
        while companion_is_running(parent_pid, sentinel):
            try:
                activation_command = await wake.wait()
            except Exception as exc:
                if isinstance(wake, PicovoiceWakeWord):
                    # A malformed/incompatible model or a transient licence
                    # check must not leave the desktop assistant deaf.
                    log(
                        "v2 Picovoice wake failure; using Deepgram fallback: "
                        f"{type(exc).__name__}: {str(exc)[:240]}"
                    )
                    wake = DeepgramWakeWord(config, parent_pid, sentinel)
                    continue
                raise
            if activation_command is None:
                break
            try:
                active_npu = (
                    npu_whisper
                    if status["providers"]["npuWhisper"]["effectiveProvider"] == "npu_whisper"
                    else None
                )
                await VoiceSessionV2(config, parent_pid, sentinel, active_npu).run(activation_command)
            except Exception as exc:
                # A transient network/provider failure returns to the wake
                # listener rather than creating a second process or session.
                log(f"v2 session failure: {type(exc).__name__}: {str(exc)[:300]}")
                await asyncio.sleep(1)
    finally:
        if npu_start_task:
            try:
                await npu_start_task
            except Exception:
                pass
        if npu_candidate:
            await asyncio.to_thread(npu_candidate.close)
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
    result = backend_command_json(
        "POST",
        "/command/assistant",
        {"text": text, "input_method": "voice_transcript", "language": language, "history": []},
    )
    data = result.get("data") if isinstance(result, dict) else None
    selected_language = data.get("voiceLanguage") if isinstance(data, dict) else None
    if selected_language in LANGUAGE_NAMES:
        save_config_language(selected_language)
    return result


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

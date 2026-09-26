"""Alfonzo Voice v2 — Windows voice runtime for VCUF Secretary.

Voice v2 is the only installed Windows listener and it speaks only OpenAI:
OpenAI speech-to-text through the authenticated Secretary backend for both the
wake gate and the command transcript, and OpenAI PCM streaming TTS for the
reply. There is no other speech provider and no provider fallback. Every
business operation still goes through the authenticated, permission-checked
and audited Secretary API.

No microphone audio is written to disk.  Only final transcript text is sent to
Secretary and retained there.  Provider credentials are read from named
environment variables, never from the VCUF config file or source tree.
"""

from __future__ import annotations

import argparse
import asyncio
from array import array
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

try:
    import numpy as np
except ImportError:  # The pure-Python path below still works, only slower.
    np = None

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


DEFAULT_ASSISTANT_NAME = "Alfonzo"
RUNTIME_NAME = f"{DEFAULT_ASSISTANT_NAME} Voice v2"
RATE = 24_000
NATIVE_WINDOWS_OUTPUT_RATE = 48_000
CHANNELS = 1
SAMPLE_WIDTH = 2
INPUT_FRAME_MS = 20
INPUT_FRAME_BYTES = RATE * SAMPLE_WIDTH * INPUT_FRAME_MS // 1_000
# WebRTC AEC consumes exact 10 ms blocks at the selected sample rate. Capture
# runs at 20 ms, split into these 10 ms frames before AEC; the reverse signal
# uses the same frame size.
AEC_FRAME_BYTES = RATE * SAMPLE_WIDTH * 10 // 1_000
# PortAudio's blocking Windows output is not reliable when Python feeds it in
# 10 ms writes.  Keep WebRTC AEC at its required 10 ms cadence, but submit four
# AEC frames to the audio device at once and retain enough network jitter
# buffer to survive normal provider streaming variation.
# 100 ms, not 40: on the HDMI/TV endpoint a 40 ms device buffer left no
# headroom while the microphone thread and echo cancellation share the CPU,
# and every missed write was an audible crackle (26 Sep 2026).
PLAYBACK_DEVICE_FRAME_MS = 100
PLAYBACK_FRAME_BYTES = RATE * SAMPLE_WIDTH * PLAYBACK_DEVICE_FRAME_MS // 1_000
PLAYBACK_PREBUFFER_MS = 500
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
            "provider": "openai_vad",
            "word": DEFAULT_ASSISTANT_NAME,
            "deviceName": "",
            "speechThreshold": 450,
            "preRollMs": 600,
            "silenceMs": 1_100,
            "maxSegmentMs": 8_000,
        },
        "stt": {
            # OpenAI transcription runs in the Secretary backend, which holds
            # OPENAI_API_KEY; this PC sends it gated audio segments only.
            "provider": "openai",
            # Dictated numbers are spoken in groups with real pauses between
            # them. While a number is in flight the voice gate waits this long
            # for the next group instead of the ordinary silence window, and
            # the parts are joined into one command.
            "digitSilenceMs": 2_000,
            "digitJoinMs": 2_000,
            # Local voice gate that cuts the conversation into utterances
            # before each one is sent for transcription.
            "openai": {
                "speechThreshold": 300,
                "preRollMs": 320,
                "silenceMs": 700,
                "minSpeechMs": 180,
                "maxSegmentMs": 15_000,
            },
        },
        "tts": {
            "provider": "openai",
            "apiKeyEnv": "OPENAI_API_KEY",
            "model": "tts-1",
            "voice": "nova",
            "deviceName": "",
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


SINGLE_INSTANCE_MUTEX_NAME = "Local\\VCUBF.Emma.VoiceV2.Runtime"
_single_instance_handle: int | None = None


def acquire_single_instance() -> bool:
    """Hold one named kernel mutex for the life of this runtime process.

    Every launcher path (desktop shortcut re-arm, a manual Run-VoiceV2, an
    orphaned tray wrapper) reaches ``--run`` through here, so a second
    microphone listener cannot start even when the process-list guards race.
    The handle is intentionally never closed: Windows releases it at exit.
    """
    global _single_instance_handle
    if os.name != "nt" or _single_instance_handle is not None:
        return True
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateMutexW.argtypes = (ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p)
    kernel32.CreateMutexW.restype = ctypes.c_void_p
    kernel32.CloseHandle.argtypes = (ctypes.c_void_p,)
    handle = kernel32.CreateMutexW(None, False, SINGLE_INSTANCE_MUTEX_NAME)
    if not handle:
        # Kernel objects unavailable: never block the only listener.
        return True
    error_already_exists = 183
    if ctypes.get_last_error() == error_already_exists:
        kernel32.CloseHandle(handle)
        return False
    _single_instance_handle = handle
    return True


def backend_transcribe_pcm(pcm16: bytes, sample_rate: int, wake_word: str = "") -> str:
    """Transcribe with OpenAI through Secretary's authenticated backend, without writing audio to disk."""
    memory = io.BytesIO()
    with wave.open(memory, "wb") as output:
        output.setnchannels(CHANNELS)
        output.setsampwidth(SAMPLE_WIDTH)
        output.setframerate(sample_rate)
        output.writeframes(pcm16)
    config = load_config()
    query = urlencode({"wake_word": wake_word}) if wake_word else ""
    url = config.get("ServerUrl", "https://backend-production-7952.up.railway.app").rstrip("/") + "/command/transcribe"
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
        # was changed. Transcription receives the exact selected language.
        raise RuntimeError("WAKE_LANGUAGE_INVALID")
    word = str(common.get("WakeWord") or config["wake"].get("word") or DEFAULT_ASSISTANT_NAME).strip()
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
        raise RuntimeError("WAKE_VAD_SETTINGS_INVALID") from exc
    if not 80 <= threshold <= 12_000 or not 100 <= pre_roll_ms <= 2_000 or not 300 <= silence_ms <= 4_000 or not 1_000 <= max_segment_ms <= 15_000:
        raise RuntimeError("WAKE_VAD_SETTINGS_INVALID")
    return threshold, pre_roll_ms, silence_ms, max_segment_ms


def localized_runtime_status(language: str, state: str, wake_word: str = DEFAULT_ASSISTANT_NAME) -> str:
    """Text shown in the private live monitor must follow the active language."""
    locale = language.split("-", 1)[0].lower()
    name_label = wake_word.strip() or DEFAULT_ASSISTANT_NAME
    # The label is the company's own name for the assistant, so these read as
    # a product state rather than a sentence about a person: no adjective or
    # participle here has to agree with the gender of a name chosen later.
    messages = {
        "cs": {"waiting": f"{name_label} Voice v2 čeká na oslovení {wake_word}", "active": f"{name_label} Voice v2 — nyní mluvte", "thinking": f"{name_label} Voice v2 — přemýšlí", "speaking": f"{name_label} Voice v2 — mluví", "ended": f"{name_label} Voice v2 — relace skončila", "stopped": f"{name_label} Voice v2 — zastaveno"},
        "pl": {"waiting": f"{name_label} Voice v2 czeka na słowo {wake_word}", "active": f"{name_label} Voice v2 — mów teraz", "thinking": f"{name_label} Voice v2 — myśli", "speaking": f"{name_label} Voice v2 — mówi", "ended": f"{name_label} Voice v2 — sesja zakończona", "stopped": f"{name_label} Voice v2 — zatrzymano"},
        "fr": {"waiting": f"{name_label} Voice v2 attend le mot {wake_word}", "active": f"{name_label} Voice v2 — parlez maintenant", "thinking": f"{name_label} Voice v2 — réflexion", "speaking": f"{name_label} Voice v2 — réponse en cours", "ended": f"{name_label} Voice v2 — session terminée", "stopped": f"{name_label} Voice v2 — arrêté"},
        "de": {"waiting": f"{name_label} Voice v2 wartet auf {wake_word}", "active": f"{name_label} Voice v2 — sprechen Sie jetzt", "thinking": f"{name_label} Voice v2 — denkt nach", "speaking": f"{name_label} Voice v2 — spricht", "ended": f"{name_label} Voice v2 — Sitzung beendet", "stopped": f"{name_label} Voice v2 — beendet"},
        "es": {"waiting": f"{name_label} Voice v2 espera la palabra {wake_word}", "active": f"{name_label} Voice v2 — hable ahora", "thinking": f"{name_label} Voice v2 — pensando", "speaking": f"{name_label} Voice v2 — hablando", "ended": f"{name_label} Voice v2 — sesión terminada", "stopped": f"{name_label} Voice v2 — detenido"},
        "it": {"waiting": f"{name_label} Voice v2 attende la parola {wake_word}", "active": f"{name_label} Voice v2 — parli ora", "thinking": f"{name_label} Voice v2 — sta pensando", "speaking": f"{name_label} Voice v2 — sta parlando", "ended": f"{name_label} Voice v2 — sessione terminata", "stopped": f"{name_label} Voice v2 — arrestato"},
        "en": {"waiting": f"{name_label} Voice v2 is waiting for {wake_word}", "active": f"{name_label} Voice v2 — speak now", "thinking": f"{name_label} Voice v2 — thinking", "speaking": f"{name_label} Voice v2 — speaking", "ended": f"{name_label} Voice v2 — session ended", "stopped": f"{name_label} Voice v2 — stopped"},
    }
    return messages.get(locale, messages["en"]).get(state, messages["en"].get(state, RUNTIME_NAME))


def normalized_text(value: str) -> str:
    return " ".join("".join(character.lower() if character.isalnum() else " " for character in value).split())


def spoken_fold(value: str) -> str:
    """One spelling for a sound a recogniser writes more than one way.

    The same name comes back written several ways: Alfonzo, Alfonso, Alfonz;
    Emma, Ema. Only the pairs that genuinely collide in Czech, Polish and
    English spelling of one sound are folded here, and a double letter is
    treated as the spelling choice it is. Anything wider would start waking the
    assistant on ordinary words.
    """
    folded = folded_text(value).replace("ph", "f")
    for source, target in (("z", "s"), ("w", "v"), ("y", "i")):
        folded = folded.replace(source, target)
    return re.sub(r"(.)\1+", r"\1", folded)


def same_spoken_word(heard: str, expected: str) -> bool:
    """The same name, allowing for how it was spelled and how it was declined."""
    if not heard or not expected:
        return False
    if heard == expected:
        return True
    # Czech and Polish decline a name when addressing someone — Alfonzo,
    # Alfonze, Alfonzi — so the last letter may differ or be absent, and no
    # more than that. A name of one or two letters has no room for the
    # allowance and does not get it.
    shorter, longer = sorted((heard, expected), key=len)
    if len(longer) - len(shorter) > 1 or len(shorter) < 3:
        return False
    return longer[:-1] == (shorter[:-1] if len(longer) == len(shorter) else shorter)


def wake_word_end(transcript: str, wake_word: str) -> int | None:
    """Where the wake word ends in the transcript, or None if it is not there.

    Tolerance is derived from the configured wake word rather than written out
    for one particular name. Emma had its spellings listed in the source and
    Alfonzo had none, so renaming the assistant left it deaf to everything but
    an exact transcription of its new name — which a speech model produces only
    some of the time.
    """
    expected = [spoken_fold(token) for token in normalized_text(wake_word).split() if token]
    if not expected:
        return None
    words = list(re.finditer(r"\w+", transcript, re.UNICODE))
    folded = [spoken_fold(match.group(0)) for match in words]
    for start in range(len(folded) - len(expected) + 1):
        if all(same_spoken_word(folded[start + offset], word) for offset, word in enumerate(expected)):
            return words[start + len(expected) - 1].end()
    return None


def contains_wake_word(transcript: str, wake_word: str) -> bool:
    return wake_word_end(transcript, wake_word) is not None


def wake_command_tail(transcript: str, wake_word: str) -> str:
    """Keep a command spoken directly after the wake word, if there is one."""
    end = wake_word_end(transcript, wake_word)
    return transcript[end:].lstrip(" ,.:;!?-–—") if end is not None else ""


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
    """Convert 24 kHz PCM to native 48 kHz Windows PCM.

    Linear interpolation avoids delegating sample-rate conversion to the old
    MME compatibility layer used by the default HDMI/TV endpoint.
    """
    usable = raw[: len(raw) - (len(raw) % SAMPLE_WIDTH)]
    if not usable:
        return b""
    if np is not None:
        # Vectorised: the per-sample Python loop cost several milliseconds per
        # frame on this ARM CPU, time the audio device did not have.
        source = np.frombuffer(usable, dtype="<i2").astype(np.int32)
        output_np = np.empty(source.size * 2, dtype=np.int32)
        output_np[0::2] = source
        output_np[1:-1:2] = (source[:-1] + source[1:]) // 2
        output_np[-1] = source[-1]
        return output_np.astype("<i2").tobytes()
    samples = array("h")
    samples.frombytes(usable)
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


# The words that mark a dictated number as a telephone number, in the three
# languages the companion speaks. Digits alone are not enough: "set the price
# to 1500" must not be held back waiting for more digits.
PHONE_CUE_WORDS = frozenset({
    "phone", "telephone", "mobile", "cell", "number",
    "telefon", "telefonu", "telefonni", "telefonniho", "mobil", "cislo", "cislem",
    "numer", "numeru", "komorka", "komorke", "telefoniczny",
})

# Recognisers write dictated digits either as figures or as words.
SPOKEN_DIGITS = frozenset({
    "zero", "oh", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
    "nula", "jedna", "jeden", "dva", "tri", "ctyri", "pet", "sest", "sedm", "osm", "devet",
    "dwa", "trzy", "cztery", "piec", "szesc", "siedem", "osiem", "dziewiec",
})

# A telephone number is at least this many digits in every locale Secretary
# supports, so a shorter trailing run is still being dictated.
COMPLETE_NUMBER_DIGITS = 9


def number_token_digits(token: str) -> int | None:
    """Digits carried by one dictated token, or None when it is not a number."""
    if not token:
        return None
    if token.isdigit():
        return len(token)
    return 1 if token in SPOKEN_DIGITS else None


def trailing_number_digits(text: str) -> int:
    """Digits in the run of number tokens the utterance ends with."""
    total = 0
    for token in reversed(folded_text(text).split()):
        digits = number_token_digits(token)
        if digits is None:
            break
        total += digits
    return total


def dictated_number_incomplete(text: str) -> bool:
    """True when the speaker is still part-way through dictating a number.

    Speakers dictate a telephone number in groups with real pauses between
    them. The voice gate reads such a pause as the end of the utterance, so a
    command that names a telephone number and then stops inside one is held
    back until the remaining digits arrive.
    """
    tokens = folded_text(text).split()
    if not any(token in PHONE_CUE_WORDS for token in tokens):
        return False
    digits = trailing_number_digits(text)
    return 0 < digits < COMPLETE_NUMBER_DIGITS


def continues_dictated_number(text: str) -> bool:
    """True when an utterance is nothing but the rest of a dictated number."""
    tokens = folded_text(text).split()
    if not tokens:
        return False
    return all(number_token_digits(token) is not None for token in tokens)


def joined_dictated_number(held: str, addition: str) -> str:
    """Join two dictated parts of one number without inventing separators."""
    return f"{held.strip()} {addition.strip()}".strip()


def self_test() -> bool:
    defaults = default_v2_config()
    merged = merge_defaults(defaults, {"tts": {"voice": "shimmer"}})
    return (
        merged["tts"]["voice"] == "shimmer"
        and merged["tts"]["provider"] == "openai"
        and merged["tts"]["model"] == "tts-1"
        and merged["stt"]["provider"] == "openai"
        and contains_wake_word("Emmo, otevři kontakty", "Emma")
        and wake_command_tail("Emma, otevři kontakty", "Emma") == "otevři kontakty"
        and contains_wake_word("Emma, otevři kontakty", "Emma")
        # The tolerance is derived from the configured name, not written out for
        # one of them. These are the spellings a speech model actually returns
        # for this name, and the declined forms a Czech speaker actually says.
        and all(
            contains_wake_word(f"{heard}, ukaž klienty", "Alfonzo")
            for heard in ("Alfonzo", "Alfonso", "Alfonz", "Alfons", "Alfonzi", "Alfonze")
        )
        and wake_command_tail("Alfonso ukaž klienty", "Alfonzo") == "ukaž klienty"
        # And ordinary speech still does not wake it.
        and not contains_wake_word("ukaž klienty", "Alfonzo")
        and not contains_wake_word("telefon zvoní", "Alfonzo")
        and not contains_wake_word("pošli to emailem", "Emma")
        and pcm_mean_amplitude(b"\x00\x00\x00\x00") == 0
        and pcm_mean_amplitude(b"\x10\x00\xf0\xff") == 16
        and len(upsample_pcm16_2x(b"\x00\x00\xe8\x03")) == 8
        and barge_in_thresholds(0, 0) == (750.0, 2_400)
        and barge_in_thresholds(5_000, 16_000) == (1_100.0, 3_200)
        and playback_buffer_self_test()
        # A dictated telephone number arrives in groups. A command that stops
        # inside one waits for the rest; a complete number and an ordinary
        # number in a command do not wait at all.
        and dictated_number_incomplete("vytvoř klienta Jan Novák, telefon 724 555")
        and dictated_number_incomplete("create client Jan Novak, phone seven two four")
        and not dictated_number_incomplete("vytvoř klienta Jan Novák, telefon 724 555 111")
        and not dictated_number_incomplete("nastav cenu na 1500")
        and not dictated_number_incomplete("ukaž klienty")
        and continues_dictated_number("555 111")
        and continues_dictated_number("pět pět pět")
        and not continues_dictated_number("otevři kontakty")
        and joined_dictated_number("telefon 724", "555 111") == "telefon 724 555 111"
        and trailing_number_digits("telefon 724 555") == 6
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


WAKE_PROVIDER = "openai_vad"
STT_PROVIDER = "openai"
TTS_PROVIDER = "openai"


def provider_status(config: dict[str, Any]) -> dict[str, Any]:
    """Report what this runtime will use. It only ever uses OpenAI.

    A provider name left in an older voice-v2.json (Picovoice, Deepgram, NPU
    Whisper) is not honoured and not silently swapped for another engine: it is
    reported under ``ignoredProvider`` and the runtime runs on OpenAI anyway.
    """
    stt = config["stt"]
    tts = config["tts"]
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
    requested_wake = str(config["wake"].get("provider") or WAKE_PROVIDER).strip()
    requested_stt = str(stt.get("provider") or STT_PROVIDER).strip()
    requested_tts = str(tts.get("provider") or TTS_PROVIDER).strip()
    wake_ready = bool(wake_word) and not profile_error and not vad_error
    configured = {
        "wake": {
            "provider": WAKE_PROVIDER,
            "requestedProvider": requested_wake,
            "ignoredProvider": "" if requested_wake == WAKE_PROVIDER else requested_wake,
            "effectiveProvider": WAKE_PROVIDER if wake_ready else "",
            "providerConfigured": wake_ready,
            "language": language,
            "wakeWordPresent": bool(wake_word),
            "vadSettingsValid": not vad_error,
            "microphone": str(config["wake"].get("deviceName") or "").strip() or "Windows default",
            "configurationError": profile_error or vad_error,
        },
        "stt": {
            "provider": STT_PROVIDER,
            "requestedProvider": requested_stt,
            "ignoredProvider": "" if requested_stt == STT_PROVIDER else requested_stt,
            "effectiveProvider": STT_PROVIDER,
            # Readiness is decided by the authenticated backend at request
            # time (OPENAI_API_KEY lives there); nothing to verify on this PC.
            "providerConfigured": True,
            "viaBackend": True,
            "endpoint": "/command/transcribe",
        },
        "openaiTts": {
            "provider": TTS_PROVIDER,
            "apiKeyPresent": bool(environment_value("OPENAI_API_KEY")),
            "model": str(tts.get("model") or "tts-1"),
            "voice": str(tts.get("voice") or "nova"),
        },
        "speech": {
            "requestedProvider": requested_tts,
            "ignoredProvider": "" if requested_tts == TTS_PROVIDER else requested_tts,
            "effectiveProvider": TTS_PROVIDER,
        },
    }
    ready = (
        configured["wake"]["providerConfigured"]
        and configured["wake"]["wakeWordPresent"]
        and configured["openaiTts"]["apiKeyPresent"]
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
        self.underflow_count = 0
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
        if self.frames_written or self.starvation_count or self.slow_write_count or self.underflow_count:
            log(
                "v2 playback summary: "
                f"frames={self.frames_written}, starvation={self.starvation_count}, "
                f"slow_writes={self.slow_write_count}, device_underflows={self.underflow_count}"
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
            try:
                # Report underflows instead of hiding them: an underflow is
                # exactly what the listener hears as a crackle.
                self.stream.write(device_frame, exception_on_underflow=True)
            except IOError as exc:
                if exc.errno != getattr(pyaudio, "paOutputUnderflowed", -9980):
                    raise
                self.underflow_count += 1
            write_elapsed = time.monotonic() - write_started
            if write_elapsed > (PLAYBACK_DEVICE_FRAME_MS / 1_000) * 2.5:
                self.slow_write_count += 1
            self.frames_written += 1
            self.last_output_at = time.monotonic()


class OpenAIPcmTts:
    """OpenAI-only 24 kHz PCM speech; failures never switch providers."""

    def __init__(self, config: dict[str, Any]):
        if config.get("provider", "openai") != "openai":
            raise RuntimeError("OPENAI_TTS_REQUIRED")
        self.api_key = environment_value("OPENAI_API_KEY")
        self.model = str(config.get("model") or "tts-1").strip()
        self.voice = str(config.get("voice") or "nova").strip()

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
            "v2 OpenAI TTS ready for uninterrupted playback in "
            f"{int((time.monotonic() - request_started) * 1_000)}ms; bytes={len(rendered_audio)}"
        )


class OpenAIWakeWord:
    """Wake detection by GPT transcription through the authenticated backend.

    The microphone stays local until a cheap amplitude gate opens. The gated
    segment (pre-roll + speech + trailing silence) is transcribed by the
    Secretary backend (OpenAI transcription; the API key never lives on this
    PC) and the wake word is matched in text. No Picovoice, no Deepgram.
    """

    def __init__(self, config: dict[str, Any], parent_pid: int = 0, stop_file: Path | None = None):
        self.config = config
        self.parent_pid = parent_pid
        self.stop_file = stop_file

    async def wait(self) -> str | None:
        language, wake_word = current_wake_profile(self.config)
        threshold, pre_roll_ms, silence_ms, max_segment_ms = wake_vad_settings(self.config)
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
            heartbeat.start()
            write_live_preview(status=localized_runtime_status(language, "waiting", wake_word))
            log(f"v2 OpenAI (GPT) wake listener started ({language}, {wake_word})")
            pre_roll_frames = max(1, (pre_roll_ms + INPUT_FRAME_MS - 1) // INPUT_FRAME_MS)
            silence_frames_required = max(1, (silence_ms + INPUT_FRAME_MS - 1) // INPUT_FRAME_MS)
            max_segment_frames = max(1, max_segment_ms // INPUT_FRAME_MS)
            # 160 ms of energy before a segment is worth one transcription
            # request; a door slam or a cough stays local.
            min_speech_frames = 8
            pre_roll: deque[bytes] = deque(maxlen=pre_roll_frames)
            active: list[bytes] = []
            speech_frames = 0
            silence_frames = 0
            while True:
                if not companion_is_running(self.parent_pid, self.stop_file):
                    return None
                raw = await asyncio.to_thread(stream.read, INPUT_FRAME_BYTES // SAMPLE_WIDTH, False)
                if not audio_ready.is_set():
                    audio_ready.set()
                    log(f"v2 OpenAI wake microphone audio confirmed: {input_device_name}")
                if time.monotonic() - getattr(self, "last_audio_log", 0.0) >= 10.0:
                    self.last_audio_log = time.monotonic()
                    log(f"v2 OpenAI wake microphone audio active: {input_device_name}")
                if heartbeat.paused.is_set():
                    pre_roll.clear()
                    active = []
                    speech_frames = silence_frames = 0
                    continue
                loud = pcm_mean_amplitude(raw) >= threshold
                if not active:
                    pre_roll.append(raw)
                    if loud:
                        active = list(pre_roll)
                        speech_frames = 1
                        silence_frames = 0
                    continue
                active.append(raw)
                if loud:
                    speech_frames += 1
                    silence_frames = 0
                else:
                    silence_frames += 1
                if silence_frames < silence_frames_required and len(active) < max_segment_frames:
                    continue
                segment, active = b"".join(active), []
                pre_roll.clear()
                worth_request = speech_frames >= min_speech_frames
                speech_frames = silence_frames = 0
                if not worth_request:
                    continue
                try:
                    transcript = await asyncio.to_thread(backend_transcribe_pcm, segment, RATE, wake_word)
                except Exception as exc:
                    log(f"v2 OpenAI wake transcription error: {type(exc).__name__}: {str(exc)[:200]}")
                    await asyncio.sleep(0.5)
                    continue
                if not transcript:
                    continue
                # Pre-wake hypotheses stay in the private local monitor only.
                write_live_preview("hypothesis", transcript, localized_runtime_status(language, "waiting", wake_word))
                if contains_wake_word(transcript, wake_word):
                    log("v2 OpenAI wake word detected")
                    return wake_command_tail(transcript, wake_word)
        finally:
            heartbeat.close()
            if stream:
                try:
                    stream.stop_stream()
                    stream.close()
                except Exception:
                    pass
            audio.terminate()


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
        self.tts = OpenAIPcmTts(config["tts"])
        self.transcript = TranscriptStore()
        self.stop = asyncio.Event()
        self.turn_task: asyncio.Task | None = None
        self.generation = 0
        self.last_assistant_text = ""
        self.recent_assistant_texts: deque[str] = deque(maxlen=6)
        self.last_activity = time.monotonic()
        self.input_stream = None
        self.near_end_frames = 0
        # A command that stops part-way through a dictated telephone number is
        # held here until the remaining digits arrive, and the voice gate waits
        # longer for them while it is held.
        self.number_hold_text = ""
        self.number_hold_until = 0.0
        self.number_flush_task: asyncio.Task[None] | None = None
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

    def backend_segmenter_settings(self) -> dict[str, Any]:
        """Local voice-gate timing for OpenAI transcription (stt.openai)."""
        openai = self.config["stt"].get("openai") or {}

        def value(name: str, default: int) -> int:
            try:
                return int(openai.get(name, default))
            except (TypeError, ValueError):
                return default

        return {
            "speechThreshold": value("speechThreshold", 300),
            "preRollMs": value("preRollMs", 320),
            "silenceMs": value("silenceMs", 700),
            "minSpeechMs": value("minSpeechMs", 180),
            "maxSegmentMs": value("maxSegmentMs", 15_000),
        }

    async def backend_microphone_segmenter(self, segments: asyncio.Queue[bytes]) -> None:
        await self.microphone_segmenter(segments, self.backend_segmenter_settings(), "OpenAI")

    async def backend_transcription_receiver(self, segments: asyncio.Queue[bytes]) -> None:
        """Every utterance goes to the backend's OpenAI transcription (GPT STT)."""
        while not self.stop.is_set():
            segment = await segments.get()
            started = time.monotonic()
            try:
                text = await asyncio.to_thread(backend_transcribe_pcm, segment, RATE)
                log(f"v2 OpenAI transcription completed in {int((time.monotonic() - started) * 1_000)}ms")
                if text:
                    await self.handle_transcript(text)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                # One failed request must not end the conversation.
                log(f"v2 OpenAI transcription error: {type(exc).__name__}: {str(exc)[:240]}")

    def digit_timing(self) -> tuple[int, int]:
        """Silence window while a number is in flight, and the join window, in ms."""
        stt = self.config.get("stt") or {}

        def value(name: str, default: int) -> int:
            try:
                parsed = int(stt.get(name, default))
            except (TypeError, ValueError):
                return default
            return parsed if parsed > 0 else default

        return value("digitSilenceMs", 2_000), value("digitJoinMs", 2_000)

    def number_pending(self) -> bool:
        return bool(self.number_hold_text) and time.monotonic() < self.number_hold_until

    def clear_number_hold(self) -> None:
        self.number_hold_text = ""
        self.number_hold_until = 0.0
        task = self.number_flush_task
        self.number_flush_task = None
        if task and not task.done():
            task.cancel()

    def hold_dictated_number(self, heard: str) -> None:
        """Wait for the rest of a number instead of acting on half of one."""
        join_ms = self.digit_timing()[1]
        self.number_hold_text = heard
        self.number_hold_until = time.monotonic() + join_ms / 1_000
        previous = self.number_flush_task
        if previous and not previous.done():
            previous.cancel()
        self.number_flush_task = asyncio.create_task(self.flush_dictated_number(heard, join_ms))
        log(f"v2 waiting {join_ms}ms for the rest of a dictated number")

    async def flush_dictated_number(self, heard: str, join_ms: int) -> None:
        """Run the command as spoken once no further digits arrive."""
        try:
            await asyncio.sleep(join_ms / 1_000)
        except asyncio.CancelledError:
            return
        if self.number_hold_text != heard:
            return
        self.number_hold_text = ""
        self.number_hold_until = 0.0
        self.number_flush_task = None
        log("v2 no further digits arrived; running the command as spoken")
        self.start_turn(heard)

    def start_turn(self, heard: str) -> None:
        if self.turn_task and not self.turn_task.done():
            self.turn_task.cancel()
        self.turn_task = asyncio.create_task(self.execute_turn(heard))

    async def microphone_segmenter(self, segments: asyncio.Queue[bytes], settings: dict[str, Any], label: str) -> None:
        threshold = int(settings["speechThreshold"])
        pre_roll_frames = max(1, int(settings["preRollMs"]) // INPUT_FRAME_MS)
        base_silence_frames = max(1, int(settings["silenceMs"]) // INPUT_FRAME_MS)
        # While a dictated number is still arriving the gate waits longer, so
        # the groups a speaker separates with a pause stay in one segment.
        digit_silence_frames = max(base_silence_frames, self.digit_timing()[0] // INPUT_FRAME_MS)
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
                required_silence = digit_silence_frames if self.number_pending() else base_silence_frames
                reached_end = silence_frames >= required_silence and speech_frames >= min_speech_frames
                reached_limit = len(active_frames) >= max_segment_frames
                if reached_end or reached_limit:
                    await segments.put(b"".join(active_frames))
                    active_frames = []
                    speech_frames = 0
                    silence_frames = 0
                    pre_roll.clear()
            except Exception as exc:
                if not self.stop.is_set():
                    log(f"v2 {label} microphone error: {type(exc).__name__}: {str(exc)[:300]}")
                self.stop.set()

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
        wake_word = str(load_config().get("WakeWord") or DEFAULT_ASSISTANT_NAME)
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
        if self.number_pending():
            if continues_dictated_number(heard):
                heard = joined_dictated_number(self.number_hold_text, heard)
                self.clear_number_hold()
                log("v2 joined the rest of a dictated number onto the held command")
            else:
                # Half a telephone number must never reach a record, so the
                # unfinished command is dropped rather than half-executed.
                log("v2 dropped a command whose dictated number was never finished")
                self.clear_number_hold()
        if dictated_number_incomplete(heard):
            self.hold_dictated_number(heard)
            return
        self.start_turn(heard)

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

    async def run_backend_transport(self, initial_transcript: str, started: float) -> None:
        """Local voice gate + GPT transcription via the authenticated backend."""
        segments: asyncio.Queue[bytes] = asyncio.Queue(maxsize=3)
        sender = asyncio.create_task(self.backend_microphone_segmenter(segments))
        receiver = asyncio.create_task(self.backend_transcription_receiver(segments))
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
            log(f"v2 session started with language {self.language}; stt={STT_PROVIDER}")
            await self.run_backend_transport(initial_transcript, started)
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
            if field in {"apiKeyPresent", "wakeWordPresent"} and value is False
        ]
        if not status["providers"]["wake"]["providerConfigured"]:
            missing.append("wake.providerConfigured")
        raise RuntimeError("VOICE_V2_NOT_CONFIGURED: " + ", ".join(missing))
    sentinel = Path(stop_file).resolve() if stop_file.strip() else None
    for name in ("wake", "stt", "speech"):
        ignored = status["providers"][name].get("ignoredProvider")
        if ignored:
            log(f"v2 {name} provider '{ignored}' in voice-v2.json is not supported and was ignored; using OpenAI")
    wake = OpenAIWakeWord(config, parent_pid, sentinel)
    try:
        while companion_is_running(parent_pid, sentinel):
            activation_command = await wake.wait()
            if activation_command is None:
                break
            try:
                await VoiceSessionV2(config, parent_pid, sentinel).run(activation_command)
            except Exception as exc:
                # A transient network/provider failure returns to the wake
                # listener rather than creating a second process or session.
                log(f"v2 session failure: {type(exc).__name__}: {str(exc)[:300]}")
                await asyncio.sleep(1)
    finally:
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
        if not acquire_single_instance():
            log("v2 runtime already running in this session; second instance exits (code 3)")
            print(json.dumps({"status": "already_running", "runtime": RUNTIME_NAME}))
            return 3
        asyncio.run(run_voice_v2(args.parent_pid, str(args.stop_file)))
        return 0
    parser.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())

"""Emma Voice v2 — provider-based Windows voice runtime for VCUF Secretary.

Voice v2 deliberately runs beside ``emma_realtime.py``.  It never changes the
legacy desktop listener or its shortcut.  When configured, it uses a local
Porcupine wake word, Deepgram Nova-3 streaming STT and ElevenLabs PCM streaming
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
from collections import deque
from dataclasses import dataclass
from difflib import SequenceMatcher
import importlib.util
import json
import os
from pathlib import Path
import queue
import threading
import time
from typing import Any
from urllib.parse import urlencode
import urllib.error
import urllib.request

from aec_audio_processing import AudioProcessor
import pyaudio
import websockets

from emma_realtime import (
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
PLAYBACK_FRAME_BYTES = INPUT_FRAME_BYTES
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
            "provider": "porcupine",
            "accessKeyEnv": "PICOVOICE_ACCESS_KEY",
            "keywordPath": "",
            "modelPath": "",
            "sensitivity": 0.62,
        },
        "stt": {
            "provider": "deepgram",
            "apiKeyEnv": "DEEPGRAM_API_KEY",
            "model": "nova-3",
            "languageMode": "selected",
            "endpointingMs": 250,
            "utteranceEndMs": 900,
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


def language_code(language: str, mode: str) -> str:
    if mode == "auto":
        return "multi"
    return language.split("-", 1)[0].lower() or "en"


def normalized_text(value: str) -> str:
    return " ".join("".join(character.lower() if character.isalnum() else " " for character in value).split())


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
        and looks_like_self_echo("hello there", "Hello there, how can I help?")
        and not looks_like_self_echo("stop now", "Hello there, how can I help?")
    )


def provider_status(config: dict[str, Any]) -> dict[str, Any]:
    wake = config["wake"]
    stt = config["stt"]
    tts = config["tts"]
    porcupine_installed = importlib.util.find_spec("pvporcupine") is not None
    keyword_path = Path(str(wake.get("keywordPath") or "")) if wake.get("keywordPath") else None
    configured = {
        "porcupine": {
            "provider": wake["provider"],
            "packageInstalled": porcupine_installed,
            "accessKeyPresent": bool(environment_value(str(wake["accessKeyEnv"]))),
            "keywordModelPresent": bool(keyword_path and keyword_path.is_file()),
        },
        "deepgram": {
            "provider": stt["provider"],
            "apiKeyPresent": bool(environment_value(str(stt["apiKeyEnv"]))),
            "model": stt["model"],
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
        configured["porcupine"]["packageInstalled"]
        and configured["porcupine"]["accessKeyPresent"]
        and configured["porcupine"]["keywordModelPresent"]
        and configured["deepgram"]["apiKeyPresent"]
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


class PorcupineWakeWord:
    def __init__(self, config: dict[str, Any]):
        self.config = config

    def wait(self) -> None:
        try:
            import pvporcupine  # type: ignore[import-not-found]
        except ModuleNotFoundError as exc:
            raise RuntimeError("PORCUPINE_PACKAGE_MISSING") from exc
        access_key = environment_value(str(self.config["accessKeyEnv"]))
        keyword_path = Path(str(self.config["keywordPath"])).expanduser()
        if not access_key or not keyword_path.is_file():
            raise RuntimeError("PORCUPINE_NOT_CONFIGURED")
        options: dict[str, Any] = {
            "access_key": access_key,
            "keyword_paths": [str(keyword_path)],
            "sensitivities": [float(self.config["sensitivity"])],
        }
        model_path = str(self.config.get("modelPath") or "").strip()
        if model_path:
            options["model_path"] = str(Path(model_path).expanduser())
        detector = pvporcupine.create(**options)
        audio = pyaudio.PyAudio()
        stream = None
        try:
            stream = audio.open(
                format=pyaudio.paInt16,
                channels=1,
                rate=detector.sample_rate,
                input=True,
                frames_per_buffer=detector.frame_length,
            )
            log("v2 local Porcupine wake listener started")
            while True:
                samples = array("h")
                samples.frombytes(stream.read(detector.frame_length, exception_on_overflow=False))
                if detector.process(samples) >= 0:
                    log("v2 local wake word detected")
                    return
        finally:
            if stream:
                stream.stop_stream()
                stream.close()
            audio.terminate()
            detector.delete()


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
            await asyncio.to_thread(
                backend_json,
                "POST",
                f"/command/voice-conversations/{self.conversation_id}/messages",
                {"role": role, "content": value[:8_000], "sequence": self.sequence, "source_event_id": source_event_id[:200]},
            )
        self.sequence += 1

    async def end(self, status: str) -> None:
        if not self.conversation_id:
            return
        identifier, self.conversation_id = self.conversation_id, None
        await asyncio.to_thread(backend_json, "POST", f"/command/voice-conversations/{identifier}/end", {"status": status})


class VoiceSessionV2:
    def __init__(self, config: dict[str, Any]):
        self.config = config
        self.common_config = load_config()
        self.language = str(self.common_config.get("Language", "en-GB"))
        if self.language not in LANGUAGE_NAMES:
            self.language = "en-GB"
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

    def current_generation(self) -> int:
        return self.generation

    def deepgram_url(self) -> str:
        stt = self.config["stt"]
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
            "endpointing": str(stt["endpointingMs"]),
            "utterance_end_ms": str(stt["utteranceEndMs"]),
        }
        return "wss://api.deepgram.com/v1/listen?" + urlencode(query)

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
                complete = len(raw) - (len(raw) % INPUT_FRAME_BYTES)
                processed: list[bytes] = []
                with self.aec_lock:
                    for offset in range(0, complete, INPUT_FRAME_BYTES):
                        processed.append(self.aec.process_stream(raw[offset:offset + INPUT_FRAME_BYTES]))
                if complete < len(raw):
                    processed.append(raw[complete:])
                await ws.send(b"".join(processed))
            except Exception as exc:
                if not self.stop.is_set():
                    log(f"v2 microphone error: {type(exc).__name__}")
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
        await self.transcript.append("user", heard, f"v2-user-{self.transcript.sequence}")
        write_live_preview("user", heard, "Emma Voice v2 is thinking")
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
        selected_language = (result.get("data") or {}).get("voiceLanguage") if isinstance(result, dict) else None
        if selected_language in LANGUAGE_NAMES and selected_language != self.language:
            self.language = selected_language
            save_config_language(selected_language)
            log(f"v2 language changed to {selected_language}")
        message = str((result or {}).get("message") or self.localized_error_message()).strip()
        if not message or generation != self.generation:
            return
        self.last_assistant_text = message
        await self.transcript.append("assistant", message, f"v2-assistant-{self.transcript.sequence}")
        write_live_preview("assistant", message, "Emma Voice v2 is speaking")
        await self.update_state("speaking", True, response=message)
        self.speaker.active.set()
        try:
            await asyncio.to_thread(self.tts.stream, message, self.language, self.speaker, generation, self.current_generation)
            while generation == self.generation and not self.speaker.finished.is_set() and not self.stop.is_set():
                await asyncio.sleep(0.03)
        except asyncio.CancelledError:
            raise
        except (OSError, urllib.error.URLError, urllib.error.HTTPError) as exc:
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
            "en": "I could not reach the Secretary service just now. Please try again.",
        }
        return messages.get(self.language.split("-", 1)[0].lower(), messages["en"])

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
            if self.turn_task and self.turn_task.done():
                try:
                    self.turn_task.result()
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

    async def run(self) -> None:
        api_key = environment_value(str(self.config["stt"]["apiKeyEnv"]))
        if not api_key:
            raise RuntimeError("DEEPGRAM_NOT_CONFIGURED")
        self.speaker.start()
        try:
            await self.transcript.start()
            await self.update_state("listening", True)
            write_live_preview(status="Emma Voice v2 active — speak now")
            started = time.monotonic()
            log(f"v2 session started with language {self.language}")
            async with websockets.connect(
                self.deepgram_url(),
                additional_headers={"Authorization": f"Token {api_key}"},
                max_size=8 * 1024 * 1024,
            ) as ws:
                sender = asyncio.create_task(self.microphone_sender(ws))
                receiver = asyncio.create_task(self.deepgram_receiver(ws))
                heartbeat = asyncio.create_task(self.heartbeat())
                while not self.stop.is_set() and time.monotonic() - started < int(self.config["session"]["maxSeconds"]):
                    await asyncio.sleep(0.1)
                for task in (sender, receiver, heartbeat):
                    task.cancel()
                await asyncio.gather(sender, receiver, heartbeat, return_exceptions=True)
                try:
                    await ws.send(json.dumps({"type": "CloseStream"}))
                except Exception:
                    pass
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
            write_live_preview(status="Emma Voice v2 session ended")
            log("v2 session ended")


async def run_voice_v2() -> None:
    config = load_v2_config()
    status = provider_status(config)
    if not status["ready"]:
        missing = []
        for name, details in status["providers"].items():
            for field, value in details.items():
                if field.endswith("Present") or field == "packageInstalled":
                    if value is False:
                        missing.append(f"{name}.{field}")
        raise RuntimeError("VOICE_V2_NOT_CONFIGURED: " + ", ".join(missing))
    wake = PorcupineWakeWord(config["wake"])
    while True:
        await asyncio.to_thread(wake.wait)
        try:
            await VoiceSessionV2(config).run()
        except Exception as exc:
            # A transient network/provider failure must return to the local wake
            # listener rather than leave a half-open session or require a new
            # desktop launch. The error is visible in the local v2 log only.
            log(f"v2 session failure: {type(exc).__name__}")
            await asyncio.sleep(1)


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
        asyncio.run(run_voice_v2())
        return 0
    parser.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())

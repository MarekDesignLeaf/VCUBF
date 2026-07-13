"""Short-lived OpenAI Realtime audio session for the VCUBF Windows companion.

The local PowerShell companion owns wake-word detection. This process starts only
after activation, obtains an ephemeral OpenAI credential from the authenticated
VCUBF backend, streams PCM audio, supports server VAD/barge-in, and routes every
business operation back through the audited VCUBF command endpoint.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import sys
import time
import urllib.error
import urllib.request

import pyaudio
import websockets

RATE = 24_000
CHUNK = 2_400  # 100 ms PCM16 frames
MAX_SESSION_SECONDS = 180
IDLE_AFTER_RESPONSE_SECONDS = 25

APP_DIR = Path(os.environ["LOCALAPPDATA"]) / "VCUBF" / "Emma"
CONFIG_PATH = APP_DIR / "config.json"
TOKEN_PATH = APP_DIR / "token.bin"
LOG_PATH = APP_DIR / "emma-realtime.log"


class DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]


def log(message: str) -> None:
    APP_DIR.mkdir(parents=True, exist_ok=True)
    with LOG_PATH.open("a", encoding="utf-8") as handle:
        handle.write(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {message}\n")


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
        return json.loads(response.read().decode("utf-8"))


def compact_tool_result(payload: dict) -> str:
    # Tool output may contain real records requested by the user. Limit size to
    # keep the spoken response focused and prevent an accidental huge transfer.
    encoded = json.dumps(payload, ensure_ascii=False, default=str)
    return encoded[:12_000]


def response_text(event: dict) -> str:
    """Extract the assistant transcript from a completed Realtime response."""
    parts: list[str] = []
    for item in (event.get("response") or {}).get("output") or []:
        if item.get("type") != "message":
            continue
        for content in item.get("content") or []:
            text = content.get("transcript") or content.get("text")
            if isinstance(text, str) and text.strip():
                parts.append(text.strip())
    return " ".join(parts)


class RealtimeEmma:
    def __init__(self, initial_command: str):
        self.initial_command = initial_command.strip()
        self.stop = asyncio.Event()
        self.send_lock = asyncio.Lock()
        self.output_queue: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=100)
        self.last_activity = time.monotonic()
        self.response_complete_at: float | None = None
        self.current_response_text = ""
        self.current_status = "listening"
        self.current_listening = True
        self.reported_speaking = False
        self.exit_code = 0
        self.state_lock = asyncio.Lock()
        self.audio = pyaudio.PyAudio()
        self.input_stream = None
        self.output_stream = None
        self.ws = None

    async def send(self, payload: dict) -> None:
        async with self.send_lock:
            await self.ws.send(json.dumps(payload, separators=(",", ":")))

    async def update_state(
        self,
        status: str,
        listening: bool,
        transcript: str = "",
        response: str = "",
        ack_control: str = "",
    ) -> dict:
        self.current_status = status
        self.current_listening = listening
        body = {"status": status, "mode": "realtime", "listening": listening}
        if transcript:
            body["last_transcript"] = transcript[:2000]
        if response:
            body["last_response"] = response[:4000]
        if ack_control:
            body["ack_control"] = ack_control
        try:
            async with self.state_lock:
                return await asyncio.to_thread(backend_json, "PUT", "/command/voice-state", body)
        except Exception as exc:
            log(f"voice state error: {type(exc).__name__}")
            return {}

    async def heartbeat_state(self) -> dict:
        """Refresh liveness without overwriting a newer event state."""
        try:
            async with self.state_lock:
                body = {"status": self.current_status, "mode": "realtime", "listening": self.current_listening}
                return await asyncio.to_thread(backend_json, "PUT", "/command/voice-state", body)
        except Exception as exc:
            log(f"voice heartbeat error: {type(exc).__name__}")
            return {}

    async def configure(self) -> None:
        instructions = """You are Emma, a concise, warm voice assistant for VCUBF Secretary.
Speak naturally in the user's language. Keep normal answers short enough for speech.
For every request involving company records, clients, jobs, leads, tasks, schedules,
communications, quotes, invoices, employees, services, notifications, or any business
operation, call execute_business_request with the user's exact request. Also call it
whenever the user asks where a VCUBF feature is, how to use the program, or needs help
reaching an outcome; the backend owns the current program map and usage instructions.
Repeat backend UI guidance faithfully and never add likely buttons, fields or capabilities.
Never invent business data and never claim an action succeeded before the tool result confirms it.
The backend enforces identity, permissions, ambiguity checks and confirmations.
Never attempt to bypass it. Legal, payment, deletion, publishing, hiring, salary,
invoice-sending and other risky actions must remain in a reviewed confirmation flow.
If interrupted, stop speaking immediately and listen to the new request."""
        await self.send(
            {
                "type": "session.update",
                "session": {
                    "type": "realtime",
                    "instructions": instructions,
                    "output_modalities": ["audio"],
                    "audio": {
                        "input": {
                            "format": {"type": "audio/pcm", "rate": RATE},
                            "transcription": {"model": "gpt-4o-mini-transcribe"},
                            "turn_detection": {
                                "type": "semantic_vad",
                                "eagerness": "medium",
                                "create_response": True,
                                "interrupt_response": True,
                            },
                        },
                        "output": {
                            "format": {"type": "audio/pcm", "rate": RATE},
                            "voice": "marin",
                        },
                    },
                    "tools": [
                        {
                            "type": "function",
                            "name": "execute_business_request",
                            "description": "Read or change VCUBF data, or obtain current program navigation and usage guidance, through the authenticated, permission-checked and audited backend.",
                            "parameters": {
                                "type": "object",
                                "additionalProperties": False,
                                "required": ["request"],
                                "properties": {"request": {"type": "string"}},
                            },
                        }
                    ],
                    "tool_choice": "auto",
                },
            }
        )
        if self.initial_command:
            await self.update_state("thinking", False, transcript=self.initial_command)
            await self.send(
                {
                    "type": "conversation.item.create",
                    "item": {
                        "type": "message",
                        "role": "user",
                        "content": [{"type": "input_text", "text": self.initial_command}],
                    },
                }
            )
            await self.send({"type": "response.create"})
        else:
            await self.update_state("listening", True)

    async def microphone(self) -> None:
        self.input_stream = self.audio.open(
            format=pyaudio.paInt16, channels=1, rate=RATE, input=True, frames_per_buffer=CHUNK
        )
        while not self.stop.is_set():
            try:
                chunk = await asyncio.to_thread(self.input_stream.read, CHUNK, False)
                await self.send({"type": "input_audio_buffer.append", "audio": base64.b64encode(chunk).decode("ascii")})
            except Exception as exc:
                if not self.stop.is_set():
                    log(f"microphone error: {type(exc).__name__}")
                self.stop.set()

    async def playback(self) -> None:
        self.output_stream = self.audio.open(
            format=pyaudio.paInt16, channels=1, rate=RATE, output=True, frames_per_buffer=CHUNK
        )
        while not self.stop.is_set():
            chunk = await self.output_queue.get()
            if chunk is None:
                return
            await asyncio.to_thread(self.output_stream.write, chunk)

    def clear_playback(self) -> None:
        while True:
            try:
                self.output_queue.get_nowait()
            except asyncio.QueueEmpty:
                break

    async def run_tool(self, event: dict) -> None:
        call_id = event.get("call_id")
        await self.update_state("thinking", False)
        try:
            arguments = json.loads(event.get("arguments") or "{}")
            request_text = str(arguments.get("request") or "").strip()
            if not request_text:
                raise ValueError("missing request")
            result = await asyncio.to_thread(
                backend_json,
                "POST",
                "/command/assistant",
                {"text": request_text, "input_method": "voice_transcript", "language": load_config().get("Language", "en-GB"), "history": []},
            )
            output = compact_tool_result(result)
        except Exception as exc:
            log(f"tool error: {type(exc).__name__}")
            output = json.dumps({"ok": False, "message": "The business request could not be completed."})
        await self.send(
            {
                "type": "conversation.item.create",
                "item": {"type": "function_call_output", "call_id": call_id, "output": output},
            }
        )
        await self.send({"type": "response.create"})

    async def receive(self) -> None:
        async for raw in self.ws:
            event = json.loads(raw)
            event_type = event.get("type", "")
            self.last_activity = time.monotonic()
            if event_type in ("response.output_audio.delta", "response.audio.delta"):
                if not self.reported_speaking:
                    self.reported_speaking = True
                    await self.update_state("speaking", True)
                chunk = base64.b64decode(event.get("delta", ""))
                if chunk:
                    await self.output_queue.put(chunk)
            elif event_type in ("response.output_audio_transcript.delta", "response.audio_transcript.delta"):
                self.current_response_text += str(event.get("delta") or "")
                if not self.reported_speaking:
                    self.reported_speaking = True
                    await self.update_state("speaking", True)
            elif event_type in ("response.output_audio_transcript.done", "response.audio_transcript.done"):
                transcript = str(event.get("transcript") or "").strip()
                if transcript:
                    self.current_response_text = transcript
            elif event_type == "input_audio_buffer.speech_started":
                self.clear_playback()
                self.response_complete_at = None
                self.current_response_text = ""
                self.reported_speaking = False
                await self.update_state("hearing", True)
                # Current Realtime sessions interrupt automatically when
                # interrupt_response is true. Cancel is harmless if no response is active.
                try:
                    await self.send({"type": "response.cancel"})
                except Exception:
                    pass
            elif event_type == "response.function_call_arguments.done":
                asyncio.create_task(self.run_tool(event))
            elif event_type == "conversation.item.input_audio_transcription.completed":
                heard = str(event.get("transcript") or "").strip()
                if heard:
                    await self.update_state("thinking", False, transcript=heard)
                normalized = heard.lower().rstrip(".!?")
                if normalized in {"stop", "goodbye", "that's all", "that is all"}:
                    self.stop.set()
            elif event_type == "response.done":
                self.response_complete_at = time.monotonic()
                completed_text = response_text(event) or self.current_response_text.strip()
                output = (event.get("response") or {}).get("output") or []
                if completed_text:
                    await self.update_state("listening", True, response=completed_text)
                elif any(item.get("type") == "function_call" for item in output):
                    await self.update_state("thinking", False)
                else:
                    await self.update_state("listening", True)
                self.current_response_text = ""
                self.reported_speaking = False
            elif event_type == "error":
                error = event.get("error") or {}
                log(f"realtime error: {error.get('code', 'unknown')} {error.get('message', '')[:300]}")

    async def control_watchdog(self) -> None:
        while not self.stop.is_set():
            await asyncio.sleep(2)
            state = await self.heartbeat_state()
            control = str(state.get("pendingControl") or "")
            if control == "pause":
                # PowerShell acknowledges after this process exits so it can
                # atomically return to a genuinely paused wake-word listener.
                self.exit_code = 10
                self.stop.set()
            elif control == "end_conversation":
                await self.update_state("listening", True, ack_control="end_conversation")
                self.stop.set()
            elif control == "resume":
                await self.update_state(self.current_status, self.current_listening, ack_control="resume")

    async def watchdog(self) -> None:
        started = time.monotonic()
        while not self.stop.is_set():
            await asyncio.sleep(1)
            now = time.monotonic()
            if now - started > MAX_SESSION_SECONDS:
                self.stop.set()
            elif self.response_complete_at and now - self.response_complete_at > IDLE_AFTER_RESPONSE_SECONDS:
                self.stop.set()

    async def run(self) -> None:
        session = await asyncio.to_thread(backend_json, "POST", "/command/realtime/session", {})
        secret = session["client_secret"]
        model = session["model"]
        uri = f"wss://api.openai.com/v1/realtime?model={model}"
        async with websockets.connect(uri, additional_headers={"Authorization": f"Bearer {secret}"}, max_size=8 * 1024 * 1024) as ws:
            self.ws = ws
            await self.configure()
            tasks = [
                asyncio.create_task(self.microphone()),
                asyncio.create_task(self.playback()),
                asyncio.create_task(self.receive()),
                asyncio.create_task(self.watchdog()),
                asyncio.create_task(self.control_watchdog()),
            ]
            await self.stop.wait()
            await self.output_queue.put(None)
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    def close(self) -> None:
        for stream in (self.input_stream, self.output_stream):
            if stream:
                try:
                    stream.stop_stream()
                    stream.close()
                except Exception:
                    pass
        self.audio.terminate()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stdin", action="store_true")
    parser.add_argument("--diagnostic", action="store_true")
    args = parser.parse_args()
    if args.diagnostic:
        devices = []
        audio = pyaudio.PyAudio()
        try:
            for index in range(audio.get_device_count()):
                info = audio.get_device_info_by_index(index)
                if int(info.get("maxInputChannels", 0)) > 0:
                    devices.append(info.get("name"))
        finally:
            audio.terminate()
        print(json.dumps({"status": "ok", "input_devices": len(devices), "token_protected": TOKEN_PATH.exists()}))
        return 0
    initial = sys.stdin.readline().strip() if args.stdin else ""
    runtime = RealtimeEmma(initial)
    try:
        asyncio.run(runtime.run())
        return runtime.exit_code
    except (urllib.error.URLError, OSError, KeyError, websockets.WebSocketException) as exc:
        log(f"session failed: {type(exc).__name__}")
        return 1
    finally:
        runtime.close()


if __name__ == "__main__":
    raise SystemExit(main())

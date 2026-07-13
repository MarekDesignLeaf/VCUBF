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
LIVE_PATH = APP_DIR / "emma-live.json"


class DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]


def log(message: str) -> None:
    APP_DIR.mkdir(parents=True, exist_ok=True)
    with LOG_PATH.open("a", encoding="utf-8") as handle:
        handle.write(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {message}\n")


def write_live_preview(role: str = "", text: str = "", status: str = "Realtime active — speak now") -> None:
    """Expose only the latest activated-session text to the local monitor."""
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
        self.response_texts: dict[str, str] = {}
        self.current_status = "listening"
        self.current_listening = True
        self.reported_speaking = False
        self.exit_code = 0
        self.state_lock = asyncio.Lock()
        self.transcript_lock = asyncio.Lock()
        self.conversation_id: str | None = None
        self.current_user_sequence = 0
        self.next_user_sequence = 1
        self.item_sequences: dict[str, int] = {}
        self.response_sequences: dict[str, int] = {}
        self.audio = pyaudio.PyAudio()
        self.input_stream = None
        self.output_stream = None
        self.ws = None
        configured_language = str(load_config().get("Language", "en-GB"))
        self.transcription_language = configured_language.split("-", 1)[0].lower() or "en"

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

    async def start_transcript(self) -> None:
        try:
            result = await asyncio.to_thread(backend_json, "POST", "/command/voice-conversations", {"mode": "realtime"})
            self.conversation_id = str(result["id"])
        except Exception as exc:
            log(f"transcript start error: {type(exc).__name__}")

    async def append_transcript(self, role: str, content: str, sequence: int, source_event_id: str = "") -> None:
        content = content.strip()
        if not content:
            return
        write_live_preview(role, content, "You spoke" if role == "user" else "Emma is answering")
        if not self.conversation_id:
            return
        body = {"role": role, "content": content[:8000], "sequence": sequence}
        if source_event_id:
            body["source_event_id"] = source_event_id[:200]
        try:
            async with self.transcript_lock:
                await asyncio.to_thread(
                    backend_json,
                    "POST",
                    f"/command/voice-conversations/{self.conversation_id}/messages",
                    body,
                )
        except Exception as exc:
            log(f"transcript message error: {type(exc).__name__}")

    async def end_transcript(self, status: str) -> None:
        if not self.conversation_id:
            return
        try:
            await asyncio.to_thread(
                backend_json,
                "POST",
                f"/command/voice-conversations/{self.conversation_id}/end",
                {"status": status},
            )
        except Exception as exc:
            log(f"transcript end error: {type(exc).__name__}")

    async def configure(self) -> None:
        instructions = """You are Emma, a concise, warm voice assistant for VCUBF Secretary.
Always speak and respond in English. Never switch to French, Polish, or another language
based on accent, names, locale guesses, or transcription uncertainty. Change spoken language
only when the user explicitly asks you to speak that language. Keep normal answers short enough for speech.
For every request involving company records, clients, jobs, leads, tasks, schedules,
communications, quotes, invoices, employees, services, notifications, or any business
operation, call execute_business_request with the user's exact request. Also call it
whenever the user asks where a VCUBF feature is, how to use the program, or needs help
reaching an outcome; the backend owns the current program map and usage instructions.
Repeat backend UI guidance faithfully and never add likely buttons, fields or capabilities.
Never invent business data and never claim an action succeeded before the tool result confirms it.
When the tool result contains uiAction, tell the user that Secretary is opening that page or record.
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
                            "transcription": {
                                "model": "gpt-4o-transcribe",
                                "language": self.transcription_language,
                                "prompt": "Transcribe in English. VCUBF Secretary voice command. The assistant wake word is Emma. Common requests include show me contacts, list clients, list jobs, create a task, and navigate the application. Preserve contact names, company names, and application terms exactly.",
                            },
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
            self.current_user_sequence = 1
            self.next_user_sequence = 3
            await self.update_state("thinking", False, transcript=self.initial_command)
            await self.append_transcript("user", self.initial_command, 1, "initial-command")
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
            if event_type == "response.created":
                response_id = str((event.get("response") or {}).get("id") or "")
                if response_id and self.current_user_sequence:
                    self.response_sequences[response_id] = self.current_user_sequence + 1
            elif event_type in ("response.output_audio.delta", "response.audio.delta"):
                if not self.reported_speaking:
                    self.reported_speaking = True
                    await self.update_state("speaking", True)
                chunk = base64.b64decode(event.get("delta", ""))
                if chunk:
                    await self.output_queue.put(chunk)
            elif event_type in ("response.output_audio_transcript.delta", "response.audio_transcript.delta"):
                response_id = str(event.get("response_id") or "")
                delta = str(event.get("delta") or "")
                self.current_response_text += delta
                if response_id:
                    self.response_texts[response_id] = self.response_texts.get(response_id, "") + delta
                if not self.reported_speaking:
                    self.reported_speaking = True
                    await self.update_state("speaking", True)
            elif event_type in ("response.output_audio_transcript.done", "response.audio_transcript.done"):
                transcript = str(event.get("transcript") or "").strip()
                if transcript:
                    self.current_response_text = transcript
                    response_id = str(event.get("response_id") or "")
                    if response_id:
                        self.response_texts[response_id] = transcript
            elif event_type == "input_audio_buffer.speech_started":
                self.current_user_sequence = self.next_user_sequence
                self.next_user_sequence += 2
                item_id = str(event.get("item_id") or "")
                if item_id:
                    self.item_sequences[item_id] = self.current_user_sequence
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
            elif event_type == "conversation.item.created":
                item = event.get("item") or {}
                item_id = str(item.get("id") or "")
                if item_id and item.get("role") == "user" and self.current_user_sequence:
                    self.item_sequences.setdefault(item_id, self.current_user_sequence)
            elif event_type == "conversation.item.input_audio_transcription.completed":
                heard = str(event.get("transcript") or "").strip()
                if heard:
                    await self.update_state("thinking", False, transcript=heard)
                    item_id = str(event.get("item_id") or "")
                    sequence = self.item_sequences.pop(item_id, self.current_user_sequence or 1)
                    await self.append_transcript("user", heard, sequence, str(event.get("event_id") or item_id))
                normalized = heard.lower().rstrip(".!?")
                if normalized in {"stop", "goodbye", "that's all", "that is all"}:
                    self.stop.set()
            elif event_type == "response.done":
                self.response_complete_at = time.monotonic()
                response_id = str((event.get("response") or {}).get("id") or "")
                completed_text = response_text(event) or self.response_texts.pop(response_id, "").strip() or self.current_response_text.strip()
                output = (event.get("response") or {}).get("output") or []
                if completed_text:
                    await self.update_state("listening", True, response=completed_text)
                    sequence = self.response_sequences.pop(response_id, self.current_user_sequence + 1)
                    await self.append_transcript("assistant", completed_text, sequence, response_id or str(event.get("event_id") or ""))
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
        transcript_status = "completed"
        write_live_preview(status="Realtime active — speak now")
        await self.start_transcript()
        try:
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
            if self.exit_code == 10:
                transcript_status = "interrupted"
        except Exception:
            transcript_status = "error"
            raise
        finally:
            await self.end_transcript(transcript_status)
            write_live_preview(status="Realtime conversation ended")

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

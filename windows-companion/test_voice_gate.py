"""Unit tests for the Voice v2 transcript gate, wake tolerance and provider choice.

    python test_voice_gate.py

Runs anywhere: only the pure helpers are exercised, so no microphone is needed.
The transcripts used as fixtures are ones speech models actually produced.
"""
import sys, types, unittest
from pathlib import Path

COMPANION = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parent
sys.path.insert(0, str(COMPANION))

# emma_common resolves the Windows per-user data directory at import time.
import os  # noqa: E402
os.environ.setdefault("LOCALAPPDATA", str(Path(__file__).resolve().parent / "_fake_localappdata"))

# emma_voice_v2 imports Windows-only audio packages at module level; stub the
# ones that are irrelevant to the pure helpers under test.
for name in ("aec_audio_processing", "pyaudio"):
    if name not in sys.modules:
        try:
            __import__(name)
        except Exception:
            module = types.ModuleType(name)
            # emma_voice_v2 only needs these symbols to exist at import time.
            module.AudioProcessor = object
            module.paInt16 = 8
            sys.modules[name] = module

import emma_voice_v2 as voice  # noqa: E402


import unittest.mock  # noqa: E402


class TranscriptGate(unittest.TestCase):
    def test_real_commands_pass(self):
        for text in ["Emma, ukaž klienty", "Emma, show me today's jobs", "ano", "stop", "zruš to"]:
            self.assertEqual(voice.implausible_transcript(text), "", text)

    def test_known_hallucinations_are_refused(self):
        for text in ["Titulky vytvořil JohnyX", "Titulky vytvořil Jirka Kováč", "Děkuji za pozornost",
                     "Konec.", "Subtitles by the Amara.org community", "Thanks for watching!"]:
            self.assertEqual(voice.implausible_transcript(text), "KNOWN_HALLUCINATION", text)

    def test_sound_tags_are_refused(self):
        for text in ["[MUZIĘ]", "[hudba]", "(music)", "*cough*"]:
            self.assertEqual(voice.implausible_transcript(text), "SOUND_TAG", text)

    def test_noise_shapes_are_refused(self):
        self.assertEqual(voice.implausible_transcript("..."), "PUNCTUATION_ONLY")
        self.assertEqual(voice.implausible_transcript("M."), "TOO_SHORT")
        self.assertEqual(voice.implausible_transcript("ano ano ano ano"), "REPETITION_LOOP")
        self.assertEqual(voice.implausible_transcript("   "), "EMPTY")


class OpenAIOnly(unittest.TestCase):
    """Voice runs on OpenAI and nothing else; an old provider name cannot switch it."""

    def status(self, wake=None, stt=None, tts=None):
        config = voice.default_v2_config()
        if wake:
            config["wake"]["provider"] = wake
        if stt:
            config["stt"]["provider"] = stt
        if tts:
            config["tts"]["provider"] = tts
        with unittest.mock.patch.object(voice, "current_wake_profile", return_value=("cs-CZ", "Alfonzo")), \
             unittest.mock.patch.object(voice, "environment_value", return_value="test-key"):
            return voice.provider_status(config)["providers"]

    def test_defaults_are_openai(self):
        providers = self.status()
        self.assertEqual(providers["wake"]["effectiveProvider"], "openai_vad")
        self.assertEqual(providers["stt"]["effectiveProvider"], "openai")
        self.assertEqual(providers["speech"]["effectiveProvider"], "openai")
        self.assertEqual(providers["wake"]["ignoredProvider"], "")

    def test_legacy_provider_names_are_ignored_not_used(self):
        providers = self.status(wake="picovoice_porcupine", stt="deepgram", tts="elevenlabs")
        self.assertEqual(providers["wake"]["effectiveProvider"], "openai_vad")
        self.assertEqual(providers["wake"]["ignoredProvider"], "picovoice_porcupine")
        self.assertEqual(providers["stt"]["effectiveProvider"], "openai")
        self.assertEqual(providers["stt"]["ignoredProvider"], "deepgram")
        self.assertEqual(providers["speech"]["effectiveProvider"], "openai")

    def test_no_other_speech_engine_remains_in_the_runtime(self):
        for name in ("PicovoiceWakeWord", "DeepgramWakeWord", "NpuWhisperClient", "pvporcupine"):
            self.assertFalse(hasattr(voice, name), name)


class BackendReceiver(unittest.IsolatedAsyncioTestCase):
    """Every utterance is transcribed by OpenAI through the backend."""

    async def test_segment_goes_to_backend_and_reaches_command(self):
        import asyncio
        import threading
        from unittest.mock import AsyncMock, Mock, patch
        session = object.__new__(voice.VoiceSessionV2)
        session.stop = threading.Event()
        session.handle_transcript = AsyncMock()

        def transcribe(*args):
            session.stop.set()  # Process exactly the queued segment.
            return "Alfonzo, ukaž klienty"

        segments = asyncio.Queue()
        await segments.put(b"sample-pcm")
        backend = Mock(side_effect=transcribe)
        with patch.object(voice, "backend_transcribe_pcm", backend), patch.object(voice, "log"):
            await session.backend_transcription_receiver(segments)
        backend.assert_called_once()
        session.handle_transcript.assert_awaited_once_with("Alfonzo, ukaž klienty")


if __name__ == "__main__":
    unittest.main(argv=sys.argv[:1], verbosity=2)

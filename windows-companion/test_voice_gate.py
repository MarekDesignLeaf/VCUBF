"""Unit tests for the Voice v2 transcript gate, wake tolerance and voice gate.

    python test_voice_gate.py

Runs anywhere: only the pure helpers are exercised, so neither the Qualcomm NPU
nor a microphone is needed. The thresholds asserted here were measured on the
Snapdragon X Elite with whisper-base — real speech scored 0.64-0.73 mean token
probability, keyboard noise 0.28 — and the transcripts used as fixtures are the
ones the model actually produced.
"""
import sys, types, unittest
from pathlib import Path
import numpy as np

COMPANION = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parent
sys.path.insert(0, str(COMPANION))

# emma_common resolves the Windows per-user data directory at import time.
import os  # noqa: E402
os.environ.setdefault("LOCALAPPDATA", str(Path(__file__).resolve().parent / "_fake_localappdata"))

# emma_voice_v2 imports Windows-only audio packages at module level; stub the
# ones that are irrelevant to the pure helpers under test.
# The sidecar's pure helpers need neither torch nor the Qualcomm runtime.
for name in ("torch", "qai_hub_models", "qai_hub_models.models", "qai_hub_models.models._shared",
             "qai_hub_models.models._shared.hf_whisper", "qai_hub_models.models._shared.hf_whisper.app",
             "qai_hub_models.utils", "qai_hub_models.utils.onnx", "qai_hub_models.utils.onnx.torch_wrapper",
             "aec_audio_processing", "pyaudio", "websockets", "pvporcupine", "sounddevice"):
    if name not in sys.modules:
        try:
            __import__(name)
        except Exception:
            module = types.ModuleType(name)
            # emma_voice_v2 only needs these symbols to exist at import time.
            module.AudioProcessor = object
            module.paInt16 = 8
            module.HfWhisperApp = object
            module.OnnxModelTorchWrapper = object
            sys.modules[name] = module
            continue
            sys.modules[name] = module

import emma_voice_v2 as voice  # noqa: E402
import npu_whisper_sidecar as sidecar  # noqa: E402


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

    def test_confidence_floor_sits_between_measured_noise_and_speech(self):
        # Measured on this hardware: speech 0.64-0.73, keyboard noise 0.28.
        self.assertGreater(voice.LOCAL_CONFIDENCE_FLOOR, 0.30)
        self.assertLess(voice.LOCAL_CONFIDENCE_FLOOR, 0.60)


class LocalDecision(unittest.TestCase):
    """What the small local model may act on without the accurate one."""

    def test_short_confident_confirmations_are_actionable(self):
        for word in ["ano", "Ne.", "stop", "zruš", "yes", "cancel", "potvrzuji"]:
            self.assertTrue(voice.local_result_is_actionable(word, 0.7), word)

    def test_full_commands_always_go_to_the_accurate_model(self):
        for text in ["Emma, ukaž klienty", "MMO, ukáš klienty", "show me today's jobs"]:
            self.assertFalse(voice.local_result_is_actionable(text, 0.95), text)

    def test_low_confidence_is_never_actionable(self):
        self.assertFalse(voice.local_result_is_actionable("ano", 0.30))


class WakeVerification(unittest.TestCase):
    """The small local model must not veto a correct acoustic wake."""

    def test_garbled_wake_word_is_still_plausible(self):
        # Exactly what whisper-base wrote for "Emma" on this hardware.
        for heard in ["MMO, ukáš klienty.", "Ema, ukaž klienty", "Emo ukaž klienty", "Emmo, ukaž klienty"]:
            self.assertTrue(voice.wake_word_plausible(heard, "Emma"), heard)

    def test_clearly_different_speech_is_not_plausible(self):
        for heard in ["zavolej Petrovi zítra", "kolik stojí ten materiál"]:
            self.assertFalse(voice.wake_word_plausible(heard, "Emma"), heard)

    def test_custom_wake_word_is_honoured(self):
        self.assertTrue(voice.wake_word_plausible("Sekretářko, ukaž klienty", "Sekretářka"))
        self.assertFalse(voice.wake_word_plausible("ukaž klienty", "Sekretářka"))


class VoiceGate(unittest.TestCase):
    rate = 16000

    def speech_ms(self, audio):
        return sidecar.speech_activity(audio.astype(np.float32), self.rate)[0]

    def test_digital_silence_has_no_speech(self):
        self.assertEqual(self.speech_ms(np.zeros(self.rate * 3)), 0.0)

    def test_steady_noise_has_no_speech(self):
        rng = np.random.default_rng(1)
        self.assertLess(self.speech_ms(rng.normal(0, 0.03, self.rate * 3)), sidecar.MIN_SPEECH_MS)

    def test_speech_like_bursts_are_detected(self):
        rng = np.random.default_rng(2)
        audio = rng.normal(0, 0.002, self.rate * 3)
        audio[self.rate // 2 : self.rate // 2 + self.rate] += rng.normal(0, 0.08, self.rate)
        self.assertGreaterEqual(self.speech_ms(audio), sidecar.MIN_SPEECH_MS)

    def test_token_budget_scales_with_audio_and_is_bounded(self):
        self.assertEqual(sidecar.decode_token_budget(0.2, 199), 10)
        self.assertEqual(sidecar.decode_token_budget(2.0, 199), 28)
        self.assertEqual(sidecar.decode_token_budget(60.0, 199), 199)



class NpuReceiverIntegration(unittest.IsolatedAsyncioTestCase):
    """Exercise the actual receiver, with audio/provider boundaries mocked."""

    async def run_segment(self, text, confidence=0.7, reason=""):
        import asyncio
        import threading
        from unittest.mock import AsyncMock, Mock, patch
        session = object.__new__(voice.VoiceSessionV2)
        session.stop = threading.Event()
        session.language = "cs-CZ"
        session.handle_transcript = AsyncMock()

        def transcribe(*args):
            session.stop.set()  # Process exactly the queued segment.
            return text, 10, confidence, reason

        session.npu_whisper = types.SimpleNamespace(transcribe=transcribe)
        segments = asyncio.Queue()
        await segments.put(b"sample-pcm")
        accurate = Mock(return_value="Emma, ukaž klienty")
        with patch.object(voice, "backend_transcribe_pcm", accurate), patch.object(voice, "log"):
            await session.npu_transcription_receiver(segments)
        return accurate, session.handle_transcript

    async def test_noise_artifacts_never_reach_cloud_or_command(self):
        for text in ["[MUZIĘ]", "[Skřící]", "Titulky vytvořil JohnyX", "ano ano ano ano"]:
            with self.subTest(text=text):
                cloud, command = await self.run_segment(text, 0.28)
                cloud.assert_not_called()
                command.assert_not_awaited()

    async def test_no_speech_never_reaches_cloud_or_command(self):
        cloud, command = await self.run_segment("", 0.0, "NO_SPEECH")
        cloud.assert_not_called()
        command.assert_not_awaited()

    async def test_full_command_uses_accurate_transcript(self):
        cloud, command = await self.run_segment("MMO, ukáš klienty.")
        cloud.assert_called_once()
        command.assert_awaited_once_with("Emma, ukaž klienty")

    async def test_confident_confirmation_stays_local(self):
        cloud, command = await self.run_segment("ano")
        cloud.assert_not_called()
        command.assert_awaited_once_with("ano")

    async def test_low_confidence_confirmation_is_verified(self):
        cloud, command = await self.run_segment("ano", 0.28)
        cloud.assert_called_once()
        command.assert_awaited_once_with("Emma, ukaž klienty")

    async def test_empty_uncertain_decode_can_use_accurate_stt(self):
        cloud, command = await self.run_segment("", 0.0)
        cloud.assert_called_once()
        command.assert_awaited_once_with("Emma, ukaž klienty")


if __name__ == "__main__":
    unittest.main(argv=sys.argv[:1], verbosity=2)

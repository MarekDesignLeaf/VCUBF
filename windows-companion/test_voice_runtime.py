"""Runtime control regression tests; no microphone or provider calls."""
import threading
import unittest
from unittest.mock import Mock, patch

# Reuse the optional audio dependency stubs, not hardware acceptance claims.
from test_voice_gate import voice


class RuntimeControls(unittest.TestCase):
    def test_playback_rejects_echo_and_accepts_explicit_stop(self):
        self.assertEqual(voice.classify_playback_transcript(
            "Tady jsou klienti", "Tady jsou klienti", "cs-CZ", "Emma", True, True
        ), ("ignore", ""))
        self.assertEqual(voice.classify_playback_transcript(
            "stop", "Tady jsou klienti", "cs-CZ", "Emma", True, True
        ), ("stop", ""))
        self.assertFalse(voice.is_explicit_stop("zastávka stop u klienta", "cs-CZ"))

    def test_playback_requires_wake_word_for_new_command(self):
        self.assertEqual(voice.classify_playback_transcript(
            "ukaž klienty", "jiná odpověď", "cs-CZ", "Emma", True, False
        ), ("ignore", ""))
        self.assertEqual(voice.classify_playback_transcript(
            "Emma ukaž klienty", "jiná odpověď", "cs-CZ", "Emma", True, False
        ), ("command", "ukaž klienty"))

    def test_fallback_only_runs_for_current_generation(self):
        tts = voice.ResilientPcmTts.__new__(voice.ResilientPcmTts)
        tts.primary_name, tts.fallback_name = "primary", "fallback"
        tts.primary = Mock()
        tts.primary.stream.side_effect = OSError("offline")
        tts.fallback = Mock()
        with patch.object(voice, "log"):
            tts.stream("Hello", "en-GB", Mock(), 1, lambda: 2)
            tts.fallback.stream.assert_not_called()
            tts.stream("Hello", "en-GB", Mock(), 1, lambda: 1)
            tts.fallback.stream.assert_called_once()

    def test_heartbeat_does_not_report_listening_before_audio_ready(self):
        heartbeat = voice.ListeningStateHeartbeat(audio_ready=threading.Event())
        calls = []
        def backend(method, path, body):
            calls.append(body)
            heartbeat.stop_event.set()
            return {}
        with patch.object(voice, "backend_json", side_effect=backend), patch.object(
            voice, "companion_is_running", return_value=True
        ):
            heartbeat._run()
        self.assertEqual(calls[0]["status"], "offline")
        self.assertFalse(calls[0]["listening"])

    def test_heartbeat_acknowledges_pause(self):
        ready = threading.Event()
        ready.set()
        heartbeat = voice.ListeningStateHeartbeat(audio_ready=ready)
        calls = []
        def backend(method, path, body):
            calls.append(body)
            if len(calls) == 1:
                return {"pendingControl": "pause"}
            heartbeat.stop_event.set()
            return {}
        with patch.object(voice, "backend_json", side_effect=backend), patch.object(
            voice, "companion_is_running", return_value=True
        ), patch.object(voice, "log"):
            heartbeat._run()
        self.assertTrue(heartbeat.paused.is_set())
        self.assertEqual(calls[1]["ack_control"], "pause")
        self.assertFalse(calls[1]["listening"])


if __name__ == "__main__":
    unittest.main()

# CP-CODE-002 — Emma Voice v2: exactly one runtime, GPT speech recognition

Status: BUILT / TESTED (self-test, backend unit tests, live end-to-end on the Owner's PC) → **DEPLOYED LOCALLY (Owner's PC), APPROVAL_REQUIRED for merge to master**
Branch: `voice/CP-CODE-002-openai-stt` on top of master `a3472f1` · Owner request (20 Sep 2026): "Emma must not start more than once, and must recognise what I say well — no Picovoice, GPT recognition."
Governing process: SEC-00 §5 (change control), SEC-08 §8 voice pipeline enters the same governed path, SAF: provider keys stay on the backend.

## 1. What changed
- **Single instance (hard guarantee):** `emma_voice_v2.py --run` now takes a named kernel mutex (`Local\VCUBF.Emma.VoiceV2.Runtime`). A second start exits with code 3 (`{"status":"already_running"}`) before touching the microphone or the backend. `Run-VoiceV2.ps1` no longer shows a blocking dialog when a runtime already exists (that dialog stalled the unified launcher and produced repeated pop-ups); `Launch-VCUBFSecretary.ps1` stops any orphaned runtime before re-arming a new one.
- **GPT speech recognition, no Picovoice:** new wake provider `openai_vad` and STT provider `openai`. The microphone stays local behind an amplitude gate; each gated segment (pre-roll + speech + 700–1100 ms silence) is sent as WAV to the authenticated backend `POST /command/transcribe`, which calls OpenAI `gpt-4o-transcribe` (language from the user's Secretary language, vocabulary prompt incl. learned aliases). The OpenAI key never lives on the PC; every request is audited (`transcribe_voice_command`). The NPU Whisper sidecar is no longer started unless Picovoice or `npu_whisper` is actually selected.
- **Backend:** default transcription model `gpt-4o-transcribe` (`OPENAI_TRANSCRIPTION_MODEL` still overrides); new `isPromptEcho()` guard turns a prompt echoed for silent audio into "heard nothing" (the reason whisper-1 had been kept). `backend/tests/promptEcho.test.ts` (3 tests) + existing `hallucinationShapes` (14) pass.
- **Owner's PC configuration (not in git):** `%LOCALAPPDATA%\VCUBF\Emma\voice-v2.json` → `wake.provider=openai_vad`, `stt.provider=openai` (backup `voice-v2.json.before-cp002`); `backend/.env` → `WHISPER_SERVER_URL` commented out, `OPENAI_TRANSCRIPTION_MODEL=gpt-4o-transcribe`; the Owner's account voice language set to `cs-CZ` via `PUT /auth/voice-preferences` (was `en-GB`, which produced Slovak-flavoured transcripts).

## 2. Evidence
- `python emma_voice_v2.py --self-test` → ok; `--diagnostic` shows `openaiStt.active=true` once the config selects the providers.
- Live: runtime started by the unified launcher, log `v2 OpenAI (GPT) wake listener started (cs-CZ, Emma)`; a second `--run` launched by hand exited with code 3 and logged `runtime already running`.
- Recognition: synthetic Czech utterance ("Emmo, ukaž mi faktury po splatnosti za minulý měsíc") through `POST /command/transcribe` → exact transcript with language `cs`; with the account still on `en-GB` the same audio came back Slovak-flavoured — hence the language change above.
- Found and fixed during rollout: `NotifyIcon.Text` is limited to 63 characters; a longer engine label made `Run-VoiceV2.ps1` throw after starting Python, its `finally` wrote the stop file, and the launcher re-armed every second (the exact "Emma starts again and again" symptom, reproduced and closed).
- Not yet measured: real-microphone accuracy across a day of use, and per-utterance latency (REST round trip ≈ 1–2 s after end of speech). Realtime streaming transcription is the follow-up if latency matters.

## 3. Conflict analysis
- README/VOICE_V2_SETUP still describe Picovoice/NPU/Deepgram as the defaults; those remain available but are no longer the Owner's configuration. Docs update is part of the merge.
- Privacy note: with `openai_vad` a gated pre-wake segment leaves the PC (to Secretary → OpenAI) exactly as it did with `deepgram_vad`; audio is never written to disk and only text is retained. Recorded in this CP; no Bible article weakened.
- Cost: only gated speech segments are billed (gpt-4o-transcribe, per audio minute); silence stays local.

## 4. Rollback
`voice-v2.json.before-cp002` and `*.before-cp002` copies in `%LOCALAPPDATA%\VCUBF\Emma\app`; `git checkout master` in the local project and re-run the desktop shortcut.

## 5. Out of scope / next
Realtime (streaming) GPT transcription via short-lived backend credential; frontend "Windows Emma" panel showing the STT engine; removing Picovoice/Deepgram code paths once the Owner confirms the GPT path over a week; rebasing PR #1 (CP-CODE-001) onto the 18 master commits pushed today.

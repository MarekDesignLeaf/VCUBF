# Alfonzo Voice v2 for Windows

Voice v2 is the single Windows Alfonzo runtime. It speaks only OpenAI:

- **Wake word** — a local amplitude gate on the microphone; a segment that
  sounds like speech is transcribed by OpenAI and matched against the wake word
  (`Alfonzo`) in text;
- **Transcription** — OpenAI (`gpt-4o-transcribe` by default) through the
  authenticated Secretary endpoint `POST /command/transcribe`. The OpenAI key
  lives in the backend, not on the PC;
- **Speech output** — OpenAI TTS (`tts-1`, voice `nova` by default) streamed as
  PCM;
- **Every business action** — the authenticated Secretary `/command/assistant`
  endpoint, with its permission checks, validation, confirmation and audit.

There is no other speech provider and no fallback to one. Picovoice, Deepgram,
Qualcomm NPU Whisper and ElevenLabs were removed on 26 September 2026. If an
older `voice-v2.json` still names one of them, the runtime ignores it, logs
that it was ignored and runs on OpenAI; the installer rewrites the file.

The runtime keeps the microphone open while it is speaking. Exact output PCM is
fed to acoustic echo cancellation before the microphone is used. A transcript
matching Alfonzo's own reply is ignored; an explicit stop or a new command
addressed to Alfonzo interrupts playback. Audio is never written to disk.

Privacy: pre-wake speech segments that pass the amplitude gate leave the PC
(to Secretary and on to OpenAI) so the wake word can be recognised.

## Install the unified Secretary application

From `windows-companion` run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-VoiceV2.ps1
```

This removes the legacy runtime, its automatic startup entry, the old Voice v2
shortcut and the Picovoice and NPU Whisper files and runtimes left by earlier
installations. It creates exactly one desktop shortcut named **VCUBF
Secretary**. That shortcut opens one dedicated Secretary browser window and
starts Voice v2 for that window only. Closing the Secretary window stops Voice
v2 and any active conversation.

**Which Secretary it talks to.** By default the installer points the browser
window and Voice v2 at the live Secretary on Railway
(`https://backend-production-7952.up.railway.app`,
`https://frontend-production-ee13.up.railway.app`), so voice commands act on
the real business data and connectors. On the first start the window opens the
account page with a pairing code: sign in and approve this PC. The PC then
holds a 30-day device token (DPAPI-protected `token.bin`); the approval is
audited, and a password change or account disablement revokes it. Changing
the target backend deletes the old token, so the PC pairs again.

For testing code from this checkout, install with `-LocalDevelopment`: the
window, API and voice then use `localhost:5173` / `localhost:4000` and the
passwordless local test sign-in, and nothing reaches production.

When Voice v2 is running, it has an icon in the Windows notification area.
Right-click it and choose **Ukončit Alfonzo Voice v2** to stop the wake
listener and any active conversation.

## Configuration

The installer creates or migrates this non-secret file:

```text
%LOCALAPPDATA%\VCUBF\Emma\voice-v2.json
```

The only credential the PC needs is the OpenAI key for speech output, set as a
user environment variable:

```powershell
setx OPENAI_API_KEY "your OpenAI API key"
```

Transcription uses the backend's own `OPENAI_API_KEY`.

Tunable values: `wake.word`, `wake.deviceName`, the wake gate
(`wake.speechThreshold`, `preRollMs`, `silenceMs`, `maxSegmentMs`), the
conversation gate under `stt.openai`, the dictated-number windows
(`stt.digitSilenceMs`, `stt.digitJoinMs`) and `tts.model` / `tts.voice`.

## Verify before first microphone use

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Run-VoiceV2.ps1 -SelfTest
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Run-VoiceV2.ps1 -Diagnostic
```

`Diagnostic` reports configuration only; it does not expose keys or open the
microphone. `providers.wake.effectiveProvider` is `openai_vad`,
`providers.stt.effectiveProvider` and `providers.speech.effectiveProvider` are
`openai`. A non-empty `ignoredProvider` shows an old provider name that was
found in the configuration and not used. Voice v2 starts only when the
diagnostic reports `"ready": true`.

## Reliability: what Alfonzo refuses to hear

**Voice gate.** Audio is cut into utterances locally by amplitude; a segment
with too little speech is never sent for transcription.

**Transcript filter.** Every transcript reaches the parser through
`handle_transcript`, the single place `implausible_transcript` is applied. It
drops `EMPTY`, `SOUND_TAG` (`[hudba]`, `(music)`), `PUNCTUATION_ONLY`,
`KNOWN_HALLUCINATION` (the subtitle-credit family speech models invent on
silence), `TOO_SHORT` and `REPETITION_LOOP`. The backend holds the same rule in
`voiceAssistantService.isLikelyHallucination`, covered by
`backend/tests/hallucinationShapes.test.ts`.

**Dictated numbers.** A command that stops part-way through a telephone number
waits `stt.digitJoinMs` for the rest instead of acting on half a number.

Run the offline tests from `windows-companion`:

```powershell
python .\test_voice_gate.py
python -m unittest test_voice_runtime
```

They cover the transcript filter, the OpenAI-only provider choice (including
that old provider names are ignored) and the backend transcription receiver,
with the audio and network boundaries stubbed. Passing them is not microphone
or live-transcription acceptance.

## Product boundaries

Voice v2 is only the control layer. Tool execution stays in the Secretary
business API, so speech cannot bypass validation, audit, confirmation
requirements, company scope or Alfonzo's capability catalogue.

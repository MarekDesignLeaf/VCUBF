# Emma Voice v2 for Windows

Voice v2 is a parallel production-grade voice runtime. It leaves the current
Windows Emma untouched until its own provider diagnostics are ready. It uses:

- **Porcupine** for an entirely local `Emma` wake word;
- **Deepgram Nova-3** over WebSocket for real-time PCM transcription;
- **ElevenLabs** PCM streaming for low-latency spoken output;
- the existing authenticated Secretary `/command/assistant` endpoint for every
  tool, permission check, validation, confirmation and audit record.

The V2 runtime keeps the microphone open while it is speaking. Exact output PCM
is fed to acoustic echo cancellation before the microphone is streamed. A final
transcript matching Emma's own reply is ignored; a distinct final user
transcript interrupts the playback and becomes the next tool request. Audio is
never written to disk.

## Install without replacing V1

From `windows-companion` run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-VoiceV2.ps1
```

This installs a separate desktop shortcut named **VCUBF Secretary — Voice v2**.
It does not change the existing startup task, desktop shortcut, configuration or
runtime of Voice v1. Voice v2 refuses to start while v1 is active, so exactly
one companion can own the microphone.

## Configure providers

The installer creates this non-secret configuration file if it does not exist:

```text
%LOCALAPPDATA%\VCUBF\Emma\voice-v2.json
```

Copy the real Porcupine `.ppn` model path and the ElevenLabs voice ID into that
file. Keep API secrets out of JSON. Set them as user environment variables, then
open a new PowerShell session:

```powershell
setx PICOVOICE_ACCESS_KEY "your Picovoice access key"
setx DEEPGRAM_API_KEY "your Deepgram API key"
setx ELEVENLABS_API_KEY "your ElevenLabs API key"
```

Create the custom `Emma` Windows wake-word model in Picovoice Console, download
the `.ppn` file, and set `wake.keywordPath` to its full path. Set
`tts.voiceId` to a voice from your ElevenLabs account. The runtime uses the
selected Secretary language for Deepgram and ElevenLabs; set
`stt.languageMode` to `auto` only for a deliberately multilingual session.

## Verify before first microphone use

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Run-VoiceV2.ps1 -SelfTest
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Run-VoiceV2.ps1 -Diagnostic
```

`Diagnostic` reports only whether providers and local models are available; it
does not expose keys or open the microphone. Voice v2 starts only when the
diagnostic reports `"ready": true`.

## Product boundaries

Voice v2 is the provider layer from the production architecture. It deliberately
keeps tool execution in the existing Secretary business API so the new speech
providers cannot bypass validation, audit, confirmation requirements, company
scope or Emma's capability catalogue. The FastAPI/LangGraph orchestrator remains
the next backend migration stage and will call the same API contracts.

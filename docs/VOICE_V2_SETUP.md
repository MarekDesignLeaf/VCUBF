# Emma Voice v2 for Windows

Voice v2 is the single Windows Emma runtime. It uses:

- **local VAD plus Deepgram Nova-3** to verify the `Emma` wake word in the
  currently selected Secretary language;
- **Deepgram Nova-3** over WebSocket for real-time PCM transcription;
- **ElevenLabs** PCM streaming for low-latency spoken output;
- the existing authenticated Secretary `/command/assistant` endpoint for every
  tool, permission check, validation, confirmation and audit record.

The V2 runtime keeps the microphone open while it is speaking. Exact output PCM
is fed to acoustic echo cancellation before the microphone is streamed. A final
transcript matching Emma's own reply is ignored; a distinct final user
transcript interrupts the playback and becomes the next tool request. Audio is
never written to disk.

While waiting for `Emma`, a local amplitude gate keeps silence on the PC. When
it detects speech, it keeps a short in-memory pre-roll and sends that speech
segment to Deepgram only to verify the wake word; it then closes that stream.
This is required for Czech and other languages without a compatible local
Windows recognizer. The request opts out of the Deepgram Model Improvement
Program; provider-side handling remains governed by the configured Deepgram
account and its data policy.

## Install the unified Secretary application

From `windows-companion` run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-VoiceV2.ps1
```

This removes the legacy Emma runtime, its automatic startup entry and the old
Voice v2 shortcut. It creates exactly one desktop shortcut named **VCUBF
Secretary**. That shortcut opens one dedicated Secretary browser window and
starts Voice v2 for that window only. Closing the dedicated browser window
always stops Voice v2, including an active conversation.

When Voice v2 is running, it has a visible icon in the Windows notification
area. Right-click it and choose **Ukončit Emmu Voice v2** to stop the wake
listener and any active conversation. The launcher owns the Python runtime; if
the Secretary window or its launcher closes, the child runtime stops too.

## Configure providers

The installer creates this non-secret configuration file if it does not exist:

```text
%LOCALAPPDATA%\VCUBF\Emma\voice-v2.json
```

The installer configures the Deepgram VAD wake word automatically. Keep API
secrets out of JSON. Set only the Deepgram and ElevenLabs credentials as user
environment variables, then open a new PowerShell session:

```powershell
setx DEEPGRAM_API_KEY "your Deepgram API key"
setx ELEVENLABS_API_KEY "your ElevenLabs API key"
```

Set `tts.voiceId` in `voice-v2.json` to a voice from your ElevenLabs account.
The runtime uses the selected Secretary language for wake verification,
Deepgram transcription and ElevenLabs output. It does not depend on a Windows
Speech Recognition language pack and never falls back to English. Set
`stt.languageMode` to `auto` only for a deliberately multilingual session.

## Verify before first microphone use

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Run-VoiceV2.ps1 -SelfTest
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Run-VoiceV2.ps1 -Diagnostic
```

`Diagnostic` reports only whether providers and configuration are available; it
does not expose keys or open the microphone. Voice v2 starts only when the
diagnostic reports `"ready": true`.

## Product boundaries

Voice v2 is the provider layer from the production architecture. It deliberately
keeps tool execution in the existing Secretary business API so the new speech
providers cannot bypass validation, audit, confirmation requirements, company
scope or Emma's capability catalogue. The FastAPI/LangGraph orchestrator remains
the next backend migration stage and will call the same API contracts.

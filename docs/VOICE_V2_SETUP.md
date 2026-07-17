# Emma Voice v2 for Windows

Voice v2 is the single Windows Emma runtime. It uses:

- **Picovoice Porcupine** for fully local, low-latency detection of the `Emma`
  wake word, with the former local-VAD/Deepgram path as an automatic fallback;
- **Qualcomm Whisper Base through ONNX Runtime QNN** for local transcription on
  the Snapdragon Hexagon NPU, with Deepgram Nova-3 as an automatic fallback;
- **ElevenLabs** PCM streaming for low-latency spoken output;
- the existing authenticated Secretary `/command/assistant` endpoint for every
  tool, permission check, validation, confirmation and audit record.

The V2 runtime keeps the microphone open while it is speaking. Exact output PCM
is fed to acoustic echo cancellation before the microphone is streamed. A final
transcript matching Emma's own reply is ignored; a distinct final user
transcript interrupts the playback and becomes the next tool request. Audio is
never written to disk.

With a valid Windows `Emma.ppn` model, wake-word detection runs entirely on the
PC and no wake audio is uploaded. If the custom model is absent, incompatible,
or rejected by Picovoice, the runtime returns to the local amplitude gate and
sends only a detected speech segment to Deepgram to verify the wake word. That
fallback request opts out of the Deepgram Model Improvement Program;
provider-side handling remains governed by the configured Deepgram account and
its data policy.

## Install the unified Secretary application

From `windows-companion` run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-VoiceV2.ps1
```

This removes the legacy Emma runtime, its automatic startup entry and the old
Voice v2 shortcut. It creates exactly one desktop shortcut named **VCUBF
Secretary**. That shortcut opens one dedicated Secretary browser window and
starts Voice v2 for that window only. Closing the Secretary window always stops
Voice v2, its NPU worker and any active conversation.

When Voice v2 is running, it has a visible icon in the Windows notification
area. Right-click it and choose **Ukončit Emmu Voice v2** to stop the wake
listener and any active conversation. The launcher owns the Python runtime; if
the Secretary window or its launcher closes, the child runtime stops too.

## Configure providers

The installer creates this non-secret configuration file if it does not exist:

```text
%LOCALAPPDATA%\VCUBF\Emma\voice-v2.json
```

On a Snapdragon X PC, install and verify the local NPU transcription runtime
once from `windows-companion`:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-NpuWhisper.ps1
```

The installer requires a working Qualcomm Hexagon NPU driver, installs the
official Qualcomm Whisper Windows runtime and selects `stt.provider` =
`npu_whisper`. The model remains loaded in one child process while Emma runs;
utterance audio stays in memory and is not written to disk. If QNN cannot start,
Emma records the failure and uses Deepgram instead.

Keep API secrets out of JSON. Set Picovoice, Deepgram and ElevenLabs credentials
as user environment variables, then open a new PowerShell session:

```powershell
setx DEEPGRAM_API_KEY "your Deepgram API key"
setx ELEVENLABS_API_KEY "your ElevenLabs API key"
setx PICOVOICE_ACCESS_KEY "your Picovoice AccessKey"
```

The AccessKey is not the wake-word model. Generate and configure the
platform-specific Windows model directly with:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Configure-PicovoiceWake.ps1
```

The helper asks Picovoice to train the phrase **Emma**, stores the resulting
`.ppn` in the private local Emma directory and switches the non-secret configuration to
`picovoice_porcupine`. Restart Secretary from its single desktop icon. If the
model cannot initialize, Emma logs the cause without the key and automatically
uses Deepgram wake verification instead of remaining deaf.

An existing Windows `.ppn` model can instead be imported with
`-ModelPath C:\path\to\Emma_windows.ppn`.

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
does not expose keys or open the microphone. Check
`providers.wake.effectiveProvider`: `picovoice_porcupine` means local wake-word
detection is active, while `deepgram_vad` means the safe fallback is active.
Check `providers.npuWhisper.effectiveProvider`: `npu_whisper` together with
`executionProvider: QNNExecutionProvider` confirms NPU transcription is active.
Voice v2 starts only when the diagnostic reports `"ready": true`.

## Product boundaries

Voice v2 is the provider layer from the production architecture. It deliberately
keeps tool execution in the existing Secretary business API so the new speech
providers cannot bypass validation, audit, confirmation requirements, company
scope or Emma's capability catalogue. The FastAPI/LangGraph orchestrator remains
the next backend migration stage and will call the same API contracts.

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

## Reliability: what Emma refuses to hear

The following guards reduce false commands from silence and recognised noise
artefacts. They do not prove that every room sound or passing conversation is
rejected; acoustic wake and real-device acceptance still require separate tests.

**Voice gate** (`npu_whisper_sidecar.py`). Every segment is split into 20 ms
frames. The noise floor is the tenth percentile of the frame RMS values and the
speech threshold is `max(0.004, noise_floor × 3)`. A segment with less than
200 ms above that threshold is answered with `reason: "NO_SPEECH"` and Whisper
is never started for it, so silence and steady room noise cost about one
millisecond and no NPU work at all.

**Decode budget.** The decoder is capped at
`max(8, min(hard_limit, seconds × 10 + 8))` tokens, so a repetition loop ends
instead of consuming the whole context.

**Confidence.** The sidecar returns the mean probability of the tokens it
emitted. Measured on a Snapdragon X Elite with `whisper-base` on QNN, real
Czech speech scores 0.64-0.73 and keyboard noise scores 0.28, so the runtime's
floor is `LOCAL_CONFIDENCE_FLOOR = 0.45` in `emma_voice_v2.py`.

**Transcript filter.** Every provider — NPU, Deepgram and the authenticated
fallback — reaches the parser through `handle_transcript`, which is the single
place `implausible_transcript` is applied. It drops the text and logs the
reason: `EMPTY`, `SOUND_TAG` (`[MUZIĘ]`, `[Skřící]`), `PUNCTUATION_ONLY`,
`KNOWN_HALLUCINATION` (the subtitle-credit family Whisper invents on silence,
such as "Titulky vytvořil JohnyX" or "Thanks for watching"), `TOO_SHORT` and
`REPETITION_LOOP`. Matching folds diacritics, because the same invented credit
comes back accented or not depending on the recogniser. The backend holds the
same rule in `voiceAssistantService.isLikelyHallucination`, covered by
`backend/tests/hallucinationShapes.test.ts`, so the Android app and the browser
fallback are protected by it too.

## Two-tier transcription

`whisper-base` is the only local model Qualcomm publishes for this runtime. It
is dependable for one or two words and unreliable for a whole sentence: "ukaž
klienty" came back as "ukáš klienty". Voice v2 therefore splits the work when
`stt.provider` is `npu_whisper`.

A confident short answer from a fixed list — `ano`, `ne`, `potvrď`, `zruš`,
`stop`, `yes`, `no`, `confirm`, `cancel` and their siblings — is executed
straight from the NPU result, so confirmations stay instant. Anything longer is
a real instruction: the same audio goes to the accurate model through the
authenticated `POST /command/transcribe`, and that transcript becomes the
command. A misheard command is worse than a slightly slower correct one.

Wake verification is deliberately tolerant and runs even when Deepgram owns
command transcription. Porcupine remains the detector and
the NPU only looks for an obvious false positive: the first two spoken tokens
are compared with the wake word by equality, two-character prefix, single edit
and consonant skeleton, so "MMO, ukáš klienty" still counts as "Emma". A
low-confidence local transcript never overrules Porcupine; only a confident and
clearly different one rejects the wake.

## Measured behaviour

Snapdragon X Elite, `whisper-base` on `QNNExecutionProvider`, model loaded once
at start (2-7 s), then per segment:

| Input | Local decode | Local transcript | Outcome |
| --- | --- | --- | --- |
| "Emma, ukaž klienty" | 250 ms | `MMO, ukáš klienty.` | wake accepted (0.72), sent to accurate STT |
| "Emma, vytvoř novou zakázku…" | 361 ms | `MMO, vytvoš novou zakásku…` | wake accepted (0.64), sent to accurate STT |
| "Emma, kolik mám nezaplacených faktur" | 311 ms | `MMO, kolik mám nezapracených faktur.` | wake accepted (0.73), sent to accurate STT |
| "Emma, ukaž dnešní úkoly" | 263 ms | `MMO, ukáždnéšní úkolé.` | wake accepted (0.66), sent to accurate STT |
| White noise | 1 ms | — | ignored by the voice gate |
| Low rumble | 1 ms | — | ignored by the voice gate |
| Keyboard clicks | 198 ms | `[MUZIĘ]` | ignored, `SOUND_TAG` |
| Short burst | 195 ms | `[Skřící]` | ignored, `SOUND_TAG` |

The four Czech samples are why the split exists: the wake word survives the
local model, the command does not.

Run the offline unit tests for these guards from `windows-companion`:

```powershell
python .\test_voice_gate.py
```

The 21 tests cover the transcript filter, the local-execution rule, wake
plausibility and the actual NPU receiver decision path. Six receiver tests
verify that recognised noise never calls accurate STT or the command handler,
while full commands and uncertain short responses still use accurate STT.
They stub the audio/provider boundaries; passing them is not microphone,
cloud-transcription or complete business-action acceptance.

A receiver regression was corrected on 18 September 2026: a local transcript
classified as noise previously fell through to accurate STT. The receiver now
ignores non-empty rejected transcripts before any cloud call. An empty decode
without NO_SPEECH may still use accurate STT to recover genuine speech.
The new regression failed for four noise fixtures against the previous
installed file, and all 21 tests passed against the updated installed file.

## Product boundaries

Voice v2 is the provider layer from the production architecture. It deliberately
keeps tool execution in the existing Secretary business API so the new speech
providers cannot bypass validation, audit, confirmation requirements, company
scope or Emma's capability catalogue. The FastAPI/LangGraph orchestrator remains
the next backend migration stage and will call the same API contracts.

# VCUBF Emma for Windows 11

Native Windows tray companion for VCUBF. It uses the locally installed Windows Speech Recognizer for the configurable wake word (`Emma` by default), then starts a hands-free Realtime conversation or falls back to the audited text-assistant path. The editable review dialog remains available when hands-free mode is disabled.

## Install

Open Windows PowerShell in this directory and run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1 -StartNow
```

The installer creates one **VCUBF Secretary** icon on the Windows desktop. Double-clicking it silently starts Emma first, opens one production sign-in flow in the default browser and creates a one-time device handoff. Completing that login automatically connects the companion to the same account; there is no second approval button. On a fresh start Emma says **Emma is active and listening**. The page remembers the last successful email address on this PC and the browser can offer its saved password through standard password autofill.

Emma receives a bounded text-only excerpt from the signed-in user's recent completed conversations so a later session can continue naturally. Audio is never retained. A permanent note is created only by an explicit command such as **“remember that …”** (personal) or **“remember for the company that …”** (shared, requiring CRM management permission). Saved and archived notes are visible on the **Emma Memory** page; clearing transcript history does not delete permanent notes.

The companion opens the normal VCUBF login in your default browser, so browser password autofill works. The one-time desktop code is approved automatically only after that login succeeds. The browser hands back a device token; no password is entered into or saved by the companion. The token is encrypted with Windows DPAPI for the current Windows user, expires after 30 days and is invalidated immediately by a password change, account disablement or session-version reset. Right-click the tray icon to pause/resume listening, change the wake word, reconnect in the browser, open VCUBF or exit.

Natural assistant mode is enabled by default. Exact supported commands stay on the fast deterministic path. Other natural wording is sent as text to the backend OpenAI integration, which may translate it into one supported canonical command, ask one clarifying question, answer conversationally, or describe a safe plan for a complex objective. The model never writes to the database directly and cannot bypass permissions, reference disambiguation or confirmation-gated actions. When Realtime mode is disabled, OpenAI receives recognized text rather than microphone audio.

Realtime audio mode is also enabled by default. Wake-word detection remains local and no microphone audio leaves the PC before activation. After `Emma` is recognised, the companion obtains a short-lived Realtime credential from the authenticated VCUBF backend and opens a temporary speech-to-speech session. Server voice-activity detection ends turns automatically, and speaking while Emma is responding interrupts playback immediately. The permanent OpenAI API key remains only on the backend. Every company-data request is returned to the normal `/command/assistant` endpoint as a tool call, so permissions, audit, ambiguity rejection and risk controls remain authoritative. The audio session closes after inactivity or after three minutes.

Every signed-in VCUBF page includes a **Windows Emma** control centre. It reports the live device state and stores the complete final text transcript of each activated conversation: ordered user/Emma turns, timestamps, mode and completion state. Background speech that does not activate Emma is not sent to this history. The web controls can pause or resume local wake-word listening, end the current Realtime conversation and delete all saved transcript text after confirmation; device commands are acknowledged so the page shows the applied state rather than only the requested state. Audio is streamed only during an activated Realtime session and is never stored by VCUBF.

The local-only **What Emma hears** monitor opens by default and shows microphone level, recognition hypotheses and activated Realtime turns. Close it when it is not needed and reopen it with the tray command **Show live hearing**; pre-wake text shown there is not uploaded or saved. The wake word uses a dedicated high-priority grammar; say `Emma` alone to start Realtime audio, then speak naturally even when the installed Windows recognizer does not support the conversation language.

Program-navigation and usage questions are routed through the backend just like business-data questions. The backend supplies Emma with a tested map covering every implemented frontend route, primary control labels, prerequisites and confirmation boundaries. This lets her guide the user to an outcome without granting the Realtime model direct database access or allowing it to invent unavailable UI.

## Voice flow

1. Say `Emma` followed by a supported English command, or say `Emma`, wait for `Yes?`, then speak within eight seconds.
2. In the default hands-free mode, Emma executes the supported command immediately and speaks a useful result.
3. For twelve seconds after a response, speak a follow-up without repeating the wake word. Say `stop` or `goodbye` to end the exchange.
4. Right-click the tray icon and choose **Talk to Emma now** for a manual push-to-talk-style prompt without saying the wake word.
4. Local conversational phrases include `hello`, `what can you do`, `repeat`, `thank you` and `stop`.

Hands-free mode can be disabled in tray **Settings** to restore the editable review dialog. Backend permissions, deterministic ambiguity checks and confirmation requirements remain authoritative in either mode.

Settings also control natural assistant mode, Realtime audio, Emma and Secretary menu language, fallback spoken-response speed and volume. You can also say, for example, **“Emma, switch language to Czech”**; the selected language is saved for both Emma and the web menu. English (UK/US), Czech, Polish, French, German, Spanish and Italian are supported. If Windows has no local speech pack for the selected language, the companion retains an available local wake-word recognizer while Realtime uses the chosen conversation language. The default wake word remains editable at any time. If Realtime cannot connect, the companion automatically falls back to the text assistant and Windows speech synthesis.

The wake-word recognizer is local and continues while browsers are minimized or closed, but Windows must be running and the user must be signed in. Microphone privacy settings must allow desktop applications. Realtime audio requires internet access. The deterministic parser supports English business-command canonical forms and explicit language changes in English or Czech; the natural assistant can translate ordinary supported phrasing into them.

## Diagnostics

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\VCUBF-Emma.ps1 -Diagnostic
```

## Uninstall

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Uninstall.ps1
```

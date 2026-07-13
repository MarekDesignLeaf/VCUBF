# VCUBF Emma for Windows 11

Native Windows tray companion for VCUBF. It uses the locally installed Windows Speech Recognizer, listens for the configured wake word (`Emma` by default), pauses for an editable review dialog, and sends only the approved transcript to the existing audited `/command/text` endpoint.

## Install

Open Windows PowerShell in this directory and run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1 -StartNow
```

The installer creates one **VCUBF Secretary** icon on the Windows desktop. Double-clicking it silently ensures that Emma is running and opens the production login in the default browser. The page remembers the last successful email address on this PC and the browser can offer its saved password through standard password autofill.

The companion opens the normal VCUBF login in your default browser, so browser password autofill works. After login, approve the matching eight-character code on the Account page. The browser hands back a short-lived one-time token; no password is entered into or saved by the companion. The resulting API token is encrypted with Windows DPAPI for the current Windows user. Right-click the tray icon to pause/resume listening, change the wake word, reconnect in the browser, open VCUBF or exit.

Natural assistant mode is enabled by default. Exact supported commands stay on the fast deterministic path. Other natural wording is sent as text to the backend OpenAI integration, which may translate it into one supported canonical command, ask one clarifying question, answer conversationally, or describe a safe plan for a complex objective. The model never writes to the database directly and cannot bypass permissions, reference disambiguation or confirmation-gated actions. Audio is not sent to OpenAI in this Windows version.

## Voice flow

1. Say `Emma` followed by a supported English command, or say `Emma`, wait for `Yes?`, then speak within eight seconds.
2. In the default hands-free mode, Emma executes the supported command immediately and speaks a useful result.
3. For twelve seconds after a response, speak a follow-up without repeating the wake word. Say `stop` or `goodbye` to end the exchange.
4. Right-click the tray icon and choose **Talk to Emma now** for a manual push-to-talk-style prompt without saying the wake word.
4. Local conversational phrases include `hello`, `what can you do`, `repeat`, `thank you` and `stop`.

Hands-free mode can be disabled in tray **Settings** to restore the editable review dialog. Backend permissions, deterministic ambiguity checks and confirmation requirements remain authoritative in either mode.

Settings also control natural assistant mode, recognizer language, spoken-response speed and volume. The default wake word remains editable at any time.

The recognizer is local and continues while browsers are minimized or closed, but Windows must be running and the user must be signed in. Microphone privacy settings must allow desktop applications. The current command parser supports English command forms.

## Diagnostics

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\VCUBF-Emma.ps1 -Diagnostic
```

## Uninstall

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Uninstall.ps1
```

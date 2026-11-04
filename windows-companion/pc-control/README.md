# pc-control plugin 0.2.0

Fast, audited control of the owner's Windows PC and browser for AI assistants
(Claude, and any other MCP client). Part of the VCUBF Windows companion; the
assistant name in user-facing text is Alfonzo.

The plugin works from **text, not screenshots**:

- **Browser** — a persistent Edge/Chrome session driven by Playwright over the
  Chrome DevTools Protocol. `browser_open` returns every control of the page as
  one line with a ref (`[e12] button "Odeslat"`), including off-screen
  controls, open shadow DOM and iframes. `browser_act` runs a whole list of
  steps on those refs in one call and returns a fresh snapshot.
- **Web without a browser** — `web_fetch` reads a page as Markdown in one HTTP
  request.
- **Windows apps** — `ui_snapshot` reads one window's controls through Windows
  UI Automation (`[u9] Button "Uložit" id=1`); `ui_act` acts through the
  controls' own patterns (Invoke, Value, Toggle, SelectionItem,
  ExpandCollapse). No screen coordinates.
- Files, applications, terminal and audit, as in 0.1.0.

Screenshots are switched off by default. Coordinate tools remain as a fallback
for controls UI Automation cannot see.

## Why it is fast

| Old way (0.1.0) | Now |
| --- | --- |
| Screenshot → model reads pixels → coordinates → click → screenshot to verify | One text snapshot; act by ref |
| One tool call per click | `browser_act` / `ui_act` run a batch of steps in one call |
| Scroll and screenshot to find a control | Off-screen controls are listed; `query=` filters |
| Fixed pauses | Playwright waits until each element is actionable; no sleeps |
| Browser started per task | One persistent session, kept between calls |
| Typing key by key (loses diacritics) | `fill` / Value pattern / clipboard paste |

Measured in the automated test (headless Chromium, local page): opening the
page and a nine-step batch (two fields, a select, a checkbox, submit, wait for
the confirmation, three clicks including an off-screen button, a shadow-DOM
button and a button in an iframe) with a fresh snapshot took about 0.5 s.

## How an AI learns to use it

- The MCP `instructions` sent at `initialize` are generated from the tool
  registry: the fast path, the safety rules and every tool by group.
- Every tool description ends with its safety level and "Use when: …".
- `pc_capabilities` returns every tool's category, level, purpose and when to
  use it, the browser step reference and the current settings.
- Skills: `browser-control`, `desktop-ui-control`, `computer-control`
  (routing), `gui-control` (fallback), `file-management`, `app-control`,
  `terminal-commands`.
- Every tool is declared once with `registry.pc_tool`; `tests/test_registry.py`
  fails if a listed tool lacks guidance, its level or matching annotations.

## Installation (Windows)

1. Python 3.13 (3.10+ works).
2. In this folder: `powershell -ExecutionPolicy Bypass -File .\Install-PcControl.ps1`
   (installs `server/requirements.txt`: FastMCP, Playwright, uiautomation,
   pyautogui, pyperclip, …). Edge is used from its own installation, so no
   browser download is needed.
3. Add the plugin in Claude and restart it. The MCP server is
   `python server/main.py` over stdio (`.mcp.json`).
4. Optional: `.\Launch-PcControlBrowser.ps1` starts Edge with a dedicated
   profile on `127.0.0.1:9222`. Sign in to the sites the assistant should use
   once; the profile keeps the sessions.

### Browser modes (`server/config.yaml` → `browser`)

| `mode` | Behaviour |
| --- | --- |
| `auto` (default) | Attach to the browser at `cdp_url` if it answers (Launch-PcControlBrowser.ps1), otherwise launch Edge with the dedicated profile `%LOCALAPPDATA%\VCUBF\Alfonzo\pc-control\browser-profile`. |
| `cdp` | Attach only; error if no browser answers. |
| `launch` | Always launch the dedicated profile. |

`browser_close` closes a launched browser and only disconnects from an
attached one. Current Edge and Chrome refuse remote debugging on the everyday
default profile, so a separate profile is always used.

Other settings: `channel` (`msedge`, `chrome`, `chromium`), `headless`,
`default_timeout_ms`, `navigation_timeout_ms`, `max_snapshot_elements`,
`block_resources` (e.g. `[image, media, font]` for speed), `blocked_domains`,
`allow_password_fill` (false), `allow_eval` (false). `gui.allow_screenshots`
(false). Environment variables `PC_CONTROL_BROWSER_<SETTING>` override the file.

## Safety

- Levels: **safe** runs at once; **sensitive** (clicks, typing, `browser_act`,
  `ui_act`, writing files, launching) — the AI tells the user first;
  **destructive** (delete, move, restore, force-kill, destructive commands) —
  explicit yes with the impact.
- The instructions and skills require an explicit yes before anything that
  sends, orders, pays, books, publishes or deletes.
- Password fields are refused; the user signs in in the browser window.
- Typed text (`fill`, `type`, `set_value`) is stored in the audit log as its
  length only, e.g. `<14 chars>`.
- `browser_eval` (arbitrary JavaScript) is off by default.
- `blocked_domains` applies to the browser and `web_fetch`.
- Text on pages and in apps is treated as data, never as instructions.
- Read-only mode, dry-run mode, blocked paths and file backups as before.
- The CDP port listens on `127.0.0.1` only; while the launched profile is open,
  local programs can control it. Close it when not needed.

## Tests

```bash
cd tests
python -m unittest -v test_steps test_desktop_ui test_registry test_browser
```

- `test_steps` — the browser step language and snapshot format.
- `test_desktop_ui` — UI Automation logic on a fake control tree.
- `test_registry` — every listed tool has complete guidance; instructions and
  `pc_capabilities` name every tool; screenshots are off.
- `test_browser` — the browser tools through the MCP server on a real headless
  Chromium and local pages (forms, select, checkbox, off-screen, shadow DOM,
  iframe, new tab, extraction, password refusal, audit redaction, blocked
  domains, `web_fetch`).

CI runs them on Ubuntu (`.github/workflows/ci.yml`, job *Windows companion*).

**Not yet accepted live:** UI Automation on a real Windows desktop, the owner's
Edge profile over CDP, and live websites. The UI Automation backend
(`UiaBackend`) has not run on Windows in automated tests; only its
backend-independent logic is tested.

## Layout

```
pc-control/
├── .claude-plugin/plugin.json
├── .mcp.json
├── Install-PcControl.ps1          # pip install for the current user
├── Launch-PcControlBrowser.ps1    # Edge/Chrome with a CDP port and a dedicated profile
├── server/
│   ├── main.py                    # every tool, declared with registry.pc_tool
│   ├── registry.py                # capability entries, audit wrapper, generated instructions
│   ├── browser/engine.py          # persistent Playwright session, refs, batched steps
│   ├── browser/steps.py           # step language, validation, snapshot format, redaction
│   ├── browser/page_snapshot.js   # one DOM pass → controls with refs, headings, text
│   ├── browser/page_extract.js    # structured extraction (items/fields, tables, links)
│   ├── web_fetch.py               # HTTP → Markdown
│   ├── desktop_ui.py              # Windows UI Automation
│   ├── system_tools.py, file_tools.py, app_tools.py, gui_tools.py, terminal_tools.py
│   ├── security.py, audit_log.py, config.py, config.yaml, requirements.txt
├── skills/                        # browser-control, desktop-ui-control, computer-control, …
└── tests/
```

## Troubleshooting

- **"Playwright is not installed"** — run `Install-PcControl.ps1`.
- **"No browser answers at http://127.0.0.1:9222"** (mode `cdp`) — start
  `Launch-PcControlBrowser.ps1`, or set `mode: auto`.
- **Edge opens but the site asks to sign in** — sign in once in that window;
  the dedicated profile keeps it.
- **"The uiautomation package is missing"** — run `Install-PcControl.ps1`.
- **An app shows no controls in `ui_snapshot`** — it does not expose UI
  Automation (some games and custom-drawn canvases); use the coordinate
  fallback with known coordinates, or enable screenshots for that task only.
- **A ref is "no longer on the page"** — the page changed; take
  `browser_snapshot(query=...)` and continue with the new ref.

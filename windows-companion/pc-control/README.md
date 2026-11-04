# pc-control Plugin

Secure, audited Windows computer control for Claude. Gives Claude the ability to interact with your PC — reading system status, managing files, launching applications, controlling the GUI, and running terminal commands — all through a clearly defined, safety-first interface.

## What It Does

| Category | Capabilities |
|----------|-------------|
| **System** | CPU/RAM/disk status, running processes, open windows, focus control |
| **Files** | List, read, write, copy, move, delete, search, backup/restore |
| **Applications** | Launch, close, detect running apps, open projects in VS Code / Android Studio |
| **GUI** | Screenshot, click, type, keyboard shortcuts, scroll, mouse control |
| **Terminal** | PowerShell & CMD commands, background processes, build error analysis |
| **Audit** | Every action logged to JSONL with timestamp, level, params, result |

## Safety Model

All tools are classified as **safe**, **sensitive**, or **destructive**:

- **Safe** actions (reads, screenshots) execute immediately
- **Sensitive** actions (writes, clicks, launches) require user confirmation
- **Destructive** actions (delete, force-kill, registry changes) require explicit confirmation with impact description

Additional protections:
- Files are automatically backed up before any modification
- Deleted files go to a `_deleted_/` recovery folder by default (not permanently removed)
- Dry-run mode: preview commands without executing them
- Read-only mode: block all write/execute operations
- Blocked paths: System32 and other critical Windows directories are never touched
- No passwords, tokens, or sensitive data are ever stored or transmitted

---

## Installation

### 1. Install Python dependencies

```powershell
cd <plugin-folder>/server
pip install -r requirements.txt
```

> **Windows note**: `pywin32` requires a restart after install for the DLL to register.
> Run `python -m pywin32_postinstall -install` if needed.

### 2. Install the plugin in Claude

In Claude (Cowork mode), go to **Settings → Plugins → Install from file** and select `pc-control.plugin`.

### 3. Verify

Ask Claude: *"What's my system status?"* — it should return CPU, RAM, and disk info.

---

## Configuration

Edit `server/config.yaml` to customise behaviour:

```yaml
security:
  mode: active        # "active" or "readonly"
  dry_run: false      # true = preview only, never execute

files:
  auto_backup: true   # backup before every write

terminal:
  default_shell: powershell
  timeout_seconds: 60
```

---

## Usage Examples

Ask Claude in natural language:

- *"Show me what's using the most RAM"*
- *"Open my project at C:/projects/my-app in VS Code"*
- *"Read the file C:/projects/my-app/src/index.js"*
- *"Run `npm run build` in C:/projects/my-app and show me any errors"*
- *"Take a screenshot and click the OK button"*
- *"Search for all Python files in C:/projects that contain 'TODO'"*
- *"What processes are running with 'chrome' in the name?"*

---

## Audit Log

All actions are recorded in `server/logs/audit.jsonl`. Each entry:

```json
{
  "ts": "2025-01-01T12:00:00+00:00",
  "tool": "write_file",
  "level": "sensitive",
  "dry_run": false,
  "params": {"path": "C:/project/main.py", "content": "..."},
  "result_summary": "{\"success\": true, \"backup\": \"main.py.bak.20250101_120000\"}",
  "error": null
}
```

Ask Claude: *"Show me the last 20 actions from the audit log"*

---

## Modes

| Mode | How to enable | Effect |
|------|--------------|--------|
| Active (default) | `security.mode: active` | Full control |
| Read-only | `security.mode: readonly` | Only safe reads allowed |
| Dry-run | `security.dry_run: true` | Log everything, execute nothing |

---

## Project Structure

```
pc-control/
├── .claude-plugin/
│   └── plugin.json           # Plugin manifest
├── server/
│   ├── main.py               # MCP server entry point
│   ├── system_tools.py       # OS status, processes, windows
│   ├── file_tools.py         # File operations
│   ├── app_tools.py          # Application control
│   ├── gui_tools.py          # Screen/mouse/keyboard
│   ├── terminal_tools.py     # Shell commands
│   ├── security.py           # Action classification
│   ├── audit_log.py          # JSONL audit logging
│   ├── config.py             # Configuration loader
│   ├── config.yaml           # Settings
│   └── requirements.txt      # Python dependencies
├── skills/
│   ├── computer-control/     # Overview + safety guidelines
│   ├── file-management/      # File operation guide
│   ├── app-control/          # Application launch guide
│   ├── gui-control/          # Screen/mouse/keyboard guide
│   └── terminal-commands/    # Shell command guide
├── .mcp.json                 # MCP server registration
└── README.md
```

---

## Troubleshooting

**"pywin32 not installed"** — Run `pip install pywin32` then `python -m pywin32_postinstall -install`

**"mss or Pillow not installed"** — Run `pip install mss Pillow`

**"pyautogui not installed"** — Run `pip install pyautogui`

**Screenshot is black** — Some apps use hardware acceleration. Try capturing a region instead of full screen.

**Command times out** — Increase `terminal.timeout_seconds` in config.yaml.

**Backup files accumulating** — Search for `*.bak.*` files and clean up periodically.

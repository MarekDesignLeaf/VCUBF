---
name: computer-control
description: >
  This skill should be used whenever the user asks to "control my computer",
  "automate a task on my PC", "manage my Windows machine", "take a screenshot",
  "click something on screen", "open a program", "run a command", or any
  request that involves interacting with the Windows operating system, desktop,
  files, applications, or terminal. Also use when the user asks about what the
  plugin can do or how to use it safely.
metadata:
  version: "0.1.0"
---

# PC Control — Overview and Safety Guidelines

This plugin gives Claude secure, audited access to the Windows computer. Every action goes through a three-tier safety system and is written to an audit log.

## Safety Model

Every tool call is classified before execution:

| Level | Examples | Behaviour |
|-------|----------|-----------|
| **SAFE** | Screenshots, reading files, listing processes | Executes immediately |
| **SENSITIVE** | Clicking, typing, launching apps, writing files | Requires user confirmation |
| **DESTRUCTIVE** | Deleting files, force-killing processes, destructive shell commands | Requires explicit confirmation with impact description |

Before calling any SENSITIVE or DESTRUCTIVE tool, tell the user what you are about to do and why. Wait for their acknowledgment.

## Modes

- **Read-only mode**: Only SAFE tools execute. Set `security.mode: readonly` in config.yaml.
- **Active mode**: All tools available (default).
- **Dry-run mode**: Set `security.dry_run: true` in config.yaml or pass `dry_run=True` to `run_command` to preview without executing.

## Core Workflow

1. **Understand the task** — clarify with the user if the goal is ambiguous.
2. **Take a screenshot** (`take_screenshot`) to see current screen state before any GUI interaction.
3. **Identify targets** — read coordinates, window titles, or file paths from the screenshot or by listing windows/files.
4. **Announce intent** — tell the user exactly what you will do before doing it.
5. **Execute** — call the appropriate tool.
6. **Verify** — take another screenshot or read output to confirm success.
7. **Recover** — if something goes wrong, restore from backup or undo.

## Available Tool Groups

- **System**: `get_system_status`, `get_processes`, `list_windows`, `focus_window`
- **Files**: `list_files`, `read_file`, `write_file`, `copy_file`, `move_file`, `delete_file`, `create_directory`, `search_files`, `create_backup`, `restore_backup`
- **Applications**: `launch_app`, `close_app`, `is_app_running`, `open_project`
- **GUI**: `take_screenshot`, `click`, `type_text`, `type_text_fast`, `press_keys`, `scroll`, `move_mouse`, `get_mouse_position`
- **Terminal**: `run_command`, `start_process`, `read_terminal_output`, `analyse_build_error`
- **Audit**: `get_audit_log`

## Rules — Always Follow

- Never execute DESTRUCTIVE actions without first telling the user the exact impact.
- Never delete files permanently (`permanent=True`) without explicit confirmation.
- Before editing any file, call `create_backup` first.
- Before running terminal commands, use `dry_run=True` to preview.
- Never store passwords, tokens, or API keys in files or pass them through tools.
- Never transmit data outside the local machine.
- If unsure about the user's intent, ask before acting.

See `references/tool-reference.md` for full parameter documentation.
See `references/workflows.md` for step-by-step workflow guides.

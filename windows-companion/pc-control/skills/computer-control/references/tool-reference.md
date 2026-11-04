# Tool Reference

## System Tools

### `get_system_status`
No parameters. Returns OS version, CPU usage, RAM, all disks, uptime, username.

### `get_processes(name_filter="")`
- `name_filter`: substring to filter process names (optional)
Returns list of: pid, name, status, cpu_percent, mem_mb, username.

### `list_windows()`
No parameters. Returns all visible top-level windows with hwnd, title, pid, is_active.

### `focus_window(hwnd=None, title_contains="")`
- `hwnd`: window handle integer (from list_windows)
- `title_contains`: substring to match (used if hwnd not provided)

---

## File Tools

### `list_files(directory, pattern="*", recursive=False)`
- `directory`: full path to directory
- `pattern`: glob pattern (e.g. "*.py", "*.txt")
- `recursive`: search subdirectories

### `read_file(path, encoding="utf-8")`
Returns `content` string. Max 5 MB by default (configure max_inline_read_mb).

### `write_file(path, content, encoding="utf-8")`
Auto-creates parent directories. Auto-backs up existing file to `.bak.TIMESTAMP`.
Returns `backup` path.

### `copy_file(source, destination)`
Copies file or entire directory tree.

### `move_file(source, destination)` ⚠️ DESTRUCTIVE
Moves/renames. Creates backup of source first.

### `delete_file(path, permanent=False)` ⚠️ DESTRUCTIVE
- `permanent=False` (default): moves to `_deleted_/` subfolder (recoverable)
- `permanent=True`: irreversible — require explicit user consent

### `create_directory(path)`
Creates directory and all parents.

### `search_files(root, pattern, content_search="")`
Recursively finds files matching glob. Optionally filters by content substring.

### `create_backup(path)`
Creates `filename.ext.bak.TIMESTAMP` copy.

### `restore_backup(backup_path, target_path)` ⚠️ DESTRUCTIVE
Overwrites target with backup. Backs up current target first.

---

## Application Tools

### `launch_app(name, args="", working_dir="")`
Known aliases: chrome, edge, vscode, notepad, explorer, word, excel, outlook,
powershell, terminal, android studio, calculator, cmd.
Or pass full executable path.

### `close_app(name="", pid=None, force=False)` ⚠️ DESTRUCTIVE if force=True
- `force=True` kills without saving — DESTRUCTIVE

### `is_app_running(name)`
Returns `running: bool` and list of matching instances.

### `open_project(project_path, editor="auto")`
Auto-detects: flutter, android, nodejs, python, dotnet, rust, go, java.
Opens in VS Code by default; Android Studio for Android projects.

---

## GUI Tools

### `take_screenshot(region=None)`
- `region`: `{"left": x, "top": y, "width": w, "height": h}` (optional)
Returns base64-encoded PNG. Always call this before GUI interactions.

### `click(x, y, button="left", double=False)`
- `button`: "left" | "right" | "middle"
- `double`: double-click

### `type_text(text, interval=0.02)`
Types character-by-character. Use for short strings.

### `type_text_fast(text)`
Pastes via clipboard. Better for long text.

### `press_keys(keys)`
Examples: `"ctrl+c"`, `"alt+f4"`, `"ctrl+a,ctrl+c"`, `"enter"`, `"escape"`, `"win+d"`.
Comma-separated for sequential combos.

### `scroll(x, y, clicks=3, direction="down")`
- `direction`: "up" | "down"

### `get_mouse_position()`
Returns current `x, y` coordinates.

### `move_mouse(x, y, duration=0.2)`
Moves without clicking.

---

## Terminal Tools

### `run_command(command, shell_type="auto", timeout=None, working_dir="", dry_run=False)`
- `shell_type`: "powershell" | "cmd" | "auto"
- `timeout`: seconds (default from config, 60)
- `dry_run`: preview without executing
Returns stdout, stderr, returncode.

### `start_process(command, shell_type="auto", working_dir="")`
Starts background process. Returns `pid`.

### `read_terminal_output(pid, timeout=1.0)`
Reads buffered output from background process.

### `analyse_build_error(output)`
Parses build output, returns structured errors/warnings with file and line numbers.

---

## Audit Tool

### `get_audit_log(n=50)`
Returns last n audit entries. Each entry: ts, tool, level, params, result_summary, error.

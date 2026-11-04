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

## Browser Tools (see the browser-control skill)

### `browser_open(url, query="", new_tab=False, include_text=False)`
Opens the URL in the persistent browser; returns the snapshot: title, URL, headings and each control as
`[e12] role "name" value=… → href`. `query` keeps only matching controls; `include_text` adds the page text.

### `browser_snapshot(query="", limit=120, include_text=False)`
The current page's snapshot. Off-screen controls, open shadow DOM and iframes (`f1:e3`) are included.

### `browser_act(steps, snapshot="auto", query="")`
Runs a list of steps in one call, stops at the first failure, returns `done`, `failed`, `url`, `title`, `snapshot`.
Steps: click, dblclick, hover, fill, type, clear, select (value|label), check, uncheck, upload, press, goto, back,
forward, reload, scroll, wait_for (text|gone|url|target|state|ms). Targets: ref or locator
(role+name, text, label, placeholder, css, test_id; exact, nth). Password fields are refused.

### `browser_read(max_chars=8000)` — readable text of the page as light Markdown.
### `browser_extract(items="", fields=None, tables=False, links=False, link_filter="", limit=100)`
Fields are `"css"`, `"css@attr"` or `"@attr"`, read inside each `items` container; URLs become absolute.
### `browser_tabs(action="list", index=None, url="")` — list, new, switch, close.
### `browser_eval(expression)` — off unless `browser.allow_eval: true`.
### `browser_close()` — closes the launched browser or disconnects from the user's own.

### `web_fetch(url, max_chars=20000, include_links=False)`
Plain HTTP fetch, page as Markdown. No browser, no JavaScript.

---

## Windows App Tools (UI Automation; see the desktop-ui-control skill)

### `ui_windows()` — top-level windows: title, process, pid, hwnd.
### `ui_snapshot(window="foreground", query="", limit=150)`
`window`: "foreground", title substring, "exe:name.exe" or hwnd. Returns `[u12] Button "Save" id=…` lines and visible text.
### `ui_act(steps, window="foreground", snapshot="auto", query="")`
Steps: click, set_value, type, toggle, check, uncheck, select (item), expand, collapse, focus, keys, wait_for.
Targets: ref or `{"name", "role", "id", "class", "exact", "nth"}`.

---

## Meta

### `pc_status()` — read-only health check: version, Python, OS, packages, config, audit log folder, browser and UI Automation availability, problems with fixes.
### `pc_capabilities()` — every tool's category, level, purpose and when to use it, plus current settings.

---

## Coordinate Fallback Tools

### `take_screenshot(region=None)`
Off by default (`gui.allow_screenshots: false`); answers with a pointer to `ui_snapshot` / `browser_snapshot`.

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

---
name: file-management
description: >
  This skill should be used when the user asks to "manage files", "organize
  folders", "find a file", "read a file", "edit a file", "copy", "move",
  "rename", or "delete" files or folders on their Windows computer. Also use
  when asked to "create a backup", "restore a backup", or "search for files
  containing" specific text.
metadata:
  version: "0.1.0"
---

# File Management

## Safety Rules

- **Always create a backup before modifying any file**: call `create_backup` first.
- **Never use `permanent=True` on `delete_file` without explicit user confirmation** of the impact.
- **Check blocked paths**: System32, SysWOW64, and Windows Defender folders are blocked.
- **Soft-delete by default**: `delete_file` without `permanent=True` moves files to a `_deleted_/` recovery folder.

## Key Workflows

### Reading a file
```
list_files(directory="C:/path")      → browse structure
read_file(path="C:/path/file.txt")   → get content
```

### Editing a file
```
create_backup(path="C:/path/file.txt")          → safety copy
content = read_file(path=...)["content"]         → read current
write_file(path=..., content=<modified>)         → write new version
read_file(path=...)                              → verify
```

### Searching across a project
```
search_files(root="C:/project", pattern="*.py", content_search="TODO")
```

### Recovering a deleted file
```
list_files(directory="C:/path/_deleted_")        → find the entry
restore_backup(backup_path=..., target_path=...)  → restore
```

## Auto-Backup Behaviour

Every `write_file`, `move_file`, and `restore_backup` call automatically
creates a backup named `filename.ext.bak.YYYYMMDD_HHMMSS` before modifying
the file. These accumulate — advise the user to clean them up periodically.

## Large Files

`read_file` has a 5 MB inline limit. For larger files:
- Use `search_files` with `content_search` to locate specific lines
- Use `run_command` with `Select-String` (PowerShell) or `findstr` (CMD)

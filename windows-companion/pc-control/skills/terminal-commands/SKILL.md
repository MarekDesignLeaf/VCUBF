---
name: terminal-commands
description: >
  This skill should be used when the user asks to "run a command",
  "execute a PowerShell script", "run a CMD command", "check git status",
  "run npm install", "run a build", "run tests", "check for errors in the
  terminal", "start a dev server", or any request involving shell commands
  on their Windows computer.
metadata:
  version: "0.1.0"
---

# Terminal Commands

## Always Preview First

Before running any command, use `dry_run=True` to show the user what would be executed:

```
run_command(command="npm run build", dry_run=True)
→ Shows the command without executing it
→ User confirms → run without dry_run
```

## PowerShell (default) vs CMD

```
run_command(command="Get-ChildItem C:/", shell_type="powershell")
run_command(command="dir C:/", shell_type="cmd")
run_command(command="any command", shell_type="auto")   → uses config default (powershell)
```

## Common Tasks

```
# Check Node/npm version
run_command(command="node --version; npm --version")

# Install dependencies
run_command(command="npm install", working_dir="C:/projects/my-app")

# Run build
run_command(command="npm run build", working_dir="C:/projects/my-app")

# Git status
run_command(command="git status", working_dir="C:/projects/repo")

# List recent git commits
run_command(command="git log --oneline -10", working_dir="C:/projects/repo")

# Check running ports
run_command(command="netstat -ano | findstr LISTENING")

# Find large files
run_command(command='Get-ChildItem C:/ -Recurse | Sort-Object Length -Descending | Select-Object -First 20 | Format-Table Name,Length,FullName')
```

## Analysing Build Errors

After a build, pass the output to `analyse_build_error`:

```
result = run_command(command="npm run build", working_dir="C:/project")
analysis = analyse_build_error(output=result["stdout"] + result["stderr"])
→ returns structured errors and warnings with file/line locations
```

## Long-Running Processes

For dev servers or watchers, use `start_process` and read output incrementally:

```
handle = start_process(command="npm start", working_dir="C:/project")
pid = handle["pid"]
read_terminal_output(pid=pid, timeout=2.0)   → check startup logs
```

## Destructive Commands — Always Confirm

The following patterns are classified DESTRUCTIVE and must be confirmed by the user before execution:

`rm`, `del`, `rmdir`, `format`, `reg delete`, `reg add`, `net user`,
`diskpart`, `bcdedit`, `git reset --hard`, `git clean`, `git push --force`,
`taskkill /f`, `Stop-Process -Force`, `Remove-Item`, `wmic`

**Always explain the impact before running these.** Use `dry_run=True` to preview first.

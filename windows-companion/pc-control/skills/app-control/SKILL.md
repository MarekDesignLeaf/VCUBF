---
name: app-control
description: >
  This skill should be used when the user asks to "open an application",
  "launch a program", "close an app", "start VS Code", "open Android Studio",
  "open Chrome", "open my project", "check if a program is running", or any
  request to start or stop software on their Windows computer.
metadata:
  version: "0.1.0"
---

# Application Control

## Launching Applications

Use `launch_app` with a known alias or full executable path:

```
launch_app(name="chrome")
launch_app(name="vscode", working_dir="C:/projects/my-app")
launch_app(name="C:/Program Files/MyApp/app.exe", args="--config dev")
```

Built-in aliases: chrome, edge, firefox, vscode, notepad, notepad++,
explorer, word, excel, outlook, powershell, terminal, android studio,
calculator, paint, task manager, cmd.

## Opening a Project

`open_project` auto-detects the project type and picks the right editor:

```
open_project(project_path="C:/projects/my-flutter-app")
→ detects Flutter → opens in VS Code

open_project(project_path="C:/projects/android-app")
→ detects Android → opens in Android Studio
```

Override the editor: `open_project(project_path=..., editor="vscode")`

Detectable project types: flutter, android, nodejs, python, dotnet, rust, go, java, generic.

## Closing Applications

```
is_app_running(name="chrome")           → check first
close_app(name="chrome")                → graceful terminate
close_app(pid=1234, force=True)         → DESTRUCTIVE: force-kill (confirm first)
```

Force-killing (`force=True`) is classified as DESTRUCTIVE — always confirm with the user first and warn that unsaved data may be lost.

## After Launch

After launching an app, call `ui_snapshot(window="exe:<name>.exe")` to confirm the window appeared and read its controls as text; then act with `ui_act` (see the desktop-ui-control skill). Screenshots are off by default.

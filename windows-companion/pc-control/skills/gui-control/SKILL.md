---
name: gui-control
description: >
  This skill should be used when the user asks to "click on something",
  "take a screenshot", "type text into an app", "press a keyboard shortcut",
  "scroll down", "move the mouse", or any request involving visual interaction
  with the screen, mouse, or keyboard on their Windows computer.
metadata:
  version: "0.1.0"
---

# GUI Control

## The Screenshot-First Rule

**Always take a screenshot before any click or keyboard action.**
This ensures you know the current screen state and can identify correct coordinates.

```
take_screenshot()   → returns base64 PNG; examine it carefully
```

For a specific region: `take_screenshot(region={"left": 0, "top": 0, "width": 800, "height": 600})`

## Click Workflow

```
1. take_screenshot()             → identify target coordinates
2. focus_window(title_contains=<app name>)
3. take_screenshot()             → confirm window is active
4. click(x=<x>, y=<y>)
5. take_screenshot()             → verify the click had the expected effect
```

## Keyboard Shortcuts

```
press_keys("ctrl+c")             → copy
press_keys("ctrl+v")             → paste
press_keys("ctrl+z")             → undo
press_keys("alt+f4")             → close window
press_keys("win+d")              → show desktop
press_keys("ctrl+a,ctrl+c")      → select all, then copy (sequential)
press_keys("enter")              → press Enter
press_keys("escape")             → press Escape
press_keys("tab")                → Tab
press_keys("ctrl+shift+p")       → VS Code command palette
```

## Typing Text

Short strings (under ~100 chars): `type_text(text="hello world")`
Long strings or special characters: `type_text_fast(text="long content...")` (uses clipboard)

## Scrolling

```
scroll(x=960, y=540, clicks=3, direction="down")   → scroll down in the middle of screen
scroll(x=960, y=540, clicks=5, direction="up")     → scroll back up
```

## Safety Considerations

- **Failsafe is enabled by default**: moving the mouse to the top-left corner aborts automation.
- **Pause between actions**: the plugin inserts a 100ms pause between GUI calls to reduce race conditions.
- **After every action**: take a screenshot to verify the result before proceeding.
- **If something goes wrong**: press `press_keys("escape")` or `press_keys("ctrl+z")` to undo.

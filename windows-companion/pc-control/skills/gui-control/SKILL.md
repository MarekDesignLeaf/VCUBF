---
name: gui-control
description: >
  Fallback only. Use when a control cannot be reached by ui_act or
  browser_act (custom-drawn canvases, games, apps without UI Automation), when
  the user explicitly asks for a screenshot, or to move the mouse or press a
  shortcut in the focused window. For normal app and web work use the
  desktop-ui-control and browser-control skills.
metadata:
  version: "0.2.1"
---

# GUI Control — coordinate fallback

Use these tools only when `ui_snapshot` / `browser_snapshot` cannot see the
control. They work on screen coordinates, which are slow to obtain and break
when windows move.

## Screenshots are off by default

`take_screenshot` answers with an error unless `gui.allow_screenshots: true` is
set in `server/config.yaml`. Read windows with `ui_snapshot` and pages with
`browser_snapshot` instead: they return the controls as text with refs.

## Keyboard shortcuts

```
press_keys("ctrl+c")             → copy
press_keys("ctrl+v")             → paste
press_keys("ctrl+z")             → undo
press_keys("alt+f4")             → close window
press_keys("ctrl+a,ctrl+c")      → select all, then copy (sequential)
press_keys("enter") / ("escape") / ("tab")
```

`ui_act(window=..., steps=[{"keys": "ctrl+s"}])` does the same for a named
window without focusing it by hand.

## Typing text

`ui_act` with `{"type": true, "value": "..."}` pastes into the focused control
and keeps diacritics. `type_text` types ASCII key by key; `type_text_fast`
pastes through the clipboard.

## Coordinates

`click(x, y)`, `scroll(x, y, …)`, `move_mouse(x, y)` need coordinates you
already know (a fixed layout the user described). Failsafe is enabled: moving
the mouse to the top-left corner aborts automation.

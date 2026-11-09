---
name: gui-control
description: >
  Use only with coordinates the user gave, for a control ui_act or
  browser_act cannot reach (custom-drawn canvases, games, apps without UI
  Automation), to press a shortcut in the focused window, or to capture a
  picture the user explicitly asked for. Never screenshot-driven. For normal app and web work use the
  desktop-ui-control and browser-control skills.
metadata:
  version: "0.2.1"
---

# GUI Control — coordinates the user gave, never screenshots

Control works only from text state (`ui_snapshot`, `browser_snapshot`). The
coordinate tools take only coordinates the user gave, for a control UI
Automation cannot reach; they break when windows move. Never read coordinates
off a screenshot.

## Screenshots never drive control

`take_screenshot` is off unless `gui.allow_screenshots: true` is set in
`server/config.yaml`, and even then it only captures a picture the user
explicitly asked for. Never take one to find, click, read or check a control,
and never fall back to one when a snapshot cannot see something; nothing acts
on what it shows. Read windows with `ui_snapshot` and pages with
`browser_snapshot`: they return the controls as text with refs.

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

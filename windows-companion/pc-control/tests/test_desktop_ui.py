"""Windows UI Automation logic against a fake control tree (no Windows, no screen).

This proves the tree reading, refs, locators and the pattern-first actions; it
is not an acceptance on a real Windows desktop.
"""
import unittest

import _env  # noqa: F401

from pc_engine import (
    Engine, UiError, UiSession, activate, find_control, find_window, parse_ui_steps,
    redact_ui_steps, run_ui_steps, snapshot_window,
)


class FakeNode:
    def __init__(self, control_type, name="", automation_id="", patterns=(), value=None, toggle="off",
                 children=(), enabled=True, offscreen=False):
        self.control_type, self.name, self.automation_id, self.class_name = control_type, name, automation_id, ""
        self._patterns = set(patterns)
        self._value, self._toggle, self._expanded, self._selected = value, toggle, False, False
        self._children, self._enabled, self._offscreen = list(children), enabled, offscreen
        self.calls = []

    def key(self): return (id(self),)
    def children(self): return self._children
    def patterns(self): return self._patterns
    def value(self): return self._value
    def toggle_state(self): return self._toggle if "toggle" in self._patterns else None
    def expanded(self): return self._expanded
    def selected(self): return self._selected
    def enabled(self): return self._enabled
    def offscreen(self): return self._offscreen
    def invoke(self): self.calls.append("invoke")
    def toggle(self):
        self.calls.append("toggle")
        self._toggle = "on" if self._toggle == "off" else "off"
    def set_value(self, text):
        self.calls.append(("set_value", text))
        self._value = text
    def select(self):
        self.calls.append("select")
        self._selected = True
    def expand(self):
        self.calls.append("expand")
        self._expanded = True
    def collapse(self):
        self.calls.append("collapse")
        self._expanded = False
    def focus(self): self.calls.append("focus")
    def click(self): self.calls.append("click")


def save_dialog():
    name = FakeNode("Edit", "Název souboru:", "1001", patterns={"value"}, value="")
    kind = FakeNode("ComboBox", "Uložit jako typ:", "FileTypeControlHost", patterns={"expand_collapse", "value"}, value="Text (*.txt)",
                    children=[FakeNode("ListItem", "Text (*.txt)", patterns={"selection_item"}),
                              FakeNode("ListItem", "Všechny soubory (*.*)", patterns={"selection_item"})])
    utf = FakeNode("CheckBox", "Kódování UTF-8", patterns={"toggle"})
    save = FakeNode("Button", "Uložit", "1", patterns={"invoke"})
    cancel = FakeNode("Button", "Storno", "2", patterns={"invoke"})
    custom = FakeNode("Custom", "Plátno")  # no pattern: physical click fallback
    hidden = FakeNode("Button", "Skryté", offscreen=True, patterns={"invoke"})
    disabled = FakeNode("Button", "Nápověda", patterns={"invoke"}, enabled=False)
    pane = FakeNode("Pane", "", children=[name, kind, utf, FakeNode("Text", "Složka: Dokumenty"), custom, hidden, disabled])
    window = FakeNode("Window", "Uložit jako", children=[pane, save, cancel])
    return window, {"name": name, "kind": kind, "utf": utf, "save": save, "cancel": cancel, "custom": custom, "disabled": disabled}


class FakeBackend:
    def __init__(self):
        self.window, self.nodes = save_dialog()
        self.notepad = FakeNode("Window", "Bez názvu – Poznámkový blok")
        self.keys, self.typed = [], []

    def windows(self): return [self.notepad, self.window]
    def foreground(self): return self.window
    def window_by_handle(self, hwnd): return self.window if hwnd == 42 else None
    def window_info(self, node):
        return {"title": node.name, "process": "notepad.exe", "pid": 7, "hwnd": 42 if node is self.window else 43}
    def send_keys(self, keys): self.keys.append(keys)
    def type_text(self, text): self.typed.append(text)


class Snapshot(unittest.TestCase):
    def test_lists_controls_with_refs_values_and_states_and_skips_offscreen(self):
        window, nodes = save_dialog()
        session = UiSession()
        data = snapshot_window(session, window)
        names = [item["name"] for item in data["elements"]]
        self.assertEqual(names, ["Název souboru:", "Uložit jako typ:", "Text (*.txt)", "Všechny soubory (*.*)", "Kódování UTF-8", "Plátno", "Nápověda", "Uložit", "Storno"])
        self.assertNotIn("Skryté", names)
        self.assertEqual(data["texts"], ["Složka: Dokumenty"])
        utf = next(item for item in data["elements"] if item["name"] == "Kódování UTF-8")
        self.assertEqual(utf["toggle"], "off")
        self.assertTrue(next(item for item in data["elements"] if item["name"] == "Nápověda")["disabled"])
        # The same control keeps its ref.
        again = snapshot_window(session, window)
        self.assertEqual([item["ref"] for item in data["elements"]], [item["ref"] for item in again["elements"]])

    def test_query_narrows_to_matching_controls(self):
        window, _ = save_dialog()
        data = snapshot_window(UiSession(), window, query="uložit")
        self.assertEqual([item["name"] for item in data["elements"]], ["Uložit jako typ:", "Uložit"])

    def test_formatted_snapshot_through_the_service(self):
        backend = FakeBackend()
        engine = Engine(ui_backend_factory=lambda: backend)
        result = engine.call("ui_snapshot", {"window": "Uložit jako"})
        self.assertTrue(result["success"])
        self.assertIn('Window: Uložit jako  [notepad.exe pid=7 hwnd=42]', result["snapshot"])
        self.assertRegex(result["snapshot"], r'\[u\d+\] Edit "Název souboru:" id=1001 value=""')
        self.assertRegex(result["snapshot"], r'\[u\d+\] Button "Uložit" id=1')


class Windows(unittest.TestCase):
    def test_finds_by_foreground_title_process_and_handle(self):
        backend = FakeBackend()
        self.assertIs(find_window(backend, "foreground"), backend.window)
        self.assertIs(find_window(backend, "poznámkový"), backend.notepad)
        self.assertIs(find_window(backend, "exe:notepad.exe"), backend.notepad)
        self.assertIs(find_window(backend, "42"), backend.window)
        with self.assertRaises(UiError) as caught:
            find_window(backend, "Excel")
        self.assertIn("Open windows:", str(caught.exception))


class Acting(unittest.TestCase):
    def setUp(self):
        self.backend = FakeBackend()
        self.window, self.nodes = self.backend.window, self.backend.nodes
        self.session = UiSession()

    def run_steps(self, steps):
        return run_ui_steps(self.backend, self.session, self.window, parse_ui_steps(steps), sleep=lambda _: None)

    def test_fills_selects_checks_and_saves_through_patterns_in_one_batch(self):
        done, failure = self.run_steps([
            {"set_value": {"name": "Název souboru"}, "value": "nabídka-Novák.txt"},
            {"select": {"name": "Uložit jako typ"}, "item": "Všechny soubory (*.*)"},
            {"check": {"name": "UTF-8", "role": "CheckBox"}},
            {"check": {"name": "UTF-8"}},
            {"click": {"name": "Uložit", "role": "Button", "exact": True}},
        ])
        self.assertIsNone(failure, failure)
        self.assertEqual(self.nodes["name"].calls, [("set_value", "nabídka-Novák.txt")])
        self.assertEqual(self.nodes["kind"].children()[1].calls, ["select"])
        self.assertEqual(self.nodes["utf"].calls, ["toggle"], "check twice toggles once")
        self.assertEqual(self.nodes["save"].calls, ["invoke"])
        self.assertEqual(self.nodes["cancel"].calls, [])
        self.assertEqual(len(done), 5)

    def test_uses_refs_from_the_snapshot(self):
        data = snapshot_window(self.session, self.window)
        save_ref = next(item["ref"] for item in data["elements"] if item["name"] == "Uložit")
        done, failure = self.run_steps([{"click": save_ref}])
        self.assertIsNone(failure)
        self.assertEqual(self.nodes["save"].calls, ["invoke"])

    def test_physical_click_only_without_a_pattern(self):
        self.assertEqual(activate(self.nodes["custom"]), "clicked")
        self.assertEqual(self.nodes["custom"].calls, ["click"])

    def test_keys_and_typing_go_through_the_backend(self):
        done, failure = self.run_steps([{"keys": "ctrl+s"}, {"type": True, "value": "Příliš žluťoučký kůň"}])
        self.assertIsNone(failure)
        self.assertEqual(self.backend.keys, ["ctrl+s"])
        self.assertEqual(self.backend.typed, ["Příliš žluťoučký kůň"])

    def test_stops_at_the_first_failure_and_reports_it(self):
        done, failure = self.run_steps([{"click": {"name": "Storno"}}, {"click": {"name": "Nápověda"}}, {"click": {"name": "Uložit"}}])
        self.assertEqual(len(done), 1)
        self.assertEqual(failure["step"], 2)
        self.assertIn("disabled", failure["error"])
        self.assertEqual(self.nodes["save"].calls, [])

    def test_wait_for_times_out_cleanly(self):
        done, failure = self.run_steps([{"wait_for": {"name": "Hotovo"}, "timeout_ms": 100}])
        self.assertIn("timed out", failure["error"])

    def test_unknown_ref_and_bad_steps_are_refused(self):
        with self.assertRaises(UiError):
            find_control(self.session, self.window, "u999")
        for raw in ([{"click": "Uložit"}], [{"set_value": "u1"}], [{"wait_for": "u1"}], [{"click": {"title": "x"}}], []):
            with self.subTest(raw=raw), self.assertRaises(UiError):
                parse_ui_steps(raw)

    def test_redacts_typed_text(self):
        self.assertEqual(redact_ui_steps([{"set_value": "u1", "value": "heslo"}, {"click": "u2"}]),
                         [{"set_value": "u1", "value": "<5 chars>"}, {"click": "u2"}])

    def test_act_through_the_service_returns_a_fresh_snapshot(self):
        engine = Engine(ui_backend_factory=lambda: self.backend)
        result = engine.call("ui_act", {"steps": [{"click": {"name": "Uložit", "exact": True}}], "window": "Uložit jako"})
        self.assertTrue(result["success"], result)
        self.assertIn("Window: Uložit jako", result["snapshot"])


if __name__ == "__main__":
    unittest.main()

"""The browser step language: a malformed plan is refused whole, before any browser action."""
import unittest

import _env  # noqa: F401

from browser.steps import StepError, format_element, format_snapshot, parse_steps, redact_steps


class ParseSteps(unittest.TestCase):
    def test_accepts_refs_locators_and_every_operation(self):
        steps = parse_steps([
            {"fill": "e3", "value": "Jan Novák"},
            {"type": {"placeholder": "Hledat"}, "value": "trávník"},
            {"select": "e5", "label": "Sekání trávy"},
            {"select": "e5", "value": "lawn"},
            {"check": {"label": "Souhlasím s podmínkami"}},
            {"click": {"role": "button", "name": "Odeslat", "exact": True}},
            {"click": "f1:e2"},
            {"press": "Enter"},
            {"press": "Control+A", "target": "e3"},
            {"wait_for": {"text": "přijata"}, "timeout_ms": 3000},
            {"wait_for": {"state": "networkidle"}},
            {"wait_for": {"target": {"css": "#result"}}},
            {"scroll": "bottom"},
            {"goto": "https://example.org/"},
            {"back": True},
            {"upload": "e9", "files": ["C:/faktura.pdf"]},
        ])
        self.assertEqual([step.op for step in steps][:6], ["fill", "type", "select", "select", "check", "click"])
        self.assertEqual(steps[0].target.ref, "e3")
        self.assertEqual(steps[2].extra["by"], "label")
        self.assertEqual(steps[3].extra["by"], "value")
        self.assertEqual(steps[6].target.ref, "f1:e2")
        self.assertEqual(steps[9].extra, {"timeout_ms": 3000, "kind": "text"})

    def test_refuses_bad_plans_with_the_step_number(self):
        cases = [
            ([], "non-empty"),
            ([{"click": "Odeslat"}], "not a snapshot ref"),
            ([{"click": "e1", "fill": "e2"}], "exactly one operation"),
            ([{"fill": "e1"}], "needs value"),
            ([{"click": {"text": "a", "css": "b"}}], "exactly one of"),
            ([{"click": {"text": "a", "name": "b"}}], "only used with role"),
            ([{"goto": "javascript:alert(1)"}], "http"),
            ([{"wait_for": {"ms": 60000}}], "prefer waiting"),
            ([{"wait_for": {"text": "a", "ms": 5}}], "one condition"),
            ([{"click": "e1", "force": True}], "unknown keys"),
            ([{"click": "e1"}] * 41, "at most 40"),
            ([{"click": "e1"}, {"select": "e2"}], "step 2"),
        ]
        for raw, message in cases:
            with self.subTest(raw=raw[:2]):
                with self.assertRaises(StepError) as caught:
                    parse_steps(raw)
                self.assertIn(message, str(caught.exception))

    def test_redacts_typed_text_for_the_audit_log(self):
        redacted = redact_steps([{"fill": "e3", "value": "tajné"}, {"click": "e4"}])
        self.assertEqual(redacted, [{"fill": "e3", "value": "<5 chars>"}, {"click": "e4"}])


class FormatSnapshot(unittest.TestCase):
    def test_one_compact_line_per_control(self):
        self.assertEqual(format_element({"ref": "e2", "role": "button", "name": "Odeslat"}), '[e2] button "Odeslat"')
        self.assertEqual(
            format_element({"ref": "e3", "role": "textbox", "name": "Jméno", "value": "", "required": True}),
            '[e3] textbox "Jméno" value="" required')
        self.assertEqual(
            format_element({"ref": "e4", "role": "combobox", "name": "Služba", "value": "–", "options": ["–", "Sekání"], "moreOptions": 3}),
            '[e4] combobox "Služba" value="–" options=[– | Sekání +3]')
        self.assertEqual(format_element({"ref": "e5", "role": "checkbox", "name": "OK", "checked": False}), '[e5] checkbox "OK" not-checked')
        self.assertEqual(format_element({"ref": "e6", "role": "link", "name": "Ceník", "href": "/cenik"}), '[e6] link "Ceník" → /cenik')

    def test_says_when_controls_were_left_out(self):
        text = format_snapshot([{"url": "https://a/", "title": "A", "headings": ["# A"], "elements": [{"ref": "e1", "role": "button", "name": "X"}], "total": 9}])
        self.assertIn("Controls: 1 shown of 9 (narrow with query=...)", text)
        self.assertIn("Headings: # A", text)


if __name__ == "__main__":
    unittest.main()

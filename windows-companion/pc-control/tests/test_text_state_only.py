"""The owner's rule: no control through screenshots.

Every control path works from text state (browser_snapshot, ui_snapshot). A
screenshot only captures a picture the user explicitly asked for; it never
drives a control loop and is never a fallback. This checks every text an AI
reads: the generated MCP instructions, each tool's description, the skills
and the README.
"""
import asyncio
import re
import unittest

import _env

import main
import pc_engine
from registry import REGISTRY, instructions

PLUGIN = _env.SERVER.parent
# A sentence that mentions screenshots must say they are not used, are off, or
# are only for a picture the user explicitly asked for.
ALLOWED = re.compile(r"\b(never|not|no|without|off|explicitly|nothing acts)\b", re.IGNORECASE)
# Wording that would make a screenshot part of control.
DRIVES_CONTROL = re.compile(
    r"screenshot[^.\n]*\b(fallback|last resort|to verify|to check|to find|to locate|cannot see|if .* fails)\b"
    r"|\b(fallback|last resort)\b[^.\n]*screenshot",
    re.IGNORECASE,
)


IDENTIFIER = re.compile(r"`?\b\w*_screenshots?\w*\b`?(\([^)]*\))?`?", re.IGNORECASE)


def sentences(text: str):
    """Sentences, with wrapped lines of one paragraph or list item joined, and table rows apart."""
    blocks, current = [], []
    for line in text.splitlines():
        stripped = line.strip()
        starts_new = not stripped or stripped.startswith(("|", "#", "- ", "* ", "```")) or re.match(r"\d+\. ", stripped)
        if starts_new and current:
            blocks.append(" ".join(current))
            current = []
        if stripped:
            current.append(stripped)
        if stripped.startswith(("|", "#")):
            blocks.append(" ".join(current))
            current = []
    if current:
        blocks.append(" ".join(current))
    parts = []
    for block in blocks:
        parts.extend(part.strip() for part in re.split(r"(?<=[.!?])\s+", block) if part.strip())
    # A tool or setting name (take_screenshot, allow_screenshots) is not a statement about screenshots.
    return [IDENTIFIER.sub("", part) for part in parts]


def check(case: unittest.TestCase, where: str, text: str):
    for sentence in sentences(text):
        if "screenshot" not in sentence.lower():
            continue
        with case.subTest(where=where, sentence=sentence[:120]):
            case.assertRegex(sentence, ALLOWED, "a screenshot may be named only to say it is not used for control")
            if DRIVES_CONTROL.search(sentence):
                case.assertRegex(sentence, re.compile(r"\b(never|not|no)\b", re.IGNORECASE),
                                 "a screenshot is never a fallback or a way to find or check a control")


class TextStateOnly(unittest.TestCase):
    def test_the_generated_instructions_state_the_rule(self):
        text = instructions("test")
        self.assertIn("Control works only from text state", text)
        self.assertIn("never fall back to one when a snapshot cannot see something", text)
        check(self, "instructions", text)

    def test_no_tool_description_makes_a_screenshot_part_of_control(self):
        for tool in asyncio.run(main.mcp.list_tools()):
            check(self, tool.name, tool.description or "")

    def test_take_screenshot_is_only_for_a_picture_the_user_asked_for(self):
        spec = REGISTRY["take_screenshot"]
        self.assertEqual(spec.category, "image")
        self.assertIn("explicitly asks", spec.use_when)
        self.assertIn("never as a fallback", spec.use_when)
        # Coordinate tools never take coordinates from a screenshot.
        for name in ("click", "scroll", "move_mouse"):
            self.assertIn("never", REGISTRY[name].use_when, name)

    def test_the_engine_has_no_image_tool(self):
        for spec in pc_engine.TOOLS.values():
            with self.subTest(tool=spec.name):
                self.assertNotRegex(spec.name, r"screenshot|image|camera|photo")
                check(self, spec.name, f"{spec.summary} {spec.use_when}")

    def test_skills_and_readme_never_make_a_screenshot_part_of_control(self):
        files = sorted((PLUGIN / "skills").rglob("*.md")) + [PLUGIN / "README.md"]
        self.assertTrue(files)
        for path in files:
            check(self, str(path.relative_to(PLUGIN)), path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()

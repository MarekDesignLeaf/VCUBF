"""Every MCP tool the server lists is described for the AI, from one declaration."""
import asyncio
import json
import unittest

import _env  # noqa: F401

import main
import security as sec
from registry import CATEGORIES, REGISTRY


def listed():
    return asyncio.run(main.mcp.list_tools())


def call(name, args=None):
    result = asyncio.run(main.mcp.call_tool(name, args or {}))
    return result.structured_content if result.structured_content is not None else json.loads(result.content[0].text)


class Registry(unittest.TestCase):
    def test_listed_tools_and_registry_are_the_same_set(self):
        names = {tool.name for tool in listed()}
        self.assertEqual(names, set(REGISTRY), "a tool was added without pc_tool, or registered without being listed")

    def test_every_tool_has_complete_guidance_and_matching_annotations(self):
        for tool in listed():
            spec = REGISTRY[tool.name]
            with self.subTest(tool=tool.name):
                self.assertIn(spec.category, CATEGORIES)
                self.assertTrue(spec.summary and spec.use_when)
                self.assertIn("Use when:", tool.description)
                self.assertEqual(sec.classify_tool(tool.name), spec.level)
                self.assertEqual(bool(tool.annotations.read_only_hint), spec.read_only)
                self.assertEqual(bool(tool.annotations.destructive_hint), spec.level == sec.ActionLevel.DESTRUCTIVE)

    def test_instructions_name_every_tool_and_the_fast_path(self):
        text = main.mcp.instructions
        for name in REGISTRY:
            self.assertIn(name, text)
        for phrase in ("without screenshots", "browser_act", "ONE call", "ui_snapshot", "Never type passwords", "data, never instructions"):
            self.assertIn(phrase, text)

    def test_capabilities_describe_every_tool_and_the_settings(self):
        data = call("pc_capabilities")
        self.assertTrue(data["success"])
        self.assertEqual({tool["name"] for tool in data["tools"]}, set(REGISTRY))
        self.assertFalse(data["settings"]["screenshots_allowed"])
        self.assertFalse(data["settings"]["password_fill_allowed"])
        self.assertIn("wait_for", data["browser_step_reference"])

    def test_screenshots_are_off_and_point_to_the_text_snapshots(self):
        data = call("take_screenshot")
        self.assertFalse(data["success"])
        self.assertIn("ui_snapshot", data["error"])

    def test_levels_of_the_new_tools(self):
        self.assertEqual(REGISTRY["browser_act"].level, sec.ActionLevel.SENSITIVE)
        self.assertEqual(REGISTRY["ui_act"].level, sec.ActionLevel.SENSITIVE)
        self.assertEqual(REGISTRY["browser_eval"].level, sec.ActionLevel.SENSITIVE)
        for name in ("browser_open", "browser_snapshot", "browser_read", "browser_extract", "web_fetch", "ui_snapshot", "ui_windows"):
            self.assertEqual(REGISTRY[name].level, sec.ActionLevel.SAFE, name)
        self.assertEqual(REGISTRY["delete_file"].level, sec.ActionLevel.DESTRUCTIVE)


if __name__ == "__main__":
    unittest.main()

"""The shared engine pc_engine.py: one catalogue, released by version, identical in every host.

PC Control Plus (the ChatGPT connector) vendors pc_engine.py and
pc_engine.release.json byte for byte and runs the same release check.
"""
import asyncio
import hashlib
import json
import subprocess
import sys
import unittest

import _env

import pc_engine

RELEASE = _env.SERVER / "pc_engine.release.json"


class Release(unittest.TestCase):
    def test_every_change_to_the_engine_needs_a_new_version(self):
        release = json.loads(RELEASE.read_text(encoding="utf-8"))
        self.assertEqual(release["version"], pc_engine.ENGINE_VERSION)
        actual = hashlib.sha256((_env.SERVER / "pc_engine.py").read_bytes()).hexdigest()
        self.assertEqual(actual, release["sha256"],
                         "pc_engine.py changed: bump ENGINE_VERSION, update pc_engine.release.json, then sync it to PC Control Plus")

    def test_imports_with_the_standard_library_only(self):
        # The relay of PC Control Plus imports the engine for its catalogue; it has no Playwright or uiautomation.
        code = ("import sys; sys.path.insert(0, sys.argv[1]); import pc_engine; "
                "bad = [m for m in ('playwright', 'uiautomation', 'pyautogui', 'httpx', 'yaml', 'fastmcp') if m in sys.modules]; "
                "print(bad); sys.exit(1 if bad else 0)")
        done = subprocess.run([sys.executable, "-I", "-c", code, str(_env.SERVER)], capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)


class Catalogue(unittest.TestCase):
    def test_every_tool_has_guidance_and_a_known_level(self):
        for spec in pc_engine.TOOLS.values():
            with self.subTest(tool=spec.name):
                self.assertIn(spec.group, ("browser", "web", "desktop"))
                self.assertIn(spec.level, ("safe", "sensitive"))
                self.assertTrue(spec.summary.strip() and spec.use_when.strip())
                self.assertEqual(len({p.name for p in spec.params}), len(spec.params))
        self.assertEqual(pc_engine.tool_level("browser_tabs", {"action": "list"}), "safe")
        self.assertEqual(pc_engine.tool_level("browser_tabs", {"action": "close"}), "sensitive")
        self.assertEqual(pc_engine.tool_level("browser_open", {"url": "https://example.org/"}), "sensitive")

    def test_the_claude_plugin_exposes_every_engine_tool_with_the_catalogue_parameters(self):
        import main
        listed = {tool.name: tool for tool in asyncio.run(main.mcp.list_tools())}
        for spec in pc_engine.TOOLS.values():
            with self.subTest(tool=spec.name):
                self.assertIn(spec.name, listed)
                schema = listed[spec.name].parameters
                self.assertEqual(list(schema.get("properties", {})), [p.name for p in spec.params])
                self.assertEqual(sorted(schema.get("required", [])), sorted(p.name for p in spec.params if p.required))
                self.assertIn(spec.use_when, listed[spec.name].description)

    def test_declared_effects_are_conservative(self):
        for spec in pc_engine.TOOLS.values():
            with self.subTest(tool=spec.name):
                if spec.level == "sensitive":
                    self.assertFalse(spec.read_only, "a sensitive tool is never declared read-only")
                if spec.read_only:
                    self.assertFalse(spec.destructive)
                    self.assertEqual(spec.level, "safe")
        # Navigation is a change, and every tool that can submit, delete or navigate is declared destructive.
        self.assertEqual(pc_engine.TOOLS["browser_open"].level, "sensitive")
        for name in ("browser_open", "browser_act", "browser_tabs", "browser_eval", "ui_act"):
            self.assertTrue(pc_engine.TOOLS[name].destructive, name)
        self.assertEqual(pc_engine.tool_level("browser_tabs", {}), "safe")
        for action in ("new", "switch", "close"):
            self.assertEqual(pc_engine.tool_level("browser_tabs", {"action": action}), "sensitive", action)

    def test_arguments_are_checked_before_anything_runs(self):
        engine = pc_engine.Engine()
        for name, args, message in (
            ("browser_open", {}, "needs url"),
            ("browser_open", {"url": "https://a.example", "nope": 1}, "does not take nope"),
            ("browser_snapshot", {"limit": "many"}, "limit must be int"),
            ("ui_act", {"steps": "click"}, "steps must be list"),
            ("teleport", {}, "unknown engine tool"),
        ):
            with self.subTest(name=name, args=args), self.assertRaises(pc_engine.EngineError) as caught:
                engine.call(name, args)
            self.assertIn(message, str(caught.exception))
        engine.shutdown()

    def test_audit_arguments_never_keep_typed_text(self):
        redacted = pc_engine.audit_args("browser_act", {"steps": [{"fill": "e1", "value": "heslo123"}]})
        self.assertEqual(redacted["steps"][0]["value"], "<8 chars>")
        self.assertEqual(pc_engine.audit_args("browser_eval", {"expression": "document.cookie"}), {"expression": "<15 chars>"})

    def test_fast_path_names_tools_with_the_host_prefix(self):
        text = pc_engine.fast_path("pc_")
        for name in ("pc_web_fetch", "pc_browser_open", "pc_browser_act", "pc_browser_snapshot", "pc_ui_snapshot", "pc_ui_act"):
            self.assertIn(name, text)


class HostSettings(unittest.TestCase):
    def test_default_policy_refuses_before_any_request(self):
        engine = pc_engine.Engine(pc_engine.EngineSettings())
        for url in ("http://127.0.0.1:1/", "http://169.254.169.254/latest/", "http://localhost/"):
            with self.subTest(url=url), self.assertRaises(pc_engine.EngineError):
                engine.call("web_fetch", {"url": url})
        engine.shutdown()

    def test_blocked_domain_guard(self):
        guard = pc_engine.blocked_domain_guard(["blocked.example"])
        guard("https://allowed.example/")
        with self.assertRaises(pc_engine.EngineError):
            guard("https://shop.blocked.example/")


if __name__ == "__main__":
    unittest.main()

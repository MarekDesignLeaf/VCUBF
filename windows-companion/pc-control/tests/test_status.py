"""pc_status and the launcher: a broken install is reported over MCP, never as "Connection closed"."""
import json
import os
import subprocess
import sys
import threading
import unittest

import _env

import status

LAUNCH = str(_env.SERVER / "launch.py")


def mcp_session(python, *requests, env_extra=None, timeout=60):
    """Run the launcher over stdio like an MCP client: send each request, read its answer, then close."""
    env = dict(os.environ, **(env_extra or {}))
    process = subprocess.Popen([python, LAUNCH], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, encoding="utf-8", env=env)
    answers = {}
    timer = threading.Timer(timeout, process.kill)
    timer.start()
    try:
        for request in requests:
            process.stdin.write(json.dumps(request) + "\n")
            process.stdin.flush()
            if "id" not in request:
                continue
            for line in process.stdout:
                line = line.strip()
                if not line.startswith("{"):
                    continue
                message = json.loads(line)
                if message.get("id") == request["id"]:
                    answers[request["id"]] = message
                    break
    finally:
        timer.cancel()
        process.stdin.close()
        try:
            stderr = process.communicate(timeout=10)[1]
        except subprocess.TimeoutExpired:
            process.kill()
            stderr = process.communicate()[1]
    return answers, stderr


INIT = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}}}
INITIALIZED = {"jsonrpc": "2.0", "method": "notifications/initialized"}
LIST = {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}
CALL_STATUS = {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "pc_status", "arguments": {}}}
CALL_OTHER = {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "browser_open", "arguments": {"url": "https://example.org"}}}


class CollectStatus(unittest.TestCase):
    def test_reports_packages_groups_and_problems_without_changing_anything(self):
        log_dir = _env.TMP / "status-logs-never-created"
        os.environ["PC_CONTROL_LOG_DIR"] = str(log_dir)
        try:
            data = status.collect_status(server_running=True)
        finally:
            os.environ["PC_CONTROL_LOG_DIR"] = str(_env.TMP / "logs")
        self.assertTrue(data["success"])
        self.assertEqual(data["version"], status.VERSION)
        self.assertEqual({item["module"] for item in data["packages"]}, set(status.PACKAGES))
        for key in ("server", "browser", "web_fetch", "desktop_ui", "keyboard_and_typing", "system"):
            self.assertIn(key, data["tool_groups_usable"])
        self.assertEqual(data["environment"]["python_executable"], sys.executable)
        self.assertIn("cdp", data["browser"])
        self.assertIsInstance(data["problems"], list)
        if sys.platform != "win32":
            self.assertFalse(data["tool_groups_usable"]["desktop_ui"])
            self.assertTrue(any("Windows" in problem for problem in data["problems"]))
        self.assertFalse(log_dir.exists(), "the check must not create the log folder")


class Launcher(unittest.TestCase):
    def test_without_the_packages_it_serves_pc_status_with_the_exact_error(self):
        # The cloud-session case: a Python with none of the server's packages.
        answers, stderr = mcp_session(sys.executable, INIT, INITIALIZED, LIST, CALL_STATUS, CALL_OTHER,
                                      env_extra={"PC_CONTROL_FORCE_FALLBACK": "1"})
        self.assertIn(1, answers, stderr)
        init = answers[1]["result"]
        self.assertEqual(init["serverInfo"]["version"], f"{status.VERSION}-fallback")
        self.assertIn("Only pc_status is available", init["instructions"])
        self.assertEqual([tool["name"] for tool in answers[2]["result"]["tools"]], ["pc_status"])
        report = answers[3]["result"]["structuredContent"]
        self.assertFalse(report["server_running"])
        self.assertIn("forced", report["startup_error"])
        self.assertTrue(answers[4]["result"]["isError"])
        self.assertIn("pc_status", answers[4]["result"]["content"][0]["text"])

    @unittest.skipIf(any(__import__("importlib").util.find_spec(m) is None for m in ("fastmcp", "yaml")), "server packages not installed")
    def test_with_the_packages_it_starts_the_full_server_including_pc_status(self):
        answers, stderr = mcp_session(sys.executable, INIT, INITIALIZED, LIST, CALL_STATUS)
        self.assertIn(2, answers, stderr[-2000:])
        names = [tool["name"] for tool in answers[2]["result"]["tools"]]
        self.assertIn("pc_status", names)
        self.assertIn("pc_capabilities", names)
        self.assertIn("browser_act", names)
        self.assertEqual(answers[1]["result"]["serverInfo"]["version"], status.VERSION)
        report = json.loads(answers[3]["result"]["content"][0]["text"])
        self.assertTrue(report["server_running"])
        self.assertTrue(report["tool_groups_usable"]["server"])


if __name__ == "__main__":
    unittest.main()

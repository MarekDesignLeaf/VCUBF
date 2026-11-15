"""Test environment: an isolated config and audit log, and the server on sys.path."""
from __future__ import annotations

import glob
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).parent
SERVER = HERE.parent / "server"
FIXTURES = HERE / "fixtures"
TMP = Path(tempfile.mkdtemp(prefix="pc_control_test_"))

config = (SERVER / "config.yaml").read_text(encoding="utf-8")
(TMP / "config.yaml").write_text(config.replace("blocked_domains: []", "blocked_domains: [blocked.invalid]"), encoding="utf-8")
os.environ["PC_CONTROL_CONFIG"] = str(TMP / "config.yaml")
os.environ["PC_CONTROL_LOG_DIR"] = str(TMP / "logs")
os.environ["PC_CONTROL_BROWSER_PROFILE"] = str(TMP / "profile")
os.environ["PC_CONTROL_BROWSER_MODE"] = "launch"
os.environ["PC_CONTROL_BROWSER_HEADLESS"] = "true"
os.environ["PC_CONTROL_BROWSER_CHANNEL"] = "chromium"
# The fixtures are served from 127.0.0.1: an explicit opt-in, off by default in config.yaml.
os.environ["PC_CONTROL_BROWSER_ALLOW_PRIVATE_NETWORK"] = "true"

# A pre-installed Chromium (cloud sessions) when Playwright's own is not downloaded.
if not os.environ.get("PC_CONTROL_BROWSER_EXECUTABLE_PATH"):
    for candidate in sorted(glob.glob("/opt/pw-browsers/chromium-*/chrome-linux*/chrome")):
        os.environ["PC_CONTROL_BROWSER_EXECUTABLE_PATH"] = candidate

if str(SERVER) not in sys.path:
    sys.path.insert(0, str(SERVER))

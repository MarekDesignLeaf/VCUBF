"""The vendored PC Control Plus snapshot proves itself without credentials.

The relay catalogue Secretary offers is imported from a minimal snapshot of the
pinned signed PC Control Plus release (pcp-upstream/ and pcp-upstream.json).
These tests take a copy of the snapshot, the pin and the generated catalogue,
break one thing at a time, and require import_pcp_catalogue.check to refuse:
a changed relay.py (which the release manifest does not sign), a changed signed
file, a changed git object, an extra file, a wrong commit, tree, release id or
key, and a stale catalogue. They regenerate the catalogue from the relay in the
snapshot, so they need the relay's packages (pcp-upstream/remote/requirements.txt
and cryptography): CI's relay-catalogue job installs them, and the tests fail,
never skip, without them.
"""
import base64
import hashlib
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

import _env

sys.path.insert(0, str(_env.SERVER))
import import_pcp_catalogue as importer  # noqa: E402


class Snapshot(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        root = Path(self.scratch.name)
        self.snapshot = root / "pcp-upstream"
        shutil.copytree(importer.SNAPSHOT, self.snapshot, ignore=shutil.ignore_patterns("__pycache__"))
        self.pin = root / "pcp-upstream.json"
        shutil.copy(importer.PIN, self.pin)
        self.target = root / "pcpRelayCatalogue.generated.ts"
        shutil.copy(importer.TARGET, self.target)

    def tearDown(self):
        self.scratch.cleanup()

    def check(self, regenerate=True):
        return importer.check(self.pin, self.snapshot, self.target, regenerate=regenerate)

    def refused(self, fragment, regenerate=True):
        with self.assertRaises(importer.ProvenanceError) as caught:
            self.check(regenerate)
        self.assertIn(fragment, str(caught.exception))

    def edit_pin(self, **changes):
        pin = json.loads(self.pin.read_text(encoding="utf-8"))
        pin.update(changes)
        self.pin.write_text(json.dumps(pin), encoding="utf-8")

    def test_the_committed_snapshot_pin_and_catalogue_are_the_signed_release(self):
        release = self.check()
        pin = json.loads(self.pin.read_text(encoding="utf-8"))
        self.assertEqual(release["commit"], pin["commit"])
        self.assertEqual(release["release_id"], pin["release_id"])
        self.assertEqual(sorted(path.name for path in (self.snapshot / "remote").iterdir()), sorted(importer.SNAPSHOT_FILES))

    def test_refuses_a_changed_relay_even_though_the_manifest_does_not_sign_it(self):
        self.assertNotIn("relay.py", json.loads((self.snapshot / "remote" / "release-manifest.json").read_text())["files"])
        relay = self.snapshot / "remote" / "relay.py"
        relay.write_bytes(relay.read_bytes().replace(b"ALLOWED = ALLOWED |", b"ALLOWED = ALLOWED | {'run_command'} |", 1))
        self.refused("remote/relay.py is not the blob of the pinned commit")

    def test_refuses_a_changed_signed_file(self):
        module = self.snapshot / "remote" / "web_goal.py"
        module.write_bytes(module.read_bytes() + b"\n# changed\n")
        self.refused("remote/web_goal.py is not the blob of the pinned commit")

    def test_refuses_a_remote_tree_rewritten_to_match_a_changed_file(self):
        # Re-pointing the tree at a changed relay.py changes the tree's own hash.
        relay = self.snapshot / "remote" / "relay.py"
        changed = relay.read_bytes() + b"\n# changed\n"
        relay.write_bytes(changed)
        objects = importer.read_objects(self.snapshot)
        old = importer.tree_entries(objects["tree-remote"])["relay.py"][1]
        tree = objects["tree-remote"].replace(bytes.fromhex(old), bytes.fromhex(importer.git_sha("blob", changed)))
        (self.snapshot / "git" / "tree-remote.b64").write_text(base64.b64encode(tree).decode())
        self.refused("the root tree's remote/ entry is not the snapshot's remote tree")

    def test_refuses_a_wrong_commit_tree_or_release(self):
        self.edit_pin(commit="0" * 40)
        self.refused("the pin is " + "0" * 40)
        shutil.copy(importer.PIN, self.pin)
        self.edit_pin(tree="1" * 40)
        self.refused("the pin is " + "1" * 40)
        shutil.copy(importer.PIN, self.pin)
        self.edit_pin(release_id="2" * 40)
        self.refused("the pin is " + "2" * 40)

    def test_refuses_a_key_that_did_not_sign_the_release(self):
        self.edit_pin(release_public_key_b64=base64.b64encode(bytes(32)).decode())
        self.refused("does not verify with the pinned public key")

    def test_refuses_a_file_that_is_not_part_of_the_snapshot(self):
        (self.snapshot / "remote" / ".env.example").write_text("PCP_CLIENT_TOKEN=x\n")
        self.refused("expected exactly")
        (self.snapshot / "remote" / ".env.example").unlink()
        (self.snapshot / "notes.txt").write_text("x")
        self.refused("outside remote/ and git/")

    def test_refuses_a_stale_catalogue(self):
        text = self.target.read_text(encoding="utf-8")
        recorded = importer.recorded_upstream(text)
        self.target.write_text(text.replace(recorded["snapshot_sha256"], "f" * 64), encoding="utf-8")
        self.refused("was not imported from this snapshot and pin (stale)", regenerate=False)
        # The right release recorded, but a tool changed by hand: regenerating finds it.
        self.target.write_text(text.replace('"relay_tool": "list_directory"', '"relay_tool": "run_command"', 1), encoding="utf-8")
        self.refused("is not what the relay in the snapshot produces (stale)")

    def test_a_failed_refresh_changes_nothing(self):
        before = {path: path.read_bytes() for path in (self.pin, self.target)}
        with self.assertRaises(Exception):
            importer.refresh(Path(self.scratch.name) / "not-a-checkout", self.pin, self.snapshot, self.target)
        self.assertEqual({path: path.read_bytes() for path in (self.pin, self.target)}, before)
        self.check()

    def test_the_snapshot_holds_no_credentials(self):
        for path in self.snapshot.rglob("*"):
            if path.is_file() and path.suffix != ".b64":
                text = path.read_text(encoding="utf-8")
                with self.subTest(file=path.name):
                    self.assertNotRegex(text, r"(?i)(ghp_|github_pat_|sk-[a-z0-9]{20}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY)")
        self.assertEqual(hashlib.sha256(b"").hexdigest()[:4], "e3b0")  # sanity: hashlib available


if __name__ == "__main__":
    unittest.main()

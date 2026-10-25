"""Offline payload relocation, process ownership and platform adapter checks."""
import errno
import importlib.util
import json
import os
from pathlib import Path
import random
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

from product_skills_fixture import configure_product_skills, assert_product_provenance
SKILLS = configure_product_skills(__file__, 5)
sys.dont_write_bytecode = True
sys.path.insert(0, str(SKILLS / "watch-pr/scripts"))
import portable_lock
import watch_pr
assert_product_provenance(SKILLS, "portability-imports")


class Portability(unittest.TestCase):
    def test_lock_exclusivity_and_release_across_processes(self):
        # Exercises the real host backend. The same test runs msvcrt on Windows.
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "owner.lock"
            code = """import sys
sys.dont_write_bytecode = True
sys.path.insert(0, sys.argv[1])
from portable_lock import lock_exclusive
with open(sys.argv[2], 'a+b') as stream:
    try:
        lock_exclusive(stream, blocking=False)
        print('owned')
    except BlockingIOError:
        print('contended')
"""
            argv = [sys.executable, "-B", "-c", code, str(SKILLS / "watch-pr/scripts"), str(path)]
            with path.open("a+b") as owner:
                portable_lock.lock_exclusive(owner)
                children = [subprocess.Popen(argv, stdout=subprocess.PIPE, text=True) for _ in range(3)]
                for child in children:
                    output, _ = child.communicate(timeout=10)
                    self.assertEqual(child.returncode, 0)
                    self.assertEqual(output.strip(), "contended")
            self.assertEqual(subprocess.check_output(argv, text=True).strip(), "owned")

    def test_windows_backend_contention_retry_and_fatal_errors(self):
        with tempfile.TemporaryFile("w+b") as stream:
            locking = unittest.mock.Mock(side_effect=[OSError(errno.EACCES, "busy"), None])
            backend = types.SimpleNamespace(locking=locking, LK_NBLCK=2)
            with patch.object(portable_lock.os, "name", "nt"), patch.dict(sys.modules, msvcrt=backend), patch.object(portable_lock.time, "sleep") as sleep:
                portable_lock.lock_exclusive(stream)
                sleep.assert_called_once_with(0.05)
                self.assertEqual(locking.call_count, 2)
                locking.side_effect = OSError(errno.EACCES, "busy")
                with self.assertRaises(BlockingIOError):
                    portable_lock.lock_exclusive(stream, blocking=False)
                locking.side_effect = OSError(errno.EBADF, "invalid descriptor")
                with self.assertRaises(OSError) as error:
                    portable_lock.lock_exclusive(stream)
                self.assertEqual(error.exception.errno, errno.EBADF)

    def test_detach_options_match_platform(self):
        with patch.object(watch_pr.os, "name", "nt"), patch.object(watch_pr.subprocess, "DETACHED_PROCESS", 8, create=True), patch.object(watch_pr.subprocess, "CREATE_NEW_PROCESS_GROUP", 512, create=True):
            self.assertEqual(watch_pr.detached_options(), {"creationflags": 520})
        with patch.object(watch_pr.os, "name", "posix"):
            self.assertEqual(watch_pr.detached_options(), {"start_new_session": True})

    def test_replay_ack_preserves_order_for_bounded_generated_batches(self):
        rng = random.Random(17831)
        for size in (0, 1, 99, 100, 101, 201, *[rng.randrange(2, 300) for _ in range(8)]):
            with self.subTest(size=size), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                expected = [{"kind": "comment", "id": i} for i in range(size)]
                watch_pr.emit(directory, expected)
                received = []
                while True:
                    packet = watch_pr.relay(directory)
                    self.assertEqual(watch_pr.relay(directory), packet)
                    if not packet["events"]:
                        break
                    received.extend({"kind": e["kind"], "id": e["id"]} for e in packet["events"])
                    watch_pr.ack(directory, packet["delivery_id"])
                self.assertEqual(received, expected)

    def test_json_cli_results_and_errors_are_capture_safe_with_ascii_streams(self):
        # Models Python 3.10 redirected Windows output without UTF-8 mode. Keep
        # subprocess output as bytes so the test cannot hide encoding failures.
        environment = dict(os.environ, PYTHONIOENCODING="ascii", PYTHONUTF8="0",
                           PYTHONDONTWRITEBYTECODE="1", PYTHONPATH="")
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "仕様-é"
            directory.mkdir()
            filename = "資料-résumé.py"
            (directory / filename).write_text("value = 1\n", encoding="utf-8")
            for skill, entrypoint in (("dev-spec", "dev_spec.py"), ("dev-plan", "dev_plan.py")):
                with self.subTest(skill=skill, result="success"):
                    output = directory / (skill + ".json")
                    result = subprocess.run([sys.executable, "-B", str(SKILLS / skill / "scripts" / entrypoint),
                                             "inspect", "--repo", str(directory), "--path", filename,
                                             "--out", str(output)], env=environment,
                                            capture_output=True, timeout=10)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    observed = json.loads(result.stdout.decode("ascii"))
                    self.assertEqual(observed["repo"], str(directory.resolve()))
                    self.assertIn(filename, observed["files"])
                    self.assertEqual(json.loads(output.read_text(encoding="utf-8")), observed)
            missing = directory / "不存在.json"
            cases = [
                ("dev-spec", "dev_spec.py", ["inspect", "--repo", str(directory), "--path", missing.name, "--out", str(directory / "bad-spec.json")]),
                ("dev-plan", "dev_plan.py", ["inspect", "--repo", str(directory), "--path", missing.name, "--out", str(directory / "bad-plan.json")]),
                ("dev-plan", "closeout.py", ["--root", "threadnote://fixture/root", "--implemented", str(missing),
                                             "--evidence", str(missing), "--state", str(directory / "receipt.json")]),
            ]
            for skill, entrypoint, arguments in cases:
                with self.subTest(skill=skill, entrypoint=entrypoint, result="error"):
                    result = subprocess.run([sys.executable, "-B", str(SKILLS / skill / "scripts" / entrypoint),
                                             *arguments], env=environment, capture_output=True, timeout=10)
                    self.assertEqual(result.returncode, 1)
                    error = json.loads(result.stderr.decode("ascii"))
                    self.assertIn("error", error)
                    self.assertNotIn("UnicodeEncodeError", error["error"])
                    self.assertIn("不存在.json", error["error"])

    def test_every_script_helps_and_imports_from_relocated_payload_without_cache(self):
        with tempfile.TemporaryDirectory(prefix="relocated-workflows-") as temporary:
            relocated = Path(temporary) / "resources"
            for skill in ("dev-spec", "dev-plan", "dev-cycle", "watch-pr"):
                shutil.copytree(SKILLS / skill, relocated / skill)
            environment = dict(os.environ, PYTHONPATH="")
            environment.pop("PYTHONDONTWRITEBYTECODE", None)
            for script in sorted(relocated.glob("*/scripts/*.py")):
                with self.subTest(script=script.relative_to(relocated).as_posix()):
                    help_run = subprocess.run([sys.executable, str(script), "--help"], cwd=temporary,
                                              env=environment, capture_output=True, text=True, timeout=10)
                    self.assertEqual(help_run.returncode, 0, help_run.stderr)
                    code = "import runpy,sys; sys.path.insert(0,sys.argv[1]); runpy.run_path(sys.argv[2],run_name='payload_import')"
                    imported = subprocess.run([sys.executable, "-B", "-c", code, str(script.parent), str(script)],
                                              cwd=temporary, env=environment, capture_output=True, text=True, timeout=10)
                    self.assertEqual(imported.returncode, 0, imported.stderr)
            # Cross-skill imports must use supplied installed roots, never user skill paths.
            code = """import sys
sys.dont_write_bytecode = True
from pathlib import Path
root = Path(sys.argv[1])
sys.path.insert(0, str(root / 'dev-plan/scripts'))
import workflow
for module in workflow.modules(root / 'dev-cycle/scripts', root / 'dev-spec/scripts'):
    assert Path(module.__file__).is_relative_to(root), module.__file__
"""
            result = subprocess.run([sys.executable, "-B", "-c", code, str(relocated)], cwd=temporary,
                                    env=environment, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(list(relocated.rglob("__pycache__")), [])
            self.assertEqual(list(relocated.rglob("*.pyc")), [])


def replay_fixture(event_ids):
    with tempfile.TemporaryDirectory() as temporary:
        directory = Path(temporary)
        watch_pr.emit(directory, [{"kind": "comment", "id": item} for item in event_ids])
        received, identical = [], True
        while True:
            packet = watch_pr.relay(directory)
            identical = identical and watch_pr.relay(directory) == packet
            if not packet["events"]:
                return {"ids": received, "replaysIdentical": identical}
            received.extend(event["id"] for event in packet["events"])
            watch_pr.ack(directory, packet["delivery_id"])


if __name__ == "__main__":
    if sys.argv[1:] == ["--replay-fixture"]:
        print(json.dumps(replay_fixture(json.load(sys.stdin))))
    else:
        unittest.main()

"""Isolated Python/OS pipe contracts; never builds or invokes a Threadnote release."""
import importlib.util
import json
import os
from pathlib import Path
import random
import subprocess
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
HARNESS = Path(__file__).resolve().parents[1] / "release-artifact.py"
SPEC = importlib.util.spec_from_file_location("release_artifact_under_test", HARNESS)
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class PreviewObservationLock(unittest.TestCase):
    def test_nested_observation_preserves_inventory_and_releases_both_locks(self):
        paths = ("data/context-maintenance/state-v2.json.lock", "data/locks/resources/local/mutations.lock")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in paths:
                (root / name).parent.mkdir(parents=True, exist_ok=True)
            tokens = set()
            for _ in range(24):
                with release.hold_observation_lock(root, paths[0], "maintenance"), \
                        release.hold_observation_lock(root, paths[1], "account mutation"):
                    before = release.inventory(root)
                    for name in paths:
                        owner = json.loads((root / name).read_text())
                        self.assertEqual(owner["processId"], os.getpid())
                        self.assertNotIn(owner["token"], tokens)
                        tokens.add(owner["token"])
                    self.assertEqual(release.inventory(root), before)
                self.assertTrue(all(not (root / name).exists() for name in paths))

    def test_cleanup_preserves_foreign_owner_and_original_body_error(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for replacement in (None, "foreign owner\n"):
                with self.subTest(replacement=replacement):
                    with self.assertRaisesRegex(ValueError, "original preview failure"):
                        with release.hold_observation_lock(root, "lock", "fixture"):
                            if replacement is not None:
                                (root / "lock").write_text(replacement)
                            raise ValueError("original preview failure")
                    if replacement is None:
                        self.assertFalse((root / "lock").exists())
                    else:
                        self.assertEqual((root / "lock").read_text(), replacement)
                        (root / "lock").unlink()

    def test_successful_body_cannot_conceal_lost_ownership(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaisesRegex(RuntimeError, "lost ownership"):
                with release.hold_observation_lock(root, "lock", "fixture"):
                    (root / "lock").write_text("foreign owner\n")
            self.assertEqual((root / "lock").read_text(), "foreign owner\n")


class ReleaseOutput(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="release-output-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.evidence = self.root / "synthetic-native.log"
        self.environment = {"HOME": str(self.root), "USERPROFILE": str(self.root), "PATH": "",
                            "TMPDIR": str(self.root), "TMP": str(self.root), "TEMP": str(self.root),
                            "PYTHONIOENCODING": "cp1252", "PYTHONDONTWRITEBYTECODE": "1"}
        for key in ("SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC"):
            if key in os.environ:
                self.environment[key] = os.environ[key]

    def streams(self, stdout, stderr, code):
        program = ("import os,sys; os.write(1," + repr(stdout) + "); os.write(2," + repr(stderr)
                   + "); sys.exit(" + str(code) + ")")
        return [sys.executable, "-B", "-c", program]

    def assert_raw(self, stdout, stderr):
        self.assertEqual(self.evidence.with_name(self.evidence.name + ".stdout.bin").read_bytes(), stdout)
        self.assertEqual(self.evidence.with_name(self.evidence.name + ".stderr.bin").read_bytes(), stderr)

    def test_success_utf8_json_stderr_and_newlines_remain_exact(self):
        payload = {"message": "Unicode — 漢 🙂"}
        stdout = json.dumps(payload, ensure_ascii=False).encode() + b"\r\n"
        stderr = "diagnostic —\r\nnext\rline\n".encode()
        output = release.run(self.streams(stdout, stderr, 0), self.environment, self.root, evidence=self.evidence)
        self.assertEqual(json.loads(output), payload)
        self.assertEqual(output, stdout.decode().replace("\r\n", "\n"))
        self.assertEqual(self.evidence.read_text(encoding="utf-8"), output + "diagnostic —\nnext\nline\n")
        self.assert_raw(stdout, stderr)

    def test_python_child_stdio_is_utf8_without_mutating_parent_environment(self):
        before = dict(self.environment)
        program = "import sys; print('Unicode \\u2014 \\u6f22'); print('stderr \\u2014',file=sys.stderr)"
        output = release.run([sys.executable, "-B", "-c", program], self.environment, self.root, evidence=self.evidence)
        self.assertEqual(output, "Unicode — 漢\n")
        self.assertEqual(self.environment, before)

    def test_nonzero_utf8_exit_is_reported_with_original_streams(self):
        stdout, stderr = "output —\n".encode(), "child assertion — failed\n".encode()
        with self.assertRaisesRegex(RuntimeError, "exited with code 7") as failed:
            release.run(self.streams(stdout, stderr, 7), self.environment, self.root, evidence=self.evidence)
        self.assertIn("child assertion — failed", str(failed.exception))
        self.assert_raw(stdout, stderr)

    def test_nonzero_invalid_stdout_and_stderr_never_mask_child_exit(self):
        for stream in (1, 2):
            with self.subTest(stream=stream):
                stdout = b"raw\x97\xfffailure\r\n" if stream == 1 else b"stdout\n"
                stderr = b"raw\x97\xfffailure\r\n" if stream == 2 else b"stderr\n"
                with self.assertRaisesRegex(RuntimeError, "exited with code 23") as failed:
                    release.run(self.streams(stdout, stderr, 23), self.environment, self.root, evidence=self.evidence)
                self.assertIn(r"raw\x97\xfffailure", str(failed.exception))
                self.assert_raw(stdout, stderr)
                self.assertIn(r"raw\x97\xfffailure", self.evidence.read_text(encoding="utf-8"))

    def test_zero_exit_invalid_utf8_on_either_stream_still_fails_with_raw_evidence(self):
        for stream in (1, 2):
            with self.subTest(stream=stream):
                stdout = b"bad\x97" if stream == 1 else b"valid stdout"
                stderr = b"bad\x97" if stream == 2 else b"valid stderr"
                with self.assertRaises(UnicodeDecodeError):
                    release.run(self.streams(stdout, stderr, 0), self.environment, self.root, evidence=self.evidence)
                self.assert_raw(stdout, stderr)
                self.assertIn(r"bad\x97", self.evidence.read_text(encoding="utf-8"))

    def test_failure_without_evidence_still_exposes_the_original_exit(self):
        with self.assertRaisesRegex(RuntimeError, "exited with code 19") as failed:
            release.run(self.streams(b"", b"failure\x97", 19), self.environment, self.root)
        self.assertIn(r"failure\x97", str(failed.exception))

    def test_bounded_arbitrary_stream_bytes_are_preserved_before_exit_refusal(self):
        randomizer = random.Random(39865863150)
        cases = [(b"", b""), (bytes(range(256)), b""), (b"", bytes(range(256))),
                 (b"\r\n\x00\xff", b"\x97\r\n")]
        cases += [(bytes(randomizer.randrange(256) for _ in range(randomizer.randrange(65))),
                   bytes(randomizer.randrange(256) for _ in range(randomizer.randrange(65)))) for _ in range(16)]
        for index, (stdout, stderr) in enumerate(cases):
            with self.subTest(index=index):
                with self.assertRaisesRegex(RuntimeError, "exited with code 23"):
                    release.run(self.streams(stdout, stderr, 23), self.environment, self.root, evidence=self.evidence)
                self.assert_raw(stdout, stderr)

    def test_timeout_and_binary_capture_contract_are_retained(self):
        arguments = ["synthetic"]
        with patch.object(release.subprocess, "run", side_effect=subprocess.TimeoutExpired(arguments, 600)) as launch:
            with self.assertRaises(subprocess.TimeoutExpired):
                release.run(arguments, self.environment, self.root, timeout=600, evidence=self.evidence)
        self.assertEqual(launch.call_args.kwargs["timeout"], 600)
        self.assertTrue(launch.call_args.kwargs["capture_output"])
        self.assertEqual(launch.call_args.kwargs["env"]["PYTHONIOENCODING"], "utf-8")
        for key in ("encoding", "errors", "text", "universal_newlines"):
            self.assertNotIn(key, launch.call_args.kwargs)

    def test_native_log_copy_includes_only_the_produced_sidecars(self):
        destination = self.root / "saved"
        destination.mkdir()
        expected = {"suite-native.log": b"log\n", "suite-native.log.stdout.bin": b"stdout\x97",
                    "suite-native.log.stderr.bin": b"stderr\xff"}
        unrelated = {"suite-native.log.unrelated": b"unrelated", "orphan-native.log.stderr.bin": b"orphan",
                     "other.log": b"other", "other.log.stdout.bin": b"other sidecar"}
        for name, raw in {**expected, **unrelated}.items():
            (self.root / name).write_bytes(raw)
        release.copy_native_logs(self.root, destination)
        self.assertEqual({p.name: p.read_bytes() for p in destination.iterdir()}, expected)
        (self.root / "suite-native.log.stderr.bin").unlink()
        with self.assertRaises(FileNotFoundError):
            release.copy_native_logs(self.root, destination)

    def failed_stage(self, copy_failure=False):
        checkout = self.root / "checkout"
        dist = checkout / "dist"
        dist.mkdir(parents=True)
        (dist / "fixture").write_bytes(b"synthetic archive payload; never executable")
        fixtures = checkout / "apps/threadnote/test/dev-skills/python"
        fixtures.mkdir(parents=True)
        (fixtures / "fixture.py").write_text("# synthetic staging input\n")
        archive = self.root / "fixture.tar.gz"
        with tarfile.open(archive, "w:gz") as stream:
            stream.add(dist / "fixture", arcname="fixture")
        Path(str(archive) + ".sha256").write_text(release.digest(archive) + "\n")
        staging = self.root / "staging"
        staging.mkdir()
        report = self.root / "report/result.json"
        original = RuntimeError("original native suite refusal")
        packet = b'NATIVE_GRAPH_TIMEOUT_DIAGNOSTICS {"version":1}\n'
        expected = {"test_dev_spec-native.log": packet + b"traceback\n" * 1000,
                    "test_dev_spec-native.log.stdout.bin": b"",
                    "test_dev_spec-native.log.stderr.bin": packet + b"traceback\n" * 1000}

        def fail_child(arguments, environment, cwd, timeout):
            self.assertEqual(timeout, 1800)
            self.assertEqual(arguments[-1], "--functional-only")
            for name, raw in expected.items():
                (staging / name).write_bytes(raw)
            (staging / "private-data").write_text("must not copy unrelated files")
            raise original

        with patch.object(release.tempfile, "mkdtemp", return_value=str(staging)), \
                patch.object(release.sys, "platform", "win32"), patch.object(release, "run", side_effect=fail_child) as launch:
            if copy_failure:
                with patch.object(release, "copy_native_logs", side_effect=OSError("synthetic copy refusal")):
                    with self.assertRaises(RuntimeError) as caught:
                        release.stage(SimpleNamespace(checkout=checkout, archive=archive, report=report, functional_only=True))
            else:
                with self.assertRaises(RuntimeError) as caught:
                    release.stage(SimpleNamespace(checkout=checkout, archive=archive, report=report, functional_only=True))
        self.assertIs(caught.exception, original)
        self.assertEqual(launch.call_count, 1)
        self.assertEqual(json.loads(report.read_text())["error"], str(original))
        self.assertTrue(staging.exists(), "Original failure retains its fixture")
        return report, expected

    def test_failed_stage_retains_native_sidecars_beyond_the_exception_tail(self):
        report, expected = self.failed_stage()
        destination = report.with_suffix(".provenance")
        self.assertEqual({p.name: p.read_bytes() for p in destination.iterdir()}, expected)
        self.assertNotIn(b"NATIVE_GRAPH_TIMEOUT_DIAGNOSTICS", expected["test_dev_spec-native.log"][-5000:])
        self.assertIn(b"NATIVE_GRAPH_TIMEOUT_DIAGNOSTICS", (destination / "test_dev_spec-native.log.stderr.bin").read_bytes())

    def test_failed_stage_copy_refusal_cannot_mask_original_failure(self):
        self.failed_stage(copy_failure=True)

    def test_best_effort_failed_evidence_handles_absent_and_incomplete_logs(self):
        report = self.root / "report/result.json"
        release.preserve_failed_native_logs(self.root, report)
        self.assertEqual(list(report.with_suffix(".provenance").iterdir()), [])
        (self.root / "suite-native.log").write_bytes(b"original failure")
        (self.root / "suite-native.log.stdout.bin").write_bytes(b"partial")
        release.preserve_failed_native_logs(self.root, report)
        self.assertEqual((report.with_suffix(".provenance") / "suite-native.log").read_bytes(), b"original failure")
        self.assertFalse((report.with_suffix(".provenance") / "suite-native.log.stderr.bin").exists())


class ReleasePreviewFence(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="release-preview-fence-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.lock = self.root / "data/locks/resources/local/mutations.lock"

    def test_owned_version1_token_is_exclusive_live_flushed_and_removed(self):
        with patch.object(release.os, "open", wraps=os.open) as opened, \
                patch.object(release.os, "fsync", wraps=os.fsync) as flushed:
            with release.hold_account_mutation_lock(self.root):
                token = json.loads(self.lock.read_text())
                self.assertEqual(set(token), {"version", "processId", "token"})
                self.assertEqual(token["version"], 1)
                self.assertEqual(token["processId"], os.getpid())
                self.assertRegex(token["token"], r"^[a-f0-9]{32}$")
                self.assertEqual(opened.call_args.args[1], os.O_WRONLY | os.O_CREAT | os.O_EXCL)
                self.assertEqual(opened.call_args.args[2], 0o600)
                self.assertEqual(flushed.call_count, 1)
                with self.assertRaises(FileExistsError):
                    os.open(self.lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        self.assertFalse(self.lock.exists())

    def test_body_failure_preserves_original_exception_and_releases_owned_token(self):
        original = RuntimeError("original preview refusal")
        with self.assertRaises(RuntimeError) as caught:
            with release.hold_account_mutation_lock(self.root):
                raise original
        self.assertIs(caught.exception, original)
        self.assertFalse(self.lock.exists())

    def test_foreign_replacement_refuses_and_is_never_removed(self):
        foreign = '{"version":1,"processId":1,"token":"foreign"}\n'
        with self.assertRaisesRegex(RuntimeError, "lost ownership of the account mutation lock"):
            with release.hold_account_mutation_lock(self.root):
                self.lock.write_text(foreign)
        self.assertEqual(self.lock.read_text(), foreign)

    def test_body_failure_with_foreign_replacement_preserves_both(self):
        original = ValueError("original assertion")
        foreign = '{"version":1,"processId":1,"token":"foreign"}\n'
        with self.assertRaises(ValueError) as caught:
            with release.hold_account_mutation_lock(self.root):
                self.lock.write_text(foreign)
                raise original
        self.assertIs(caught.exception, original)
        self.assertEqual(self.lock.read_text(), foreign)

    def test_bounded_contention_never_steals_an_existing_owner(self):
        self.lock.parent.mkdir(parents=True)
        foreign = '{"version":1,"processId":' + str(os.getpid()) + ',"token":"foreign"}\n'
        self.lock.write_text(foreign)
        before = release.inventory(self.root)
        with patch.object(release.time, "monotonic", side_effect=[0, 11]), \
                patch.object(release.time, "sleep") as sleep:
            with self.assertRaisesRegex(RuntimeError, "Account mutation lock did not become available"):
                with release.hold_account_mutation_lock(self.root):
                    self.fail("Foreign owner was admitted")
        self.assertEqual(self.lock.read_text(), foreign)
        self.assertEqual(release.inventory(self.root), before)
        sleep.assert_not_called()


if __name__ == "__main__":
    unittest.main()

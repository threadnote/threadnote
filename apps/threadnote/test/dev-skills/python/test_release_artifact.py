"""Isolated Python/OS pipe contracts; never builds or invokes a Threadnote release."""
import importlib.util
import json
import os
from pathlib import Path
import random
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
HARNESS = Path(__file__).resolve().parents[1] / "release-artifact.py"
SPEC = importlib.util.spec_from_file_location("release_artifact_under_test", HARNESS)
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


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


if __name__ == "__main__":
    unittest.main()

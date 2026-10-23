import copy
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import zipfile

source = Path(sys.argv.pop(1)).resolve()
spec = importlib.util.spec_from_file_location("windows_prerequisites", source)
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


class WindowsPrerequisiteTests(unittest.TestCase):
    def fixture(self, root):
        path = root / "github-path"
        path.write_bytes(b"previous-directory\n")
        return {"PATH": "original-path", "RUNNER_TEMP": str(root), "GITHUB_PATH": str(path)}, path

    def archive(self, target="x86_64-pc-windows-msvc", member=None, payload=b"synthetic executable"):
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w") as archive:
            archive.writestr(member or f"ripgrep-{bootstrap.VERSION}-{target}/rg.exe", payload)
        return stream.getvalue()

    def test_working_runner_does_not_download_or_change_environment(self):
        with tempfile.TemporaryDirectory() as root:
            environment, path = self.fixture(Path(root))
            before = copy.deepcopy(environment)
            with patch.object(bootstrap.shutil, "which", return_value="runner-rg"), \
                    patch.object(bootstrap.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, b"ripgrep 15.1.0\n")), \
                    patch.object(bootstrap.urllib.request, "urlopen") as fetch:
                self.assertEqual(bootstrap.ensure_ripgrep(environment, "AMD64"), Path("runner-rg"))
                fetch.assert_not_called()
            self.assertEqual(environment, before)
            self.assertEqual(path.read_bytes(), b"previous-directory\n")

    def test_missing_and_broken_tools_use_architecture_pinned_verified_executable(self):
        for arch, target in (("AMD64", "x86_64-pc-windows-msvc"), ("ARM64", "aarch64-pc-windows-msvc")):
            for initial in (None, "broken-rg"):
                with self.subTest(arch=arch, initial=initial), tempfile.TemporaryDirectory() as root:
                    environment, path = self.fixture(Path(root)); before = copy.deepcopy(environment)
                    payload = self.archive(target); probes = []
                    def probe(args, **options):
                        probes.append((args, options))
                        self.assertEqual(path.read_bytes(), b"previous-directory\n")
                        return subprocess.CompletedProcess(args, 7 if args[0] == "broken-rg" else 0, b"ripgrep 15.2.0\n")
                    with patch.object(bootstrap.shutil, "which", return_value=initial), \
                            patch.dict(bootstrap.ASSETS, {arch.lower(): (target, hashlib.sha256(payload).hexdigest())}), \
                            patch.object(bootstrap.urllib.request, "urlopen", return_value=io.BytesIO(payload)) as fetch, \
                            patch.object(bootstrap.subprocess, "run", side_effect=probe):
                        executable = bootstrap.ensure_ripgrep(environment, arch)
                    self.assertEqual(executable.read_bytes(), b"synthetic executable")
                    self.assertEqual(path.read_text().splitlines(), ["previous-directory", str(executable.parent)])
                    self.assertEqual(environment, before)
                    self.assertEqual(fetch.call_count, 1)
                    self.assertTrue(fetch.call_args.args[0].endswith(f"ripgrep-{bootstrap.VERSION}-{target}.zip"))
                    self.assertTrue(all(options["timeout"] == 10 for _, options in probes))

    def test_transport_failure_preserves_path_and_installs_nothing(self):
        with tempfile.TemporaryDirectory() as root:
            environment, path = self.fixture(Path(root))
            with patch.object(bootstrap.shutil, "which", return_value=None), \
                    patch.object(bootstrap.urllib.request, "urlopen", side_effect=urllib.error.HTTPError("url", 504, "Gateway Timeout", {}, None)):
                with self.assertRaises(urllib.error.HTTPError):
                    bootstrap.ensure_ripgrep(environment, "ARM64")
            self.assertEqual(path.read_bytes(), b"previous-directory\n")
            self.assertEqual(list(Path(root).iterdir()), [path])

    def test_every_corrupted_archive_is_rejected_before_path_publication(self):
        # Bounded integrity property over twenty distinct single-byte mutations.
        original = self.archive(); expected = hashlib.sha256(original).hexdigest()
        offset = os.environ.get("THREADNOTE_CI_ARCHIVE_OFFSET")
        indices = range(20) if offset is None else [int(offset) % len(original)]
        mask = 1 << int(os.environ.get("THREADNOTE_CI_ARCHIVE_BIT", "0"))
        for index in indices:
            with self.subTest(index=index), tempfile.TemporaryDirectory() as root:
                environment, path = self.fixture(Path(root))
                corrupted = bytearray(original); corrupted[index] ^= mask
                with patch.object(bootstrap.shutil, "which", return_value=None), \
                        patch.dict(bootstrap.ASSETS, {"amd64": ("x86_64-pc-windows-msvc", expected)}), \
                        patch.object(bootstrap.urllib.request, "urlopen", return_value=io.BytesIO(corrupted)), \
                        patch.object(bootstrap.subprocess, "run") as probe:
                    with self.assertRaisesRegex(RuntimeError, "SHA-256"):
                        bootstrap.ensure_ripgrep(environment, "AMD64")
                    probe.assert_not_called()
                self.assertEqual(path.read_bytes(), b"previous-directory\n")
                self.assertEqual(list(Path(root).iterdir()), [path])

    def test_unusable_verified_executable_is_removed_and_never_published(self):
        for outcome in (subprocess.CompletedProcess([], 9, b""), subprocess.CompletedProcess([], 0, b""), OSError("wrong architecture"), subprocess.TimeoutExpired("rg", 10)):
            with self.subTest(outcome=repr(outcome)), tempfile.TemporaryDirectory() as root:
                environment, path = self.fixture(Path(root)); payload = self.archive()
                with patch.object(bootstrap.shutil, "which", return_value=None), \
                        patch.dict(bootstrap.ASSETS, {"amd64": ("x86_64-pc-windows-msvc", hashlib.sha256(payload).hexdigest())}), \
                        patch.object(bootstrap.urllib.request, "urlopen", return_value=io.BytesIO(payload)), \
                        patch.object(bootstrap.subprocess, "run", **({"side_effect": outcome} if isinstance(outcome, Exception) else {"return_value": outcome})):
                    with self.assertRaisesRegex(RuntimeError, "--version"):
                        bootstrap.ensure_ripgrep(environment, "AMD64")
                self.assertEqual(path.read_bytes(), b"previous-directory\n")
                self.assertEqual(list(Path(root).iterdir()), [path])

    def test_unexpected_archive_members_are_not_extracted(self):
        for member in ("../rg.exe", "other/rg.exe"):
            with self.subTest(member=member), tempfile.TemporaryDirectory() as root:
                environment, path = self.fixture(Path(root)); payload = self.archive(member=member)
                with patch.object(bootstrap.shutil, "which", return_value=None), \
                        patch.dict(bootstrap.ASSETS, {"amd64": ("x86_64-pc-windows-msvc", hashlib.sha256(payload).hexdigest())}), \
                        patch.object(bootstrap.urllib.request, "urlopen", return_value=io.BytesIO(payload)):
                    with self.assertRaises(KeyError):
                        bootstrap.ensure_ripgrep(environment, "AMD64")
                self.assertEqual(list(Path(root).iterdir()), [path])

    def test_size_bounds_reject_payload_before_path_publication(self):
        for kind in ("archive", "executable"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as root:
                environment, path = self.fixture(Path(root)); payload = self.archive(payload=b"too large")
                with patch.object(bootstrap.shutil, "which", return_value=None), \
                        patch.dict(bootstrap.ASSETS, {"amd64": ("x86_64-pc-windows-msvc", hashlib.sha256(payload).hexdigest())}), \
                        patch.object(bootstrap.urllib.request, "urlopen", return_value=io.BytesIO(payload)), \
                        patch.object(bootstrap, "MAX_ARCHIVE_BYTES", len(payload) - 1 if kind == "archive" else len(payload)), \
                        patch.object(bootstrap, "MAX_EXECUTABLE_BYTES", 1):
                    with self.assertRaises(RuntimeError):
                        bootstrap.ensure_ripgrep(environment, "AMD64")
                self.assertEqual(path.read_bytes(), b"previous-directory\n")
                self.assertEqual(list(Path(root).iterdir()), [path])

    def test_unsupported_architecture_does_not_download_or_publish(self):
        with tempfile.TemporaryDirectory() as root:
            environment, path = self.fixture(Path(root))
            with patch.object(bootstrap.shutil, "which", return_value=None), \
                    patch.object(bootstrap.urllib.request, "urlopen") as fetch:
                with self.assertRaises(KeyError):
                    bootstrap.ensure_ripgrep(environment, "unsupported")
                fetch.assert_not_called()
            self.assertEqual(path.read_bytes(), b"previous-directory\n")
            self.assertEqual(list(Path(root).iterdir()), [path])


if __name__ == "__main__":
    unittest.main()

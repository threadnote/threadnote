"""Admit Windows workflow tests only with a usable, verified ripgrep executable."""
import hashlib
import io
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

VERSION = "15.2.0"
# Official release assets and SHA-256 digests from
# https://github.com/BurntSushi/ripgrep/releases/tag/15.2.0
ASSETS = {
    "amd64": ("x86_64-pc-windows-msvc", "71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5"),
    "arm64": ("aarch64-pc-windows-msvc", "e4abca10c3a64ebea742667dd7009449d49403db5460dd6873e389fa2945360f"),
}
MAX_ARCHIVE_BYTES = 8 * 1024 * 1024
MAX_EXECUTABLE_BYTES = 16 * 1024 * 1024


def usable(executable):
    if executable is None:
        return False
    try:
        result = subprocess.run([str(executable), "--version"], capture_output=True, timeout=10)
        return result.returncode == 0 and result.stdout.startswith(b"ripgrep ")
    except (OSError, subprocess.TimeoutExpired):
        return False


def ensure_ripgrep(environment, architecture):
    existing = shutil.which("rg", path=environment.get("PATH", ""))
    if usable(existing):
        print("Using verified runner ripgrep")
        return Path(existing)
    target, expected = ASSETS[architecture.lower()]
    github_path = Path(environment["GITHUB_PATH"])
    runner_temp = Path(environment["RUNNER_TEMP"])
    asset = f"ripgrep-{VERSION}-{target}"
    url = f"https://github.com/BurntSushi/ripgrep/releases/download/{VERSION}/{asset}.zip"
    with urllib.request.urlopen(url, timeout=30) as response:
        payload = response.read(MAX_ARCHIVE_BYTES + 1)
    if len(payload) > MAX_ARCHIVE_BYTES or hashlib.sha256(payload).hexdigest() != expected:
        raise RuntimeError("Ripgrep release archive failed its pinned SHA-256/size check")
    # Read only the exact executable member; never extract arbitrary archive paths.
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        member = archive.getinfo(asset + "/rg.exe")
        if not 0 < member.file_size <= MAX_EXECUTABLE_BYTES:
            raise RuntimeError("Ripgrep executable exceeds its size bound")
        executable_bytes = archive.read(member)
    directory = Path(tempfile.mkdtemp(prefix="threadnote-ripgrep-", dir=runner_temp))
    try:
        executable = directory / "rg.exe"
        executable.write_bytes(executable_bytes)
        if not usable(executable):
            raise RuntimeError("Pinned ripgrep executable failed --version")
        # Publish only after checksum, archive and actual execution verification.
        separator = "" if not github_path.exists() or github_path.read_bytes().endswith(b"\n") else "\n"
        with github_path.open("a", encoding="utf-8", newline="\n") as stream:
            stream.write(separator + str(directory) + "\n")
        print(f"Verified ripgrep {VERSION} for {target}; added its directory to GITHUB_PATH")
        return executable
    except BaseException:
        shutil.rmtree(directory)
        raise


if __name__ == "__main__":
    try:
        if platform.system() != "Windows":
            raise RuntimeError("This prerequisite is only for Windows runners")
        ensure_ripgrep(os.environ, platform.machine())
    except Exception as error:
        print(f"Windows workflow prerequisite failed: {error}", file=sys.stderr)
        sys.exit(1)

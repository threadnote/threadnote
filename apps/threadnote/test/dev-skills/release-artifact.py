"""Run real packaged workflows outside the checkout, with explicit isolation evidence.

The normal suite does not build releases. Invoke through release-artifact.test.ts
with THREADNOTE_RELEASE_ARCHIVE after the production archive command.
"""
import argparse
import contextlib
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def inventory(root):
    result = {}
    for path in sorted(root.rglob("*")):
        key = path.relative_to(root).as_posix()
        if path.is_symlink():
            result[key] = {"link": os.readlink(path)}
        elif path.is_dir():
            result[key] = {"directory": True}
        else:
            result[key] = {"sha256": digest(path)}
    return result


def run(arguments, environment, cwd, timeout=120, evidence=None, input_text=None):
    # Own Python children use UTF-8 pipes; raw capture also preserves unexpected native diagnostics.
    result = subprocess.run(arguments, env={**environment, "PYTHONIOENCODING": "utf-8"}, cwd=cwd,
                            capture_output=True, timeout=timeout,
                            input=None if input_text is None else input_text.encode("utf-8"))

    def decode(value, errors="strict"):
        return value.decode("utf-8", errors=errors).replace("\r\n", "\n").replace("\r", "\n")

    stdout = decode(result.stdout, errors="backslashreplace")
    stderr = decode(result.stderr, errors="backslashreplace")
    if evidence is not None:
        evidence.with_name(evidence.name + ".stdout.bin").write_bytes(result.stdout)
        evidence.with_name(evidence.name + ".stderr.bin").write_bytes(result.stderr)
        evidence.write_text(stdout + stderr, encoding="utf-8")
    require(result.returncode == 0, repr(arguments) + " exited with code " + str(result.returncode)
            + "\n" + stdout[-5000:] + stderr[-5000:])
    # Success output remains strict UTF-8, including stderr; diagnostic rendering never grants success.
    decode(result.stderr)
    return decode(result.stdout)


def copy_native_logs(root, destination):
    for log in root.glob("*-native.log"):
        for source in (log, log.with_name(log.name + ".stdout.bin"), log.with_name(log.name + ".stderr.bin")):
            shutil.copyfile(source, destination / source.name)


def preserve_failed_native_logs(root, report):
    try:
        destination = report.with_suffix(".provenance")
        destination.mkdir(parents=True, exist_ok=True)
        copy_native_logs(root, destination)
    except BaseException:
        pass  # Evidence retention must never replace the original staging failure.


def fixture_environment(root, runtime):
    environment = {key: os.environ[key] for key in
                   ("PATH", "PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR", "COMSPEC") if key in os.environ}
    user = root / "user"
    environment.update({
        "PATH": str(runtime) + os.pathsep + str(root / "tools"),
        "THREADNOTE_RELEASE_FIXTURE_ROOT": str(root),
        "HOME": str(user), "USERPROFILE": str(user), "THREADNOTE_HOME": str(root / "data"),
        "THREADNOTE_USER": "release-fixture", "THREADNOTE_AGENT_ID": "test",
        "THREADNOTE_BIN_DIR": str(root / "bin"), "THREADNOTE_INSTALL_ROOT": str(root / "runtime"),
        "XDG_CONFIG_HOME": str(user / ".config"), "XDG_DATA_HOME": str(user / ".local/share"),
        "XDG_STATE_HOME": str(user / ".local/state"), "XDG_CACHE_HOME": str(user / ".cache"),
        "APPDATA": str(user / "appdata"), "LOCALAPPDATA": str(user / "localappdata"),
        "TMPDIR": str(root / "tmp"), "TMP": str(root / "tmp"), "TEMP": str(root / "tmp"),
        "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1", "GIT_TERMINAL_PROMPT": "0",
        "GIT_ALLOW_PROTOCOL": "file", "NO_COLOR": "1", "NO_UPDATE_NOTIFIER": "1",
        "THREADNOTE_NO_UPDATE_CHECK": "1", "THREADNOTE_AUTO_UPDATE": "off",
        "PYTHONDONTWRITEBYTECODE": "1", "PYTHONPATH": "",
    })
    user.mkdir()
    (root / "tmp").mkdir()
    return environment


def verify_isolation(checkout, enforced):
    if not enforced:
        return {"enforced": False, "reason": "Functional native Windows lane; OS isolation acceptance is pending."}
    try:
        (checkout / "config/agent-skills/dev-plan/SKILL.md").read_bytes()
    except OSError as error:
        require(error.errno in (errno.EPERM, errno.EACCES, errno.ENOENT), "Unexpected source denial: " + str(error))
        source_errno = error.errno
    else:
        raise RuntimeError("The source checkout is readable inside the isolated fixture")
    with socket.socket() as probe:
        probe.settimeout(2)
        denied = probe.connect_ex(("192.0.2.1", 443))
    require(denied in (errno.EPERM, errno.EACCES, errno.ENETUNREACH),
            "Outbound network was not denied by the OS: " + str(denied))
    return {"enforced": True, "sourceReadErrno": source_errno, "outboundConnectErrno": denied,
            "exceptions": ["/bin/ps only: system process-identity probe executes without sandbox"]
            if sys.platform == "darwin" else []}


@contextlib.contextmanager
def hold_observation_lock(root, relative_path, label):
    """Serialize disposable preview snapshots without hiding changes to any observed file."""
    lock = root / relative_path
    token = json.dumps({"version": 1, "processId": os.getpid(), "token": uuid.uuid4().hex}) + "\n"
    deadline = time.monotonic() + 10
    while True:
        try:
            descriptor = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            break
        except FileExistsError:
            require(time.monotonic() < deadline, label + " lock did not become available")
            time.sleep(0.01)

    body_failed = False
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(token)
            stream.flush()
            os.fsync(stream.fileno())
        yield
        try:
            still_owned = lock.read_text(encoding="utf-8") == token
        except FileNotFoundError:
            still_owned = False
        require(still_owned, "Fixture lost ownership of the " + label + " lock")
    except BaseException:
        body_failed = True
        raise
    finally:
        try:
            if lock.read_text(encoding="utf-8") == token:
                lock.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            if not body_failed:
                raise


@contextlib.contextmanager
def hold_account_mutation_lock(root):
    """Fence independent settled readers while observing the complete preview filesystem image."""
    lock = root / "data/locks/resources/local/mutations.lock"
    lock.parent.mkdir(parents=True, exist_ok=True)
    token = json.dumps({"version": 1, "processId": os.getpid(), "token": uuid.uuid4().hex}) + "\n"
    deadline = time.monotonic() + 10
    while True:
        try:
            descriptor = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            break
        except FileExistsError:
            require(time.monotonic() < deadline, "Account mutation lock did not become available")
            time.sleep(0.01)

    body_failed = False
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(token)
            stream.flush()
            os.fsync(stream.fileno())
        yield
        try:
            still_owned = lock.read_text(encoding="utf-8") == token
        except FileNotFoundError:
            still_owned = False
        require(still_owned, "Fixture lost ownership of the account mutation lock")
    except BaseException:
        body_failed = True
        raise
    finally:
        try:
            if lock.read_text(encoding="utf-8") == token:
                lock.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            if not body_failed:
                raise


def wait_for_compaction_scheduler(root, manager):
    """Wait for the persistent startup lock, rather than sampling its creation mid-preview."""
    lock = root / "data/locks/indexes/code-graph/automatic-compaction-scheduler.lock"
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        require(manager.poll() is None, "Manager stopped before its compaction scheduler was ready")
        try:
            owner = json.loads(lock.read_text(encoding="utf-8"))
            if owner.get("version") == 1 and owner.get("processId") == manager.pid and owner.get("token"):
                return
        except (OSError, ValueError):
            pass
        time.sleep(0.01)
    raise RuntimeError("Manager did not acquire its automatic compaction scheduler lock")


def manager_checks(root, binary, environment, checks):
    previous = json.loads(run(
        [str(binary), "context", "maintain", "--action", "status", "--json"], environment, root))
    body_failed = False
    try:
        if not previous["paused"]:
            paused = json.loads(run(
                [str(binary), "context", "maintain", "--action", "pause", "--json"], environment, root))
            require(paused["paused"] is True, "Context maintenance did not pause in the fixture home")
        manager_checks_while_paused(root, binary, environment, checks)
    except BaseException:
        body_failed = True
        raise
    finally:
        if not previous["paused"]:
            try:
                restored = json.loads(run(
                    [str(binary), "context", "maintain", "--action", "resume", "--json"], environment, root))
                require(restored["paused"] is False, "Context maintenance pause state was not restored")
            except Exception as error:
                if not body_failed:
                    raise
                print("Maintenance pause-state restoration also failed: " + str(error), file=sys.stderr)


def manager_checks_while_paused(root, binary, environment, checks):
    log = root / "manager.log"
    with log.open("w", encoding="utf-8") as output:
        manager = subprocess.Popen([str(binary), "manage", "--no-open", "--ui-port", "0"],
                                   env=environment, cwd=root, stdout=output, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 45
            match = None
            while time.monotonic() < deadline:
                match = re.search(r"http://127\.0\.0\.1:\d+/\?token=([^\s]+)", log.read_text(encoding="utf-8"))
                if match:
                    break
                require(manager.poll() is None, "Manager stopped: " + log.read_text(encoding="utf-8")[-3000:])
                time.sleep(0.1)
            require(match is not None, "Manager startup timed out")
            origin = match.group(0).split("/?")[0]
            token = urllib.parse.unquote(match.group(1))
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

            def request(path, body=None, authenticated=True, expected=200):
                headers = {"Content-Type": "application/json"}
                if authenticated:
                    headers["Authorization"] = "Bearer " + token
                call = urllib.request.Request(origin + path, headers=headers,
                                              data=None if body is None else json.dumps(body).encode())
                try:
                    response = opener.open(call, timeout=30)
                except urllib.error.HTTPError as error:
                    response = error
                with response:
                    payload = response.read()
                    require(response.status == expected, path + ": " + str(response.status) + " " + payload.decode()[:1000])
                return json.loads(payload) if path.startswith("/api/") else payload

            require(b"<html" in request("/").lower(), "Packaged Manager HTML is missing")
            request("/api/dev-skills/catalog", authenticated=False, expected=401)
            request("/api/dev-skills/catalog")
            wait_for_compaction_scheduler(root, manager)
            selector = {"agent": "antigravity-cli", "scope": "user"}
            for action in ("install", "update", "remove"):
                # Capture only user/data/runtime state; Manager's diagnostic log is expected to change.
                with hold_observation_lock(root, "data/context-maintenance/state-v2.json.lock", "maintenance"), \
                        hold_observation_lock(root, "data/locks/resources/local/mutations.lock", "account mutation"):
                    before = {name: inventory(root / name) for name in ("user", "data", "runtime")}
                    preview = request("/api/dev-skills/preview", {"action": action, "selector": selector})
                    require(preview["canApply"], "Manager preview blocked: " + json.dumps(preview["issues"]))
                    after = {name: inventory(root / name) for name in before}
                    changed = [name + "/" + path for name in before
                               for path in sorted(before[name].keys() | after[name].keys())
                               if before[name].get(path) != after[name].get(path)]
                    require(before == after, "Manager " + action + " preview changed files (" + str(len(changed))
                            + "): " + json.dumps(changed[:30]))
                result = request("/api/dev-skills/apply", {"action": action, "selector": selector,
                                 "previewDigest": preview["previewDigest"], "confirm": True})
                require(result["result"]["applied"] == (action != "update"), "Unexpected Manager apply result")
                target = result["status"]["targets"][0]
                require(target["installationState"] == ("absent" if action == "remove" else "current"),
                        "Manager status does not match apply")
                checks.append({"managerAction": action, "layout": preview["target"]["layout"],
                               "state": target["installationState"]})
        finally:
            manager.terminate()
            try:
                manager.wait(timeout=10)
            except subprocess.TimeoutExpired:
                manager.kill()
                manager.wait(timeout=10)


def native_watch_checks(root, binary, environment):
    base = {"protocolVersion": 1, "executorVersion": 1, "action": "watch", "watchId": "extracted-release",
            "consumerId": "release-consumer", "wakeupId": "release-fixture"}
    receipt = root / "provenance/watch-deliveries.json"
    receipt.parent.mkdir(parents=True, exist_ok=True)
    deliveries = []

    def call(command, **fields):
        response = json.loads(run([str(binary), "workflow-automation"], environment, root,
                                  input_text=json.dumps({**base, "command": command, **fields})))
        require(response.get("status") == "ok", "Native watch failed: " + json.dumps(response))
        return response

    def settle(delivery, status):
        dispositions = [{"eventId": event["id"], "status": status,
                         "reason": "Private extracted-release lifecycle observation.",
                         "evidence": "provenance/watch-deliveries.json"} for event in delivery["events"]]
        deliveries.append({"delivery": delivery, "dispositions": dispositions})
        with receipt.open("w", encoding="utf-8") as stream:
            stream.write(json.dumps(deliveries, indent=2) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        call("disposition", deliveryId=delivery["id"], dispositions=dispositions)
        return call("ack", deliveryId=delivery["id"])

    started = False
    try:
        initial = call("start", pr="https://github.com/fixture/repo/pull/1")
        started = True
        require(initial["collector"]["alive"], "Native collector did not start")
        deadline = time.monotonic() + 30
        delivery = None
        while time.monotonic() < deadline:
            observed = call("wait", timeoutSeconds=1)
            delivery = observed.get("delivery")
            if delivery:
                break
        require(delivery is not None, "Native collector missed the private provider signals")
        health = call("inspect")
        require(not health["sourceErrors"] and len(health["sources"]) == 5,
                "Native watch did not complete all five sources")
        require(sorted(event["kind"] for event in delivery["events"]) ==
                ["ci_error", "comment", "review_thread"], "Native provider signals were lost or invented")
        requests = (root / "provider-requests.json").read_bytes()
        require(call("relay")["delivery"] == delivery, "Unacknowledged native delivery did not replay")
        require((root / "provider-requests.json").read_bytes() == requests,
                "Relay consumption started a competing GitHub poll")
        acknowledged = settle(delivery, "open")
        require(acknowledged["pending"] == 0 and acknowledged["work"]["open"] == 3,
                "ACK discarded actionable work")
        work = call("work")["work"]["items"]
        require({item["eventId"] for item in work} == {event["id"] for event in delivery["events"]},
                "Actionable work was not durably retained")
        health = call("inspect")
        call("work-disposition", expectedRevision=health["revision"], dispositions=[
            {"eventId": item["eventId"], "status": "resolved", "reason": "Synthetic fixture issues verified.",
             "evidence": "provenance/watch-deliveries.json"} for item in work])
        require(all(item["status"] == "resolved" for item in call("work")["work"]["items"]),
                "Verified work disposition was not retained")
        return {"nativeWatch": "passed", "signals": 3, "sources": 5, "replayed": True,
                "ackRetainedOpenWork": True, "provider": "private compiled frozen fixture"}
    finally:
        if started:
            call("stop")
            deadline = time.monotonic() + 15
            stopped = call("inspect")
            while stopped["collector"]["alive"] and time.monotonic() < deadline:
                time.sleep(0.05)
                stopped = call("inspect")
            require(not stopped["collector"]["alive"], "Fixture left an unowned native collector")
            for _ in range(4):
                pending = call("relay").get("delivery")
                if not pending:
                    break
                settle(pending, "resolved")
            require(call("inspect")["pending"] == 0, "Terminal fixture events were not recorded and acknowledged")


def execute(root, checkout, enforced):
    release_root = root / "runtime/versions/payload"
    release = json.loads((release_root / "release.json").read_text(encoding="utf-8"))
    binary = release_root / release["executable"]
    before_release = inventory(release_root)
    environment = fixture_environment(root, release_root)
    result = {"status": "running", "release": release, "binarySha256": digest(binary), "checks": []}
    checks = result["checks"]
    try:
        result["isolation"] = verify_isolation(checkout, enforced)
        denial = subprocess.run([str(root / "tools" / ("python.exe" if sys.platform == "win32" else "python")),
                                 "-c", "raise SystemExit(0)"], env=environment, cwd=root, capture_output=True, timeout=30)
        require(denial.returncode == 97, "External interpreter denial proxy is not active")
        (root / "interpreter-attempts.json").write_text("[]", encoding="utf-8")
        require(shutil.which("git", path=environment["PATH"]) and shutil.which("rg", path=environment["PATH"]),
                "Installed workflow checks require Git and ripgrep")

        def cli(*arguments):
            text = run([str(binary), "dev-skills", *arguments], environment, root)
            checks.append({"cli": list(arguments)})
            return json.loads(text)

        before_preview = inventory(root / "user")
        cli("list", "--json")
        for action in ("install", "update", "remove"):
            cli(action, "--agent", "codex", "--dry-run", "--json")
        require(before_preview == inventory(root / "user") and not (root / "data").exists(),
                "CLI discovery or preview changed the fresh target")
        installed = cli("install", "--agent", "codex", "--json")
        require(installed["applied"], "Compiled CLI did not install the bundled skills")
        skills = Path(installed["target"]["skillRoot"])
        generation = skills / ".threadnote-dev-skills/generations" / installed["bundleDigest"]
        manifest = json.loads((release_root / release["devSkills"]["manifest"]).read_text(encoding="utf-8"))
        require(manifest["digest"] == installed["bundleDigest"], "Installed bundle differs from the archive")
        require({name: digest(generation / name) for name in manifest["hashes"]} == manifest["hashes"],
                "Installed helper bytes differ from the archive manifest")
        require(manifest["schemaVersion"] == 2 and all(not name.endswith(".py") for name in manifest["hashes"]),
                "New release includes a Python workflow payload or old manifest")
        result["installedProvenance"] = {"generation": str(generation), "digest": manifest["digest"],
                                         "files": len(manifest["hashes"]), "nativeOnly": True}
        for skill in manifest["skills"]:
            content = (skills / skill["id"] / "SKILL.md").read_text(encoding="utf-8")
            require(str(generation) in content and str(checkout) not in content and "{{THREADNOTE_" not in content,
                    "Entrypoint does not resolve to its installed generation: " + skill["id"])
        for action in ("install", "update"):
            require(not cli(action, "--agent", "codex", "--json")["applied"], "Idempotent action changed files")
        manager_checks(root, binary, environment, checks)
        controller = runpy.run_path(str(root / "native-release-workflows.py"))
        result["nativeWorkflows"] = controller["run_workflows"](root, binary, environment, installed["bundleDigest"])
        checks.append(native_watch_checks(root, binary, environment))
        require(not json.loads((root / "interpreter-attempts.json").read_text(encoding="utf-8")),
                "Product attempted to launch an external interpreter")
        result["externalInterpreters"] = {"denied": True, "productAttempts": 0}
        require(cli("remove", "--agent", "codex", "--json")["applied"], "CLI remove did not apply")
        require(all(not (skills / skill["id"] / "SKILL.md").exists() for skill in manifest["skills"]),
                "Removed entrypoint still exists")
        require(before_release == inventory(release_root), "Running the installed workflows changed the release")
        result["status"] = "passed" if enforced else "functional-passed-isolation-pending"
        return result
    except BaseException as error:
        result.update(status="failed", error=str(error))
        raise
    finally:
        (root / "result.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")


def stage(arguments):
    checkout = Path(arguments.checkout).resolve()
    archive = Path(arguments.archive).resolve()
    report = Path(arguments.report).resolve()
    require(archive.is_file(), "Build and archive the real release first")
    checksum = Path(str(archive) + ".sha256").read_text(encoding="utf-8").split()[0]
    require(digest(archive) == checksum, "Release archive checksum mismatch")
    root = Path(tempfile.mkdtemp(prefix="threadnote-extracted-release-")).resolve()
    require(not root.is_relative_to(checkout), "Fixture must be outside the source checkout")
    payload = root / "runtime/versions/payload"
    payload.mkdir(parents=True)
    try:
        expected = inventory(checkout / "dist")
        require(expected, "Expected built release is absent")
        with tarfile.open(archive, "r:gz") as stream:
            names = set()
            for member in stream.getmembers():
                destination = (payload / member.name).resolve()
                require(destination.is_relative_to(payload), "Archive path escapes payload")
                require(member.isdir() or member.isfile(), "Unexpected archive link or special entry")
                require(destination not in names, "Duplicate archive path")
                names.add(destination)
            stream.extractall(payload)
        require(inventory(payload) == expected, "Extracted archive inventory/bytes differ from the built release")
        shutil.copyfile(checkout / "apps/threadnote/test/dev-skills/native-release-workflows.py",
                        root / "native-release-workflows.py")
        tool = Path(arguments.tools).resolve()
        require(tool.is_file(), "Compile the native test tool proxy before release isolation")
        tools = root / "tools"
        tools.mkdir()
        tool_paths = {name: shutil.which(name) for name in ("git", "rg")}
        require(all(tool_paths.values()), "Native release fixtures require Git and ripgrep")
        (root / "tool-paths.json").write_text(json.dumps(tool_paths), encoding="utf-8")
        for name in ("git", "rg", "gh", "memory-read", "python", "python3", "python3.14", "node", "bun"):
            target = tools / (name + (".exe" if sys.platform == "win32" else ""))
            try:
                os.link(tool, target)
            except OSError:
                shutil.copy2(tool, target)
        (root / "interpreter-attempts.json").write_text("[]", encoding="utf-8")
        (root / "provider-requests.json").write_text("[]", encoding="utf-8")
        (root / "provider.json").write_text(json.dumps({"head": "a" * 40, "terminal": False, "revision": 1}),
                                           encoding="utf-8")
        harness = root / "release-artifact.py"
        shutil.copyfile(__file__, harness)
        command = [sys.executable, "-B", str(harness), "--execute", str(root), "--checkout", str(checkout)]
        if sys.platform == "darwin":
            # macOS rejects executing setuid /bin/ps inside any sandbox, including
            # allow-default. This immutable system probe supplies lock-owner start
            # identity. Only ps escapes; CLI/Python/Git retain both denials.
            policy = '(version 1)(allow default)(deny network*)' \
                '(allow network-inbound (local ip "localhost:*"))' \
                '(allow network-outbound (remote ip "localhost:*"))' \
                '(allow process-exec (literal "/bin/ps") (with no-sandbox))' \
                '(deny file-read* (subpath ' + json.dumps(str(checkout)) + '))'
            command = ["/usr/bin/sandbox-exec", "-p", policy, *command]
        elif sys.platform.startswith("linux"):
            require(shutil.which("bwrap"), "Linux offline release checks require bubblewrap")
            command = ["bwrap", "--unshare-net", "--die-with-parent", "--ro-bind", "/", "/",
                       "--bind", str(root), str(root), "--tmpfs", str(checkout), "--dev", "/dev",
                       "--proc", "/proc", "--chdir", str(root), *command]
        else:
            require(arguments.functional_only, "Native Windows OS isolation is pending; use explicit --functional-only")
            command.append("--functional-only")
        run(command, os.environ.copy(), root, timeout=1800)
        result = json.loads((root / "result.json").read_text(encoding="utf-8"))
        result.update(archiveSha256=checksum, archiveEntries=len(expected), checkoutAccess="denied" if
                      result["isolation"]["enforced"] else "not OS-enforced")
        report.parent.mkdir(parents=True, exist_ok=True)
        report.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        evidence = report.with_suffix(".provenance")
        shutil.copytree(root / "provenance", evidence, dirs_exist_ok=True)
        copy_native_logs(root, evidence)
        shutil.rmtree(root)
        print(json.dumps({"status": result["status"], "report": str(report)}))
    except BaseException as error:
        report.parent.mkdir(parents=True, exist_ok=True)
        report.write_text(json.dumps({"status": "failed", "error": str(error), "fixture": str(root)}, indent=2) + "\n")
        preserve_failed_native_logs(root, report)
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive")
    parser.add_argument("--checkout", required=True)
    parser.add_argument("--report")
    parser.add_argument("--execute")
    parser.add_argument("--tools")
    parser.add_argument("--functional-only", action="store_true")
    args = parser.parse_args()
    if args.execute:
        execute(Path(args.execute), Path(args.checkout), not args.functional_only)
    else:
        require(args.archive and args.report and args.tools, "Staging requires --archive, --report and --tools")
        stage(args)

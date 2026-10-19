#!/usr/bin/env python3
"""Local, standalone Threadnote mechanics reused from dev-plan."""
import sys
sys.dont_write_bytecode = True
from portable_lock import lock_exclusive
import argparse, contextlib, hashlib, json, os, re, shutil, subprocess, tempfile, uuid
from pathlib import Path

FENCE = chr(96) * 3
NL = "\n"
MARKER = "<!-- dev-spec:v1 "

class PlanError(Exception):
    pass


class CommandError(PlanError):
    def __init__(self, argv, stderr):
        self.stderr = stderr
        super().__init__("Command failed: " + argv[0] + "\n" + stderr[:2000])


def require(condition, message):
    if not condition:
        raise PlanError(message)


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(encoded(value).encode()).hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write(NL)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def nonempty(value, label):
    require(isinstance(value, str) and bool(value.strip()), "Missing " + label)
    return value


def string_list(value, label, required=False):
    require(isinstance(value, list) and (value or not required), "Invalid " + label)
    for item in value:
        nonempty(item, label)
    require(len(value) == len(set(value)), "Duplicate " + label)
    return value


def safe_path(repo, name):
    nonempty(name, "path")
    path = Path(name)
    require(not path.is_absolute() and ".." not in path.parts, "Path escapes repository: " + name)
    resolved = (repo / path).resolve()
    require(resolved.is_relative_to(repo), "Symlink escapes repository: " + name)
    return resolved


def run(argv, cwd=None, text=None, timeout=55):
    result = subprocess.run(argv, cwd=cwd, input=text, capture_output=True, text=True, encoding="utf-8", timeout=timeout)
    if result.returncode != 0:
        raise CommandError(argv, result.stderr)
    return result.stdout


def inspect(repo, paths):
    repo = Path(repo).resolve()
    require(repo.is_dir(), "Repository does not exist")
    paths = string_list(paths, "scope paths", required=True)
    files = set()
    for name in paths:
        path = safe_path(repo, name)
        require(path.exists(), "Scope path does not exist: " + name)
        if path.is_file():
            files.add(path.relative_to(repo).as_posix())
        else:
            require(shutil.which("rg"), "Directory discovery requires rg; use explicit file paths")
            result = subprocess.run(["rg", "--files", "--hidden", "-g", "!.git", "--", name],
                                    cwd=repo, text=True, encoding="utf-8", capture_output=True)
            require(result.returncode in (0, 1), result.stderr)
            files.update(Path(member).as_posix() for member in result.stdout.splitlines())
    require(len(files) <= 500, "Scope exceeds 500 files; select the relevant code area")
    hashes = {}
    for name in sorted(files):
        path = safe_path(repo, name)
        require(path.is_file(), "Scope member is not a file: " + name)
        hashes[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, text=True, encoding="utf-8", capture_output=True)
    return {"repo": str(repo), "paths": paths, "files": hashes,
            "head": head.stdout.strip() if head.returncode == 0 else None}


def diagram_check(diagram, label):
    nonempty(diagram, label + " diagram")
    require(FENCE not in diagram, "Diagram must not include Markdown fences")
    first = diagram.strip().splitlines()[0].split()[0]
    require(first in {"flowchart", "graph", "sequenceDiagram", "classDiagram", "stateDiagram-v2",
                      "erDiagram", "journey", "C4Context", "C4Container"},
            "Unsupported Mermaid type for " + label)


def memory_text(record):
    return record["markdown"].strip() + "\n\n" + MARKER + encoded(record).replace("--", "\\u002d\\u002d") + " -->\n"


def load_record(body):
    start = body.rfind(MARKER)
    require(start >= 0, "Not a dev-spec memory")
    end = body.find(" -->", start)
    require(end >= 0, "Incomplete artifact")
    record = json.loads(body[start + len(MARKER):end])
    require(record.get("schemaVersion") == 1, "Unsupported artifact version")
    require(canonical(memory_text(record)) == canonical(body), "Memory body and structured content diverged")
    return record


class Threadnote:
    def __init__(self, repo=None, home=None):
        self.repo, self.home = repo, home

    def call(self, command, args, text=None):
        return run(["threadnote", command] + (["--home", self.home] if self.home else []) + args,
                   cwd=self.repo, text=text)

    def read(self, uri):
        return canonical(self.call("read", [uri]))

    def peek(self, uri):
        try:
            return self.read(uri)
        except CommandError as error:
            try:
                detail = json.loads(error.stderr.splitlines()[0])
            except (ValueError, IndexError):
                raise error
            if detail.get("code") == "memory-resource-not-found" and detail.get("requestedUri") == uri:
                return None
            raise

    def active(self, uri):
        return bool(re.search(r"^status: active$", self.call("read", [uri]), re.M))

    def remember(self, record, topic, replace=None, preview=False):
        args = ["--kind", record["memoryKind"], "--project", record["project"], "--topic", topic,
                "--status", "active", "--keyword", "dev-spec", "--keyword", record["featureId"],
                "--keyword", record["kind"], "--stdin"]
        for ref in record.get("codeRefs", []):
            args += ["--code-ref", ref]
        args += ["--defer-code-refs" if record.get("deferred") else "--require-current-code-refs"]
        for relation in record.get("relations", []):
            args += ["--relation", relation["type"] + "=" + relation["uri"]]
        if replace:
            args += ["--replace", replace]
        if preview:
            args += ["--dry-run"]
        output = self.call("remember", args, memory_text(record))
        pattern = r"Would (?:create|replace) native resource: (threadnote://[^\s]+)" if preview else r"Stored memory: (threadnote://[^\s]+)"
        match = re.search(pattern, output)
        require(match, "Unrecognized native write response; reconcile before retrying")
        return match.group(1)


def pin(client, uri):
    return {"uri": uri, "sha256": hashlib.sha256(client.read(uri).encode()).hexdigest()}


@contextlib.contextmanager
def locked(path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(str(path) + ".lock", "a+b") as lock:
        try:
            lock_exclusive(lock, blocking=False)
        except BlockingIOError:
            raise PlanError("Another writer owns this receipt")
        yield


class Store:
    """One local writer; exact native previews and readback guard retries."""
    def __init__(self, path, client, identity):
        self.path, self.client = Path(path), client
        self.state = read_json(path) if self.path.exists() else {
            "identity": identity, "runId": uuid.uuid4().hex[:12], "receipts": {}, "history": {}, "archives": {}}
        require(self.state["identity"] == identity, "Receipt belongs to another feature or operation")

    def flush(self):
        write_json(self.path, self.state)

    def recover(self, uri=None):
        pending = self.state.get("pending")
        if not pending:
            return
        if pending["operation"] == "archive":
            target = uri or pending.get("uri")
            if target:
                require(digest(load_record(self.client.read(target))) == pending["hash"]
                        and not self.client.active(target), "Archive recovery mismatch")
                self.state["archives"][pending["source"]] = target
            else:
                original = self.client.peek(pending["source"])
                require(original is not None and digest(load_record(original)) == pending["hash"]
                        and self.client.active(pending["source"]),
                        "Unknown archive outcome; recall actual archived URI and pass --recover-uri")
        else:
            target = uri or pending.get("uri") or pending["expectedUri"]
            body = self.client.peek(target)
            if body is not None and digest(load_record(body)) == pending["hash"]:
                self.accept(pending["key"], target, pending["hash"])
            else:
                require(target == pending["expectedUri"] and
                        (digest(body) if body is not None else None) == pending["beforeHash"],
                        "Write destination changed unexpectedly; reconcile concurrent edits")
        self.state.pop("pending")
        self.flush()

    def accept(self, key, uri, fingerprint):
        previous = self.state["receipts"].get(key)
        if previous and previous["uri"] != uri:
            self.state["history"][previous["uri"]] = previous["hash"]
        self.state["receipts"][key] = {"uri": uri, "hash": fingerprint}

    def put(self, key, record, stable=False):
        require(not self.state.get("pending"), "Recover pending operation first")
        require(len(record.get("relations", [])) <= 16, "Artifact exceeds native relation limit; split its scope")
        require(len(memory_text(record).encode()) <= 60000, "Artifact exceeds memory limit; split capability content")
        fingerprint = digest(record)
        old = self.state["receipts"].get(key)
        if old:
            require(digest(load_record(self.client.read(old["uri"]))) == old["hash"], "Stored artifact was edited elsewhere")
            if old["hash"] == fingerprint:
                return old["uri"]
        topic = record["featureId"] + "-" + self.state["runId"] + "-" + key
        if not stable:
            topic += "-" + fingerprint[:12]
        replacement = old["uri"] if old and stable else None
        expected = self.client.remember(record, topic, replacement, preview=True)
        before = self.client.peek(expected)
        self.state["pending"] = {"operation": "save", "key": key, "hash": fingerprint, "topic": topic,
                                 "expectedUri": expected, "beforeHash": digest(before) if before is not None else None}
        self.flush()
        uri = self.client.remember(record, topic, replacement)
        self.state["pending"]["uri"] = uri
        self.flush()
        require(digest(load_record(self.client.read(uri))) == fingerprint, "Saved memory readback mismatch")
        self.accept(key, uri, fingerprint)
        self.state.pop("pending")
        self.flush()
        return uri

    def archive(self, uri, fingerprint):
        if uri in self.state["archives"]:
            return self.state["archives"][uri]
        require(digest(load_record(self.client.read(uri))) == fingerprint, "Artifact changed before retirement")
        self.state["pending"] = {"operation": "archive", "source": uri, "hash": fingerprint}
        self.flush()
        result = self.client.call("archive", [uri])
        match = re.search(r"Stored memory: (threadnote://[^\s]+)", result)
        require(match, "Unknown archive outcome; recover actual returned URI")
        self.state["pending"]["uri"] = match.group(1)
        self.flush()
        self.recover()
        return self.state["archives"][uri]


def canonical(raw):
    if raw.startswith("MEMORY\n"):
        require("\n\n" in raw, "Unrecognized Threadnote read envelope")
        metadata, raw = raw.split("\n\n", 1)
        preface = "Archived original Threadnote memory.\n\n"
        if re.search(r"^status: archived$", metadata, re.M) and raw.startswith(preface):
            raw = raw[len(preface):]
    return raw.strip() + NL

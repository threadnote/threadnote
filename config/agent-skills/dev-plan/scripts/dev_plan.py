#!/usr/bin/env python3
"""Compile diagram-first development plans into connected private Threadnote memories."""
import sys
sys.dont_write_bytecode = True
from portable_lock import lock_exclusive
import workflow_transport as wt

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import uuid

FENCE = chr(96) * 3
MARKER = "<!-- dev-plan:v1 "
NL = "\n"


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


def fresh(plan):
    old = plan["scope"]
    now = inspect(old["repo"], old["paths"])
    require(old["files"] == now["files"], "Scoped source changed; refresh the architecture and scope snapshot")
    return {"source": "current", "headChanged": old.get("head") != now.get("head")}


def order(phases):
    by_id = {phase["id"]: phase for phase in phases}
    require(len(by_id) == len(phases), "Duplicate phase ID")
    active, done, result = set(), set(), []

    def visit(key):
        require(key in by_id, "Unknown dependency: " + key)
        require(key not in active, "Phase dependency cycle at " + key)
        if key in done:
            return
        active.add(key)
        for parent in by_id[key]["dependsOn"]:
            visit(parent)
        active.remove(key)
        done.add(key)
        result.append(by_id[key])

    for key in by_id:
        visit(key)
    return result


def diagram_check(diagram, label):
    nonempty(diagram, label + " diagram")
    require(FENCE not in diagram, "Diagram must not include Markdown fences")
    first = diagram.strip().splitlines()[0].split()[0]
    require(first in {"flowchart", "graph", "sequenceDiagram", "classDiagram", "stateDiagram-v2",
                      "erDiagram", "journey", "C4Context", "C4Container"},
            "Unsupported Mermaid type for " + label)


def validate(plan, ready=False, review=None, check_source=True):
    require(plan.get("schemaVersion") == 1, "Unsupported plan schema")
    for field in ("id", "title", "objective", "project"):
        nonempty(plan.get(field), field)
    require(re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", plan["id"]), "Invalid plan ID")
    require(isinstance(plan.get("scope"), dict), "Missing scope snapshot")
    repo = Path(plan["scope"]["repo"])
    require(repo.is_absolute(), "Scope repository must be absolute")
    context = plan.get("recall", {})
    string_list(context.get("queries"), "recall queries", required=True)
    sources = context.get("sources")
    require(isinstance(sources, list), "Missing read-and-pinned recall sources")
    source_map = {}
    for source in sources:
        uri = nonempty(source.get("uri"), "source URI")
        require(uri.startswith("threadnote://"), "Use actual canonical Threadnote URIs")
        require(uri not in source_map, "Duplicate recalled source")
        require(re.fullmatch(r"[0-9a-f]{64}", source.get("sha256", "")), "Source needs a pin hash")
        require(source.get("role") in {"constraint", "decision", "history", "task", "preference"},
                "Classify the recalled source")
        nonempty(source.get("usedFor"), "source usedFor")
        source_map[uri] = source
    used_sources = set()

    def artifact(spec, label, has_diagram=False):
        refs = string_list(spec.get("contextRefs"), label + " contextRefs")
        if not refs:
            nonempty(spec.get("contextNote"), label + " explanation of no relevant recall")
        require(set(refs) <= set(source_map), label + " references an unread/unpinned memory")
        used_sources.update(refs)
        code_refs = string_list(spec.get("codeRefs"), label + " codeRefs")
        require(len(code_refs) <= 8, label + " exceeds Threadnote's eight-code-ref limit")
        if plan["scope"]["files"]:
            require(code_refs, label + " needs existing code anchors")
        for ref in code_refs:
            if ref.startswith("cgs_"):
                require(re.fullmatch(r"cgs_[0-9a-f]{32}", ref), "Malformed symbol anchor")
                require(spec.get("codeRefPaths", {}).get(ref) in plan["scope"]["files"],
                        "Graph anchor needs its inspected source path in codeRefPaths: " + ref)
            elif ref.startswith("cgr_"):
                require(len(ref) > 8, "Malformed qualified anchor")
                require(spec.get("codeRefPaths", {}).get(ref) in plan["scope"]["files"],
                        "Qualified anchor needs its inspected local source path in codeRefPaths")
            else:
                require(safe_path(repo, ref).is_file() and ref in plan["scope"]["files"],
                        "Code ref must be an inspected source file: " + ref)
        if has_diagram:
            nonempty(spec.get("summary"), label + " summary")
            diagram_check(spec.get("diagram"), label)

    artifact(plan, "root")
    artifact(plan.get("current", {}), "current", True)
    artifact(plan.get("target", {}), "target", True)
    string_list(plan["current"].get("invariants"), "current invariants")
    string_list(plan["current"].get("unknowns"), "current unknowns")
    string_list(plan["target"].get("contracts"), "target contracts", required=True)
    require(isinstance(plan["target"].get("decisions"), list), "Missing target decisions")
    for decision in plan["target"]["decisions"]:
        for field in ("choice", "rationale"):
            nonempty(decision.get(field), "decision " + field)
    requirements = plan.get("requirements")
    require(isinstance(requirements, list) and requirements, "Missing requirements")
    req_ids = [r["id"] for r in requirements]
    require(len(req_ids) == len(set(req_ids)), "Duplicate requirement ID")
    for requirement in requirements:
        nonempty(requirement.get("id"), "requirement ID")
        nonempty(requirement.get("behavior"), "requirement behavior")
    phases = plan.get("phases")
    require(isinstance(phases, list) and phases, "Missing phases")
    for phase in phases:
        require(re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", phase.get("id", "")), "Invalid phase ID")
        string_list(phase.get("dependsOn"), "phase dependencies")
    sorted_phases = order(phases)
    created, ancestors, covered = {}, {}, set()
    for phase in sorted_phases:
        key = phase["id"]
        artifact(phase, "phase " + key)
        for field in ("title", "outcome", "safeBoundary"):
            nonempty(phase.get(field), key + " " + field)
        string_list(phase.get("contracts"), key + " contracts")
        paths = string_list(phase.get("affectedPaths"), key + " affectedPaths", True)
        new_paths = string_list(phase.get("newPaths"), key + " newPaths")
        require(set(new_paths) <= set(paths), "New paths must be affected paths")
        ancestors[key] = set(phase["dependsOn"])
        for parent in phase["dependsOn"]:
            ancestors[key].update(ancestors[parent])
        for name in paths:
            existing = safe_path(repo, name).exists()
            earlier = any(owner in ancestors[key] for owner in created.get(name, []))
            require(existing or name in new_paths or earlier,
                    "Missing path must be planned explicitly: " + name)
            require(not (name in new_paths and existing), "New path already exists: " + name)
        for name in new_paths:
            require(name not in created, "Two phases create the same path: " + name)
            created.setdefault(name, []).append(key)
        acceptance = phase.get("acceptance")
        require(isinstance(acceptance, list) and acceptance, key + " needs acceptance")
        ids = []
        for item in acceptance:
            for field in ("id", "criterion", "verification"):
                nonempty(item.get(field), key + " acceptance " + field)
            ids.append(item["id"])
            matches = string_list(item.get("requirements"), key + " requirement links", True)
            require(set(matches) <= set(req_ids), "Acceptance references unknown requirement")
            covered.update(matches)
        require(len(ids) == len(set(ids)), "Duplicate acceptance ID in " + key)
        if phase.get("diagram"):
            diagram_check(phase["diagram"], key)
        require(len(set(phase["contextRefs"])) + len(phase["dependsOn"]) + 2 <= 16,
                "Phase exceeds native relation limit; simplify its dependency/context boundary")
    require(covered == set(req_ids), "Requirements without acceptance: " + ", ".join(set(req_ids) - covered))
    if plan.get("spec"):
        upstream = plan["spec"]
        require(upstream["featureId"] == plan["id"], "Plan changed the feature identity")
        actual = {r["id"]: r["behavior"] for r in requirements}
        require(all(actual.get(r["id"]) == r["behavior"] for r in upstream["requirements"]),
                "Approved spec requirement changed or disappeared; revise dev-spec first")
        scenarios = {s["id"]: s for s in upstream["scenarios"]}
        mapped = set()
        for phase in phases:
            for acceptance in phase["acceptance"]:
                links = acceptance.get("specScenarios", [])
                require(isinstance(links, list) and len(links) <= 1, "Map each spec scenario to its own acceptance item")
                for sid in links:
                    require(sid in scenarios, "Unknown spec scenario")
                    s = scenarios[sid]
                    expected = "Given " + s["given"] + "; when " + s["when"] + "; then " + s["then"]
                    require(acceptance["criterion"] == expected and set(s["requirementIds"]) <= set(acceptance["requirements"]),
                            "Approved acceptance scenario was weakened; revise dev-spec first")
                    mapped.add(sid)
        require(mapped == set(scenarios), "Spec scenarios missing from phases: " + ", ".join(set(scenarios) - mapped))
        pinned = {s["uri"]: s["sha256"] for s in plan["recall"]["sources"]}
        require(all(pinned.get(uri) == sha for uri, sha in upstream["memoryHashes"].items()),
                "Spec revision pins changed; re-import the reconciled specification")
    require(used_sources == set(source_map), "Remove unused recall sources or attach them to relevant artifacts")
    require(len(plan["contextRefs"]) <= 14, "Root needs room for architecture relations; narrow its context")
    require(len(plan["target"]["contextRefs"]) <= 15, "Target needs room for current architecture relation")
    require(len(plan["current"]["contextRefs"]) <= 16, "Current architecture exceeds relation limit")
    questions = plan.get("openQuestions")
    require(isinstance(questions, list), "Missing openQuestions")
    policy = plan.get("review", {})
    require(isinstance(policy.get("required"), bool), "Review classification is required")
    nonempty(policy.get("reason"), "review classification reason")
    required_review = len(phases) > 1 or policy["required"]
    if ready:
        require(not questions, "Unresolved consequential questions: save as draft")
        if required_review:
            require(review is not None, "Substantial plan needs a quiet independent review")
            require(review.get("planHash") == digest(plan), "Review is for a different plan")
            require(review.get("verdict") == "ready", "Reviewer has not cleared the plan")
            require(isinstance(review.get("findings"), list), "Malformed review findings")
            require(not any(f.get("severity") in {"critical", "important"} for f in review["findings"]),
                    "Unresolved material review findings")
    status = fresh(plan) if check_source else {"source": "not checked"}
    return {**status, "phases": len(phases), "requirements": len(requirements),
            "reviewRequired": required_review, "mermaid": "type/fences checked; syntax/render not checked"}


def canonical(raw):
    if raw.startswith("MEMORY\n"):
        require("\n\n" in raw, "Unrecognized Threadnote read envelope")
        metadata, raw = raw.split("\n\n", 1)
        preface = "Archived original Threadnote memory.\n\n"
        if re.search(r"^status: archived$", metadata, re.M) and raw.startswith(preface):
            raw = raw[len(preface):]
    return raw.strip() + NL


class Threadnote:
    def __init__(self, repo=None, home=None, **workflow_options):
        self.repo, self.home = repo, home
        self.workflow_options = workflow_options
        self.workflow = None
        wt.attach_explicit(self)

    def call(self, command, args, text=None):
        wt.require(self.workflow is None and not self.workflow_options.get("workflow_context"), "Structured workflows require an existing pinned context and do not execute human read/remember/archive commands")
        wt.require_desktop_legacy(self.home)
        argv = ["threadnote", command]
        if self.home:
            argv += ["--home", self.home]
        return run(argv + args, cwd=self.repo, text=text)

    def read(self, uri):
        if self.workflow is not None:
            return self.workflow.read(uri)["body"]
        return canonical(self.call("read", [uri]))

    def peek(self, uri):
        if self.workflow is not None:
            observed = self.workflow.read(uri, missing=True)
            return observed["body"] if observed is not None else None
        try:
            return self.read(uri)
        except CommandError as error:
            try:
                recovery = json.loads(error.stderr.splitlines()[0])
            except (ValueError, IndexError):
                raise error
            if recovery.get("code") == "memory-resource-not-found" and recovery.get("requestedUri") == uri:
                return None
            raise

    def is_active(self, uri):
        if self.workflow is not None:
            return self.workflow.read(uri)["state"] == "active"
        return bool(re.search(r"^status: active$", self.call("read", [uri]), re.M))

    def remember(self, record, topic, relations, replace=None, deferred=False, dry_run=False):
        if self.workflow is not None:
            return self.workflow.write(record, topic, memory_text(record), [{"type": kind, "uri": uri} for kind, uri in relations], replace, deferred, dry_run)
        args = ["--kind", record["memoryKind"], "--project", record["project"], "--topic", topic,
                "--status", "active", "--keyword", "dev-plan", "--keyword", record["planId"],
                "--keyword", record["kind"], "--stdin"]
        if record["kind"] in {"current", "target", "implemented"}:
            args += ["--keyword", "architecture"]
        for ref in record["data"].get("codeRefs", []):
            args += ["--code-ref", ref]
        args += ["--defer-code-refs" if deferred else "--require-current-code-refs"]
        for kind, uri in relations:
            args += ["--relation", kind + "=" + uri]
        if replace:
            args += ["--replace", replace]
        if dry_run:
            args += ["--dry-run"]
        output = self.call("remember", args, memory_text(record))
        if dry_run:
            match = re.search(r"Would (?:create|replace) native resource: (threadnote://[^\s]+)", output)
            require(match, "Native preview did not return its exact destination; no write attempted")
            return match.group(1)
        match = re.search(r"Stored memory: (threadnote://[^\s]+)", output)
        require(match, "Unrecognized store response; do not retry the write blindly")
        return match.group(1)

    def preflight(self, record, topic, relations, replace=None, deferred=False):
        if self.workflow is not None:
            preview = self.workflow.prepare(record, topic, memory_text(record), [{"type": kind, "uri": uri} for kind, uri in relations], replace, deferred)
            before = self.peek(preview["canonicalUri"])
            return {"expectedUri": preview["canonicalUri"], "beforeHash": digest(before) if before is not None else None}
        uri = self.remember(record, topic, relations, replace, deferred, dry_run=True)
        before = self.peek(uri)
        return {"expectedUri": uri, "beforeHash": digest(before) if before is not None else None}

    def archive(self, uri):
        if self.workflow is not None:
            return self.workflow.archive(uri)
        output = self.call("archive", [uri])
        match = re.search(r"Stored memory: (threadnote://[^\s]+)", output)
        require(match, "Archive did not return its exact destination")
        return match.group(1)


def reconcile_write(pending, client, uri=None):
    """Return a verified stored URI, or None only when the exact destination is unchanged."""
    destination = uri or pending.get("uri") or pending.get("expectedUri")
    require(destination, "Unknown write outcome; recall the exact topic and supply its actual URI")
    body = client.peek(destination)
    if body is not None and digest(load_record(body)) == pending["hash"]:
        return destination
    if destination == pending.get("expectedUri") and "beforeHash" in pending:
        require((digest(body) if body is not None else None) == pending["beforeHash"],
                "Write destination changed unexpectedly; reconcile concurrent edits")
        return None
    raise PlanError("Recovered memory differs from the intended write")


def load_record(text):
    start = text.rfind(MARKER)
    require(start >= 0, "Memory is not a dev-plan artifact")
    end = text.find(" -->", start)
    require(end >= 0, "Incomplete dev-plan data")
    record = json.loads(text[start + len(MARKER):end])
    require(record.get("schemaVersion") == 1, "Unsupported artifact version")
    require(canonical(memory_text(record)) == canonical(text),
            "Memory text differs from its structured contract; reconcile the edit explicitly")
    return record


def quote(text):
    return json.dumps(str(text).replace('"', "'").replace("\n", " "), ensure_ascii=False)


def phase_diagram(phases):
    lines = ["flowchart LR"]
    numbers = {p["id"]: "p" + str(i) for i, p in enumerate(phases)}
    for phase in phases:
        lines.append("  " + numbers[phase["id"]] + "[" + quote(phase["title"]) + "]")
    for phase in phases:
        for parent in phase["dependsOn"]:
            lines.append("  " + numbers[parent] + " --> " + numbers[phase["id"]])
    return NL.join(lines)


def bullets(title, values):
    return ([f"**{title}**", ""] + ["- " + value for value in values] + [""]) if values else []


def phase_lines(spec):
    lines = [spec["outcome"], ""]
    if spec.get("diagram"):
        lines += [FENCE + "mermaid", spec["diagram"], FENCE, ""]
    lines += bullets("Affected code", spec["affectedPaths"])
    lines += bullets("Key contracts", spec["contracts"])
    lines += ["**Acceptance**", ""]
    for item in spec["acceptance"]:
        lines += ["- " + item["criterion"] + " — Verify: " + item["verification"]]
    lines += ["", "**Safe boundary:** " + spec["safeBoundary"], ""]
    return lines


def memory_text(record, machine=True):
    data, kind = record["data"], record["kind"]
    lines = ["# " + record["title"], ""]
    if kind in {"current", "target", "implemented"}:
        lines += [data["summary"], "", FENCE + "mermaid", data["diagram"], FENCE, ""]
        if kind in {"current", "implemented"}:
            lines += bullets("Invariants", data["invariants"])
            lines += bullets("Uncertainties", data["unknowns"])
            if kind == "implemented":
                lines += bullets("Final contracts", data.get("contracts", []))
                lines += bullets("Deviations from design", data.get("deviations", []))
                lines += bullets("Superseded architecture",
                                 [f"[{key}]({uri})" for key, uri in sorted(data.get("supersededArchitecture", {}).items())])
                lines += bullets("Archived planning history",
                                 [f"[{key}]({uri})" for key, uri in sorted(data.get("archiveMap", {}).items())])
        else:
            lines += bullets("Contracts", data["contracts"])
            lines += bullets("Decisions", [d["choice"] + " — " + d["rationale"] for d in data["decisions"]])
    elif kind == "phase":
        lines += phase_lines(data)
    elif kind == "index":
        lines += bullets("Artifacts", [f"[{key}]({uri})" for key, uri in sorted(data["members"].items())])
    elif kind == "root":
        lines += [data["objective"], "", "**Readiness:** " + data["readiness"], "",
                  FENCE + "mermaid", phase_diagram(data["phaseSummary"]), FENCE, ""]
        lines += bullets("Requirements", [r["id"] + ": " + r["behavior"] for r in data["requirements"]])
        lines += bullets("Artifacts", [f"[{key}]({uri})" for key, uri in sorted(data["children"].items())])
        if "singlePhase" in data:
            lines += phase_lines(data["singlePhase"])
        lines += bullets("Open questions", data["openQuestions"])
        lines += ["**Implementation closeout**", "",
                  "After every phase is verified, reconcile the target design with the actual code. "
                  "Resolve and bind current code-graph references, including newly created symbols. "
                  "Use the dev-plan closeout satellite to save the verified implemented architecture as "
                  "private durable knowledge before archiving this plan's obsolete baseline and planning "
                  "artifacts. Keep relevant prior-memory links and record design deviations. "
                  "Pending graph citations mean architecture closeout is pending; do not retire the baseline. "
                  "Retire other recalled architecture only after verifying that its full scope is superseded.",
                  ""]
    lines += bullets("Code anchors", data.get("codeRefs", []))
    lines += bullets("Relevant prior memories", [f"[Memory]({uri})" for uri in data.get("contextRefs", [])])
    if data.get("contextNote") and not data.get("contextRefs"):
        lines += [data["contextNote"], ""]
    if machine:
        # Compact, non-instructional data enables deterministic reload. Previews omit it.
        lines += [MARKER + encoded(record).replace("--", "\\u002d\\u002d") + " -->"]
    return NL.join(lines).strip() + NL


def record_for(plan, kind, data, title):
    return {"schemaVersion": 1, "planId": plan["id"], "project": plan["project"],
            "memoryKind": "durable",
            "kind": kind, "title": title, "data": data}


def pin(client, uri):
    content = client.read(uri)
    return {"uri": uri, "sha256": hashlib.sha256(content.encode()).hexdigest(),
            "role": "decision", "usedFor": ""}


def verify_sources(plan, client):
    for source in plan["recall"]["sources"]:
        require(pin(client, source["uri"])["sha256"] == source["sha256"],
                "Recalled memory changed; reconcile before saving: " + source["uri"])
    if plan.get("spec"):
        verify_spec_input(plan["spec"], client, plan["id"], plan["project"])


def save(plan, state_path, client, review=None, draft=False, deferred=False):
    wt.configure(client, state_path, plan["project"], plan["id"], plan["scope"]["repo"])
    require(not deferred or draft, "Deferred citations can only be saved as draft")
    validate(plan, ready=not draft, review=review)
    verify_sources(plan, client)
    state_path = Path(state_path)
    state_path.parent.mkdir(parents=True, exist_ok=True)
    with open(str(state_path) + ".lock", "a+b") as lock:
        try:
            lock_exclusive(lock, blocking=False)
        except BlockingIOError:
            raise PlanError("Another save owns this receipt file")
        state = read_json(state_path) if state_path.exists() else {
            "schemaVersion": 1, "planId": plan["id"], "project": plan["project"],
            "repo": plan["scope"]["repo"], "runId": uuid.uuid4().hex[:12],
            "receipts": {}, "history": {}}
        wt.receipt_context(client, state)
        write_json(state_path, state)
        require((state["planId"], state["project"], state["repo"]) ==
                (plan["id"], plan["project"], plan["scope"]["repo"]), "Receipt file belongs to another plan")
        require(not state.get("pending"), "A write outcome is unresolved; run recover to reconcile its destination")
        used_keys = set()

        def put(key, record, relations):
            used_keys.add(key)
            relations = list(dict.fromkeys(relations))
            require(len(relations) <= 16, key + " exceeds native relation limit")
            record["relations"] = [{"type": kind, "uri": uri} for kind, uri in relations]
            record["citationPolicy"] = "defer" if deferred else "require-current"
            record["runId"] = state["runId"]
            old = state["receipts"].get(key)
            same_storage = False
            if old:
                observed = load_record(client.read(old["uri"]))
                require(digest(observed) == old["hash"], "Stored artifact changed outside this draft: " + key)
                same_storage = observed.get("memoryKind") == record["memoryKind"]
                if key == "root" and not same_storage:
                    state.setdefault("history", {})[old["uri"]] = old["hash"]
                    record["data"]["priorArtifacts"][old["uri"]] = old["hash"]
            require(len(memory_text(record).encode()) <= 60000, key + " is too large; narrow or split its content")
            fingerprint = digest(record)
            if old and old["hash"] == fingerprint:
                return old["uri"]
            topic = f'{plan["id"]}-{state["runId"]}-{key}-{fingerprint[:16]}'
            # Root advances only after every new immutable child has been verified.
            if key == "root":
                topic = plan["id"] + "-" + state["runId"] + "-plan-durable"
            # Native replacement preserves its URI/kind. A legacy handoff root
            # gets a new durable identity, retaining the old root as history.
            replacement = old["uri"] if old and key == "root" and same_storage else None
            preview = client.preflight(record, topic, relations,
                                       replace=replacement, deferred=deferred)
            state["pending"] = {"key": key, "hash": fingerprint, "topic": topic, "record": record, **preview}
            write_json(state_path, state)
            uri = client.remember(record, topic, relations,
                                  replace=replacement, deferred=deferred)
            state["pending"]["uri"] = uri
            write_json(state_path, state)
            require(digest(load_record(client.read(uri))) == fingerprint, "Memory readback mismatch: " + key)
            if old and old["uri"] != uri:
                state.setdefault("history", {})[old["uri"]] = old["hash"]
            state["receipts"][key] = {"uri": uri, "hash": fingerprint}
            state.pop("pending")
            write_json(state_path, state)
            return uri

        def refs(spec):
            return [("references", uri) for uri in spec.get("contextRefs", [])]

        children = {}
        children["current"] = put("current", record_for(plan, "current", plan["current"],
                                                       plan["title"] + " — current architecture"),
                                  refs(plan["current"]))
        children["target"] = put("target", record_for(plan, "target", plan["target"],
                                                     plan["title"] + " — target architecture"),
                                 refs(plan["target"]) + [("references", children["current"])])
        if len(plan["phases"]) > 1:
            for phase in order(plan["phases"]):
                key = "phase-" + phase["id"]
                links = refs(phase) + [("references", children["current"]), ("references", children["target"])]
                links += [("depends_on", children["phase-" + p]) for p in phase["dependsOn"]]
                children[key] = put(key, record_for(plan, "phase", phase, phase["title"]), links)
        root = {key: value for key, value in plan.items() if key not in {"current", "target", "phases"}}
        root.update({"children": children, "readiness": "draft" if draft else "ready",
                     "planCodeRefs": plan["codeRefs"],
                     "phaseSummary": [{"id": p["id"], "title": p["title"], "dependsOn": p["dependsOn"]}
                                      for p in plan["phases"]]})
        root_refs = refs(plan)
        if len(plan["phases"]) == 1:
            root["singlePhase"] = plan["phases"][0]
            root_refs += refs(plan["phases"][0])
            root["codeRefs"] = list(dict.fromkeys(plan["codeRefs"] + plan["phases"][0]["codeRefs"]))
            require(len(root["codeRefs"]) <= 8, "Single plan exceeds native eight-code-ref limit")
        navigation = dict(children)
        level = 0
        while len(set(root_refs)) + len(navigation) > 16:
            grouped = {}
            items = list(navigation.items())
            for start in range(0, len(items), 16):
                members = dict(items[start:start + 16])
                key = f"index-{level}-{start // 16}"
                record = record_for(plan, "index", {"members": members}, plan["title"] + " — artifact index")
                grouped[key] = put(key, record, [("references", uri) for uri in members.values()])
            require(len(grouped) < len(navigation), "Too many root context links for native relations")
            navigation = grouped
            level += 1
        root["reviewReceipt"] = review if review else None
        root["navigation"] = navigation
        for key in list(state["receipts"]):
            if key != "root" and key not in used_keys:
                obsolete = state["receipts"].pop(key)
                state.setdefault("history", {})[obsolete["uri"]] = obsolete["hash"]
        root["priorArtifacts"] = dict(state.get("history", {}))
        root_uri = put("root", record_for(plan, "root", root, plan["title"]),
                       root_refs + [("references", uri) for uri in navigation.values()])
        state["rootUri"] = root_uri
        state["planHash"] = digest(plan)
        write_json(state_path, state)
        return {"rootUri": root_uri, "readiness": root["readiness"], "artifacts": children}


def recover(state_path, uri, client):
    state = read_json(state_path)
    pending = state.get("pending")
    require(pending, "There is no pending write")
    uri = reconcile_write(pending, client, uri)
    if uri is None:
        state.pop("pending")
        write_json(state_path, state)
        return {"status": "not-written", "next": "Exact destination unchanged; retry save after resolving the error"}
    old = state["receipts"].get(pending["key"])
    if old and pending["key"] != "root" and old["uri"] != uri:
        state.setdefault("history", {})[old["uri"]] = old["hash"]
    state["receipts"][pending["key"]] = {"uri": uri, "hash": pending["hash"]}
    state.pop("pending")
    write_json(state_path, state)
    return {"recovered": uri, "next": "Rerun save with the same draft and receipt file"}


def load_plan(uri, client):
    record = load_record(client.read(uri))
    require(record["kind"] == "root", "Expected a root plan memory")
    data = record["data"]
    plan = {key: value for key, value in data.items()
            if key not in {"children", "phaseSummary", "singlePhase", "readiness", "reviewReceipt",
                           "planCodeRefs", "navigation", "priorArtifacts"}}
    plan["codeRefs"] = data.get("planCodeRefs", data["codeRefs"])
    for kind in ("current", "target"):
        child = load_record(client.read(data["children"][kind]))
        require(child["kind"] == kind and child["planId"] == plan["id"], "Wrong architecture child")
        plan[kind] = child["data"]
    plan["phases"] = [data["singlePhase"]] if "singlePhase" in data else []
    if not plan["phases"]:
        for summary in data["phaseSummary"]:
            child = load_record(client.read(data["children"]["phase-" + summary["id"]]))
            require(child["kind"] == "phase" and child["planId"] == plan["id"], "Wrong phase child")
            plan["phases"].append(child["data"])
    return plan, record


def template(scope, args):
    anchors = list(scope["files"])[:4]
    context = {"contextRefs": [], "contextNote": "", "codeRefs": anchors}
    return {
        "schemaVersion": 1, "id": args.id, "project": args.project, "title": args.title,
        "objective": args.objective, "scope": scope, **context,
        "requirements": [{"id": "R1", "behavior": args.objective}],
        "recall": {"queries": [], "sources": []},
        "current": {**context, "summary": "", "diagram": "", "invariants": [], "unknowns": []},
        "target": {**context, "summary": "", "diagram": "", "contracts": [], "decisions": []},
        "phases": [{"id": "deliver", "title": args.title, "outcome": "", "dependsOn": [],
                    **context, "affectedPaths": scope["paths"], "newPaths": [], "contracts": [],
                    "acceptance": [{"id": "A1", "criterion": "", "verification": "", "requirements": ["R1"]}],
                    "safeBoundary": ""}],
        "openQuestions": [], "review": {"required": True, "reason": ""}
    }


def render(plan, directory):
    validate(plan, check_source=False)
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    records = {"current": record_for(plan, "current", plan["current"], plan["title"] + " — current"),
               "target": record_for(plan, "target", plan["target"], plan["title"] + " — target")}
    for phase in plan["phases"]:
        records["phase-" + phase["id"]] = record_for(plan, "phase", phase, phase["title"])
    root = {**plan, "readiness": "local preview", "phaseSummary": plan["phases"],
            "children": {key: key + ".md" for key in records}}
    records["plan"] = record_for(plan, "root", root, plan["title"])
    for key, record in records.items():
        (directory / (key + ".md")).write_text(memory_text(record, machine=False), encoding="utf-8")
    return {"preview": str(directory), "files": [key + ".md" for key in records]}


def render_check(plan, command):
    require(Path(command).is_absolute() and Path(command).is_file(), "Use an absolute Mermaid CLI path")
    diagrams = [plan["current"]["diagram"], plan["target"]["diagram"], phase_diagram(plan["phases"])]
    diagrams += [p["diagram"] for p in plan["phases"] if p.get("diagram")]
    with tempfile.TemporaryDirectory(prefix="dev-plan-mermaid-") as directory:
        for i, diagram in enumerate(diagrams):
            source = Path(directory) / f"{i}.mmd"
            source.write_text(diagram, encoding="utf-8")
            run([command, "-i", str(source), "-o", str(source.with_suffix(".svg"))])
    return {"mermaid": "rendered successfully", "diagrams": len(diagrams)}


def differences(before, after):
    old = {p["id"]: p for p in before["phases"]}
    new = {p["id"]: p for p in after["phases"]}
    changed = {key for key in old.keys() | new.keys() if old.get(key) != new.get(key)}
    if before["target"] != after["target"] or before["current"] != after["current"]:
        changed.update(new)
    affected = set(changed)
    while True:
        expanded = affected | {p["id"] for p in after["phases"] if affected.intersection(p["dependsOn"])}
        if expanded == affected:
            break
        affected = expanded
    return {"changedPhases": sorted(changed), "affectedPhases": sorted(affected),
            "currentChanged": before["current"] != after["current"],
            "targetChanged": before["target"] != after["target"],
            "userDecisionNeeded": before["objective"] != after["objective"]
            or before["requirements"] != after["requirements"]
            or before["target"]["contracts"] != after["target"]["contracts"]}


def export_cycle(uri, client, delivery, bindings):
    require(client.is_active(uri), "Archived planning history cannot be exported for execution")
    plan, root = load_plan(uri, client)
    require(root["data"]["readiness"] == "ready", "Only a ready plan can be exported for execution")
    validate(plan, ready=True, review=root["data"].get("reviewReceipt"))
    verify_sources(plan, client)
    contents = {uri: client.read(uri)}
    if plan.get("spec"):
        for link, expected in plan["spec"]["memoryHashes"].items():
            require(client.is_active(link), "Spec artifact was retired; reconcile before executing")
            contents[link] = client.read(link)
            require(hashlib.sha256(contents[link].encode()).hexdigest() == expected, "Spec revision drift")
    architecture = [root["data"]["children"][key] for key in ("current", "target")]
    for link in architecture:
        contents[link] = client.read(link)
    phases = []
    for phase in plan["phases"]:
        require(phase["id"] in bindings, "Missing explicit branch binding for " + phase["id"])
        branch = bindings[phase["id"]]
        for field in ("branch", "baseBranch"):
            nonempty(branch.get(field), field)
        links = list(architecture)
        if len(plan["phases"]) > 1:
            links.append(root["data"]["children"]["phase-" + phase["id"]])
            links += [root["data"]["children"]["phase-" + dep] for dep in phase["dependsOn"]]
        links += phase["contextRefs"]
        if plan.get("spec"):
            links += list(plan["spec"]["memoryHashes"])
        links = list(dict.fromkeys(links))
        for link in links:
            contents.setdefault(link, client.read(link))
        phases.append({"id": phase["id"], "title": phase["title"], "dependsOn": phase["dependsOn"],
                       "memoryUris": links, "allowedPaths": phase["affectedPaths"],
                       "acceptanceCriteria": [a["criterion"] for a in phase["acceptance"]],
                       "safeToMergeReason": phase["safeBoundary"], "branch": branch["branch"],
                       "baseBranch": branch["baseBranch"], "status": "pending",
                       "acceptanceRefs": [{"id": a["id"], "criterion": a["criterion"],
                                           "requirements": a["requirements"], "specScenarios": a.get("specScenarios", [])}
                                          for a in phase["acceptance"]]})
    return ({"objective": plan["objective"], "delivery": delivery, "planMemoryUris": [uri],
             "memoryHashes": {key: hashlib.sha256(value.encode()).hexdigest() for key, value in contents.items()},
             "featureId": plan["id"], "spec": plan.get("spec"),
             **({"workflowContext": wt.locator(client)} if wt.locator(client) else {}),
             "phases": phases, "completion": {"skill": "dev-plan", "rootUri": uri,
                "specRootUri": plan.get("spec", {}).get("rootUri"),
                "required": "Bind verified current code refs to implemented architecture before retiring baseline"}},
            contents)


def closeout_input(uri, scope, client, directory):
    plan, root = load_plan(uri, client)
    implemented = {**plan["target"], "scope": scope, "invariants": [], "unknowns": [],
                   "deviations": [], "codeRefs": [], "recallSources": plan["recall"]["sources"]}
    implemented.pop("decisions", None)
    evidence = {"rootHash": digest(root), "scopeHash": digest(scope), "architectureVerification": "",
                "phases": [{"id": p["id"], "status": "pending",
                            "acceptance": [{"id": a["id"], "evidence": ""} for a in p["acceptance"]]}
                           for p in plan["phases"]]}
    directory = Path(directory)
    require(not (directory / "implemented.json").exists() and not (directory / "evidence.json").exists(),
            "Closeout draft already exists; revise it instead of overwriting")
    write_json(directory / "implemented.json", implemented)
    write_json(directory / "evidence.json", evidence)
    return {"implemented": str(directory / "implemented.json"), "evidence": str(directory / "evidence.json"),
            "next": "Reconcile with actual code; bind real current codeRefs and record observed evidence"}


def verify_spec_input(packet, client, feature_id, project):
    for uri, expected in packet["memoryHashes"].items():
        require(client.is_active(uri) and pin(client, uri)["sha256"] == expected, "Spec input memory changed or is inactive")
    body = client.read(packet["rootUri"])
    marker = "<!-- dev-spec:v1 "
    start = body.rfind(marker)
    require(start >= 0, "Expected a native dev-spec root")
    root = json.loads(body[start + len(marker):body.find(" -->", start)])
    expected_body = root["markdown"].strip() + "\n\n" + marker + encoded(root).replace("--", "\\u002d\\u002d") + " -->\n"
    require(body.strip() == expected_body.strip(), "Spec body and structured intent diverged")
    require(root["kind"] == "root" and root["data"]["status"] == "ready"
            and root["data"]["specHash"] == packet["revision"], "Spec root is not the approved packet revision")
    core = root["data"]["core"]
    require(set(packet["memoryHashes"]) == {packet["rootUri"], *root["data"]["children"].values()},
            "Spec packet must pin the complete artifact set")
    require(packet["featureId"] == feature_id == core["id"] and project == core["project"], "Spec identity changed")
    require(packet["requirements"] == [{"id": r["id"], "behavior": r["behavior"]} for r in core["requirements"]]
            and packet["scenarios"] == core["scenarios"] and packet["constraints"] == core["constraints"]
            and packet["outOfScope"] == core["outOfScope"], "Spec packet obligations differ from its authoritative memory")
    return core


def from_spec(packet, scope, client):
    """Import approved obligations; leave architecture and phase design unfinished."""
    wt.attach_inherited(client, packet.get("workflowContext"), scope["repo"])
    from types import SimpleNamespace
    require(packet.get("kind") == "dev-spec-plan-input" and packet.get("schemaVersion") == 1, "Unsupported spec packet")
    require(packet.get("packetHash") == digest({k: v for k, v in packet.items() if k not in {"packetHash", "workflowContext"}}), "Spec packet changed")
    sources = []
    for uri, expected in packet["memoryHashes"].items():
        require(client.is_active(uri), "Spec input is inactive")
        source = pin(client, uri)
        require(source["sha256"] == expected, "Spec input memory changed")
        sources.append({**source, "role": "constraint", "usedFor": "Approved behavior/domain contract from dev-spec"})
    core = verify_spec_input(packet, client, packet["featureId"], packet["project"])
    require(all(packet[k] == core[k] for k in ("title", "objective", "project")), "Spec packet identity changed")
    require(len(sources) <= 13, "Narrow this spec handoff to at most thirteen relevant artifact memories")
    plan = template(scope, SimpleNamespace(id=packet["featureId"], project=packet["project"],
                                          title=packet["title"], objective=packet["objective"]))
    plan["spec"] = {k: packet[k] for k in ("featureId", "rootUri", "revision", "memoryHashes", "requirements", "scenarios", "constraints", "outOfScope")}
    plan["requirements"] = packet["requirements"]
    plan["recall"] = {"queries": ["Explicit approved dev-spec handoff " + packet["rootUri"]], "sources": sources}
    uris = list(packet["memoryHashes"])
    plan["contextRefs"] = uris
    plan["current"]["contextRefs"] = [packet["rootUri"]]
    plan["target"]["contextRefs"] = uris
    plan["phases"][0]["contextRefs"] = uris
    plan["phases"][0]["acceptance"] = [
        {"id": s["id"], "criterion": "Given " + s["given"] + "; when " + s["when"] + "; then " + s["then"],
         "requirements": s["requirementIds"], "specScenarios": [s["id"]], "verification": ""}
        for s in packet["scenarios"]]
    plan["openQuestions"] = ["Complete code-grounded architecture, phase boundaries and verification methods."]
    return plan


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--threadnote-home", help="Isolated Threadnote store; normally omit")
    wt.add_arguments(parser)
    commands = parser.add_subparsers(dest="command", required=True)
    cmd = commands.add_parser("inspect")
    cmd.add_argument("--repo", required=True)
    cmd.add_argument("--path", action="append", required=True)
    cmd.add_argument("--out", required=True)
    cmd = commands.add_parser("init")
    for name in ("scope", "id", "project", "title", "objective", "out"):
        cmd.add_argument("--" + name, required=True)
    cmd = commands.add_parser("pin")
    cmd.add_argument("--uri", required=True)
    cmd.add_argument("--out", required=True)
    cmd = commands.add_parser("from-spec")
    cmd.add_argument("--packet", required=True)
    cmd.add_argument("--scope", required=True)
    cmd.add_argument("--out", required=True)
    for name in ("validate", "render", "review-packet", "save"):
        cmd = commands.add_parser(name)
        cmd.add_argument("--plan", required=True)
        if name in {"render", "review-packet"}:
            cmd.add_argument("--out", required=True)
        if name in {"validate", "save"}:
            cmd.add_argument("--review")
        if name == "validate":
            cmd.add_argument("--ready", action="store_true")
            cmd.add_argument("--mermaid-cli")
        if name == "save":
            cmd.add_argument("--state", required=True)
            cmd.add_argument("--draft", action="store_true")
            cmd.add_argument("--defer-code-refs", action="store_true")
    cmd = commands.add_parser("recover")
    cmd.add_argument("--state", required=True)
    cmd.add_argument("--uri")
    cmd = commands.add_parser("load")
    cmd.add_argument("--root", required=True)
    cmd.add_argument("--out", required=True)
    cmd.add_argument("--state", required=True)
    cmd = commands.add_parser("diff")
    cmd.add_argument("--before", required=True)
    cmd.add_argument("--after", required=True)
    cmd = commands.add_parser("export-dev-cycle")
    cmd.add_argument("--root", required=True)
    cmd.add_argument("--delivery", choices=["local", "commit", "pr"], required=True)
    cmd.add_argument("--bindings", required=True)
    cmd.add_argument("--out", required=True)
    cmd = commands.add_parser("closeout-input")
    cmd.add_argument("--root", required=True)
    cmd.add_argument("--scope", required=True)
    cmd.add_argument("--out", required=True)
    args = parser.parse_args()
    plan = read_json(args.plan) if hasattr(args, "plan") else None
    client = Threadnote(plan["scope"]["repo"] if plan else None, args.threadnote_home, **wt.options(args))
    review = read_json(args.review) if getattr(args, "review", None) else None
    if args.command == "inspect":
        result = inspect(args.repo, args.path)
        write_json(args.out, result)
    elif args.command == "init":
        require(not Path(args.out).exists(), "Draft already exists; load/revise it instead")
        write_json(args.out, template(read_json(args.scope), args))
        result = {"draft": args.out, "ready": False}
    elif args.command == "from-spec":
        require(not Path(args.out).exists(), "Plan draft exists; reconcile instead of overwriting")
        scope = read_json(args.scope)
        client.repo = scope["repo"]
        packet = read_json(args.packet)
        context = packet.get("workflowContext")
        if context:
            wt.require(Path(context).is_file(), "Upstream workflow context is missing")
            wt.require(not args.workflow_context or Path(args.workflow_context).resolve() == Path(context).resolve(), "Explicit context conflicts with approved spec handoff")
            client = Threadnote(scope["repo"], args.threadnote_home, **{**wt.options(args), "workflow_context": context})
        result = from_spec(packet, scope, client)
        write_json(args.out, result)
        wt.carry(client, args.out)
        result = {"draft": args.out, "ready": False, "featureId": result["id"]}
    elif args.command == "pin":
        result = pin(client, args.uri)
        write_json(args.out, result)
    elif args.command == "validate":
        result = validate(plan, args.ready, review)
        if args.mermaid_cli:
            result.update(render_check(plan, args.mermaid_cli))
    elif args.command == "render":
        result = render(plan, args.out)
    elif args.command == "review-packet":
        validation = validate(plan)
        write_json(args.out, {"planHash": digest(plan), "plan": plan, "validation": validation,
                             "scope": "Read-only review; final JSON artifact only; use references/review.md"})
        result = {"packet": args.out, "planHash": digest(plan)}
    elif args.command == "save":
        wt.configure(client, args.state, plan["project"], plan["id"], plan["scope"]["repo"], wt.inherit(args.plan))
        result = save(plan, args.state, client, review, args.draft, args.defer_code_refs)
    elif args.command == "recover":
        state = read_json(args.state)
        wt.configure(client, args.state, state["project"], state["planId"], state["repo"])
        result = recover(args.state, args.uri, client)
    elif args.command == "load":
        plan, record = load_plan(args.root, client)
        receipts = {"root": {"uri": args.root, "hash": digest(record)}}
        require(not Path(args.state).exists(), "Receipt file exists; do not overwrite concurrent work")
        queue = list(record["data"]["children"].items()) + list(record["data"].get("navigation", {}).items())
        while queue:
            key, uri = queue.pop(0)
            if key in receipts:
                continue
            child = load_record(client.read(uri))
            receipts[key] = {"uri": uri, "hash": digest(child)}
            if child["kind"] == "index":
                queue += list(child["data"]["members"].items())
        require(not Path(args.out).exists(), "Draft exists; do not overwrite unsaved edits")
        write_json(args.out, plan)
        write_json(args.state, {"schemaVersion": 1, "planId": plan["id"], "project": plan["project"],
                               "repo": plan["scope"]["repo"], "rootUri": args.root, "receipts": receipts,
                               "runId": record["runId"], "history": record["data"].get("priorArtifacts", {}),
                               **({"workflowContext": wt.locator(client)} if wt.locator(client) else {})})
        result = {"draft": args.out, "state": args.state}
    elif args.command == "diff":
        result = differences(read_json(args.before), read_json(args.after))
    elif args.command == "closeout-input":
        result = closeout_input(args.root, read_json(args.scope), client, args.out)
    else:
        exported, contents = export_cycle(args.root, client, args.delivery, read_json(args.bindings))
        directory = Path(args.out)
        write_json(directory / "plan.json", exported)
        write_json(directory / "memory-content.json", contents)
        result = {"plan": str(directory / "plan.json"), "memories": str(directory / "memory-content.json")}
    print(json.dumps(wt.result_context(client, result), ensure_ascii=True, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (PlanError, KeyError, ValueError, OSError, subprocess.TimeoutExpired) as error:
        print(json.dumps(wt.cli_error(error), ensure_ascii=True), file=sys.stderr)
        sys.exit(1)

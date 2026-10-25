"""Versioned native workflow-memory transport; local receipts stay outside artifact bodies."""
import sys
sys.dont_write_bytecode = True

import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import uuid

from portable_lock import lock_exclusive


class WorkflowError(ValueError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def require(value, message):
    if not value:
        raise WorkflowError("workflow-context-conflict", message)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


def body_hash(body):
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def save_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, ensure_ascii=True, indent=2)
            stream.write("\n")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextlib.contextmanager
def locked(path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with Path(str(path) + ".lock").open("a+b") as stream:
        lock_exclusive(stream, blocking=False)
        yield


def generation():
    root = Path(__file__).resolve().parents[2]
    if re.fullmatch(r"[a-f0-9]{64}", root.name):
        return root.name
    # Source-mode identity has no author path and never writes into the payload.
    hashes = [(p.relative_to(root).as_posix(), hashlib.sha256(p.read_bytes()).hexdigest())
              for skill in ("dev-spec", "dev-plan", "dev-cycle", "watch-pr")
              for p in sorted((root / skill).rglob("*"))
              if p.is_file() and p.name != ".DS_Store" and "__pycache__" not in p.parts and p.suffix != ".pyc"]
    return "source-" + digest(hashes)


def add_arguments(parser):
    parser.add_argument("--workflow-context", help="Private shared workflow context file; required for bound reads/resume")
    parser.add_argument("--workflow-profile", choices=["desktop", "codex-cloud-personal", "cursor-cloud-personal"])
    parser.add_argument("--workflow-team", help="Initial personal-cloud publication team")
    parser.add_argument("--workflow-generation", help="Explicit immutable helper generation pin")


def options(args):
    return {name: getattr(args, name, None) for name in
            ("workflow_context", "workflow_profile", "workflow_team", "workflow_generation")}


def locator(client):
    transport = getattr(client, "workflow", None)
    return str(transport.path) if transport is not None else None


def receipt_context(client, state):
    context = locator(client)
    if context is not None:
        require(state.get("workflowContext", context) == context, "Receipt belongs to another workflow context")
        state["workflowContext"] = context
    return state


def sidecar(path):
    return Path(str(path) + ".workflow-context.json")


def carry(client, path):
    context = locator(client)
    if context is not None:
        save_json(sidecar(path), {"workflowContext": context})


def inherit(path):
    return read_json(sidecar(path)).get("workflowContext") if sidecar(path).exists() else None


def require_desktop_legacy(home):
    environment = os.environ
    cloud = any(environment.get(key) for key in
                ("THREADNOTE_CURSOR_CLOUD_TEAM", "THREADNOTE_CURSOR_CLOUD_TEAMS", "THREADNOTE_CURSOR_CLOUD_MODE"))
    cloud = cloud or "cloud" in environment.get("THREADNOTE_MCP_TOOLSET", "")
    context_home = Path(home).expanduser() if home else Path(environment.get("THREADNOTE_HOME", Path.home() / ".threadnote"))
    cloud = cloud or any((context_home / profile / "profile.json").exists() for profile in ("codex-cloud", "cursor-cloud"))
    if cloud:
        raise WorkflowError("workflow-context-required", "Personal cloud requires --workflow-context or a new save receipt; legacy desktop receipts cannot be interpreted as cloud state")


class WorkflowTransport:
    def __init__(self, path, repo=None, home=None, profile=None, team=None, generation_pin=None, invoke=None):
        self.path = Path(path).expanduser().resolve()
        self.repo = str(Path(repo).resolve()) if repo else None
        self.home = str(Path(home).expanduser().resolve()) if home else None
        self.profile, self.team = profile, team
        self.generation = generation()
        require(generation_pin is None or generation_pin == self.generation,
                "Explicit workflow generation does not match these actual helper resources")
        self.invoke = invoke
        self._binding_identity = None
        self.state = read_json(self.path) if self.path.exists() else None
        if self.state is not None and "binding" in self.state:
            self._validate()

    def _validate(self):
        require(isinstance(self.state, dict) and self.state.get("protocolVersion") == 1
                and isinstance(self.state.get("binding"), dict), "Unsupported workflow context")
        binding = self.state["binding"]
        require(binding.get("generation") == self.generation, "Use the workflow's pinned immutable helper generation")
        require(self.repo is None or str(Path(binding["repo"]).resolve()) == self.repo, "Workflow checkout changed")
        require(self.home is None or str(Path(binding["home"]).resolve()) == self.home, "Workflow data home changed")
        require(self.profile is None or binding["profile"] == self.profile, "Workflow profile changed")
        require(self.team is None or binding.get("team") == self.team, "Workflow publication team changed")
        identity = digest(binding)
        require(self._binding_identity is None or identity == self._binding_identity,
                "Workflow binding identity changed during this operation")
        self._binding_identity = identity
        self.repo, self.home = str(Path(binding["repo"]).resolve()), str(Path(binding["home"]).resolve())

    @property
    def binding(self):
        require(self.state is not None and "binding" in self.state, "Initialize or recover workflow context by saving the original spec or plan first")
        return self.state["binding"]

    @property
    def cloud(self):
        return self.binding["profile"] != "desktop"

    def request(self, action, **fields):
        request = {"protocolVersion": 1, "action": action, **fields}
        if action != "bind":
            request["bindingId"] = self.binding["bindingId"]
        if self.invoke:
            result = self.invoke(request)
        else:
            argv = ["threadnote", "workflow-memory"] + (["--home", self.home] if self.home else [])
            completed = subprocess.run(argv, input=json.dumps(request, ensure_ascii=True), text=True,
                                       encoding="utf-8", capture_output=True, cwd=self.repo, timeout=55)
            try:
                result = json.loads(completed.stdout)
            except (ValueError, TypeError) as error:
                raise WorkflowError("workflow-protocol-invalid", "workflow-memory did not return a structured JSON result") from error
            require(isinstance(result, dict), "Invalid workflow JSON result")
            if completed.returncode and result.get("status") != "error":
                raise WorkflowError("workflow-protocol-invalid", "workflow-memory exited without a structured error")
        require(isinstance(result, dict) and result.get("protocolVersion") == 1, "Invalid workflow protocol version/result")
        if result.get("status") == "error":
            raise WorkflowError(result.get("code", "workflow-error"), result.get("message", "Workflow operation failed"))
        allowed = {"ok", "not-found"} if action == "read" else {"ok", "pending"} if action == "publication-publish" else {"ok"}
        require(result.get("status") in allowed, "Unexpected workflow operation status")
        return result

    def bind(self, project, feature_id):
        with locked(self.path):
            if self.path.exists():
                self.state = read_json(self.path)
                if "binding" in self.state:
                    self._validate()
                    require(self.binding["project"] == project and self.binding["featureId"] == feature_id, "Workflow feature/project changed")
                    return
                request = self.state.get("pendingBinding")
                require(isinstance(request, dict) and request.get("project") == project
                        and request.get("featureId") == feature_id and request.get("generation") == self.generation,
                        "Unresolved initial binding belongs to another workflow")
            else:
                request = {"workflowRunId": uuid.uuid4().hex, "project": project, "featureId": feature_id,
                           "generation": self.generation}
                if self.profile is not None:
                    request["profile"] = self.profile
                if self.team is not None:
                    request["team"] = self.team
                self.state = {"protocolVersion": 1, "pendingBinding": request}
                save_json(self.path, self.state)
            result = self.request("bind", **request)
            binding = result.get("binding", {})
            require(isinstance(binding, dict), "Invalid workflow binding result")
            require(all(binding.get(key) == value for key, value in request.items() if key != "team")
                    and ("team" not in request or binding.get("team") == request["team"]), "Runtime returned a different workflow binding")
            self.state = {"protocolVersion": 1, "binding": binding, "operations": {}}
            self._validate()
            save_json(self.path, self.state)

    def read(self, uri, missing=False):
        result = self.request("read", uri=uri)
        if result["status"] == "not-found":
            require(result.get("requestedUri") == uri, "Not-found result targets another request")
            if missing:
                return None
            raise WorkflowError("workflow-artifact-not-found", "Workflow artifact was not found: " + uri)
        require(result.get("verifiedReadback") is True and isinstance(result.get("body"), str), "Workflow readback is incomplete")
        require(result.get("bodySha256") == body_hash(result["body"]), "Workflow readback body digest mismatch")
        require(re.fullmatch(r"[a-f0-9]{64}", result.get("revision", "")) is not None, "Workflow revision is missing")
        require(isinstance(result.get("canonicalUri"), str) and result.get("state") in {"active", "archived", "expired", "superseded"}, "Workflow identity/state missing")
        return result

    def _accept(self, pending, result):
        require(result.get("operationId", pending["request"]["operationId"]) == pending["request"]["operationId"], "Workflow operation identity mismatch")
        uri = result.get("canonicalUri")
        require(isinstance(uri, str), "Workflow mutation has no exact destination")
        require(uri == pending["preview"]["canonicalUri"], "Workflow mutation changed its preflight destination")
        observed = self.read(uri)
        require(result.get("verifiedReadback") is True and result.get("revision") == observed["revision"], "Workflow mutation readback revision mismatch")
        expected = pending["request"].get("bodySha256", pending.get("sourceBodySha256"))
        require(expected == observed["bodySha256"], "Workflow mutation readback differs from intended body")
        if pending["request"]["action"] == "archive":
            require(observed["state"] == "archived", "Workflow archive readback is not archived")
        else:
            require(observed["state"] == "active", "Workflow write readback is not active")
            require(observed.get("storageKind") == pending["request"]["storageKind"],
                    "Workflow write readback has a different storage kind")
        self.state["operations"][pending["key"]] = {"request": pending["request"], "preview": pending["preview"], "result": result}
        self.state.pop("pending", None)
        save_json(self.path, self.state)
        return uri

    def recover(self, archive_plan=None):
        with locked(self.path):
            self.state = read_json(self.path)
            self._validate()
            pending = self.state.get("pending")
            if archive_plan is not None:
                # Recheck under the replay lock: another helper may have changed pending intent
                # after the caller's admission check released its own lock.
                require(archive_plan.get("bindingId") == self.binding["bindingId"]
                        and archive_plan.get("generation") == self.generation
                        and archive_plan.get("bindingHash") == digest(self.binding),
                        "Archive recovery belongs to another full workflow identity")
                require(not pending or (pending["key"] == "archive:" + archive_plan["request"]["uri"]
                        and pending["request"] == archive_plan["request"]
                        and pending.get("sourceBodySha256") == archive_plan["sourceBodySha256"]
                        and (pending.get("preview") == archive_plan["preview"]
                             or (pending.get("stage") == "preflight" and pending.get("preview") is None))),
                        "Pending workflow mutation differs from the admitted archive recovery")
            if not pending or pending.get("stage") != "mutation":
                return
            try:
                result = self.request("recover", operationId=pending["request"]["operationId"])
            except WorkflowError as error:
                if error.code != "operation-not-found":
                    raise
                request = dict(pending["request"])
                result = self.request(request.pop("action"), **{k: v for k, v in request.items() if k not in {"protocolVersion", "bindingId"}})
            self._accept(pending, result)

    def prepare(self, record, topic, body, relations, replace=None, deferred=False):
        return json.loads(self._prepare_write(record, topic, body, relations, replace, deferred))["preview"]

    def _write_admission(self, key, operation):
        require(isinstance(operation, dict) and isinstance(operation.get("request"), dict), "Invalid workflow write attempt")
        request = operation["request"]
        require(isinstance(request.get("operationId"), str) and bool(request["operationId"])
                and "expectedRevision" in request
                and (request["expectedRevision"] is None or isinstance(request["expectedRevision"], str))
                and digest({k: v for k, v in request.items() if k not in {"operationId", "expectedRevision"}}) == key,
                "Workflow write request differs from its intent")
        stage, preview = operation.get("stage"), operation.get("preview")
        require((isinstance(stage, str) and stage in {"preflight", "mutation"})
                or ("stage" not in operation and isinstance(operation.get("result"), dict)),
                "Invalid workflow write attempt stage")
        require((stage == "preflight" and preview is None)
                or (isinstance(preview, dict) and isinstance(preview.get("canonicalUri"), str)
                    and preview.get("beforeRevision") == request["expectedRevision"]), "Invalid workflow write preview")
        if stage is None:
            result = operation["result"]
            require(result.get("canonicalUri") == preview["canonicalUri"]
                    and isinstance(result.get("revision"), str) and re.fullmatch(r"[a-f0-9]{64}", result["revision"])
                    and result.get("operationId", request["operationId"]) == request["operationId"],
                    "Invalid completed workflow write receipt")
        return json.dumps({"contextPath": str(self.path), "bindingHash": digest(self.binding), "key": key,
                           "request": request, "preview": preview, "stage": stage},
                          sort_keys=True, ensure_ascii=False, separators=(",", ":"))

    def _prepare_write(self, record, topic, body, relations, replace=None, deferred=False):
        role = record["kind"]
        if self.cloud and role in {"verified", "implemented"}:
            raise WorkflowError("pending-publication", "Personal cloud closeout needs an approved sanitized publication graph; both draft sets remain active")
        source_run = record.get("runId") or record.get("data", {}).get("runId")
        require(source_run, "Workflow artifact lacks its existing source writer runId")
        request = {"action": "replace" if replace else "create", "artifactKey": topic,
                   "sourceRunId": source_run, "role": role, "body": body, "bodySha256": body_hash(body),
                   "storageKind": "handoff" if self.cloud else record.get("memoryKind", "handoff"),
                   "relations": relations, "codeRefs": record.get("codeRefs", record.get("data", {}).get("codeRefs", [])),
                   "citationPolicy": "defer" if deferred else "require-current"}
        if replace:
            request["uri"] = replace
        key = digest(request)
        with locked(self.path):
            self.state = read_json(self.path)
            self._validate()
            old = self.state["operations"].get(key)
            if key in self.state["operations"]:
                return self._write_admission(key, old)
            pending = self.state.get("pending")
            require(pending is None or (isinstance(pending, dict) and pending.get("key") == key),
                    "Recover the pending workflow operation before changing its intent")
            if not pending:
                request["operationId"] = uuid.uuid4().hex
                request["expectedRevision"] = self.read(replace)["revision"] if replace else None
                pending = {"key": key, "request": request, "stage": "preflight"}
                self._write_admission(key, pending)
                self.state["pending"] = pending
                save_json(self.path, self.state)
            else:
                self._write_admission(key, pending)
            request = pending["request"]
            preview = self.request("preflight", mutation=request["action"], **{k: v for k, v in request.items() if k != "action"})
            require(preview.get("beforeRevision") == request["expectedRevision"] and isinstance(preview.get("canonicalUri"), str), "Workflow preflight changed expected revision/destination")
            pending["preview"] = preview
            admitted = self._write_admission(key, pending)
            save_json(self.path, self.state)
            return admitted

    def write(self, record, topic, body, relations, replace=None, deferred=False, preview=False):
        admission = json.loads(self._prepare_write(record, topic, body, relations, replace, deferred))
        prepared = admission["preview"]
        identity = digest({k: v for k, v in admission.items() if k != "stage"})
        if preview:
            return prepared["canonicalUri"]
        with locked(self.path):
            self.state = read_json(self.path)
            self._validate()
            pending = self.state.get("pending")
            if pending is None:
                # A verified completed operation is replayed only for the same intent.
                completed = self.state["operations"].get(admission["key"])
                current = json.loads(self._write_admission(admission["key"], completed))
                require(current["stage"] is None and digest({k: v for k, v in current.items() if k != "stage"}) == identity,
                        "Cannot identify the completed workflow operation")
                uri = completed["result"]["canonicalUri"]
                observed = self.read(uri)
                require(observed["bodySha256"] == body_hash(body)
                        and observed["revision"] == completed["result"]["revision"]
                        and observed["state"] == "active", "Completed workflow artifact changed")
                return uri
            current = json.loads(self._write_admission(pending.get("key") if isinstance(pending, dict) else None, pending))
            # Another caller may advance this exact attempt, but cannot replace it or regress its stage.
            require(admission["stage"] in {"preflight", "mutation"}
                    and current["stage"] in ({"preflight", "mutation"} if admission["stage"] == "preflight" else {"mutation"})
                    and digest({k: v for k, v in current.items() if k != "stage"}) == identity,
                    "Pending workflow write differs from the prepared attempt")
            pending["stage"] = "mutation"
            save_json(self.path, self.state)
            request = dict(pending["request"])
            result = self.request(request.pop("action"), **request)
            return self._accept(pending, result)

    def validate_archive_plans(self, plans):
        with locked(self.path):
            self.state = read_json(self.path)
            self._validate()
            identity = {"bindingId": self.binding["bindingId"], "generation": self.generation,
                        "bindingHash": digest(self.binding)}
            require(all(all(plan.get(key) == value for key, value in identity.items()) for plan in plans),
                    "Archive admission belongs to another full workflow identity")
            return identity

    def plan_archive(self, uri):
        """Read-only native preflight; persist the returned intent in the closeout receipt."""
        with locked(self.path):
            self.state = read_json(self.path)
            self._validate()
            require(not self.state.get("pending"), "Recover the existing workflow operation before planning closeout")
            source = self.read(uri)
            require(source["state"] == "active", "Archive plan requires an active owned artifact")
            match = re.search(r"<!-- dev-(?:spec|plan):v1 (.*?) -->", source["body"], re.S)
            require(match, "Archive requires a native owned workflow artifact")
            record = json.loads(match.group(1))
            source_run = source.get("sourceRunId") or record.get("runId") or record.get("data", {}).get("runId")
            require(source_run, "Workflow archive lacks source writer runId")
            request = {"action": "archive", "operationId": uuid.uuid4().hex,
                       "artifactKey": source.get("artifactKey") or uri.rsplit("/", 1)[-1].removesuffix(".md"),
                       "sourceRunId": source_run, "role": record["kind"], "uri": uri,
                       "expectedRevision": source["revision"]}
            preview = self.request("preflight", mutation="archive", **{k: v for k, v in request.items() if k != "action"})
            require(preview.get("beforeRevision") == source["revision"]
                    and preview.get("bodySha256") == source["bodySha256"]
                    and isinstance(preview.get("canonicalUri"), str), "Archive preflight changed source or destination")
            return {"bindingId": self.binding["bindingId"], "generation": self.generation,
                    "bindingHash": digest(self.binding),
                    "request": request, "preview": preview, "sourceBodySha256": source["bodySha256"]}

    def archive(self, uri, expected_revision=None, plan=None):
        if plan is not None:
            # Validate the admitted intent before recover() can replay a native mutation.
            with locked(self.path):
                self.state = read_json(self.path)
                self._validate()
                pending = self.state.get("pending")
                require(plan.get("bindingId") == self.binding["bindingId"] and plan.get("generation") == self.generation
                        and plan.get("bindingHash") == digest(self.binding)
                        and plan["request"].get("action") == "archive" and plan["request"].get("uri") == uri,
                        "Archive plan belongs to another workflow, generation or source")
                require(expected_revision is None or expected_revision == plan["request"]["expectedRevision"],
                        "Archive plan targets another revision")
                require(not pending or (pending["key"] == "archive:" + uri
                        and pending["request"] == plan["request"]
                        and pending.get("sourceBodySha256") == plan["sourceBodySha256"]
                        and (pending.get("preview") == plan["preview"]
                             or (pending.get("stage") == "preflight" and pending.get("preview") is None))),
                        "Pending workflow mutation differs from the admitted archive plan")
        self.recover(archive_plan=plan)
        with locked(self.path):
            self.state = read_json(self.path)
            self._validate()
            if plan is not None:
                require(plan.get("bindingId") == self.binding["bindingId"] and plan.get("generation") == self.generation
                        and plan.get("bindingHash") == digest(self.binding),
                        "Archive plan belongs to another workflow or helper generation")
                require(plan["request"].get("action") == "archive" and plan["request"].get("uri") == uri,
                        "Archive plan targets another source")
                require(expected_revision is None or expected_revision == plan["request"]["expectedRevision"],
                        "Archive plan targets another revision")
            request_key = "archive:" + uri
            completed = self.state["operations"].get(request_key)
            if completed:
                require(expected_revision is None or completed["request"]["expectedRevision"] == expected_revision,
                        "Completed archive targets another source revision")
                archived = self.read(completed["result"]["canonicalUri"])
                require(archived["revision"] == completed["result"]["revision"] and archived["state"] == "archived",
                        "Completed workflow archive changed")
                require(plan is None or (completed["request"] == plan["request"]
                        and archived["canonicalUri"] == plan["preview"]["canonicalUri"]),
                        "Completed archive differs from the admitted archive plan")
                return archived["canonicalUri"]
            pending = self.state.get("pending")
            require(not pending or pending["key"] == request_key, "Recover the pending workflow operation before archiving")
            require(plan is None or not pending or pending["request"] == plan["request"],
                    "Pending archive differs from the admitted archive plan")
            if pending is None:
                source = self.read(uri)
                require(expected_revision is None or source["revision"] == expected_revision, "Owned artifact revision changed before retirement")
                match = re.search(r"<!-- dev-(?:spec|plan):v1 (.*?) -->", source["body"], re.S)
                require(match, "Archive requires a native owned workflow artifact")
                record = json.loads(match.group(1))
                source_run = source.get("sourceRunId") or record.get("runId") or record.get("data", {}).get("runId")
                require(source_run, "Workflow archive lacks source writer runId")
                request = plan["request"] if plan is not None else {
                    "action": "archive", "operationId": uuid.uuid4().hex,
                    "artifactKey": source.get("artifactKey") or uri.rsplit("/", 1)[-1].removesuffix(".md"),
                    "sourceRunId": source_run, "role": record["kind"], "uri": uri, "expectedRevision": source["revision"]}
                require(plan is None or (source["revision"] == request["expectedRevision"]
                        and source["bodySha256"] == plan["sourceBodySha256"]),
                        "Owned artifact changed after final-size admission")
                pending = {"key": request_key, "request": request, "sourceBodySha256": source["bodySha256"], "stage": "preflight"}
                self.state["pending"] = pending
                save_json(self.path, self.state)
            request = pending["request"]
            pending["preview"] = self.request("preflight", mutation="archive", **{k: v for k, v in request.items() if k != "action"})
            require(pending["preview"].get("beforeRevision") == request["expectedRevision"], "Archive preflight changed expected source revision")
            require(plan is None or pending["preview"] == plan["preview"],
                    "Archive destination changed after final-size admission")
            pending["stage"] = "mutation"
            save_json(self.path, self.state)
            return self._accept(pending, self.request("archive", **{k: v for k, v in request.items() if k != "action"}))


def configure(client, receipt_path, project, feature_id, repo=None, inherited=None):
    """New real-client receipts use the protocol; old unbound desktop stays legacy."""
    if not hasattr(client, "workflow_options"):
        return
    receipt = read_json(receipt_path) if Path(receipt_path).exists() else None
    explicit = client.workflow_options.get("workflow_context")
    recorded = receipt.get("workflowContext") if receipt else None
    if recorded:
        require(Path(recorded).is_file(), "Workflow context was lost; restore the pinned task context instead of rebinding")
    if receipt is not None and not recorded:
        require(not explicit and not inherited, "Legacy desktop receipts require their original unbound client; do not reinterpret them as a cloud run")
        require_desktop_legacy(client.home)
        return
    selected = recorded or explicit or inherited or locator(client) or str(receipt_path) + ".workflow-context.json"
    require(not recorded or not explicit or Path(recorded).resolve() == Path(explicit).resolve(), "Receipt workflow context conflicts with explicit context")
    require(not inherited or Path(selected).resolve() == Path(inherited).resolve(), "Cross-skill workflow context changed")
    transport = WorkflowTransport(selected, repo or client.repo, client.home,
                                  client.workflow_options.get("workflow_profile"), client.workflow_options.get("workflow_team"),
                                  client.workflow_options.get("workflow_generation"))
    if recorded or inherited:
        require(transport.state is not None, "Pinned workflow context is missing; cannot resume lost cloud task state")
    transport.bind(project, feature_id)
    client.workflow = transport
    transport.recover()


def attach_explicit(client):
    path = client.workflow_options.get("workflow_context")
    if path and Path(path).exists():
        client.workflow = WorkflowTransport(path, client.repo, client.home,
                                            client.workflow_options.get("workflow_profile"), client.workflow_options.get("workflow_team"),
                                            client.workflow_options.get("workflow_generation"))


def attach_inherited(client, context, repo=None):
    if not context or not hasattr(client, "workflow_options"):
        return
    require(Path(context).is_file(), "Pinned workflow context is missing; cannot resume")
    current = client.workflow_options.get("workflow_context") or locator(client)
    require(not current or Path(current).resolve() == Path(context).resolve(), "Workflow context conflicts with upstream handoff")
    client.workflow_options["workflow_context"] = str(Path(context).resolve())
    client.repo = repo or client.repo
    attach_explicit(client)


def result_context(client, result):
    context = locator(client)
    return {**result, "workflowContext": context} if context and isinstance(result, dict) else result


def cli_error(error):
    result = {"error": str(error)}
    if isinstance(error, WorkflowError):
        result["code"] = error.code
        result["status"] = "pending" if error.code == "pending-publication" else "error"
    return result


def block_cloud_finish(client):
    transport = getattr(client, "workflow", None)
    if transport is not None and transport.cloud:
        raise WorkflowError("pending-publication", "Cloud closeout is pending approved sanitized publication/readback; both specification and plan drafts remain active. Use the personal-cloud publication coordinator when available.")
    if transport is None and hasattr(client, "workflow_options"):
        require_desktop_legacy(client.home)

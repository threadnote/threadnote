"""Offline wire-v1 transport, run propagation and interrupted-operation checks."""
import copy
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[5]
SKILLS = ROOT / "config/agent-skills"
sys.path[:0] = [str(SKILLS / name / "scripts") for name in ("dev-spec", "dev-plan", "dev-cycle")]
import workflow_transport as wt
import dev_spec
import dev_plan
import workflow
import phase_state


class NativeFixture:
    """Models independently persisted native revisions and an operation journal."""
    def __init__(self, repo, home, profile="codex-cloud-personal"):
        self.repo, self.home, self.profile = str(repo), str(home), profile
        self.calls, self.bindings, self.documents, self.operations = [], {}, {}, {}
        self.publications = {}
        self.fail = None

    def response(self, request):
        self.calls.append(copy.deepcopy(request))
        action = request["action"]
        if action == "bind":
            run_id = request["workflowRunId"]
            self.bindings.setdefault(run_id, {**{k: v for k, v in request.items() if k not in {"protocolVersion", "action"}},
                "bindingId": "binding-" + run_id, "home": self.home, "repo": self.repo,
                "account": "fixture", "user": "fixture", "agentId": "fixture", "profile": request.get("profile", self.profile),
                "team": request.get("team", "personal"),
                "sharedRoots": ["threadnote://user/fixture/memories/shared/personal"], "artifactLifetime": "cloud-workspace-local"})
            if self.fail == "after-bind":
                self.fail = None
                raise wt.WorkflowError("lost-response", "Interrupted after bind")
            return {"protocolVersion": 1, "status": "ok", "binding": self.bindings[run_id]}
        if action == "read":
            item = self.documents.get(request["uri"])
            return {"protocolVersion": 1, "status": "ok", **item} if item else {
                "protocolVersion": 1, "status": "not-found", "requestedUri": request["uri"]}
        if action == "publication-preview":
            graph = {**request["graph"], "sourceCommit": request["sourceCommit"]}
            fingerprint = wt.digest(graph)
            self.publications.setdefault(fingerprint, {"graph": copy.deepcopy(graph)})
            nodes = [{"key": node["key"], "canonicalUri": "threadnote://user/fixture/memories/shared/personal/durable/projects/fixture/" + node["topic"] + ".md",
                      "body": node["body"], "bodySha256": wt.body_hash(node["body"])} for node in graph["nodes"]]
            self.publications[fingerprint]["nodes"] = nodes
            return {"protocolVersion": 1, "status": "ok", "approvalDigest": fingerprint, "sourceCommit": graph["sourceCommit"], "nodes": nodes}
        if action == "publication-approve":
            self.publications[request["approvalDigest"]]["decision"] = request["decision"]
            return {"protocolVersion": 1, "status": "ok", "approvalDigest": request["approvalDigest"], "decision": request["decision"]}
        if action == "publication-publish":
            publication = self.publications[request["approvalDigest"]]
            if publication.get("decision") != "approve":
                return {"protocolVersion": 1, "status": "error", "code": "approval-required", "message": "Approval required"}
            nodes = []
            for index, node in enumerate(publication["nodes"]):
                document = {"canonicalUri": node["canonicalUri"], "memoryId": "shared-" + node["key"],
                            "revision": wt.body_hash(node["body"] + "native-shared"), "state": "active", "storageKind": "durable",
                            "role": node["key"], "body": node["body"], "bodySha256": node["bodySha256"], "verifiedReadback": True}
                self.documents[node["canonicalUri"]] = document
                nodes.append({key: document[key] for key in ("canonicalUri", "revision", "bodySha256")})
                nodes[-1]["key"] = node["key"]
                if index == 0 and self.fail == "publication-failed":
                    self.fail = None
                    return {"protocolVersion": 1, "status": "error", "code": "git-push-failed", "message": "Synthetic push failure after first node"}
                if index == 0 and self.fail == "publication-pending":
                    self.fail = None
                    return {"protocolVersion": 1, "status": "pending", "approvalDigest": request["approvalDigest"],
                            "stage": node["key"] + ":create", "committed": {"commit": "fixture-unpushed"},
                            "message": "Publication remains pending. Restore the configured share and retry the same approved graph."}
            if self.fail == "readback-mismatch":
                self.fail = None
                nodes[-1]["revision"] = "0" * 64
            return {"protocolVersion": 1, "status": "ok", "approvalDigest": request["approvalDigest"], "verifiedReadback": True, "nodes": nodes}
        operation = request["operationId"]
        if action == "recover":
            return self.operations.get(operation, {"protocolVersion": 1, "status": "error", "code": "operation-not-found", "message": "No native operation"})
        uri = request.get("uri", "threadnote://user/fixture/memories/handoffs/active/fixture/workflow-" + request["bindingId"] + "-" + request["artifactKey"] + ".md")
        existing = self.documents.get(uri)
        expected = request["expectedRevision"]
        if action == "preflight":
            return {"protocolVersion": 1, "status": "ok", "canonicalUri": uri,
                    "beforeRevision": existing["revision"] if existing else None}
        if operation in self.operations:
            return self.operations[operation]
        if self.fail == "before-mutation":
            self.fail = None
            raise wt.WorkflowError("lost-response", "Interrupted before native journal")
        if (existing["revision"] if existing else None) != expected:
            return {"protocolVersion": 1, "status": "error", "code": "revision-conflict", "message": "Concurrent native edit"}
        if action == "create" and existing:
            return {"protocolVersion": 1, "status": "error", "code": "already-exists", "message": "Create must be absent"}
        body = request.get("body", existing["body"] if existing else "")
        if action == "archive":
            del self.documents[uri]
            uri = uri.replace("/active/", "/archived/")
        native = {"canonicalUri": uri, "memoryId": "fixture-memory", "revision": hashlib.sha256((body + action).encode()).hexdigest(),
                  "state": "archived" if action == "archive" else "active", "storageKind": request.get("storageKind", "handoff"),
                  "role": request["role"], "artifactKey": request["artifactKey"], "sourceRunId": request["sourceRunId"], "body": body, "bodySha256": wt.body_hash(body), "verifiedReadback": True}
        self.documents[uri] = native
        result = {"protocolVersion": 1, "status": "ok", "operationId": operation, **native}
        self.operations[operation] = result
        if self.fail == "after-mutation":
            self.fail = None
            raise wt.WorkflowError("lost-response", "Interrupted after mutation")
        return result


class TransportTests(unittest.TestCase):
    def setUp(self):
        generation_patch = patch.object(wt, "generation", return_value="fixture-generation")
        generation_patch.start()
        self.addCleanup(generation_patch.stop)
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.repo = self.directory / "repo"
        self.repo.mkdir()
        self.home = self.directory / "home"
        self.native = NativeFixture(self.repo, self.home)
        self.context = self.directory / "context.json"
        self.transport = self.make_transport()
        self.transport.bind("fixture", "feature")
        self.record = {"kind": "current", "memoryKind": "durable", "runId": "writer-123", "data": {}}
        self.body = "Fixture baseline.\n"

    def make_transport(self):
        return wt.WorkflowTransport(self.context, self.repo, self.home, generation_pin="fixture-generation", invoke=self.native.response)

    def test_private_baseline_semantic_role_uses_handoff_and_json_readback(self):
        uri = self.transport.write(self.record, "feature-current", self.body, [])
        writes = [call for call in self.native.calls if call["action"] == "create"]
        self.assertEqual(writes[0]["storageKind"], "handoff")
        self.assertEqual(writes[0]["role"], "current")
        self.assertEqual(self.transport.read(uri)["body"], self.body)
        self.assertNotIn("remember", [call["action"] for call in self.native.calls])
        self.assertIsNone(self.transport.read("threadnote://missing", missing=True))

    def test_desktop_keeps_requested_storage_kind(self):
        self.native.profile = "desktop"
        other = wt.WorkflowTransport(self.directory / "desktop.json", self.repo, self.home,
                                     generation_pin="fixture-generation", invoke=self.native.response)
        other.bind("fixture", "feature")
        uri = other.write(self.record, "desktop-baseline", self.body, [])
        self.assertEqual(other.read(uri)["storageKind"], "durable")

    def test_wrong_storage_kind_blocks_receipt_and_recovers_same_write(self):
        self.native.profile = "desktop"

        def incorrect_readback(request):
            result = self.native.response(request)
            if request["action"] == "read" and result["status"] == "ok":
                result = {**result, "storageKind": "handoff"}
            return result

        context = self.directory / "desktop.json"
        other = wt.WorkflowTransport(context, self.repo, self.home,
                                     generation_pin="fixture-generation", invoke=incorrect_readback)
        other.bind("fixture", "feature")
        with self.assertRaisesRegex(wt.WorkflowError, "different storage kind"):
            other.write(self.record, "desktop-baseline", self.body, [])
        self.assertIn("pending", wt.read_json(context))
        other.invoke = self.native.response
        other.recover()
        self.assertEqual(len(self.native.operations), 1)
        self.assertNotIn("pending", wt.read_json(context))

    def test_pending_status_is_only_valid_for_publication_publish(self):
        result = {"protocolVersion": 1, "status": "pending", "approvalDigest": "fixture-digest",
                  "stage": "architecture:create", "message": "Publication remains pending"}
        self.transport.invoke = lambda request: result
        self.assertEqual(self.transport.request("publication-publish", approvalDigest="fixture-digest"), result)
        for action in ("create", "read", "publication-preview", "publication-approve"):
            with self.assertRaisesRegex(wt.WorkflowError, "Unexpected workflow operation status"):
                self.transport.request(action)

    def test_lost_response_recovers_same_native_operation_without_duplicate_write(self):
        self.native.fail = "after-mutation"
        with self.assertRaisesRegex(wt.WorkflowError, "after mutation"):
            self.transport.write(self.record, "feature-current", self.body, [])
        pending = wt.read_json(self.context)["pending"]
        operation = pending["request"]["operationId"]
        self.assertEqual(pending["stage"], "mutation")
        self.make_transport().recover()
        self.assertEqual([call["operationId"] for call in self.native.calls if call["action"] == "recover"], [operation])
        self.assertEqual(len(self.native.operations), 1)
        self.assertNotIn("pending", wt.read_json(self.context))

    def test_crash_before_native_journal_replays_exact_saved_request(self):
        self.native.fail = "before-mutation"
        with self.assertRaises(wt.WorkflowError):
            self.transport.write(self.record, "feature-current", self.body, [])
        original = wt.read_json(self.context)["pending"]["request"]
        self.make_transport().recover()
        mutations = [call for call in self.native.calls if call["action"] == "create"]
        self.assertEqual(mutations[0], mutations[1])
        self.assertEqual(mutations[1]["operationId"], original["operationId"])

    def test_changed_pending_intent_cas_and_failed_recovery_keep_receipts(self):
        self.native.fail = "before-mutation"
        with self.assertRaises(wt.WorkflowError):
            self.transport.write(self.record, "feature-current", self.body, [])
        with self.assertRaisesRegex(wt.WorkflowError, "pending workflow operation"):
            self.transport.write(self.record, "feature-current", "Changed.\n", [])
        pending = wt.read_json(self.context)["pending"]
        uri = pending["preview"]["canonicalUri"]
        self.native.documents[uri] = {"revision": "f" * 64}
        with self.assertRaisesRegex(wt.WorkflowError, "Concurrent native edit"):
            self.make_transport().recover()
        self.assertEqual(wt.read_json(self.context)["pending"]["request"], pending["request"])

    def test_lost_binding_response_reuses_persisted_run_identity(self):
        context = self.directory / "lost-bind.json"
        transport = wt.WorkflowTransport(context, self.repo, self.home, generation_pin="fixture-generation", invoke=self.native.response)
        self.native.fail = "after-bind"
        with self.assertRaises(wt.WorkflowError):
            transport.bind("fixture", "feature")
        before = wt.read_json(context)["pendingBinding"]
        resumed = wt.WorkflowTransport(context, self.repo, self.home, generation_pin="fixture-generation", invoke=self.native.response)
        resumed.bind("fixture", "feature")
        self.assertEqual(resumed.binding["workflowRunId"], before["workflowRunId"])

    def test_bound_context_generation_and_missing_state_are_not_rebound(self):
        with self.assertRaisesRegex(wt.WorkflowError, "generation"):
            wt.WorkflowTransport(self.context, self.repo, self.home, generation_pin="another-generation")
        receipt = self.directory / "receipts.json"
        wt.save_json(receipt, {"workflowContext": str(self.context)})
        client = dev_plan.Threadnote(str(self.repo), str(self.home), workflow_generation="fixture-generation")
        self.context.unlink()
        with self.assertRaisesRegex(wt.WorkflowError, "lost"):
            wt.configure(client, receipt, "fixture", "feature", self.repo)
        self.assertFalse(self.context.exists())

    def test_explicit_generation_must_match_actual_helpers_before_new_binding(self):
        context = self.directory / "unbound.json"
        before = list(self.native.calls)
        with self.assertRaisesRegex(wt.WorkflowError, "Explicit workflow generation"):
            wt.WorkflowTransport(context, self.repo, self.home, generation_pin="spoofed-generation", invoke=self.native.response)
        self.assertFalse(context.exists())
        self.assertEqual(self.native.calls, before)

    def test_actual_generation_resume_keeps_identity_and_cannot_be_overridden(self):
        uri = self.transport.write(self.record, "feature-current", self.body, [])
        before, calls = wt.read_json(self.context), len(self.native.calls)
        for explicit in (None, "fixture-generation"):
            resumed = wt.WorkflowTransport(self.context, self.repo, self.home, generation_pin=explicit, invoke=self.native.response)
            resumed.bind("fixture", "feature")
            self.assertEqual(resumed.binding, self.transport.binding)
            self.assertEqual(resumed.write(self.record, "feature-current", self.body, []), uri)
        self.assertEqual(sum(call["action"] == "bind" for call in self.native.calls[calls:]), 0)
        self.assertEqual(wt.read_json(self.context), before)
        with patch.object(wt, "generation", return_value="changed-actual-generation"):
            for explicit in (None, "fixture-generation"):
                with self.assertRaisesRegex(wt.WorkflowError, "generation"):
                    wt.WorkflowTransport(self.context, self.repo, self.home, generation_pin=explicit, invoke=self.native.response)
        self.assertEqual(wt.read_json(self.context), before)

    def test_read_errors_and_malformed_digest_are_never_absence(self):
        def failed(request):
            return {"protocolVersion": 1, "status": "error", "code": "access-denied", "message": "Denied"}
        transport = self.make_transport()
        transport.invoke = failed
        with self.assertRaisesRegex(wt.WorkflowError, "Denied"):
            transport.read("threadnote://fixture", missing=True)
        uri = self.transport.write(self.record, "feature-current", self.body, [])
        self.native.documents[uri]["bodySha256"] = "0" * 64
        with self.assertRaisesRegex(wt.WorkflowError, "digest"):
            self.transport.read(uri, missing=True)

    def test_cloud_closeout_stops_before_either_draftset_changes(self):
        client = dev_plan.Threadnote(str(self.repo), str(self.home))
        client.workflow = self.transport
        before = copy.deepcopy(self.native.documents)
        with self.assertRaisesRegex(wt.WorkflowError, "publication-preview"):
            workflow.finish({}, self.directory, None, None, None, client, client)
        self.assertEqual(self.native.documents, before)
        with self.assertRaisesRegex(wt.WorkflowError, "sanitized publication"):
            self.transport.write({**self.record, "kind": "implemented"}, "raw-closeout", self.body, [])

    def test_archive_recovery_verifies_exact_archived_body(self):
        record = {"schemaVersion": 1, "kind": "root", "runId": "writer-123", "memoryKind": "handoff", "data": {}}
        body = "Fixture.\n<!-- dev-plan:v1 " + json.dumps(record) + " -->\n"
        uri = self.transport.write(record, "feature-plan", body, [])
        self.native.fail = "after-mutation"
        with self.assertRaises(wt.WorkflowError):
            self.transport.archive(uri)
        self.make_transport().recover()
        archive = wt.read_json(self.context)["operations"]["archive:" + uri]["result"]["canonicalUri"]
        self.assertEqual(self.transport.read(archive)["body"], body)
        self.assertNotIn(uri, self.native.documents)
        archive_request = next(call for call in self.native.calls if call["action"] == "archive")
        self.assertEqual(archive_request["artifactKey"], "feature-plan")
        self.assertEqual(archive_request["sourceRunId"], "writer-123")

    def test_outer_spec_archive_receipt_recovers_lost_returned_uri(self):
        import support
        record = dev_spec.record({"id": "feature", "project": "fixture"}, "root",
                                 {"runId": "writer-123"}, "Fixture.", [])
        body = support.memory_text(record)
        uri = self.transport.write(record, "feature-spec", body, [])
        client = support.Threadnote(str(self.repo), str(self.home))
        client.workflow = self.transport
        receipt = self.directory / "spec-archive-receipts.json"
        store = support.Store(receipt, client, {"fixture": "archive"})
        self.native.fail = "after-mutation"
        with self.assertRaises(wt.WorkflowError):
            store.archive(uri, support.digest(record))
        self.assertNotIn("uri", wt.read_json(receipt)["pending"])
        recovered = support.Store(receipt, client, {"fixture": "archive"})
        recovered.recover()
        archived = recovered.state["archives"][uri]
        self.assertEqual(support.load_record(client.read(archived)), record)
        self.assertNotIn("pending", recovered.state)

    def test_subprocess_boundary_uses_only_structured_workflow_memory(self):
        uri = self.transport.write(self.record, "feature-current", self.body, [])
        result = {"protocolVersion": 1, "status": "ok", **self.native.documents[uri]}
        transport = self.make_transport()
        transport.invoke = None
        with patch.object(wt.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=json.dumps(result), stderr="")) as run:
            self.assertEqual(transport.read(uri)["body"], self.body)
            arguments, keywords = run.call_args
            self.assertEqual(arguments[0][:2], ["threadnote", "workflow-memory"])
            self.assertEqual(json.loads(keywords["input"])["bindingId"], transport.binding["bindingId"])
            self.assertEqual(keywords["encoding"], "utf-8")
            self.assertEqual(keywords["cwd"], str(self.repo.resolve()))
        with patch.object(wt.subprocess, "run", return_value=SimpleNamespace(returncode=1, stdout=json.dumps({
                "protocolVersion": 1, "status": "error", "code": "backend-unavailable", "message": "Unavailable"}), stderr="")):
            with self.assertRaisesRegex(wt.WorkflowError, "Unavailable"):
                transport.read(uri, missing=True)

    def test_cloud_legacy_and_missing_explicit_context_never_call_human_cli(self):
        client = dev_plan.Threadnote(str(self.repo), str(self.home), workflow_context=str(self.directory / "lost-context.json"))
        with patch.object(dev_plan, "run") as run:
            with self.assertRaisesRegex(wt.WorkflowError, "pinned context"):
                client.read("threadnote://fixture")
            run.assert_not_called()
        profile = self.home / "codex-cloud/profile.json"
        profile.parent.mkdir(parents=True)
        profile.write_text("{}", encoding="utf-8")
        client = dev_plan.Threadnote(str(self.repo), str(self.home))
        with patch.object(dev_plan, "run") as run:
            with self.assertRaisesRegex(wt.WorkflowError, "Personal cloud requires"):
                client.read("threadnote://fixture")
            run.assert_not_called()
        receipt = self.directory / "legacy.json"
        wt.save_json(receipt, {"runId": "legacy-desktop"})
        with self.assertRaisesRegex(wt.WorkflowError, "legacy desktop receipts"):
            wt.configure(client, receipt, "fixture", "feature", self.repo)

    def test_shared_context_roundtrip_preserves_existing_artifact_hashes(self):
        # Reuse the existing behavioral fixture, replacing only its persistence boundary.
        sys.path.insert(0, str(Path(__file__).parent / "dev-spec"))
        import test_dev_spec as fixture_module
        fixture = fixture_module.Specs()
        fixture.setUp()
        self.addCleanup(fixture.tearDown)
        native = NativeFixture(fixture.repo, fixture.directory / "native-home")
        def request(transport, action, **fields):
            payload = {"protocolVersion": 1, "action": action, **fields}
            if action != "bind":
                payload["bindingId"] = transport.binding["bindingId"]
            response = native.response(payload)
            if response["status"] == "error":
                raise wt.WorkflowError(response["code"], response["message"])
            return response
        with patch.object(wt.WorkflowTransport, "request", request):
            fixture.sc = dev_spec.Threadnote(str(fixture.repo), str(fixture.directory / "native-home"), workflow_generation="fixture-generation")
            # Let spec initialize the deterministic adjacent context, then import its locator.
            saved = fixture.saved()
            original_spec_hash = dev_spec.digest(fixture.spec)
            packet = dev_spec.export_plan(saved["rootUri"], fixture.sc)
            fixture.pc = dev_plan.Threadnote(str(fixture.repo), str(fixture.directory / "native-home"), workflow_generation="fixture-generation")
            plan = dev_plan.from_spec(packet, fixture.scope, fixture.pc)
            self.assertNotIn("workflowContext", plan)
            self.assertEqual(dev_spec.digest(fixture.spec), original_spec_hash)
            self.assertEqual(wt.locator(fixture.sc), wt.locator(fixture.pc))
            # Existing fixture completes its normal architecture inputs/save/export.
            saved, plan, result, cycle, memories = fixture.plan_cycle()
            self.assertEqual(cycle["workflowContext"], wt.locator(fixture.sc))
            phase_packet = phase_state.make_packet(cycle, "deliver", memories)
            self.assertEqual(phase_packet["workflowContext"], cycle["workflowContext"])
            self.assertEqual(cycle["spec"]["requirements"], plan["requirements"])
            self.assertNotIn("workflowContext", cycle["spec"])
            self.assertEqual(wt.read_json(fixture.state)["workflowContext"], cycle["workflowContext"])
            self.assertTrue(all(item["storageKind"] == "handoff" for item in native.documents.values()))


class CloudPublicationTests(unittest.TestCase):
    def setUp(self):
        generation_patch = patch.object(wt, "generation", return_value="fixture-generation")
        generation_patch.start()
        self.addCleanup(generation_patch.stop)
        sys.path.insert(0, str(Path(__file__).parent / "dev-spec"))
        import test_dev_spec as fixtures
        self.fixture = fixtures.Specs()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.native = NativeFixture(self.fixture.repo, self.fixture.directory / "native-home")
        def request(transport, action, **fields):
            payload = {"protocolVersion": 1, "action": action, **fields}
            if action != "bind":
                payload["bindingId"] = transport.binding["bindingId"]
            result = self.native.response(payload)
            if result["status"] == "error":
                raise wt.WorkflowError(result["code"], result["message"])
            return result
        self.request_patch = patch.object(wt.WorkflowTransport, "request", request)
        self.request_patch.start()
        self.addCleanup(self.request_patch.stop)
        self.fixture.sc = dev_spec.Threadnote(str(self.fixture.repo), str(self.fixture.directory / "native-home"), workflow_generation="fixture-generation")
        self.fixture.pc = dev_plan.Threadnote(str(self.fixture.repo), str(self.fixture.directory / "native-home"), workflow_generation="fixture-generation")
        _, self.plan, self.cycle, self.directory = self.fixture.prepare()
        self.originals = set(self.native.documents)
        import cloud_closeout
        self.cloud = cloud_closeout
        import spec_closeout
        self.spec_closeout = spec_closeout

    def preview(self):
        return self.cloud.preview(self.cycle, self.directory, phase_state, dev_spec, self.spec_closeout, self.fixture.pc, self.fixture.sc)

    def decision(self, preview, decision="approve"):
        return self.cloud.approve(self.cycle, self.directory, phase_state, self.fixture.pc,
                                  preview["approvalDigest"], decision, "Synthetic actual user decision: " + decision)

    def finish(self):
        return workflow.finish(self.cycle, self.directory, phase_state, dev_spec, self.spec_closeout, self.fixture.pc, self.fixture.sc)

    def test_projection_preserves_behavior_ids_domain_and_contains_no_private_execution_blob(self):
        preview = self.preview()
        state = wt.read_json(self.cloud.state_path(self.directory))
        bodies = "\n".join(node["body"] for node in preview["nodes"])
        self.assertIn("R1", bodies)
        self.assertIn("S1", bodies)
        self.assertIn("Deadline equality is expired.", bodies)
        for forbidden in (str(self.fixture.repo), "snapshotTree", "archiveMap", "<!-- dev-plan:v1", "<!-- dev-spec:v1"):
            self.assertNotIn(forbidden, bodies)
        self.assertTrue(all(uri not in bodies for uri in self.originals))
        self.assertEqual({node["key"] for node in state["graph"]["nodes"]}, {"architecture", "spec"})
        self.assertFalse(any(call["action"] in {"publication-publish", "archive"} for call in self.native.calls))
        self.assertTrue(self.originals <= set(self.native.documents))

    def test_deferred_rejected_and_missing_approval_preserve_both_sets(self):
        preview = self.preview()
        for decision in (None, "defer", "reject"):
            if decision:
                self.decision(preview, decision)
            with self.assertRaisesRegex(wt.WorkflowError, "unapproved"):
                self.finish()
            self.assertTrue(self.originals <= set(self.native.documents))
        self.assertFalse(any(call["action"] == "archive" for call in self.native.calls))

    def test_stale_evidence_invalidates_approval_without_publication(self):
        preview = self.preview()
        self.decision(preview)
        evidence = dev_plan.read_json(self.directory / "evidence.json")
        evidence["architectureVerification"] += " Changed after approval."
        dev_plan.write_json(self.directory / "evidence.json", evidence)
        with self.assertRaisesRegex(wt.WorkflowError, "approval is stale"):
            self.finish()
        self.assertTrue(self.originals <= set(self.native.documents))
        self.assertFalse(any(call["action"] in {"archive", "publication-publish"} for call in self.native.calls))

    def test_partial_git_failure_and_readback_failure_leave_drafts_then_retry_completes(self):
        preview = self.preview()
        self.decision(preview)
        for failure in ("publication-failed", "readback-mismatch"):
            self.native.fail = failure
            with self.assertRaises(wt.WorkflowError):
                self.finish()
            self.assertTrue(self.originals <= set(self.native.documents))
            self.assertFalse(any(call["action"] == "archive" for call in self.native.calls))
        result = self.finish()
        self.assertEqual(result["status"], "complete")
        self.assertFalse(self.originals & set(self.native.documents))
        self.assertEqual(self.cycle["knowledgeCloseout"], result)
        self.assertEqual(self.finish(), result)
        first_archive = next(i for i, call in enumerate(self.native.calls) if call["action"] == "archive")
        publication_reads = [call for call in self.native.calls[:first_archive] if call["action"] == "read" and "/shared/" in call["uri"]]
        self.assertGreaterEqual(len(publication_reads), 2)

    def test_pending_native_publication_preserves_drafts_and_retries_only_approved_digest(self):
        preview = self.preview()
        self.decision(preview)
        self.native.fail = "publication-pending"
        with self.assertRaisesRegex(wt.WorkflowError, "pending.*Stage: architecture:create") as raised:
            self.finish()
        self.assertEqual(raised.exception.code, "pending-publication")
        state = wt.read_json(self.cloud.state_path(self.directory))
        self.assertEqual(state["pendingPublication"]["approvalDigest"], preview["approvalDigest"])
        self.assertNotIn("published", state)
        self.assertNotIn("knowledgeCloseout", self.cycle)
        self.assertTrue(self.originals <= set(self.native.documents))
        self.assertFalse(any(call["action"] == "archive" for call in self.native.calls))
        self.assertEqual(self.finish()["status"], "complete")
        publications = [call for call in self.native.calls if call["action"] == "publication-publish"]
        self.assertEqual(len(publications), 2)
        self.assertEqual(publications[0], publications[1])
        self.assertEqual(set(publications[1]), {"protocolVersion", "action", "bindingId", "approvalDigest"})
        self.assertNotIn("pendingPublication", wt.read_json(self.cloud.state_path(self.directory)))

    def test_interrupted_retirement_reuses_original_archive_operation(self):
        preview = self.preview()
        self.decision(preview)
        self.native.fail = "after-mutation"
        with self.assertRaisesRegex(wt.WorkflowError, "after mutation"):
            self.finish()
        context = wt.read_json(wt.locator(self.fixture.pc))
        first_archive = context["pending"]["request"]["operationId"]
        self.assertEqual(context["pending"]["request"]["action"], "archive")
        completed = self.finish()
        self.assertEqual(completed["status"], "complete")
        self.assertEqual(sum(call["action"] == "archive" and call["operationId"] == first_archive for call in self.native.calls), 1)
        self.assertFalse(self.originals & set(self.native.documents))

    def test_changed_draft_revision_blocks_all_additional_retirement(self):
        preview = self.preview()
        self.decision(preview)
        uri = sorted(self.originals)[-1]
        self.native.documents[uri]["revision"] = "e" * 64
        with self.assertRaisesRegex(wt.WorkflowError, "owned draft/archive changed"):
            self.finish()
        self.assertTrue(self.originals <= set(self.native.documents))
        self.assertFalse(any(call["action"] in {"archive", "publication-publish"} for call in self.native.calls))

    def test_changed_source_commit_invalidates_approved_projection(self):
        preview = self.preview()
        self.decision(preview)
        self.fixture.git("-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "commit", "--allow-empty", "-qm", "New source commit")
        with self.assertRaisesRegex(wt.WorkflowError, "approval is stale"):
            self.finish()
        self.assertTrue(self.originals <= set(self.native.documents))
        self.assertFalse(any(call["action"] in {"archive", "publication-publish"} for call in self.native.calls))

    def test_private_reference_in_projection_is_rejected_without_native_preview(self):
        evidence = dev_plan.read_json(self.directory / "evidence.json")
        evidence["architectureVerification"] = "See " + next(iter(self.originals))
        dev_plan.write_json(self.directory / "evidence.json", evidence)
        with self.assertRaisesRegex(wt.WorkflowError, "private reference"):
            self.preview()
        self.assertFalse(any(call["action"] == "publication-preview" for call in self.native.calls))
        self.assertTrue(self.originals <= set(self.native.documents))


if __name__ == "__main__":
    unittest.main()

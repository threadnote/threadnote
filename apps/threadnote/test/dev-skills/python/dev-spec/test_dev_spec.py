#!/usr/bin/env python3
"""Behavioral invariants and isolated native checks for the three-skill handoff."""
import sys
from pathlib import Path
PRODUCT_SKILLS = Path(__file__).resolve().parents[6] / "config/agent-skills"
sys.path[:0] = [str(PRODUCT_SKILLS / skill / "scripts") for skill in ("dev-spec", "dev-plan", "dev-cycle", "watch-pr")]
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest

import dev_spec as ds
import support
import spec_closeout

ROOT = PRODUCT_SKILLS
PLAN = ROOT / "dev-plan/scripts"
CYCLE = ROOT / "dev-cycle/scripts"
sys.path[:0] = [str(PLAN), str(CYCLE)]
import dev_plan as dp
import workflow
import phase_state as ps


class Backend:
    def __init__(self):
        self.memories, self.archived, self.writes, self.retired = {}, set(), [], []
        self.fail = None

    def read(self, uri):
        support.require(uri in self.memories, "Memory does not exist: " + uri)
        return self.memories[uri]

    def active(self, uri):
        return uri in self.memories and uri not in self.archived

    def call(self, command, args, text=None):
        uri = args[0]
        if command == "read":
            return "MEMORY\nstatus: " + ("active" if self.active(uri) else "archived") + "\n\n" + self.read(uri)
        support.require(command == "archive", "Unexpected fake command")
        archived = uri.replace("/active/", "/archived/")
        self.memories[archived] = self.memories.pop(uri)
        self.archived.add(archived)
        self.retired.append(uri)
        return "Stored memory: " + archived

    def write(self, record, topic, replacement, preview, body):
        support.require(all(self.active(r["uri"]) for r in record["relations"]), "Relation target must be active")
        uri = replacement or "threadnote://user/test/memories/active/" + topic + ".md"
        if preview:
            return uri
        if self.fail == "reject":
            self.fail = None
            raise support.PlanError("Rejected before mutation")
        if self.fail == "rebind" and record["kind"] == "implemented" and record["data"].get("verifiedSpec"):
            self.fail = None
            raise support.PlanError("Rejected architecture rebind")
        self.memories[uri] = body
        self.writes.append((uri, copy.deepcopy(record)))
        if self.fail == "lost":
            self.fail = None
            raise support.PlanError("Lost response after mutation")
        return uri


class SpecClient:
    def __init__(self, backend):
        self.backend, self.repo = backend, None

    def read(self, uri): return self.backend.read(uri)
    def peek(self, uri): return self.backend.memories.get(uri)
    def active(self, uri): return self.backend.active(uri)
    def call(self, *args, **kwargs): return self.backend.call(*args, **kwargs)
    def remember(self, record, topic, replace=None, preview=False):
        return self.backend.write(record, topic, replace, preview, support.memory_text(record))


class PlanClient(SpecClient):
    def is_active(self, uri): return self.active(uri)
    def remember(self, record, topic, relations, replace=None, deferred=False):
        return self.backend.write(record, topic, replace, False, dp.memory_text(record))
    def preflight(self, record, topic, relations, replace=None, deferred=False):
        uri = self.backend.write(record, topic, replace, True, dp.memory_text(record))
        before = self.peek(uri)
        return {"expectedUri": uri, "beforeHash": dp.digest(before) if before is not None else None}


class Specs(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="dev-spec-test-")
        self.directory = Path(self.tmp.name)
        self.repo = self.directory / "repo"
        (self.repo / "src").mkdir(parents=True)
        (self.repo / "src/cache.py").write_text("def get(value):\n    return value\n")
        self.git("init", "-q")
        self.git("add", ".")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "commit", "-qm", "Fixture")
        self.scope = ds.inspect(self.repo, ["src/"])
        scopefile = self.directory / "scope.json"
        ds.write_json(scopefile, self.scope)
        self.spec = ds.template(SimpleNamespace(id="cache-ttl", project="fixture", title="Cache TTL",
            objective="Expired values are absent", cwd=str(self.repo), focus="Cache reads", scope=scopefile))
        self.spec.update(actors=["Cache consumer"], inScope=["Expiry at read"], outOfScope=["Background eviction"],
            contextNote="Synthetic fixture has no prior memories", codeRefs=["src/cache.py"],
            review={"required": False, "reason": "Narrow synthetic behavior fixture"})
        self.spec["recall"]["queries"] = ["fixture cache expiry decisions (synthetic)"]
        self.spec["scenarios"][0].update(given="a value expiring at time 10", when="read at time 10", then="the value is absent")
        self.spec["artifacts"] = [self.artifact("z-workflow"), self.artifact("a-domain", "domain")]
        self.backend = Backend()
        self.sc, self.pc = SpecClient(self.backend), PlanClient(self.backend)
        self.state = self.directory / "spec-receipts.json"

    def tearDown(self): self.tmp.cleanup()

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.repo), *args], check=True, text=True, capture_output=True).stdout.strip()

    def artifact(self, key, kind="workflow"):
        return {"id": key, "kind": kind, "title": key, "summary": "Expiry is observable on reads.",
                "requirementIds": ["R1"], "diagram": "stateDiagram-v2\n  Available --> Expired: deadline",
                "sections": [{"title": "Invariant", "items": ["Deadline equality is expired."]}],
                "contextRefs": [], "contextNote": "Synthetic fixture has no prior memories", "codeRefs": ["src/cache.py"]}

    def confirmation(self):
        return {"intentHash": ds.digest(ds.intent(self.spec)), "source": "user", "confirmed": True,
                "response": "Synthetic fixture approval: yes to expiry at the deadline."}

    def saved(self, draft=False):
        return ds.save(self.spec, self.state, self.sc, self.confirmation(), draft=draft)

    def plan_cycle(self):
        saved = self.saved()
        packet = ds.export_plan(saved["rootUri"], self.sc)
        plan = dp.from_spec(packet, self.scope, self.pc)
        plan["current"].update(summary="Reads return the value directly", diagram="flowchart LR\n Consumer --> Cache",
                               invariants=["Calls return a value or absence"])
        plan["target"].update(summary="Reads check deadline", diagram="flowchart LR\n Consumer --> Expiry --> Cache",
                              contracts=["At deadline, return absence"], decisions=[{"choice": "Read-time expiry", "rationale": "Bounded behavior"}])
        plan["phases"][0].update(outcome="Expired values read as absent", safeBoundary="Reads without expiry keep behavior")
        for a in plan["phases"][0]["acceptance"]:
            a["verification"] = "Exercise exact deadline with deterministic clock"
        plan["openQuestions"] = []
        plan["review"] = {"required": False, "reason": "Narrow synthetic fixture"}
        result = dp.save(plan, self.directory / "plan-receipts.json", self.pc)
        cycle, memories = dp.export_cycle(result["rootUri"], self.pc, "local",
                                          {p["id"]: {"branch": "feature/ttl", "baseBranch": "main"} for p in plan["phases"]})
        return saved, plan, result, cycle, memories

    def validate_cycle(self, cycle):
        # Synthetic test transport receipts; native review/snapshot behavior is covered by dev-cycle's suite.
        for phase in cycle["phases"]:
            tree = self.git("rev-parse", "HEAD^{tree}")
            validation = {"snapshotTree": tree, "status": "passed", "productState": "working",
                          "checks": [{"command": "synthetic transport fixture", "result": "passed", "evidence": "Fixture exercised"}],
                          "acceptance": [{"criterion": criterion, "result": "passed", "evidence": "Synthetic transport verification"}
                                         for criterion in phase["acceptanceCriteria"]]}
            path = self.directory / (phase["id"] + "-validation.json")
            ds.write_json(path, validation)
            phase.update(status="validated", validatedTree=tree, validationFile=str(path),
                         validationHash=hashlib.sha256(path.read_bytes()).hexdigest(), validationPlanHash=ps.definition_hash(cycle))

    def prepare(self):
        saved, plan, result, cycle, memories = self.plan_cycle()
        self.validate_cycle(cycle)
        directory = self.directory / "completion"
        workflow.prepare(cycle, ds.inspect(self.repo, ["src/"]), directory, ps, ds, self.pc, self.sc)
        implemented = ds.read_json(directory / "implemented.json")
        implemented["codeRefs"] = ["src/cache.py"]
        ds.write_json(directory / "implemented.json", implemented)
        evidence = ds.read_json(directory / "evidence.json")
        evidence["architectureVerification"] = "Synthetic transport check of final fixture"
        ds.write_json(directory / "evidence.json", evidence)
        evidence = ds.read_json(directory / "spec-evidence.json")
        evidence.update(codeRefs=["src/cache.py"], behaviorVerification="Synthetic final transport verification")
        ds.write_json(directory / "spec-evidence.json", evidence)
        return saved, plan, cycle, directory

    def finish(self, cycle, directory):
        return workflow.finish(cycle, directory, ps, ds, spec_closeout, self.pc, self.sc)

    def test_confirmation_tracks_intent_not_evidence_refresh(self):
        with self.assertRaisesRegex(support.PlanError, "user must confirm"):
            ds.validate(self.spec, ready=True)
        approval = self.confirmation()
        self.spec["observations"].append("Read source at src/cache.py")
        ds.validate(self.spec, True, approval)
        self.spec["scenarios"][0]["then"] = "the value is present"
        with self.assertRaisesRegex(support.PlanError, "exact acceptance"):
            ds.validate(self.spec, True, approval)

    def test_uncovered_requirements_and_open_decisions_block_ready(self):
        self.spec["requirements"].append({"id": "R2", "behavior": "New behavior", "priority": "must", "change": "added"})
        with self.assertRaisesRegex(support.PlanError, "without acceptance"):
            self.saved()
        self.spec["requirements"].pop()
        self.spec["questions"] = [{"id": "Q1", "question": "What does expiry mean?", "impact": "Behavior", "disposition": "open"}]
        with self.assertRaisesRegex(support.PlanError, "Unresolved"):
            self.saved()
        result = self.saved(draft=True)
        with self.assertRaisesRegex(support.PlanError, "confirmed ready"):
            ds.export_plan(result["rootUri"], self.sc)

    def test_substantial_review_requires_current_hash_and_no_material_findings(self):
        self.spec["review"] = {"required": True, "reason": "Consequential contracts"}
        with self.assertRaisesRegex(support.PlanError, "quiet independent"):
            self.saved()
        review = {"specHash": ds.digest(self.spec), "verdict": "ready", "findings": [{"severity": "important"}]}
        with self.assertRaisesRegex(support.PlanError, "Material"):
            ds.validate(self.spec, True, self.confirmation(), review)

    def test_roundtrip_preserves_artifact_order_and_idempotency(self):
        result = self.saved()
        self.assertEqual(ds.load(result["rootUri"], self.sc)[0], self.spec)
        count = len(self.backend.writes)
        self.assertEqual(self.saved()["rootUri"], result["rootUri"])
        self.assertEqual(len(self.backend.writes), count)

    def test_relevant_prior_memory_links_survive_on_each_artifact(self):
        uri = "threadnote://user/test/memories/active/prior.md"
        self.backend.memories[uri] = "Preserve no-expiry behavior.\n"
        self.spec["recall"]["sources"] = [{**support.pin(self.sc, uri), "usedFor": "Behavior compatibility"}]
        for artifact in [self.spec, *self.spec["artifacts"]]: artifact["contextRefs"] = [uri]
        self.saved()
        self.assertTrue(all({"type": "references", "uri": uri} in r["relations"] for _, r in self.backend.writes))

    def test_failed_and_lost_writes_resume(self):
        for fault in ("reject", "lost"):
            self.backend.fail = fault
            self.state = self.directory / (fault + ".json")
            with self.assertRaises(support.PlanError): self.saved()
            result = self.saved()
            self.assertEqual(ds.load(result["rootUri"], self.sc)[0], self.spec)

    def test_unknown_concurrent_edit_is_not_overwritten_on_recovery(self):
        self.backend.fail = "lost"
        with self.assertRaises(support.PlanError): self.saved()
        uri, record = self.backend.writes[-1]
        record["markdown"] += "\nConcurrent content."
        self.backend.memories[uri] = support.memory_text(record)
        with self.assertRaisesRegex(support.PlanError, "changed unexpectedly"): self.saved()

    def test_plan_import_and_cycle_packet_preserve_approved_scenarios(self):
        saved, plan, result, cycle, memories = self.plan_cycle()
        packet = ps.make_packet(cycle, "deliver", memories)
        self.assertEqual(packet["featureId"], self.spec["id"])
        self.assertIn(saved["rootUri"], packet["readUris"])
        self.assertEqual(packet["phase"]["acceptanceCriteria"], [ds.scenario_text(s) for s in self.spec["scenarios"]])
        plan["phases"][0]["acceptance"][0]["criterion"] = "Maybe expires"
        with self.assertRaisesRegex(dp.PlanError, "weakened|exact"):
            dp.validate(plan)
        cycle["phases"][0]["acceptanceRefs"][0]["specScenarios"] = []
        with self.assertRaisesRegex(ValueError, "disappeared"):
            ps.validate_plan(cycle)

    def test_requirement_scenario_ids_pins_and_evidence_survive_coordinated_closeout(self):
        saved, plan, cycle, directory = self.prepare()
        original_requirements = {item["id"] for item in self.spec["requirements"]}
        original_scenarios = {item["id"] for item in self.spec["scenarios"]}
        self.assertEqual({item["id"] for item in plan["requirements"]}, original_requirements)
        self.assertEqual({item["id"] for item in cycle["spec"]["scenarios"]}, original_scenarios)
        for uri, expected in cycle["spec"]["memoryHashes"].items():
            self.assertEqual(hashlib.sha256(self.sc.read(uri).encode()).hexdigest(), expected)
        for phase in cycle["phases"]:
            self.assertEqual({sid for item in phase["acceptanceRefs"] for sid in item["specScenarios"]}, original_scenarios)
            self.assertEqual({rid for item in phase["acceptanceRefs"] for rid in item["requirements"]}, original_requirements)
        result = self.finish(cycle, directory)
        verified = support.load_record(self.sc.read(result["verifiedSpecUri"]))
        self.assertEqual({item["id"] for item in verified["data"]["core"]["requirements"]}, original_requirements)
        evidence = verified["data"]["evidence"]
        self.assertEqual({item["id"] for item in evidence["scenarios"]}, original_scenarios)
        self.assertTrue(all(item["result"] == "passed" and item["evidence"] for item in evidence["scenarios"]))
        self.assertIn(saved["rootUri"], verified["data"]["archiveMap"])
        architecture = dp.load_record(self.pc.read(result["implementedArchitectureUri"]))
        self.assertEqual(architecture["data"]["verifiedSpec"]["revision"], cycle["spec"]["revision"])

    def test_import_rejects_forged_identity_and_missing_artifacts(self):
        result = self.saved()
        for edit in (lambda p: p.update(project="other"), lambda p: p["memoryHashes"].pop(next(iter(result["children"].values())))):
            packet = ds.export_plan(result["rootUri"], self.sc)
            edit(packet)
            packet["packetHash"] = dp.digest({k: v for k, v in packet.items() if k != "packetHash"})
            with self.assertRaises(dp.PlanError): dp.from_spec(packet, self.scope, self.pc)

    def test_plan_cannot_change_its_copy_of_upstream_intent(self):
        _, plan, _, _, _ = self.plan_cycle()
        plan["spec"]["scenarios"][0]["then"] = "the value is retained"
        plan["phases"][0]["acceptance"][0]["criterion"] = ds.scenario_text(plan["spec"]["scenarios"][0])
        with self.assertRaisesRegex(dp.PlanError, "authoritative memory"):
            dp.save(plan, self.directory / "plan-receipts.json", self.pc)

    def test_changed_validation_file_is_not_accepted(self):
        _, _, _, cycle, _ = self.plan_cycle()
        self.validate_cycle(cycle)
        Path(cycle["phases"][0]["validationFile"]).write_text("{}")
        with self.assertRaisesRegex(dp.PlanError, "evidence or plan revision changed"):
            workflow.evidence_from_cycle(cycle, ps)

    def test_cycle_drift_and_changed_validation_are_detected(self):
        _, _, _, cycle, _ = self.plan_cycle()
        self.validate_cycle(cycle)
        fingerprint = ps.definition_hash(cycle)
        cycle["completion"]["required"] += " Changed"
        self.assertNotEqual(ps.definition_hash(cycle), fingerprint)
        with self.assertRaisesRegex(dp.PlanError, "revision changed"):
            workflow.evidence_from_cycle(cycle, ps)

    def test_incomplete_spec_evidence_cannot_retire_architecture(self):
        _, _, cycle, directory = self.prepare()
        evidence = ds.read_json(directory / "spec-evidence.json")
        evidence["behaviorVerification"] = ""
        ds.write_json(directory / "spec-evidence.json", evidence)
        with self.assertRaisesRegex(support.PlanError, "combined behavior"):
            self.finish(cycle, directory)
        self.assertFalse(self.backend.retired)

    def test_source_drift_after_phase_validation_blocks_prepare(self):
        _, _, _, cycle, _ = self.plan_cycle()
        self.validate_cycle(cycle)
        (self.repo / "src/cache.py").write_text("def get(value):\n    return 'broken'\n")
        scope = ds.inspect(self.repo, ["src/"])
        with self.assertRaisesRegex(dp.PlanError, "Final source has no passing combined validation"):
            workflow.prepare(cycle, scope, self.directory / "drift", ps, ds, self.pc, self.sc)
        self.assertFalse(self.backend.retired)

    def test_source_drift_after_prepare_blocks_finish_even_with_refreshed_scope(self):
        _, _, cycle, directory = self.prepare()
        (self.repo / "src/cache.py").write_text("def get(value):\n    return 'broken'\n")
        scope = ds.inspect(self.repo, ["src/"])
        for filename in ("implemented.json", "spec-evidence.json"):
            value = ds.read_json(directory / filename)
            value["scope"] = scope
            ds.write_json(directory / filename, value)
        with self.assertRaisesRegex(dp.PlanError, "Final source has no passing combined validation"):
            self.finish(cycle, directory)
        self.assertFalse(self.backend.retired)

    def test_combined_validation_must_cover_every_phase_on_current_tree(self):
        _, _, _, cycle, _ = self.plan_cycle()
        scenario = {"id": "S2", "requirementIds": ["R1"], "given": "no expiry", "when": "read later", "then": "the value remains"}
        cycle["spec"]["scenarios"].append(scenario)
        criterion = ds.scenario_text(scenario)
        later = copy.deepcopy(cycle["phases"][0])
        later.update(id="compatibility", acceptanceCriteria=[criterion],
                     acceptanceRefs=[{"id": "A2", "criterion": criterion, "requirements": ["R1"], "specScenarios": ["S2"]}])
        cycle["phases"].append(later)
        self.validate_cycle(cycle)
        validations = workflow.evidence_from_cycle(cycle, ps)
        pending = workflow.validation_input(cycle, self.scope, ps)
        self.assertEqual(len(pending["acceptance"]), 2)
        self.assertEqual(pending["status"], "pending")
        with self.assertRaisesRegex(ValueError, "failed, or stale"):
            workflow.current_validation(cycle, self.scope, ps, validations, pending)
        with self.assertRaisesRegex(dp.PlanError, "combined validation"):
            workflow.current_validation(cycle, self.scope, ps, validations)
        combined = copy.deepcopy(validations["deliver"])
        combined["acceptance"] += validations["compatibility"]["acceptance"]
        combined["planHash"] = ps.definition_hash(cycle)
        checked = workflow.current_validation(cycle, self.scope, ps, validations, combined)
        self.assertEqual(len(checked["acceptance"]), 2)

    def test_temporary_phase_acceptance_does_not_redefine_final_behavior(self):
        _, _, _, cycle, _ = self.plan_cycle()
        phase = cycle["phases"][0]
        phase["acceptanceCriteria"].append("Temporary migration compatibility is available")
        phase["acceptanceRefs"].append({"id": "TEMP", "criterion": phase["acceptanceCriteria"][-1],
                                        "requirements": ["R1"], "specScenarios": []})
        self.validate_cycle(cycle)
        validations = workflow.evidence_from_cycle(cycle, ps)
        checked = workflow.current_validation(cycle, self.scope, ps, validations)
        self.assertEqual(len(checked["acceptance"]), 1)
        self.assertEqual(len(validations["deliver"]["acceptance"]), 2)

    def test_closeout_preserves_only_linked_verified_knowledge_and_owned_history(self):
        first = self.saved()
        self.spec["artifacts"].pop()
        self.spec["observations"].append("Refined scope evidence")
        saved, _, cycle, directory = self.prepare()
        result = self.finish(cycle, directory)
        self.assertEqual(result["status"], "complete")
        verified = support.load_record(self.sc.read(result["verifiedSpecUri"]))
        architecture = dp.load_record(self.pc.read(result["implementedArchitectureUri"]))
        self.assertIn(result["verifiedSpecUri"], architecture["data"]["contextRefs"])
        self.assertIn({"type": "references", "uri": result["implementedArchitectureUri"]}, verified["relations"])
        self.assertIn(first["rootUri"], verified["data"]["archiveMap"])
        self.assertIn(first["children"]["a-domain"], verified["data"]["archiveMap"])
        self.assertTrue(all(self.backend.active(r["uri"]) for r in architecture["relations"]))
        self.assertEqual(len([u for u in self.backend.memories if self.backend.active(u)]), 3)
        cycle.pop("knowledgeCloseout")
        self.assertEqual(self.finish(cycle, directory), result)
        self.assertEqual(cycle["knowledgeCloseout"], result)

    def test_rebind_failure_resumes_after_spec_drafts_retired(self):
        _, _, cycle, directory = self.prepare()
        self.backend.fail = "rebind"
        with self.assertRaisesRegex(support.PlanError, "rebind"):
            self.finish(cycle, directory)
        result = self.finish(cycle, directory)
        self.assertEqual(result["status"], "complete")

    def test_revised_spec_context_follows_retired_owned_architecture(self):
        _, _, planned, _, _ = self.plan_cycle()
        old_current = planned["artifacts"]["current"]
        self.spec["recall"]["sources"] = [{**support.pin(self.sc, old_current), "usedFor": "Observed cache behavior"}]
        self.spec["contextRefs"] = [old_current]
        _, _, cycle, directory = self.prepare()
        result = self.finish(cycle, directory)
        verified = support.load_record(self.sc.read(result["verifiedSpecUri"]))
        self.assertIn(old_current, verified["data"]["evidence"]["contextArchiveMap"])
        self.assertTrue(all(self.sc.active(r["uri"]) for r in verified["relations"]))

    def test_unrelated_recalled_knowledge_is_preserved(self):
        uri = "threadnote://user/test/memories/active/existing-contract.md"
        self.backend.memories[uri] = "Keep no-expiry reads unchanged.\n"
        self.spec["recall"]["sources"] = [{**support.pin(self.sc, uri), "usedFor": "Compatibility"}]
        for artifact in [self.spec, *self.spec["artifacts"]]: artifact["contextRefs"] = [uri]
        _, _, cycle, directory = self.prepare()
        result = self.finish(cycle, directory)
        self.assertTrue(self.sc.active(uri))
        verified = support.load_record(self.sc.read(result["verifiedSpecUri"]))
        self.assertIn({"type": "references", "uri": uri}, verified["relations"])

    @unittest.skipUnless(os.environ.get("DEV_SPEC_NATIVE") == "1", "Opt-in isolated native lifecycle")
    def test_native_full_workflow_with_current_new_code_bindings(self):
        native_home = str(self.directory / "native-home")
        self.sc, self.pc = ds.Threadnote(str(self.repo), native_home), dp.Threadnote(str(self.repo), native_home)

        def index():
            dp.run(["threadnote", "graph", "index", "--home", native_home, "--cwd", str(self.repo), "--no-vectors", "--json"])

        index()
        saved, plan, result, cycle, memories = self.plan_cycle()
        (self.repo / "src/expiry.py").write_text("def expired(deadline, now):\n    return deadline is not None and now >= deadline\n")
        self.git("add", ".")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "commit", "-qm", "Synthetic implementation")
        index()
        self.validate_cycle(cycle)
        directory = self.directory / "native-completion"
        scope = ds.inspect(self.repo, ["src/"])
        workflow.prepare(cycle, scope, directory, ps, ds, self.pc, self.sc)
        for filename in ("implemented.json", "spec-evidence.json"):
            value = ds.read_json(directory / filename)
            value["codeRefs"] = ["src/cache.py", "src/expiry.py"]
            if filename == "spec-evidence.json": value["behaviorVerification"] = "Synthetic native transport, not feature validation"
            ds.write_json(directory / filename, value)
        value = ds.read_json(directory / "evidence.json")
        value["architectureVerification"] = "Synthetic native binding check of both actual files"
        ds.write_json(directory / "evidence.json", value)
        complete = self.finish(cycle, directory)
        for uri in (complete["verifiedSpecUri"], complete["implementedArchitectureUri"]):
            self.assertTrue(self.sc.active(uri))
            metadata = self.sc.call("read", [uri]).split("\n\n", 1)[0]
            citations = [json.loads(line.split(": ", 1)[1]) for line in metadata.splitlines() if line.startswith("code_citation: ")]
            self.assertEqual({c["path"] for c in citations}, {"src/cache.py", "src/expiry.py"})
            self.assertTrue(all(c["sourceCommit"] == scope["head"] and not c["sourceDirty"] for c in citations))
        final = support.load_record(self.sc.read(complete["verifiedSpecUri"]))
        self.assertTrue(all(not self.sc.active(u) for u in final["data"]["archiveMap"].values()))
        arch = dp.load_record(self.pc.read(complete["implementedArchitectureUri"]))
        self.assertTrue(all(self.sc.active(r["uri"]) for r in arch["relations"]))


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Behavioral checks; all persistence uses a fake client or an isolated Threadnote home."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from product_skills_fixture import configure_product_skills, assert_product_provenance
PRODUCT_SKILLS = configure_product_skills(__file__, 6)
# Match the dev-plan entrypoint's sibling import resolution, including its own transport.
sys.path.insert(0, str(PRODUCT_SKILLS / "dev-plan/scripts"))

import copy
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import dev_plan as dp
import closeout

assert_product_provenance(PRODUCT_SKILLS, "dev-plan-imports")


class MemoryClient:
    def __init__(self):
        self.repo = None
        self.memories = {}
        self.archived = set()
        self.writes = []
        self.retirements = []
        self.lose_response = False
        self.reject_implemented = False

    def read(self, uri):
        dp.require(uri in self.memories, "Memory does not exist")
        return self.memories[uri]

    def peek(self, uri):
        return self.memories.get(uri)

    def is_active(self, uri):
        return uri in self.memories and uri not in self.archived

    def remember(self, record, topic, relations, replace=None, deferred=False):
        if record["kind"] == "implemented" and self.reject_implemented:
            raise dp.PlanError("Current code citation binding rejected")
        uri = replace or "threadnote://user/test/memories/active/" + topic + ".md"
        self.memories[uri] = dp.memory_text(record)
        self.writes.append((uri, copy.deepcopy(record), list(relations), deferred))
        if self.lose_response:
            self.lose_response = False
            raise dp.PlanError("Connection lost after a write")
        return uri

    def preflight(self, record, topic, relations, replace=None, deferred=False):
        if record["kind"] == "implemented" and self.reject_implemented:
            raise dp.PlanError("Current code citation binding rejected")
        dp.require(all(self.is_active(uri) for _, uri in relations), "Relation target must be active")
        uri = replace or "threadnote://user/test/memories/active/" + topic + ".md"
        before = self.peek(uri)
        return {"expectedUri": uri, "beforeHash": dp.digest(before) if before is not None else None}

    def plan_archive(self, uri):
        # Exact in-memory native plan; normal examples still verify citation/readback ordering.
        return {"transport": "fixture-native-v1", "source": uri,
                "sourceRecordHash": dp.digest(dp.load_record(self.read(uri))),
                "preview": {"canonicalUri": uri.replace("/active/", "/archived/")}}

    def validate_archive_plans(self, plans):
        for plan in plans:
            uri = plan["source"]
            observed = self.peek(uri) or self.peek(plan["preview"]["canonicalUri"])
            dp.require(observed is not None and dp.digest(dp.load_record(observed)) == plan["sourceRecordHash"],
                       "Native planned source changed")

    def archive(self, uri, plan=None):
        dp.require(plan is not None and plan["source"] == uri, "Archive needs its exact admitted plan")
        self.validate_archive_plans([plan])
        output = self.call("archive", [uri])
        archived = re.search(r"Stored memory: (threadnote://[^\s]+)", output).group(1)
        dp.require(archived == plan["preview"]["canonicalUri"], "Native archive destination drift")
        return archived

    def call(self, command, args, text=None):
        uri = args[0]
        if command == "read":
            return "MEMORY\nstatus: " + ("archived" if uri in self.archived else "active") + "\n\n" + self.read(uri)
        dp.require(command == "archive", "Unexpected fake operation")
        archived = uri.replace("/active/", "/archived/")
        self.memories[archived] = self.memories.pop(uri)
        self.archived.add(archived)
        self.retirements.append(uri)
        return "Stored memory: " + archived + "\n"


class Plans(unittest.TestCase):
    def setUp(self):
        self.addCleanup(assert_product_provenance, PRODUCT_SKILLS, self.id())
        self.tmp = tempfile.TemporaryDirectory(prefix="dev-plan-test-")
        self.directory = Path(self.tmp.name)
        self.repo = self.directory / "repo"
        (self.repo / "src").mkdir(parents=True)
        (self.repo / "src/cache.py").write_text("def get(key):\n    return None\n")
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        subprocess.run(["git", "-C", str(self.repo), "add", "src/cache.py"], check=True)
        subprocess.run(["git", "-C", str(self.repo), "-c", "user.name=Skill Test",
                        "-c", "user.email=skill-test@invalid", "commit", "-qm", "Fixture"], check=True)
        args = SimpleNamespace(id="cache-ttl", project="fixture", title="Cache TTL", objective="Expired values are absent")
        self.plan = json.loads(json.dumps(dp.template(dp.inspect(self.repo, ["src/"]), args)))
        self.plan["recall"]["queries"] = ["fixture cache expiry decisions (synthetic test)"]
        for artifact in [self.plan, self.plan["current"], self.plan["target"], *self.plan["phases"]]:
            artifact["contextNote"] = "Synthetic fixture has no prior memories."
        self.plan["current"].update(summary="The cache reads values directly.",
                                    diagram="flowchart LR\n  Caller --> Cache",
                                    invariants=["Existing calls accept a key."])
        self.plan["target"].update(summary="Reads exclude expired values.",
                                   diagram="flowchart LR\n  Caller --> ExpiryCheck --> Cache",
                                   contracts=["Expired values are returned as absent."],
                                   decisions=[{"choice": "Check expiry at read", "rationale": "Preserves call signature."}])
        self.plan["phases"][0].update(outcome="Expired entries are absent without breaking existing reads.",
                                     safeBoundary="Calls without expiry retain their existing behavior.")
        self.plan["phases"][0]["acceptance"][0].update(
            criterion="An expired cache entry reads as absent.",
            verification="Run focused fake-clock expiry tests and existing cache tests.")
        self.plan["review"] = {"required": False, "reason": "One narrow behavior-preserving fixture change."}
        self.state = self.directory / "receipts.json"
        self.client = MemoryClient()

    def tearDown(self):
        self.tmp.cleanup()

    def review(self):
        return {"planHash": dp.digest(self.plan), "verdict": "ready", "findings": []}

    def saved(self, draft=False):
        return dp.save(self.plan, self.state, self.client, self.review(), draft=draft)

    def completion(self, result):
        root = dp.load_record(self.client.read(result["rootUri"]))
        implemented = {**self.plan["target"], "scope": dp.inspect(self.repo, ["src/"]),
                       "invariants": ["Calls still accept a key."], "unknowns": [], "deviations": []}
        evidence = {"rootHash": dp.digest(root), "scopeHash": dp.digest(implemented["scope"]),
                    "architectureVerification": "Inspected the fixture's implementation and exercised its read flow.",
                    "phases": [{"id": p["id"], "status": "complete",
                                "acceptance": [{"id": a["id"], "evidence": "Synthetic fixture check passed."}
                                               for a in p["acceptance"]]} for p in self.plan["phases"]]}
        return implemented, evidence

    def test_roundtrip_reuses_unchanged_memories(self):
        result = self.saved()
        loaded, root = dp.load_plan(result["rootUri"], self.client)
        self.assertEqual(loaded, self.plan)
        self.assertEqual(len(self.client.writes), 3)
        self.saved()
        self.assertEqual(len(self.client.writes), 3)
        self.assertIn("bind current code-graph references", self.client.read(result["rootUri"]))

    def test_draft_and_ready_plan_artifacts_are_durable(self):
        second = copy.deepcopy(self.plan["phases"][0])
        second.update(id="expose", title="Expose expiry", dependsOn=["deliver"])
        self.plan["phases"].append(second)
        draft = self.saved(draft=True)
        self.assertEqual(draft["readiness"], "draft")
        self.assertEqual(self.saved()["readiness"], "ready")
        self.assertEqual({r["kind"] for _, r, _, _ in self.client.writes}, {"current", "target", "phase", "root"})
        self.assertTrue(all(r["memoryKind"] == "durable" for _, r, _, _ in self.client.writes))

    def test_legacy_root_gets_a_durable_identity_with_preserved_history(self):
        original = dp.record_for
        def legacy(*args, **kwargs):
            return {**original(*args, **kwargs), "memoryKind": "handoff"}
        with patch.object(dp, "record_for", legacy):
            previous = self.saved()
        state = dp.read_json(self.state)
        old_uri = previous["rootUri"].replace("-plan-durable.md", "-plan.md")
        self.client.memories[old_uri] = self.client.memories.pop(previous["rootUri"])
        state["receipts"]["root"]["uri"] = state["rootUri"] = old_uri
        dp.write_json(self.state, state)
        current = self.saved()
        self.assertNotEqual(current["rootUri"], old_uri)
        loaded, root = dp.load_plan(current["rootUri"], self.client)
        self.assertEqual(loaded, self.plan)
        self.assertIn(old_uri, root["data"]["priorArtifacts"])
        self.assertTrue(self.client.is_active(old_uri))
        count = len(self.client.writes)
        self.assertEqual(self.saved()["rootUri"], current["rootUri"])
        self.assertEqual(len(self.client.writes), count)

    def test_direct_recalled_memory_links_on_every_artifact(self):
        uri = "threadnote://user/test/memories/constraint.md"
        self.client.memories[uri] = "Keep the cache API stable.\n"
        source = dp.pin(self.client, uri)
        source["role"], source["usedFor"] = "constraint", "Preserve API."
        self.plan["recall"]["sources"] = [source]
        for artifact in [self.plan, self.plan["current"], self.plan["target"], *self.plan["phases"]]:
            artifact["contextRefs"] = [uri]
        self.saved()
        for _, _, relations, _ in self.client.writes:
            self.assertIn(("references", uri), relations)

    def test_real_dependency_links_and_export(self):
        second = copy.deepcopy(self.plan["phases"][0])
        second.update(id="expose", title="Expose expiry", dependsOn=["deliver"])
        self.plan["phases"].append(second)
        result = self.saved()
        phase = dp.load_record(self.client.read(result["artifacts"]["phase-expose"]))
        self.assertIn({"type": "depends_on", "uri": result["artifacts"]["phase-deliver"]}, phase["relations"])
        bindings = {p["id"]: {"branch": "feature/" + p["id"], "baseBranch": "main"} for p in self.plan["phases"]}
        exported, content = dp.export_cycle(result["rootUri"], self.client, "local", bindings)
        self.assertEqual(len(exported["phases"]), 2)
        self.assertTrue(all(uri in content for uri in exported["memoryHashes"]))

    def test_cycles_uncovered_requirements_and_fake_existing_paths_fail(self):
        broken = copy.deepcopy(self.plan)
        broken["phases"][0]["dependsOn"] = ["deliver"]
        with self.assertRaisesRegex(dp.PlanError, "cycle"):
            dp.validate(broken)
        broken = copy.deepcopy(self.plan)
        broken["requirements"].append({"id": "R2", "behavior": "Extra requirement"})
        with self.assertRaisesRegex(dp.PlanError, "without acceptance"):
            dp.validate(broken)
        broken = copy.deepcopy(self.plan)
        broken["phases"][0]["affectedPaths"] = ["src/missing.py"]
        with self.assertRaisesRegex(dp.PlanError, "planned explicitly"):
            dp.validate(broken)

    def test_stale_source_and_stale_review_block_ready_save(self):
        self.plan["review"]["required"] = True
        review = self.review()
        self.plan["target"]["summary"] += " Updated."
        with self.assertRaisesRegex(dp.PlanError, "different plan"):
            dp.save(self.plan, self.state, self.client, review)
        (self.repo / "src/cache.py").write_text("changed\n")
        with self.assertRaisesRegex(dp.PlanError, "source changed"):
            dp.validate(self.plan)
        self.assertFalse(self.client.writes)

    def test_unknown_save_outcome_requires_readback_recovery(self):
        self.client.lose_response = True
        with self.assertRaises(dp.PlanError):
            self.saved()
        with self.assertRaisesRegex(dp.PlanError, "unresolved"):
            self.saved()
        actual_uri = self.client.writes[-1][0]
        dp.recover(self.state, actual_uri, self.client)
        self.saved()
        self.assertEqual(len(self.client.writes), 3)

    def test_closeout_cannot_retire_before_current_code_binding(self):
        result = self.saved()
        implemented, evidence = self.completion(result)
        self.client.reject_implemented = True
        with self.assertRaisesRegex(dp.PlanError, "binding rejected"):
            closeout.complete(result["rootUri"], implemented, evidence,
                              self.directory / "closeout.json", self.client)
        self.assertFalse(self.client.retirements)
        self.assertIn(result["artifacts"]["current"], self.client.memories)
        self.assertNotIn("pending", dp.read_json(self.directory / "closeout.json"))
        self.client.reject_implemented = False
        completed = closeout.complete(result["rootUri"], implemented, evidence,
                                     self.directory / "closeout.json", self.client)
        self.assertEqual(completed["status"], "complete")

    def test_rejected_write_after_preflight_can_recover_without_uri(self):
        class RejectWrite(MemoryClient):
            reject = True

            def remember(self, *args, **kwargs):
                if self.reject:
                    raise dp.PlanError("Rejected before writing")
                return super().remember(*args, **kwargs)

        self.client = RejectWrite()
        with self.assertRaisesRegex(dp.PlanError, "Rejected"):
            self.saved()
        outcome = dp.recover(self.state, None, self.client)
        self.assertEqual(outcome["status"], "not-written")
        self.client.reject = False
        self.saved()
        self.assertEqual(len(self.client.writes), 3)

    def test_final_closeout_write_rejection_resumes_after_archival(self):
        class RejectFinal(MemoryClient):
            reject = True

            def remember(self, record, *args, **kwargs):
                if record["kind"] == "implemented" and record["data"]["closeoutStatus"] == "complete" and self.reject:
                    raise dp.PlanError("Final write rejected before mutation")
                return super().remember(record, *args, **kwargs)

        self.client = RejectFinal()
        result = self.saved()
        implemented, evidence = self.completion(result)
        state_path = self.directory / "final-closeout.json"
        with self.assertRaisesRegex(dp.PlanError, "Final write rejected"):
            closeout.complete(result["rootUri"], implemented, evidence, state_path, self.client)
        self.assertEqual(len(self.client.retirements), 3)
        self.client.reject = False
        completed = closeout.complete(result["rootUri"], implemented, evidence, state_path, self.client)
        self.assertEqual(completed["status"], "complete")
        final = dp.load_record(self.client.read(completed["implementedUri"]))
        self.assertEqual(len(final["data"]["archiveMap"]), 3)

    def test_recovery_rejects_unexpected_destination_change(self):
        self.client.lose_response = True
        with self.assertRaises(dp.PlanError):
            self.saved()
        uri, record, _, _ = self.client.writes[-1]
        record["data"]["summary"] = "Concurrent revision."
        self.client.memories[uri] = dp.memory_text(record)
        with self.assertRaisesRegex(dp.PlanError, "changed unexpectedly"):
            dp.recover(self.state, None, self.client)
        self.assertIn("pending", dp.read_json(self.state))

    def test_closeout_requires_each_acceptance_and_new_current_anchors(self):
        result = self.saved()
        implemented, evidence = self.completion(result)
        evidence["phases"][0]["acceptance"] = []
        with self.assertRaisesRegex(dp.PlanError, "Every acceptance"):
            closeout.complete(result["rootUri"], implemented, evidence,
                              self.directory / "closeout.json", self.client)
        self.assertFalse(self.client.retirements)
        implemented, evidence = self.completion(result)
        implemented["codeRefs"] = []
        with self.assertRaises(dp.PlanError):
            closeout.complete(result["rootUri"], implemented, evidence,
                              self.directory / "closeout2.json", self.client)

    def test_closeout_preserves_implemented_architecture_and_archived_history(self):
        result = self.saved()
        implemented, evidence = self.completion(result)
        completed = closeout.complete(result["rootUri"], implemented, evidence,
                                     self.directory / "closeout.json", self.client)
        self.assertEqual(completed["status"], "complete")
        record = dp.load_record(self.client.read(completed["implementedUri"]))
        self.assertEqual(record["memoryKind"], "durable")
        self.assertEqual(record["citationPolicy"], "require-current")
        self.assertEqual(len(completed["archiveMap"]), 3)
        for relation in record["relations"]:
            self.assertIn(relation["uri"], self.client.memories)
        self.assertEqual(len([u for u in self.client.memories if self.client.is_active(u)]), 1)

    def test_revision_history_is_retired_and_separate_runs_do_not_collide(self):
        first = self.saved()
        self.plan["target"]["summary"] += " Clarified behavior."
        result = self.saved()
        self.assertNotEqual(first["artifacts"]["target"], result["artifacts"]["target"])
        other = dp.save(self.plan, self.directory / "other.json", self.client, self.review())
        self.assertNotEqual(result["rootUri"], other["rootUri"])
        implemented, evidence = self.completion(result)
        completed = closeout.complete(result["rootUri"], implemented, evidence,
                                     self.directory / "closeout.json", self.client)
        self.assertIn(first["artifacts"]["target"], completed["archiveMap"])
        self.assertTrue(self.client.is_active(other["rootUri"]))

    def test_large_plan_indexes_remain_connected_through_closeout(self):
        original = self.plan["phases"][0]
        self.plan["phases"] = []
        for number in range(15):
            phase = copy.deepcopy(original)
            phase.update(id=f"slice-{number}", title=f"Slice {number}", dependsOn=[])
            self.plan["phases"].append(phase)
        result = self.saved()
        root = dp.load_record(self.client.read(result["rootUri"]))
        self.assertLessEqual(len(root["relations"]), 16)
        self.assertTrue(any(key.startswith("index-") for key in root["data"]["navigation"]))
        implemented, evidence = self.completion(result)
        completed = closeout.complete(result["rootUri"], implemented, evidence,
                                     self.directory / "closeout.json", self.client)
        self.assertEqual(len(completed["archiveMap"]), len(self.client.retirements))
        self.assertEqual(len([u for u in self.client.memories if self.client.is_active(u)]), 1)

    def test_phase_consolidation_retires_removed_phases_and_indexes(self):
        original = self.plan["phases"][0]
        self.plan["phases"] = []
        for number in range(15):
            phase = copy.deepcopy(original)
            phase.update(id=f"slice-{number}", title=f"Slice {number}", dependsOn=[])
            self.plan["phases"].append(phase)
        self.saved()
        self.plan["phases"] = [original]
        result = self.saved()
        implemented, evidence = self.completion(result)
        closeout.complete(result["rootUri"], implemented, evidence,
                          self.directory / "closeout.json", self.client)
        self.assertEqual(len([u for u in self.client.memories if self.client.is_active(u)]), 1)

    @unittest.skipUnless(os.environ.get("DEV_PLAN_NATIVE") == "1", "Opt-in isolated native transport check")
    def test_native_threadnote_draft_roundtrip(self):
        client = dp.Threadnote(str(self.repo), str(self.directory / "native-home"))
        result = dp.save(self.plan, self.state, client, draft=True, deferred=True)
        loaded, root = dp.load_plan(result["rootUri"], client)
        self.assertEqual(loaded, self.plan)
        self.assertEqual(root["data"]["readiness"], "draft")
        for receipt in dp.read_json(self.state)["receipts"].values():
            self.assertEqual(client.workflow.read(receipt["uri"])["storageKind"], "durable")
        again = dp.save(self.plan, self.state, client, draft=True, deferred=True)
        self.assertEqual(result["rootUri"], again["rootUri"])

    @unittest.skipUnless(os.environ.get("DEV_PLAN_NATIVE") == "1", "Opt-in isolated native lifecycle check")
    def test_native_current_citations_and_closeout(self):
        native_home = str(self.directory / "native-current-home")
        client = dp.Threadnote(str(self.repo), native_home)

        def index():
            dp.run(["threadnote", "graph", "index", "--home", native_home, "--cwd", str(self.repo),
                    "--no-vectors", "--json"])

        index()
        result = dp.save(self.plan, self.state, client)
        root = dp.load_record(client.read(result["rootUri"]))
        # Add actual source after planning to exercise closeout's new-file citation binding.
        (self.repo / "src/expiry.py").write_text("def expired(deadline, now):\n    return now >= deadline\n")
        subprocess.run(["git", "-C", str(self.repo), "add", "src/expiry.py"], check=True)
        subprocess.run(["git", "-C", str(self.repo), "-c", "user.name=Skill Test",
                        "-c", "user.email=skill-test@invalid", "commit", "-qm", "Synthetic implementation"], check=True)
        index()
        implemented = {**self.plan["target"], "scope": dp.inspect(self.repo, ["src/"]),
                       "codeRefs": ["src/cache.py", "src/expiry.py"],
                       "invariants": ["This is an isolated lifecycle fixture."], "unknowns": [], "deviations": []}
        evidence = {"rootHash": dp.digest(root), "scopeHash": dp.digest(implemented["scope"]),
                    "architectureVerification": "Synthetic transport fixture; verified both source paths exist.",
                    "phases": [{"id": "deliver", "status": "complete",
                                "acceptance": [{"id": "A1", "evidence": "Synthetic lifecycle binding check; not a feature test."}]}]}
        completed = closeout.complete(result["rootUri"], implemented, evidence,
                                     self.directory / "native-closeout.json", client)
        final = dp.load_record(client.read(completed["implementedUri"]))
        self.assertEqual(final["data"]["codeRefs"], ["src/cache.py", "src/expiry.py"])
        self.assertEqual(final["data"]["closeoutStatus"], "complete")
        self.assertTrue(client.is_active(completed["implementedUri"]))
        citations = client.workflow.read(completed["implementedUri"])["codeCitations"]
        self.assertEqual({c["path"] for c in citations}, {"src/cache.py", "src/expiry.py"})
        graph = json.loads(dp.run(["threadnote", "graph", "status", "--home", native_home,
                                  "--cwd", str(self.repo), "--json"]))
        self.assertFalse(graph["stale"])
        for citation in citations:
            self.assertEqual(citation["sourceCommit"], implemented["scope"]["head"])
            self.assertEqual(citation["sourceSnapshotId"], graph["readySnapshot"]["id"])
            self.assertFalse(citation["sourceDirty"])
        for archived in completed["archiveMap"].values():
            self.assertFalse(client.is_active(archived))


def durability_fixture(case):
    """Exercise generated revision sequences through save/load and receipt recovery."""
    fixture = Plans()
    fixture.setUp()
    try:
        template = copy.deepcopy(fixture.plan["phases"][0])
        fixture.plan["phases"] = [dict(copy.deepcopy(template), id="phase-" + str(index),
                                      dependsOn=[] if index == 0 else ["phase-" + str(index - 1)])
                                  for index in range(case["phases"])]
        if case["legacy"]:
            original = dp.record_for
            with patch.object(dp, "record_for", lambda *a, **kw: {**original(*a, **kw), "memoryKind": "handoff"}):
                fixture.saved(draft=True)
            state = dp.read_json(fixture.state)
            prior = state["rootUri"]
            old_uri = prior.replace("-plan-durable.md", "-plan.md")
            fixture.client.memories[old_uri] = fixture.client.memories.pop(prior)
            state["receipts"]["root"]["uri"] = state["rootUri"] = old_uri
            dp.write_json(fixture.state, state)
        for index, draft in enumerate(case["drafts"]):
            fixture.plan["target"]["summary"] = "Reads exclude expired values. Revision " + str(index)
            result = fixture.saved(draft=draft)
            loaded, root = dp.load_plan(result["rootUri"], fixture.client)
            fixture.assertEqual(loaded, fixture.plan)
            fixture.assertEqual(result["readiness"], "draft" if draft else "ready")
            for receipt in dp.read_json(fixture.state)["receipts"].values():
                fixture.assertEqual(dp.load_record(fixture.client.read(receipt["uri"]))["memoryKind"], "durable")
            count = len(fixture.client.writes)
            fixture.assertEqual(fixture.saved(draft=draft), result)
            fixture.assertEqual(len(fixture.client.writes), count)
            if case["legacy"]:
                fixture.assertIn(old_uri, root["data"]["priorArtifacts"])
                fixture.assertTrue(fixture.client.is_active(old_uri))
        print(json.dumps({"roundtrip": True, "durable": True, "idempotent": True}))
    finally:
        fixture.tearDown()
        fixture.doCleanups()


if __name__ == "__main__":
    if "--durability-fixture" in sys.argv:
        durability_fixture(json.load(sys.stdin))
    else:
        unittest.main()

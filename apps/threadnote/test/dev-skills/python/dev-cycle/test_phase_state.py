import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from product_skills_fixture import configure_product_skills, assert_product_provenance
PRODUCT_SKILLS = configure_product_skills(__file__, 6)
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import subprocess
import sys
import unittest
import phase_state as state
assert_product_provenance(PRODUCT_SKILLS, "phase-state-imports")


class PhaseStateTests(unittest.TestCase):
    def setUp(self):
        self.plan = {
            "objective": "Deliver safe incremental changes", "delivery": "pr",
            "planMemoryUris": ["threadnote://plan/root"],
            "memoryHashes": {"threadnote://plan/root": hashlib.sha256(b"approved plan").hexdigest()},
            "phases": [self.phase("one"), self.phase("two", ["one"])],
        }

    def phase(self, key, dependencies=None):
        return {"id": key, "title": key, "dependsOn": dependencies or [],
                "memoryUris": [], "allowedPaths": ["src/", "tests/"],
                "acceptanceCriteria": ["Old behavior still works"],
                "safeToMergeReason": "Backward compatible additive change",
                "branch": "feature/" + key, "baseBranch": "main" if key == "one" else "feature/one",
                "status": "pending"}

    def receipt(self, phase, plan=None):
        plan = self.plan if plan is None else plan
        return {"phaseId": phase["id"], "delivery": plan["delivery"], "planHash": state.definition_hash(plan),
                "headSha": phase["headSha"], "validatedTree": phase["validatedTree"],
                "commitEvidence": "git show confirms validated tree at head",
                "pr": {"url": "https://github.com/example/repo/pull/123", "headSha": phase["headSha"],
                       "branch": phase["branch"], "baseBranch": phase["baseBranch"], "state": "open",
                       "evidence": "gh pr view confirms URL, head and base"},
                "watch": {"prUrl": "https://github.com/example/repo/pull/123", "headSha": phase["headSha"],
                          "stateDir": str(Path(tempfile.gettempdir()).resolve() / "watch-state"),
                          "consumerKind": "orchestrator", "consumerId": "current-run", "status": "active",
                          "evidence": "relay resumed by this run"}}

    def deliver(self, phase):
        phase.update(status="validated", headSha="head-" + phase["id"], validatedTree="tree-" + phase["id"])
        self.plan["featureMemory"] = {"required": False, "classification": "small-fix", "reason": "Scoped fixture fix"}
        state.record_delivery(self.plan, phase["id"], self.receipt(phase))

    def test_validation_routes_back_to_delivery_before_dependent_or_independent_work(self):
        one, two = self.plan["phases"]
        for dependencies in (["one"], []):
            two["dependsOn"] = dependencies
            one.update(status="validated", headSha="head-one", validatedTree="tree-one")
            action = state.next_action(self.plan)
            self.assertEqual((action["action"], action["phase"]["id"]), ("deliver", "one"))
            self.assertIn("record-delivery", action["reason"])
            with self.assertRaisesRegex(ValueError, "Finish delivery of phase one"):
                state.next_phase(self.plan)
            with self.assertRaisesRegex(ValueError, "Finish delivery of phase one"):
                state.make_packet(self.plan, "two", {"threadnote://plan/root": "approved plan"})

    def test_cached_packet_cannot_skip_newly_pending_delivery(self):
        self.plan["phases"][1]["dependsOn"] = []
        packet = state.make_packet(self.plan, "two", {"threadnote://plan/root": "approved plan"})
        self.plan["phases"][0].update(status="validated", validatedTree="tree-one")
        with self.assertRaisesRegex(ValueError, "Finish delivery of phase one"):
            state.check_scope(self.plan, packet, ["src/child.py"])
        # The completed phase may still obtain its own packet to finish delivery or fix feedback.
        self.assertEqual(state.make_packet(self.plan, "one", {"threadnote://plan/root": "approved plan"})["phase"]["id"], "one")

    def test_publication_label_or_planned_url_does_not_prove_handoff(self):
        for status in ("validated", "published", "merged", "blocked"):
            self.plan["phases"][0].update(status=status, headSha="head", validatedTree="tree",
                                           prUrl="https://github.com/example/repo/pull/123")
            action = state.next_action(self.plan)
            self.assertEqual((action["action"], action["phase"]["id"]), ("deliver", "one"))

    def test_pr_delivery_is_head_bound_and_keeps_ci_asynchronous(self):
        one = self.plan["phases"][0]
        before_hash = state.definition_hash(self.plan)
        self.deliver(one)
        one["ciStatus"] = "pending"
        self.assertEqual(state.definition_hash(self.plan), before_hash)
        self.assertEqual(state.next_action(self.plan)["action"], "implement")
        self.assertEqual(state.make_packet(self.plan, "two", {"threadnote://plan/root": "approved plan"})["phase"]["id"], "two")
        one["headSha"] = "new-head"
        self.assertEqual(state.next_action(self.plan)["action"], "deliver")
        one["headSha"] = "head-one"
        one["validatedTree"] = "new-tree"
        self.assertEqual(state.next_action(self.plan)["action"], "deliver")

    def test_replaced_pr_needs_a_new_delivery_receipt(self):
        one = self.plan["phases"][0]
        self.deliver(one)
        packet = state.make_packet(self.plan, "two", {"threadnote://plan/root": "approved plan"})
        one["prUrl"] = "https://github.com/example/repo/pull/456"
        self.assertEqual(state.next_action(self.plan)["action"], "deliver")
        with self.assertRaisesRegex(ValueError, "different phase PR"):
            state.check_scope(self.plan, packet, ["src/child.py"])
        replacement = self.receipt(one)
        replacement["pr"]["url"] = one["prUrl"]
        replacement["watch"]["prUrl"] = one["prUrl"]
        state.record_delivery(self.plan, "one", replacement)
        self.assertEqual(state.next_action(self.plan)["action"], "implement")
        # A checked replacement may also update the phase URL in the same operation.
        state.record_delivery(self.plan, "one", self.receipt(one))
        self.assertEqual(one["prUrl"], "https://github.com/example/repo/pull/123")
        self.assertEqual(state.next_action(self.plan)["action"], "implement")

    def test_receipt_validation_rejects_incomplete_mismatched_or_unowned_handoffs_without_mutation(self):
        one = self.plan["phases"][0]
        self.deliver(one)
        good = self.receipt(one)
        changes = [((), "phaseId", "two"), ((), "planHash", "old"), ((), "delivery", "local"),
                   ((), "headSha", "old"), ((), "validatedTree", "old"), ((), "commitEvidence", ""),
                   ((), "pr", None), (("pr",), "url", "planned"), (("pr",), "headSha", "old"),
                   (("pr",), "branch", "other"), (("pr",), "baseBranch", "other"),
                   (("pr",), "state", "closed"), (("pr",), "evidence", ""), ((), "watch", None),
                   (("watch",), "prUrl", "https://github.com/example/repo/pull/999"),
                   (("watch",), "headSha", "old"), (("watch",), "status", "interrupted"),
                   (("watch",), "stateDir", "relative"), (("watch",), "consumerKind", "collector"),
                   (("watch",), "consumerId", ""), (("watch",), "evidence", "")]
        for parents, key, value in changes:
            candidate = copy.deepcopy(good)
            target = candidate
            for parent in parents:
                target = target[parent]
            target[key] = value
            before = copy.deepcopy(self.plan)
            with self.subTest(path=(*parents, key)), self.assertRaises(ValueError):
                state.record_delivery(self.plan, "one", candidate)
            self.assertEqual(self.plan, before)

    def test_receipt_does_not_bypass_feature_publication_gate(self):
        one = self.plan["phases"][0]
        one.update(status="validated", headSha="head", validatedTree="tree")
        before = copy.deepcopy(self.plan)
        with self.assertRaisesRegex(ValueError, "Classify whether"):
            state.record_delivery(self.plan, "one", self.receipt(one))
        self.assertEqual(self.plan, before)

    def test_commit_delivery_needs_commit_receipt_but_no_pr_and_local_needs_neither(self):
        one = self.plan["phases"][0]
        one.update(status="validated", headSha="head", validatedTree="tree")
        self.plan["delivery"] = "commit"
        self.assertEqual(state.next_action(self.plan)["action"], "deliver")
        receipt = self.receipt(one)
        receipt.pop("pr")
        receipt.pop("watch")
        state.record_delivery(self.plan, "one", receipt)
        self.assertEqual(state.next_action(self.plan)["action"], "implement")
        self.plan["delivery"] = "local"
        one.pop("deliveryReceipt")
        self.assertEqual(state.next_phase(self.plan)["id"], "two")

    def test_final_phase_requires_delivery_before_plan_complete(self):
        self.plan["phases"] = self.plan["phases"][:1]
        self.plan["phases"][0]["status"] = "validated"
        self.assertEqual(state.next_action(self.plan)["action"], "deliver")
        self.deliver(self.plan["phases"][0])
        self.assertEqual(state.next_action(self.plan), {"action": "complete", "phase": None})
        self.plan["phases"][0]["status"] = "stale"
        self.assertEqual(state.next_action(self.plan), {"action": "blocked", "phase": None})

    def test_merged_pr_readback_can_finish_without_a_live_watcher(self):
        phase = self.plan["phases"][0]
        phase.update(status="merged", headSha="head", validatedTree="tree")
        receipt = self.receipt(phase)
        receipt["pr"]["state"] = "merged"
        receipt.pop("watch")
        state.record_delivery(self.plan, "one", receipt)
        self.assertEqual(state.next_action(self.plan)["action"], "implement")

    def test_record_delivery_cli_persists_receipt_and_next_returns_action(self):
        self.plan["phases"][0].update(status="validated", headSha="head", validatedTree="tree")
        self.plan["featureMemory"] = {"required": False, "classification": "small-fix", "reason": "Scoped fixture fix"}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, receipt = root / "plan.json", root / "delivery.json"
            source.write_text(json.dumps(self.plan))
            receipt.write_text(json.dumps(self.receipt(self.plan["phases"][0])))
            def invoke(*args):
                result = subprocess.run([sys.executable, "-B", str(Path(state.__file__)), *args, "--plan", str(source)],
                                        capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                return json.loads(result.stdout)
            self.assertEqual(invoke("next")["action"], "deliver")
            invoke("record-delivery", "--phase", "one", "--receipt", str(receipt))
            self.assertEqual(invoke("next")["action"], "implement")
            saved = json.loads(source.read_text())
            self.assertEqual(saved["phases"][0]["status"], "published")
            self.assertEqual(saved["phases"][0]["deliveryReceipt"], json.loads(receipt.read_text()))

    def test_packet_requires_reading_pinned_memories(self):
        packet = state.make_packet(self.plan, "one", {"threadnote://plan/root": "approved plan"})
        self.assertEqual(packet["phase"]["id"], "one")
        with self.assertRaises(ValueError):
            state.make_packet(self.plan, "one", {})
        with self.assertRaises(ValueError):
            state.make_packet(self.plan, "one", {"threadnote://plan/root": "changed plan"})

    def test_phase_definition_drift_is_detected_but_progress_is_allowed(self):
        packet = state.make_packet(self.plan, "one", {"threadnote://plan/root": "approved plan"})
        self.plan["phases"][0]["status"] = "active"
        state.check_scope(self.plan, packet, ["src/app.py"])
        self.plan["phases"][0]["acceptanceCriteria"].append("Unapproved new behavior")
        with self.assertRaises(ValueError):
            state.check_scope(self.plan, packet, ["src/app.py"])

    def test_phase_scope_and_dependency_guards(self):
        with self.assertRaises(ValueError):
            state.make_packet(self.plan, "two", {"threadnote://plan/root": "approved plan"})
        packet = state.make_packet(self.plan, "one", {"threadnote://plan/root": "approved plan"})
        with self.assertRaises(ValueError):
            state.check_scope(self.plan, packet, ["unrelated/private.py"])
        self.deliver(self.plan["phases"][0])
        self.assertEqual(state.next_phase(self.plan)["id"], "two")

    def test_invalid_cycles_unknown_dependencies_and_missing_safety_are_rejected(self):
        for change in ("cycle", "unknown", "safety"):
            plan = copy.deepcopy(self.plan)
            if change == "cycle":
                plan["phases"][0]["dependsOn"] = ["two"]
            elif change == "unknown":
                plan["phases"][1]["dependsOn"] = ["absent"]
            else:
                plan["phases"][0]["safeToMergeReason"] = ""
            with self.subTest(change=change), self.assertRaises(ValueError):
                state.validate_plan(plan)

    def test_parent_failure_invalidates_published_descendants(self):
        for phase in self.plan["phases"]:
            phase["status"] = "published"
        result = state.invalidate(self.plan, "one", "Parent CI failed")
        self.assertEqual(set(result), {"one", "two"})
        self.assertTrue(all(phase["status"] == "stale" for phase in self.plan["phases"]))
        self.assertIsNone(state.next_phase(self.plan))

    def test_validation_cannot_pass_with_missing_acceptance_or_failing_checks(self):
        validation = {"snapshotTree": "tree", "status": "passed", "productState": "working",
                      "acceptance": [{"criterion": "Old behavior still works", "result": "passed", "evidence": "test_old"}],
                      "checks": [{"command": "test", "result": "passed", "evidence": "exit 0"}]}
        state.check_validation(self.plan["phases"][0], "tree", validation)
        for key, value in (("acceptance", []), ("checks", []), ("snapshotTree", "old"),
                           ("productState", "broken")):
            with self.subTest(key=key), self.assertRaises(ValueError):
                state.check_validation(self.plan["phases"][0], "tree", {**validation, key: value})

    def test_learning_requires_external_evidence_not_self_grade_and_dedupes(self):
        lesson = {"scope": "parser", "trigger": "Empty record", "cause": "Unchecked index",
                  "correction": "Validate length", "preventiveCheck": "test_empty_record",
                  "failureEvidence": "test_empty_record failed before fix",
                  "successEvidence": "test_empty_record passed after fix", "status": "verified"}
        reflection = {"project": "example", "callerCwd": str(Path(tempfile.gettempdir()).resolve() / "checkout"), "task": "Fix parser",
                      "phaseId": "one", "sourceCommit": "abc", "lessons": [lesson, lesson], "retrieved": []}
        packet = state.learning_packet(reflection)
        self.assertEqual(len(packet["verifiedLessonIds"]), 1)
        self.assertEqual(packet["handoff"]["kind"], "handoff")
        self.assertNotIn("apply_memory_candidates", json.dumps(packet))
        bad = {**lesson, "successEvidence": ""}
        with self.assertRaises(ValueError):
            state.learning_packet({**reflection, "lessons": [bad]})

    def test_learning_records_actual_reuse_and_never_invents_lessons(self):
        reflection = {"project": "example", "callerCwd": str(Path(tempfile.gettempdir()).resolve() / "checkout"), "task": "Small task",
                      "phaseId": "one", "sourceCommit": "abc", "lessons": [],
                      "retrieved": [{"uri": "threadnote://gotcha", "disposition": "used",
                                     "check": "test_empty", "outcome": "prevented"}]}
        packet = state.learning_packet(reflection)
        self.assertEqual(packet["verifiedLessonIds"], [])
        self.assertEqual(packet["metrics"]["used"], 1)
        self.assertIn("threadnote://gotcha", packet["handoff"]["references"])

    def test_feature_publication_requires_current_confirmed_team_receipt(self):
        self.plan["phases"][0].update(status="validated", headSha="head-one")
        with self.assertRaises(ValueError):
            state.publication_gate(self.plan, "one")
        self.plan["featureMemory"] = {"required": True, "reason": "Substantive feature",
            "team": "docs", "uri": "threadnote://team/docs/feature", "revision": "revision-one",
            "receipt": {"status": "published", "team": "docs", "uri": "threadnote://team/docs/feature",
                        "revision": "revision-one", "sourceCommit": "head-one", "remoteCommit": "team-commit"}}
        self.assertEqual(state.publication_gate(self.plan, "one")["featureMemory"], "shared")
        for key, value in (("status", "draft"), ("team", "wrong-team"), ("revision", "old"),
                           ("sourceCommit", "old-head"), ("remoteCommit", "")):
            plan = copy.deepcopy(self.plan)
            plan["featureMemory"]["receipt"][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                state.publication_gate(plan, "one")

    def test_small_fix_can_skip_feature_memory_with_explicit_reason(self):
        self.plan["phases"][0].update(status="validated", headSha="head-one")
        self.plan["featureMemory"] = {"required": False, "classification": "small-fix",
                                      "reason": "One-line null guard; no new feature contract"}
        self.assertEqual(state.publication_gate(self.plan, "one")["featureMemory"], "exempt")
        self.plan["featureMemory"]["classification"] = "feature"
        with self.assertRaises(ValueError):
            state.publication_gate(self.plan, "one")

    def test_project_preferences_require_user_authority_and_remain_private(self):
        reflection = {"project": "docs", "callerCwd": str(Path(tempfile.gettempdir()).resolve() / "checkout"), "task": "Small task",
                      "phaseId": "one", "sourceCommit": "abc", "lessons": [], "retrieved": [],
                      "projectPreferences": [
                          {"key": "tests", "value": "Run focused parser tests first",
                           "source": "User explicitly requested this for docs", "authority": "explicit-user"},
                          {"key": "database", "value": "Always use SQLite",
                           "source": "One task happened to use SQLite", "authority": "inferred"}]}
        packet = state.learning_packet(reflection)
        self.assertEqual(len(packet["preferences"]), 1)
        self.assertEqual(packet["preferences"][0]["kind"], "preference")
        self.assertEqual(packet["preferences"][0]["project"], "docs")
        self.assertEqual(len(packet["preferenceCandidates"]), 1)
        self.assertNotIn("team", packet["preferences"][0])

    def test_tiny_publication_does_not_need_the_stack_schema(self):
        publication = {"delivery": "pr", "phase": {"id": "single", "status": "validated", "headSha": "head"},
                       "featureMemory": {"required": False, "classification": "small-fix", "reason": "Null guard only"}}
        self.assertEqual(state.publication_gate(publication, "single")["featureMemory"], "exempt")

    def test_packet_cli_creates_missing_phase_output_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            plan = {**self.plan, "planMemoryUris": [], "memoryHashes": {}}
            source, output = root / "plan.json", root / "new-phase/phase-packet.json"
            source.write_text(json.dumps(plan))
            result = subprocess.run([sys.executable, "-B", str(Path(state.__file__)), "packet",
                                     "--plan", str(source), "--phase", "one", "--output", str(output)],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(output.read_text())["phase"]["id"], "one")

    def test_closeout_prepares_interactive_choices_without_applying_proposals(self):
        proposals = [{"id": str(i), "kind": "preference", "summary": "Save a project preference?",
                      "target": "private docs preference", "preview": "Use focused tests; full preview /preview.json",
                      "status": "pending"} for i in range(4)]
        packet = state.closeout_packet(proposals)
        self.assertEqual(packet["proposalIds"], ["0", "1", "2"])
        self.assertEqual(packet["remaining"], ["3"])
        self.assertEqual(packet["questions"][0]["options"], ["Approve", "Defer", "Reject"])
        proposals[0]["preview"] += " changed"
        self.assertNotEqual(packet["proposalHashes"]["0"], state.closeout_packet(proposals)["proposalHashes"]["0"])

    def test_knowledge_delta_prompt_requires_actual_review_identity(self):
        proposal = {"id": "KD1", "kind": "knowledge-delta", "summary": "Apply parser learning?",
                    "target": "docs", "preview": "Reviewed decisions, constraints, checks and risks"}
        with self.assertRaises(ValueError):
            state.closeout_packet([proposal])
        proposal.update(reviewId="review-1", reviewRevision=2, candidateIds=["candidate-1"])
        self.assertEqual(state.closeout_packet([proposal])["proposalIds"], ["KD1"])


def delivery_fixture(sequence):
    fixture = PhaseStateTests()
    fixture.setUp()
    fixture.plan["delivery"] = sequence["delivery"]
    fixture.plan["planMemoryUris"] = []
    fixture.plan["memoryHashes"] = {}
    fixture.plan["phases"] = [fixture.phase("p" + str(i)) for i in range(len(sequence["receipts"]) + 1)]
    candidate = fixture.plan["phases"][-1]
    packet = state.make_packet(fixture.plan, candidate["id"], {})
    for phase, recorded in zip(fixture.plan["phases"], sequence["receipts"]):
        phase.update(status="validated", headSha="head-" + phase["id"], validatedTree="tree-" + phase["id"])
        if recorded:
            fixture.deliver(phase)
    if sequence["changeHead"] and sequence["receipts"]:
        fixture.plan["phases"][0]["headSha"] = "changed-head"
    before = copy.deepcopy(fixture.plan)
    action = state.next_action(fixture.plan)
    admitted = []
    for operation in (lambda: state.make_packet(fixture.plan, candidate["id"], {}),
                      lambda: state.check_scope(fixture.plan, packet, ["src/next.py"])):
        try:
            operation()
            admitted.append(True)
        except ValueError:
            admitted.append(False)
    assert fixture.plan == before, "Read-only guards mutated the plan"
    print(json.dumps({"action": action["action"], "phase": action["phase"]["id"],
                      "packetAllowed": admitted[0], "cachedPacketAllowed": admitted[1]}))


if __name__ == "__main__":
    if sys.argv[1:] == ["--delivery-fixture"]:
        delivery_fixture(json.load(sys.stdin))
    else:
        unittest.main()

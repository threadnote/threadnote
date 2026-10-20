import sys
from pathlib import Path
PRODUCT_SKILLS = Path(__file__).resolve().parents[6] / "config/agent-skills"
sys.path[:0] = [str(PRODUCT_SKILLS / skill / "scripts") for skill in ("dev-spec", "dev-plan", "dev-cycle", "watch-pr")]
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import subprocess
import sys
import unittest
import phase_state as state


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
        self.plan["phases"][0]["status"] = "published"
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


if __name__ == "__main__":
    unittest.main()

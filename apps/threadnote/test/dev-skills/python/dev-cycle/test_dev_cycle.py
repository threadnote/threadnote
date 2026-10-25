import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from product_skills_fixture import configure_product_skills, assert_product_provenance
PRODUCT_SKILLS = configure_product_skills(__file__, 6)
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


HELPER = PRODUCT_SKILLS / "dev-cycle/scripts/dev_cycle.py"


class DevCycleTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.name", "Dev Cycle Test")
        self.git("config", "user.email", "test@example.invalid")
        (self.repo / "app.py").write_text("answer = 0\n")
        (self.repo / "remove.txt").write_text("original\n")
        self.git("add", ".")
        self.git("commit", "-qm", "baseline")

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.repo), *args])

    def run_helper(self, *args, succeeds=True):
        result = subprocess.run(
            [sys.executable, str(HELPER), *map(str, args)],
            capture_output=True, text=True,
        )
        if succeeds:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0)
        return result

    def snapshot(self, name, base="HEAD", previous=None):
        output = self.repo / ".context" / "dev-cycle" / "test-run" / name
        args = ["snapshot", "--repo", self.repo, "--output", output, "--base", base]
        if previous:
            args += ["--previous", previous]
        self.run_helper(*args)
        return output

    def metadata(self, directory):
        return json.loads((directory / "snapshot.json").read_text())

    def review(self, directory, findings, previous=None):
        (directory / "findings.json").write_text(json.dumps(findings))
        (directory / "agent-selection.json").write_text(json.dumps({
            "selected": ["orchestrator"], "mode": "orchestrator-only", "skipped": [],
        }))
        (directory / "review.json").write_text(json.dumps({
            "status": "complete",
            "snapshotTree": self.metadata(directory)["tree"],
            "reviewMode": "incremental" if previous else "full",
            "lanes": [{"name": "orchestrator", "status": "complete"}],
        }))

    def finding(self, **overrides):
        return dict({
            "id": "F001", "file": "app.py", "line": 1,
            "severity": "important", "category": "correctness",
            "confidence": 95, "body": "Incorrect answer",
            "trigger": "Calling answer", "impact": "Returns the wrong result",
            "evidence": "app.py:1 returns 0", "state": "new",
        }, **overrides)

    def test_clean_snapshot_preserves_status_index_and_gitignore(self):
        index = (self.repo / ".git" / "index").read_bytes()
        snapshot = self.snapshot("baseline")
        self.assertEqual(self.git("status", "--porcelain"), b"")
        self.assertEqual((self.repo / ".git" / "index").read_bytes(), index)
        self.assertFalse((self.repo / ".gitignore").exists())
        self.assertEqual((snapshot / "diff.patch").read_bytes(), b"")

    def test_capture_preserves_partial_staging_and_deletions(self):
        (self.repo / "app.py").write_text("answer = 1\n")
        self.git("add", "app.py")
        (self.repo / "app.py").write_text("answer = 2\n")
        (self.repo / "remove.txt").unlink()
        (self.repo / "new file.bin").write_bytes(b"\x00\x01\x02")
        index = (self.repo / ".git" / "index").read_bytes()
        staged = self.git("diff", "--cached")
        snapshot = self.snapshot("iter-1")
        self.assertEqual((self.repo / ".git" / "index").read_bytes(), index)
        self.assertEqual(self.git("diff", "--cached"), staged)
        files = json.loads((snapshot / "files.json").read_text())
        self.assertEqual(set(files), {"app.py", "remove.txt", "new file.bin"})
        self.assertIn("+answer = 2", (snapshot / "diff.patch").read_text())

    def test_implementation_baseline_excludes_existing_changes(self):
        (self.repo / "notes.txt").write_text("existing user work\n")
        baseline = self.snapshot("baseline")
        (self.repo / "app.py").write_text("answer = 1\n")
        current = self.snapshot("iter-1", self.metadata(baseline)["tree"])
        self.assertEqual(json.loads((current / "files.json").read_text()), ["app.py"])

    def test_capture_rehashes_files_with_unchanged_cached_stat(self):
        self.git("config", "core.trustctime", "false")
        self.git("config", "core.checkStat", "minimal")
        path = self.repo / "app.py"
        path.write_text("answer = 1\n")
        old = path.stat().st_mtime_ns - 10_000_000_000
        os.utime(path, ns=(old, old))
        self.git("add", "app.py")
        index = (self.repo / ".git" / "index").read_bytes()
        path.write_text("answer = 2\n")
        os.utime(path, ns=(old, old))
        snapshot = self.snapshot("iter-1")
        self.assertIn("+answer = 2", (snapshot / "diff.patch").read_text())
        self.assertEqual((self.repo / ".git" / "index").read_bytes(), index)
        path.write_text("answer = 3\n")
        os.utime(path, ns=(old, old))
        self.run_helper("check", "--repo", self.repo, "--snapshot", snapshot, succeeds=False)

    def test_branch_fix_is_in_snapshot_and_source_delta(self):
        self.git("checkout", "-qb", "feature")
        (self.repo / "app.py").write_text("answer = 1\n")
        self.git("commit", "-qam", "feature")
        base = self.git("merge-base", "main", "HEAD").decode().strip()
        first = self.snapshot("iter-1", base)
        (self.repo / "app.py").write_text("answer = 2\n")
        second = self.snapshot("iter-2", base, first)
        delta = (second / "delta.patch").read_text()
        self.assertIn("+answer = 2", (second / "diff.patch").read_text())
        self.assertIn("-answer = 1\n+answer = 2", delta)
        self.assertIn("diff --git a/app.py b/app.py", delta)
        self.assertEqual(json.loads((second / "delta-files.json").read_text()), ["app.py"])

    def test_snapshot_is_immutable_and_check_detects_source_drift(self):
        first = self.snapshot("iter-1")
        self.run_helper("check", "--repo", self.repo, "--snapshot", first)
        self.run_helper("snapshot", "--repo", self.repo, "--output", first,
                        "--base", "HEAD", succeeds=False)
        (self.repo / "app.py").write_text("answer = 2\n")
        self.run_helper("check", "--repo", self.repo, "--snapshot", first, succeeds=False)

    def test_non_repository_fails_without_creating_output(self):
        output = self.repo / "outside" / "artifacts"
        with tempfile.TemporaryDirectory() as unrelated:
            self.run_helper("snapshot", "--repo", unrelated, "--output", output,
                            "--base", "HEAD", succeeds=False)
        self.assertFalse(output.exists())

    def test_review_counts_are_computed(self):
        first = self.snapshot("iter-1")
        self.review(first, [self.finding(), self.finding(id="F002", severity="minor")])
        self.run_helper("validate-review", "--iteration", first)
        summary = json.loads((first / "summary.json").read_text())
        self.assertEqual(summary["blockingIssueCount"], 1)
        self.assertEqual(summary["counts"]["minor"], 1)

    def test_malformed_review_does_not_leave_clean_summary(self):
        first = self.snapshot("iter-1")
        self.review(first, [])
        self.run_helper("validate-review", "--iteration", first)
        (first / "findings.json").write_text("not JSON")
        self.run_helper("validate-review", "--iteration", first, succeeds=False)
        self.assertFalse((first / "summary.json").exists())

    def test_failed_lane_or_wrong_snapshot_cannot_be_clean(self):
        first = self.snapshot("iter-1")
        for field, value in (("lanes", [{"name": "generalist", "status": "failed"}]),
                             ("snapshotTree", "wrong-tree")):
            self.review(first, [])
            report = json.loads((first / "review.json").read_text())
            report[field] = value
            (first / "review.json").write_text(json.dumps(report))
            self.run_helper("validate-review", "--iteration", first, succeeds=False)

    def test_incremental_review_must_account_for_previous_blocker(self):
        first = self.snapshot("iter-1")
        self.review(first, [self.finding()])
        second = self.snapshot("iter-2", previous=first)
        self.review(second, [], previous=first)
        self.run_helper("validate-review", "--iteration", second, "--previous", first,
                        succeeds=False)
        self.review(second, [self.finding(state="resolved", reason="Verified corrected output")], first)
        self.run_helper("validate-review", "--iteration", second, "--previous", first)
        summary = json.loads((second / "summary.json").read_text())
        self.assertEqual(summary["blockingIssueCount"], 0)
        self.assertEqual(summary["resolved"], ["F001"])

    def test_omitted_selected_lane_cannot_be_clean(self):
        first = self.snapshot("iter-1")
        self.review(first, [])
        (first / "agent-selection.json").write_text(json.dumps({
            "selected": ["orchestrator", "security-correctness"], "mode": "single",
        }))
        self.run_helper("validate-review", "--iteration", first, succeeds=False)

    def test_prior_blocker_cannot_be_silently_downgraded(self):
        first = self.snapshot("iter-1")
        self.review(first, [self.finding()])
        second = self.snapshot("iter-2", previous=first)
        self.review(second, [self.finding(state="carried", severity="minor")], first)
        self.run_helper("validate-review", "--iteration", second, "--previous", first,
                        succeeds=False)

    def test_snapshot_in_linked_worktree_preserves_its_index(self):
        checkout = self.repo / "linked-checkout"
        self.git("worktree", "add", "-qb", "feature", str(checkout))
        (checkout / "app.py").write_text("answer = 5\n")
        index = Path(subprocess.check_output([
            "git", "-C", str(checkout), "rev-parse", "--git-path", "index",
        ]).decode().strip())
        before = index.read_bytes()
        output = checkout / ".context/dev-cycle/test/iter-1"
        self.run_helper("snapshot", "--repo", checkout, "--output", output, "--base", "HEAD")
        self.assertEqual(index.read_bytes(), before)
        self.assertIn("+answer = 5", (output / "diff.patch").read_text())

    def test_staged_ignored_file_and_split_index_are_preserved(self):
        (self.repo / ".gitignore").write_text("private.txt\n")
        (self.repo / "private.txt").write_text("already staged content\n")
        self.git("add", "-f", "private.txt")
        self.git("update-index", "--split-index")
        before = (self.repo / ".git/index").read_bytes()
        first = self.snapshot("iter-1")
        self.assertIn("private.txt", json.loads((first / "files.json").read_text()))
        self.assertEqual((self.repo / ".git/index").read_bytes(), before)

    def test_committed_phase_head_needs_explicit_reconciliation_and_keeps_source_guard(self):
        (self.repo / "app.py").write_text("answer = 1\n")
        first = self.snapshot("iter-1")
        self.git("commit", "-qam", "validated phase")
        head = self.git("rev-parse", "HEAD").decode().strip()
        self.run_helper("check", "--repo", self.repo, "--snapshot", first, succeeds=False)
        self.run_helper("check", "--repo", self.repo, "--snapshot", first, "--accepted-head", head)
        (self.repo / "app.py").write_text("answer = 2\n")
        self.run_helper("check", "--repo", self.repo, "--snapshot", first, "--accepted-head", head,
                        succeeds=False)
        output = first.parent / "iter-2"
        self.run_helper("snapshot", "--repo", self.repo, "--output", output,
                        "--base", self.metadata(first)["baseTree"], "--previous", first,
                        "--accepted-head", head)
        self.assertIn("-answer = 1\n+answer = 2", (output / "delta.patch").read_text())


if __name__ == "__main__":
    unittest.main()

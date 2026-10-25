#!/usr/bin/env python3
"""Offline regression/property tests; no authenticated GitHub calls."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from product_skills_fixture import configure_product_skills, assert_product_provenance
PRODUCT_SKILLS = configure_product_skills(__file__, 6)
import copy
from portable_lock import lock_exclusive
import json
from pathlib import Path
import random
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import watch_pr as watcher
assert_product_provenance(PRODUCT_SKILLS, "watch-pr-imports")


def fixture():
    return {
        "pr": {"head": {"sha": "a" * 40}, "html_url": "https://github.com/owner/repo/pull/1",
               "state": "open", "mergeable": True, "mergeable_state": "clean", "draft": False},
        "checks": [{"id": 1, "name": "tests", "status": "completed", "conclusion": "success"}],
        "statuses": [],
        "activity": {"comment": [], "review_comment": [], "review": []},
    }


class SatelliteTests(unittest.TestCase):
    def test_settled_completion_and_no_duplicate(self):
        snap = fixture()
        state, events = watcher.transition({}, snap, 0)
        self.assertEqual(events, [])
        state, events = watcher.transition(state, snap, 59)
        self.assertEqual(events, [])
        state, events = watcher.transition(state, snap, 60)
        self.assertEqual([e["kind"] for e in events], ["ci_complete"])
        self.assertTrue(events[0]["ready"])
        self.assertEqual(watcher.transition(state, snap, 120)[1], [])

    def test_empty_pending_failed_or_blocked_never_ready(self):
        for variant in ("empty", "pending", "failure", "status", "draft", "blocked", "unknown"):
            with self.subTest(variant=variant):
                snap = fixture()
                if variant == "empty":
                    snap["checks"] = []
                elif variant == "pending":
                    snap["checks"][0]["status"] = "in_progress"
                elif variant == "failure":
                    snap["checks"][0]["conclusion"] = "timed_out"
                elif variant == "status":
                    snap["statuses"] = [{"id": 2, "context": "external", "state": "pending"}]
                elif variant == "draft":
                    snap["pr"]["draft"] = True
                elif variant == "blocked":
                    snap["pr"]["mergeable_state"] = "blocked"
                else:
                    snap["pr"]["mergeable"] = None
                state, _ = watcher.transition({}, snap, 0)
                _, events = watcher.transition(state, snap, 100)
                self.assertFalse(any(e.get("ready") for e in events))

    def test_head_change_invalidates_completion(self):
        snap = fixture()
        state, _ = watcher.transition({}, snap, 0)
        state, _ = watcher.transition(state, snap, 60)
        snap["pr"]["head"]["sha"] = "b" * 40
        state, events = watcher.transition(state, snap, 61)
        self.assertEqual([e["kind"] for e in events], ["head_changed"])
        self.assertEqual([e["kind"] for e in watcher.transition(state, snap, 121)[1]], ["ci_complete"])

    def test_failure_and_comment_dedup_no_bodies(self):
        snap = fixture()
        old = {"id": 12, "updated_at": "t1", "html_url": "https://example.com/12", "body": "untrusted"}
        snap["activity"]["comment"] = [old]
        state, _ = watcher.transition({}, snap, 0)
        old["updated_at"] = "t2"
        snap["checks"][0]["conclusion"] = "failure"
        state, events = watcher.transition(state, snap, 1)
        self.assertEqual({e["kind"] for e in events}, {"comment", "ci_error"})
        self.assertNotIn("untrusted", json.dumps(events))
        self.assertEqual(watcher.transition(state, snap, 2)[1], [])

    def test_review_block_then_approval(self):
        snap = fixture()
        snap["activity"]["review"] = [{"id": 10, "user": {"id": 9}, "state": "CHANGES_REQUESTED"}]
        state, events = watcher.transition({}, snap, 0)
        self.assertEqual(events[0]["kind"], "review_blocked")
        snap["activity"]["review"].append({"id": 11, "user": {"id": 9}, "state": "APPROVED"})
        state, _ = watcher.transition(state, snap, 60)
        self.assertEqual(state["blocked_reviews"], [])

    def test_closed_and_merged_are_distinct_terminal_events(self):
        for merged, kind in ((False, "closed"), (True, "merged")):
            snap = fixture()
            snap["pr"].update(state="closed", merged=merged)
            state, events = watcher.transition({}, snap, 0)
            self.assertEqual(events[0]["kind"], kind)
            self.assertEqual(watcher.transition(state, snap, 1)[1], [])

    def test_property_order_invariance_non_mutation_and_idempotence(self):
        rng = random.Random(722)
        for _ in range(100):
            snap = fixture()
            snap["checks"] = [{"id": i, "name": f"job-{i}", "status": "completed", "conclusion": "success"}
                              for i in range(rng.randint(1, 20))]
            original = copy.deepcopy(snap)
            state, _ = watcher.transition({}, snap, 0)
            previous = copy.deepcopy(state)
            shuffled = copy.deepcopy(snap)
            rng.shuffle(shuffled["checks"])
            result, events = watcher.transition(state, shuffled, 61)
            normal, expected = watcher.transition(state, snap, 61)
            self.assertEqual((result, events), (normal, expected))
            self.assertEqual(snap, original)
            self.assertEqual(state, previous)
            self.assertEqual(watcher.transition(result, shuffled, 62)[1], [])

    def test_drain_delivers_once_and_bounds_batch(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            watcher.emit(directory, [{"kind": "comment", "id": i} for i in range(105)])
            self.assertEqual(len(watcher.drain(directory)["events"]), 100)
            self.assertEqual(len(watcher.drain(directory)["events"]), 5)
            self.assertEqual(watcher.drain(directory)["events"], [])

    def test_relay_replays_until_acknowledged_and_recovers_after_restart(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            watcher.emit(directory, [{"kind": "comment", "id": i} for i in range(105)])
            first = watcher.relay(directory)
            self.assertEqual(len(first["events"]), 100)
            self.assertEqual(watcher.relay(directory)["delivery_id"], first["delivery_id"])
            self.assertEqual(watcher.relay(directory)["events"], first["events"])
            with self.assertRaises(ValueError):
                watcher.drain(directory)
            with self.assertRaises(ValueError):
                watcher.ack(directory, "wrong-delivery")
            watcher.ack(directory, first["delivery_id"])
            watcher.ack(directory, first["delivery_id"])
            second = watcher.relay(directory)
            self.assertEqual(len(second["events"]), 5)
            self.assertNotEqual(second["delivery_id"], first["delivery_id"])
            watcher.ack(directory, second["delivery_id"])
            self.assertEqual(watcher.relay(directory)["events"], [])

    def test_relay_ack_survives_cursor_saved_before_receipt(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            watcher.emit(directory, [{"kind": "ci_error", "head": "a"}])
            batch = watcher.relay(directory)
            pending = watcher.read_json(directory / "delivery.json", {})
            watcher.save(directory / "cursor.json", pending["end"])
            self.assertEqual(watcher.relay(directory)["delivery_id"], batch["delivery_id"])
            watcher.ack(directory, batch["delivery_id"])
            self.assertEqual(watcher.relay(directory)["events"], [])

    def test_api_pagination_and_timeout_without_error_leak(self):
        result = type("Result", (), {"returncode": 0, "stdout": b'[[{"id":1}],[{"id":2}]]'})()
        with patch.object(watcher.subprocess, "run", return_value=result) as run:
            self.assertEqual(watcher.api("github.com", "path", ""), [{"id": 1}, {"id": 2}])
            self.assertIn("--paginate", run.call_args.args[0])
            self.assertEqual(run.call_args.kwargs["timeout"], 45)
        result.returncode = 1
        result.stderr = b"secret token"
        with patch.object(watcher.subprocess, "run", return_value=result):
            with self.assertRaisesRegex(RuntimeError, "GitHub API request failed") as error:
                watcher.api("github.com", "path")
            self.assertNotIn("secret", str(error.exception))

    def test_real_wait_process_wakes_on_inbox_signal(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            with (directory / "watch.lock").open("a+b") as lock:
                lock_exclusive(lock)
                process = subprocess.Popen([sys.executable, "-B", str(Path(watcher.__file__)), "wait",
                                            "--state-dir", root, "--timeout", "2"], stdout=subprocess.PIPE)
                watcher.emit(directory, [{"kind": "comment", "id": 42}])
                output, _ = process.communicate(timeout=5)
                self.assertEqual(process.returncode, 0)
                self.assertEqual(json.loads(output)["events"][0]["id"], 42)
                self.assertEqual(watcher.drain(directory)["events"], [])

    def test_watch_cooperative_stop_and_lock_release(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)

            def snapshot_and_stop(_):
                (directory / "stop").touch()
                return fixture()

            args = SimpleNamespace(pr="https://github.com/owner/repo/pull/1", interval=1, max_hours=1)
            with patch.object(watcher, "snapshot", side_effect=snapshot_and_stop):
                watcher.watch(args, directory)
            self.assertFalse(watcher.live(directory))
            self.assertIsNotNone(watcher.drain(directory)["last_poll"])
            self.assertEqual(watcher.drain(directory)["events"], [])

    def test_pr_url_validation(self):
        self.assertEqual(watcher.target("https://github.com/o/r/pull/12"), ("github.com", "repos/o/r", "12"))
        for url in ("http://github.com/o/r/pull/1", "https://secret@github.com/o/r/pull/1", "https://github.com/o/r/issues/1"):
            with self.assertRaises(ValueError):
                watcher.target(url)


if __name__ == "__main__":
    unittest.main()

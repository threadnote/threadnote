#!/usr/bin/env python3
"""Caller protocol doubles: no executable, runtime, owner home or native graph is used."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from product_skills_fixture import configure_product_skills, assert_product_provenance
PRODUCT_SKILLS = configure_product_skills(__file__, 6)
# Match the dev-plan entrypoint's sibling import resolution, including its own transport.
sys.path.insert(0, str(PRODUCT_SKILLS / "dev-plan/scripts"))

import copy
import hashlib
import json
import os
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import archive_transport as at
import dev_plan as dp
import workflow_transport as wt

assert_product_provenance(PRODUCT_SKILLS, "archive-transport-imports")
SOURCE = "threadnote://user/synthetic/memories/durable/projects/test/source.md"
DESTINATION = "threadnote://user/synthetic/memories/durable/archived/test/consolidation-exact.md"


class ArchiveTransport(unittest.TestCase):
    def setUp(self):
        self.addCleanup(assert_product_provenance, PRODUCT_SKILLS, self.id())
        temporary = tempfile.TemporaryDirectory(prefix="archive-protocol-")
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name).resolve()
        self.executable = self.directory / "immutable-native"
        self.executable.write_bytes(b"Synthetic protocol identity; never executed.")
        self.client = SimpleNamespace(repo=str(self.directory), home=str(self.directory / "home"))
        self.native = {"version": 1, "planId": "a" * 64, "timestamp": "2026-10-22T00:00:00.000Z",
                       "archiveKey": "e" * 64,
                       "source": {"uri": SOURCE, "sha256": "b" * 64, "bytes": 42},
                       "destination": {"uri": DESTINATION, "sha256": "c" * 64, "bytes": 84},
                       "runtime": {"executablePath": str(self.executable),
                                   "sha256": hashlib.sha256(self.executable.read_bytes()).hexdigest()},
                       "config": {"account": "synthetic-account", "user": "synthetic",
                                  "agentId": "synthetic-agent", "agentContextHome": self.client.home,
                                  "realHome": self.client.home,
                                  "manifestPath": str(self.directory / "config.json"),
                                  "manifestRealPath": str(self.directory / "config.json"),
                                  "manifestSha256": "d" * 64}}
        self.calls = []
        self.missing = False
        self.fail = False
        self.transform = lambda response: response
        self.runner = patch.object(at.subprocess, "run", self.invoke)
        self.runner.start()
        self.addCleanup(self.runner.stop)
        self.which = patch.object(at.shutil, "which", return_value=str(self.directory / "global-launcher"))
        self.which_mock = self.which.start()
        self.addCleanup(self.which.stop)

    def invoke(self, argv, **options):
        request = json.loads(options["input"])
        self.calls.append((copy.deepcopy(argv), copy.deepcopy(request), copy.deepcopy(options)))
        if self.missing:
            return subprocess.CompletedProcess(argv, 1, "Unknown command memory-archive\n", "")
        if self.fail:
            return subprocess.CompletedProcess(argv, 1, json.dumps({"version": 1, "status": "error",
                                                               "code": "source-changed", "message": "Refused"}), "")
        if request["action"] == "plan":
            response = {"version": 1, "status": "ok", "plan": copy.deepcopy(self.native)}
        else:
            response = {"version": 1, "status": "ok", "result": {
                "version": 1, "planId": request["plan"]["planId"], "sourceUri": SOURCE,
                "destinationUri": DESTINATION,
                "status": "ready" if request["action"] == "check" else "archived"}}
        return subprocess.CompletedProcess(argv, 0, json.dumps(self.transform(response)), "")

    def policy(self, **changes):
        policy = {"version": 1, "executablePath": str(self.executable),
                  "executableSha256": self.native["runtime"]["sha256"],
                  "account": "synthetic-account", "user": "synthetic",
                  "agentContextHome": self.client.home, "sourceUris": [SOURCE],
                  "ownerApproval": "Synthetic test provenance only; never a live permission"}
        policy.update(changes)
        path = self.directory / "policy.json"
        path.write_text(json.dumps(policy), encoding="utf-8")
        return path

    def test_plan_check_commit_pin_same_plan_runtime_and_environment(self):
        with patch.dict(os.environ, {"SYNTHETIC_ARCHIVE_ENV": "before"}):
            transport = at.LegacyArchiveTransport(self.client)
        plan = transport.plan_archive(SOURCE)
        frozen = copy.deepcopy(plan)
        with patch.dict(os.environ, {"SYNTHETIC_ARCHIVE_ENV": "after", "PATH": "/different"}):
            transport.validate_archive_plans([plan])
            self.assertEqual(transport.archive(SOURCE, plan), DESTINATION)
        self.assertEqual(plan, frozen)
        self.assertEqual([r[1]["action"] for r in self.calls], ["plan", "check", "commit"])
        self.assertEqual(self.calls[0][0][0], str(self.directory / "global-launcher"))
        for argv, request, options in self.calls[1:]:
            self.assertEqual(argv, [str(self.executable), "memory-archive", "--home", self.client.home])
            self.assertEqual(request["plan"], self.native)
            self.assertEqual(options["env"]["SYNTHETIC_ARCHIVE_ENV"], "before")
            self.assertEqual(options["cwd"], str(self.directory))
            self.assertEqual(options["timeout"], 55)
        self.which_mock.assert_called_once()

    def test_executable_change_refuses_before_any_check_or_commit_process(self):
        transport = at.LegacyArchiveTransport(self.client)
        plan = transport.plan_archive(SOURCE)
        self.executable.write_bytes(b"Changed synthetic executable")
        for operation in (lambda: transport.validate_archive_plans([plan]), lambda: transport.archive(SOURCE, plan)):
            with self.assertRaisesRegex(dp.PlanError, "differs|bytes changed"):
                operation()
        self.assertEqual(len(self.calls), 1)

    def test_home_checkout_and_full_native_identity_changes_are_rejected(self):
        for field in ("home", "repo", "account", "user", "agentId", "manifestSha256", "realHome", "manifestRealPath"):
            with self.subTest(field=field):
                self.client.repo, self.client.home = str(self.directory), str(self.directory / "home")
                transport = at.LegacyArchiveTransport(self.client)
                plan = transport.plan_archive(SOURCE)
                changed = copy.deepcopy(plan)
                if field in ("home", "repo"):
                    setattr(self.client, field, str(self.directory / "changed"))
                else:
                    changed["plan"]["config"][field] = "changed"
                before = len(self.calls)
                with self.assertRaises(dp.PlanError):
                    transport.archive(SOURCE, changed)
                self.assertEqual(len(self.calls), before)

    def test_malformed_plan_does_not_pin_a_partial_identity(self):
        transport = at.LegacyArchiveTransport(self.client)
        malformed = copy.deepcopy(self.native)
        malformed["destination"]["bytes"] = True
        with self.assertRaises(dp.PlanError):
            transport._pin(malformed)
        self.assertIsNone(transport.identity)
        self.assertIsNone(transport.executable)
        transport.plan_archive(SOURCE)
        for key in ("agentId", "manifestSha256", "realHome"):
            malformed = copy.deepcopy(self.native)
            del malformed["config"][key]
            with self.subTest(key=key), self.assertRaises(dp.PlanError):
                at.LegacyArchiveTransport(self.client)._pin(malformed)

    def test_missing_protocol_or_native_refusal_never_uses_legacy_archive(self):
        transport = at.LegacyArchiveTransport(self.client)
        self.missing = True
        with self.assertRaisesRegex(dp.PlanError, "no legacy archive fallback"):
            transport.plan_archive(SOURCE)
        self.missing, self.fail = False, True
        with self.assertRaisesRegex(dp.PlanError, "source-changed"):
            transport.plan_archive(SOURCE)
        self.assertTrue(all(call[0][1] == "memory-archive" for call in self.calls))

    def test_destination_source_status_and_plan_drift_refused(self):
        for field in ("destinationUri", "sourceUri", "planId", "status"):
            with self.subTest(field=field):
                transport = at.LegacyArchiveTransport(self.client)
                plan = transport.plan_archive(SOURCE)
                def changed(response):
                    response["result"][field] = "different"
                    return response
                self.transform = changed
                with self.assertRaisesRegex(dp.PlanError, "differs from its admitted plan"):
                    transport.archive(SOURCE, plan)
                self.transform = lambda response: response
        transport = at.LegacyArchiveTransport(self.client)
        plan = transport.plan_archive(SOURCE)
        plan["preview"]["canonicalUri"] += ".changed"
        before = len(self.calls)
        with self.assertRaises(dp.PlanError):
            transport.archive(SOURCE, plan)
        self.assertEqual(len(self.calls), before)

    def test_interrupted_commit_reuses_exact_plan_with_fresh_caller(self):
        plan = at.LegacyArchiveTransport(self.client).plan_archive(SOURCE)
        def replay(response):
            if "result" in response:
                response["result"]["status"] = "already-archived"
            return response
        self.transform = replay
        resumed = at.LegacyArchiveTransport(self.client)
        resumed.validate_archive_plans([plan])
        self.assertEqual(resumed.archive(SOURCE, plan), DESTINATION)
        self.assertTrue(all(argv[0] == str(self.executable) for argv, _, _ in self.calls[1:]))
        self.assertEqual(self.calls[-1][1]["plan"], self.native)

    def test_policy_pins_identity_and_source_set_before_native_call(self):
        transport = at.LegacyArchiveTransport(self.client, self.policy())
        self.assertEqual(transport.plan_archive(SOURCE)["preview"]["canonicalUri"], DESTINATION)
        self.assertEqual(self.calls[0][0][0], str(self.executable))
        self.which_mock.assert_not_called()
        before = len(self.calls)
        with self.assertRaisesRegex(dp.PlanError, "outside"):
            transport.plan_archive(SOURCE + ".other")
        self.assertEqual(len(self.calls), before)
        for changes in ({"executableSha256": "0" * 64}, {"version": True}, {"sourceUris": []},
                        {"sourceUris": [SOURCE, SOURCE]}, {"sourceUris": [1]}, {"extra": "unexpected"}):
            with self.subTest(changes=changes), self.assertRaises(dp.PlanError):
                at.LegacyArchiveTransport(self.client, self.policy(**changes))
        self.assertEqual(len(self.calls), before)

    def test_policy_config_mismatch_and_runtime_alias_refused(self):
        for changes in ({"account": "different"}, {"user": "different"}, {"agentContextHome": "/different"}):
            with self.subTest(changes=changes):
                transport = at.LegacyArchiveTransport(self.client, self.policy(**changes))
                with self.assertRaisesRegex(dp.PlanError, "scoped runtime policy"):
                    transport.plan_archive(SOURCE)
        alias = self.directory / "alias"
        try:
            alias.symlink_to(self.executable)
        except OSError:
            return  # Windows without symlink privilege still exercises identity/config controls above.
        with self.assertRaisesRegex(dp.PlanError, "canonical immutable"):
            at.LegacyArchiveTransport(self.client, self.policy(executablePath=str(alias)))

    def test_structured_or_personal_cloud_cannot_route_through_legacy_protocol(self):
        client = dp.Threadnote()
        client.workflow = SimpleNamespace()
        client.archive_runtime_policy = "unused-policy.json"
        for operation in (lambda: client.plan_archive(SOURCE), lambda: client.validate_archive_plans([]),
                          lambda: client.archive(SOURCE, {})):
            with self.assertRaisesRegex(dp.PlanError, "original owning runtime"):
                operation()
        client.workflow = None
        client.workflow_options = {"workflow_context": "missing-original-context.json"}
        with self.assertRaises(wt.WorkflowError):
            client.plan_archive(SOURCE)
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()

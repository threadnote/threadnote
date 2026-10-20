"""Opt-in real CLI/Git coverage; no mocked workflow-memory or publication receipts.

Put the intended Threadnote binary (or source CLI wrapper) on PATH, then run:
DEV_WORKFLOW_CLOUD_NATIVE=1 python3 -B test_personal_cloud_workflow.py
Each case owns temporary user/data homes and a local bare remote. Git network
protocols are disabled, and teardown removes both successful and failed fixtures.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
from product_skills_fixture import configure_product_skills, assert_product_provenance
SKILLS = configure_product_skills(__file__, 5)
import cloud_closeout
import dev_plan
import dev_spec
import phase_state
import spec_closeout
import workflow
import workflow_transport as wt

# Reuse only the existing fixture builders, never their fake persistence clients.
fixture_spec = importlib.util.spec_from_file_location(
    "personal_cloud_spec_builders", Path(__file__).parent / "dev-spec/test_dev_spec.py")
fixtures = importlib.util.module_from_spec(fixture_spec)
fixture_spec.loader.exec_module(fixtures)
assert_product_provenance(SKILLS, "personal-cloud-imports")


@unittest.skipUnless(os.environ.get("DEV_WORKFLOW_CLOUD_NATIVE") == "1",
                     "Opt-in actual personal-cloud CLI/Git lifecycle")
class PersonalCloudNative(unittest.TestCase):
    def setUp(self):
        self.addCleanup(assert_product_provenance, SKILLS, self.id())
        self.assertIsNotNone(shutil.which("threadnote"), "Place the intended native/source CLI on PATH")
        self.assertIsNotNone(shutil.which("git"), "Native fixture requires Git")
        self.assertIsNotNone(shutil.which("rg"), "Workflow inspection requires ripgrep")
        self.temporary = tempfile.TemporaryDirectory(prefix="threadnote-personal-workflow-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.home = self.root / "data-home"
        self.user_home = self.root / "user-home"
        self.user_home.mkdir()
        # An allowlist prevents ambient credentials, cloud identities, Git settings,
        # model configuration, or user data roots from entering the child processes.
        environment = {key: os.environ[key] for key in
                       ("PATH", "PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR", "COMSPEC",
                        "DEV_WORKFLOW_INSTALLED_SKILLS", "DEV_WORKFLOW_PROVENANCE_DIR")
                       if key in os.environ}
        environment.update({
            "HOME": str(self.user_home), "USERPROFILE": str(self.user_home),
            "XDG_CONFIG_HOME": str(self.root / "xdg-config"),
            "XDG_CACHE_HOME": str(self.root / "xdg-cache"),
            "XDG_DATA_HOME": str(self.root / "xdg-data"),
            "APPDATA": str(self.root / "appdata"), "LOCALAPPDATA": str(self.root / "localappdata"),
            "CODEX_HOME": str(self.user_home / ".codex"), "THREADNOTE_HOME": str(self.home),
            "TMPDIR": str(self.root), "TEMP": str(self.root), "TMP": str(self.root),
            "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_TERMINAL_PROMPT": "0", "GIT_ALLOW_PROTOCOL": "file",
            "GIT_AUTHOR_NAME": "Native Workflow Fixture", "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
            "GIT_COMMITTER_NAME": "Native Workflow Fixture", "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
            "NO_COLOR": "1", "NO_UPDATE_NOTIFIER": "1", "THREADNOTE_NO_UPDATE_CHECK": "1",
            "THREADNOTE_AUTO_UPDATE": "off", "PYTHONDONTWRITEBYTECODE": "1",
        })
        self.environment = patch.dict(os.environ, environment, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.fixture = fixtures.Specs()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.repo = self.fixture.repo
        # A credential-free, never-contacted source identity avoids publishing a
        # machine-local checkout URL as a native code citation.
        self.fixture.git("remote", "add", "origin", "https://example.invalid/native-workflow/source.git")
        self.remote = self.root / "personal-memory.git"
        self.command("git", "init", "--bare", "--initial-branch=main", str(self.remote))
        seed = self.root / "seed"
        self.command("git", "clone", str(self.remote), str(seed))
        (seed / "README.md").write_text("# Isolated personal memory fixture\n", encoding="utf-8")
        self.command("git", "-C", str(seed), "add", "README.md")
        self.command("git", "-C", str(seed), "commit", "-m", "Seed fixture")
        self.command("git", "-C", str(seed), "push", "origin", "main")

    def command(self, *arguments, cwd=None, timeout=120):
        result = subprocess.run(arguments, cwd=cwd or self.root, text=True, encoding="utf-8",
                                capture_output=True, timeout=timeout)
        self.assertEqual(result.returncode, 0, "Command failed: " + repr(arguments) + "\n" + result.stdout + result.stderr)
        return result.stdout

    def cli(self, *arguments):
        return self.command("threadnote", *arguments, "--home", str(self.home), cwd=self.repo)

    def remote_git(self, *arguments):
        return self.command("git", "--git-dir", str(self.remote), *arguments).strip()

    def bootstrap(self, profile):
        agent = "codex" if profile == "codex-cloud-personal" else "cursor"
        self.cli("cloud", agent, "bootstrap", "--remote", str(self.remote), "--team", "personal")
        if agent == "cursor":
            os.environ["THREADNOTE_CURSOR_CLOUD_TEAM"] = "personal"
        self.cli("graph", "index", "--cwd", str(self.repo), "--no-vectors", "--json")
        options = {"workflow_profile": profile, "workflow_team": "personal",
                   "workflow_generation": wt.generation()}
        self.fixture.sc = dev_spec.Threadnote(str(self.repo), str(self.home), **options)
        self.fixture.pc = dev_plan.Threadnote(str(self.repo), str(self.home), **options)
        self.fixture.spec["observations"].append("PRIVATE_EXECUTION_MARKER " + str(self.fixture.directory))

    def implement_and_prepare(self, cycle):
        (self.repo / "src/expiry.py").write_text(
            "def expired(deadline, now):\n    return deadline is not None and now >= deadline\n", encoding="utf-8")
        (self.repo / "src/cache.py").write_text(
            "from .expiry import expired\n\ndef get(value, deadline=None, now=0):\n"
            "    return None if expired(deadline, now) else value\n", encoding="utf-8")
        (self.repo / "test_cache.py").write_text(
            "import unittest\nfrom src.cache import get\n\nclass Expiry(unittest.TestCase):\n"
            "    def test_deadline(self):\n        self.assertIsNone(get('value', 10, 10))\n"
            "    def test_future(self):\n        self.assertEqual(get('value', 10, 9), 'value')\n"
            "    def test_without_deadline(self):\n        self.assertEqual(get('value'), 'value')\n",
            encoding="utf-8")
        self.fixture.git("add", "src/cache.py", "src/expiry.py", "test_cache.py")
        self.fixture.git("commit", "-qm", "Implement and verify fixture expiry")
        self.command(sys.executable, "-B", "-m", "unittest", "test_cache", cwd=self.repo)
        self.cli("graph", "index", "--cwd", str(self.repo), "--no-vectors", "--json")
        # The pre-existing builder supplies the receipt shape. Replace its synthetic
        # evidence with the command and assertions actually exercised above.
        self.fixture.validate_cycle(cycle)
        for phase in cycle["phases"]:
            path = Path(phase["validationFile"])
            validation = dev_spec.read_json(path)
            validation["checks"] = [{"command": "python -B -m unittest test_cache", "result": "passed",
                                     "evidence": "Three fixture tests passed: equality, future deadline, no deadline."}]
            for item in validation["acceptance"]:
                item["evidence"] = "Actual fixture test_cache.Expiry.test_deadline passed; equality returns absence."
            dev_spec.write_json(path, validation)
            phase["validationHash"] = hashlib.sha256(path.read_bytes()).hexdigest()
        directory = self.fixture.directory / "native-cloud-completion"
        scope = dev_spec.inspect(self.repo, ["src/"])
        workflow.prepare(cycle, scope, directory, phase_state, dev_spec, self.fixture.pc, self.fixture.sc)
        implemented = dev_spec.read_json(directory / "implemented.json")
        implemented["codeRefs"] = ["src/cache.py", "src/expiry.py"]
        dev_spec.write_json(directory / "implemented.json", implemented)
        evidence = dev_spec.read_json(directory / "evidence.json")
        evidence["architectureVerification"] = "Cache reads call expired before returning a value; three fixture tests passed."
        dev_spec.write_json(directory / "evidence.json", evidence)
        evidence = dev_spec.read_json(directory / "spec-evidence.json")
        evidence.update(codeRefs=["src/cache.py", "src/expiry.py"],
                        behaviorVerification="The exact deadline returns absence; future and no-deadline values remain available.")
        dev_spec.write_json(directory / "spec-evidence.json", evidence)
        return directory

    def assert_drafts_active(self, roots, directory):
        for client, uri in roots:
            self.assertEqual(client.workflow.read(uri)["state"], "active")
        state = wt.read_json(cloud_closeout.state_path(directory))
        self.assertFalse(state["archives"], "Neither draft set may retire before the complete Git readback")
        self.assertNotIn("published", state)

    def publication_journal(self, binding_id):
        return wt.read_json(self.home / "workflow-memory" / (binding_id + ".publication.json"))

    def assert_private_data_absent(self, text, owned_uris):
        for value in (str(self.root), str(self.repo), str(self.home), str(self.fixture.directory),
                      "PRIVATE_EXECUTION_MARKER", "<!-- dev-plan:v1", "<!-- dev-spec:v1", "/memories/handoffs/"):
            self.assertNotIn(value, text)
            self.assertNotIn(json.dumps(value)[1:-1], text)
        for uri in owned_uris:
            self.assertNotIn(uri, text)
        self.assertNotRegex(text, r'"(?:scope|archiveMap|snapshotTree|receipts|pending|workflowContext)"\s*:')

    def exercise_personal_profile(self, profile):
        self.bootstrap(profile)
        remote_before = self.remote_git("rev-parse", "main")
        saved, plan, planned, cycle, _ = self.fixture.plan_cycle()
        self.assertEqual(self.remote_git("rev-parse", "main"), remote_before, "Private planning must not push Git")
        self.assertEqual(dev_spec.load(saved["rootUri"], self.fixture.sc)[0], self.fixture.spec)
        self.assertEqual(dev_plan.load_plan(planned["rootUri"], self.fixture.pc)[0], plan)
        self.assertEqual(cycle["spec"]["requirements"], plan["requirements"])
        context_path = Path(cycle["workflowContext"])
        original_context = wt.read_json(context_path)
        binding = original_context["binding"]
        self.assertEqual(binding["profile"], profile)
        self.assertEqual(wt.locator(self.fixture.sc), str(context_path))
        self.assertEqual(wt.locator(self.fixture.pc), str(context_path))
        native_journal = wt.read_json(self.home / "workflow-memory" / (binding["bindingId"] + ".json"))
        self.assertTrue(native_journal["artifacts"])
        # In cloud, the architecture baseline is private handoff storage despite its semantic role.
        baseline = self.fixture.pc.workflow.read(planned["artifacts"]["current"])
        self.assertEqual((baseline["storageKind"], baseline["role"]), ("handoff", "current"))
        directory = self.implement_and_prepare(cycle)
        preview = cloud_closeout.preview(cycle, directory, phase_state, dev_spec, spec_closeout,
                                         self.fixture.pc, self.fixture.sc)
        owned = wt.read_json(cloud_closeout.state_path(directory))["owned"]
        for node in preview["nodes"]:
            self.assert_private_data_absent(node["body"], owned)
        roots = [(self.fixture.sc, saved["rootUri"]), (self.fixture.pc, planned["rootUri"])]
        cloud_closeout.approve(cycle, directory, phase_state, self.fixture.pc, preview["approvalDigest"],
                               "reject", "Isolated fixture owner rejects this concrete preview.")
        with self.assertRaisesRegex(wt.WorkflowError, "unapproved|deferred"):
            self.fixture.finish(cycle, directory)
        self.assert_drafts_active(roots, directory)
        self.assertEqual(self.remote_git("rev-parse", "main"), remote_before)

        cloud_closeout.approve(cycle, directory, phase_state, self.fixture.pc, preview["approvalDigest"],
                               "approve", "Isolated fixture owner approves the exact digest and temporary personal Git destination.")
        # The configured destination itself is unavailable, independently of Git's
        # pre-receive policy. Preserve the exact approval/binding and both drafts.
        unavailable = self.remote.with_name("personal-memory-unavailable.git")
        self.remote.rename(unavailable)
        try:
            with self.assertRaises(wt.WorkflowError) as offline:
                self.fixture.finish(cycle, directory)
            self.assertEqual(offline.exception.code, "pending-publication")
            self.assert_drafts_active(roots, directory)
            offline_journal = self.publication_journal(binding["bindingId"])
            self.assertEqual(offline_journal["approvalDigest"], preview["approvalDigest"])
            self.assertEqual(wt.read_json(context_path)["binding"], binding)
        finally:
            unavailable.rename(self.remote)
        self.assertEqual(self.remote_git("rev-parse", "main"), remote_before)
        hook = self.remote / "hooks/pre-receive"
        hook.write_text("#!/bin/sh\necho 'native fixture push rejected' >&2\nexit 1\n", encoding="utf-8")
        hook.chmod(0o755)
        try:
            with self.assertRaises(wt.WorkflowError) as failed:
                self.fixture.finish(cycle, directory)
            self.assertEqual(failed.exception.code, "pending-publication")
            self.assertIn("pending", str(failed.exception).lower())
        finally:
            hook.unlink(missing_ok=True)
        self.assert_drafts_active(roots, directory)
        self.assertEqual(self.remote_git("rev-parse", "main"), remote_before)
        failed_journal = self.publication_journal(binding["bindingId"])
        self.assertEqual(failed_journal["intent"], offline_journal["intent"])
        self.assertEqual(failed_journal["approvalDigest"], preview["approvalDigest"])
        self.assertTrue(any(item.get("committed") for item in failed_journal["progress"].values()),
                        "The rejection must exercise a committed-but-unpushed native publication")

        # Reconstruct both Python clients from their persisted locator before retry:
        # recovery may not create a new binding, approval graph, or operation identity.
        options = {"workflow_context": str(context_path), "workflow_generation": binding["generation"]}
        self.fixture.sc = dev_spec.Threadnote(str(self.repo), str(self.home), **options)
        self.fixture.pc = dev_plan.Threadnote(str(self.repo), str(self.home), **options)
        complete = self.fixture.finish(cycle, directory)
        self.assertEqual(complete["status"], "complete")
        completed_journal = self.publication_journal(binding["bindingId"])
        self.assertEqual(completed_journal["intent"], failed_journal["intent"])
        self.assertEqual(completed_journal["approvalDigest"], preview["approvalDigest"])
        for key, progress in failed_journal["progress"].items():
            if "committed" in progress:
                receipt = completed_journal["progress"][key]["committed"]
                for field, value in progress["committed"].items():
                    self.assertEqual(receipt[field], value, "Retry must preserve the original local commit receipt")
                self.assertEqual(receipt["remoteCommit"], receipt["commit"])
                self.assertTrue(receipt["verified"])
        final_context = wt.read_json(context_path)
        self.assertEqual(final_context["binding"], binding)
        for key, operation in original_context["operations"].items():
            self.assertEqual(final_context["operations"][key]["request"]["operationId"], operation["request"]["operationId"])
        closed = wt.read_json(cloud_closeout.state_path(directory))
        self.assertEqual(set(closed["archives"]), set(owned))
        for client, uri in roots:
            self.assertEqual(client.workflow.read(closed["archives"][uri])["state"], "archived")

        files = self.remote_git("ls-tree", "-r", "--name-only", "main").splitlines()
        self.assertFalse(any("handoff" in name or "workflow-memory" in name for name in files))
        durable = [name for name in files if name.startswith("durable/") and name.endswith(".md")]
        self.assertEqual(len(durable), 2, "Only the verified architecture and behavior belong in the remote")
        contents = {name: self.remote_git("show", "main:" + name) for name in files}
        all_content = "\n".join(contents.values())
        self.assert_private_data_absent(all_content, owned)
        self.assertIn("R1", all_content)
        self.assertIn("src/expiry.py", all_content)
        for name in durable:
            citations = [json.loads(line.split(": ", 1)[1]) for line in contents[name].splitlines()
                         if line.startswith("code_citation: ")]
            self.assertEqual({item["path"] for item in citations}, {"src/cache.py", "src/expiry.py"})
            self.assertTrue(all(item["sourceCommit"] == self.fixture.git("rev-parse", "HEAD")
                                and not item["sourceDirty"] for item in citations))
        for uri in (complete["implementedArchitectureUri"], complete["verifiedSpecUri"]):
            observed = self.fixture.pc.workflow.read(uri)
            self.assertEqual((observed["state"], observed["storageKind"]), ("active", "durable"))
        final_head = self.remote_git("rev-parse", "main")
        self.assertNotEqual(final_head, remote_before)
        self.assertEqual(self.fixture.finish(cycle, directory), complete)
        self.assertEqual(self.remote_git("rev-parse", "main"), final_head, "Idempotent closeout must not add commits")

    def test_codex_personal_full_workflow_denial_push_rejection_and_recovery(self):
        self.exercise_personal_profile("codex-cloud-personal")

    def test_cursor_personal_full_workflow_denial_push_rejection_and_recovery(self):
        self.exercise_personal_profile("cursor-cloud-personal")


if __name__ == "__main__":
    unittest.main()

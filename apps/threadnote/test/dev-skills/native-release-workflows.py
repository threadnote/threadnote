"""Extracted executable lifecycle acceptance controlled by host Python.

Every product invocation uses the explicit executable and supplied environment.
The caller supplies a PATH with interpreter deny stubs; this module never adds
Python, Node or Bun to that PATH. Personal profiles use actual bootstrap and
publication commands against isolated local bare Git, not live provider APIs.
"""

import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path


def run_workflows(root, binary, environment, generation):
    """Run desktop and both Personal Cloud profiles and return bounded evidence."""
    root = Path(root).resolve()
    binary = Path(binary).resolve()
    assert binary.is_file(), binary
    assert isinstance(generation, str) and generation
    root.mkdir(parents=True, exist_ok=True)
    listed = subprocess.run([str(binary), "dev-skills", "list", "--json"], cwd=root, env=environment,
                            text=True, capture_output=True, timeout=120)
    assert listed.returncode == 0, listed.stderr
    surfaces = {item["profile"]: item for item in json.loads(listed.stdout)["surfaces"]
                if item.get("profile") in ["codex-cloud-personal", "cursor-cloud-personal"]}
    assert set(surfaces) == {"codex-cloud-personal", "cursor-cloud-personal"}, surfaces
    profiles = ["desktop"] + [name for name, surface in surfaces.items() if sys.platform in surface["platforms"]]
    results = [_run_profile(root / profile, binary, environment, generation, profile) for profile in profiles]
    rejected = []
    for name, surface in surfaces.items():
        if sys.platform not in surface["platforms"]:
            host = "codex" if name == "codex-cloud-personal" else "cursor"
            probe = subprocess.run([str(binary), "cloud", host, "bootstrap", "--remote", str(root / "unsupported.git"),
                                    "--team", "default", "--user", "release-fixture", "--agent-id", "release-fixture"],
                                   cwd=root, env=environment, text=True, capture_output=True, timeout=30)
            assert probe.returncode != 0 and "no native workflow target on" in probe.stderr, probe.stdout + probe.stderr
            rejected.append(name)
    return {"status": "passed", "profiles": results, "operations": sum(item["operations"] for item in results),
            "unsupportedHostProfilesRejected": rejected, "personalCloudHost": "catalog-declared native platforms", "liveProviderAcceptance": False}


def _run_profile(fixture, binary, environment, generation, profile):
    assert not fixture.exists(), "Use a fresh extracted native workflow fixture"
    fixture.mkdir(parents=True)
    cli = [str(binary)]
    home = fixture / "home"
    repo = fixture / "repo"
    home.mkdir(parents=True)
    repo.mkdir()
    environment = dict(environment)
    environment["THREADNOTE_HOME"] = str(home)
    environment["THREADNOTE_USER"] = "release-fixture"
    environment["THREADNOTE_AGENT_ID"] = "release-fixture"
    environment["THREADNOTE_CURSOR_CLOUD_TEAM"] = "default"
    # The product's actual Git commits use only synthetic fixture identity.
    environment["GIT_AUTHOR_NAME"] = "Release Workflow Fixture"
    environment["GIT_AUTHOR_EMAIL"] = "fixture@example.invalid"
    environment["GIT_COMMITTER_NAME"] = "Release Workflow Fixture"
    environment["GIT_COMMITTER_EMAIL"] = "fixture@example.invalid"
    (repo / "source.ts").write_text("export const completeRead = (value: string) => value;\n", encoding="utf-8")
    for args in [
        ["init", "--initial-branch=main"],
        ["config", "user.email", "fixture@example.invalid"],
        ["config", "user.name", "Private Closeout Fixture"],
        ["add", "source.ts"],
        ["commit", "-m", "Private closeout source"],
    ]:
        subprocess.run(["git", *args], cwd=repo, env=environment, check=True, capture_output=True, text=True, timeout=60)

    run_id = "closeout-smoke"
    common = {"protocolVersion": 1, "executorVersion": 1, "runId": run_id, "generation": generation}
    records = []

    def call(request, expected_code=None):
        process = subprocess.run(
            [*cli, "workflow-automation", "--home", str(home)],
            input=json.dumps(request),
            cwd=repo,
            env=environment,
            text=True,
            capture_output=True,
            timeout=180,
        )
        try:
            value = json.loads(process.stdout)
        except json.JSONDecodeError as error:
            raise RuntimeError(f"CLI returned non-JSON output for {request.get('action')}.") from error
        records.append(
            {
                "action": request.get("action"),
                "command": request.get("command"),
                "returncode": process.returncode,
                "status": value.get("status") if isinstance(value, dict) else None,
                "code": value.get("code") if isinstance(value, dict) else None,
            }
        )
        (fixture / "receipts.json").write_text(json.dumps(records, indent=2) + "\n", encoding="utf-8")
        if expected_code is not None:
            assert process.returncode != 0 and value.get("code") == expected_code, value
            return value
        if process.returncode != 0 or not isinstance(value, dict) or value.get("status") != "ok":
            raise RuntimeError(f"CLI request failed: {json.dumps(value, sort_keys=True)}\n{process.stderr[-2000:]}")
        return value


    def git(*args):
        return subprocess.run(["git", *args], cwd=repo, env=environment, check=True, capture_output=True, text=True, timeout=60).stdout.strip()


    def author(command, **values):
        return call({**common, "action": "authoring", "command": command, **values})["authoring"]


    def cycle(command, **values):
        return call({**common, "action": "cycle", "command": command, **values})["cycle"]


    def mutate_cycle(command, **values):
        revision = cycle("inspect")["revision"]
        return cycle(command, expectedRevision=revision, **values)


    def read_artifact(uri):
        result = call({**common, "action": "read", "uri": uri})
        artifact = result["artifact"]
        assert artifact["uri"] == uri, artifact
        return artifact


    def structured_document(artifact):
        body = artifact["body"]
        marker = "\n<!-- threadnote-authoring:v1 "
        start = body.rfind(marker)
        end = body.rfind(" -->\n")
        assert start >= 0 and end > start, "Expected complete structured native document readback"
        return json.loads(body[start + len(marker) : end])


    remote = None
    if profile != "desktop":
        # Local bare Git exercises actual bootstrap/publish, never a live provider.
        remote = fixture / "remote.git"
        seed = fixture / "seed"
        for args, cwd in [
            (["init", "--bare", "--initial-branch=main", str(remote)], fixture),
            (["clone", str(remote), str(seed)], fixture),
            (["config", "user.email", "fixture@example.invalid"], seed),
            (["config", "user.name", "Release Workflow Fixture"], seed),
        ]:
            subprocess.run(["git", *args], cwd=cwd, env=environment, check=True, capture_output=True, text=True, timeout=60)
        (seed / "README.md").write_text("Private local share fixture.\n", encoding="utf-8")
        for args in [["add", "README.md"], ["commit", "-m", "Seed isolated share"], ["push", "origin", "main"]]:
            subprocess.run(["git", *args], cwd=seed, env=environment, check=True, capture_output=True, text=True, timeout=60)
        git("remote", "add", "origin", "https://github.com/fixture/native-release.git")
        provider = "codex" if profile == "codex-cloud-personal" else "cursor"
        bootstrap = subprocess.run([*cli, "--home", str(home), "cloud", provider, "bootstrap", "--remote", str(remote), "--team", "default", "--user", "release-fixture", "--agent-id", "release-fixture"], cwd=repo, env=environment, text=True, capture_output=True, timeout=180)
        assert bootstrap.returncode == 0, bootstrap.stderr[-4000:] + bootstrap.stdout[-4000:]
        profile_path = home / (provider + "-cloud") / "profile.json"
        identity = json.loads(profile_path.read_text(encoding="utf-8"))
        assert identity["provider"] == provider + "-cloud" and identity["user"] == "release-fixture", identity

    plan = {
        "format": "threadnote-native-authoring",
        "schemaVersion": 1,
        "kind": "plan",
        "id": "private-closeout-feature",
        "project": "private-closeout-smoke",
        "title": "Private Native Closeout Smoke",
        "objective": "Retain complete verified behavior and original decision rationale.",
        "requirements": [{"id": "complete-read", "behavior": "The reader returns every stored field."}],
        "context": {
            "codeRefs": ["source.ts"],
            "evidenceRefs": [],
            "note": "Synthetic private smoke fixture; no external or production claims.",
        },
        "source": {
            "head": git("rev-parse", "HEAD"),
            "files": [{"path": "source.ts", "sha256": hashlib.sha256((repo / "source.ts").read_bytes()).hexdigest()}],
        },
        "current": {
            "summary": "A reader uses the existing store.",
            "components": ["Reader", "Store"],
            "contracts": ["Stored values remain complete."],
            "diagram": "flowchart TD\n  Reader --> Store",
        },
        "target": {
            "summary": "The reader returns complete records.",
            "components": ["Reader", "Store"],
            "contracts": ["No field is silently omitted."],
            "diagram": "flowchart TD\n  Reader --> Store",
        },
        "phases": [
            {
                "id": "verify-read",
                "title": "Verify complete reads",
                "outcome": "The local reader preserves the complete value.",
                "dependsOn": [],
                "affectedPaths": ["source.ts"],
                "newPaths": [],
                "contracts": ["Return every stored field."],
                "acceptance": [
                    {
                        "id": "complete-read-check",
                        "criterion": "The committed reader source is present and the local check passes.",
                        "verification": "Read the exact source file and run git diff --check.",
                        "requirementIds": ["complete-read"],
                    }
                ],
                "safeBoundary": "Private local fixture only; no merge or publication.",
            }
        ],
        "decisions": [
            {
                "id": "retain-store",
                "question": "Should the existing store be retained?",
                "selection": "retain",
                "selected": "Retain the existing store and its complete-record behavior.",
                "alternatives": [
                    {
                        "id": "replace-store",
                        "design": "Replace the current store.",
                        "tradeoffs": "Adds migration risk without improving the verified behavior.",
                    }
                ],
                "rationale": "The current store already preserves complete values; retaining it avoids a needless migration while meeting the approved behavior.",
                "affectedPhases": ["verify-read"],
                "authority": "orchestrator",
            },
            {
                "id": "reject-partial-read",
                "question": "Should the reader return partial records?",
                "selection": "adapt",
                "selected": "Return the complete record and reject partial-read behavior.",
                "alternatives": [
                    {
                        "id": "partial-record",
                        "design": "Return only the fields available in the first response.",
                        "tradeoffs": "Hides missing data and weakens the complete-read requirement.",
                    }
                ],
                "rationale": "The partial-record alternative was rejected because missing fields would be silent data loss; the reader must preserve the full stored value.",
                "affectedPhases": ["verify-read"],
                "authority": "orchestrator",
            },
        ],
        "openQuestions": [],
        "review": {"required": False, "reason": "Synthetic CLI smoke data; not a product approval."},
    }
    actual_decisions = {
        "retain-store": {
            "implemented": "Kept the existing complete-record storage behavior.",
            "rationale": "The local source preserves the existing store contract and returns the full value.",
        },
        "reject-partial-read": {
            "implemented": "Returned complete records; partial-read behavior remained rejected.",
            "rationale": "The local reader returns the whole value and does not introduce a partial response path.",
        },
    }

    call({**common, "action": "init", "project": plan["project"], "featureId": plan["id"], "title": plan["title"], "profile": profile, **({"team": "default"} if profile != "desktop" else {})})
    call({**common, "action": "graph-ready"})
    # Real native confirmation and immutable spec export bind plan acceptance.
    spec = {key: plan[key] for key in ["format", "schemaVersion", "id", "project", "title", "objective", "requirements", "context", "source", "review"]}
    spec.update({"kind": "spec", "actors": ["Reader"], "inScope": ["Read complete stored values."], "outOfScope": [], "constraints": [], "observations": [], "scenarios": [{"id": "complete-read-scenario", "requirementIds": ["complete-read"], "given": "A complete stored value.", "when": "The reader requests the value.", "then": "Every stored field is returned."}], "assumptions": [], "questions": [], "artifacts": []})
    acceptance = author("acceptance-packet", document=spec, detail="document")
    assert acceptance["document"] == spec
    confirmation = author("confirm", document=spec, userDecision="approve", userResponse="Approve only this synthetic isolated complete-read fixture.")["confirmation"]
    assert confirmation["intentHash"] == acceptance["intentHash"]
    saved_spec = author("save", document=spec, ready=True, expectedRevision=None, confirmation=confirmation)
    assert saved_spec["readiness"] == "ready"
    spec_packet = author("export-plan", uri=saved_spec["root"]["uri"])
    assert spec_packet["spec"]["root"] == saved_spec["root"]
    assert spec_packet["spec"]["binding"]["profile"] == profile
    plan["phases"][0]["acceptance"][0]["scenarioIds"] = ["complete-read-scenario"]
    linked = author("from-spec", packet=spec_packet, document=plan)
    plan = linked["document"]
    assert plan["spec"] == spec_packet["spec"]
    authoring_validation = author("validate", document=plan, ready=True)
    if not authoring_validation["ready"]:
        raise RuntimeError("Plan validation issues: " + json.dumps(authoring_validation["issues"], sort_keys=True))
    saved = author("save", document=plan, ready=True, expectedRevision=None)
    assert saved["readiness"] == "ready"
    plan_root_uri = saved["root"]["uri"]
    exported = author(
        "export-dev-cycle",
        uri=plan_root_uri,
        delivery="local",
        bindings={"verify-read": {"branch": "fixture/closeout-local", "baseBranch": "main"}},
    )
    assert exported["phases"][0]["acceptanceRefs"][0]["requirements"] == ["complete-read"]
    assert exported["phases"][0]["acceptanceRefs"][0]["specScenarios"] == ["complete-read-scenario"]

    unrelated_response = call(
        {
            **common,
            "action": "write",
            "operationId": "private-unrelated-evidence",
            "artifactKey": "private-unrelated-evidence",
            "role": "evidence",
            "nameHint": "unrelated",
            "body": "Unrelated private evidence remains active after closeout.\n",
            "expectedRevision": None,
            "storageKind": "durable" if profile == "desktop" else "handoff",
            "codeRefs": [],
            "relations": [],
        }
    )
    unrelated_uri = unrelated_response["artifact"]["uri"]
    git("checkout", "-b", "fixture/closeout-local")
    assert mutate_cycle("init", plan=exported)["next"] == {"action": "implement", "phaseId": "verify-read"}
    snapshot = mutate_cycle("snapshot", phaseId="verify-read", snapshotId="verify-read-1")["snapshot"]["snapshot"]
    review = {
        "snapshotId": snapshot["snapshotId"],
        "phaseHash": snapshot["phaseHash"],
        "snapshotTree": snapshot["tree"],
        "status": "complete",
        "mode": "full",
        "selected": ["orchestrator"],
        "lanes": [{"name": "orchestrator", "status": "complete"}],
        "findings": [],
    }
    mutate_cycle("validate-review", snapshotId=snapshot["snapshotId"], attemptId="verify-read-review-1", report=review)
    source_bytes = (repo / "source.ts").read_bytes()
    assert b"completeRead" in source_bytes and b"=> value" in source_bytes
    check = subprocess.run(["git", "diff", "--check"], cwd=repo, env=environment, capture_output=True, text=True, timeout=60)
    assert check.returncode == 0, check.stderr
    validation = {
        "snapshotTree": snapshot["tree"],
        "reviewTree": snapshot["tree"],
        "status": "passed",
        "productState": "working",
        "checks": [
            {
                "command": "git diff --check",
                "result": "passed",
                "evidence": "The real private fixture repository returned zero from git diff --check.",
            }
        ],
        "acceptance": [
            {
                "criterion": plan["phases"][0]["acceptance"][0]["criterion"],
                "result": "passed",
                "evidence": "Read the committed source.ts bytes and confirmed the completeRead identity implementation is present.",
            }
        ],
    }
    ready = mutate_cycle("ready", phaseId="verify-read", snapshotId=snapshot["snapshotId"], validation=validation)
    assert ready["next"] == {"action": "complete"}, ready
    assert len(cycle("closeout-packet")["phases"]) == 1

    validation_input = call({**common, "action": "closeout", "command": "validation-input"})
    proposal = {
        "architecture": {
            "summary": "The implemented reader returns the complete local value.",
            "components": ["Reader", "Store"],
            "contracts": ["Return every stored field."],
            "diagram": "flowchart TD\n  Reader --> Store",
            "invariants": ["A complete value is never silently truncated."],
            "unknowns": ["This private smoke does not measure production scale."],
            "deviations": [],
            "codeRefs": ["source.ts"],
        },
        "architectureVerification": "Inspected the committed source.ts and verified the actual local cycle acceptance.",
        "behaviorVerification": "Verified the complete saved spec and plan readback, linked acceptance scenario, committed completeRead source and successful local cycle checks.",
        "combinedChecks": [
            {
                "command": "git diff --check",
                "result": "passed",
                "evidence": "The real private fixture repository returned zero from git diff --check.",
            }
        ],
        "phaseEvidence": [
            {
                "id": phase["id"],
                "acceptance": [
                    {"criterion": item, "evidence": "Verified against committed source.ts and the local cycle receipt."}
                    for item in phase["acceptanceCriteria"]
                ],
            }
            for phase in validation_input["phases"]
        ],
        "scenarios": [{"id": item["id"], "evidence": "Read complete committed source and verified every stored field is returned."} for item in validation_input["scenarios"]],
        "decisions": [
            {"id": item["id"], **actual_decisions[item["id"]]} for item in plan["decisions"]
        ],
    }
    prepared = call({**common, "action": "closeout", "command": "prepare", "proposal": proposal})
    assert prepared["closeout"]["owned"] > 0

    before_closeout_inspect = call({**common, "action": "inspect"})
    owned_uris = sorted(
        {
            operation["uri"]
            for operation in before_closeout_inspect["operations"]
            if operation.get("uri") and operation.get("operationId", "").startswith("author-")
        }
    )
    assert owned_uris and unrelated_uri not in owned_uris
    owned_memory_ids = {
        operation["uri"]: operation["memoryId"]
        for operation in before_closeout_inspect["operations"]
        if operation.get("uri") in owned_uris
    }
    assert set(owned_memory_ids) == set(owned_uris)
    if profile == "desktop":
        finished = call({**common, "action": "closeout", "command": "finish"})
        closeout_summary = finished["closeout"]
        assert closeout_summary["state"] == "complete"
        assert closeout_summary["owned"] == len(owned_uris)
        assert closeout_summary["archived"] == len(owned_uris)
        assert read_artifact(unrelated_uri)["state"] == "active"

        outputs = {item["key"]: item for item in closeout_summary["outputs"]}
        architecture_ref = outputs["architecture"]
        decision_index_ref = outputs["decisions-0"]
        architecture_artifact = read_artifact(architecture_ref["uri"])
        assert decision_index_ref["uri"] in architecture_artifact["body"]
        decision_index = read_artifact(decision_index_ref["uri"])
        decision_index_document = structured_document(decision_index)
        decision_entries = next(section["body"] for section in decision_index_document["sections"] if section["id"] == "entries")
        decision_uris = re.findall(r"(?m)^-\s*(threadnote://\S+)$", decision_entries)
        assert len(decision_uris) == len(plan["decisions"]), decision_uris
        decision_documents = [read_artifact(uri)["body"] for uri in decision_uris]

        history_uris = {outputs["history-0"]["uri"]}
        seen_history_uris = set()
        archive_destinations = {}
        while history_uris:
            history_uri = history_uris.pop()
            if history_uri in seen_history_uris:
                continue
            seen_history_uris.add(history_uri)
            history_artifact = read_artifact(history_uri)
            history_document = structured_document(history_artifact)
            history_entries = next(section["body"] for section in history_document["sections"] if section["id"] == "entries")
            for line in history_entries.splitlines():
                if line.startswith("{"):
                    item = json.loads(line)
                    archive_destinations[item["source"]] = item["archive"]
                elif line.startswith("Next: threadnote://"):
                    history_uris.add(line.removeprefix("Next: ").strip())
        assert set(archive_destinations) == set(owned_uris)
        assert len(set(archive_destinations.values())) == len(owned_uris)
        for source_uri in owned_uris:
            archived = read_artifact(archive_destinations[source_uri])
            assert archived["state"] == "archived"
            assert archived["memoryId"] == owned_memory_ids[source_uri]
    else:
        publication = call({**common, "action": "closeout", "command": "publication-preview"})["publication"]
        assert sorted(node["key"] for node in publication["nodes"]) == ["architecture", "spec"]
        call({**common, "action": "closeout", "command": "publication-approve", "approvalDigest": "0" * 64, "decision": "approve", "approvalEvidence": "Synthetic wrong-digest rejection fixture."}, expected_code="publication-approval-changed")
        for uri in owned_uris:
            assert read_artifact(uri)["state"] == "active"
        call({**common, "action": "closeout", "command": "publication-approve", "approvalDigest": publication["approvalDigest"], "decision": "approve", "approvalEvidence": "Explicit fixture authority approves this exact isolated local bare Git publication graph."})
        closeout_summary = call({**common, "action": "closeout", "command": "finish"})["closeout"]
        assert closeout_summary["state"] == "complete"
        assert closeout_summary["owned"] == closeout_summary["archived"] == len(owned_uris)
        assert read_artifact(unrelated_uri)["state"] == "active"
        remote_bodies = {}
        for node in publication["nodes"]:
            relative = node["canonicalUri"].split("/shared/default/", 1)[1]
            raw = subprocess.run(["git", "-C", str(remote), "show", "main:" + relative], env=environment, check=True, capture_output=True, text=True, timeout=60).stdout
            parsed = subprocess.run(["memory-read", node["canonicalUri"]], input=raw, env=environment,
                                    check=True, capture_output=True, text=True, timeout=30)
            durable_body = json.loads(parsed.stdout)["body"].strip() + "\n"
            assert hashlib.sha256(durable_body.encode()).hexdigest() == node["bodySha256"]
            assert durable_body == node["body"].strip() + "\n"
            for forbidden in [str(fixture), str(home), ".context", ".closeout.json", *owned_uris]:
                assert forbidden not in raw, forbidden
            remote_bodies[node["key"]] = durable_body
        assert spec["scenarios"][0]["given"] in remote_bodies["spec"]
        decision_documents = [remote_bodies["architecture"]]
        receipt = json.loads((home / "workflow-automations" / "native-v1" / f"{run_id}.json.closeout.json").read_text(encoding="utf-8"))
        assert set(receipt["archives"]) == set(owned_uris)
        assert len({item["uri"] for item in receipt["archives"].values()}) == len(owned_uris)
        for uri in owned_uris:
            archived = read_artifact(receipt["archives"][uri]["uri"])
            assert archived["state"] == "archived"
            assert archived["memoryId"] == owned_memory_ids[uri] == receipt["archives"][uri]["memoryId"]
        remote_head = subprocess.run(["git", "-C", str(remote), "rev-parse", "main"], env=environment, check=True, capture_output=True, text=True, timeout=60).stdout.strip()

    for planned in plan["decisions"]:
        actual = actual_decisions[planned["id"]]
        matching = [body for body in decision_documents if planned["id"] in body]
        assert len(matching) == 1, planned["id"]
        body = matching[0]
        assert planned["selected"] in body
        assert planned["rationale"] in body
        assert actual["implemented"] in body
        assert actual["rationale"] in body
        for alternative in planned["alternatives"]:
            assert alternative["design"] in body and alternative["tradeoffs"] in body

    receipt_path = home / "workflow-automations" / "native-v1" / f"{run_id}.json.closeout.json"
    receipt_bytes = receipt_path.read_bytes()
    inspected = call({**common, "action": "closeout", "command": "inspect"})
    assert inspected["closeout"]["state"] == "complete"
    replayed = call({**common, "action": "closeout", "command": "finish"})
    assert replayed["closeout"]["state"] == "complete"
    assert receipt_path.read_bytes() == receipt_bytes
    if remote is not None:
        replay_head = subprocess.run(["git", "-C", str(remote), "rev-parse", "main"], env=environment, check=True, capture_output=True, text=True, timeout=60).stdout.strip()
        assert replay_head == remote_head

    summary = {
        "status": "passed",
        "operations": len(records),
        "fixture": str(fixture),
        "privateHome": str(home),
        "ownedDraftsArchived": len(owned_uris),
        "unrelatedArtifactPreserved": True,
        "completeDecisionReadback": len(plan["decisions"]),
        "profile": profile,
        "specConfirmationAndBinding": True,
        "profileBootstrap": "not-applicable" if remote is None else "actual-cli",
        "remoteReplayHeadUnchanged": remote is not None,
        "publicationBackend": "private-local" if remote is None else "local-bare-git",
        "liveProviderAcceptance": False,
        "finishReplayReceiptBytesUnchanged": True,
        "sourceSha256": hashlib.sha256(source_bytes).hexdigest(),
    }
    (fixture / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    return summary

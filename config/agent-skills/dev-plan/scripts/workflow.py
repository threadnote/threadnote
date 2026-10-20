#!/usr/bin/env python3
"""Connect dev-cycle verification to dev-plan and dev-spec knowledge closeout."""
import sys
sys.dont_write_bytecode = True
import workflow_transport as wt
from portable_lock import lock_exclusive

import argparse
import hashlib
import importlib
import json
from pathlib import Path
import subprocess

import dev_plan as dp
import closeout as architecture_closeout


def modules(cycle_scripts, spec_scripts):
    for directory, required in ((cycle_scripts, "phase_state.py"), (spec_scripts, "dev_spec.py")):
        dp.require(Path(directory).is_absolute() and (Path(directory) / required).is_file(),
                   "Pass the actual installed satellite directory: " + required)
        sys.path.insert(0, str(directory))
    return importlib.import_module("phase_state"), importlib.import_module("dev_spec"), importlib.import_module("spec_closeout")


def evidence_from_cycle(cycle, phase_state):
    phase_state.validate_plan(cycle)
    fingerprint = phase_state.definition_hash(cycle)
    result = {}
    for phase in cycle["phases"]:
        dp.require(phase.get("status") in phase_state.READY, "An implementation phase is not validated")
        path = Path(phase.get("validationFile", ""))
        dp.require(path.is_file(), "Phase has no saved validation evidence; run phase_state ready")
        dp.require(hashlib.sha256(path.read_bytes()).hexdigest() == phase.get("validationHash")
                   and phase.get("validationPlanHash") == fingerprint, "Validation evidence or plan revision changed")
        validation = dp.read_json(path)
        phase_state.check_validation(phase, phase["validatedTree"], validation)
        result[phase["id"]] = validation
    return result


def final_criteria(cycle):
    if cycle.get("spec"):
        return list(dict.fromkeys("Given " + s["given"] + "; when " + s["when"] + "; then " + s["then"]
                                  for s in cycle["spec"]["scenarios"]))
    return list(dict.fromkeys(c for phase in cycle["phases"] for c in phase["acceptanceCriteria"]))


def validation_input(cycle, scope, phase_state):
    evidence_from_cycle(cycle, phase_state)
    dp.fresh({"scope": scope})
    tree = importlib.import_module("dev_cycle").capture(Path(scope["repo"]))
    criteria = final_criteria(cycle)
    return {"snapshotTree": tree, "planHash": phase_state.definition_hash(cycle), "status": "pending",
            "productState": "unverified", "checks": [],
            "acceptance": [{"criterion": c, "result": "pending", "evidence": ""} for c in criteria]}


def current_validation(cycle, scope, phase_state, validations, combined=None):
    """Require passing acceptance for the actual combined working tree, not old phase trees."""
    source_tree = importlib.import_module("dev_cycle").capture(Path(scope["repo"]))
    criteria = final_criteria(cycle)
    if combined is not None:
        dp.require(combined.get("planHash") == phase_state.definition_hash(cycle), "Combined validation targets another plan revision")
        candidates = [combined]
    else:
        candidates = validations.values()
    for candidate in candidates:
        if candidate.get("snapshotTree") != source_tree or not set(criteria) <= {a.get("criterion") for a in candidate.get("acceptance", [])}:
            continue
        selected = {**candidate, "acceptance": [a for a in candidate["acceptance"] if a["criterion"] in criteria]}
        phase_state.check_validation({"acceptanceCriteria": criteria}, source_tree, selected)
        return {**selected, "planHash": phase_state.definition_hash(cycle)}
    raise dp.PlanError("Final source has no passing combined validation. Run all feature acceptance checks on the current snapshot and pass --validation FILE.")


def prepare(cycle, scope, directory, phase_state, spec_module, plan_client, spec_client, combined=None):
    validations = evidence_from_cycle(cycle, phase_state)
    dp.fresh({"scope": scope})
    final_validation = current_validation(cycle, scope, phase_state, validations, combined)
    accepted = {a["criterion"]: a["evidence"] for a in final_validation["acceptance"]}
    root_uri = cycle.get("completion", {}).get("rootUri")
    dp.require(root_uri, "Use dev-plan export-dev-cycle before workflow closeout")
    for uri in cycle.get("planMemoryUris", []):
        dp.require(plan_client.is_active(uri) and dp.pin(plan_client, uri)["sha256"] == cycle["memoryHashes"].get(uri),
                   "Authoritative plan changed since implementation validation")
    plan, root = dp.load_plan(root_uri, plan_client)
    dp.require(plan["id"] == cycle.get("featureId"), "Feature identity mismatch")
    dp.require(plan.get("spec") == cycle.get("spec"), "Implementation input differs from the authoritative spec handoff")
    dp.require(set(validations) == {p["id"] for p in plan["phases"]}, "Phase map differs from authoritative plan")
    result = dp.closeout_input(root_uri, scope, plan_client, directory)
    path = Path(directory)
    evidence = dp.read_json(path / "evidence.json")
    evidence["combinedValidation"] = final_validation
    for phase in evidence["phases"]:
        phase_results = {a["criterion"]: a["evidence"] for a in validations[phase["id"]]["acceptance"]}
        original = next(p for p in plan["phases"] if p["id"] == phase["id"])
        phase["status"] = "complete"
        phase["validatedTree"] = validations[phase["id"]]["snapshotTree"]
        for item in phase["acceptance"]:
            criterion = next(a["criterion"] for a in original["acceptance"] if a["id"] == item["id"])
            dp.require(criterion in phase_results, "Acceptance differs from the saved development plan")
            item["evidence"] = phase_results[criterion]
    dp.write_json(path / "evidence.json", evidence)
    if cycle.get("spec"):
        upstream = cycle["spec"]
        spec, spec_root = spec_module.load(upstream["rootUri"], spec_client)
        dp.require(spec_root["data"]["specHash"] == upstream["revision"], "Spec revision differs from implementation input")
        observed = {}
        for phase in cycle["phases"]:
            for item in phase["acceptanceRefs"]:
                for sid in item["specScenarios"]:
                    observed.setdefault(sid, []).append(accepted[item["criterion"]])
        spec_evidence = {"specRevision": upstream["revision"], "scope": scope, "codeRefs": [],
                         "architectureUri": "", "behaviorVerification": "", "unresolvedDeviations": [],
                         "scenarios": [{"id": s["id"], "result": "passed", "evidence": "\n".join(observed[s["id"]])}
                                       for s in spec["scenarios"]]}
        dp.write_json(path / "spec-evidence.json", spec_evidence)
    dp.write_json(path / "combined-validation.json", final_validation)
    dp.write_json(path / "workflow.json", {"cycleHash": phase_state.definition_hash(cycle), "rootUri": root_uri,
                                           "validationHash": dp.digest(final_validation),
                                           "featureId": plan["id"], "specRootUri": cycle.get("spec", {}).get("rootUri")})
    return {**result, "next": "Inspect final combined behavior; fill architectureVerification, actual codeRefs and spec behaviorVerification."}


def finish(cycle, directory, phase_state, spec_module, spec_closeout, plan_client, spec_client, recover_uri=None):
    if getattr(plan_client, "workflow", None) is not None and plan_client.workflow.cloud:
        from cloud_closeout import finish as finish_cloud
        return finish_cloud(cycle, directory, phase_state, plan_client, spec_client)
    wt.block_cloud_finish(plan_client)
    wt.block_cloud_finish(spec_client)
    directory = Path(directory)
    definition = dp.read_json(directory / "workflow.json")
    dp.require(definition["cycleHash"] == phase_state.definition_hash(cycle), "Implementation plan changed after closeout preparation")
    validations = evidence_from_cycle(cycle, phase_state)
    implemented = dp.read_json(directory / "implemented.json")
    evidence = dp.read_json(directory / "evidence.json")
    dp.fresh({"scope": implemented["scope"]})
    combined = dp.read_json(directory / "combined-validation.json")
    dp.require(dp.digest(combined) == definition["validationHash"], "Combined verification changed after closeout preparation")
    current_validation(cycle, implemented["scope"], phase_state, validations, combined)
    path = directory / "workflow-receipts.json"
    spec_evidence = dp.read_json(directory / "spec-evidence.json") if definition["specRootUri"] else None
    input_hash = dp.digest([definition, implemented, evidence, spec_evidence])
    # The child transactions use their own locks; this lock covers the cross-skill sequence.
    with open(str(path) + ".lock", "a+b") as lock:
        try:
            lock_exclusive(lock, blocking=False)
        except BlockingIOError:
            raise dp.PlanError("Another workflow closeout owns these receipts")
        state = dp.read_json(path) if path.exists() else {"inputHash": input_hash}
        dp.require(state["inputHash"] == input_hash, "Closeout inputs changed; reconcile the existing transaction")
        if state.get("status") == "complete":
            cycle["knowledgeCloseout"] = state["result"]
            return state["result"]
        if "architecture" not in state:
            if spec_evidence is not None:
                spec, root = spec_module.load(definition["specRootUri"], spec_client)
                dp.require(spec_evidence["scope"] == implemented["scope"], "Spec and architecture must describe the same final source")
                spec_closeout.check(spec, root["data"]["specHash"], spec_evidence, spec_client, verify_architecture=False)
            state["architecture"] = architecture_closeout.complete(definition["rootUri"], implemented, evidence,
                directory / "architecture-receipts.json", plan_client, recover_uri)
            dp.write_json(path, state)
        if spec_evidence is not None:
            actual = dict(spec_evidence)
            actual["architectureUri"] = state["architecture"]["implementedUri"]
            actual["contextArchiveMap"] = state["architecture"]["archiveMap"]
            if "specification" not in state:
                state["specification"] = spec_closeout.complete(definition["specRootUri"], actual,
                    directory / "spec-receipts.json", spec_client, recover_uri)
                dp.write_json(path, state)
            # Repair references to the now-retired approved spec with active verified knowledge.
            if not state.get("rebound"):
                if state.get("pending"):
                    uri = dp.reconcile_write(state["pending"], plan_client, recover_uri)
                    if uri:
                        state["rebound"] = uri
                    state.pop("pending")
                    dp.write_json(path, state)
                if not state.get("rebound"):
                    uri = state["architecture"]["implementedUri"]
                    record = dp.load_record(plan_client.read(uri))
                    mapping = state["specification"]["artifactReplacements"]
                    record["data"]["contextRefs"] = list(dict.fromkeys(mapping.get(u, u) for u in record["data"]["contextRefs"]))
                    verified = state["specification"]["verifiedSpecUri"]
                    if verified not in record["data"]["contextRefs"]:
                        record["data"]["contextRefs"].append(verified)
                    relations = [("references", u) for u in record["data"]["contextRefs"]]
                    dp.require(len(relations) <= 16, "Reconciled architecture exceeds native relation limit")
                    record["relations"] = [{"type": t, "uri": u} for t, u in relations]
                    record["data"]["verifiedSpec"] = {"uri": verified, "revision": cycle["spec"]["revision"]}
                    record["data"]["recallSources"] = [
                        {"uri": u, "sha256": dp.pin(plan_client, u)["sha256"], "role": "constraint",
                         "usedFor": "Verified behavior and implementation context"}
                        for u in record["data"]["contextRefs"]]
                    record["data"]["specArchiveMap"] = state["specification"]["archiveMap"]
                    topic = record["planId"] + "-" + record["runId"] + "-implemented-architecture"
                    preview = plan_client.preflight(record, topic, relations, replace=uri)
                    state["pending"] = {"hash": dp.digest(record), "topic": topic, **preview}
                    dp.write_json(path, state)
                    saved = plan_client.remember(record, topic, relations, replace=uri)
                    state["pending"]["uri"] = saved
                    dp.write_json(path, state)
                    dp.require(dp.digest(dp.load_record(plan_client.read(saved))) == dp.digest(record), "Architecture relation readback mismatch")
                    state["rebound"] = saved
                    state.pop("pending")
                    dp.write_json(path, state)
        result = {"status": "complete", "featureId": definition["featureId"],
                  "implementedArchitectureUri": state["architecture"]["implementedUri"],
                  "verifiedSpecUri": state.get("specification", {}).get("verifiedSpecUri")}
        state.update(status="complete", result=result)
        dp.write_json(path, state)
        cycle["knowledgeCloseout"] = result
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["validation-input", "prepare", "publication-preview", "publication-approve", "finish"])
    parser.add_argument("--cycle-plan", required=True)
    parser.add_argument("--cycle-scripts", required=True)
    parser.add_argument("--spec-scripts", required=True)
    parser.add_argument("--directory", required=True)
    parser.add_argument("--scope")
    parser.add_argument("--validation", help="Current combined feature validation; required if no phase receipt covers all acceptance on this tree")
    parser.add_argument("--threadnote-home")
    wt.add_arguments(parser)
    parser.add_argument("--recover-uri")
    parser.add_argument("--approval-digest")
    parser.add_argument("--decision", choices=["approve", "defer", "reject"])
    parser.add_argument("--approval-evidence", help="Actual explicit user decision on the concrete publication preview")
    args = parser.parse_args()
    phase_state, spec_module, spec_closeout = modules(args.cycle_scripts, args.spec_scripts)
    cycle = dp.read_json(args.cycle_plan)
    scope = dp.read_json(args.scope) if args.scope else dp.read_json(Path(args.directory) / "implemented.json")["scope"]
    context = cycle.get("workflowContext")
    wt.require(not context or Path(context).is_file(), "Pinned workflow context was lost; cannot resume")
    wt.require(not context or not args.workflow_context or Path(context).resolve() == Path(args.workflow_context).resolve(), "Cycle context conflicts with explicit context")
    client_options = {**wt.options(args), "workflow_context": context or args.workflow_context}
    plan_client = dp.Threadnote(scope["repo"], args.threadnote_home, **client_options)
    spec_client = spec_module.Threadnote(scope["repo"], args.threadnote_home, **client_options)
    if args.command == "validation-input":
        path = Path(args.directory) / "combined-input.json"
        dp.require(not path.exists(), "Combined validation draft exists; reconcile it rather than overwrite evidence")
        dp.write_json(path, validation_input(cycle, scope, phase_state))
        result = {"validation": str(path), "next": "Run combined feature checks; record actual results before passing this file to prepare --validation."}
    elif args.command == "prepare":
        result = prepare(cycle, scope, args.directory, phase_state, spec_module, plan_client, spec_client,
                         dp.read_json(args.validation) if args.validation else None)
    elif args.command == "publication-preview":
        from cloud_closeout import preview
        result = preview(cycle, args.directory, phase_state, spec_module, spec_closeout, plan_client, spec_client)
    elif args.command == "publication-approve":
        from cloud_closeout import approve
        result = approve(cycle, args.directory, phase_state, plan_client, args.approval_digest, args.decision, args.approval_evidence)
    else:
        result = finish(cycle, args.directory, phase_state, spec_module, spec_closeout, plan_client, spec_client, args.recover_uri)
        dp.write_json(args.cycle_plan, cycle)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps(wt.cli_error(error)), file=sys.stderr); sys.exit(1)

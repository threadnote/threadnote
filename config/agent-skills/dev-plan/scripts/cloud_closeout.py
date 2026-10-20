"""Approve a sanitized personal-cloud knowledge graph before retiring either draft set."""
import sys
sys.dont_write_bytecode = True

import json
from pathlib import Path
import re

import dev_plan as dp
import closeout
import workflow_transport as wt


def transport(client):
    result = getattr(client, "workflow", None)
    wt.require(result is not None and result.cloud, "Publication requires a bound personal-cloud workflow context")
    return result


def pending(message):
    raise wt.WorkflowError("pending-publication", message)


def head(repo):
    result = dp.run(["git", "rev-parse", "--verify", "HEAD"], cwd=repo).strip()
    wt.require(re.fullmatch(r"[a-f0-9]{40}|[a-f0-9]{64}", result), "Publication needs the actual full source commit")
    return result


def source_proof(cycle, directory, phase_state):
    # This proof stays private. It is never part of the approved durable graph.
    import workflow
    directory = Path(directory)
    values = {name: dp.read_json(directory / name) for name in
              ("workflow.json", "implemented.json", "evidence.json", "combined-validation.json")}
    if (directory / "spec-evidence.json").exists():
        values["spec-evidence.json"] = dp.read_json(directory / "spec-evidence.json")
    definition, implemented = values["workflow.json"], values["implemented.json"]
    wt.require(definition["cycleHash"] == phase_state.definition_hash(cycle), "Implementation plan changed after closeout preparation")
    dp.fresh({"scope": implemented["scope"]})
    validations = workflow.evidence_from_cycle(cycle, phase_state)
    validation = values["combined-validation.json"]
    wt.require(dp.digest(validation) == definition["validationHash"], "Combined verification changed after preparation")
    workflow.current_validation(cycle, implemented["scope"], phase_state, validations, validation)
    return {"inputHash": wt.digest(values), "planHash": phase_state.definition_hash(cycle),
            "sourceCommit": head(implemented["scope"]["repo"])}, values


def owned_plan(client, plan, root, root_uri):
    queue = [root_uri, *root["data"]["children"].values(), *root["data"].get("navigation", {}).values(),
             *root["data"].get("priorArtifacts", {})]
    result = {}
    while queue:
        uri = queue.pop(0)
        if uri in result:
            continue
        observed = transport(client).read(uri)
        record = dp.load_record(observed["body"])
        wt.require(record["planId"] == plan["id"] and record["project"] == plan["project"]
                   and record.get("runId") == root.get("runId") and observed["state"] == "active",
                   "Refusing publication/retirement of another plan's artifact")
        result[uri] = {"revision": observed["revision"], "bodySha256": observed["bodySha256"], "kind": "plan"}
        if record["kind"] == "index":
            queue.extend(record["data"]["members"].values())
    return result


def owned_spec(client, spec_module, spec, root, root_uri):
    expected = {root_uri: spec_module.digest(root), **root["data"]["history"]}
    for uri in root["data"]["children"].values():
        expected.setdefault(uri, None)
    result = {}
    for uri, fingerprint in expected.items():
        observed = transport(client).read(uri)
        record = spec_module.load_record(observed["body"])
        wt.require(record["featureId"] == spec["id"] and record["project"] == spec["project"]
                   and record["data"]["runId"] == root["data"]["runId"] and observed["state"] == "active"
                   and (fingerprint is None or spec_module.digest(record) == fingerprint),
                   "Refusing publication/retirement of another or changed specification artifact")
        result[uri] = {"revision": observed["revision"], "bodySha256": observed["bodySha256"], "kind": "spec"}
    return result


def clean_text(value, binding):
    wt.require(isinstance(value, str), "Knowledge projection contains a non-text field")
    # Reject leakage instead of silently deleting meaning or changing approved facts.
    for private in (binding["repo"], binding["home"]):
        wt.require(not private or private not in value, "Remove local checkout/home paths from publication text")
    wt.require(not re.search(r"(?:/Users/|/home/|/private/|/tmp/|/var/|(?<![A-Za-z0-9_])[A-Za-z]:[\\/]|\\\\[^\\ ]+\\)", value),
               "Remove private absolute paths from publication text")
    wt.require(not re.search(r"<!--\s*dev-(?:spec|plan):v1|[\"'](?:scope|snapshotTree|archiveMap|receipts|pending|callerCwd)[\"']\s*:", value),
               "Publication text must not embed raw workflow records, snapshots or receipts")
    for uri in re.findall(r"threadnote://[^\s<>\]\)\"']+", value):
        wt.require(any(uri == root or uri.startswith(root.rstrip("/") + "/") for root in binding["sharedRoots"]),
                   "Publication text contains an unpublished private reference")
    return value.strip()


def section(title, values, binding):
    if not values:
        return ""
    if isinstance(values, str):
        value = clean_text(values, binding)
        if title == "Architecture" or title.endswith(" — diagram"):
            value = "```mermaid\n" + value + "\n```"
        return "\n## " + title + "\n\n" + value + "\n"
    wt.require(isinstance(values, list) and all(isinstance(value, str) for value in values), "Invalid allowlisted projection field")
    return "\n## " + title + "\n\n" + "\n".join("- " + clean_text(value, binding) for value in values) + "\n"


def relations(refs, own_plan, own_spec, binding, source):
    result = []
    for uri in dict.fromkeys(refs):
        if uri in own_plan:
            target = "architecture"
        elif uri in own_spec:
            target = "spec"
        else:
            clean_text(uri, binding)
            wt.require(any(uri.startswith(root.rstrip("/") + "/") for root in binding["sharedRoots"]),
                       "Publication relations require an authorized durable knowledge target")
            result.append({"type": "references", "uri": uri})
            continue
        if target != source:
            result.append({"type": "references", "nodeKey": target})
    return list({wt.digest(item): item for item in result}.values())


def projection(cycle, directory, phase_state, spec_module, spec_closeout, plan_client, spec_client):
    source, values = source_proof(cycle, directory, phase_state)
    pt, st = transport(plan_client), transport(spec_client)
    wt.require(pt.binding["bindingId"] == st.binding["bindingId"], "Specification and plan use different workflow bindings")
    definition, implemented, evidence = values["workflow.json"], values["implemented.json"], values["evidence.json"]
    plan, root = dp.load_plan(definition["rootUri"], plan_client)
    wt.require(plan.get("spec") == cycle.get("spec"), "Approved spec handoff changed before publication")
    closeout.evidence_check(plan, root, implemented, evidence)
    for pin in implemented.get("recallSources", plan["recall"]["sources"]):
        wt.require(dp.pin(plan_client, pin["uri"])["sha256"] == pin["sha256"], "Publication source memory changed")
    own_plan = owned_plan(plan_client, plan, root, definition["rootUri"])
    own_spec, spec, spec_root = {}, None, None
    if cycle.get("spec"):
        spec, spec_root = spec_module.load(cycle["spec"]["rootUri"], spec_client)
        wt.require(spec_root["data"]["specHash"] == cycle["spec"]["revision"], "Specification revision changed")
        spec_evidence = values["spec-evidence.json"]
        wt.require(spec_evidence["scope"] == implemented["scope"], "Specification and architecture source proof differs")
        spec_closeout.check(spec, spec_root["data"]["specHash"], spec_evidence, spec_client, verify_architecture=False)
        own_spec = owned_spec(spec_client, spec_module, spec, spec_root, cycle["spec"]["rootUri"])
    binding = pt.binding
    body = "# " + clean_text(plan["title"], binding) + " — verified architecture\n"
    for title, key in (("Implemented behavior", "summary"), ("Architecture", "diagram"), ("Contracts", "contracts"),
                       ("Invariants", "invariants"), ("Known limits", "unknowns"), ("Verified deviations", "deviations")):
        body += section(title, implemented.get(key), binding)
    body += section("Architecture verification", evidence["architectureVerification"], binding)
    checks = []
    for phase in evidence["phases"]:
        for item in phase["acceptance"]:
            checks.append(phase["id"] + "/" + item["id"] + ": " + item["evidence"])
    body += section("Acceptance evidence", checks, binding)
    arch_relations = relations(implemented["contextRefs"], own_plan, own_spec, binding, "architecture")
    if spec and not any(item.get("nodeKey") == "spec" for item in arch_relations):
        arch_relations.append({"type": "references", "nodeKey": "spec"})
    nodes = [{"key": "architecture", "role": "architecture", "topic": plan["id"] + "-" + root["runId"] + "-verified-architecture",
              "body": body.rstrip() + "\n", "codeRefs": implemented["codeRefs"], "relations": arch_relations}]
    if spec:
        body = "# " + clean_text(spec["title"], binding) + " — verified behavior\n"
        for title, key in (("Outcome", "objective"), ("Actors", "actors"), ("Verified scope", "inScope"),
                           ("Scope limits", "outOfScope"), ("Constraints", "constraints")):
            body += section(title, spec.get(key), binding)
        body += section("Requirements", [r["id"] + ": " + r["behavior"] for r in spec["requirements"]], binding)
        body += section("Verified scenarios", [s["id"] + " [" + ", ".join(s["requirementIds"]) + "]: "
                        + spec_module.scenario_text(s) for s in spec["scenarios"]], binding)
        # Domain artifact content is explicitly allowlisted; execution/source metadata is omitted.
        for artifact in spec["artifacts"]:
            for key in ("summary", "diagram", "rules", "invariants", "contracts"):
                if artifact.get(key):
                    body += section(artifact["id"] + " — " + key, artifact[key], binding)
            for item in artifact.get("sections", []):
                title = clean_text(item["title"], binding)
                body += section(artifact["id"] + " — " + title, item["items"], binding)
        actual = values["spec-evidence.json"]
        body += section("Behavior verification", actual["behaviorVerification"], binding)
        body += section("Scenario evidence", [s["id"] + ": " + s["evidence"] for s in actual["scenarios"]], binding)
        refs = [*spec["contextRefs"], *(uri for a in spec["artifacts"] for uri in a["contextRefs"])]
        spec_relations = relations(refs, own_plan, own_spec, binding, "spec")
        if not any(item.get("nodeKey") == "architecture" for item in spec_relations):
            spec_relations.append({"type": "references", "nodeKey": "architecture"})
        nodes.append({"key": "spec", "role": "spec", "topic": spec["id"] + "-" + spec_root["data"]["runId"] + "-verified-behavior",
                      "body": body.rstrip() + "\n", "codeRefs": actual["codeRefs"], "relations": spec_relations})
    return {"nodes": nodes, "sourceCommit": source["sourceCommit"]}, source, {**own_plan, **own_spec}


def state_path(directory):
    return Path(directory) / "cloud-publication.json"


def preview(cycle, directory, phase_state, spec_module, spec_closeout, plan_client, spec_client):
    graph, source, owned = projection(cycle, directory, phase_state, spec_module, spec_closeout, plan_client, spec_client)
    path = state_path(directory)
    with wt.locked(path):
        old = wt.read_json(path) if path.exists() else {}
        wt.require(not old.get("archives"), "Retirement has begun; resume the original publication instead of revising it")
        result = transport(plan_client).request("publication-preview", graph={"nodes": graph["nodes"]}, sourceCommit=source["sourceCommit"])
        wt.require(result.get("sourceCommit") == source["sourceCommit"] and isinstance(result.get("approvalDigest"), str),
                   "Publication preview source/digest mismatch")
        supplied = {node["key"]: node for node in result.get("nodes", [])}
        wt.require(set(supplied) == {node["key"] for node in graph["nodes"]}, "Publication preview changed graph members")
        for node in graph["nodes"]:
            target = supplied[node["key"]]
            clean_text(target["canonicalUri"], transport(plan_client).binding)
            wt.require(target["body"] == node["body"] and target["bodySha256"] == wt.body_hash(node["body"]),
                       "Publication preview changed approved content")
        state = {"protocolVersion": 1, "bindingId": transport(plan_client).binding["bindingId"],
                 "graph": graph, "sourceProof": source, "owned": owned, "preview": result, "archives": {}}
        # Re-previewing identical content must preserve an explicit recorded decision.
        if old.get("preview", {}).get("approvalDigest") == result["approvalDigest"] and old.get("sourceProof") == source:
            state.update({key: old[key] for key in ("decision", "approvalEvidence", "published") if key in old})
        wt.save_json(path, state)
        return {"status": "pending", "code": "approval-required", "approvalDigest": result["approvalDigest"],
                "preview": str(path), "nodes": result["nodes"], "sourceCommit": source["sourceCommit"]}


def checked_state(cycle, directory, phase_state, plan_client):
    path = state_path(directory)
    if not path.exists():
        pending("Prepare and inspect publication-preview, then explicitly record Approve/Defer/Reject before cloud finish")
    state = wt.read_json(path)
    source, _ = source_proof(cycle, directory, phase_state)
    wt.require(state["bindingId"] == transport(plan_client).binding["bindingId"] and state["sourceProof"] == source,
               "Publication approval is stale: inputs, source or workflow binding changed; prepare a new concrete preview")
    return state


def approve(cycle, directory, phase_state, plan_client, approval_digest, decision, evidence):
    path = state_path(directory)
    with wt.locked(path):
        state = checked_state(cycle, directory, phase_state, plan_client)
        wt.require(approval_digest == state["preview"]["approvalDigest"], "Approval targets another publication preview")
        wt.require(decision in {"approve", "defer", "reject"} and isinstance(evidence, str) and evidence.strip(),
                   "Record the actual explicit human decision and evidence")
        result = transport(plan_client).request("publication-approve", approvalDigest=approval_digest,
                                               decision=decision, approvalEvidence=evidence)
        wt.require(result.get("approvalDigest") == approval_digest and result.get("decision") == decision,
                   "Publication approval receipt differs from the actual decision")
        state.update(decision=decision, approvalEvidence=evidence)
        wt.save_json(path, state)
        return {"status": "approved" if decision == "approve" else "pending", "approvalDigest": approval_digest, "decision": decision}


def finish(cycle, directory, phase_state, plan_client, spec_client):
    path = state_path(directory)
    with wt.locked(path):
        state = checked_state(cycle, directory, phase_state, plan_client)
        wt.require(transport(spec_client).binding["bindingId"] == state["bindingId"], "Specification workflow binding changed")
        if state.get("decision") != "approve":
            pending("Cloud publication is deferred/unapproved; both draft sets remain active. Inspect the concrete preview and record the user's decision")
        if not state.get("published"):
            # Approval is also pinned to authoritative private input revisions,
            # not merely to unchanged local evidence files.
            for uri, descriptor in state["owned"].items():
                client = spec_client if descriptor["kind"] == "spec" else plan_client
                observed = transport(client).read(uri)
                wt.require(observed["state"] == "active" and observed["revision"] == descriptor["revision"]
                           and observed["bodySha256"] == descriptor["bodySha256"],
                           "An owned draft/archive changed after approval; prepare a new concrete preview")
        result = transport(plan_client).request("publication-publish", approvalDigest=state["preview"]["approvalDigest"])
        if result.get("status") == "pending":
            wt.require(result.get("approvalDigest") == state["preview"]["approvalDigest"]
                       and isinstance(result.get("stage"), str) and isinstance(result.get("message"), str),
                       "Pending publication receipt does not identify the approved graph/stage")
            state["pendingPublication"] = result
            wt.save_json(path, state)
            pending(result["message"] + " Stage: " + result["stage"]
                    + ". Retry finish with this same approved graph; both draft sets remain active")
        wt.require(result.get("approvalDigest") == state["preview"]["approvalDigest"] and result.get("verifiedReadback") is True,
                   "Git publication lacks complete approved graph readback; preserve both draft sets")
        expected = {node["key"]: node for node in state["preview"]["nodes"]}
        actual = {node["key"]: node for node in result.get("nodes", [])}
        wt.require(set(actual) == set(expected), "Published graph is incomplete; preserve both draft sets")
        for key, node in actual.items():
            wt.require(node["canonicalUri"] == expected[key]["canonicalUri"] and node["bodySha256"] == expected[key]["bodySha256"],
                       "Published destination/content differs from approved preview")
            observed = transport(plan_client).read(node["canonicalUri"])
            wt.require(observed["revision"] == node["revision"] and observed["bodySha256"] == node["bodySha256"]
                       and observed["state"] == "active" and observed["storageKind"] == "durable",
                       "Final durable graph independent readback failed; preserve both draft sets")
        state["published"] = result
        state.pop("pendingPublication", None)
        wt.save_json(path, state)
        current_source, _ = source_proof(cycle, directory, phase_state)
        wt.require(current_source == state["sourceProof"],
                   "Publication source changed during verification; preserve remaining task artifacts")
        # Reconcile any archive response lost on a previous already-verified attempt.
        transport(plan_client).recover()
        if transport(spec_client) is not transport(plan_client):
            transport(spec_client).recover()
        # Validate every remaining preimage before retiring the first additional artifact.
        for uri, descriptor in state["owned"].items():
            client = spec_client if descriptor["kind"] == "spec" else plan_client
            native = transport(client)
            archived = state["archives"].get(uri)
            completed = wt.read_json(native.path).get("operations", {}).get("archive:" + uri)
            if archived is None and completed:
                wt.require(completed["request"]["expectedRevision"] == descriptor["revision"], "Recovered archive source revision changed")
                archived = completed["result"]["canonicalUri"]
                state["archives"][uri] = archived
            observed = native.read(archived or uri)
            wt.require(observed["bodySha256"] == descriptor["bodySha256"]
                       and (observed["state"] == "archived" if archived else observed["state"] == "active" and observed["revision"] == descriptor["revision"]),
                       "An owned draft/archive changed; remaining task artifacts are preserved")
        wt.save_json(path, state)
        for uri, descriptor in state["owned"].items():
            if uri in state["archives"]:
                continue
            native = transport(spec_client if descriptor["kind"] == "spec" else plan_client)
            state["archives"][uri] = native.archive(uri, expected_revision=descriptor["revision"])
            wt.save_json(path, state)
        completed = {"status": "complete", "featureId": cycle["featureId"],
                     "implementedArchitectureUri": actual["architecture"]["canonicalUri"],
                     "verifiedSpecUri": actual["spec"]["canonicalUri"] if "spec" in actual else None}
        state.update(status="complete", result=completed)
        wt.save_json(path, state)
        cycle["knowledgeCloseout"] = completed
        return completed

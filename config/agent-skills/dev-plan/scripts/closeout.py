#!/usr/bin/env python3
"""Bind implemented architecture to current code, then retire obsolete planning artifacts."""
import sys
sys.dont_write_bytecode = True
import workflow_transport as wt
from portable_lock import lock_exclusive

import argparse
import json
from pathlib import Path
import re
import subprocess

from dev_plan import (PlanError, Threadnote, digest, diagram_check, fresh, load_plan, memory_text,
                      load_record, nonempty, pin, read_json, reconcile_write, record_for, require, safe_path,
                      string_list, write_json)


def evidence_check(plan, root, implemented, evidence):
    require(evidence.get("rootHash") == digest(root), "Completion evidence targets a different root revision")
    fresh({"scope": implemented["scope"]})
    require(evidence.get("scopeHash") == digest(implemented["scope"]), "Evidence targets a different source snapshot")
    nonempty(evidence.get("architectureVerification"), "architecture verification evidence")
    supplied = evidence.get("phases", [])
    require(isinstance(supplied, list), "Missing phase completion evidence")
    by_id = {p["id"]: p for p in supplied}
    require(len(by_id) == len(supplied), "Duplicate completion phase")
    require(set(by_id) == {p["id"] for p in plan["phases"]}, "Every planned phase needs completion evidence")
    for phase in plan["phases"]:
        actual = by_id[phase["id"]]
        require(actual.get("status") == "complete", "Implementation phase is not complete")
        checks = actual.get("acceptance", [])
        require(isinstance(checks, list), "Missing acceptance evidence")
        actual_checks = {c["id"]: c for c in checks}
        require(len(actual_checks) == len(checks), "Duplicate completion acceptance")
        require(set(actual_checks) == {a["id"] for a in phase["acceptance"]},
                "Every acceptance criterion needs real evidence")
        for check in checks:
            nonempty(check.get("evidence"), "actual command/result or observed acceptance evidence")
    for key in ("summary", "diagram"):
        nonempty(implemented.get(key), "implemented " + key)
    diagram_check(implemented["diagram"], "implemented architecture")
    for key in ("invariants", "unknowns", "contracts", "deviations", "contextRefs"):
        string_list(implemented.get(key), "implemented " + key, required=key == "contracts")
    anchors = string_list(implemented.get("codeRefs"), "implemented codeRefs", required=True)
    require(len(anchors) <= 8, "Choose at most eight decisive current code anchors")
    repo = Path(implemented["scope"]["repo"])
    for anchor in anchors:
        if anchor.startswith(("cgs_", "cgr_")):
            require(implemented.get("codeRefPaths", {}).get(anchor) in implemented["scope"]["files"],
                    "Implemented graph anchor needs its inspected source path in codeRefPaths")
        else:
            require(safe_path(repo, anchor).is_file() and anchor in implemented["scope"]["files"],
                    "Implemented anchor must be an inspected source file")
    if not implemented["contextRefs"]:
        nonempty(implemented.get("contextNote"), "no relevant recalled-memory explanation")
    require(len(implemented["contextRefs"]) <= 13, "Leave relation room for superseded architecture and plan history")


def complete(root_uri, implemented, evidence, state_path, client, recover_uri=None):
    wt.block_cloud_finish(client)
    state_path = Path(state_path)
    state_path.parent.mkdir(parents=True, exist_ok=True)
    with open(str(state_path) + ".lock", "a+b") as lock:
        try:
            lock_exclusive(lock, blocking=False)
        except BlockingIOError:
            raise PlanError("Another closeout owns this receipt file")
        input_hash = digest({"root": root_uri, "implemented": implemented, "evidence": evidence})
        if state_path.exists():
            state = read_json(state_path)
            require(state["inputHash"] == input_hash, "Closeout inputs changed; reconcile the saved transaction")
            plan, root = state["plan"], state["root"]
        else:
            plan, root = load_plan(root_uri, client)
            require(root["data"]["readiness"] == "ready", "Finish and validate the plan before implementation closeout")
            evidence_check(plan, root, implemented, evidence)
            # Snapshot only artifacts created by this plan. Recalled memories are never retired here.
            records = {}
            pending_uris = (list(root["data"]["children"].values())
                            + list(root["data"].get("navigation", {}).values())
                            + list(root["data"].get("priorArtifacts", {})) + [root_uri])
            while pending_uris:
                uri = pending_uris.pop(0)
                if uri in records:
                    continue
                record = load_record(client.read(uri))
                require(record["planId"] == plan["id"] and record["project"] == plan["project"]
                        and record.get("runId") == root.get("runId"),
                        "Refusing to archive an artifact from another plan")
                records[uri] = record
                if record["kind"] == "index":
                    pending_uris += list(record["data"]["members"].values())
            state = {"schemaVersion": 1, "inputHash": input_hash, "plan": plan, "root": root,
                     "rootUri": root_uri, "records": records, "archiveMap": {}, "status": "pending"}
            write_json(state_path, state)
        evidence_check(plan, root, implemented, evidence)
        client.repo = implemented["scope"]["repo"]
        sources = {s["uri"]: s for s in implemented.get("recallSources", plan["recall"]["sources"])}
        for uri in implemented["contextRefs"]:
            require(uri in sources, "Implemented architecture references unread context")
            require(pin(client, uri)["sha256"] == sources[uri]["sha256"],
                    "Relevant memory changed; refresh the implemented architecture's context")
        if state.get("pending"):
            pending = state["pending"]
            if pending["operation"] == "archive":
                uri = recover_uri or pending.get("uri")
                if uri is None and getattr(client, "workflow", None) is not None:
                    uri = client.archive(pending["source"])
                if not uri:
                    original = client.peek(pending["source"])
                    require(original is not None and digest(load_record(original)) == pending["hash"]
                            and client.is_active(pending["source"]),
                            "Archive outcome unknown; recall its archived topic and provide --recover-uri")
                else:
                    require(digest(load_record(client.read(uri))) == pending["hash"],
                            "Recovered archive differs from the intended artifact")
                    if getattr(client, "workflow", None) is not None:
                        require(client.workflow.read(uri)["state"] == "archived", "Recovery URI has not been archived")
                    else:
                        raw = client.call("read", [uri])
                        require(re.search(r"^status: archived$", raw, re.M), "Recovery URI has not been archived")
                    state["archiveMap"][pending["source"]] = uri
            else:
                uri = reconcile_write(pending, client, recover_uri)
                if uri:
                    state["implementedUri"] = uri
            state.pop("pending")
            write_json(state_path, state)
        if state["status"] == "complete":
            return {"implementedUri": state["implementedUri"], "status": "complete",
                    "archiveMap": state["archiveMap"]}

        def publish(final=False):
            baseline = root["data"]["children"]["current"]
            target = root["data"]["children"]["target"]
            data = {**implemented, "archiveMap": state["archiveMap"],
                    "closeoutStatus": "complete" if final else "archiving",
                    "planningRoot": state["archiveMap"].get(root_uri, root_uri),
                    "supersededArchitecture": {key: state["archiveMap"].get(uri, uri)
                                                for key, uri in (("current", baseline), ("target", target))},
                    "implementationEvidence": evidence}
            record = record_for(plan, "implemented", data, plan["title"] + " — implemented architecture")
            record["runId"] = root["runId"]
            relations = [("references", uri) for uri in implemented["contextRefs"]]
            # Native relation targets must be active. Archived history stays in canonical body links.
            if not final:
                relations += [("supersedes", uri) for uri in (baseline, target)]
                relations += [("references", root_uri)]
            record["relations"] = [{"type": kind, "uri": uri} for kind, uri in relations]
            record["citationPolicy"] = "require-current"
            require(len(memory_text(record).encode()) <= 60000,
                    "Implemented architecture is too large; narrow the source snapshot")
            topic = plan["id"] + "-" + root["runId"] + "-implemented-architecture"
            preview = client.preflight(record, topic, relations, replace=state.get("implementedUri"), deferred=False)
            state["pending"] = {"operation": "save", "hash": digest(record), "topic": topic, **preview}
            write_json(state_path, state)
            # No deferred option: native exact-current binding must succeed BEFORE any retirement.
            uri = client.remember(record, state["pending"]["topic"], relations,
                                  replace=state.get("implementedUri"), deferred=False)
            state["pending"]["uri"] = uri
            write_json(state_path, state)
            require(digest(load_record(client.read(uri))) == digest(record), "Implemented architecture readback mismatch")
            state["implementedUri"] = uri
            state.pop("pending")
            write_json(state_path, state)

        if not state.get("implementedUri"):
            publish()
        for uri, record in state["records"].items():
            if uri in state["archiveMap"]:
                continue
            require(digest(load_record(client.read(uri))) == digest(record),
                    "Planning artifact changed during closeout; reconcile before retirement")
            state["pending"] = {"operation": "archive", "source": uri, "hash": digest(record)}
            write_json(state_path, state)
            if hasattr(client, "archive"):
                archived = client.archive(uri)
            else:
                output = client.call("archive", [uri])
                match = re.search(r"Stored memory: (threadnote://[^\s]+)", output)
                require(match, "Unknown archive outcome; recover the returned archived URI before retrying")
                archived = match.group(1)
            state["pending"]["uri"] = archived
            write_json(state_path, state)
            require(digest(load_record(client.read(archived))) == digest(record), "Archive readback mismatch")
            state["archiveMap"][uri] = archived
            state.pop("pending")
            write_json(state_path, state)
        publish(final=True)
        state["status"] = "complete"
        write_json(state_path, state)
        return {"implementedUri": state["implementedUri"], "status": "complete", "archiveMap": state["archiveMap"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("root", "implemented", "evidence", "state"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--threadnote-home")
    wt.add_arguments(parser)
    parser.add_argument("--recover-uri")
    args = parser.parse_args()
    implemented = read_json(args.implemented)
    result = complete(args.root, implemented, read_json(args.evidence), args.state,
                      Threadnote(implemented["scope"]["repo"], args.threadnote_home, **wt.options(args)), args.recover_uri)
    print(json.dumps(result, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (PlanError, KeyError, ValueError, OSError, subprocess.TimeoutExpired) as error:
        print(json.dumps(wt.cli_error(error), ensure_ascii=True), file=sys.stderr)
        sys.exit(1)

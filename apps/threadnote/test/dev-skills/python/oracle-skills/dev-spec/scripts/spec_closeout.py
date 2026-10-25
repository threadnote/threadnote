#!/usr/bin/env python3
"""Preserve verified behavioral knowledge before retiring owned spec drafts."""
import sys
sys.dont_write_bytecode = True
import workflow_transport as wt

import copy
import json
import re

import dev_spec as ds
from support import Store, digest, load_record, locked, nonempty, pin, require


def check(spec, revision, evidence, client, verify_architecture=True):
    require(evidence.get("specRevision") == revision, "Spec completion evidence targets another revision")
    ds.fresh(evidence.get("scope"))
    require(evidence.get("scope"), "Verified spec needs an inspected implementation scope")
    require(evidence.get("codeRefs"), "Bind actual implemented code references before retirement")
    ds.anchors(evidence["codeRefs"], evidence.get("codeRefPaths", {}), evidence["scope"])
    nonempty(evidence.get("behaviorVerification"), "final combined behavior verification")
    actual = evidence.get("scenarios", [])
    require(len(actual) == len(spec["scenarios"]) and {s["id"] for s in actual} == {s["id"] for s in spec["scenarios"]},
            "Every approved acceptance scenario needs completion evidence")
    for scenario in actual:
        require(scenario.get("result") == "passed", "A required behavior remains unverified")
        nonempty(scenario.get("evidence"), "actual scenario verification evidence")
    require(not evidence.get("unresolvedDeviations", []), "Resolve behavioral deviations; do not rewrite intent to fit code")
    if not verify_architecture:
        return None
    architecture = nonempty(evidence.get("architectureUri"), "implemented architecture URI")
    require(client.active(architecture), "Implemented architecture must be active before spec retirement")
    body = client.read(architecture)
    match = re.search(r"<!-- dev-plan:v1 (.*?) -->", body, re.S)
    require(match, "Expected implemented architecture from dev-plan")
    record = json.loads(match.group(1))
    require(record["kind"] == "implemented" and record["planId"] == spec["id"]
            and record["project"] == spec["project"] and record["data"]["closeoutStatus"] == "complete",
            "Architecture belongs to another feature or is incomplete")
    return architecture


def complete(root_uri, evidence, path, client, recover_uri=None):
    wt.block_cloud_finish(client)
    with locked(path):
        store = Store(path, client, {"root": root_uri, "evidenceHash": digest(evidence)})
        store.recover(recover_uri)
        if store.state.get("status") == "complete":
            return store.state["result"]
        if "spec" not in store.state:
            spec, root = ds.load(root_uri, client)
            require(root["data"]["status"] == "ready", "Only approved ready specs can close out")
            ds.validate(spec, True, root["data"]["confirmation"], root["data"]["review"], check_source=False)
            records = {root_uri: digest(root), **root["data"]["history"]}
            for uri in root["data"]["children"].values():
                records[uri] = digest(load_record(client.read(uri)))
            for uri, expected in records.items():
                record = load_record(client.read(uri))
                require(digest(record) == expected and record["featureId"] == spec["id"]
                        and record["project"] == spec["project"] and record["data"]["runId"] == root["data"]["runId"],
                        "Refusing to retire an unowned or changed spec artifact")
            store.state.update(spec=spec, root=root, records=records)
            store.flush()
        spec, root = store.state["spec"], store.state["root"]
        architecture = check(spec, root["data"]["specHash"], evidence, client)
        client.repo = evidence["scope"]["repo"]
        sources = evidence.get("recallSources", spec["recall"]["sources"])
        pins = {s["uri"]: s["sha256"] for s in sources}
        archived = evidence.get("contextArchiveMap", {})
        architecture_record = json.loads(re.search(r"<!-- dev-plan:v1 (.*?) -->", client.read(architecture), re.S).group(1))
        require(all(architecture_record["data"]["archiveMap"].get(u) == target for u, target in archived.items()),
                "Context replacements must be retired artifacts of this implemented architecture")
        for uri in set(u for a in [spec, *spec["artifacts"]] for u in a["contextRefs"]):
            require(uri in pins and pin(client, archived.get(uri, uri))["sha256"] == pins[uri], "Relevant context changed before verification")

        def current_refs(refs):
            return list(dict.fromkeys([*(architecture if u in archived else u for u in refs), architecture]))

        children, replacements = {}, {}
        for artifact in spec["artifacts"]:
            refs = current_refs(artifact["contextRefs"])
            data = {"artifact": artifact, "specRevision": root["data"]["specHash"], "scope": evidence["scope"],
                    "evidence": evidence, "runId": store.state["runId"]}
            item = ds.record(spec, "verified", data, ds.artifact_markdown(artifact), refs, evidence["codeRefs"])
            uri = store.put(artifact["id"], item, stable=True)
            children[artifact["id"]] = uri
            replacements[root["data"]["children"][artifact["id"]]] = uri

        def publish(final=False):
            refs = list(dict.fromkeys([*current_refs(spec["contextRefs"]), *children.values()]))
            markdown = ds.summary(spec) + "\n**Verification:** " + evidence["behaviorVerification"] + "\n\n"
            markdown += "\n".join(ds.lines("Verified artifacts", ["[" + key + "](" + uri + ")" for key, uri in children.items()]))
            markdown += "\n".join(ds.lines("Archived specification history", ["[History](" + uri + ")" for uri in store.state["archives"].values()]))
            data = {"core": root["data"]["core"], "children": children, "specRevision": root["data"]["specHash"],
                    "status": "verified" if final else "retiring-drafts", "evidence": evidence,
                    "archiveMap": dict(store.state["archives"]), "runId": store.state["runId"]}
            return store.put("verified-root", ds.record(spec, "verified", data, markdown, refs, evidence["codeRefs"]), stable=True)

        verified_uri = publish()
        for uri, fingerprint in store.state["records"].items():
            store.archive(uri, fingerprint)
        verified_uri = publish(final=True)
        replacements[root_uri] = verified_uri
        result = {"status": "complete", "verifiedSpecUri": verified_uri, "artifactReplacements": replacements,
                  "archiveMap": dict(store.state["archives"])}
        store.state.update(status="complete", result=result)
        store.flush()
        return result

#!/usr/bin/env python3
"""Author, validate, persist and hand off an interactive behavioral specification."""
import sys
sys.dont_write_bytecode = True
import workflow_transport as wt

import argparse
import copy
import hashlib
import json
from pathlib import Path
import re
import subprocess

from support import (FENCE, PlanError, Store, Threadnote, diagram_check, digest, inspect, load_record,
                     locked, nonempty, pin, read_json, require, safe_path, string_list, write_json)


def intent(spec):
    """Evidence refreshes do not require re-approving unchanged product decisions."""
    return {key: spec[key] for key in ("id", "title", "objective", "actors", "inScope", "outOfScope",
            "requirements", "scenarios", "constraints", "assumptions", "questions")} | {
            "artifacts": [{key: value for key, value in artifact.items()
                           if key not in {"contextRefs", "contextNote", "codeRefs", "codeRefPaths"}}
                          for artifact in spec["artifacts"]]}


def scenario_text(scenario):
    return "Given " + scenario["given"] + "; when " + scenario["when"] + "; then " + scenario["then"]


def template(args):
    common = {"contextRefs": [], "contextNote": "", "codeRefs": []}
    return {"schemaVersion": 1, "id": args.id, "project": args.project, "title": args.title,
            "objective": args.objective, "callerCwd": str(Path(args.cwd).resolve()), "focus": args.focus,
            "scope": read_json(args.scope) if args.scope else None,
            "observations": [], "actors": [], "inScope": [], "outOfScope": [],
            "requirements": [{"id": "R1", "behavior": args.objective, "priority": "must", "change": "added"}],
            "scenarios": [{"id": "S1", "requirementIds": ["R1"], "given": "", "when": "", "then": ""}],
            "constraints": [], "assumptions": [], "questions": [], "artifacts": [],
            "recall": {"queries": [], "sources": []}, "review": {"required": False, "reason": ""}, **common}


def ids(items, label):
    require(isinstance(items, list), "Invalid " + label)
    result = set()
    for item in items:
        key = nonempty(item.get("id"), label + " ID")
        require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", key), "Invalid ID: " + key)
        require(key not in result, "Duplicate " + label + " ID: " + key)
        result.add(key)
    return result


def anchors(refs, mapping, scope):
    string_list(refs, "codeRefs")
    require(len(refs) <= 8, "At most eight decisive native anchors per artifact")
    for ref in refs:
        path = mapping.get(ref) if ref.startswith(("cgs_", "cgr_")) else ref
        require(scope and path in scope["files"], "Code anchor needs an inspected existing path: " + ref)
        require(safe_path(Path(scope["repo"]), path).is_file(), "Code anchor source is missing")


def fresh(scope):
    if scope:
        require(inspect(scope["repo"], scope["paths"])["files"] == scope["files"],
                "Inspected source changed; reconcile observations and refresh scope")


def validate(spec, ready=False, confirmation=None, review=None, check_source=True):
    require(spec.get("schemaVersion") == 1, "Unsupported spec schema")
    for key in ("id", "project", "title", "objective", "callerCwd", "focus"):
        nonempty(spec.get(key), key)
    require(re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", spec["id"]), "Invalid feature ID")
    require(Path(spec["callerCwd"]).is_absolute(), "callerCwd must be absolute")
    if spec.get("scope"):
        require(Path(spec["scope"]["repo"]).resolve() == Path(spec["callerCwd"]).resolve(),
                "Scope and callerCwd differ")
    for key in ("actors", "inScope", "outOfScope", "constraints", "observations"):
        string_list(spec.get(key), key, required=key in {"actors", "inScope"})
    require(isinstance(spec.get("questions"), list), "Missing open questions")
    for question in spec["questions"]:
        for key in ("id", "question", "impact"):
            nonempty(question.get(key), "question " + key)
        require(question.get("disposition") in {"open", "deferred-to-plan"}, "Invalid question disposition")
    for assumption in spec.get("assumptions", []):
        for key in ("statement", "basis"):
            nonempty(assumption.get(key), "assumption " + key)
        require(assumption.get("authority") in {"user", "evidence", "agent"}, "Missing assumption provenance")
    requirements = ids(spec.get("requirements"), "requirement")
    require(requirements, "At least one observable requirement is needed")
    for item in spec["requirements"]:
        nonempty(item.get("behavior"), "requirement behavior")
        require(item.get("priority") in {"must", "should", "could"}, "Invalid priority")
        require(item.get("change") in {"added", "modified", "removed", "preserved"}, "Invalid behavior delta")
        if item["change"] in {"modified", "removed"}:
            nonempty(item.get("previousBehavior"), "previous behavior for changed requirement")
            nonempty(item.get("reason"), "reason for changed behavior")
    scenarios = ids(spec.get("scenarios"), "scenario")
    covered = set()
    for item in spec["scenarios"]:
        for key in ("given", "when", "then"):
            nonempty(item.get(key), "scenario " + key)
        links = string_list(item.get("requirementIds"), "scenario requirement IDs", required=True)
        require(set(links) <= requirements, "Scenario refers to an unknown requirement")
        covered.update(links)
    require(covered == requirements, "Requirements without acceptance scenarios: " + ", ".join(requirements - covered))
    recalled = spec.get("recall", {})
    string_list(recalled.get("queries"), "scoped recall queries", required=True)
    sources = {}
    for source in recalled.get("sources", []):
        uri = nonempty(source.get("uri"), "recalled URI")
        require(uri.startswith("threadnote://") and uri not in sources, "Invalid/duplicate recalled URI")
        require(re.fullmatch(r"[0-9a-f]{64}", source.get("sha256", "")), "Missing memory pin")
        nonempty(source.get("usedFor"), "recalled source relevance")
        sources[uri] = source
    used = set()
    artifact_ids = ids(spec.get("artifacts"), "artifact")
    require("root" not in artifact_ids, "Artifact ID root is reserved")
    for artifact in [spec, *spec["artifacts"]]:
        refs = string_list(artifact.get("contextRefs"), "artifact contextRefs")
        require(set(refs) <= set(sources), "Artifact references unread/unpinned context")
        used.update(refs)
        if not refs:
            nonempty(artifact.get("contextNote"), "no relevant recall explanation")
        anchors(artifact.get("codeRefs"), artifact.get("codeRefPaths", {}), spec.get("scope"))
        if artifact is spec:
            continue
        require(artifact.get("kind") in {"domain", "workflow", "contract", "capability"}, "Unsupported artifact kind")
        for key in ("title", "summary"):
            nonempty(artifact.get(key), "artifact " + key)
        links = string_list(artifact.get("requirementIds"), "artifact requirement IDs", required=True)
        require(set(links) <= requirements, "Artifact refers to unknown requirements")
        if artifact["kind"] in {"domain", "workflow"} or artifact.get("diagram"):
            diagram_check(artifact.get("diagram"), artifact["id"])
        require(isinstance(artifact.get("sections"), list), "Artifact needs sections")
        for section in artifact["sections"]:
            nonempty(section.get("title"), "section title")
            string_list(section.get("items"), "section items", required=True)
        require(len(refs) <= 15, "Leave one native relation for implemented architecture")
    require(used == set(sources), "Remove unused recalled sources or link them where relevant")
    require(len(spec["contextRefs"]) + len(artifact_ids) <= 15, "Split the feature: leave one root relation for implemented architecture")
    policy = spec.get("review", {})
    require(type(policy.get("required")) is bool, "Review classification is required")
    nonempty(policy.get("reason"), "review classification reason")
    if check_source:
        fresh(spec.get("scope"))
    if ready:
        require(not any(q["disposition"] == "open" for q in spec["questions"]), "Unresolved behavioral decisions: save draft")
        require(confirmation and confirmation.get("intentHash") == digest(intent(spec))
                and confirmation.get("source") == "user" and confirmation.get("confirmed") is True,
                "The user must confirm this exact acceptance summary before ready status")
        nonempty(confirmation.get("response"), "actual user confirmation")
        if policy["required"]:
            require(review and review.get("specHash") == digest(spec) and review.get("verdict") == "ready",
                    "Substantial spec needs a current quiet independent review")
            require(isinstance(review.get("findings"), list), "Missing review findings")
            require(not any(f.get("severity") in {"critical", "important"} for f in review["findings"]),
                    "Material spec review findings remain")
    return {"specHash": digest(spec), "intentHash": digest(intent(spec)), "requirements": len(requirements),
            "scenarios": len(scenarios), "artifacts": len(artifact_ids) + 1,
            "mermaid": "type/fence checks only; render with --mermaid-cli when available"}


def lines(title, items):
    return ["**" + title + "**", ""] + ["- " + item for item in items] + [""] if items else []


def artifact_markdown(artifact):
    result = ["# " + artifact["title"], "", artifact["summary"], ""]
    if artifact.get("diagram"):
        result += [FENCE + "mermaid", artifact["diagram"], FENCE, ""]
    for section in artifact["sections"]:
        result += lines(section["title"], section["items"])
    result += lines("Requirements", artifact["requirementIds"])
    return "\n".join(result)


def summary(spec):
    result = ["# " + spec["title"], "", spec["objective"], ""]
    for key, title in (("actors", "Actors"), ("inScope", "In scope"), ("outOfScope", "Out of scope"),
                       ("constraints", "Constraints")):
        result += lines(title, spec[key])
    result += lines("Requirements", [r["id"] + " [" + r["priority"] + "; " + r["change"] + "]: " + r["behavior"]
                                    + (" (Previously: " + r["previousBehavior"] + "; reason: " + r["reason"] + ")"
                                       if r["change"] in {"modified", "removed"} else "")
                                    for r in spec["requirements"]])
    result += lines("Acceptance scenarios", [s["id"] + " → " + ", ".join(s["requirementIds"]) + ": " + scenario_text(s)
                                            for s in spec["scenarios"]])
    result += lines("Assumptions", [a["statement"] + " (" + a["authority"] + ": " + a["basis"] + ")" for a in spec["assumptions"]])
    result += lines("Open or deferred questions", [q["question"] + " — " + q["impact"] + " [" + q["disposition"] + "]"
                                                 for q in spec["questions"]])
    return "\n".join(result).strip() + "\n"


def record(spec, kind, data, markdown, refs, code_refs=None, deferred=False):
    body = markdown.rstrip() + "\n\n" + "\n".join(lines("Relevant prior memories", ["[Memory](" + u + ")" for u in refs]))
    return {"schemaVersion": 1, "featureId": spec["id"], "project": spec["project"], "kind": kind,
            "memoryKind": "durable" if kind == "verified" else "handoff", "data": data,
            "markdown": body, "codeRefs": code_refs or [], "deferred": deferred,
            "relations": [{"type": "references", "uri": uri} for uri in refs]}


def verify_pins(spec, client):
    for source in spec["recall"]["sources"]:
        require(pin(client, source["uri"])["sha256"] == source["sha256"], "Recalled context changed; reconcile before saving")


def save(spec, path, client, confirmation=None, review=None, draft=False, deferred=False, recover_uri=None):
    wt.configure(client, path, spec["project"], spec["id"], spec["callerCwd"])
    require(not deferred or draft, "Deferred citations cannot produce a ready spec")
    validate(spec, ready=not draft, confirmation=confirmation, review=review)
    verify_pins(spec, client)
    with locked(path):
        store = Store(path, client, {"feature": spec["id"], "project": spec["project"], "cwd": spec["callerCwd"]})
        wt.receipt_context(client, store.state)
        store.flush()
        store.recover(recover_uri)
        saved_input = digest([spec, confirmation, review, draft, deferred])
        if store.state.get("savedInput") == saved_input:
            for receipt in store.state["receipts"].values():
                require(digest(load_record(client.read(receipt["uri"]))) == receipt["hash"], "Stored artifact changed")
            root = load_record(client.read(store.state["rootUri"]))
            return {"rootUri": store.state["rootUri"], "status": root["data"]["status"],
                    "specHash": digest(spec), "children": root["data"]["children"]}
        children, used = {}, {"root"}
        for artifact in spec["artifacts"]:
            key = artifact["id"]
            data = {"artifact": artifact, "runId": store.state["runId"]}
            children[key] = store.put(key, record(spec, artifact["kind"], data, artifact_markdown(artifact),
                                                  artifact["contextRefs"], artifact["codeRefs"], deferred))
            used.add(key)
        for key in list(store.state["receipts"]):
            if key not in used:
                old = store.state["receipts"].pop(key)
                store.state["history"][old["uri"]] = old["hash"]
        core = {k: v for k, v in spec.items() if k != "artifacts"}
        if store.state["receipts"].get("root"):
            old = store.state["receipts"]["root"]
            store.state["history"][old["uri"]] = old["hash"]
        data = {"core": core, "children": children, "artifactOrder": [a["id"] for a in spec["artifacts"]],
                "specHash": digest(spec), "intentHash": digest(intent(spec)),
                "status": "draft" if draft else "ready", "confirmation": confirmation, "review": review,
                "history": dict(store.state["history"]), "runId": store.state["runId"]}
        markdown = summary(spec) + "\n**Status:** " + data["status"] + "\n\n"
        markdown += "\n".join(lines("Artifacts", ["[" + key + "](" + uri + ")" for key, uri in children.items()]))
        markdown += ("\n**Handoff:** dev-plan preserves these requirement/scenario IDs and this exact revision. "
                     "dev-cycle verifies the accepted behavior, binds actual code references, and preserves a verified "
                     "spec plus implemented architecture before retiring owned drafts. A code mismatch is not permission "
                     "to rewrite approved intent. Implementation/publication requires its own task authorization.\n")
        root = record(spec, "root", data, markdown, spec["contextRefs"], spec["codeRefs"], deferred)
        root["relations"] += [{"type": "references", "uri": uri} for uri in children.values()]
        uri = store.put("root", root)
        store.state["rootUri"] = uri
        store.state["savedInput"] = saved_input
        store.flush()
        return {"rootUri": uri, "status": data["status"], "specHash": data["specHash"], "children": children}


def load(uri, client):
    root = load_record(client.read(uri))
    require(root["kind"] == "root", "Expected an active specification root")
    spec = {**root["data"]["core"], "artifacts": []}
    for key in root["data"].get("artifactOrder", root["data"]["children"]):
        child_uri = root["data"]["children"][key]
        child = load_record(client.read(child_uri))
        require(child["featureId"] == root["featureId"] and child["data"]["runId"] == root["data"]["runId"]
                and child["data"]["artifact"]["id"] == key, "Wrong specification child")
        spec["artifacts"].append(child["data"]["artifact"])
    require(digest(spec) == root["data"]["specHash"], "Specification children changed; reconcile the revision")
    return spec, root


def export_plan(uri, client):
    require(client.active(uri), "Planning input must be active")
    spec, root = load(uri, client)
    require(root["data"]["status"] == "ready", "Only a confirmed ready spec can feed dev-plan")
    validate(spec, True, root["data"]["confirmation"], root["data"]["review"])
    verify_pins(spec, client)
    uris = [uri, *root["data"]["children"].values()]
    packet = {"schemaVersion": 1, "kind": "dev-spec-plan-input", "featureId": spec["id"], "project": spec["project"],
              "title": spec["title"], "objective": spec["objective"], "rootUri": uri, "revision": digest(spec),
              "memoryHashes": {u: pin(client, u)["sha256"] for u in uris},
              "requirements": [{"id": r["id"], "behavior": r["behavior"]} for r in spec["requirements"]],
              "scenarios": spec["scenarios"], "constraints": spec["constraints"], "outOfScope": spec["outOfScope"],
              "confirmation": root["data"]["confirmation"]}
    result = {**packet, "packetHash": digest(packet)}
    if wt.locator(client):
        result["workflowContext"] = wt.locator(client)
    return result


def diff(before, after):
    result = {}
    for field in ("requirements", "scenarios", "artifacts"):
        old, new = ({i["id"]: i for i in s[field]} for s in (before, after))
        result[field] = {"added": sorted(new.keys() - old.keys()), "removed": sorted(old.keys() - new.keys()),
                         "changed": sorted(k for k in old.keys() & new.keys() if old[k] != new[k])}
    result["confirmationRequired"] = digest(intent(before)) != digest(intent(after))
    result["next"] = "Reconcile changed spec obligations in dev-plan, then regenerate affected dev-cycle packets."
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--threadnote-home")
    wt.add_arguments(parser)
    sub = parser.add_subparsers(dest="command", required=True)
    cmd = sub.add_parser("init")
    for key in ("id", "project", "title", "objective", "cwd", "focus", "out"):
        cmd.add_argument("--" + key, required=True)
    cmd.add_argument("--scope")
    cmd = sub.add_parser("inspect")
    cmd.add_argument("--repo", required=True); cmd.add_argument("--path", action="append", required=True); cmd.add_argument("--out", required=True)
    cmd = sub.add_parser("pin")
    cmd.add_argument("--uri", required=True); cmd.add_argument("--out", required=True)
    for name in ("validate", "render", "review-packet", "acceptance-packet", "confirm", "save"):
        cmd = sub.add_parser(name); cmd.add_argument("--spec", required=True)
        if name in {"validate", "save"}:
            cmd.add_argument("--confirmation"); cmd.add_argument("--review")
        if name == "validate":
            cmd.add_argument("--ready", action="store_true"); cmd.add_argument("--mermaid-cli")
        if name in {"render", "review-packet", "acceptance-packet", "confirm"}:
            cmd.add_argument("--out", required=True)
        if name == "confirm":
            cmd.add_argument("--packet", required=True); cmd.add_argument("--user-response", required=True)
        if name == "save":
            cmd.add_argument("--state", required=True); cmd.add_argument("--draft", action="store_true")
            cmd.add_argument("--defer-code-refs", action="store_true"); cmd.add_argument("--recover-uri")
    for name in ("load", "export-plan"):
        cmd = sub.add_parser(name); cmd.add_argument("--root", required=True); cmd.add_argument("--out", required=True)
        if name == "load": cmd.add_argument("--state", required=True)
    cmd = sub.add_parser("diff")
    cmd.add_argument("--before", required=True); cmd.add_argument("--after", required=True)
    args = parser.parse_args()
    spec = read_json(args.spec) if hasattr(args, "spec") else None
    client = Threadnote(spec["callerCwd"] if spec else None, args.threadnote_home, **wt.options(args))
    confirmation = read_json(args.confirmation) if getattr(args, "confirmation", None) else None
    review = read_json(args.review) if getattr(args, "review", None) else None
    if args.command == "init":
        require(not Path(args.out).exists(), "Draft exists; resume it")
        result = template(args); write_json(args.out, result)
        result = {"draft": args.out}
    elif args.command == "inspect":
        result = inspect(args.repo, args.path); write_json(args.out, result)
    elif args.command == "pin":
        result = {**pin(client, args.uri), "usedFor": ""}; write_json(args.out, result)
    elif args.command == "diff":
        result = diff(read_json(args.before), read_json(args.after))
    elif args.command == "validate":
        result = validate(spec, args.ready, confirmation, review)
        if args.mermaid_cli:
            import tempfile
            from support import run
            require(Path(args.mermaid_cli).is_absolute() and Path(args.mermaid_cli).is_file(), "Use an installed absolute Mermaid CLI path")
            with tempfile.TemporaryDirectory(prefix="dev-spec-render-") as directory:
                for a in spec["artifacts"]:
                    if a.get("diagram"):
                        source = Path(directory) / (a["id"] + ".mmd"); source.write_text(a["diagram"], encoding="utf-8")
                        run([args.mermaid_cli, "-i", str(source), "-o", str(source.with_suffix(".svg"))])
            result["mermaid"] = "rendered"
    elif args.command in {"review-packet", "acceptance-packet", "render"}:
        result = validate(spec)
        if args.command == "render":
            directory = Path(args.out); directory.mkdir(parents=True, exist_ok=True)
            (directory / "spec.md").write_text(summary(spec), encoding="utf-8")
            for artifact in spec["artifacts"]:
                (directory / (artifact["id"] + ".md")).write_text(artifact_markdown(artifact), encoding="utf-8")
        else:
            write_json(args.out, {**result, "spec": spec, "summary": summary(spec)})
        result = {"output": args.out, **result}
    elif args.command == "confirm":
        validate(spec)
        packet = read_json(args.packet)
        require(packet["intentHash"] == digest(intent(spec)), "Acceptance packet is stale")
        result = {"intentHash": packet["intentHash"], "source": "user", "confirmed": True,
                  "response": nonempty(args.user_response, "actual affirmative user response")}
        write_json(args.out, result)
    elif args.command == "save":
        result = save(spec, args.state, client, confirmation, review, args.draft, args.defer_code_refs, args.recover_uri)
    elif args.command == "load":
        require(not Path(args.out).exists() and not Path(args.state).exists(), "Resume files already exist")
        spec, root = load(args.root, client)
        receipts = {"root": {"uri": args.root, "hash": digest(root)}}
        for key, uri in root["data"]["children"].items():
            receipts[key] = {"uri": uri, "hash": digest(load_record(client.read(uri))) }
        write_json(args.out, spec)
        write_json(args.state, {"identity": {"feature": spec["id"], "project": spec["project"], "cwd": spec["callerCwd"]},
                               "runId": root["data"]["runId"], "receipts": receipts, "history": root["data"]["history"],
                               "archives": {}, "rootUri": args.root, **({"workflowContext": wt.locator(client)} if wt.locator(client) else {})})
        result = {"draft": args.out, "receipts": args.state}
    else:
        result = export_plan(args.root, client); write_json(args.out, result)
    print(json.dumps(wt.result_context(client, result), ensure_ascii=True, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (PlanError, KeyError, ValueError, OSError, subprocess.TimeoutExpired) as error:
        print(json.dumps(wt.cli_error(error)), file=sys.stderr); sys.exit(1)

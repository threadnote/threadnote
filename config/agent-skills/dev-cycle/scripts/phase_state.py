#!/usr/bin/env python3
"""Guard phased plans and prepare evidence-backed private Threadnote handoffs."""
import sys
sys.dont_write_bytecode = True

import argparse
import fnmatch
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

from dev_cycle import check, read_json, require, validate_review, write_json


DEFINITION = ("id", "title", "dependsOn", "memoryUris", "allowedPaths",
              "acceptanceCriteria", "safeToMergeReason", "branch", "baseBranch")
READY = {"validated", "published", "merged"}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def text(value, name):
    require(isinstance(value, str) and value.strip(), "Missing " + name)
    return value


def strings(value, name, nonempty=False):
    require(isinstance(value, list) and (value or not nonempty), "Invalid " + name)
    for item in value:
        text(item, name)
    require(len(set(value)) == len(value), "Duplicate " + name)
    return value


def validate_plan(plan):
    text(plan.get("objective"), "objective")
    require(plan.get("delivery") in {"local", "commit", "pr"}, "Invalid delivery mode")
    strings(plan.get("planMemoryUris", []), "planMemoryUris")
    phases = plan.get("phases")
    require(isinstance(phases, list) and phases, "Plan needs phases")
    by_id = {}
    for phase in phases:
        for key in ("id", "title", "safeToMergeReason", "branch", "baseBranch"):
            text(phase.get(key), key)
        for key in ("dependsOn", "memoryUris", "allowedPaths", "acceptanceCriteria"):
            strings(phase.get(key), key, nonempty=key in {"allowedPaths", "acceptanceCriteria"})
        require(phase["id"] not in by_id, "Duplicate phase ID")
        require(phase.get("status", "pending") in {"pending", "active", *READY, "stale", "blocked"},
                "Invalid phase status")
        for pattern in phase["allowedPaths"]:
            require(not Path(pattern).is_absolute() and ".." not in Path(pattern).parts,
                    "Allowed paths must stay inside the checkout")
        by_id[phase["id"]] = phase
    if plan.get("spec"):
        spec = plan["spec"]
        require(plan.get("featureId") == spec.get("featureId"), "Feature identity differs from dev-spec")
        require(all(plan.get("memoryHashes", {}).get(uri) == sha for uri, sha in spec["memoryHashes"].items()),
                "Approved spec pins are missing or changed")
        scenarios = {s["id"]: s for s in spec["scenarios"]}
        covered = set()
        for phase in phases:
            refs = phase.get("acceptanceRefs", [])
            require([r["criterion"] for r in refs] == phase["acceptanceCriteria"], "Acceptance traceability differs from phase criteria")
            for ref in refs:
                for sid in ref.get("specScenarios", []):
                    require(sid in scenarios, "Unknown upstream acceptance scenario")
                    scenario = scenarios[sid]
                    expected = "Given " + scenario["given"] + "; when " + scenario["when"] + "; then " + scenario["then"]
                    require(ref["criterion"] == expected and set(scenario["requirementIds"]) <= set(ref["requirements"]),
                            "Approved scenario was weakened between planning and implementation")
                    covered.add(sid)
        require(covered == set(scenarios), "Approved acceptance scenarios disappeared from the implementation plan")
    visiting, visited = set(), set()

    def visit(key):
        require(key in by_id, "Unknown dependency: " + key)
        require(key not in visiting, "Phase dependency cycle")
        if key in visited:
            return
        visiting.add(key)
        for parent in by_id[key]["dependsOn"]:
            visit(parent)
        visiting.remove(key)
        visited.add(key)

    for key in by_id:
        visit(key)
    return by_id


def definition_hash(plan):
    validate_plan(plan)
    return digest({"objective": plan["objective"], "delivery": plan["delivery"],
                   "planMemoryUris": plan.get("planMemoryUris", []),
                   "memoryHashes": plan.get("memoryHashes", {}),
                   "phases": [{**{key: phase[key] for key in DEFINITION},
                               **({"acceptanceRefs": phase["acceptanceRefs"]} if "acceptanceRefs" in phase else {})}
                              for phase in plan["phases"]],
                   **{key: plan[key] for key in ("featureId", "spec", "completion") if key in plan}})


def eligible(phase, by_id):
    return all(by_id[key].get("status") in READY for key in phase["dependsOn"])


def next_phase(plan):
    by_id = validate_plan(plan)
    return next((phase for phase in plan["phases"]
                 if phase.get("status", "pending") in {"pending", "active"} and eligible(phase, by_id)), None)


def make_packet(plan, phase_id, memories):
    by_id = validate_plan(plan)
    require(phase_id in by_id, "Unknown phase")
    phase = by_id[phase_id]
    require(eligible(phase, by_id) and phase.get("status", "pending") not in {"stale", "blocked"},
            "Phase has unvalidated/stale dependencies or needs reconciliation")
    uris = list(dict.fromkeys(plan.get("planMemoryUris", []) + phase["memoryUris"]))
    hashes = plan.get("memoryHashes", {})
    for uri in uris:
        require(uri.startswith("threadnote://"), "Use canonical Threadnote URIs")
        require(uri in memories and isinstance(memories[uri], str), "Read required plan memory: " + uri)
        require(hashlib.sha256(memories[uri].encode()).hexdigest() == hashes.get(uri),
                "Plan memory changed or is not pinned: " + uri)
    return {"schemaVersion": 1, "planHash": definition_hash(plan), "phase": dict(phase), "readUris": uris,
            **{key: plan[key] for key in ("featureId", "spec", "completion", "workflowContext") if key in plan}}


def check_scope(plan, packet, files):
    require(packet["planHash"] == definition_hash(plan), "Plan definition drift; reconcile before proceeding")
    phase = validate_plan(plan)[packet["phase"]["id"]]
    require(phase.get("status") not in {"stale", "blocked"}, "Reconcile the invalidated phase first")
    require(eligible(phase, validate_plan(plan)), "A phase dependency is no longer validated")
    for file in files:
        path = Path(file)
        require(not path.is_absolute() and ".." not in path.parts, "Invalid changed path")
        require(any(file.startswith(pattern) if pattern.endswith("/") else fnmatch.fnmatchcase(file, pattern)
                    for pattern in phase["allowedPaths"]), "Out-of-phase change: " + file)
    return phase


def check_validation(phase, tree, validation):
    require(validation.get("snapshotTree") == tree and validation.get("status") == "passed",
            "Validation is missing, failed, or stale")
    require(validation.get("productState") == "working", "Each phase must leave a working product")
    acceptance = validation.get("acceptance", [])
    require({item.get("criterion") for item in acceptance} == set(phase["acceptanceCriteria"])
            and len(acceptance) == len(phase["acceptanceCriteria"]), "Acceptance criteria are not fully covered")
    checks = validation.get("checks", [])
    require(isinstance(checks, list) and checks, "No validation checks recorded")
    for item in [*acceptance, *checks]:
        require(item.get("result") == "passed", "A required check did not pass")
        text(item.get("evidence"), "check evidence")
    for item in checks:
        text(item.get("command"), "check command")


def invalidate(plan, phase_id, reason):
    by_id = validate_plan(plan)
    require(phase_id in by_id, "Unknown phase")
    text(reason, "invalidation reason")
    affected = {phase_id}
    while True:
        expanded = affected | {key for key, phase in by_id.items() if affected.intersection(phase["dependsOn"])}
        if expanded == affected:
            break
        affected = expanded
    require(not any(by_id[key].get("status") == "merged" for key in affected),
            "Merged changes need a new corrective phase, not history rewriting")
    for key in affected:
        by_id[key].update(status="stale", invalidationReason=reason)
    return sorted(affected)


def publication_gate(plan, phase_id):
    if "phases" in plan:
        phase = validate_plan(plan).get(phase_id)
    else:
        phase = plan.get("phase")
        require(isinstance(phase, dict) and phase.get("id") == phase_id, "Invalid single-phase publication record")
    require(phase is not None and phase.get("status") in {"validated", "published"},
            "Only a validated phase may be published")
    require(plan["delivery"] == "pr", "PR publication is not in this plan's deliverable")
    text(phase.get("headSha"), "committed phase headSha")
    memory = plan.get("featureMemory")
    require(isinstance(memory, dict) and type(memory.get("required")) is bool,
            "Classify whether detailed team feature memory is required before opening a PR")
    text(memory.get("reason"), "feature-memory requirement/exemption reason")
    if not memory["required"]:
        require(memory.get("classification") in {"small-fix", "maintenance"},
                "A substantive feature cannot bypass team sharing as a small fix")
        return {"phase": phase_id, "featureMemory": "exempt", "reason": memory["reason"]}
    for key in ("team", "uri", "revision"):
        text(memory.get(key), "feature memory " + key)
    require(memory["uri"].startswith("threadnote://"), "Use the returned canonical shared-memory URI")
    receipt = memory.get("receipt", {})
    require(receipt.get("status") == "published" and receipt.get("team") == memory["team"]
            and receipt.get("uri") == memory["uri"] and receipt.get("revision") == memory["revision"]
            and receipt.get("sourceCommit") == phase["headSha"],
            "Feature memory has not been shared to the relevant team at the current revision/head")
    text(receipt.get("remoteCommit"), "confirmed team publication receipt")
    return {"phase": phase_id, "featureMemory": "shared", "team": memory["team"], "uri": memory["uri"]}


def learning_packet(reflection):
    for key in ("project", "callerCwd", "task", "phaseId", "sourceCommit"):
        text(reflection.get(key), key)
    require(Path(reflection["callerCwd"]).is_absolute(), "callerCwd must be absolute")
    retrieved = reflection.get("retrieved", [])
    for item in retrieved:
        require(text(item.get("uri"), "retrieved URI").startswith("threadnote://"), "Invalid memory URI")
        require(item.get("disposition") in {"used", "irrelevant", "stale", "contradicted"}, "Invalid retrieval disposition")
        text(item.get("outcome"), "retrieval outcome")
        if item["disposition"] == "used":
            text(item.get("check"), "preventive check actually run")
    lessons = {}
    for lesson in reflection.get("lessons", []):
        for key in ("scope", "trigger", "cause", "correction", "preventiveCheck", "failureEvidence"):
            text(lesson.get(key), key)
            require(len(lesson[key]) <= 800, "Store concise evidence pointers, not raw logs")
        require(lesson.get("status") in {"observed", "verified", "contradicted"}, "Invalid lesson status")
        if lesson["status"] == "verified":
            text(lesson.get("successEvidence"), "verified external success evidence")
        key = "G" + digest([reflection["project"], lesson["scope"], lesson["trigger"], lesson["cause"]])[:16]
        require(key not in lessons or lessons[key] == lesson, "Conflicting evidence for the same gotcha")
        lessons[key] = lesson
    preferences, candidates = [], []
    for item in reflection.get("projectPreferences", []):
        for key in ("key", "value", "source"):
            text(item.get(key), "preference " + key)
            require(len(item[key]) <= 800, "Keep preference evidence concise")
        if item.get("authority") not in {"explicit-user", "confirmed-user"}:
            candidates.append(item)
            continue
        payload = {"kind": "preference", "project": reflection["project"],
                   "callerCwd": reflection["callerCwd"],
                   "topic": "dev-cycle-preference-" + digest(item["key"])[:12],
                   "text": json.dumps({"preference": item["value"], "source": item["source"],
                                       "scope": reflection["project"], "authority": item["authority"]}),
                   "keywords": ["dev-cycle", "project-preference", item["key"]]}
        if item.get("replaceUri"):
            payload["replaceUri"] = item["replaceUri"]
        preferences.append(payload)
    metrics = {"retrieved": len(retrieved), "used": sum(item["disposition"] == "used" for item in retrieved),
               "recurred": sum(item["outcome"] == "recurred" for item in retrieved)}
    record = {"task": reflection["task"], "phase": reflection["phaseId"], "sourceCommit": reflection["sourceCommit"],
              "experience": lessons, "retrievalOutcomes": retrieved, "metrics": metrics,
              "next_step": reflection.get("nextStep", "Recall relevant experience and revalidate before reuse")}
    payload = {"kind": "handoff", "project": reflection["project"], "callerCwd": reflection["callerCwd"],
               "topic": "dev-cycle-experience-" + reflection["phaseId"] + "-" + digest(reflection["task"])[:10],
               "text": json.dumps(record, ensure_ascii=False),
               "keywords": sorted({"dev-cycle", *({"gotcha"} if lessons or retrieved else set()), *lessons}),
               "references": sorted({item["uri"] for item in retrieved})}
    require(len(payload["text"]) <= 12000, "Split experience by phase; do not store a transcript")
    if reflection.get("replaceUri"):
        payload["replaceUri"] = reflection["replaceUri"]
    return {"handoff": payload, "verifiedLessonIds": [key for key, item in lessons.items() if item["status"] == "verified"],
            "metrics": metrics, "preferences": preferences, "preferenceCandidates": candidates}


def closeout_packet(proposals):
    require(isinstance(proposals, list), "Proposals must be an array")
    pending, seen = [], set()
    for item in proposals:
        for key in ("id", "kind", "summary", "target", "preview"):
            text(item.get(key), "proposal " + key)
        require(item["id"] not in seen, "Duplicate proposal ID")
        seen.add(item["id"])
        if item.get("status", "pending") != "pending":
            continue
        if item["kind"] == "knowledge-delta":
            text(item.get("reviewId"), "reviewed Knowledge Delta ID")
            require(type(item.get("reviewRevision")) is int, "Knowledge Delta needs its reviewed revision")
            strings(item.get("candidateIds"), "Knowledge Delta candidate IDs", nonempty=True)
        pending.append(item)
    batch = pending[:3]
    return {"proposalIds": [item["id"] for item in batch],
            "proposalHashes": {item["id"]: digest(item) for item in batch},
            "remaining": [item["id"] for item in pending[3:]],
            "questions": [{"title": item["summary"] + "\nTarget: " + item["target"]
                                      + "\nReview: " + item["preview"] + "\nApply this proposal?",
                           "options": ["Approve", "Defer", "Reject"]} for item in batch]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("validate-plan", "next", "packet", "check-phase", "ready", "invalidate"):
        command = commands.add_parser(name)
        command.add_argument("--plan", type=Path, required=True)
        if name in {"packet", "invalidate"}:
            command.add_argument("--phase", required=True)
        if name == "packet":
            command.add_argument("--memories", type=Path)
            command.add_argument("--output", type=Path, required=True)
        if name in {"check-phase", "ready"}:
            command.add_argument("--packet", type=Path, required=True)
            command.add_argument("--snapshot", type=Path, required=True)
        if name == "ready":
            command.add_argument("--validation", type=Path, required=True)
            review = command.add_mutually_exclusive_group(required=True)
            review.add_argument("--review", type=Path)
            review.add_argument("--review-skipped")
            command.add_argument("--previous-review", type=Path)
        if name == "invalidate":
            command.add_argument("--reason", required=True)
    learn = commands.add_parser("learning-packet")
    learn.add_argument("--reflection", type=Path, required=True)
    learn.add_argument("--output", type=Path, required=True)
    publication = commands.add_parser("publication-ready")
    source = publication.add_mutually_exclusive_group(required=True)
    source.add_argument("--plan", type=Path)
    source.add_argument("--publication", type=Path)
    publication.add_argument("--phase", required=True)
    closeout = commands.add_parser("closeout-packet")
    closeout.add_argument("--proposals", type=Path, required=True)
    closeout.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command in {"learning-packet", "closeout-packet"}:
            if args.command == "learning-packet":
                result = learning_packet(read_json(args.reflection))
            else:
                result = closeout_packet(read_json(args.proposals))
            args.output.parent.mkdir(parents=True, exist_ok=True)
            write_json(args.output, result)
        elif args.command == "publication-ready":
            result = publication_gate(read_json(args.plan or args.publication), args.phase)
        else:
            plan = read_json(args.plan)
            by_id = validate_plan(plan)
            if args.command == "validate-plan":
                result = {"planHash": definition_hash(plan), "phases": list(by_id)}
            elif args.command == "next":
                result = {"phase": next_phase(plan)}
            elif args.command == "packet":
                result = make_packet(plan, args.phase, read_json(args.memories) if args.memories else {})
                args.output.parent.mkdir(parents=True, exist_ok=True)
                write_json(args.output, result)
            elif args.command == "invalidate":
                result = {"invalidated": invalidate(plan, args.phase, args.reason)}
                write_json(args.plan, plan)
            else:
                packet, snapshot = read_json(args.packet), read_json(args.snapshot / "snapshot.json")
                phase = check_scope(plan, packet, read_json(args.snapshot / "files.json"))
                result = {"phase": phase["id"], "status": "scope-verified"}
                if args.command == "ready":
                    check_validation(phase, snapshot["tree"], read_json(args.validation))
                    check(SimpleNamespace(repo=Path(snapshot["repo"]), snapshot=args.snapshot, accepted_head=None))
                    if args.review:
                        review = validate_review(SimpleNamespace(iteration=args.review, previous=args.previous_review))
                        require(review["blockingIssueCount"] == 0, "Blocking findings remain")
                        context = read_json(args.review / "review-context.json")
                        validation = read_json(args.validation)
                        require(context.get("phaseId") == phase["id"] and context.get("planHash") == packet["planHash"]
                                and validation.get("reviewTree") == review["snapshotTree"],
                                "Review belongs to a different phase, plan revision, or source tree")
                    else:
                        text(args.review_skipped, "review skip reason")
                    phase.update(status="validated", validatedTree=snapshot["tree"],
                                 validationFile=str(args.validation.resolve()),
                                 validationHash=hashlib.sha256(args.validation.read_bytes()).hexdigest(),
                                 validationPlanHash=packet["planHash"])
                    write_json(args.plan, plan)
                    result["status"] = "validated"
    except (ValueError, OSError, KeyError, TypeError) as error:
        parser.exit(1, "error: " + str(error) + "\n")
    print(json.dumps(result))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Capture local Git trees without changing the index; validate review artifacts."""
import sys
sys.dont_write_bytecode = True

import argparse
from collections import Counter
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


BLOCKING = {"critical", "important"}
SEVERITIES = BLOCKING | {"minor", "informational"}
CATEGORIES = {"security", "performance", "architecture", "quality", "flaky-test", "devex", "correctness"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def git(repo, *args, env=None):
    result = subprocess.run(
        ["git", "-C", str(repo), *args], capture_output=True,
        env=dict(os.environ, GIT_OPTIONAL_LOCKS="0", **(env or {})),
    )
    require(result.returncode == 0, result.stderr.decode(errors="replace").strip())
    return result.stdout


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path, value):
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n", dir=path.parent, delete=False) as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")
    os.replace(stream.name, path)


def root_and_head(repo):
    root = Path(os.fsdecode(git(repo, "rev-parse", "--show-toplevel")).strip()).resolve()
    head = git(root, "rev-parse", "--verify", "HEAD").decode().strip()
    return root, head


def local_exclude(repo):
    state_path = ".context/dev-cycle"
    require(not git(repo, "ls-files", "--", state_path), "Dev-cycle state must not be tracked")
    path = Path(os.fsdecode(git(repo, "rev-parse", "--git-path", "info/exclude")).strip())
    if not path.is_absolute():
        path = repo / path
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    rule = "/.context/dev-cycle/"
    if rule not in text.splitlines():
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8", newline="\n") as stream:
            stream.write("\n" + rule + "\n")


def capture(repo):
    require(not git(repo, "ls-files", "--unmerged"), "Resolve index conflicts before snapshotting")
    status = git(repo, "status", "--porcelain=v2", "-z", "--ignore-submodules=none")
    for record in status.split(b"\0"):
        if record[:2] in (b"1 ", b"2 "):
            sub = record.split(b" ", 3)[2]
            require(not (sub.startswith(b"S") and sub[2:] != b".."),
                    "Dirty submodule content needs a separate dev-cycle in that checkout")
    index = Path(os.fsdecode(git(repo, "rev-parse", "--git-path", "index")).strip())
    if not index.is_absolute():
        index = repo / index
    with tempfile.TemporaryDirectory(prefix="dev-cycle-index-") as temporary:
        temporary_index = Path(temporary) / "index"
        if index.exists():
            shutil.copyfile(index, temporary_index)
        env = {"GIT_INDEX_FILE": str(temporary_index)}
        git(repo, "add", "--all", "--", ".", env=env)
        # Rehash tracked bytes: copied index timestamps can hide same-size edits.
        git(repo, "add", "--renormalize", "--all", "--", ".", env=env)
        tree = git(repo, "write-tree", env=env).decode().strip()
        require(not git(repo, "ls-tree", "-r", "--name-only", tree, "--", ".context/dev-cycle"),
                "Repository ignore rules override the local dev-cycle exclusion")
        return tree


def snapshot(args):
    repo, head = root_and_head(args.repo)
    base = git(repo, "rev-parse", "--verify", args.base + "^{tree}").decode().strip()
    previous = read_json(args.previous / "snapshot.json") if args.previous else None
    if previous:
        require((previous["repo"], previous["baseTree"]) == (str(repo), base),
                "Previous snapshot belongs to a different checkout or review base")
        require(previous["head"] == head or args.accepted_head == head,
                "HEAD changed; reconcile it with the phase delivery ledger before accepting its SHA")
    output = args.output.resolve()
    require(output.is_relative_to(repo / ".context/dev-cycle"),
            "Output must be inside this checkout's .context/dev-cycle/")
    require(not output.exists(), "Snapshot directory already exists; snapshots are immutable")
    local_exclude(repo)
    tree = capture(repo)
    output.mkdir(parents=True)
    comparisons = [("diff.patch", "files.json", base)]
    if previous:
        comparisons.append(("delta.patch", "delta-files.json", previous["tree"]))
    for patch, files, old_tree in comparisons:
        (output / patch).write_bytes(git(repo, "diff", "--binary", "--no-ext-diff",
                                       "--no-textconv", "--no-renames", old_tree, tree, "--"))
        paths = git(repo, "diff", "--name-only", "--no-renames", "-z", old_tree, tree, "--")
        write_json(output / files, [os.fsdecode(path) for path in paths.split(b"\0") if path])
    metadata = {"schemaVersion": 1, "repo": str(repo), "head": head, "baseTree": base,
                "tree": tree, "previousTree": previous["tree"] if previous else None,
                "acceptedHead": args.accepted_head}
    write_json(output / "snapshot.json", metadata)
    return metadata


def check(args):
    repo, head = root_and_head(args.repo)
    saved = read_json(args.snapshot / "snapshot.json")
    require(saved["repo"] == str(repo), "Checkout changed")
    require(saved["head"] == head or args.accepted_head == head,
            "HEAD changed; reconcile it with the phase delivery ledger before accepting its SHA")
    require(capture(repo) == saved["tree"], "Source changed since the snapshot; do not reuse its verdict")
    return {"status": "unchanged", "tree": saved["tree"]}


def validate_review(args):
    directory = args.iteration
    (directory / "summary.json").unlink(missing_ok=True)
    saved = read_json(directory / "snapshot.json")
    report = read_json(directory / "review.json")
    findings = read_json(directory / "findings.json")
    selection = read_json(directory / "agent-selection.json")
    require(isinstance(report, dict), "review.json must be an object")
    require(report.get("status") == "complete", "Review is incomplete")
    require(report.get("snapshotTree") == saved["tree"], "Review snapshot identity mismatch")
    mode = "incremental" if args.previous else "full"
    require(report.get("reviewMode") == mode, "Review mode mismatch")
    lanes = report.get("lanes")
    require(isinstance(lanes, list) and lanes, "Every selected review lane must report completion")
    require(all(isinstance(lane, dict) and lane.get("name") and lane.get("status") == "complete"
                for lane in lanes), "A selected review lane failed or is incomplete")
    selected = selection.get("selected") if isinstance(selection, dict) else None
    require(isinstance(selected, list) and selected and all(isinstance(name, str) for name in selected),
            "agent-selection.json must list every selected lane, including orchestrator")
    names = [lane["name"] for lane in lanes]
    require(len(set(names)) == len(names) and len(set(selected)) == len(selected)
            and set(names) == set(selected) and "orchestrator" in selected,
            "Selected lanes and reported review coverage differ")
    require(isinstance(findings, list), "findings.json must be an array")
    previous = {}
    if args.previous:
        old = read_json(args.previous / "snapshot.json")
        require((old["repo"], old["baseTree"], old["tree"]) ==
                (saved["repo"], saved["baseTree"], saved["previousTree"])
                and (old["head"] == saved["head"] or saved.get("acceptedHead") == saved["head"]),
                "Previous review does not match the snapshot delta")
        previous = {finding["id"]: finding for finding in read_json(args.previous / "findings.json")}
    seen = set()
    for finding in findings:
        require(isinstance(finding, dict), "Each finding must be an object")
        for key in ("id", "file", "body", "trigger", "impact", "evidence"):
            require(isinstance(finding.get(key), str) and finding[key].strip(), "Missing finding " + key)
        key = finding["id"]
        require(key not in seen, "Duplicate finding ID: " + key)
        seen.add(key)
        path = Path(finding["file"])
        require(not path.is_absolute() and ".." not in path.parts, "Finding path must be repository-relative")
        require(type(finding.get("line")) is int and finding["line"] > 0, "Invalid source line")
        require(finding.get("severity") in SEVERITIES, "Invalid severity")
        require(finding.get("category") in CATEGORIES, "Invalid category")
        require(type(finding.get("confidence")) is int and 0 <= finding["confidence"] <= 100,
                "Invalid confidence")
        state = finding.get("state")
        require(state in {"new", "carried", "resolved", "rejected"}, "Invalid finding state")
        if state in {"resolved", "rejected"}:
            require(isinstance(finding.get("reason"), str) and finding["reason"].strip(),
                    "Resolved/rejected findings need a concrete reason")
        if state in {"carried", "resolved"}:
            require(key in previous, "Unknown prior finding: " + key)
        require(not (state == "new" and key in previous), "Prior finding must retain its identity/state")
        if key in previous and previous[key]["severity"] in BLOCKING and finding["severity"] not in BLOCKING:
            require(isinstance(finding.get("reason"), str) and finding["reason"].strip(),
                    "Downgrading a prior blocker needs an evidence-based reason")
    for key, finding in previous.items():
        if finding["severity"] in BLOCKING and finding["state"] in {"new", "carried"}:
            require(key in seen, "Prior blocker disappeared without a disposition: " + key)
    active = [finding for finding in findings if finding["state"] in {"new", "carried"}]
    counts = Counter(finding["severity"] for finding in active)
    blocking = sum(counts[severity] for severity in BLOCKING)
    summary = {"schemaVersion": 1, "snapshotTree": saved["tree"], "reviewMode": mode,
               "blockingIssueCount": blocking, "issueCount": blocking,
               "counts": {severity: counts[severity] for severity in sorted(SEVERITIES)},
               "agentSelection": [lane["name"] for lane in lanes]}
    for state in ("resolved", "new", "carried", "rejected"):
        summary[state] = [finding["id"] for finding in findings if finding["state"] == state]
    write_json(directory / "summary.json", summary)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    snap = commands.add_parser("snapshot")
    snap.add_argument("--repo", type=Path, required=True)
    snap.add_argument("--output", type=Path, required=True)
    snap.add_argument("--base", required=True)
    snap.add_argument("--previous", type=Path)
    snap.add_argument("--accepted-head", help="Exact current SHA already reconciled in the delivery ledger")
    verify = commands.add_parser("check")
    verify.add_argument("--repo", type=Path, required=True)
    verify.add_argument("--snapshot", type=Path, required=True)
    verify.add_argument("--accepted-head", help="Exact current SHA already reconciled in the delivery ledger")
    review = commands.add_parser("validate-review")
    review.add_argument("--iteration", type=Path, required=True)
    review.add_argument("--previous", type=Path)
    args = parser.parse_args()
    try:
        result = {"snapshot": snapshot, "check": check, "validate-review": validate_review}[args.command](args)
    except (ValueError, OSError, KeyError, TypeError) as error:
        parser.exit(1, "error: " + str(error) + "\n")
    print(json.dumps(result))


if __name__ == "__main__":
    main()

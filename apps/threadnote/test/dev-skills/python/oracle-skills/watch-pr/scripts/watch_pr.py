#!/usr/bin/env python3
"""Read-only GitHub satellite. Durable, body-free events; no model/API dependency."""
import sys
sys.dont_write_bytecode = True
from portable_lock import lock_exclusive
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import time
from urllib.parse import urlparse

PASS = {"success", "neutral", "skipped"}


def target(url):
    parsed = urlparse(url)
    match = re.fullmatch(r"/([\w.-]+)/([\w.-]+)/pull/([1-9][0-9]*)/?", parsed.path)
    if parsed.scheme != "https" or not parsed.hostname or not match or parsed.username or parsed.port:
        raise ValueError("Use an HTTPS GitHub PR URL without credentials or a port")
    if not re.fullmatch(r"[a-zA-Z0-9.-]+", parsed.hostname):
        raise ValueError("Invalid GitHub host")
    owner, repo, number = match.groups()
    return parsed.hostname, f"repos/{owner}/{repo}", number


def api(host, endpoint, collection=None):
    argv = ["gh", "api", "--hostname", host, endpoint]
    if collection is not None:
        argv += ["--paginate", "--slurp"]
    result = subprocess.run(argv, capture_output=True, timeout=45, check=False)
    if result.returncode:
        # Never propagate authenticated API stderr or arbitrary response bodies.
        raise RuntimeError("GitHub API request failed; check gh authentication/access and rate limits")
    if len(result.stdout) > 16 * 1024 * 1024:
        raise RuntimeError("GitHub API response exceeds the satellite limit")
    value = json.loads(result.stdout)
    if collection is None:
        return value
    return [item for page in value for item in (page[collection] if collection else page)]


def snapshot(url):
    host, repo, number = target(url)
    pr = api(host, f"{repo}/pulls/{number}")
    head = pr["head"]["sha"]
    if pr["state"] != "open":
        return {"pr": pr, "checks": [], "statuses": [], "activity": {}}
    checks = api(host, f"{repo}/commits/{head}/check-runs?filter=latest&per_page=100", "check_runs")
    # Combined status pagination returns the latest status for each context.
    statuses = api(host, f"{repo}/commits/{head}/status?per_page=100", "statuses")
    activity = {
        "comment": api(host, f"{repo}/issues/{number}/comments?per_page=100", ""),
        "review_comment": api(host, f"{repo}/pulls/{number}/comments?per_page=100", ""),
        "review": api(host, f"{repo}/pulls/{number}/reviews?per_page=100", ""),
    }
    return {"pr": pr, "checks": checks, "statuses": statuses, "activity": activity}


def transition(previous, snap, now, settle=60):
    """Pure state machine: baseline activity, monotonic IDs, head-scoped CI."""
    pr = snap["pr"]
    head = pr["head"]["sha"]
    state = dict(previous)
    events = []

    def emit(kind, **fields):
        events.append({"kind": kind, "head": head, "pr": pr["html_url"], **fields})

    if previous.get("head") and previous["head"] != head:
        emit("head_changed", previous_head=previous["head"])
    if previous.get("head") != head:
        state.update(head=head, failures=[], complete_key=None, settled_key=None, settled_since=now)
    if pr.get("merged") or pr["state"] == "closed":
        kind = "merged" if pr.get("merged") else "closed"
        if previous.get("terminal") != kind:
            emit(kind)
        state["terminal"] = kind
        return state, events

    seen = dict(previous.get("activity", {}))
    for kind, items in snap["activity"].items():
        for item in items:
            key = f"{kind}:{item['id']}"
            version = [item.get("updated_at") or item.get("submitted_at"), item.get("state")]
            if previous.get("initialized") and seen.get(key) != version:
                emit(kind, id=item["id"], url=item.get("html_url"), state=item.get("state"))
            seen[key] = version
    state["activity"] = seen
    # GitHub exposes historical reviews; only the latest per reviewer blocks.
    latest_reviews = {}
    for review in snap["activity"].get("review", []):
        user = review.get("user") or {}
        if review.get("state") in {"APPROVED", "CHANGES_REQUESTED", "DISMISSED"}:
            latest_reviews[user.get("id", review["id"])] = review
    blocked = sorted(r["id"] for r in latest_reviews.values() if r["state"] == "CHANGES_REQUESTED")
    if blocked and blocked != previous.get("blocked_reviews"):
        emit("review_blocked", review_ids=blocked)
    state["blocked_reviews"] = blocked

    failures = []
    pending = False
    signature = []
    for check in snap["checks"]:
        signature.append(["check", check["id"], check["status"], check.get("conclusion")])
        if check["status"] != "completed":
            pending = True
        elif check.get("conclusion") not in PASS:
            failures.append({"source": "check", "id": check["id"], "name": check["name"][:200],
                             "result": check.get("conclusion"), "url": check.get("html_url")})
    for status in snap["statuses"]:
        signature.append(["status", status["id"], status["state"]])
        if status["state"] == "pending":
            pending = True
        elif status["state"] != "success":
            failures.append({"source": "status", "id": status["id"], "name": status["context"][:200],
                             "result": status["state"], "url": status.get("target_url")})
    failure_keys = sorted(f"{f['source']}:{f['id']}:{f['result']}" for f in failures)
    if failures and failure_keys != state.get("failures"):
        emit("ci_error", failures=failures[:100])
    state["failures"] = failure_keys
    signature.sort(key=lambda value: (value[0], value[1]))
    key = json.dumps([head, signature, pr.get("mergeable_state"), bool(blocked)], sort_keys=True)
    if state.get("settled_key") != key:
        state.update(settled_key=key, settled_since=now)
    complete = bool(signature) and not pending
    if complete and now - state["settled_since"] >= settle and state.get("complete_key") != key:
        ready = not failures and not blocked and not pr.get("draft") and pr.get("mergeable") is True
        ready = ready and pr.get("mergeable_state") == "clean"
        emit("ci_complete", ready=ready, checks=len(signature), failed=len(failures))
        state["complete_key"] = key
    state["initialized"] = True
    return state, events


def read_json(path, default):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default


def save(path, value):
    temporary = path.with_name(path.name + f".{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, sort_keys=True), encoding="utf-8")
    os.replace(temporary, path)


def emit(directory, events):
    with (directory / "inbox.lock").open("a+b") as lock:
        lock_exclusive(lock)
        with (directory / "events.jsonl").open("a", encoding="utf-8", newline="\n") as stream:
            for event in events:
                stream.write(json.dumps({"at": time.time(), **event}) + "\n")
            stream.flush()
            os.fsync(stream.fileno())


def live(directory):
    with (directory / "watch.lock").open("a+b") as lock:
        try:
            lock_exclusive(lock, blocking=False)
            return False
        except BlockingIOError:
            return True


def drain(directory):
    with (directory / "inbox.lock").open("a+b") as lock:
        lock_exclusive(lock)
        pending = read_json(directory / "delivery.json", {})
        if pending and not pending.get("acked"):
            raise ValueError("A relay delivery is pending; record it and acknowledge its ID first")
        cursor = read_json(directory / "cursor.json", 0)
        path = directory / "events.jsonl"
        with path.open("rb") if path.exists() else open(os.devnull, "rb") as stream:
            stream.seek(cursor)
            # Bound each delivery; remaining events are consumed next time.
            events = [json.loads(line) for _, line in zip(range(100), stream)]
            save(directory / "cursor.json", stream.tell())
    state = read_json(directory / "state.json", {})
    return {"events": events, "running": live(directory), "last_poll": state.get("last_poll"),
            "terminal": state.get("terminal")}


def relay(directory):
    """Persist a replayable delivery before advancing the inbox; no GitHub calls."""
    with (directory / "inbox.lock").open("a+b") as lock:
        lock_exclusive(lock)
        packet = read_json(directory / "delivery.json", {})
        if not packet or packet.get("acked"):
            cursor = read_json(directory / "cursor.json", 0)
            path = directory / "events.jsonl"
            with path.open("rb") if path.exists() else open(os.devnull, "rb") as stream:
                stream.seek(cursor)
                events = [json.loads(line) for _, line in zip(range(100), stream)]
                end = stream.tell()
            packet = {"delivery_id": f"{cursor}:{end}", "events": events, "end": end}
            if events:
                save(directory / "delivery.json", packet)
    state = read_json(directory / "state.json", {})
    return {"events": packet["events"], "delivery_id": packet["delivery_id"] if packet["events"] else None,
            "running": live(directory), "last_poll": state.get("last_poll"), "terminal": state.get("terminal")}


def ack(directory, delivery_id):
    with (directory / "inbox.lock").open("a+b") as lock:
        lock_exclusive(lock)
        packet = read_json(directory / "delivery.json", {})
        if not delivery_id or packet.get("delivery_id") != delivery_id:
            raise ValueError("Acknowledgement does not match the pending delivery")
        save(directory / "cursor.json", packet["end"])
        save(directory / "delivery.json", {**packet, "acked": True})
    return {"acked": delivery_id}


def watch(args, directory):
    with (directory / "watch.lock").open("a+b") as lock:
        lock_exclusive(lock, blocking=False)
        state = read_json(directory / "state.json", {})
        if state.get("pr") not in {None, args.pr}:
            raise ValueError("State directory belongs to a different PR")
        state.update(pr=args.pr, pid=os.getpid(), terminal=None)
        save(directory / "state.json", state)
        deadline = time.monotonic() + args.max_hours * 3600
        errors = 0
        while time.monotonic() < deadline and not (directory / "stop").exists():
            try:
                state, events = transition(state, snapshot(args.pr), time.time())
                state["last_poll"] = time.time()
                emit(directory, events)
                save(directory / "state.json", state)
                errors = 0
                if state.get("terminal"):
                    return
            except (RuntimeError, subprocess.TimeoutExpired, json.JSONDecodeError, KeyError) as error:
                errors += 1
                if errors >= 3:
                    emit(directory, [{"kind": "watcher_error", "pr": args.pr,
                                      "reason": type(error).__name__, "consecutive_errors": errors}])
                    return
            # Cooperative stop, without waiting a full polling/backoff interval.
            next_poll = time.monotonic() + min(args.interval * 2 ** errors, 600)
            while time.monotonic() < min(next_poll, deadline) and not (directory / "stop").exists():
                time.sleep(min(1, max(0, next_poll - time.monotonic())))
        if not (directory / "stop").exists():
            emit(directory, [{"kind": "watcher_timeout", "pr": args.pr}])


def detached_options():
    """Detach without requiring a POSIX session on native Windows."""
    if os.name == "nt":
        return {"creationflags": subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP}
    return {"start_new_session": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["start", "watch", "drain", "wait", "relay", "ack", "stop"])
    parser.add_argument("--pr")
    parser.add_argument("--state-dir", required=True, type=Path)
    parser.add_argument("--interval", type=float, default=60)
    parser.add_argument("--max-hours", type=float, default=24)
    parser.add_argument("--timeout", type=float, default=55)
    parser.add_argument("--delivery-id")
    args = parser.parse_args()
    if not args.state_dir.is_absolute() or args.interval < 1 or args.max_hours <= 0 or not 0 <= args.timeout <= 60:
        parser.error("Use an absolute private state dir, interval >=1, positive max-hours, timeout 0..60")
    os.umask(0o077)
    directory = args.state_dir
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    if args.command in {"start", "watch"}:
        if not args.pr:
            parser.error("--pr is required to start/watch")
        target(args.pr)
        state = read_json(directory / "state.json", {})
        if state.get("pr") not in {None, args.pr}:
            parser.error("State directory belongs to a different PR")
    if args.command == "start":
        with (directory / "start.lock").open("a+b") as startup:
            lock_exclusive(startup, blocking=False)
            if live(directory):
                parser.error("A satellite already owns this state directory")
            (directory / "stop").unlink(missing_ok=True)
            with (directory / "satellite.log").open("a") as log:
                child = subprocess.Popen([sys.executable, "-B", str(Path(__file__).resolve()), "watch", "--pr", args.pr,
                                          "--state-dir", str(directory), "--interval", str(args.interval),
                                          "--max-hours", str(args.max_hours)], stdin=subprocess.DEVNULL,
                                         stdout=log, stderr=log, **detached_options())
            for _ in range(100):
                if live(directory):
                    print(json.dumps({"pid": child.pid, "state_dir": str(directory), "started": True}))
                    return
                if child.poll() is not None:
                    parser.error("Satellite exited during startup; inspect its local log")
                time.sleep(0.02)
            parser.error("Satellite did not acquire its ownership lock")
    elif args.command == "watch":
        watch(args, directory)
    elif args.command == "stop":
        (directory / "stop").touch(mode=0o600)
        print(json.dumps({"stop_requested": True}))
    elif args.command == "ack":
        print(json.dumps(ack(directory, args.delivery_id)))
    else:
        deadline = time.monotonic() + (args.timeout if args.command in {"wait", "relay"} else 0)
        while True:
            result = relay(directory) if args.command == "relay" else drain(directory)
            if result["events"] or not result["running"] or time.monotonic() >= deadline:
                print(json.dumps(result))
                return
            time.sleep(min(0.5, max(0, deadline - time.monotonic())))


if __name__ == "__main__":
    main()

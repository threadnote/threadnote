import json
import math
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path

capture = Path(sys.argv[1])
data = json.loads(capture.read_text())
raw = defaultdict(list)
for line in Path(f"{capture}.stages.jsonl").read_text().splitlines():
    event = json.loads(line)
    raw[event["request"]].append(event)


def distribution(values):
    values = sorted(values)
    if not values:
        return {"n": 0}
    return {
        "n": len(values),
        "median": round(statistics.median(values), 3),
        "p95": round(values[math.ceil(0.95 * len(values)) - 1], 3),
        "max": round(values[-1], 3),
    }


operations = ("vector-state", "vector-scores")
observations = {}
by_arm = defaultdict(list)
rounds = defaultdict(dict)

for arm in data["arms"]:
    pair = arm["pair"]
    name = arm["backend"]
    rounds[pair][name] = []
    for sample in arm["samples"]:
        identity = (pair, sample["sample"])
        entry = {
            "milliseconds": sample["milliseconds"],
            "exact": sample["success"],
            "reason": sample.get("reason"),
        }
        by_arm[name].append(entry)
        rounds[pair][name].append(entry)
        observations[name, *identity] = entry
        if not (name.endswith("-trace") and sample["success"]):
            continue
        request = f"warm/{pair}/{name}/{sample['sample']}"
        events = raw[request]
        children = {child["operation"]: child for child in sample["children"]}
        if len(events) != 2 or len({event["pid"] for event in events}) != 2 or set(children) != set(operations):
            raise ValueError(f"Expected two owned worker records for {request}")
        for operation in operations:
            decoded = f"decoded-{operation}"
            event, = (event for event in events if decoded in event["marks"])
            marks = event["marks"]
            if not 0 <= marks["entry"] <= marks["read"] <= marks[decoded] <= marks["served"] <= marks["written"]:
                raise ValueError(f"Unexpected marker order for {request} {operation}")
            launch = children[operation]["launchEpochMilliseconds"]
            entry[operation] = {
                "entryToRead": marks["read"] - marks["entry"],
                "entryToDecode": marks[decoded] - marks["entry"],
                "launchToRead": (event["timeOrigin"] - launch) + marks["read"],
                "launchToDecode": (event["timeOrigin"] - launch) + marks[decoded],
                "decodeToServe": marks["served"] - marks[decoded],
                "decodeToWritten": marks["written"] - marks[decoded],
                "ownedCommand": children[operation]["milliseconds"],
            }
            trace = entry[operation]
            if not -2 <= trace["launchToRead"] <= trace["launchToDecode"] <= trace["ownedCommand"] + 2:
                raise ValueError(f"Parent and child benchmark clocks did not correlate for {request} {operation}")
        for metric in entry[operations[0]]:
            entry[metric] = sum(entry[operation][metric] for operation in operations)


def report(entries):
    exact = [entry for entry in entries if entry["exact"]]
    traced = [entry for entry in exact if operations[0] in entry]
    result = {
        "exact": len(exact),
        "requests": len(entries),
        "failures": dict(Counter(entry["reason"] for entry in entries if not entry["exact"])),
        "endToEndExact": distribution(entry["milliseconds"] for entry in exact),
        "endToEndAllAttempts": distribution(entry["milliseconds"] for entry in entries),
    }
    if traced:
        measures = tuple(traced[0][operations[0]])
        result["combinedWorkers"] = {key: distribution(entry[key] for entry in traced) for key in measures}
        result["byWorker"] = {
            operation: {key: distribution(entry[operation][key] for entry in traced) for key in measures}
            for operation in operations
        }
    return result


def matched(stock, candidate):
    exact_pairs = [
        (entry, match)
        for (backend, pair, sample), entry in observations.items()
        if backend == stock and entry["exact"]
        and (match := observations.get((candidate, pair, sample), {})).get("exact")
    ]
    measures = ["milliseconds"]
    if stock.endswith("-trace"):
        measures += ["entryToRead", "entryToDecode", "launchToRead", "launchToDecode", "decodeToWritten", "ownedCommand"]
    return {
        metric: distribution(candidate[metric] - stock[metric] for stock, candidate in exact_pairs)
        for metric in measures
    }


if not all(data[key] for key in ("sourceStable", "fixtureStable", "distributionStable", "modelStable")):
    raise ValueError("Source, fixture, distribution or model changed")
expected = data["configuration"]["pairs"] * data["configuration"]["samples"]
if len(by_arm) != 4 or any(len(entries) != expected for entries in by_arm.values()):
    raise ValueError("Expected every arm and matched round")
if data["configuration"]["documents"] == 2 and any(not entry["exact"] for entries in by_arm.values() for entry in entries):
    raise ValueError("Smoke observed a non-exact request")

print(json.dumps({
    "arms": {arm: report(entries) for arm, entries in by_arm.items()},
    "rounds": {pair: {arm: report(entries) for arm, entries in arms.items()} for pair, arms in rounds.items()},
    "matchedCandidateMinusStock": {
        "control": matched("baseline", "candidate"),
        "traced": matched("baseline-trace", "candidate-trace"),
    },
}, indent=2))

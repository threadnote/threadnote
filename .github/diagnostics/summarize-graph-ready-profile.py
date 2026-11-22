"""Retain path-free, inclusive sample counts from one disposable CPU capture."""

import hashlib
import json
import sys
from collections import Counter
from pathlib import Path


profile_path, benchmark_path, source_root, output_path = map(Path, sys.argv[1:])
profile_bytes = profile_path.read_bytes()
profile = json.loads(profile_bytes)
benchmark = json.loads(benchmark_path.read_bytes())
metadata = benchmark["metadata"]
environment = benchmark["environment"]
assert profile["samples"], "CPU profiler produced no samples"
assert environment["commit"] == metadata["benchmarkMeasuredSourceCommit"]
assert not environment["dirty"] and metadata["benchmarkGoverned"]

query_path = "packages/graph/src/store/queries.ts"
query_source = (source_root / query_path).read_text().splitlines()
candidate_start = next(i for i, line in enumerate(query_source) if "const termStatement =" in line)
candidate_end = next(i for i, line in enumerate(query_source) if "const candidateScores =" in line)

frames = {node["id"]: node["callFrame"] for node in profile["nodes"]}
parents = {child: node["id"] for node in profile["nodes"] for child in node.get("children", [])}
counts = dict.fromkeys(
    ["graphInspect", "readyStatus", "lexicalSearch", "candidateSqlCallsite", "symbolHydration",
     "sqliteAdapter", "sqliteWithLexicalSearch", "compactMcpProjection"],
    0,
)
for node, occurrences in Counter(profile["samples"]).items():
    stages = set()
    while node in frames:
        frame = frames[node]
        name = frame["functionName"].lower()
        url = frame["url"]
        line = frame["lineNumber"]
        if "inspectreadygraph" in name or "traversalquery" in name:
            stages.add("graphInspect")
        if "readscopedreadystatus" in name or "readcodegraphstatus" in name:
            stages.add("readyStatus")
        if "selectsearchsymbolswithsql" in name or "codegraphtermcandidatequerystatement" in name:
            stages.add("lexicalSearch")
        if "selectsymbolsbyidswithsql" in name:
            stages.add("symbolHydration")
        if url.endswith(query_path) and candidate_start <= line < candidate_end:
            stages.update(("lexicalSearch", "candidateSqlCallsite"))
        if "sql-sqlite-bun" in url or "bun:sqlite" in url:
            stages.add("sqliteAdapter")
        if "codegraphmcpresponse" in name:
            stages.add("compactMcpProjection")
        node = parents.get(node)
    if "sqliteAdapter" in stages and stages & {"lexicalSearch", "symbolHydration"}:
        stages.add("sqliteWithLexicalSearch")
    for stage in stages:
        counts[stage] += occurrences

metric_names = {
    "hot-query-process-cpu", "hot-deferred-ready-query-orchestration-process-cpu",
    "hot-deferred-ready-query-orchestration", "mcp-query-duration",
}
summary = {
    "kind": "profiling-diagnostic-not-gate-evidence",
    "source": metadata["benchmarkMeasuredSourceCommit"],
    "provenance": metadata["benchmarkSourceValidationMode"],
    "dirty": environment["dirty"],
    "governedFixture": metadata["benchmarkGoverned"],
    "runner": metadata["runnerIdentity"],
    "runnerKey": metadata["sameRunnerComparisonKey"],
    "fixtureHash": environment["fixtureHash"],
    "fixtureShape": [metadata[key] for key in ("coldFiles", "coldSymbols", "coldEdges")],
    "queryDigests": [
        metadata[f"primaryQueryStructuralDigest{phase}"]
        for phase in ("Cold", "Incremental", "SameOverlayReference")
    ],
    "sampleIntervalMicros": 1000,
    "totalSamples": len(profile["samples"]),
    "inclusiveStageSamples": counts,
    "sampleInterpretation": "Whole-run, overlapping stack counts. Missing ancestry is not a zero-cost result.",
    "inputProfileSha256": hashlib.sha256(profile_bytes).hexdigest(),
    "profiledMetrics": [
        {key: metric[key] for key in ("name", "p95", "unit")}
        for metric in benchmark["measurements"]
        if metric["name"] in metric_names
    ],
}
output_path.write_text(json.dumps(summary, indent=2) + "\n")

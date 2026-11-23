"""Add report-only probes to untracked copies of the benchmark scripts."""
from pathlib import Path

def copy(name, old, new):
    original = Path("scripts") / name
    contents = original.read_text()
    assert contents.count(old)==1, name
    (original.parent/("r5-rss-"+name)).write_text(contents.replace(old,new))

copy("benchmark-recall-vectors.ts","from './benchmark-code-graph.js'","from './r5-rss-benchmark-code-graph.js'")
copy("benchmark-code-graph.ts","new URL('./code-graph-benchmark-sampler.ts',","new URL('./r5-rss-code-graph-benchmark-sampler.ts',")
copy("code-graph-benchmark-sampler.ts","from './windows-process-tree-sampler.js'","from './r5-rss-windows-process-tree-sampler.js'")
copy("windows-process-tree-sampler.ts","new URL('./windows-process-tree-sampler.ps1',","new URL('./r5-rss-windows-process-tree-sampler.ps1',")
marker="    # Bounded categories only:"
copy("windows-process-tree-sampler.ps1",marker,"""
    $category = 'exception'
    foreach ($known in @('identity-race','parent-identity-race','root-identity-changed','creation-time-unavailable','duplicate-process','cyclic-process-tree','tree-limit')) {
      if ($_.Exception.Message -eq $known) { $category = $known }
    }
    $kind = $_.Exception.GetBaseException().GetType().Name
    $role = if ($rootId -eq $entryId) { 'root' } else { 'descendant' }
    $diagnostic = @{reason=$failure;role=$role;site=$_.InvocationInfo.ScriptLineNumber;type=$kind;category=$category;sequence=$request.id}
    $log = Join-Path $env:R5_RSS_DIAGNOSTIC_DIRECTORY ("helper-" + $PID + ".jsonl")
    [IO.File]::AppendAllText($log, ($diagnostic | ConvertTo-Json -Compress) + [Environment]::NewLine)
"""+marker)

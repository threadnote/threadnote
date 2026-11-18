# One owned PowerShell process serves serialized recursive working-set observations.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$culture = [Globalization.CultureInfo]::InvariantCulture
function Write-Reply($value) {
  [Console]::Out.WriteLine(($value | ConvertTo-Json -Depth 8 -Compress))
  [Console]::Out.Flush()
}
Write-Reply @{protocol=1; kind='ready'; processId=$PID}
while ($null -ne ($line = [Console]::In.ReadLine())) {
  if ([Text.Encoding]::UTF8.GetByteCount($line) -gt 65536) { exit 2 }
  $request = $null
  $failure = 'process-inspection-failed'
  try {
    $request = $line | ConvertFrom-Json
    if ($request.protocol -ne 1 -or $request.id -notmatch '^[1-9][0-9]{0,14}$' -or
        $request.rootProcessId -lt 1 -or $request.rootProcessId -gt [int]::MaxValue) { exit 2 }
    $rootId = [int]$request.rootProcessId
    $rows = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate)
    $byId = @{}
    $children = @{}
    foreach ($row in $rows) {
      $rowId = [int]$row.ProcessId
      if ($byId.ContainsKey($rowId)) { throw 'duplicate-process' }
      $byId[$rowId] = $row
      $parentId = [int]$row.ParentProcessId
      if (-not $children.ContainsKey($parentId)) { $children[$parentId] = [Collections.Generic.List[int]]::new() }
      $children[$parentId].Add($rowId)
    }
    if (-not $byId.ContainsKey($rootId)) { $failure = 'root-exited'; throw 'root-unavailable' }
    $pending = [Collections.Generic.Queue[int]]::new()
    $pending.Enqueue($rootId)
    $seen = @{}
    $entries = [Collections.Generic.List[object]]::new()
    while ($pending.Count -gt 0) {
      $entryId = $pending.Dequeue()
      if ($seen.ContainsKey($entryId)) { throw 'cyclic-process-tree' }
      $seen[$entryId] = $true
      if ($seen.Count -gt 4096) { throw 'tree-limit' }
      $row = $byId[$entryId]
      if ($null -eq $row.CreationDate) { throw 'creation-time-unavailable' }
      $process = $null
      $after = $null
      try {
        $process = [Diagnostics.Process]::GetProcessById($entryId)
        $ticks = $process.StartTime.ToUniversalTime().Ticks
        $cimTicks = ([DateTime]$row.CreationDate).ToUniversalTime().Ticks
        # CIM's datetime has microsecond precision; GetProcessTimes/.NET retains 100ns.
        if ([Math]::Abs([decimal]$ticks - [decimal]$cimTicks) -ge 10) { throw 'identity-race' }
        $identity = 'win32:' + $ticks.ToString($culture)
        if ($entryId -eq $rootId -and $request.expectedRootIdentity -and
            $identity -ne $request.expectedRootIdentity) { $failure = 'root-identity-changed'; throw 'root-identity-changed' }
        $process.Refresh()
        $rss = $process.WorkingSet64
        $cpu = $process.TotalProcessorTime.Ticks
        $after = [Diagnostics.Process]::GetProcessById($entryId)
        if ($after.StartTime.ToUniversalTime().Ticks -ne $ticks -or $process.HasExited) { throw 'identity-race' }
        if ($entryId -ne $rootId) {
          $parent = $byId[[int]$row.ParentProcessId]
          if ($null -eq $parent -or $null -eq $parent.CreationDate -or
              $cimTicks -lt ([DateTime]$parent.CreationDate).ToUniversalTime().Ticks) { throw 'parent-identity-race' }
        }
        $entries.Add(@{processId=$entryId; parentProcessId=[int]$row.ParentProcessId;
          startIdentity=$identity; rssBytes=$rss.ToString($culture); cpuTicks=$cpu.ToString($culture)})
      } finally {
        if ($null -ne $after) { $after.Dispose() }
        if ($null -ne $process) { $process.Dispose() }
      }
      if ($children.ContainsKey($entryId)) {
        foreach ($childId in $children[$entryId]) { $pending.Enqueue($childId) }
      }
    }
    $rootAfter = [Diagnostics.Process]::GetProcessById($rootId)
    try {
      if ('win32:' + $rootAfter.StartTime.ToUniversalTime().Ticks.ToString($culture) -ne $entries[0].startIdentity) {
        $failure = 'root-identity-changed'; throw 'root-identity-changed'
      }
    } finally { $rootAfter.Dispose() }
    Write-Reply @{protocol=1; kind='sample'; id=[string]$request.id; ok=$true; entries=@($entries.ToArray())}
  } catch {
    if ($null -eq $request) { exit 2 }
    # Bounded categories only: process names, command lines and CIM exception text are not emitted.
    Write-Reply @{protocol=1; kind='sample'; id=[string]$request.id; ok=$false; reason=$failure}
  }
}

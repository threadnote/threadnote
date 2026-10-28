# Temporary D17 controller. Synthetic checks run before the sole original H100 launch.
[CmdletBinding()]
param([switch]$QualifyOnly)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'Windows only; no local substitute capture' }
# Bind native child cwd to the checkout containing this reviewed controller, not native inherited cwd.
$expectedCheckout = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).ProviderPath
$checkoutCandidate = if ($env:GITHUB_WORKSPACE) { $env:GITHUB_WORKSPACE } else { $PWD.Path }
$reviewedCheckout = (Resolve-Path -LiteralPath $checkoutCandidate).ProviderPath
$reviewedCheckout = [IO.Path]::TrimEndingDirectorySeparator($reviewedCheckout)
if (-not [string]::Equals($reviewedCheckout, [IO.Path]::TrimEndingDirectorySeparator($expectedCheckout), [StringComparison]::OrdinalIgnoreCase)) {
  throw 'working directory differs from reviewed controller checkout'
}

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
public sealed class H100Output : MemoryStream {
  readonly int cap; readonly string fault;
  public H100Output(int cap, string fault) { this.cap=cap; this.fault=fault; }
  public override void Write(byte[] b, int o, int n) {
    if (fault=="Write") throw new IOException("injected write fault");
    if (Length+n>cap) throw new IOException("output cap");
    long before=Length;
    base.Write(b,o,fault=="ShortWrite" && n>0?n-1:n);
    if (Length-before!=n) throw new IOException("short write");
  }
  public override Task WriteAsync(byte[] b,int o,int n,CancellationToken ct) {
    try { Write(b,o,n); return Task.CompletedTask; } catch(Exception e) { return Task.FromException(e); }
  }
  public override ValueTask WriteAsync(ReadOnlyMemory<byte> b,CancellationToken ct=default) {
    try { byte[] a=b.ToArray(); Write(a,0,a.Length); return ValueTask.CompletedTask; }
    catch(Exception e) { return ValueTask.FromException(e); }
  }
}
public sealed class H100CopyFault : Stream {
  public override bool CanRead=>true; public override bool CanWrite=>false; public override bool CanSeek=>false;
  public override long Length=>throw new NotSupportedException();
  public override long Position { get=>throw new NotSupportedException(); set=>throw new NotSupportedException(); }
  public override int Read(byte[] b,int o,int n)=>throw new IOException("injected copy fault");
  public override Task<int> ReadAsync(byte[] b,int o,int n,CancellationToken ct)=>Task.FromException<int>(new IOException("injected copy fault"));
  public override void Flush(){} public override long Seek(long o,SeekOrigin s)=>throw new NotSupportedException();
  public override void SetLength(long n)=>throw new NotSupportedException();
  public override void Write(byte[] b,int o,int n)=>throw new NotSupportedException();
}
'@

function Invoke-OwnedH100([string[]]$Arguments, [int]$LimitMs, [string]$Fault = 'None', [bool]$Profile = $false) {
  $info = [Diagnostics.ProcessStartInfo]::new((Get-Command bun -CommandType Application).Source)
  $info.WorkingDirectory = $reviewedCheckout
  $info.UseShellExecute = $false
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) }
  foreach ($key in @('GITHUB_TOKEN', 'GH_TOKEN')) { [void]$info.Environment.Remove($key) }
  if ($Profile) { $info.Environment['THREADNOTE_NATIVE_CPU_PROFILE'] = '1' }
  else { [void]$info.Environment.Remove('THREADNOTE_NATIVE_CPU_PROFILE') }
  $runner = [Diagnostics.Process]::new()
  $runner.StartInfo = $info
  $owned = [Collections.Generic.List[object]]::new()
  $stdout = [H100Output]::new($(if ($Fault -eq 'Cap') {2048} else {8MB}), $Fault)
  $stderr = [H100Output]::new(8MB, 'None')
  $copies = @()
  $originalExit = $null
  $forced = $false
  $outputFault = $false
  $identityFault = $Fault -eq 'Ambiguous'
  $discoveryTruncated = $false
  $controllerFault = $false
  $cleanupMs = 0
  $returnVerified = $false
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $cleanup = $null
  $rootBunImage = $null
  $discovery = @{nonBunObserved=0}
  # Only the runner and verified same-image Bun descendants consume retained slots.
  # Other images are snapshot-only exclusions; rooted Kill(true) contains their trees.
  function Discover-Owned {
    $discoveryClock = [Diagnostics.Stopwatch]::StartNew()
    try {
      if (-not $rootBunImage -or ($cleanup -and $cleanup.ElapsedMilliseconds -ge 15000)) { $script:discoveryInvalid = $true; return }
      $rows = @(Get-CimInstance Win32_Process -OperationTimeoutSec 1)
      $nonBun = @{}
      for ($depth = 0; $depth -lt 8; $depth++) {
        $added = $false
        foreach ($row in $rows) {
          if ($discoveryClock.ElapsedMilliseconds -ge 1000 -or ($cleanup -and $cleanup.ElapsedMilliseconds -ge 15000)) { $script:discoveryInvalid = $true; return }
          if (@($owned | Where-Object Id -eq $row.ProcessId).Count -or $nonBun.ContainsKey([int]$row.ProcessId)) { continue }
          $parents = @($owned | Where-Object Id -eq $row.ParentProcessId)
          $parentIsBun = $parents.Count -eq 1
          if (-not $parentIsBun -and -not $nonBun.ContainsKey([int]$row.ParentProcessId)) { continue }
          $parent = if ($parentIsBun) {$parents[0]} else {$nonBun[[int]$row.ParentProcessId]}
          $born = $row.CreationDate.ToUniversalTime().Ticks
          if ($born -lt $parent.Start) { continue }
          if ($parentIsBun -and $parent.Process.HasExited -and $born -gt $parent.Process.ExitTime.ToUniversalTime().Ticks) { continue }
          if ([string]::IsNullOrEmpty($row.ExecutablePath)) { $script:discoveryInvalid = $true; continue }
          $image = [IO.Path]::GetFullPath($row.ExecutablePath)
          if (-not [string]::Equals($image, $rootBunImage, [StringComparison]::OrdinalIgnoreCase)) {
            # Rebuilt per snapshot; thousands of sequential Git children never accumulate handles.
            if ($nonBun.Count -ge 128) { $script:discoveryOverflow = $true; return }
            $nonBun[[int]$row.ProcessId] = [pscustomobject]@{Start=$born}
            $discovery.nonBunObserved++
            $added = $true
            continue
          }
          # A same-image child reached through an unretained intermediary is unresolved, not inferred owned.
          if (-not $parentIsBun) { $script:discoveryInvalid = $true; continue }
          $child = $null
          try {
            $child = [Diagnostics.Process]::GetProcessById([int]$row.ProcessId)
            [void]$child.Handle
            $start = $child.StartTime.ToUniversalTime().Ticks
            $actualImage = [IO.Path]::GetFullPath($child.MainModule.FileName)
            if ([Math]::Abs($start - $born) -gt 10000 -or -not [string]::Equals($actualImage, $rootBunImage, [StringComparison]::OrdinalIgnoreCase)) {
              $child.Dispose(); $script:discoveryInvalid = $true; continue
            }
            if ($owned.Count -ge 8) { $child.Dispose(); $script:discoveryOverflow = $true; return }
            $owned.Add([pscustomobject]@{Id=$child.Id; Start=$start; Process=$child; Return=$null})
            $added = $true
          } catch { if ($child) { $child.Dispose() }; $script:discoveryInvalid = $true }
        }
        if (-not $added) { return }
      }
      # Depth/image/ancestry gaps remain unresolved; this is not a complete child census.
      foreach ($row in $rows) {
        if ((@($owned | Where-Object Id -eq $row.ParentProcessId).Count -or $nonBun.ContainsKey([int]$row.ParentProcessId)) -and
          -not @($owned | Where-Object Id -eq $row.ProcessId).Count -and -not $nonBun.ContainsKey([int]$row.ProcessId)) {
          $script:discoveryOverflow = $true
        }
      }
    } catch { $script:discoveryInvalid = $true }
  }
  $script:discoveryInvalid = $false
  $script:discoveryOverflow = $false
  try {
    if (-not $runner.Start()) { throw 'runner failed to start' }
    [void]$runner.Handle
    $owned.Add([pscustomobject]@{Id=$runner.Id; Start=$runner.StartTime.ToUniversalTime().Ticks; Process=$runner; Return=$null})
    $rootBunImage = [IO.Path]::GetFullPath($runner.MainModule.FileName)
    $inputStream = if ($Fault -eq 'Copy') { [H100CopyFault]::new() } else { $runner.StandardOutput.BaseStream }
    $copies = @($inputStream.CopyToAsync($stdout), $runner.StandardError.BaseStream.CopyToAsync($stderr))
    $nextDiscovery = 0
    while ($true) {
      if ($clock.ElapsedMilliseconds -ge $nextDiscovery) { Discover-Owned; $nextDiscovery = $clock.ElapsedMilliseconds + 1000 }
      if ($runner.HasExited) { $originalExit = $runner.ExitCode }
      if (@($copies | Where-Object IsFaulted).Count) { $outputFault = $true; break }
      if ($identityFault -or $script:discoveryInvalid -or $script:discoveryOverflow) { break }
      if ($null -ne $originalExit) { break }
      if ($clock.ElapsedMilliseconds -ge $LimitMs) { break }
      Start-Sleep -Milliseconds 50
    }
  } catch { $controllerFault = $true }
  finally {
    # ONE cumulative 15s budget, including discovery, retained-handle waits and BOTH drains.
    $cleanup = [Diagnostics.Stopwatch]::StartNew()
    if ($owned.Count -and $null -eq $originalExit -and $runner.HasExited) { $originalExit = $runner.ExitCode }
    if ($owned.Count) { Discover-Owned }
    foreach ($entry in @($owned.ToArray()) | Sort-Object Start -Descending) {
      try {
        if (-not $entry.Process.HasExited) {
          if ($cleanup.ElapsedMilliseconds -ge 15000) { break }
          if ($entry.Process.StartTime.ToUniversalTime().Ticks -ne $entry.Start) { $identityFault = $true; continue }
          # Rooted tree containment catches children created after the latest bounded CIM snapshot.
          # Retained returns below remain separate: CIM is not a complete all-child census.
          $entry.Process.Kill($true)
          $forced = $true
        }
      } catch { $identityFault = $true }
    }
    foreach ($entry in $owned) {
      try {
        $remaining = [Math]::Max(0, 15000 - [int]$cleanup.ElapsedMilliseconds)
        if ($entry.Process.WaitForExit($remaining)) { $entry.Return = $entry.Process.ExitCode }
      } catch { $identityFault = $true }
    }
    $drainsComplete = $true
    for ($index = 0; $index -lt $copies.Count; $index++) {
      $copy = $copies[$index]
      try {
        $remaining = [Math]::Max(0, 15000 - [int]$cleanup.ElapsedMilliseconds)
        if (-not $copy.Wait($remaining)) { $outputFault = $true; $drainsComplete = $false }
      } catch { $outputFault = $true }
      if ($copy.IsFaulted) {
        # Observe the failed copy, then drain/discard its remaining real pipe AFTER termination.
        try {
          $stream = if ($index -eq 0) {$runner.StandardOutput.BaseStream} else {$runner.StandardError.BaseStream}
          $drain = $stream.CopyToAsync([IO.Stream]::Null)
          $remaining = [Math]::Max(0, 15000 - [int]$cleanup.ElapsedMilliseconds)
          if (-not $drain.Wait($remaining)) { $drainsComplete = $false }
        } catch { $drainsComplete = $false }
      }
    }
    $identityFault = $identityFault -or $script:discoveryInvalid
    $discoveryTruncated = $script:discoveryOverflow
    $cleanupMs = [int]$cleanup.ElapsedMilliseconds
    $returnVerified = $owned.Count -gt 0 -and -not $identityFault -and -not $discoveryTruncated -and
      $cleanupMs -lt 15000 -and $drainsComplete -and @($owned | Where-Object { $null -eq $_.Return }).Count -eq 0 -and
      @($copies | Where-Object { -not $_.IsCompleted }).Count -eq 0
  }
  $text = ''
  if ($returnVerified -and -not $outputFault) {
    $text = [Text.Encoding]::UTF8.GetString($stdout.ToArray()) + "`n" + [Text.Encoding]::UTF8.GetString($stderr.ToArray())
  }
  $returns = @($owned | ForEach-Object { [ordered]@{pid=$_.Id; startTicks=$_.Start; exit=$_.Return} })
  foreach ($entry in $owned) { $entry.Process.Dispose() }
  if (-not $owned.Count) { $runner.Dispose() }
  $stdout.Dispose(); $stderr.Dispose()
  $cleanupMs = [int]$cleanup.ElapsedMilliseconds
  $returnVerified = $returnVerified -and $cleanupMs -lt 15000
  return [pscustomobject]@{OriginalExit=$originalExit; Forced=$forced; OutputFault=$outputFault; IdentityFault=$identityFault;
    DiscoveryTruncated=$discoveryTruncated; ControllerFault=$controllerFault; CleanupMs=$cleanupMs; CleanupClock=$cleanup; NonBunObserved=$discovery.nonBunObserved;
    ReturnStatus=$(if ($returnVerified) {'RETURN_VERIFIED'} else {'RETURN_UNVERIFIED'}); Returns=$returns; Text=$text}
}

function Count-Value($Value) {
  if ($Value -isnot [ValueType] -or $Value -is [bool] -or [double]$Value -lt 0 -or
    [double]$Value -gt 9007199254740991 -or [Math]::Floor([double]$Value) -ne [double]$Value) { throw 'invalid bounded count' }
  return $Value
}
function Project-Counts($Value, [string[]]$Keys) {
  $out = [ordered]@{}
  foreach ($key in $Keys) { $out[$key] = Count-Value $Value.$key }
  return $out
}
function Project-Rows($Rows, [int]$Cap) {
  if (@($Rows).Count -gt $Cap) { throw 'row cap' }
  return @($Rows | ForEach-Object {
    if ($_.file -cnotmatch '^(?:OTHER|NATIVE|(?:apps/threadnote/|packages/|node_modules/(?:@effect/|effect/|fflate/|vitest/|@vitest/|vite/))[\w./@-]+)$' -or
      $_.file.Length -gt 160 -or $_.file.Split('/') -contains '..' -or $_.file.Split('/') -contains '.' -or
      $_.name -cnotmatch '^[\w$<>.:-]{1,64}$') { throw 'unqualified row' }
    [ordered]@{file=$_.file; name=$_.name; line=(Count-Value $_.line); samples=(Count-Value $_.samples)}
  })
}
function Convert-H100Packets([string]$Text) {
  $cpu = $null
  $progress = $null
  $cpuLines = @($Text -split "`r?`n" | Where-Object { $_.StartsWith('NATIVE_AUTHORING_CPU_DIAGNOSTICS ') })
  if ($cpuLines.Count -ne 1 -or [Text.Encoding]::UTF8.GetByteCount($cpuLines[0]) -gt 196608 + 40) { throw 'missing/ambiguous CPU summary' }
  $payload = $cpuLines[0].Substring('NATIVE_AUTHORING_CPU_DIAGNOSTICS '.Length)
  if ([Text.Encoding]::UTF8.GetByteCount($payload) -gt 196608) { throw 'CPU packet cap' }
  $packet = $cpuLines[0].Substring('NATIVE_AUTHORING_CPU_DIAGNOSTICS '.Length) | ConvertFrom-Json
  if ($packet.version -ne 1 -or $packet.role -cne 'native-fixture-cpu' -or $packet.api -cne 'bun:jsc.profile' -or
    $packet.scope -cne 'provided-native-scope-includes-acquisition-body-finalization' -or $packet.intervalMicros -ne 10000 -or
    $packet.status -cnotmatch '^(captured|insufficient|overlap|conflict|unavailable|profile-failed|flush-timeout|export-failed)$' -or
    $packet.outcome -cnotmatch '^(Success|Failure)$' -or $packet.bun -cnotmatch '^[\w.+-]{1,32}$' -or
    $packet.revision -cnotmatch '^(?:[a-f0-9]{7,64}|unavailable)$') { throw 'invalid CPU packet' }
  $cpu = [ordered]@{version=1; role=$packet.role; api=$packet.api; scope=$packet.scope; status=$packet.status;
    outcome=$packet.outcome; bun=$packet.bun; revision=$packet.revision; intervalMicros=10000;
    pid=(Count-Value $packet.pid); session=(Count-Value $packet.session); flushMs=(Count-Value $packet.flushMs)}
  if ($packet.PSObject.Properties.Name -contains 'summary') {
    $s = $packet.summary
    $summary = Project-Counts $s @('totalTraces','analyzedTraces')
    if ($summary.analyzedTraces -gt 65536) { throw 'trace cap' }
    $summary.close = Project-Counts $s.close @('nativeCloseTotal','closeDriverAndRecallObserved','closeDriverObservedRecallUnknown','closeDriverUnknown','missingContext','rejectedContext','truncatedContext')
    if ($summary.close.nativeCloseTotal -ne ($summary.close.closeDriverAndRecallObserved + $summary.close.closeDriverObservedRecallUnknown + $summary.close.closeDriverUnknown)) { throw 'CLOSE partition' }
    $summary.context = Project-Counts $s.context @('applicationUnknown','dependencyUnknown','empty','rejected','truncated')
    $summary.omissions = Project-Counts $s.omissions @('traces','frames')
    foreach ($table in @('keys','rows','samples')) { $summary.omissions[$table] = Project-Counts $s.omissions.$table @('self','application','dependency') }
    foreach ($table in @('self','application','dependency')) { $summary[$table] = @(Project-Rows $s.$table $(if ($table -eq 'dependency') {128} else {256})) }
    $cpu.summary = $summary
  }
  # Existing progress output contains fixed labels only. Reject any unknown string/key, then preserve its bounded packet.
  $progressLines = @($Text -split "`r?`n" | Where-Object { $_.StartsWith('NATIVE_AUTHORING_PROGRESS_DIAGNOSTICS ') })
  if ($progressLines.Count -gt 1) { throw 'ambiguous progress' }
  if ($progressLines.Count -eq 1) {
    $json = $progressLines[0].Substring('NATIVE_AUTHORING_PROGRESS_DIAGNOSTICS '.Length)
    if ($json.Length -gt 16000) { throw 'progress cap' }
    $progress = $json | ConvertFrom-Json
    $labels = @(
      'CommandExecutor.execute','Failure','OTHER','Span','Started',
      'Success','acquireAndBeginMs','action','active','activeAges',
      'activeCount','ageMs','allSources','args','authoring',
      'authoring-load','authoring-load-document','authoring-read','authoring-save','available',
      'bigint','binding','bodyCpu','bodyEntered','bodyExitSnapshot',
      'bodyExited','bodyMs','bodyTransaction','boolean','bucket',
      'canonicalMutationChanged','capture','changedSources','classify','cleanupObservedMs',
      'clocks','closeout.stage.finish','closeout.stage.graph-ready','closeout.stage.prepare','cohort',
      'command','commandCohorts','commit','commitAndReleaseMs','completedSpans',
      'context','continuityMissing','count','counters','counts',
      'cpu','cpuStart','default','defaultStatePath','defaultValue',
      'delegate','detail','diagnostic-monotonic-ms','document','duration',
      'effect','effect-native-timestamps-ns-to-inclusive-ms','effect.sql.transaction.commit','elapsedMs','end',
      'ended','entry','execute','external.loadAccess','facades',
      'failed','finish','fixture-raw-store-read','fixture-state-read','forceAllSources',
      'forceFromMarker','forceRefresh','fs','graph-ready','historyReadsSucceeded',
      'historyRule','identityReconciliations','includes-other-worker-activity-and-boundary-skew;cpu-may-exceed-wall;not-serialization-or-io-attribution','inclusive-overlapping','inclusiveMs',
      'incremental','inferred-from-fixture-boundaries-after-first-successful-state-read','init','input','inspect',
      'invalid','key','kind','known','label',
      'lastBoundary','limits','line','load','lower-prepare',
      'maxChangedSources','memoryCodeCitation.capture','memoryCodeCitation.captureRepositoryGroup','method','n',
      'native-fixture-progress','native-preflight','native.progress.authoring-load','native.progress.authoring-load-document','native.progress.authoring-read',
      'native.progress.authoring-save','native.progress.fixture-raw-store-read','native.progress.fixture-state-read','native.progress.init','native.progress.inspect',
      'native.progress.other','number','object','observe','observed',
      'observer','options','other','outcome','outerFailure',
      'packet','parent','phase','preCommitMs','prefix',
      'prepare','program','projection','read','readFileString',
      'recall.acquireDatabase','recall.assembleRefreshSources','recall.closeDatabase','recall.databaseBody','recall.ensureDatabaseFresh',
      'recall.executeIndexQuery','recall.hashRefreshGeneration','recall.identity','recall.initializeDatabase','recall.initializeIdentityIndex',
      'recall.loadIdentityConflicts','recall.loadIdentityProjection','recall.loadMemoryIdentities','recall.rebuildIdentityConflicts','recall.reconcileIdentityProjection',
      'recall.refresh','recall.refresh.canonicalMutationChanged','recall.refresh.continuityAllowed','recall.refresh.forceFromMarker','recall.refresh.forceRefresh',
      'recall.refreshDatabase','recall.refreshDerivedIndexesAfterCanonicalMutation','recall.resolveLegacyMemoryLinks','recall.resolveMemoryIdentityAliases','recall.scanSources',
      'recall.selectIdentityProjection','recall.selectIndexData','recall.writeRefresh','recall.writeRefreshBody','recent',
      'recentDropped','refreshDecisions','rejected','removedSources','role',
      'runCommandEffect','save','saveStarted','saveSucceeded','scannedSources',
      'scope','sequence','service','span','spanTotals',
      'sql.transaction','start','started','startedMs','store',
      'succeeded','system','systemMs','this','totals',
      'transaction','transactionBoundaries','unlistedActiveCount','user','userMs',
      'value','version','vocabulary','worker-process-all-threads-excludes-children','workflowAutomation.bound',
      'workflowAutomation.inspectNative','workflowAutomation.projectCloseoutKnowledge','workflowAutomation.readState','workflowAutomation.run','workflowAutomation.save',
      'workflowAutomation.writeState','workflowMemory.executeOperation','workflowMemory.inspectJournal','workflowMemory.prepareOperation','workflowMemory.readJournalFile',
      'workflowMemory.reconcileManifest','workflowMemory.resolveBinding','workflowMemory.verifyBinding','workflowMemory.writeJournalFile'
    )
    function Assert-Progress($Value, [int]$Depth = 0) {
      if ($Depth -gt 12) { throw 'progress depth' }
      if ($null -eq $Value -or $Value -is [bool]) { return }
      if ($Value -is [string]) { if ($labels -cnotcontains $Value) { throw 'unknown progress vocabulary' }; return }
      if ($Value -is [ValueType]) { [void](Count-Value $Value); return }
      if ($Value -is [array]) { if ($Value.Count -gt 64) { throw 'progress array cap' }; foreach ($item in $Value) { Assert-Progress $item ($Depth+1) }; return }
      foreach ($property in $Value.PSObject.Properties) {
        if ($labels -cnotcontains $property.Name) { throw 'unknown progress key' }
        Assert-Progress $property.Value ($Depth+1)
      }
    }
    if ($progress.version -ne 1 -or $progress.role -cne 'native-fixture-progress') { throw 'invalid progress packet' }
    Assert-Progress $progress
  }
  return [pscustomobject]@{Cpu=$cpu; Progress=$progress}
}

# Qualification uses only synthetic Bun children; no profile, fixture or production store.
$qualification = [Diagnostics.Stopwatch]::StartNew()
$checks = [Collections.Generic.List[object]]::new()
$runtime = $null
try {
  $syntheticCpu = [ordered]@{version=1; role='native-fixture-cpu'; api='bun:jsc.profile';
    scope='provided-native-scope-includes-acquisition-body-finalization'; status='captured'; outcome='Failure';
    bun='synthetic'; revision='unavailable'; intervalMicros=10000; pid=1; session=1; flushMs=0;
    summary=@{totalTraces=1; analyzedTraces=1;
      close=@{nativeCloseTotal=1; closeDriverAndRecallObserved=0; closeDriverObservedRecallUnknown=1; closeDriverUnknown=0; missingContext=0; rejectedContext=0; truncatedContext=0};
      context=@{applicationUnknown=1; dependencyUnknown=0; empty=0; rejected=0; truncated=0};
      omissions=@{traces=0; frames=0; keys=@{self=0; application=0; dependency=0}; rows=@{self=0; application=0; dependency=0}; samples=@{self=0; application=0; dependency=0}};
      self=@(@{file='NATIVE'; name='CLOSE'; line=0; samples=1}); application=@(@{file='OTHER'; name='OTHER'; line=0; samples=1});
      dependency=@(@{file='node_modules/@effect/sql-sqlite-bun/dist/SqliteClient.js'; name='close'; line=1; samples=1})}}
  $syntheticProgress = [ordered]@{version=1; role='native-fixture-progress'; bodyEntered=$true; bodyExited=$true;
    activeCount=0; recentDropped=0; historyReadsSucceeded=0; outerFailure=$true; counters=@{'authoring-save'=@{started=1; succeeded=0; failed=1}}}
  $cpuText = 'NATIVE_AUTHORING_CPU_DIAGNOSTICS ' + ($syntheticCpu | ConvertTo-Json -Depth 20 -Compress)
  $progressText = 'NATIVE_AUTHORING_PROGRESS_DIAGNOSTICS ' + ($syntheticProgress | ConvertTo-Json -Depth 20 -Compress)
  $positive = Convert-H100Packets ($cpuText + "`n" + $progressText)
  if (-not $positive.Progress.bodyEntered -or $positive.Progress.historyReadsSucceeded -ne 0 -or $positive.Cpu.summary.close.closeDriverObservedRecallUnknown -ne 1) { throw 'positive packet contract' }
  $checks.Add([ordered]@{fault='positive-packets'; passed=$true})
  foreach ($fault in @('private-key','private-row','oversize-progress','oversize-cpu','ambiguous-session')) {
    $bad = switch ($fault) {
      'private-key' { $cpuText + "`n" + 'NATIVE_AUTHORING_PROGRESS_DIAGNOSTICS {"version":1,"role":"native-fixture-progress","PRIVATE":"PRIVATE"}' }
      'private-row' { $cpuText.Replace('node_modules/@effect/sql-sqlite-bun/dist/SqliteClient.js','/PRIVATE/source.ts') }
      'oversize-progress' { $cpuText + "`n" + 'NATIVE_AUTHORING_PROGRESS_DIAGNOSTICS ' + (' ' * 16001) }
      'oversize-cpu' { 'NATIVE_AUTHORING_CPU_DIAGNOSTICS ' + (' ' * 196609) }
      'ambiguous-session' { $cpuText + "`n" + $cpuText }
    }
    $rejected = $false
    try { [void](Convert-H100Packets $bad) } catch { $rejected = $true }
    $checks.Add([ordered]@{fault=$fault; passed=$rejected})
    if (-not $rejected) { throw 'packet fault not rejected' }
  }
  foreach ($fault in @('None', 'NonBunChurn', 'Write', 'ShortWrite', 'Copy', 'Cap', 'Ambiguous', 'Timeout')) {
    if ($qualification.ElapsedMilliseconds -ge 30000) { throw 'synthetic qualification deadline' }
    $code = 'console.log("H100_RUNTIME "+JSON.stringify({bun:Bun.version,revision:Bun.revision,cwd:process.cwd()}));const c=Bun.spawn([process.execPath,"-e","setTimeout(()=>process.exit(0),2000)"],{stdout:"ignore",stderr:"ignore"});setTimeout(()=>process.stdout.write("x".repeat(8192)),1200);setTimeout(()=>process.exit(7),2300);'
    if ($fault -eq 'NonBunChurn') {
      $code = 'const children=Array.from({length:12},()=>Bun.spawn([process.env.ComSpec,"/d","/s","/c","ping -n 3 127.0.0.1 >nul"],{stdout:"ignore",stderr:"ignore"}));const c=Bun.spawn([process.execPath,"-e","setTimeout(()=>process.exit(0),2000)"],{stdout:"ignore",stderr:"ignore"});Promise.all([...children.map(child=>child.exited),c.exited]).then(()=>process.exit(7));'
    }
    if ($fault -eq 'Timeout') { $code = 'setTimeout(()=>{},10000)' }
    $limit = if ($fault -eq 'Timeout') {1000} else {4000}
    $result = Invoke-OwnedH100 @('-e', $code) ([Math]::Min($limit, 30000 - [int]$qualification.ElapsedMilliseconds)) $fault
    $okay = if ($fault -eq 'None') {
      $result.OriginalExit -eq 7 -and -not $result.Forced -and $result.ReturnStatus -eq 'RETURN_VERIFIED' -and $result.Returns.Count -ge 2
    } elseif ($fault -eq 'NonBunChurn') {
      $result.OriginalExit -eq 7 -and -not $result.Forced -and $result.ReturnStatus -eq 'RETURN_VERIFIED' -and
        $result.Returns.Count -eq 2 -and $result.NonBunObserved -ge 9
    } elseif ($fault -eq 'Ambiguous') {
      $result.ReturnStatus -eq 'RETURN_UNVERIFIED' -and $result.IdentityFault
    } elseif ($fault -eq 'Timeout') {
      $null -eq $result.OriginalExit -and $result.Forced -and $result.ReturnStatus -eq 'RETURN_VERIFIED'
    } else { $result.OutputFault -and $result.ReturnStatus -eq 'RETURN_VERIFIED' }
    if ($fault -eq 'None' -and $okay) {
      $runtimeLines = @($result.Text -split "`r?`n" | Where-Object { $_.StartsWith('H100_RUNTIME ') })
      if ($runtimeLines.Count -ne 1) { throw 'runtime identity missing' }
      $actual = $runtimeLines[0].Substring('H100_RUNTIME '.Length) | ConvertFrom-Json
      if ($actual.bun -cne '1.4.2' -or $actual.revision -cnotmatch '^[a-f0-9]{7,64}$') { throw 'unexpected actual Bun identity' }
      if (-not [string]::Equals($actual.cwd, $reviewedCheckout, [StringComparison]::OrdinalIgnoreCase)) { throw 'synthetic child working directory mismatch' }
      $runtime = [ordered]@{bun=$actual.bun; revision=$actual.revision; workingDirectoryVerified=$true}
    }
    $checks.Add([ordered]@{fault=$fault; passed=[bool]$okay; originalExit=$result.OriginalExit; returnStatus=$result.ReturnStatus; cleanupMs=$result.CleanupMs; nonBunObserved=$result.NonBunObserved})
    if (-not $okay -or $qualification.ElapsedMilliseconds -ge 30000) { throw "synthetic qualification failed: $fault" }
  }
} catch {
  $preflightExport = if ($env:RUNNER_TEMP) {Join-Path $env:RUNNER_TEMP 'h100-export'} else {''}
  if ($preflightExport -and (Test-Path -LiteralPath (Join-Path $preflightExport 'claim.json'))) {
    [IO.File]::WriteAllText((Join-Path $preflightExport 'control.json'),
      ([ordered]@{version=1; qualified=$false; preflightFailed=$true; originalExit=$null; qualification=$checks.ToArray()} | ConvertTo-Json -Depth 10 -Compress))
  }
  throw 'synthetic qualification failed; no H100 launch'
}
if ($QualifyOnly) { $checks | ConvertTo-Json -Depth 5; exit 0 }

$export = Join-Path $env:RUNNER_TEMP 'h100-export'
$claimPath = Join-Path $export 'claim.json'
$claim = Get-Content -LiteralPath $claimPath -Raw | ConvertFrom-Json
if ($env:GITHUB_EVENT_NAME -ne 'pull_request' -or $env:GITHUB_RUN_ATTEMPT -ne '1' -or $env:GITHUB_REPOSITORY -ne 'threadnote/threadnote' -or
  $claim.runID -ne $env:GITHUB_RUN_ID -or $claim.attempt -ne 1 -or $claim.head -cnotmatch '^[a-f0-9]{40}$' -or $claim.label -cne ('h100-once-' + $claim.head) -or $claim.claim -ne 'DELETE200') { throw 'missing exact run claim' }
if ((git -C $reviewedCheckout rev-parse HEAD) -cne $claim.head) { throw 'checkout differs from claimed reviewed head' }
# Public unauthenticated live-head read: job token is used ONLY in the initial inline claim step.
$live = Invoke-RestMethod -Uri 'https://api.github.com/repos/threadnote/threadnote/pulls/913' -TimeoutSec 15 -MaximumRetryCount 0
if ($live.head.sha -cne $claim.head -or $live.head.repo.full_name -cne 'threadnote/threadnote') { throw 'head drift before launch' }
$fixture = 'apps/threadnote/test/dev-skills/native-authoring-lifecycle.test.ts'
# Normalize checkout CRLF only for the immutable fixture-byte contract.
$bytes = [Text.Encoding]::UTF8.GetBytes([IO.File]::ReadAllText((Join-Path $reviewedCheckout $fixture)).Replace("`r`n", "`n"))
$hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
if ($hash -cne 'd354d96e996d7b514d0a242b9b9901adb2151a017480e9db479bb5c35179bb1d' -or $bytes.Length -ne 80683) { throw 'protected H100 fixture changed' }
if ($qualification.ElapsedMilliseconds -ge 30000) { throw 'preflight deadline; no launch' }
[IO.File]::WriteAllText((Join-Path $export 'control.json'),
  ([ordered]@{version=1; phase='launch-ready'; qualified=$false; originalExit=$null; runID=$claim.runID; attempt=1;
    head=$claim.head; runtime=$runtime; qualification=$checks.ToArray()} | ConvertTo-Json -Depth 10 -Compress))
if ($qualification.ElapsedMilliseconds -ge 30000) { throw 'preflight receipt deadline; no launch' }
$raw = Join-Path $env:RUNNER_TEMP ('h100-private-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($raw)
$report = Join-Path $raw 'vitest.json'
$result = Invoke-OwnedH100 @('node_modules/vitest/vitest.mjs', 'run', '--no-file-parallelism', '--maxWorkers=1',
  $fixture, '-t', '^native authoring lifecycle > retains and navigates 100 same-length revisions of a large native plan$',
  '--reporter=default', '--reporter=json', "--outputFile=$report") 675000 'None' $true

# The SAME cleanup stopwatch remains authoritative through projection, disposal and receipt attempts.
function Assert-CleanupBudget {
  if ($result.CleanupClock.ElapsedMilliseconds -ge 15000) { $result.ReturnStatus = 'RETURN_UNVERIFIED'; throw 'cumulative cleanup/receipt deadline' }
}
$qualified = $false
$exportFault = $false
$cpu = $null
$progress = $null
try {
  Assert-CleanupBudget
  $packets = Convert-H100Packets $result.Text
  $cpu = $packets.Cpu; $progress = $packets.Progress
  if ((Get-Item -LiteralPath $report).Length -gt 8MB) { throw 'private JSON report read cap' }
  $vitest = [IO.File]::ReadAllText($report) | ConvertFrom-Json
  $executed = @($vitest.testResults | ForEach-Object { $_.assertionResults } | Where-Object { $_.status -in @('passed','failed') })
  if ($executed.Count -ne 1 -or $executed[0].fullName -cne 'native authoring lifecycle retains and navigates 100 same-length revisions of a large native plan') { throw 'original single-case result missing' }
  Assert-CleanupBudget
  $workers = @($result.Returns | Where-Object { $_.pid -eq $cpu.pid -and $null -ne $_.exit })
  $qualified = $cpu.status -eq 'captured' -and $cpu.Contains('summary') -and $cpu.summary.analyzedTraces -gt 0 -and $workers.Count -eq 1 -and $result.ReturnStatus -eq 'RETURN_VERIFIED' -and
    -not $result.Forced -and -not $result.OutputFault -and -not $result.ControllerFault -and $null -ne $result.OriginalExit
} catch { $exportFault = $true }
$rawRemoved = $false
try { Assert-CleanupBudget; Remove-Item -LiteralPath $raw -Recurse -Force; $rawRemoved = -not (Test-Path -LiteralPath $raw); Assert-CleanupBudget } catch { $exportFault = $true }
$qualified = $qualified -and $rawRemoved -and -not $exportFault
$control = [ordered]@{version=1; runID=$claim.runID; attempt=1; head=$claim.head; runtime=$runtime; qualified=$qualified;
  originalExit=$result.OriginalExit; parentAndWorkerReturns=$result.Returns; returnStatus=$result.ReturnStatus;
  forcedContainment=$result.Forced; outputFault=$result.OutputFault; identityFault=$result.IdentityFault;
  discoveryTruncated=$result.DiscoveryTruncated; nonBunObserved=$result.NonBunObserved; controllerFault=$result.ControllerFault; cleanupMs=[int]$result.CleanupClock.ElapsedMilliseconds;
  ownershipEvidence='verified-retained-handle-returns-plus-rooted-tree-termination;CIM-is-not-a-complete-child-census';
  exportFault=$exportFault; rawRemoved=$rawRemoved; qualification=$checks.ToArray(); interpretation='attribution-only-no-timing-acceptance';
  limits='internal-native-profile-allocation-and-overhead-unbounded;logical-deadlines-do-not-preempt-kernel-calls'}
try {
  Assert-CleanupBudget
  if ($cpu) { [IO.File]::WriteAllText((Join-Path $export 'cpu.json'), ($cpu | ConvertTo-Json -Depth 20 -Compress)) }
  Assert-CleanupBudget
  if ($progress) { [IO.File]::WriteAllText((Join-Path $export 'progress.json'), ($progress | ConvertTo-Json -Depth 20 -Compress)) }
  Assert-CleanupBudget
  $control.cleanupMs = [int]$result.CleanupClock.ElapsedMilliseconds
  [IO.File]::WriteAllText((Join-Path $export 'control.json'), ($control | ConvertTo-Json -Depth 20 -Compress))
  $files = @(Get-ChildItem -LiteralPath $export -File)
  if (@($files | Where-Object { $_.Name -cnotin @('claim.json','cpu.json','progress.json','control.json') }).Count -or
    ($files | Measure-Object Length -Sum).Sum -gt 1MB) { throw 'export allowlist/cap' }
  Assert-CleanupBudget
} catch {
  # Best effort failure receipt follows termination/drain; it never grants qualification.
  $control.qualified = $false; $control.exportFault = $true; $control.returnStatus = 'RETURN_UNVERIFIED'
  $control.cleanupMs = [int]$result.CleanupClock.ElapsedMilliseconds
  try { [IO.File]::WriteAllText((Join-Path $export 'control.json'), ($control | ConvertTo-Json -Depth 20 -Compress)) } catch {}
  if ($null -ne $result.OriginalExit -and $result.OriginalExit -ne 0) { exit $result.OriginalExit }
  throw 'sanitized export/deadline failed; capture unqualified'
}
if ($null -ne $result.OriginalExit -and $result.OriginalExit -ne 0) { exit $result.OriginalExit }
if (-not $qualified) { exit 1 }
exit 0

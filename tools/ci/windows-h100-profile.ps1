# Temporary D18 hosted-Windows capture. Packet/root-pipe checks precede the sole original H100 launch.
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

# Observe the root invocation only. Hosted step/job limits own ultimate containment.
function Invoke-H100Root([string[]]$Arguments, [string]$Fault = 'None', [bool]$Profile = $false) {
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
  $stdout = [H100Output]::new($(if ($Fault -eq 'Cap') {2048} else {8MB}), $Fault)
  $stderr = [H100Output]::new(8MB, 'None')
  $copies = @()
  $started = $false
  $start = $null
  $pidObserved = $null
  $originalExit = $null
  $rootExit = $null
  $rootReturned = $false
  $forced = $false
  $outputFault = $false
  $rootFault = $false
  $pipesDrained = $true
  try {
    if (-not $runner.Start()) { throw 'runner failed to start' }
    $started = $true
    [void]$runner.Handle
    $start = $runner.StartTime.ToUniversalTime().Ticks
    $pidObserved = $runner.Id
    $inputStream = if ($Fault -eq 'Copy') {[H100CopyFault]::new()} else {$runner.StandardOutput.BaseStream}
    $copies = @($inputStream.CopyToAsync($stdout), $runner.StandardError.BaseStream.CopyToAsync($stderr))
    while ($true) {
      if ($runner.HasExited) { $originalExit = $runner.ExitCode; break }
      if (@($copies | Where-Object IsFaulted).Count) { $outputFault = $true; break }
      Start-Sleep -Milliseconds 50
    }
  } catch { $rootFault = $true }
  finally {
    # Only root-fault cleanup and pipe drain share this best-effort 15s budget.
    # This is neither a child census nor a whole-export/VM-teardown deadline.
    $drain = [Diagnostics.Stopwatch]::StartNew()
    if ($started) {
      try {
        if ($runner.HasExited) { $originalExit = $runner.ExitCode }
        elseif ($null -ne $start -and $runner.StartTime.ToUniversalTime().Ticks -eq $start) {
          $runner.Kill($true)
          $forced = $true
        } else { $rootFault = $true }
        $remaining = [Math]::Max(0, 15000 - [int]$drain.ElapsedMilliseconds)
        if ($runner.WaitForExit($remaining)) { $rootExit = $runner.ExitCode; $rootReturned = $true }
      } catch { $rootFault = $true }
    }
    for ($index = 0; $index -lt $copies.Count; $index++) {
      $copy = $copies[$index]
      try {
        $remaining = [Math]::Max(0, 15000 - [int]$drain.ElapsedMilliseconds)
        if (-not $copy.Wait($remaining)) { $outputFault = $true; $pipesDrained = $false }
      } catch { $outputFault = $true }
      if ($copy.IsFaulted) {
        # Observe the failed copy, then best-effort discard the real pipe after root cleanup.
        try {
          $stream = if ($index -eq 0) {$runner.StandardOutput.BaseStream} else {$runner.StandardError.BaseStream}
          $discard = $stream.CopyToAsync([IO.Stream]::Null)
          $remaining = [Math]::Max(0, 15000 - [int]$drain.ElapsedMilliseconds)
          if (-not $discard.Wait($remaining)) { $pipesDrained = $false }
        } catch { $pipesDrained = $false }
      }
    }
    $pipesDrained = $pipesDrained -and $copies.Count -eq 2 -and @($copies | Where-Object {-not $_.IsCompleted}).Count -eq 0
  }
  $text = ''
  if ($pipesDrained -and -not $outputFault) {
    $text = [Text.Encoding]::UTF8.GetString($stdout.ToArray()) + "`n" + [Text.Encoding]::UTF8.GetString($stderr.ToArray())
  }
  try { $runner.Dispose(); $stdout.Dispose(); $stderr.Dispose() } catch { $rootFault = $true }
  return [pscustomobject]@{OriginalExit=$originalExit; RootExit=$rootExit; RootReturned=$rootReturned;
    RootPid=$pidObserved; RootStartTicks=$start; Forced=$forced; OutputFault=$outputFault; RootFault=$rootFault;
    PipesDrained=($pipesDrained -and $drain.ElapsedMilliseconds -lt 15000); RootDrainMs=[int]$drain.ElapsedMilliseconds; Text=$text}
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

# Qualification uses only unprofiled synthetic root processes; no fixture or production store.
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
  foreach ($fault in @('None', 'Write', 'ShortWrite', 'Copy', 'Cap')) {
    if ($qualification.ElapsedMilliseconds -ge 30000) { throw 'synthetic qualification deadline' }
    $code = 'console.log("H100_RUNTIME "+JSON.stringify({bun:Bun.version,revision:Bun.revision,cwd:process.cwd()}));process.stdout.write("x".repeat(8192));setTimeout(()=>process.exit(7),1000);'
    $result = Invoke-H100Root @('-e', $code) $fault
    $okay = $result.RootReturned -and $result.PipesDrained -and -not $result.RootFault
    if ($fault -eq 'None') {
      $okay = $okay -and $result.OriginalExit -eq 7 -and -not $result.Forced -and -not $result.OutputFault
      if ($okay) {
        $runtimeLines = @($result.Text -split "`r?`n" | Where-Object { $_.StartsWith('H100_RUNTIME ') })
        if ($runtimeLines.Count -ne 1) { throw 'runtime identity missing' }
        $actual = $runtimeLines[0].Substring('H100_RUNTIME '.Length) | ConvertFrom-Json
        if ($actual.bun -cne '1.4.2' -or $actual.revision -cnotmatch '^[a-f0-9]{7,64}$') { throw 'unexpected actual Bun identity' }
        if (-not [string]::Equals($actual.cwd, $reviewedCheckout, [StringComparison]::OrdinalIgnoreCase)) { throw 'synthetic root working directory mismatch' }
        $runtime = [ordered]@{bun=$actual.bun; revision=$actual.revision; workingDirectoryVerified=$true}
      }
    } else { $okay = $okay -and $result.OutputFault }
    $checks.Add([ordered]@{fault=$fault; passed=[bool]$okay; originalExit=$result.OriginalExit; rootExit=$result.RootExit;
      rootReturned=$result.RootReturned; pipesDrained=$result.PipesDrained; forced=$result.Forced;
      outputFault=$result.OutputFault; rootFault=$result.RootFault; rootDrainMs=$result.RootDrainMs})
    if (-not $okay -or $qualification.ElapsedMilliseconds -ge 30000) { throw 'root pipe qualification failed' }
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
$result = Invoke-H100Root @('node_modules/vitest/vitest.mjs', 'run', '--no-file-parallelism', '--maxWorkers=1',
  $fixture, '-t', '^native authoring lifecycle > retains and navigates 100 same-length revisions of a large native plan$',
  '--reporter=default', '--reporter=json', "--outputFile=$report") 'None' $true

$qualified = $false
$exportFault = $false
$cpu = $null
$progress = $null
$caseOutcome = $null
try {
  $packets = Convert-H100Packets $result.Text
  $cpu = $packets.Cpu; $progress = $packets.Progress
  if ((Get-Item -LiteralPath $report).Length -gt 8MB) { throw 'private JSON report read cap' }
  $vitest = [IO.File]::ReadAllText($report) | ConvertFrom-Json
  $executed = @($vitest.testResults | ForEach-Object { $_.assertionResults } | Where-Object { $_.status -in @('passed','failed') })
  if ($executed.Count -ne 1 -or $executed[0].fullName -cne 'native authoring lifecycle retains and navigates 100 same-length revisions of a large native plan') { throw 'original single-case result missing' }
  $caseOutcome = $executed[0].status
  # The packet came from this invocation's private pipes. Worker identity is self-reported metadata.
  $qualified = $cpu.status -eq 'captured' -and $cpu.Contains('summary') -and $cpu.summary.analyzedTraces -gt 0 -and
    $cpu.pid -gt 0 -and $cpu.session -gt 0 -and $cpu.bun -ceq $runtime.bun -and $cpu.revision -ceq $runtime.revision -and
    $cpu.outcome -ceq $(if ($executed[0].status -eq 'passed') {'Success'} else {'Failure'}) -and
    $result.RootReturned -and $result.PipesDrained -and -not $result.Forced -and -not $result.OutputFault -and
    -not $result.RootFault -and $null -ne $result.OriginalExit
} catch { $exportFault = $true }
$rawRemoved = $false
try { Remove-Item -LiteralPath $raw -Recurse -Force; $rawRemoved = -not (Test-Path -LiteralPath $raw) } catch { $exportFault = $true }
$qualified = $qualified -and $rawRemoved -and -not $exportFault
$control = [ordered]@{version=1; runID=$claim.runID; attempt=1; head=$claim.head; runtime=$runtime; qualified=$qualified;
  originalExit=$result.OriginalExit; originalCaseOutcome=$caseOutcome; rootExit=$result.RootExit; rootReturned=$result.RootReturned;
  rootPid=$result.RootPid; rootStartTicks=$result.RootStartTicks; bestEffortTreeKill=$result.Forced;
  outputFault=$result.OutputFault; rootFault=$result.RootFault; pipesDrained=$result.PipesDrained; rootDrainMs=$result.RootDrainMs;
  containment='existing-hosted-Windows-15minute-step-20minute-job-lifecycle';
  workerMetadata='self-reported-profile-pid-session-runtime;not-OS-child-return-proof';
  exportFault=$exportFault; rawRemoved=$rawRemoved; qualification=$checks.ToArray(); interpretation='attribution-only-no-timing-acceptance';
  limits='descendant-quiescence-and-exact-platform-teardown-time-unknown;native-profile-allocation-and-overhead-unbounded;logical-drain-deadline-does-not-preempt-kernel-IO'}

try {
  if ($cpu) { [IO.File]::WriteAllText((Join-Path $export 'cpu.json'), ($cpu | ConvertTo-Json -Depth 20 -Compress)) }
  if ($progress) { [IO.File]::WriteAllText((Join-Path $export 'progress.json'), ($progress | ConvertTo-Json -Depth 20 -Compress)) }
  [IO.File]::WriteAllText((Join-Path $export 'control.json'), ($control | ConvertTo-Json -Depth 20 -Compress))
  $files = @(Get-ChildItem -LiteralPath $export -File)
  if (@($files | Where-Object { $_.Name -cnotin @('claim.json','cpu.json','progress.json','control.json') }).Count -or
    ($files | Measure-Object Length -Sum).Sum -gt 1MB) { throw 'export allowlist/cap' }
} catch {
  # Best effort failure receipt follows termination/drain; it never grants qualification.
  $control.qualified = $false; $control.exportFault = $true
  try { [IO.File]::WriteAllText((Join-Path $export 'control.json'), ($control | ConvertTo-Json -Depth 20 -Compress)) } catch {}
  if ($null -ne $result.OriginalExit -and $result.OriginalExit -ne 0) { exit $result.OriginalExit }
  throw 'sanitized export failed; capture unqualified'
}
if ($null -ne $result.OriginalExit -and $result.OriginalExit -ne 0) { exit $result.OriginalExit }
if ($caseOutcome -eq 'failed' -or -not $qualified) { exit 1 }
exit 0

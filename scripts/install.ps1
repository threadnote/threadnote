[CmdletBinding(PositionalBinding = $false)]
param(
  [switch]$Beta,
  [switch]$DryRun,
  [switch]$Force,
  [switch]$NoStart,
  [switch]$NoModelSetup,
  [switch]$WithHooks,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ThreadnoteArgs
)

$ErrorActionPreference = 'Stop'
$repository = if ($env:THREADNOTE_REPOSITORY) { $env:THREADNOTE_REPOSITORY } else { 'threadnote/threadnote' }
$officialRepositories = @('Kashkovsky/threadnote', 'threadnote/threadnote')
$channel = if ($Beta) { 'beta' } elseif ($env:THREADNOTE_CHANNEL) { $env:THREADNOTE_CHANNEL } else { 'latest' }
$releaseSource = if ($env:THREADNOTE_RELEASE_SOURCE) {
  $env:THREADNOTE_RELEASE_SOURCE
} else {
  "https://api.github.com/repos/$repository/releases?per_page=100"
}
$installationLockWait = [TimeSpan]::FromMinutes(10)
$installationLockStaleAge = [TimeSpan]::FromMinutes(1)
$downloadTimeout = [TimeSpan]::FromMinutes(15)
$installationLockAcquired = $false
$installationLockPath = $null
$installationLockToken = $null

function Read-ThreadnoteInstallationLock {
  param([Parameter(Mandatory = $true)][string]$Path)
  return ([string](Get-Content -LiteralPath $Path -Raw -ErrorAction Stop)).Trim()
}

function Release-ThreadnoteInstallationLock {
  if (
    -not $script:installationLockAcquired -or
    -not $script:installationLockPath -or
    -not $script:installationLockToken
  ) { return }
  try {
    $observed = Read-ThreadnoteInstallationLock $script:installationLockPath
    if ($observed -ceq $script:installationLockToken) {
      Remove-Item -LiteralPath $script:installationLockPath -Force -ErrorAction Stop
    }
  } catch [System.IO.FileNotFoundException], [System.Management.Automation.ItemNotFoundException] {
  } finally {
    $script:installationLockAcquired = $false
    $script:installationLockPath = $null
    $script:installationLockToken = $null
  }
}

function Get-ThreadnoteProcessStartIdentity {
  param([Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process)
  try {
    return "win32:$($Process.StartTime.ToUniversalTime().Ticks)"
  } catch {
    return $null
  }
}

function Get-ThreadnoteLockOwner {
  param([Parameter(Mandatory = $true)][AllowNull()][AllowEmptyString()][string]$Token)
  if (-not $Token) { return $null }
  if ($Token.StartsWith('{')) {
    try {
      $parsed = $Token | ConvertFrom-Json
      $parsedProcessId = 0
      if (
        $parsed.version -eq 1 -and
        [int]::TryParse([string]$parsed.processId, [ref]$parsedProcessId) -and
        $parsedProcessId -gt 0
      ) {
        return [PSCustomObject]@{
          ProcessId = $parsedProcessId
          ProcessStartIdentity = if ($parsed.processStartIdentity) {
            [string]$parsed.processStartIdentity
          } else {
            $null
          }
        }
      }
    } catch {
      return $null
    }
    return $null
  }
  $ownerText = ($Token -split ':', 2)[0]
  $ownerProcessId = 0
  if ([int]::TryParse($ownerText, [ref]$ownerProcessId) -and $ownerProcessId -gt 0) {
    return [PSCustomObject]@{
      ProcessId = $ownerProcessId
      ProcessStartIdentity = $null
    }
  }
  return $null
}

function Enter-ThreadnoteInstallationLock {
  param([Parameter(Mandatory = $true)][string]$Path)
  $script:installationLockPath = $Path
  $currentProcess = Get-Process -Id $PID -ErrorAction Stop
  $currentProcessStartIdentity = Get-ThreadnoteProcessStartIdentity $currentProcess
  $lockOwner = @{
    processId = $PID
    token = "bootstrap-installer:$([Guid]::NewGuid().ToString('N'))"
    version = 1
  }
  if ($currentProcessStartIdentity) {
    $lockOwner.processStartIdentity = $currentProcessStartIdentity
  }
  $script:installationLockToken = $lockOwner | ConvertTo-Json -Compress
  $startedAt = [DateTimeOffset]::UtcNow
  while ($true) {
    try {
      $stream = [IO.FileStream]::new($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      try {
        $content = [Text.Encoding]::UTF8.GetBytes("$($script:installationLockToken)`n")
        $stream.Write($content, 0, $content.Length)
        $stream.Flush($true)
      } finally {
        $stream.Dispose()
      }
      $script:installationLockAcquired = $true
      return
    } catch [System.IO.IOException] {
      $observed = try {
        Read-ThreadnoteInstallationLock $Path
      } catch {
        ''
      }
      $ownerInfo = Get-ThreadnoteLockOwner $observed
      if ($ownerInfo) {
        $ownerProcess = Get-Process -Id $ownerInfo.ProcessId -ErrorAction SilentlyContinue
        $ownerIsStale = -not $ownerProcess
        if ($ownerProcess -and $ownerInfo.ProcessStartIdentity) {
          $currentOwnerStartIdentity = Get-ThreadnoteProcessStartIdentity $ownerProcess
          if (
            $currentOwnerStartIdentity -and
            $currentOwnerStartIdentity -cne $ownerInfo.ProcessStartIdentity
          ) {
            $ownerIsStale = $true
          }
        }
        if ($ownerIsStale) {
          $current = try {
            Read-ThreadnoteInstallationLock $Path
          } catch {
            ''
          }
          if ($current -ceq $observed) {
            Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
            continue
          }
        }
      } else {
        $lockInfo = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
        if ($lockInfo -and ([DateTime]::UtcNow - $lockInfo.LastWriteTimeUtc -ge $installationLockStaleAge)) {
          $observedLastWriteTimeTicks = $lockInfo.LastWriteTimeUtc.Ticks
          $observedLength = $lockInfo.Length
          $current = try {
            Read-ThreadnoteInstallationLock $Path
          } catch {
            ''
          }
          $currentInfo = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
          if (
            $currentInfo -and
            $current -ceq $observed -and
            $currentInfo.LastWriteTimeUtc.Ticks -eq $observedLastWriteTimeTicks -and
            $currentInfo.Length -eq $observedLength
          ) {
            Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
            continue
          }
        }
      }
      if ([DateTimeOffset]::UtcNow - $startedAt -ge $installationLockWait) {
        throw "Timed out waiting for Threadnote installation lock: $Path"
      }
      Start-Sleep -Milliseconds 100
    }
  }
}

function ConvertTo-ThreadnoteSemver {
  param([Parameter(Mandatory = $true)][string]$Version)
  if ($Version -notmatch '^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z.-]+))?$') {
    return $null
  }
  return [PSCustomObject]@{
    Major = [int64]$Matches[1]
    Minor = [int64]$Matches[2]
    Patch = [int64]$Matches[3]
    Prerelease = [string]$Matches[4]
  }
}

function Compare-ThreadnoteSemver {
  param(
    [Parameter(Mandatory = $true)][string]$Left,
    [Parameter(Mandatory = $true)][string]$Right
  )
  $leftVersion = ConvertTo-ThreadnoteSemver $Left
  $rightVersion = ConvertTo-ThreadnoteSemver $Right
  if (-not $leftVersion -or -not $rightVersion) {
    throw 'Cannot compare an invalid Threadnote release version.'
  }
  foreach ($field in @('Major', 'Minor', 'Patch')) {
    if ($leftVersion.$field -ne $rightVersion.$field) {
      return $(if ($leftVersion.$field -gt $rightVersion.$field) { 1 } else { -1 })
    }
  }
  if (-not $leftVersion.Prerelease -and $rightVersion.Prerelease) { return 1 }
  if ($leftVersion.Prerelease -and -not $rightVersion.Prerelease) { return -1 }
  if (-not $leftVersion.Prerelease) { return 0 }
  $leftIdentifiers = $leftVersion.Prerelease -split '\.'
  $rightIdentifiers = $rightVersion.Prerelease -split '\.'
  $count = [Math]::Min($leftIdentifiers.Count, $rightIdentifiers.Count)
  for ($index = 0; $index -lt $count; $index += 1) {
    $leftId = $leftIdentifiers[$index]
    $rightId = $rightIdentifiers[$index]
    if ($leftId -ceq $rightId) { continue }
    $leftNumber = 0L
    $rightNumber = 0L
    $leftNumeric = [int64]::TryParse($leftId, [ref]$leftNumber)
    $rightNumeric = [int64]::TryParse($rightId, [ref]$rightNumber)
    if ($leftNumeric -and $rightNumeric) { return $(if ($leftNumber -gt $rightNumber) { 1 } else { -1 }) }
    if ($leftNumeric -ne $rightNumeric) { return $(if ($leftNumeric) { -1 } else { 1 }) }
    return $(if ([string]::CompareOrdinal($leftId, $rightId) -gt 0) { 1 } else { -1 })
  }
  if ($leftIdentifiers.Count -eq $rightIdentifiers.Count) { return 0 }
  return $(if ($leftIdentifiers.Count -gt $rightIdentifiers.Count) { 1 } else { -1 })
}

function Get-ThreadnoteSha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  $utilityModule = Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1'
  if (Test-Path -LiteralPath $utilityModule) {
    Import-Module $utilityModule -Force -ErrorAction Stop
    return (Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  }

  $stream = [IO.File]::OpenRead($Path)
  try {
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
      $hashBytes = $hasher.ComputeHash($stream)
      $hashText = [BitConverter]::ToString($hashBytes)
      return $hashText.Replace('-', '').ToLowerInvariant()
    } finally {
      $hasher.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

function Invoke-ThreadnoteWithRetry {
  param(
    [Parameter(Mandatory = $true)][string]$Operation,
    [Parameter(Mandatory = $true)][scriptblock]$Action
  )
  $maximumAttempts = 4
  for ($attempt = 1; $attempt -le $maximumAttempts; $attempt += 1) {
    try {
      return & $Action
    } catch {
      if ($attempt -eq $maximumAttempts) {
        throw @"
$Operation failed after $maximumAttempts attempts: $($_.Exception.Message)
$($_.InvocationInfo.PositionMessage)
$($_.ScriptStackTrace)
"@
      }
      Start-Sleep -Seconds ([Math]::Min($attempt, 3))
    }
  }
}

function Save-ThreadnoteDownload {
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][string]$Path
  )

  Add-Type -AssemblyName System.Net.Http
  try {
    Invoke-ThreadnoteWithRetry "Download $Uri" {
      Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
      $client = [System.Net.Http.HttpClient]::new()
      $cancellation = [System.Threading.CancellationTokenSource]::new()
      $response = $null
      $sourceStream = $null
      $destinationStream = $null
      try {
        $client.Timeout = [System.Threading.Timeout]::InfiniteTimeSpan
        $client.DefaultRequestHeaders.UserAgent.ParseAdd('threadnote-installer')
        $cancellation.CancelAfter($downloadTimeout)
        $response = $client.GetAsync(
          $Uri,
          [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead,
          $cancellation.Token
        ).GetAwaiter().GetResult()
        $null = $response.EnsureSuccessStatusCode()
        $sourceStream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $destinationStream = [IO.FileStream]::new(
          $Path,
          [IO.FileMode]::CreateNew,
          [IO.FileAccess]::Write,
          [IO.FileShare]::None
        )
        $sourceStream.CopyToAsync($destinationStream, 81920, $cancellation.Token).GetAwaiter().GetResult()
        $destinationStream.Flush($true)
      } finally {
        if ($destinationStream) { $destinationStream.Dispose() }
        if ($sourceStream) { $sourceStream.Dispose() }
        if ($response) { $response.Dispose() }
        $cancellation.Dispose()
        $client.Dispose()
      }
    }
  } catch {
    Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    throw
  }
}

function Assert-ThreadnoteArchivePath {
  param(
    [Parameter(Mandatory = $true)][string]$Value,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if (
    -not $Value -or
    $Value -match '^[/\\]' -or
    $Value -match '^[A-Za-z]:' -or
    $Value.Contains('\')
  ) {
    throw "Unsafe release archive: $Label is absolute or uses a platform-specific separator: $Value"
  }
  $components = @()
  foreach ($component in ($Value -split '/')) {
    if (-not $component -or $component -eq '.') { continue }
    if ($component -eq '..') {
      if ($components.Count -eq 0) {
        throw "Unsafe release archive: $Label escapes the extraction root: $Value"
      }
      if ($components.Count -eq 1) {
        $components = @()
      } else {
        $components = @($components[0..($components.Count - 2)])
      }
      continue
    }
    $components += $component
  }
}

function Assert-ThreadnoteReleaseArchive {
  param([Parameter(Mandatory = $true)][string]$Path)
  $entries = @(& tar.exe -tzf $Path)
  if ($LASTEXITCODE -ne 0) {
    throw 'Could not inspect the release archive.'
  }
  $verboseEntries = @(& tar.exe -tvzf $Path)
  if ($LASTEXITCODE -ne 0) {
    throw 'Could not inspect release archive entry types.'
  }
  if ($entries.Count -eq 0 -or $entries.Count -ne $verboseEntries.Count) {
    throw 'Unsafe release archive: archive listings have different entry counts or are empty.'
  }
  for ($index = 0; $index -lt $entries.Count; $index += 1) {
    $entry = [string]$entries[$index]
    Assert-ThreadnoteArchivePath -Value $entry -Label 'entry path'
    $verboseEntry = [string]$verboseEntries[$index]
    if (-not $verboseEntry) {
      throw "Unsafe release archive: entry type is missing for $entry"
    }
    $type = $verboseEntry.Substring(0, 1)
    if ($type -notin @('-', 'd')) {
      throw "Unsafe release archive: unsupported entry type $type for $entry"
    }
  }
}

function Recover-ThreadnoteReleasePromotion {
  param(
    [Parameter(Mandatory = $true)][string]$ReleaseRoot,
    [Parameter(Mandatory = $true)][string]$StagedRoot,
    [Parameter(Mandatory = $true)][string]$BackupRoot,
    [Parameter(Mandatory = $true)][string]$JournalPath
  )
  if (Test-Path -LiteralPath $BackupRoot) {
    if (Test-Path -LiteralPath $ReleaseRoot) {
      Remove-Item -LiteralPath $BackupRoot -Recurse -Force
    } else {
      Move-Item -LiteralPath $BackupRoot -Destination $ReleaseRoot
    }
  }
  Remove-Item -LiteralPath $StagedRoot -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $JournalPath -Force -ErrorAction SilentlyContinue
}

function Write-ThreadnotePromotionJournal {
  param(
    [Parameter(Mandatory = $true)][string]$ReleaseRoot,
    [Parameter(Mandatory = $true)][string]$StagedRoot,
    [Parameter(Mandatory = $true)][string]$BackupRoot,
    [Parameter(Mandatory = $true)][string]$JournalPath
  )
  $temporary = "$JournalPath.$PID.tmp"
  $content = @{
    backupRoot = $BackupRoot
    releaseRoot = $ReleaseRoot
    stagedRoot = $StagedRoot
    version = 1
  } | ConvertTo-Json -Compress
  $encoding = [Text.UTF8Encoding]::new($false)
  [IO.File]::WriteAllText($temporary, "$content`n", $encoding)
  Move-Item -LiteralPath $temporary -Destination $JournalPath -Force
}

function Invoke-ThreadnotePromotionFault {
  param([Parameter(Mandatory = $true)][string]$Step)
  if ($env:THREADNOTE_INSTALLER_FAIL_AFTER_PROMOTION_STEP -ceq $Step) {
    throw "Injected installer interruption after promotion step: $Step"
  }
}

function Resolve-ThreadnoteVersion {
  $requestedVersion = if ($env:THREADNOTE_VERSION) { $env:THREADNOTE_VERSION.TrimStart('v') } else { $null }
  $prerelease = if ($requestedVersion) {
    $null
  } else {
    switch ($channel) {
      'latest' { $false }
      'stable' { $false }
      'beta' { $null }
      default { throw 'THREADNOTE_CHANNEL must be latest, stable, or beta.' }
    }
  }
  $headers = @{
    Accept = 'application/vnd.github+json'
    'User-Agent' = 'threadnote-installer'
  }
  $release = $null
  $selectedVersion = $null
  # Windows PowerShell 5.1 emits a top-level REST JSON array as one pipeline
  # object. Store the response first so foreach enumerates the array itself.
  $releaseResponse = Invoke-ThreadnoteWithRetry 'Fetch Threadnote releases' {
    Invoke-RestMethod -Uri $releaseSource -Headers $headers -TimeoutSec 60
  }
  foreach ($candidate in $releaseResponse) {
    if ($candidate.draft -or $candidate.immutable -ne $true) { continue }
    if (-not $requestedVersion -and $null -ne $prerelease -and [bool]$candidate.prerelease -ne $prerelease) {
      continue
    }
    $candidateVersion = ([string]$candidate.tag_name).TrimStart('v')
    if (-not (ConvertTo-ThreadnoteSemver $candidateVersion)) { continue }
    if ($requestedVersion -and $candidateVersion -cne $requestedVersion) { continue }
    if (-not $selectedVersion -or (Compare-ThreadnoteSemver $candidateVersion $selectedVersion) -gt 0) {
      $release = $candidate
      $selectedVersion = $candidateVersion
    }
  }
  if (-not $release) {
    if ($requestedVersion) {
      throw "Threadnote $requestedVersion is not a published immutable release."
    }
    throw "No immutable $channel Threadnote release is currently published."
  }
  return $selectedVersion
}

$architecture = switch ($env:PROCESSOR_ARCHITECTURE.ToUpperInvariant()) {
  'AMD64' { 'x64' }
  'ARM64' { 'arm64' }
  default { throw "Threadnote standalone releases do not support $env:PROCESSOR_ARCHITECTURE." }
}
$version = Resolve-ThreadnoteVersion
if ($version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$') {
  throw 'Resolved release version is invalid.'
}
$artifact = "threadnote-windows-$architecture.tar.gz"
$tag = "v$version"
$downloadRoot = if ($env:THREADNOTE_RELEASE_DOWNLOAD_ROOT) {
  $env:THREADNOTE_RELEASE_DOWNLOAD_ROOT.TrimEnd('/')
} else {
  "https://github.com/$repository/releases/download/$tag"
}
$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) "threadnote-install-$([Guid]::NewGuid().ToString('N'))"
$archive = Join-Path $temporaryRoot $artifact
$checksumPath = "$archive.sha256"

New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
try {
  Write-Host "Downloading Threadnote $version for windows-$architecture"
  Save-ThreadnoteDownload "$downloadRoot/$artifact" $archive
  Save-ThreadnoteDownload "$downloadRoot/$artifact.sha256" $checksumPath
  $checksumLine = [string](
    Get-Content -LiteralPath $checksumPath |
      Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } |
      Select-Object -First 1
  )
  $checksumLine = $checksumLine.Trim()
  if ($checksumLine -notmatch '^([a-fA-F0-9]{64})(?:\s+\*?(.+))?$') {
    throw "Release checksum document is invalid for $artifact."
  }
  if ($Matches[2] -and $Matches[2] -ne $artifact) {
    throw "Release checksum document names $($Matches[2]) instead of $artifact."
  }
  $expected = $Matches[1].ToLowerInvariant()
  $actual = Get-ThreadnoteSha256 $archive
  if ($actual -ne $expected) {
    throw "Checksum verification failed for $artifact (expected $expected, received $actual)."
  }
  Assert-ThreadnoteReleaseArchive $archive

  $installRoot = if ($env:THREADNOTE_INSTALL_ROOT) {
    $env:THREADNOTE_INSTALL_ROOT
  } elseif ($env:LOCALAPPDATA) {
    Join-Path $env:LOCALAPPDATA 'Threadnote'
  } else {
    Join-Path $HOME '.local\share\threadnote'
  }
  $installRoot = [IO.Path]::GetFullPath($installRoot)
  $launcherRoot = if ($env:THREADNOTE_BIN_DIR) {
    $env:THREADNOTE_BIN_DIR
  } elseif ($env:LOCALAPPDATA) {
    Join-Path $env:LOCALAPPDATA 'Threadnote\bin'
  } else {
    Join-Path $HOME '.local\bin'
  }
  $versionsRoot = Join-Path $installRoot 'versions'
  $releaseRoot = Join-Path $versionsRoot $version
  New-Item -ItemType Directory -Path $versionsRoot -Force | Out-Null
  Enter-ThreadnoteInstallationLock (Join-Path $installRoot '.installation.lock')
  $stagedRoot = Join-Path $versionsRoot ".$version.bootstrap.staging"
  $backupRoot = Join-Path $versionsRoot ".$version.promotion-backup"
  $promotionJournal = Join-Path $versionsRoot ".$version.promotion.json"
  Recover-ThreadnoteReleasePromotion $releaseRoot $stagedRoot $backupRoot $promotionJournal
  New-Item -ItemType Directory -Path $stagedRoot | Out-Null
  & tar.exe -xzf $archive -C $stagedRoot
  if ($LASTEXITCODE -ne 0) {
    throw "Could not extract $artifact."
  }
  $metadataPath = Join-Path $stagedRoot 'release.json'
  $executable = Join-Path $stagedRoot 'threadnote.exe'
  $nativeRuntime = Join-Path $stagedRoot 'runtime\node-llama-cpp.js'
  if (
    -not (Test-Path -LiteralPath $metadataPath) -or
    -not (Test-Path -LiteralPath $executable) -or
    -not (Test-Path -LiteralPath $nativeRuntime)
  ) {
    throw 'Release artifact validation failed: executable, metadata, or native runtime is missing.'
  }
  $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
  $metadataVersion = $metadata.version
  $metadataExecutable = $metadata.executable
  $codeSignature = $metadata.codeSignature
  if (
    $metadataVersion -isnot [string] -or
    $metadataVersion -cne $version -or
    $metadataExecutable -isnot [string] -or
    $metadataExecutable -cne 'threadnote.exe' -or
    $codeSignature -isnot [string] -or
    $codeSignature -cne 'unsigned'
  ) {
    throw "Release metadata does not match Threadnote $version."
  }
  $officialRelease = (
    $officialRepositories -ccontains $repository -and
    -not $env:THREADNOTE_RELEASE_SOURCE -and
    -not $env:THREADNOTE_RELEASE_DOWNLOAD_ROOT
  )
  if ($officialRelease) {
    Write-Warning 'This Windows release is unsigned. Its immutable GitHub release and SHA-256 checksum were verified.'
  }

  Write-ThreadnotePromotionJournal $releaseRoot $stagedRoot $backupRoot $promotionJournal
  Invoke-ThreadnotePromotionFault 'journaled'
  if (Test-Path -LiteralPath $releaseRoot) {
    Move-Item -LiteralPath $releaseRoot -Destination $backupRoot
  }
  Invoke-ThreadnotePromotionFault 'previous-backed-up'
  try {
    Move-Item -LiteralPath $stagedRoot -Destination $releaseRoot
  } catch {
    Recover-ThreadnoteReleasePromotion $releaseRoot $stagedRoot $backupRoot $promotionJournal
    throw
  }
  Invoke-ThreadnotePromotionFault 'release-promoted'
  Remove-Item -LiteralPath $backupRoot -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $promotionJournal -Force -ErrorAction SilentlyContinue
  Release-ThreadnoteInstallationLock

  Write-Host "Installed standalone Threadnote $version"
  $installArgs = @('install')
  if ($DryRun) { $installArgs += '--dry-run' }
  if ($Force) { $installArgs += '--force' }
  if ($NoStart) { $installArgs += '--no-start' }
  if ($NoModelSetup) { $installArgs += '--no-model-setup' }
  if ($WithHooks) { $installArgs += '--with-hooks' }
  if ($ThreadnoteArgs) { $installArgs += $ThreadnoteArgs }

  $previousInstallRoot = $env:THREADNOTE_INSTALL_ROOT
  try {
    $env:THREADNOTE_INSTALL_ROOT = $installRoot
    & (Join-Path $releaseRoot 'threadnote.exe') @installArgs
    if ($LASTEXITCODE -ne 0) {
      throw "threadnote install failed with exit code $LASTEXITCODE."
    }
  } finally {
    if ($null -eq $previousInstallRoot) {
      Remove-Item Env:THREADNOTE_INSTALL_ROOT -ErrorAction SilentlyContinue
    } else {
      $env:THREADNOTE_INSTALL_ROOT = $previousInstallRoot
    }
  }
  if (-not $env:THREADNOTE_BIN_DIR) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $userPathEntries = @($userPath -split ';' | Where-Object { $_ })
    if (-not ($userPathEntries | Where-Object { $_.TrimEnd('\') -ieq $launcherRoot.TrimEnd('\') })) {
      $updatedUserPath = (@($launcherRoot) + $userPathEntries) -join ';'
      [Environment]::SetEnvironmentVariable('Path', $updatedUserPath, 'User')
      Write-Host "Added Threadnote command directory to the user PATH: $launcherRoot"
      Write-Host 'Open a new terminal before running threadnote.'
    }
  }
} finally {
  if ($stagedRoot) {
    Remove-Item -LiteralPath $stagedRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
  Release-ThreadnoteInstallationLock
  Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host 'Threadnote is installed. Next:'
Write-Host '  threadnote doctor --dry-run'
Write-Host '  threadnote mcp-install codex --apply    # if you use Codex'
Write-Host '  threadnote mcp-install claude --apply   # if you use Claude'
Write-Host '  threadnote mcp-install cursor --apply   # if you use Cursor'

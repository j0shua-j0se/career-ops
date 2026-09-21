<#
.SYNOPSIS
    Prints the "career-ops weekly prescan" scheduled task's last run time,
    next run time, and last result, plus a short read of prescan.mjs's own
    last summary and log.

.DESCRIPTION
    Read-only. Touches nothing — safe to run any time, does not require the
    task to be registered (it says so and points at register-prescan-task.ps1
    if it isn't).

    Two independent sources, both printed:
      1. Windows Task Scheduler's own record for the task (state, last run
         time, last result code, next scheduled run) via Get-ScheduledTaskInfo.
      2. prescan.mjs's own data\cache\prescan-summary.json (per-step exit
         codes/durations, found/new counts, pending left, JD ok/expired/other)
         and the tail of data\cache\prescan-last.log, which is what the
         scheduled task's cmd.exe wrapper redirects stdout/stderr into.

    A task can be registered but never have run yet (LastRunTime absent), and
    prescan.mjs can have run manually (`node prescan.mjs`) without ever going
    through the scheduled task — both sources are shown independently rather
    than assumed to agree.

.EXAMPLE
    .\scripts\prescan-status.ps1
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$TaskName = 'career-ops weekly prescan'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$SummaryPath = Join-Path $RepoRoot 'data\cache\prescan-summary.json'
$LogPath = Join-Path $RepoRoot 'data\cache\prescan-last.log'

Write-Host "=== Scheduled task ==="
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
    Write-Host "No scheduled task named '$TaskName' is registered."
    Write-Host "Register it with: scripts\register-prescan-task.ps1"
} else {
    $info = $task | Get-ScheduledTaskInfo
    $resultCode = $info.LastTaskResult
    $resultText =
        if ($null -eq $resultCode) { 'unknown (never run yet)' }
        elseif ($resultCode -eq 0) { 'success (0)' }
        elseif ($resultCode -eq 267011) { 'has not run yet (0x41303 / 267011)' }
        else { '0x{0:X8} ({0})' -f $resultCode }

    Write-Host "Name:        $($task.TaskName)"
    Write-Host "State:       $($task.State)"
    Write-Host "Last run:    $($info.LastRunTime)"
    Write-Host "Last result: $resultText"
    Write-Host "Next run:    $($info.NextRunTime)"
}

Write-Host ""
Write-Host "=== prescan.mjs's own summary (data\cache\prescan-summary.json) ==="
if (-not (Test-Path -LiteralPath $SummaryPath)) {
    Write-Host "No summary yet at $SummaryPath — prescan.mjs has not completed a run (manual or scheduled)."
} else {
    try {
        $summary = Get-Content -LiteralPath $SummaryPath -Raw | ConvertFrom-Json
        Write-Host "Started:      $($summary.started_at)"
        Write-Host "Finished:     $($summary.finished_at)"
        Write-Host "Free-rejected:$($summary.free_rejected)"
        Write-Host "Pending left: $($summary.pending_left)"
        if ($summary.jd) {
            Write-Host ("JD:           ok={0} expired={1} other={2}" -f $summary.jd.ok, $summary.jd.expired, $summary.jd.other)
        }
        if ($summary.steps) {
            Write-Host "Steps:"
            foreach ($name in $summary.steps.PSObject.Properties.Name) {
                $s = $summary.steps.$name
                $extra = @()
                if ($null -ne $s.found) { $extra += "found=$($s.found)" }
                if ($null -ne $s.new) { $extra += "new=$($s.new)" }
                if ($null -ne $s.error) { $extra += "error=`"$($s.error)`"" }
                Write-Host ("  {0,-20} exit={1} durationMs={2} {3}" -f $name, $s.exitCode, $s.durationMs, ($extra -join ' '))
            }
        }
    } catch {
        Write-Host "Could not parse $($SummaryPath) — $($_.Exception.Message)"
    }
}

if (Test-Path -LiteralPath $LogPath) {
    Write-Host ""
    Write-Host "=== Last run's log tail (data\cache\prescan-last.log) ==="
    Get-Content -LiteralPath $LogPath -Tail 15
}

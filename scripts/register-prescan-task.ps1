<#
.SYNOPSIS
    Registers (or unregisters) the "career-ops weekly prescan" Windows
    scheduled task. Written by prescan.mjs's own orchestrator — reviewed and
    RUN BY HAND. Nothing in this repo calls this script automatically.

.DESCRIPTION
    Registers a PER-USER scheduled task named "career-ops weekly prescan" that
    runs `node prescan.mjs` in this repo every Sunday at 02:00. prescan.mjs is
    the unattended, zero-token stage of the job-search pipeline (portal scan,
    ATS sweep, pre-screen, JD pre-fetch) — see prescan.mjs's own header for why
    it exists as a separate, schedulable step from `/career-ops run`.

    Deliberately narrow, matching the constraints it was written to:
      - LogonType Interactive, RunLevel Limited: runs only while the user is
        logged on, with NO stored password and NO elevation. A background
        S4U/Password logon was explicitly ruled out.
      - Weekly, Sunday 02:00 — see New-ScheduledTaskTrigger below.
      - StartWhenAvailable / DontStopIfGoingOnBatteries / AllowStartIfOnBatteries
        / a 6-hour ExecutionTimeLimit, exactly as specified: a missed Sunday
        (laptop asleep) still runs once the machine wakes, a multi-hour ATS
        sweep is not treated as "stuck" and killed on battery, and a genuinely
        hung run is capped rather than left running forever.
      - node's full path is resolved HERE, at registration time, and baked
        into the task action — Task Scheduler runs outside the interactive
        shell's PATH, so a bare "node" in the action fails silently (the task
        shows "Ready", never produces output).
      - stdout/stderr are redirected to data\cache\prescan-last.log via a
        cmd.exe wrapper — Task Scheduler has no native output redirection for
        an arbitrary executable action. The log is OVERWRITTEN each run (">"
        not ">>"), matching its "-last" name; prescan.mjs's own
        data\prescan-log.md is the durable, append-only, per-run audit trail.

    Idempotent: re-running this script (e.g. after a `node` upgrade changes
    the resolved path) replaces the existing task definition in place via
    Register-ScheduledTask -Force. It does not register duplicate tasks.

    This script does NOT run prescan.mjs, does not commit/push/switch
    branches, and does not touch any career-ops data file. It only touches
    the Windows Task Scheduler.

.PARAMETER Unregister
    Remove the "career-ops weekly prescan" task instead of registering it.

.EXAMPLE
    .\scripts\register-prescan-task.ps1
    Registers the weekly Sunday 02:00 task.

.EXAMPLE
    .\scripts\register-prescan-task.ps1 -WhatIf
    Shows what would be registered, without changing anything.

.EXAMPLE
    .\scripts\register-prescan-task.ps1 -Unregister
    Removes the task.

.NOTES
    Requires Windows PowerShell 5.1's ScheduledTasks module (built in on
    Windows 11). Must be run as the user the task should run under — no
    elevation is requested or required.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$Unregister
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$TaskName = 'career-ops weekly prescan'
# scripts\ -> repo root. Resolved from the script's own path so this works
# regardless of the caller's current directory.
$RepoRoot = Split-Path -Parent $PSScriptRoot
$LogPath = Join-Path $RepoRoot 'data\cache\prescan-last.log'
$LogDir = Split-Path -Parent $LogPath

# ── -Unregister ──────────────────────────────────────────────────────────────
if ($Unregister) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $existing) {
        Write-Host "career-ops: no scheduled task named '$TaskName' is registered — nothing to remove."
        return
    }
    if ($PSCmdlet.ShouldProcess($TaskName, 'Unregister scheduled task')) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "career-ops: unregistered scheduled task '$TaskName'."
    }
    return
}

# ── Preconditions ────────────────────────────────────────────────────────────

# Resolve node's full path NOW — see .DESCRIPTION. Fails loudly rather than
# baking in a bare "node" that would silently never run.
$NodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $NodeCmd) {
    $NodeCmd = Get-Command node -ErrorAction SilentlyContinue
}
if (-not $NodeCmd) {
    throw "career-ops: could not resolve 'node' on PATH for this user. Install Node 24 (or make sure it's on PATH for a NON-elevated shell — Task Scheduler runs as this user, not as an admin) and re-run this script."
}
$NodePath = $NodeCmd.Source

$PrescanScript = Join-Path $RepoRoot 'prescan.mjs'
if (-not (Test-Path -LiteralPath $PrescanScript)) {
    throw "career-ops: prescan.mjs not found at $PrescanScript — is this script still under <repo>\scripts\?"
}

if (-not (Test-Path -LiteralPath $LogDir)) {
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
}

# ── Task definition ──────────────────────────────────────────────────────────

# cmd.exe /c wraps the action so plain ">"/"2>&1" redirection works — Task
# Scheduler itself has no output-redirection option for an arbitrary EXE
# action. Every path is fully quoted (repo paths may contain spaces).
$CmdArgument = '/c ""{0}" "{1}" > "{2}" 2>&1"' -f $NodePath, $PrescanScript, $LogPath

$Action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $CmdArgument -WorkingDirectory $RepoRoot

# Weekly, Sunday 02:00 — exactly as specified.
$Trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At '02:00'

# Interactive logon (runs only while this user is logged on; no password is
# ever stored for it) + Limited run level (no elevation, ever).
$UserId = "$env:USERDOMAIN\$env:USERNAME"
$Principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited

$Settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 6)

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$verb = if ($existing) { 'Re-register (update in place)' } else { 'Register' }

if ($PSCmdlet.ShouldProcess($TaskName, "$verb scheduled task — weekly, Sunday 02:00, node at $NodePath")) {
    # -Force makes this idempotent: a second run replaces the existing
    # definition (e.g. a changed node path) instead of erroring or duplicating.
    Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger `
        -Principal $Principal -Settings $Settings -Force | Out-Null
    Write-Host "career-ops: registered '$TaskName'."
    Write-Host "  Runs:     node prescan.mjs  (weekly, Sunday 02:00, as $UserId, no elevation)"
    Write-Host "  Node:     $NodePath"
    Write-Host "  Log:      $LogPath (overwritten each run)"
    Write-Host "  Working:  $RepoRoot"
    Write-Host ""
    Write-Host "Review any time with: scripts\prescan-status.ps1"
    Write-Host "Remove with:          scripts\register-prescan-task.ps1 -Unregister"
}

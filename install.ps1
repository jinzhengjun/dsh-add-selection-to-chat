# Registers dsh-add-selection-to-chat as an installed bundle in a DSH profile.
#
# This is the same two-step registration the Plugin Manager performs:
#   1. `dsh plugin --profile <p> add <dir>` — pnpm records the profile dependency
#      (a `link:` to this directory) and creates node_modules/dsh-add-selection-to-chat;
#   2. append the name to the profile manifest's `dsh.profile.bundles` so its
#      `cordis.patch.yml` layer is actually applied.
#
# Both steps are what make the bundle show up under 插件 → 已安装: the list is
# built from the profile's dependency record, not from the Loader rows.
#
# Writes outside the workspace, so it needs an unrestricted shell.

[CmdletBinding()]
param(
    [string]$Profile = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop'),
    [string]$Name = 'dsh-add-selection-to-chat'
)

$ErrorActionPreference = 'Stop'

$packageDir = $PSScriptRoot
$profileName = Split-Path -Leaf $Profile
$manifestPath = Join-Path $Profile 'package.json'

function Find-DshCli {
    $command = Get-Command dsh -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $process = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($process -and $process.Path) {
        $candidate = Join-Path (Split-Path $process.Path) 'resources\runtime\cli\bin\dsh.cmd'
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    return $null
}

# --- legacy cleanup --------------------------------------------------------------
# Earlier versions of this package registered by hand: a copied directory under
# node_modules plus an `insert` block in cordis.patch.yml. Both would collide with
# the bundle row, so drop them if present.
$legacyDir = Join-Path $Profile "node_modules\$Name"
if (Test-Path -LiteralPath $legacyDir) {
    $item = Get-Item -LiteralPath $legacyDir -Force
    if (-not $item.LinkType) {
        Remove-Item -LiteralPath $legacyDir -Recurse -Force
        Write-Host "removed legacy copy $legacyDir"
    }
}

$patchPath = Join-Path $Profile 'cordis.patch.yml'
if (Test-Path -LiteralPath $patchPath) {
    $patchText = Get-Content -LiteralPath $patchPath -Raw -Encoding utf8
    $pattern = "(?ms)^# >>> " + [regex]::Escape($Name) + " \(managed by install\.ps1\).*?^# <<< " + [regex]::Escape($Name) + "[^\r\n]*(?:\r?\n)?"
    if ($patchText -match $pattern) {
        $patchText = [regex]::Replace($patchText, $pattern, '')
        if ($patchText.Trim().Length -gt 0) { $patchText = $patchText.TrimEnd() + "`n" }
        $encoding = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($patchPath, $patchText, $encoding)
        Write-Host 'removed legacy cordis.patch.yml block'
    }
}

# --- 1. pnpm dependency ----------------------------------------------------------
$cli = Find-DshCli
if (-not $cli) {
    throw @"
Could not find the dsh CLI. Run it yourself from the profile directory:

    dsh plugin --profile $profileName add "$packageDir"

or use 插件 → 添加插件 in the app and paste this absolute path:

    $packageDir
"@
}

Write-Host "registering $Name -> $packageDir"
& cmd /c "`"$cli`" plugin --profile $profileName add `"$packageDir`""
if ($LASTEXITCODE -ne 0) { throw "dsh plugin add failed with exit code $LASTEXITCODE" }

# --- 2. bundle selection ---------------------------------------------------------
$manifest = [System.IO.File]::ReadAllText($manifestPath)
if ($manifest -notmatch [regex]::Escape($Name)) {
    $updated = [regex]::Replace($manifest, '(?s)("bundles"\s*:\s*\[)(.*?)(\])', {
            param($match)
            $inner = $match.Groups[2].Value.TrimEnd()
            $entry = "`n        `"$Name`""
            "$($match.Groups[1].Value)$inner,$entry`n      ]"
        })
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($manifestPath, $updated, $encoding)
    Write-Host 'selected the bundle layer in dsh.profile.bundles'
} else {
    Write-Host 'bundle layer already selected'
}

Write-Host ''
Write-Host 'installed' -ForegroundColor Green
Write-Host 'Restart the DSH desktop app, then check 插件 → 已安装 and the preview right-click menu.' -ForegroundColor Yellow

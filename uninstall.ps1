# Removes dsh-add-selection-to-chat from a DSH profile.
#
# The reverse of install.ps1, and of what 插件 → 已安装 → 移除 does:
#   1. drop the name from the profile manifest's `dsh.profile.bundles`;
#   2. `dsh plugin --profile <p> remove <name>` so pnpm forgets the dependency;
#   3. clean up the legacy hand-install this package used to ship (a copied
#      node_modules directory and a marked block in cordis.patch.yml).
#
# Restart DSH afterwards.

[CmdletBinding()]
param(
    [string]$Profile = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop'),
    [string]$Name = 'dsh-add-selection-to-chat'
)

$ErrorActionPreference = 'Stop'

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

$encoding = New-Object System.Text.UTF8Encoding($false)

# --- 1. bundle selection ---------------------------------------------------------
if (Test-Path -LiteralPath $manifestPath) {
    $manifest = [System.IO.File]::ReadAllText($manifestPath)
    if ($manifest -match [regex]::Escape($Name)) {
        $updated = [regex]::Replace($manifest, '(?s)("bundles"\s*:\s*\[)(.*?)(\])', {
                param($match)
                $entries = $match.Groups[2].Value -split ','
                $kept = $entries | Where-Object {
                    $line = $_.Trim()
                    $line.Length -gt 0 -and $line -notmatch [regex]::Escape($Name)
                }
                if ($kept.Count -eq 0) { return "$($match.Groups[1].Value)`n      ]" }
                $body = ($kept | ForEach-Object { $_.TrimEnd() }) -join ','
                "$($match.Groups[1].Value)$body`n      ]"
            })
        [System.IO.File]::WriteAllText($manifestPath, $updated, $encoding)
        Write-Host 'removed the bundle layer selection'
    }
}

# --- 2. pnpm dependency ----------------------------------------------------------
$cli = Find-DshCli
if ($cli) {
    & cmd /c "`"$cli`" plugin --profile $profileName remove $Name"
    if ($LASTEXITCODE -ne 0) { Write-Warning "dsh plugin remove exited with $LASTEXITCODE (dependency may already be gone)" }
} else {
    Write-Warning "dsh CLI not found; remove the dependency yourself: dsh plugin --profile $profileName remove $Name"
}

# --- 3. legacy hand-install ------------------------------------------------------
$legacyDir = Join-Path $Profile "node_modules\$Name"
if (Test-Path -LiteralPath $legacyDir) {
    Remove-Item -LiteralPath $legacyDir -Recurse -Force
    Write-Host "removed $legacyDir"
}

$patchPath = Join-Path $Profile 'cordis.patch.yml'
if (Test-Path -LiteralPath $patchPath) {
    $patchText = Get-Content -LiteralPath $patchPath -Raw -Encoding utf8
    $pattern = "(?ms)^# >>> " + [regex]::Escape($Name) + " \(managed by install\.ps1\).*?^# <<< " + [regex]::Escape($Name) + "[^\r\n]*(?:\r?\n)?"
    if ($patchText -match $pattern) {
        $patchText = [regex]::Replace($patchText, $pattern, '')
        if ($patchText.Trim().Length -gt 0) { $patchText = $patchText.TrimEnd() + "`n" }
        [System.IO.File]::WriteAllText($patchPath, $patchText, $encoding)
        Write-Host 'removed the legacy cordis.patch.yml block'
    }
}

Write-Host ''
Write-Host 'Removed. Restart the DSH desktop app.' -ForegroundColor Yellow
Write-Host 'The package directory itself (this folder) is untouched.' -ForegroundColor DarkGray

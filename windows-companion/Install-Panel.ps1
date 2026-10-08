# Installs the "VCUBF — ovládání a stav" window (VCUBF-Panel.ps1) for the live
# Secretary on Railway and points the desktop shortcut at it.
#
# Nothing is deleted: the file the shortcut pointed at before stays on disk, and
# its path is printed, so going back is only a matter of pointing the shortcut
# there again.

$ErrorActionPreference = 'Stop'

$source = Join-Path $PSScriptRoot 'VCUBF-Panel.ps1'
$webDir = Join-Path $env:LOCALAPPDATA 'VCUBF\SecretaryWeb'
if (-not (Test-Path -LiteralPath (Join-Path $webDir 'Open-SecretaryRailway.ps1'))) {
    throw "Secretary (Railway) is not set up on this PC: $webDir\Open-SecretaryRailway.ps1 is missing."
}

$target = Join-Path $webDir 'VCUBF-Panel.ps1'
Copy-Item -LiteralPath $source -Destination $target -Force

# The shortcut keeps its name; it is updated where it already is, so a desktop
# redirected to OneDrive does not end up with a second copy.
$name = 'VCUBF - ovladani a stav.lnk'
$candidates = @(
    (Join-Path $env:USERPROFILE "Desktop\$name"),
    (Join-Path ([Environment]::GetFolderPath('Desktop')) $name)
) | Select-Object -Unique
$link = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $link) { $link = Join-Path ([Environment]::GetFolderPath('Desktop')) $name }

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($link)
if ($shortcut.TargetPath) { Write-Output "Previous target: $($shortcut.TargetPath) $($shortcut.Arguments)" }
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -STA -File `"$target`""
$shortcut.WorkingDirectory = $webDir
if (Test-Path -LiteralPath 'C:\VCUBF\vcubf.ico') { $shortcut.IconLocation = 'C:\VCUBF\vcubf.ico' }
$shortcut.Description = 'VCUBF - ovladani a stav (Secretary na Railway)'
$shortcut.Save()

Write-Output "Installed: $target"
Write-Output "Shortcut:  $link"

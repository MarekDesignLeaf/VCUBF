param([switch]$StartNow)
$ErrorActionPreference='Stop'
$source=Split-Path -Parent $PSCommandPath
$target=Join-Path $env:LOCALAPPDATA 'VCUBF\Emma\app'
New-Item -ItemType Directory -Path $target -Force|Out-Null
Copy-Item -LiteralPath (Join-Path $source 'VCUBF-Emma.ps1') -Destination $target -Force
Copy-Item -LiteralPath (Join-Path $source 'Open-VCUBF.ps1') -Destination $target -Force
Copy-Item -LiteralPath (Join-Path $source 'emma_realtime.py') -Destination $target -Force
$script=Join-Path $target 'VCUBF-Emma.ps1'
$shell=New-Object -ComObject WScript.Shell
$shortcut=$shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Startup')) 'VCUBF Emma.lnk'))
$shortcut.TargetPath="$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$shortcut.Arguments="-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
$shortcut.WorkingDirectory=$target
$shortcut.IconLocation="$env:SystemRoot\System32\SHELL32.dll,220"
$shortcut.Save()
$desktopShortcut=$shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'VCUBF Secretary.lnk'))
$desktopShortcut.TargetPath="$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$desktopShortcut.Arguments="-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $target 'Open-VCUBF.ps1')`""
$desktopShortcut.WorkingDirectory=$target
$desktopShortcut.IconLocation="$env:SystemRoot\System32\imageres.dll,15"
$desktopShortcut.Save()
Write-Host "VCUBF Emma installed in $target"
if($StartNow){Start-Process -FilePath $shortcut.TargetPath -ArgumentList $shortcut.Arguments -WindowStyle Hidden}

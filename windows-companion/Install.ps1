param([switch]$StartNow)
$ErrorActionPreference='Stop'
$source=Split-Path -Parent $PSCommandPath
$target=Join-Path $env:LOCALAPPDATA 'VCUBF\Emma\app'
New-Item -ItemType Directory -Path $target -Force|Out-Null
Copy-Item -LiteralPath (Join-Path $source 'VCUBF-Emma.ps1') -Destination $target -Force
Copy-Item -LiteralPath (Join-Path $source 'Open-VCUBF.ps1') -Destination $target -Force
Copy-Item -LiteralPath (Join-Path $source 'emma_realtime.py') -Destination $target -Force
Copy-Item -LiteralPath (Join-Path $source 'requirements.txt') -Destination $target -Force
$python=$null
foreach($candidate in @('python.exe','py.exe')) {
  foreach($command in @(Get-Command $candidate -CommandType Application -ErrorAction SilentlyContinue)) {
    if(!$command.Source -or $command.Source -match '\\WindowsApps\\') { continue }
    $prefix=@()
    if([IO.Path]::GetFileName($command.Source) -match '^py\.exe$') { $prefix=@('-3') }
    & $command.Source @prefix --version *> $null
    if($LASTEXITCODE -eq 0) {
      $python=[pscustomobject]@{Path=$command.Source;Prefix=$prefix}
      break
    }
  }
  if($python) { break }
}
if($python) {
  $pythonPrefix=@($python.Prefix)
  & $python.Path @pythonPrefix -m pip install --disable-pip-version-check --quiet -r (Join-Path $source 'requirements.txt')
  if($LASTEXITCODE -ne 0) { throw 'VCUBF Emma audio dependencies could not be installed.' }
} else {
  Write-Warning 'Python 3 was not found. Realtime audio will remain unavailable until Python is installed and Install.ps1 is run again.'
}
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
if($StartNow){
  # Use the same secure launcher as the desktop icon.  On first use it waits
  # for browser approval before Emma opens the microphone; on later starts it
  # reuses the DPAPI-protected device pairing.
  Start-Process -FilePath $shortcut.TargetPath -ArgumentList "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $target 'Open-VCUBF.ps1')`"" -WindowStyle Hidden
}

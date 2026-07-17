param([switch]$StartNow)

$ErrorActionPreference='Stop'
$source=Split-Path -Parent $PSCommandPath
$target=Join-Path $env:LOCALAPPDATA 'VCUBF\Emma\app'
New-Item -ItemType Directory -Path $target -Force|Out-Null

foreach($file in @('emma_voice_v2.py','emma_realtime.py','Run-VoiceV2.ps1','voice-v2.example.json','requirements.txt','requirements-v2.txt')){
  Copy-Item -LiteralPath (Join-Path $source $file) -Destination $target -Force
}

$activeConfig=Join-Path (Split-Path -Parent $target) 'voice-v2.json'
if(!(Test-Path -LiteralPath $activeConfig)){
  Copy-Item -LiteralPath (Join-Path $source 'voice-v2.example.json') -Destination $activeConfig
}

$python=$null
foreach($candidate in @('python.exe','py.exe')) {
  foreach($command in @(Get-Command $candidate -CommandType Application -ErrorAction SilentlyContinue)) {
    if(!$command.Source -or $command.Source -match '\\WindowsApps\\'){continue}
    $prefix=@()
    if([IO.Path]::GetFileName($command.Source) -match '^py\.exe$'){$prefix=@('-3')}
    & $command.Source @prefix --version *> $null
    if($LASTEXITCODE -eq 0){$python=[pscustomobject]@{Path=$command.Source;Prefix=$prefix};break}
  }
  if($python){break}
}
if(!$python){throw 'Python 3 was not found. Install Python, then run Install-VoiceV2.ps1 again.'}

& $python.Path @($python.Prefix) -m pip install --disable-pip-version-check --quiet -r (Join-Path $source 'requirements-v2.txt')
if($LASTEXITCODE -ne 0){throw 'Emma Voice v2 dependencies could not be installed.'}

$shell=New-Object -ComObject WScript.Shell
$desktopShortcut=$shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'VCUBF Secretary — Voice v2.lnk'))
$desktopShortcut.TargetPath="$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$desktopShortcut.Arguments="-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $target 'Run-VoiceV2.ps1')`""
$desktopShortcut.WorkingDirectory=$target
$desktopShortcut.IconLocation="$env:SystemRoot\System32\imageres.dll,15"
$desktopShortcut.Save()

Write-Host "Emma Voice v2 installed in $target"
Write-Host "Configure $activeConfig and the named user environment variables before starting Voice v2."
if($StartNow){
  Start-Process -FilePath $desktopShortcut.TargetPath -ArgumentList $desktopShortcut.Arguments -WindowStyle Hidden
}

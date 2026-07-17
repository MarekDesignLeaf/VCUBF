param([switch]$StartNow)

$ErrorActionPreference='Stop'
$source=Split-Path -Parent $PSCommandPath
$projectRoot=Split-Path -Parent $source
$target=Join-Path $env:LOCALAPPDATA 'VCUBF\Emma\app'
$legacyV1Script=Join-Path $target 'VCUBF-Emma.ps1'
$legacyV1Runtime=Join-Path $target 'emma_realtime.py'
$v2Runner=Join-Path $target 'Run-VoiceV2.ps1'
$v2Runtime=Join-Path $target 'emma_voice_v2.py'
$unifiedLauncher=Join-Path $target 'Launch-VCUBFSecretary.ps1'
$legacyBrowserProfile=Join-Path (Split-Path -Parent $target) 'SecretaryBrowser'
$secretaryBrowserProfile=Join-Path (Split-Path -Parent $target) 'SecretaryBrowserV2'
New-Item -ItemType Directory -Path $target -Force|Out-Null

function Stop-InstallerProcessTree([int]$ProcessId){
  foreach($child in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue|Where-Object{$_.ParentProcessId -eq $ProcessId})){
    Stop-InstallerProcessTree ([int]$child.ProcessId)
  }
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

foreach($file in @('emma_voice_v2.py','emma_common.py','picovoice_wake.js','Run-VoiceV2.ps1','Configure-PicovoiceWake.ps1','Launch-VCUBFSecretary.ps1','voice-v2.example.json','requirements.txt','requirements-v2.txt')){
  Copy-Item -LiteralPath (Join-Path $source $file) -Destination $target -Force
}

# Voice v2 is now the only companion. Remove every legacy executable path,
# startup entry and duplicate shortcut before publishing the unified launcher.
foreach($legacy in @('WindowsSpeechWake.ps1','VCUBF-Emma.ps1','emma_realtime.py','Open-VCUBF.ps1')){
  Remove-Item -LiteralPath (Join-Path $target $legacy) -Force -ErrorAction SilentlyContinue
}
Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('Startup')) 'VCUBF Emma.lnk') -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('Desktop')) 'VCUBF Secretary — Voice v2.lnk') -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -and (
    $_.CommandLine.IndexOf($legacyV1Script,[StringComparison]::OrdinalIgnoreCase) -ge 0 -or
    $_.CommandLine.IndexOf($legacyV1Runtime,[StringComparison]::OrdinalIgnoreCase) -ge 0 -or
    $_.CommandLine.IndexOf($unifiedLauncher,[StringComparison]::OrdinalIgnoreCase) -ge 0 -or
    $_.CommandLine.IndexOf($v2Runner,[StringComparison]::OrdinalIgnoreCase) -ge 0 -or
    ($_.CommandLine.IndexOf($v2Runtime,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.CommandLine -like '*--run*')
  )
} | ForEach-Object { Stop-InstallerProcessTree ([int]$_.ProcessId) }
# Remove only stale local development runtimes from this VCUBF checkout. They
# otherwise keep ports 4000/5173 occupied after an older launcher was replaced.
Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -and $_.CommandLine.IndexOf($projectRoot,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and
  $_.CommandLine -match '(tsx.*src[\\/]server\.ts|vite.*--host)'
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -and (
    $_.CommandLine.IndexOf($legacyBrowserProfile,[StringComparison]::OrdinalIgnoreCase) -ge 0 -or
    $_.CommandLine.IndexOf($secretaryBrowserProfile,[StringComparison]::OrdinalIgnoreCase) -ge 0
  ) -and
  ($_.Name -ieq 'msedge.exe' -or $_.Name -ieq 'chrome.exe')
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$activeConfig=Join-Path (Split-Path -Parent $target) 'voice-v2.json'
if(!(Test-Path -LiteralPath $activeConfig)){
  Copy-Item -LiteralPath (Join-Path $source 'voice-v2.example.json') -Destination $activeConfig
}

# Preserve the selected wake provider. Picovoice is enabled only after its
# platform-specific Emma model has been imported; Deepgram remains the safe
# fallback while that model is absent or invalid.
$rawConfig=Get-Content -LiteralPath $activeConfig -Raw
try {
  $voiceConfig=$rawConfig | ConvertFrom-Json
} catch {
  # Keep an invalid user file for inspection, then create a known-safe config.
  # The V2 config contains no API keys, so replacing only this malformed file
  # cannot discard credentials.
  $backup="$activeConfig.invalid-$(Get-Date -Format 'yyyyMMddHHmmss').bak"
  Copy-Item -LiteralPath $activeConfig -Destination $backup -Force
  Copy-Item -LiteralPath (Join-Path $source 'voice-v2.example.json') -Destination $activeConfig -Force
  $voiceConfig=Get-Content -LiteralPath $activeConfig -Raw | ConvertFrom-Json
  Write-Host "Replaced invalid Voice v2 configuration. Backup: $backup"
}
if(!$voiceConfig.PSObject.Properties['wake']){
  $voiceConfig | Add-Member -NotePropertyName wake -NotePropertyValue ([pscustomobject]@{})
}
$wake=$voiceConfig.wake
if(!$wake.PSObject.Properties['provider']){$wake | Add-Member -NotePropertyName provider -NotePropertyValue 'deepgram_vad'}
elseif($wake.provider -notin @('deepgram_vad','picovoice_porcupine')){$wake.provider='deepgram_vad'}
if(!$wake.PSObject.Properties['word']){$wake | Add-Member -NotePropertyName word -NotePropertyValue 'Emma'}elseif([string]::IsNullOrWhiteSpace([string]$wake.word)){$wake.word='Emma'}
if(!$wake.PSObject.Properties['accessKeyEnv']){$wake | Add-Member -NotePropertyName accessKeyEnv -NotePropertyValue 'PICOVOICE_ACCESS_KEY'}
if(!$wake.PSObject.Properties['keywordPath']){$wake | Add-Member -NotePropertyName keywordPath -NotePropertyValue ''}
if(!$wake.PSObject.Properties['sensitivity']){$wake | Add-Member -NotePropertyName sensitivity -NotePropertyValue 0.65}
if(!$wake.PSObject.Properties['speechThreshold']){$wake | Add-Member -NotePropertyName speechThreshold -NotePropertyValue 450}
if(!$wake.PSObject.Properties['preRollMs']){$wake | Add-Member -NotePropertyName preRollMs -NotePropertyValue 600}
if(!$wake.PSObject.Properties['silenceMs']){$wake | Add-Member -NotePropertyName silenceMs -NotePropertyValue 1100}
if(!$wake.PSObject.Properties['maxSegmentMs']){$wake | Add-Member -NotePropertyName maxSegmentMs -NotePropertyValue 8000}
foreach($obsolete in @('modelPath','confidence')){
  if($wake.PSObject.Properties[$obsolete]){$wake.PSObject.Properties.Remove($obsolete)}
}
if(!$voiceConfig.PSObject.Properties['stt']){
  $voiceConfig | Add-Member -NotePropertyName stt -NotePropertyValue ([pscustomobject]@{})
}
$stt=$voiceConfig.stt
if(!$stt.PSObject.Properties['endpointingMs']){$stt | Add-Member -NotePropertyName endpointingMs -NotePropertyValue 250}
if(!$stt.PSObject.Properties['utteranceEndMs']){
  $stt | Add-Member -NotePropertyName utteranceEndMs -NotePropertyValue 1000
} else {
  $utteranceEndMs=0
  try{$utteranceEndMs=[int]$stt.utteranceEndMs}catch{}
  if($utteranceEndMs -lt 1000 -or $utteranceEndMs -gt 5000){$stt.utteranceEndMs=1000}
}
$voiceConfig | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $activeConfig -Encoding UTF8

# The desktop test build runs the browser UI, API and Emma from this checkout.
# Keep all three on the same local origin pair so no test command can silently
# fall through to an older Railway deployment.
$desktopConfigPath=Join-Path (Split-Path -Parent $target) 'config.json'
$codexNode=Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$localNodePath=if(Test-Path -LiteralPath $codexNode){$codexNode}else{[string](Get-Command 'node.exe' -CommandType Application -ErrorAction SilentlyContinue|Select-Object -ExpandProperty Source -First 1)}
if(Test-Path -LiteralPath $desktopConfigPath){
  try{$desktopConfig=Get-Content -LiteralPath $desktopConfigPath -Raw|ConvertFrom-Json}catch{$desktopConfig=[pscustomobject]@{}}
}else{$desktopConfig=[pscustomobject]@{}}
foreach($pair in @(
  @('LocalMode',$true),
  @('LocalProjectRoot',$projectRoot),
  @('ServerUrl','http://localhost:4000'),
  @('FrontendUrl','http://localhost:5173'),
  @('LocalNodePath',$localNodePath)
)){
  if($desktopConfig.PSObject.Properties[$pair[0]]){$desktopConfig.($pair[0])=$pair[1]}
  else{$desktopConfig|Add-Member -NotePropertyName $pair[0] -NotePropertyValue $pair[1]}
}
$desktopConfig|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $desktopConfigPath -Encoding UTF8

$prismaCli=Join-Path $projectRoot 'backend\node_modules\prisma\build\index.js'
if($localNodePath -and (Test-Path -LiteralPath $prismaCli)){
  $previousEngineType=$env:PRISMA_CLIENT_ENGINE_TYPE
  try{
    $env:PRISMA_CLIENT_ENGINE_TYPE='library'
    & $localNodePath $prismaCli generate --schema (Join-Path $projectRoot 'backend\prisma\schema.prisma') *> $null
    if($LASTEXITCODE -ne 0){throw 'Lokální databázový klient Prisma se nepodařilo připravit.'}
  }finally{
    if($null -eq $previousEngineType){Remove-Item Env:PRISMA_CLIENT_ENGINE_TYPE -ErrorAction SilentlyContinue}else{$env:PRISMA_CLIENT_ENGINE_TYPE=$previousEngineType}
  }
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

# Picovoice's native Python DLL currently fails under native Windows ARM64
# Python. Install a tiny x64 Node sidecar when an x64 Node runtime is already
# available; other machines continue to use the direct Python binding.
$nodeArch=if($localNodePath -and (Test-Path -LiteralPath $localNodePath)){(& $localNodePath -p 'process.arch' 2>$null)}else{''}
$npmPath=[string](Get-Command 'npm.cmd' -CommandType Application -ErrorAction SilentlyContinue|Select-Object -ExpandProperty Source -First 1)
if($nodeArch -eq 'x64' -and $npmPath){
  $picovoiceNodeRoot=Join-Path (Split-Path -Parent $target) 'picovoice-node'
  & $npmPath install --prefix $picovoiceNodeRoot --no-audit --no-fund --save-exact '@picovoice/porcupine-node@4.0.2' '@picovoice/pvrecorder-node@1.2.9' *> $null
  if($LASTEXITCODE -ne 0){Write-Warning 'Picovoice Node sidecar dependencies could not be installed; Deepgram fallback remains available.'}
}

$shell=New-Object -ComObject WScript.Shell
$desktopShortcut=$shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'VCUBF Secretary.lnk'))
$desktopShortcut.TargetPath="$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$desktopShortcut.Arguments="-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $target 'Launch-VCUBFSecretary.ps1')`""
$desktopShortcut.WorkingDirectory=$target
$desktopShortcut.IconLocation="$env:SystemRoot\System32\imageres.dll,15"
$desktopShortcut.Save()

Write-Host "VCUBF Secretary installed in $target"
Write-Host "The single desktop icon opens Secretary and Emma Voice v2 together. Closing that browser window stops Emma Voice v2."
Write-Host "Picovoice support is installed. Import a Windows Emma .ppn model with Configure-PicovoiceWake.ps1; Deepgram remains the automatic fallback."
if($StartNow){
  Start-Process -FilePath $desktopShortcut.TargetPath -ArgumentList $desktopShortcut.Arguments -WindowStyle Hidden
}

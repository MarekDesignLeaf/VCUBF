# Default: the companion works with the live Secretary on Railway, the single
# source of truth. -LocalDevelopment points it at a backend and frontend run
# from this checkout instead (localhost:4000 / localhost:5173), for testing code.
param([switch]$StartNow,[switch]$LocalDevelopment)

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

foreach($file in @('emma_voice_v2.py','emma_common.py','Run-VoiceV2.ps1','Launch-VCUBFSecretary.ps1','Test-VoiceHealth.ps1','voice-v2.example.json','requirements.txt','requirements-v2.txt')){
  Copy-Item -LiteralPath (Join-Path $source $file) -Destination $target -Force
}

# Voice v2 is now the only companion. Remove every legacy executable path,
# startup entry and duplicate shortcut before publishing the unified launcher.
# Voice runs on OpenAI only, so the Picovoice and NPU Whisper files and the
# runtimes they installed are removed from earlier installations as well.
foreach($legacy in @('WindowsSpeechWake.ps1','VCUBF-Emma.ps1','emma_realtime.py','Open-VCUBF.ps1','npu_whisper_sidecar.py','picovoice_wake.js','Configure-PicovoiceWake.ps1','Install-NpuWhisper.ps1')){
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
    ($_.CommandLine.IndexOf($v2Runtime,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.CommandLine -like '*--run*') -or
    $_.CommandLine.IndexOf('npu_whisper_sidecar.py',[StringComparison]::OrdinalIgnoreCase) -ge 0
  )
} | ForEach-Object { Stop-InstallerProcessTree ([int]$_.ProcessId) }
# Remove only stale local development runtimes from this VCUBF checkout. They
# otherwise keep ports 4000/5173 occupied after an older launcher was replaced.
if($LocalDevelopment){
  Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and $_.CommandLine.IndexOf($projectRoot,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and
    $_.CommandLine -match '(tsx.*src[\\/]server\.ts|vite.*--host)'
  } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -and (
    $_.CommandLine.IndexOf($legacyBrowserProfile,[StringComparison]::OrdinalIgnoreCase) -ge 0 -or
    $_.CommandLine.IndexOf($secretaryBrowserProfile,[StringComparison]::OrdinalIgnoreCase) -ge 0
  ) -and
  ($_.Name -ieq 'msedge.exe' -or $_.Name -ieq 'chrome.exe')
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

foreach($legacyRuntime in @('picovoice-node','npu-whisper')){
  Remove-Item -LiteralPath (Join-Path (Split-Path -Parent $target) $legacyRuntime) -Recurse -Force -ErrorAction SilentlyContinue
}

$activeConfig=Join-Path (Split-Path -Parent $target) 'voice-v2.json'
if(!(Test-Path -LiteralPath $activeConfig)){
  Copy-Item -LiteralPath (Join-Path $source 'voice-v2.example.json') -Destination $activeConfig
}

# Voice runs on OpenAI only: wake word, transcription and speech. Any other
# provider left in an older configuration is rewritten to OpenAI here.
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
if(!$wake.PSObject.Properties['provider']){$wake | Add-Member -NotePropertyName provider -NotePropertyValue 'openai_vad'}
else{$wake.provider='openai_vad'}
if(!$wake.PSObject.Properties['word']){$wake | Add-Member -NotePropertyName word -NotePropertyValue 'Alfonzo'}elseif([string]::IsNullOrWhiteSpace([string]$wake.word)){$wake.word='Alfonzo'}
if(!$wake.PSObject.Properties['deviceName']){$wake | Add-Member -NotePropertyName deviceName -NotePropertyValue ''}
if(!$wake.PSObject.Properties['speechThreshold']){$wake | Add-Member -NotePropertyName speechThreshold -NotePropertyValue 450}
if(!$wake.PSObject.Properties['preRollMs']){$wake | Add-Member -NotePropertyName preRollMs -NotePropertyValue 600}
if(!$wake.PSObject.Properties['silenceMs']){$wake | Add-Member -NotePropertyName silenceMs -NotePropertyValue 1100}
if(!$wake.PSObject.Properties['maxSegmentMs']){$wake | Add-Member -NotePropertyName maxSegmentMs -NotePropertyValue 8000}
foreach($obsolete in @('modelPath','confidence','accessKeyEnv','keywordPath','sensitivity')){
  if($wake.PSObject.Properties[$obsolete]){$wake.PSObject.Properties.Remove($obsolete)}
}
if(!$voiceConfig.PSObject.Properties['stt']){
  $voiceConfig | Add-Member -NotePropertyName stt -NotePropertyValue ([pscustomobject]@{})
}
$stt=$voiceConfig.stt
if(!$stt.PSObject.Properties['provider']){$stt|Add-Member -NotePropertyName provider -NotePropertyValue 'openai'}
else{$stt.provider='openai'}
# The local voice gate that cuts speech into utterances for OpenAI
# transcription. Earlier installations kept these values under "npu".
$gateSource=if($stt.PSObject.Properties['openai']){$stt.openai}elseif($stt.PSObject.Properties['npu']){$stt.npu}else{[pscustomobject]@{}}
$gate=[ordered]@{}
foreach($pair in @(@('speechThreshold',300),@('preRollMs',320),@('silenceMs',700),@('minSpeechMs',180),@('maxSegmentMs',15000))){
  $gate[$pair[0]]=if($gateSource.PSObject.Properties[$pair[0]]){$gateSource.($pair[0])}else{$pair[1]}
}
if($stt.PSObject.Properties['openai']){$stt.openai=[pscustomobject]$gate}else{$stt|Add-Member -NotePropertyName openai -NotePropertyValue ([pscustomobject]$gate)}
foreach($obsolete in @('fallbackProvider','apiKeyEnv','model','languageMode','endpointingMs','utteranceEndMs','npu')){
  if($stt.PSObject.Properties[$obsolete]){$stt.PSObject.Properties.Remove($obsolete)}
}
if(!$voiceConfig.PSObject.Properties['tts']){
  $voiceConfig | Add-Member -NotePropertyName tts -NotePropertyValue ([pscustomobject]@{})
}
$tts=$voiceConfig.tts
if(!$tts.PSObject.Properties['deviceName']){$tts|Add-Member -NotePropertyName deviceName -NotePropertyValue ''}
# OpenAI is the only speech-output provider. Migrate old provider fields.
$voiceName=if($tts.voice){[string]$tts.voice}elseif($tts.fallbackVoice){[string]$tts.fallbackVoice}else{'nova'}
$model=if($tts.provider -eq 'openai' -and $tts.model -notlike 'eleven*' -and $tts.model){[string]$tts.model}elseif($tts.fallbackModel){[string]$tts.fallbackModel}else{'tts-1'}
$voiceConfig.tts=[pscustomobject]@{provider='openai';apiKeyEnv='OPENAI_API_KEY';model=$model;voice=$voiceName;deviceName=[string]$tts.deviceName}
$voiceConfig | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $activeConfig -Encoding UTF8

# Production (default): the browser UI, API and voice runtime all use the live
# Secretary on Railway, so every voice command acts on the real business data
# and connectors. The first start pairs this PC with the signed-in account in
# the browser (device pairing, 30-day token, audited approval).
# -LocalDevelopment: all three use this checkout on localhost instead, so no
# test command can reach production.
$productionServer='https://backend-production-7952.up.railway.app'
$productionFrontend='https://frontend-production-ee13.up.railway.app'
$desktopConfigPath=Join-Path (Split-Path -Parent $target) 'config.json'
$codexNode=Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$localNodePath=if(Test-Path -LiteralPath $codexNode){$codexNode}else{[string](Get-Command 'node.exe' -CommandType Application -ErrorAction SilentlyContinue|Select-Object -ExpandProperty Source -First 1)}
if(Test-Path -LiteralPath $desktopConfigPath){
  try{$desktopConfig=Get-Content -LiteralPath $desktopConfigPath -Raw|ConvertFrom-Json}catch{$desktopConfig=[pscustomobject]@{}}
}else{$desktopConfig=[pscustomobject]@{}}
$previousServer=if($desktopConfig.PSObject.Properties['ServerUrl']){[string]$desktopConfig.ServerUrl}else{''}
$targetServer=if($LocalDevelopment){'http://localhost:4000'}else{$productionServer}
if($previousServer -and $previousServer.TrimEnd('/') -ne $targetServer){
  # A token issued by one backend is not valid on another; pair again.
  Remove-Item -LiteralPath (Join-Path (Split-Path -Parent $target) 'token.bin') -Force -ErrorAction SilentlyContinue
}
foreach($pair in @(
  @('LocalMode',[bool]$LocalDevelopment),
  @('LocalProjectRoot',$projectRoot),
  @('ServerUrl',$targetServer),
  @('FrontendUrl',$(if($LocalDevelopment){'http://localhost:5173'}else{$productionFrontend})),
  @('LocalNodePath',$localNodePath)
)){
  if($desktopConfig.PSObject.Properties[$pair[0]]){$desktopConfig.($pair[0])=$pair[1]}
  else{$desktopConfig|Add-Member -NotePropertyName $pair[0] -NotePropertyValue $pair[1]}
}
$desktopConfig|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $desktopConfigPath -Encoding UTF8

$prismaCli=Join-Path $projectRoot 'backend\node_modules\prisma\build\index.js'
if($LocalDevelopment -and $localNodePath -and (Test-Path -LiteralPath $prismaCli)){
  $previousEngineType=$env:PRISMA_CLIENT_ENGINE_TYPE
  $previousErrorAction=$ErrorActionPreference
  try{
    $env:PRISMA_CLIENT_ENGINE_TYPE='library'
    # Prisma writes informational banners to stderr. Windows PowerShell must
    # not turn those successful native-process messages into terminating
    # errors before we can inspect the real exit code.
    $ErrorActionPreference='Continue'
    & $localNodePath $prismaCli generate --schema (Join-Path $projectRoot 'backend\prisma\schema.prisma') *> $null
    $prismaExitCode=$LASTEXITCODE
  }finally{
    $ErrorActionPreference=$previousErrorAction
    if($null -eq $previousEngineType){Remove-Item Env:PRISMA_CLIENT_ENGINE_TYPE -ErrorAction SilentlyContinue}else{$env:PRISMA_CLIENT_ENGINE_TYPE=$previousEngineType}
  }
  if($prismaExitCode -ne 0){throw 'Lokální databázový klient Prisma se nepodařilo připravit.'}
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
if($LASTEXITCODE -ne 0){throw 'Voice v2 dependencies could not be installed.'}

$shell=New-Object -ComObject WScript.Shell
$desktopShortcut=$shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'VCUBF Secretary.lnk'))
$desktopShortcut.TargetPath="$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$desktopShortcut.Arguments="-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $target 'Launch-VCUBFSecretary.ps1')`""
$desktopShortcut.WorkingDirectory=$target
$desktopShortcut.IconLocation="$env:SystemRoot\System32\imageres.dll,15"
$desktopShortcut.Save()

Write-Host "VCUBF Secretary installed in $target"
Write-Host "The single desktop icon opens Secretary and Voice v2 together. Closing that browser window stops Voice v2."
Write-Host "Voice v2 uses OpenAI for the wake word, transcription and speech."
if($LocalDevelopment){
  Write-Host "Local development mode: Secretary and voice use this checkout on localhost:4000 / localhost:5173."
}else{
  Write-Host "Secretary and voice use the live system on Railway ($productionServer). The first start asks you to approve this PC in the browser."
}
if($StartNow){
  Start-Process -FilePath $desktopShortcut.TargetPath -ArgumentList $desktopShortcut.Arguments -WindowStyle Hidden
}

param(
  [switch]$Diagnostic,
  [switch]$SelfTest,
  [int]$OwnerProcessId = 0,
  [string]$StopFile = ''
)

$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms

# A desktop shortcut can outlive a change to a user environment variable.
# Reload the persisted credentials for this process before Python is launched,
# so an updated provider key is used on the very next Emma restart.
foreach($secretName in @('DEEPGRAM_API_KEY','ELEVENLABS_API_KEY','PICOVOICE_ACCESS_KEY')) {
  $userValue=[Environment]::GetEnvironmentVariable($secretName,'User')
  if($userValue) { Set-Item -Path "Env:$secretName" -Value $userValue }
}

$app=Split-Path -Parent $PSCommandPath
$runtime=Join-Path $app 'emma_voice_v2.py'
if(!(Test-Path -LiteralPath $runtime)){throw 'Emma Voice v2 runtime is missing. Run Install-VoiceV2.ps1 again.'}

$emmaRoot=Split-Path -Parent $app
$desktopConfigPath=Join-Path $emmaRoot 'config.json'
$nodeCandidates=@()
if(Test-Path -LiteralPath $desktopConfigPath){
  try{
    $desktopConfig=Get-Content -LiteralPath $desktopConfigPath -Raw|ConvertFrom-Json
    if($desktopConfig.LocalNodePath){$nodeCandidates+=[string]$desktopConfig.LocalNodePath}
  }catch{}
}
$nodeCandidates+='C:\Users\hutra\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$nodeCandidates+=@(Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue|Select-Object -ExpandProperty Source)
foreach($candidate in @($nodeCandidates|Select-Object -Unique)){
  if(!(Test-Path -LiteralPath $candidate)){continue}
  if((& $candidate -p 'process.arch' 2>$null) -eq 'x64'){
    $env:PICOVOICE_NODE_PATH=$candidate
    $env:PICOVOICE_NODE_MODULES=Join-Path $emmaRoot 'picovoice-node\node_modules'
    break
  }
}

function Resolve-Python {
  foreach($candidate in @('python.exe','py.exe')) {
    foreach($command in @(Get-Command $candidate -CommandType Application -ErrorAction SilentlyContinue)) {
      if(!$command.Source -or $command.Source -match '\\WindowsApps\\'){continue}
      $prefix=@()
      if([IO.Path]::GetFileName($command.Source) -match '^py\.exe$'){$prefix=@('-3')}
      & $command.Source @prefix --version *> $null
      if($LASTEXITCODE -eq 0){return [pscustomobject]@{Path=$command.Source;Prefix=$prefix}}
    }
  }
  return $null
}

$python=Resolve-Python
if(!$python){
  [Windows.Forms.MessageBox]::Show('Python 3 is required for Emma Voice v2. Install Python and run Install-VoiceV2.ps1 again.','VCUBF Emma Voice v2','OK','Error')|Out-Null
  exit 1
}

if($SelfTest){
  & $python.Path @($python.Prefix) $runtime --self-test
  exit $LASTEXITCODE
}

$diagnosticJson=& $python.Path @($python.Prefix) $runtime --diagnostic
if($LASTEXITCODE -ne 0){throw 'Emma Voice v2 diagnostic failed.'}
$v2Diagnostic=$diagnosticJson|ConvertFrom-Json
if($Diagnostic){$diagnosticJson;exit 0}

$v1Script=Join-Path $app 'VCUBF-Emma.ps1'
$v1Runtime=Join-Path $app 'emma_realtime.py'
$legacy=@(Get-CimInstance Win32_Process|Where-Object{
  $_.CommandLine -and (
    $_.CommandLine.IndexOf($v1Script,[StringComparison]::OrdinalIgnoreCase) -ge 0 -or
    $_.CommandLine.IndexOf($v1Runtime,[StringComparison]::OrdinalIgnoreCase) -ge 0
  )
})
if($legacy){
  [Windows.Forms.MessageBox]::Show('Emma Voice v1 is active. Stop it from the VCUF Emma tray menu before starting Voice v2. This prevents two microphones or two conversations running at once.','VCUBF Emma Voice v2','OK','Warning')|Out-Null
  exit 2
}

$alreadyRunning=@(Get-CimInstance Win32_Process|Where-Object{
  $_.CommandLine -and $_.CommandLine.IndexOf($runtime,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.CommandLine -like '*--run*'
})
if($alreadyRunning){
  [Windows.Forms.MessageBox]::Show('Emma Voice v2 is already running.','VCUBF Emma Voice v2','OK','Information')|Out-Null
  exit 0
}

if(!$v2Diagnostic.ready){
  $missing=@()
  if(!$v2Diagnostic.providers.wake.providerConfigured){$missing+='wake-word configuration'}
  if(!$v2Diagnostic.providers.wake.wakeWordPresent){$missing+='Emma wake word'}
  if($v2Diagnostic.providers.wake.requestedProvider -eq 'picovoice_porcupine'){
    if(!$v2Diagnostic.providers.wake.packageInstalled){$missing+='Picovoice package'}
    if(!$v2Diagnostic.providers.wake.picovoiceAccessKeyPresent){$missing+='PICOVOICE_ACCESS_KEY'}
    if(!$v2Diagnostic.providers.wake.keywordModelPresent){$missing+='Windows Emma .ppn model'}
    if(!$v2Diagnostic.providers.wake.picovoiceSettingsValid){$missing+='Picovoice wake-word settings'}
  }elseif(!$v2Diagnostic.providers.wake.vadSettingsValid){$missing+='Deepgram VAD wake-word settings'}
  if(!$v2Diagnostic.providers.npuWhisper.providerConfigured){$missing+='speech-to-text provider'}
  if($v2Diagnostic.providers.npuWhisper.effectiveProvider -eq 'deepgram'){
    if(!$v2Diagnostic.providers.deepgram.apiKeyPresent){$missing+='DEEPGRAM_API_KEY'}
    if(!$v2Diagnostic.providers.deepgram.streamTimingValid){$missing+='Deepgram streaming timing (utterance end must be 1000–5000 ms)'}
  }
  if($v2Diagnostic.providers.npuWhisper.requestedProvider -eq 'npu_whisper' -and !$v2Diagnostic.providers.npuWhisper.runtimePresent -and !$v2Diagnostic.providers.npuWhisper.fallbackActive){
    $missing+='Qualcomm NPU Whisper runtime'
  }
  if(!$v2Diagnostic.providers.elevenlabs.apiKeyPresent){$missing+='ELEVENLABS_API_KEY'}
  if(!$v2Diagnostic.providers.elevenlabs.voiceIdPresent){$missing+='ElevenLabs voice ID'}
  [Windows.Forms.MessageBox]::Show("Voice v2 is installed but not configured. Missing: $($missing -join ', ').`n`nSee docs\\VOICE_V2_SETUP.md in the VCUF project. No microphone session was started.",'VCUBF Emma Voice v2','OK','Information')|Out-Null
  exit 2
}

$stopFile=if($StopFile){$StopFile}else{Join-Path (Split-Path -Parent $app) 'voice-v2.stop'}
$ownerPid=if($OwnerProcessId -gt 0){$OwnerProcessId}else{$PID}
Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
$arguments=@($python.Prefix) + @("`"$runtime`"",'--run','--parent-pid',$ownerPid,'--stop-file',"`"$stopFile`"")
$process=Start-Process -FilePath $python.Path -ArgumentList $arguments -WindowStyle Hidden -PassThru
$wakeEngine=if($v2Diagnostic.providers.wake.effectiveProvider -eq 'picovoice_porcupine'){'Picovoice (lokálně)'}else{'Deepgram VAD'}
$sttEngine=if($v2Diagnostic.providers.npuWhisper.effectiveProvider -eq 'npu_whisper'){'Qualcomm NPU Whisper'}else{'Deepgram'}

$menu=New-Object Windows.Forms.ContextMenuStrip
$exit=$menu.Items.Add('Ukončit Emmu Voice v2')
$context=New-Object Windows.Forms.ApplicationContext
$notify=New-Object Windows.Forms.NotifyIcon -Property @{
  Icon=[Drawing.SystemIcons]::Information
  Visible=$true
  Text="Emma Voice v2 — $wakeEngine / $sttEngine"
  ContextMenuStrip=$menu
}
$exit.Add_Click({ $context.ExitThread() })
$timer=New-Object Windows.Forms.Timer -Property @{Interval=1000}
$timer.Add_Tick({
  if($process.HasExited){
    $notify.ShowBalloonTip(3000,'Emma Voice v2','Hlasová relace skončila.','Info')
    $context.ExitThread()
  }
})

try {
  $timer.Start()
  $notify.ShowBalloonTip(3000,'Emma Voice v2',"Naslouchá na oslovení Emma přes $wakeEngine. Přepis: $sttEngine. Ikona zde umožňuje bezpečné ukončení.",'Info')
  [Windows.Forms.Application]::Run($context)
} finally {
  $timer.Stop();$timer.Dispose()
  Set-Content -LiteralPath $stopFile -Value 'stop' -Encoding ASCII
  if(!$process.HasExited){
    $deadline=[datetime]::UtcNow.AddSeconds(4)
    while(!$process.HasExited -and [datetime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 100}
    if(!$process.HasExited){Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue}
  }
  $notify.Visible=$false;$notify.Dispose()
}
exit $(if($process.HasExited){$process.ExitCode}else{0})

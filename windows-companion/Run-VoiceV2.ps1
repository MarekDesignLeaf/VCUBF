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
foreach($secretName in @('DEEPGRAM_API_KEY','ELEVENLABS_API_KEY')) {
  $userValue=[Environment]::GetEnvironmentVariable($secretName,'User')
  if($userValue) { Set-Item -Path "Env:$secretName" -Value $userValue }
}

$app=Split-Path -Parent $PSCommandPath
$runtime=Join-Path $app 'emma_voice_v2.py'
if(!(Test-Path -LiteralPath $runtime)){throw 'Emma Voice v2 runtime is missing. Run Install-VoiceV2.ps1 again.'}

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
  if(!$v2Diagnostic.providers.deepgramWake.providerConfigured){$missing+='Deepgram VAD wake-word configuration'}
  if(!$v2Diagnostic.providers.deepgramWake.wakeWordPresent){$missing+='Emma wake word'}
  if(!$v2Diagnostic.providers.deepgramWake.vadSettingsValid){$missing+='Deepgram VAD wake-word settings'}
  if(!$v2Diagnostic.providers.deepgram.apiKeyPresent){$missing+='DEEPGRAM_API_KEY'}
  if(!$v2Diagnostic.providers.deepgram.streamTimingValid){$missing+='Deepgram streaming timing (utterance end must be 1000–5000 ms)'}
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

$menu=New-Object Windows.Forms.ContextMenuStrip
$exit=$menu.Items.Add('Ukončit Emmu Voice v2')
$context=New-Object Windows.Forms.ApplicationContext
$notify=New-Object Windows.Forms.NotifyIcon -Property @{
  Icon=[Drawing.SystemIcons]::Information
  Visible=$true
  Text='Emma Voice v2 — čeká na Emma'
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
  $notify.ShowBalloonTip(3000,'Emma Voice v2','Naslouchá na oslovení Emma. Ikona zde umožňuje bezpečné ukončení.','Info')
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

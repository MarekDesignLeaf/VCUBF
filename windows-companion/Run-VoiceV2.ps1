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
# so an updated provider key is used on the very next restart.
foreach($secretName in @('OPENAI_API_KEY')) {
  $userValue=[Environment]::GetEnvironmentVariable($secretName,'User')
  if($userValue) { Set-Item -Path "Env:$secretName" -Value $userValue }
}

$app=Split-Path -Parent $PSCommandPath
$runtime=Join-Path $app 'emma_voice_v2.py'
if(!(Test-Path -LiteralPath $runtime)){throw 'The Voice v2 runtime is missing. Run Install-VoiceV2.ps1 again.'}

$emmaRoot=Split-Path -Parent $app
$assistantName='Alfonzo'
$desktopConfigPath=Join-Path $emmaRoot 'config.json'
if(Test-Path -LiteralPath $desktopConfigPath){
  try{
    $desktopConfig=Get-Content -LiteralPath $desktopConfigPath -Raw|ConvertFrom-Json
    if($desktopConfig.WakeWord){$assistantName=[string]$desktopConfig.WakeWord}
  }catch{}
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
  [Windows.Forms.MessageBox]::Show("Python 3 is required for $assistantName Voice v2. Install Python and run Install-VoiceV2.ps1 again.","VCUBF $assistantName Voice v2",'OK','Error')|Out-Null
  exit 1
}

if($SelfTest){
  & $python.Path @($python.Prefix) $runtime --self-test
  exit $LASTEXITCODE
}

$diagnosticJson=& $python.Path @($python.Prefix) $runtime --diagnostic
if($LASTEXITCODE -ne 0){throw 'The Voice v2 diagnostic failed.'}
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
  [Windows.Forms.MessageBox]::Show("Voice v1 is active. Stop it from its tray menu before starting Voice v2. This prevents two microphones or two conversations running at once.","VCUBF $assistantName Voice v2",'OK','Warning')|Out-Null
  exit 2
}

$alreadyRunning=@(Get-CimInstance Win32_Process|Where-Object{
  $_.CommandLine -and $_.CommandLine.IndexOf($runtime,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.CommandLine -like '*--run*'
})
if($alreadyRunning){
  # Silent: the unified launcher re-arms automatically and a modal dialog here
  # blocked it. The Python runtime also holds a kernel mutex (exit code 3), so
  # a second listener cannot start even if this process-list check races.
  exit 3
}

if(!$v2Diagnostic.ready){
  $missing=@()
  if(!$v2Diagnostic.providers.wake.wakeWordPresent){$missing+='wake word'}
  if(!$v2Diagnostic.providers.wake.vadSettingsValid){$missing+='wake-word voice-gate settings'}
  if(!$v2Diagnostic.providers.wake.providerConfigured -and $v2Diagnostic.providers.wake.configurationError){$missing+=[string]$v2Diagnostic.providers.wake.configurationError}
  if(!$v2Diagnostic.providers.openaiTts.apiKeyPresent){$missing+='OPENAI_API_KEY'}
  [Windows.Forms.MessageBox]::Show("Voice v2 is installed but not configured. Missing: $($missing -join ', ').`n`nSee docs\\VOICE_V2_SETUP.md in the VCUF project. No microphone session was started.","VCUBF $assistantName Voice v2",'OK','Information')|Out-Null
  exit 2
}

$stopFile=if($StopFile){$StopFile}else{Join-Path (Split-Path -Parent $app) 'voice-v2.stop'}
$ownerPid=if($OwnerProcessId -gt 0){$OwnerProcessId}else{$PID}
Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
$arguments=@($python.Prefix) + @("`"$runtime`"",'--run','--parent-pid',$ownerPid,'--stop-file',"`"$stopFile`"")
$process=Start-Process -FilePath $python.Path -ArgumentList $arguments -WindowStyle Hidden -PassThru
# Voice runs on OpenAI only: wake, transcription and speech.
$wakeEngine='GPT (OpenAI)'
$sttEngine='GPT (OpenAI)'

$menu=New-Object Windows.Forms.ContextMenuStrip
$exit=$menu.Items.Add("Ukončit $assistantName Voice v2")
$context=New-Object Windows.Forms.ApplicationContext
$notify=New-Object Windows.Forms.NotifyIcon -Property @{
  Icon=[Drawing.SystemIcons]::Information
  Visible=$true
  Text="$assistantName Voice v2 — $wakeEngine / $sttEngine"
  ContextMenuStrip=$menu
}
$exit.Add_Click({ $context.ExitThread() })
$timer=New-Object Windows.Forms.Timer -Property @{Interval=1000}
$timer.Add_Tick({
  if($process.HasExited){
    if($process.ExitCode -ne 3){
      $notify.ShowBalloonTip(3000,"$assistantName Voice v2",'Hlasová relace skončila.','Info')
    }
    $context.ExitThread()
  }
})

try {
  $timer.Start()
  $notify.ShowBalloonTip(3000,"$assistantName Voice v2","Naslouchá na oslovení $assistantName přes $wakeEngine. Přepis: $sttEngine. Ikona zde umožňuje bezpečné ukončení.",'Info')
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

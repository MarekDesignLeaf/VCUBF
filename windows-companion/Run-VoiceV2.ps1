param([switch]$Diagnostic,[switch]$SelfTest)

$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms

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
$legacy=@(Get-CimInstance Win32_Process|Where-Object{
  $_.CommandLine -and ($_.CommandLine -like "*$v1Script*" -or $_.CommandLine -like "*emma_realtime.py*")
})
if($legacy){
  [Windows.Forms.MessageBox]::Show('Emma Voice v1 is active. Stop it from the VCUF Emma tray menu before starting Voice v2. This prevents two microphones or two conversations running at once.','VCUBF Emma Voice v2','OK','Warning')|Out-Null
  exit 2
}

$alreadyRunning=@(Get-CimInstance Win32_Process|Where-Object{$_.CommandLine -and $_.CommandLine -like '*emma_voice_v2.py*--run*'})
if($alreadyRunning){
  [Windows.Forms.MessageBox]::Show('Emma Voice v2 is already running.','VCUBF Emma Voice v2','OK','Information')|Out-Null
  exit 0
}

if(!$v2Diagnostic.ready){
  $missing=@()
  if(!$v2Diagnostic.providers.porcupine.packageInstalled){$missing+='Porcupine Python package'}
  if(!$v2Diagnostic.providers.porcupine.accessKeyPresent){$missing+='PICOVOICE_ACCESS_KEY'}
  if(!$v2Diagnostic.providers.porcupine.keywordModelPresent){$missing+='Emma .ppn wake-word model'}
  if(!$v2Diagnostic.providers.deepgram.apiKeyPresent){$missing+='DEEPGRAM_API_KEY'}
  if(!$v2Diagnostic.providers.elevenlabs.apiKeyPresent){$missing+='ELEVENLABS_API_KEY'}
  if(!$v2Diagnostic.providers.elevenlabs.voiceIdPresent){$missing+='ElevenLabs voice ID'}
  [Windows.Forms.MessageBox]::Show("Voice v2 is installed but not configured. Missing: $($missing -join ', ').`n`nSee docs\\VOICE_V2_SETUP.md in the VCUF project. No microphone session was started.",'VCUBF Emma Voice v2','OK','Information')|Out-Null
  exit 2
}

& $python.Path @($python.Prefix) $runtime --run
exit $LASTEXITCODE

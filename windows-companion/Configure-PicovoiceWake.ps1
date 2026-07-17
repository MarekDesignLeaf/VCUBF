param(
  [string]$ModelPath='',
  [switch]$Silent
)

$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms

$app=Split-Path -Parent $PSCommandPath
$emmaRoot=Split-Path -Parent $app
$configPath=Join-Path $emmaRoot 'voice-v2.json'
$examplePath=Join-Path $app 'voice-v2.example.json'
$keywordDir=Join-Path $emmaRoot 'keywords'
$targetModel=Join-Path $keywordDir 'Emma_windows.ppn'

$accessKey=[Environment]::GetEnvironmentVariable('PICOVOICE_ACCESS_KEY','User')
if([string]::IsNullOrWhiteSpace($accessKey)){
  throw 'PICOVOICE_ACCESS_KEY is not stored for the current Windows user.'
}
$env:PICOVOICE_ACCESS_KEY=$accessKey

New-Item -ItemType Directory -Path $keywordDir -Force|Out-Null
if([string]::IsNullOrWhiteSpace($ModelPath)){
  $python=$null
  foreach($candidate in @('python.exe','py.exe')){
    foreach($command in @(Get-Command $candidate -CommandType Application -ErrorAction SilentlyContinue)){
      if(!$command.Source -or $command.Source -match '\\WindowsApps\\'){continue}
      $prefix=@()
      if([IO.Path]::GetFileName($command.Source) -match '^py\.exe$'){$prefix=@('-3')}
      & $command.Source @prefix -c 'import pvporcupine' *> $null
      if($LASTEXITCODE -eq 0){$python=[pscustomobject]@{Path=$command.Source;Prefix=$prefix};break}
    }
    if($python){break}
  }
  if(!$python){throw 'Python package pvporcupine is missing. Run Install-VoiceV2.ps1 first.'}
  $env:PICOVOICE_MODEL_OUTPUT=$targetModel
  & $python.Path @($python.Prefix) -c "import os,pvporcupine; pvporcupine.train_wake_word_from_phrase(access_key=os.environ['PICOVOICE_ACCESS_KEY'], output_path=os.environ['PICOVOICE_MODEL_OUTPUT'], language='en', phrase='Emma', platform='windows')"
  if($LASTEXITCODE -ne 0){throw 'Picovoice could not create the Windows Emma wake-word model.'}
  $ModelPath=$targetModel
}

$resolvedModel=(Resolve-Path -LiteralPath $ModelPath).Path
if([IO.Path]::GetExtension($resolvedModel) -ine '.ppn'){
  throw 'The selected file is not a Picovoice .ppn keyword model.'
}
if($resolvedModel -ine $targetModel){Copy-Item -LiteralPath $resolvedModel -Destination $targetModel -Force}
if(!(Test-Path -LiteralPath $configPath)){
  if(!(Test-Path -LiteralPath $examplePath)){throw 'Voice v2 configuration template is missing.'}
  Copy-Item -LiteralPath $examplePath -Destination $configPath
}

try{$config=Get-Content -LiteralPath $configPath -Raw|ConvertFrom-Json}catch{throw 'Voice v2 configuration is invalid.'}
if(!$config.PSObject.Properties['wake']){$config|Add-Member -NotePropertyName wake -NotePropertyValue ([pscustomobject]@{})}
$wake=$config.wake
foreach($pair in @(
  @('provider','picovoice_porcupine'),
  @('word','Emma'),
  @('accessKeyEnv','PICOVOICE_ACCESS_KEY'),
  @('keywordPath',$targetModel),
  @('sensitivity',0.65)
)){
  if($wake.PSObject.Properties[$pair[0]]){$wake.($pair[0])=$pair[1]}
  else{$wake|Add-Member -NotePropertyName $pair[0] -NotePropertyValue $pair[1]}
}
$config|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $configPath -Encoding UTF8

if(!$Silent){
  [Windows.Forms.MessageBox]::Show(
    'Windows model Emma byl vytvořen a aktivován. Ukončete a znovu spusťte VCUBF Secretary jedinou ikonou na ploše.',
    'VCUBF Emma Voice v2',
    'OK',
    'Information'
  )|Out-Null
}

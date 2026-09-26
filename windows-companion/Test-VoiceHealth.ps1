param()

$ErrorActionPreference = 'Stop'
$root = Join-Path $env:LOCALAPPDATA 'VCUBF\Emma'
$config = Get-Content -LiteralPath (Join-Path $root 'config.json') -Raw | ConvertFrom-Json
$server = ([string]$config.ServerUrl).TrimEnd('/')
$frontend = ([string]$config.FrontendUrl).TrimEnd('/')
$voice = @(Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='pythonw.exe'" |
  Where-Object { $_.CommandLine -like '*emma_voice_v2.py*--run*' })
$backendOk = $false
$frontendOk = $false
$openAiApiOk = $false
$voiceConfig = Get-Content -LiteralPath (Join-Path $root 'voice-v2.json') -Raw | ConvertFrom-Json
$openAiSelected = $voiceConfig.tts.provider -eq 'openai'
$state = $null
$activeConversationCount = -1
$serverLanguage = ''
# 5 seconds, not 2: resolving "localhost" tries IPv6 first and falls back to
# IPv4 after about two seconds on this machine, which reported a running
# server as down. Measured at 2129 ms for localhost against 78 ms for
# 127.0.0.1.
try { $backendOk = (Invoke-WebRequest -Uri "$server/health" -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200 } catch {}
try { $frontendOk = (Invoke-WebRequest -Uri "$frontend/" -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200 } catch {}
$openAiKey = [Environment]::GetEnvironmentVariable('OPENAI_API_KEY','User')
if($openAiKey) {
  try { $openAiApiOk = (Invoke-WebRequest -Uri 'https://api.openai.com/v1/models' -Headers @{Authorization="Bearer $openAiKey"} -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200 } catch {}
}
try {
  if($config.LocalMode -eq $true) {
    $session = Invoke-RestMethod -Uri "$server/auth/local-test-active-session" -TimeoutSec 3
    $serverLanguage = [string]$session.user.voiceLanguage
    $token = [string]$session.token
  } else {
    # The live system: use this PC's paired device token.
    Add-Type -AssemblyName System.Security
    $protected = [IO.File]::ReadAllBytes((Join-Path $root 'token.bin'))
    $token = [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser))
    $me = Invoke-RestMethod -Uri "$server/auth/me" -Headers @{Authorization="Bearer $token"} -TimeoutSec 10
    $serverLanguage = [string]$me.voiceLanguage
  }
  if($token) {
    $headers = @{Authorization="Bearer $token"}
    $state = Invoke-RestMethod -Uri "$server/command/voice-state" -Headers $headers -TimeoutSec 3
    $conversations = @(Invoke-RestMethod -Uri "$server/command/voice-conversations?limit=20" -Headers $headers -TimeoutSec 3)
    $activeConversationCount = @($conversations | Where-Object { $_.status -eq 'active' }).Count
  }
} catch {}
$recentAudio = $false
$recentBusinessResponses = 0
$recentWakeActivations = 0
$recentRuntimeErrors = 0
$microphone = ''
$logPath = Join-Path $root 'emma-voice-v2.log'
if(Test-Path -LiteralPath $logPath) {
  foreach($line in @(Get-Content -LiteralPath $logPath -Tail 120)) {
    $stamp = $null
    if($line -match '^(?<stamp>\S+)') {
      try { $stamp = ([datetimeoffset]::Parse($matches.stamp)).UtcDateTime } catch {}
    }
    if($stamp -and $stamp -gt [datetime]::UtcNow.AddSeconds(-35) -and $line -match 'v2 business response completed') {
      $recentBusinessResponses++
    }
    if($stamp -and $stamp -gt [datetime]::UtcNow.AddSeconds(-60) -and $line -match 'wake word detected') {
      $recentWakeActivations++
    }
    if($stamp -and $stamp -gt [datetime]::UtcNow.AddSeconds(-60) -and $line -match 'v2 (?:playback error|audio output error|session failure|microphone error)') {
      $recentRuntimeErrors++
    }
    if($line -match 'v2 OpenAI wake microphone audio (?:confirmed|active): (?<device>.+)$') {
      $microphone = $matches.device
      if($stamp -and $stamp -gt [datetime]::UtcNow.AddSeconds(-25)) { $recentAudio = $true }
    }
  }
}
$possibleSelfReplyLoop = $recentBusinessResponses -ge 5
$possibleWakeLoop = $recentWakeActivations -ge 6
$heartbeatFresh = $false
if($state -and $state.heartbeatAt) {
  $heartbeatFresh = ([datetimeoffset]$state.heartbeatAt).UtcDateTime -gt [datetime]::UtcNow.AddSeconds(-12)
}
$result = [ordered]@{
  healthy = $backendOk -and $frontendOk -and $openAiSelected -and $openAiApiOk -and $voice.Count -eq 1 -and $recentAudio -and $heartbeatFresh -and $state.listening -and ([string]$config.Language -eq $serverLanguage) -and !$possibleSelfReplyLoop -and !$possibleWakeLoop -and $recentRuntimeErrors -eq 0 -and $activeConversationCount -ge 0 -and $activeConversationCount -le 1
  backend = $backendOk
  frontend = $frontendOk
  openAiApi = $openAiApiOk
  configuredSpeechProvider = [string]$voiceConfig.tts.provider
  effectiveSpeechProvider = if($openAiSelected -and $openAiApiOk){'openai'}else{'unavailable'}
  voiceProcessCount = $voice.Count
  microphone = $microphone
  recentMicrophoneAudio = $recentAudio
  recentBusinessResponses = $recentBusinessResponses
  possibleSelfReplyLoop = $possibleSelfReplyLoop
  recentWakeActivations = $recentWakeActivations
  possibleWakeLoop = $possibleWakeLoop
  recentRuntimeErrors = $recentRuntimeErrors
  activeConversationCount = $activeConversationCount
  voiceStatus = if($state){[string]$state.status}else{'unavailable'}
  listening = if($state){[bool]$state.listening}else{$false}
  heartbeatFresh = $heartbeatFresh
  desktopLanguage = [string]$config.Language
  serverLanguage = $serverLanguage
}
$result | ConvertTo-Json
if(!$result.healthy) { exit 1 }

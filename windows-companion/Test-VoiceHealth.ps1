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
$elevenLabsOk = $false
$openAiTtsFallbackOk = $false
$state = $null
$activeConversationCount = -1
$serverLanguage = ''
# 5 seconds, not 2: resolving "localhost" tries IPv6 first and falls back to
# IPv4 after about two seconds on this machine, which reported a running
# server as down. Measured at 2129 ms for localhost against 78 ms for
# 127.0.0.1.
try { $backendOk = (Invoke-WebRequest -Uri "$server/health" -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200 } catch {}
try { $frontendOk = (Invoke-WebRequest -Uri "$frontend/" -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200 } catch {}
$elevenLabsKey = [Environment]::GetEnvironmentVariable('ELEVENLABS_API_KEY','User')
if($elevenLabsKey) {
  try { $elevenLabsOk = (Invoke-WebRequest -Uri 'https://api.elevenlabs.io/v1/user' -Headers @{'xi-api-key'=$elevenLabsKey} -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200 } catch {}
}
$openAiKey = [Environment]::GetEnvironmentVariable('OPENAI_API_KEY','User')
if($openAiKey) {
  try { $openAiTtsFallbackOk = (Invoke-WebRequest -Uri 'https://api.openai.com/v1/models' -Headers @{Authorization="Bearer $openAiKey"} -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200 } catch {}
}
try {
  $session = Invoke-RestMethod -Uri "$server/auth/local-test-active-session" -TimeoutSec 3
  $serverLanguage = [string]$session.user.voiceLanguage
  if($session.token) {
    $headers = @{Authorization="Bearer $($session.token)"}
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
    if($line -match '^(?<stamp>\S+) v2 Picovoice (?:microphone audio confirmed|microphone level): AUDIO (?<rms>\d+) (?<peak>\d+)$') {
      try {
        if(([datetimeoffset]::Parse($matches.stamp)).UtcDateTime -gt [datetime]::UtcNow.AddSeconds(-25)) {
          $recentAudio = $true
        }
      } catch {}
    }
    if($stamp -and $stamp -gt [datetime]::UtcNow.AddSeconds(-35) -and $line -match 'v2 business response completed') {
      $recentBusinessResponses++
    }
    if($stamp -and $stamp -gt [datetime]::UtcNow.AddSeconds(-60) -and $line -match 'wake word detected and confirmed') {
      $recentWakeActivations++
    }
    if($stamp -and $stamp -gt [datetime]::UtcNow.AddSeconds(-60) -and $line -match 'v2 (?:playback error|audio output error|session failure|microphone error)') {
      $recentRuntimeErrors++
    }
    if($line -match 'Picovoice sidecar READY \d+ \d+ (?<device>.+)$') { $microphone = $matches.device }
  }
}
$possibleSelfReplyLoop = $recentBusinessResponses -ge 5
$possibleWakeLoop = $recentWakeActivations -ge 6
$heartbeatFresh = $false
if($state -and $state.heartbeatAt) {
  $heartbeatFresh = ([datetimeoffset]$state.heartbeatAt).UtcDateTime -gt [datetime]::UtcNow.AddSeconds(-12)
}
$result = [ordered]@{
  healthy = $backendOk -and $frontendOk -and ($elevenLabsOk -or $openAiTtsFallbackOk) -and $voice.Count -eq 1 -and $recentAudio -and $heartbeatFresh -and $state.listening -and ([string]$config.Language -eq $serverLanguage) -and !$possibleSelfReplyLoop -and !$possibleWakeLoop -and $recentRuntimeErrors -eq 0 -and $activeConversationCount -le 1
  backend = $backendOk
  frontend = $frontendOk
  elevenLabs = $elevenLabsOk
  openAiTtsFallback = $openAiTtsFallbackOk
  effectiveSpeechProvider = if($elevenLabsOk){'elevenlabs'}elseif($openAiTtsFallbackOk){'openai'}else{'unavailable'}
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

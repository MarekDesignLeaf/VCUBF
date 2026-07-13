$ErrorActionPreference='SilentlyContinue'
Add-Type -AssemblyName System.Security

$appDir=Join-Path $env:LOCALAPPDATA 'VCUBF\Emma'
$app=Join-Path $appDir 'app\VCUBF-Emma.ps1'
$configPath=Join-Path $appDir 'config.json'
$tokenPath=Join-Path $appDir 'token.bin'
$server='https://backend-production-7952.up.railway.app'
if(Test-Path -LiteralPath $configPath){
  try{$saved=Get-Content -LiteralPath $configPath -Raw|ConvertFrom-Json;if($saved.ServerUrl){$server=$saved.ServerUrl.TrimEnd('/')}}catch{}
}

# Every desktop launch creates a fresh one-time browser handoff. This binds
# Emma to the account that actually completes this login, avoiding a split
# state where the web app and the Windows companion use different sessions.
$pairing=$null
try{$pairing=Invoke-RestMethod -Method POST -Uri "$server/auth/device/start" -ContentType 'application/json' -Body '{}' -TimeoutSec 15}catch{}

$running=Get-CimInstance Win32_Process|Where-Object{$_.Name -eq 'powershell.exe' -and $_.CommandLine -like "*$app*"}
if(!$running -and (Test-Path -LiteralPath $app)){
  $shell=New-Object -ComObject WScript.Shell
  $null=$shell.Run("powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$app`" -DesktopLaunch -Announce",0,$false)
  Start-Sleep -Milliseconds 700
}

$url='https://frontend-production-ee13.up.railway.app/login'
if($pairing){$url=$pairing.verification_url}
elseif(Test-Path -LiteralPath $configPath){
  try{$email=(Get-Content -LiteralPath $configPath -Raw|ConvertFrom-Json).Email;if($email){$url+="?email=$([uri]::EscapeDataString($email))"}}catch{}
}
Start-Process $url

if(!$pairing){exit 0}

# The launcher remains hidden while the user signs in. Account.tsx approves
# the one-time code after login, then this loop stores the resulting device
# token with DPAPI for the current Windows user.
$deadline=(Get-Date).AddMinutes(10)
do{
  Start-Sleep -Seconds 2
  try{
    $result=Invoke-RestMethod -Method POST -Uri "$server/auth/device/token" -ContentType 'application/json' -Body (@{pairing_id=$pairing.pairing_id;secret=$pairing.secret}|ConvertTo-Json) -TimeoutSec 15
    if($result.token){
      $bytes=[Text.Encoding]::UTF8.GetBytes([string]$result.token)
      $protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
      [IO.File]::WriteAllBytes($tokenPath,$protected)
      if(Test-Path -LiteralPath $configPath){$config=Get-Content -LiteralPath $configPath -Raw|ConvertFrom-Json}else{$config=[pscustomobject]@{ServerUrl=$server}}
      if($config.PSObject.Properties.Name -contains 'Email'){$config.Email=$result.user.email}else{$config|Add-Member -NotePropertyName Email -NotePropertyValue $result.user.email}
      if($config.PSObject.Properties.Name -contains 'WakeWord'){$config.WakeWord=$result.user.voiceWakeWord}else{$config|Add-Member -NotePropertyName WakeWord -NotePropertyValue $result.user.voiceWakeWord}
      $config|ConvertTo-Json|Set-Content -LiteralPath $configPath -Encoding UTF8
      break
    }
  }catch{}
}while((Get-Date)-lt $deadline)

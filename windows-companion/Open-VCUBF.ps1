$ErrorActionPreference='SilentlyContinue'
Add-Type -AssemblyName System.Security
Add-Type -AssemblyName System.Windows.Forms

$appDir=Join-Path $env:LOCALAPPDATA 'VCUBF\Emma'
$app=Join-Path $appDir 'app\VCUBF-Emma.ps1'
$configPath=Join-Path $appDir 'config.json'
$tokenPath=Join-Path $appDir 'token.bin'
$server='https://backend-production-7952.up.railway.app'
$frontend='https://frontend-production-ee13.up.railway.app'
if(Test-Path -LiteralPath $configPath){
  try{$saved=Get-Content -LiteralPath $configPath -Raw|ConvertFrom-Json;if($saved.ServerUrl){$server=$saved.ServerUrl.TrimEnd('/')}}catch{}
}

function Get-SavedEmail {
  if(!(Test-Path -LiteralPath $configPath)){return ''}
  try{
    $saved=Get-Content -LiteralPath $configPath -Raw|ConvertFrom-Json
    return [string]$saved.Email
  }catch{return ''}
}

function Get-ExistingDeviceProfile {
  if(!(Test-Path -LiteralPath $tokenPath)){return $null}
  try {
    $protected=[IO.File]::ReadAllBytes($tokenPath)
    $token=[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($protected,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))
    return Invoke-RestMethod -Method GET -Uri "$server/auth/me" -Headers @{Authorization="Bearer $token"} -TimeoutSec 15
  } catch {
    # Delete only a confirmed unauthorised token. Network failures must not
    # silently disconnect an otherwise valid desktop pairing.
    if($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 401){Remove-Item -LiteralPath $tokenPath -Force -ErrorAction SilentlyContinue}
    return $null
  }
}

function Save-PairedProfile($Result) {
  $bytes=[Text.Encoding]::UTF8.GetBytes([string]$Result.token)
  $protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  [IO.File]::WriteAllBytes($tokenPath,$protected)
  if(Test-Path -LiteralPath $configPath){$config=Get-Content -LiteralPath $configPath -Raw|ConvertFrom-Json}else{$config=[pscustomobject]@{ServerUrl=$server}}
  foreach($pair in @(@('Email',[string]$Result.user.email),@('WakeWord',[string]$Result.user.voiceWakeWord),@('Language',[string]$Result.user.voiceLanguage))){
    if(!$pair[1]){continue}
    if($config.PSObject.Properties.Name -contains $pair[0]){$config.($pair[0])=$pair[1]}else{$config|Add-Member -NotePropertyName $pair[0] -NotePropertyValue $pair[1]}
  }
  if(!($config.PSObject.Properties.Name -contains 'ServerUrl')){$config|Add-Member -NotePropertyName ServerUrl -NotePropertyValue $server}
  $config|ConvertTo-Json|Set-Content -LiteralPath $configPath -Encoding UTF8
}

function Start-Emma {
  $running=Get-CimInstance Win32_Process|Where-Object{$_.Name -eq 'powershell.exe' -and $_.CommandLine -like "*$app*"}
  if(!$running -and (Test-Path -LiteralPath $app)){
    $shell=New-Object -ComObject WScript.Shell
    $null=$shell.Run("powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$app`" -Announce",0,$false)
  }
}

function Open-Login([string]$Email) {
  $url="$frontend/login"
  if($Email){$url+="?email=$([uri]::EscapeDataString($Email))"}
  Start-Process $url
}

# A valid local device token represents the already-approved Windows Emma
# account.  Reuse it instead of forcing a fresh pairing on every double-click.
$profile=Get-ExistingDeviceProfile
if($profile){
  Save-PairedProfile ([pscustomobject]@{token=[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($tokenPath),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser));user=$profile})
  Start-Emma
  Open-Login ([string]$profile.email)
  exit 0
}

# First use or an expired token: pair in the browser first.  Emma starts only
# after the device token and voice language have been stored, so it cannot
# briefly listen in the wrong language or claim to be ready without access.
$pairing=$null
try{$pairing=Invoke-RestMethod -Method POST -Uri "$server/auth/device/start" -ContentType 'application/json' -Body '{}' -TimeoutSec 15}catch{}
if(!$pairing){
  Open-Login (Get-SavedEmail)
  [Windows.Forms.MessageBox]::Show('VCUBF could not start secure device pairing. Sign in in the browser, then open the desktop icon again.','VCUBF Emma','OK','Warning')|Out-Null
  exit 1
}

Start-Process $pairing.verification_url
$deadline=(Get-Date).AddMinutes(10)
$paired=$false
do{
  Start-Sleep -Seconds 2
  try{
    $result=Invoke-RestMethod -Method POST -Uri "$server/auth/device/token" -ContentType 'application/json' -Body (@{pairing_id=$pairing.pairing_id;secret=$pairing.secret}|ConvertTo-Json) -TimeoutSec 15
    if($result.token){Save-PairedProfile $result;$paired=$true;break}
  }catch{}
}while((Get-Date)-lt $deadline)

if($paired){Start-Emma;exit 0}
[Windows.Forms.MessageBox]::Show('Pairing expired before sign-in was approved. Open VCUBF Secretary again to create a new secure code.','VCUBF Emma','OK','Warning')|Out-Null
exit 1

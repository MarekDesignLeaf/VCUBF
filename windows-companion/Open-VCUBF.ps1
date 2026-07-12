$ErrorActionPreference='SilentlyContinue'
$app=Join-Path $env:LOCALAPPDATA 'VCUBF\Emma\app\VCUBF-Emma.ps1'
$running=Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'powershell.exe' -and $_.CommandLine -like "*$app*" }
if(!$running -and (Test-Path -LiteralPath $app)) {
  $shell=New-Object -ComObject WScript.Shell
  $null=$shell.Run("powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$app`"",0,$false)
  Start-Sleep -Milliseconds 500
}
$url='https://frontend-production-ee13.up.railway.app/login'
$config=Join-Path $env:LOCALAPPDATA 'VCUBF\Emma\config.json'
if(Test-Path -LiteralPath $config) {
  try { $email=(Get-Content -LiteralPath $config -Raw|ConvertFrom-Json).Email; if($email){$url+="?email=$([uri]::EscapeDataString($email))"} } catch {}
}
Start-Process $url

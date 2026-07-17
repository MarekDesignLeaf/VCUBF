param([switch]$SkipTest)

$ErrorActionPreference='Stop'
$source=Split-Path -Parent $PSCommandPath
$emmaRoot=Join-Path $env:LOCALAPPDATA 'VCUBF\Emma'
$runtimeRoot=Join-Path $emmaRoot 'npu-whisper'
$appRoot=Join-Path $runtimeRoot 'fetch\whisper_windows_py'
$bootstrap=Join-Path $runtimeRoot 'bootstrap'
$activeConfig=Join-Path $emmaRoot 'voice-v2.json'

$npu=Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue|Where-Object{
  $_.Status -eq 'OK' -and $_.Class -eq 'ComputeAccelerator' -and $_.FriendlyName -match 'Qualcomm.*Hexagon.*NPU'
}|Select-Object -First 1
if(!$npu){throw 'Qualcomm Hexagon NPU was not found or its driver is not ready.'}

$python=Join-Path $env:LOCALAPPDATA 'Programs\Python\Python311\python.exe'
if(!(Test-Path -LiteralPath $python) -or (& $python -c 'import platform;print(platform.machine())' 2>$null) -ne 'AMD64'){
  winget install --id Python.Python.3.11 --exact --scope user --architecture x64 --force --silent --disable-interactivity --accept-package-agreements --accept-source-agreements
  if($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $python)){throw 'Python 3.11 x64 could not be installed.'}
}

$bootstrapVenv=Join-Path $bootstrap '.venv'
$bootstrapPython=Join-Path $bootstrapVenv 'Scripts\python.exe'
if(!(Test-Path -LiteralPath $bootstrapPython)){
  & $python -m venv $bootstrapVenv
  if($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $bootstrapPython)){throw 'The Qualcomm bootstrap environment could not be created.'}
}
& $bootstrapPython -m pip install --disable-pip-version-check --quiet 'qai-hub-apps==0.32.2'
if($LASTEXITCODE -ne 0){throw 'Qualcomm AI Hub Apps could not be installed.'}

if(!(Test-Path -LiteralPath (Join-Path $appRoot 'models\encoder.onnx')) -or !(Test-Path -LiteralPath (Join-Path $appRoot 'models\decoder.onnx'))){
  $fetch=Join-Path (Split-Path -Parent $bootstrapPython) 'qai-hub-apps.exe'
  & $fetch fetch whisper_windows_py --model whisper_base --chipset qualcomm-snapdragon-x-elite --output-dir (Join-Path $runtimeRoot 'fetch')
  if($LASTEXITCODE -ne 0){throw 'The Qualcomm Whisper NPU model could not be downloaded.'}
}

$runtimePython=Join-Path $appRoot '.venv\Scripts\python.exe'
if(!(Test-Path -LiteralPath $runtimePython)){
  & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File (Join-Path $appRoot 'install_runtime.ps1')
  if($LASTEXITCODE -ne 0){throw 'The Qualcomm Whisper NPU runtime could not be installed.'}
}
& $runtimePython -c "import onnxruntime as ort; assert 'QNNExecutionProvider' in ort.get_available_providers()"
if($LASTEXITCODE -ne 0){throw 'The Qualcomm Whisper runtime does not expose QNNExecutionProvider.'}

$installedSidecar=Join-Path $emmaRoot 'app\npu_whisper_sidecar.py'
New-Item -ItemType Directory -Path (Split-Path -Parent $installedSidecar) -Force|Out-Null
Copy-Item -LiteralPath (Join-Path $source 'npu_whisper_sidecar.py') -Destination $installedSidecar -Force

if(!(Test-Path -LiteralPath $activeConfig)){
  Copy-Item -LiteralPath (Join-Path $source 'voice-v2.example.json') -Destination $activeConfig -Force
}
$config=Get-Content -LiteralPath $activeConfig -Raw|ConvertFrom-Json
if(!$config.PSObject.Properties['stt']){$config|Add-Member -NotePropertyName stt -NotePropertyValue ([pscustomobject]@{})}
if($config.stt.PSObject.Properties['provider']){$config.stt.provider='npu_whisper'}else{$config.stt|Add-Member -NotePropertyName provider -NotePropertyValue 'npu_whisper'}
if(!$config.stt.PSObject.Properties['npu']){$config.stt|Add-Member -NotePropertyName npu -NotePropertyValue ([pscustomobject]@{})}
foreach($pair in @(@('pythonPath',$runtimePython),@('appPath',$appRoot),@('modelSize','base'))){
  if($config.stt.npu.PSObject.Properties[$pair[0]]){$config.stt.npu.($pair[0])=$pair[1]}
  else{$config.stt.npu|Add-Member -NotePropertyName $pair[0] -NotePropertyValue $pair[1]}
}
$config|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $activeConfig -Encoding UTF8

if(!$SkipTest){
  & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File (Join-Path $appRoot 'test.ps1')
  if($LASTEXITCODE -ne 0){throw 'The Qualcomm NPU transcription test failed.'}
}

Write-Host 'Qualcomm NPU Whisper is installed and selected for Emma Voice v2. Deepgram remains the automatic fallback.'

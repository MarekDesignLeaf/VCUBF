$target=Join-Path $env:LOCALAPPDATA 'VCUBF\Emma'
Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('Startup')) 'VCUBF Emma.lnk') -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('Desktop')) 'VCUBF Secretary.lnk') -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'powershell.exe' -and $_.CommandLine -like '*VCUBF-Emma.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue
Write-Host 'VCUBF Emma uninstalled.'

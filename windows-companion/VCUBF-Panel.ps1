# VCUBF — ovládání a stav: the control and status window for the live
# Secretary on Railway.
#
# What runs where:
#   * Railway: the server, the database and speech transcription. They are
#     restarted there, never from this PC, so this window only reports on them.
#   * This PC: the Secretary window, Chrome in app mode with its own profile,
#     opened by Open-SecretaryRailway.ps1 with this PC's device key. Alfonzo
#     listens and speaks inside that window, so starting, stopping or restarting
#     the window starts, stops or restarts Alfonzo.
#
# Two earlier panels no longer fit and are left untouched on disk:
#   * C:\VCUBF\vcubf-panel.ps1 runs a local copy (localhost, local PostgreSQL,
#     local Whisper). Its Start would bring up a second Secretary on this PC,
#     and Secretary runs on Railway only.
#   * The 26 September Railway panel drove the Python voice companion and its
#     own browser window, which no longer run; its Restart would start a second
#     Alfonzo next to the one in the Secretary window.
#
# There is no microphone switch here on purpose: listening is never turned on or
# off by hand.
#
# -Check prints the status once and exits, without opening a window.

param([switch]$Check)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Net.Http

$webDir     = Join-Path $env:LOCALAPPDATA 'VCUBF\SecretaryWeb'
$launcher   = Join-Path $webDir 'Open-SecretaryRailway.ps1'
$profileDir = Join-Path $webDir 'profile'
$server     = 'https://backend-production-7952.up.railway.app'
$frontend   = 'https://frontend-production-ee13.up.railway.app'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$icon       = 'C:\VCUBF\vcubf.ico'

# Windows PowerShell 5.1 runs on .NET Framework, whose default may still offer
# old TLS versions first; Railway accepts only modern ones.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# --- the Secretary window ----------------------------------------------------

# Every process of the Secretary window carries its own profile folder on its
# command line; the person's everyday Chrome never does. Found this way, a window
# opened before this panel started is still seen, and still stoppable.
function Get-WindowProcesses {
    $needle = $profileDir.ToLowerInvariant()
    @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($needle) })
}

function Test-Window { (Get-WindowProcesses).Count -gt 0 }

$script:startedAt = [datetime]::MinValue

function Start-SecretaryWindow {
    if (Test-Window) { return }
    if (-not (Test-Path -LiteralPath $launcher)) {
        [void][System.Windows.Forms.MessageBox]::Show("Spouštěč Secretary chybí:`n$launcher", 'VCUBF — ovládání a stav', 'OK', 'Error')
        return
    }
    $script:startedAt = Get-Date
    Start-Process -FilePath $powershell -WindowStyle Hidden -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$launcher`""
    ) | Out-Null
}

function Wait-WindowGone([int]$seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline -and (Test-Window)) {
        Start-Sleep -Milliseconds 250
        [System.Windows.Forms.Application]::DoEvents()
    }
}

function Stop-SecretaryWindow {
    if (-not (Test-Window)) { return }
    # Asked to close first, so Chrome shuts down cleanly and leaves nothing
    # half-written in its profile; whatever is still running after that is ended.
    foreach ($process in Get-WindowProcesses) {
        try {
            $running = Get-Process -Id $process.ProcessId -ErrorAction Stop
            if ($running.MainWindowHandle -ne [IntPtr]::Zero) { [void]$running.CloseMainWindow() }
        } catch { }
    }
    Wait-WindowGone 5
    Get-WindowProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Wait-WindowGone 3
    $script:startedAt = [datetime]::MinValue
}

function Restart-SecretaryWindow {
    Stop-SecretaryWindow
    Start-SecretaryWindow
}

# --- Railway and the internet ------------------------------------------------

# Checked without blocking: a request is started on one tick of the window's
# timer and read on a later one, so a slow or missing connection never freezes
# the window.
$http = New-Object System.Net.Http.HttpClient
$http.Timeout = [TimeSpan]::FromSeconds(6)
$script:probes = $null
$script:status = @{ Server = $null; Build = ''; ServerDetail = ''; Web = $null; Internet = $null }

function Start-Probes {
    $tcp = New-Object Net.Sockets.TcpClient
    $script:probes = @{
        Since  = Get-Date
        Server = $http.GetStringAsync("$server/health")
        Web    = $http.GetAsync("$frontend/index.html", [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead)
        Tcp    = $tcp
        Net    = $tcp.ConnectAsync('api.openai.com', 443)
    }
}

function Test-Succeeded($task) { $task.IsCompleted -and -not $task.IsFaulted -and -not $task.IsCanceled }

function Read-Server($task) {
    if (-not (Test-Succeeded $task)) {
        $reason = if ($task.Exception) { $task.Exception.GetBaseException().Message } else { 'bez odpovědi' }
        $script:status.Server = $false; $script:status.Build = ''; $script:status.ServerDetail = $reason
        return
    }
    try {
        $health = $task.Result | ConvertFrom-Json
        $script:status.Server = ($health.status -eq 'ok')
        $script:status.Build = [string]$health.build
        $script:status.ServerDetail = $task.Result
    } catch {
        $script:status.Server = $false; $script:status.Build = ''; $script:status.ServerDetail = $task.Result
    }
}

function Read-Web($task) {
    if (Test-Succeeded $task) {
        $script:status.Web = $task.Result.IsSuccessStatusCode
        $task.Result.Dispose()
    } else {
        $script:status.Web = $false
    }
}

# Reads whatever has finished; anything still running after eight seconds
# counts as not answering. Returns true once the round is complete.
function Read-Probes {
    if (-not $script:probes) { return $true }
    $late = ((Get-Date) - $script:probes.Since).TotalSeconds -gt 8
    $tasks = @($script:probes.Server, $script:probes.Web, $script:probes.Net)
    $done = @($tasks | Where-Object { $_.IsCompleted }).Count -eq $tasks.Count
    if (-not $done -and -not $late) { return $false }
    Read-Server $script:probes.Server
    Read-Web $script:probes.Web
    $script:status.Internet = Test-Succeeded $script:probes.Net
    try { $script:probes.Tcp.Close() } catch { }
    $script:probes = $null
    return $true
}

function Get-ShortBuild { if ($script:status.Build.Length -gt 7) { $script:status.Build.Substring(0, 7) } else { $script:status.Build } }

# --- report --------------------------------------------------------------------

function Get-Report {
    $window = @(Get-WindowProcesses)
    $lines = New-Object System.Collections.ArrayList
    [void]$lines.Add("VCUBF — stav  ($(Get-Date -Format 'dd.MM.yyyy HH:mm:ss'))")
    [void]$lines.Add('')
    $checks = @(
        @{ Name = 'Připojení k internetu'; Ok = $script:status.Internet; Detail = '';
           Why = 'Bez internetu Alfonzo nerozumí ani nemluví a Secretary se nenačte.' },
        @{ Name = 'Server na Railway'; Ok = $script:status.Server; Detail = $(if ($script:status.Build) { "verze $(Get-ShortBuild)" } else { $script:status.ServerDetail });
           Why = 'Data, oprávnění a přepis řeči jsou na serveru. Restartuje se na Railway, ne z tohoto počítače.' },
        @{ Name = 'Aplikace na Railway'; Ok = $script:status.Web; Detail = '';
           Why = 'Okno Secretary se nemá odkud načíst.' },
        @{ Name = 'Okno Secretary s Alfonzem'; Ok = ($window.Count -gt 0); Detail = $(if ($window.Count) { "procesů: $($window.Count)" } else { '' });
           Why = 'Secretary není otevřený, a tak Alfonzo neposlouchá. Dejte Spustit.' }
    )
    $first = $null
    foreach ($check in $checks) {
        $word = if ($check.Ok) { 'BĚŽÍ   ' } else { 'CHYBÍ  ' }
        $detail = if ($check.Detail) { "  ($($check.Detail))" } else { '' }
        [void]$lines.Add("  $word $($check.Name)$detail")
        if (-not $check.Ok -and -not $first) { $first = $check }
    }
    [void]$lines.Add('')
    if ($first) {
        [void]$lines.Add("PŘÍČINA: $($first.Name)")
        [void]$lines.Add("  $($first.Why)")
    } else {
        [void]$lines.Add('ZÁVĚR: vše potřebné běží.')
    }
    return $lines -join [Environment]::NewLine
}

if ($Check) {
    Start-Probes
    # WaitAll throws when a check failed; the failure is read from the task below.
    try { [void][System.Threading.Tasks.Task]::WaitAll(@($script:probes.Server, $script:probes.Web, $script:probes.Net), 8000) } catch { }
    [void](Read-Probes)
    if ($script:probes) { $script:probes.Since = [datetime]::MinValue; [void](Read-Probes) }
    Get-Report
    exit 0
}

# --- window ----------------------------------------------------------------------

[System.Windows.Forms.Application]::EnableVisualStyles()

$dark        = [System.Drawing.Color]::FromArgb(18, 22, 20)
$panelColour = [System.Drawing.Color]::FromArgb(28, 33, 31)
$textColour  = [System.Drawing.Color]::FromArgb(228, 232, 230)
$muted       = [System.Drawing.Color]::FromArgb(150, 158, 154)
$green       = [System.Drawing.Color]::FromArgb(74, 222, 128)
$amber       = [System.Drawing.Color]::FromArgb(230, 190, 90)
$red         = [System.Drawing.Color]::FromArgb(240, 110, 110)

$form = New-Object System.Windows.Forms.Form
$form.Text = 'VCUBF — ovládání a stav'
$form.ClientSize = New-Object System.Drawing.Size(620, 366)
$form.StartPosition = 'CenterScreen'
$form.BackColor = $dark
$form.ForeColor = $textColour
$form.Font = New-Object System.Drawing.Font('Segoe UI', 9.5)
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false
if (Test-Path -LiteralPath $icon) { $form.Icon = New-Object System.Drawing.Icon($icon) }

function Show-Text([string]$title, [string]$body) {
    $window = New-Object System.Windows.Forms.Form
    $window.Text = $title
    $window.ClientSize = New-Object System.Drawing.Size(720, 360)
    $window.StartPosition = 'CenterParent'
    $window.BackColor = $dark
    if (Test-Path -LiteralPath $icon) { $window.Icon = New-Object System.Drawing.Icon($icon) }
    $box = New-Object System.Windows.Forms.TextBox
    $box.Multiline = $true; $box.ReadOnly = $true; $box.ScrollBars = 'Both'; $box.WordWrap = $false
    $box.Dock = 'Fill'
    $box.BackColor = [System.Drawing.Color]::FromArgb(12, 15, 14)
    $box.ForeColor = [System.Drawing.Color]::FromArgb(210, 220, 214)
    $box.Font = New-Object System.Drawing.Font('Consolas', 9.5)
    $box.Text = $body
    $box.Select(0, 0)
    $window.Controls.Add($box)
    [void]$window.ShowDialog($form)
}

function New-FlatButton([string]$text, [int]$x, [int]$y, [int]$w, [int]$h) {
    $button = New-Object System.Windows.Forms.Button
    $button.Text = $text
    $button.Location = New-Object System.Drawing.Point($x, $y)
    $button.Size = New-Object System.Drawing.Size($w, $h)
    $button.FlatStyle = 'Flat'
    $button.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(60, 68, 64)
    $button.BackColor = [System.Drawing.Color]::FromArgb(38, 44, 41)
    $button.ForeColor = $textColour
    $button.Cursor = 'Hand'
    return $button
}

function New-Row([string]$label, [int]$top) {
    $box = New-Object System.Windows.Forms.Panel
    $box.Location = New-Object System.Drawing.Point(14, $top)
    $box.Size = New-Object System.Drawing.Size(592, 56)
    $box.BackColor = $panelColour
    $dot = New-Object System.Windows.Forms.Label
    $dot.Location = New-Object System.Drawing.Point(11, 9); $dot.Size = New-Object System.Drawing.Size(16, 18)
    $dot.Text = '●'; $dot.Font = New-Object System.Drawing.Font('Segoe UI', 12); $dot.ForeColor = $muted
    $name = New-Object System.Windows.Forms.Label
    $name.Location = New-Object System.Drawing.Point(32, 8); $name.Size = New-Object System.Drawing.Size(300, 18); $name.Text = $label
    $state = New-Object System.Windows.Forms.Label
    $state.Location = New-Object System.Drawing.Point(32, 27); $state.Size = New-Object System.Drawing.Size(320, 18)
    $state.Text = 'zjišťuji…'; $state.ForeColor = $muted; $state.Font = New-Object System.Drawing.Font('Segoe UI', 8.5)
    $box.Controls.AddRange(@($dot, $name, $state))
    $form.Controls.Add($box)
    return @{ Box = $box; Dot = $dot; State = $state }
}

function Set-Row($row, [string]$colour, [string]$text) {
    $row.Dot.ForeColor = switch ($colour) { 'green' { $green } 'amber' { $amber } 'grey' { $muted } default { $red } }
    $row.State.Text = $text
}

# Row 1: the only thing that runs on this PC.
$localRow = New-Row 'Secretary a Alfonzo (tento počítač)' 12
$startButton   = New-FlatButton 'Spustit'  382 14 64 28
$stopButton    = New-FlatButton 'Zastavit' 450 14 66 28
$restartButton = New-FlatButton 'Restart'  520 14 62 28
$localRow.Box.Controls.AddRange(@($startButton, $stopButton, $restartButton))

# Rows 2 to 4: reported only.
$serverRow = New-Row 'Server na Railway' 74
$serverButton = New-FlatButton 'Stav' 520 14 62 28
$serverRow.Box.Controls.Add($serverButton)
$webRow = New-Row 'Aplikace na Railway' 136
$netRow = New-Row 'Připojení k internetu' 198

$diagnose = New-FlatButton 'Diagnostika' 14 268 140 38
$quit = New-FlatButton 'Ukončit vše' 162 268 120 38
$quit.ForeColor = $red

$hint = New-Object System.Windows.Forms.Label
$hint.Location = New-Object System.Drawing.Point(16, 316)
$hint.Size = New-Object System.Drawing.Size(592, 44)
$hint.ForeColor = $muted
$hint.Font = New-Object System.Drawing.Font('Segoe UI', 8.5)
$hint.Text = "Server, databáze a přepis řeči běží na Railway a restartují se tam. Na tomto počítači běží jen okno Secretary`na Alfonzo v něm. Zavřením tohoto okna se nic nezastaví."
$form.Controls.AddRange(@($diagnose, $quit, $hint))

$refreshWindowRow = {
    if (Test-Window) {
        $script:startedAt = [datetime]::MinValue
        Set-Row $localRow 'green' 'běží — Alfonzo je v okně Secretary'
    } elseif (((Get-Date) - $script:startedAt).TotalSeconds -lt 30) {
        Set-Row $localRow 'amber' 'spouští se…'
    } else {
        Set-Row $localRow 'red' 'zavřeno — Alfonzo neposlouchá, dejte Spustit'
    }
}

# A new round of checks starts at most every five seconds: often enough to see a
# problem promptly, rarely enough not to load Railway from a window left open.
$script:nextProbe = [datetime]::MinValue
$refreshRailwayRows = {
    if ($script:probes) {
        if (-not (Read-Probes)) { return }
        if ($script:status.Server) { Set-Row $serverRow 'green' "běží — verze $(Get-ShortBuild)" } else { Set-Row $serverRow 'red' 'neodpovídá' }
        if ($script:status.Web) { Set-Row $webRow 'green' 'běží' } else { Set-Row $webRow 'red' 'neodpovídá' }
        if ($script:status.Internet) { Set-Row $netRow 'green' 'připojeno' } else { Set-Row $netRow 'red' 'bez připojení — Alfonzo nerozumí ani nemluví' }
    }
    if ((Get-Date) -ge $script:nextProbe) {
        Start-Probes
        $script:nextProbe = (Get-Date).AddSeconds(5)
    }
}

function Invoke-Busy([scriptblock]$action) {
    $form.UseWaitCursor = $true
    foreach ($button in @($startButton, $stopButton, $restartButton, $quit)) { $button.Enabled = $false }
    try { & $action } finally {
        foreach ($button in @($startButton, $stopButton, $restartButton, $quit)) { $button.Enabled = $true }
        $form.UseWaitCursor = $false
        & $refreshWindowRow
    }
}

$startButton.Add_Click({ Invoke-Busy { Start-SecretaryWindow } })
$stopButton.Add_Click({ Invoke-Busy { Stop-SecretaryWindow } })
$restartButton.Add_Click({ Invoke-Busy { Set-Row $localRow 'amber' 'restartuje se…'; $localRow.State.Refresh(); Restart-SecretaryWindow } })
$serverButton.Add_Click({
    $text = "Adresa: $server`r`n`r`n/health: " + $(if ($script:status.Server) { $script:status.ServerDetail } else { "NEODPOVÍDÁ — $($script:status.ServerDetail)" }) +
        "`r`n`r`nServer, databáze a přepis řeči běží na Railway. Restartují se tam, ne z tohoto počítače."
    Show-Text 'Server na Railway' $text
})
$diagnose.Add_Click({ Show-Text 'Diagnostika' (Get-Report) })
$quit.Add_Click({ Invoke-Busy { Stop-SecretaryWindow }; $form.Close() })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$script:tick = 0
$timer.Add_Tick({
    $script:tick++
    & $refreshRailwayRows
    if ($script:tick % 3 -eq 0) { & $refreshWindowRow }
})
$form.Add_Shown({ & $refreshWindowRow; & $refreshRailwayRows; $timer.Start() })

[void]$form.ShowDialog()
$timer.Stop()
$http.Dispose()

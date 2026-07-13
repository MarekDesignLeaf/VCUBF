param([switch]$Diagnostic,[string]$CommandTest)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Speech
Add-Type -AssemblyName System.Security
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$script:AppDir = Join-Path $env:LOCALAPPDATA 'VCUBF\Emma'
$script:ConfigPath = Join-Path $script:AppDir 'config.json'
$script:TokenPath = Join-Path $script:AppDir 'token.bin'
$script:LogPath = Join-Path $script:AppDir 'emma.log'
$script:Recognizer = $null
$script:Synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$script:Listening = $false
$script:ArmedUntil = [datetime]::MinValue
$script:Busy = $false
$script:Notify = $null
$script:LastResponse = ''
$script:ConversationHistory = @()

New-Item -ItemType Directory -Path $script:AppDir -Force | Out-Null

function Write-EmmaLog([string]$Message) {
  $line = '{0:o} {1}' -f [datetime]::UtcNow, $Message
  Add-Content -LiteralPath $script:LogPath -Value $line -Encoding UTF8
}

function Default-Config {
  [pscustomobject]@{ ServerUrl = 'https://backend-production-7952.up.railway.app'; Email = ''; WakeWord = 'Emma'; Language = 'en-GB'; Confidence = 0.62; AutoStart = $true; HandsFree = $true; ConversationSeconds = 12; Assistant = $true; Realtime = $true; VoiceRate = 0; VoiceVolume = 90 }
}

function Load-Config {
  if (!(Test-Path -LiteralPath $script:ConfigPath)) { return Default-Config }
  try {
    $saved = Get-Content -LiteralPath $script:ConfigPath -Raw | ConvertFrom-Json
    $defaults = Default-Config
    foreach ($name in $defaults.PSObject.Properties.Name) { if ($null -eq $saved.$name) { $saved | Add-Member -NotePropertyName $name -NotePropertyValue $defaults.$name } }
    return $saved
  } catch { Write-EmmaLog "Invalid config: $($_.Exception.Message)"; return Default-Config }
}

function Save-Config($Config) {
  $Config.ServerUrl = $Config.ServerUrl.TrimEnd('/')
  $Config | ConvertTo-Json | Set-Content -LiteralPath $script:ConfigPath -Encoding UTF8
}

function Save-Token([string]$Token) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($Token)
  $protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [IO.File]::WriteAllBytes($script:TokenPath, $protected)
}

function Load-Token {
  if (!(Test-Path -LiteralPath $script:TokenPath)) { return $null }
  try {
    $protected = [IO.File]::ReadAllBytes($script:TokenPath)
    $bytes = [Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    return [Text.Encoding]::UTF8.GetString($bytes)
  } catch { Remove-Item -LiteralPath $script:TokenPath -Force -ErrorAction SilentlyContinue; return $null }
}

function Invoke-Vcubf([string]$Method, [string]$Path, $Body = $null, [switch]$Anonymous) {
  $headers = @{}
  if (!$Anonymous) {
    $token = Load-Token
    if (!$token) { throw 'LOGIN_REQUIRED' }
    $headers.Authorization = "Bearer $token"
  }
  $params = @{ Method = $Method; Uri = "$($script:Config.ServerUrl)$Path"; Headers = $headers; UseBasicParsing = $true; TimeoutSec = 30 }
  if ($null -ne $Body) { $params.ContentType = 'application/json'; $params.Body = ($Body | ConvertTo-Json -Depth 8) }
  try { return Invoke-RestMethod @params }
  catch {
    if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 401) { Remove-Item -LiteralPath $script:TokenPath -Force -ErrorAction SilentlyContinue; throw 'LOGIN_REQUIRED' }
    throw
  }
}

function Speak([string]$Text) {
  if ([string]::IsNullOrWhiteSpace($Text)) { return }
  try {
    $script:Synth.Rate = [int]$script:Config.VoiceRate
    $script:Synth.Volume = [int]$script:Config.VoiceVolume
    $wasListening = $script:Listening
    if ($wasListening) { $script:Recognizer.RecognizeAsyncCancel(); $script:Listening = $false }
    $script:Synth.Speak($Text)
    if ($wasListening) { Start-Listening }
  } catch { Write-EmmaLog "Speech synthesis failed: $($_.Exception.Message)" }
}

function Spoken-Result($Response) {
  if (!$Response.ok) { if ($Response.message) { return $Response.message }; return "I could not complete that. $($Response.error)" }
  if ($Response.message) { return $Response.message }
  $count = if ($null -ne $Response.data -and $null -ne $Response.data.Count) { [int]$Response.data.Count } else { -1 }
  $noun = { param($singular,$plural) if($count -eq 1){"$count $singular"}else{"$count $plural"} }
  switch ([string]$Response.intent) {
    'list_clients' { return "You have $(& $noun 'client' 'clients')." }
    'list_jobs' { return "You have $(& $noun 'job' 'jobs')." }
    'list_leads' { return "You have $(& $noun 'lead' 'leads')." }
    'list_tasks' { return "You have $(& $noun 'task' 'tasks')." }
    'list_quotes' { return "I found $(& $noun 'quote' 'quotes')." }
    'list_job_openings' { return "I found $(& $noun 'job opening' 'job openings')." }
    'list_learning_rules' { return "You have $(& $noun 'learning rule' 'learning rules')." }
    'list_communications' { return "I found $(& $noun 'communication record' 'communication records')." }
    'list_portfolio_photos' { return "I found $(& $noun 'photo' 'photos')." }
    'list_follow_ups' { return "You have $(& $noun 'follow up' 'follow ups') due." }
    'list_unresolved_enquiries' { return "You have $(& $noun 'unresolved enquiry' 'unresolved enquiries')." }
    'list_notifications' { return "You have $(& $noun 'notification' 'notifications')." }
    'create_client' { return "The client was created." }
    'create_lead' { return "The lead was created." }
    'create_job' { return "The job was created." }
    'create_task' { return "The task was created." }
    'create_service' { return "The service was created." }
    'assign_job' { return "The job was assigned." }
    'change_job_status' { return "The job status was updated." }
    'convert_lead' { return "The lead was converted." }
    default { return "$(([string]$Response.intent).Replace('_',' ')) completed successfully." }
  }
}

function Handle-LocalConversation([string]$Command) {
  $normal=$Command.Trim().ToLowerInvariant()
  if($normal -match '^(hello|hi|good morning|good afternoon)[.! ]*$'){Speak 'Hello. How can I help?';$script:ArmedUntil=[datetime]::UtcNow.AddSeconds([int]$script:Config.ConversationSeconds);return $true}
  if($normal -match '^(what can you do|help|commands)[?!. ]*$'){Speak 'I can create and list clients, leads, jobs, tasks and services, assign jobs, change job status, list quotes, communications, follow ups, notifications and more.';$script:ArmedUntil=[datetime]::UtcNow.AddSeconds([int]$script:Config.ConversationSeconds);return $true}
  if($normal -match '^(repeat|say that again)[?!. ]*$'){Speak $(if($script:LastResponse){$script:LastResponse}else{'There is nothing to repeat yet.'});$script:ArmedUntil=[datetime]::UtcNow.AddSeconds([int]$script:Config.ConversationSeconds);return $true}
  if($normal -match '^(thank you|thanks)[?!. ]*$'){Speak "You're welcome.";$script:ArmedUntil=[datetime]::UtcNow.AddSeconds([int]$script:Config.ConversationSeconds);return $true}
  if($normal -match '^(stop|cancel|that is all|goodbye)[?!. ]*$'){Speak 'Okay.';$script:ArmedUntil=[datetime]::MinValue;return $true}
  return $false
}

function Show-Login {
  try { $pairing=Invoke-Vcubf POST '/auth/device/start' @{} -Anonymous }
  catch { [Windows.Forms.MessageBox]::Show('Could not start browser sign-in. Check the server connection.','VCUBF Emma','OK','Error')|Out-Null;Write-EmmaLog "Pairing start failed: $($_.Exception.Message)";return $false }
  $form=New-Object Windows.Forms.Form -Property @{Text='Connect VCUBF Emma';Size=New-Object Drawing.Size(500,285);StartPosition='CenterScreen';TopMost=$true;FormBorderStyle='FixedDialog';MaximizeBox=$false}
  $title=New-Object Windows.Forms.Label -Property @{Left=20;Top=20;Width=440;Height=42;Text='Sign in in your browser using its saved passwords, then approve this matching code.'}
  $code=New-Object Windows.Forms.Label -Property @{Left=100;Top=75;Width=300;Height=45;Text=$pairing.code;Font=New-Object Drawing.Font('Consolas',22,[Drawing.FontStyle]::Bold);TextAlign='MiddleCenter'}
  $status=New-Object Windows.Forms.Label -Property @{Left=20;Top=135;Width=440;Height=35;Text='Waiting for browser approval…';TextAlign='MiddleCenter'}
  $open=New-Object Windows.Forms.Button -Property @{Left=90;Top=185;Width=145;Text='Open browser again'}
  $copy=New-Object Windows.Forms.Button -Property @{Left=245;Top=185;Width=145;Text='Copy code'}
  $cancel=New-Object Windows.Forms.Button -Property @{Left=365;Top=225;Width=95;Text='Cancel';DialogResult='Cancel'}
  $form.Controls.AddRange(@($title,$code,$status,$open,$copy,$cancel));$form.CancelButton=$cancel
  $open.Add_Click({Start-Process $pairing.verification_url});$copy.Add_Click({[Windows.Forms.Clipboard]::SetText($pairing.code)})
  $timer=New-Object Windows.Forms.Timer -Property @{Interval=2000}
  $timer.Add_Tick({
    try {
      $result=Invoke-Vcubf POST '/auth/device/token' @{pairing_id=$pairing.pairing_id;secret=$pairing.secret} -Anonymous
      if($result.token){Save-Token $result.token;$script:Config.WakeWord=$result.user.voiceWakeWord;$script:Config.Email=$result.user.email;Save-Config $script:Config;$status.Text='Connected successfully.';$timer.Stop();$form.DialogResult='OK';$form.Close()}
    } catch { if($_.Exception.Message -match 'PAIRING_EXPIRED|PAIRING_ALREADY_USED'){$status.Text='The pairing expired. Close and try again.';$timer.Stop()} }
  })
  Start-Process $pairing.verification_url
  $timer.Start();$dialog=$form.ShowDialog();$timer.Stop();$timer.Dispose();$form.Dispose()
  return $dialog -eq 'OK'
}

function Ensure-Login {
  try { Invoke-Vcubf GET '/auth/me' | Out-Null; return $true } catch { return Show-Login }
}

function Set-AutoStart([bool]$Enabled) {
  $startup = [Environment]::GetFolderPath('Startup')
  $shortcutPath = Join-Path $startup 'VCUBF Emma.lnk'
  if (!$Enabled) { Remove-Item -LiteralPath $shortcutPath -Force -ErrorAction SilentlyContinue; return }
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`""
  $shortcut.WorkingDirectory = Split-Path -Parent $PSCommandPath
  $shortcut.IconLocation = "$env:SystemRoot\System32\SHELL32.dll,220"
  $shortcut.Save()
}

function Show-Settings {
  $form = New-Object Windows.Forms.Form -Property @{ Text='VCUBF Emma settings'; Size=New-Object Drawing.Size(470,465); StartPosition='CenterScreen'; TopMost=$true; FormBorderStyle='FixedDialog'; MaximizeBox=$false }
  $wake = New-Object Windows.Forms.TextBox -Property @{ Left=150; Top=30; Width=230; Text=$script:Config.WakeWord }
  $confidence = New-Object Windows.Forms.NumericUpDown -Property @{ Left=150; Top=70; Width=100; DecimalPlaces=2; Minimum=.30; Maximum=.95; Increment=.05; Value=[decimal]$script:Config.Confidence }
  $auto = New-Object Windows.Forms.CheckBox -Property @{ Left=150; Top=110; Width=230; Text='Start with Windows'; Checked=[bool]$script:Config.AutoStart }
  $hands = New-Object Windows.Forms.CheckBox -Property @{ Left=150; Top=140; Width=260; Text='Hands-free automatic execution'; Checked=[bool]$script:Config.HandsFree }
  $assistant = New-Object Windows.Forms.CheckBox -Property @{ Left=150; Top=170; Width=270; Text='Natural conversation with OpenAI'; Checked=[bool]$script:Config.Assistant }
  $realtime = New-Object Windows.Forms.CheckBox -Property @{ Left=150; Top=200; Width=270; Text='Realtime audio and interruption'; Checked=[bool]$script:Config.Realtime }
  $language = New-Object Windows.Forms.ComboBox -Property @{ Left=150; Top=235; Width=120; DropDownStyle='DropDownList' }
  @('en-GB','en-US') | ForEach-Object {[void]$language.Items.Add($_)}; $language.SelectedItem=$script:Config.Language
  $rate = New-Object Windows.Forms.NumericUpDown -Property @{ Left=150; Top=270; Width=100; Minimum=-5; Maximum=5; Value=[decimal]$script:Config.VoiceRate }
  $volume = New-Object Windows.Forms.NumericUpDown -Property @{ Left=150; Top=305; Width=100; Minimum=0; Maximum=100; Increment=5; Value=[decimal]$script:Config.VoiceVolume }
  $server = New-Object Windows.Forms.TextBox -Property @{ Left=150; Top=340; Width=270; Text=$script:Config.ServerUrl }
  foreach ($pair in @(@('Wake word',30),@('Confidence',70),@('Startup',110),@('Mode',140),@('Assistant',170),@('Realtime',200),@('Language',235),@('Voice speed',270),@('Voice volume',305),@('Server',340))) { $form.Controls.Add((New-Object Windows.Forms.Label -Property @{ Left=20; Top=$pair[1]; Width=120; Text=$pair[0] })) }
  $save = New-Object Windows.Forms.Button -Property @{ Left=300; Top=385; Width=120; Text='Save'; DialogResult='OK' }
  $form.Controls.AddRange(@($wake,$confidence,$auto,$hands,$assistant,$realtime,$language,$rate,$volume,$server,$save)); $form.AcceptButton=$save
  if ($form.ShowDialog() -ne 'OK') { return }
  if ($wake.Text.Trim().Length -lt 2) { [Windows.Forms.MessageBox]::Show('Wake word must contain at least two characters.') | Out-Null; return }
  $script:Config.WakeWord=$wake.Text.Trim(); $script:Config.Confidence=[double]$confidence.Value; $script:Config.AutoStart=$auto.Checked; $script:Config.HandsFree=$hands.Checked; $script:Config.Assistant=$assistant.Checked; $script:Config.Realtime=$realtime.Checked; $script:Config.Language=[string]$language.SelectedItem; $script:Config.VoiceRate=[int]$rate.Value; $script:Config.VoiceVolume=[int]$volume.Value; $script:Config.ServerUrl=$server.Text.TrimEnd('/'); Save-Config $script:Config; Set-AutoStart $script:Config.AutoStart
  try { Invoke-Vcubf PUT '/auth/voice-preferences' @{ wake_word=$script:Config.WakeWord; continuous_listening=$true; language=$script:Config.Language } | Out-Null } catch { Write-EmmaLog "Could not sync voice preferences: $($_.Exception.Message)" }
  Initialize-Recognizer
  $script:Notify.ShowBalloonTip(2500,'VCUBF Emma',"Wake word changed to $($script:Config.WakeWord).",'Info')
}

function Show-Review([string]$RecognizedText) {
  $form = New-Object Windows.Forms.Form -Property @{ Text='Review voice command'; Size=New-Object Drawing.Size(570,230); StartPosition='CenterScreen'; TopMost=$true; FormBorderStyle='FixedDialog'; MaximizeBox=$false }
  $label = New-Object Windows.Forms.Label -Property @{ Left=20; Top=20; Width=510; Text='Review or correct the command. Nothing is sent until you choose Run.' }
  $text = New-Object Windows.Forms.TextBox -Property @{ Left=20; Top=55; Width=510; Height=65; Multiline=$true; Text=$RecognizedText }
  $run = New-Object Windows.Forms.Button -Property @{ Left=410; Top=140; Width=120; Text='Run'; DialogResult='OK' }
  $cancel = New-Object Windows.Forms.Button -Property @{ Left=280; Top=140; Width=120; Text='Cancel'; DialogResult='Cancel' }
  $form.Controls.AddRange(@($label,$text,$run,$cancel)); $form.AcceptButton=$run; $form.CancelButton=$cancel
  if ($form.ShowDialog() -ne 'OK' -or [string]::IsNullOrWhiteSpace($text.Text)) { Speak 'Cancelled'; return }
  try {
    if (!(Ensure-Login)) { return }
    $response = Invoke-Vcubf POST '/command/text' @{ text=$text.Text.Trim(); input_method='voice_transcript' }
    $message = if ($response.ok) { if ($response.message) { $response.message } else { "$($response.intent) completed" } } else { if ($response.message) { $response.message } else { $response.error } }
    $script:Notify.ShowBalloonTip(4000,'VCUBF Emma',$message, $(if($response.ok){'Info'}else{'Warning'}))
    Speak $message
  } catch { Write-EmmaLog "Command failed: $($_.Exception.Message)"; $script:Notify.ShowBalloonTip(4000,'VCUBF Emma','The command could not be sent.','Error'); Speak 'The command could not be sent' }
}

function Execute-VoiceCommand([string]$Command) {
  if(Handle-LocalConversation $Command){return}
  try {
    if (!(Ensure-Login)) { return }
    $realtimeScript=Join-Path (Split-Path -Parent $PSCommandPath) 'emma_realtime.py'
    if([bool]$script:Config.Realtime -and (Test-Path -LiteralPath $realtimeScript)){
      $Command | & python.exe $realtimeScript --stdin
      if($LASTEXITCODE -eq 0){$script:ArmedUntil=[datetime]::MinValue;return}
      Write-EmmaLog 'Realtime session failed; falling back to text assistant.'
    }
    $path=if([bool]$script:Config.Assistant){'/command/assistant'}else{'/command/text'}
    $body=@{text=$Command.Trim();input_method='voice_transcript'}
    if([bool]$script:Config.Assistant){$body.language=$script:Config.Language;$body.history=@($script:ConversationHistory | Select-Object -Last 6)}
    $response=Invoke-Vcubf POST $path $body
    $message=if($response.kind -in @('reply','clarification','plan','error')){[string]$response.message}else{Spoken-Result $response}
    $script:ConversationHistory += [pscustomobject]@{role='user';content=$Command.Trim()}
    $script:ConversationHistory += [pscustomobject]@{role='assistant';content=$message}
    $script:ConversationHistory = @($script:ConversationHistory | Select-Object -Last 6)
    $script:LastResponse=$message
    $script:Notify.ShowBalloonTip(4000,'VCUBF Emma',$message,$(if($response.ok){'Info'}else{'Warning'}));Speak $message
    $script:ArmedUntil=[datetime]::UtcNow.AddSeconds([int]$script:Config.ConversationSeconds)
  } catch {Write-EmmaLog "Command failed: $($_.Exception.Message)";$message='The command could not be sent.';$script:LastResponse=$message;$script:Notify.ShowBalloonTip(4000,'VCUBF Emma',$message,'Error');Speak $message}
}

function Find-WakeCommand([string]$Text) {
  $wake = [regex]::Escape($script:Config.WakeWord)
  $match = [regex]::Match($Text, "(?i)(?:^|\W)$wake(?:\W|$)(?<command>.*)$")
  if (!$match.Success) { return $null }
  return $match.Groups['command'].Value.Trim(' ',',','.',':',';','!','-')
}

function Handle-Recognition($sender, $event) {
  if ($script:Busy -or !$script:Listening -or $event.Result.Confidence -lt [double]$script:Config.Confidence) { return }
  $text = $event.Result.Text.Trim(); if (!$text) { return }
  Write-EmmaLog ("Heard ({0:N2}): {1}" -f $event.Result.Confidence,$text)
  $command = Find-WakeCommand $text
  if ($null -ne $command) {
    if (!$command) { $script:ArmedUntil=[datetime]::UtcNow.AddSeconds(8); Speak 'Yes?'; return }
  } elseif ([datetime]::UtcNow -lt $script:ArmedUntil) { $command=$text } else { return }
  $script:ArmedUntil=[datetime]::MinValue; $script:Busy=$true
  try { $script:Recognizer.RecognizeAsyncCancel(); $script:Listening=$false; if([bool]$script:Config.HandsFree){Execute-VoiceCommand $command}else{Show-Review $command} } finally { $script:Busy=$false; Start-Listening }
}

function Initialize-Recognizer {
  $wasListening=$script:Listening
  if ($script:Recognizer) { try { $script:Recognizer.RecognizeAsyncCancel(); $script:Recognizer.Dispose() } catch {} }
  $info=[System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | Where-Object { $_.Culture.Name -eq $script:Config.Language } | Select-Object -First 1
  if (!$info) { throw "No Windows speech recognizer is installed for $($script:Config.Language)." }
  $script:Recognizer=New-Object System.Speech.Recognition.SpeechRecognitionEngine($info)
  $script:Recognizer.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
  $script:Recognizer.SetInputToDefaultAudioDevice()
  Register-ObjectEvent -InputObject $script:Recognizer -EventName SpeechRecognized -Action { Handle-Recognition $sender $event } | Out-Null
  if ($wasListening) { Start-Listening }
}

function Start-Listening {
  if ($script:Listening -or $script:Busy) { return }
  try { $script:Recognizer.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple); $script:Listening=$true; if($script:Notify){$script:Notify.Text="VCUBF Emma — listening for $($script:Config.WakeWord)"} }
  catch { Write-EmmaLog "Microphone start failed: $($_.Exception.Message)"; if($script:Notify){$script:Notify.ShowBalloonTip(4000,'VCUBF Emma','Microphone listening could not start.','Error')} }
}

function Stop-Listening {
  try { $script:Recognizer.RecognizeAsyncCancel() } catch {}; $script:Listening=$false; if($script:Notify){$script:Notify.Text='VCUBF Emma — paused'}
}

$script:Config = Load-Config
if ($CommandTest) {
  $response=Invoke-Vcubf POST '/command/text' @{text=$CommandTest;input_method='voice_transcript'}
  [pscustomobject]@{Status=$(if($response.ok){'ok'}else{'failed'});Intent=$response.intent;SpokenResponse=(Spoken-Result $response)}|ConvertTo-Json -Compress
  if(!$response.ok){exit 1};exit 0
}
if ($Diagnostic) {
  $recognizers=[System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | ForEach-Object { "$($_.Culture.Name): $($_.Description)" }
  $wakeTests = (Find-WakeCommand "$($script:Config.WakeWord) list clients") -eq 'list clients' -and (Find-WakeCommand "x$($script:Config.WakeWord) list clients") -eq $null
  $realtimeScript=Join-Path (Split-Path -Parent $PSCommandPath) 'emma_realtime.py'
  [pscustomobject]@{ Status=$(if($wakeTests -and (Test-Path -LiteralPath $realtimeScript)){'ok'}else{'failed'}); WakeWord=$script:Config.WakeWord; Server=$script:Config.ServerUrl; HandsFree=[bool]$script:Config.HandsFree; Assistant=[bool]$script:Config.Assistant; Realtime=[bool]$script:Config.Realtime; RealtimeRuntime=(Test-Path -LiteralPath $realtimeScript); ConversationSeconds=[int]$script:Config.ConversationSeconds; Recognizers=$recognizers; WakeParser=$wakeTests; TokenProtected=(Test-Path $script:TokenPath) } | ConvertTo-Json -Depth 4
  if(!$wakeTests){exit 1}
  exit 0
}

[Windows.Forms.Application]::EnableVisualStyles()
$createdNew=$false
$mutex=[Threading.Mutex]::new($true,'Local\VCUBFEmmaCompanion',[ref]$createdNew)
if(!$createdNew){[Windows.Forms.MessageBox]::Show('VCUBF Emma is already running.','VCUBF Emma')|Out-Null;exit 0}

try {
  Initialize-Recognizer
  $script:Notify=New-Object Windows.Forms.NotifyIcon -Property @{ Icon=[Drawing.SystemIcons]::Information; Visible=$true; Text='VCUBF Emma — starting' }
  $menu=New-Object Windows.Forms.ContextMenuStrip
  $talk=$menu.Items.Add('Talk to Emma now'); $start=$menu.Items.Add('Start listening'); $stop=$menu.Items.Add('Stop listening'); $settings=$menu.Items.Add('Settings'); $open=$menu.Items.Add('Open VCUBF'); $signin=$menu.Items.Add('Connect in browser'); $menu.Items.Add((New-Object Windows.Forms.ToolStripSeparator))|Out-Null; $exit=$menu.Items.Add('Exit')
  $talk.Add_Click({$script:ArmedUntil=[datetime]::UtcNow.AddSeconds(8);Speak 'Yes?'})
  $start.Add_Click({Start-Listening}); $stop.Add_Click({Stop-Listening}); $settings.Add_Click({Show-Settings}); $open.Add_Click({Start-Process 'https://frontend-production-ee13.up.railway.app'}); $signin.Add_Click({Remove-Item -LiteralPath $script:TokenPath -Force -ErrorAction SilentlyContinue; Show-Login|Out-Null}); $exit.Add_Click({$script:Context.ExitThread()})
  $script:Notify.ContextMenuStrip=$menu; $script:Notify.Add_DoubleClick({Start-Process 'https://frontend-production-ee13.up.railway.app'})
  Set-AutoStart ([bool]$script:Config.AutoStart)
  if (!(Load-Token)) { Show-Login | Out-Null }
  Start-Listening
  $script:Notify.ShowBalloonTip(3000,'VCUBF Emma',"Listening locally for $($script:Config.WakeWord).",'Info')
  $script:Context=New-Object Windows.Forms.ApplicationContext
  [Windows.Forms.Application]::Run($script:Context)
} catch { Write-EmmaLog "Fatal: $($_.Exception)"; [Windows.Forms.MessageBox]::Show($_.Exception.Message,'VCUBF Emma','OK','Error')|Out-Null }
finally { Stop-Listening; if($script:Notify){$script:Notify.Visible=$false;$script:Notify.Dispose()}; if($script:Recognizer){$script:Recognizer.Dispose()};$script:Synth.Dispose();$mutex.ReleaseMutex();$mutex.Dispose() }

param([switch]$Diagnostic,[string]$CommandTest,[switch]$DesktopLaunch,[switch]$Announce,[switch]$ShowMonitor)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Speech
Add-Type -AssemblyName System.Security
Add-Type -ReferencedAssemblies @('System.Speech','System.Collections.Concurrent') -TypeDefinition @'
using System.Collections.Concurrent;
using System.IO;
using System.Speech.Recognition;

public sealed class VcubfSpeechEvent {
  public string Kind { get; set; }
  public string Text { get; set; }
  public float Confidence { get; set; }
  public int AudioLevel { get; set; }
  public byte[] AudioWav { get; set; }
}

public sealed class VcubfSpeechBridge {
  private readonly ConcurrentQueue<VcubfSpeechEvent> queue = new ConcurrentQueue<VcubfSpeechEvent>();
  private SpeechRecognitionEngine engine;

  public void Attach(SpeechRecognitionEngine value) {
    Detach();
    engine = value;
    engine.SpeechRecognized += OnRecognized;
    engine.SpeechHypothesized += OnHypothesized;
    engine.SpeechRecognitionRejected += OnRejected;
    engine.AudioLevelUpdated += OnAudioLevel;
  }

  public void Detach() {
    if (engine == null) return;
    engine.SpeechRecognized -= OnRecognized;
    engine.SpeechHypothesized -= OnHypothesized;
    engine.SpeechRecognitionRejected -= OnRejected;
    engine.AudioLevelUpdated -= OnAudioLevel;
    engine = null;
  }

  public VcubfSpeechEvent Next() {
    VcubfSpeechEvent item;
    return queue.TryDequeue(out item) ? item : null;
  }

  private void OnRecognized(object sender, SpeechRecognizedEventArgs e) {
    byte[] audioWav = null;
    if (e.Result.Audio != null) {
      using (MemoryStream stream = new MemoryStream()) {
        e.Result.Audio.WriteToWaveStream(stream);
        audioWav = stream.ToArray();
      }
    }
    queue.Enqueue(new VcubfSpeechEvent { Kind = "recognized", Text = e.Result.Text, Confidence = e.Result.Confidence, AudioWav = audioWav });
  }
  private void OnHypothesized(object sender, SpeechHypothesizedEventArgs e) {
    queue.Enqueue(new VcubfSpeechEvent { Kind = "hypothesized", Text = e.Result.Text, Confidence = e.Result.Confidence });
  }
  private void OnRejected(object sender, SpeechRecognitionRejectedEventArgs e) {
    queue.Enqueue(new VcubfSpeechEvent { Kind = "rejected", Text = e.Result == null ? "" : e.Result.Text, Confidence = e.Result == null ? 0 : e.Result.Confidence });
  }
  private void OnAudioLevel(object sender, AudioLevelUpdatedEventArgs e) {
    queue.Enqueue(new VcubfSpeechEvent { Kind = "audio", AudioLevel = e.AudioLevel });
  }
}
'@
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$script:AppDir = Join-Path $env:LOCALAPPDATA 'VCUBF\Emma'
$script:ConfigPath = Join-Path $script:AppDir 'config.json'
$script:TokenPath = Join-Path $script:AppDir 'token.bin'
$script:LogPath = Join-Path $script:AppDir 'emma.log'
$script:Recognizer = $null
$script:DictationGrammar = $null
$script:Synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$script:Listening = $false
$script:ArmedUntil = [datetime]::MinValue
$script:Busy = $false
$script:Notify = $null
$script:LastResponse = ''
$script:ConversationHistory = @()
$script:RemotePaused = $false
$script:StateTimer = $null
$script:TranscriptConversationId = $null
$script:LaunchStartedAt = try { (Get-Process -Id $PID).StartTime.ToUniversalTime() } catch { [datetime]::UtcNow }
$script:InitialListeningLogged = $false
$script:SpeechBridge = $null
$script:RecognitionTimer = $null
$script:HearingMonitor = $null
$script:HearingMonitorStatus = $null
$script:HearingMonitorText = $null
$script:HearingMonitorLevel = $null
$script:LastLocalHypothesis = ''
$script:RealtimePreviewPath = Join-Path $script:AppDir 'emma-live.json'
$script:PreferenceSyncTicks = 0
$script:RefreshRecognizerAfterLogin = $false
$script:VoiceLanguageNames = @{
  'en-GB' = 'English (United Kingdom)'; 'en-US' = 'English (United States)'; 'cs-CZ' = 'Czech'; 'pl-PL' = 'Polish'
  'fr-FR' = 'French'; 'de-DE' = 'German'; 'es-ES' = 'Spanish'; 'it-IT' = 'Italian'
}
$script:SupportedVoiceLanguages = @('en-GB','en-US','cs-CZ','pl-PL','fr-FR','de-DE','es-ES','it-IT')

New-Item -ItemType Directory -Path $script:AppDir -Force | Out-Null

function Write-EmmaLog([string]$Message) {
  $line = '{0:o} {1}' -f [datetime]::UtcNow, $Message
  Add-Content -LiteralPath $script:LogPath -Value $line -Encoding UTF8
}

function Default-Config {
  [pscustomobject]@{ ServerUrl = 'https://backend-production-7952.up.railway.app'; Email = ''; WakeWord = 'Emma'; Language = 'en-GB'; Confidence = 0.62; AutoStart = $true; ShowMonitor = $true; HandsFree = $true; ConversationSeconds = 12; Assistant = $true; Realtime = $true; VoiceRate = 0; VoiceVolume = 90 }
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

# The desktop launcher writes the paired account, wake word and language to
# config.json after the user has approved the browser sign-in.  A companion
# that was already open must notice that change before it starts listening;
# otherwise Windows can keep recognising in the previous language.
function Sync-LocalVoiceConfig {
  try {
    $saved = Load-Config
    $wakeChanged = [string]$saved.WakeWord -ne [string]$script:Config.WakeWord
    $languageChanged = [string]$saved.Language -ne [string]$script:Config.Language
    $serverChanged = [string]$saved.ServerUrl -ne [string]$script:Config.ServerUrl
    $emailChanged = [string]$saved.Email -ne [string]$script:Config.Email
    if (!$wakeChanged -and !$languageChanged -and !$serverChanged -and !$emailChanged) { return $false }

    $script:Config = $saved
    if (($wakeChanged -or $languageChanged) -and $script:Recognizer) {
      Initialize-Recognizer
    }
    if ($languageChanged) { Select-SynthesisVoice }
    Write-EmmaLog "Local voice configuration refreshed. Wake word: $($script:Config.WakeWord); language: $($script:Config.Language)."
    return $true
  } catch {
    Write-EmmaLog "Local voice configuration refresh failed: $($_.Exception.Message)"
    return $false
  }
}

function Get-VoiceLanguageName([string]$Language) {
  if ($script:VoiceLanguageNames.ContainsKey($Language)) { return [string]$script:VoiceLanguageNames[$Language] }
  return $Language
}

function Select-SynthesisVoice {
  try {
    $target = [string]$script:Config.Language
    $base = $target.Split('-')[0]
    $voice = $script:Synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq $target } | Select-Object -First 1
    if (!$voice) { $voice = $script:Synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like "$base-*" } | Select-Object -First 1 }
    if ($voice) { $script:Synth.SelectVoice($voice.VoiceInfo.Name) }
  } catch { Write-EmmaLog "Speech voice selection failed: $($_.Exception.Message)" }
}

function Sync-VoicePreferences {
  try {
    $profile = Invoke-Vcubf GET '/auth/me'
    $nextLanguage = [string]$profile.voiceLanguage
    $nextWakeWord = [string]$profile.voiceWakeWord
    $changed = $false
    if ($nextLanguage -and $script:SupportedVoiceLanguages -contains $nextLanguage -and $script:Config.Language -ne $nextLanguage) { $script:Config.Language = $nextLanguage; $changed = $true }
    if ($nextWakeWord -and $script:Config.WakeWord -ne $nextWakeWord) { $script:Config.WakeWord = $nextWakeWord; $changed = $true }
    if (!$changed) { return $false }
    Save-Config $script:Config
    Initialize-Recognizer
    Select-SynthesisVoice
    $label = Get-VoiceLanguageName $script:Config.Language
    Write-EmmaLog "Voice preferences synchronised. Language: $label."
    if ($script:Notify) { $script:Notify.ShowBalloonTip(3000,'VCUBF Emma',"Language changed to $label.",'Info') }
    return $true
  } catch { Write-EmmaLog "Voice preference sync failed: $($_.Exception.Message)"; return $false }
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

function Invoke-VcubfAudio([byte[]]$Audio) {
  $token = Load-Token
  if (!$token) { throw 'LOGIN_REQUIRED' }
  $language = [Uri]::EscapeDataString([string]$script:Config.Language)
  $wakeWord = [Uri]::EscapeDataString([string]$script:Config.WakeWord)
  $headers = @{ Authorization = "Bearer $token" }
  try {
    return Invoke-RestMethod -Method POST -Uri "$($script:Config.ServerUrl)/command/transcribe?language=$language&wake_word=$wakeWord" -Headers $headers -ContentType 'audio/wav' -Body $Audio -UseBasicParsing -TimeoutSec 30
  } catch {
    if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 401) { Remove-Item -LiteralPath $script:TokenPath -Force -ErrorAction SilentlyContinue; throw 'LOGIN_REQUIRED' }
    throw
  }
}

function Update-VoiceState([string]$Status,[bool]$IsListening,[string]$Mode='wake_word',[string]$Transcript='',[string]$Response='',[string]$Ack='') {
  try {
    $body=@{status=$Status;mode=$Mode;listening=$IsListening}
    if($Transcript){$body.last_transcript=$Transcript}
    if($Response){$body.last_response=$Response}
    if($Ack){$body.ack_control=$Ack}
    return Invoke-Vcubf PUT '/command/voice-state' $body
  } catch { return $null }
}

function Start-TranscriptConversation([string]$Mode='local') {
  if($script:TranscriptConversationId){return}
  try{$conversation=Invoke-Vcubf POST '/command/voice-conversations' @{mode=$Mode};$script:TranscriptConversationId=[string]$conversation.id}
  catch{Write-EmmaLog "Transcript start failed: $($_.Exception.Message)"}
}

function Add-TranscriptMessage([string]$Role,[string]$Content) {
  if([string]::IsNullOrWhiteSpace($Content)){return}
  if(!$script:TranscriptConversationId){Start-TranscriptConversation 'local'}
  if(!$script:TranscriptConversationId){return}
  try{Invoke-Vcubf POST "/command/voice-conversations/$($script:TranscriptConversationId)/messages" @{role=$Role;content=$Content.Trim()}|Out-Null}
  catch{Write-EmmaLog "Transcript message failed: $($_.Exception.Message)"}
}

function End-TranscriptConversation([string]$Status='completed') {
  if(!$script:TranscriptConversationId){return}
  try{Invoke-Vcubf POST "/command/voice-conversations/$($script:TranscriptConversationId)/end" @{status=$Status}|Out-Null}
  catch{Write-EmmaLog "Transcript end failed: $($_.Exception.Message)"}
  $script:TranscriptConversationId=$null
}

function Record-TranscriptExchange([string]$Command,[string]$Response,[string]$Mode='local') {
  Start-TranscriptConversation $Mode
  Add-TranscriptMessage 'user' $Command
  Add-TranscriptMessage 'assistant' $Response
}

function Apply-RemoteControl($State) {
  $control=[string]$State.pendingControl
  if(!$control){return}
  if($control -eq 'pause'){
    $script:RemotePaused=$true
    End-TranscriptConversation 'interrupted'
    try{$script:Recognizer.RecognizeAsyncCancel()}catch{};$script:Listening=$false
    Update-VoiceState 'paused' $false 'wake_word' '' '' 'pause'|Out-Null
  } elseif($control -eq 'resume'){
    $script:RemotePaused=$false
    Update-VoiceState 'listening' $true 'wake_word' '' '' 'resume'|Out-Null
    Start-Listening
  } elseif($control -eq 'end_conversation'){
    $script:ArmedUntil=[datetime]::MinValue
    End-TranscriptConversation 'completed'
    Update-VoiceState $(if($script:RemotePaused){'paused'}else{'listening'}) (!$script:RemotePaused) 'wake_word' '' '' 'end_conversation'|Out-Null
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

function Update-HearingMonitor([string]$Text,[string]$Status='Listening locally') {
  if($Text){$script:LastLocalHypothesis=$Text.Trim()}
  if(!$script:HearingMonitor -or $script:HearingMonitor.IsDisposed){return}
  $script:HearingMonitorStatus.Text=$Status
  $script:HearingMonitorText.Text=$(if($script:LastLocalHypothesis){$script:LastLocalHypothesis}else{"Waiting for $($script:Config.WakeWord)…"})
  $script:HearingMonitor.Refresh()
}

function Update-HearingLevel([int]$Level) {
  if(!$script:HearingMonitorLevel -or $script:HearingMonitorLevel.IsDisposed){return}
  $script:HearingMonitorLevel.Value=[math]::Max(0,[math]::Min(100,$Level))
}

function Position-HearingMonitor($Form) {
  $area=[Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $x=$area.Left+[math]::Max(0,[int](($area.Width-$Form.Width)/2))
  $y=$area.Top+[math]::Max(0,[int](($area.Height-$Form.Height)/2))
  $Form.StartPosition='Manual'
  $Form.Location=New-Object Drawing.Point($x,$y)
}

function Show-HearingMonitor {
  if($script:DictationGrammar){$script:DictationGrammar.Enabled=$true}
  if($script:HearingMonitor -and !$script:HearingMonitor.IsDisposed){Position-HearingMonitor $script:HearingMonitor;$script:HearingMonitor.Show();$script:HearingMonitor.Activate();return}
  $form=New-Object Windows.Forms.Form -Property @{Text='What Emma hears';Size=New-Object Drawing.Size(560,250);StartPosition='Manual';TopMost=$true;FormBorderStyle='FixedDialog';MaximizeBox=$false}
  $title=New-Object Windows.Forms.Label -Property @{Left=20;Top=18;Width=500;Text="Live local recognition — say $($script:Config.WakeWord)";Font=New-Object Drawing.Font('Segoe UI',11,[Drawing.FontStyle]::Bold)}
  $status=New-Object Windows.Forms.Label -Property @{Left=20;Top=52;Width=500;Text=$(if($script:Listening){'Microphone active'}else{'Microphone paused'})}
  $level=New-Object Windows.Forms.ProgressBar -Property @{Left=20;Top=76;Width=500;Height=12;Minimum=0;Maximum=100;Value=0;Style='Continuous'}
  $heard=New-Object Windows.Forms.TextBox -Property @{Left=20;Top=100;Width=500;Height=55;Multiline=$true;ReadOnly=$true;Text=$(if($script:LastLocalHypothesis){$script:LastLocalHypothesis}else{"Waiting for $($script:Config.WakeWord)…"})}
  $privacy=New-Object Windows.Forms.Label -Property @{Left=20;Top=168;Width=500;Height=36;Text='This live pre-wake text stays on this PC. It is not uploaded or saved in conversation history.'}
  $form.Controls.AddRange(@($title,$status,$level,$heard,$privacy))
  $script:HearingMonitor=$form;$script:HearingMonitorStatus=$status;$script:HearingMonitorText=$heard;$script:HearingMonitorLevel=$level
  $form.Add_FormClosed({$script:HearingMonitor=$null;$script:HearingMonitorStatus=$null;$script:HearingMonitorText=$null;$script:HearingMonitorLevel=$null;if($script:DictationGrammar -and [datetime]::UtcNow -ge $script:ArmedUntil){$script:DictationGrammar.Enabled=$false}})
  Position-HearingMonitor $form
  $form.Show()
}

function Sync-RealtimePreview {
  if(!(Test-Path -LiteralPath $script:RealtimePreviewPath)){return}
  try{
    $preview=Get-Content -LiteralPath $script:RealtimePreviewPath -Raw | ConvertFrom-Json
    $prefix=if($preview.role -eq 'assistant'){'Emma'}else{'You'}
    if($preview.text){Update-HearingMonitor ("$prefix`: $($preview.text)") ([string]$preview.status)}
    elseif($preview.status){Update-HearingMonitor '' ([string]$preview.status)}
  }catch{}
}

function Spoken-Result($Response) {
  if (!$Response.ok) { if ($Response.message) { return $Response.message }; return "I could not complete that. $($Response.error)" }
  $message=''
  if ($Response.message) { $message=[string]$Response.message }
  $count = if ($null -ne $Response.data -and $null -ne $Response.data.Count) { [int]$Response.data.Count } else { -1 }
  $noun = { param($singular,$plural) if($count -eq 1){"$count $singular"}else{"$count $plural"} }
  if(!$message){$message=switch ([string]$Response.intent) {
    'list_clients' { "You have $(& $noun 'client' 'clients')." }
    'list_contacts' { "You have $(& $noun 'contact' 'contacts')." }
    'list_channel_messages' { "I found $(& $noun 'message' 'messages')." }
    'list_jobs' { "You have $(& $noun 'job' 'jobs')." }
    'list_leads' { "You have $(& $noun 'lead' 'leads')." }
    'list_tasks' { "You have $(& $noun 'task' 'tasks')." }
    'list_quotes' { "I found $(& $noun 'quote' 'quotes')." }
    'list_job_openings' { "I found $(& $noun 'job opening' 'job openings')." }
    'list_learning_rules' { "You have $(& $noun 'learning rule' 'learning rules')." }
    'list_communications' { "I found $(& $noun 'communication record' 'communication records')." }
    'list_portfolio_photos' { "I found $(& $noun 'photo' 'photos')." }
    'list_follow_ups' { "You have $(& $noun 'follow up' 'follow ups') due." }
    'list_unresolved_enquiries' { "You have $(& $noun 'unresolved enquiry' 'unresolved enquiries')." }
    'list_notifications' { "You have $(& $noun 'notification' 'notifications')." }
    'create_client' { "The client was created." }
    'create_lead' { "The lead was created." }
    'create_job' { "The job was created." }
    'create_task' { "The task was created." }
    'create_service' { "The service was created." }
    'assign_job' { "The job was assigned." }
    'change_job_status' { "The job status was updated." }
    'convert_lead' { "The lead was converted." }
    default { "$(([string]$Response.intent).Replace('_',' ')) completed successfully." }
  }}
  if($Response.uiAction -and $Response.uiAction.label -and $Response.intent -ne 'navigate'){$message="$message Opening $($Response.uiAction.label) in Secretary."}
  return $message
}

function Handle-LocalConversation([string]$Command) {
  $normal=$Command.Trim().ToLowerInvariant()
  if($normal -match '^(hello|hi|good morning|good afternoon)[.! ]*$'){$answer='Hello. How can I help?';Record-TranscriptExchange $Command $answer;Speak $answer;$script:ArmedUntil=[datetime]::UtcNow.AddSeconds([int]$script:Config.ConversationSeconds);return $true}
  if($normal -match '^(what can you do|help|commands)[?!. ]*$'){$answer='I can create and list clients, leads, jobs, tasks and services, assign jobs, change job status, list quotes, communications, follow ups, notifications and more.';Record-TranscriptExchange $Command $answer;Speak $answer;$script:ArmedUntil=[datetime]::UtcNow.AddSeconds([int]$script:Config.ConversationSeconds);return $true}
  if($normal -match '^(repeat|say that again)[?!. ]*$'){$answer=$(if($script:LastResponse){$script:LastResponse}else{'There is nothing to repeat yet.'});Record-TranscriptExchange $Command $answer;Speak $answer;$script:ArmedUntil=[datetime]::UtcNow.AddSeconds([int]$script:Config.ConversationSeconds);return $true}
  if($normal -match '^(thank you|thanks)[?!. ]*$'){$answer="You're welcome.";Record-TranscriptExchange $Command $answer;Speak $answer;$script:ArmedUntil=[datetime]::UtcNow.AddSeconds([int]$script:Config.ConversationSeconds);return $true}
  if($normal -match '^(stop|cancel|that is all|goodbye)[?!. ]*$'){$answer='Okay.';Record-TranscriptExchange $Command $answer;Speak $answer;$script:ArmedUntil=[datetime]::MinValue;End-TranscriptConversation 'completed';return $true}
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
      if($result.token){
        $wakeChanged = $result.user.voiceWakeWord -and [string]$script:Config.WakeWord -ne [string]$result.user.voiceWakeWord
        $languageChanged = $result.user.voiceLanguage -and [string]$script:Config.Language -ne [string]$result.user.voiceLanguage
        Save-Token $result.token
        if($result.user.voiceWakeWord){$script:Config.WakeWord=$result.user.voiceWakeWord}
        if($result.user.voiceLanguage -and $script:SupportedVoiceLanguages -contains [string]$result.user.voiceLanguage){$script:Config.Language=$result.user.voiceLanguage}
        $script:Config.Email=$result.user.email
        Save-Config $script:Config
        $script:RefreshRecognizerAfterLogin = [bool]($wakeChanged -or $languageChanged)
        $status.Text='Connected successfully.';$timer.Stop();$form.DialogResult='OK';$form.Close()
      }
    } catch { if($_.Exception.Message -match 'PAIRING_EXPIRED|PAIRING_ALREADY_USED'){$status.Text='The pairing expired. Close and try again.';$timer.Stop()} }
  })
  Start-Process $pairing.verification_url
  $timer.Start();$dialog=$form.ShowDialog();$timer.Stop();$timer.Dispose();$form.Dispose()
  return $dialog -eq 'OK'
}

function Ensure-Login {
  try { Invoke-Vcubf GET '/auth/me' | Out-Null; return $true }
  catch {
    $connected = Show-Login
    if ($connected) {
      Sync-VoicePreferences | Out-Null
      if ($script:RefreshRecognizerAfterLogin) {
        $script:RefreshRecognizerAfterLogin = $false
        Initialize-Recognizer
      }
      Sync-LocalVoiceConfig | Out-Null
    }
    return $connected
  }
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
  $form = New-Object Windows.Forms.Form -Property @{ Text='VCUBF Emma settings'; Size=New-Object Drawing.Size(470,500); StartPosition='CenterScreen'; TopMost=$true; FormBorderStyle='FixedDialog'; MaximizeBox=$false }
  $wake = New-Object Windows.Forms.TextBox -Property @{ Left=150; Top=30; Width=230; Text=$script:Config.WakeWord }
  $confidence = New-Object Windows.Forms.NumericUpDown -Property @{ Left=150; Top=70; Width=100; DecimalPlaces=2; Minimum=.30; Maximum=.95; Increment=.05; Value=[decimal]$script:Config.Confidence }
  $auto = New-Object Windows.Forms.CheckBox -Property @{ Left=150; Top=110; Width=230; Text='Start with Windows'; Checked=[bool]$script:Config.AutoStart }
  $hands = New-Object Windows.Forms.CheckBox -Property @{ Left=150; Top=140; Width=260; Text='Hands-free automatic execution'; Checked=[bool]$script:Config.HandsFree }
  $assistant = New-Object Windows.Forms.CheckBox -Property @{ Left=150; Top=170; Width=270; Text='Natural conversation with OpenAI'; Checked=[bool]$script:Config.Assistant }
  $realtime = New-Object Windows.Forms.CheckBox -Property @{ Left=150; Top=200; Width=270; Text='Realtime audio and interruption'; Checked=[bool]$script:Config.Realtime }
  $language = New-Object Windows.Forms.ComboBox -Property @{ Left=150; Top=235; Width=120; DropDownStyle='DropDownList' }
  $script:SupportedVoiceLanguages | ForEach-Object {[void]$language.Items.Add($_)}; $language.SelectedItem=$script:Config.Language
  $rate = New-Object Windows.Forms.NumericUpDown -Property @{ Left=150; Top=270; Width=100; Minimum=-5; Maximum=5; Value=[decimal]$script:Config.VoiceRate }
  $volume = New-Object Windows.Forms.NumericUpDown -Property @{ Left=150; Top=305; Width=100; Minimum=0; Maximum=100; Increment=5; Value=[decimal]$script:Config.VoiceVolume }
  $showMonitor = New-Object Windows.Forms.CheckBox -Property @{ Left=150; Top=335; Width=260; Text='Show live hearing on startup'; Checked=[bool]$script:Config.ShowMonitor }
  $server = New-Object Windows.Forms.TextBox -Property @{ Left=150; Top=370; Width=270; Text=$script:Config.ServerUrl }
  foreach ($pair in @(@('Wake word',30),@('Confidence',70),@('Startup',110),@('Mode',140),@('Assistant',170),@('Realtime',200),@('Language',235),@('Voice speed',270),@('Voice volume',305),@('Monitor',335),@('Server',370))) { $form.Controls.Add((New-Object Windows.Forms.Label -Property @{ Left=20; Top=$pair[1]; Width=120; Text=$pair[0] })) }
  $save = New-Object Windows.Forms.Button -Property @{ Left=300; Top=415; Width=120; Text='Save'; DialogResult='OK' }
  $form.Controls.AddRange(@($wake,$confidence,$auto,$hands,$assistant,$realtime,$language,$rate,$volume,$showMonitor,$server,$save)); $form.AcceptButton=$save
  if ($form.ShowDialog() -ne 'OK') { return }
  if ($wake.Text.Trim().Length -lt 2) { [Windows.Forms.MessageBox]::Show('Wake word must contain at least two characters.') | Out-Null; return }
  $script:Config.WakeWord=$wake.Text.Trim(); $script:Config.Confidence=[double]$confidence.Value; $script:Config.AutoStart=$auto.Checked; $script:Config.ShowMonitor=$showMonitor.Checked; $script:Config.HandsFree=$hands.Checked; $script:Config.Assistant=$assistant.Checked; $script:Config.Realtime=$realtime.Checked; $script:Config.Language=[string]$language.SelectedItem; $script:Config.VoiceRate=[int]$rate.Value; $script:Config.VoiceVolume=[int]$volume.Value; $script:Config.ServerUrl=$server.Text.TrimEnd('/'); Save-Config $script:Config; Set-AutoStart $script:Config.AutoStart
  try { Invoke-Vcubf PUT '/auth/voice-preferences' @{ wake_word=$script:Config.WakeWord; continuous_listening=$true; language=$script:Config.Language } | Out-Null } catch { Write-EmmaLog "Could not sync voice preferences: $($_.Exception.Message)" }
  Initialize-Recognizer; Select-SynthesisVoice
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
  $command=$text.Text.Trim()
  try {
    if (!(Ensure-Login)) { return }
    Start-TranscriptConversation 'reviewed_text'
    Add-TranscriptMessage 'user' $command
    $response = Invoke-Vcubf POST '/command/text' @{ text=$command; input_method='voice_transcript' }
    Sync-VoicePreferences | Out-Null
    $message = Spoken-Result $response
    Add-TranscriptMessage 'assistant' $message
    $script:Notify.ShowBalloonTip(4000,'VCUBF Emma',$message, $(if($response.ok){'Info'}else{'Warning'}))
    Speak $message
    End-TranscriptConversation 'completed'
  } catch {
    $failure='The command could not be sent.'
    Add-TranscriptMessage 'assistant' $failure
    End-TranscriptConversation 'error'
    Write-EmmaLog "Command failed: $($_.Exception.Message)"
    $script:Notify.ShowBalloonTip(4000,'VCUBF Emma',$failure,'Error'); Speak $failure
  }
}

function Resolve-RealtimePython {
  # Prefer a real Python runtime over the Windows Store shim.  The shim can
  # start successfully but cannot import the microphone/WebSocket packages,
  # which previously left a wake-word session with no useful error.
  foreach($candidate in @('python.exe','py.exe')) {
    foreach($command in @(Get-Command $candidate -CommandType Application -ErrorAction SilentlyContinue)) {
      $path = [string]$command.Source
      if(!$path -or $path -match '\\WindowsApps\\') { continue }
      $prefix = @()
      if([IO.Path]::GetFileName($path) -match '^py\.exe$') { $prefix = @('-3') }
      try {
        $version = @(& $path @prefix --version 2>&1) -join ' '
        $dependencyCheck = @(& $path @prefix -c 'import aec_audio_processing, pyaudio, websockets' 2>&1) -join ' '
        if($LASTEXITCODE -eq 0 -and $version -match 'Python\s+3\.' -and !$dependencyCheck) {
          return [pscustomobject]@{ Path=$path; Prefix=$prefix; Version=$version.Trim() }
        }
        Write-EmmaLog "Python candidate rejected: $path. $dependencyCheck"
      } catch {}
    }
  }
  return $null
}

function Invoke-RealtimeProcess([string]$RealtimeScript,[string]$Command) {
  $python = Resolve-RealtimePython
  if(!$python) {
    Write-EmmaLog 'Realtime cannot start: no usable Python 3 runtime was found.'
    return 127
  }
  Remove-Item -LiteralPath $script:RealtimePreviewPath -Force -ErrorAction SilentlyContinue
  Update-HearingMonitor $script:Config.WakeWord 'Realtime active — speak now'
  $startInfo=New-Object Diagnostics.ProcessStartInfo
  $startInfo.FileName=$python.Path
  $arguments=@($python.Prefix)
  $arguments += '"' + $RealtimeScript + '"'
  if($Command){$arguments += '--stdin'}
  $startInfo.Arguments=($arguments -join ' ')
  $startInfo.UseShellExecute=$false
  $startInfo.CreateNoWindow=$true
  $startInfo.RedirectStandardInput=[bool]$Command
  $startInfo.RedirectStandardError=$true
  $process=New-Object Diagnostics.Process
  $process.StartInfo=$startInfo
  if(!$process.Start()){throw 'REALTIME_START_FAILED'}
  Write-EmmaLog "Realtime started with $($python.Version): $($python.Path)"
  if($Command){$process.StandardInput.WriteLine($Command);$process.StandardInput.Close()}
  while(!$process.WaitForExit(100)){
    [Windows.Forms.Application]::DoEvents()
    Sync-RealtimePreview
  }
  Sync-RealtimePreview
  $exitCode=$process.ExitCode
  $stderr=$process.StandardError.ReadToEnd().Trim()
  if($stderr){Write-EmmaLog "Realtime stderr: $($stderr.Substring(0,[math]::Min(1500,$stderr.Length)))"}
  Write-EmmaLog "Realtime exited with code $exitCode."
  Remove-Item -LiteralPath $script:RealtimePreviewPath -Force -ErrorAction SilentlyContinue
  return $exitCode
}

function Execute-VoiceCommand([string]$Command) {
  if($Command -and (Handle-LocalConversation $Command)){return}
  try {
    if (!(Ensure-Login)) { return }
    $realtimeFailure=$false
    $realtimeScript=Join-Path (Split-Path -Parent $PSCommandPath) 'emma_realtime.py'
    if([bool]$script:Config.Realtime -and (Test-Path -LiteralPath $realtimeScript)){
      End-TranscriptConversation 'interrupted'
      $realtimeExitCode=Invoke-RealtimeProcess $realtimeScript $Command
      Sync-VoicePreferences | Out-Null
      if($realtimeExitCode -eq 10){$script:RemotePaused=$true;Update-VoiceState 'paused' $false 'wake_word' '' '' 'pause'|Out-Null;return}
      if($realtimeExitCode -eq 0){$script:ArmedUntil=[datetime]::MinValue;return}
      Write-EmmaLog 'Realtime session failed; falling back to text assistant.'
      $realtimeFailure=$true
    }
    if([string]::IsNullOrWhiteSpace($Command)){
      # Realtime is the preferred Siri-style conversation.  If it cannot be
      # opened, retain a safe hands-free path: arm the local recognizer for a
      # short second phrase and transcribe only that activated request.
      $script:ArmedUntil=[datetime]::UtcNow.AddSeconds(10)
      Update-HearingMonitor '' 'Live conversation unavailable — say your request now'
      Update-VoiceState 'listening' $true 'wake_word'|Out-Null
      $prompt=if($realtimeFailure){'Live conversation is unavailable. Please say your request now.'}else{'I am ready. Please say your request.'}
      if($script:Notify){$script:Notify.ShowBalloonTip(4500,'VCUBF Emma',$prompt,'Warning')}
      Speak $prompt
      return
    }
    $path=if([bool]$script:Config.Assistant){'/command/assistant'}else{'/command/text'}
    Start-TranscriptConversation 'reviewed_text'
    Add-TranscriptMessage 'user' $Command.Trim()
    $body=@{text=$Command.Trim();input_method='voice_transcript'}
    if([bool]$script:Config.Assistant){$body.language=$script:Config.Language;$body.history=@($script:ConversationHistory | Select-Object -Last 6)}
    $response=Invoke-Vcubf POST $path $body
    Sync-VoicePreferences | Out-Null
    $message=if($response.kind -in @('reply','clarification','plan','error')){[string]$response.message}else{Spoken-Result $response}
    $script:ConversationHistory += [pscustomobject]@{role='user';content=$Command.Trim()}
    $script:ConversationHistory += [pscustomobject]@{role='assistant';content=$message}
    $script:ConversationHistory = @($script:ConversationHistory | Select-Object -Last 6)
    $script:LastResponse=$message
    Add-TranscriptMessage 'assistant' $message
    Update-VoiceState $(if($response.kind -eq 'error'){'error'}else{'listening'}) $true 'reviewed_text' $Command.Trim() $message|Out-Null
    $script:Notify.ShowBalloonTip(4000,'VCUBF Emma',$message,$(if($response.ok){'Info'}else{'Warning'}));Speak $message
    $script:ArmedUntil=[datetime]::UtcNow.AddSeconds([int]$script:Config.ConversationSeconds)
  } catch {Write-EmmaLog "Command failed: $($_.Exception.Message)";$message='The command could not be sent.';$script:LastResponse=$message;Add-TranscriptMessage 'assistant' $message;End-TranscriptConversation 'error';$script:Notify.ShowBalloonTip(4000,'VCUBF Emma',$message,'Error');Speak $message}
}

function Start-HandsFreeRealtime {
  if($script:Busy){return}
  $script:ArmedUntil=[datetime]::MinValue;$script:Busy=$true
  try{
    try{$script:Recognizer.RecognizeAsyncCancel()}catch{}
    $script:Listening=$false
    Update-VoiceState 'hearing' $true 'wake_word' $script:Config.WakeWord|Out-Null
    Speak 'Yes?'
    Execute-VoiceCommand ''
  } finally {$script:Busy=$false;Start-Listening}
}

function Find-WakeCommand([string]$Text) {
  $wake = [regex]::Escape($script:Config.WakeWord)
  $match = [regex]::Match($Text, "(?i)(?:^|\W)$wake(?:\W|$)(?<command>.*)$")
  if (!$match.Success) { return $null }
  return $match.Groups['command'].Value.Trim(' ',',','.',':',';','!','-')
}

function Handle-Recognition([string]$Text,[double]$Confidence,[byte[]]$AudioWav) {
  if ($script:Busy -or !$script:Listening) { return }
  $text = $Text.Trim(); if (!$text) { return }
  $confidence=$Confidence
  Update-HearingMonitor $text ("Recognized locally ({0:P0} confidence)" -f $confidence)
  $command = Find-WakeCommand $text
  $minimumConfidence=if($null -ne $command){[math]::Min([double]$script:Config.Confidence,0.35)}else{[double]$script:Config.Confidence}
  if($confidence -lt $minimumConfidence){return}
  if ($null -ne $command) {
    if (!$command -and [bool]$script:Config.HandsFree -and [bool]$script:Config.Realtime) {
      Write-EmmaLog ("Wake word accepted ({0:N2}); starting Realtime listening." -f $confidence)
      Start-HandsFreeRealtime
      return
    }
    if (!$command) { $script:ArmedUntil=[datetime]::UtcNow.AddSeconds(8); Speak 'Yes?'; return }
  } elseif ([datetime]::UtcNow -lt $script:ArmedUntil) { $command=$text } else { return }
  if($AudioWav -and $AudioWav.Length -ge 44){
    try {
      $transcription=Invoke-VcubfAudio $AudioWav
      $accurateText=([string]$transcription.text).Trim()
      if(!$accurateText){throw 'EMPTY_TRANSCRIPTION'}
      $accurateCommand=Find-WakeCommand $accurateText
      if($null -eq $accurateCommand){$accurateCommand=$accurateText.Trim(' ',',','.',':',';','!','-')}
      if(!$accurateCommand){throw 'EMPTY_COMMAND'}
      $command=$accurateCommand
      Update-HearingMonitor $accurateText 'Accurate online transcription'
    } catch {
      Write-EmmaLog "Accurate command transcription failed: $($_.Exception.Message)"
      Update-HearingMonitor $text 'Online transcription failed — please repeat the command'
      $script:ArmedUntil=[datetime]::UtcNow.AddSeconds(8)
      Speak 'I did not catch that accurately. Please say the command again.'
      return
    }
  }
  Write-EmmaLog ("Accepted ({0:N2}): {1}" -f $confidence,$command)
  Update-VoiceState 'hearing' $true 'wake_word' $command|Out-Null
  $script:ArmedUntil=[datetime]::MinValue; $script:Busy=$true
  try { $script:Recognizer.RecognizeAsyncCancel(); $script:Listening=$false; if([bool]$script:Config.HandsFree){Execute-VoiceCommand $command}else{Show-Review $command} } finally { $script:Busy=$false; Start-Listening }
}

function Drain-SpeechEvents {
  if(!$script:SpeechBridge){return}
  while($true){
    $item=$script:SpeechBridge.Next()
    if(!$item){break}
    switch($item.Kind){
      'recognized' {Handle-Recognition ([string]$item.Text) ([double]$item.Confidence) ([byte[]]$item.AudioWav)}
      'hypothesized' {if($item.Text){Update-HearingMonitor ([string]$item.Text) ("Hearing locally ({0:P0})" -f $item.Confidence)}}
      'rejected' {Update-HearingMonitor ([string]$item.Text) 'Speech detected but not understood'}
      'audio' {Update-HearingLevel ([int]$item.AudioLevel)}
    }
  }
}

function Initialize-Recognizer {
  $wasListening=$script:Listening
  if($script:SpeechBridge){$script:SpeechBridge.Detach()}
  if ($script:Recognizer) { try { $script:Recognizer.RecognizeAsyncCancel(); $script:Recognizer.Dispose() } catch {} }
  $recognizers=[System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
  $info=$recognizers | Where-Object { $_.Culture.Name -eq $script:Config.Language } | Select-Object -First 1
  if (!$info) {
    $fallback=$recognizers | Where-Object { $_.Culture.Name -like 'en-*' } | Select-Object -First 1
    if (!$fallback) { $fallback=$recognizers | Select-Object -First 1 }
    if (!$fallback) { throw 'No Windows speech recognizer is installed.' }
    $info=$fallback
    Write-EmmaLog "No local recognizer for $($script:Config.Language); using $($info.Culture.Name) for the wake word while Realtime uses the selected language."
    if($script:Notify){$script:Notify.ShowBalloonTip(4500,'VCUBF Emma',"Install the $($script:Config.Language) Windows speech pack for local recognition. Emma will use $($info.Culture.Name) for the wake word until then.",'Info')}
  }
  $script:Recognizer=New-Object System.Speech.Recognition.SpeechRecognitionEngine($info)
  $script:DictationGrammar=New-Object System.Speech.Recognition.DictationGrammar;$script:DictationGrammar.Name='VCUBF Dictation';$script:DictationGrammar.Enabled=$false;$script:Recognizer.LoadGrammar($script:DictationGrammar)
  $wakeOnlyBuilder=[System.Speech.Recognition.GrammarBuilder]::new();$wakeOnlyBuilder.Culture=$info.Culture;$wakeOnlyBuilder.Append([string]$script:Config.WakeWord)
  $wakeOnly=[System.Speech.Recognition.Grammar]::new($wakeOnlyBuilder);$wakeOnly.Name='VCUBF Wake Only';$wakeOnly.Priority=127;$wakeOnly.Weight=1.0;$script:Recognizer.LoadGrammar($wakeOnly)
  $wakeCommandBuilder=[System.Speech.Recognition.GrammarBuilder]::new();$wakeCommandBuilder.Culture=$info.Culture;$wakeCommandBuilder.Append([string]$script:Config.WakeWord);$wakeCommandBuilder.AppendDictation()
  $wakeCommand=[System.Speech.Recognition.Grammar]::new($wakeCommandBuilder);$wakeCommand.Name='VCUBF Wake Command';$wakeCommand.Priority=126;$wakeCommand.Weight=1.0;$script:Recognizer.LoadGrammar($wakeCommand)
  $script:Recognizer.SetInputToDefaultAudioDevice()
  $script:SpeechBridge=New-Object VcubfSpeechBridge
  $script:SpeechBridge.Attach($script:Recognizer)
  Select-SynthesisVoice
  if ($wasListening) { Start-Listening }
}

function Start-Listening {
  if ($script:Listening -or $script:Busy -or $script:RemotePaused) { return }
  if (!(Load-Token)) {
    $script:Listening=$false
    if($script:Notify){$script:Notify.Text='VCUBF Emma — sign in required'}
    return
  }
  try {
    if($script:DictationGrammar){$script:DictationGrammar.Enabled=(($script:HearingMonitor -and !$script:HearingMonitor.IsDisposed) -or [datetime]::UtcNow -lt $script:ArmedUntil)}
    $script:Recognizer.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
    $script:Listening=$true
    if(!$script:InitialListeningLogged){
      $elapsed=[int](([datetime]::UtcNow-$script:LaunchStartedAt).TotalMilliseconds)
      Write-EmmaLog "Local microphone listening started after $elapsed ms."
      $script:InitialListeningLogged=$true
    }
    if($script:Notify){$script:Notify.Text="VCUBF Emma — listening for $($script:Config.WakeWord)"}
    Update-VoiceState 'listening' $true 'wake_word'|Out-Null
  }
  catch { Write-EmmaLog "Microphone start failed: $($_.Exception.Message)"; Update-VoiceState 'error' $false 'wake_word'|Out-Null; if($script:Notify){$script:Notify.ShowBalloonTip(4000,'VCUBF Emma','Microphone listening could not start.','Error')} }
}

function Stop-Listening {
  $script:RemotePaused=$true;End-TranscriptConversation 'interrupted';try { $script:Recognizer.RecognizeAsyncCancel() } catch {}; $script:Listening=$false; if($script:Notify){$script:Notify.Text='VCUBF Emma — paused'};Update-VoiceState 'paused' $false 'wake_word'|Out-Null
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
  $realtimePython=Resolve-RealtimePython
  [pscustomobject]@{ Status=$(if($wakeTests -and (Test-Path -LiteralPath $realtimeScript) -and $realtimePython){'ok'}else{'failed'}); WakeWord=$script:Config.WakeWord; Server=$script:Config.ServerUrl; HandsFree=[bool]$script:Config.HandsFree; Assistant=[bool]$script:Config.Assistant; Realtime=[bool]$script:Config.Realtime; RealtimeRuntime=(Test-Path -LiteralPath $realtimeScript); RealtimePython=$(if($realtimePython){$realtimePython.Path}else{$null}); RealtimePythonVersion=$(if($realtimePython){$realtimePython.Version}else{$null}); ConversationSeconds=[int]$script:Config.ConversationSeconds; Recognizers=$recognizers; WakeParser=$wakeTests; TokenProtected=(Test-Path $script:TokenPath) } | ConvertTo-Json -Depth 4
  if(!$wakeTests -or !$realtimePython){exit 1}
  exit 0
}

[Windows.Forms.Application]::EnableVisualStyles()
$createdNew=$false
$mutex=[Threading.Mutex]::new($true,'Local\VCUBFEmmaCompanion',[ref]$createdNew)
if(!$createdNew){[Windows.Forms.MessageBox]::Show('VCUBF Emma is already running.','VCUBF Emma')|Out-Null;exit 0}

try {
  Write-EmmaLog 'Startup: initializing speech recognizer.'
  Initialize-Recognizer
  Write-EmmaLog 'Startup: speech recognizer initialized.'
  $script:Notify=New-Object Windows.Forms.NotifyIcon -Property @{ Icon=[Drawing.SystemIcons]::Information; Visible=$true; Text='VCUBF Emma — starting' }
  $menu=New-Object Windows.Forms.ContextMenuStrip
  $talk=$menu.Items.Add('Talk to Emma now'); $monitor=$menu.Items.Add('Show live hearing'); $start=$menu.Items.Add('Start listening'); $stop=$menu.Items.Add('Stop listening'); $settings=$menu.Items.Add('Settings'); $open=$menu.Items.Add('Open VCUBF'); $signin=$menu.Items.Add('Connect in browser'); $menu.Items.Add((New-Object Windows.Forms.ToolStripSeparator))|Out-Null; $exit=$menu.Items.Add('Exit')
  $talk.Add_Click({if([bool]$script:Config.HandsFree -and [bool]$script:Config.Realtime){Start-HandsFreeRealtime}else{$script:ArmedUntil=[datetime]::UtcNow.AddSeconds(8);Speak 'Yes?'}})
  $monitor.Add_Click({Show-HearingMonitor});$start.Add_Click({$script:RemotePaused=$false;Start-Listening}); $stop.Add_Click({Stop-Listening}); $settings.Add_Click({Show-Settings}); $open.Add_Click({Start-Process 'https://frontend-production-ee13.up.railway.app'}); $signin.Add_Click({Remove-Item -LiteralPath $script:TokenPath -Force -ErrorAction SilentlyContinue; Show-Login|Out-Null}); $exit.Add_Click({$script:Context.ExitThread()})
  $script:Notify.ContextMenuStrip=$menu; $script:Notify.Add_DoubleClick({Start-Process 'https://frontend-production-ee13.up.railway.app'})
  $script:StateTimer=New-Object Windows.Forms.Timer -Property @{Interval=3000}
  $script:StateTimer.Add_Tick({
    # A first-run desktop launch remains open while the browser completes the
    # device pairing.  Do not advertise a microphone as active until a real
    # token exists; once it does, refresh the paired language/wake word and
    # begin listening without requiring another click.
    if(!(Load-Token)){
      if($script:Listening){try{$script:Recognizer.RecognizeAsyncCancel()}catch{};$script:Listening=$false}
      if($script:Notify){$script:Notify.Text='VCUBF Emma — sign in required'}
      return
    }
    Sync-LocalVoiceConfig | Out-Null
    $script:PreferenceSyncTicks++
    if($script:PreferenceSyncTicks -ge 10){$script:PreferenceSyncTicks=0;Sync-VoicePreferences | Out-Null}
    $wasListening=$script:Listening
    Start-Listening
    if(!$wasListening -and $script:Listening -and $Announce){Speak 'Emma is active and listening.'}
    $state=Update-VoiceState $(if($script:RemotePaused){'paused'}elseif($script:Listening){'listening'}else{'thinking'}) (!$script:RemotePaused -and $script:Listening) 'wake_word'
    Apply-RemoteControl $state
    if($script:TranscriptConversationId -and !$script:Busy -and $script:ArmedUntil -ne [datetime]::MinValue -and [datetime]::UtcNow -ge $script:ArmedUntil){End-TranscriptConversation 'completed'}
  })
  $script:StateTimer.Start()
  $script:RecognitionTimer=New-Object Windows.Forms.Timer -Property @{Interval=100}
  $script:RecognitionTimer.Add_Tick({Drain-SpeechEvents})
  $script:RecognitionTimer.Start()
  Set-AutoStart ([bool]$script:Config.AutoStart)
  Write-EmmaLog 'Startup: loading saved connection.'
  if (!(Load-Token) -and !$DesktopLaunch) { Show-Login | Out-Null }
  Write-EmmaLog 'Startup: starting microphone.'
  Start-Listening
  Write-EmmaLog 'Startup: microphone initialization finished.'
  if($ShowMonitor -or [bool]$script:Config.ShowMonitor){Show-HearingMonitor;Write-EmmaLog 'Startup: live hearing monitor shown.'}
  if($script:Listening){$script:Notify.ShowBalloonTip(3000,'VCUBF Emma',"Listening locally for $($script:Config.WakeWord).",'Info')}
  else{$script:Notify.ShowBalloonTip(4500,'VCUBF Emma','Sign in in the browser to activate hands-free listening.','Info')}
  if($Announce -and $script:Listening){Speak 'Emma is active and listening.'}
  $script:Context=New-Object Windows.Forms.ApplicationContext
  [Windows.Forms.Application]::Run($script:Context)
} catch { Write-EmmaLog "Fatal: $($_.Exception)"; [Windows.Forms.MessageBox]::Show($_.Exception.Message,'VCUBF Emma','OK','Error')|Out-Null }
finally { if($script:StateTimer){$script:StateTimer.Stop();$script:StateTimer.Dispose()};if($script:RecognitionTimer){$script:RecognitionTimer.Stop();$script:RecognitionTimer.Dispose()};End-TranscriptConversation 'interrupted';Stop-Listening;Update-VoiceState 'offline' $false 'wake_word'|Out-Null;if($script:SpeechBridge){$script:SpeechBridge.Detach()};if($script:HearingMonitor -and !$script:HearingMonitor.IsDisposed){$script:HearingMonitor.Dispose()};if($script:Notify){$script:Notify.Visible=$false;$script:Notify.Dispose()}; if($script:Recognizer){$script:Recognizer.Dispose()};$script:Synth.Dispose();$mutex.ReleaseMutex();$mutex.Dispose() }

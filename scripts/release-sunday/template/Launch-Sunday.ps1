# Windows PowerShell 5.1 STA supervisor. No console or Enter lifetime dependency.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
try { . (Join-Path $PSScriptRoot 'OneClick-Core.ps1') }
catch { [void][Windows.Forms.MessageBox]::Show('Falta el componente de inicio. Extraiga TODO el ZIP antes de abrir TKD.','TKD Fight','OK','Error'); exit 1 }
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtime = Join-Path $root 'portable-runtime'
$configFile = Join-Path $runtime 'installation.json'
$requestFile = Join-Path $runtime 'open.request'
$node = Join-Path $root 'bin\node.exe'
$server = Join-Path $root 'dist-server\index.mjs'
$script:config=$null; $script:process=$null; $script:attempts=@(); $script:ready=$false
$script:stopping=$false; $script:blocked=$false; $script:nextOpen=$true; $script:allowExit=$false
$script:deadline=[datetime]::MaxValue
$hash = [Security.Cryptography.SHA256]::Create()
try { $key=([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($root.ToLowerInvariant())))).Replace('-','') } finally { $hash.Dispose() }
$mutex=New-Object Threading.Mutex($false,('Local\TKDOneClick-'+$key))
$owns=$false
try { $owns=$mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $owns=$true }
if (-not $owns) {
    try { [IO.File]::WriteAllText($requestFile,[guid]::NewGuid().ToString()) } catch { }
    $mutex.Dispose(); exit 0
}
function Write-Diagnostic([string]$Message) {
    # Do not log config/headers/secret or raw HTTP errors.
    [IO.File]::AppendAllText((Join-Path $runtime 'launcher.log'),([datetime]::UtcNow.ToString('o')+' '+$Message+[Environment]::NewLine))
}
function Show-Status([string]$Message,[bool]$Failed=$false) {
    $script:label.Text=$Message
    $script:label.ForeColor=if ($Failed) { [Drawing.Color]::DarkRed } else { [Drawing.Color]::Black }
    $script:tray.Text=if ($Failed) { 'TKD Fight - necesita atencion' } elseif ($script:ready) { 'TKD Fight - listo' } else { 'TKD Fight - iniciando' }
    if ($Failed) { $script:form.Show(); $script:form.Activate() }
}
function Get-Listeners([int]$Port) {
    return @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object { $_.Port -eq $Port })
}
function Read-Identity {
    try { return Invoke-RestMethod -Uri ("http://127.0.0.1:$($script:config.port)/api/local/identity") -Headers @{Authorization='Bearer '+$script:config.secret} -TimeoutSec 1 } catch { return $null }
}
function Confirm-Process($Identity) {
    if (-not $Identity -or -not (Test-OneClickIdentity $Identity $script:config $script:build.buildId $Identity.pid)) { return $false }
    $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$Identity.pid) -ErrorAction SilentlyContinue
    if (-not $p -or $p.ExecutablePath -ine $node -or $p.CommandLine -notlike ('*"'+$server+'"*')) { return $false }
    $script:process=Get-Process -Id $Identity.pid -ErrorAction SilentlyContinue
    return ($null -ne $script:process)
}
function Open-Browser {
    if (-not $script:ready) { $script:nextOpen=$true; $script:form.Show(); return }
    if (-not (Confirm-Process (Read-Identity))) { throw 'No se pudo verificar la instancia. No se abrira otro servidor.' }
    $candidates=@()
    foreach ($base in @($env:ProgramFiles,${env:ProgramFiles(x86)},$env:LocalAppData)) {
        if ($base) { $candidates+=(Join-Path $base 'Google\Chrome\Application\chrome.exe'); $candidates+=(Join-Path $base 'Microsoft\Edge\Application\msedge.exe') }
    }
    $browser=$candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (-not $browser) { throw 'No se encontro Chrome o Edge. Instale uno antes del torneo; no se cambiara el perfil.' }
    $url="http://localhost:$($script:config.port)"+$(if ($script:config.role -eq 'MC') { '/central' } else { '' })
    Start-Process -FilePath $browser -ArgumentList @(('--user-data-dir="'+(Join-Path $script:dataDir 'browser-profile')+'"'),('--app="'+$url+'"'),'--no-first-run') | Out-Null
    $script:nextOpen=$false; $script:form.Hide()
}
function Start-ServiceProcess {
    $script:ready=$false
    if (@(Get-Listeners $script:config.port).Count -gt 0) {
        if (Confirm-Process (Read-Identity)) { $script:ready=$true; return }
        throw "Puerto guardado $($script:config.port) ocupado por otra aplicacion. No se cerrara ningun proceso ni se cambiara el puerto. Cierre esa aplicacion y pulse Reintentar."
    }
    if ($script:process -and -not $script:process.HasExited) { throw 'El proceso sigue vivo pero no responde. No se duplicara ni se forzara su cierre. Revise los registros.' }
    $env:PORT=[string]$script:config.port; $env:DATA_DIR=$script:dataDir; $env:NODE_ENV='production'
    $env:TKD_ROLE=switch ($script:config.role) { 'T1' {'cuadrilatero1'} 'T2' {'cuadrilatero2'} 'T3' {'cuadrilatero3'} 'MC' {'mesacentral'} }
    $env:TKD_PORTABLE_INSTALLATION_ID=$script:config.installationId
    $env:TKD_PORTABLE_SUPERVISOR_SECRET=$script:config.secret
    $env:TKD_PORTABLE_BUILD_ID=$script:build.buildId
    $env:ALLOWED_ORIGINS="http://localhost:$($script:config.port),http://127.0.0.1:$($script:config.port)"
    $logs=Join-Path $script:dataDir 'logs'; New-Item -ItemType Directory -Path $logs -Force | Out-Null
    $stamp=[datetime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff')
    $script:process=Start-Process -FilePath $node -ArgumentList ('"'+$server+'"') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs "$stamp-stdout.log") -RedirectStandardError (Join-Path $logs "$stamp-stderr.log") -PassThru
    $script:deadline=[datetime]::UtcNow.AddSeconds(40)
    Write-Diagnostic "Started process $($script:process.Id), role $($script:config.role), port $($script:config.port), build $($script:build.buildId)"
    Show-Status 'Iniciando... Se abrira el sistema cuando este listo.'
}
function Retry-Startup {
    $script:blocked=$false
    try { Start-ServiceProcess } catch { $script:blocked=$true; Write-Diagnostic $_.Exception.Message; Show-Status $_.Exception.Message $true }
}
try {
    New-Item -ItemType Directory -Path $runtime -Force | Out-Null
    $acl=Get-Acl -LiteralPath $runtime; $acl.SetAccessRuleProtection($true,$false)
    $user=[Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($user,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
    $systemSid=New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($systemSid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
    Set-Acl -LiteralPath $runtime -AclObject $acl
    foreach ($file in @($node,$server,(Join-Path $root 'build-id.json'),(Join-Path $PSScriptRoot 'check-runtime.cjs'))) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Falta $file. Extraiga TODO el ZIP en una carpeta propia." }
    }
    $script:build=Get-Content -LiteralPath (Join-Path $root 'build-id.json') -Raw | ConvertFrom-Json
    if (-not $script:build.buildId -or $script:build.backupSchemaVersion -ne 1) { throw 'Identificacion de compilacion invalida.' }
    $script:form=New-Object Windows.Forms.Form; $script:form.Text='TKD Fight - Estado'; $script:form.Size=New-Object Drawing.Size(560,240); $script:form.StartPosition='CenterScreen'
    $script:label=New-Object Windows.Forms.Label; $script:label.Location=New-Object Drawing.Point(20,20); $script:label.Size=New-Object Drawing.Size(505,110); $script:label.Text='Iniciando...'; $script:form.Controls.Add($script:label)
    $retry=New-Object Windows.Forms.Button; $retry.Text='Reintentar'; $retry.Location=New-Object Drawing.Point(20,150); $retry.Width=110; $retry.Add_Click({Retry-Startup}); $script:form.Controls.Add($retry)
    $open=New-Object Windows.Forms.Button; $open.Text='Abrir sistema'; $open.Location=New-Object Drawing.Point(145,150); $open.Width=120; $open.Add_Click({try { Open-Browser } catch { Show-Status $_.Exception.Message $true }}); $script:form.Controls.Add($open)
    $script:tray=New-Object Windows.Forms.NotifyIcon; $script:tray.Icon=[Drawing.SystemIcons]::Application; $script:tray.Text='TKD Fight - iniciando'; $script:tray.Visible=$true
    $menu=New-Object Windows.Forms.ContextMenuStrip
    [void]$menu.Items.Add('Abrir sistema',$null,{try { Open-Browser } catch { Show-Status $_.Exception.Message $true }})
    [void]$menu.Items.Add('Ver estado',$null,{$script:form.Show();$script:form.Activate()})
    [void]$menu.Items.Add('Cerrar sistema',$null,{
        $shutdownRequested=$false
        try {
            if (-not (Confirm-Process (Read-Identity))) {
                if ($script:process -and -not $script:process.HasExited) { throw 'No se pudo verificar el proceso.' }
                $script:allowExit=$true; $script:form.Close(); return
            }
            $shutdownRequested=$true
            $answer=Invoke-RestMethod -Method Post -Uri ("http://127.0.0.1:$($script:config.port)/api/local/shutdown") -Headers @{Authorization='Bearer '+$script:config.secret} -TimeoutSec 5
            if ($answer.ok -ne $true -or $answer.state -ne 'shutting-down') { throw 'Cierre no aceptado.' }
            $script:stopping=$true; $script:ready=$false; $script:deadline=[datetime]::UtcNow.AddSeconds(20); Show-Status 'Cerrando de forma segura...'
        } catch {
            $statusCode=0
            if ($_.Exception.Response) { $statusCode=[int]$_.Exception.Response.StatusCode }
            if ($shutdownRequested -and $statusCode -ne 409) {
                # A lost shutdown response must not cause automatic restart of an accepted close.
                $script:blocked=$true; $script:ready=$false
                Show-Status 'No se pudo comprobar la respuesta del cierre. Recuperacion automatica pausada. Verifique Estado y pulse Reintentar para volver a abrir; no se forzo el cierre.' $true
            } else { Show-Status 'No se puede cerrar: hay pelea, resultado u operacion pendiente, o no se pudo verificar el servidor. Termine la operacion y reintente. No se forzo el cierre.' $true }
        }
    })
    $script:tray.ContextMenuStrip=$menu; $script:tray.Add_DoubleClick({try { Open-Browser } catch { Show-Status $_.Exception.Message $true }})
    $script:form.Add_FormClosing({param($sender,$eventArgs) if (-not $script:allowExit) { $eventArgs.Cancel=$true; $script:form.Hide() }})
    $script:form.Show(); [Windows.Forms.Application]::DoEvents()
    if (Test-Path -LiteralPath $configFile -PathType Leaf) { $script:config=Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json; [void](Test-OneClickConfig $script:config) }
    else {
        foreach ($folder in @('data-t1','data-t2','data-t3','data-central')) {
            if ((Test-Path -LiteralPath (Join-Path $root $folder)) -and @(Get-ChildItem -LiteralPath (Join-Path $root $folder) -Force).Count -gt 0) { throw 'Hay datos previos sin configuracion de inicio. Use una extraccion nueva o recupere la configuracion; no se creara otro origen.' }
        }
        $choose=New-Object Windows.Forms.Form; $choose.Text='Elija el tatami de esta PC (solo una vez)'; $choose.Size=New-Object Drawing.Size(420,150); $choose.StartPosition='CenterScreen'
        $roles=New-Object Windows.Forms.ComboBox; $roles.DropDownStyle='DropDownList'; $roles.Location=New-Object Drawing.Point(20,20); $roles.Width=350
        [void]$roles.Items.AddRange(@('T1 - Tatami 1','T2 - Tatami 2','T3 - Tatami 3','MC - Mesa Central')); $roles.SelectedIndex=0; $choose.Controls.Add($roles)
        $accept=New-Object Windows.Forms.Button; $accept.Text='Iniciar'; $accept.Location=New-Object Drawing.Point(260,60); $accept.DialogResult='OK'; $choose.Controls.Add($accept); $choose.AcceptButton=$accept
        if ($choose.ShowDialog() -ne 'OK') { $script:allowExit=$true; return }
        $role=@('T1','T2','T3','MC')[$roles.SelectedIndex]
        $bytes=New-Object byte[] 32; $rng=[Security.Cryptography.RandomNumberGenerator]::Create(); try {$rng.GetBytes($bytes)} finally {$rng.Dispose()}
        $script:config=[pscustomobject]@{version=1;installationId=[guid]::NewGuid().ToString();role=$role;port=(Select-OneClickPort -Occupied @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | ForEach-Object {$_.Port}));secret=([BitConverter]::ToString($bytes)).Replace('-','').ToLowerInvariant()}
        Write-OneClickJson $configFile $script:config
    }
    $subdir=if ($script:config.role -eq 'MC') {'data-central'} else {'data-'+$script:config.role.ToLowerInvariant()}
    $script:dataDir=Join-Path $root $subdir; New-Item -ItemType Directory -Path $script:dataDir -Force | Out-Null
    $ringFile=Join-Path $script:dataDir 'ring.json'
    if (Test-Path -LiteralPath $ringFile -PathType Leaf) { $ring=Get-Content -LiteralPath $ringFile -Raw | ConvertFrom-Json; if ($ring.alias -ne $script:config.role) {throw 'La identidad del tatami no coincide con los datos.'} }
    else { Write-OneClickJson $ringFile @{alias=$script:config.role;name=$script:config.role} }
    Push-Location $root
    try {$output=(& $node (Join-Path $PSScriptRoot 'check-runtime.cjs') 2>&1 | Out-String);$code=$LASTEXITCODE} finally {Pop-Location}
    if ($code -ne 0) {
        if ($output -notmatch '(?i)DLL|specified module|module could not be found|not a valid Win32') {throw 'El motor incluido fallo. No se instalaran requisitos sin diagnostico. Consulte los registros.'}
        $installer=Join-Path (Split-Path -Parent $root) 'Prerequisites\vc_redist.x64.exe'; $signature=Get-AuthenticodeSignature -LiteralPath $installer
        if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft Corporation') {throw 'El instalador VC++ incluido no tiene firma Microsoft valida.'}
        Show-Status 'Reparando VC++ diagnosticado. Windows puede pedir permiso.'
        $repair=Start-Process powershell.exe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "'+(Join-Path $PSScriptRoot 'Ensure-VCRedist.ps1')+'" -InstallerPath "'+$installer+'"') -WindowStyle Hidden -Wait -PassThru
        if ($repair.ExitCode -ne 0) {throw 'No se completo la reparacion VC++. Reinicie Windows si lo solicita.'}
        Push-Location $root
        try {$output=(& $node (Join-Path $PSScriptRoot 'check-runtime.cjs') 2>&1 | Out-String);$code=$LASTEXITCODE} finally {Pop-Location}
        if ($code -ne 0) {throw 'El motor sigue fallando despues de reparar VC++. No se inicio el torneo.'}
    }
    Retry-Startup
    $timer=New-Object Windows.Forms.Timer; $timer.Interval=1500
    $timer.Add_Tick({
        try {
            if (Test-Path -LiteralPath $requestFile -PathType Leaf) {Remove-Item -LiteralPath $requestFile;$script:nextOpen=$true;$script:form.Show()}
            if ($script:stopping) {
                if ($script:process.HasExited) {$script:allowExit=$true;$script:form.Close()}
                elseif ([datetime]::UtcNow -gt $script:deadline) {Show-Status 'El cierre seguro esta tardando. No se forzo ningun proceso. Conserve los datos y revise los registros.' $true}
                return
            }
            if ($script:blocked) {return}
            if ($script:process -and $script:process.HasExited) {
                $policy=Get-OneClickRecovery -Attempts $script:attempts; $script:attempts=$policy.Attempts
                if (-not $policy.Allowed) {throw 'El servidor se detuvo repetidamente. Recuperacion pausada; revise registros y pulse Reintentar. Sus datos se conservaron.'}
                $script:attempts += [datetime]::UtcNow; $script:process=$null
                Write-Diagnostic 'Unexpected exit; recovering same origin and data, no gameplay commands.';Start-ServiceProcess;return
            }
            $identity=Read-Identity
            if ($script:process -and (Test-OneClickIdentity $identity $script:config $script:build.buildId $script:process.Id)) {
                $script:ready=$true;Show-Status ("Listo. $($script:config.role) - http://localhost:$($script:config.port)`r`nCerrar esta ventana NO detiene TKD. Use el icono junto al reloj para cerrar el sistema.")
                if ($script:nextOpen) {Open-Browser}
            } elseif ($script:ready -or [datetime]::UtcNow -gt $script:deadline) {
                $script:ready=$false;throw 'El proceso sigue vivo pero no responde con la identidad esperada. No se duplicara. Revise registros y pulse Reintentar.'
            }
        } catch {$script:blocked=$true;$script:ready=$false;Write-Diagnostic $_.Exception.Message;Show-Status $_.Exception.Message $true}
    })
    $timer.Start(); [Windows.Forms.Application]::Run($script:form)
} catch {
    try {Write-Diagnostic $_.Exception.Message} catch {}
    [void][Windows.Forms.MessageBox]::Show($_.Exception.Message,'TKD Fight - No se pudo iniciar','OK','Error')
} finally {
    if ($timer) {$timer.Stop();$timer.Dispose()}
    if ($script:tray) {$script:tray.Visible=$false;$script:tray.Dispose()}
    if ($owns) {$mutex.ReleaseMutex()};$mutex.Dispose()
}

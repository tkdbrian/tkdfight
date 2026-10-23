# =============================================================================
# TKD-Manager.ps1
# Gestor principal de TKD Fight:
#   - System tray icon (verde=OK / amarillo=iniciando / rojo=caído)
#   - Server watchdog: reinicia node.exe si cae
#   - Browser watchdog: reabre Chrome/Edge kiosk si se cierra
# =============================================================================
param(
    [string]$Role      = $env:TKD_ROLE,
    [string]$DataDir   = $env:TKD_DATA,
    [string]$Port      = "3001",
    [string]$OpenPath  = $env:TKD_OPEN_PATH
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Desconectar completamente del proceso de consola (más confiable que ShowWindow)
# FreeConsole() elimina la ventana de consola — no queda nada que cerrar por error
Add-Type -Name ConsoleFree -Namespace "" -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool FreeConsole();'
$null = [ConsoleFree]::FreeConsole()

# ── Defaults ─────────────────────────────────────────────────────────────────
if (-not $Role)      { $Role      = "cuadrilatero1" }
if (-not $Port)      { $Port      = "3001" }
if (-not $OpenPath)  { $OpenPath  = "" }

# ── Rutas ─────────────────────────────────────────────────────────────────────
$RootDir    = Split-Path -Parent $PSScriptRoot          # scripts/../  →  sistema/ o portable/
$NodeExe    = Join-Path $RootDir "bin\node.exe"
if (-not (Test-Path $NodeExe)) {
    $found = Get-Command node -ErrorAction SilentlyContinue
    $NodeExe = if ($found) { $found.Source } else { "node" }
}
$ServerFile = Join-Path $RootDir "dist-server\index.mjs"
if (-not $DataDir) { $DataDir = Join-Path $RootDir "data" }
if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir | Out-Null }
$StopFile   = Join-Path $RootDir ".server.stop"
$LogDir     = Join-Path $RootDir "logs"
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }
$LogFile    = Join-Path $LogDir "server-$(Get-Date -Format 'yyyy-MM-dd').log"

# ── Log ───────────────────────────────────────────────────────────────────────
function Write-Log ([string]$msg) {
    "[$(Get-Date -Format 'HH:mm:ss')] $msg" |
        Add-Content -Path $LogFile -Encoding UTF8 -ErrorAction SilentlyContinue
}
Write-Log "=== TKD-Manager arrancó. Role=$Role Port=$Port DataDir=$DataDir ==="

# Rotar logs: eliminar archivos de más de 7 días
Get-ChildItem $LogDir -Filter "server-*.log" -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) } |
    Remove-Item -Force -ErrorAction SilentlyContinue

# ── Estado compartido entre runspaces (thread-safe) ──────────────────────────
$shared = [hashtable]::Synchronized(@{
    Status         = "starting"   # starting | running | restarting | stopped
    ServerPid      = $null
    BrowserPid     = $null
    ShouldStop     = $false
    NeedIconUpdate = $true
    Port           = $Port
    DataDir        = $DataDir
    NodeExe        = $NodeExe
    ServerFile     = $ServerFile
    StopFile       = $StopFile
    LogFile        = $LogFile
    RootDir        = $RootDir
    OpenPath       = $OpenPath
})

# ── Helpers ───────────────────────────────────────────────────────────────────
function Get-LocalIp {
    try {
        $ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
               Where-Object { $_.IPAddress -ne '127.0.0.1' } |
               Sort-Object PrefixOrigin |
               Select-Object -First 1).IPAddress
        return if ($ip) { $ip } else { "localhost" }
    } catch { return "localhost" }
}

$ChromePaths = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LocalAppData\Google\Chrome\Application\chrome.exe"
)
$EdgePaths = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)

function Open-KioskBrowser ([string]$Url) {
    foreach ($p in $ChromePaths) {
        if (Test-Path $p) {
            $proc = Start-Process -FilePath $p -ArgumentList @("--app=$Url","--no-first-run","--disable-extensions","--disable-translate") -PassThru -ErrorAction SilentlyContinue
            if ($proc) { Write-Log "Navegador Chrome PID=$($proc.Id)"; return $proc.Id }
        }
    }
    foreach ($p in $EdgePaths) {
        if (Test-Path $p) {
            $proc = Start-Process -FilePath $p -ArgumentList @("--kiosk","--no-first-run",$Url) -PassThru -ErrorAction SilentlyContinue
            if ($proc) { Write-Log "Navegador Edge PID=$($proc.Id)"; return $proc.Id }
        }
    }
    Write-Log "Fallback: abriendo en navegador predeterminado"
    Start-Process $Url
    return $null
}

# ── Runspace 1: Server watchdog ───────────────────────────────────────────────
$srRS = [runspacefactory]::CreateRunspace()
$srRS.Open()
$srRS.SessionStateProxy.SetVariable("shared", $shared)

$srPS = [powershell]::Create()
$srPS.Runspace = $srRS
$null = $srPS.AddScript({
    function Log([string]$m) {
        "[$(Get-Date -Format 'HH:mm:ss')] [WD] $m" |
            Add-Content -Path $shared.LogFile -Encoding UTF8 -ErrorAction SilentlyContinue
    }
    Remove-Item $shared.StopFile -ErrorAction SilentlyContinue

    while (-not $shared.ShouldStop) {
        if (Test-Path $shared.StopFile) { break }

        $shared.Status = "starting"; $shared.NeedIconUpdate = $true
        Log "Iniciando servidor en puerto $($shared.Port)..."

        # Normalizar DataDir (quitar espacios al final que rompen rutas en Windows)
        $cleanDataDir = ($shared.DataDir).TrimEnd(' ','\','/')
        if (-not (Test-Path $cleanDataDir)) {
            try { New-Item -ItemType Directory -Path $cleanDataDir -Force | Out-Null } catch {}
        }

        $pi = New-Object System.Diagnostics.ProcessStartInfo
        $pi.FileName               = $shared.NodeExe
        $pi.Arguments              = '"' + $shared.ServerFile + '"'
        $pi.WorkingDirectory       = $shared.RootDir
        $pi.UseShellExecute        = $false
        $pi.CreateNoWindow         = $true
        $pi.RedirectStandardOutput = $true
        $pi.RedirectStandardError  = $true
        $pi.EnvironmentVariables["DATA_DIR"]        = $cleanDataDir
        $pi.EnvironmentVariables["PORT"]            = $shared.Port
        $pi.EnvironmentVariables["NODE_ENV"]        = "production"
        $pi.EnvironmentVariables["ALLOWED_ORIGINS"] = "*"

        # Logs separados de stdout/stderr del servidor — clave para diagnosticar fallos en maquinas ajenas
        $logDir       = Split-Path $shared.LogFile -Parent
        $stdoutPath   = Join-Path $logDir ("server-stdout-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))
        $stderrPath   = Join-Path $logDir ("server-stderr-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))

        $p = New-Object System.Diagnostics.Process
        $p.StartInfo = $pi
        $p.EnableRaisingEvents = $true

        # Capturar stdout/stderr asincronicamente y volcarlos a archivo
        $outAction = {
            if ($EventArgs.Data) {
                Add-Content -Path $Event.MessageData -Value $EventArgs.Data -ErrorAction SilentlyContinue
            }
        }
        $outSub = Register-ObjectEvent -InputObject $p -EventName OutputDataReceived -Action $outAction -MessageData $stdoutPath
        $errSub = Register-ObjectEvent -InputObject $p -EventName ErrorDataReceived  -Action $outAction -MessageData $stderrPath

        try {
            $p.Start() | Out-Null
            $p.BeginOutputReadLine()
            $p.BeginErrorReadLine()
        } catch {
            Log "Error al iniciar node.exe: $_"
            Unregister-Event -SourceIdentifier $outSub.Name -ErrorAction SilentlyContinue
            Unregister-Event -SourceIdentifier $errSub.Name -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 5
            continue
        }

        $shared.ServerPid = $p.Id
        $shared.Status    = "running"; $shared.NeedIconUpdate = $true
        Log "Servidor corriendo PID=$($p.Id) DataDir=$cleanDataDir"

        while (-not $p.HasExited) {
            if (Test-Path $shared.StopFile) { try { $p.Kill() } catch {}; break }
            Start-Sleep -Milliseconds 500
        }

        # Drenar buffers y desuscribirse
        try { $p.WaitForExit(1000) | Out-Null } catch {}
        Unregister-Event -SourceIdentifier $outSub.Name -ErrorAction SilentlyContinue
        Unregister-Event -SourceIdentifier $errSub.Name -ErrorAction SilentlyContinue

        if (Test-Path $shared.StopFile) { break }

        # Mostrar las ultimas 3 lineas de stderr en el log principal para diagnostico inmediato
        $lastErr = ""
        if (Test-Path $stderrPath) {
            try { $lastErr = (Get-Content $stderrPath -Tail 3 -ErrorAction SilentlyContinue) -join " | " } catch {}
        }
        Log "Servidor caido (exit=$($p.ExitCode)). stderr: $lastErr"
        $shared.Status = "restarting"; $shared.NeedIconUpdate = $true
        Start-Sleep -Seconds 2
    }

    $shared.Status = "stopped"; $shared.NeedIconUpdate = $true
    Log "Watchdog detenido."
})
$null = $srPS.BeginInvoke()

# Esperar a que el puerto 3001 acepte conexiones TCP (máx 15s)
$portOpen = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $tcp.Connect("127.0.0.1", [int]$Port)
        $tcp.Close()
        $portOpen = $true
        break
    } catch { }
}
if (-not $portOpen) { Write-Log "[WARN] Puerto $Port no respondió en 15s, abriendo browser de todas formas" }

# ── Abrir navegador en modo kiosk ─────────────────────────────────────────────
$appUrl = "http://localhost:${Port}${OpenPath}"
$shared.BrowserPid = Open-KioskBrowser -Url $appUrl

# ── Íconos de tray (generados con GDI+, sin archivos externos) ───────────────
function New-CircleIcon ([System.Drawing.Color]$color) {
    $bmp   = New-Object System.Drawing.Bitmap(16, 16)
    $g     = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::Transparent)
    $brush = New-Object System.Drawing.SolidBrush($color)
    $g.FillEllipse($brush, 1, 1, 14, 14)
    $brush.Dispose(); $g.Dispose()
    $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
    $bmp.Dispose()
    return $icon
}
$iconGreen  = New-CircleIcon([System.Drawing.Color]::LimeGreen)
$iconYellow = New-CircleIcon([System.Drawing.Color]::Gold)
$iconRed    = New-CircleIcon([System.Drawing.Color]::OrangeRed)

# ── System Tray ───────────────────────────────────────────────────────────────
$roleLabel = switch ($Role) {
    "central"       { "Mesa Central" }
    "cuadrilatero1" { "Cuadrilatero 1" }
    "cuadrilatero2" { "Cuadrilatero 2" }
    "cuadrilatero3" { "Cuadrilatero 3" }
    default         { $Role }
}

$tray          = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon     = $iconYellow
$tray.Visible  = $true
$tray.Text     = "TKD - $roleLabel  [Iniciando...]"

$ctxMenu = New-Object System.Windows.Forms.ContextMenuStrip
$miAbrir   = $ctxMenu.Items.Add("Abrir aplicacion")
$miReinic  = $ctxMenu.Items.Add("Reiniciar servidor")
$miIp      = $ctxMenu.Items.Add("Ver IP de la red")
$null = $ctxMenu.Items.Add([System.Windows.Forms.ToolStripSeparator]::new())
$miCerrar  = $ctxMenu.Items.Add("Cerrar TKD")
$tray.ContextMenuStrip = $ctxMenu

# Balloon de arranque
$localIp = Get-LocalIp
$tray.BalloonTipTitle = "TKD Fight - $roleLabel"
$tray.BalloonTipText  = "Sistema listo`nRed: http://${localIp}:${Port}"
$tray.ShowBalloonTip(6000)

# ── Timer: actualiza ícono desde el hilo principal de WinForms ────────────────
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 800
$timer.Add_Tick({
    if ($shared.NeedIconUpdate) {
        $shared.NeedIconUpdate = $false
        switch ($shared.Status) {
            "running"    { $tray.Icon = $iconGreen;  $tray.Text = "TKD - $roleLabel  [OK]" }
            "restarting" { $tray.Icon = $iconYellow; $tray.Text = "TKD - $roleLabel  [Reiniciando...]" }
            "starting"   { $tray.Icon = $iconYellow; $tray.Text = "TKD - $roleLabel  [Iniciando...]" }
            "stopped"    { $tray.Icon = $iconRed;    $tray.Text = "TKD - $roleLabel  [Detenido]" }
        }
    }
})
$timer.Start()

# ── Eventos del menú ──────────────────────────────────────────────────────────
$miAbrir.Add_Click({ Start-Process $appUrl })

$miReinic.Add_Click({
    if ($shared.ServerPid) {
        try { Stop-Process -Id $shared.ServerPid -Force -ErrorAction SilentlyContinue } catch {}
    }
})

$miIp.Add_Click({
    $ip = Get-LocalIp
    [System.Windows.Forms.MessageBox]::Show(
        "Organizador / Mesa:`nhttp://localhost:$Port`n`nJueces (celular, misma WiFi):`nhttp://${ip}:${Port}/judge`n`nMesa Central:`nhttp://${ip}:${Port}/central`n`nTV:`nhttp://${ip}:${Port}/tv",
        "TKD - Direcciones de red",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Information
    ) | Out-Null
})

$miCerrar.Add_Click({
    $r = [System.Windows.Forms.MessageBox]::Show(
        "Cerrar TKD Fight?`nSe detendran el servidor y el navegador.",
        "Cerrar TKD - $roleLabel",
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Question
    )
    if ($r -eq [System.Windows.Forms.DialogResult]::Yes) {
        $shared.ShouldStop = $true
        "" | Set-Content $shared.StopFile -ErrorAction SilentlyContinue
        if ($shared.BrowserPid) {
            try { Stop-Process -Id $shared.BrowserPid -Force -ErrorAction SilentlyContinue } catch {}
        }
        $timer.Stop()
        $tray.Visible = $false
        $tray.Dispose()
        [System.Windows.Forms.Application]::Exit()
    }
})

$tray.Add_DoubleClick({ Start-Process $appUrl })

# ── Message loop (bloquea hasta que se cierre el tray) ────────────────────────
[System.Windows.Forms.Application]::Run()

# ── Cleanup ───────────────────────────────────────────────────────────────────
$timer.Dispose()
$iconGreen.Dispose(); $iconYellow.Dispose(); $iconRed.Dispose()
$srPS.Dispose(); $srRS.Dispose()
Write-Log "TKD-Manager finalizado."

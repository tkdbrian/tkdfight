param(
    [Parameter(Mandatory = $true)][string]$InstallerPath
)

$ErrorActionPreference = "Stop"
$registryPath = "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64"

function Get-InstalledVCRedistVersion {
    $registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
        [Microsoft.Win32.RegistryHive]::LocalMachine,
        [Microsoft.Win32.RegistryView]::Registry64
    )

    try {
        $runtimeKey = $registry.OpenSubKey($registryPath)
        if (-not $runtimeKey) {
            return $null
        }

        try {
            if ($runtimeKey.GetValue("Installed", 0) -ne 1) {
                return $null
            }

            $versionText = ([string]$runtimeKey.GetValue("Version")).Trim().TrimStart("v", "V")
            $installedVersion = $null
            if ([Version]::TryParse($versionText, [ref]$installedVersion)) {
                return $installedVersion
            }
            return $null
        } finally {
            $runtimeKey.Dispose()
        }
    } finally {
        $registry.Dispose()
    }
}

if (-not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {
    if (Get-InstalledVCRedistVersion) {
        Write-Host "Microsoft Visual C++ Redistributable x64 ya esta instalado."
        exit 0
    }
    Write-Error "No se encontro el redistribuible incluido: $InstallerPath"
    exit 1
}

$requiredVersion = [Version](Get-Item -LiteralPath $InstallerPath).VersionInfo.FileVersion
$installedVersion = Get-InstalledVCRedistVersion
if ($installedVersion -and $installedVersion -ge $requiredVersion) {
    Write-Host "Microsoft Visual C++ Redistributable x64 $installedVersion ya esta instalado."
    exit 0
}

try {
    $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($currentIdentity)
    $isAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    $startParameters = @{
        FilePath = (Resolve-Path -LiteralPath $InstallerPath).Path
        ArgumentList = "/install /passive /norestart"
        Wait = $true
        PassThru = $true
    }
    if (-not $isAdministrator) {
        $startParameters.Verb = "RunAs"
    }

    Write-Host "Instalando Microsoft Visual C++ Redistributable x64..."
    $process = Start-Process @startParameters
    $installedVersion = Get-InstalledVCRedistVersion
    if ($process.ExitCode -eq 3010) {
        if ($installedVersion -and $installedVersion -ge $requiredVersion) {
            Write-Error "El redistribuible se instalo, pero Windows requiere reiniciar antes de iniciar TKD Fight."
            exit 3010
        }
        throw "El redistribuible solicito reiniciar, pero no se detecta la version necesaria."
    }
    if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 1638) {
        throw "El instalador de Microsoft finalizo con codigo $($process.ExitCode)."
    }
    if (-not $installedVersion -or $installedVersion -lt $requiredVersion) {
        throw "El instalador termino, pero no se detecta la version VC++ x64 requerida ($requiredVersion)."
    }

    Write-Host "Microsoft Visual C++ Redistributable x64 quedo instalado."
    exit 0
} catch {
    Write-Error $_
    exit 1
}
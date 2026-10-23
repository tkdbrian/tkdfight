param(
    [Parameter(Mandatory = $true)][string]$DestinationPath
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$downloadUrl = "https://aka.ms/vc14/vc_redist.x64.exe"
$temporaryPath = "$DestinationPath.download"
$destinationDirectory = Split-Path -Parent $DestinationPath

try {
    New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
    Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    Invoke-WebRequest -Uri $downloadUrl -OutFile $temporaryPath -UseBasicParsing

    $signature = Get-AuthenticodeSignature -LiteralPath $temporaryPath
    $signerName = if ($signature.SignerCertificate) {
        $signature.SignerCertificate.GetNameInfo(
            [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
            $false
        )
    } else {
        ""
    }

    if ($signature.Status -ne "Valid" -or $signerName -ne "Microsoft Corporation") {
        throw "La firma Authenticode del redistribuible no es valida o no pertenece a Microsoft."
    }

    Move-Item -LiteralPath $temporaryPath -Destination $DestinationPath -Force
    Write-Host "Redistribuible VC++ x64 verificado y preparado."
    exit 0
} catch {
    Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    Write-Error $_
    exit 1
}
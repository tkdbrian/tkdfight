param([Parameter(Mandatory = $true)][string]$FilePath)

$ErrorActionPreference = "Stop"
$signature = Get-AuthenticodeSignature -LiteralPath $FilePath
if ($signature.Status -ne "Valid" -or $signature.SignerCertificate.Subject -notmatch "Microsoft Corporation") {
    throw "VC++ prerequisite must have a valid Microsoft signature: $FilePath"
}

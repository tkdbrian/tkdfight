param(
    [Parameter(Mandatory = $true)][string]$Folder,
    [Parameter(Mandatory = $true)][string]$ZipPath
)

$ErrorActionPreference = "Stop"
$folderFull = [IO.Path]::GetFullPath($Folder)
$zipFull = [IO.Path]::GetFullPath($ZipPath)
if (-not (Test-Path -LiteralPath $folderFull -PathType Container)) { throw "Package folder missing" }
if (Test-Path -LiteralPath $zipFull) { throw "ZIP already exists; never overwrite" }
if (-not [IO.Path]::GetDirectoryName($zipFull).Equals([IO.Path]::GetDirectoryName($folderFull), [StringComparison]::OrdinalIgnoreCase)) {
    throw "ZIP must be a sibling of the unique package folder"
}

Compress-Archive -LiteralPath $folderFull -DestinationPath $zipFull -CompressionLevel Optimal
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($zipFull)
try {
    $manifest = Get-Content -LiteralPath (Join-Path $folderFull "release-manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    $expected = @{}
    foreach ($property in $manifest.files.PSObject.Properties) { $expected[$property.Name] = $property.Value.sha256 }
    $prefix = [IO.Path]::GetFileName($folderFull) + "/"
    $seen = @{}
    foreach ($entry in $archive.Entries) {
        $zipName = $entry.FullName.Replace("\", "/")
        if ($zipName.EndsWith("/")) { continue }
        if (-not $zipName.StartsWith($prefix, [StringComparison]::Ordinal)) { throw "Unexpected ZIP path: $($entry.FullName)" }
        $rel = $zipName.Substring($prefix.Length)
        if ($rel -eq "release-manifest.json") {
            $manifestStream = $entry.Open()
            try {
                $hasher = [Security.Cryptography.SHA256]::Create()
                try { $manifestHash = [BitConverter]::ToString($hasher.ComputeHash($manifestStream)).Replace("-", "").ToLowerInvariant() }
                finally { $hasher.Dispose() }
            } finally { $manifestStream.Dispose() }
            $sourceManifestHash = (Get-FileHash -LiteralPath (Join-Path $folderFull "release-manifest.json") -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($manifestHash -ne $sourceManifestHash) { throw "ZIP manifest hash mismatch" }
            continue
        }
        if (-not $expected.ContainsKey($rel) -or $seen.ContainsKey($rel)) { throw "Unexpected/duplicate ZIP entry: $rel" }
        $stream = $entry.Open()
        try {
            $hasher = [Security.Cryptography.SHA256]::Create()
            try { $hash = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace("-", "").ToLowerInvariant() }
            finally { $hasher.Dispose() }
        } finally { $stream.Dispose() }
        if ($hash -ne $expected[$rel]) { throw "ZIP entry hash mismatch: $rel" }
        $seen[$rel] = $true
    }
    if ($seen.Count -ne $expected.Count) { throw "ZIP missing payload files: expected $($expected.Count), got $($seen.Count)" }
} finally { $archive.Dispose() }

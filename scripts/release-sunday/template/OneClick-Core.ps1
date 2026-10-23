function Test-OneClickConfig($Config) {
    $id = [guid]::Empty
    if ($Config.version -ne 1 -or -not [guid]::TryParse([string]$Config.installationId,[ref]$id) -or $Config.secret -cnotmatch '^[a-f0-9]{64}$' -or $Config.role -notin @('T1','T2','T3','MC') -or $Config.port -notin 43101..43130) { throw 'Configuracion local invalida. No se cambiaron los datos.' }
    return $true
}
function Select-OneClickPort([int[]]$Occupied) {
    foreach ($candidate in 43101..43130) { if ($candidate -notin $Occupied) { return $candidate } }
    throw 'No hay un puerto local disponible entre 43101 y 43130. Cierre otras aplicaciones y reintente.'
}
function Write-OneClickJson([string]$Path,$Value) {
    $temp = $Path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temp,($Value | ConvertTo-Json -Depth 8),(New-Object Text.UTF8Encoding($false)))
        if (Test-Path -LiteralPath $Path -PathType Leaf) { [IO.File]::Replace($temp,$Path,[System.Management.Automation.Language.NullString]::Value) } else { [IO.File]::Move($temp,$Path) }
    } finally { if (Test-Path -LiteralPath $temp -PathType Leaf) { Remove-Item -LiteralPath $temp } }
}
function Test-OneClickIdentity($Identity,$Config,[string]$BuildId,[int]$ProcessId) {
    return ($null -ne $Identity -and $Identity.ok -eq $true -and $Identity.installationId -ceq $Config.installationId -and $Identity.buildId -ceq $BuildId -and $Identity.role -ceq $Config.role -and $Identity.port -eq $Config.port -and $Identity.pid -eq $ProcessId -and $Identity.state -eq 'ready')
}
function Get-OneClickRecovery([datetime[]]$Attempts,[datetime]$Now=[datetime]::UtcNow) {
    $recent = @($Attempts | Where-Object { $_ -gt $Now.AddSeconds(-60) })
    return [pscustomobject]@{ Allowed=($recent.Count -lt 3); Attempts=$recent }
}

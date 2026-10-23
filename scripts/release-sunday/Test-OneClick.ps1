$ErrorActionPreference = 'Stop'
$template = Join-Path $PSScriptRoot 'template'
. (Join-Path $template 'OneClick-Core.ps1')
$count = 0
function Assert-True($Value, $Message) { if (-not $Value) { throw $Message }; $script:count++ }
function Assert-Throws($Action, $Message) { $thrown = $false; try { & $Action } catch { $thrown = $true }; Assert-True $thrown $Message }
$config = [pscustomobject]@{ version = 1; installationId = [guid]::NewGuid().ToString(); secret = ('a' * 64); role = 'T2'; port = 43104 }
Assert-True (Test-OneClickConfig $config) 'valid configuration rejected'
$config.port = 3101
Assert-Throws { Test-OneClickConfig $config } 'legacy port accepted'
$config.port = 43104
$config.secret = 'short'
Assert-Throws { Test-OneClickConfig $config } 'short secret accepted'
$config.secret = 'a' * 64
Assert-True ((Select-OneClickPort -Occupied @(43101,43102,3001,3101)) -eq 43103) 'first free port not selected'
Assert-Throws { Select-OneClickPort -Occupied @(43101..43130) } 'full range accepted'
$identity = [pscustomobject]@{ ok=$true; installationId=$config.installationId; buildId='test'; role='T2'; pid=100; port=43104; state='ready' }
Assert-True (Test-OneClickIdentity $identity $config 'test' 100) 'matching identity rejected'
Assert-True (-not (Test-OneClickIdentity $identity $config 'other' 100)) 'wrong build accepted'
Assert-True (-not (Test-OneClickIdentity $identity $config 'test' 101)) 'wrong PID accepted'
$identity.installationId = [guid]::NewGuid().ToString()
Assert-True (-not (Test-OneClickIdentity $identity $config 'test' 100)) 'foreign installation accepted'
$now = [datetime]'2026-10-23T12:00:00Z'
Assert-True ((Get-OneClickRecovery -Attempts @() -Now $now).Allowed) 'first recovery blocked'
Assert-True (-not (Get-OneClickRecovery -Attempts @($now.AddSeconds(-1),$now.AddSeconds(-2),$now.AddSeconds(-3)) -Now $now).Allowed) 'restart storm allowed'
Assert-True ((Get-OneClickRecovery -Attempts @($now.AddSeconds(-61),$now.AddSeconds(-2),$now.AddSeconds(-3)) -Now $now).Allowed) 'expired recovery did not expire'
$temp = Join-Path ([IO.Path]::GetTempPath()) ('tkd-oneclick-test-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $temp | Out-Null
try {
    $file = Join-Path $temp 'config.json'
    Write-OneClickJson $file $config
    Assert-True (Test-OneClickConfig (Get-Content -LiteralPath $file -Raw | ConvertFrom-Json)) 'atomic config not readable'
    Write-OneClickJson $file $config
    Assert-True (Test-OneClickConfig (Get-Content -LiteralPath $file -Raw | ConvertFrom-Json)) 'atomic replacement not readable'
    Assert-True (@(Get-ChildItem -LiteralPath $temp -File).Count -eq 1) 'temporary file leaked'
} finally { Remove-Item -LiteralPath $temp -Recurse -Force }
$launcher = Get-Content -LiteralPath (Join-Path $template 'Launch-Sunday.ps1') -Raw
Assert-True ($launcher -notmatch 'Read-Host|Stop-Process|taskkill|Stop-TKDServer|Start-TKDServer') 'unsafe legacy lifetime retained'
Assert-True ($launcher -match 'WindowStyle Hidden') 'background launch not hidden'
Assert-True ($launcher -match '/api/local/shutdown' -and $launcher -match '/api/local/identity') 'authenticated lifecycle absent'
Assert-True ($launcher -match 'NotifyIcon' -and $launcher -match 'Mutex') 'single-instance tray absent'
Assert-True (-not (Test-Path -LiteralPath (Join-Path $template 'ABRIR_TKD.bat'))) 'legacy entry retained'
# Execute real lifecycle functions with mocked OS boundaries (no server/browser started).
$tokens=$null; $parseErrors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $template 'Launch-Sunday.ps1'),[ref]$tokens,[ref]$parseErrors)
Assert-True ($parseErrors.Count -eq 0) 'launcher has parse errors'
foreach ($name in @('Start-ServiceProcess','Retry-Startup')) {
    $definition=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
    . ([scriptblock]::Create($definition.Extent.Text))
}
$script:spawned=0; $script:listeners=@(); $script:adopt=$false
function Get-Listeners { param($Port) return $script:listeners }
function Read-Identity { return $identity }
function Confirm-Process { param($Identity) return $script:adopt }
function Show-Status { param($Message,$Failed) }
function Write-Diagnostic { param($Message) }
function New-Item { param($ItemType,$Path,[switch]$Force) }
function Start-Process { param($FilePath,$ArgumentList,$WorkingDirectory,$WindowStyle,$RedirectStandardOutput,$RedirectStandardError,[switch]$PassThru)
    Assert-True ($WindowStyle -eq 'Hidden') 'server is not detached hidden'
    $script:spawned++; return [pscustomobject]@{Id=43210;HasExited=$false}
}
$script:config=$config; $script:build=[pscustomobject]@{buildId='test'}; $script:dataDir='C:\isolated\data-t2'; $root='C:\isolated';$node='C:\isolated\node.exe';$server='C:\isolated\index.mjs'; $script:process=$null
Start-ServiceProcess
Assert-True ($script:spawned -eq 1 -and -not $script:ready) 'start did not wait for identity'
Assert-True ($env:PORT -eq 43104 -and $env:DATA_DIR -eq $script:dataDir) 'persistent origin/data were changed'
$script:listeners=@(1); $script:adopt=$true
Start-ServiceProcess
Assert-True ($script:ready -and $script:spawned -eq 1) 'same instance duplicated instead of reused'
$script:adopt=$false
Assert-Throws { Start-ServiceProcess } 'foreign port accepted'
Assert-True ($script:spawned -eq 1) 'foreign port spawned server'
$script:listeners=@()
Assert-Throws { Start-ServiceProcess } 'alive unhealthy server duplicated'
Assert-True ($script:spawned -eq 1) 'unhealthy live process replaced'
Retry-Startup
Assert-True $script:blocked 'failed retry did not block automatic startup'
Write-Output "PASS: $count isolated one-click checks"

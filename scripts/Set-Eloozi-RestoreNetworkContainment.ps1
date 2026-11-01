[CmdletBinding()]
param(
  [ValidateSet('Enable','Remove')]
  [string]$Action = 'Enable',
  [string]$RunId
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$postgresExe = [IO.Path]::GetFullPath('D:\pgSQL\bin\postgres.exe')
$stateRoot = Join-Path $env:LOCALAPPDATA 'Eloozi\RestoreContainment'

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Abra PowerShell como Administrador e execute novamente.'
  }
}

function Protect-StateDirectory([string]$Path) {
  [void](New-Item -ItemType Directory -Path $Path -Force)
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner($sid)
  $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.SetAccessRule($rule)
  Set-Acl -LiteralPath $Path -AclObject $acl
  $actual = Get-Acl -LiteralPath $Path
  if (-not $actual.AreAccessRulesProtected -or $actual.Access.Count -ne 1 -or $actual.Access[0].IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) {
    throw 'Não foi possível confirmar ACL privada para o registro da contenção.'
  }
}

Assert-Administrator
if (-not (Test-Path -LiteralPath $postgresExe -PathType Leaf)) { throw "Executável não encontrado: $postgresExe" }
if ((Get-Service -Name MpsSvc).Status -ne 'Running') { throw 'Windows Defender Firewall não está ativo; nenhuma regra foi criada.' }

if ($Action -eq 'Remove') {
  if (-not $RunId -or $RunId -notmatch '^[0-9a-fA-F-]{36}$') { throw 'Informe o RunId retornado pelo modo Enable.' }
  $stateFile = Join-Path $stateRoot "$RunId.json"
  if (-not (Test-Path -LiteralPath $stateFile -PathType Leaf)) { throw 'Registro deste RunId não encontrado; nenhuma regra foi removida.' }
  $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
  if ($state.run_id -ne $RunId -or $state.program -ne $postgresExe) { throw 'Registro não corresponde ao executável/RunId; nenhuma regra foi removida.' }
  $running = @(Get-CimInstance Win32_Process -Filter "Name='postgres.exe'" | Where-Object {
    $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -ieq $postgresExe
  })
  if ($running.Count -gt 0) { throw 'Pare o cluster descartável antes de remover a contenção; nenhuma regra foi removida.' }
  foreach ($name in $state.rule_names) {
    $rule = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
    if ($rule) {
      if ($rule.Group -ne $state.group) { throw "Regra $name tem grupo inesperado; interrompendo remoção." }
      $app = $rule | Get-NetFirewallApplicationFilter
      if ([IO.Path]::GetFullPath($app.Program) -ne $postgresExe) { throw "Regra $name aponta para outro executável; interrompendo remoção." }
    }
  }
  foreach ($name in $state.rule_names) { Remove-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $stateFile -Force
  Write-Output "REMOVED RunId=$RunId; removidas somente as regras registradas por esta execução."
  exit 0
}

$instances = @(Get-CimInstance Win32_Process -Filter "Name='postgres.exe'" | Where-Object {
  $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -ieq $postgresExe
})
if ($instances.Count -gt 0) {
  $pids = ($instances | ForEach-Object ProcessId) -join ', '
  throw "Encontradas instâncias existentes de $postgresExe (PID $pids). Nenhuma regra foi criada, para não bloqueá-las. Feche/identifique-as ou use uma VM/bancada de rede isolada."
}

$profiles = Get-NetFirewallProfile -PolicyStore ActiveStore
if (@($profiles | Where-Object { -not $_.Enabled }).Count -gt 0) { throw 'Há perfil de Firewall inativo; nenhuma regra foi criada.' }

$runIdNew = [guid]::NewGuid().ToString()
$group = "Eloozi restore containment $runIdNew"
$ruleName = "Eloozi restore outbound block $runIdNew"
$created = $false
try {
  New-NetFirewallRule -DisplayName $ruleName -Group $group -Direction Outbound -Action Block -Program $postgresExe -Profile Any -Enabled True -Protocol Any -RemoteAddress Any | Out-Null
  $created = $true

  $active = Get-NetFirewallRule -DisplayName $ruleName -PolicyStore ActiveStore -ErrorAction Stop
  $appFilter = $active | Get-NetFirewallApplicationFilter
  $addrFilter = $active | Get-NetFirewallAddressFilter
  $portFilter = $active | Get-NetFirewallPortFilter
  if ($active.Enabled -ne 'True' -or $active.Direction -ne 'Outbound' -or $active.Action -ne 'Block' -or $active.Profile -ne 'Any' -or [IO.Path]::GetFullPath($appFilter.Program) -ne $postgresExe -or $addrFilter.RemoteAddress -notcontains 'Any' -or $portFilter.Protocol -ne 'Any') {
    throw 'A regra efetiva não corresponde ao bloqueio de saída esperado; removendo a regra criada.'
  }

  $initdb = 'D:\pgSQL\bin\initdb.exe'
  $pgCtl = 'D:\pgSQL\bin\pg_ctl.exe'
  $psql = 'D:\pgSQL\bin\psql.exe'
  foreach ($tool in @($initdb,$pgCtl,$psql)) { if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) { throw "Ferramenta local ausente: $tool" } }
  $probeDir = Join-Path $env:LOCALAPPDATA "Eloozi\RestoreContainment\loopback-probe-$runIdNew"
  Protect-StateDirectory $probeDir
  $probePort = 55991
  $probeStarted = $false
  try {
    & $initdb -D $probeDir -U postgres -A trust --encoding=UTF8 --no-locale | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'initdb do teste loopback falhou.' }
    Add-Content -LiteralPath (Join-Path $probeDir 'postgresql.conf') -Value "`nlisten_addresses = '127.0.0.1'`nport = $probePort`n"
    & $pgCtl -D $probeDir -l (Join-Path $probeDir 'server.log') -w start | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL não iniciou no loopback sob a regra.' }
    $probeStarted = $true
    $probeResult = @(& $psql -X -qAt -h 127.0.0.1 -p $probePort -U postgres -d postgres -c 'select 1' 2>&1)
    if ($LASTEXITCODE -ne 0 -or ($probeResult -join '').Trim() -ne '1') { throw 'Conexão PostgreSQL local não passou sob a regra.' }
  } finally {
    if ($probeStarted) { & $pgCtl -D $probeDir -w stop -m fast | Out-Null }
    if (Test-Path -LiteralPath $probeDir) { Remove-Item -LiteralPath $probeDir -Recurse -Force }
  }

  $currentInstances = @(Get-CimInstance Win32_Process -Filter "Name='postgres.exe'" | Where-Object {
    $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -ieq $postgresExe
  })
  if ($currentInstances.Count -gt 0) { throw 'Uma instância PostgreSQL surgiu durante a configuração; removendo a regra para não afetá-la.' }

  Protect-StateDirectory $stateRoot
  $state = [ordered]@{ run_id=$runIdNew; group=$group; program=$postgresExe; rule_names=@($ruleName); created_utc=[DateTime]::UtcNow.ToString('o') }
  $state | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $stateRoot "$runIdNew.json") -Encoding UTF8
  Write-Output "CONTAINMENT_PASS RunId=$runIdNew"
  Write-Output "Executável isolado: $postgresExe"
  Write-Output 'Regra efetiva: outbound block, todos os perfis, todos os protocolos e destinos, somente para esse executável.'
  Write-Output 'Nenhuma instância anterior foi encontrada; teste local SELECT 1 em 127.0.0.1 passou sob a regra e os arquivos do probe foram removidos.'
  Write-Output "Remoção: .\scripts\Set-Eloozi-RestoreNetworkContainment.ps1 -Action Remove -RunId $runIdNew"
} catch {
  if ($created) { Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue }
  throw
}

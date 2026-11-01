[CmdletBinding(SupportsShouldProcess=$true)]
param([Parameter(Mandatory=$true)][string]$StateFile)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$StateFile=[IO.Path]::GetFullPath($StateFile)
$state=Get-Content -LiteralPath $StateFile -Raw|ConvertFrom-Json
$work=[IO.Path]::GetFullPath($state.work)
$base=[IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Eloozi\PrivateRestoreBench'))
if(-not $work.StartsWith($base+'\',[StringComparison]::OrdinalIgnoreCase) -or $StateFile -ne (Join-Path $work 'state.json')){throw 'Estado fora da bancada privada.'}
$runId=[IO.Path]::GetFileName($work);$guid=[guid]::Empty
if(-not [guid]::TryParse($runId,[ref]$guid)){throw 'RunId invalido.'}
$expectedName='ElooziPrivate-'+$runId
$program=Join-Path $work 'pgsql\bin\postgres.exe'
if($state.program -ne $program -or $state.rule -ne $expectedName -or $state.group -ne $expectedName){throw 'Identidade da regra ou executavel diverge.'}
if($state.phase -ne 'restore-rehearsal-complete-stopped' -or -not $state.restoration.cluster_stopped -or -not $state.restoration.database_removed){throw 'Restauracao/ensaio/encerramento nao comprovados pelo estado.'}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$admin=([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if(-not $WhatIfPreference -and -not $admin){throw 'Remocao real exige PowerShell como Administrador.'}
$processes=@(Get-CimInstance Win32_Process -Filter "Name='postgres.exe'" -ErrorAction Stop)
if(@($processes|Where-Object {-not $_.ExecutablePath}).Count){throw 'Nao foi possivel identificar todos os executaveis PostgreSQL; regra preservada.'}
if(@($processes|Where-Object {$_.ExecutablePath -ieq $program -or $_.ExecutablePath.StartsWith($work+'\',[StringComparison]::OrdinalIgnoreCase)}).Count){throw 'Processo privado ativo; regra preservada.'}
& (Join-Path $work 'pgsql\bin\pg_ctl.exe') -D (Join-Path $work 'data') status
if($LASTEXITCODE -ne 3){throw 'pg_ctl nao confirmou ausencia de servidor (exit esperado 3); regra preservada.'}
$fw=New-Object -ComObject HNetCfg.FwPolicy2
$rules=@($fw.Rules|Where-Object Name -eq $expectedName)
if($rules.Count -eq 0){Write-Output 'Regra especifica ja ausente; nenhuma alteracao.';exit 0}
if($rules.Count -ne 1){throw 'Nome duplicado; nenhuma alteracao.'}
$r=$rules[0]
if($r.Grouping -ne $expectedName -or $r.ApplicationName -ine $program -or $r.Description -ne "Eloozi private bench $runId; state=$StateFile" -or $r.Action -ne 0 -or $r.Direction -ne 2 -or $r.Protocol -ne 256 -or $r.RemoteAddresses -ne '*' -or $r.LocalAddresses -ne '*' -or $r.Profiles -ne 2147483647){throw 'Metadados da regra divergem; nenhuma alteracao.'}
if($PSCmdlet.ShouldProcess($expectedName,'Remover exclusivamente a protecao privada com servidor parado')){
 $trace=@{requested_utc=[DateTime]::UtcNow.ToString('o');rule=$r.Name;group=$r.Grouping;program=$r.ApplicationName;description=$r.Description;postgres_processes_in_bench=0;pg_ctl_status_exit=3}
 $state|Add-Member -NotePropertyName protection_cleanup -NotePropertyValue $trace -Force
 $state|ConvertTo-Json -Depth 10|Set-Content -LiteralPath $StateFile -Encoding UTF8
 $fw.Rules.Remove($expectedName)
 if(@($fw.Rules|Where-Object Name -eq $expectedName).Count){throw 'Regra ainda presente; consulte estado privado.'}
 $state.protection_cleanup.removed_utc=[DateTime]::UtcNow.ToString('o')
 $state|ConvertTo-Json -Depth 10|Set-Content -LiteralPath $StateFile -Encoding UTF8
 Write-Output 'PRIVATE_RULE_REMOVED; logs, runtime, dados da bancada e dump preservados.'
}

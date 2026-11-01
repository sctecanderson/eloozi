[CmdletBinding()]
param([string]$CleanupState,[string]$ResumeState)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
Get-ChildItem Env: | Where-Object Name -Like 'PG*' | ForEach-Object { Remove-Item -LiteralPath ('Env:'+$_.Name) }
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if(-not $ResumeState -and -not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Execute em PowerShell como Administrador.'}
$base=Join-Path $env:LOCALAPPDATA 'Eloozi\PrivateRestoreBench'
function Save-State { $script:state | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $script:stateFile -Encoding UTF8 }
function Private-Directory($p){
 [void](New-Item -ItemType Directory -Path $p -Force)
 $acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetAccessRuleProtection($true,$false);$acl.SetOwner($identity.User)
 $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity.User,'FullControl','ContainerInherit,ObjectInherit','None','Allow'));Set-Acl -LiteralPath $p -AclObject $acl
}
function Run($exe,$arguments,$seconds=45,$allowFailure=$false){
 $tag=[guid]::NewGuid().ToString('N');$out=Join-Path $script:work "$tag.out";$err=Join-Path $script:work "$tag.err"
 $argsQuoted=($arguments | ForEach-Object {'"'+([string]$_).Replace('"','\"')+'"'}) -join ' '
 $p=Start-Process -FilePath $exe -ArgumentList $argsQuoted -PassThru -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err
 $processHandle=$p.Handle
 $script:state.last_child_pid=$p.Id;Save-State
 if(-not $p.WaitForExit($seconds*1000)){$p.Kill();throw "Timeout de $seconds segundos: $([IO.Path]::GetFileName($exe))"};$p.WaitForExit()
 $exitCode=$p.ExitCode
 if($null -eq $exitCode){throw 'Exit code indisponivel; consulte logs privados.'}
 $script:state.last_process=@{executable=$exe;exit_code=$exitCode;stdout=$out;stderr=$err};Save-State
 $result=(Get-Content $out -Raw -ErrorAction SilentlyContinue)+(Get-Content $err -Raw -ErrorAction SilentlyContinue)
 if($exitCode -ne 0 -and -not $allowFailure){throw "Processo falhou: $([IO.Path]::GetFileName($exe)); exit=$exitCode; consulte logs privados."}
 return $result
}
if($CleanupState){
 $stateFile=[IO.Path]::GetFullPath($CleanupState);$state=Get-Content -LiteralPath $stateFile -Raw|ConvertFrom-Json;$work=[IO.Path]::GetFullPath($state.work)
 if(-not $work.StartsWith(([IO.Path]::GetFullPath($base)+ '\'),[StringComparison]::OrdinalIgnoreCase) -or $stateFile -ne (Join-Path $work 'state.json')){throw 'Estado fora da bancada privada.'}
 $expected=Join-Path $work 'pgsql\bin\postgres.exe';if($state.program -ne $expected){throw 'Executável divergente.'}
 $running=@(Get-CimInstance Win32_Process -Filter "Name='postgres.exe'"|Where-Object ExecutablePath -eq $expected)
 if($running.Count){Run (Join-Path $work 'pgsql\bin\pg_ctl.exe') @('-D',(Join-Path $work 'data'),'-w','-t','20','stop','-m','fast') 30|Out-Null}
 if(@(Get-CimInstance Win32_Process -Filter "Name='postgres.exe'"|Where-Object ExecutablePath -eq $expected).Count){throw 'Processo privado ainda ativo; contenção preservada.'}
 $r=Get-NetFirewallRule -Name $state.rule -ErrorAction SilentlyContinue
 if($r){if(($r|Get-NetFirewallApplicationFilter).Program -ne $expected -or $r.Group -ne $state.group){throw 'Regra diverge.'};$r|Remove-NetFirewallRule}
 $state.phase='cleaned';Save-State
 Write-Output 'CLEANUP_PASS; regra removida; diretório privado retido para auditoria e remoção posterior.';exit
}
if($ResumeState){
 $stateFile=[IO.Path]::GetFullPath($ResumeState);$loaded=Get-Content -LiteralPath $stateFile -Raw|ConvertFrom-Json
 $work=[IO.Path]::GetFullPath($loaded.work)
 if(-not $work.StartsWith(([IO.Path]::GetFullPath($base)+'\'),[StringComparison]::OrdinalIgnoreCase) -or $stateFile -ne (Join-Path $work 'state.json')){throw 'Estado fora da bancada privada.'}
 $program=Join-Path $work 'pgsql\bin\postgres.exe';if($loaded.program -ne $program){throw 'Executavel divergente.'}
 $state=@{};foreach($prop in $loaded.PSObject.Properties){$state[$prop.Name]=$prop.Value}
 if($state.phase -ne 'failed-review-required'){throw 'Retomada exige estado de falha revisada.'}
 if((Get-Content -LiteralPath (Join-Path $work 'data\PG_VERSION') -Raw).Trim() -ne '17'){throw 'Cluster inicializado nao encontrado.'}
 $fw=New-Object -ComObject HNetCfg.FwPolicy2
 $r=@($fw.Rules|Where-Object Name -eq $state.rule)
 if($r.Count -ne 1 -or $r[0].ApplicationName -ne $program -or $r[0].Grouping -ne $state.group -or -not $r[0].Enabled -or $r[0].Action -ne 0 -or $r[0].Direction -ne 2 -or $r[0].RemoteAddresses -ne '*' -or $r[0].Protocol -ne 256){throw 'Regra privada ausente/divergente.'}
 foreach($profile in @(1,2,4)){if(-not $fw.FirewallEnabled($profile)){throw 'Perfil de firewall inativo.'}}
 if(Test-Path -LiteralPath (Join-Path $work 'data\postmaster.pid')){throw 'Cluster pode estar ativo; inspecione antes da retomada.'}
}else{
$id=[guid]::NewGuid().ToString();$work=Join-Path $base $id;Private-Directory $work
$stateFile=Join-Path $work 'state.json';$program=Join-Path $work 'pgsql\bin\postgres.exe'
$state=[ordered]@{version=1;work=$work;program=$program;rule="ElooziPrivate-$id";group="ElooziPrivate-$id";phase='planned';last_child_pid=0;external_test='pending';loopback='pending'};Save-State
}
Write-Host "Estado privado: $stateFile"
try{
 if(-not $ResumeState){
 Write-Host '1/5 Copiando runtime privado (bin/lib/share).'
 foreach($folder in @('bin','lib','share')){
  $dest=Join-Path $work "pgsql\$folder";[void](New-Item -ItemType Directory -Path $dest -Force)
  Run "$env:SystemRoot\System32\robocopy.exe" @("D:\pgSQL\$folder",$dest,'/E','/R:0','/W:0','/NFL','/NDL','/NJH','/NJS') 180 $true|Out-Null
 }
 if(-not(Test-Path $program)-or -not(Test-Path (Join-Path $work 'pgsql\lib\dblink.dll'))){throw 'Runtime privado incompleto.'}
 Write-Host '2/5 Controle TCP externo sem dados de aplicação: 1.1.1.1:443.'
 $tcp=[Net.Sockets.TcpClient]::new();try{$a=$tcp.BeginConnect('1.1.1.1',443,$null,$null);if(-not $a.AsyncWaitHandle.WaitOne(5000)){throw 'Controle externo indisponível; teste inconclusivo.'};$tcp.EndConnect($a)}finally{$tcp.Dispose()}
 $state.phase='rule-planned';Save-State
 Write-Host '3/5 Instalando regra somente no executável privado.'
 New-NetFirewallRule -Name $state.rule -DisplayName $state.rule -Group $state.group -Description "Eloozi private bench $id; state=$stateFile" -Program $program -Direction Outbound -Action Block -Profile Any -Enabled True|Out-Null
 $state.phase='rule-created';Save-State
 $active=Get-NetFirewallRule -Name $state.rule -PolicyStore ActiveStore
 if($active.Action -ne 'Block' -or $active.Direction -ne 'Outbound' -or $active.Enabled -ne 'True' -or ($active|Get-NetFirewallApplicationFilter).Program -ne $program){throw 'Regra efetiva diverge.'}
 if(@(Get-NetFirewallProfile -PolicyStore ActiveStore|Where-Object {-not $_.Enabled}).Count){throw 'Perfil de firewall desativado.'}
 $bin=Join-Path $work 'pgsql\bin';$data=Join-Path $work 'data'
 Run (Join-Path $bin 'initdb.exe') @('-D',$data,'-U','postgres','-A','trust','--encoding=UTF8','--no-locale') 60|Out-Null
 }
 $bin=Join-Path $work 'pgsql\bin';$data=Join-Path $work 'data'
 if($ResumeState){Write-Host 'Retomando cluster existente sem copiar runtime, criar regra ou repetir initdb.'}
 Add-Content (Join-Path $data 'postgresql.conf') "`nlc_messages='C'`n"
 Add-Content (Join-Path $data 'postgresql.conf') "`nlisten_addresses='127.0.0.1'`nport=55992`nstatement_timeout='8s'`n"
 $state.phase='starting-probe';Save-State
 Run (Join-Path $bin 'pg_ctl.exe') @('-D',$data,'-l',(Join-Path $work 'server.log'),'-w','-t','20','start') 30|Out-Null
 Write-Host '4/5 Testando loopback SQL e conexão externa pelo backend privado.'
 $sql="select 1; create extension if not exists dblink; select dblink_connect('hostaddr=1.1.1.1 port=443 dbname=postgres connect_timeout=3 sslmode=disable gssencmode=disable');"
 $result=Run (Join-Path $bin 'psql.exe') @('-X','-w','-h','127.0.0.1','-p','55992','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-At','-c',$sql) 15 $true
 if($result -notmatch '(?m)^1\r?$'){throw 'Loopback não comprovado.'};$state.loopback='pass';Save-State
 $socketDenied=($state.last_process.exit_code -eq 1 -and $result -match 'connection to server at "1\.1\.1\.1", port 443 failed:[^\r\n]*\(0x0000271D/10013\)')
 if(-not $socketDenied -and $result -notmatch '(?i)connection timed out|timeout expired|forbidden by its access permissions'){throw 'Bloqueio externo não comprovado; consulte logs privados.'}
 $state.external_test='pass-control-reachable-backend-connect-blocked';Save-State
 Run (Join-Path $bin 'pg_ctl.exe') @('-D',$data,'-w','-t','20','stop','-m','fast') 30|Out-Null
 $state.phase='contained-ready';Save-State
 Write-Host "CONTAINMENT_PASS Estado=$stateFile"
 Write-Host '5/5 Probe parado; regra privada mantida. Nenhum dump foi restaurado.'
 Write-Host "Limpeza: powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -CleanupState `"$stateFile`""
}catch{
 if($state.Contains('last_process')){$state.failure_process=$state.last_process;Save-State}
 # Preserve the containment rule while stopping only this private cluster.
 if($program -eq (Join-Path $work 'pgsql\bin\postgres.exe') -and (Test-Path -LiteralPath (Join-Path $work 'data\postmaster.pid'))){
  try{Run (Join-Path $work 'pgsql\bin\pg_ctl.exe') @('-D',(Join-Path $work 'data'),'-w','-t','20','stop','-m','fast') 30|Out-Null}catch{Write-Warning 'Parada privada falhou; protecao mantida. Consulte estado e logs.'}
 }
 $state.phase='failed-review-required';Save-State
 Write-Host "FALHA: $($_.Exception.Message) Estado: $stateFile"
 Write-Host 'Recursos privados e eventual regra foram preservados; use CleanupState para limpeza rastreável.'
 throw
}

[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$manifest=Get-Content -LiteralPath (Join-Path $repo 'docs\principal-cutover-manifest-20261031.json') -Raw|ConvertFrom-Json
if($manifest.project_ref -ne 'llhujxzefujdsthpezag' -or @($manifest.handlers).Count -ne 4){throw 'Manifesto inesperado.'}
foreach($f in $manifest.handlers){
 if($f.path -notmatch '^supabase/functions/asaas-(checkout|webhook)/(handler|index)\.ts$'){throw 'Arquivo inesperado.'}
 if((Get-FileHash -LiteralPath (Join-Path $repo $f.path) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $f.sha256){throw ('Hash diverge: '+$f.path)}
}
$stage=Join-Path $env:LOCALAPPDATA ('Eloozi\CutoverPhase1\'+[guid]::NewGuid().ToString())
[void](New-Item -ItemType Directory -Path $stage)
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetAccessRuleProtection($true,$false);$acl.SetOwner($sid)
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'));Set-Acl -LiteralPath $stage -AclObject $acl
$actual=Get-Acl -LiteralPath $stage
if(-not $actual.AreAccessRulesProtected -or $actual.Access.Count -ne 1 -or $actual.Access[0].IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'ACL privada nao confirmada.'}
foreach($f in $manifest.handlers){$dest=Join-Path $stage $f.path;[void](New-Item -ItemType Directory -Path (Split-Path $dest) -Force);Copy-Item -LiteralPath (Join-Path $repo $f.path) -Destination $dest;if((Get-FileHash $dest -Algorithm SHA256).Hash.ToLowerInvariant() -ne $f.sha256){throw 'Copia divergente.'}}
@'
project_id = "llhujxzefujdsthpezag"
[functions.asaas-checkout]
verify_jwt = true
[functions.asaas-webhook]
verify_jwt = false
'@|Set-Content -LiteralPath (Join-Path $stage 'supabase\config.toml') -Encoding ASCII
$requests=@()
foreach($name in @('asaas-checkout','asaas-webhook')){
 $files=@($manifest.handlers|Where-Object {$_.path -like "supabase/functions/$name/*"}|ForEach-Object {@{name=[IO.Path]::GetFileName($_.path);content_from_verified_local_file=(Join-Path $stage $_.path);sha256=$_.sha256}})
 $payload=@{project_id=$manifest.project_ref;name=$name;entrypoint_path='index.ts';verify_jwt=($name -eq 'asaas-checkout');files=@($files|ForEach-Object {@{name=$_.name;content=[IO.File]::ReadAllText($_.content_from_verified_local_file,[Text.Encoding]::UTF8)}})}
 $payloadFile=Join-Path $stage ('deploy-'+$name+'.json')
 [IO.File]::WriteAllText($payloadFile,($payload|ConvertTo-Json -Depth 7),[Text.UTF8Encoding]::new($false))
 $requests+=@{tool='supabase_deploy_edge_function';tool_payload_file=$payloadFile;project_id=$manifest.project_ref;name=$name;entrypoint_path='index.ts';verify_jwt=($name -eq 'asaas-checkout');files=$files}
}
@{status='PREPARED_NOT_AUTHORIZED_NOT_DEPLOYED';project_ref=$manifest.project_ref;prepared_utc=[DateTime]::UtcNow.ToString('o');stage=$stage;handlers=$manifest.handlers;deployment_requests=$requests}|ConvertTo-Json -Depth 9|Set-Content -LiteralPath (Join-Path $stage 'phase1-stage.json') -Encoding UTF8
Write-Output ('PHASE1_LOCAL_STAGE_READY '+$stage)
Write-Output 'Quatro hashes conferidos. Nenhum comando remoto executado.'

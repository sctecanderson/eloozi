[CmdletBinding()]
param([switch]$ApplyApprovedPause,[Parameter(Mandatory=$true)][string]$ReceiptFile)
$ErrorActionPreference='Stop'
if(-not $ApplyApprovedPause){throw 'Preparado apenas. Execute somente depois de autorizacao especifica da fase 1.'}
$ReceiptFile=[IO.Path]::GetFullPath($ReceiptFile)
$privateBase=[IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Eloozi\CutoverPhase1'))+'\'
if(-not $ReceiptFile.StartsWith($privateBase,[StringComparison]::OrdinalIgnoreCase) -or -not(Test-Path -LiteralPath (Split-Path $ReceiptFile))){throw 'Receipt deve ficar no stage privado existente.'}
$ref='llhujxzefujdsthpezag';$secure=$null;$bstr=[IntPtr]::Zero;$plain=$null;$headers=$null;$step='hidden_token'
try{
 $secure=Read-Host 'Token Supabase Management API (oculto; somente neste terminal)' -AsSecureString
 if(-not $secure -or $secure.Length -eq 0){throw 'Token vazio.'}
 $bstr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure);$plain=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
 $headers=@{Authorization='Bearer '+$plain}
 $step='confirm_project';$project=Invoke-RestMethod -Method Get -Uri "https://api.supabase.com/v1/projects/$ref" -Headers $headers -TimeoutSec 25
 if($project.id -ne $ref -or $project.name -ne 'Eloozi'){throw 'Projeto nao corresponde ao principal.'}
 $step='check_configuration_names';$secrets=Invoke-RestMethod -Method Get -Uri "https://api.supabase.com/v1/projects/$ref/secrets" -Headers $headers -TimeoutSec 25
 $names=@($secrets|ForEach-Object name)
 foreach($name in @('ASAAS_API_KEY','ASAAS_WEBHOOK_TOKEN')){if($name -notin $names){$step='missing_'+$name;throw 'Configuracao ausente.'}}
 if('ASAAS_BASE_URL' -notin $names -and 'ASAAS_API_BASE_URL' -notin $names){$step='missing_explicit_ASAAS_BASE_URL_or_ASAAS_API_BASE_URL';throw 'URL Asaas explicita ausente; configurar pelo canal protegido antes de publicar handlers.'}
 $step='pause_write_ack_unknown'
 @{project_ref=$ref;operation='set BILLING_ISSUANCE_PAUSED=true only';utc=[DateTime]::UtcNow.ToString('o');status='WRITE_INTENT_ACK_UNKNOWN'}|ConvertTo-Json|Set-Content -LiteralPath $ReceiptFile -Encoding UTF8
 $response=Invoke-WebRequest -UseBasicParsing -Method Post -Uri "https://api.supabase.com/v1/projects/$ref/secrets" -Headers $headers -ContentType 'application/json' -Body '[{"name":"BILLING_ISSUANCE_PAUSED","value":"true"}]' -TimeoutSec 25
 if($response.StatusCode -ne 201){throw 'Gravacao da flag nao confirmada por HTTP 201.'}
 @{project_ref=$ref;operation='set BILLING_ISSUANCE_PAUSED=true only';ack_http=201;utc=[DateTime]::UtcNow.ToString('o');status='FLAG_WRITE_ACK_ONLY_NOT_PROOF_OF_EFFECTIVE_PAUSE';config_names_checked=@('ASAAS_API_KEY','ASAAS_WEBHOOK_TOKEN','ASAAS_BASE_URL or ASAAS_API_BASE_URL')}|ConvertTo-Json -Depth 4|Set-Content -LiteralPath $ReceiptFile -Encoding UTF8
 Write-Output 'PAUSE_FLAG_WRITE_ACK; isto nao comprova pausa na versao antiga nem drenagem.'
}catch{
 # Never echo request headers, token, response body or a raw HTTP exception.
 Write-Output ('PHASE1_PAUSE_FAILED step='+$step+'; nenhuma repeticao automatica. Falha depois do POST pode ter resultado remoto desconhecido; nao interpretar como flag ausente.')
 throw 'Nao prosseguir com deploy sem confirmar a flag e a configuracao.'
}finally{
 if($headers){$headers.Clear()};$plain=$null
 if($bstr -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)}
 if($secure){$secure.Dispose()}
}

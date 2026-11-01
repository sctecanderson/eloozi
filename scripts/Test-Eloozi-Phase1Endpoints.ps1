[CmdletBinding()]
param([switch]$AfterDeploymentAuthorization,[switch]$CheckoutOnly,[Parameter(Mandatory=$true)][string]$ReceiptFile)
$ErrorActionPreference='Stop'
if(-not $AfterDeploymentAuthorization){throw 'Executar somente depois da autorizacao especifica e publicacao dos handlers pausados.'}
$ReceiptFile=[IO.Path]::GetFullPath($ReceiptFile)
$base=[IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Eloozi\CutoverPhase1'))+'\'
if(-not $ReceiptFile.StartsWith($base,[StringComparison]::OrdinalIgnoreCase) -or -not(Test-Path -LiteralPath (Split-Path $ReceiptFile))){throw 'Receipt deve ficar no stage privado.'}
function Read-PrivateValue($label){$s=Read-Host $label -AsSecureString;$p=[IntPtr]::Zero;try{if(-not $s){return ''};$p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($p)}finally{if($p -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p)};if($s){$s.Dispose()}}}
function Jwt-Payload([string]$token){
 if([string]::IsNullOrWhiteSpace($token)){throw 'Token JWT vazio ou nao informado (falha de formato).'}
 $parts=$token.Trim().Split('.')
 if($parts.Length -lt 2 -or [string]::IsNullOrWhiteSpace($parts[1])){throw 'Token JWT malformado: nao contem as secoes separadas por ponto (falha de formato).'}
 $part=$parts[1].Replace('-','+').Replace('_','/')
 while($part.Length%4){$part+='='}
 try{
  $bytes=[Convert]::FromBase64String($part)
  $json=[Text.Encoding]::UTF8.GetString($bytes)
  $parsed=$json|ConvertFrom-Json
  if(-not $parsed){throw 'Payload JSON nulo'}
  return $parsed
 }catch{
  throw 'Token JWT invalido: payload Base64/JSON corrompido (falha de formato).'
 }
}
function Post-Probe($url,$headers,$body){
 try{$r=Invoke-WebRequest -UseBasicParsing -Uri $url -Method Post -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 25;return @{status=[int]$r.StatusCode;body=($r.Content|ConvertFrom-Json);request_id=$r.Headers['sb-request-id']}}
 catch{if(-not $_.Exception.Response){throw 'Falha de transporte; sem repeticao automatica.'};$r=$_.Exception.Response;$reader=[IO.StreamReader]::new($r.GetResponseStream());try{$text=$reader.ReadToEnd()}finally{$reader.Dispose()};try{$json=$text|ConvertFrom-Json}catch{$json=$null};return @{status=[int]$r.StatusCode;body=$json;request_id=$r.Headers['sb-request-id']}}
}
$jwt=$null;$key=$null;$webhookToken=$null;$userHeaders=$null;$webhookHeaders=$null
$receipt=@{project_ref='llhujxzefujdsthpezag';started_utc=[DateTime]::UtcNow.ToString('o');probes=@();status='pending';drainage='not_tested';gateway_confirmation='not_tested'}
function Record-Probe($name,$result,$pass){$receipt.probes+=@{name=$name;http=$result.status;passed=[bool]$pass;request_id=$result.request_id;utc=[DateTime]::UtcNow.ToString('o')};$receipt|ConvertTo-Json -Depth 6|Set-Content -LiteralPath $ReceiptFile -Encoding UTF8;if(-not $pass){throw "Probe $name falhou com HTTP $($result.status); interromper sem usar payload de cobranca valido."}}
try{
 $key=Read-PrivateValue 'Publishable/anon key do principal (oculta)'
 if([string]::IsNullOrWhiteSpace($key)){throw 'Chave anon key nao informada ou vazia (falha de formato).'}
 $key=$key.Trim()
 if($key.StartsWith('sb_secret_')){throw 'Secret key nao permitida neste teste.'}
 if($key.StartsWith('ey')){
  $keyClaims=Jwt-Payload $key
  if($keyClaims.role -ne 'anon'){throw 'Chave apikey JWT deve possuir role "anon"; service_role nao permitido (falha de tipo de sessao).'}
 }
 $jwt=Read-PrivateValue 'JWT de sessao normal autenticada do principal (oculto)'
 if([string]::IsNullOrWhiteSpace($jwt)){throw 'JWT de sessao nao informado ou vazio (falha de formato: entrada vazia).'}
 $jwt=$jwt.Trim()
 $claims=Jwt-Payload $jwt
 if($claims.iss -ne 'https://llhujxzefujdsthpezag.supabase.co/auth/v1'){throw 'Validacao do JWT falhou: emissor (iss) nao corresponde ao projeto principal llhujxzefujdsthpezag (falha de projeto).'}
 if($claims.role -ne 'authenticated' -or $claims.is_anonymous -eq $true){throw 'Validacao do JWT falhou: token nao e sessao autenticada de usuario (role deve ser "authenticated" e nao-anonimo) (falha de tipo de sessao).'}
 if(-not $claims.exp){throw 'Validacao do JWT falhou: claim de expiracao (exp) ausente no token (falha de formato).'}
 $nowUnix=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
 if([long]$claims.exp -le $nowUnix){throw 'Validacao do JWT falhou: sessao expirada (falha de expiracao).'}
 $userHeaders=@{apikey=$key;Authorization='Bearer '+$jwt}
 $url='https://llhujxzefujdsthpezag.supabase.co/functions/v1/'
 $r=Post-Probe ($url+'asaas-checkout') $userHeaders '{"action":"checkout"}'
 Record-Probe 'checkout_paused' $r ($r.status -eq 503 -and $r.body.billing_paused -eq $true)
 $r=Post-Probe ($url+'asaas-checkout') $userHeaders '{"action":"verify_payment"}'
 Record-Probe 'verification_not_paused_missing_invoice' $r ($r.status -eq 400 -and $r.body.error -like 'invoiceId*')
 if($CheckoutOnly){$receipt.status='CHECKOUT_PAUSE_BOUNDARY_PASS_NOT_DRAINAGE';$receipt.finished_utc=[DateTime]::UtcNow.ToString('o');$receipt|ConvertTo-Json -Depth 6|Set-Content -LiteralPath $ReceiptFile -Encoding UTF8;Write-Output 'CHECKOUT_PAUSE_BOUNDARY_PASS; drenagem e demais endpoints nao testados.';return}
 $r=Post-Probe ($url+'asaas-webhook') @{} '{}'
 Record-Probe 'webhook_rejects_missing_own_token' $r ($r.status -eq 401 -and $r.body.error -like 'Token de webhook*')
 $webhookToken=Read-PrivateValue 'ASAAS_WEBHOOK_TOKEN existente (oculto; nunca no chat)'
 $webhookHeaders=@{'asaas-access-token'=$webhookToken}
 $r=Post-Probe ($url+'asaas-webhook') $webhookHeaders '{}'
 Record-Probe 'webhook_own_token_reaches_payload_validation' $r ($r.status -eq 400 -and $r.body.error -like 'Payload de webhook*')
 $receipt.status='HTTP_BOUNDARIES_PASS_NOT_DRAINAGE_OR_GATEWAY_CONFIRMATION';$receipt.finished_utc=[DateTime]::UtcNow.ToString('o')
 $receipt|ConvertTo-Json -Depth 6|Set-Content -LiteralPath $ReceiptFile -Encoding UTF8
 Write-Output 'PHASE1_HTTP_BOUNDARIES_PASS; quatro probes; sem invoice/payment valido ou consulta ao gateway.'
}finally{
 if($userHeaders){$userHeaders.Clear()};if($webhookHeaders){$webhookHeaders.Clear()}
 $jwt=$null;$key=$null;$webhookToken=$null;$claims=$null
}

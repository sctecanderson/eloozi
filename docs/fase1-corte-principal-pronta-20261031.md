# Fase 1 pronta para autorização específica — 31/10/2026

**PREPARADA, NÃO AUTORIZADA, NÃO EXECUTADA.** Alvo único `llhujxzefujdsthpezag` / Eloozi. Não houve gravação de secrets, deploy, chamada de checkout/webhook, Asaas, migration ou repair nesta preparação. A fase termina com emissão ainda pausada e backup novo restaurado localmente; não autoriza frontend nem retomada financeira.

Este documento operacionaliza somente a primeira fase do roteiro aprovado em `docs/roteiro-final-principal-20261031.md`. As 19 migrations e a reconciliação de histórico ficam integralmente fora desta fase.

## Material congelado

Stage privado já criado, ACL protegida apenas para o usuário:

```powershell
$Stage = "$env:LOCALAPPDATA\Eloozi\CutoverPhase1\2b997de9-d265-4b30-8c89-b01920565e8f"
```

`phase1-stage.json` registra projeto, quatro fontes e requisições. Os dois arquivos `deploy-asaas-checkout.json` e `deploy-asaas-webhook.json` contêm os argumentos completos do conector, incluindo o conteúdo das fontes; não foram enviados. Há somente `index.ts` e `handler.ts` de cada função, mais configuração isolada; não se usa `.env.local`, vínculo CLI ou arquivos de frontend do repositório.

| Fonte | Bytes | SHA-256 dos bytes locais e copiados |
|---|---:|---|
| supabase/functions/asaas-checkout/handler.ts | 48097 | d859f3a2a25a86bd657d12eea171d163bd3583739181c541a7ada1d75dfd8f72 |
| supabase/functions/asaas-checkout/index.ts | 812 | 3288a91bf3934456516367162a6bb71f8888392064c201de7ea6c05023afeaa8 |
| supabase/functions/asaas-webhook/handler.ts | 10503 | 0b9b227c98ddf464fdec5e7f0af044a7d6559a89a687d57f0fe1b4f2ba855dc7 |
| supabase/functions/asaas-webhook/index.ts | 717 | 8d9ce438620ea70fbb1f8b6027990af4ccd3fe6154587c05d6352ad464869b12 |

Leitura hospedada nesta preparação: checkout e webhook continuam versão **7**, `verify_jwt=true` e `false`, respectivamente. Fontes atuais e metadados foram preservados em `$Stage\rollback-v7`, sem secrets. O hash de bundle informado pela plataforma é diferente conceitualmente do hash de cada fonte; não compará-los como se fossem a mesma coisa. A cópia v7 é evidência de recuperação/comparação, não autorização para republicá-la.

## Configuração exigida — somente nomes

| Nome | Tratamento |
|---|---|
| SUPABASE_URL | Runtime do próprio principal; não substituir por testes |
| SUPABASE_ANON_KEY | Runtime; checkout usa autenticação normal |
| SUPABASE_SERVICE_ROLE_KEY | Somente runtime servidor; nunca no probe ou frontend |
| ASAAS_API_KEY | Preservar credencial existente, sem rotação nesta fase |
| ASAAS_BASE_URL | Endpoint explícito correspondente à credencial existente |
| ASAAS_API_BASE_URL | Alias aceito; ASAAS_BASE_URL tem precedência |
| ASAAS_WEBHOOK_TOKEN | Preservar token existente; webhook valida esse token |
| BILLING_ISSUANCE_PAUSED | Gravar literalmente **true** antes da publicação |

Conferir pelo canal protegido a coerência do endpoint/ambiente Asaas já usado. Não mudar credencial, conta, endpoint do provedor ou webhook no Asaas nesta fase. Listar nomes de secrets não comprova valores corretos, e os probes não comprovam autenticação no gateway. Se faltar URL explícita ou configuração necessária, parar antes do deploy e resolver a configuração sob autorização específica, sem mostrar valores no chat.

O CLI não está disponível nesta máquina; **não é requisito instalá-lo**. O caminho preparado usa PowerShell nativo para a flag e o conector Supabase para as duas publicações. Não instalar Docker/WSL ou alterar o vínculo de testes.

## Sequência exata após autorização

### 1. Preflight e intenção de pausa

Reconfirmar em leitura o projeto, as versões hospedadas e os quatro hashes. Divergência exige revisão; não sobrescrever silenciosamente a preparação. Confirmar responsáveis pela janela, emissores alternativos e retenção/reentrega de pagamentos em trânsito. Não assumir que todos os produtores são controlados pela flag sem inventário. Manter registros detalhados privados.

Em PowerShell normal, sem transcript, com token Management API digitado apenas no prompt oculto:

```powershell
Set-Location 'D:\PROJETOS\Eloozi'
$Stage = "$env:LOCALAPPDATA\Eloozi\CutoverPhase1\2b997de9-d265-4b30-8c89-b01920565e8f"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/Set-Eloozi-Phase1Pause.ps1 -ApplyApprovedPause -ReceiptFile "$Stage\pause-write-receipt.json"
if ($LASTEXITCODE -ne 0) { throw 'PARAR: flag/configuração não confirmadas.' }
```

O script GET confirma `id` e nome do principal, lista somente nomes internamente e exige configurações Asaas. O único POST é `https://api.supabase.com/v1/projects/llhujxzefujdsthpezag/secrets`, corpo `[{'name':'BILLING_ISSUANCE_PAUSED','value':'true'}]` em JSON válido no script. Esperado HTTP 201. Token nunca vai em linha de comando, arquivo ou variável de ambiente; memória não gerenciada é limpa no finally. Timeout de 25s, sem repetição automática. Registra intenção antes do POST; perda de resposta deixa resultado desconhecido, não significa flag ausente.

**HTTP 201 não pausa a versão 7**, que ignora a flag. Entre essa gravação e a troca/drenagem ainda pode existir execução antiga. Não declarar corte estabelecido nem avançar para backup de corte por causa desse ACK.

### 2. Publicar checkout pausado, depois webhook compatível

Revalidar os hashes imediatamente antes de enviar. Operações exatas do conector Supabase, uma de cada vez, usando integralmente o JSON privado indicado:

| Ordem | Ferramenta | Arquivo de argumentos | Alvo/entrada/flags |
|---:|---|---|---|
| 1 | supabase_deploy_edge_function | `$Stage\deploy-asaas-checkout.json` | project_id=llhujxzefujdsthpezag; name=asaas-checkout; entrypoint_path=index.ts; verify_jwt=true; files=index.ts,handler.ts |
| 2 | supabase_deploy_edge_function | `$Stage\deploy-asaas-webhook.json` | mesmo project_id; name=asaas-webhook; entrypoint_path=index.ts; verify_jwt=false; files=index.ts,handler.ts |

Não enviar os caminhos como conteúdo: os JSONs já contêm os textos completos das fontes verificadas. Não publicar outras funções. Após cada publicação, ler definição/versão/flags hospedadas, comparar conteúdo das fontes ou diferenças de empacotamento justificadas, registrar versão, deployment ID quando fornecido e horário. Não exigir igualdade de um bundle remoto com SHA de fonte local.

Antes de publicar o webhook, comprovar o probe `checkout_paused`:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/Test-Eloozi-Phase1Endpoints.ps1 -AfterDeploymentAuthorization -CheckoutOnly -ReceiptFile "$Stage\checkout-pause-probe.json"
if ($LASTEXITCODE -ne 0) { throw 'PARAR antes de publicar webhook.' }
```

Se falhar, parar, manter flag e preservar webhook atual. O checkout novo devolve 503 antes de reservar fatura/claim/fetch de emissão; `verify_payment` fica fora desse bloqueio. O webhook usa seu próprio token, portanto `verify_jwt=false` é intencional e não significa endpoint sem autenticação.

Após as duas publicações, executar os quatro probes abaixo. Nunca usar payload válido de contratação. O script agregado abaixo é para depois dos dois deploys.

### 3. Aceitação HTTP sem gateway

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/Test-Eloozi-Phase1Endpoints.ps1 -AfterDeploymentAuthorization -ReceiptFile "$Stage\http-probes.json"
if ($LASTEXITCODE -ne 0) { throw 'PARAR: aceitação HTTP incompleta.' }
```

Entradas ocultas: public/anon key, JWT normal autenticado não anônimo do principal e token existente do webhook. Não usar service_role para demonstrar acesso. O servidor valida a sessão; a inspeção local de claims é apenas guarda adicional. O script faz uma única tentativa por probe, timeout 25s, e registra somente status, horário, resultado e request ID quando fornecido, sem corpos ou headers.

| Probe | POST/JSON | Esperado |
|---|---|---|
| checkout_paused | /functions/v1/asaas-checkout; `{"action":"checkout"}` | 503, billing_paused=true |
| verification_not_paused_missing_invoice | mesmo endpoint; `{"action":"verify_payment"}` | 400, erro invoiceId ausente; não 503 de pausa |
| webhook_rejects_missing_own_token | /functions/v1/asaas-webhook; `{}`, sem token | 401 do guard de token do handler |
| webhook_own_token_reaches_payload_validation | mesmo endpoint; `{}`, com token correto | 400, payload inválido |

Não há restaurantId, invoiceId, paymentId, plano válido ou evento confirmado nesses probes. Portanto eles não emitem, não quitam e não consultam Asaas. São testes de fronteira HTTP/configuração, **não E2E de confirmação**. Não fabricar PAYMENT_CONFIRMED ou marcar paid por UPDATE.

Compatibilidade antes do SQL: os handlers tentam confirmação quatro-args e só usam a antiga quando a assinatura falta (PGRST202/42883). Erros reais de autorização, transporte ou estado não viram fallback. Fatura com referência previamente persistida pode usar a confirmação antiga; pagamento cuja referência não foi persistida pode exigir attach RPC ainda inexistente e retornar 503 retryable/payment_received. Não aplicar essa RPC nesta fase, não descartar o pagamento nem fingir confirmação concluída. Registrar a pendência privada e garantir retenção/reentrega; sem esse procedimento, parar a fase. Pagamentos legítimos podem continuar pelo fluxo já existente; qualquer validação observada deve ser identificada como tal, sem gerar cobrança para testar.

### 4. Provar drenagem — gate separado

Registrar versões antigas e novas, momento de troca de roteamento, cobertura temporal da telemetria e identificadores de execução/deployment realmente disponíveis. A consulta de descoberta em leitura preparada para os logs unificados é:

```sql
SELECT source, arrayJoin(mapKeys(log_attributes)) AS attribute_name, count() AS n
FROM logs
WHERE source IN ('function_edge_logs', 'function_logs', 'functions_logs')
GROUP BY source, attribute_name
ORDER BY source, attribute_name;
```

Nesta preparação retornou vazio: isso **não significa zero execuções**. Não inventar nomes de atributos nem escrever filtro por versão até identificar os campos reais. Depois da publicação, correlacionar Invocations e logs de runtime com as versões/deployments, inícios e conclusões/shutdown disponíveis. Se não houver evidência suficiente, obter observabilidade/suporte do provedor e manter `DRAINAGE_UNKNOWN`; não avançar por silêncio dos logs.

PASS exige: roteamento das novas requisições para o checkout pausado; nenhum escritor alternativo emitindo; todas as execuções antigas capazes de emitir com término comprovado; nenhuma execução antiga ativa; e toda emissão em trânsito com desfecho conhecido ou retenção/reconciliação identificada, sem reemissão. Capturar as evidências privadas, sem tokens/dados pessoais em relatório.

O limite publicado de duração de worker é 150s no plano Free e 400s nos planos pagos; idle timeout de requisição é outra medida. Não assumir o plano nem usar espera cega de 400s como prova: worker pode tratar várias requisições, e faltam cobertura/último início/roteamento. Uma resposta 503 isolada ou metadata ACTIVE também não prova drenagem global. Se não for possível demonstrar esses critérios, a fase permanece parcialmente executada, com emissão pausada, e o backup de corte ainda não é iniciado.

### 5. Backup novo e restauração, só após os gates

Preservar backup de 16:00:51Z e seu hash; não sobrescrever. Em terminal normal, executar o exportador já utilizado, com senha oculta:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Temp\Eloozi-Backup-Principal.ps1"
if ($LASTEXITCODE -ne 0) { throw 'PARAR: novo backup falhou.' }
```

Ele aponta ao Session pooler oficial do principal, porta 5432, db postgres, usuário postgres.llhujxzefujdsthpezag, SSL obrigatório. Não usa transaction pooler. Confirma ref, ACL privada e hash, limpa credenciais no finally. Nenhuma senha deve ir ao chat ou histórico.

Usar o caminho **real retornado por essa execução**, sem adivinhar o último arquivo:

```powershell
$NewMetadata = Read-Host 'Caminho do backup-metadata.json recém-gerado'
$Meta = Get-Content -LiteralPath $NewMetadata -Raw -Encoding UTF8 | ConvertFrom-Json
if ($Meta.project_ref -ne 'llhujxzefujdsthpezag') { throw 'Projeto incorreto.' }
$NewDump = Join-Path (Split-Path $NewMetadata) $Meta.backup_file_name
$NewSHA = (Get-FileHash -LiteralPath $NewDump -Algorithm SHA256).Hash.ToLowerInvariant()
if ($NewSHA -ne $Meta.archive_sha256) { throw 'Hash do archive diverge.' }
$Bench = "$env:LOCALAPPDATA\Eloozi\PrivateRestoreBench\3d1bf2ea-a25f-4c8e-85a4-d0bd26fee92e"
$State = Join-Path $Bench 'state.json'
$Archive = Join-Path $Bench ('restore-review-approved-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))
if (Test-Path -LiteralPath $Archive) { throw 'Pasta de preservação já existe.' }
Copy-Item -LiteralPath (Join-Path $Bench 'restore-review') -Destination $Archive -Recurse -ErrorAction Stop
foreach ($Old in Get-ChildItem -LiteralPath (Join-Path $Bench 'restore-review') -Recurse -File) {
  $Relative = $Old.FullName.Substring((Join-Path $Bench 'restore-review').Length).TrimStart('\')
  if ((Get-FileHash -LiteralPath $Old.FullName).Hash -ne (Get-FileHash -LiteralPath (Join-Path $Archive $Relative)).Hash) { throw 'Preservação dos logs diverge.' }
}
node scripts/restore-private-principal.mjs "$State" "$NewMetadata" "--expected-sha256=$NewSHA" --restore-only
if ($LASTEXITCODE -ne 0) { throw 'PARAR: restauração/verificação incompleta; consultar logs privados.' }
```

Executar como usuário normal: não iniciar PostgreSQL sob token administrativo. Não criar bancada, repetir initdb nem remover a regra. O runner valida novamente regra/executável/evidência de contenção, inspeciona TOC/dependências e restaura na bancada existente. `--restore-only` não aplica as 19 migrations. O modo novo foi conferido sintaticamente, mas só poderá ser validado funcionalmente com o novo archive; não apresentá-lo como teste já passado.

Aceitar somente pg_restore exit 0, hashes/contagens/definições/RLS/grants/histórico comparados com o novo archive, diferenças justificadas individualmente, banco restaurado removido após sucesso e cluster parado no finally. Verificar em especial contratos/legacy/trials/ciclos/faturas/reservas/mesas/visitas/comandas. Dados podem mudar durante o export consistente; snapshot do archive é a referência, não uma comparação posterior sem snapshot no principal. Não repetir o ensaio de migrations sem mudança que o justifique.

Adaptações já conhecidas continuam explícitas: roles NOLOGIN locais sem equivalência de atributos/senhas/memberships; supabase_vault indisponível; sete event triggers gerenciados omitidos; serviços gerenciados e integrações externas não instalados. Reavaliar diferenças do archive novo, sem ocultá-las ou aceitar novas omissões genericamente. Storage binário, secrets Edge, configuração da plataforma e login gerenciado não são recuperados por esse dump. Sucesso local não é recuperação integral do Supabase.

## Parada e recuperação desta fase

- Ref/hash/configuração divergente, probe inesperado, evento sem retenção, emissão nova após pausa declarada ou drenagem não demonstrada: interromper sequência, manter flag true, registrar estado e não iniciar SQL.
- Deploy com resposta incerta: ler versão/fontes/flags hospedadas antes de decidir qualquer nova publicação. Não repetir emissão ou confirmação para testar.
- Checkout com falha: manter bloqueado e corrigir/republicar versão compatível após revisão. **Não republicar checkout v7**, que ignora a pausa. Não escrever BILLING_ISSUANCE_PAUSED=false nem apagar a flag.
- Webhook/verificação com falha: preservar eventos e pagamentos, registrar IDs apenas em área privada e manter tratamento/reentrega. Corrigir o handler compatível; v7 preservada é referência, não rollback automático. Não responder sucesso artificial, apagar evento, marcar paid, criar substituta ou acrescentar ciclo. Não mexer nas configurações Asaas.
- Falha no backup/restore: manter original e novo archive, logs e regra; runner encerra somente cluster privado em finally. Não restaurar o principal nem remover contenção com processo ativo. Diagnosticar nova diferença localmente; não avançar para migrations.

Não há down/restore remoto nesta fase. Retomada de emissão, SQL, história e frontend exigem outras autorizações. Para retirar proteção local ao final de todos os usos, usar somente o removedor rastreável já preparado após status parado/zero processos; **não removê-la antes da verificação do backup novo**.

## O que foi realmente validado nesta preparação

Quatro fontes/stage e payloads locais comparados por SHA-256; parser PowerShell dos três scripts PASS; leitura atual de ambas as funções hospedadas v7 e preservação privada de fontes; cluster privado sem processos, state parado; assinatura da regra exigida pelo runner e perfis de firewall conferidos pela interface COM usada pelo runner. A tentativa Get-NetFirewallRule retornou acesso negado, sem alteração; a conferência COM posterior passou. Evidência funcional anterior permanece: loopback passou, socket externo do backend negado com 10013; filtro individual causador não isolado. Não houve nova tentativa externa.

Logs disponíveis consultados somente em leitura não forneceram atributos/execuções de funções nessa busca. Pausa, publicação, probes hospedados, drenagem, backup novo e restauração nova continuam **não executados**. Não repetir npm/typecheck/build ou ensaio SQL já aprovado para esta preparação de scripts/documentação, sem mudança de aplicação.

Referências oficiais consultadas: [Management API — secrets](https://supabase.com/docs/reference/api/v1-bulk-create-secrets), [CLI deploy com bundle por API](https://supabase.com/docs/reference/cli/supabase-functions-deploy), [limites de Edge Functions](https://supabase.com/docs/guides/functions/limits), [logs](https://supabase.com/docs/guides/functions/logging).

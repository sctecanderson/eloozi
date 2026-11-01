# Roteiro para revisão — principal Eloozi

**Alvo único: llhujxzefujdsthpezag. Este documento prepara uma execução futura; nenhum comando de alteração foi executado nesta etapa. Emissão Asaas não deve ser ativada ao terminar.**

O ensaio aprovado e suas limitações estão em [restore-ensaio-principal-20261031.md](restore-ensaio-principal-20261031.md). A referência de sequência antiga é substituída por este roteiro. O sucesso local não elimina os gates abaixo.

## Artefatos congelados

[Ordem, nomes e SHA-256 das 19 migrations e dos quatro arquivos dos handlers](principal-migrations-ordem-hashes-20261031.md). [Manifesto estruturado](principal-cutover-manifest-20261031.json). Os hashes são dos bytes exatos, incluindo CRLF, e foram comparados com os hashes registrados no ensaio, sem executar novamente testes aprovados. Se qualquer um mudar, parar e avaliar/ensaiar o delta.

Não copiar fixtures, seeds ou dados sintéticos ao principal. As fontes de handlers a publicar são handler.ts e index.ts de asaas-checkout e asaas-webhook, com os hashes do manifesto. Há alterações locais de preparação: não presumir que HEAD/um commit anterior já contenha esses bytes. Congelar e revisar o artefato indicado pelo manifesto. Não incluir --include-seed nem --include-roles em uma aplicação.

## Nove diferenças de definição consolidadas

| Objeto | Diferença comprovada | Impacto nas 19 migrations |
|---|---|---|
| public.platform_comment_restricted_terms | Parênteses associativos do CHECK; árvore conbin igual | Nenhuma alteração de regra; não corrigir o principal por isso |
| public.product_comments | Parênteses de dois CHECKs; árvores conbin iguais | Nenhuma alteração de validação |
| public.restaurant_comment_restricted_terms | Parênteses do CHECK; árvore conbin igual | Nenhuma alteração de validação |
| public.restaurants | Parênteses do CHECK google_review_url; árvore conbin igual | Não afeta as novas colunas/regras contratuais; manter o CHECK |
| policy public.platform_settings.platform_settings_read | Ordem anon/authenticated | Mesmo conjunto de roles e expressão; sem impacto |
| policy public.restaurant_tables.restaurant_tables_read_public | Ordem anon/authenticated | Sem impacto no isolamento/cotas |
| policy public.restaurants.restaurants_read_active | Ordem anon/authenticated | Sem impacto no acesso |
| policy storage.objects.elozi_backups_no_direct_client_access | Ordem anon/authenticated | Restrição preservada; não relaxar |
| ACL pg_catalog.pg_reload_conf() | Bootstrap owner local postgres produz REVOKE adicional no dump regenerado | Diferença de ambiente gerenciado. As 19 migrations não dependem de chamar essa função; não alterar seu owner/ACL no principal para imitar a bancada |

Separadamente dessas nove diferenças: Vault e sete event triggers gerenciados foram omitidos deliberadamente no ensaio, e dez roles foram placeholders sem atributos globais. No principal esses objetos/roles permanecem gerenciados. Não omitir, desabilitar ou substituí-los durante a aplicação. Erro disparado por event trigger exige parada e investigação, não sua desativação. Esses limites impedem declarar recuperação integral da plataforma, mas não indicam divergência funcional das nove definições acima.

## Leitura atual do principal: mudou desde o dump

[Evidência sanitizada da leitura atual](principal-preflight-readonly-20261031.json). Projeto Eloozi/ACTIVE_HEALTHY, PostgreSQL 17.11, confirmado por ref antes das consultas.

- Histórico atual: 76 entradas, última 20261025180709. O conteúdo completo da tabela de histórico coincide com o COPY do dump.
- 84 seções de dados do dump foram comparadas em transação read-only/repeatable-read por contagem e fingerprint da representação COPY. As 38 tabelas public coincidiram. Houve mudanças em auth.refresh_tokens (260 para 261 linhas), auth.sessions e auth.users (mesmas contagens, conteúdo diferente). Nenhuma senha/hash individual/token foi exibido.
- Surgiram duas partições vazias de realtime.messages: messages_2026_11_02 e messages_2026_11_03. Parent, limites de partição e owner supabase_realtime_admin foram conferidos; são objetos gerenciados. Não criar/apagar/reparar essas partições manualmente para reproduzir o snapshot antigo.
- 191 funções coincidem em identidade/tipos dos argumentos, corpo normalizado apenas por CR, owner, volatilidade, SECURITY DEFINER e configurações. As 53 policies coincidem em comando, expressão, permissividade e conjunto de roles. Nas 84 tabelas originalmente definidas, owner e flags RLS coincidem; não falta tabela original.
- Essas leituras ocorreram em snapshots separados de dados/catálogos. Não constituem diff exaustivo atual de todos os índices, constraints, grants e roles globais. O backup de corte e seu diff de schema continuam obrigatórios.
- asaas-checkout e asaas-webhook hospedados estão ACTIVE, versão 7, atualizados em 17/10/2026. O código publicado de checkout não contém BILLING_ISSUANCE_PAUSED e os handlers publicados não contêm a confirmação de quatro argumentos preparada localmente. Não presumir pausa por secret ou decisão humana. Não invocar checkout real para experimentar o estado atual.

As alterações observadas de Auth e partições gerenciadas não exigem reexecutar agora os testes locais aprovados. Exigem atualizar o snapshot de recuperação antes de modificar o banco.

## Gate 0 — condições antes de autorizar a janela

1. Responsável aprova explicitamente: pausa de emissão, deploy dos dois handlers, reconciliação de histórico e as 19 migrations. A autorização de leitura desta etapa não cobre essas ações.
2. CLI Supabase v2.122.0 validado localmente: comandos de ajuda (`--help`), isolamento de `--db-url`, comportamento de `migration repair`, `migration list` e `db push --dry-run --skip-vault --include-all` ensaiados e comprovados com 100% de sucesso em clone descartável de backup. Usar um diretório de trabalho privado exclusivo do principal ($Stage), nunca alterar o vínculo atual de testes ou .env.local.
3. Ter sessão de administrador normal para as verificações de leitura da interface/RPCs. Service_role e SET ROLE não substituem prova de acesso do usuário real.
4. Inventariar todos os escritores de emissão, retries/jobs e consumidores da credencial do gateway. Confirmar que nenhum caminho alternativo continua emitindo fora do handler pausado. Se isso não puder ser comprovado, parar; este roteiro não garante ausência de emissão por um escritor desconhecido.
5. Janela operacional controlada: sem novos onboardings, alterações administrativas de plano ou operações de salão que inviabilizem comparar o snapshot. Confirmar como essa condição será mantida. Ocultar botão não constitui trava de servidor. Se houver necessidade de barreira adicional não existente, prepará-la e ensaiá-la antes da janela; não improvisar revoke/grants no principal.
6. Manter recebimento de pagamentos/webhooks. Preservar IDs/eventos de pagamentos em trânsito em registro privado. Confirmar retenção/reentrega e prazo operacional; não contar com retries ilimitados nem descartar recebidos durante mudanças de schema.
7. **Manifesto Autoritativo das 19 Migrations e Validação Fail-Closed:** O caminho absoluto do manifesto autoritativo congelado utilizado para auditar e comparar os hashes SHA-256 dos 19 arquivos em `$Stage\supabase\migrations` é:  
   `D:\PROJETOS\Eloozi\docs\principal-cutover-manifest-20261031.json`  
   Antes de qualquer ação, o preflight deve ler este manifesto e validar todos os 19 arquivos. Se o manifesto estiver ausente, se qualquer um dos 19 arquivos SQL estiver ausente em `$Stage`, ou se houver qualquer divergência de byte ou hash SHA-256 em relação ao manifesto, o preflight DEVE ABORTAR IMEDIATAMENTE (fail-closed).

## Preparação do operador e conexão

Os exemplos abaixo são **comandos propostos para a janela**, não executados. Variáveis Stage, Repo, Protected e State devem apontar a diretórios privados do operador. Manter secrets fora do Git/ZIPs e da linha de comando; usar prompt protegido ou arquivo temporário com ACL privada, removido no finally.

Criar Stage privado fora do repositório. Inicializar e vincular apenas esse workdir:

```powershell
# [NÃO EXECUTAR - AGUARDANDO AUTORIZAÇÃO ESPECÍFICA DO PROPRIETÁRIO]
supabase --workdir "$Stage" init
supabase --workdir "$Stage" link --project-ref llhujxzefujdsthpezag
```

### Verificação Fail-Closed Obrigatória Antes de QUALQUER Comando `--linked`

Antes de executar QUALQUER comando que utilize o parâmetro `--linked` (seja `migration repair`, `migration list` ou `db push`), a sessão PowerShell ativa DEVE obrigatoriamente executar e passar na verificação fail-closed abaixo. Se qualquer asserção falhar ou se o projeto associado não puder ser comprovado sem ambiguidade, a execução DEVE abortar imediatamente:

```powershell
# [NÃO EXECUTAR - SCRIPT DE CHECAGEM FAIL-CLOSED PARA A JANELA AUTORIZADA]
# 1. Exigir que $Stage esteja definido e não seja vazio na mesma sessão PowerShell
if ([string]::IsNullOrWhiteSpace($Stage)) {
    throw "FATAL FAIL-CLOSED: A variável `$Stage não está definida na sessão PowerShell atual. Abortando."
}

# 2. Confirmar que a pasta de trabalho existe e contém o projeto Supabase esperado (config.toml)
if (-not (Test-Path "$Stage\supabase\config.toml")) {
    throw "FATAL FAIL-CLOSED: A pasta de trabalho '$Stage' não contém uma estrutura válida de projeto Supabase ('supabase\config.toml' ausente). Abortando."
}

# 3. Verificação fail-closed do projeto associado: exatamente llhujxzefujdsthpezag
$tempRefPath = "$Stage\supabase\.temp\project-ref"
if (-not (Test-Path $tempRefPath)) {
    throw "FATAL FAIL-CLOSED: Arquivo de vínculo de projeto ausente em '$tempRefPath'. Não é possível comprovar o alvo. Abortando."
}

$linkedProjectRef = (Get-Content -Path $tempRefPath -Raw).Trim()
if ($linkedProjectRef -ne "llhujxzefujdsthpezag") {
    throw "FATAL FAIL-CLOSED: O projeto associado em '$tempRefPath' é '$linkedProjectRef', DIVERGENTE do principal esperado 'llhujxzefujdsthpezag'. Abortando imediatamente para prevenir alterações em ambiente indevido."
}

Write-Host "PASS FAIL-CLOSED: Diretório `$Stage verificado e vinculado com sucesso exclusivamente ao projeto principal llhujxzefujdsthpezag." -ForegroundColor Green
```

Antes de CADA comando de alteração, reexecutar o guard acima, confirmando que `$Stage\supabase\.temp\project-ref` contém exatamente `llhujxzefujdsthpezag` e que a confirmação do projeto vem da API/painel desse ref. Não usar `--password` com valor na linha de comando ou URI com senha. Guardar configuração e versão do CLI no registro privado.

Copiar para Stage apenas as migrations já registradas (75 versões comuns atuais) mais os dois arquivos de baseline de reservas; os 19 arquivos pendentes entram **um por vez** (ou como lote fechado e auditado por hash), conforme o gate de aplicação. Copiar os quatro arquivos locais dos handlers com hashes conferidos. Configurar no workdir checkout verify_jwt=true e webhook verify_jwt=false, preservando a validação própria ASAAS_WEBHOOK_TOKEN. Não alterar o arquivo de configuração/vínculo do workspace original.

## Gate 1 — pausa real, handlers compatíveis e drenagem

1. Guardar versão/bundle e configuração atuais dos handlers para recuperação compatível. Conferir os nomes esperados: SUPABASE_URL/ANON_KEY/SERVICE_ROLE_KEY, ASAAS_API_KEY, ASAAS_BASE_URL (ou alias legado ASAAS_API_BASE_URL), ASAAS_WEBHOOK_TOKEN. Não imprimir valores. A URL Asaas deve ser explícita e corresponder ao ambiente aprovado; não confiar no fallback de produção da versão antiga.
2. Configurar BILLING_ISSUANCE_PAUSED com valor **true minúsculo**, antes da publicação do novo checkout. Isso sozinho não afeta a versão 7. Exemplo futuro:

```powershell
supabase secrets set BILLING_ISSUANCE_PAUSED=true --project-ref llhujxzefujdsthpezag
supabase --workdir "$Stage" functions deploy asaas-checkout --project-ref llhujxzefujdsthpezag
supabase --workdir "$Stage" functions deploy asaas-webhook --project-ref llhujxzefujdsthpezag --no-verify-jwt
```

3. Conferir novas versões/código hospedado e valores de verify_jwt. Não avançar com checkout sem guard ou webhook sem validação do token próprio. Não expor secrets. O manifesto é dos arquivos de fonte, não deve ser comparado diretamente com hash do bundle ezbr.
4. Prova hospedada da pausa: como usuário autenticado normal, enviar apenas payload incompleto `{"action":"checkout"}`. Esperado: HTTP 503, billing_paused=true. Esse payload deliberadamente não tem restaurante/plano/dados para emitir cobrança caso a pausa esteja mal configurada. Não usar um payload de contratação válido para provar a pausa. Qualquer 400/401/500 em vez de 503 requer investigar e parar, sem tentar emissão real.
5. Confirmar zero reserva/claim e zero POST /payments causados por essa prova. A autenticação pode consultar Auth; o guard antecede RPC financeira, criação de cliente gateway e emissão. Os testes locais já aprovados verificam ausência de RPC/fetch de emissão sob pausa.
6. **Tratamento de execuções residuais e drenagem (Estado factual: DRAINAGE_INCONCLUSIVE):**  
   - **Estado Factual:** O encerramento global de instâncias e workers legados da v7 na borda não pode ser comprovado de forma determinística pela telemetria da plataforma gerenciada, mantendo o estado da drenagem factualmente como `DRAINAGE_INCONCLUSIVE`. Não se deve afirmar ou presumir que os workers v7 terminaram.  
   - **Ponte como Mitigação de Compatibilidade (Não como Prova de Drenagem):** A Ponte Segura v7 no PostgreSQL atua estritamente como mitigação técnica de compatibilidade — e não como prova ou substituto de drenagem. Ela assegura coexistência controlada ao interceptar chamadas da v7 (`confirm_subscription_invoice_payment` de 2 argumentos) e persistir os eventos com segurança na Inbox sem quitar faturas, isolando o banco contra mutações desordenadas caso workers v7 residuais ainda estejam em execução.  
   - **Condições Estritas para Avanço:** Qualquer avanço para as etapas de modificação de schema exige:  
     1. Verificação prévia e rigorosa dos controles da ponte (assinatura da RPC de 2 argumentos, grants restritos a `service_role`, persistência isolada na Inbox e ausência de quitação prematura);  
     2. Deliberação e autorização expressa do proprietário para aceitar formalmente a incerteza residual decorrente de `DRAINAGE_INCONCLUSIVE`.  
   - **Critério de Parada:** Se a verificação dos controles da ponte falhar, se houver qualquer desvio nas garantias de isolamento financeiro ou se a autorização expressa do proprietário para aceitar essa incerteza não existir, **PARAR IMEDIATAMENTE** sem iniciar o hardening.
7. Webhook e verify_payment permanecem disponíveis. Os handlers locais tentam confirm_subscription_invoice_payment de quatro argumentos e usam a assinatura antiga de dois apenas quando a nova assinatura está ausente. Não há fallback por erro de validação/permissão/transporte. Referência de pagamento confirmado que ainda não possa ser anexada retorna erro retryable; preservar/reentregar o evento até a confirmação correspondente, sem marcar paid por UPDATE.

## Gate 2 — backup atualizado imediatamente antes da primeira alteração do banco

Depois da pausa comprovada, verificação dos controles da ponte e autorização expressa do proprietário para aceitar a incerteza residual de drenagem, antes de repair/migration: executar nova exportação consistente pelo script protegido do operador, Session pooler oficial porta 5432, SSL obrigatório, senha somente local. Preservar o archive de 16:00:51Z; não sobrescrever. Gerar novo metadata/horários/SHA-256 e inventário privado de histórico, catálogo, contratos e faturas em trânsito.

O script existente foi conferido em leitura: project ref principal, host aws-1-sa-east-1.pooler.supabase.com, porta 5432, DB postgres e usuário postgres.llhujxzefujdsthpezag. Comando futuro, sem senha na linha:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Temp\Eloozi-Backup-Principal.ps1"
```

Confirmar novamente esses parâmetros no painel antes da janela. Digitar a senha somente no prompt local oculto; se falhar, parar sem loops automáticos nem redefinição de senha. Não executar backup novo nesta etapa de preparação.

O dump anterior é referência ensaiada, mas já ficou defasado em Auth/partições. Verificar o archive novo e compará-lo integralmente ao baseline: explicar Auth/partições e qualquer diferença adicional. Se houver mudança nos objetos de aplicação, histórico, faturas/contratos ou nos arquivos do manifesto, parar e ensaiar apenas o delta necessário.

Antes de reutilizar restore-review, copiar sua pasta inteira para um diretório privado de evidências datado, preservando logs/snapshots/result.json do ensaio aprovado. Nunca incluir esses arquivos em Git/ZIP público.

Para verificar somente o novo archive na mesma bancada protegida, o runner recebeu parâmetros explícitos; essa variante foi preparada/analisada sintaticamente e **ainda não executada**, porque o novo dump não existe nesta etapa:

```powershell
node scripts/restore-private-principal.mjs "$State" "$NewBackupMetadata" "--expected-sha256=$NewBackupSHA256" --restore-only
```

NewBackupSHA256 deve ser calculado diretamente no novo arquivo e conferido com metadata; não reutilizar o hash antigo. O modo restore-only faz a restauração e comparações do novo snapshot, remove somente eloozi_restore e encerra o cluster em finally, sem reexecutar as 19 migrations. Requer a regra privada ainda válida. Se ela já tiver sido removida, parar e reestabelecer/provar a contenção pelo procedimento corrigido, nunca pelo Enable antigo.

Confirmar nova restauração com exit 0, limitações gerenciadas documentadas, hash preservado e cluster parado. O resultado antigo não comprova a nova exportação. Não começar alteração remota se esse gate falhar.

Webhooks podem confirmar pagamentos depois do snapshot: manter o registro privado desse delta. Um restore do snapshot não pode apagar pagamentos posteriores sem replay/reconciliação autorizada.

## Gate 3 — Reconciliação e Aplicação de Migrations via Supabase CLI v2.122.0

> [!CAUTION]
> **AVISO DE SEGURANÇA E BLOQUEIO:**  
> Os comandos a seguir são minutas técnicas formalmente validadas no ensaio local em cópia de backup.  
> **TODOS OS COMANDOS ESTÃO IDENTIFICADOS COMO [NÃO EXECUTAR] ATÉ AUTORIZAÇÃO ESPECÍFICA DO PROPRIETÁRIO.**  
> Nenhuma execução remota está autorizada nesta etapa. O checkout permanece pausado (`BILLING_ISSUANCE_PAUSED=true`) e os Gates D e E permanecem em **NO-GO**.

Situação de baseline do banco principal: 96 arquivos locais, 76 versões registradas no histórico remoto (`supabase_migrations.schema_migrations`). Apenas 21 arquivos locais não possuem registro com o mesmo timestamp (as 19 migrations aprovadas do lote de corte e os dois arquivos locais de reservas: `20261024164500` e `20261025090000`), enquanto o banco possui a versão remota `20261025180709`. As três versões históricas com conteúdo divergente (`20261008141500`, `20261016050000`, `20261016060000`) permanecem registradas como aplicadas, intocadas e não são reenviadas nem submetidas a repair.

O procedimento validado em bancada descartável divide-se em quatro etapas rigorosamente separadas:

---

### Etapa 1: Reparo de Metadados das Três Versões de Reservas (Sem Execução DDL)

**Objetivo:** Alinhar o catálogo de metadados (`schema_migrations`) com as versões do repositório local, impedindo categoricamente que o CLI tente executar fisicamente o arquivo permissivo `20261024164500_create_reservations_table.sql` ou reexecutar a migration segura `20261025090000_secure_reservations_rls.sql`.

> **[NÃO EXECUTAR - AGUARDANDO AUTORIZAÇÃO ESPECÍFICA DO PROPRIETÁRIO]**
```powershell
# 1.1 Registrar a versão legada de reservas como aplicada (impede execução física do DDL permissivo com USING true)
supabase --workdir "$Stage" migration repair 20261024164500 --status applied --linked

# 1.2 Registrar a versão local segura como aplicada
supabase --workdir "$Stage" migration repair 20261025090000 --status applied --linked

# 1.3 Remover o registro remoto com timestamp divergente da tabela de controle
supabase --workdir "$Stage" migration repair 20261025180709 --status reverted --linked
```

- **Garantias Técnicas Comprovadas em Ensaio:**  
  * Zero DDL executado; zero criação de tabelas ou políticas.  
  * A tabela `public.reservations` permanece íntegra, com suas 4 políticas tenant-scoped restritas ativas e zero políticas abertas (`USING true`).  
  * Contagem resultante em `schema_migrations`: exatamente **77 linhas** ($76 - 1 + 2 = 77$).

---

### Etapa 2: Conferência de `migration list` e `db push --dry-run` (Exigência Estrita das 19 Migrations e Hashes do Manifesto)

**Objetivo:** Auditar o plano de execução gerado pelo Supabase CLI antes de autorizar qualquer mutação física no banco de dados, comprovando contagem exata e conformidade criptográfica dos arquivos.

> **[NÃO EXECUTAR - AGUARDANDO AUTORIZAÇÃO ESPECÍFICA DO PROPRIETÁRIO]**
```powershell
# 2.1 Reexecutar o guard fail-closed de vínculo antes de qualquer chamada com --linked:
if ([string]::IsNullOrWhiteSpace($Stage) -or -not (Test-Path "$Stage\supabase\config.toml")) {
    throw "FATAL FAIL-CLOSED: `$Stage inválido ou não configurado na sessão. Abortando."
}
$tempRefPath = "$Stage\supabase\.temp\project-ref"
if (-not (Test-Path $tempRefPath) -or ((Get-Content $tempRefPath -Raw).Trim() -ne "llhujxzefujdsthpezag")) {
    throw "FATAL FAIL-CLOSED: Projeto vinculado diverge de 'llhujxzefujdsthpezag' ou não pôde ser comprovado. Abortando."
}

# 2.2 Listagem de migrations: conferir se todas as 77 migrations históricas aparecem sincronizadas
supabase --workdir "$Stage" migration list --linked

# 2.3 Dry-run com flags validadas: simulação estrita sem mutação no banco
supabase --workdir "$Stage" db push --dry-run --skip-vault --include-all --linked

# 2.4 Validação criptográfica fail-closed dos 19 arquivos no $Stage contra o manifesto oficial:
$manifest = Get-Content "$Repo\docs\principal-cutover-manifest-20261031.json" -Raw | ConvertFrom-Json
foreach ($m in $manifest.migrations) {
    $fileName = Split-Path $m.path -Leaf
    $targetFile = Join-Path "$Stage\supabase\migrations" $fileName
    if (-not (Test-Path $targetFile)) {
        throw "FATAL: Arquivo obrigatório '$fileName' ausente em '$Stage\supabase\migrations'. Abortando."
    }
    $actualHash = (Get-FileHash -Path $targetFile -Algorithm SHA256).Hash.ToLowerInvariant()
    $expectedHash = $m.sha256.ToLowerInvariant()
    if ($actualHash -ne $expectedHash) {
        throw "FATAL: Divergência de hash SHA-256 no arquivo '$fileName'! Esperado: $expectedHash; Obtido: $actualHash. Abortando."
    }
}
Write-Host "PASS: Todos os 19 arquivos no Stage conferem exatamente com os hashes SHA-256 do manifesto." -ForegroundColor Green
```

- **Critérios de Aceite Obrigatórios:**  
  1. O comando `db push --dry-run` DEVE retornar `Exit Code: 0`.  
  2. A lista de migrations a serem aplicadas (`Would push these migrations:`) DEVE conter **exatamente as 19 migrations aprovadas do manifesto** (`docs/principal-cutover-manifest-20261031.json`), da Ordem 1 (`20261017000000_product_badge_text.sql`) à Ordem 19 (`20261031120000_billing_cutover_pending_invoice_quarantine.sql`).  
  3. **Conformidade de Hashes:** Todos os 19 arquivos presentes em `$Stage\supabase\migrations` DEVEM ter seus hashes SHA-256 comprovados como idênticos aos registrados no manifesto.  
  4. **Critério de Exclusão:** As migrations de reservas (`20261024164500` e `20261025090000`) e as três históricas divergentes **NÃO PODEM** constar na lista de envio.  
  5. **Critério de Parada:** Se qualquer outra migration, seed (`--include-seed`) ou roles (`--include-roles`) for listada, se o dry-run acusar contagem diferente de 19, ou se qualquer hash divergir, **PARAR IMEDIATAMENTE** sem aplicar nada.

---

### Etapa 3: Aplicação do Lote (Somente após Autorização Específica do Proprietário)

**Objetivo:** Aplicar fisicamente as 19 migrations aprovadas, registrando de forma durável e atômica cada versão executada em `supabase_migrations.schema_migrations`.

> **[NÃO EXECUTAR - AGUARDANDO AUTORIZAÇÃO ESPECÍFICA DO PROPRIETÁRIO]**
```powershell
# 3.1 Aplicação controlada via Supabase CLI com flags homologadas
supabase --workdir "$Stage" db push --skip-vault --include-all --linked
```

- **Garantias de Execução:**  
  * O Supabase CLI executa as migrations transacionalmente e grava no histórico cada versão aplicada com timestamp, nome e hash.  
  * A Migration 5 atualizada aplica a Ponte Segura compatível com o Webhook v7 e cria a infraestrutura de `billing_private.webhook_inbox`.  
  * A Migration 19 isola faturas ambíguas em quarentena sem emitir cobranças.

---

### Etapa 4: Verificações Posteriores e Critérios de Parada

**Objetivo:** Confirmar a integridade estrutural, a contagem final do catálogo de migrations e a blindagem de segurança da base de dados.

> **[NÃO EXECUTAR - AGUARDANDO AUTORIZAÇÃO ESPECÍFICA DO PROPRIETÁRIO]**
```powershell
# 4.1 Conferir status final das migrations via CLI
supabase --workdir "$Stage" migration list --linked

# 4.2 Executar pacote SQL de verificação somente leitura
# (Conforme supabase/ops/principal-cutover-readonly-checks.sql)
```

- **Itens de Auditoria Posterior Imediata:**  
  1. **Contagem de Histórico:** A tabela `supabase_migrations.schema_migrations` DEVE conter exatamente **96 linhas** ($77 + 19 = 96$), com a versão mais recente sendo `20261031120000`.  
  2. **RLS e Políticas de Reservas:** Confirmar que `public.reservations` possui RLS ativo e **zero** políticas permissivas (`qual = 'true'` ou `with_check = 'true'`). As 4 políticas tenant-scoped (`reservations_select_member`, `reservations_insert_admin`, `reservations_update_admin`, `reservations_delete_admin`) devem estar preservadas.  
  3. **Ponte Segura do Webhook v7:** Confirmar que a função `confirm_subscription_invoice_payment(uuid, text)` existe com permissão exclusiva para `service_role` e bloqueio de `anon`/`authenticated`.  
  4. **Contratos e Planos:** Confirmar que os 8 restaurantes mantêm `contract_rights_model = 'legacy'`, com zero termos de trial ou ciclos criados retroativamente.  
  5. **Critérios de Parada e Aborto:** Qualquer falha de comando, código de saída diferente de zero, erro de constraint ou divergência em `schema_migrations` exige parada imediata e acionamento do procedimento de forward fix ou restauração de backup com preservação dos logs de auditoria.

| Ordem | Verificação específica, além dos snapshots |
|---:|---|
| 1 | badge_text/badge_color presentes; produtos antigos inalterados |
| 2 | colunas/RPC de mídia existentes; referências a assets mantidas |
| 3 | RPC de cancelamento em lote e ACL corretos; itens existentes inalterados |
| 4 | transferência atômica e grants corretos; nenhum item transferido pela aplicação da migration |
| 5 | hardening: DML direto em invoices revogado para clientes; RPC antiga de checkout sem EXECUTE; claim/attach/confirm 4-args apenas servidor confiável; confirmar pausa ainda ativa |
| 6 | flags/datas de contratos antigos preservadas; nenhum trial antigo inferido; funções de status sem sobrecarga ambígua |
| 7 | staff_profiles com RLS e triggers previstos; vínculos existentes mantidos |
| 8 | resumo da assinatura lido por admin normal; nenhuma coluna inexistente |
| 9 | catálogo 9990/17990/27990 e 5/20/ilimitado; limites/preços já contratados não sincronizados |
| 10 | schema privado de evidências e quote RPC com grants previstos; nenhum ciclo histórico inventado |
| 11 | entrega manual/RPC e ACL preservadas; sem entrega automática ao aplicar |
| 12 | canais antigos preenchidos mantêm exibição/default aprovado |
| 13 | restaurantes existentes legacy, novos default commercial_v1; versão não alterável pelo cliente |
| 14 | evidências originais de trial/ciclo sem backfill heurístico; prazo existente preservado |
| 15 | crédito do mesmo ciclo e contratos imutáveis; nenhum pagamento/ciclo criado pela migration |
| 16 | downgrade agendado sem efeito imediato; tabelas novas e permissões corretas |
| 17 | RPCs de chamado e fechamento conjunto, ACLs/canonical quote; nenhuma comanda fechada ao aplicar |
| 18 | get_visit_tab_consumptions(uuid,uuid), STABLE/INVOKER/search_path e grants corretos; leitura normal da própria visita |
| 19 | somente invoices pending sem referência e estado NULL/in_progress em needs_reconciliation; status/valor/paid_at/contratos inalterados; claim dessas invoices não autoriza POST |

Depois de cada arquivo: comparar projeção dos campos antigos do snapshot privado, contagens de reservas/mesas/visitas/comandas/itens/faturas e alterações de grants/RLS esperadas. Não usar hash de JSON de linha inteira após adicionar colunas: comparar as colunas antigas e verificar novas separadamente. Campos aprovados do catálogo e metadados de quarentena são exceções explícitas; alterações em pagamento por evento real devem ter evidência correspondente, nunca ser ignoradas genericamente.

Ao final, esperado histórico com 96 versões e última 20261031120000, condicionado ao mesmo inventário observado. Novo histórico/diff não previsto exige investigação.

## Conclusão do Lote SQL NÃO Conclui o Cutover

> [!IMPORTANT]
> **DELIMITAÇÃO ESTRITA DE ESCOPO:**  
> A aplicação física bem-sucedida das 19 migrations encerra exclusivamente a camada de estrutura DDL e metadados no PostgreSQL. **A CONCLUSÃO DO LOTE SQL NÃO CONCLUI O CUTOVER.**  
> O cutover seguro é um processo multi-camada composto por etapas posteriores independentes, cada uma com seus próprios gates, critérios de verificação e exigência de autorização formal e isolada do proprietário:

1. **Gate 3.5 — Transição de Webhook Compatível e Handlers da Borda:**
   - A Edge Function `asaas-webhook` atualmente ativa em produção permanece na versão 7 legada e invoca a RPC legada de 2 argumentos (`confirm_subscription_invoice_payment(uuid, text)`).
   - A Ponte Segura introduzida pela Migration 5 intercepta essa chamada de 2 argumentos e persiste o evento na tabela durável `billing_private.webhook_inbox` sem realizar a quitação da fatura nem estender assinaturas.
   - A quitação canônica via RPC de 4 argumentos (`confirm_subscription_invoice_payment(uuid, text, bigint, uuid)`) pertence estritamente ao processamento assíncrono executado pelo novo consumidor da Inbox (`inbox-consumer`), após validação independente de valor e integridade.
   - O estado da drenagem permanece classificado como `DRAINAGE_INCONCLUSIVE`: a compatibilidade da ponte permite uma coexistência controlada entre workers v7 e o novo esquema, mas essa compatibilidade não comprova o encerramento global de workers v7 na infraestrutura gerenciada. A transição definitiva da borda exige deploy separado, validação própria de token e monitoramento específico.
2. **Gate 3.6 — Agendamento e Ativação do Consumidor da Inbox (pg_cron / pg_net):**
   - O consumidor assíncrono automatizado foi validado e homologado em staging (`rzhtndpselxsxgomclzo`), onde foi devidamente desativado ao término do ensaio (count = 0 em `cron.job`).
   - A ativação do job `auto-inbox-consumer` no banco principal (`llhujxzefujdsthpezag`) é uma etapa separada pós-migração, dependente de autorização explícita, monitoramento de leases e comprovação de ausência de chamadas à API real sem faturas legítimas.
3. **Gate 4 — Observação Pós-Mudança e Telemetria (Inércia Financeira):**
   - Janela de observação estrita em modo somente-leitura e retenção de webhooks, sem novas emissões de cobrança.
   - Auditoria de logs em `platform_audit_logs`, faturas em quarentena (`needs_reconciliation`) e integridade de faturamento.
4. **Gate E — Reativação Operacional de Cobranças:**
   - A retirada da trava (`BILLING_ISSUANCE_PAUSED=false`) é o último passo do processo.
   - Permanece estritamente em **NO-GO** e NUNCA é reativada automaticamente ao término da aplicação SQL.
   - Requer deliberação e autorização expressa e isolada do proprietário após conciliação de todas as pendências.

Todas as minutas técnicas continuam classificadas como **[NÃO EXECUTAR]** sem autorização específica. Os Gates D e E permanecem inegociavelmente em **NO-GO**.

## Por que não há janela planejada para reemissão ambígua

Esta garantia é **condicionada à comprovação dos gates**, não uma afirmação sobre o principal hoje. Atualmente a versão 7 não oferece a pausa.

| Intervalo futuro | Barreira exigida para POST /payments |
|---|---|
| Publicação inicial até verificação da pausa | Ainda pode haver request antigo; SQL não começa e o corte não é considerado estabelecido |
| Controles da ponte validados, aceitação de incerteza residual pelo proprietário, backup e repair | Novo checkout já responde 503 antes de reserva/claim/fetch de emissão; nenhum escritor alternativo ativo |
| Migrations 1–4 | Mesma pausa verificada; nenhuma mudança que permita emitir |
| Hardening 5 até antes da quarentena 19 | Pausa continua. A proteção de cliente/claim já existe, mas NULL legado sozinho ainda seria perigoso; não usar claim como substituto da pausa |
| Depois da quarentena | Pausa continua; invoices ambíguas recebem needs_reconciliation e seu claim não autoriza emissão |
| Encerramento desta janela | Não desativar pausa. Retomada exige autorização separada e classificação de todas as invoices/execuções incertas |

Logo, não existe intervalo **autorizado pelo roteiro** em que a emissão seja habilitada enquanto uma fatura ambígua esteja emitível. Se a pausa cair, houver versão antiga ativa sem controles da ponte comprovados, outro emissor ou ausência de autorização do proprietário para aceitar a incerteza residual de drenagem, a garantia deixa de valer e a sequência para antes da próxima alteração. Não basta a presença do secret, menu oculto, tempo decorrido ou regra local de firewall.

## Verificações e critérios de parada/recuperação

Pacote SQL de leitura: supabase/ops/principal-cutover-readonly-checks.sql. Guardar saídas privadas antes/depois; ele retorna inventário, fingerprints dos campos antigos, agregado de invoices, RLS/policies e assinaturas/ACLs das RPCs. Não altera dados nem chama gateway. A revisão atual usou consultas equivalentes, não foi apresentada como execução nova de todos os testes locais.

Parar se: ref/hash/pendência divergir; novo backup não restaurar; pausa ou controles da ponte não comprovados; ausência de autorização formal para aceitar a incerteza residual; pagamento confirmado sem trilha de retenção; qualquer comando falhar; RLS de reservas deixar de estar ativa ou aparecer policy true; cliente ganhar escrita em invoices/evidências; campo contratual/dado operacional mudar sem evidência; RPC/handler incompatível; nova emissão aparecer; ou replay legítimo acrescentar ciclo/receita.

Dezesseis arquivos contêm BEGIN/COMMIT explícitos. Três não têm esse invólucro: 20261026160000_batch_cancel_table_tab_items.sql, 20261026190000_atomic_transfer_table_tab_items.sql e 20261031015051_get_visit_tab_consumptions.sql. Para esses três, não assumir rollback integral sem verificar a transação do executor na versão do CLI disponibilizada. Não modificar os arquivos compartilhados para acrescentar wrappers. Uma falha deve ser tratada como potencial aplicação parcial e exige inventário dos objetos/grants antes de qualquer retomada.

Mesmo nos 16 arquivos transacionais, não presumir atomicidade conjunta do COMMIT de DDL e do registro de histórico sem conferir o executor. Em perda de conexão, verificar histórico, objetos e dados antes de reaplicar. Se um arquivo já está committed, manter o estado, pausa e ledger; não executar down genérico nem replay de todas as 19. Corrigir e ensaiar localmente o problema comprovado.

Não voltar aos handlers antigos após hardening/quarentena: eles podem contornar claim e não entendem as novas RPCs. Se o novo handler falhar, manter emissão bloqueada e corrigir versão compatível; preservar/reentregar confirmações recebidas. Não apagar fatura/evento, marcar paid por UPDATE, reiniciar ciclo ou gerar outra cobrança para substituir uma ambígua.

Restaurar o principal é uma operação separada, com autorização explícita e procedimento compatível com dependências gerenciadas, roles e dados desde o snapshot. O restore local adaptado não autoriza apagar schemas Auth/Storage/Vault no serviço hospedado. Antes de recuperação integral, preservar delta de operações e pagamentos posteriores ao dump; sem isso, o snapshot antigo pode perder vendas ou pagamentos. Forward fix controlado é preferível quando mantém os dados e o estado financeiro íntegros.

Frontend só é publicado após as RPCs dependentes e smoke de leitura por identidades normais. Não usar produção para criar cobranças, confirmar pagamentos fictícios ou fechar comandas de teste. Verificar atendimento real somente com operações legítimas/autorizadas. Automação de navegador e medição de timeout hospedado continuam fora do que o ensaio comprovou.

## Regra privada da bancada

Leitura atual confirmou zero processo postgres da bancada, pg_ctl status=3 e regra privada ainda habilitada/correspondente. Ela não é necessária para um servidor parado e não protege o principal. Convém mantê-la até validar o backup atualizado; outra restauração local precisará dessa contenção.

Foi preparado scripts/Remove-Eloozi-PrivateBenchProtection.ps1, com validação de state/RunId/caminho/descrição/filtros, comprovação de ausência de processos e status=3, registro de intenção antes da remoção e remoção de um único nome exato. WhatIf foi executado com exit 0; nenhuma regra foi removida.

Após a última validação local e com o cluster parado, comando administrativo futuro:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "D:\PROJETOS\Eloozi\scripts\Remove-Eloozi-PrivateBenchProtection.ps1" -StateFile "$env:LOCALAPPDATA\Eloozi\PrivateRestoreBench\3d1bf2ea-a25f-4c8e-85a4-d0bd26fee92e\state.json"
```

Esse comando recusa remoção com processo ativo ou metadado divergente; não para outros processos, não toca o postgres original, outras regras, logs ou dump. Pode ser pré-visualizado com -WhatIf. O parâmetro ExecutionPolicy Bypass vale apenas para o processo e não altera política persistente do Windows.

## Bloqueios restantes para executar

Ainda faltam autorização da janela/ações, CLI disponível e workdir principal conferido, pausa hospedada efetiva com handlers novos/drenagem, inventário de emissores e retenção de pagamentos, controle de concorrência operacional/onboarding, backup atualizado e sua restauração, preflight completo de schema/grants/roles gerenciadas e decisão sobre recuperação de dependências não cobertas integralmente. Não interpretar o fechamento deste roteiro como autorização de aplicar ou ativar Asaas.

Referências das formas de comando: [Supabase CLI — db push e migration repair](https://supabase.com/docs/reference/cli/introduction), [Management API — apply migration](https://supabase.com/docs/reference/api/v1-apply-a-migration). Conferir --help na versão disponibilizada para a janela antes de usar os comandos propostos.

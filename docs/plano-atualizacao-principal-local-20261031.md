# Plano local de atualizacao do Supabase principal — 31/10/2026

## Escopo e bloqueios

Projeto alvo identificado nos diagnosticos anteriores: principal `llhujxzefujdsthpezag`. Projeto de testes `rzhtndpselxsxgomclzo` nao foi usado nesta rodada. Esta rodada nao fez consulta nem alteracao remota; nao acionou Asaas, CLI, deploy, migration repair, SQL remoto ou frontend hospedado. O backup completo restauravel, a autorizacao para o corte financeiro e a janela operacional permanecem requisitos pendentes. Nao iniciar a aplicacao enquanto qualquer um estiver pendente.

Supabase CLI nao esta disponivel no PATH nem em `node_modules/.bin`; nao foi instalada. Nao foi possivel conferir nesta rodada a existencia, data ou restaurabilidade de backup. A sintaxe de `supabase migration repair` abaixo segue a [referencia oficial do CLI](https://supabase.com/docs/reference/cli/supabase-migration-repair), mas deve ser revalidada com a versao de CLI usada na janela de mudanca.

## Diagnostico de historico preservado

O historico lido anteriormente no principal termina em `20261025180709`. Nao reexecutar migrations historicas. Tres arquivos locais com o mesmo timestamp ja aplicado divergem em conteudo: `20261008141500_create_table_tab_consumption.sql` (statement de seed), `20261016050000_saas_subscription_billing.sql` (tres statements de seguranca/checkout) e `20261016060000_banco_inter_pix_cnpj_integration.sql` (um statement). As definicoes atuais das RPCs financeiras de base foram comparadas e coincidem com os hashes do principal. Esses arquivos compartilhados nao devem ser editados nem reaplicados para reconciliar o principal.

Reservas: no principal ja existem a tabela, RLS e as quatro policies tenant-scoped; nao ha policy `USING/ WITH CHECK true`. A definicao da migration local segura `20261025090000_secure_reservations_rls.sql` foi comparada e e equivalente ao registro remoto `20261025180709`. A migration compartilhada `20261024164500_create_reservations_table.sql` contem policies permissivas e **nao deve ser executada**. Estrategia futura, somente depois de backup restauravel, preflight de todas as colunas/constraints/indices/FKs e autorizacao: history-only, sem SQL funcional, usando comandos separados e conferindo `supabase migration list` apos cada um:

```powershell
supabase migration repair 20261024164500 --status applied
supabase migration list
supabase migration repair 20261025090000 --status applied
supabase migration list
supabase migration repair 20261025180709 --status reverted
supabase migration list
```

Isso registra que o estado final ja existe sem executar a migration permissiva e transfere o registro da migration segura do timestamp remoto para o arquivo local correspondente. Parar se a versao/forma do CLI, o historico observado ou qualquer objeto diferir; nao substituir por `db push`, nao modificar migrations compartilhadas e nao remover as policies seguras. O resultado esperado do preflight e a ausencia de migration local de reservas pendente e de registro remoto sem arquivo local; nenhuma dessas operacoes foi executada nesta entrega.

## Alteracoes locais de preparacao financeira

- `asaas-checkout` agora aceita `BILLING_ISSUANCE_PAUSED=true`: novas emissoes retornam 503 antes de RPC financeira ou chamada ao gateway; `verify_payment` permanece habilitado. O handler exige URL explicita (`ASAAS_BASE_URL`, com alias legado `ASAAS_API_BASE_URL`) e nao possui fallback silencioso para endpoint Asaas de producao.
- `asaas-checkout` e `asaas-webhook` chamam primeiro a RPC de confirmacao de quatro argumentos e so tentam a assinatura legada de dois argumentos quando o erro identifica assinatura ausente. Falhas de permissao, validacao ou transporte nao caem para a RPC antiga.
- Se a verificacao encontrar pagamento confirmado mas a RPC de anexar referencia ainda nao existir, o handler responde 503 retryable com indicacao de pagamento recebido; nao descarta o evento nem faz UPDATE direto.
- Nova migration incremental `20261031120000_billing_cutover_pending_invoice_quarantine.sql`: depois da migration 26233815, marca como `needs_reconciliation` somente faturas `pending`, sem `external_reference` utilizavel, cujo estado de emissao e NULL ou `in_progress`. Mantem status, valor, datas, restaurante, contrato e claim. O claim de emissao bloqueia novo POST ate reconciliacao. Evento confirmado pode anexar referencia e usar a RPC de confirmacao existente.

Configuracao esperada, nomes apenas (nenhum valor foi lido ou registrado): frontend `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`; Edge Functions `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ASAAS_API_KEY`, `ASAAS_BASE_URL` (ou `ASAAS_API_BASE_URL` legado), `ASAAS_WEBHOOK_TOKEN`; checkout tambem `BILLING_ISSUANCE_PAUSED=true` durante o corte. Antes de qualquer release, provar que o URL Supabase e do principal e que o endpoint/credencial Asaas correspondem ao ambiente autorizado. A existencia/pausa dos secrets e endpoints hospedados nao foi reconsultada nesta rodada. Diagnostico remoto anterior encontrou `asaas-checkout` e `asaas-webhook` ativos e nao encontrou evidencia de pausa; portanto Asaas nao pode ser considerado pausado.

## Ensaio local descartavel executado

Runner: `node scripts/test-financial-cutover-db.mjs`, PostgreSQL 17.11 ja instalado em `D:\pgSQL\bin`, cluster temporario apenas em loopback `127.0.0.1:55517`, sem leitura de `.env`, URL remota ou credenciais. O runner aplica migrations locais em ordem, omite explicitamente `20261024164500_create_reservations_table.sql`, cria a tabela de reservas pela migration segura e verifica RLS/policies. Antes do hardening financeiro compara hashes das RPCs-base `create_subscription_checkout` e `confirm_subscription_invoice_payment` com os hashes lidos no principal.

Fixture isolada: cinco restaurantes sinteticos cobrindo contratos legacy, trial antigo sem evidencia, trial comprovado, pagamento em transito e confirmacao tardia; cinco faturas sinteticas (paga, emitida pendente, pendente sem referencia, paga alocada a ciclo e emissao em progresso); tres evidencias de trial, um ciclo e sua alocacao confirmada. Snapshots comparam campos de contrato, trial, ciclos, alocacoes e faturas. Sem gateway externo. Executado: migration de quarentena alterou apenas duas linhas de metadados de emissao; faturas pagas/externamente vinculadas mantiveram campos de cobranca; status/valores/datas/claims das ambiguas foram mantidos; emissao repetida foi recusada; evento confirmado sintetico foi anexado/confirmado, criando um ciclo/alocacao, e replay ficou idempotente. Legacy, trial Premium comprovado e trial antigo sem evidencia foram preservados. A fixture de trial preexistente tambem terminou e registrou suas assercoes; ela captura restaurantes/faturas antes da migration de ciclo para comparar preservacao.

Resultado da execucao final: `RESULTADO_FINAL: PASS`, PostgreSQL encerrado e diretorio temporario removido em `finally`; log sanitizado em `docs/financial-cutover-local.log`. Tentativas anteriores do runner falharam antes dos asserts por incompatibilidade do token restrito no sandbox, CRLF na leitura do psql e fixtures/asserts locais; foram corrigidas no runner/fixture e nao sao contabilizadas como aprovadas.

Limitacao do ensaio: o cluster e uma reconstrucao do schema a partir das migrations locais, com os hashes das RPCs-base e os objetos de reservas comparados ao principal; nao e um clone/restore do schema inteiro do principal. As tres divergencias historicas de conteudo foram executadas apenas na reconstrucao local para formar a base; por isso o ensaio comprova a cadeia local e os pontos explicitamente comparados, nao equivalencia integral do schema remoto. O backup restauravel e necessario para uma prova de ensaio sobre clone real.

Validacao final de codigo: `npm.cmd test` exit 0, 273 aprovados, 4 skips preexistentes, 0 falhas; inclui regressao de que a pausa bloqueia nova emissao sem RPC/fetch, mas deixa verificacao manual ativa, alem de verificar manual/webhook com RPC legada. `npm.cmd run typecheck` exit 0. `npm.cmd run build` exit 0 (Vite 6.4.4, 209 modulos). Logs atuais: `docs/financial-cutover-npm-test.log`, `docs/financial-cutover-typecheck.log`, `docs/financial-cutover-build.log`. Nenhuma chamada Asaas real.

## Sequencia futura exata — sem lote generico

Cada migration deve ser aplicada individualmente, na ordem abaixo, com pausa entre passos para comparar historico, inspecionar erro e executar as verificacoes; nunca reaplicar as tres migrations historicas divergentes. A lista foi lida contra o principal nos diagnosticos anteriores. Se o preflight encontrar qualquer outra pendente/divergente, interromper antes de aplicar.

| Ordem | Migration | Dependencia / verificacao imediatamente apos aplicar |
|---:|---|---|
| 0 | Reconciliacao history-only de reservas acima | So depois de backup e diff completo dos objetos; provar RLS ligada e policies seguras antes e depois. A migration permissiva nao e executada. |
| 1 | `20261017000000_product_badge_text.sql` | Conferir colunas/badges e que produtos existentes preservam os valores/visibilidade esperados. |
| 2 | `20261024140000_restaurant_dashboard_media.sql` | Conferir colunas de media e RPC/grants; nao remover assets. |
| 3 | `20261026160000_batch_cancel_table_tab_items.sql` | Conferir assinatura/grants e sem mudanca em itens existentes fora do escopo previsto. |
| 4 | `20261026190000_atomic_transfer_table_tab_items.sql` | Conferir RPC/grants, itens e registros de transferencias; manter operacoes antigas. |
| 5 | Deploy separado de `asaas-checkout` e `asaas-webhook` com emissao pausada | Confirmar versao implantada, testar guard 503 sem RPC/fetch de emissao, confirmar que verify/webhook continuam aceitando eventos e que log nao expoe valores. **Asaas permanece pausado.** Deploy nao autorizado agora. |
| 6 | `20261026233815_checkout_and_subscription_security_hardening.sql` | Dependente das tabelas de assinatura base; remove RPC antiga do cliente, adiciona claims e RPC nova. Sob pausa: conferir assinatura/ACLs, RLS/grants, emissao bloqueada, evento tardio processado pela nova assinatura e nenhum estado de fatura alterado pela migration. Nao reemitir invoices pendentes existentes. |
| 7 | `20261027000000_enforce_strict_trial_rules.sql` | Conferir onboarding, autorizacao, estados de trial e snapshots de contratos/faturas; sem reiniciar/encurtar trial. |
| 8 | `20261027210000_create_staff_profiles.sql` | Conferir schema, RLS, triggers e isolamento por restaurante. |
| 9 | `20261028183120_fix_get_restaurant_billing_summary_invoices_columns.sql` | Executar leitura da RPC de resumo com admin normal; sem mutacao. |
| 10 | `20261028223000_commercial_catalog_modules_and_active_tables_quota.sql` | Conferir catalogo 5/20/ilimitado; direitos atuais nao devem ser sincronizados por flag/opcao implicita; snapshots de mesa/visita/comanda/trial. |
| 11 | `20261029000754_subscription_transition_quotes.sql` | Conferir schema privado, grants e que cotar nao altera assinatura/fatura. |
| 12 | `20261029002852_basic_manual_delivery.sql` | Executar regressao de entrega com estados/roles e preservar KDS pago. |
| 13 | `20261029010637_restaurant_contact_channels.sql` | Conferir defaults para canais antigos, salvar/reler por admin e leitura publica sem canal vazio. |
| 14 | `20261029024000_contract_module_access.sql` | Confirmar novos inserts `commercial_v1`, existentes `legacy`, grants/RLS e permissao Premium sujeita a cargo. Nao converter legacy em renovacao. |
| 15 | `20261029143000_premium_trial_and_prepaid_cycle.sql` | Confirmar trial original de 168h apenas em onboardings elegiveis; snapshots de faturas/planos/datas; nenhuma inferencia historica sem evidencia. |
| 16 | `20261029180000_trial_prepaid_upgrades.sql` | Conferir reserva/creditos do mesmo ciclo, locks, pagamentos pendentes e idempotencia; nao recalcular ciclos antigos. |
| 17 | `20261030130000_scheduled_subscription_downgrades.sql` | Conferir agendamento/cancelamento/substituicao, sem efeito antes da confirmacao de renovacao; preservar trials e ciclos. |
| 18 | `20261030223205_service_call_cycles_and_group_payment.sql` | Aplicar somente se a historia do principal confirmar ausente. Verificar chamados, cotacao/fechamento atomico, ACLs e idempotencia. |
| 19 | `20261031015051_get_visit_tab_consumptions.sql` | Aplicar somente se ausente; conferir RPC invoker, grants authenticated, RLS e uma consulta por visita. |
| 20 | `20261031120000_billing_cutover_pending_invoice_quarantine.sql` | Ultima etapa antes de decidir retomada. Conferir somente invoices `pending` sem referencia e estado NULL/in_progress marcadas; comparar status/valores/datas/claims e manter via de conciliacao. |

Frontend correspondente so pode ser publicado depois do schema/RPCs dependentes e de uma verificacao de compatibilidade do build e config `VITE_*` apontando para o principal. As Edge Functions devem ser implantadas antes da migration de hardening com pausa habilitada; apos hardening, verificar chamadas 4-args novas e que fallback 2-args so ocorre quando assinatura estiver ausente. A ordem de ativacao sem pausa requer autorizacao separada e ainda nao esta aprovada.

### Corte e pagamentos em transito

1. Antes do corte, tirar backup completo e provar restore em alvo isolado. Exportar inventario de invoices (status, amount, external reference presente/ausente, emissao/claim timestamps), ciclo/contrato e trilha de webhooks; armazenar evidencias com acesso restrito.
2. Ativar `BILLING_ISSUANCE_PAUSED=true` ao publicar o handler de checkout; confirmar 503 em pedido novo e zero chamada ao endpoint Asaas. Nao pausar/remover o endpoint de webhook. Consultas manuais confirmam pagamento continuam disponiveis se credenciais/config de gateway estiverem corretas.
3. Drenar chamadas de emissao ja iniciadas: aguardar requests em andamento, verificar logs de Edge e estado de claims; nao reciclar claim nem expirar faturas por timeout. Eventos confirmados continuam no webhook.
4. Aplicar as migrations listadas uma a uma mantendo a pausa. Qualquer erro deixa a pausa ativada; nao reaplicar arquivos ja registrados.
5. `needs_reconciliation` nao e cancelamento nem perda de pagamento: nao emitir novo POST para fatura sem referencia; verificar por referencia oficial do Asaas sob procedimento autorizado, anexar referencia apenas pelo RPC confiavel e confirmar apenas valor/estado validados. Nunca marcar `paid` por UPDATE nem apagar o evento.
6. Enquanto houver pagamentos/requests sem resultado conclusivo, manter checkout pausado e webhook ativo/retentivo. O codigo retorna 503 retryable quando a confirmacao precisa de schema ainda ausente; webhooks devem ser reentregues. Preservar ids/eventos para reconciliacao manual. Nao ativar Asaas nesta etapa.

### Recuperacao e pontos de parada

- Antes de qualquer mudanca: se ref confirmado, historico, hashes, policies, schema ou backup divergirem, parar sem aplicar nada.
- Durante aplicacao: se migration ou verificacao falhar, manter emissao pausada, registrar migration que parou e resultado, nao executar as seguintes e nao tentar DDL inverso de cabeca. Investigar em backup/clone; somente restaurar backup previamente testado com autorizacao especifica.
- Pagamento confirmado sem confirmacao local: manter invoice/evento, aceitar retry do webhook, reconciliar com gateway de modo auditavel; nunca descartar, emitir segunda cobranca, alterar status via SQL manual ou somar ciclo duas vezes.
- Retomada do checkout exige: toda cadeia conferida, fila/invoices ambiguas classificadas, nenhuma emissao em andamento sem dono, confirmacao idempotente testada em ambiente aprovado, Edge URLs/secrets conferidos sem exposicao e autorizacao explicita para tirar a pausa. **Nada disso autoriza Asaas nesta entrega.**

## Pendencias que bloqueiam aplicacao

1. Backup completo comprovadamente restauravel e exercicio de recuperacao.
2. Autorizacao explicita para reconcile de historico, aplicar migrations, deploy Edge/frontend e corte financeiro.
3. Supabase CLI disponivel na janela e projeto confirmado como `llhujxzefujdsthpezag` em checkout isolado; CLI nao instalado/nao configurado nesta rodada.
4. Preflight final de schema completo de reservas e das outras divergencias; o ensaio local nao e clone do principal.
5. Confirmacao operacional de valores/nomes de secrets esperados e URL Asaas, sem compartilhar seus valores. Diagnostico anterior nao comprovou emissao pausada; `asaas-checkout` e `asaas-webhook` estavam ativos.
6. Reconciliacao de qualquer invoice sem referencia/estado de emissao incerto, feita sob procedimento autorizado com trilha de auditoria.

## Arquivos locais desta preparacao

- `supabase/functions/asaas-checkout/{handler.ts,index.ts}`
- `supabase/functions/asaas-webhook/{handler.ts,index.ts}`
- `tests/checkoutSecurity.test.ts`
- `supabase/migrations/20261031120000_billing_cutover_pending_invoice_quarantine.sql`
- `supabase/tests/financial_cutover_prepare.sql`
- `supabase/tests/financial_cutover_assert.sql`
- `scripts/test-financial-cutover-db.mjs`
- `docs/financial-cutover-local.log`
- `docs/plano-atualizacao-principal-local-20261031.md`
- `CONTINUIDADE_CODEX.md`


Atualizacao final: docs/roteiro-final-principal-20261031.md consolida a leitura atual, hashes, gates e pendencias; usar esse roteiro em lugar deste plano preliminar. Nenhuma aplicacao autorizada por esta nota.

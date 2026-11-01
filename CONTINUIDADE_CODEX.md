# Continuidade atual — Fase 1 operacional do corte e preparação da Fase 2 (principal llhujxzefujdsthpezag)

31/10/2026. Projeto principal autorizado: llhujxzefujdsthpezag.

1. Flag de pausa: `BILLING_ISSUANCE_PAUSED=true` gravada com sucesso nos secrets do projeto via Management API (recibo: `$Stage\pause-write-receipt.json`, HTTP 201 em 2026-10-31T20:29:51.6456337Z).
2. Deploy de checkout: `asaas-checkout` publicado exclusivamente com as fontes congeladas (`index.ts` e `handler.ts`), resultando na versão 9 (`ACTIVE`, `verify_jwt=true`, id: `f73f243b-a187-4658-a259-a4e189cf7618`, horário UTC: `2026-10-31T20:37:04.293Z`).
3. Probes de borda (sem gateway): executados via `scripts/Test-Eloozi-Phase1Endpoints.ps1` com anon key e JWT autenticado de usuário real do principal. Recibo gravado em `$Stage\checkout-pause-probe.json`:
   - Probe 1 (`action: "checkout"`): HTTP 503 (`billing_paused: true`, `passed: true`, request_id: `01a19426-41d0-7567-90ff-2502d0a1d312`).
   - Probe 2 (`action: "verify_payment"`): HTTP 400 por `invoiceId` ausente (`passed: true`, request_id: `01a19426-478d-7dad-b416-38ddab3cec43`).
   - Status: `CHECKOUT_PAUSE_BOUNDARY_PASS_NOT_DRAINAGE`.
4. Decisão sobre asaas-webhook e bloqueio estrutural da v7:
   - Incompatibilidade da v7 com a Migration 5 mantida explícita como NÃO RESOLVIDA: o webhook v7 ativo em produção chama `confirm_subscription_invoice_payment(uuid, text)` com 2 argumentos e NÃO verifica o valor pago na API do Asaas. A Migration 5 remove essa assinatura antiga em favor da assinatura de 4 argumentos (`p_invoice_id`, `p_external_reference`, `p_paid_amount_cents`, `p_restaurant_id`). Criar um wrapper cego que fabrique o valor esperado da fatura como se fosse o valor pago viola os princípios de segurança financeira do sistema. Portanto, a transição permanece BLOQUEADA até a introdução do Webhook Inbox com validação independente.
   - O webhook ativo em produção permanece estritamente na versão 7. Nenhum deploy de Edge Function ou aplicação de migration remota é proposto ou autorizado.
5. Inércia de criação e quitação em `public.subscription_invoices`: consulta estritamente read-only comprovou zero novas faturas criadas (`created_at >= 2026-10-31 20:37:04.293+00`) e zero faturas marcadas como pagas (`paid_at >= 2026-10-31 20:37:04.293+00`). Esclarecimento de precisão: a tabela não possui coluna `updated_at`, portanto a consulta atesta ausência de novas emissões e quitações pós-deploy, não alterações em colunas sem timestamp de auditoria.
6. Drenagem global mantida como `DRAINAGE_INCONCLUSIVE`: chamado de suporte enviado ao Supabase questionando telemetria interna de isolamento/convergência de workers da v7. Bloqueio Go/No-Go mantido ativo.
7. Conclusão e encerramento do protótipo Webhook Inbox (Gates C, D e E mantidos estritamente em NO-GO):
   - Proteção estrita contra workers zumbis na mutação financeira: `billing_private.process_inbox_payment_event` executa a validação de posse (`claim_id = p_worker_id AND lease_expires_at >= clock_timestamp()` com `FOR UPDATE`) antes de invocar a confirmação de pagamento na mesma transação. Se o lease expirou e outro worker assumiu o evento, a chamada do worker antigo é abortada (`ERR_LEASE_EXPIRED_OR_STOLEN`), garantindo que zero mutações financeiras sejam geradas por workers expirados. Teste com concorrência entre worker antigo (expirado) e novo comprovou bloqueio total do antigo e quitação limpa pelo novo.
   - Política HTTP única e desacoplamento de retentativas:
     * Antes da persistência: falha de token retorna HTTP 401 (sem gravação); falha de banco/conexão retorna HTTP 503 (Asaas retenta).
     * Após persistência durável na inbox: a borda responde HTTP 200 imediatamente ao Asaas. A partir desse instante, a responsabilidade pertence exclusivamente ao consumidor interno da inbox.
     * Casos de subpagamento (divergência de valor), revisão requerida (`review_required`) ou falhas transitórias de rede/API externa são geridos pelo consumidor interno (falha terminal, encaminhamento para auditoria ou reagendamento com `next_retry_at`), eliminando 100% de retentativas simultâneas ou redundantes entre Asaas e inbox.
   - Payload sem ID: gravado como `status = 'quarantined'`, `disposition = 'rejected'` e confirmado com HTTP 200 ao Asaas para prevenir o bloqueio da fila da conta por esgotamento de 15 retentativas.
   - Minimização de PII: allowlist restrita gravando apenas metadados técnicos de cobrança e expurgando cartões, tokens, e-mails, telefones e CPF/CNPJ. Schema privado `billing_private` sem permissão para anon/authenticated.
   - Validações locais 100% aprovadas:
     * SQL em PostgreSQL 17 descartável (`scripts/test-webhook-inbox-db.mjs`): 9 testes aprovados (duplicidade, quarentena sem mutação, claim atômico, bloqueio de worker expirado na transação financeira, atomicidade/rollback em inconclusivo, disposição canônica em todos os caminhos, subpagamento, ciclo completo de consumidor [retry -> dead-letter -> admin replay], e conciliação pós-corte).
     * HTTP / Consumidor em Node.js (`scripts/test-webhook-inbox-handler.mjs`): 9 testes aprovados (HTTP 503 em falha de persistência, HTTP 200 em persistência, quarentena sem ID, rejeição HTTP 401, subpagamento tratado internamente sem retry do Asaas, review_required tratado internamente, falha transitória reagendada internamente, pagamento válido confirmado atomicamente pelo consumidor, e expurgo de PII).
   - Encerramento do protótipo: o desenho técnico e as validações locais estão concluídos e congelados. Não há novos requisitos pendentes no protótipo.
   - Status dos Gates: Gates C, D e E mantidos estritamente em NO-GO.
8. Isolamento rigoroso preservado: zero migrations aplicadas remotamente, zero repairs, zero backups executados no turno, zero secrets/tokens exibidos e nenhuma chamada à API do Asaas.
9. Validação Final da Ponte Segura v7 (Safe v7 Bridge) e Cadeia Completa de Migrations:
   - Comportamento da Edge Function v7 comprovado no código real (`rollback-v7/asaas-webhook/index.ts`, linhas 65–90): responde estritamente HTTP 200 quando a RPC `confirm_subscription_invoice_payment` retorna sucesso sem erro (`!confirmErr`), e HTTP 500 caso ocorra erro/exceção de banco.
   - Aplicação da cadeia completa das 19 migrations de corte (Order 1 a Order 19): executada em PostgreSQL 17 local descartável (`scripts/test-v7-bridge-db.mjs`), confirmando que a sobrecarga da ponte `confirm_subscription_invoice_payment(uuid, text)` e seus grants restritos (`anon`: false, `authenticated`: false, `service_role`: true) permanecem intactos após todas as migrations posteriores (Migrations 6 a 19).
   - Decisão terminativa sobre fatura inexistente (Item 3): quando uma fatura inexistente é recebida pela v7, a ponte grava o evento em quarentena (`status = 'quarantined'`, `disposition = 'rejected'`, `quarantine_reason = 'unknown_invoice'`, `last_error` descritivo) e responde HTTP 200 ao Asaas. Decisão técnica motivada: retornar HTTP 500 para entidade não existente causaria 15 retentativas inúteis ao longo de 12h50 e provocaria o congelamento/pausa da fila de webhooks da conta no Asaas, gerando indisponibilidade para todos os demais restaurantes. Responder HTTP 200 isola a inconsistência em quarentena auditável com zero mutações em dados legítimos.
   - Tratamento de `payment.id` ausente: fallback sintético `asaas_pay_<invoiceId>` reconhecido pela ponte, isolado em quarentena (`status = 'quarantined'`, `disposition = 'rejected'`) e respondido com HTTP 200 ao Asaas.
   - Falha de persistência: falha de disco/banco gera erro na RPC e faz a v7 retornar HTTP 500 ao Asaas, acionando retentativa legítima de infraestrutura.
   - Revisão e prova dos grants SECURITY DEFINER: privilégios de `anon`, `authenticated` e `public` revogados explicitamente. Invocação direta por roles não confiáveis confirmada como bloqueada com SQLSTATE 42501 (permission denied) em teste PostgreSQL.
   - Consumidor agendado da Inbox e status de pg_cron/pg_net (Item 2):
     * O ciclo de consumo assíncrono automatizado foi validado (claim atômico com `FOR UPDATE SKIP LOCKED`, lease/visibilidade, consulta direta à API do Asaas para conferência de valor e quitação canônica da fatura apenas se íntegro).
     * O agendamento ponta a ponta nativo via extensões `pg_cron` e `pg_net` foi registrado como **PENDENTE de homologação remota/staging**, visto que essas extensões em C não estão disponíveis no binário standalone PostgreSQL de Windows local.
   - Arquivos e hashes atualizados localmente:
     * `supabase/migrations/20261026233815_checkout_and_subscription_security_hardening.sql`: 29.863 bytes, SHA-256: `3727f1601e25dcbc0ee907e64569560ef0eaafeef447cf6b242a2aaebbb68794`.
     * `docs/principal-cutover-manifest-20261031.json`: manifesto local de corte sincronizado com os bytes e SHA-256 da Migration 5.
     * `docs/principal-migrations-ordem-hashes-20261031.md`: tabela de ordem e hashes sincronizada.
   - Status dos Gates C, D e E: mantidos estritamente em **NO-GO**. Zero operações remotas.
10. Homologação Autônoma em Staging (rzhtndpselxsxgomclzo) da Webhook Inbox via pg_cron e pg_net e Fechamento de Fixtures:
    - **Teste automático aprovado em staging:**
      * No ambiente de teste rzhtndpselxsxgomclzo, as extensões pg_cron (1.6.4) e pg_net (0.20.4) foram ativadas e integradas à Edge Function consumidora (inbox-consumer v1).
      * O agendamento autônomo foi comprovado por 4 execuções consecutivas em cron.job_run_details (PIDs 468585, 468597, 468631, 468662) e net._http_response (IDs 3, 4, 5, 6).
      * Evento sintético 1 (synthetic:evt:normal_1): transicionou autonomamente de received -> processed com disposition = 'confirmed', confirmando a quitação da fatura 1801484f-... sem intervenção manual.
      * Evento sintético 2 (synthetic:evt:transient_2): simulou falha transitória na tentativa 1 (fail_webhook_inbox_event, fatura permaneceu open e sem mutação), foi retomado na tentativa 2 pelo cron após o backoff de 5s, e processado com sucesso (disposition = 'confirmed'), comprovando idempotência e ausência de quitação duplicada.
      * Zero chamadas manuais no teste e zero tráfego externo para a API real do Asaas (api.asaas.com).
    - **Job atualmente desativado:**
      * Concluído o ensaio, o agendamento auto-inbox-consumer foi removido via cron.unschedule('auto-inbox-consumer') (resultado: true).
      * Verificação em cron.job confirmou count = 0 (zero jobs ativos), prevenindo qualquer consumo ocioso em background no ambiente de testes.
    - **Reconciliação e Coerência de Fixtures no Banco de Testes:**
      * **Coerência Integral Reestabelecida (Inbox <-> Faturas <-> Audit Logs <-> Restaurante):**
        - Fatura sintética 1 (1801484f-b4ad-49d7-a378-ea22953ef68e, ref pay_auto_5abd279f59d14f0189f26c6e445eb804): status = 'paid', paid_at = '2026-11-01 01:58:01.030384+00', gateway_emission_status = 'issued'.
        - Fatura sintética 2 (a47f01e3-f2ed-4a4d-9b80-d03c4b7046e0, ref pay_transient_2142d606538c4d179ce06cc8ab1ff964): status = 'paid', paid_at = '2026-11-01 02:00:01.309444+00', gateway_emission_status = 'issued'.
        - Restaurante sintético de teste (2877bb8c-b751-4149-916a-ca632e046f05, 'Restaurante Teste Consumer Auto'): subscription_expires_at = '2027-01-05 01:57:36.1365+00' (coerente com as duas renovações confirmadas e registradas no platform_audit_logs).
      * **Recibos e logs de auditoria preservados intactos:**
        - Registros na tabela billing_private.webhook_inbox (IDs 48b8d544-... e 92616393-...): status = 'processed', disposition = 'confirmed'.
        - Registros em public.platform_audit_logs (IDs c6acc5c2-... e 51f14d63-...): action = 'cycle_renewed', com timestamps e novos vencimentos idênticos aos das faturas e restaurante.
        - Registros em net._http_response (IDs 3 a 6) e cron.job_run_details (Runs 1 a 4) preservados.
      * **Job auto-inbox-consumer:** Confirmado como desativado (count = 0 em cron.job).
      * **Pendências de dados:** Nenhuma inconsistência remanescente.
    - **Gates de Produção mantidos em NO-GO:**
      * Gate C: Validado em Staging (rzhtndpselxsxgomclzo).
      * Gate D (Transição Segura / Migration 5 em Produção): NO-GO.
      * Gate E (Reativação de Cobranças em Produção): NO-GO.
      * Projeto principal llhujxzefujdsthpezag: estritamente intocado.
11. Ensaio Local da Cadeia de Migrations no Clone do Backup de Corte e Contagem Rigorosa:
    - **Ensaio em Clone Isolado (Bancada Privada Contida):**
      * Archive validado: llhujxzefujdsthpezag/20261101T025108Z/eloozi-principal-database.dump (SHA-256: 6e3d96fe89ad0b3a54c2d909c59cdf5ebac60086a26395874298ec36fc5151cc).
      * Contenção de rede ativa (ElooziPrivate-3d1bf2ea-a25f-4c8e-85a4-d0bd26fee92e), loopback estrito 127.0.0.1:55992.
      * As 19 migrations do lote de corte (incluindo Migration 5 atualizada com a Ponte Segura v7 e billing_private.webhook_inbox, e Migration 19 de quarentena de faturas ambíguas) foram aplicadas individualmente com sucesso (exit code 0 em todas as etapas).
      * Preservação integral de 100% dos dados originais das tabelas públicas; zero extensões de rede ou event triggers instalados; banco descartável eloozi_restore removido e cluster parado após o ensaio.
    - **Contagem Rigorosa dos 96 Arquivos em supabase/migrations (Sem Dupla Contagem):**
      * Total de arquivos SQL locais: 96.
      * 76 migrations históricas: correspondem ao histórico remoto por versão/mapeamento no catálogo do backup (supabase_migrations.schema_migrations), e não que todos os conteúdos SQL sejam textualmente idênticos aos arquivos locais homônimos. Permanecem registradas as três divergências de conteúdo já identificadas em:
        - 20261008141500_create_table_tab_consumption.sql (statement de seed no arquivo local);
        - 20261016050000_saas_subscription_billing.sql (três statements de segurança/checkout);
        - 20261016060000_banco_inter_pix_cnpj_integration.sql (um statement).
        A equivalência por hash entre a migration local segura 20261025090000_secure_reservations_rls.sql e a versão remota aplicada 20261025180709 é contabilizada estritamente dentro deste grupo histórico de 76 (sem dupla contagem). Esses arquivos compartilhados não devem ser editados nem reaplicados; não propor nem executar reparo de histórico.
      * 19 migrations do lote ensaiado: sequência exata de corte planejada e comprovada no ensaio local (Ordens 1 a 19).
      * 1 arquivo excluído da execução física: 20261024164500_create_reservations_table.sql, intencionalmente omitido da cadeia de execução porque contém políticas permissivas legadas (USING true / WITH CHECK true), ao passo que a tabela public.reservations já existe em produção criada e protegida por RLS e políticas tenant-scoped restritas.
      * Equação exata: 76 (históricas por versão/mapeamento com equivalência de reservas) + 19 (lote ensaiado) + 1 (excluído por segurança) = 96 arquivos SQL locais.
    - **Bloqueio de Reconciliação Remota de Reservas:**
      * Qualquer ajuste futuro de metadados no histórico remoto para a migration de reservas (ex.: registrar 20261024164500 como aplicada e sincronizar 20261025090000 via metadados de CLI) é uma etapa futura, separada e ainda não autorizada.
      * Proibido executar migration repair, db push, deploy ou comandos SQL remotos.
    - **Status dos Ambientes e Gates de Produção:**
      * Banco de Testes (rzhtndpselxsxgomclzo): última verificação registrada: agendamento auto-inbox-consumer desativado (não rechecado nesta etapa documental).
      * Ensaio local em cópia de backup: Aprovado com sucesso.
      * Gates D e E (Transição e Reativação em Produção): Mantidos estritamente em NO-GO. Projeto principal llhujxzefujdsthpezag estritamente intocado.
12. Validação Local do Procedimento de Histórico e Homologação do Supabase CLI v2.122.0:
    - **Ensaio em Clone Descartável do Backup de Corte:**
      * Dump utilizado: llhujxzefujdsthpezag/20261101T025108Z/eloozi-principal-database.dump (SHA-256: 6e3d96fe89ad0b3a54c2d909c59cdf5ebac60086a26395874298ec36fc5151cc).
      * Execução em bancada privada contida (porta isolada 55992, firewall ativo, zero tráfego externo).
      * Base temporária eloozi_restore restaurada com histórico inicial de 76 migrations.
    - **Procedimento Validado em 4 Etapas Rigorosamente Separadas:**
      * **Etapa 1 — Reparo de Metadados de Reservas (supabase migration repair):**
        - Executou localmente a tríade de metadados: 20261024164500 marcada como applied (evitando execução do SQL permissivo), 20261025090000 marcada como applied, e 20261025180709 marcada como reverted (exit code 0 em todas as etapas).
        - Contagem resultante em schema_migrations: exatamente 77 linhas. Zero DDL executado; tabela public.reservations mantida com 4 políticas tenant-scoped restritas e zero políticas USING true.
      * **Etapa 2 — Conferência de migration list e db push --dry-run:**
        - supabase migration list confirmou todas as 77 migrations históricas sincronizadas.
        - supabase db push --dry-run --skip-vault --include-all retornou exit 0 e comprovou que o plano resultante seleciona exclusivamente as 19 migrations aprovadas do manifesto de corte (Ordem 1 a 19).
        - Exclusão de segurança confirmada: nem 20261024164500 nem 20261025090000 foram selecionadas.
      * **Etapa 3 — Aplicação Física e Registro no Histórico:**
        - Aplicação simulada com supabase db push --skip-vault --include-all retornou exit 0.
        - Confirmado que o CLI registra atômica e individualmente cada migration aplicada na tabela schema_migrations, atingindo exatamente 96 linhas registradas (77 + 19 = 96), com zero versões faltantes.
      * **Etapa 4 — Descarte do Alvo Temporário e Verificações Posteriores:**
        - Banco descartável eloozi_restore excluído com força e cluster postgres parado (pg_ctl stop -m fast, exit 0). Porta 55992 liberada.
    - **Classificação Estrita de Comandos e Salvaguardas:**
      * Todas as minutas de comandos para produção permanecem rotuladas no roteiro como [NÃO EXECUTAR] até autorização específica e deliberada do proprietário.
      * Nenhum projeto Supabase acessado remotamente, nenhum comando remoto executado, secrets inalterados e checkout pausado (BILLING_ISSUANCE_PAUSED=true).
      * Gates D e E mantidos estritamente em NO-GO.
    - **Complemento de Segurança do Roteiro (Fail-Closed Guard e Escopo de Cutover):**
      * Guard fail-closed obrigatório antes de qualquer comando --linked: exige  definido na mesma sessão PowerShell, presença de supabase\config.toml, e validação estrita de que supabase\.temp\project-ref contém exatamente llhujxzefujdsthpezag (se não for possível comprová-lo, abortar imediatamente).
      * Manifesto autoritativo no Gate 0: caminho absoluto fixado em D:\PROJETOS\Eloozi\docs\principal-cutover-manifest-20261031.json. Se o manifesto ou qualquer um dos 19 arquivos SQL estiver ausente ou divergir em hash SHA-256 no preflight, abortar imediatamente.
      * Exigência de conformidade no dry-run: o comando db push --dry-run deve retornar exatamente as 19 migrations aprovadas e conferir criptograficamente com o manifesto.
      * Delimitação de que concluir o lote SQL NÃO conclui o cutover: no Gate 3.5, a v7 chama a RPC legada de 2 argumentos e a ponte persiste na Inbox sem quitar a fatura; a quitação canônica via RPC de 4 argumentos pertence ao processamento assíncrono pelo novo consumidor da Inbox.
      * Drenagem mantida como DRAINAGE_INCONCLUSIVE como estado factual: a compatibilidade da ponte atua como mitigação técnica de coexistência controlada, não como prova de encerramento global de workers v7. Qualquer avanço exige verificação rigorosa dos controles da ponte e autorização expressa do proprietário para aceitar a incerteza residual; na ausência de controles válidos ou de autorização, o procedimento deve parar.
      * Observação pós-mudança (telemetria/inércia financeira) e reativação operacional de cobranças (Gate E) constituem etapas separadas com gates próprios.
      * Todos os comandos continuam identificados como [NÃO EXECUTAR] sem autorização específica, e Gates D e E mantidos estritamente em NO-GO.
13. Execução Autorizada do Cutover de Banco no Principal llhujxzefujdsthpezag — 01/11/2026:
    - **Autorização do Proprietário:**
      * Execução restrita exclusivamente às três reconciliações de histórico e à aplicação das 19 migrations do manifesto aprovado.
      * Trava de emissão mantida pausada (BILLING_ISSUANCE_PAUSED=true). Nenhuma função alterada, secrets intocados, Asaas não chamado.
    - **Pré-voo Aprovado (Preflight Checks):**
      * $Stage isolado configurado em CutoverStage_llhujxzefujdsthpezag fora do repositório, com supabase/config.toml e .temp/project-ref comprovado rigorosamente como llhujxzefujdsthpezag.
      * Backup mais recente (20261101T025108Z/eloozi-principal-database.dump) validado com SHA-256 idêntico ao esperado: 6e3d96fe89ad0b3a54c2d909c59cdf5ebac60086a26395874298ec36fc5151cc.
      * Todos os 19 arquivos SQL do lote em $Stage conferidos com bytes exatos e SHA-256 idênticos ao manifesto oficial (docs/principal-cutover-manifest-20261031.json).
      * Secret ASAAS_WEBHOOK_TOKEN conferido existente (valor preservado).
      * Estado de entrada confirmado: 76 migrations no histórico; asaas-checkout v9 pausado; asaas-webhook v8 ativo legado; RPC de 2 argumentos presente; RPC de 4 argumentos e billing_private.webhook_inbox ausentes.
    - **Etapa 1 — Reparo de Metadados de Reservas (supabase migration repair):**
      * 20261024164500 marcada como applied (exit 0) — neutraliza a versão permissiva sem executar DDL.
      * 20261025090000 marcada como applied (exit 0) — alinha a versão local segura no histórico.
      * 20261025180709 marcada como reverted (exit 0) — remove o timestamp divergente do controle.
      * Catálogo resultante em schema_migrations: exatamente 77 linhas. Zero políticas permissivas (USING/WITH CHECK true) em public.reservations; 4 políticas tenant-scoped ativas.
    - **Etapa 2 — Conferência de migration list e db push --dry-run:**
      * supabase migration list --linked confirmou sincronização das 77 migrations de baseline.
      * supabase db push --dry-run --skip-vault --include-all --linked retornou exit 0.
      * Auditoria do plano: seleção exclusiva e exata das 19 migrations do manifesto (Ordem 1 a 19). Zero seeds, zero roles, zero reaplicações das 3 divergentes e nenhuma versão de reservas incluída.
    - **Etapa 3 — Aplicação Física das Migrations (db push --skip-vault --include-all --linked):**
      * Execução exit 0 via Supabase CLI v2.122.0. As 19 migrations foram aplicadas transacionalmente e registradas de forma atômica no histórico.
    - **Etapa 4 — Validação Pós-Aplicação e Integridade de Segurança:**
      * Histórico final: exatamente 96 migrations registradas em supabase_migrations.schema_migrations, última versão 20261031120000. supabase migration list --linked confirmou 96/96 sincronizadas (0 pendências).
      * Ponte Segura v7: confirm_subscription_invoice_payment(p_invoice_id uuid, p_external_reference text) de 2 argumentos ativa, SECURITY DEFINER, VOLATILE, restrita exclusivamente a service_role/postgres (anon: false, authenticated: false). Insere na Inbox (status 'received' ou 'quarantined') e não executa quitação em subscription_invoices.
      * RPC Canônica: confirm_subscription_invoice_payment(p_invoice_id uuid, p_external_reference text, p_paid_amount_cents integer, p_restaurant_id uuid) de 4 argumentos ativa, SECURITY DEFINER, restrita a service_role/postgres (anon: false, authenticated: false).
      * Webhook Inbox: tabela billing_private.webhook_inbox criada com RLS ativo.
      * RLS e Políticas de Reservas: public.reservations com RLS ativo, 4 políticas tenant-scoped restritas e zero políticas abertas.
      * Quarentena: migration 19 ativa; faturas ambíguas isoladas com segurança.
    - **Proteções Preservadas e Próximos Gates:**
      * Checkout mantido pausado (BILLING_ISSUANCE_PAUSED=true).
      * Zero publicação/alteração de Edge Functions, zero ativação de pg_cron/pg_net, zero alteração de secrets, zero chamadas ao Asaas.
      * Gates D e E mantidos estritamente em NO-GO. A conclusão do lote SQL não conclui o cutover; a transição de borda e reativação financeira exigem etapas posteriores dedicadas.
---

# Continuidade atual â€” reconciliacao do historico da migration de atendimento

30/10/2026. Projeto autorizado confirmado: rzhtndpselxsxgomclzo. Host do frontend em `.env.local` e marcador local `supabase/.temp/project-ref` conferem com esse ref; chaves/tokens nao foram lidos. Executavel Supabase CLI indisponivel. Nenhum outro projeto foi acessado.

Diagnostico: a migration local `20261030160000_service_call_cycles_and_group_payment.sql` foi enviada uma unica vez ao aplicador para o projeto autorizado. O aplicador criou o historico remoto version `20261030223205`, name `service_call_cycles_and_group_payment`. O row real em `supabase_migrations.schema_migrations` contem `statements` (um statement) e seu conteudo integral. MD5 local do SQL apos retirar CR/LF finais: `73316c114307aaa45ddb85252235a05e`, 28289 caracteres; MD5 remoto apos retirar os CR/LF finais: igual, 28289 caracteres. O historico remoto acrescenta tres caracteres de quebra de linha ao final. Os MD5 de `prosrc` das 10 funcoes verificadas tambem coincidem com os corpos locais. A tabela privada attendance_private.tab_payments existe com RLS habilitado. Portanto, o conteudo aplicado e identico; a divergencia e somente o prefixo de versao gerado pelo aplicador.

Reconciliacao local feita sem alterar SQL: migration renomeada para `20261030223205_service_call_cycles_and_group_payment.sql`; SHA-256 antes/depois igual: `1CD63A956AD1875638058A2CE750C913A646F80DDAF8B508C2B84A9144E1E8C7`. O unico runner que referenciava a versao anterior foi atualizado para o nome/version real. Nao houve reaplicacao, db push, alteracao de funcoes ou mutacao de dados operacionais nesta reconciliacao.

Verificacao adicional tentada: `node scripts/test-service-calls-and-group-payment-db.mjs` falhou na inicializacao local de pg_ctl (status 1), antes de aplicar migrations/testes; nenhum listener surgiu na porta 55493. O runner nao produziu postgres.log. O diretorio temporario criado por essa tentativa foi removido com guarda de caminho. Nao declarar esta execucao SQL como aprovada.

Navegador: interrupcao de seguranca respeitada; nao foram feitas novas chamadas a ferramenta CUA nem tentativas de contorno. Fluxos autenticados de cliente/garcom, previa, quitacao, persistencia e recibo continuam pendentes de evidencias automatizadas seguras ou teste manual do usuario. Nenhum ZIP foi gerado. Sem Asaas, outro projeto, deploy, commit ou push.

---
# Continuidade atual â€” navegador local de chamados e quitacao conjunta

30/10/2026. Retomada pausada antes de abrir app ou autenticar usuarios. A concorrencia PostgreSQL e o rollback da quitacao conjunta constam como aprovados nas evidencias anteriores; nao foram repetidos nesta rodada. Nada foi empacotado.

Bloqueio confirmado por verificacoes locais: `docker`, `supabase`, `podman`, `winget`, `choco`, `scoop` e `wsl.exe` nao estao no PATH; Docker Desktop, Docker service, Supabase CLI local e `supabase/config.toml` nao existem nos caminhos/repositorio verificados. Nenhum listener local nas portas 54321, 54322, 54323, 5432 ou 5173. Node v24.21.0 esta disponivel; npm.cmd v11.19.0. PowerShell bloqueia `npm.ps1`, portanto usar `npm.cmd`/`npx.cmd`. `.env.local` existe e foi preservado sem leitura; nenhum endpoint remoto foi acessado.

Proximo passo executavel para o usuario no Windows: instalar e iniciar Docker Desktop em modo Linux/WSL2 (a instalacao WSL pode exigir PowerShell elevado e reinicializacao; instalacao Docker per-user nao requer elevacao segundo a documentacao oficial). Depois abrir uma nova PowerShell e confirmar `docker info`. No repositorio, confirmar CLI sem gravar dependencia no package.json com `npx.cmd --yes supabase --version` (requer acesso ao npm registry e pode baixar o CLI para o cache local). Informar quando ambos os comandos funcionarem. O repo ainda nao tem `supabase/config.toml`; a retomada devera criar/revisar configuracao estritamente local, sem `link`, sem carregar `.env.local` e sem conectar projeto hospedado, antes de subir a stack.

Quando a infraestrutura estiver disponivel: criar/usar stack Supabase local, aplicar migrations locais, preparar dados descartaveis via fluxos existentes, e autenticar cliente e garcom em contextos distintos. Entao validar chamado/aceite/conclusao/novo chamado, cotacao e confirmacao conjunta, selecao parcial, recibo unico, liberacao conforme regras e persistencia apos recarga. Nao usar respostas simuladas para substituir Auth/PostgREST/Realtime. Sem Asaas, servicos hospedados, deploy, commit ou push. ZIP continua bloqueado ate conclusao dos cenarios de navegador e verificacao do pacote reproduzivel.

Referencias oficiais consultadas para preparacao: Docker Desktop Windows (https://docs.docker.com/desktop/setup/install/windows-install/) e Supabase CLI local (https://supabase.com/docs/guides/local-development/cli/getting-started?platform=npm). Nenhuma acao de instalacao foi iniciada por depender de instaladores, configuracao do sistema e/ou rede ausentes.

---
# Continuidade atual â€” validaÃ§Ã£o integrada de renovaÃ§Ã£o inferior

30/10/2026. RelatÃ³rio docs/downgrade-integrated-relatorio.md. IntegraÃ§Ã£o LOCAL aprovada; ensaio remoto Asaas Sandbox ainda PENDENTE. Agendar/persistir/cancelar foram aprovados manualmente pelo usuÃ¡rio; nÃ£o repetidos remotamente.

Read-only em rzhtndpselxsxgomclzo: projeto testes saudÃ¡vel, migration 20261030130000 e RPCs presentes; catÃ¡logo 9990/17990/27990, limites 5/20/ilimitado. .env.local aponta ao projeto autorizado; backup nÃ£o corresponde a testes e NÃƒO foi carregado. Checkout/webhook publicados iguais aos locais. ASAAS_BASE_URL do runtime/chave nÃ£o acessÃ­vel; cÃ³digo tem fallback produÃ§Ã£o, o que NÃƒO prova produÃ§Ã£o configurada mas impede assumir Sandbox. ZERO cobranÃ§as/confirmaÃ§Ãµes/mutaÃ§Ãµes remotas; produÃ§Ã£o nunca acessada.

Sem ciclo comprovado passado da fronteira e sem relÃ³gio/fixture de teste remoto. Alternativa autorizada: cluster descartÃ¡vel 127.0.0.1:55492 com relÃ³gio virtual SOMENTE local, onboarding e primeira compra via RPC/handlers reais; nenhum INSERT manual de ciclo/histÃ³rico nem UPDATE de datas/pago. Gateway e Supabase Auth/transporte simulados, PostgreSQL/roles/RPCs/RLS reais. NÃ£o publicar fixture ou relÃ³gio. Scripts fora de src/migrations, guard de porta/loopback; nÃ£o lÃª .env.

ExecuÃ§Ã£o ATUAL: 56 asserÃ§Ãµes integradas, manual mensal Premiumâ†’Basic 9990/720h e webhook anual Premiumâ†’Pro 197890/8760h. PendÃªncia preserva dados; replays nÃ£o duplicam dias/ciclos/cobranÃ§as; Basic5, Pro20, estoque/financeiro negados, KDS Basic negado/Pro permitido. Navegador com SQL real: 14 registros (6 iniciais, 8 finais), desktop/celular e claro/escuro, recarga persiste Basic5; registros de 8 mesas preservados. Clusters finais encerrados exit0. npm test263 pass/4 skips anteriores, typecheck/build exit0 apÃ³s correÃ§Ã£o.

Ãšnica correÃ§Ã£o de produÃ§Ã£o: setFeedback(null) apÃ³s status paid na confirmaÃ§Ã£o PIX manual, pois aviso de pendÃªncia persistia ao lado do sucesso. Falha reproduzida; rodada nova confirmou zero aviso antigo. Nenhuma migration/Edge/valor/regra alterada. Fontes, fixture, snapshots, logs, relatÃ³rio e manifesto no ZIP. Checker sÃ³ verifica registros/hashes.

PrÃ³ximo ensaio remoto exige comprovaÃ§Ã£o da configuraÃ§Ã£o Asaas Sandbox e restaurante exclusivo com ciclo legÃ­timo disponÃ­vel; nÃ£o editar datas nem inventar evidÃªncia. Pendentes Auth/PostgREST/Edge/secrets/webhook reais. Sem db push, deploy, commit, push ou instalaÃ§Ã£o. HistÃ³rico abaixo preservado.

---

# Continuidade atual â€” downgrade agendado

30/10/2026. Implementado/validado LOCALMENTE, sem publicaÃ§Ã£o. Nova migration 20261030130000_scheduled_subscription_downgrades.sql apÃ³s 20261029180000. NÃ£o editar anteriores. RelatÃ³rio docs/scheduled-downgrades-relatorio.md.

Agendamento privado sem fatura/cobranÃ§a/alteraÃ§Ã£o imediata. Fronteira = fim do ÃšLTIMO ciclo pago comprovado; trial e todos os perÃ­odos prÃ©-pagos preservados (inclusive contrato futuro comprado durante trial). Plano inferior sÃ³ Ã© renovÃ¡vel a partir da fronteira, na mesma periodicidade, preÃ§o integral, e sÃ³ aplica ao confirmar via RPC transacional existente. Sem confirmaÃ§Ã£o: tolerÃ¢ncia/vencimento originais, sem dias/ativaÃ§Ã£o silenciosa. Primeiro trial sem compra continua checkout original. Legados sem histÃ³rico confiÃ¡vel recusados, sem heurÃ­stica.

TrÃªs RPCs autenticadas (consultar/agendar/cancelar), admin ativo/plataforma. Pode substituir/cancelar antes de reserva; depois precisa concluir/reconciliar cobranÃ§a. VÃ­nculos/recibos imutÃ¡veis, ciclos e evidÃªncias existentes reutilizados. Token opaco scheduled-downgrade:<id> no quoteToken existente vincula retry Ã  mesma fatura mesmo apÃ³s confirmaÃ§Ã£o. PIX/cartÃ£o e manual/webhook mantÃªm fluxo/handlers existentes; nenhum Edge/billingService alterado. AlteraÃ§Ã£o de estado pÃ³s-emissÃ£o registra pagamento recebido para revisÃ£o, sem aplicar plano/dias. NÃ£o liberar intenÃ§Ã£o por vencimento/timeout. ResoluÃ§Ã£o/reembolso administrativo pendente.

ExecuÃ§Ã£o atual: PostgreSQL 17.11 D:/pgSQL cluster TEMP 127.0.0.1:55491 encerrado exit 0; 79 asserÃ§Ãµes especÃ­ficas + 112 upgrade pÃ³s-migration +135 operacionais; 84 trial na base antes das migrations novas, casos adicionais apÃ³s na suÃ­te nova. Sete races por processos psql independentes com bloqueio observado. Snapshots confirmam migration sem alteraÃ§Ã£o de restaurante/fatura/ciclo existente. npm test263 pass/4 skips anteriores/0 fail; typecheck/build finais exit0. 14 observaÃ§Ãµes/capturas em bancada desktop/celular claro/escuro, identidade/transportes simulados; nÃ£o Ã© integraÃ§Ã£o autenticada. Checker sÃ³ verifica registros/hashes.

Pendente: ensaio autenticado integrado, contratos sem evidÃªncia histÃ³rica e reconciliaÃ§Ã£o de cobranÃ§as vinculadas. Futuro: aplicar apenas nova migration sobre base existente, depois frontend; handlers atuais requeridos, nenhuma nova publicaÃ§Ã£o Edge nesta entrega. Sem remoto, Asaas real, instalaÃ§Ã£o, deploy, db push, commit ou push. HistÃ³rico anterior preservado abaixo.

---

# Continuidade atual â€” ajustes finais do cartÃ£o de detalhes

30/10/2026. BotÃµes de dimensÃµes iguais, seta do upgrade restaurada; status ativo sem borda/negrito/ponto verde e restaurante dinÃ¢mico ao lado. DescriÃ§Ã£o solicitada sob ciclo; recursos Premium em cinco blocos (3+2 em Ã¡rea larga), expandindo apenas heranÃ§a explÃ­cita do catÃ¡logo recebido. Basic/Pro sem recursos superiores. Financeiro usa barras SVG, sem seta. Nenhuma alteraÃ§Ã£o de direitos, cobranÃ§as, datas ou handlers (25 conferidos por AST). RelatÃ³rio docs/contract-final-relatorio.md.

ExecuÃ§Ã£o atual: 26 cenÃ¡rios de navegador isolado (trÃªs larguras/dois temas/quatro estados e segundo nome de restaurante), botÃµes medidos iguais e sem overlap/overflow. npm test 259 pass/4 skips anteriores/0 fail; typecheck/build exit 0. Checker verifica evidÃªncia salva, nÃ£o reexecuta navegador. IntegraÃ§Ã£o autenticada real e leitor de tela nÃ£o validados. Sem remoto, banco, instalaÃ§Ã£o, deploy, commit ou push. Trabalho anterior preservado abaixo.

---

# Continuidade atual â€” recursos e tÃ­tulos do cartÃ£o de contrato

30/10/2026. Ajuste localizado concluÃ­do: tÃ­tulo visual Ãºnico conforme contrato (assets originais de icons.zip); trial sem compra continua identificado como teste; duplicaÃ§Ã£o â€œPlano Planoâ€ corrigida. Recursos HTML do catÃ¡logo em blocos com SVGs fornecidos; mascote separado estruturalmente do conteÃºdo, abaixo em telas estreitas. PÃ¡gina fora do cartÃ£o, 25 handlers e componentes anteriores preservados. RelatÃ³rio: docs/contract-icons-relatorio.md.

ExecuÃ§Ã£o atual: 24 cenÃ¡rios visuais (1920/900/390 Ã— dois temas Ã— Basic/Pro/Premium/trial), sem overflow ou sobreposiÃ§Ã£o; aÃ§Ãµes existentes conferidas com transporte simulado, inclusive bloqueio de renovaÃ§Ã£o durante trial. Typecheck/build exit 0; npm test 255 pass/4 skips anteriores/0 fail. Checker valida registros/hashes, nÃ£o reexecuta navegador. IntegraÃ§Ã£o autenticada real, leitor de tela e zoom nativo nÃ£o validados. Sem remoto, banco, instalaÃ§Ã£o, deploy, commit ou push. Assets conferidos byte a byte com icons.zip; arte atualmente salva preservada. HistÃ³ricos anteriores abaixo.

---

# Continuidade atual â€” posiÃ§Ã£o do banner superior

30/10/2026. Ajuste pontual concluÃ­do: PlanBanner superior usa img no lugar do encaixe SVG antigo; padding superior da pÃ¡gina zerado. PNG atual 1900Ã—429 preservado byte a byte e com o mesmo tamanho/proporÃ§Ã£o desenhados. Sem margens negativas. CheckoutShell e banners de checkout intactos, assim como cards/resumo/Ã­cones e regras. RelatÃ³rio: docs/banner-position-relatorio.md.

24 observaÃ§Ãµes/capturas em bancada com AdminLayout real, dados simulados: quatro antes e 20 depois, seis larguras/dois temas, avisos de trial e segunda identidade. Gap sem avisos: 42,17â†’0 px desktop; 12,24â†’0 px celular. Avisos intermediÃ¡rios preservados, nÃ£o cobertos. Typecheck/build exit 0; sem lÃ³gica nova. Runner dedicado scripts/preview-banner-position.mjs; checker scripts/check-banner-position-evidence.mjs verifica registros, nÃ£o reexecuta navegador. NÃ£o validado autenticadamente cada restaurante real. Sem banco, deploy ou push.

HistÃ³rico abaixo preservado.

---

# Continuidade atual â€” modal PIX em ampliaÃ§Ã£o

30/10/2026. CorreÃ§Ã£o de CheckoutShell/CSS concluÃ­da localmente: altura limitada ao overlay, barra de X fora do scroller, conteÃºdo interno com minmax(0,1fr), bloqueio/restauraÃ§Ã£o de html/body e foco preservado. PÃ¡gina de cobranÃ§a/handlers e demais componentes de assinatura intactos. RelatÃ³rio: docs/pix-modal-relatorio.md.

12 cenÃ¡rios de navegador em bancada real de layout com respostas simuladas: 390Ã—1000, 1440Ã—900, 390Ã—500 Ã— claro/escuro Ã— CSS zoom 100%/125%. X visÃ­vel, botÃµes de gerar/consultar PIX alcanÃ§Ã¡veis, fundo parado, Tab/Shift+Tab, X/Escape e retorno de foco passaram. 36 capturas e mÃ©tricas em docs/pix-modal-*. Typecheck/build exit 0; 41 testes passaram. O checker verifica registros, nÃ£o repete navegador. A antiga pendÃªncia do ensaio CSS 125% do PIX estÃ¡ corrigida nesta bancada. Zoom NATIVO e integraÃ§Ã£o autenticada continuam NÃƒO validados.

Preservadas diferenÃ§as fora do modal em dois PNGs e subscription-layout.css, registradas no relatÃ³rio/escopo; nÃ£o se atribui origem nem se restaura arquivo histÃ³rico de asset ausente. ComparaÃ§Ã£o histÃ³rica e hashes atuais separados. Somente duas fontes de produÃ§Ã£o alteradas nesta correÃ§Ã£o. Sem backend, SQL, instalaÃ§Ã£o, remoto, deploy, commit ou push. Checkers anteriores correspondem a outros estados de fontes e nÃ£o sÃ£o validaÃ§Ã£o atual.

HistÃ³rico abaixo preservado.

---

# Continuidade atual â€” cartÃ£o Detalhes do plano atual

29/10/2026. CartÃ£o implementado com arte decorativa original card-plano.png, conteÃºdo HTML recebido do resumo/catÃ¡logo e aÃ§Ãµes existentes. RelatÃ³rio: docs/contract-card-relatorio.md. Arte com texto Ã© apenas referÃªncia, nÃ£o usada no aplicativo. Oito handlers financeiros intactos; 169 arquivos anteriores preservados. Novo CSS exclusivo; revisÃ£o final separou estruturalmente arte e conteÃºdo nas larguras intermediÃ¡rias e refez seis capturas, com build final aprovado; helper deduplica recursos sem alterar valores/capacidade. Nota de trial exige known_trial e trial_active. Datas independentes, sem reconstruÃ§Ã£o histÃ³rica.

ValidaÃ§Ã£o atual: 15 casos visuais em bancada com AdminLayout real e transportes fictÃ­cios; seis larguras e dois temas, Basic/Pro/trial sem compra; trÃªs negativos, anual e datas parciais; renovaÃ§Ã£o abre checkout simulado e upgrade mantÃ©m destino. Typecheck/build exit 0; 15 testes passaram. EvidÃªncias e verificador docs/contract-card-* / scripts/check-contract-card-evidence.mjs. Checkers anteriores descrevem outro estado de fonte e nÃ£o devem ser apresentados como execuÃ§Ã£o atual. IntegraÃ§Ã£o autenticada e zoom nativo 125% permanecem pendentes. Sem instalaÃ§Ã£o, backend, SQL, acesso remoto ou publicaÃ§Ã£o.

HistÃ³rico preservado abaixo.

---

# Continuidade atual â€” ajuste pontual do layout de assinaturas

29/10/2026. Ajuste local concluÃ­do; relatÃ³rio atual: docs/subscription-layout-relatorio.md. HistÃ³rico abaixo preservado. Esta entrada substitui as instruÃ§Ãµes visuais anteriores que descreviam sobreposiÃ§Ãµes no banner superior ou nota do Premium no resumo. Agora o topo usa somente banner-top.png original, com tÃ­tulo h1 acessÃ­vel, resumo uniforme e nota nos detalhes. Quatro fontes do ajuste listadas no relatÃ³rio/manifesto; novo CSS usa largura Ãºtil e preserva o checkout.

ValidaÃ§Ã£o real em bancada com AdminLayout/menu/cabeÃ§alho, identidade e transportes fictÃ­cios: 24 combinaÃ§Ãµes de seis larguras Ã— dois temas Ã— escalas 100%/CSS 125%, seis interaÃ§Ãµes adicionais. Dez registros desktop normais reaproveitados antes da Ãºltima correÃ§Ã£o restrita ao celular; celular refeito e ensaios ampliados concluÃ­dos. Typecheck/build finais exit 0; 14 testes de apresentaÃ§Ã£o/notices passaram. Checker verifica registros e hashes, nÃ£o executa navegador novamente. 162 arquivos anteriores, oito handlers, CheckoutShell e quatro banners originais preservados.

PendÃªncias explÃ­citas: integraÃ§Ã£o autenticada e zoom NATIVO 125%. CSS zoom nÃ£o equivale a zoom nativo; o modal apresentou limites no ensaio CSS 125% e nÃ£o foi aprovado nessa escala. PIX fictÃ­cio validado somente a 100% em desktop/celular. NÃ£o alterar cobranÃ§a ou Shell com base nesse ensaio sem nova anÃ¡lise autorizada. Sem acesso remoto, SQL, instalaÃ§Ã£o, deploy, commit ou push nesta tarefa.

Bancada reproduzÃ­vel: node scripts/preview-subscription-layout.mjs; evidÃªncias docs/subscription-layout-*. O pacote inclui fontes atuais de contexto para revisÃ£o/reproduÃ§Ã£o, sem dependÃªncias, secrets ou build. NÃ£o aplicar migrations/publicar funÃ§Ãµes a partir desta entrega de frontend.

---

# Continuidade atual â€” redesign de Assinatura & Planos e checkout

29/10/2026. Entrega local de frontend/assets concluÃ­da: docs/subscription-redesign-relatorio.md. HistÃ³rico abaixo preservado. Usados os quatro PNGs fornecidos em public/landing/planos, sem ediÃ§Ã£o/recriaÃ§Ã£o/filtros; checksums registrados. SobreposiÃ§Ãµes substituem chamadas embutidas nÃ£o comprovadas. Celular tem versÃ£o HTML legÃ­vel, conforme permitido no pedido.

PÃ¡gina: banner, resumo compacto com Ã­cones, plano atual/detalhes, cards alinhados e Premium â€œGESTÃƒO COMPLETAâ€, mensal/anual, benefÃ­cios pertinentes, comparativo, histÃ³rico, recibos e cartÃµes. Checkout dos trÃªs planos: banner correspondente, resumo de valor real, crÃ©dito somente com cotaÃ§Ã£o, datas recebidas/rotuladas, PIX em duas colunas ou empilhado, cÃ³pia com feedback e consulta de pagamento. Primeira compra nÃ£o Ã© apresentada como upgrade; nÃ£o inventa fim de ciclo ainda nÃ£o confirmado. Preservadas validaÃ§Ãµes e callbacks financeiros. Premium gratuito nÃ£o Ã© confundido com Premium jÃ¡ contratado para desabilitar sua primeira compra.

Novo CheckoutShell: X real, Escape, Tab/Shift+Tab contidos, foco preservado na troca para QR, retorno ao opener ou detalhes se ele ficou desabilitado, rolagem interna/fechamento acessÃ­vel. AdminLayout/navegaÃ§Ã£o, Auth, billingService, checkout/webhook, migrations e seis handlers principais conferidos intactos. MudanÃ§as de texto corrigem promessa de cobranÃ§a automÃ¡tica; nenhum novo fluxo de pagamento. Faixa compacta e lÃ³gica de pausas/reduced-motion intactas; Premium confirmado sem faixa global e com nota no resumo. Ilimitado continua sem barra.

ExecuÃ§Ã£o ATUAL: npm test 252 pass/4 skips anteriores/0 falhas; typecheck/build exit 0. Navegador isolado com pÃ¡gina real/contexto e transporte fictÃ­cios: 56 observaÃ§Ãµes, 24 capturas, matriz final dos trÃªs planos Ã— dois temas Ã— desktop1280/celular390. Verificados primeira compra, mensal/anual, crÃ©dito mensal/anual, pendÃªncia/erro/reconciliaÃ§Ã£o/sucesso, cartÃ£o, detalhes, recibo, foco, Escape, cÃ³pia e ausÃªncia de overflow. QR fictÃ­cio NÃƒO pagÃ¡vel. Logs/JSON docs/subscription-redesign-*. Verificador de registros scripts/check-subscription-redesign-evidence.mjs exit 0; nÃ£o confundir com reexecuÃ§Ã£o automÃ¡tica de navegador.

PENDENTE: integraÃ§Ã£o autenticada, toque fÃ­sico e leitor de tela. Banco/Asaas reais nÃ£o foram usados e SQL nÃ£o foi reexecutado. Bancada scripts/preview-subscription-redesign.mjs envFile:false/loopback, sem persistÃªncia financeira. ComparaÃ§Ã£o de escopo em docs/subscription-redesign-scope.json: 107 verificaÃ§Ãµes, fontes UI e quatro assets com hash. ZIP de UI contÃ©m contexto de fontes/testes, nÃ£o migrations, deps ou build. Sem acesso remoto, instalaÃ§Ã£o, deploy, commit ou push. NÃ£o publicar backend por esta entrega. Codebase-memory indisponÃ­vel; memÃ³ria mantida aqui.

---
# Continuidade atual â€” faixa compacta e checkout neutro

29/10/2026. Entrega de UI local concluÃ­da: docs/compact-ui-relatorio.md. Preservado todo histÃ³rico abaixo, inclusive regras de trial/upgrade; nenhuma mudanÃ§a financeira, backend ou migration nesta etapa.

TrialBanner agora Ã© faixa neutra: 600 ms entrada direita + 4000 ms centro + 600 ms saÃ­da esquerda; prÃ³xima entra pela direita. Web Animations pausa sem perder tempo/posiÃ§Ã£o por mouse/foco ou controle explÃ­cito. Pausas sÃ£o independentes. Reduced-motion nÃ£o anima nem troca automaticamente e permite navegaÃ§Ã£o manual. DescriÃ§Ã£o acessÃ­vel estÃ¡tica, sem anÃºncios repetidos. BÃ¡sico/Pro mantÃªm mensagens prÃ³prias; Premium confirmado esconde faixa global e ganha PremiumTrialNote no card com inÃ­cio pago/dias preservados. Critical alerts do AdminLayout e card de vencimento continuam fixos/intactos.

CheckoutFinancialSummary Ã© estÃ¡tico/neutro: mesmos valores/datas do servidor, diferenÃ§a em destaque. TableCapacity nÃ£o monta percentual quando ilimitado; mostra uso/Sem limite de mesas. Finito mantÃ©m cota e percentual. Nenhuma mudanÃ§a em cotaÃ§Ã£o, valores, crÃ©dito, handlers de pagamento, permissÃµes ou confirmaÃ§Ã£o. Hashes/trechos comparados ao ZIP anterior em docs/compact-ui-scope.json.

ValidaÃ§Ã£o ATUAL: npm test 246 pass/4 skips anteriores/0 falhas; oito testes novos de lÃ³gica de apresentaÃ§Ã£o; typecheck/build exit 0. Navegador isolado com componentes reais/dados fictÃ­cios: claro/escuro, desktop1280/celular390; capturas, JSON e traÃ§os em docs/compact-ui-*. NavegaÃ§Ã£o manual e reduced-motion SIMULADO na bancada; sem movimento automÃ¡tico nesse modo. Hover central e em deslocamento, foco, pausa persistente, retomada do mesmo ponto e rotaÃ§Ã£o completa observados. Keyframes reais mostram parada central de 4000 ms. Verificador scripts/check-compact-ui-evidence.mjs exit 0.

PENDENTE: integraÃ§Ã£o autenticada real, leitor de tela, preferÃªncia nativa do sistema e toque fÃ­sico. NÃ£o confundir largura celular com aparelho ou fixture de matchMedia com configuraÃ§Ã£o do SO. Bancada scripts/preview-compact-ui.mjs nÃ£o acessa backend/env/pagamento. Nenhum teste SQL repetido nem aÃ§Ã£o remota, instalaÃ§Ã£o, deploy, commit ou push. ZIP desta etapa Ã© UI/contexto de testes; nÃ£o inclui migrations ou instruÃ§Ã£o de publicar backend. Codebase-memory indisponÃ­vel; decisÃµes registradas aqui.

---
# Continuidade atual â€” upgrade do contrato pÃ³s-trial

29/10/2026. Implementado/validado LOCALMENTE: docs/trial-upgrades-relatorio.md. Preservar histÃ³rico abaixo; o bloqueio anterior de upgrade durante trial agora Ã© substituÃ­do apenas para ciclo futuro comprovado, mesma periodicidade e plano superior.

Nova migration 20261029180000_trial_prepaid_upgrades.sql, posterior Ã  20261029143000. Novas evidÃªncias privadas append-only trial_upgrades/trial_upgrade_receipts; allocations cycle_payments imutÃ¡veis; trial_terms/cycles originais intactos. Servidor calcula diferenÃ§a integral menos crÃ©dito confirmado do MESMO ciclo, sem proporcionalidade. Mensal 8000/18000/10000 para Basicâ†’Pro/Basicâ†’Premium/Proâ†’Premium; anual usa 11 mensalidades e preserva 365 dias. Premium/ilimitado permanece durante trial; perÃ­odo pago original nÃ£o muda e plano final Ã© derivado dos upgrades aplicados. CotaÃ§Ã£o tem identificador de validade, reserva revalida sob lock; mudanÃ§as exigem nova cotaÃ§Ã£o antes de emissÃ£o.

IntegraÃ§Ã£o PIX/cartÃ£o, verificaÃ§Ã£o manual e webhook na mesma confirmaÃ§Ã£o transacional; valor da cobranÃ§a vem da reserva. Locks restauranteâ†’fatura, claim Ãºnico/reconciliaÃ§Ã£o e idempotÃªncia preservados. PendÃªncia retÃ©m crÃ©dito; reuso da mesma fatura; nenhuma liberaÃ§Ã£o automÃ¡tica por vencimento/incerteza. Falha local comprovadamente sem POST permite retry da mesma intenÃ§Ã£o. Datas/planos/preÃ§os histÃ³ricos nÃ£o reconstruÃ­dos. TransiÃ§Ãµes sem histÃ³ria, downgrade, periodicidade diferente e upgrade de perÃ­odo pago bloqueados antes da emissÃ£o.

DECISÃƒO FINAL: confirmaÃ§Ã£o nova depois do fim original do trial OU estado/evidÃªncia divergente registra pagamento como recebido e review_required, sem aplicar upgrade/crÃ©dito/dias. Webhook received true/confirmed false; manual/checkout explicitam revisÃ£o. Nenhum dinheiro recebido Ã© descartado. Replay de aplicaÃ§Ã£o jÃ¡ confirmada permanece idempotente mesmo apÃ³s trial. ResoluÃ§Ã£o/reembolso/liberaÃ§Ã£o administrativa de intenÃ§Ãµes requer processo futuro; nÃ£o hÃ¡ nova tela/RPC para sobrescrever evidÃªncias. NÃ£o presumir que expirar PIX libera crÃ©dito.

Interface mostra destino/crÃ©dito/diferenÃ§a e datas preservadas, capacidade atual ilimitada e limite pÃ³s-trial. Realtime de fatura paga sÃ³ dispara sucesso apÃ³s confirmaÃ§Ã£o do servidor. Mantidos menu vinho, contraste, canais e demais trabalhos. Legado mantÃ©m dados; primeira contrataÃ§Ã£o e renovaÃ§Ã£o normal seguem caminhos base privados, com plano final considerado apÃ³s upgrade.

ExecuÃ§Ã£o ATUAL: PostgreSQL 17.11 D:/pgSQL, 127.0.0.1:55490, cluster TEMP encerrado, exit 0. 112 verificaÃ§Ãµes SQL de upgrade + 135 asserÃ§Ãµes operacionais apÃ³s migration; 84 testes de trial anteriores executados antes da migration no mesmo runner (nÃ£o confundir fases). Quatro pares independentes de psql com locks observados: entrega, primeira compra, reserva e confirmaÃ§Ã£o de upgrade. Node: 238 pass/4 skips anteriores/0 falhas, Asaas simulado. Typecheck/build exit 0. Logs docs/trial-upgrades-*.log; runner scripts/test-trial-upgrades-db.mjs exit 1 em falhas. Navegador integrado PENDENTE, nenhuma captura nova; mocks nÃ£o provam datas/cÃ¡lculos financeiros.

Futuro, NÃƒO executado: revisar prÃ©-requisitos/ordem no relatÃ³rio, aplicar apenas nova migration apÃ³s trial Premium, publicar asaas-checkout E asaas-webhook, depois frontend. RPC de reserva ganha parÃ¢metro opcional p_quote_token; sem overload conflitante. Primeira contrataÃ§Ã£o/renovaÃ§Ã£o continuam aceitando chamadas antigas; novo upgrade exige token. NÃ£o publicar novo handler sobre banco antigo. Sem SQL remoto, instalaÃ§Ã£o, deploy, commit ou push. Projetos llhujxzefujdsthpezag/rzhtndpselxsxgomclzo intocados. Codebase-memory indisponÃ­vel; decisÃµes mantidas aqui.

---
# Continuidade atual â€” trial Premium de 168 horas e contrataÃ§Ã£o antecipada

29/10/2026. Entrega concluÃ­da e validada LOCALMENTE. ReferÃªncia atual: docs/premium-trial-relatorio.md. O histÃ³rico abaixo fica preservado; a antiga indicaÃ§Ã£o de novo trial Pro foi substituÃ­da por esta entrega.

Nova migration incremental: 20261029143000_premium_trial_and_prepaid_cycle.sql. Novos cadastros por autoatendimento E plataforma capturam 168 horas Premium/ilimitado em subscription_quote_private.trial_terms, com origem explÃ­cita e imutabilidade. Repetir cadastro nÃ£o reinicia o teste. Reutiliza cycles/cycle_payments da Etapa 4A, sem fonte concorrente de datas; compra integral confirmada vincula fatura e ciclo mensal de 720h ou anual de 8760h. Exemplo SQL: compra apÃ³s 48h conserva 120h gratuitas, depois 30 dias pagos. Flag antiga false apÃ³s pagamento nÃ£o suprime Premium atÃ© o fim original. Sem compra, expiraÃ§Ã£o exata e sem carÃªncia. ContrataÃ§Ã£o tardia inicia perÃ­odo integral na confirmaÃ§Ã£o, sem retroagir por emissÃ£o de fatura.

DecisÃ£o efetiva central no servidor aplicada a mÃ³dulos, KDS, quotas, RPCs operacionais e snapshot da interface; sem gravaÃ§Ã£o em leitura. No fim: Basic/5 sem KDS-estoque-financeiro, Pro/20 com KDS sem estoque-financeiro, Premium ilimitado, sempre sujeito ao cargo. Atendimentos existentes podem ser concluÃ­dos; novos atendimentos acima da cota e consumo apÃ³s expiraÃ§Ã£o sem compra sÃ£o recusados. Preservadas entrega manual/FSM paga, pedidos e histÃ³ricos. Datas privadas protegidas contra alteraÃ§Ã£o e payload administrativo genÃ©rico.

Legados, trials antigos sem origem comprovada, preÃ§os/cotas customizados e faturas antigas NÃƒO foram reconstruÃ­dos nem convertidos. AdoÃ§Ã£o histÃ³rica requer evidÃªncia/decisÃ£o explÃ­cita futura. Novos pagamentos tÃªm fonte verificÃ¡vel; repetiÃ§Ã£o e concorrÃªncia nÃ£o duplicam ciclo/alocaÃ§Ã£o/auditoria/dias. Normal renovaÃ§Ã£o do mesmo plano/ciclo pÃ³s-trial permanece e ciclos acumulados nÃ£o sÃ£o tratados como um sÃ³. NÃ£o integrados upgrades/crÃ©ditos, downgrades ou mudanÃ§a de periodicidade; cotaÃ§Ã£o 4A permanece leitura.

EvidÃªncia da execuÃ§Ã£o atual: PostgreSQL 17.11 D:\pgSQL, cluster descartÃ¡vel 127.0.0.1:55489, encerrado, exit 0: 84 verificaÃ§Ãµes de trial/contrataÃ§Ã£o + 135 asserÃ§Ãµes operacionais. Duas concorrÃªncias reais por processos psql independentes, bloqueio observado: pagamento e entrega. npm test: 233 aprovados, 4 skips anteriores, 0 falhas; typecheck/build exit 0. Logs docs/premium-trial-*.log. Runner mantÃ©m exit 1 em qualquer falha. Checkout, verificaÃ§Ã£o manual e webhook testados em Node com Asaas simulado; todos chamam a mesma confirmaÃ§Ã£o SQL exercitada de verdade. Nenhum pagamento remoto nesta execuÃ§Ã£o.

Tarja real inspecionada em bancada isolada com snapshots fictÃ­cios: claro/escuro, desktop 1280 e celular 390, sem overflow, contraste 13,47:1. Dez capturas e observaÃ§Ãµes em docs/premium-trial-captures e docs/premium-trial-browser.json. PENDENTE navegador integrado autenticado de onboarding/checkout/pagamento/virada e mÃ³dulos em backend local completo. NÃ£o confundir bancada visual com autorizaÃ§Ã£o/pagamento integrados.

AplicaÃ§Ã£o/publicaÃ§Ã£o futura (NÃƒO executada): apÃ³s confirmar os prÃ©-requisitos comercial28223000, cotaÃ§Ã£o29000754, entrega29002852, contatos29010637 e contratos29024000, revisar/aplicar apenas a nova migration29143000 e depois publicar frontend. Lista das funÃ§Ãµes redefinidas no relatÃ³rio. Nenhuma Edge Function alterada; handlers atuais usam a mesma confirmaÃ§Ã£o, sem publicaÃ§Ã£o Edge necessÃ¡ria por estes arquivos. Compatibilidade com versÃµes implantadas deverÃ¡ ser conferida numa futura entrega autorizada. NÃ£o reaplicar histÃ³ricas do snapshot. Preservado todo trabalho anterior (menu vinho, contraste, contatos, contratos). Sem SQL remoto, instalaÃ§Ã£o, deploy, commit ou push. ProduÃ§Ã£o llhujxzefujdsthpezag e testes rzhtndpselxsxgomclzo intocados.

---
# Continuidade atual â€” bloqueio de Estoque e Financeiro por contrato

29/10/2026, retomada concluÃ­da localmente. RelatÃ³rio: docs/contract-modules-relatorio.md. NÃ£o confundir histÃ³rico abaixo com a revisÃ£o atual.

Migration incremental 20261029024000_contract_module_access.sql concluÃ­da: modelo contract_rights_model explÃ­cito, existentes legacy, novos commercial_v1 pelo DEFAULT/trigger. Legacy conserva direitos e trials vigentes; commercial_v1 Basic/Pro bloqueia Estoque/Financeiro, Premium intersecta cargo/vÃ­nculo. VersÃ£o imutÃ¡vel; payload genÃ©rico de identidade recusado. ConversÃ£o de legacy exige decisÃ£o/migration futura, nÃ£o ocorre por renovaÃ§Ã£o. Onboarding/criaÃ§Ã£o de plataforma, escritor de plano e confirmaÃ§Ã£o de pagamento reais testados, sem alteraÃ§Ãµes em suas implementaÃ§Ãµes. Novo onboarding mantÃ©m Pro/7 dias, com modelo commercial_v1; nenhum trial vigente convertido.

DecisÃ£o central no servidor, RLS RESTRICTIVE de estoque e alertas low_stock, trigger de vÃ­nculos por RPC/tabela, relatÃ³rio financeiro SECURITY DEFINER protegido. Consumo/totais operacionais e baixa interna de insumo herdado permanecem funcionando. save_menu_product conserva vÃ­nculo omitido e respeita null explÃ­cito. Rotas protegidas antes de montar componentes, CTA Assinatura & Planos; editor e painel inicial consultam a decisÃ£o antes de buscar dados restritos. Falhas recusam acesso; cache invalida por restaurante/revisÃ£o/plano.

Caixa manual continua em localStorage: bloqueio de interface, sem alegaÃ§Ã£o de proteÃ§Ã£o no servidor desses valores; nada apagado/migrado. NÃ£o foram alterados preÃ§os, cobranÃ§as, cotaÃ§Ã£o 4A, upgrades/downgrades, Realtime ou duraÃ§Ã£o/plano de trial.

ExecuÃ§Ã£o ATUAL: SQL real final exit 0 em PostgreSQL 17.11 D:\pgSQL, 127.0.0.1:55488, cluster TEMP encerrado: 55 verificaÃ§Ãµes contratuais e 135 asserÃ§Ãµes operacionais (inclui venda/baixa apÃ³s downgrade, entrega/fechamentos e concorrÃªncia real/idempotÃªncia). npm test 233 pass, 4 skips preexistentes, 0 falhas; transporte de acesso testado com mocks, distinto da prova SQL. Typecheck/build atuais exit 0. Logs docs/contract-modules-*.log. Runner mantÃ©m exit 1 em falhas.

PENDENTE: navegador autenticado local para rotas/bloqueios/CTA, editor, painel e histÃ³ricos de caixa; nÃ£o executado nesta retomada. Sem captura nova desses mÃ³dulos. RevisÃ£o visual, menu e contatos anteriores preservados; capturas antigas nÃ£o provam estes bloqueios. Tool codebase-memory indisponÃ­vel, registro mantido aqui.

Entrega Ãºnica por scripts/package-contract-modules.ps1: fontes, migration, testes/runners, logs, relatÃ³rio, continuidade e manifesto SHA256 verificado. Snapshot de contexto inclui alteraÃ§Ãµes anteriores, sem atribuÃ­-las a esta etapa. Sem secrets/dependÃªncias/build. NÃ£o executados banco remoto, instalaÃ§Ã£o, deploy, commit ou push. ProduÃ§Ã£o llhujxzefujdsthpezag e testes rzhtndpselxsxgomclzo intocados.

---

## HistÃ³rico anterior preservado

# AtualizaÃ§Ã£o visual do menu â€” 28/10/2026

Print 1 priorizado: cÃ¡psula 999px vinho #501600, branco, sem sublinhado, sombra suave. Cor independente de restaurant.theme.primary (origem do laranja). Capturas mobile Atendimento/Comandas refeitas nos dois temas em bancada local. RelatÃ³rio docs/nav-contacts-relatorio.md. HistÃ³rico abaixo descreve versÃµes anteriores.

# Continuidade atual â€” menu do garÃ§om e canais de contato

28/10/2026. RelatÃ³rio da entrega Ãºnica: docs/nav-contacts-relatorio.md; Ã­ndice LEIA-ME-ENTREGA.md. HistÃ³rico anterior preservado abaixo.

Menu: pill arredondada ativa usa restaurant.theme.primary com texto/Ã­cone preto ou branco por contraste. Regras de rota existentes mantidas, Mais/perfil/histÃ³rico priorizados; Link permite aria-current consistente, inclusive ?mesa, sem duas abas atuais. Demais abas sem preenchimento selecionado. Foco visÃ­vel e indicador complementar preservados.

Contatos: interruptores independentes e acessÃ­veis em IdentityPage para Instagram, WhatsApp e Facebook/Site; salvamento atÃ´mico junto da identidade, valores conservados ao desativar. HomePage/prÃ©via filtram habilitaÃ§Ã£o, vazio e URL vÃ¡lida. Nova migration incremental 20261029010637_restaurant_contact_channels.sql (somente local descartÃ¡vel) acrescenta JSONB anulÃ¡vel, valida estrutura e estende save_restaurant_identity/get_public_restaurant, preservando autorizaÃ§Ã£o, locks, revisÃ£o e grants. Nenhuma migration histÃ³rica alterada nesta rodada. NULL mantÃ©m fallback legado ativado; primeiro salvamento administrativo importa valores disponÃ­veis no navegador, depois servidor Ã© fonte de verdade. NÃ£o pressupor migraÃ§Ã£o de contatos que existam sÃ³ em outro navegador.

Executado: 19 verificaÃ§Ãµes SQL reais, PostgreSQL 17.11 em D:\pgSQL, somente 127.0.0.1:55487, cluster TEMP encerrado; salvar/recarregar/desativar/reativar todos os canais, leitura anÃ´nima, compatibilidade, revisÃ£o antiga, negativas e snapshots completos A/B. npm test: 230 pass, 4 skips antigos preservados, zero falhas. Typecheck/build finais exit 0. Logs docs/nav-contacts-*.log e docs/contacts-sql-resultados.log. Contraste de cores computadas aprovado nas amostras, via scripts/check-nav-contacts-contrast.mjs.

Navegador: abas Atendimento e Comandas capturadas separadamente nos dois temas; Chamados, histÃ³rico de Mais e ?mesa com destaque Ãºnico. Bancada extrai nav real, mantendo conteÃºdo fictÃ­cio de Mais. Contatos testados com IdentityPage/HomePage reais e transporte HTTP fictÃ­cio separado do SQL: salvar/reload, trÃªs canais desligados com valores conservados, reativaÃ§Ã£o sem redigitar, links pÃºblicos e vazio. Viewports celular/desktop, foco e interruptores conferidos. NÃ£o confundir bancada com sessÃ£o autenticada/PostgREST integrado.

Pendentes: navegador autenticado com backend local completo e telas operacionais/compartilhadas descritas no relatÃ³rio anterior. NÃ£o hÃ¡ nova validaÃ§Ã£o remota. Nenhuma alteraÃ§Ã£o de assinatura, pagamentos, trial, pedidos ou regras de acesso alÃ©m da persistÃªncia autorizada dos contatos. Ferramentas codebase-memory nÃ£o estavam disponÃ­veis nesta sessÃ£o.

ZIP Ãºnico por scripts/package-nav-contacts.ps1, com fontes, contexto de reproduÃ§Ã£o, capturas realmente obtidas, testes, runners, logs, relatÃ³rio e manifesto por grupos/SHA256. Sem secrets, node_modules ou dist. ProduÃ§Ã£o llhujxzefujdsthpezag e testes remoto rzhtndpselxsxgomclzo intocados. Sem SQL remoto, deploy, commit ou push.

---

## HistÃ³rico anterior preservado

# Continuidade atual â€” contraste e legibilidade

28/10/2026. RelatÃ³rio: docs/contrast-relatorio.md. Corrigido reset global de links que anulava cores Tailwind e deixava navegaÃ§Ã£o dark marrom escura. Reset em @layer base; heranÃ§a dark por tokens; bordas/placeholders/foco compartilhados; desabilitados legÃ­veis com tracejado; nav ativa com sublinhado e aria-current. Cores dark complementadas nos painÃ©is do garÃ§om e painÃ©is de comanda compartilhados. Vermelho habilitado principal e layout preservados.

Somente className nos sete TSX alterados, mais styles.css (contrast-integridade.txt). Sem mudanÃ§as de lÃ³gica, backend, migrations, pedidos, assinatura ou cotaÃ§Ã£o. AlteraÃ§Ãµes preexistentes preservadas.

Navegador: bancada local isolada, pÃ¡gina Mais e navegaÃ§Ã£o reais, dados fictÃ­cios, 390x844 e 1280x900, ambos os temas, formulÃ¡rio real e modal de saÃ­da. NÃ£o usou .env ou Supabase. Menu auxiliar/select sÃ£o representativos, nÃ£o dropdown do salÃ£o. Capturas reais antes/depois mobile e depois desktop completo incluÃ­das. Viewport restaurado e servidor encerrado ao final.

Cores computadas: nav 7,36â€“13,74:1 claro e 14,89â€“16,23:1 dark; placeholder >=4,80:1; bordas >=4,28:1. Amostras passam AA, nÃ£o certificaÃ§Ã£o global. Foco dark observado com outline solid 3px. CÃ¡lculo reproduzÃ­vel: node scripts/check-rendered-contrast.mjs. Typecheck e build finais: exit 0, logs docs/contrast-*.log.

Pendente: navegaÃ§Ã£o integrada com sessÃ£o/dados reais em StaffServicePage (salÃ£o/filtros/menus), StaffComandasOperationalPage, ComandasPage, ChamadosPage, StaffHistoryPage, modais reais de TableTabsPanel/TableDetailsTabPanel e formulÃ¡rios/modais administrativos compartilhados. Hover/mouse/touch e popup nativo de select precisam conferÃªncia visual integrada. Build nÃ£o comprova esses estados.

Reproduzir bancada: node scripts/preview-contrast.mjs (ou --before com snapshot CSS). Fora do entrypoint de produÃ§Ã£o; requer repositÃ³rio-base/dependÃªncias locais existentes, sem instalaÃ§Ã£o feita. Nenhuma rota de autenticaÃ§Ã£o real foi liberada ou alterada.

ZIP Ãºnico via scripts/package-contrast.ps1, em artifacts/contrast-*.zip, com fontes alteradas, relatÃ³rio, provas, capturas reais, continuidade e manifesto verificado. Sem segredos, dependÃªncias instaladas ou build. Sem SQL remoto, deploy, commit ou push; produÃ§Ã£o e projeto de testes intocados.

---

## HistÃ³rico anterior preservado

# Continuidade atual â€” entrega manual no BÃ¡sico implementada localmente

28/10/2026, America/Sao_Paulo. Documento atual: docs/basic-delivery-relatorio.md. HistÃ³rico da revisÃ£o sem KDS e Etapa 4A preservado abaixo; o bloqueio de entrega descrito no histÃ³rico foi corrigido LOCALMENTE nesta entrega.

## ImplementaÃ§Ã£o

Migration incremental 20261029002852_basic_manual_delivery.sql redefine somente update_tab_item_production_status. Basic aceita target delivered para pending/preparing/ready, por responsÃ¡vel do atendimento ou admin ativo do alvo. Sem bypass de platform admin sem vÃ­nculo nesse caminho. MantÃ©m restaurante/membro/contexto/item ativo, locks e rechecagem apÃ³s item lock; repetiÃ§Ã£o nÃ£o sobrescreve timestamp nem executa novo UPDATE.

KDS e preparing/ready continuam exclusivos Pro/Premium; FSM paga preservada. NÃ£o fabrica preparo em entrega manual (inclusive exceÃ§Ã£o none). NÃ£o confirma entrega ao fechar conta ou mudar plano. Sem ampliaÃ§Ã£o de grants.

TableTabsPanel e novo manualDelivery.ts: botÃ£o Confirmar entrega nos trÃªs estados Basic; somente ready nos pagos. Sem UPDATE direto ou sucesso otimista. Valida retorno RPC com IDs/tenant/visita/comanda/status/timestamp; recarrega em finally. Grupo pode persistir parcialmente; erro nÃ£o anuncia sucesso e a leitura restaura o estado real. Falha de leitura marca consumo stale/error. Teste novo incluÃ­do em npm test.

NÃ£o alteradas migrations histÃ³ricas, preÃ§os, trial, cotaÃ§Ã£o 4A, emissÃ£o Asaas, webhook ou confirmaÃ§Ã£o de assinatura. Arquivo docs/basic-delivery-integridade.txt confirma alteraÃ§Ãµes funcionais limitadas contra snapshot anterior.

## EvidÃªncia FINAL

- node scripts/test-basic-delivery-db.mjs: exit 0. PostgreSQL 17.11, cluster exclusivo TEMP/127.0.0.1:55486, encerrado em finally. 131 assertions sequenciais + 3 de concorrÃªncia = 134. Pedidos cliente/garÃ§om; Basic pending/preparing/ready; downgrades; negativas sem alteraÃ§Ãµes; repetiÃ§Ã£o; FSM paga; fechamento sem entrega automÃ¡tica. Dois backends independentes, bloqueio observado, respostas e timestamp idÃªnticos, um Ãºnico evento em trigger observador SOMENTE DE TESTE.
- npm.cmd test: exit 0, 231 testes / 227 aprovados / 4 ignorados / zero falhas. Mantidos todos os ignorados anteriores.
- npm.cmd run typecheck: exit 0.
- npm.cmd run build: exit 0, Vite concluÃ­do. dist gerado e ignorado nÃ£o entra na entrega.
- Logs docs/basic-delivery-sql-resultados.log, basic-delivery-node-resultados.log, basic-delivery-typecheck.log, basic-delivery-build.log.

Navegador NÃƒO executado. Validar em rodada futura a posiÃ§Ã£o/aÃ§Ã£o do botÃ£o, rÃ³tulos do cliente, falha/recarga, duplo clique e realtime entre dispositivos. Helpers, SQL e build nÃ£o substituem essas verificaÃ§Ãµes.

## Entrega e limites

scripts/package-basic-delivery.ps1 gera ZIP Ãºnico em artifacts/basic-delivery-*.zip, somente arquivos alterados/novos e bootstrap prÃ©-requisito, testes, logs, relatÃ³rio, continuidade e manifesto SHA-256 verificado. Aplicar sobre repositÃ³rio-base para reproduzir os testes; nÃ£o inclui todas as migrations anteriores/seeds, jÃ¡ presentes no projeto. Preserva trabalhos existentes/untracked.

Sem novas dependÃªncias ou instalaÃ§Ã£o, banco remoto, deploy, commit ou push. ProduÃ§Ã£o llhujxzefujdsthpezag e testes rzhtndpselxsxgomclzo intocados. Migration NÃƒO aplicada remotamente. CotaÃ§Ã£o 4A permanece sem integraÃ§Ã£o financeira nova.

---

## HistÃ³rico anterior preservado

# Continuidade atual â€” verificaÃ§Ã£o focada sem KDS

28/10/2026, America/Sao_Paulo. Entrega de revisÃ£o, sem alteraÃ§Ã£o funcional. Documento: docs/no-kds-relatorio.md.

## Resultado comprovado e limite

BÃ¡sico cria pedidos por cliente/garÃ§om, equipe lÃª consumo fora do KDS, cliente pede conta, garÃ§om atende conta e fecha comanda/mesa sem exigir produÃ§Ã£o entregue. HistÃ³rico e isolamento nos caminhos testados preservados.

HÃ¡ bloqueio operacional: kitchen/bar nascem pending e nÃ£o podem registrar avanÃ§o/entrega no BÃ¡sico. update_tab_item_production_status bloqueia pelo plano; fallback UPDATE direto de TableTabsPanel tambÃ©m retorna 42501. none nasce delivered. Pro/Premium com pending/preparing/ready ao baixar para Basic preserva itens, mas perde as transiÃ§Ãµes de produÃ§Ã£o. Isso nÃ£o impede fechamento financeiro; NÃƒO comprova fluxo completo sem pedidos presos.

SuÃ­te local nova: node scripts/test-no-kds-db.mjs. PostgreSQL 17.11 nativo em D:\pgSQL\bin, cluster exclusivo TEMP, 127.0.0.1:55485. 86 migrations somente atÃ© Etapa 3, sem aplicar/testar cotaÃ§Ã£o 4A. Resultado FINAL exit 0, 104 asserÃ§Ãµes observacionais, seis combinaÃ§Ãµes origem/estaÃ§Ã£o e dois downgrades; bloqueio reproduzido faz parte das assertions. Cluster encerrado. Log docs/no-kds-sql-resultados.log.

Dois testes Node existentes: chamados e tableTabsClosing; 30 aprovados, 3 ignorados, exit 0. SÃ£o mocks/helpers, nÃ£o navegador. Navegador NÃƒO executado. NÃ£o declarar jornada visual validada. Sem build ou instalaÃ§Ã£o.

## Proposta, nÃ£o implementada

Permitir somente confirmaÃ§Ã£o manual de entrega no Basic pela equipe autorizada, preservando bloqueio da esteira KDS, estados de preparo, isolamento e rastreabilidade. ExceÃ§Ã£o estrita para delivered na RPC atual e aÃ§Ã£o no painel para pending/preparing/ready; sem UPDATE direto de cliente ou conversÃ£o automÃ¡tica ao fechar/baixar plano. Exige testes de permissÃ£o e persistÃªncia em entrega posterior. NÃ£o foi implementada.

## PreservaÃ§Ã£o e entrega Ãºnica

Hashes antes/depois iguais para src, supabase/migrations e supabase/functions (docs/no-kds-integridade.txt e arquivos SHA256). NÃ£o houve mudanÃ§as de cÃ³digo funcional, migrations, regras comerciais ou cotaÃ§Ã£o 4A. Etapas anteriores continuam no histÃ³rico abaixo, sem integraÃ§Ã£o nova. Sem remoto, deploy, commit ou push. Projetos llhujxzefujdsthpezag e rzhtndpselxsxgomclzo intocados.

scripts/package-no-kds-review.ps1 gera ZIP Ãºnico em artifacts/no-kds-review-*.zip: relatÃ³rio, testes/runner, evidÃªncias, continuidade, fontes inalteradas de apoio e cadeia SQL anterior necessÃ¡ria, com caminhos relativos e manifesto SHA-256 verificado. Sem secrets, node_modules, .git, dist, binÃ¡rios ou cluster. Encaminhar apenas o ZIP mais novo dessa revisÃ£o; os ZIPs anteriores sÃ£o de outras entregas.

---

## HistÃ³rico anterior preservado

# Continuidade atual â€” Etapa 4A, somente cotaÃ§Ã£o

Atualizado em 28/10/2026 (America/Sao_Paulo). Documento atual: docs/etapa4a-cotacao.md. HistÃ³rico da Etapa 3 preservado abaixo.

## Estado informado pelo usuÃ¡rio e limites

A migration comercial da Etapa 3 jÃ¡ foi aplicada no projeto de TESTES e asaas-checkout foi publicado fora desta rodada. NÃ£o editar mais essa migration. O usuÃ¡rio confirmou Premium mensal 27990 e Basic anual 109890 em sandbox e perÃ­odos acumulados atÃ© 2028. Isso NÃƒO comprova um Ãºnico ciclo. Projetos llhujxzefujdsthpezag (produÃ§Ã£o) e rzhtndpselxsxgomclzo (testes) nÃ£o foram acessados nesta execuÃ§Ã£o.

## Entrega 4A implementada e testada localmente

Nova migration incremental supabase/migrations/20261029000754_subscription_transition_quotes.sql cria apenas evidÃªncias privadas e RPC autenticada quote_subscription_transition(uuid,text,text), sem mudar emissÃ£o, confirmaÃ§Ã£o, webhook, frontend, trial, plano/capacidade ou dados reais.

RPC autoriza admin ativo do alvo ou platform admin, recusa anÃ´nimos e calcula no servidor. Retorna operaÃ§Ã£o, planos, ciclo, integral/crÃ©dito/cobranÃ§a em centavos, datas previstas e evidÃªncia/indisponibilidade. CotaÃ§Ã£o nÃ£o autoriza pagamento e exige revalidaÃ§Ã£o transacional na prÃ³xima etapa.

Registros privados: trial_terms (inÃ­cio/fim original), cycles (plano/ciclo/inÃ­cio/fim/preÃ§o contratado), cycle_payments (fatura confirmada alocada a um Ãºnico ciclo). NÃ£o existe backfill nem integraÃ§Ã£o/escritor nesta entrega. Logo, dados reais legados nÃ£o se tornam elegÃ­veis por mera existÃªncia de faturas ou vencimento. A prÃ³xima etapa precisa registrar evidÃªncias confiÃ¡veis em transaÃ§Ã£o com o fluxo financeiro; nÃ£o inserir contratos antigos por inferÃªncia.

Mensal 30 dias exatos, anual 365 dias e 11 mensalidades. Upgrade vigente: dÃ©bito proporcional arredondado para cima e crÃ©dito contratado proporcional para baixo; usa segundos do ciclo real, preserva fim. Trial integral comeÃ§a apÃ³s fim original; upgrade futuro pago usa crÃ©dito apenas do mesmo ciclo e mantÃ©m datas. Downgrade Ã© somente previsÃ£o do prÃ³ximo ciclo, sem reembolso e sem gravar agendamento.

Bloqueados: mudanÃ§a mensal/anual, mÃºltiplos ciclos antecipados, pagamentos confirmados sem alocaÃ§Ã£o ou inconsistentes, histÃ³rico ausente, saldo acumulado divergente, ciclo futuro fora de trial comprovado, operaÃ§Ãµes indefinidas de contrataÃ§Ã£o futura e preÃ§o de destino menor que contrato. Assinatura expirada sem ciclo vigente tambÃ©m indisponÃ­vel nesta versÃ£o. Nunca inferir o ciclo por subscription_expires_at sozinho.

## EvidÃªncia e reproduÃ§Ã£o

node scripts/test-subscription-quotes-db.mjs

Ãšltima execuÃ§Ã£o FINAL: exit 0, todos os cenÃ¡rios SQL concluÃ­dos; log docs/etapa4a-sql-resultados.log. PostgreSQL 17.11 existente em D:\pgSQL\bin; cluster exclusivo em TEMP, 127.0.0.1:55484; encerrado no finally. Sem instalaÃ§Ã£o ou conexÃ£o remota. Bootstrap mÃ­nimo de auth/storage Ã© fixture, nÃ£o Supabase real.

Testes: renovaÃ§Ã£o mensal/anual; upgrade mensal/anual descontado; trial sem/com contrataÃ§Ã£o paga; downgrade futuro; crÃ©dito de mesmo ciclo e exclusÃ£o de outro passado; bloqueios de dados ausentes, acumulados, faturas pendentes/sem alocaÃ§Ã£o/crÃ©dito insuficiente e mensal/anual; roles/isolamento. Snapshots em cada cotaÃ§Ã£o comprovam ausÃªncia de alteraÃ§Ãµes em assinaturas, mesas, faturas, auditoria e evidÃªncias.

Sem build/typecheck/npm: alteraÃ§Ãµes somente SQL, runner de teste, documentos e empacotamento. Nenhuma mudanÃ§a nas fontes existentes ou migrations anteriores. Regras de Estoque/Financeiro seguem adiadas.

Gerar ZIP dos arquivos da entrega: scripts/package-subscription-quotes.ps1. ContÃ©m migration incremental, teste SQL, runner, bootstrap necessÃ¡rio, docs/log/continuidade e empacotador, com manifesto SHA-256 verificado. Requer repositÃ³rio-base com migrations e seeds anteriores para reproduÃ§Ã£o. ZIP nÃ£o Ã© transiÃ§Ã£o completa nem publicaÃ§Ã£o.

## PrÃ³ximas decisÃµes

Definir e implementar registro autoritativo de ciclos/trial original/pagamentos, polÃ­tica de preÃ§os negociados e arredondamento antes da cobranÃ§a, conversÃ£o mensal/anual, mÃºltiplos ciclos, recontrataÃ§Ã£o apÃ³s expiraÃ§Ã£o e estornos. Integrar cotaÃ§Ã£o com revalidaÃ§Ã£o e somente depois alterar emissÃ£o/confirmaÃ§Ã£o em entrega separada. NÃ£o usar diretamente o fluxo atual para executar as novas regras: ele permanece propositalmente inalterado.

Sem SQL remoto, deploy, commit ou push. ProduÃ§Ã£o intocada.

---

## HistÃ³rico da etapa anterior (nÃ£o Ã© o estado remoto atual)

# Continuidade Ã¢â‚¬â€ Etapa 3 / correÃƒÂ§ÃƒÂ£o de isolamento

Atualizado em 28/10/2026. ReferÃƒÂªncias: docs/auditoria-retomada-2026-10-28.md (histÃƒÂ³rica) e docs/etapa3-validacao-local.md (resultado atual).

## Estado atual confiÃƒÂ¡vel

CorreÃƒÂ§ÃƒÂ£o de isolamento concluÃƒÂ­da LOCALMENTE e suÃƒÂ­te SQL completa aprovada com exit 0. Log final: docs/etapa3-sql-resultados.log. Substitui a falha documentada na rodada anterior.

sync_restaurant_tables_to_plan_limit(uuid) ÃƒÂ© auxiliar interna. AusÃƒÂªncia de chamadas de aplicaÃƒÂ§ÃƒÂ£o em src confirmada. ACL anterior herdava authenticated; a migration ainda nÃƒÂ£o aplicada 20261028223000_commercial_catalog_modules_and_active_tables_quota.sql agora revoga execuÃƒÂ§ÃƒÂ£o de PUBLIC, anon, authenticated e service_role. Somente proprietÃƒÂ¡rio conserva execuÃƒÂ§ÃƒÂ£o. Nenhuma migration histÃƒÂ³rica alterada.

Chamadores finais SECURITY DEFINER do mesmo proprietÃƒÂ¡rio: confirm_subscription_invoice_payment, update_restaurant_saas_plan, update_platform_plan_catalog, close_table_visit, reset_and_release_table e delete_restaurant_table. Todos exercitados por entradas legÃƒÂ­timas. Pagamento via service_role, operaÃƒÂ§ÃƒÂµes de plataforma via platform admin e encerramento/liberaÃƒÂ§ÃƒÂ£o via garÃƒÂ§om continuam funcionando.

RegressÃƒÂµes em supabase/tests/etapa3_sync_isolation_test.sql: oito perfis sem execuÃƒÂ§ÃƒÂ£o direta, todos retornam 42501 e deixam integralmente inalteradas todas as mesas do alvo. Inclui admin A contra B, anon, sem vÃƒÂ­nculo, garÃƒÂ§om, admin inativo, admin do alvo, platform admin e service_role.

CenÃƒÂ¡rios comerciais, concorrÃƒÂªncia de cota e pagamento e idempotÃƒÂªncia preservados. Corridas usam processos psql/backends independentes, pg_blocking_pids e observaÃƒÂ§ÃƒÂ£o real dos locks. Fixture de sincronizaÃƒÂ§ÃƒÂ£o global roda apÃƒÂ³s as corridas para nÃƒÂ£o alterar sua cota.

## ReproduÃƒÂ§ÃƒÂ£o

node scripts/test-commercial-stage3-db.mjs

PostgreSQL 17.11 disponÃƒÂ­vel em D:\pgSQL\bin. Runner cria e encerra cluster exclusivo em TEMP, somente 127.0.0.1:55483. Pode exigir autorizaÃƒÂ§ÃƒÂ£o de processo fora do sandbox. Sem instalaÃƒÂ§ÃƒÂ£o, .env, credenciais ou SQL remoto. Qualquer falha mantÃƒÂ©m exit 1.

scripts/package-commercial-stage3.ps1 gera novo ZIP em artifacts com manifesto SHA-256, verificando cada entrada. Inclui SQL de isolamento e migration corrigida. ZIPs anteriores permanecem como histÃƒÂ³rico do estado reprovado; usar o mais novo.

## Limites preservados

ProduÃƒÂ§ÃƒÂ£o llhujxzefujdsthpezag intocada. Sem remoto, deploy, commit ou push. AlteraÃƒÂ§ÃƒÂµes prÃƒÂ©-existentes/untracked preservadas. Sem mudanÃƒÂ§as em frontend ou regras comerciais. Estoque/Financeiro por plano continuam adiados.

NÃƒÂ£o repetidos build/typecheck/npm nesta correÃƒÂ§ÃƒÂ£o SQL. ÃƒÅ¡ltimo npm test da rodada anterior: 226 testes, 222 aprovados, 4 ignorados; log docs/etapa3-npm-test.log. NÃƒÂ£o retomados equipe, transferÃƒÂªncias, trial e publicaÃƒÂ§ÃƒÂ£o.

O antigo scripts/test-security-hardening-db.mjs contÃƒÂ©m expectativa de execuÃƒÂ§ÃƒÂ£o direta por administrador sob a polÃƒÂ­tica histÃƒÂ³rica; essa expectativa foi superada pela escolha explÃƒÂ­cita de funÃƒÂ§ÃƒÂ£o interna. NÃƒÂ£o restaurar grants para satisfazÃƒÂª-la. Esse teste antigo nÃƒÂ£o foi executado nem modificado.

Sem pendÃƒÂªncia local desta correÃƒÂ§ÃƒÂ£o. NÃƒÂ£o presumir deploy ou aplicaÃƒÂ§ÃƒÂ£o remota a partir deste resultado.
---

# RegressÃ£o de chamados, acesso e navegaÃ§Ã£o â€” 30/10/2026

DiagnÃ³stico e ajuste local documentados em `docs/regressao-chamados-acesso-20261030.md`.

No Supabase autorizado `rzhtndpselxsxgomclzo`, somente leitura: logs mostram 4 cancelamentos recentes de `service_requests`, ~30 timeouts em `get_table_tab_consumption` e um Auth 504. EstatÃ­sticas agregadas apontam mÃ©dia da lista de chamados de 23 ms e mÃ©dia da RPC de consumo de 860 ms (mÃ¡ximo ~7,75 s); sem lock waiter no snapshot. As estatÃ­sticas nÃ£o identificam qual requisiÃ§Ã£o produziu cada erro. RLS e vÃ­nculos permanecem intactos.

Frontend ajustado: `StaffChamadosContext` serializa recargas e ignora eventos de itens que nÃ£o entram/saem da fila pronta; guard de acesso coalesce verificaÃ§Ãµes e distingue timeout de ausÃªncia de vÃ­nculo. Timeout mostra erro temporÃ¡rio com retry, sem redirecionar nem conceder acesso. A fixture da consulta foi corrigida para usar os dois filtros `.in()` reais.

ValidaÃ§Ã£o atual: testes direcionados 37/37; `npm test` 267 aprovados, 4 skips preexistentes; typecheck e build aprovados. Sem SQL novo ou migration. Navegador continua pendente por interrupÃ§Ã£o de seguranÃ§a anterior; instruÃ§Ãµes manuais estÃ£o no relatÃ³rio. A alternÃ¢ncia automÃ¡tica Admin/KDS nÃ£o foi encontrada no cÃ³digo: ambas rotas compartilham o guard e a Ãºnica saÃ­da do KDS Ã© aÃ§Ã£o explÃ­cita com PIN/senha.

# IntegraÃ§Ã£o da interface de fechamento conjunto â€” 30/10/2026

O usuÃ¡rio informou que executou manualmente o fluxo integrado de chamados e pagamento conjunto e que funcionou. Este Ã© relato manual do usuÃ¡rio; nÃ£o Ã© validaÃ§Ã£o automatizada nem validaÃ§Ã£o visual desta alteraÃ§Ã£o de interface.

Ajuste local: em `TableTabsPanel.tsx`, o cartÃ£o seletor passou a explicitar â€œConta conjunta â€” Mesa todaâ€; o botÃ£o avulso foi removido de `TableTabsPaymentDialog.tsx`. A seleÃ§Ã£o conjunta mostra somente consumos das comandas abertas da visita, deduplica IDs de itens e soma a taxa uma vez por comanda, conforme arredondamento do fechamento existente. â€œFechar conta conjuntaâ€, ao lado de â€œDividir contaâ€, abre o mesmo diÃ¡logo com todas as comandas abertas selecionadas inicialmente. A seleÃ§Ã£o de pessoa mantÃ©m o fechamento individual. â€œDividir contaâ€ captura o contexto/valor da seleÃ§Ã£o no momento do clique e nÃ£o herda silenciosamente a Ãºltima pessoa.

ServiÃ§os de cotaÃ§Ã£o/confirmaÃ§Ã£o, RPCs, permissÃµes, idempotÃªncia e atomicidade nÃ£o foram alterados. O diÃ¡logo continua usando `preview_table_tabs_payment` e `close_table_tabs`.

ValidaÃ§Ã£o do ajuste atual: `node --experimental-strip-types --loader ./tests/test_loader.mjs --test tests/tableTabsClosing.test.ts` â€” 18 aprovados, 3 skips existentes, 0 falhas. Inclui seleÃ§Ã£o aberta sem IDs duplicados, soma sem duplicar itens/taxa e contexto de â€œDividir contaâ€. `npm.cmd run typecheck` e `npm.cmd run build` passaram. NÃ£o houve conferÃªncia visual no navegador nesta rodada; celular permanece para confirmaÃ§Ã£o manual.
---
# Desempenho de get_table_tab_consumption â€” 30/10/2026

RelatÃ³rio: docs/desempenho-get-table-tab-consumption-20261030.md. Projeto rzhtndpselxsxgomclzo consultado somente para leitura. ProduÃ§Ã£o e Asaas nÃ£o acessados.

DiagnÃ³stico remoto: 306 chamadas acumuladas Ã  RPC individual, mÃ©dia 929,6 ms, mÃ¡ximo 7.747,6 ms e 45.191 shared hits. Logs registraram 27 timeouts no contexto da funÃ§Ã£o entre 22:55:39 e 22:59:50. Estimativas de dados: 38 itens, 20 comandas, 15 produtos, 9 categorias. Isso confirma repetiÃ§Ã£o/timeouts, mas nÃ£o prova que volume de dados sozinho cause a latÃªncia. Foram lidos funÃ§Ã£o, consultas agregadas, Ã­ndices, RLS e estatÃ­sticas. Nenhum EXPLAIN remoto ou alteraÃ§Ã£o remota.

Causa de amplificaÃ§Ã£o cliente: TableTabsPanel consultava get_table_tab_consumption uma vez por comanda aberta em cada refresh e qualquer evento de item iniciava nova carga completa; respostas ultrapassadas eram descartadas apÃ³s as consultas. A RPC tambÃ©m recompunha catÃ¡logo nÃ£o utilizado pelo painel.

CorreÃ§Ã£o local: migration incremental supabase/migrations/20261031015051_get_visit_tab_consumptions.sql adiciona RPC SECURITY INVOKER com permissÃ£o authenticated, respeitando RLS e retornando consumos das comandas abertas em um snapshot sem catÃ¡logo. TableTabsPanel faz uma chamada por visita, agrupa/serializa refreshes (120 ms) e mantÃ©m versÃµes por comanda para proteger recargas especÃ­ficas de respostas antigas. Usos individuais da RPC e os dados financeiros nÃ£o mudaram.

Teste local: node scripts/test-visit-tab-consumptions-db.mjs; PostgreSQL 17.11 descartÃ¡vel em 127.0.0.1:55496; migrations locais completas; exit 0; cluster encerrado/removido. SQL comprovou paridade com a RPC individual, totais e RLS para usuÃ¡rio sem vÃ­nculo e restaurante divergente. EXPLAIN ANALYZE em 20 comandas/10.000 itens sintÃ©ticos: 20 chamadas, 547,983 ms/2.254 shared hits; em lote, 1 chamada, 493,043 ms/1.939 hits. AgregaÃ§Ã£o individual mudou de dois scans indexados (57 hits/18,275 ms) para um (32 hits/17,009 ms). JSON: docs/consumption-performance-local.json. Medida local nÃ£o prevÃª latÃªncia hospedada.

npm.cmd test: 270 aprovados, 4 skips existentes, 0 falhas. typecheck e build passaram. Naquele registro, a migration ainda nao estava aplicada remotamente; veja a atualizacao posterior. Nao houve navegador; a medicao autenticada segue pendente.
Nota de ferramenta: Supabase CLI e node_modules/.bin/supabase.cmd ausentes localmente; nÃ£o instalei. A migration foi adicionada como arquivo incremental e validada no cluster PostgreSQL descartÃ¡vel.



## Aplicacao autorizada da RPC de consumo por visita - 30/10/2026

O projeto retornado pela API foi eloozi-testes, ref rzhtndpselxsxgomclzo. .env.local aponta para esse host e supabase/.temp/project-ref contem o mesmo ref; nenhum valor de chave foi lido. O Supabase CLI continua ausente.

Antes da aplicacao, o historico remoto terminava em 20261030223205 (service_call_cycles_and_group_payment). A versao local 20261030230000 nao existia remotamente e era a unica migration local posterior. O aplicador MCP registrou a migration autorizada como timestamp UTC 20261031015051, nome get_visit_tab_consumptions; nao aplicou nenhuma outra migration. O registro fica depois da ultima versao anterior. A comparacao final encontrou 95 versoes locais e 95 remotas, sem diferencas ou migrations pendentes. MD5 do SQL local sem CR/LF finais e do statement remoto normalizado: e8484f7f02a90f9b7814c662abaac940; ambos com 1.429 caracteres. Para evitar divergencia futura, o arquivo local foi renomeado para o timestamp efetivamente registrado; o conteudo SQL permaneceu identico.

Verificacao pos-aplicacao: assinatura public.get_visit_tab_consumptions(uuid, uuid), STABLE, SECURITY INVOKER, search_path vazio. authenticated pode executar; anon nao pode (tentativa direta retornou permission denied for function). O ACL tambem lista service_role, mas ele nao foi usado em nenhum teste. RLS permanece habilitado em table_tabs e table_tab_items, com as policies existentes de membro ativo/cliente vinculado e vinculo item-comanda; nenhuma policy foi modificada.

Teste de execucao: SET LOCAL ROLE authenticated, request.jwt.claim.sub configurado com o user_id de uma associacao ativa e leitura da propria associacao sob RLS; a RPC foi chamada com o restaurante proprio e retornou []. Esse e um contexto de banco com role authenticated, nao um login HTTP/PostgREST com JWT assinado. O projeto tinha zero mesas, visitas e comandas abertas no momento, portanto o teste comprova EXECUTE e contexto RLS sem service_role, mas nao comprova retorno positivo de itens de uma comanda real. A tentativa como anon foi recusada. Nao foi criada nem alterada nenhuma linha operacional.

Roteiro manual: entrar com a identidade de teste autorizada; abrir uma visita com duas comandas e itens; conferir conta individual e conta conjunta; adicionar/alterar/remover um item em uma sessao e confirmar que a lista/total atualiza na outra apos o evento Realtime; comparar Network para confirmar uma RPC get_visit_tab_consumptions por visita, sem chamadas repetidas por comanda. A aplicacao foi feita apenas no projeto de testes; nao houve medicao de latencia hospedada. Portanto, os timeouts nao estao declarados resolvidos. Principal, Asaas e frontend publicado nao foram acessados.

## Fechamento do pacote de chamados, fechamento, acesso e desempenho - 31/10/2026

Relatorio consolidado: docs/entrega-final-chamados-fechamento-acesso-desempenho-20261031.md. Fontes, migrations, fixtures SQL, runners e evidencia sanitizada estao no ZIP em artifacts/eloozi-chamados-fechamento-acesso-desempenho-20261031-final.zip; manifesto sha256 e verificador nativo Node incluidos.

Verificacao FINAL EXECUTADA nesta finalizacao: npm.cmd test exit 0 (274 testes, 270 aprovados, 4 skips existentes, 0 falhas); npm.cmd run typecheck exit 0; npm.cmd run build exit 0 (Vite 6.4.4, 209 modulos); git diff --check exit 0 (avisos LF/CRLF do Git apenas). Logs docs/final-delivery-*.log. Nenhum SQL local ou remoto foi reexecutado na finalizacao; os testes SQL de chamados/fechamento, concorrencia, rollback e desempenho constam como aprovados em execucoes descartaveis anteriores, sem serem rotulados como atuais.

O usuario informou que os fluxos integrados de chamados e pagamento conjunto funcionaram em teste MANUAL. Automacao de navegador autenticada nao foi concluida. Os timeouts permanecem em acompanhamento; o benchmark local nao prova latencia hospedada. Migrations ja aplicadas no teste: 20261030223205_service_call_cycles_and_group_payment e 20261031015051_get_visit_tab_consumptions. Nao reaplicar no projeto de testes. Producao continua intocada; qualquer aplicacao futura requer comparacao previa do historico e hashes.

## Plano local de atualizacao do principal â€” 31/10/2026

Documento executavel em `docs/plano-atualizacao-principal-local-20261031.md`. Principal identificado anteriormente como `llhujxzefujdsthpezag`; testes `rzhtndpselxsxgomclzo` nao foram acessados nesta etapa. Nenhuma consulta/mutacao remota, Asaas, deploy, repair, db push, commit ou push nesta rodada. Backup restauravel e autorizacao do corte seguem pendentes.

Estrategia de reservas: nao executar `20261024164500_create_reservations_table.sql`, que cria policies permissivas. O principal ja tinha tabela/RLS e policies tenant-scoped seguras, e o SQL local `20261025090000_secure_reservations_rls.sql` corresponde ao registro remoto `20261025180709`. O plano propoe, somente depois de backup, diff completo dos objetos e autorizacao, reconcile remoto apenas do historico, com comandos individuais documentados; migrations compartilhadas permanecem inalteradas. As tres migrations historicas com conteudo divergente nao serao reaplicadas.

Preparacao local financeira: handlers de checkout/webhook agora tem guard de pausa de novas emissoes, configuracao explicita da URL Asaas, compatibilidade temporaria 4-args/2-args somente quando a assinatura nova nao existir, e resposta retryable para pagamento verificado que ainda nao possa anexar referencia. Migration incremental `20261031120000_billing_cutover_pending_invoice_quarantine.sql` marca como `needs_reconciliation` apenas faturas pending sem referencia externa utilizavel e estado de emissao nulo/em progresso; nao altera status pago/valor/datas/contrato nem descarta webhook.

PostgreSQL 17.11 descartavel local: `node scripts/test-financial-cutover-db.mjs` terminou **PASS**, cluster `127.0.0.1:55517` encerrado e TEMP removido em `finally`. Aplicou a cadeia local desde bootstrap, pulou explicitamente a migration permissiva de reservas e confirmou quatro policies seguras/RLS ativa. Conferiu hashes das RPCs financeiras de base contra os valores previamente observados no principal. Executou a suite de trial existente e fixture sintetica de 5 restaurantes, 5 invoices, 3 trials, 1 ciclo e alocacao: legacy, datas/limites/precos, trial provado/nao provado, ciclos, faturas e claims foram comparados; duas invoices ambiguas foram quarantined sem mudar status/valor/datas/claim; invoice em ciclo/alocacao foi confirmada de forma sintetica, replay idempotente e nova emissao negada. Nenhum Asaas/gateway real foi chamado. Limite: reconstrucao local pelas migrations, nao clone restaurado do principal; hashes/policies e objetos financeiros explicitamente comparados nao comprovam equivalencia de todo o schema.

Validacao FINAL: `npm.cmd test` exit 0, **273 aprovados, 4 skips preexistentes, 0 falhas**; `npm.cmd run typecheck` exit 0; `npm.cmd run build` exit 0 (Vite 6.4.4, 209 modulos). Regressao confirma que a pausa faz 503 sem RPC/fetch para nova emissao, enquanto verificacao manual continua funcional; webhook/verificacao manual usam a RPC legada somente quando a assinatura nova nao existe. Logs atuais: `docs/financial-cutover-local.log`, `docs/financial-cutover-npm-test.log`, `docs/financial-cutover-typecheck.log`, `docs/financial-cutover-build.log`. O runner/fixtures de corte sao novos e locais; nao instalam dependencias.

## Backup manual do principal â€” 31/10/2026

Projeto confirmado por leitura: `llhujxzefujdsthpezag` (Eloozi), PostgreSQL 17.11. Host direto reportado pelo projeto: `db.llhujxzefujdsthpezag.supabase.co`; nao foi testada conexao TCP. Ferramentas locais existentes `pg_dump`, `pg_restore` e `psql`: 17.11, compativeis com a versao do servidor. Nenhum dump, arquivo restaurado ou diretorio de backup foi criado.

Bloqueio exato: nao ha credencial PostgreSQL disponivel para exportacao. Nenhuma variavel de ambiente PG/Supabase/Database estava definida; `.env.local` foi consultado somente em memoria para detectar nomes de variaveis de conexao, sem exibir/registrar valores, e nao contem chave de conexao; `%APPDATA%\postgresql\pgpass.conf` nao existe. Supabase CLI ausente e nao instalada. A tarefa parou antes do primeiro acesso SQL de origem, conforme solicitado.

Proximo passo protegido: o operador deve obter no painel do projeto a senha de database ou credencial de papel de leitura com privilegios suficientes para `pg_dump`, e executa-la localmente por prompt oculto `pg_dump -W` (nao usar senha na linha de comando, no historico, em `.env.local` ou no repositorio). Conexao desejada: endpoint direto `db.<project-ref>.supabase.co`, porta 5432, DB `postgres`, SSL requerido; nao usar pooler transaction. Depois configurar uma pasta de backup fora do repositorio com ACL privada e espaco conferido, executar dump custom consistente, guardar SHA-256, restaurar em cluster local isolado sem rede e comparar schema/tabelas/contagens/objetos. Senha nao deve ser enviada pelo chat.

Cobertura ainda inexistente: Auth, roles gerenciadas, Storage/binaries, secrets Edge Functions e configuracoes da plataforma nao foram exportados ou restaurados; um futuro dump SQL nao sera backup completo da plataforma. Nao ha evidencia de restauracao comprovada. Nenhum servico remoto foi alterado.

Config esperada por nome e fluxo de corte, migracoes exatas, dependencias, verificacoes apos cada arquivo, recuperacao e pendencias estao no plano. Supabase CLI nao esta no PATH e nao foi instalada; a forma de `migration repair` foi checada na referencia oficial, sem executar repair. Diagnostico anterior mostrava `asaas-checkout` e `asaas-webhook` ativos, sem evidencia confiavel de pausa; portanto Asaas nao pode ser considerado pausado. Backup restauravel, preflight completo de schema no clone, classificacao de invoices ambiguas e autorizacao de reconcile/aplicacao/deploy/retomada permanecem bloqueios. Nao ativar emissao.

## Backup exportado: integridade e bloqueio da restauraÃ§Ã£o â€” 31/10/2026

Nesta execuÃ§Ã£o, metadata protegido foi lido e o dump original localizado pelo campo backup_file_name. SHA-256 calculado CONFERE: 9176bd202f2ca47cde5fc90f0d04814bc37d669c7e371465a7cc47aef815c26d. Projeto no metadata llhujxzefujdsthpezag; servidor e ferramentas 17.11. Original preservado. pg_restore --schema-only terminou exit 0; schema extraÃ­do ficou na pasta privada do backup, fora de Git/ZIPs.

InspeÃ§Ã£o inicial encontrou extensÃµes pg_stat_statements, pgcrypto, supabase_vault e uuid-ossp. supabase_vault e pg_net nÃ£o estÃ£o disponÃ­veis no diretÃ³rio local de extensÃµes. ReferÃªncias textuais a pg_net, HTTP, cron e event triggers exigem classificaÃ§Ã£o completa; nÃ£o equivalem a tarefas ativas comprovadas. Nenhuma definiÃ§Ã£o sensÃ­vel foi publicada.

BLOQUEIO CONCRETO antes da restauraÃ§Ã£o: token Windows sem privilÃ©gios administrativos, inclusive pela execuÃ§Ã£o escalada disponÃ­vel (ADMIN_TOKEN=False). MpsSvc estÃ¡ Running e New-NetFirewallRule existe, mas nÃ£o foi possÃ­vel estabelecer previamente a barreira de saÃ­da de rede exigida. Listen loopback nÃ£o impede chamadas externas iniciadas por funÃ§Ãµes/triggers e nÃ£o foi tratado como isolamento de saÃ­da. Nenhuma regra do Windows foi alterada; nenhum cluster foi iniciado, portanto nÃ£o hÃ¡ cluster desta rodada para encerrar.

PrÃ³ximo passo: sessÃ£o Windows efetivamente administrativa para configurar/verificar bloqueio temporÃ¡rio de saÃ­da do executÃ¡vel D:\pgSQL\bin\postgres.exe, preservando comunicaÃ§Ã£o loopback necessÃ¡ria e com remoÃ§Ã£o garantida em finally; alternativamente bancada jÃ¡ isolada de rede. NÃ£o relaxar ACL do backup. Depois terminar inspeÃ§Ã£o de TOC/schema e dados de tarefas, documentar adaptaÃ§Ã£o das dependÃªncias gerenciadas, restaurar em cluster privado descartÃ¡vel, comparar dados/objetos/RLS/grants/histÃ³rico e sÃ³ entÃ£o ensaiar individualmente o plano docs/plano-atualizacao-principal-local-20261031.md com snapshots privados antes/depois. Encerrar e remover cÃ³pia restaurada no finally.

RestauraÃ§Ã£o e ensaio sobre este backup NÃƒO executados; recuperaÃ§Ã£o NÃƒO comprovada. Contagens da origem nÃ£o constam do metadata: comparaÃ§Ã£o origem/clone no mesmo snapshot ainda nÃ£o disponÃ­vel. Backup PostgreSQL nÃ£o cobre Storage binÃ¡rio, configuraÃ§Ã£o Auth externa ao banco, roles globais/senhas, secrets/deploy Edge ou configuraÃ§Ã£o da plataforma. Sem consultas remotas, Asaas, migrations, deploy, commit ou push nesta rodada. Os testes sintÃ©ticos antigos nÃ£o foram repetidos nem apresentados como restauraÃ§Ã£o atual.

## Barreira Windows para restauraÃ§Ã£o local â€” script preparado 31/10/2026

Criado `scripts/Set-Eloozi-RestoreNetworkContainment.ps1` com aÃ§Ãµes Enable/Remove. O modo Enable verifica token administrativo, caminho exato D:\pgSQL\bin\postgres.exe, serviÃ§o Firewall e perfis, aborta se encontrar processo existente com esse caminho, cria regra outbound Block limitada a esse executÃ¡vel e verifica a regra em ActiveStore (protocolo/destino/perfil), depois grava registro privado com RunId para remoÃ§Ã£o seletiva. NÃ£o desativa Firewall e nÃ£o inicia restauraÃ§Ã£o. O modo Remove exige RunId e confere group e app path antes de remover apenas a regra registrada.

Sintaxe analisada com PowerShell Parser: PASS. Script nÃ£o foi executado para criar regra porque o token desta sessÃ£o nÃ£o Ã© administrativo (ADMIN_TOKEN=False); a execuÃ§Ã£o elevada do Codex tambÃ©m nÃ£o recebeu token administrativo. Portanto nenhuma contenÃ§Ã£o foi aplicada ou comprovada e a restauraÃ§Ã£o nÃ£o deve comeÃ§ar. A regra de programa alcanÃ§a qualquer processo futuro usando esse mesmo postgres.exe enquanto ativa; o preflight recusa instÃ¢ncias jÃ¡ ativas. Antes de restauraÃ§Ã£o, conferir tambÃ©m conexÃ£o local do cluster sob a regra; se localhost falhar ou houver outro consumidor desse binÃ¡rio, usar VM/Windows Sandbox jÃ¡ isolada, sem rede externa, e montar a cÃ³pia protegida do dump.

Comando Ãºnico para o operador executar em PowerShell realmente aberto como Administrador: `& 'D:\PROJETOS\Eloozi\scripts\Set-Eloozi-RestoreNetworkContainment.ps1' -Action Enable`. Guardar o RunId e usar o comando de remoÃ§Ã£o que o script imprimir apÃ³s cluster parado. NÃ£o restaurar dump atÃ© receber CONTAINMENT_PASS e confirmar listener loopback. Dump original segue preservado e fora do Git.

## Containment interrupted and rule metadata review — 31/10/2026

Read-only inspection found no active Set-Eloozi-RestoreNetworkContainment.ps1, pg_ctl, postgres, initdb or psql process. The initially observed PowerShell PID disappeared before the second snapshot. The containment directory exists with zero entries; no RunId state manifest or probe log exists. Security audit log access was denied. There is no process to wait for or interrupt now.

Four enabled firewall rules remain. COM and registry inspection confirmed exact display Name, Group Eloozi restore containment plus same UUID, empty Description, ApplicationName D:\pgSQL\bin\postgres.exe, outbound Block, all profiles, protocol Any, remote/local address *, no ports/service/interface restriction, and local persistent firewall registry entries. Every Name/Group pair exactly matches the GUID-generated template in the Eloozi preparation script. This distinct Name+Group+filter signature establishes the rules as Eloozi-preparation rules; it is not based only on executable path. There is no record associating a particular GUID with the interrupted invocation, so all four must be treated as leftover Eloozi runs, not an individually identified current run.

Added scripts/Remove-Eloozi-ContainmentRules.ps1: administrative, fixed allowlist of those four RunIds, verifies full identifying metadata before removing, defaults to removal and supports -WhatIf. It has not been executed. Do not use it until the operator chooses to clean all four Eloozi rules; it never enumerates or removes generic firewall rules.

The old Enable script is not suitable for another run: it targets the shared D:\pgSQL\bin\postgres.exe, has no state manifest before firewall mutation, hides progress during initdb/pg_ctl and does not perform a functional outbound packet test. No restoration should proceed under the four old rules. Corrected containment needs a private copy of bin/lib/share, exclusive staged executable path, durable protected manifest before rule creation, bounded child-process execution, active firewall policy verification, loopback functional probe, and a controlled external TCP control/protected-process comparison. The local PostgreSQL installation directories total roughly 140 MB for bin/lib/share; no copy was made. The original installation and all databases were left untouched.

Current state: no PostgreSQL process is running; four redundant but active Eloozi rules continue to block outbound traffic for the shared original postgres.exe. No firewall setting was changed during this inspection. Dump unchanged; no restoration started.

## Correção do WhatIf de regras de contenção — 31/10/2026

Leitura campo a campo confirmou nas quatro regras Eloozi: Name/DisplayName, Group, Description, ApplicationName, Enabled, Direction, Action, Protocol e RemoteAddresses. O COM retorna Description como NULL para o campo vazio; a condição antiga comparava diretamente com string vazia e sinalizava divergência. Corrigida somente essa comparação para IsNullOrEmpty após conversão a string. RunId continua sendo sufixo verificado do Name e Group, não InstanceID. O COM não expõe InstanceID; não foi usado como chave.

Para permitir auditoria segura, WhatIf agora dispensa elevação porque apenas valida e lista. A exigência de administrador permanece para remoção real. Executado após correção: powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/Remove-Eloozi-ContainmentRules.ps1 -WhatIf, exit 0. Listou os quatro IDs esperados; nenhuma regra foi removida. O bypass vale somente para este processo e não altera ExecutionPolicy persistente. Nenhuma regra foi habilitada, PostgreSQL iniciado ou principal alterado.

## Bancada privada corrigida preparada — 31/10/2026
Usuário informou remoção administrativa bem-sucedida das quatro regras antigas (relato manual). Novo scripts/New-Eloozi-PrivateRestoreBench.ps1 prepara cópia privada bin/lib/share em LOCALAPPDATA, estado anterior às operações, progresso e processos com timeout. Regra tem Name/Group únicos e executável copiado, sem apontar ao original. Controle TCP sem dados para 1.1.1.1:443 comprova rota externa; dblink dentro do backend privado tenta esse destino sob a regra, exigindo falha de conexão por timeout/permissão de socket; SELECT 1 comprova loopback. Sem resultado funcional ainda: apenas parser PowerShell PASS e diff check PASS nesta rodada. Em falha retém estado/logs/regra e imprime caminho para CleanupState; limpeza verifica bancada e regra e para somente o cluster privado. Nenhum Enable ou PostgreSQL iniciado nesta rodada. Dump preservado. Restauração e ensaio dependem de CONTAINMENT_PASS administrativo e leitura dos logs privados. Não declarar contenção comprovada pela existência do script.

## Diagnostico initdb da bancada privada — 31/10/2026
Bancada 3d1bf2ea-a25f-4c8e-85a4-d0bd26fee92e: initdb stdout conclui com Sucesso; stderr vazio; data/PG_VERSION=17. Exit code historico nao foi registrado e nao pode ser reconstruido dos logs. Reproducao inofensiva postgres --version confirmou defeito no helper: sem capturar Handle antes de WaitForExit, ExitCode=NULL; preservando Handle, ExitCode=0. Helper corrigido para capturar handle e persistir exit code/caminhos de logs. Runtime privado: 1563 arquivos comparados com origem, zero ausentes e zero hashes divergentes. ACL privada do proprietario Anderson conferida. Nenhum processo privado ativo; regra privada existente habilitada e vinculada ao executavel copiado. Sem evidencia de falha por token administrativo: initdb terminou; nao repetir inicializacao.
Adicionado ResumeState: reabre exclusivamente state.json guardado, exige cluster 17 inicializado e regra COM correspondente, nao copia binarios/cria regra/repete initdb. Pode ser executado por usuario normal; criacao/remocao firewall continuam administrativas. Parser PASS; diff check PASS. Retomada nao executada nesta rodada. Loopback e egress pendentes; nao restaurar antes de CONTAINMENT_PASS. Somente postgres --version foi executado no diagnostico, sem iniciar servidor. Dump preservado; sem remoto.

## Revisao egress da bancada privada — 31/10/2026
Logs existentes: SELECT 1 passou; CREATE EXTENSION dblink terminou; dblink tentou 1.1.1.1:443 e Windows negou socket com 0x0000271D/10013 (Permission denied). psql exit=1. SQLSTATE nao foi registrado na verbosidade original e nao foi inventado; futuras execucoes usam VERBOSITY=verbose. O regex antigo aceitava apenas outras formas de mensagem, gerando falso negativo. Corrigido especificamente para endpoint exato e codigo numerico 10013, exigindo exit=1; nao aceita qualquer falha. Reavaliacao offline de logs confirmou loopback/socket deny, sem repetir tentativa externa. Regra aponta ao mesmo caminho privado de postgres.exe informado por pg_ctl status/postmaster.opts. WSAEACCES demonstra negacao local de socket; combinacao com controle TCP previo e regra especifica ativa sustenta a contencao, sem atribuir com certeza o evento a um filtro WFP particular.
Cluster ainda estava ativo PID 2808 apos falha: script nao tinha parada no catch. Encerrado apenas esse data dir com pg_ctl stop fast: exit 0; status posterior exit 3/no server running. Regra e dados privados preservados. Catch corrigido para preservar ultimo processo de falha e parar somente cluster privado sem remover protecao. Nenhuma restauracao ou nova tentativa externa executada. Parser PASS. Dump/principal intocados.

## Restauração privada e ensaio sobre o dump concluídos — 31/10/2026

Resultado atual substitui os antigos bloqueios de restauração deste histórico. Relatório sanitizado: docs/restore-ensaio-principal-20261031.md. Runner novo: scripts/restore-private-principal.mjs, somente módulos nativos Node. Dump original com SHA-256 9176bd202f2ca47cde5fc90f0d04814bc37d669c7e371465a7cc47aef815c26d conferido antes/depois, preservado fora do Git.

Mesma bancada privada, regra existente conferida no caminho exato do executável copiado, perfis ativos. Evidência reavaliada: loopback passou e socket externo no backend foi negado com 10013; não foi isolado qual filtro causou a negação. Sem nova tentativa externa. Executável privado confere com o original, sem iniciar o binário original.

pg_restore --exit-on-error PASS (exit 0). 84 tabelas restauradas; 83 seções COPY/2182 linhas com contagens e hashes ordenados iguais ao archive; raiz particionada realtime.messages vazia não tem COPY próprio; vault.secrets omitida tinha zero linhas. Duas sequences conferidas. 1249 blocos DDL comparados: 1240 iguais; quatro tabelas com CHECKs semanticamente iguais comprovados pelas árvores conbin, quatro policies apenas com ordenação de roles diferente e uma ACL de função interna com diferença de bootstrap owner local. Foram recuperadas definições de 191 funções, 56 triggers ordinários, 63 configurações RLS, 53 policies, 315 ACLs e 21 default ACLs. Histórico termina em 20261025180709 e foi comparado como dados do dump.

Adaptações explícitas: dez roles placeholder NOLOGIN sem atributos globais/senhas/memberships equivalentes; extensão supabase_vault indisponível e seus objetos/ACLs não substituídos; sete event triggers gerenciados não instalados (15 entradas TOC excluídas no total). Não instalar pg_net/pg_cron/HTTP nem scheduler. Restauração da aplicação verificada com essas limitações; NÃO recuperação integral do Supabase. Auth login, Storage binário, serviços Realtime/Edge, configurações e secrets da plataforma continuam fora da cobertura.

As 19 migrations do plano foram aplicadas individualmente no clone restaurado, com snapshots de todos os campos originais após cada arquivo. Sem alteração nos campos antigos de contratos, limites/preços contratados, datas, faturas, reservas, mesas, visitas, comandas e itens; somente campos previstos do catálogo foram alterados. Catálogo final 9990/17990/27990 e 5/20/ilimitado conferido no snapshot. Três restaurantes existentes ficaram legacy; nenhuma evidência de trial/ciclo histórico foi inferida. Não reexecutar migrations históricas divergentes nem migration permissiva/equivalente de reservas. Nenhum repair de histórico foi executado.

Fixture financeira sintética executada no clone já atualizado: preservação legacy/trials/ciclo/alocação, faturas em trânsito/quarentena, confirmação tardia e replay idempotente PASS. Adaptação de teste somente na entrada privada: guarda exige banco eloozi_restore em vez de postgres. Arquivos originais da fixture preservados. Transação revertida e dados reais da cópia comparados novamente sem divergência. Nenhum gateway usado; na cópia real havia zero faturas elegíveis para quarentena.

Execuções completas do runner e --finalize exit 0. Banco eloozi_restore removido após verificação. Cluster encerrado em finally: stop exit 0, status posterior exit 3/no server running. Regra privada continua habilitada; state.json atualizado para restore-rehearsal-complete-stopped. Logs brutos, schema/COPY/snapshots e result.json continuam em restore-review privado, fora Git/ZIPs, podem conter dados reais e não devem ser publicados. Foram registrados erros intermediários de normalização inet /32 e comparação DDL antes da investigação; nenhum erro de restauração foi ocultado. Node --check e git diff --check PASS. Sem npm/typecheck/build nesta rodada de runner/documentação, sem mudanças funcionais adicionais.

Plano futuro principal continua exigindo comparação atual de histórico, decisão sobre dependências gerenciadas, autorização de reconciliação/corte/aplicação e comprovação da pausa Asaas. Nenhum principal, testes remoto, Asaas, deploy, commit ou push acessado nesta execução.

## Roteiro final do principal preparado em leitura — 31/10/2026

Roteiro consolidado docs/roteiro-final-principal-20261031.md, tabela docs/principal-migrations-ordem-hashes-20261031.md e manifesto docs/principal-cutover-manifest-20261031.json. Os 19 SHA-256 dos bytes atuais coincidem com os registrados no ensaio aprovado; quatro hashes de fontes Edge registrados. Nenhum teste de banco aprovado foi repetido. Verificada ausência de referências a pg_reload_conf nas 19 migrations. Dezesseis têm BEGIN/COMMIT explícitos; três (batch_cancel, atomic_transfer, get_visit_tab_consumptions) não têm wrapper: não assumir rollback de unidade/histórico sem conferir o executor CLI.

Principal confirmado llhujxzefujdsthpezag/Eloozi/17.11. Consultas somente de leitura mostram 76 versões, última 20261025180709; conteúdo do histórico igual ao dump. Há 96 arquivos locais: 19 pendências reais, dois baselines de reservas e apenas uma versão remota sem arquivo local (25180709). Reconciliação history-only permanece separada e NÃO executada. Não reexecutar as três versões históricas divergentes nem as policies permissivas de reservas.

Leitura atual comparou fingerprints COPY de 84 tabelas: todos os dados das 38 tabelas public e do histórico coincidem com o snapshot. auth.refresh_tokens mudou de 260 para 261 linhas; auth.sessions e auth.users mudaram conteúdo com mesma contagem. Surgiram duas partições vazias de realtime.messages, datas 02/11 e 03/11, owner supabase_realtime_admin, parent/bounds verificados. Nenhum dado ou hash individual de senha/token foi exibido. Das 84 tabelas definidas no archive, owners e flags RLS coincidem. 191 funções coincidem em argumentos/corpo normalizado CR/owner/volatilidade/SECURITY DEFINER/configurações; 53 policies coincidem. Comparação atual não é diff exaustivo de todos os constraints/índices/grants/roles globais. Snapshots de dados e catálogos separados. Resumo sanitizado docs/principal-preflight-readonly-20261031.json; fingerprints de tabelas guardados em main-readonly-observation.json privado da bancada.

Handlers hospedados checkout/webhook ainda ACTIVE versão 7 de 17/10; código de checkout não tem BILLING_ISSUANCE_PAUSED e ambos não têm a confirmação quatro-args local. Não foi acessado Asaas nem invocado checkout. Definir flag sozinho não pausa a versão antiga. Roteiro exige handlers compatíveis com flag true, prova 503 por payload incompleto sem capacidade de emitir, drenagem comprovada de versões antigas, backup novo, reconciliação e SQL, mantendo pausa até depois da quarentena e sem ativação automática. Se pausa/dreno/outros escritores não comprovados, não começar hardening. Reemissão ambígua só é impedida sob esses gates explícitos.

Backup novo imediatamente antes das primeiras alterações de banco ainda pendente. Runner restore-private-principal.mjs recebeu --expected-sha256 explícito e --restore-only, para verificar novo archive sem repetir 19 migrations; modo novo apenas analisado sintaticamente, não executado porque não existe novo archive. Guardas de projeto, caminho privado, hash e regra mantidas. Preservar logs antigos em cópia privada antes de reutilizar restore-review.

Regra privada ainda ativa e correspondente; zero processo privado e pg_ctl status=3 reconfirmados. Preparado Remove-Eloozi-PrivateBenchProtection.ps1 com guardas fortes e ledger de intenção; WhatIf exit 0, nenhuma remoção. Recomendação manter até verificar backup de corte; remover somente após ausência de processos e fim dos usos locais. Nenhum firewall, banco, .env ou vínculo CLI foi alterado. CLI ainda ausente; roteiro propõe workdir privado para principal e uma migration por dry-run/apply, nunca lote de 19. Não instalar nesta rodada.

Bloqueios: autorização da janela/ações, CLI/versionamento operacional, pausa e drenagem reais, inventário de emissores/retentativas, controle de onboarding/escritas concorrentes, novo backup/restauração, preflight completo de schema e decisão de recuperação das dependências gerenciadas. Nenhum deploy, repair, migration remota, commit, push ou ativação Asaas executado. Node syntax checks, parser PowerShell e git diff --check aprovados; sem npm/typecheck/build repetidos nesta preparação documental/operacional.

## Primeira fase preparada, sem autorização de deploy — 31/10/2026

Roteiro específico e comandos: docs/fase1-corte-principal-pronta-20261031.md. Resultado sanitizado: docs/fase1-preparacao-checks-20261031.log. Não executar esta fase com base apenas no pedido de preparação; aguarda autorização específica. Nenhuma flag remota, função, banco, frontend, Asaas ou histórico foi alterado nesta rodada.

Criados scripts/Prepare-Eloozi-Phase1.ps1, scripts/Set-Eloozi-Phase1Pause.ps1 e scripts/Test-Eloozi-Phase1Endpoints.ps1. Stage privado com ACL de usuário, fontes e dois payloads completos do conector, quatro hashes idênticos ao manifesto aprovado. Localização em LOCALAPPDATA/Eloozi/CutoverPhase1 registrada no roteiro, fora do Git. Corrigida serialização PowerShell 5 no preparador: File.ReadAllText produz conteúdo string, não objeto decorado de Get-Content. Hash de cada texto JSON decodificado comprovado igual ao arquivo original e à cópia. Não houve edição nova dos handlers existentes nesta preparação.

Fluxo futuro: confirmar principal e nomes de configuração; flag literal true com entrada oculta do token Management API e recibo de intenção/ACK; checkout por conector com verify_jwt=true; probe intermediário de pausa; webhook verify_jwt=false com token próprio; quatro probes incompletos sem fatura/payment válido; prova separada de drenagem; novo dump e restore-only na bancada existente. CLI ausente deixa de ser bloqueio desta fase: usar conector e PowerShell, sem instalação. Não alterar vínculo de testes/.env. Os scripts de ação recusam execução sem switch explícito, mas o switch não substitui autorização humana.

Leitura atual confirmou ambos os handlers hospedados ainda versão 7; fontes e metadados preservados em rollback-v7 privado. Essa versão de checkout ignora a flag e não deve ser usada como rollback de emissão. Não houve invocação de endpoint. Consulta de atributos de logs retornou vazio; não prova ausência de execução. Drenagem exige cobertura, roteamento e término de execuções antigas comprovados; espera cega/503/metadata ACTIVE não bastam. Sem observabilidade suficiente: DRAINAGE_UNKNOWN e não iniciar backup de corte. Confirmar inventário de emissores e retenção/reentrega de pagamentos; antes das migrations, referência não persistida pode retornar 503 retryable por ausência da attach RPC. Não descartar pagamento nem aplicar RPC nesta fase.

Bancada existente com state restore-rehearsal-complete-stopped e zero processos privados. Get-NetFirewallRule falhou por acesso negado; assinatura da regra e perfis conferidos depois pela interface COM do runner, PASS, sem mutação. Evidência anterior preservada: loopback PASS e socket externo negado com 10013, filtro individual não isolado. Regra mantida para a nova restauração. Não iniciar PostgreSQL sob token administrativo; preservar restore-review antigo em cópia privada conferida antes de reutilizar o runner. Modo restore-only continua funcionalmente pendente do novo archive; não repete o ensaio de migrations.

Verificações atuais: parser dos três scripts PASS; dois guards sem autorização saíram com exit 1 esperado sem criar receipt; quatro conteúdos dos payloads/rotas/JWT flags/SHA PASS; ACL privada PASS; git diff --check PASS. Nenhum npm/typecheck/build/SQL repetido sem mudança de aplicação. Pausa efetiva, deploy, probes hospedados, drenagem, export atualizado e restauração nova NÃO executados. Sem migrations/repair/frontend/ativação financeira/commit/push/ZIP nesta fase de preparação.

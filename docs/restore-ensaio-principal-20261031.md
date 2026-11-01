# Restauração privada e ensaio do principal — 31/10/2026

## Resultado desta execução

Restauração dos dados PostgreSQL da aplicação e ensaio local concluídos, com adaptações explícitas para dependências gerenciadas. **Não é recuperação integral do Supabase nem equivalência completa de roles/serviços da plataforma.** Nenhum endpoint remoto, Asaas, deploy, repair, commit ou push foi usado nesta execução.

O dump original foi localizado pelo backup-metadata.json e permaneceu inalterado. SHA-256 conferido antes e depois:

`9176bd202f2ca47cde5fc90f0d04814bc37d669c7e371465a7cc47aef815c26d`

Utilizado PostgreSQL 17.11 da cópia privada já existente. Alvo exclusivo: `127.0.0.1:55992`, banco descartável `eloozi_restore`, dentro da bancada identificada pelo state.json. O executável original em D:\pgSQL não foi iniciado nem protegido por novas regras.

## Contenção e inspeção prévia

- A regra existente foi conferida por Name, Group, caminho privado exato, estado habilitado, direção de saída, ação Block, protocolos/destinos Any e perfis ativos. Não houve criação, remoção ou alteração de regra nesta rodada.
- Evidência funcional anterior reavaliada nos logs privados: SELECT 1 por loopback passou; dblink dentro do backend tentou 1.1.1.1:443 e recebeu WSAEACCES `0x0000271D/10013`. O controle TCP anterior havia sido alcançável. **Não foi identificado isoladamente qual filtro causou a negação.** Não foi feita outra tentativa externa.
- A inspeção do schema não encontrou foreign servers/FDWs, linguagem não confiável ou COPY PROGRAM. Extensões do archive: pg_stat_statements, pgcrypto, uuid-ossp e supabase_vault.
- Não foram instalados pg_net, pg_cron, HTTP ou scheduler no banco restaurado. Nenhum worker externo/preload foi habilitado. Referências textuais a cron/HTTP em funções gerenciadas não foram tratadas como tarefas ativas.
- Event triggers foram excluídos antes da execução de DDL. Triggers ordinários da aplicação foram restaurados. Nenhum serviço Auth/Realtime/Storage/Edge foi iniciado.

## Restauração e comparação com o arquivo

`pg_restore --exit-on-error` terminou com código **0**. Foram recuperadas 84 tabelas: Auth 27, public 38, Realtime 10, Storage 8 e histórico de migrations 1.

Para 83 seções COPY, **2.182 linhas** tiveram contagem e SHA-256 das linhas ordenadas idênticos aos extraídos do dump. A tabela particionada raiz realtime.messages está vazia e não tem seção COPY própria; suas partições foram verificadas. A seção vault.secrets omitida tem **zero linhas**. Duas sequences tiveram last_value/is_called conferidos contra os setval do arquivo.

Esta comparação usa o próprio snapshot consistente do dump. Não houve consulta à origem nem comparação com o principal vivo após a exportação; alterações posteriores no principal não estão cobertas.

1.249 blocos de definição foram comparados, incluindo 191 funções, 84 tabelas, 56 triggers ordinários, 63 configurações de RLS, 53 policies, 315 ACLs e 21 default ACLs. Resultado: 1.240 iguais textualmente; nove diferenças classificadas:

- Quatro definições de tabela: apenas parênteses de CHECK foram reformatados pelo servidor. As definições originais foram parseadas em schema temporário dentro de transação revertida; as árvores conbin dos CHECKs coincidiram com as restauradas. Nenhuma condição foi removida.
- Quatro policies: apenas ordem de `anon, authenticated`, dependente dos OIDs locais das roles; os conjuntos de roles e o restante do SQL coincidiram.
- ACL da função interna pg_catalog.pg_reload_conf(): o PostgreSQL local tem bootstrap owner postgres, diferente do ambiente gerenciado. O dump regenerado contém um REVOKE adicional desse role. Os grants explícitos do archive foram restaurados; isso não comprova equivalência dos privilégios globais/superuser do ambiente gerenciado.

## Adaptações e omissões

Não houve stub substituindo função da aplicação. As adaptações foram:

1. Dez roles gerenciadas referenciadas por owners/grants foram criadas como placeholders NOLOGIN, sem superuser, criação de banco/role ou replicação. O archive não contém atributos globais, senhas ou memberships. Owners e grants explícitos do archive foram restaurados; a semântica global de autenticação/BYPASSRLS não foi reconstruída nem declarada equivalente.
2. supabase_vault não está disponível no runtime Windows. Foram omitidos a extensão, seu comentário, cinco ACLs dependentes e TABLE DATA vault.secrets. Vault secrets/decrypted_secrets e funções da extensão não foram substituídos. Nenhuma linha de Vault existente no dump deixou de ser recuperada, pois a seção tem zero linhas; **a API/criptografia Vault continua fora da recuperação comprovada**.
3. Sete event triggers gerenciados não foram instalados: ensure_rls, issue_graphql_placeholder, issue_pg_cron_access, issue_pg_graphql_access, issue_pg_net_access, pgrst_ddl_watch e pgrst_drop_watch. Suas definições originais continuam no archive e na extração privada. A ausência deliberada de ensure_rls limita a equivalência da automação DDL; as configurações RLS e policies existentes foram comparadas diretamente.
4. A fixture sintética financeira exige banco postgres por padrão. Somente a entrada privada usada neste ensaio foi adaptada para exigir exatamente eloozi_restore; o teste de loopback foi mantido e os arquivos originais de teste não foram alterados.

Total de entradas TOC excluídas explicitamente: **15**. Não foram ocultados erros do pg_restore nem usada restauração com erros ignorados.

Auth: dados/tabelas foram comparados, não foi exercitado login HTTP. Storage: metadados foram comparados, arquivos binários dos buckets não estão no dump. Realtime: tabelas/publicações foram restauradas, o serviço não foi exercitado. Secrets/configurações Edge, configurações Auth/projeto, credenciais globais e PITR continuam fora da cobertura.

## Ensaio de atualização na cópia restaurada

Histórico restaurado termina em **20261025180709**, conferido também como dados do archive. Não foi executado migration repair nem alterado o histórico para simular aplicação.

As 19 migrations abaixo foram executadas **individualmente** no clone, na ordem do plano. Depois de cada arquivo foram comparados todos os campos originais e a quantidade de linhas das 38 tabelas public e do histórico. Colunas novas foram avaliadas separadamente. Somente as mudanças previstas de catálogo em platform_settings foram admitidas; valores/limites dos contratos existentes não foram sincronizados com o novo catálogo.

1. 20261017000000_product_badge_text.sql
2. 20261024140000_restaurant_dashboard_media.sql
3. 20261026160000_batch_cancel_table_tab_items.sql
4. 20261026190000_atomic_transfer_table_tab_items.sql
5. 20261026233815_checkout_and_subscription_security_hardening.sql
6. 20261027000000_enforce_strict_trial_rules.sql
7. 20261027210000_create_staff_profiles.sql
8. 20261028183120_fix_get_restaurant_billing_summary_invoices_columns.sql
9. 20261028223000_commercial_catalog_modules_and_active_tables_quota.sql
10. 20261029000754_subscription_transition_quotes.sql
11. 20261029002852_basic_manual_delivery.sql
12. 20261029010637_restaurant_contact_channels.sql
13. 20261029024000_contract_module_access.sql
14. 20261029143000_premium_trial_and_prepaid_cycle.sql
15. 20261029180000_trial_prepaid_upgrades.sql
16. 20261030130000_scheduled_subscription_downgrades.sql
17. 20261030223205_service_call_cycles_and_group_payment.sql
18. 20261031015051_get_visit_tab_consumptions.sql
19. 20261031120000_billing_cutover_pending_invoice_quarantine.sql

Não foram reaplicadas as três migrations históricas divergentes, a migration permissiva de reservas ou sua equivalente segura já presente. A RLS de reservas não tinha policy true. As três linhas de restaurantes existentes permaneceram legacy; campos antigos de plano, preço, limite, início/vencimento e demais dados ficaram preservados. Nenhuma evidência de trial ou ciclo histórico foi inventada: trial_terms/cycles permaneceram vazios para esses contratos. Trials antigos sem evidência continuam exigindo decisão administrativa, não ganharam novo teste.

Reservas, mesas, visitas, comandas, itens, faturas e histórico ficaram preservados em todos os campos originais. Na cópia real não havia fatura elegível para a quarentena final. Isso não dispensa reconciliação operacional no momento de um futuro corte.

Depois da cadeia passou a fixture sintética financial_cutover_prepare/assert, executada no clone atualizado em transação revertida: contratos legacy, três evidências de trial, ciclo/alocação, faturas pagas/pendentes/em trânsito, quarentena, confirmação tardia e repetição idempotente. Ela usa apenas SQL e referências sintéticas, sem gateway. Após o rollback, todos os dados originais foram comparados novamente com o snapshot após as migrations, sem divergências.

O deploy de handlers pausados previsto no plano não foi executado: não há Edge runtime neste ensaio. O resultado prova a sequência SQL no clone adaptado, não comprova corte financeiro hospedado, integração Asaas ou autorização para aplicação no principal.

## Execução, erros e reprodução

Runner nativo Node: scripts/restore-private-principal.mjs. Duas etapas:

```powershell
node scripts/restore-private-principal.mjs "[STATE_JSON_PRIVADO]" "[BACKUP_METADATA_PRIVADO]"
node scripts/restore-private-principal.mjs "[STATE_JSON_PRIVADO]" "[BACKUP_METADATA_PRIVADO]" --finalize
```

O runner exige a bancada privada existente, hash esperado, regra correspondente e evidência de loopback/10013. Ele não lê .env nem abre conexões a serviços remotos. Recria somente o banco local eloozi_restore identificado por marcador privado, nunca cluster ou dump. O modo finalize exige as 19 etapas concluídas, executa a fixture com rollback e remove esse banco. Ambos os modos encerram o cluster em finally. Não repetir finalize após a remoção do banco; para nova reprodução é necessária a primeira etapa.

Erros intermediários registrados: a primeira guarda de endereço comparou inet::text com formato sem /32; foi corrigida para host(inet_server_addr()), antes de restaurar. Outra execução parou diante dos nove diffs DDL, que foram investigados e classificados como descrito acima. Nenhum desses resultados foi apresentado como sucesso. As execuções completas posteriores terminaram com exit 0.

Logs brutos, COPY extraído, schema, snapshots antes/depois, hashes por tabela, TOC filtrado, metadados de omissão e result.json estão em restore-review na pasta privada desta bancada, fora de Git/ZIPs. Podem conter dados reais e não devem ser encaminhados como relatório público.

Ao final: banco eloozi_restore removido; pg_ctl stop exit 0; pg_ctl status posterior exit 3/no server running. A regra privada permanece habilitada. O state.json foi atualizado para restore-rehearsal-complete-stopped. O archive original foi conferido novamente. Este relatório é sanitizado; não inclui linhas de dados, credenciais ou corpos de funções potencialmente sensíveis.

## Condições para uma mudança futura no principal

O plano docs/plano-atualizacao-principal-local-20261031.md continua sendo a referência de ordem e recuperação. Antes de qualquer aplicação remota: comparação atual do histórico/objetos, decisão sobre dependências gerenciadas/Vault, autorização de corte e reconciliação, e handlers compatíveis com emissão comprovadamente pausada. Este ensaio não comprova que Asaas esteja pausado no principal e não autoriza ativar cobranças.

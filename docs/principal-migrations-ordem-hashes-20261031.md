# Ordem e hashes — principal Eloozi

SHA-256 dos bytes exatos, conferido com a evidência do ensaio. Não executar como lote.

| Ordem | Migration | SHA-256 |
|---:|---|---|
| 1 | 20261017000000_product_badge_text.sql | b3d3e27d50777f342e5f175d4ecb58847adf9da257c4a19a25f993fbf45284b2 |
| 2 | 20261024140000_restaurant_dashboard_media.sql | f5cd9565fa560aa2de702fb27f5f329750357550cafd9e2b3f9c3082b1b045c8 |
| 3 | 20261026160000_batch_cancel_table_tab_items.sql | 788a342d096c284a983089492ce9fc9d76b4f8e4d8daab44bcfc03562a974587 |
| 4 | 20261026190000_atomic_transfer_table_tab_items.sql | 38aa84ace77ec216a939a98dde146a30ba3359aa307597ea610af159cbe7f20a |
| 5 | 20261026233815_checkout_and_subscription_security_hardening.sql | 3727f1601e25dcbc0ee907e64569560ef0eaafeef447cf6b242a2aaebbb68794 |
| 6 | 20261027000000_enforce_strict_trial_rules.sql | 455d90667e909eb2e4dc7c50b57e4d756a26e7ac72380fd84ccdc5b6675bb588 |
| 7 | 20261027210000_create_staff_profiles.sql | 0dbae10a923d0f170ca1ca7f0e9074cf05910e90cd5822fe54bca8272767d6e0 |
| 8 | 20261028183120_fix_get_restaurant_billing_summary_invoices_columns.sql | 2b39cf1e0dfbe42c69b547ffe0401a7ce4141376363471304e58a0d5cada0653 |
| 9 | 20261028223000_commercial_catalog_modules_and_active_tables_quota.sql | 23b1e5b2d69b3389ce82505bac566c41e0a39af73aceb6062830c50d7a44df10 |
| 10 | 20261029000754_subscription_transition_quotes.sql | 9829dcf7de38ac2f19512364ddc4fc32060bcf16b4a80fd16daa9826db843729 |
| 11 | 20261029002852_basic_manual_delivery.sql | b98bb46b32f5d5d7a1b40d11d795ac4d4e9d2a8259177690fc31bedfa49de2ff |
| 12 | 20261029010637_restaurant_contact_channels.sql | ea0b6b88aa1789ef730708010721e86f234f17da24b289397ec0568f32ff3852 |
| 13 | 20261029024000_contract_module_access.sql | ba67ff44f852414035c523c3cd719d9db1c16301a25bd20b2792f40b20952056 |
| 14 | 20261029143000_premium_trial_and_prepaid_cycle.sql | af9f1ce0274626ec28d41890c03b4edcc5f875c4a5c3c4c91e1578262a024482 |
| 15 | 20261029180000_trial_prepaid_upgrades.sql | 96dc7c320b33a23b83af2739ba7bca3d88b5924b4f1e47d43904b3b1734429bf |
| 16 | 20261030130000_scheduled_subscription_downgrades.sql | 3aaa9dd33864bb49c9d8eea59c09c09d12cb783f76313ce6928ac73abc4f893d |
| 17 | 20261030223205_service_call_cycles_and_group_payment.sql | 1cd63a956ad1875638058a2ce750c913a646f80ddaf8b508c2b84a9144e1e8c7 |
| 18 | 20261031015051_get_visit_tab_consumptions.sql | ed9e9a23fa7091ee91a9ff70a2f1a6946bca087d70e06de833803b05346fbc8a |
| 19 | 20261031120000_billing_cutover_pending_invoice_quarantine.sql | 9f7ca0645ae6d697ea318ab88f033a1334e10d139100b4251cde519b53bf6b77 |

## Handlers locais a publicar somente na janela autorizada

| Arquivo | SHA-256 |
|---|---|
| supabase/functions/asaas-checkout/handler.ts | d859f3a2a25a86bd657d12eea171d163bd3583739181c541a7ada1d75dfd8f72 |
| supabase/functions/asaas-checkout/index.ts | 3288a91bf3934456516367162a6bb71f8888392064c201de7ea6c05023afeaa8 |
| supabase/functions/asaas-webhook/handler.ts | 0b9b227c98ddf464fdec5e7f0af044a7d6559a89a687d57f0fe1b4f2ba855dc7 |
| supabase/functions/asaas-webhook/index.ts | 8d9ce438620ea70fbb1f8b6027990af4ccd3fe6154587c05d6352ad464869b12 |

## Auditoria e Contagem Rigorosa dos Arquivos Locais vs. Histórico Remoto

- **Total na pasta `supabase/migrations`:** **96 arquivos SQL locais**.
- **Composição da contagem:**
  1. **76 migrations históricas**: correspondem ao histórico remoto por versão/mapeamento no catálogo do backup (`supabase_migrations.schema_migrations`), e **não** significam que todos os conteúdos SQL sejam textualmente idênticos aos arquivos locais homônimos. Permanecem registradas as três divergências de conteúdo já identificadas:
     * `20261008141500_create_table_tab_consumption.sql` (statement de seed no arquivo local);
     * `20261016050000_saas_subscription_billing.sql` (três statements de segurança/checkout);
     * `20261016060000_banco_inter_pix_cnpj_integration.sql` (um statement).  
     A equivalência por hash entre a migration local segura `20261025090000_secure_reservations_rls.sql` e a versão remota aplicada `20261025180709` é contabilizada **estritamente dentro** deste grupo histórico de 76 (sem dupla contagem). Esses arquivos compartilhados não devem ser editados nem reaplicados; não propor nem executar reparo de histórico.
  2. **19 migrations do lote ensaiado**: a sequência de corte planejada e comprovada no ensaio local em cópia de backup (tabela acima, Ordens 1 a 19).
  3. **1 arquivo excluído da execução física**: `20261024164500_create_reservations_table.sql`, intencionalmente omitido da cadeia de execução porque contém políticas permissivas legadas (`USING (true) / WITH CHECK (true)`), ao passo que a tabela `public.reservations` já existe em produção criada e protegida por RLS e políticas tenant-scoped restritas.

**Equação exata:** 76 (históricas por versão/mapeamento com equivalência de reservas) + 19 (lote ensaiado) + 1 (excluído por segurança) = **96 arquivos SQL locais**.

> [!IMPORTANT]
> **Ajuste de histórico remoto de reservas é etapa futura e não autorizada:**  
> Qualquer eventual reconciliação de metadados no histórico remoto para a migration de reservas (ex.: registrar `20261024164500` como aplicada e sincronizar `20261025090000` via metadados de CLI) é uma etapa futura, separada e **ainda não autorizada**. Não executar `migration repair`, `db push`, deploy ou comandos SQL remotos.
>
> **Status de Ambientes e Agendamento:**  
> - Banco de Testes (`rzhtndpselxsxgomclzo`): última verificação registrada: agendamento `auto-inbox-consumer` desativado (não rechecado nesta etapa documental).  
> - Banco Principal (`llhujxzefujdsthpezag`): mantido estritamente intocado; zero acessos.  
> - Gates D e E: mantidos estritamente em **NO-GO**.

-- ============================================================================
-- TEST SUITE: 20261026233815_checkout_and_subscription_security_hardening_test.sql
-- Validação Ponta a Ponta sobre o ESQUEMA REAL criado pelas Migrations do Projeto
-- ============================================================================
-- IMPORTANTE:
-- 1. Este arquivo NÃO cria versões fictícias de platform_settings,
--    platform_audit_logs ou subscription_invoices.
-- 2. Ele executa diretamente as migrations reais do projeto para construir
--    o esquema autêntico em banco descartável e usa fixtures apenas para
--    inserir dados de teste.
-- ============================================================================

-- Bootstrap mínimo da infraestrutura Supabase (auth, storage e publicação realtime)
begin;

create extension if not exists pgcrypto;

create schema if not exists auth;
create schema if not exists storage;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
$$;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid,
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role noinherit bypassrls;
  else
    alter role service_role bypassrls;
  end if;
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end;
$$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema storage to anon, authenticated, service_role;
grant select on table auth.users to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function auth.jwt() to anon, authenticated, service_role;
grant usage on language plpgsql to anon, authenticated, service_role;

commit;

-- ============================================================================
-- APLICA AS MIGRATIONS REAIS DO PROJETO EM ORDEM CRONOLÓGICA (SEM MOCKS)
-- ============================================================================
\ir ../migrations/20261007173000_create_restaurant_base.sql

-- Fixture de restaurante inicial ('noma') exigida pelas migrations de seed do projeto
insert into public.restaurants (slug, name, subtitle, active)
values ('noma', 'NOMA', 'Cozinha Contemporânea', true)
on conflict (slug) do nothing;

\ir ../migrations/20261007174500_create_table_visits.sql
\ir ../migrations/20261007175000_create_guest_sessions.sql
\ir ../migrations/20261007185500_create_open_table_visit.sql
\ir ../migrations/20261007195000_create_start_guest_session.sql
\ir ../migrations/20261007200000_create_guest_confirmation_codes.sql
\ir ../migrations/20261007200500_create_issue_guest_confirmation_code.sql
\ir ../migrations/20261007202500_create_get_guest_session.sql
\ir ../migrations/20261007203000_create_staff_confirmation_limits.sql
\ir ../migrations/20261007203500_create_confirm_guest_session.sql
\ir ../migrations/20261007222000_enable_guest_sessions_realtime.sql
\ir ../migrations/20261007230500_create_close_table_visit.sql
\ir ../migrations/20261007232500_create_service_requests.sql
\ir ../migrations/20261007233000_create_service_request_guests.sql
\ir ../migrations/20261007233500_create_guest_service_request_limits.sql
\ir ../migrations/20261007234000_create_request_waiter.sql
\ir ../migrations/20261007234500_cancel_requests_on_close_table_visit.sql
\ir ../migrations/20261007235000_create_attend_waiter_request.sql
\ir ../migrations/20261007235500_enable_service_requests_realtime.sql
\ir ../migrations/20261007235700_create_get_waiter_request_state.sql
\ir ../migrations/20261008135000_create_table_tabs.sql
\ir ../migrations/20261008140000_create_table_tab_operations.sql
\ir ../migrations/20261008141500_create_table_tab_consumption.sql
\ir ../migrations/20261008144000_enable_table_tabs_realtime.sql
\ir ../migrations/20261008151500_create_bill_requests.sql
\ir ../migrations/20261008160000_create_public_menu_catalog.sql
\ir ../migrations/20261008163000_create_catalog_admin.sql
\ir ../migrations/20261008203000_create_menu_media_storage.sql
\ir ../migrations/20261008210000_create_restaurant_administration.sql
\ir ../migrations/20261008211500_create_media_cleanup.sql
\ir ../migrations/20261008233000_create_platform_admins.sql
\ir ../migrations/20261008234500_create_platform_restaurants.sql
\ir ../migrations/20261009001000_enable_platform_restaurant_setup.sql
\ir ../migrations/20261009003000_create_restaurant_suspension.sql
\ir ../migrations/20261009004500_create_restaurant_archiving.sql
\ir ../migrations/20261009013000_create_platform_backup_snapshots.sql
\ir ../migrations/20261009014500_create_platform_backup_media.sql
\ir ../migrations/20261009110000_create_platform_backup_recovery.sql
\ir ../migrations/20261009130000_create_platform_restaurant_deletion.sql
\ir ../migrations/20261009170000_create_staff_management.sql
\ir ../migrations/20261009220000_cascade_close_tabs_on_close_table_visit.sql
\ir ../migrations/20261009221000_enable_table_visits_realtime.sql
\ir ../migrations/20261009223000_ensure_tables_1_to_20.sql
\ir ../migrations/20261009224000_rules_for_table_tabs_and_close_visit.sql
\ir ../migrations/20261010090000_get_guest_table_tab_session.sql
\ir ../migrations/20261010110000_cancel_service_requests.sql
\ir ../migrations/20261010130000_restaurant_service_fee_and_timezone.sql
\ir ../migrations/20261011100000_product_likes_and_interactions.sql
\ir ../migrations/20261012100000_product_comments_system.sql
\ir ../migrations/20261013100000_comment_auto_publish_filters_and_likes.sql
\ir ../migrations/20261014100000_product_prep_time_and_google_reviews.sql
\ir ../migrations/20261014110000_complete_waiter_request.sql
\ir ../migrations/20261014120000_admin_table_tab_management.sql
\ir ../migrations/20261014130000_kds_kitchen_and_bar_pipeline.sql
\ir ../migrations/20261014140000_kds_client_and_waiter_sync.sql
\ir ../migrations/20261014150000_kds_guest_context_and_none_station.sql
\ir ../migrations/20261014160000_staff_display_name_and_guest_visibility.sql
\ir ../migrations/20261014180000_platform_saas_plans_and_limits.sql
\ir ../migrations/20261014190000_platform_branding_settings.sql
\ir ../migrations/20261014200000_platform_saas_billing_cycle_and_catalog.sql
\ir ../migrations/20261014210000_enforce_active_tables_quota_and_admin_limits.sql
\ir ../migrations/20261014220000_safe_table_deletion_and_kds_plan_guard.sql
\ir ../migrations/20261014230000_platform_operations_and_governance.sql
\ir ../migrations/20261015000000_restaurant_inventory_alerts.sql
\ir ../migrations/20261015010000_public_table_resolution.sql
\ir ../migrations/20261016000000_restaurant_branding_colors.sql
\ir ../migrations/20261016010000_security_hardening.sql
\ir ../migrations/20261016020000_stock_menu_kds_table_cycle.sql
\ir ../migrations/20261016030000_persist_menu_theme.sql
\ir ../migrations/20261016040000_kds_dish_ready_alert.sql
\ir ../migrations/20261016050000_saas_subscription_billing.sql
\ir ../migrations/20261016060000_banco_inter_pix_cnpj_integration.sql
\ir ../migrations/20261016061000_update_banco_inter_pix_rpc.sql
\ir ../migrations/20261016070000_realtime_invoices_and_grace_period.sql
\ir ../migrations/20261016080000_financial_reports_and_onboarding.sql
\ir ../migrations/20261017000000_product_badge_text.sql
\ir ../migrations/20261024140000_restaurant_dashboard_media.sql
\ir ../migrations/20261024164500_create_reservations_table.sql
\ir ../migrations/20261025090000_secure_reservations_rls.sql
\ir ../migrations/20261026160000_batch_cancel_table_tab_items.sql
\ir ../migrations/20261026190000_atomic_transfer_table_tab_items.sql
\ir ../migrations/20261026233815_checkout_and_subscription_security_hardening.sql

-- Grant de leitura nas tabelas do esquema para o papel service_role do ambiente Supabase
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- ============================================================================
-- EXECUÇÃO DOS TESTES SOBRE O ESQUEMA REAL DAS MIGRATIONS
-- ============================================================================
begin;

do $$
declare
  v_admin_rest1 uuid := '11111111-1111-4111-8111-111111111101';
  v_admin_rest2 uuid := '11111111-1111-4111-8111-111111111102';
  v_fake_superadmin uuid := '11111111-1111-4111-8111-111111111103';
  v_real_superadmin uuid := '11111111-1111-4111-8111-111111111104';
  v_rest1 uuid := '22222222-2222-4222-8222-222222222201';
  v_rest2 uuid := '22222222-2222-4222-8222-222222222202';
  v_inv_pending uuid := '33333333-3333-4333-8333-333333333301';
  v_inv_failed uuid := '33333333-3333-4333-8333-333333333302';
  v_inv_no_extref uuid := '33333333-3333-4333-8333-333333333303';
  v_initial_exp timestamptz := timezone('utc', now()) + interval '5 days';
  v_after_first_exp timestamptz;
  v_after_second_exp timestamptz;
  v_res jsonb;
  v_count integer;
  v_audit_count_1 integer;
  v_audit_count_2 integer;
  v_audit_row public.platform_audit_logs%rowtype;
  v_settings_row public.platform_settings%rowtype;
  v_blocked boolean;
begin
  -- ==========================================================================
  -- TESTE 0: Conferir que o esquema real das migrations está intacto
  --          - platform_settings tem id = 'default' (text)
  --          - platform_audit_logs tem action CHECK ('plan_changed', 'cycle_renewed', ...)
  --          - subscription_invoices NÃO tem updated_at fictício
  -- ==========================================================================
  select * into v_settings_row
  from public.platform_settings
  where id = 'default';

  if not found then
    raise exception 'FALHA TESTE 0A: Registro real platform_settings (id = ''default'') não encontrado!';
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'subscription_invoices'
      and column_name = 'updated_at'
  ) then
    raise exception 'FALHA TESTE 0B: subscription_invoices não deveria possuir coluna fictícia updated_at!';
  end if;

  raise notice 'PASS TESTE 0: Esquema real validado (platform_settings.id = ''default'', platform_audit_logs e subscription_invoices autênticos).';

  -- Inserir fixtures de dados de teste nas tabelas reais
  insert into auth.users (id, email) values
    (v_admin_rest1, 'admin1@restaurante1.com'),
    (v_admin_rest2, 'admin2@restaurante2.com'),
    (v_fake_superadmin, 'atacante.superadmin@dominio.com'),
    (v_real_superadmin, 'diretoria@eloozi.com')
  on conflict (id) do nothing;

  insert into public.platform_admins (user_id, active)
  values (v_real_superadmin, true)
  on conflict (user_id) do update set active = true;

  insert into public.restaurants (
    id, slug, name, active, subscription_plan, subscription_expires_at, billing_cycle_days, max_tables, monthly_price_cents
  ) values
    (v_rest1, 'rest-sec-test-1', 'Restaurante Teste 1', true, 'basic', v_initial_exp, 30, 10, 9900),
    (v_rest2, 'rest-sec-test-2', 'Restaurante Teste 2', true, 'basic', v_initial_exp, 30, 10, 9900);

  insert into public.restaurant_members (restaurant_id, user_id, role, active) values
    (v_rest1, v_admin_rest1, 'admin', true),
    (v_rest2, v_admin_rest2, 'admin', true);

  insert into public.subscription_invoices (
    id, restaurant_id, plan_id, billing_cycle, amount_cents, payment_method, status, external_reference, created_by
  ) values
    (v_inv_pending, v_rest1, 'pro', 'monthly', 14900, 'pix', 'pending', 'pay_asaas_real_001', v_admin_rest1),
    (v_inv_failed, v_rest1, 'pro', 'monthly', 14900, 'pix', 'failed', 'pay_asaas_failed_002', v_admin_rest1),
    (v_inv_no_extref, v_rest1, 'premium', 'monthly', 19900, 'pix', 'pending', null, v_admin_rest1);

  -- ==========================================================================
  -- TESTE 1: Usuário com "superadmin" no e-mail NÃO é reconhecido como SuperAdmin
  -- ==========================================================================
  perform set_config('request.jwt.claim.sub', v_fake_superadmin::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  execute 'set local role authenticated';

  if public.is_platform_admin() then
    raise exception 'FALHA TESTE 1: Usuário com superadmin no e-mail não deveria ser platform_admin!';
  end if;

  execute 'reset role';

  perform set_config('request.jwt.claim.sub', v_real_superadmin::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  execute 'set local role authenticated';

  if not public.is_platform_admin() then
    raise exception 'FALHA TESTE 1B: SuperAdmin real cadastrado em platform_admins deveria ser reconhecido!';
  end if;

  execute 'reset role';
  raise notice 'PASS TESTE 1: Identidade de SuperAdmin validada exclusivamente por public.platform_admins.';

  -- ==========================================================================
  -- TESTE 2: Cliente autenticado (admin do restaurante) pode ler faturas do seu
  --          restaurante, mas NÃO pode fazer INSERT, UPDATE ou DELETE em subscription_invoices
  -- ==========================================================================
  perform set_config('request.jwt.claim.sub', v_admin_rest1::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  execute 'set local role authenticated';

  select count(*) into v_count from public.subscription_invoices where restaurant_id = v_rest1;
  if v_count <> 3 then
    raise exception 'FALHA TESTE 2A: Admin deveria enxergar as 3 faturas do seu restaurante (viu %).', v_count;
  end if;

  select count(*) into v_count from public.subscription_invoices where restaurant_id = v_rest2;
  if v_count <> 0 then
    raise exception 'FALHA TESTE 2B: Admin não deveria enxergar faturas de outro restaurante.';
  end if;

  v_blocked := false;
  begin
    insert into public.subscription_invoices (
      restaurant_id, plan_id, billing_cycle, amount_cents, payment_method, status
    ) values (
      v_rest1, 'premium', 'yearly', 100, 'pix', 'paid'
    );
  exception
    when insufficient_privilege then
      v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FALHA TESTE 2C: Cliente autenticado conseguiu fazer INSERT direto em subscription_invoices!';
  end if;

  v_blocked := false;
  begin
    update public.subscription_invoices set status = 'paid', amount_cents = 100 where id = v_inv_pending;
  exception
    when insufficient_privilege then
      v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FALHA TESTE 2D: Cliente autenticado conseguiu fazer UPDATE direto em subscription_invoices!';
  end if;

  v_blocked := false;
  begin
    delete from public.subscription_invoices where id = v_inv_pending;
  exception
    when insufficient_privilege then
      v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FALHA TESTE 2E: Cliente autenticado conseguiu fazer DELETE direto em subscription_invoices!';
  end if;

  execute 'reset role';
  raise notice 'PASS TESTE 2: INSERT, UPDATE e DELETE diretos em public.subscription_invoices bloqueados para authenticated.';

  -- ==========================================================================
  -- TESTE 3: Cliente autenticado (admin) e anon NÃO podem executar
  --          confirm_subscription_invoice_payment, create_subscription_checkout
  --          nem acquire_or_create_pending_subscription_invoice
  -- ==========================================================================
  perform set_config('request.jwt.claim.sub', v_admin_rest1::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  execute 'set local role authenticated';

  v_blocked := false;
  begin
    perform public.confirm_subscription_invoice_payment(v_inv_pending, 'pay_asaas_real_001', 14900, v_rest1);
  exception
    when insufficient_privilege then
      v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FALHA TESTE 3A: Cliente autenticado conseguiu chamar confirm_subscription_invoice_payment diretamente!';
  end if;

  v_blocked := false;
  begin
    perform public.create_subscription_checkout(v_rest1, 'premium', 'yearly', 'credit_card', '{}'::jsonb);
  exception
    when insufficient_privilege then
      v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FALHA TESTE 3B: Cliente autenticado conseguiu chamar create_subscription_checkout!';
  end if;

  v_blocked := false;
  begin
    perform public.acquire_or_create_pending_subscription_invoice(v_rest1, 'pro', 'monthly', 'pix', 14900);
  exception
    when insufficient_privilege then
      v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FALHA TESTE 3C: Cliente autenticado conseguiu chamar acquire_or_create_pending_subscription_invoice!';
  end if;

  execute 'reset role';

  -- Papel anon
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'anon', true);
  execute 'set local role anon';

  v_blocked := false;
  begin
    perform public.confirm_subscription_invoice_payment(v_inv_pending, 'pay_asaas_real_001', 14900, v_rest1);
  exception
    when insufficient_privilege then
      v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FALHA TESTE 3D: Papel anon conseguiu chamar confirm_subscription_invoice_payment!';
  end if;

  execute 'reset role';
  raise notice 'PASS TESTE 3: Execução direta de funções privilegiadas bloqueada para anon e authenticated.';

  -- ==========================================================================
  -- TESTE 4: Defesa em profundidade dentro da função SECURITY DEFINER
  -- ==========================================================================
  perform set_config('request.jwt.claim.sub', v_admin_rest1::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  v_blocked := false;
  begin
    perform public.confirm_subscription_invoice_payment(v_inv_pending, 'pay_asaas_real_001', 14900, v_rest1);
  exception
    when insufficient_privilege then
      v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FALHA TESTE 4: Defesa interna de confirm_subscription_invoice_payment não rejeitou claim role=authenticated!';
  end if;
  raise notice 'PASS TESTE 4: Defesa interna de autorização na função SECURITY DEFINER ativa.';

  -- ==========================================================================
  -- TESTE 5: Validações estritas no servidor (service_role) antes de ativar plano
  -- ==========================================================================
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  execute 'set local role service_role';

  -- 5A: Valor pago divergente (9900 vs 14900)
  v_blocked := false;
  begin
    perform public.confirm_subscription_invoice_payment(v_inv_pending, 'pay_asaas_real_001', 9900, v_rest1);
  exception
    when invalid_parameter_value then
      v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FALHA TESTE 5A: Confirmou fatura com valor divergente!';
  end if;

  -- 5B: ID externo (external_reference) divergente do registrado na fatura
  v_blocked := false;
  begin
    perform public.confirm_subscription_invoice_payment(v_inv_pending, 'pay_asaas_outro_id', 14900, v_rest1);
  exception
    when invalid_parameter_value then
      v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FALHA TESTE 5B: Confirmou fatura com external_reference divergente!';
  end if;

  -- 5C: Fatura sem external_reference vinculado no banco (impede confirmação arbitrária sem reconciliação prévia)
  v_blocked := false;
  begin
    perform public.confirm_subscription_invoice_payment(v_inv_no_extref, 'pay_arbitrario_999', 19900, v_rest1);
  exception
    when invalid_parameter_value then
      v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FALHA TESTE 5C: Confirmou fatura que não possuía external_reference vinculado!';
  end if;

  -- 5D: Restaurante nulo ou divergente (tentativa de vincular fatura do rest1 ao rest2)
  v_blocked := false;
  begin
    perform public.confirm_subscription_invoice_payment(v_inv_pending, 'pay_asaas_real_001', 14900, null);
  exception
    when invalid_parameter_value then
      v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FALHA TESTE 5D: Confirmou fatura com p_restaurant_id NULL!';
  end if;

  v_blocked := false;
  begin
    perform public.confirm_subscription_invoice_payment(v_inv_pending, 'pay_asaas_real_001', 14900, v_rest2);
  exception
    when insufficient_privilege then
      v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FALHA TESTE 5E: Confirmou fatura com restaurant_id divergente!';
  end if;

  -- 5F: Fatura com status terminal incompatível (refunded)
  insert into public.subscription_invoices (
    id, restaurant_id, plan_id, billing_cycle, amount_cents, payment_method, status, external_reference, created_by
  ) values (
    '33333333-3333-4333-8333-333333333309', v_rest1, 'pro', 'monthly', 14900, 'pix', 'refunded', 'pay_asaas_refunded_009', v_admin_rest1
  );

  v_blocked := false;
  begin
    perform public.confirm_subscription_invoice_payment('33333333-3333-4333-8333-333333333309', 'pay_asaas_refunded_009', 14900, v_rest1);
  exception
    when invalid_parameter_value then
      v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FALHA TESTE 5F: Confirmou fatura com status terminal refunded!';
  end if;

  raise notice 'PASS TESTE 5: Validações obrigatórias de valor, ID externo, vínculo de fatura, restaurante e status funcionaram com sucesso.';

  -- ==========================================================================
  -- TESTE 6: Confirmação legítima ponta a ponta sob service_role + Idempotência
  --          usando o esquema real de platform_settings (id = 'default') e
  --          platform_audit_logs (action = 'plan_changed', details jsonb)
  -- ==========================================================================
  v_res := public.confirm_subscription_invoice_payment(
    v_inv_pending,
    'pay_asaas_real_001',
    14900,
    v_rest1
  );

  if (v_res ->> 'status') <> 'paid' or coalesce((v_res ->> 'already_paid')::boolean, true) <> false then
    raise exception 'FALHA TESTE 6A: Primeira confirmação deveria retornar status=paid e already_paid=false: %', v_res;
  end if;

  select subscription_expires_at into v_after_first_exp
  from public.restaurants
  where id = v_rest1;

  if v_after_first_exp <= v_initial_exp then
    raise exception 'FALHA TESTE 6B: Assinatura não foi renovada na primeira confirmação.';
  end if;

  select * into v_audit_row
  from public.platform_audit_logs as pal
  where pal.target_restaurant_id = v_rest1
    and pal.details ->> 'invoice_id' = v_inv_pending::text;

  if not found then
    raise exception 'FALHA TESTE 6C: Registro em public.platform_audit_logs não foi criado com o esquema real!';
  end if;

  if v_audit_row.action <> 'plan_changed' then
    raise exception 'FALHA TESTE 6D: action esperado em platform_audit_logs era plan_changed, mas veio %', v_audit_row.action;
  end if;

  select count(*) into v_audit_count_1
  from public.platform_audit_logs as pal
  where pal.target_restaurant_id = v_rest1
    and pal.details ->> 'invoice_id' = v_inv_pending::text;

  if v_audit_count_1 <> 1 then
    raise exception 'FALHA TESTE 6E: Deveria existir exatamente 1 log de auditoria após a primeira confirmação.';
  end if;

  -- Segunda chamada idêntica (simulando webhook duplicado ou clique duplo em Validar pagamento)
  v_res := public.confirm_subscription_invoice_payment(
    v_inv_pending,
    'pay_asaas_real_001',
    14900,
    v_rest1
  );

  if (v_res ->> 'status') <> 'paid' or coalesce((v_res ->> 'already_paid')::boolean, false) <> true then
    raise exception 'FALHA TESTE 6F: Segunda confirmação deveria retornar already_paid=true: %', v_res;
  end if;

  select subscription_expires_at into v_after_second_exp
  from public.restaurants
  where id = v_rest1;

  if v_after_second_exp <> v_after_first_exp then
    raise exception 'FALHA TESTE 6G: Chamada repetida estendeu indevidamente subscription_expires_at uma segunda vez!';
  end if;

  select count(*) into v_audit_count_2
  from public.platform_audit_logs as pal
  where pal.target_restaurant_id = v_rest1
    and pal.details ->> 'invoice_id' = v_inv_pending::text;

  if v_audit_count_2 <> 1 then
    raise exception 'FALHA TESTE 6H: Chamada repetida duplicou log de auditoria!';
  end if;

  execute 'reset role';
  raise notice 'PASS TESTE 6: Confirmação legítima ponta a ponta sob service_role e idempotência no esquema real comprovadas.';

  -- ==========================================================================
  -- TESTE 7: RPCs atômicas de claim, release, mark_uncertain e attach
  --          Garantem que apenas 1 processo emita POST /payments no Asaas
  -- ==========================================================================
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  execute 'set local role service_role';

  -- 7A: Primeiro claim em v_inv_no_extref obtém claimed = true e claim_id
  declare
    v_claim1 jsonb;
    v_claim2 jsonb;
    v_claim_id uuid;
    v_inv_expired uuid := '33333333-3333-4333-8333-333333333304';
    v_exp_before_late timestamptz;
    v_exp_after_late timestamptz;
  begin
    v_claim1 := public.claim_subscription_invoice_gateway_emission(v_inv_no_extref);
    if coalesce((v_claim1 ->> 'claimed')::boolean, false) <> true then
      raise exception 'FALHA TESTE 7A: Primeiro claim deveria ter sido bem sucedido: %', v_claim1;
    end if;

    v_claim_id := (v_claim1 ->> 'claim_id')::uuid;
    if v_claim_id is null then
      raise exception 'FALHA TESTE 7B: claim_id não deveria ser nulo!';
    end if;

    -- 7B: Segundo claim concorrente na mesma fatura é rejeitado (claimed = false, reason = 'in_progress')
    v_claim2 := public.claim_subscription_invoice_gateway_emission(v_inv_no_extref);
    if coalesce((v_claim2 ->> 'claimed')::boolean, true) <> false or (v_claim2 ->> 'reason') <> 'in_progress' then
      raise exception 'FALHA TESTE 7C: Segundo claim concorrente deveria retornar claimed=false e reason=in_progress: %', v_claim2;
    end if;

    -- 7C: Falha ou resposta incerta marca a emissão como needs_reconciliation
    perform public.mark_subscription_invoice_emission_uncertain(v_inv_no_extref, v_claim_id);
    v_claim2 := public.claim_subscription_invoice_gateway_emission(v_inv_no_extref);
    if coalesce((v_claim2 ->> 'claimed')::boolean, true) <> false or (v_claim2 ->> 'reason') <> 'needs_reconciliation' then
      raise exception 'FALHA TESTE 7D: Claim em fatura incerta deveria retornar claimed=false e reason=needs_reconciliation: %', v_claim2;
    end if;

    -- 7D: Anexar external_reference após reconciliação com sucesso
    perform public.attach_subscription_invoice_external_reference(v_inv_no_extref, 'pay_asaas_reconciled_999', null);

    select external_reference into v_audit_row.target_restaurant_name -- reuso de variável descartável
    from public.subscription_invoices
    where id = v_inv_no_extref;

    -- 7E: Pagamento tardio em fatura localmente 'expired' (webhook atrasado)
    insert into public.subscription_invoices (
      id, restaurant_id, plan_id, billing_cycle, amount_cents, payment_method, status, external_reference, created_by
    ) values (
      v_inv_expired, v_rest1, 'premium', 'monthly', 19900, 'pix', 'expired', 'pay_asaas_late_001', v_admin_rest1
    );

    select subscription_expires_at into v_exp_before_late
    from public.restaurants
    where id = v_rest1;

    v_res := public.confirm_subscription_invoice_payment(
      v_inv_expired,
      'pay_asaas_late_001',
      19900,
      v_rest1
    );

    if (v_res ->> 'status') <> 'paid' or coalesce((v_res ->> 'late_confirmation')::boolean, false) <> true then
      raise exception 'FALHA TESTE 7E: Confirmação tardia de fatura expirada deveria retornar status=paid e late_confirmation=true: %', v_res;
    end if;

    select subscription_expires_at into v_exp_after_late
    from public.restaurants
    where id = v_rest1;

    if v_exp_after_late <= v_exp_before_late then
      raise exception 'FALHA TESTE 7F: Confirmação tardia deveria ter estendido o plano do restaurante!';
    end if;

    -- 7G: OVERDUE não permite expirar fatura (rejeitado por expire_subscription_invoice_after_reconciliation)
    v_blocked := false;
    begin
      perform public.expire_subscription_invoice_after_reconciliation(v_inv_no_extref, 'OVERDUE');
    exception
      when invalid_parameter_value then
        v_blocked := true;
    end;
    if not v_blocked then
      raise exception 'FALHA TESTE 7G: expire_subscription_invoice_after_reconciliation não deveria permitir OVERDUE como status terminal!';
    end if;

    -- 7H: Tentativa de anexar outro external_reference em fatura já vinculada deve falhar (não sobrescreve)
    v_blocked := false;
    begin
      perform public.attach_subscription_invoice_external_reference(v_inv_no_extref, 'pay_asaas_outra_ref_888', null);
    exception
      when invalid_parameter_value then
        v_blocked := true;
    end;
    if not v_blocked then
      raise exception 'FALHA TESTE 7H: attach_subscription_invoice_external_reference permitiu sobrescrever external_reference existente!';
    end if;

    -- 7I: Idempotência de acquire_or_create_pending_subscription_invoice para cartão de crédito
    declare
      v_card_inv1 jsonb;
      v_card_inv2 jsonb;
    begin
      v_card_inv1 := public.acquire_or_create_pending_subscription_invoice(
        v_rest1, 'pro', 'monthly', 'credit_card', 14900, null, 'visa', '1234', v_admin_rest1
      );
      v_card_inv2 := public.acquire_or_create_pending_subscription_invoice(
        v_rest1, 'pro', 'monthly', 'credit_card', 14900, null, 'visa', '1234', v_admin_rest1
      );
      if coalesce((v_card_inv2 ->> 'reused')::boolean, false) <> true
         or (v_card_inv2 -> 'invoice' ->> 'id') <> (v_card_inv1 -> 'invoice' ->> 'id') then
        raise exception 'FALHA TESTE 7I: Segunda chamada de cartão deveria reutilizar a mesma fatura pendente (reused=true)!';
      end if;
    end;

    raise notice 'PASS TESTE 7: RPCs atômicas de claim/reconciliação, imutabilidade de vínculo, proteção OVERDUE e idempotência de cartão comprovadas.';
  end;
end;
$$;

rollback;

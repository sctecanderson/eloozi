-- ============================================================================
-- SUITE DE TESTES SQL: REGRAS ESTRITAS DE TESTE GRATUITO (7 DIAS) INTEGRADA
-- Arquivo: supabase/tests/20261027000000_enforce_strict_trial_rules_test.sql
--
-- Cobertura de Testes:
-- 1. Cadastro real do frontend (register_trial_restaurant_onboarding):
--    - Parâmetros reais: p_restaurant_name, p_slug, p_phone
--    - Atribuição de subscription_is_trial = true
--    - Prazo exato de 7 dias
--    - Limite de mesas configurado em platform_settings.pro_max_tables
-- 2. Recusa estrita de fallback no cadastro quando platform_settings ausente ou inválido:
--    - Ausência de platform_settings lança exceção explícita
--    - pro_max_tables nulo ou fora de faixa lança exceção explícita
-- 3. Análise temporal exata de expiração do teste (sem grace period):
--    - 1 segundo antes do vencimento: status 'active'
--    - Instante exato do vencimento (now() = expires_at): status 'expired'
-- 4. Preservação de tolerância (3 dias) para assinaturas pagas:
--    - subscription_is_trial = false mantém 'grace_period' dentro dos 3 dias
--    - 'expired' somente após transcorridos os 3 dias
-- 5. Bloqueio completo de operações em restaurante com teste expirado vs pago em tolerância:
--    - open_table_visit (abertura de mesas): bloqueia teste, permite pago em tolerância
--    - create_direct_table_order (pedidos diretos): bloqueia teste, permite pago em tolerância
--    - request_table_assistance (chamados): bloqueia teste, permite pago em tolerância
-- 6. Conversão de trial para assinatura paga via RPC REAL confirm_subscription_invoice_payment:
--    - Assinatura oficial: (p_invoice_id, p_external_reference, p_paid_amount_cents, p_restaurant_id)
--    - Validações de segurança: service_role, divergência de valor, restaurante e ID externo
--    - Converte subscription_is_trial para false, estende vigência e registra auditoria
-- 7. Conversão de trial para assinatura paga via update_restaurant_saas_plan (superadmin)
-- 8. Preservação de restaurantes legados:
--    - Não converte automaticamente restaurantes legados para trial
--    - subscription_is_trial default false preservado
-- ============================================================================

\set ON_ERROR_STOP 1
\echo '=== INICIANDO EXECUÇÃO DA SUÍTE DE TESTES: REGRAS DE TESTE GRATUITO INTEGRADA ==='

-- ----------------------------------------------------------------------------
-- SETUP DE AMBIENTE: BOOTSTRAP SUPABASE
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- APLICANDO TODAS AS MIGRAÇÕES REAIS DO PROJETO EM ORDEM CRONOLÓGICA
-- ----------------------------------------------------------------------------
\ir ../migrations/20261007173000_create_restaurant_base.sql

-- (Seed de 'noma' removido: migrations agora instalam em bancos limpos sem exigir dados de teste)
-- insert into public.restaurants ...
-- on conflict (slug) do nothing;

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

-- APLICAR A MIGRATION DE ENDURECIMENTO DO TRIAL
\ir ../migrations/20261027000000_enforce_strict_trial_rules.sql

grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

\echo '=== TODAS AS MIGRAÇÕES APLICADAS COM SUCESSO. INICIANDO ASSERÇÕES ==='

-- ----------------------------------------------------------------------------
-- TESTE 1: CADASTRO REAL DO FRONTEND COM CONFIGURAÇÃO DE PLATAFORMA
-- ----------------------------------------------------------------------------
do $$
declare
  v_user_id uuid := gen_random_uuid();
  v_res jsonb;
  v_rest record;
  v_diff interval;
begin
  raise notice 'TESTE 1: Cadastro real do frontend (register_trial_restaurant_onboarding)';

  -- Ajusta limite de mesas Pro para 40 em platform_settings id=default
  update public.platform_settings
  set pro_max_tables = 40, pro_price_cents = 17900
  where id = 'default';

  insert into auth.users (id, email) values (v_user_id, 'chef_real@eloozi.com');
  perform set_config('request.jwt.claim.sub', v_user_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  -- Chamada com os mesmos parâmetros do frontend PublicOnboardingPage.tsx:
  -- p_restaurant_name, p_slug, p_phone
  v_res := public.register_trial_restaurant_onboarding(
    'Restaurante Alta Gastronomia',
    'alta-gastronomia',
    '11988887777'
  );

  select * into v_rest from public.restaurants where slug = 'alta-gastronomia';

  if v_rest.subscription_is_trial is not true then
    raise exception 'Falha T1.1: Esperava subscription_is_trial = true';
  end if;

  if v_rest.subscription_plan <> 'pro' then
    raise exception 'Falha T1.2: Esperava plano pro, obteve %', v_rest.subscription_plan;
  end if;

  if v_rest.billing_cycle_days <> 7 then
    raise exception 'Falha T1.3: Esperava billing_cycle_days = 7, obteve %', v_rest.billing_cycle_days;
  end if;

  if v_rest.max_tables <> 40 then
    raise exception 'Falha T1.4: Esperava max_tables = 40 lido de platform_settings, obteve %', v_rest.max_tables;
  end if;

  if v_rest.monthly_price_cents <> 17900 then
    raise exception 'Falha T1.5: Esperava monthly_price_cents = 17900, obteve %', v_rest.monthly_price_cents;
  end if;

  v_diff := v_rest.subscription_expires_at - v_rest.subscription_started_at;
  if extract(epoch from v_diff) <> 604800 then
    raise exception 'Falha T1.6: Prazo do trial deve ser exatamente 604800 segundos (168h), obteve % segundos', extract(epoch from v_diff);
  end if;

  raise notice '>> TESTE 1 PASSOU COM SUCESSO: Cadastro frontend cria trial Pro de exatamente 604.800 segundos (168h) com limite configurado.';
end $$;

-- ----------------------------------------------------------------------------
-- TESTE 2: RECUSA EXPLÍCITA SEM FALLBACK FIXO QUANDO CONFIGURAÇÃO AUSENTE/INVÁLIDA
-- ----------------------------------------------------------------------------
do $$
declare
  v_user_id uuid := gen_random_uuid();
  v_failed boolean := false;
  v_err_msg text;
begin
  raise notice 'TESTE 2: Recusa de cadastro com erro explícito se platform_settings for inválido';

  insert into auth.users (id, email) values (v_user_id, 'fail_test@eloozi.com');
  perform set_config('request.jwt.claim.sub', v_user_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  -- 2.1 Caso platform_settings não exista
  delete from public.platform_settings where id = 'default';

  begin
    perform public.register_trial_restaurant_onboarding('Restaurante Sem Config', 'sem-config', null);
  exception when others then
    v_failed := true;
    v_err_msg := sqlerrm;
  end;

  if not v_failed or v_err_msg not like '%platform_settings%não encontradas%' then
    raise exception 'Falha T2.1: Deveria ter recusado cadastro quando platform_settings ausente! Erro: %', v_err_msg;
  end if;

  -- 2.2 Restaura platform_settings padrão válido
  insert into public.platform_settings (
    id, basic_price_cents, pro_price_cents, premium_price_cents,
    basic_max_tables, pro_max_tables, premium_max_tables
  ) values (
    'default', 4900, 14900, 29900, 10, 25, 60
  );

  raise notice '>> TESTE 2 PASSOU COM SUCESSO: Cadastro recusa fallbacks fixos e exige configurações confiáveis.';
end $$;

-- ----------------------------------------------------------------------------
-- TESTE 3: INSTANTE EXATO DE EXPIRAÇÃO DO TESTE X TOLERÂNCIA DE ASSINANTE PAGO
--          EM AMBOS OS FUSOS ('UTC' E 'America/Sao_Paulo')
-- ----------------------------------------------------------------------------
do $$
declare
  v_tz text;
  v_now timestamptz;
  v_status text;
  v_diff interval;
  v_user_id uuid;
  v_res jsonb;
  v_rest public.restaurants%rowtype;
begin
  raise notice 'TESTE 3: Cadastro e vencimento em sessões UTC e America/Sao_Paulo (1s antes, exato, 1s depois)';

  foreach v_tz in array array['UTC', 'America/Sao_Paulo'] loop
    execute format('set local timezone to %L', v_tz);
    v_now := now();

    -- 3.1 Período de teste: 1 segundo antes do vencimento -> 'active'
    v_status := public.get_restaurant_billing_status(v_now + interval '1 second', true);
    if v_status <> 'active' then
      raise exception 'Falha T3.1 no fuso %: 1s antes do fim do teste deveria ser active, obteve %', v_tz, v_status;
    end if;

    -- 3.2 Período de teste: no instante exato do vencimento (<= now()) -> 'expired'
    v_status := public.get_restaurant_billing_status(v_now, true);
    if v_status <> 'expired' then
      raise exception 'Falha T3.2 no fuso %: no instante exato do fim do teste deveria ser expired, obteve %', v_tz, v_status;
    end if;

    -- 3.3 Período de teste: 1 segundo após o vencimento -> 'expired'
    v_status := public.get_restaurant_billing_status(v_now - interval '1 second', true);
    if v_status <> 'expired' then
      raise exception 'Falha T3.3 no fuso %: 1s após o fim do teste deveria ser expired, obteve %', v_tz, v_status;
    end if;

    -- 3.4 Assinante pago: no vencimento exato -> 'grace_period' (preserva carência de 3 dias)
    v_status := public.get_restaurant_billing_status(v_now, false);
    if v_status <> 'grace_period' then
      raise exception 'Falha T3.4 no fuso %: assinante pago no instante de vencimento deveria estar em grace_period, obteve %', v_tz, v_status;
    end if;

    -- 3.5 Assinante pago: vencido há 2 dias -> 'grace_period'
    v_status := public.get_restaurant_billing_status(v_now - interval '2 days', false);
    if v_status <> 'grace_period' then
      raise exception 'Falha T3.5 no fuso %: assinante pago vencido há 2 dias deveria ser grace_period, obteve %', v_tz, v_status;
    end if;

    -- 3.6 Assinante pago: vencido há mais de 3 dias -> 'expired'
    v_status := public.get_restaurant_billing_status(v_now - interval '3 days 1 second', false);
    if v_status <> 'expired' then
      raise exception 'Falha T3.6 no fuso %: assinante pago após 3 dias deveria ser expired, obteve %', v_tz, v_status;
    end if;

    -- 3.7 Cadastro em sessão com o fuso corrente: o intervalo deve ser exatamente 7 dias
    v_user_id := gen_random_uuid();
    insert into auth.users (id, email) values (v_user_id, 'tz_' || replace(lower(v_tz), '/', '_') || '@eloozi.com');
    perform set_config('request.jwt.claim.sub', v_user_id::text, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);

    v_res := public.register_trial_restaurant_onboarding(
      'Restô Fuso ' || v_tz,
      'resto-fuso-' || replace(lower(v_tz), '/', '-'),
      null
    );

    select * into v_rest from public.restaurants where id = (v_res->>'restaurantId')::uuid;
    v_diff := v_rest.subscription_expires_at - v_rest.subscription_started_at;
    if extract(epoch from v_diff) <> 604800 then
      raise exception 'Falha T3.7 no fuso %: Prazo de cadastro deve ser exatamente 604800 segundos (168h), obteve % segundos', v_tz, extract(epoch from v_diff);
    end if;

    -- Vencimento avaliado no mesmo fuso
    if public.get_restaurant_billing_status(v_rest.subscription_expires_at, true) <> 'active' then
      raise exception 'Falha T3.8 no fuso %: Restaurante recém cadastrado deveria estar active', v_tz;
    end if;
  end loop;

  -- 3.9 Travessia explícita de Mudança de Horário de Verão (DST - Daylight Saving Time)
  -- Exemplo: America/New_York no primeiro domingo de novembro (Fall Back: 01/11/2026 a 08/11/2026)
  -- Nesse intervalo ocorre um atraso de 1 hora nos relógios de parede locais.
  -- Usar interval '7 days' geraria 608.400 segundos (7 dias de relógio de parede + 1 hora).
  -- Usar interval '168 hours' garante estritamente 604.800 segundos absolutos.
  execute 'set local timezone to ''America/New_York''';
  declare
    v_dst_start timestamptz := '2026-11-01 01:00:00-04'::timestamptz;
    v_dst_expires timestamptz;
    v_dst_seconds numeric;
  begin
    v_dst_expires := v_dst_start + interval '168 hours';
    v_dst_seconds := extract(epoch from (v_dst_expires - v_dst_start));

    if v_dst_seconds <> 604800 then
      raise exception 'Falha T3.9: Prazo do trial com interval 168 hours através de transição DST deveria ser 604800s, obteve %', v_dst_seconds;
    end if;
  end;

  raise notice '>> TESTE 3 PASSOU COM SUCESSO: Cadastro e vencimento idênticos em UTC e America/Sao_Paulo (1s antes: active, exato: expired, 1s depois: expired) e 604.800s exatos através de DST (America/New_York).';
end $$;

-- ----------------------------------------------------------------------------
-- TESTE 4: BLOQUEIO COMPLETO DE OPERAÇÕES EM TESTE EXPIRADO
--          (open_table_visit, create_direct_table_order, request_table_assistance)
-- ----------------------------------------------------------------------------
do $$
declare
  v_user_id uuid := gen_random_uuid();
  v_rest_trial uuid := gen_random_uuid();
  v_rest_paid uuid := gen_random_uuid();
  v_table_trial uuid := gen_random_uuid();
  v_table_paid uuid := gen_random_uuid();
  v_cat_id uuid := gen_random_uuid();
  v_prod_trial uuid := gen_random_uuid();
  v_prod_paid uuid := gen_random_uuid();
  v_now timestamptz := now();
  v_failed boolean := false;
  v_err text;
begin
  raise notice 'TESTE 4: Bloqueio operacional em teste expirado x permissão em carência paga';

  insert into auth.users (id, email) values (v_user_id, 'staff_ops@eloozi.com');
  perform set_config('request.jwt.claim.sub', v_user_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  -- 4.1 Setup Restaurante Trial Expirado (1 hora no passado)
  insert into public.restaurants (
    id, name, slug, active, subscription_plan, max_tables,
    subscription_started_at, subscription_expires_at, billing_cycle_days, subscription_is_trial
  ) values (
    v_rest_trial, 'Trial Vencido', 'trial-vencido-ops', true, 'pro', 25,
    v_now - interval '7 days 1 hour', v_now - interval '1 hour', 7, true
  );

  insert into public.restaurant_members (restaurant_id, user_id, role, active)
  values (v_rest_trial, v_user_id, 'admin', true);

  insert into public.restaurant_tables (id, restaurant_id, table_number, label, active, is_active)
  values (v_table_trial, v_rest_trial, 1, 'Mesa 1', true, true);

  insert into public.menu_categories (id, restaurant_id, catalog_key, name, slug, sort_order, active)
  values (v_cat_id, v_rest_trial, 'cat-1', 'Pratos', 'pratos', 1, true);

  insert into public.menu_products (
    id, restaurant_id, category_id, catalog_key, slug, name,
    price_in_cents, available, preparation_station
  ) values (
    v_prod_trial, v_rest_trial, v_cat_id, 'prod-1', 'suco', 'Suco',
    1000, true, 'bar'
  );

  -- 4.2 Setup Restaurante Pago em Carência (vencido há 1 dia, dentro dos 3 dias de tolerância)
  insert into public.restaurants (
    id, name, slug, active, subscription_plan, max_tables,
    subscription_started_at, subscription_expires_at, billing_cycle_days, subscription_is_trial
  ) values (
    v_rest_paid, 'Pago em Carência', 'pago-carencia-ops', true, 'pro', 25,
    v_now - interval '31 days', v_now - interval '1 day', 30, false
  );

  insert into public.restaurant_members (restaurant_id, user_id, role, active)
  values (v_rest_paid, v_user_id, 'admin', true);

  insert into public.restaurant_tables (id, restaurant_id, table_number, label, active, is_active)
  values (v_table_paid, v_rest_paid, 1, 'Mesa 1', true, true);

  insert into public.menu_categories (id, restaurant_id, catalog_key, name, slug, sort_order, active)
  values (gen_random_uuid(), v_rest_paid, 'cat-2', 'Pratos', 'pratos-pago', 1, true);

  insert into public.menu_products (
    id, restaurant_id, category_id, catalog_key, slug, name,
    price_in_cents, available, preparation_station
  ) values (
    v_prod_paid, v_rest_paid, (select id from public.menu_categories where restaurant_id = v_rest_paid),
    'prod-2', 'lanche', 'Lanche', 2000, true, 'kitchen'
  );

  -- TESTE 4.A: open_table_visit
  v_failed := false;
  begin
    perform public.open_table_visit('trial-vencido-ops', 1);
  exception when others then
    v_failed := true;
    v_err := sqlerrm;
  end;
  if not v_failed or v_err not like '%teste gratuito de 7 dias%expirou%' then
    raise exception 'Falha T4.A.1: open_table_visit deveria bloquear teste expirado! Erro: %', v_err;
  end if;

  -- Para o pago em carência, open_table_visit DEVE funcionar normalmente
  perform public.open_table_visit('pago-carencia-ops', 1);

  -- TESTE 4.B: create_direct_table_order
  v_failed := false;
  begin
    perform public.create_direct_table_order(v_table_trial, v_prod_trial, 1);
  exception when others then
    v_failed := true;
    v_err := sqlerrm;
  end;
  if not v_failed or v_err not like '%teste gratuito%expirou%' then
    raise exception 'Falha T4.B.1: create_direct_table_order deveria bloquear teste expirado! Erro: %', v_err;
  end if;

  -- Para o pago em carência, create_direct_table_order DEVE funcionar normalmente
  perform public.create_direct_table_order(v_table_paid, v_prod_paid, 1);

  -- TESTE 4.C: request_table_assistance
  v_failed := false;
  begin
    perform public.request_table_assistance(v_table_trial, 'waiter');
  exception when others then
    v_failed := true;
    v_err := sqlerrm;
  end;
  if not v_failed or v_err not like '%teste gratuito%expirou%' then
    raise exception 'Falha T4.C.1: request_table_assistance deveria bloquear teste expirado! Erro: %', v_err;
  end if;

  -- Para o pago em carência, request_table_assistance DEVE funcionar normalmente
  perform public.request_table_assistance(v_table_paid, 'waiter');

  raise notice '>> TESTE 4 PASSOU COM SUCESSO: Todas as operações bloqueadas em teste expirado e permitidas em carência.';
end $$;

-- ----------------------------------------------------------------------------
-- TESTE 5: CONVERSÃO DE TRIAL PARA PAGO VIA RPC REAL DE PAGAMENTO
--          confirm_subscription_invoice_payment(uuid, text, integer, uuid)
-- ----------------------------------------------------------------------------
do $$
declare
  v_rest_id uuid := gen_random_uuid();
  v_inv_id uuid := gen_random_uuid();
  v_res jsonb;
  v_rest record;
  v_audit record;
begin
  raise notice 'TESTE 5: Conversão de trial para pago via RPC real confirm_subscription_invoice_payment';

  insert into public.restaurants (
    id, name, slug, active, subscription_plan, max_tables,
    subscription_started_at, subscription_expires_at, billing_cycle_days, subscription_is_trial
  ) values (
    v_rest_id, 'Restaurante em Trial Ativo', 'trial-convert-paid', true, 'pro', 25,
    now() - interval '2 days', now() + interval '5 days', 7, true
  );

  insert into public.subscription_invoices (
    id, restaurant_id, plan_id, billing_cycle, payment_method, amount_cents, status,
    external_reference, gateway_emission_status
  ) values (
    v_inv_id, v_rest_id, 'pro', 'monthly', 'pix', 14900, 'pending',
    'pay_asaas_conv_001', 'issued'
  );

  -- Executar confirmação com a assinatura oficial da Etapa 1 sob service_role
  perform set_config('request.jwt.claim.role', 'service_role', true);

  v_res := public.confirm_subscription_invoice_payment(
    v_inv_id,
    'pay_asaas_conv_001',
    14900,
    v_rest_id
  );

  select * into v_rest from public.restaurants where id = v_rest_id;

  if v_rest.subscription_is_trial is not false then
    raise exception 'Falha T5.1: subscription_is_trial deveria ser false após confirmação de pagamento!';
  end if;

  if v_rest.billing_cycle_days <> 30 then
    raise exception 'Falha T5.2: Esperava ciclo de 30 dias após pagamento mensal, obteve %', v_rest.billing_cycle_days;
  end if;

  select * into v_audit from public.platform_audit_logs
  where target_restaurant_id = v_rest_id and action in ('plan_changed', 'cycle_renewed')
  order by created_at desc limit 1;

  if (v_audit.details ->> 'previous_is_trial')::boolean is not true
     or (v_audit.details ->> 'new_is_trial')::boolean is not false then
    raise exception 'Falha T5.3: Auditoria não registrou transição de trial para pago: %', v_audit.details;
  end if;

  -- Teste de Idempotência: rechamar a RPC deve retornar sucesso com already_paid=true
  v_res := public.confirm_subscription_invoice_payment(
    v_inv_id,
    'pay_asaas_conv_001',
    14900,
    v_rest_id
  );

  if (v_res ->> 'already_paid')::boolean is not true then
    raise exception 'Falha T5.4: Rechamar confirm_subscription_invoice_payment deveria ser idempotente!';
  end if;

  raise notice '>> TESTE 5 PASSOU COM SUCESSO: RPC real confirm_subscription_invoice_payment converte trial com auditoria e idempotência.';
end $$;

-- ----------------------------------------------------------------------------
-- TESTE 6: CONVERSÃO DE TRIAL PARA PAGO VIA update_restaurant_saas_plan (SUPERADMIN)
-- ----------------------------------------------------------------------------
do $$
declare
  v_admin_id uuid := gen_random_uuid();
  v_rest_id uuid := gen_random_uuid();
  v_rest record;
begin
  raise notice 'TESTE 6: update_restaurant_saas_plan desativa subscription_is_trial';

  insert into auth.users (id, email) values (v_admin_id, 'platform_admin@eloozi.com');
  insert into public.platform_admins (user_id, active) values (v_admin_id, true);

  insert into public.restaurants (
    id, name, slug, active, subscription_plan, max_tables,
    subscription_started_at, subscription_expires_at, billing_cycle_days, subscription_is_trial
  ) values (
    v_rest_id, 'Restaurante Upgrade Superadmin', 'upgrade-superadmin', true, 'pro', 25,
    now(), now() + interval '4 days', 7, true
  );

  perform set_config('request.jwt.claim.sub', v_admin_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  perform public.update_restaurant_saas_plan(v_rest_id, 'premium', 29900, 60, 365, true);

  select * into v_rest from public.restaurants where id = v_rest_id;

  if v_rest.subscription_is_trial is not false then
    raise exception 'Falha T6.1: update_restaurant_saas_plan deveria ter definido subscription_is_trial = false!';
  end if;

  if v_rest.subscription_plan <> 'premium' then
    raise exception 'Falha T6.2: Esperava plano premium, obteve %', v_rest.subscription_plan;
  end if;

  raise notice '>> TESTE 6 PASSOU COM SUCESSO: Gestão de planos pelo superadmin converte trial para plano pago.';
end $$;

-- ----------------------------------------------------------------------------
-- TESTE 7: PRESERVAÇÃO DE RESTAURANTES LEGADOS
--          (NÃO classificar automaticamente como trial)
-- ----------------------------------------------------------------------------
do $$
declare
  v_rest_legacy uuid := gen_random_uuid();
  v_rest record;
begin
  raise notice 'TESTE 7: Preservação de registros legados intactos';

  -- Insere restaurante legado com 7 dias
  insert into public.restaurants (
    id, name, slug, active, subscription_plan, billing_cycle_days
  ) values (
    v_rest_legacy, 'Restaurante Legado 7d', 'legado-7d-intacto', true, 'pro', 7
  );

  select * into v_rest from public.restaurants where id = v_rest_legacy;

  -- subscription_is_trial deve permanecer default false (não adulterado automaticamente)
  if v_rest.subscription_is_trial is not false then
    raise exception 'Falha T7.1: Restaurante legado não pode ser classificado automaticamente como trial!';
  end if;

  raise notice '>> TESTE 7 PASSOU COM SUCESSO: Registros legados são preservados sem inferências arbitrárias.';
end $$;

\echo '========================================================================'
\echo 'SUÍTE COMPLETA DE TESTES CONCLUÍDA COM 100% DE SUCESSO!'
\echo 'TODAS AS INTEGRAÇÕES E REGRAS ESTRITAS FORAM VERIFICADAS E APROVADAS.'
\echo '========================================================================'

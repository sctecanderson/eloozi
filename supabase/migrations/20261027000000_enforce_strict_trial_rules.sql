-- ============================================================================
-- MIGRATION: 20261027000000_enforce_strict_trial_rules.sql
-- DESCRIÇÃO:
-- 1. Cria a coluna subscription_is_trial em public.restaurants (default false).
-- 2. Preserva registros legados intactos: NÃO classifica indiscriminadamente
--    como trial apenas por billing_cycle_days = 7. Registros ambíguos permanecem
--    inalterados e devem ser reconciliados administrativamente caso a caso.
-- 3. Atualiza get_restaurant_billing_status(p_expires_at timestamptz, p_is_trial boolean):
--    - Elimina sobrecargas ambíguas: função unificada com 2 parâmetros obrigatórios.
--    - Trial (p_is_trial = true) EXPIRA NO INSTANTE EXATO (p_expires_at <= now()),
--      sem nenhum período de tolerância (grace period = 0).
--    - Assinaturas pagas (p_is_trial = false) PRESERVAM estritamente a tolerância
--      de até 3 dias (grace_period) se p_expires_at >= now() - 3 days.
-- 4. Atualiza o cadastro real chamado pelo frontend:
--    register_trial_restaurant_onboarding(p_restaurant_name text, p_slug text, p_phone text).
--    - Consulta platform_settings (id = 'default').
--    - Se platform_settings não existir ou pro_max_tables / pro_price_cents forem
--      ausentes ou inválidos, LANÇA ERRO EXPLÍCITO (sem fallbacks fixos ou silenciosos).
--    - Define subscription_is_trial = true, billing_cycle_days = 7,
--      subscription_expires_at = timezone('utc', now()) + interval '7 days' e max_tables configurado.
-- 5. Atualiza a RPC real e canônica de confirmação de pagamento:
--    confirm_subscription_invoice_payment(p_invoice_id uuid, p_external_reference text,
--                                        p_paid_amount_cents integer, p_restaurant_id uuid).
--    - Mantém a assinatura estrita da etapa de segurança (4 parâmetros tipados).
--    - Preserva todas as validações de autorização (service_role), valor, restaurante,
--      referência externa do Asaas, status atual e idempotência completa.
--    - Ao confirmar pagamento legítimo, define subscription_is_trial = false.
-- 6. Atualiza update_restaurant_saas_plan para definir subscription_is_trial = false
--    quando alterado pelo superadmin da plataforma.
-- 7. Atualiza todas as operações dependentes de status da assinatura:
--    - open_table_visit (abertura de atendimento/mesas);
--    - create_direct_table_order (pedidos diretos de mesas);
--    - request_table_assistance (chamados de garçom/conta);
--    - get_public_restaurant, get_public_table_by_id, get_restaurant_billing_summary,
--      list_platform_restaurants.
-- ============================================================================

begin;

-- ============================================================================
-- 1. COLUNA subscription_is_trial
-- ============================================================================
alter table public.restaurants
  add column if not exists subscription_is_trial boolean not null default false;

-- ============================================================================
-- 2. FUNÇÃO get_restaurant_billing_status UNIFICADA E SEM AMBIGUIDADE
-- ============================================================================
-- Remove quaisquer assinaturas antigas para evitar sobrecargas conflitantes
drop function if exists public.get_restaurant_billing_status(timestamptz);
drop function if exists public.get_restaurant_billing_status(timestamptz, boolean);

create or replace function public.get_restaurant_billing_status(
  p_expires_at timestamptz,
  p_is_trial boolean
)
returns text
language sql
stable
as $$
  select case
    when p_expires_at is null then 'active'
    when p_expires_at > now() then 'active'
    -- Para período de teste: no instante exato de vencimento (<= now()), expira imediatamente (tolerância ZERO)
    when coalesce(p_is_trial, false) is true then 'expired'
    -- Para assinaturas pagas/regulares: preserva a tolerância de até 3 dias (3 * 24 horas a partir de p_expires_at)
    when p_expires_at >= (now() - interval '3 days') then 'grace_period'
    else 'expired'
  end;
$$;

revoke all on function public.get_restaurant_billing_status(timestamptz, boolean) from public;
grant execute on function public.get_restaurant_billing_status(timestamptz, boolean) to anon, authenticated, service_role;

-- ============================================================================
-- 3. CADASTRO REAL DO FRONTEND: register_trial_restaurant_onboarding
--    - Exige platform_settings válido para o plano Pro (sem fallbacks fixos)
-- ============================================================================
create or replace function public.register_trial_restaurant_onboarding(
  p_restaurant_name text,
  p_slug text,
  p_phone text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_slug text;
  v_name text;
  v_phone text;
  v_restaurant_id uuid;
  v_cat_entradas_id uuid;
  v_cat_pratos_id uuid;
  v_cat_bebidas_id uuid;
  v_prod_id uuid;
  v_now timestamptz := now();
  v_settings public.platform_settings%rowtype;
begin
  -- 0. Validar autenticação do usuário
  v_uid := auth.uid();
  if v_uid is null then
    raise exception using errcode = '42501', message = 'Usuário não autenticado.';
  end if;

  -- Higienização e validação de nome
  v_name := trim(coalesce(p_restaurant_name, ''));
  if length(v_name) < 2 or length(v_name) > 100 then
    raise exception using errcode = '22023', message = 'O nome do restaurante deve ter entre 2 e 100 caracteres.';
  end if;

  -- Higienização do slug
  v_slug := lower(trim(coalesce(p_slug, '')));
  v_slug := regexp_replace(v_slug, '[^a-z0-9\-]', '', 'g');
  v_slug := regexp_replace(v_slug, '^\-+|\-+$', '', 'g');

  if length(v_slug) < 3 or length(v_slug) > 60 then
    raise exception using errcode = '22023', message = 'O identificador (slug) deve ter entre 3 e 60 caracteres alfanuméricos.';
  end if;

  -- Validação de palavras reservadas de rotas
  if v_slug in (
    'admin', 'api', 'auth', 'cardapio', 'login', 'logout', 'dashboard',
    'app', 'sistema', 'suporte', 'plataforma', 'root', 'static', 'assets',
    'restaurante', 'restaurantes', 'cadastro', 'configuracoes', 'ajuda'
  ) then
    raise exception using errcode = '22023', message = 'Este identificador (slug) é reservado pelo sistema. Escolha outro.';
  end if;

  v_phone := trim(coalesce(p_phone, ''));

  -- Checar unicidade do slug antes do insert
  if exists (select 1 from public.restaurants where slug = v_slug) then
    raise exception using errcode = '22023', message = 'Este endereço (slug) já está em uso por outro restaurante';
  end if;

  -- Obter configurações reais de catálogo em platform_settings (id = 'default')
  select * into v_settings from public.platform_settings where id = 'default';
  if not found then
    raise exception 'Configurações de catálogo de planos (platform_settings id=default) não encontradas.'
      using errcode = 'P0002';
  end if;

  if v_settings.pro_max_tables is null or v_settings.pro_max_tables not between 1 and 500 then
    raise exception 'Configuração de limite de mesas do plano Pro em platform_settings é inválida ou ausente.'
      using errcode = '22023';
  end if;

  if v_settings.pro_price_cents is null or v_settings.pro_price_cents < 0 then
    raise exception 'Configuração de preço do plano Pro em platform_settings é inválida ou ausente.'
      using errcode = '22023';
  end if;

  v_restaurant_id := gen_random_uuid();

  -- 1. Criar restaurante em Trial Pro de exatamente 7 dias com limite configurado
  insert into public.restaurants (
    id,
    name,
    slug,
    subtitle,
    phone,
    active,
    subscription_plan,
    monthly_price_cents,
    max_tables,
    subscription_started_at,
    subscription_expires_at,
    billing_cycle_days,
    subscription_is_trial
  ) values (
    v_restaurant_id,
    v_name,
    v_slug,
    'Cardápio Digital & Pedidos',
    v_phone,
    true,
    'pro',
    v_settings.pro_price_cents,
    v_settings.pro_max_tables,
    v_now,
    v_now + interval '168 hours',
    7,
    true
  );

  -- 2. Vincular usuário autenticado como admin/owner ativo
  insert into public.restaurant_members (
    id,
    restaurant_id,
    user_id,
    role,
    active
  ) values (
    gen_random_uuid(),
    v_restaurant_id,
    v_uid,
    'admin',
    true
  );

  -- 3. Seed Automático: 3 Mesas iniciais (Mesa 01, Mesa 02, Mesa 03)
  insert into public.restaurant_tables (id, restaurant_id, table_number, label, active, is_active)
  values
    (gen_random_uuid(), v_restaurant_id, 1, 'Mesa 01', true, true),
    (gen_random_uuid(), v_restaurant_id, 2, 'Mesa 02', true, true),
    (gen_random_uuid(), v_restaurant_id, 3, 'Mesa 03', true, true);

  -- 4. Seed Automático: 3 Categorias de exemplo
  v_cat_entradas_id := gen_random_uuid();
  v_cat_pratos_id := gen_random_uuid();
  v_cat_bebidas_id := gen_random_uuid();

  insert into public.menu_categories (id, restaurant_id, catalog_key, name, slug, sort_order, active)
  values
    (v_cat_entradas_id, v_restaurant_id, v_cat_entradas_id::text, 'Entradas & Porções', 'entradas-e-porcoes', 1, true),
    (v_cat_pratos_id, v_restaurant_id, v_cat_pratos_id::text, 'Pratos Principais', 'pratos-principais', 2, true),
    (v_cat_bebidas_id, v_restaurant_id, v_cat_bebidas_id::text, 'Bebidas', 'bebidas', 3, true);

  -- 5. Seed Automático: 5 Produtos de exemplo
  v_prod_id := gen_random_uuid();
  insert into public.menu_products (
    id, restaurant_id, category_id, catalog_key, slug, name,
    short_description, description, price_in_cents, available, featured,
    sort_order, prep_time_min_minutes, prep_time_max_minutes, preparation_station
  ) values (
    v_prod_id, v_restaurant_id, v_cat_entradas_id, v_prod_id::text, 'batata-rustica-da-casa',
    'Batata Rústica da Casa',
    'Porção crocante com alecrim, alho assado e maionese artesanal.',
    'Batatas selecionadas cortadas em gomos rústicos, temperadas com alecrim fresco, flor de sal e acompanhadas de maionese da casa.',
    3490, true, true, 1, 12, 18, 'kitchen'
  );

  v_prod_id := gen_random_uuid();
  insert into public.menu_products (
    id, restaurant_id, category_id, catalog_key, slug, name,
    short_description, description, price_in_cents, available, featured,
    sort_order, prep_time_min_minutes, prep_time_max_minutes, preparation_station
  ) values (
    v_prod_id, v_restaurant_id, v_cat_pratos_id, v_prod_id::text, 'hamburguer-artesanal-duplo',
    'Hambúrguer Artesanal Duplo',
    'Dois blends bovinos 160g, queijo cheddar inglês, bacon e pão brioche.',
    'Pão brioche selado na manteiga, dois hambúrgueres artesanais de costela, cheddar derretido, bacon crocante e molho especial.',
    4290, true, true, 1, 15, 25, 'kitchen'
  );

  v_prod_id := gen_random_uuid();
  insert into public.menu_products (
    id, restaurant_id, category_id, catalog_key, slug, name,
    short_description, description, price_in_cents, available, featured,
    sort_order, prep_time_min_minutes, prep_time_max_minutes, preparation_station
  ) values (
    v_prod_id, v_restaurant_id, v_cat_pratos_id, v_prod_id::text, 'file-a-parmegiana',
    'Filé à Parmegiana',
    'Filé mignon empanado com molho de tomates frescos, gratinado com muçarela.',
    'Clássico filé mignon empanado na hora, coberto com molho rústico de tomates italianos, queijo gratinado, arroz branco e fritas.',
    6890, true, true, 2, 20, 30, 'kitchen'
  );

  v_prod_id := gen_random_uuid();
  insert into public.menu_products (
    id, restaurant_id, category_id, catalog_key, slug, name,
    short_description, description, price_in_cents, available, featured,
    sort_order, prep_time_min_minutes, prep_time_max_minutes, preparation_station
  ) values (
    v_prod_id, v_restaurant_id, v_cat_bebidas_id, v_prod_id::text, 'refrigerante-lata-350ml',
    'Refrigerante Lata 350ml',
    'Lata 350ml servida trincando de gelada com copo e gelo.',
    'Opções disponíveis: Coca-Cola Original, Coca-Cola Sem Açúcar, Guaraná Antarctica original ou zero.',
    850, true, false, 1, 2, 5, 'bar'
  );

  v_prod_id := gen_random_uuid();
  insert into public.menu_products (
    id, restaurant_id, category_id, catalog_key, slug, name,
    short_description, description, price_in_cents, available, featured,
    sort_order, prep_time_min_minutes, prep_time_max_minutes, preparation_station
  ) values (
    v_prod_id, v_restaurant_id, v_cat_bebidas_id, v_prod_id::text, 'suco-natural-500ml',
    'Suco Natural 500ml',
    'Feito na hora com frutas frescas selecionadas (Laranja, Limão ou Abacaxi).',
    'Suco 100% natural preparado na hora, sem adição de conservantes. Servido em copo de 500ml.',
    1490, true, false, 2, 5, 8, 'bar'
  );

  return jsonb_build_object(
    'restaurant_id', v_restaurant_id,
    'slug', v_slug
  );
exception
  when unique_violation then
    raise exception using errcode = '22023', message = 'Este endereço (slug) já está em uso por outro restaurante';
end;
$$;

revoke all on function public.register_trial_restaurant_onboarding(text, text, text) from public, anon, authenticated;
grant execute on function public.register_trial_restaurant_onboarding(text, text, text) to authenticated;

-- ============================================================================
-- 4. RPC CANÔNICA DE PAGAMENTO: confirm_subscription_invoice_payment
--    - Assinatura oficial: (uuid, text, integer, uuid)
--    - Validações completas de segurança preservadas da Etapa 1
--    - Desativa subscription_is_trial ao confirmar pagamento
-- ============================================================================
create or replace function public.confirm_subscription_invoice_payment(
  p_invoice_id uuid,
  p_external_reference text,
  p_paid_amount_cents integer,
  p_restaurant_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ext_ref text;
  v_invoice public.subscription_invoices%rowtype;
  v_restaurant public.restaurants%rowtype;
  v_settings public.platform_settings%rowtype;
  v_cycle_days integer;
  v_max_tables integer;
  v_monthly_equiv_cents integer;
  v_new_expires_at timestamptz;
  v_audit_action text;
  v_actor_email text;
  v_previous_status text;
  v_now timestamptz := now();
begin
  perform public.assert_trusted_billing_server();

  if p_invoice_id is null then
    raise exception 'ID da fatura (p_invoice_id) é obrigatório.' using errcode = '22023';
  end if;
  if p_restaurant_id is null then
    raise exception 'ID do restaurante vinculado (p_restaurant_id) é obrigatório.' using errcode = '22023';
  end if;
  v_ext_ref := nullif(btrim(coalesce(p_external_reference, '')), '');
  if v_ext_ref is null then
    raise exception 'ID externo da cobrança no Asaas (p_external_reference) é obrigatório.' using errcode = '22023';
  end if;
  if p_paid_amount_cents is null or p_paid_amount_cents <= 0 then
    raise exception 'O valor pago confirmado pelo gateway (p_paid_amount_cents) é obrigatório.' using errcode = '22023';
  end if;

  select * into v_invoice from public.subscription_invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'Fatura não encontrada.' using errcode = 'P0002';
  end if;

  if v_invoice.restaurant_id <> p_restaurant_id then
    raise exception 'Divergência de segurança: a fatura informada não pertence ao restaurante vinculado.'
      using errcode = '42501';
  end if;

  if v_invoice.external_reference is null or btrim(v_invoice.external_reference) = '' then
    raise exception 'Divergência de segurança: a fatura não possui referência externa (external_reference) vinculada.'
      using errcode = '22023';
  end if;
  if btrim(v_invoice.external_reference) <> v_ext_ref then
    raise exception 'Divergência de segurança: o ID externo informado não corresponde à cobrança registrada na fatura.'
      using errcode = '22023';
  end if;

  if p_paid_amount_cents <> v_invoice.amount_cents then
    raise exception 'Divergência de valor: o valor confirmado (%) difere do valor da fatura (%).',
      p_paid_amount_cents, v_invoice.amount_cents using errcode = '22023';
  end if;

  if v_invoice.status = 'paid' then
    select * into v_restaurant from public.restaurants where id = v_invoice.restaurant_id;
    return jsonb_build_object(
      'success', true, 'invoice_id', v_invoice.id, 'status', 'paid', 'already_paid', true,
      'paid_at', v_invoice.paid_at, 'plan_id', v_invoice.plan_id,
      'billing_cycle', v_invoice.billing_cycle, 'amount_cents', v_invoice.amount_cents,
      'subscription_expires_at', v_restaurant.subscription_expires_at,
      'subscription_is_trial', false,
      'max_tables', v_restaurant.max_tables
    );
  end if;

  if v_invoice.status not in ('pending', 'expired', 'failed') then
    raise exception 'A fatura não pode ser confirmada no estado atual: %.', v_invoice.status
      using errcode = '22023';
  end if;
  v_previous_status := v_invoice.status;

  select * into v_restaurant from public.restaurants where id = v_invoice.restaurant_id for update;
  if not found then
    raise exception 'Restaurante vinculado à fatura não encontrado.' using errcode = 'P0002';
  end if;

  select * into v_settings from public.platform_settings where id = 'default';
  if not found then
    raise exception 'Configurações de catálogo de planos (platform_settings id=default) não encontradas.'
      using errcode = 'P0002';
  end if;

  if v_invoice.plan_id = 'basic' then
    v_monthly_equiv_cents := v_settings.basic_price_cents;
    v_max_tables := v_settings.basic_max_tables;
  elsif v_invoice.plan_id = 'pro' then
    v_monthly_equiv_cents := v_settings.pro_price_cents;
    v_max_tables := v_settings.pro_max_tables;
  elsif v_invoice.plan_id = 'premium' then
    v_monthly_equiv_cents := v_settings.premium_price_cents;
    v_max_tables := v_settings.premium_max_tables;
  else
    raise exception 'Plano inválido na fatura: %', v_invoice.plan_id using errcode = '22023';
  end if;

  if v_monthly_equiv_cents is null or v_monthly_equiv_cents <= 0
     or v_max_tables is null or v_max_tables <= 0 then
    raise exception 'Catálogo de planos em platform_settings inválido para o plano %.', v_invoice.plan_id
      using errcode = '22023';
  end if;

  v_cycle_days := case when v_invoice.billing_cycle = 'yearly' then 365 else 30 end;

  if v_restaurant.subscription_expires_at is not null and v_restaurant.subscription_expires_at > v_now then
    v_new_expires_at := v_restaurant.subscription_expires_at + (v_cycle_days || ' days')::interval;
  else
    v_new_expires_at := v_now + (v_cycle_days || ' days')::interval;
  end if;

  update public.subscription_invoices
  set status = 'paid', paid_at = v_now, external_reference = v_ext_ref,
      gateway_emission_status = 'issued'
  where id = v_invoice.id;

  -- Converte subscription_is_trial para false
  update public.restaurants
  set subscription_plan = v_invoice.plan_id,
      subscription_expires_at = v_new_expires_at,
      billing_cycle_days = v_cycle_days,
      max_tables = v_max_tables,
      monthly_price_cents = v_monthly_equiv_cents,
      active = true,
      subscription_is_trial = false
  where id = v_invoice.restaurant_id;

  v_audit_action := case
    when v_invoice.plan_id <> v_restaurant.subscription_plan then 'plan_changed'
    else 'cycle_renewed'
  end;

  if v_invoice.created_by is not null then
    select u.email into v_actor_email from auth.users as u where u.id = v_invoice.created_by;
  end if;

  insert into public.platform_audit_logs (
    action, target_restaurant_id, target_restaurant_name, actor_email, details
  ) values (
    v_audit_action, v_restaurant.id, v_restaurant.name,
    coalesce(v_actor_email, 'asaas_verified_server'),
    jsonb_build_object(
      'invoice_id', v_invoice.id,
      'plan_id', v_invoice.plan_id,
      'billing_cycle', v_invoice.billing_cycle,
      'amount_cents', v_invoice.amount_cents,
      'payment_method', v_invoice.payment_method,
      'external_reference', v_ext_ref,
      'previous_invoice_status', v_previous_status,
      'previous_is_trial', coalesce(v_restaurant.subscription_is_trial, false),
      'new_is_trial', false,
      'new_expires_at', v_new_expires_at
    )
  );

  return jsonb_build_object(
    'success', true, 'invoice_id', v_invoice.id, 'status', 'paid', 'already_paid', false,
    'late_confirmation', v_previous_status <> 'pending',
    'paid_at', v_now, 'plan_id', v_invoice.plan_id, 'billing_cycle', v_invoice.billing_cycle,
    'amount_cents', v_invoice.amount_cents, 'subscription_expires_at', v_new_expires_at,
    'subscription_is_trial', false,
    'max_tables', v_max_tables
  );
end;
$$;

revoke all on function public.confirm_subscription_invoice_payment(uuid, text, integer, uuid) from public, anon, authenticated;
grant execute on function public.confirm_subscription_invoice_payment(uuid, text, integer, uuid) to service_role;

-- ============================================================================
-- 5. ATUALIZAÇÃO DA RPC update_restaurant_saas_plan (SUPERADMIN)
-- ============================================================================
create or replace function public.update_restaurant_saas_plan(
  p_restaurant_id uuid,
  p_plan text,
  p_monthly_price_cents integer default null,
  p_max_tables integer default null,
  p_billing_cycle_days integer default null,
  p_renew_cycle boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller text;
  v_old record;
  v_updated record;
  v_plan text;
  v_price integer;
  v_max_tables integer;
  v_cycle_days integer;
  v_default_price integer;
  v_default_max_tables integer;
  v_started_at timestamptz;
  v_expires_at timestamptz;
  v_actor_email text;
begin
  v_caller := coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'none');
  if v_caller not in ('service_role') and not public.is_platform_admin() then
    raise exception 'Apenas administradores da plataforma podem alterar planos e limites.' using errcode = '42501';
  end if;

  v_plan := lower(trim(coalesce(p_plan, '')));
  if v_plan not in ('basic', 'pro', 'premium') then
    raise exception 'Plano inválido. Escolha entre basic, pro ou premium.' using errcode = '22023';
  end if;

  select
    r.id,
    r.name,
    r.slug,
    r.subscription_plan,
    r.monthly_price_cents,
    r.max_tables,
    r.billing_cycle_days,
    r.subscription_started_at,
    r.subscription_expires_at,
    r.subscription_is_trial
  into v_old
  from public.restaurants as r
  where r.id = p_restaurant_id;

  if not found then
    raise exception 'Restaurante não encontrado.' using errcode = '22023';
  end if;

  if v_plan = 'basic' then
    select basic_price_cents, basic_max_tables into v_default_price, v_default_max_tables
    from public.platform_settings where id = 'default';
  elsif v_plan = 'pro' then
    select pro_price_cents, pro_max_tables into v_default_price, v_default_max_tables
    from public.platform_settings where id = 'default';
  else
    select premium_price_cents, premium_max_tables into v_default_price, v_default_max_tables
    from public.platform_settings where id = 'default';
  end if;

  if p_monthly_price_cents is not null then
    if p_monthly_price_cents < 0 then
      raise exception 'Preço mensal não pode ser negativo.' using errcode = '22023';
    end if;
    v_price := p_monthly_price_cents;
  else
    v_price := v_default_price;
  end if;

  if p_max_tables is not null then
    if p_max_tables not between 1 and 500 then
      raise exception 'Limite de mesas deve ser entre 1 e 500.' using errcode = '22023';
    end if;
    v_max_tables := p_max_tables;
  else
    v_max_tables := v_default_max_tables;
  end if;

  v_cycle_days := coalesce(p_billing_cycle_days, v_old.billing_cycle_days, 30);
  if v_cycle_days not between 1 and 365 then
    raise exception 'Ciclo de cobrança deve ser entre 1 e 365 dias.' using errcode = '22023';
  end if;

  if p_renew_cycle is true or p_billing_cycle_days is not null then
    v_started_at := now();
    v_expires_at := now() + (v_cycle_days || ' days')::interval;
  else
    v_started_at := coalesce(v_old.subscription_started_at, now());
    v_expires_at := coalesce(v_old.subscription_expires_at, now() + (v_cycle_days || ' days')::interval);
  end if;

  update public.restaurants
  set
    subscription_plan = v_plan,
    monthly_price_cents = v_price,
    max_tables = v_max_tables,
    billing_cycle_days = v_cycle_days,
    subscription_started_at = v_started_at,
    subscription_expires_at = v_expires_at,
    subscription_is_trial = false
  where id = p_restaurant_id
  returning
    id,
    name,
    slug,
    subscription_plan,
    monthly_price_cents,
    max_tables,
    billing_cycle_days,
    subscription_started_at,
    subscription_expires_at,
    subscription_is_trial
  into v_updated;

  perform public.sync_restaurant_tables_to_plan_limit(p_restaurant_id);

  v_actor_email := coalesce(nullif(current_setting('request.jwt.claim.email', true), ''), 'superadmin');

  insert into public.platform_audit_logs (
    action,
    target_restaurant_id,
    target_restaurant_name,
    actor_email,
    details
  ) values (
    case
      when p_renew_cycle is true and v_plan = v_old.subscription_plan then 'cycle_renewed'
      else 'plan_changed'
    end,
    p_restaurant_id,
    v_updated.name,
    v_actor_email,
    jsonb_build_object(
      'previousPlan', v_old.subscription_plan,
      'newPlan', v_updated.subscription_plan,
      'old_plan', v_old.subscription_plan,
      'new_plan', v_updated.subscription_plan,
      'previousPriceCents', v_old.monthly_price_cents,
      'newPriceCents', v_updated.monthly_price_cents,
      'previousMaxTables', v_old.max_tables,
      'newMaxTables', v_updated.max_tables,
      'billingCycleDays', v_updated.billing_cycle_days,
      'renewCycle', coalesce(p_renew_cycle, false),
      'subscriptionIsTrial', false
    )
  );

  return jsonb_build_object(
    'id', v_updated.id,
    'name', v_updated.name,
    'slug', v_updated.slug,
    'subscriptionPlan', v_updated.subscription_plan,
    'subscription_plan', v_updated.subscription_plan,
    'monthlyPriceCents', v_updated.monthly_price_cents,
    'monthly_price_cents', v_updated.monthly_price_cents,
    'maxTables', v_updated.max_tables,
    'max_tables', v_updated.max_tables,
    'billingCycleDays', v_updated.billing_cycle_days,
    'billing_cycle_days', v_updated.billing_cycle_days,
    'subscriptionStartedAt', v_updated.subscription_started_at,
    'subscription_started_at', v_updated.subscription_started_at,
    'subscriptionExpiresAt', v_updated.subscription_expires_at,
    'subscription_expires_at', v_updated.subscription_expires_at,
    'subscriptionIsTrial', v_updated.subscription_is_trial,
    'subscription_is_trial', v_updated.subscription_is_trial,
    'billingStatus', public.get_restaurant_billing_status(v_updated.subscription_expires_at, v_updated.subscription_is_trial),
    'billing_status', public.get_restaurant_billing_status(v_updated.subscription_expires_at, v_updated.subscription_is_trial)
  );
end;
$$;

revoke all on function public.update_restaurant_saas_plan(uuid, text, integer, integer, integer, boolean) from public, anon;
grant execute on function public.update_restaurant_saas_plan(uuid, text, integer, integer, integer, boolean) to authenticated;

-- ============================================================================
-- 6. ATUALIZAÇÃO DAS OPERAÇÕES DEPENDENTES DE STATUS SAAS
-- ============================================================================

-- 6.1 open_table_visit (Abertura de atendimento na mesa)
create or replace function public.open_table_visit(
  p_restaurant_slug text,
  p_table_number integer
)
returns public.table_visits
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid;
  target_restaurant_id uuid;
  target_member_id uuid;
  target_table_id uuid;
  target_visit public.table_visits%rowtype;
  v_max_tables integer;
  v_subscription_expires_at timestamptz;
  v_is_trial boolean;
  v_billing_status text;
begin
  current_user_id := auth.uid();

  if p_restaurant_slug is null or trim(p_restaurant_slug) = '' then
    raise exception using
      errcode = '42501',
      message = 'Identificador do restaurante não informado.';
  end if;

  if p_table_number is null or p_table_number < 1 then
    raise exception using
      errcode = '22023',
      message = 'Número de mesa inválido.';
  end if;

  select
    restaurant.id,
    coalesce(restaurant.max_tables, 10),
    restaurant.subscription_expires_at,
    coalesce(restaurant.subscription_is_trial, false)
  into
    target_restaurant_id,
    v_max_tables,
    v_subscription_expires_at,
    v_is_trial
  from public.restaurants as restaurant
  where restaurant.slug = p_restaurant_slug
    and restaurant.active = true
  for share;

  if target_restaurant_id is null then
    raise exception using
      errcode = '42501',
      message = 'Restaurante indisponível.';
  end if;

  -- Validação estrita de vigência
  v_billing_status := public.get_restaurant_billing_status(v_subscription_expires_at, v_is_trial);
  if v_billing_status = 'expired' then
    if v_is_trial is true then
      raise exception using
        errcode = 'P0001',
        message = 'O período de teste gratuito de 7 dias deste restaurante expirou. Assine um plano para continuar atendendo.';
    else
      raise exception using
        errcode = 'P0001',
        message = 'A assinatura deste estabelecimento está suspensa por expiração do ciclo. Entre em contato com a administração da plataforma para regularização.';
    end if;
  end if;

  if v_max_tables is null then
    v_max_tables := 10;
  end if;

  if p_table_number > v_max_tables then
    raise exception using
      errcode = 'P0001',
      message = 'Mesa indisponível no plano atual do restaurante.';
  end if;

  select member.id
  into target_member_id
  from public.restaurant_members as member
  where member.restaurant_id = target_restaurant_id
    and member.user_id = current_user_id
    and member.active = true
    and member.role in ('admin', 'waiter')
  for share;

  if target_member_id is null then
    raise exception using
      errcode = '42501',
      message = 'Sua conta não possui acesso ativo a este restaurante.';
  end if;

  select restaurant_table.id
  into target_table_id
  from public.restaurant_tables as restaurant_table
  where restaurant_table.restaurant_id = target_restaurant_id
    and restaurant_table.table_number = p_table_number
    and (restaurant_table.active = true and restaurant_table.is_active = true)
    and restaurant_table.deleted_at is null
  for update;

  if target_table_id is null then
    raise exception using
      errcode = '22023',
      message = 'Mesa inexistente ou indisponível.';
  end if;

  select visit.*
  into target_visit
  from public.table_visits as visit
  where visit.restaurant_table_id = target_table_id
    and visit.status = 'open'
  for update;

  if found then
    if target_visit.assigned_member_id is null then
      update public.table_visits
      set assigned_member_id = target_member_id
      where id = target_visit.id
      returning * into target_visit;

    elsif target_visit.assigned_member_id <> target_member_id then
      raise exception using
        errcode = '22023',
        message = 'A mesa já possui atendimento atribuído a outro colaborador.';
    end if;

    return target_visit;
  end if;

  insert into public.table_visits (
    restaurant_id,
    restaurant_table_id,
    assigned_member_id,
    status
  ) values (
    target_restaurant_id,
    target_table_id,
    target_member_id,
    'open'
  )
  returning * into target_visit;

  return target_visit;
end;
$$;

revoke all on function public.open_table_visit(text, integer) from public, anon;
grant execute on function public.open_table_visit(text, integer) to authenticated;

-- 6.2 create_direct_table_order (Criação de pedidos diretos)
create or replace function public.create_direct_table_order(
  p_table_id uuid,
  p_product_id uuid,
  p_quantity integer default 1
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_table record;
  target_rest record;
  target_prod record;
  target_visit record;
  target_tab record;
  v_item_id uuid;
  v_inv_qty numeric;
  v_station text;
  v_prod_status text;
  v_delivered_at timestamptz;
  v_billing_status text;
begin
  if p_quantity is null or p_quantity < 1 or p_quantity > 99 then
    raise exception using errcode = '22023', message = 'Quantidade inválida. Escolha entre 1 e 99.';
  end if;

  -- 1. Validar e bloquear mesa e restaurante
  select * into target_table
  from public.restaurant_tables
  where id = p_table_id
    and coalesce(is_active, active, true) = true
    and deleted_at is null;

  if not found then
    raise exception using errcode = '22023', message = 'Mesa não identificada ou inativa.';
  end if;

  select * into target_rest
  from public.restaurants
  where id = target_table.restaurant_id
    and active = true;

  if not found then
    raise exception using errcode = '22023', message = 'Restaurante temporariamente indisponível.';
  end if;

  -- Validação estrita de vigência (com flag subscription_is_trial)
  v_billing_status := public.get_restaurant_billing_status(
    target_rest.subscription_expires_at,
    coalesce(target_rest.subscription_is_trial, false)
  );

  if v_billing_status = 'expired' then
    if target_rest.subscription_is_trial is true then
      raise exception using errcode = '42501',
        message = 'O período de teste gratuito deste restaurante expirou. Pedidos temporariamente suspensos.';
    else
      raise exception using errcode = '42501',
        message = 'Atendimento suspenso temporariamente no restaurante por expiração do plano.';
    end if;
  end if;

  -- 2. Validar produto
  select * into target_prod
  from public.menu_products
  where id = p_product_id
    and restaurant_id = target_rest.id
    and available = true;

  if not found then
    raise exception using errcode = '22023', message = 'Produto temporariamente indisponível.';
  end if;

  -- 3. Validação e Baixa Atômica de Estoque
  if target_prod.inventory_item_id is not null then
    select current_quantity into v_inv_qty
    from public.inventory_items
    where id = target_prod.inventory_item_id
    for update;

    if v_inv_qty is null or v_inv_qty < p_quantity then
      raise exception using errcode = '22023', message = 'ITEM_OUT_OF_STOCK: Produto esgotado no estoque.';
    end if;

    update public.inventory_items
    set current_quantity = current_quantity - p_quantity
    where id = target_prod.inventory_item_id;
  end if;

  -- 4. Localizar ou Inicializar Atendimento (table_visit) da Mesa
  select * into target_visit
  from public.table_visits
  where restaurant_table_id = p_table_id
    and status = 'open'
  order by opened_at desc
  limit 1
  for update;

  if not found then
    insert into public.table_visits (restaurant_id, restaurant_table_id, status)
    values (target_rest.id, p_table_id, 'open')
    returning * into target_visit;
  end if;

  -- 5. Localizar ou Inicializar Comanda (table_tab) da Mesa
  select * into target_tab
  from public.table_tabs
  where table_visit_id = target_visit.id
    and status = 'open'
  order by created_at asc
  limit 1
  for update;

  if not found then
    insert into public.table_tabs (
      restaurant_id, restaurant_table_id, table_visit_id, label, status
    ) values (
      target_rest.id, p_table_id, target_visit.id, 'Mesa ' || lpad(target_table.table_number::text, 2, '0'), 'open'
    ) returning * into target_tab;
  end if;

  -- 6. Configurar Esteira KDS
  v_station := coalesce(target_prod.preparation_station, 'kitchen');
  if v_station = 'none' then
    v_prod_status := 'delivered';
    v_delivered_at := now();
  else
    v_prod_status := 'pending';
    v_delivered_at := null;
  end if;

  -- 7. Inserir Item de Consumo
  v_item_id := gen_random_uuid();
  insert into public.table_tab_items (
    id, restaurant_id, restaurant_table_id, table_visit_id, table_tab_id,
    product_id, product_name, unit_price_in_cents, quantity, status,
    preparation_station, production_status, created_at, prep_delivered_at,
    added_by_member_id
  ) values (
    v_item_id, target_rest.id, p_table_id, target_visit.id, target_tab.id,
    target_prod.id, target_prod.name, target_prod.price_in_cents, p_quantity, 'active',
    v_station, v_prod_status, now(), v_delivered_at,
    target_visit.assigned_member_id
  );

  return jsonb_build_object(
    'success', true,
    'itemId', v_item_id,
    'tableTabId', target_tab.id,
    'tableVisitId', target_visit.id,
    'tableNumber', target_table.table_number,
    'productName', target_prod.name,
    'quantity', p_quantity,
    'unitPriceInCents', target_prod.price_in_cents,
    'productionStatus', v_prod_status,
    'preparationStation', v_station
  );
end;
$$;

revoke all on function public.create_direct_table_order(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.create_direct_table_order(uuid, uuid, integer) to anon, authenticated;

-- 6.3 request_table_assistance (Chamados de garçom e conta na mesa)
create or replace function public.request_table_assistance(
  p_table_id uuid,
  p_request_type text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table record;
  v_rest record;
  v_alert_id uuid;
  v_msg text;
  v_title text;
  v_billing_status text;
begin
  if p_request_type not in ('waiter', 'bill', 'call_waiter', 'close_table_request') then
    raise exception using errcode = '22023', message = 'Tipo de solicitação inválido.';
  end if;

  select * into v_table
  from public.restaurant_tables
  where id = p_table_id
    and coalesce(is_active, active, true) = true
    and deleted_at is null;

  if not found then
    raise exception using errcode = '22023', message = 'Mesa não encontrada ou inativa.';
  end if;

  select * into v_rest
  from public.restaurants
  where id = v_table.restaurant_id
    and active = true;

  if not found then
    raise exception using errcode = '22023', message = 'Restaurante indisponível.';
  end if;

  -- Validação estrita de vigência (com flag subscription_is_trial)
  v_billing_status := public.get_restaurant_billing_status(
    v_rest.subscription_expires_at,
    coalesce(v_rest.subscription_is_trial, false)
  );

  if v_billing_status = 'expired' then
    if v_rest.subscription_is_trial is true then
      raise exception using errcode = '42501',
        message = 'O período de teste gratuito deste restaurante expirou. Chamados suspensos.';
    else
      raise exception using errcode = '42501',
        message = 'Atendimento suspenso no restaurante por expiração da assinatura.';
    end if;
  end if;

  declare
    v_alert_db_type text;
  begin
    if p_request_type in ('waiter', 'call_waiter') then
      v_alert_db_type := 'call_waiter';
      v_title := 'Mesa ' || lpad(v_table.table_number::text, 2, '0') || ' solicita atendimento';
      v_msg := 'Cliente na mesa ' || coalesce(v_table.label, 'Mesa ' || v_table.table_number) || ' chamou a equipe.';
    else
      v_alert_db_type := 'close_table_request';
      v_title := 'Mesa ' || lpad(v_table.table_number::text, 2, '0') || ' solicitou encerramento';
      v_msg := 'Cliente na mesa ' || coalesce(v_table.label, 'Mesa ' || v_table.table_number) || ' pediu a conta / encerramento do consumo.';
    end if;

    -- Trava anti-spam de 3 minutos para chamados não atendidos do mesmo tipo na mesma mesa
    if exists (
      select 1
      from public.restaurant_alerts
      where restaurant_id = v_rest.id
        and reference_id = p_table_id
        and type = v_alert_db_type
        and is_read = false
        and created_at >= now() - interval '3 minutes'
    ) then
      return jsonb_build_object(
        'success', true,
        'throttled', true,
        'message', 'Chamado já registrado recentemente. A equipe foi notificada.'
      );
    end if;

    v_alert_id := gen_random_uuid();
    insert into public.restaurant_alerts (
      id,
      restaurant_id,
      type,
      title,
      message,
      reference_id,
      is_read,
      created_at
    ) values (
      v_alert_id,
      v_rest.id,
      v_alert_db_type,
      v_title,
      v_msg,
      p_table_id,
      false,
      now()
    );

    return jsonb_build_object(
      'success', true,
      'throttled', false,
      'alertId', v_alert_id,
      'alert_id', v_alert_id,
      'message', 'Solicitação enviada com sucesso!'
    );
  end;
end;
$$;

revoke all on function public.request_table_assistance(uuid, text) from public, anon, authenticated;
grant execute on function public.request_table_assistance(uuid, text) to anon, authenticated;

-- ============================================================================
-- 7. ATUALIZAÇÃO DA RPC get_public_restaurant
-- ============================================================================
create or replace function public.get_public_restaurant(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', r.id,
    'slug', r.slug,
    'name', r.name,
    'subtitle', coalesce(r.subtitle, ''),
    'logo', r.logo,
    'cover', r.cover,
    'dashboard_logo_url', r.dashboard_logo_url,
    'dashboard_banner_url', r.dashboard_banner_url,
    'dashboardLogoUrl', r.dashboard_logo_url,
    'dashboardBannerUrl', r.dashboard_banner_url,
    'theme', jsonb_build_object(
      'primary', coalesce(r.brand_primary_color, r.theme_primary, '#ea580c'),
      'background', r.theme_background,
      'text', r.theme_text
    ),
    'brandPrimaryColor', coalesce(r.brand_primary_color, r.theme_primary, '#ea580c'),
    'brand_primary_color', coalesce(r.brand_primary_color, r.theme_primary, '#ea580c'),
    'headerNameColor', coalesce(r.header_name_color, '#1c1917'),
    'header_name_color', coalesce(r.header_name_color, '#1c1917'),
    'headerSubtitleColor', coalesce(r.header_subtitle_color, '#57534e'),
    'header_subtitle_color', coalesce(r.header_subtitle_color, '#57534e'),
    'menuTheme', coalesce(r.menu_theme, 'classic'),
    'menu_theme', coalesce(r.menu_theme, 'classic'),
    'description', r.description,
    'address', r.address,
    'phone', r.phone,
    'openingHours', r.opening_hours,
    'revision', r.revision,
    'serviceFeePercent', r.service_fee_percent,
    'timezone', r.timezone,
    'googleReviewUrl', r.google_review_url,
    'subscriptionPlan', r.subscription_plan,
    'subscription_plan', r.subscription_plan,
    'maxTables', coalesce(r.max_tables, 10),
    'max_tables', coalesce(r.max_tables, 10),
    'subscriptionExpiresAt', r.subscription_expires_at,
    'subscription_expires_at', r.subscription_expires_at,
    'subscriptionIsTrial', coalesce(r.subscription_is_trial, false),
    'subscription_is_trial', coalesce(r.subscription_is_trial, false),
    'billingStatus', public.get_restaurant_billing_status(r.subscription_expires_at, r.subscription_is_trial),
    'billing_status', public.get_restaurant_billing_status(r.subscription_expires_at, r.subscription_is_trial)
  )
  from public.restaurants as r
  where r.slug = p_slug
    and r.active = true;
$$;

revoke all on function public.get_public_restaurant(text) from public;
grant execute on function public.get_public_restaurant(text) to anon, authenticated;

-- ============================================================================
-- 8. ATUALIZAÇÃO DA RPC get_public_table_by_id
-- ============================================================================
create or replace function public.get_public_table_by_id(p_table_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', t.id,
    'restaurantId', t.restaurant_id,
    'tableNumber', t.table_number,
    'label', t.label,
    'active', coalesce(t.is_active, t.active, true),
    'deletedAt', t.deleted_at,
    'restaurantSlug', r.slug,
    'restaurantBillingStatus', public.get_restaurant_billing_status(r.subscription_expires_at, r.subscription_is_trial),
    'restaurantSubscriptionIsTrial', coalesce(r.subscription_is_trial, false)
  )
  from public.restaurant_tables as t
  join public.restaurants as r on r.id = t.restaurant_id
  where t.id = p_table_id
    and t.deleted_at is null
    and coalesce(t.is_active, t.active, true) = true
    and r.active = true;
$$;

revoke all on function public.get_public_table_by_id(uuid) from public;
grant execute on function public.get_public_table_by_id(uuid) to anon, authenticated;

-- ============================================================================
-- 9. ATUALIZAÇÃO DA RPC get_restaurant_billing_summary
-- ============================================================================
create or replace function public.get_restaurant_billing_summary(p_restaurant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_restaurant record;
  v_settings record;
  v_tables_count integer;
  v_products_count integer;
  v_invoices jsonb;
  v_methods jsonb;
begin
  if not (
    public.is_platform_admin() or
    exists (
      select 1 from public.restaurant_members as m
      where m.restaurant_id = p_restaurant_id
        and m.user_id = auth.uid()
        and m.role = 'admin'
        and m.active = true
    )
  ) then
    raise exception 'Apenas administradores do restaurante ou da plataforma podem consultar o faturamento.'
      using errcode = '42501';
  end if;

  select * into v_restaurant
  from public.restaurants
  where id = p_restaurant_id;

  if not found then
    raise exception 'Restaurante não encontrado.' using errcode = 'P0002';
  end if;

  select * into v_settings from public.platform_settings where id = 'default';
  if not found then
    raise exception 'Configurações de catálogo de planos (platform_settings id=default) não encontradas.'
      using errcode = 'P0002';
  end if;

  select count(*) into v_tables_count
  from public.restaurant_tables
  where restaurant_id = p_restaurant_id and deleted_at is null and coalesce(is_active, active, true) = true;

  select count(*) into v_products_count
  from public.menu_products
  where restaurant_id = p_restaurant_id and available = true;

  select coalesce(jsonb_agg(inv_row), '[]'::jsonb)
  into v_invoices
  from (
    select
      i.id,
      i.amount_cents,
      i.currency,
      i.status,
      i.billing_cycle,
      i.plan_id,
      i.payment_method,
      i.due_date,
      i.paid_at,
      i.created_at,
      i.pix_qr_code,
      i.pix_copy_paste,
      i.invoice_url
    from public.subscription_invoices as i
    where i.restaurant_id = p_restaurant_id
    order by i.created_at desc
    limit 24
  ) as inv_row;

  select coalesce(jsonb_agg(pm_row), '[]'::jsonb)
  into v_methods
  from (
    select
      pm.id,
      pm.method_type,
      pm.holder_name,
      pm.card_brand,
      pm.card_last4,
      pm.exp_month,
      pm.exp_year,
      pm.is_default,
      pm.created_at
    from public.restaurant_payment_methods as pm
    where pm.restaurant_id = p_restaurant_id
    order by pm.created_at desc
  ) as pm_row;

  return jsonb_build_object(
    'restaurant', jsonb_build_object(
      'id', v_restaurant.id,
      'name', v_restaurant.name,
      'slug', v_restaurant.slug,
      'subscription_plan', v_restaurant.subscription_plan,
      'subscription_started_at', v_restaurant.subscription_started_at,
      'subscription_expires_at', v_restaurant.subscription_expires_at,
      'billing_cycle_days', v_restaurant.billing_cycle_days,
      'max_tables', v_restaurant.max_tables,
      'monthly_price_cents', v_restaurant.monthly_price_cents,
      'active', v_restaurant.active,
      'subscription_is_trial', coalesce(v_restaurant.subscription_is_trial, false),
      'billing_status', public.get_restaurant_billing_status(v_restaurant.subscription_expires_at, v_restaurant.subscription_is_trial),
      'days_remaining', ceil(extract(epoch from (v_restaurant.subscription_expires_at - now())) / 86400.0)::int
    ),
    'usage', jsonb_build_object(
      'tables_count', v_tables_count,
      'products_count', v_products_count
    ),
    'catalog', jsonb_build_object(
      'basic', jsonb_build_object(
        'plan_id', 'basic',
        'name', 'Plano Básico',
        'monthly_price_cents', v_settings.basic_price_cents,
        'yearly_price_cents', v_settings.basic_price_cents * 10,
        'max_tables', v_settings.basic_max_tables,
        'features', jsonb_build_array('Cardápio Digital com QR Code', 'Pedidos em tempo real nas mesas', 'Até 10 mesas simultâneas', 'Suporte padrão via e-mail')
      ),
      'pro', jsonb_build_object(
        'plan_id', 'pro',
        'name', 'Plano Profissional',
        'monthly_price_cents', v_settings.pro_price_cents,
        'yearly_price_cents', v_settings.pro_price_cents * 10,
        'max_tables', v_settings.pro_max_tables,
        'features', jsonb_build_array('Tudo do Básico', 'KDS Completo (Cozinha e Bar)', 'Gestão de Estoque e Insumos', 'Até 25 mesas simultâneas', 'Alertas sonoros para garçons')
      ),
      'premium', jsonb_build_object(
        'plan_id', 'premium',
        'name', 'Plano Premium Executivo',
        'monthly_price_cents', v_settings.premium_price_cents,
        'yearly_price_cents', v_settings.premium_price_cents * 10,
        'max_tables', v_settings.premium_max_tables,
        'features', jsonb_build_array('Tudo do Profissional', 'Painel Executivo Multi-filiais', 'Exportações Contábeis e DRE', 'Mesas ilimitadas (até 60)', 'Gerente de Contas Dedicado')
      )
    ),
    'invoices', v_invoices,
    'payment_methods', v_methods
  );
end;
$$;

revoke all on function public.get_restaurant_billing_summary(uuid) from public, anon;
grant execute on function public.get_restaurant_billing_summary(uuid) to authenticated;

-- ============================================================================
-- 10. ATUALIZAÇÃO DA RPC list_platform_restaurants
-- ============================================================================
create or replace function public.list_platform_restaurants()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  is_admin boolean;
begin
  select exists (
    select 1
    from public.platform_admins as admin
    where admin.user_id = auth.uid()
      and admin.active = true
  )
  into is_admin;

  if not is_admin then
    raise exception using
      errcode = '42501',
      message = 'Apenas administradores da plataforma podem listar todos os restaurantes.';
  end if;

  return coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', restaurant.id,
          'name', restaurant.name,
          'slug', restaurant.slug,
          'active', restaurant.active,
          'archived', not restaurant.active,
          'logo_url', restaurant.logo_url,
          'cover_url', restaurant.cover_url,
          'created_at', restaurant.created_at,
          'updated_at', restaurant.updated_at,
          'subscriptionPlan', restaurant.subscription_plan,
          'subscription_plan', restaurant.subscription_plan,
          'maxTables', coalesce(restaurant.max_tables, 10),
          'max_tables', coalesce(restaurant.max_tables, 10),
          'monthlyPriceCents', coalesce(restaurant.monthly_price_cents, 4900),
          'monthly_price_cents', coalesce(restaurant.monthly_price_cents, 4900),
          'activeTablesCount', (
            select count(*)
            from public.restaurant_tables as t
            where t.restaurant_id = restaurant.id
              and t.deleted_at is null
              and (t.active = true or t.is_active = true)
          ),
          'active_tables_count', (
            select count(*)
            from public.restaurant_tables as t
            where t.restaurant_id = restaurant.id
              and t.deleted_at is null
              and (t.active = true or t.is_active = true)
          ),
          'subscriptionStartedAt', restaurant.subscription_started_at,
          'subscription_started_at', restaurant.subscription_started_at,
          'subscriptionExpiresAt', restaurant.subscription_expires_at,
          'subscription_expires_at', restaurant.subscription_expires_at,
          'subscriptionIsTrial', coalesce(restaurant.subscription_is_trial, false),
          'subscription_is_trial', coalesce(restaurant.subscription_is_trial, false),
          'billingCycleDays', restaurant.billing_cycle_days,
          'billing_cycle_days', restaurant.billing_cycle_days,
          'daysRemaining', ceil(extract(epoch from (restaurant.subscription_expires_at - now())) / 86400.0)::int,
          'days_remaining', ceil(extract(epoch from (restaurant.subscription_expires_at - now())) / 86400.0)::int,
          'billingStatus', public.get_restaurant_billing_status(restaurant.subscription_expires_at, restaurant.subscription_is_trial),
          'billing_status', public.get_restaurant_billing_status(restaurant.subscription_expires_at, restaurant.subscription_is_trial)
        )
        order by restaurant.created_at desc, restaurant.id
      )
      from public.restaurants as restaurant
    ),
    '[]'::jsonb
  );
end;
$$;

revoke all on function public.list_platform_restaurants() from public, anon;
grant execute on function public.list_platform_restaurants() to authenticated;

commit;

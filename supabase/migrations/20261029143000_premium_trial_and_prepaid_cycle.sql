begin;
alter table subscription_quote_private.trial_terms add column evidence_source text;
alter table subscription_quote_private.cycles add column evidence_source text;
-- No historical backfill. Only newly captured authoritative terms activate this feature.
create function subscription_quote_private.effective_subscription(p_id uuid,p_at timestamptz default statement_timestamp()) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare r public.restaurants; t subscription_quote_private.trial_terms; c subscription_quote_private.cycles; trial_active boolean; known boolean; plan text; expiry timestamptz; status text; lim integer; unlim boolean; begin
 select * into r from public.restaurants where id=p_id;
 if not found then return null; end if;
 select * into t from subscription_quote_private.trial_terms where restaurant_id=p_id and evidence_source='onboarding_premium_168h' and original_end-original_start=interval '168 hours';
 known:=found;
 if not known then
  return jsonb_build_object('known_trial',false,'trial_active',false,'plan',r.subscription_plan,'max_tables',r.max_tables,'unlimited_tables',r.unlimited_tables,'expires_at',r.subscription_expires_at,'is_trial',r.subscription_is_trial,'billing_status',public.get_restaurant_billing_status(r.subscription_expires_at,r.subscription_is_trial));
 end if;
 select cy.* into c from subscription_quote_private.cycles cy join subscription_quote_private.cycle_payments cp on cp.cycle_id=cy.id join public.subscription_invoices i on i.id=cp.invoice_id
 where cy.restaurant_id=p_id and cy.evidence_source='trial_purchase_v1' and cy.starts_at>=t.original_end and i.restaurant_id=p_id and i.status='paid' and i.paid_at is not null and i.plan_id=cy.plan_id and i.billing_cycle=cy.billing_cycle and cp.confirmed_credit_cents=cy.contracted_price_cents and i.amount_cents=cy.contracted_price_cents order by case when p_at>=cy.starts_at and p_at<cy.ends_at then 0 when p_at<cy.starts_at then 1 else 2 end, case when p_at<cy.starts_at then cy.starts_at end asc, cy.starts_at desc limit 1;
 trial_active:=p_at>=t.original_start and p_at<t.original_end;
 plan:=case when trial_active then 'premium' when c.starts_at<=p_at then c.plan_id else 'basic' end;
 expiry:=coalesce((select max(cy.ends_at) from subscription_quote_private.cycles cy join subscription_quote_private.cycle_payments cp on cp.cycle_id=cy.id join public.subscription_invoices i on i.id=cp.invoice_id where cy.restaurant_id=p_id and cy.evidence_source='trial_purchase_v1' and cy.plan_id=c.plan_id and cy.billing_cycle=c.billing_cycle and cy.starts_at>=t.original_end and i.restaurant_id=p_id and i.status='paid' and i.paid_at is not null and nullif(btrim(i.external_reference),'') is not null and i.plan_id=cy.plan_id and i.billing_cycle=cy.billing_cycle and cp.confirmed_credit_cents=cy.contracted_price_cents and i.amount_cents=cy.contracted_price_cents),t.original_end);
 status:=case when trial_active then 'active' when c.id is null or p_at<c.starts_at then 'expired' when p_at<c.ends_at then 'active' when p_at<=c.ends_at+interval '72 hours' then 'grace_period' else 'expired' end;
 unlim:=plan='premium'; lim:=case plan when 'basic' then 5 when 'pro' then 20 else null end;
 return jsonb_build_object('known_trial',true,'trial_active',trial_active,'original_trial_start',t.original_start,'original_trial_end',t.original_end,'contracted_plan',c.plan_id,'paid_start',c.starts_at,'paid_end',c.ends_at,'billing_cycle',c.billing_cycle,'plan',plan,'max_tables',lim,'unlimited_tables',unlim,'expires_at',expiry,'is_trial',trial_active or c.id is null,'billing_status',status);
end $$;
create function subscription_quote_private.effective_plan(p_id uuid) returns text language sql stable security definer set search_path='' as $$select subscription_quote_private.effective_subscription(p_id)->>'plan'$$;
create function subscription_quote_private.effective_limit(p_id uuid) returns integer language sql stable security definer set search_path='' as $$select (subscription_quote_private.effective_subscription(p_id)->>'max_tables')::integer$$;
create function subscription_quote_private.effective_unlimited(p_id uuid) returns boolean language sql stable security definer set search_path='' as $$select (subscription_quote_private.effective_subscription(p_id)->>'unlimited_tables')::boolean$$;
create function subscription_quote_private.immutable_evidence() returns trigger language plpgsql set search_path='' as $$begin raise exception 'Subscription evidence is immutable' using errcode='42501';end $$;
create trigger immutable_trial_terms before update or delete on subscription_quote_private.trial_terms for each row when(old.evidence_source='onboarding_premium_168h') execute function subscription_quote_private.immutable_evidence();
create trigger immutable_trial_cycles before update or delete on subscription_quote_private.cycles for each row when(old.evidence_source='trial_purchase_v1') execute function subscription_quote_private.immutable_evidence();
create function public.get_effective_subscription(p_restaurant_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$begin
 if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) or not (public.is_platform_admin() or exists(select 1 from public.restaurant_members where restaurant_id=p_restaurant_id and user_id=auth.uid() and active)) then raise exception 'Active membership required' using errcode='42501';end if;
 return subscription_quote_private.effective_subscription(p_restaurant_id);end $$;
revoke all on function public.get_effective_subscription(uuid) from public,anon,authenticated;
grant execute on function public.get_effective_subscription(uuid) to authenticated;
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

  if v_settings.premium_price_cents is null or v_settings.premium_price_cents <= 0 then raise exception 'Invalid Premium price' using errcode='22023';end if;

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
    subscription_is_trial, unlimited_tables
  ) values (
    v_restaurant_id,
    v_name,
    v_slug,
    'Cardápio Digital & Pedidos',
    v_phone,
    true,
    'premium',
    v_settings.premium_price_cents,
    null,
    v_now,
    v_now + interval '168 hours',
    7,
    true, true
  );

  insert into subscription_quote_private.trial_terms(restaurant_id,original_start,original_end,evidence_source) values(v_restaurant_id,v_now,v_now+interval '168 hours','onboarding_premium_168h');
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
  v_trial subscription_quote_private.trial_terms;
  v_cycle_id uuid;
  v_last_cycle subscription_quote_private.cycles;
  v_paid_start timestamptz;
  v_ext_ref text;
  v_invoice public.subscription_invoices%rowtype;
  v_restaurant public.restaurants%rowtype;
  v_settings public.platform_settings%rowtype;
  v_cycle_days integer;
  v_max_tables integer;
  v_unlimited_tables boolean;
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
      'max_tables', case when coalesce(v_restaurant.unlimited_tables, false) then null else v_restaurant.max_tables end,
      'unlimited_tables', coalesce(v_restaurant.unlimited_tables, false)
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

  select * into v_trial from subscription_quote_private.trial_terms where restaurant_id=v_invoice.restaurant_id and evidence_source='onboarding_premium_168h';
  if v_trial.restaurant_id is not null then
    select * into v_last_cycle from subscription_quote_private.cycles where restaurant_id=v_invoice.restaurant_id and evidence_source='trial_purchase_v1' order by ends_at desc limit 1;
    if found and (v_now<v_trial.original_end or v_invoice.plan_id<>v_last_cycle.plan_id or v_invoice.billing_cycle<>v_last_cycle.billing_cycle) then
      raise exception 'Plan and billing-cycle transitions are unavailable' using errcode='22023';
    end if;
    if exists(select 1 from public.subscription_invoices i where i.restaurant_id=v_invoice.restaurant_id and i.status='paid' and i.id<>v_invoice.id and not exists(select 1 from subscription_quote_private.cycle_payments cp where cp.invoice_id=i.id)) then raise exception 'Missing reliable paid-cycle evidence' using errcode='22023';end if;
  end if;
  select * into v_settings from public.platform_settings where id = 'default';
  if not found then
    raise exception 'Configurações de catálogo de planos (platform_settings id=default) não encontradas.'
      using errcode = 'P0002';
  end if;

  if v_invoice.plan_id = 'basic' then
    v_monthly_equiv_cents := v_settings.basic_price_cents;
    v_unlimited_tables := coalesce(v_settings.basic_unlimited_tables, false);
    v_max_tables := case when v_unlimited_tables then null else v_settings.basic_max_tables end;
  elsif v_invoice.plan_id = 'pro' then
    v_monthly_equiv_cents := v_settings.pro_price_cents;
    v_unlimited_tables := coalesce(v_settings.pro_unlimited_tables, false);
    v_max_tables := case when v_unlimited_tables then null else v_settings.pro_max_tables end;
  elsif v_invoice.plan_id = 'premium' then
    v_monthly_equiv_cents := v_settings.premium_price_cents;
    v_unlimited_tables := coalesce(v_settings.premium_unlimited_tables, false);
    v_max_tables := case when v_unlimited_tables then null else v_settings.premium_max_tables end;
  else
    raise exception 'Plano inválido na fatura: %', v_invoice.plan_id using errcode = '22023';
  end if;

  if v_monthly_equiv_cents is null or v_monthly_equiv_cents <= 0
     or ((not v_unlimited_tables) and (v_max_tables is null or v_max_tables <= 0)) then
    raise exception 'Catálogo de planos em platform_settings inválido para o plano %.', v_invoice.plan_id
      using errcode = '22023';
  end if;

  -- Anual = 12 meses de acesso (365 dias); Mensal = 30 dias
  v_cycle_days := case when v_invoice.billing_cycle = 'yearly' then 365 else 30 end;

  if v_trial.restaurant_id is not null then
    v_paid_start := greatest(v_trial.original_end,v_now,v_last_cycle.ends_at);
    v_new_expires_at := v_paid_start + case v_invoice.billing_cycle when 'yearly' then interval '8760 hours' else interval '720 hours' end;
  else
  if v_restaurant.subscription_expires_at is not null and v_restaurant.subscription_expires_at > v_now then
    v_new_expires_at := v_restaurant.subscription_expires_at + (v_cycle_days || ' days')::interval;
  else
    v_new_expires_at := v_now + (v_cycle_days || ' days')::interval;
  end if;

  end if;
  update public.subscription_invoices
  set status = 'paid', paid_at = v_now, external_reference = v_ext_ref,
      gateway_emission_status = 'issued'
  where id = v_invoice.id;

  if v_trial.restaurant_id is not null then
    insert into subscription_quote_private.cycles(restaurant_id,plan_id,billing_cycle,starts_at,ends_at,contracted_price_cents,evidence_source)
    values(v_invoice.restaurant_id,v_invoice.plan_id,v_invoice.billing_cycle,v_paid_start,v_new_expires_at,v_invoice.amount_cents,'trial_purchase_v1') returning id into v_cycle_id;
    insert into subscription_quote_private.cycle_payments(invoice_id,cycle_id,confirmed_credit_cents)values(v_invoice.id,v_cycle_id,v_invoice.amount_cents);
  end if;
  -- Converte subscription_is_trial para false e aplica capacidade do plano contratado
  update public.restaurants
  set subscription_plan = v_invoice.plan_id,
      subscription_expires_at = v_new_expires_at,
      billing_cycle_days = v_cycle_days,
      max_tables = v_max_tables,
      unlimited_tables = v_unlimited_tables,
      monthly_price_cents = v_monthly_equiv_cents,
      active = true,
      subscription_is_trial = false
  where id = v_invoice.restaurant_id;

  perform public.sync_restaurant_tables_to_plan_limit(v_invoice.restaurant_id);

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
      'new_expires_at', v_new_expires_at,
      'max_tables', v_max_tables,
      'unlimited_tables', v_unlimited_tables
    )
  );

  return jsonb_build_object(
    'success', true, 'invoice_id', v_invoice.id, 'status', 'paid', 'already_paid', false,
    'late_confirmation', v_previous_status <> 'pending',
    'paid_at', v_now, 'plan_id', v_invoice.plan_id, 'billing_cycle', v_invoice.billing_cycle,
    'amount_cents', v_invoice.amount_cents, 'subscription_expires_at', v_new_expires_at,
    'subscription_is_trial', false,
    'max_tables', v_max_tables,
    'unlimited_tables', v_unlimited_tables
  );
end;
$$;
create or replace function public.sync_restaurant_tables_to_plan_limit(
  p_restaurant_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_max_tables integer;
  v_unlimited_tables boolean;
  v_deactivated_count integer := 0;
  v_activated_count integer := 0;
begin
  select subscription_quote_private.effective_limit(r.id), subscription_quote_private.effective_unlimited(r.id)
  into v_max_tables, v_unlimited_tables
  from public.restaurants as r
  where r.id = p_restaurant_id
  for update;

  if not found then
    return jsonb_build_object('deactivated_count', 0, 'activated_count', 0);
  end if;

  if v_unlimited_tables then
    -- Capacidade ilimitada: reativa todas as mesas não excluídas que estavam bloqueadas/inativas
    with activated as (
      update public.restaurant_tables as rt
      set
        active = true,
        is_active = true
      where rt.restaurant_id = p_restaurant_id
        and rt.deleted_at is null
        and (not rt.active or not rt.is_active)
      returning rt.id
    )
    select count(*)::int into v_activated_count from activated;

    return jsonb_build_object(
      'max_tables', null,
      'unlimited_tables', true,
      'deactivated_count', 0,
      'activated_count', v_activated_count
    );
  end if;

  v_max_tables := coalesce(v_max_tables, 5);

  -- 1) Se há mais mesas ativas que o limite do plano, desativa o excedente sem atendimento aberto
  with ranked_active as (
    select
      rt.id,
      exists (
        select 1
        from public.table_visits as tv
        where tv.restaurant_table_id = rt.id
          and tv.status = 'open'
      ) as has_open_visit,
      row_number() over (
        order by
          case when exists (
            select 1
            from public.table_visits as tv
            where tv.restaurant_table_id = rt.id
              and tv.status = 'open'
          ) then 0 else 1 end asc,
          rt.table_number asc,
          rt.created_at asc
      ) as rn
    from public.restaurant_tables as rt
    where rt.restaurant_id = p_restaurant_id
      and rt.deleted_at is null
      and rt.active = true
      and rt.is_active = true
  ),
  deactivated as (
    update public.restaurant_tables as rt
    set
      active = false,
      is_active = false
    from ranked_active as ra
    where rt.id = ra.id
      and ra.rn > v_max_tables
      and ra.has_open_visit = false
    returning rt.id
  )
  select count(*)::int into v_deactivated_count from deactivated;

  -- 2) Se há menos mesas ativas que o limite do plano (ex.: upgrade), reativa até atingir v_max_tables
  with current_active as (
    select count(*)::int as cnt
    from public.restaurant_tables as rt
    where rt.restaurant_id = p_restaurant_id
      and rt.deleted_at is null
      and rt.active = true
      and rt.is_active = true
  ),
  ranked_inactive as (
    select
      rt.id,
      row_number() over (order by rt.table_number asc, rt.created_at asc) as rn,
      greatest(v_max_tables - (select cnt from current_active), 0) as slots_available
    from public.restaurant_tables as rt
    where rt.restaurant_id = p_restaurant_id
      and rt.deleted_at is null
      and (not rt.active or not rt.is_active)
  ),
  activated as (
    update public.restaurant_tables as rt
    set
      active = true,
      is_active = true
    from ranked_inactive as ri
    where rt.id = ri.id
      and ri.rn <= ri.slots_available
    returning rt.id
  )
  select count(*)::int into v_activated_count from activated;

  return jsonb_build_object(
    'max_tables', v_max_tables,
    'unlimited_tables', false,
    'deactivated_count', v_deactivated_count,
    'activated_count', v_activated_count
  );
end;
$$;
create or replace function public.enforce_restaurant_tables_plan_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_max_tables integer;
  v_unlimited_tables boolean;
  v_active_count integer;
  v_target_active boolean;
begin
  if NEW.deleted_at is not null then
    NEW.active := false;
    NEW.is_active := false;
    return NEW;
  end if;

  if TG_OP = 'INSERT' then
    v_target_active := coalesce(NEW.is_active, NEW.active, true);
  else
    if NEW.is_active is distinct from OLD.is_active then
      v_target_active := coalesce(NEW.is_active, false);
    elsif NEW.active is distinct from OLD.active then
      v_target_active := coalesce(NEW.active, false);
    else
      v_target_active := coalesce(NEW.is_active, NEW.active, false);
    end if;
  end if;

  NEW.active := v_target_active;
  NEW.is_active := v_target_active;

  if not v_target_active then
    return NEW;
  end if;

  -- Trava a linha do restaurante para serializar ativações/criações concorrentes de mesas
  select subscription_quote_private.effective_limit(r.id), subscription_quote_private.effective_unlimited(r.id)
  into v_max_tables, v_unlimited_tables
  from public.restaurants as r
  where r.id = NEW.restaurant_id
  for update;

  if v_unlimited_tables then
    return NEW;
  end if;

  v_max_tables := coalesce(v_max_tables, 5);

  select count(*)::int
  into v_active_count
  from public.restaurant_tables as rt
  where rt.restaurant_id = NEW.restaurant_id
    and rt.deleted_at is null
    and (rt.is_active = true or rt.active = true)
    and (TG_OP = 'INSERT' or rt.id <> NEW.id);

  if v_active_count >= v_max_tables then
    raise exception using
      errcode = 'P0001',
      message = format(
        'Limite de %s mesas simultâneas ativas do seu plano foi atingido. Desative outra mesa ou faça upgrade de plano.',
        v_max_tables
      );
  end if;

  return NEW;
end;
$$;
create or replace function public.get_admin_tables(p_slug text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  rid uuid;
  v_max_tables integer;
  v_unlimited_tables boolean;
  v_active_count integer;
begin
  rid := public.require_catalog_admin(p_slug);

  select subscription_quote_private.effective_limit(r.id), subscription_quote_private.effective_unlimited(r.id)
  into v_max_tables, v_unlimited_tables
  from public.restaurants as r
  where r.id = rid;

  select count(*)::integer
  into v_active_count
  from public.restaurant_tables as t
  where t.restaurant_id = rid
    and t.deleted_at is null
    and (t.active = true and t.is_active = true);

  return coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', t.id,
          'restaurantId', t.restaurant_id,
          'tableNumber', t.table_number,
          'label', coalesce(t.label, ''),
          'active', (t.active and t.is_active),
          'isActive', (t.active and t.is_active),
          'is_active', (t.active and t.is_active),
          'isLockedByPlan', (
            (not (t.active and t.is_active))
            and (not v_unlimited_tables)
            and (v_active_count >= coalesce(v_max_tables, 5))
          ),
          'maxTablesLimit', case when v_unlimited_tables then null else v_max_tables end,
          'unlimitedTables', v_unlimited_tables,
          'activeTablesCount', v_active_count,
          'revision', t.revision,
          'visitId', v.id,
          'hasOpenVisit', (v.id is not null),
          'tabCount', (
            select count(*)::integer
            from public.table_tabs as tab
            where tab.table_visit_id = v.id
              and tab.status = 'open'
          ),
          'totalInCents', coalesce(
            (
              select sum(i.line_total_in_cents)::integer
              from public.table_tab_items as i
              where i.table_visit_id = v.id
                and i.status = 'active'
            ),
            0
          ),
          'billPending', exists (
            select 1
            from public.service_requests as sr
            where sr.table_visit_id = v.id
              and sr.request_type = 'bill'
              and sr.status = 'pending'
          )
        )
        order by t.table_number, t.id
      )
      from public.restaurant_tables as t
      left join public.table_visits as v
        on v.restaurant_table_id = t.id
       and v.status = 'open'
      where t.restaurant_id = rid
        and t.deleted_at is null
    ),
    '[]'::jsonb
  );
end;
$$;
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
  v_unlimited_tables boolean;
  v_max_tables integer;
  v_active_tables_count integer;
  v_open_visits_count integer;
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
    subscription_quote_private.effective_unlimited(restaurant.id),
    subscription_quote_private.effective_limit(restaurant.id),
    (subscription_quote_private.effective_subscription(restaurant.id)->>'expires_at')::timestamptz,
    (subscription_quote_private.effective_subscription(restaurant.id)->>'is_trial')::boolean
  into
    target_restaurant_id,
    v_unlimited_tables,
    v_max_tables,
    v_subscription_expires_at,
    v_is_trial
  from public.restaurants as restaurant
  where restaurant.slug = p_restaurant_slug
    and restaurant.active = true
  for update;

  if target_restaurant_id is null then
    raise exception using
      errcode = '42501',
      message = 'Restaurante indisponível.';
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

  perform subscription_quote_private.assert_table_admission(target_restaurant_id,target_table_id);
  -- Ao abrir um NOVO atendimento em plano com limite fixo, valida a contagem simultânea ativa
  if not v_unlimited_tables then
    v_max_tables := coalesce(v_max_tables, 5);

    select count(*)::int
    into v_active_tables_count
    from public.restaurant_tables as rt
    where rt.restaurant_id = target_restaurant_id
      and rt.deleted_at is null
      and rt.active = true
      and rt.is_active = true;

    select count(*)::int
    into v_open_visits_count
    from public.table_visits as tv
    where tv.restaurant_id = target_restaurant_id
      and tv.status = 'open';

    if v_active_tables_count > v_max_tables or v_open_visits_count >= v_max_tables then
      raise exception using
        errcode = 'P0001',
        message = format(
          'Limite de %s mesas simultâneas do seu plano foi atingido. Encerre ou desative uma mesa excedente antes de abrir um novo atendimento.',
          v_max_tables
        );
    end if;
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

  target_rest.subscription_expires_at := (subscription_quote_private.effective_subscription(target_rest.id)->>'expires_at')::timestamptz;
  target_rest.subscription_is_trial := (subscription_quote_private.effective_subscription(target_rest.id)->>'is_trial')::boolean;
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

  perform subscription_quote_private.assert_table_admission(target_rest.id,p_table_id);
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
create or replace function public.add_table_tab_item(
  p_restaurant_slug text,
  p_table_tab_id uuid,
  p_product_id uuid,
  p_quantity integer,
  p_item_id uuid
)
returns public.table_tab_items
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_visit_id uuid;
  target_visit public.table_visits%rowtype;
  target_tab public.table_tabs%rowtype;
  target_product public.menu_products%rowtype;
  target_item public.table_tab_items%rowtype;
  v_station text;
  v_prod_status text;
  v_delivered_at timestamptz;
begin
  if p_restaurant_slug is null or length(btrim(p_restaurant_slug)) = 0
    or p_table_tab_id is null or p_product_id is null or p_item_id is null
    or p_quantity is null or p_quantity not between 1 and 99 then
    raise exception using errcode = '22023', message = 'Selecione o produto e uma quantidade entre 1 e 99.';
  end if;

  select tab.table_visit_id into target_visit_id from public.table_tabs as tab
  join public.restaurants as restaurant on restaurant.id = tab.restaurant_id
  where tab.id = p_table_tab_id and restaurant.slug = p_restaurant_slug and restaurant.active;
  if not found then
    raise exception using errcode = '22023', message = 'Comanda não encontrada neste restaurante.';
  end if;

  target_visit := public.lock_owned_table_visit(p_restaurant_slug, target_visit_id);

  select tab.* into target_tab from public.table_tabs as tab
  where tab.id = p_table_tab_id and tab.table_visit_id = target_visit.id
    and tab.restaurant_id = target_visit.restaurant_id
    and tab.restaurant_table_id = target_visit.restaurant_table_id for update;
  if not found then
    raise exception using errcode = '22023', message = 'Comanda não encontrada neste atendimento.';
  end if;

  -- Repetir o mesmo ID e os mesmos dados não duplica o consumo.
  select item.* into target_item from public.table_tab_items as item
  where item.id = p_item_id for update;
  if found then
    if target_item.table_tab_id = target_tab.id
      and target_item.restaurant_id = target_visit.restaurant_id
      and target_item.product_id = p_product_id and target_item.quantity = p_quantity
      and target_item.added_by_member_id = target_visit.assigned_member_id then
      return target_item;
    end if;
    raise exception using errcode = '22023', message = 'Identificador de lançamento já utilizado. Atualize a comanda.';
  end if;

  if subscription_quote_private.effective_subscription(target_visit.restaurant_id)->>'billing_status'='expired' then raise exception 'Subscription expired' using errcode='42501';end if;
  if target_visit.status <> 'open' or target_tab.status <> 'open' then
    raise exception using errcode = '22023', message = 'Não é possível registrar consumo em uma comanda encerrada.';
  end if;

  select product.* into target_product from public.menu_products as product
  where product.id = p_product_id and product.restaurant_id = target_visit.restaurant_id for share;
  if not found or not target_product.available then
    raise exception using errcode = '22023', message = 'Produto indisponível neste restaurante.';
  end if;

  perform category.id from public.menu_categories as category
  where category.id = target_product.category_id and category.restaurant_id = target_visit.restaurant_id
    and category.active for share;
  if not found then
    raise exception using errcode = '22023', message = 'A categoria deste produto está indisponível.';
  end if;

  v_station := coalesce(target_product.preparation_station, 'kitchen');
  if v_station = 'none' then
    v_prod_status := 'delivered';
    v_delivered_at := clock_timestamp();
  else
    v_prod_status := 'pending';
    v_delivered_at := null;
  end if;

  insert into public.table_tab_items (
    id, restaurant_id, restaurant_table_id, table_visit_id, table_tab_id,
    product_id, product_name, unit_price_in_cents, quantity, added_by_member_id, created_at,
    preparation_station, production_status, prep_delivered_at
  ) values (
    p_item_id, target_visit.restaurant_id, target_visit.restaurant_table_id,
    target_visit.id, target_tab.id, target_product.id, target_product.name,
    target_product.price_in_cents, p_quantity, target_visit.assigned_member_id,
    greatest(clock_timestamp(), target_tab.created_at),
    v_station, v_prod_status, v_delivered_at
  ) returning * into target_item;

  return target_item;
end;
$$;
create or replace function public.get_kds_active_items(p_restaurant_slug text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_rest record;
begin
  v_user_id := auth.uid();

  if v_user_id is null
     or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)
  then
    raise exception 'Entre com uma conta da equipe para acessar o KDS.'
      using errcode = '42501';
  end if;

  select id, subscription_quote_private.effective_plan(id) as subscription_plan
  into v_rest
  from public.restaurants
  where slug = p_restaurant_slug
    and active = true;

  if not found then
    raise exception 'Restaurante não encontrado.' using errcode = '22023';
  end if;

  if not public.is_platform_admin() and not exists (
    select 1
    from public.restaurant_members as rm
    where rm.restaurant_id = v_rest.id
      and rm.user_id = v_user_id
      and rm.active = true
      and rm.role in ('admin', 'waiter')
  ) then
    raise exception 'Sua conta não possui acesso ativo ao KDS deste restaurante.'
      using errcode = '42501';
  end if;

  if v_rest.subscription_plan not in ('pro', 'premium') then
    raise exception 'O módulo KDS é exclusivo para planos Profissional e Premium. Faça upgrade para acessar a esteira de produção.'
      using errcode = '42501';
  end if;

  return coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'id', i.id,
          'table_tab_id', i.table_tab_id,
          'table_visit_id', i.table_visit_id,
          'restaurant_table_id', i.restaurant_table_id,
          'table_number', t.table_number,
          'table_name', coalesce(t.label, 'Mesa ' || lpad(t.table_number::text, 2, '0')),
          'product_name', i.product_name,
          'quantity', i.quantity,
          'preparation_station', coalesce(i.preparation_station, 'none'),
          'production_status', coalesce(i.production_status, 'pending'),
          'created_at', i.created_at,
          'prep_started_at', i.prep_started_at,
          'prep_ready_at', i.prep_ready_at,
          'prep_delivered_at', i.prep_delivered_at
        )
        order by i.created_at asc
      )
      from public.table_tab_items as i
      join public.table_tabs as tab on tab.id = i.table_tab_id and tab.status = 'open'
      join public.table_visits as v on v.id = i.table_visit_id and v.status = 'open'
      join public.restaurant_tables as t on t.id = i.restaurant_table_id and t.deleted_at is null
      where i.restaurant_id = v_rest.id
        and i.status = 'active'
        and i.production_status in ('pending', 'preparing', 'ready')
    ),
    '[]'::jsonb
  );
end;
$$;
create or replace function public.update_tab_item_production_status(
  p_restaurant_slug text,
  p_item_id uuid,
  p_target_status text
)
returns public.table_tab_items
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid;
  target_restaurant_id uuid;
  target_subscription_plan text;
  target_member_id uuid;
  target_member_role text;
  target_table_id uuid;
  target_visit_id uuid;
  target_tab_id uuid;
  target_visit public.table_visits%rowtype;
  target_tab public.table_tabs%rowtype;
  target_item public.table_tab_items%rowtype;
begin
  current_user_id := auth.uid();
  if current_user_id is null
    or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)
  then
    raise exception using
      errcode = '42501',
      message = 'Entre com uma conta da equipe.';
  end if;

  if p_item_id is null or p_target_status is null or btrim(p_target_status) = '' then
    raise exception using
      errcode = '22023',
      message = 'Informe o item e o estado de produção desejado.';
  end if;

  if p_target_status not in ('pending', 'preparing', 'ready', 'delivered') then
    raise exception using
      errcode = '22023',
      message = 'Estado de produção inválido.';
  end if;

  select restaurant.id, subscription_quote_private.effective_plan(restaurant.id)
  into target_restaurant_id, target_subscription_plan
  from public.restaurants as restaurant
  where restaurant.slug = p_restaurant_slug
    and restaurant.active = true
  for update;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'Restaurante indisponível.';
  end if;

  if target_subscription_plan not in ('pro', 'premium') and not (target_subscription_plan = 'basic' and p_target_status = 'delivered') then
    raise exception using
      errcode = '42501',
      message = 'O módulo KDS é exclusivo para planos Profissional e Premium. Faça upgrade para utilizar a esteira de produção.';
  end if;

  select member.id, member.role
  into target_member_id, target_member_role
  from public.restaurant_members as member
  where member.restaurant_id = target_restaurant_id
    and member.user_id = current_user_id
    and member.active = true
    and member.role in ('admin', 'waiter')
  for share;

  if not found and (target_subscription_plan = 'basic' or not public.is_platform_admin()) then
    raise exception using
      errcode = '42501',
      message = 'Sua conta não possui acesso ativo a este restaurante.';
  end if;

  select *
  into target_item
  from public.table_tab_items
  where id = p_item_id;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'Item de comanda não encontrado.';
  end if;

  if target_item.restaurant_id <> target_restaurant_id then
    raise exception using
      errcode = '42501',
      message = 'Item pertence a outro restaurante.';
  end if;

  if target_item.status = 'cancelled' then
    raise exception using
      errcode = '22023',
      message = 'Itens cancelados não podem ter seu estado de produção alterado.';
  end if;

  target_tab_id := target_item.table_tab_id;
  target_visit_id := target_item.table_visit_id;
  target_table_id := target_item.restaurant_table_id;

  -- Canonical lock order: restaurant, member, table, visit, tab, item.
  perform rt.id from public.restaurant_tables rt
  where rt.id=target_table_id and rt.restaurant_id=target_restaurant_id for update;
  if not found then raise exception 'Mesa indisponivel.' using errcode='22023'; end if;

  select *
  into target_visit
  from public.table_visits
  where id = target_visit_id
  for share;

  if not found or target_visit.status <> 'open' or target_visit.restaurant_id <> target_restaurant_id or target_visit.restaurant_table_id <> target_table_id then
    raise exception using
      errcode = '22023',
      message = 'Atendimento da mesa não está mais aberto.';
  end if;

  select *
  into target_tab
  from public.table_tabs
  where id = target_tab_id
  for share;

  if not found or target_tab.status <> 'open' or target_tab.restaurant_id <> target_restaurant_id or target_tab.table_visit_id <> target_visit_id or target_tab.restaurant_table_id <> target_table_id then
    raise exception using
      errcode = '22023',
      message = 'Comanda não está mais aberta.';
  end if;

  select *
  into target_item
  from public.table_tab_items
  where id = p_item_id
  for update;

  -- Recheck after item lock: a concurrent transfer/cancellation cannot redirect delivery.
  if not found or target_item.status <> 'active'
     or target_item.restaurant_id <> target_restaurant_id
     or target_item.restaurant_table_id <> target_table_id
     or target_item.table_visit_id <> target_visit_id or target_item.table_tab_id <> target_tab_id then
    raise exception 'Item nao esta ativo neste atendimento.' using errcode='22023';
  end if;
  if target_subscription_plan = 'basic' and not coalesce((
    target_member_role = 'admin' or target_visit.assigned_member_id = target_member_id
  ), false) then
    raise exception 'Somente o responsavel ou admin ativo pode confirmar entrega.' using errcode='42501';
  end if;

  if target_item.production_status = p_target_status then
    return target_item;
  end if;

  if target_subscription_plan = 'basic' and p_target_status = 'delivered'
     and target_item.production_status in ('pending','preparing','ready') then
    update public.table_tab_items
    set production_status='delivered',
        prep_delivered_at=coalesce(prep_delivered_at,greatest(clock_timestamp(),created_at))
    where id=p_item_id returning * into target_item;
    return target_item;
  end if;

  if target_item.production_status = 'pending' and p_target_status = 'preparing' then
    update public.table_tab_items
    set
      production_status = 'preparing',
      prep_started_at = coalesce(prep_started_at, timezone('utc', now()))
    where id = p_item_id
    returning * into target_item;
  elsif target_item.production_status = 'preparing' and p_target_status = 'ready' then
    update public.table_tab_items
    set
      production_status = 'ready',
      prep_ready_at = coalesce(prep_ready_at, timezone('utc', now()))
    where id = p_item_id
    returning * into target_item;
  elsif target_item.production_status = 'ready' and p_target_status = 'delivered' then
    update public.table_tab_items
    set
      production_status = 'delivered',
      prep_delivered_at = coalesce(prep_delivered_at, timezone('utc', now()))
    where id = p_item_id
    returning * into target_item;
  elsif target_item.production_status = 'pending' and p_target_status = 'delivered' and target_item.preparation_station = 'none' then
    update public.table_tab_items
    set
      production_status = 'delivered',
      prep_delivered_at = coalesce(prep_delivered_at, timezone('utc', now()))
    where id = p_item_id
    returning * into target_item;
  else
    raise exception using
      errcode = '22023',
      message = format('Transição de produção inválida: de %s para %s.', target_item.production_status, p_target_status);
  end if;

  return target_item;
end;
$$;
create or replace function public.has_contract_module(p_restaurant_id uuid,p_module text) returns boolean language sql stable security definer set search_path='' as $$
 select coalesce((select (r.contract_rights_model='legacy' or subscription_quote_private.effective_plan(r.id)='premium') from public.restaurants r where r.id=p_restaurant_id),false) and p_module in ('inventory','finance') and (public.is_platform_admin() or exists(select 1 from public.restaurant_members m where m.restaurant_id=p_restaurant_id and m.user_id=auth.uid() and m.active));
$$;
create or replace function public.acquire_or_create_pending_subscription_invoice(
  p_restaurant_id uuid,
  p_plan_id text,
  p_billing_cycle text,
  p_payment_method text,
  p_amount_cents integer,
  p_pix_expires_at timestamptz default null,
  p_card_brand text default null,
  p_card_last4 text default null,
  p_created_by uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := timezone('utc', now());
  v_existing public.subscription_invoices%rowtype;
  v_created public.subscription_invoices%rowtype;
begin
  perform public.assert_trusted_billing_server();

  if p_restaurant_id is null then
    raise exception 'Restaurante é obrigatório.' using errcode = '22023';
  end if;
  if p_plan_id not in ('basic', 'pro', 'premium') then
    raise exception 'Plano inválido: %', p_plan_id using errcode = '22023';
  end if;
  if p_billing_cycle not in ('monthly', 'yearly') then
    raise exception 'Ciclo de faturamento inválido: %', p_billing_cycle using errcode = '22023';
  end if;
  if p_payment_method not in ('pix', 'credit_card', 'debit_card') then
    raise exception 'Método de pagamento inválido: %', p_payment_method using errcode = '22023';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'Valor da fatura inválido.' using errcode = '22023';
  end if;

  -- Serializa requisições concorrentes de checkout do mesmo restaurante
  perform 1 from public.restaurants where id = p_restaurant_id for update;
  if not found then
    raise exception 'Restaurante não encontrado.' using errcode = 'P0002';
  end if;

  if exists(select 1 from subscription_quote_private.trial_terms where restaurant_id=p_restaurant_id and evidence_source='onboarding_premium_168h') then
    if exists(select 1 from subscription_quote_private.cycles c join subscription_quote_private.trial_terms t using(restaurant_id) where c.restaurant_id=p_restaurant_id and c.evidence_source='trial_purchase_v1' and (now()<t.original_end or c.plan_id<>p_plan_id or c.billing_cycle<>p_billing_cycle))
     or exists(select 1 from public.subscription_invoices where restaurant_id=p_restaurant_id and status='pending' and (plan_id<>p_plan_id or billing_cycle<>p_billing_cycle or payment_method<>p_payment_method)) then
      raise exception 'Additional trial transitions are not supported' using errcode='22023';
    end if;
  end if;
  -- Reutiliza fatura pendente existente da mesma combinação (PIX ou CARTÃO),
  -- garantindo idempotência e prevenindo criação de faturas concorrentes para a mesma tentativa de checkout.
  select * into v_existing
  from public.subscription_invoices
  where restaurant_id = p_restaurant_id
    and plan_id = p_plan_id
    and billing_cycle = p_billing_cycle
    and payment_method = p_payment_method
    and amount_cents = p_amount_cents
    and status = 'pending'
  order by created_at desc, id desc
  limit 1
  for update;

  if found then
    return jsonb_build_object('reused', true, 'invoice', to_jsonb(v_existing));
  end if;

  insert into public.subscription_invoices (
    restaurant_id, plan_id, billing_cycle, payment_method, amount_cents, status,
    pix_expires_at, card_brand, card_last4, created_by
  ) values (
    p_restaurant_id, p_plan_id, p_billing_cycle, p_payment_method, p_amount_cents, 'pending',
    case when p_payment_method = 'pix' then coalesce(p_pix_expires_at, v_now + interval '30 minutes') else null end,
    p_card_brand, p_card_last4, p_created_by
  )
  returning * into v_created;

  return jsonb_build_object('reused', false, 'invoice', to_jsonb(v_created));
end;
$$;
create or replace function public.save_restaurant_identity(
  p_slug text,
  p_revision integer,
  p_values jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  rid uuid;
  old_row public.restaurants%rowtype;
  v public.restaurants%rowtype;
  field text;
  media jsonb;
  path text;
  primary_l numeric;
  text_l numeric;
  bg_l numeric;
  v_fee numeric;
  v_tz text;
  v_google_url text;
  v_brand_primary text;
  v_header_name text;
  v_header_sub text;
  v_menu_theme text;
begin
  if p_values ?| array['original_trial_start','original_trial_end','trial_start','trial_end','paid_start','paid_end','originalTrialStart','originalTrialEnd','trialStart','trialEnd','paidStart','paidEnd','subscription_started_at','subscription_expires_at','subscription_is_trial','subscriptionStartedAt','subscriptionExpiresAt','subscriptionIsTrial','effectiveSubscription','effective_subscription'] then raise exception 'Subscription dates are server managed' using errcode='42501';end if;
  if p_values ?| array['contract_rights_model','contractRightsModel'] then raise exception 'Contract rights payload forbidden' using errcode='42501'; end if;
  rid := public.require_catalog_admin(p_slug);
  select * into old_row from public.restaurants where id = rid for update;
  if p_revision is distinct from old_row.revision then
    raise exception using errcode = '40001', message = 'A identidade foi alterada. Recarregue antes de editar novamente.';
  end if;
  select * into v from jsonb_populate_record(null::public.restaurants, p_values);
  if v.name is null or char_length(btrim(v.name)) not between 1 and 120
  or v.subtitle is null or char_length(v.subtitle) > 120
  or v.description is null or char_length(v.description) > 1000
  or v.address is null or char_length(v.address) > 300
  or v.phone is null or char_length(v.phone) > 40
  or v.opening_hours is null or char_length(v.opening_hours) > 500 then
    raise exception using errcode = '22023', message = 'Confira os dados e os limites dos campos.';
  end if;

  if p_values ? 'service_fee_percent' then
    v_fee := (p_values->>'service_fee_percent')::numeric;
    if v_fee is null or v_fee < 0 or v_fee > 30 then
      raise exception using errcode = '22023', message = 'A taxa de serviço deve estar entre 0% e 30%.';
    end if;
  else
    v_fee := old_row.service_fee_percent;
  end if;

  if p_values ? 'timezone' then
    v_tz := btrim(p_values->>'timezone');
    if v_tz is null or length(v_tz) = 0 then
      raise exception using errcode = '22023', message = 'Informe um fuso horário válido.';
    end if;
    if not exists (
      select 1 from pg_catalog.pg_timezone_names where name = v_tz
    ) then
      raise exception using errcode = '22023', message = 'Fuso horário não reconhecido pelo sistema.';
    end if;
  else
    v_tz := old_row.timezone;
  end if;

  if p_values ? 'google_review_url' then
    v_google_url := nullif(btrim(p_values->>'google_review_url'), '');
    if v_google_url is not null then
      if char_length(v_google_url) not between 10 and 500
      or v_google_url !~* '^https://([a-z0-9-]+\.)*(google\.(com|com\.br)|g\.page|goo\.gl)/' then
        raise exception using errcode = '22023', message = 'Informe um link válido do Perfil da Empresa no Google (ex: https://g.page/r/.../review ou https://maps.app.goo.gl/...).';
      end if;
    end if;
  else
    v_google_url := old_row.google_review_url;
  end if;

  -- Processamento das cores da paleta
  v_brand_primary := coalesce(
    nullif(btrim(p_values->>'brand_primary_color'), ''),
    nullif(btrim(p_values->>'brandPrimaryColor'), ''),
    v.theme_primary,
    old_row.brand_primary_color,
    '#EA580C'
  );
  if v_brand_primary !~* '^#[0-9a-f]{6}$' then
    raise exception using errcode = '22023', message = 'Cor primária da marca inválida. Use formato hexadecimal (#RRGGBB).';
  end if;

  v_header_name := coalesce(
    nullif(btrim(p_values->>'header_name_color'), ''),
    nullif(btrim(p_values->>'headerNameColor'), ''),
    old_row.header_name_color,
    '#1C1917'
  );
  if v_header_name !~* '^#[0-9a-f]{6}$' then
    raise exception using errcode = '22023', message = 'Cor do nome do restaurante inválida. Use formato hexadecimal (#RRGGBB).';
  end if;

  v_header_sub := coalesce(
    nullif(btrim(p_values->>'header_subtitle_color'), ''),
    nullif(btrim(p_values->>'headerSubtitleColor'), ''),
    old_row.header_subtitle_color,
    '#57534E'
  );
  if v_header_sub !~* '^#[0-9a-f]{6}$' then
    raise exception using errcode = '22023', message = 'Cor do complemento inválida. Use formato hexadecimal (#RRGGBB).';
  end if;

  -- Extração e validação do layout do cardápio (menu_theme)
  v_menu_theme := coalesce(
    nullif(btrim(p_values->>'menu_theme'), ''),
    nullif(btrim(p_values->>'menuTheme'), ''),
    'classic'
  );
  if v_menu_theme not in ('classic', 'takeat_premium') then
    raise exception using errcode = '22023', message = 'INVALID_MENU_THEME';
  end if;

  primary_l := public.hex_luminance(v_brand_primary);
  bg_l := public.hex_luminance(v.theme_background);
  text_l := public.hex_luminance(v.theme_text);
  if primary_l is null or bg_l is null or text_l is null or 1.05 / (primary_l + 0.05) < 4.5
  or (greatest(bg_l, text_l) + 0.05) / (least(bg_l, text_l) + 0.05) < 4.5 or 1.05 / (text_l + 0.05) < 4.5 then
    raise exception using errcode = '22023', message = 'Ajuste as cores: texto, cards e botões precisam de contraste mínimo de 4,5:1.';
  end if;

  foreach field in array array['logo', 'cover'] loop
    if not (p_values ? field) then
      raise exception using errcode = '22023', message = 'Informe logo e capa.';
    end if;
    media := p_values->field;
    if media is not null and media <> 'null'::jsonb then
      path := media->>'storagePath';
      if jsonb_typeof(media) is distinct from 'object' or path is null
      or path !~ ('^' || rid::text || '/identity/[0-9a-f-]{36}\.webp$')
      or jsonb_typeof(media->'url') is distinct from 'string'
      or media->>'url' !~ '^https://[a-zA-Z0-9.-]+(:[0-9]+)?/storage/v1/object/public/restaurant-images/'
      or right(media->>'url', char_length(path) + 1) <> '/' || path then
        raise exception using errcode = '22023', message = 'Envie logo e capa pelo painel deste restaurante.';
      end if;
      perform id from storage.objects where bucket_id = 'restaurant-images' and name = path for share;
      if not found then
        raise exception using errcode = '22023', message = 'A imagem ainda não foi enviada.';
      end if;
      media := jsonb_build_object('url', media->>'url', 'storagePath', path);
    end if;
    if field = 'logo' then v.logo := nullif(media, 'null'::jsonb); else v.cover := nullif(media, 'null'::jsonb); end if;
  end loop;

  if p_values ? 'contact_channels' and not public.valid_contact_channels(p_values->'contact_channels') then
    raise exception 'Canais de contato invalidos.' using errcode='22023';
  end if;
  update public.restaurants set
    contact_channels = case when p_values ? 'contact_channels' then p_values->'contact_channels' else old_row.contact_channels end,
    name = btrim(v.name),
    subtitle = btrim(v.subtitle),
    description = btrim(v.description),
    address = btrim(v.address),
    phone = btrim(v.phone),
    opening_hours = btrim(v.opening_hours),
    theme_primary = upper(v_brand_primary),
    theme_background = upper(v.theme_background),
    theme_text = upper(v.theme_text),
    brand_primary_color = upper(v_brand_primary),
    header_name_color = upper(v_header_name),
    header_subtitle_color = upper(v_header_sub),
    menu_theme = v_menu_theme,
    logo = v.logo,
    cover = v.cover,
    service_fee_percent = v_fee,
    timezone = v_tz,
    google_review_url = v_google_url
  where id = rid;

  return public.get_public_restaurant(p_slug);
end;
$$;
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
    'contactChannels', r.contact_channels,
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
    'maxTables', case when coalesce(r.unlimited_tables, false) then null else coalesce(r.max_tables, 5) end,
    'max_tables', case when coalesce(r.unlimited_tables, false) then null else coalesce(r.max_tables, 5) end,
    'unlimitedTables', coalesce(r.unlimited_tables, false),
    'unlimited_tables', coalesce(r.unlimited_tables, false),
    'subscriptionExpiresAt', r.subscription_expires_at,
    'subscription_expires_at', r.subscription_expires_at,
    'subscriptionIsTrial', coalesce(r.subscription_is_trial, false),
    'subscription_is_trial', coalesce(r.subscription_is_trial, false),
    'billingStatus', public.get_restaurant_billing_status(r.subscription_expires_at, r.subscription_is_trial),
    'billing_status', public.get_restaurant_billing_status(r.subscription_expires_at, r.subscription_is_trial)
  )
  || jsonb_build_object(
    'effectiveSubscription',subscription_quote_private.effective_subscription(r.id),
    'effective_subscription',subscription_quote_private.effective_subscription(r.id),
    'subscription_plan',subscription_quote_private.effective_plan(r.id),
    'max_tables',subscription_quote_private.effective_limit(r.id),
    'unlimited_tables',subscription_quote_private.effective_unlimited(r.id),
    'subscription_expires_at',subscription_quote_private.effective_subscription(r.id)->>'expires_at',
    'subscription_is_trial',(subscription_quote_private.effective_subscription(r.id)->>'is_trial')::boolean,
    'billing_status',subscription_quote_private.effective_subscription(r.id)->>'billing_status',
    'subscriptionPlan',subscription_quote_private.effective_plan(r.id),
    'maxTables',subscription_quote_private.effective_limit(r.id),
    'unlimitedTables',subscription_quote_private.effective_unlimited(r.id),
    'subscriptionExpiresAt',subscription_quote_private.effective_subscription(r.id)->>'expires_at',
    'subscriptionIsTrial',(subscription_quote_private.effective_subscription(r.id)->>'is_trial')::boolean,
    'billingStatus',subscription_quote_private.effective_subscription(r.id)->>'billing_status'
  )
  from public.restaurants as r
  where r.slug = p_slug
    and r.active = true;
$$;
create function subscription_quote_private.assert_table_admission(p_id uuid,p_table uuid) returns void language plpgsql security definer set search_path='' as $$
declare e jsonb; lim integer; begin
 perform 1 from public.restaurants where id=p_id for update;
 e:=subscription_quote_private.effective_subscription(p_id);
 if e->>'billing_status'='expired' then raise exception 'Subscription expired' using errcode='42501';end if;
 if not (e->>'unlimited_tables')::boolean then perform public.sync_restaurant_tables_to_plan_limit(p_id);end if;
 if exists(select 1 from public.table_visits where restaurant_table_id=p_table and restaurant_id=p_id and status='open') then return;end if;
 if not exists(select 1 from public.restaurant_tables where id=p_table and restaurant_id=p_id and active and is_active and deleted_at is null) then raise exception 'Table outside active quota' using errcode='P0001';end if;
 lim:=(e->>'max_tables')::integer;
 if not (e->>'unlimited_tables')::boolean and (select count(*) from public.table_visits where restaurant_id=p_id and status='open')>=lim then raise exception 'Active visit quota reached' using errcode='P0001';end if;
end $$;
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

  v_rest.subscription_expires_at := (subscription_quote_private.effective_subscription(v_rest.id)->>'expires_at')::timestamptz;
  v_rest.subscription_is_trial := (subscription_quote_private.effective_subscription(v_rest.id)->>'is_trial')::boolean;
  -- Validação estrita de vigência (com flag subscription_is_trial)
  v_billing_status := subscription_quote_private.effective_subscription(v_rest.id)->>'billing_status';

  if v_billing_status = 'expired' and not ((subscription_quote_private.effective_subscription(v_rest.id)->>'known_trial')::boolean and p_request_type in ('bill','close_table_request') and exists(select 1 from public.table_visits where restaurant_table_id=p_table_id and restaurant_id=v_rest.id and status='open')) then
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
create or replace function public.create_platform_restaurant(
  p_id uuid,
  p_name text,
  p_slug text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_price integer;
  normalized_name text;
  normalized_slug text;
  existing_restaurant public.restaurants%rowtype;
begin
  perform public.require_platform_admin();

  normalized_name := btrim(p_name);
  normalized_slug := lower(btrim(p_slug));

  if p_id is null
    or normalized_name is null
    or char_length(normalized_name) not between 1 and 120
    or normalized_slug is null
    or char_length(normalized_slug) not between 3 and 80
    or normalized_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  then
    raise exception using
      errcode = '22023',
      message = 'Informe nome e endereço válidos para o restaurante.';
  end if;

  if normalized_slug in (
    'plataforma', 'admin', 'api', 'auth'
  ) then
    raise exception using
      errcode = '22023',
      message = 'Esse endereço está reservado. Escolha outro.';
  end if;

  select *
  into existing_restaurant
  from public.restaurants
  where id = p_id
  for share;

  if found then
    if existing_restaurant.slug <> normalized_slug
      or existing_restaurant.name <> normalized_name
    then
      raise exception using
        errcode = '22023',
        message = 'Este cadastro já existe com outros dados.';
    end if;
  else
    select premium_price_cents into v_price from public.platform_settings where id='default';
    if v_price is null or v_price<=0 then raise exception 'Invalid Premium price' using errcode='22023';end if;
    insert into public.restaurants (
      id,
      name,
      slug,
      subtitle,
      active, subscription_plan, subscription_started_at, subscription_expires_at, billing_cycle_days, subscription_is_trial, max_tables, unlimited_tables, monthly_price_cents
    )
    values (
      p_id,
      normalized_name,
      normalized_slug,
      '',
      true, 'premium', v_now, v_now+interval '168 hours', 7, true, null, true, v_price
    );
    insert into subscription_quote_private.trial_terms(restaurant_id,original_start,original_end,evidence_source)values(p_id,v_now,v_now+interval '168 hours','onboarding_premium_168h');
  end if;

  -- Se o vínculo falhar, o cadastro novo também é desfeito.
  perform public.assume_platform_restaurant_setup(p_id);

  return jsonb_build_object(
    'id', p_id,
    'name', normalized_name,
    'slug', normalized_slug
  );

exception
  when unique_violation then
    raise exception using
      errcode = '22023',
      message = 'Esse cadastro ou endereço já existe. Atualize a lista.';
end;
$$;
revoke all on all functions in schema subscription_quote_private from public,anon,authenticated,service_role;
commit;
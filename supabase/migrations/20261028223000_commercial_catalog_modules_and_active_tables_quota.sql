-- =============================================================================
-- ELOOZI — ETAPA 3: MODELO COMERCIAL, MÓDULOS POR PLANO E MESAS SIMULTÂNEAS
-- =============================================================================
-- 1. Catálogo comercial aprovado (platform_settings id='default'):
--    - Básico: R$ 99,90/mês (9990), Anual R$ 1.098,90 (11x = 109890), 5 mesas simultâneas
--    - Profissional: R$ 179,90/mês (17990), Anual R$ 1.978,90 (11x = 197890), 20 mesas simultâneas
--    - Premium: R$ 279,90/mês (27990), Anual R$ 3.078,90 (11x = 307890), Mesas simultâneas ilimitadas
-- 2. Representação explícita de mesas ilimitadas (unlimited_tables = true e max_tables IS NULL).
-- 3. Não retroatividade: faturas existentes, assinaturas pagas/ativas e direitos de módulos
--    de contratos vigentes (Estoque e Financeiro) não são alterados retroativamente.
-- 4. Controle de mesas estritamente por quantidade simultaneamente ativa, nunca por table_number.
-- 5. Permissões no servidor:
--    - KDS: Profissional e Premium (com validação de vínculo ativo na equipe do restaurante)
--    - Estoque / Insumos e Financeiro: mantidas as regras anteriores até versionamento de contratos
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. ESTRUTURA EXPLÍCITA DE CAPACIDADE ILIMITADA EM platform_settings E restaurants
-- -----------------------------------------------------------------------------

alter table public.platform_settings
  add column if not exists basic_unlimited_tables boolean not null default false,
  add column if not exists pro_unlimited_tables boolean not null default false,
  add column if not exists premium_unlimited_tables boolean not null default true;

alter table public.platform_settings
  alter column basic_max_tables drop not null,
  alter column pro_max_tables drop not null,
  alter column premium_max_tables drop not null,
  alter column premium_max_tables set default null;

alter table public.platform_settings
  drop constraint if exists platform_settings_basic_max_tables_check,
  drop constraint if exists platform_settings_pro_max_tables_check,
  drop constraint if exists platform_settings_premium_max_tables_check,
  drop constraint if exists platform_settings_basic_capacity_check,
  drop constraint if exists platform_settings_pro_capacity_check,
  drop constraint if exists platform_settings_premium_capacity_check;

-- Atualizar catálogo oficial (id = 'default') para os valores comerciais fechados
update public.platform_settings
set
  basic_price_cents = 9990,
  basic_max_tables = 5,
  basic_unlimited_tables = false,
  pro_price_cents = 17990,
  pro_max_tables = 20,
  pro_unlimited_tables = false,
  premium_price_cents = 27990,
  premium_max_tables = null,
  premium_unlimited_tables = true,
  updated_at = timezone('utc', now())
where id = 'default';

-- Garantir consistência caso alguma linha auxiliar exista
update public.platform_settings
set
  basic_max_tables = case when basic_unlimited_tables then null else coalesce(basic_max_tables, 5) end,
  pro_max_tables = case when pro_unlimited_tables then null else coalesce(pro_max_tables, 20) end,
  premium_max_tables = case when premium_unlimited_tables then null else coalesce(premium_max_tables, 100) end
where id <> 'default';

alter table public.platform_settings
  add constraint platform_settings_basic_capacity_check check (
    (basic_unlimited_tables = true and basic_max_tables is null)
    or (basic_unlimited_tables = false and basic_max_tables is not null and basic_max_tables between 1 and 500)
  ),
  add constraint platform_settings_pro_capacity_check check (
    (pro_unlimited_tables = true and pro_max_tables is null)
    or (pro_unlimited_tables = false and pro_max_tables is not null and pro_max_tables between 1 and 500)
  ),
  add constraint platform_settings_premium_capacity_check check (
    (premium_unlimited_tables = true and premium_max_tables is null)
    or (premium_unlimited_tables = false and premium_max_tables is not null and premium_max_tables between 1 and 500)
  );

-- Adicionar flag explícita unlimited_tables em public.restaurants sem alterar registros existentes
alter table public.restaurants
  add column if not exists unlimited_tables boolean not null default false;

alter table public.restaurants
  alter column max_tables drop not null,
  alter column max_tables set default 5;

alter table public.restaurants
  drop constraint if exists restaurants_max_tables_check,
  drop constraint if exists restaurants_tables_capacity_check;

alter table public.restaurants
  add constraint restaurants_tables_capacity_check check (
    (unlimited_tables = true and max_tables is null)
    or (unlimited_tables = false and max_tables is not null and max_tables between 1 and 500)
  );

-- -----------------------------------------------------------------------------
-- 2. ATUALIZAR update_platform_plan_catalog E get_platform_branding
-- -----------------------------------------------------------------------------

drop function if exists public.update_platform_plan_catalog(integer, integer, integer, integer, integer, integer);
drop function if exists public.update_platform_plan_catalog(integer, integer, integer, integer, integer, integer, boolean);
drop function if exists public.update_platform_plan_catalog(integer, integer, integer, integer, integer, integer, boolean, boolean, boolean);
drop function if exists public.update_platform_plan_catalog(integer, integer, integer, integer, integer, integer, boolean, boolean, boolean, boolean);

create or replace function public.update_platform_plan_catalog(
  p_basic_price_cents integer,
  p_basic_max_tables integer,
  p_pro_price_cents integer,
  p_pro_max_tables integer,
  p_premium_price_cents integer,
  p_premium_max_tables integer default null,
  p_sync_existing_restaurants boolean default false,
  p_basic_unlimited_tables boolean default null,
  p_pro_unlimited_tables boolean default null,
  p_premium_unlimited_tables boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_basic_unlimited boolean;
  v_pro_unlimited boolean;
  v_premium_unlimited boolean;
  v_basic_max integer;
  v_pro_max integer;
  v_premium_max integer;
  v_synced_count integer := 0;
  v_actor_email text;
  r record;
begin
  if not public.is_platform_admin() then
    raise exception 'Acesso negado: apenas superadministradores da plataforma podem editar o catálogo de planos.'
      using errcode = '42501';
  end if;

  if p_basic_price_cents is null or p_basic_price_cents < 0
     or p_pro_price_cents is null or p_pro_price_cents < 0
     or p_premium_price_cents is null or p_premium_price_cents < 0 then
    raise exception 'Preços dos planos não podem ser negativos ou nulos.'
      using errcode = '22023';
  end if;

  -- Resolução estrita para Básico: diferencia limite numérico, ilimitado explícito e campo ausente
  if p_basic_unlimited_tables is true then
    if p_basic_max_tables is not null then
      raise exception 'Plano Básico: não informe limite numérico quando mesas ilimitadas estiver ativo.'
        using errcode = '22023';
    end if;
    v_basic_unlimited := true;
    v_basic_max := null;
  elsif p_basic_max_tables is not null then
    if p_basic_max_tables not between 1 and 500 then
      raise exception 'Plano Básico: o limite de mesas deve ser entre 1 e 500.'
        using errcode = '22023';
    end if;
    v_basic_unlimited := false;
    v_basic_max := p_basic_max_tables;
  else
    raise exception 'Plano Básico: informe um limite numérico de mesas (1 a 500) ou marque explicitamente como ilimitado.'
      using errcode = '22023';
  end if;

  -- Resolução estrita para Profissional: diferencia limite numérico, ilimitado explícito e campo ausente
  if p_pro_unlimited_tables is true then
    if p_pro_max_tables is not null then
      raise exception 'Plano Profissional: não informe limite numérico quando mesas ilimitadas estiver ativo.'
        using errcode = '22023';
    end if;
    v_pro_unlimited := true;
    v_pro_max := null;
  elsif p_pro_max_tables is not null then
    if p_pro_max_tables not between 1 and 500 then
      raise exception 'Plano Profissional: o limite de mesas deve ser entre 1 e 500.'
        using errcode = '22023';
    end if;
    v_pro_unlimited := false;
    v_pro_max := p_pro_max_tables;
  else
    raise exception 'Plano Profissional: informe um limite numérico de mesas (1 a 500) ou marque explicitamente como ilimitado.'
      using errcode = '22023';
  end if;

  -- Resolução estrita para Premium: diferencia limite numérico, ilimitado explícito e campo ausente
  if p_premium_unlimited_tables is true then
    if p_premium_max_tables is not null then
      raise exception 'Plano Premium: não informe limite numérico quando mesas ilimitadas estiver ativo.'
        using errcode = '22023';
    end if;
    v_premium_unlimited := true;
    v_premium_max := null;
  elsif p_premium_max_tables is not null then
    if p_premium_max_tables not between 1 and 500 then
      raise exception 'Plano Premium: o limite de mesas deve ser entre 1 e 500.'
        using errcode = '22023';
    end if;
    v_premium_unlimited := false;
    v_premium_max := p_premium_max_tables;
  else
    raise exception 'Plano Premium: informe um limite numérico de mesas (1 a 500) ou marque explicitamente como ilimitado.'
      using errcode = '22023';
  end if;

  insert into public.platform_settings (
    id,
    basic_price_cents,
    pro_price_cents,
    premium_price_cents,
    basic_max_tables,
    pro_max_tables,
    premium_max_tables,
    basic_unlimited_tables,
    pro_unlimited_tables,
    premium_unlimited_tables,
    updated_at
  ) values (
    'default',
    p_basic_price_cents,
    p_pro_price_cents,
    p_premium_price_cents,
    v_basic_max,
    v_pro_max,
    v_premium_max,
    v_basic_unlimited,
    v_pro_unlimited,
    v_premium_unlimited,
    timezone('utc', now())
  )
  on conflict (id) do update set
    basic_price_cents = excluded.basic_price_cents,
    pro_price_cents = excluded.pro_price_cents,
    premium_price_cents = excluded.premium_price_cents,
    basic_max_tables = excluded.basic_max_tables,
    pro_max_tables = excluded.pro_max_tables,
    premium_max_tables = excluded.premium_max_tables,
    basic_unlimited_tables = excluded.basic_unlimited_tables,
    pro_unlimited_tables = excluded.pro_unlimited_tables,
    premium_unlimited_tables = excluded.premium_unlimited_tables,
    updated_at = excluded.updated_at;

  if p_sync_existing_restaurants is true then
    with updated_basic as (
      update public.restaurants
      set monthly_price_cents = p_basic_price_cents,
          max_tables = v_basic_max,
          unlimited_tables = v_basic_unlimited
      where subscription_plan = 'basic'
      returning 1
    ),
    updated_pro as (
      update public.restaurants
      set monthly_price_cents = p_pro_price_cents,
          max_tables = v_pro_max,
          unlimited_tables = v_pro_unlimited
      where subscription_plan = 'pro'
      returning 1
    ),
    updated_premium as (
      update public.restaurants
      set monthly_price_cents = p_premium_price_cents,
          max_tables = v_premium_max,
          unlimited_tables = v_premium_unlimited
      where subscription_plan = 'premium'
      returning 1
    )
    select (
      (select count(*) from updated_basic) +
      (select count(*) from updated_pro) +
      (select count(*) from updated_premium)
    )::int into v_synced_count;

    for r in select id from public.restaurants loop
      perform public.sync_restaurant_tables_to_plan_limit(r.id);
    end loop;
  end if;

  v_actor_email := coalesce(nullif(current_setting('request.jwt.claim.email', true), ''), 'superadmin');

  insert into public.platform_audit_logs (
    action,
    target_restaurant_id,
    target_restaurant_name,
    actor_email,
    details
  ) values (
    'catalog_updated',
    null,
    'Catálogo Global',
    v_actor_email,
    jsonb_build_object(
      'basicPriceCents', p_basic_price_cents,
      'basicMaxTables', v_basic_max,
      'basicUnlimitedTables', v_basic_unlimited,
      'proPriceCents', p_pro_price_cents,
      'proMaxTables', v_pro_max,
      'proUnlimitedTables', v_pro_unlimited,
      'premiumPriceCents', p_premium_price_cents,
      'premiumMaxTables', v_premium_max,
      'premiumUnlimitedTables', v_premium_unlimited,
      'syncExistingRestaurants', coalesce(p_sync_existing_restaurants, false),
      'syncedRestaurantsCount', v_synced_count
    )
  );

  return jsonb_build_object(
    'success', true,
    'basicPriceCents', p_basic_price_cents,
    'basic_price_cents', p_basic_price_cents,
    'proPriceCents', p_pro_price_cents,
    'pro_price_cents', p_pro_price_cents,
    'premiumPriceCents', p_premium_price_cents,
    'premium_price_cents', p_premium_price_cents,
    'basicMaxTables', v_basic_max,
    'basic_max_tables', v_basic_max,
    'proMaxTables', v_pro_max,
    'pro_max_tables', v_pro_max,
    'premiumMaxTables', v_premium_max,
    'premium_max_tables', v_premium_max,
    'basicUnlimitedTables', v_basic_unlimited,
    'basic_unlimited_tables', v_basic_unlimited,
    'proUnlimitedTables', v_pro_unlimited,
    'pro_unlimited_tables', v_pro_unlimited,
    'premiumUnlimitedTables', v_premium_unlimited,
    'premium_unlimited_tables', v_premium_unlimited,
    'syncedRestaurantsCount', v_synced_count
  );
end;
$$;

revoke all on function public.update_platform_plan_catalog(integer, integer, integer, integer, integer, integer, boolean, boolean, boolean, boolean) from public, anon;
grant execute on function public.update_platform_plan_catalog(integer, integer, integer, integer, integer, integer, boolean, boolean, boolean, boolean) to authenticated;

create or replace function public.get_platform_branding()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings record;
begin
  select *
  into v_settings
  from public.platform_settings
  where id = 'default';

  if not found then
    return jsonb_build_object(
      'platformName', 'Elozi',
      'platformSubtitle', 'Administração da Plataforma',
      'platformLogoUrl', null,
      'superadminName', 'SuperAdmin',
      'superadminAvatarUrl', null,
      'updatedAt', timezone('utc', now()),
      'basicPriceCents', 9990,
      'basic_price_cents', 9990,
      'basicMaxTables', 5,
      'basic_max_tables', 5,
      'basicUnlimitedTables', false,
      'basic_unlimited_tables', false,
      'proPriceCents', 17990,
      'pro_price_cents', 17990,
      'proMaxTables', 20,
      'pro_max_tables', 20,
      'proUnlimitedTables', false,
      'pro_unlimited_tables', false,
      'premiumPriceCents', 27990,
      'premium_price_cents', 27990,
      'premiumMaxTables', null,
      'premium_max_tables', null,
      'premiumUnlimitedTables', true,
      'premium_unlimited_tables', true
    );
  end if;

  return jsonb_build_object(
    'platformName', v_settings.platform_name,
    'platformSubtitle', v_settings.platform_subtitle,
    'platformLogoUrl', v_settings.platform_logo_url,
    'superadminName', v_settings.superadmin_name,
    'superadminAvatarUrl', v_settings.superadmin_avatar_url,
    'updatedAt', v_settings.updated_at,
    'basicPriceCents', coalesce(v_settings.basic_price_cents, 9990),
    'basic_price_cents', coalesce(v_settings.basic_price_cents, 9990),
    'basicMaxTables', case when coalesce(v_settings.basic_unlimited_tables, false) then null else coalesce(v_settings.basic_max_tables, 5) end,
    'basic_max_tables', case when coalesce(v_settings.basic_unlimited_tables, false) then null else coalesce(v_settings.basic_max_tables, 5) end,
    'basicUnlimitedTables', coalesce(v_settings.basic_unlimited_tables, false),
    'basic_unlimited_tables', coalesce(v_settings.basic_unlimited_tables, false),
    'proPriceCents', coalesce(v_settings.pro_price_cents, 17990),
    'pro_price_cents', coalesce(v_settings.pro_price_cents, 17990),
    'proMaxTables', case when coalesce(v_settings.pro_unlimited_tables, false) then null else coalesce(v_settings.pro_max_tables, 20) end,
    'pro_max_tables', case when coalesce(v_settings.pro_unlimited_tables, false) then null else coalesce(v_settings.pro_max_tables, 20) end,
    'proUnlimitedTables', coalesce(v_settings.pro_unlimited_tables, false),
    'pro_unlimited_tables', coalesce(v_settings.pro_unlimited_tables, false),
    'premiumPriceCents', coalesce(v_settings.premium_price_cents, 27990),
    'premium_price_cents', coalesce(v_settings.premium_price_cents, 27990),
    'premiumMaxTables', case when coalesce(v_settings.premium_unlimited_tables, false) then null else v_settings.premium_max_tables end,
    'premium_max_tables', case when coalesce(v_settings.premium_unlimited_tables, false) then null else v_settings.premium_max_tables end,
    'premiumUnlimitedTables', coalesce(v_settings.premium_unlimited_tables, false),
    'premium_unlimited_tables', coalesce(v_settings.premium_unlimited_tables, false)
  );
end;
$$;

revoke all on function public.get_platform_branding() from public, anon, authenticated;
grant execute on function public.get_platform_branding() to authenticated, anon;

-- -----------------------------------------------------------------------------
-- 3. SINCRONIZAÇÃO E BLOQUEIO DE MESAS POR CONTAGEM SIMULTÂNEA ATIVA
-- -----------------------------------------------------------------------------

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
  select r.max_tables, coalesce(r.unlimited_tables, false)
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

-- Internal helper: only the owning SECURITY DEFINER RPCs may synchronize tables.
-- CREATE OR REPLACE preserves ACLs, including the historical authenticated grant.
revoke all on function public.sync_restaurant_tables_to_plan_limit(uuid)
  from public, anon, authenticated, service_role;

-- Trigger que impede ativar ou inserir mais mesas ativas simultâneas que o limite (com lock FOR UPDATE no restaurante)
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
  select r.max_tables, coalesce(r.unlimited_tables, false)
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

-- get_admin_tables: usa contagem ativa simultânea (sem bloquear por t.table_number > v_max_tables)
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

  select r.max_tables, coalesce(r.unlimited_tables, false)
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

revoke all on function public.get_admin_tables(text) from public, anon, authenticated;
grant execute on function public.get_admin_tables(text) to authenticated;

-- open_table_visit: valida assinatura + cota de mesas simultâneas ativas (nunca por p_table_number > v_max_tables)
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
    coalesce(restaurant.unlimited_tables, false),
    restaurant.max_tables,
    restaurant.subscription_expires_at,
    coalesce(restaurant.subscription_is_trial, false)
  into
    target_restaurant_id,
    v_unlimited_tables,
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

revoke all on function public.open_table_visit(text, integer) from public, anon;
grant execute on function public.open_table_visit(text, integer) to authenticated;

-- Ao liberar ou encerrar mesa, se o restaurante estiver com mesas ativas excedentes (ex.: pós-downgrade),
-- sincroniza automaticamente com o limite do plano atual.
create or replace function public.reset_and_release_table(p_table_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table public.restaurant_tables%rowtype;
  v_member_id uuid;
begin
  if p_table_id is null then
    raise exception using errcode = '22023', message = 'Informe a mesa a ser liberada.';
  end if;

  select * into v_table
  from public.restaurant_tables
  where id = p_table_id
    and deleted_at is null
  for update;

  if not found then
    raise exception using errcode = '22023', message = 'Mesa não encontrada.';
  end if;

  -- Trava de autorização
  if not (
    public.is_platform_admin()
    or exists (
      select 1
      from public.restaurant_members as m
      where m.restaurant_id = v_table.restaurant_id
        and m.user_id = (select auth.uid())
        and m.active = true
        and m.role in ('admin', 'waiter')
    )
  ) then
    raise exception using errcode = '42501', message = 'Acesso não autorizado para liberar esta mesa.';
  end if;

  select id into v_member_id
  from public.restaurant_members
  where restaurant_id = v_table.restaurant_id
    and user_id = (select auth.uid())
  limit 1;

  -- 1. Encerrar comandas abertas da mesa primeiro (para satisfazer prevent_visit_close_with_open_tabs)
  update public.table_tabs
  set status = 'closed',
      closed_by_member_id = v_member_id,
      closed_at = timezone('utc', now())
  where restaurant_table_id = p_table_id
    and status = 'open';

  -- 2. Encerrar atendimentos abertos da mesa
  update public.table_visits
  set status = 'closed',
      closed_at = timezone('utc', now())
  where restaurant_table_id = p_table_id
    and status = 'open';

  -- 3. Encerrar solicitações de serviço pendentes
  update public.service_requests
  set status = 'cancelled',
      resolved_at = timezone('utc', now()),
      resolved_by_member_id = v_member_id
  where restaurant_table_id = p_table_id
    and status = 'pending';

  -- 4. Marcar alertas da mesa como lidos
  update public.restaurant_alerts
  set is_read = true
  where reference_id = p_table_id
    and is_read = false;

  -- 5. Sincronizar mesas excedentes caso tenha ocorrido redução de plano enquanto esta mesa estava ocupada
  perform public.sync_restaurant_tables_to_plan_limit(v_table.restaurant_id);

  return jsonb_build_object(
    'success', true,
    'tableId', p_table_id,
    'tableNumber', v_table.table_number,
    'message', 'Mesa liberada e pronta para o próximo cliente.'
  );
end;
$$;

revoke all on function public.reset_and_release_table(uuid) from public, anon;
grant execute on function public.reset_and_release_table(uuid) to authenticated;

create or replace function public.close_table_visit(
  p_restaurant_slug text,
  p_table_visit_id uuid
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
  checked_at timestamptz;
begin
  current_user_id := auth.uid();

  if current_user_id is null
    or coalesce(
      (auth.jwt() ->> 'is_anonymous')::boolean,
      false
    )
  then
    raise exception using
      errcode = '42501',
      message = 'Entre com uma conta da equipe.';
  end if;

  if p_table_visit_id is null then
    raise exception using
      errcode = '22023',
      message = 'Informe o atendimento que deseja encerrar.';
  end if;

  select restaurant.id
  into target_restaurant_id
  from public.restaurants as restaurant
  where restaurant.slug = p_restaurant_slug
    and restaurant.active = true
  for share;

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

  select visit.restaurant_table_id
  into target_table_id
  from public.table_visits as visit
  where visit.id = p_table_visit_id
    and visit.restaurant_id = target_restaurant_id;

  if target_table_id is null then
    raise exception using
      errcode = '22023',
      message = 'Atendimento não encontrado neste restaurante.';
  end if;

  perform restaurant_table.id
  from public.restaurant_tables as restaurant_table
  where restaurant_table.id = target_table_id
    and restaurant_table.restaurant_id = target_restaurant_id
  for update;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'Mesa não encontrada.';
  end if;

  select visit.*
  into target_visit
  from public.table_visits as visit
  where visit.id = p_table_visit_id
    and visit.restaurant_id = target_restaurant_id
    and visit.restaurant_table_id = target_table_id
  for update;

  if not found then
    raise exception using
      errcode = '22023',
      message = 'Atendimento não encontrado.';
  end if;

  if target_visit.assigned_member_id
    is distinct from target_member_id
  then
    raise exception using
      errcode = '42501',
      message = 'Somente o responsável pode encerrar este atendimento.';
  end if;

  if target_visit.status = 'closed' then
    return target_visit;
  end if;

  if exists (
    select 1
    from public.table_tabs as tab
    where tab.table_visit_id = target_visit.id
      and tab.status = 'open'
  ) then
    raise exception using
      errcode = '22023',
      message = 'Encerre todas as comandas abertas antes de finalizar o atendimento da mesa.';
  end if;

  checked_at := greatest(
    clock_timestamp(),
    target_visit.opened_at
  );

  update public.guest_sessions
  set status = 'revoked'
  where restaurant_id = target_restaurant_id
    and restaurant_table_id = target_table_id
    and status in ('pending', 'active');

  update public.service_requests
  set
    status = 'cancelled',
    resolved_at = greatest(checked_at, created_at),
    resolved_by_member_id = target_member_id
  where restaurant_id = target_restaurant_id
    and restaurant_table_id = target_table_id
    and status = 'pending';

  update public.table_visits
  set
    status = 'closed',
    closed_at = checked_at
  where id = target_visit.id
  returning * into target_visit;

  -- Sincroniza mesas excedentes caso tenha ocorrido redução de plano enquanto esta mesa estava ocupada
  perform public.sync_restaurant_tables_to_plan_limit(target_restaurant_id);

  return target_visit;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. FATURAMENTO E CATÁLOGO: get_restaurant_billing_summary & confirm_subscription_invoice_payment
-- -----------------------------------------------------------------------------

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

  select count(*)::int into v_tables_count
  from public.restaurant_tables
  where restaurant_id = p_restaurant_id
    and deleted_at is null
    and coalesce(is_active, active, true) = true;

  select count(*)::int into v_products_count
  from public.menu_products
  where restaurant_id = p_restaurant_id
    and available = true;

  select coalesce(jsonb_agg(inv_row), '[]'::jsonb)
  into v_invoices
  from (
    select
      i.id,
      i.plan_id,
      i.billing_cycle,
      i.amount_cents,
      i.payment_method,
      i.status,
      i.pix_qr_code_payload,
      i.pix_expires_at,
      i.card_brand,
      i.card_last4,
      i.external_reference,
      i.paid_at,
      i.created_at
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
      'max_tables', case when coalesce(v_restaurant.unlimited_tables, false) then null else v_restaurant.max_tables end,
      'unlimited_tables', coalesce(v_restaurant.unlimited_tables, false),
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
        'yearly_price_cents', v_settings.basic_price_cents * 11,
        'max_tables', case when coalesce(v_settings.basic_unlimited_tables, false) then null else v_settings.basic_max_tables end,
        'unlimited_tables', coalesce(v_settings.basic_unlimited_tables, false),
        'features', jsonb_build_array(
          case
            when coalesce(v_settings.basic_unlimited_tables, false) then 'Mesas simultâneas ilimitadas'
            else format('Até %s mesas simultâneas', v_settings.basic_max_tables)
          end,
          'Cardápio Digital com QR Code',
          'Pedidos e comandas em tempo real'
        )
      ),
      'pro', jsonb_build_object(
        'plan_id', 'pro',
        'name', 'Plano Profissional',
        'monthly_price_cents', v_settings.pro_price_cents,
        'yearly_price_cents', v_settings.pro_price_cents * 11,
        'max_tables', case when coalesce(v_settings.pro_unlimited_tables, false) then null else v_settings.pro_max_tables end,
        'unlimited_tables', coalesce(v_settings.pro_unlimited_tables, false),
        'features', jsonb_build_array(
          case
            when coalesce(v_settings.pro_unlimited_tables, false) then 'Mesas simultâneas ilimitadas'
            else format('Até %s mesas simultâneas', v_settings.pro_max_tables)
          end,
          'Tudo do plano Básico',
          'KDS Cozinha e Bar'
        )
      ),
      'premium', jsonb_build_object(
        'plan_id', 'premium',
        'name', 'Plano Premium',
        'monthly_price_cents', v_settings.premium_price_cents,
        'yearly_price_cents', v_settings.premium_price_cents * 11,
        'max_tables', case when coalesce(v_settings.premium_unlimited_tables, false) then null else v_settings.premium_max_tables end,
        'unlimited_tables', coalesce(v_settings.premium_unlimited_tables, false),
        'features', jsonb_build_array(
          case
            when coalesce(v_settings.premium_unlimited_tables, false) then 'Mesas simultâneas ilimitadas'
            else format('Até %s mesas simultâneas', v_settings.premium_max_tables)
          end,
          'Tudo do plano Profissional',
          'Gestão de Estoque e Insumos',
          'Financeiro e Fechamento de Caixa'
        )
      )
    ),
    'invoices', v_invoices,
    'payment_methods', v_methods
  );
end;
$$;

revoke all on function public.get_restaurant_billing_summary(uuid) from public, anon;
grant execute on function public.get_restaurant_billing_summary(uuid) to authenticated;

-- confirm_subscription_invoice_payment: aplica max_tables / unlimited_tables do catálogo e 365 dias no anual
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

  if v_restaurant.subscription_expires_at is not null and v_restaurant.subscription_expires_at > v_now then
    v_new_expires_at := v_restaurant.subscription_expires_at + (v_cycle_days || ' days')::interval;
  else
    v_new_expires_at := v_now + (v_cycle_days || ' days')::interval;
  end if;

  update public.subscription_invoices
  set status = 'paid', paid_at = v_now, external_reference = v_ext_ref,
      gateway_emission_status = 'issued'
  where id = v_invoice.id;

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

revoke all on function public.confirm_subscription_invoice_payment(uuid, text, integer, uuid) from public, anon, authenticated;
grant execute on function public.confirm_subscription_invoice_payment(uuid, text, integer, uuid) to service_role;

-- -----------------------------------------------------------------------------
-- 5. ATUALIZAR FUNÇÕES DE IDENTIDADE PÚBLICA E GESTÃO SUPERADMIN
-- -----------------------------------------------------------------------------

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
  from public.restaurants as r
  where r.slug = p_slug
    and r.active = true;
$$;

revoke all on function public.get_public_restaurant(text) from public;
grant execute on function public.get_public_restaurant(text) to anon, authenticated;

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
          'archivedAt', restaurant.archived_at,
          'logo_url', restaurant.logo_url,
          'cover_url', restaurant.cover_url,
          'createdAt', restaurant.created_at,
          'created_at', restaurant.created_at,
          'updated_at', restaurant.updated_at,
          'adminCount', (
            select count(*)::integer
            from public.restaurant_members as member
            where member.restaurant_id = restaurant.id
              and member.role = 'admin'
              and member.active = true
          ),
          'adminEmails', coalesce(
            (
              select jsonb_agg(u.email)
              from public.restaurant_members as member
              join auth.users as u on u.id = member.user_id
              where member.restaurant_id = restaurant.id
                and member.role = 'admin'
                and member.active = true
                and u.email is not null
            ),
            '[]'::jsonb
          ),
          'subscriptionPlan', restaurant.subscription_plan,
          'subscription_plan', restaurant.subscription_plan,
          'maxTables', case when coalesce(restaurant.unlimited_tables, false) then null else coalesce(restaurant.max_tables, 5) end,
          'max_tables', case when coalesce(restaurant.unlimited_tables, false) then null else coalesce(restaurant.max_tables, 5) end,
          'unlimitedTables', coalesce(restaurant.unlimited_tables, false),
          'unlimited_tables', coalesce(restaurant.unlimited_tables, false),
          'monthlyPriceCents', coalesce(restaurant.monthly_price_cents, 9990),
          'monthly_price_cents', coalesce(restaurant.monthly_price_cents, 9990),
          'activeTablesCount', (
            select count(*)::integer
            from public.restaurant_tables as t
            where t.restaurant_id = restaurant.id
              and t.deleted_at is null
              and (t.active = true or t.is_active = true)
          ),
          'active_tables_count', (
            select count(*)::integer
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

drop function if exists public.update_restaurant_saas_plan(uuid, text, integer, integer, integer, boolean);
drop function if exists public.update_restaurant_saas_plan(uuid, text, integer, integer, integer, boolean, boolean);

create or replace function public.update_restaurant_saas_plan(
  p_restaurant_id uuid,
  p_plan text,
  p_monthly_price_cents integer default null,
  p_max_tables integer default null,
  p_billing_cycle_days integer default null,
  p_renew_cycle boolean default false,
  p_unlimited_tables boolean default null
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
  v_unlimited_tables boolean;
  v_cycle_days integer;
  v_default_price integer;
  v_default_max_tables integer;
  v_default_unlimited boolean;
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
    r.active,
    r.archived_at,
    r.subscription_plan,
    r.monthly_price_cents,
    r.max_tables,
    r.unlimited_tables,
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
    select basic_price_cents, basic_max_tables, coalesce(basic_unlimited_tables, false)
    into v_default_price, v_default_max_tables, v_default_unlimited
    from public.platform_settings where id = 'default';
  elsif v_plan = 'pro' then
    select pro_price_cents, pro_max_tables, coalesce(pro_unlimited_tables, false)
    into v_default_price, v_default_max_tables, v_default_unlimited
    from public.platform_settings where id = 'default';
  else
    select premium_price_cents, premium_max_tables, coalesce(premium_unlimited_tables, true)
    into v_default_price, v_default_max_tables, v_default_unlimited
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

  if p_unlimited_tables is true then
    if p_max_tables is not null then
      raise exception 'Não informe limite numérico de mesas quando mesas ilimitadas estiver ativo.'
        using errcode = '22023';
    end if;
    v_unlimited_tables := true;
    v_max_tables := null;
  elsif p_unlimited_tables is false then
    if p_max_tables is not null then
      if p_max_tables not between 1 and 500 then
        raise exception 'Limite de mesas deve ser entre 1 e 500.' using errcode = '22023';
      end if;
      v_unlimited_tables := false;
      v_max_tables := p_max_tables;
    elsif v_default_max_tables is not null and v_default_max_tables between 1 and 500 then
      v_unlimited_tables := false;
      v_max_tables := v_default_max_tables;
    else
      raise exception 'Informe um limite numérico de mesas entre 1 e 500.' using errcode = '22023';
    end if;
  else
    if p_max_tables is not null then
      if p_max_tables not between 1 and 500 then
        raise exception 'Limite de mesas deve ser entre 1 e 500.' using errcode = '22023';
      end if;
      v_unlimited_tables := false;
      v_max_tables := p_max_tables;
    else
      v_unlimited_tables := coalesce(v_default_unlimited, v_plan = 'premium');
      v_max_tables := case when v_unlimited_tables then null else v_default_max_tables end;
    end if;
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
    unlimited_tables = v_unlimited_tables,
    billing_cycle_days = v_cycle_days,
    subscription_started_at = v_started_at,
    subscription_expires_at = v_expires_at,
    subscription_is_trial = false
  where id = p_restaurant_id
  returning
    id,
    name,
    slug,
    active,
    archived_at,
    subscription_plan,
    monthly_price_cents,
    max_tables,
    unlimited_tables,
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
      'unlimitedTables', v_updated.unlimited_tables,
      'billingCycleDays', v_updated.billing_cycle_days,
      'renewCycle', coalesce(p_renew_cycle, false),
      'subscriptionIsTrial', false
    )
  );

  return jsonb_build_object(
    'id', v_updated.id,
    'name', v_updated.name,
    'slug', v_updated.slug,
    'active', v_updated.active,
    'archivedAt', v_updated.archived_at,
    'archived_at', v_updated.archived_at,
    'subscriptionPlan', v_updated.subscription_plan,
    'subscription_plan', v_updated.subscription_plan,
    'monthlyPriceCents', v_updated.monthly_price_cents,
    'monthly_price_cents', v_updated.monthly_price_cents,
    'maxTables', v_updated.max_tables,
    'max_tables', v_updated.max_tables,
    'unlimitedTables', v_updated.unlimited_tables,
    'unlimited_tables', v_updated.unlimited_tables,
    'activeTablesCount', (
      select count(*)::int
      from public.restaurant_tables as t
      where t.restaurant_id = v_updated.id
        and t.deleted_at is null
        and (t.active = true or t.is_active = true)
    ),
    'active_tables_count', (
      select count(*)::int
      from public.restaurant_tables as t
      where t.restaurant_id = v_updated.id
        and t.deleted_at is null
        and (t.active = true or t.is_active = true)
    ),
    'billingCycleDays', v_updated.billing_cycle_days,
    'billing_cycle_days', v_updated.billing_cycle_days,
    'subscriptionStartedAt', v_updated.subscription_started_at,
    'subscription_started_at', v_updated.subscription_started_at,
    'subscriptionExpiresAt', v_updated.subscription_expires_at,
    'subscription_expires_at', v_updated.subscription_expires_at,
    'subscriptionIsTrial', v_updated.subscription_is_trial,
    'subscription_is_trial', v_updated.subscription_is_trial,
    'daysRemaining', ceil(extract(epoch from (v_updated.subscription_expires_at - now())) / 86400.0)::int,
    'days_remaining', ceil(extract(epoch from (v_updated.subscription_expires_at - now())) / 86400.0)::int,
    'billingStatus', public.get_restaurant_billing_status(v_updated.subscription_expires_at, v_updated.subscription_is_trial),
    'billing_status', public.get_restaurant_billing_status(v_updated.subscription_expires_at, v_updated.subscription_is_trial)
  );
end;
$$;

revoke all on function public.update_restaurant_saas_plan(uuid, text, integer, integer, integer, boolean, boolean) from public, anon;
grant execute on function public.update_restaurant_saas_plan(uuid, text, integer, integer, integer, boolean, boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- 6. PERMISSÕES DE MÓDULOS POR PLANO NO SERVIDOR (KDS)
-- -----------------------------------------------------------------------------

-- 6.1 KDS: exclusivo dos planos Profissional ('pro') e Premium ('premium')
-- Além do plano, valida que o usuário autenticado pertence à equipe ativa do restaurante (admin/waiter) ou é platform_admin.
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

  select id, subscription_plan
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

revoke all on function public.get_kds_active_items(text) from public, anon, authenticated;
grant execute on function public.get_kds_active_items(text) to authenticated;

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

  select restaurant.id, restaurant.subscription_plan
  into target_restaurant_id, target_subscription_plan
  from public.restaurants as restaurant
  where restaurant.slug = p_restaurant_slug
    and restaurant.active = true
  for share;

  if not found then
    raise exception using
      errcode = '42501',
      message = 'Restaurante indisponível.';
  end if;

  if target_subscription_plan not in ('pro', 'premium') then
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

  if not found and not public.is_platform_admin() then
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

  select *
  into target_visit
  from public.table_visits
  where id = target_visit_id
  for share;

  if not found or target_visit.status <> 'open' then
    raise exception using
      errcode = '22023',
      message = 'Atendimento da mesa não está mais aberto.';
  end if;

  select *
  into target_tab
  from public.table_tabs
  where id = target_tab_id
  for share;

  if not found or target_tab.status <> 'open' then
    raise exception using
      errcode = '22023',
      message = 'Comanda não está mais aberta.';
  end if;

  select *
  into target_item
  from public.table_tab_items
  where id = p_item_id
  for update;

  if target_item.production_status = p_target_status then
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
      prep_started_at = coalesce(prep_started_at, timezone('utc', now())),
      prep_ready_at = coalesce(prep_ready_at, timezone('utc', now())),
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

revoke all privileges on function public.update_tab_item_production_status(text, uuid, text) from public, anon, authenticated;
grant execute on function public.update_tab_item_production_status(text, uuid, text) to authenticated;

-- Nota de Não Retroatividade (Etapa 3):
-- As políticas RLS de public.inventory_items, a RPC public.save_menu_product e a RPC
-- public.get_restaurant_financial_report mantêm suas regras anteriores de controle de acesso
-- por papel (role) do estabelecimento. A restrição por plano para Estoque e Financeiro fica
-- separada e pendente de versionamento de contratos para não bloquear retroativamente
-- assinaturas Basic/Pro contratadas sob regras anteriores e ainda vigentes.

commit;

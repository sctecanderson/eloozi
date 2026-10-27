-- ============================================================================
-- TEST SUITE: 20261026160000_batch_cancel_table_tab_items_test.sql
-- Validação da RPC cancel_table_tab_items_batch em PostgreSQL Isolado
--
-- Cobertura de Testes:
-- 1. Autorização do próprio restaurante (garçom ativo do restaurante)
-- 2. Bloqueio de outro restaurante / usuário sem vínculo (42501)
-- 3. Item inexistente (22023)
-- 4. Item já cancelado (retorna sem duplicação nem erro)
-- 5. Rollback integral quando um item do lote falhar (atômico)
-- 6. Lote misto de itens ativos e já cancelados
-- 7. Execução como o papel real anon (privilégio EXECUTE revogado no Postgres -> 42501)
-- 8. Execução como o papel real authenticated (sem vínculo -> 42501; com vínculo garçom -> autorizado)
--
-- Execução estritamente contida em transação isolada com ROLLBACK final.
-- ============================================================================

begin;

-- Garante dependências mínimas necessárias no ambiente de teste
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  created_at timestamptz not null default now()
);

create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated noinherit; end if;
end;
$$;

grant usage on schema public to anon, authenticated;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
grant execute on function auth.jwt() to anon, authenticated;
grant usage on language plpgsql to anon, authenticated;

create table if not exists public.restaurants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.restaurant_tables (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete restrict,
  table_number smallint not null,
  label text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint restaurant_tables_id_restaurant_unique unique (id, restaurant_id)
);

create table if not exists public.restaurant_members (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('admin', 'waiter')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint restaurant_members_unique_user unique (restaurant_id, user_id),
  constraint restaurant_members_id_restaurant_unique unique (id, restaurant_id)
);

create table if not exists public.table_visits (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete restrict,
  restaurant_table_id uuid not null,
  assigned_member_id uuid,
  status text not null default 'open' check (status in ('open', 'closed')),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  constraint table_visits_table_same_restaurant
    foreign key (restaurant_table_id, restaurant_id)
    references public.restaurant_tables (id, restaurant_id) on delete restrict
);

create table if not exists public.table_tabs (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete restrict,
  restaurant_table_id uuid not null,
  table_visit_id uuid not null references public.table_visits(id) on delete restrict,
  label text not null,
  status text not null default 'open' check (status in ('open', 'closed')),
  created_by_member_id uuid not null,
  created_at timestamptz not null default now(),
  closed_by_member_id uuid,
  closed_at timestamptz
);

create table if not exists public.table_tab_items (
  id uuid primary key,
  restaurant_id uuid not null references public.restaurants(id) on delete restrict,
  restaurant_table_id uuid not null,
  table_visit_id uuid not null references public.table_visits(id) on delete restrict,
  table_tab_id uuid not null references public.table_tabs(id) on delete restrict,
  product_id uuid not null,
  product_name text not null,
  unit_price_in_cents integer not null,
  quantity integer not null,
  line_total_in_cents bigint generated always as (unit_price_in_cents::bigint * quantity::bigint) stored,
  status text not null default 'active' check (status in ('active', 'cancelled')),
  added_by_member_id uuid not null,
  created_at timestamptz not null default now(),
  cancelled_by_member_id uuid,
  cancelled_at timestamptz,
  cancellation_reason text
);

grant select on public.table_tab_items to authenticated;

-- Função lock_owned_table_visit de produção para controle de autorização e locking
create or replace function public.lock_owned_table_visit(
  p_restaurant_slug text,
  p_table_visit_id uuid
)
returns public.table_visits language plpgsql security definer set search_path = '' as $$
declare
  current_user_id uuid;
  target_restaurant_id uuid;
  target_member_id uuid;
  target_visit public.table_visits%rowtype;
begin
  current_user_id := auth.uid();

  if current_user_id is null or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception using errcode = '42501', message = 'Entre com uma conta da equipe.';
  end if;

  if p_table_visit_id is null then
    raise exception using errcode = '22023', message = 'Informe o atendimento.';
  end if;

  select restaurant.id into target_restaurant_id
  from public.restaurants as restaurant
  where restaurant.slug = p_restaurant_slug and restaurant.active = true for share;

  if not found then
    raise exception using errcode = '42501', message = 'Restaurante indisponível.';
  end if;

  select member.id into target_member_id
  from public.restaurant_members as member
  where member.restaurant_id = target_restaurant_id
    and member.user_id = current_user_id
    and member.active = true
    and member.role in ('admin', 'waiter') for share;

  if not found then
    raise exception using errcode = '42501', message = 'Sua conta não possui acesso ativo a este restaurante.';
  end if;

  select visit.* into target_visit
  from public.table_visits as visit
  where visit.id = p_table_visit_id and visit.restaurant_id = target_restaurant_id for update;

  if not found then
    raise exception using errcode = '22023', message = 'Atendimento não encontrado neste restaurante.';
  end if;

  return target_visit;
end;
$$;

-- Aplica a migração real oficial para garantir que testamos exatamente a função resultante
\ir ../migrations/20261026160000_batch_cancel_table_tab_items.sql

-- ============================================================================
-- BLOCO PRINCIPAL DE TESTES COM ASSERÇÕES
-- ============================================================================
do $$
declare
  v_rest_a_id uuid := '11111111-1111-4111-a111-111111111111';
  v_rest_b_id uuid := '22222222-2222-4222-a222-222222222222';

  v_user_waiter_a uuid := 'a0000000-0000-4000-a000-000000000001';
  v_user_waiter_b uuid := 'a0000000-0000-4000-a000-000000000002';
  v_user_no_link  uuid := 'a0000000-0000-4000-a000-000000000003';

  v_member_a_id uuid := 'd1111111-1111-4111-a111-111111111111';
  v_member_b_id uuid := 'd2222222-2222-4222-a222-222222222222';

  v_table_a_id uuid := 'e1111111-1111-4111-a111-111111111111';
  v_table_b_id uuid := 'e2222222-2222-4222-a222-222222222222';

  v_visit_open_id   uuid := 'f1111111-1111-4111-a111-111111111111';
  v_visit_closed_id uuid := 'f1111111-1111-4111-a111-222222222222';

  v_tab_open_1_id uuid := 'c1111111-1111-4111-a111-111111111111';
  v_tab_open_2_id uuid := 'c1111111-1111-4111-a111-222222222222';
  v_tab_closed_id uuid := 'c1111111-1111-4111-a111-333333333333';

  v_prod_1_id uuid := 'b1111111-1111-4111-a111-111111111111';
  v_prod_2_id uuid := 'b1111111-1111-4111-a111-222222222222';

  v_item_1_id uuid := '81111111-1111-4111-a111-111111111111';
  v_item_2_id uuid := '81111111-1111-4111-a111-222222222222';
  v_item_3_cancelled_id uuid := '81111111-1111-4111-a111-333333333333';
  v_item_4_tab2_id uuid := '81111111-1111-4111-a111-444444444444';
  v_item_5_closed_tab_id uuid := '81111111-1111-4111-a111-555555555555';
  v_item_6_auth_id uuid := '81111111-1111-4111-a111-666666666666';

  v_returned_count integer;
  v_item_status text;
  v_item_reason text;
  v_caught_code text;
begin
  raise notice '===============================================================';
  raise notice 'INICIANDO TESTES SQL: RPC cancel_table_tab_items_batch';
  raise notice '===============================================================';

  -- 1. SETUP DE DADOS
  insert into auth.users (id, email) values
    (v_user_waiter_a, 'waiter-a@test.eloozi'),
    (v_user_waiter_b, 'waiter-b@test.eloozi'),
    (v_user_no_link,  'nolink@test.eloozi');

  insert into public.restaurants (id, slug, name, active) values
    (v_rest_a_id, 'noma-a', 'Noma Restaurante A', true),
    (v_rest_b_id, 'outro-b', 'Outro Restaurante B', true);

  insert into public.restaurant_members (id, restaurant_id, user_id, role, active) values
    (v_member_a_id, v_rest_a_id, v_user_waiter_a, 'waiter', true),
    (v_member_b_id, v_rest_b_id, v_user_waiter_b, 'waiter', true);

  insert into public.restaurant_tables (id, restaurant_id, table_number, label, active) values
    (v_table_a_id, v_rest_a_id, 1, 'Mesa 1', true),
    (v_table_b_id, v_rest_b_id, 2, 'Mesa 2', true);

  insert into public.table_visits (id, restaurant_id, restaurant_table_id, assigned_member_id, status) values
    (v_visit_open_id, v_rest_a_id, v_table_a_id, v_member_a_id, 'open'),
    (v_visit_closed_id, v_rest_a_id, v_table_a_id, v_member_a_id, 'closed');

  insert into public.table_tabs (id, restaurant_id, restaurant_table_id, table_visit_id, label, status, created_by_member_id) values
    (v_tab_open_1_id, v_rest_a_id, v_table_a_id, v_visit_open_id, 'Pessoa 1', 'open', v_member_a_id),
    (v_tab_open_2_id, v_rest_a_id, v_table_a_id, v_visit_open_id, 'Pessoa 2', 'open', v_member_a_id),
    (v_tab_closed_id, v_rest_a_id, v_table_a_id, v_visit_open_id, 'Pessoa Encerrada', 'closed', v_member_a_id);

  insert into public.table_tab_items (id, restaurant_id, restaurant_table_id, table_visit_id, table_tab_id, product_id, product_name, unit_price_in_cents, quantity, status, added_by_member_id, cancellation_reason, cancelled_by_member_id, cancelled_at) values
    (v_item_1_id, v_rest_a_id, v_table_a_id, v_visit_open_id, v_tab_open_1_id, v_prod_1_id, 'Suco de Laranja', 1200, 1, 'active', v_member_a_id, null, null, null),
    (v_item_2_id, v_rest_a_id, v_table_a_id, v_visit_open_id, v_tab_open_1_id, v_prod_1_id, 'Hambúrguer Artesanal', 3500, 1, 'active', v_member_a_id, null, null, null),
    (v_item_3_cancelled_id, v_rest_a_id, v_table_a_id, v_visit_open_id, v_tab_open_1_id, v_prod_1_id, 'Sobremesa Cancelada', 1500, 1, 'cancelled', v_member_a_id, 'Cancelado anteriormente', v_member_a_id, now()),
    (v_item_4_tab2_id, v_rest_a_id, v_table_a_id, v_visit_open_id, v_tab_open_2_id, v_prod_2_id, 'Água com Gás', 700, 2, 'active', v_member_a_id, null, null, null),
    (v_item_5_closed_tab_id, v_rest_a_id, v_table_a_id, v_visit_open_id, v_tab_closed_id, v_prod_2_id, 'Café Espresso', 800, 1, 'active', v_member_a_id, null, null, null),
    (v_item_6_auth_id, v_rest_a_id, v_table_a_id, v_visit_open_id, v_tab_open_1_id, v_prod_2_id, 'Cerveja Artesanal', 1800, 1, 'active', v_member_a_id, null, null, null);

  -- --------------------------------------------------------------------------
  -- TESTE 1: Autorização do próprio restaurante (garçom ativo cancela lote com 2 itens)
  -- --------------------------------------------------------------------------
  perform set_config('request.jwt.claim.sub', v_user_waiter_a::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_user_waiter_a, 'is_anonymous', false)::text, true);

  select count(*) into v_returned_count
  from public.cancel_table_tab_items_batch(
    'noma-a',
    array[v_item_1_id, v_item_4_tab2_id],
    'Cliente desistiu dos itens'
  )
  where status = 'cancelled' and already_cancelled = false and cancellation_reason = 'Cliente desistiu dos itens';

  if v_returned_count <> 2 then
    raise exception 'TESTE 1 FALHOU: esperava 2 itens cancelados com already_cancelled=false e motivo correspondente, obteve %', v_returned_count;
  end if;

  -- Verifica persistência e motivo em cada item cancelado no banco
  select status, cancellation_reason into v_item_status, v_item_reason
  from public.table_tab_items where id = v_item_1_id;
  if v_item_status <> 'cancelled' or v_item_reason <> 'Cliente desistiu dos itens' then
    raise exception 'TESTE 1 FALHOU: item 1 com status=% ou motivo=% inválido', v_item_status, v_item_reason;
  end if;

  select status, cancellation_reason into v_item_status, v_item_reason
  from public.table_tab_items where id = v_item_4_tab2_id;
  if v_item_status <> 'cancelled' or v_item_reason <> 'Cliente desistiu dos itens' then
    raise exception 'TESTE 1 FALHOU: item 4 com status=% ou motivo=% inválido', v_item_status, v_item_reason;
  end if;

  raise notice '[OK] TESTE 1: Autorização do próprio restaurante, status cancelled e already_cancelled=false comprovados.';

  -- --------------------------------------------------------------------------
  -- TESTE 2: Bloqueio de outro restaurante / usuário sem vínculo
  -- --------------------------------------------------------------------------
  -- 2a: Usuário anônimo sem login
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', json_build_object('is_anonymous', true)::text, true);
  v_caught_code := null;
  begin
    perform public.cancel_table_tab_items_batch('noma-a', array[v_item_2_id], 'Tentativa anônima');
  exception when others then
    get stacked diagnostics v_caught_code = returned_sqlstate;
  end;
  if v_caught_code <> '42501' then
    raise exception 'TESTE 2a FALHOU: esperava SQLSTATE 42501 para anônimo, obteve %', v_caught_code;
  end if;

  -- 2b: Usuário sem vínculo com restaurante
  perform set_config('request.jwt.claim.sub', v_user_no_link::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_user_no_link, 'is_anonymous', false)::text, true);
  v_caught_code := null;
  begin
    perform public.cancel_table_tab_items_batch('noma-a', array[v_item_2_id], 'Sem vínculo');
  exception when others then
    get stacked diagnostics v_caught_code = returned_sqlstate;
  end;
  if v_caught_code <> '42501' then
    raise exception 'TESTE 2b FALHOU: esperava SQLSTATE 42501 para usuário sem vínculo, obteve %', v_caught_code;
  end if;

  -- 2c: Garçom do Restaurante B tentando cancelar no Restaurante A
  perform set_config('request.jwt.claim.sub', v_user_waiter_b::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_user_waiter_b, 'is_anonymous', false)::text, true);
  v_caught_code := null;
  begin
    perform public.cancel_table_tab_items_batch('noma-a', array[v_item_2_id], 'Invasão cross-restaurant');
  exception when others then
    get stacked diagnostics v_caught_code = returned_sqlstate;
  end;
  if v_caught_code <> '42501' then
    raise exception 'TESTE 2c FALHOU: esperava SQLSTATE 42501 para garçom de outro restaurante, obteve %', v_caught_code;
  end if;

  raise notice '[OK] TESTE 2: Bloqueio estrito de usuário anônimo, sem vínculo e cross-restaurant (42501) comprovado.';

  -- --------------------------------------------------------------------------
  -- TESTE 3: Item inexistente
  -- --------------------------------------------------------------------------
  perform set_config('request.jwt.claim.sub', v_user_waiter_a::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_user_waiter_a, 'is_anonymous', false)::text, true);
  v_caught_code := null;
  begin
    perform public.cancel_table_tab_items_batch(
      'noma-a',
      array['00000000-0000-0000-0000-000000000000'::uuid],
      'Item que não existe'
    );
  exception when others then
    get stacked diagnostics v_caught_code = returned_sqlstate;
  end;
  if v_caught_code <> '22023' then
    raise exception 'TESTE 3 FALHOU: esperava SQLSTATE 22023 para item inexistente, obteve %', v_caught_code;
  end if;

  raise notice '[OK] TESTE 3: Rejeição de item inexistente com SQLSTATE 22023 comprovada.';

  -- --------------------------------------------------------------------------
  -- TESTE 4: Item já cancelado (retorna sem duplicação nem erro e com already_cancelled=true)
  -- --------------------------------------------------------------------------
  select count(*) into v_returned_count
  from public.cancel_table_tab_items_batch(
    'noma-a',
    array[v_item_3_cancelled_id],
    'Tentando cancelar novamente'
  )
  where status = 'cancelled' and already_cancelled = true and cancellation_reason = 'Cancelado anteriormente';

  if v_returned_count <> 1 then
    raise exception 'TESTE 4 FALHOU: esperava retorno de 1 item já cancelado com already_cancelled=true e motivo preservado, obteve %', v_returned_count;
  end if;

  -- Garante que motivo original foi preservado na tabela
  select cancellation_reason into v_item_reason
  from public.table_tab_items where id = v_item_3_cancelled_id;
  if v_item_reason <> 'Cancelado anteriormente' then
    raise exception 'TESTE 4 FALHOU: motivo original foi sobrescrito: %', v_item_reason;
  end if;

  raise notice '[OK] TESTE 4: Item já cancelado retorna idempotentemente com already_cancelled=true e motivo preservado.';

  -- --------------------------------------------------------------------------
  -- TESTE 5: Rollback integral quando um item do lote falhar (atômico)
  -- --------------------------------------------------------------------------
  -- Item 2 ainda está ativo
  select status into v_item_status from public.table_tab_items where id = v_item_2_id;
  if v_item_status <> 'active' then
    raise exception 'PRE-TESTE 5 FALHOU: item 2 deveria estar active';
  end if;

  -- 5a: Lote contendo [Item 2 (ativo), Item Inexistente]
  v_caught_code := null;
  begin
    perform public.cancel_table_tab_items_batch(
      'noma-a',
      array[v_item_2_id, '00000000-0000-0000-0000-000000000000'::uuid],
      'Lote com falha de item inexistente'
    );
  exception when others then
    get stacked diagnostics v_caught_code = returned_sqlstate;
  end;
  if v_caught_code <> '22023' then
    raise exception 'TESTE 5a FALHOU: esperava erro 22023, obteve %', v_caught_code;
  end if;

  -- Comprova que Item 2 CONTINUA active (rollback atômico integral)
  select status into v_item_status from public.table_tab_items where id = v_item_2_id;
  if v_item_status <> 'active' then
    raise exception 'TESTE 5a FALHOU: Item 2 sofreu alteração parcial indevida (status=%)!', v_item_status;
  end if;

  -- 5b: Lote contendo [Item 2 (ativo), Item 5 (em comanda encerrada)]
  v_caught_code := null;
  begin
    perform public.cancel_table_tab_items_batch(
      'noma-a',
      array[v_item_2_id, v_item_5_closed_tab_id],
      'Lote com comanda encerrada'
    );
  exception when others then
    get stacked diagnostics v_caught_code = returned_sqlstate;
  end;
  if v_caught_code <> '22023' then
    raise exception 'TESTE 5b FALHOU: esperava erro 22023 para comanda encerrada, obteve %', v_caught_code;
  end if;

  -- Comprova novamente que Item 2 CONTINUA active (rollback atômico integral)
  select status into v_item_status from public.table_tab_items where id = v_item_2_id;
  if v_item_status <> 'active' then
    raise exception 'TESTE 5b FALHOU: Item 2 sofreu alteração parcial indevida (status=%)!', v_item_status;
  end if;

  raise notice '[OK] TESTE 5: Rollback integral comprovado. Nenhum item do lote foi cancelado em caso de falha.';

  -- --------------------------------------------------------------------------
  -- TESTE 6: Lote misto (item ativo + item já cancelado)
  -- --------------------------------------------------------------------------
  -- v_item_2_id está ativo; v_item_3_cancelled_id já está cancelado com motivo anterior.
  -- O cancelamento em lote deve processar ambos:
  -- - v_item_2_id: cancelado agora, already_cancelled=false, motivo='Cancelamento misto'
  -- - v_item_3_cancelled_id: já cancelado, already_cancelled=true, motivo preservado='Cancelado anteriormente'
  declare
    v_mixed_count integer;
    v_newly_cancelled_count integer;
    v_already_cancelled_count integer;
  begin
    select
      count(*),
      count(*) filter (where id = v_item_2_id and already_cancelled = false and cancellation_reason = 'Cancelamento misto'),
      count(*) filter (where id = v_item_3_cancelled_id and already_cancelled = true and cancellation_reason = 'Cancelado anteriormente')
    into v_mixed_count, v_newly_cancelled_count, v_already_cancelled_count
    from public.cancel_table_tab_items_batch(
      'noma-a',
      array[v_item_2_id, v_item_3_cancelled_id],
      'Cancelamento misto'
    );

    if v_mixed_count <> 2 or v_newly_cancelled_count <> 1 or v_already_cancelled_count <> 1 then
      raise exception 'TESTE 6 FALHOU: Lote misto não validou corretamente (total=%, novos=%, prévios=%)',
        v_mixed_count, v_newly_cancelled_count, v_already_cancelled_count;
    end if;

    -- Confere na tabela se motivo anterior do item 3 foi mantido e se o item 2 foi cancelado com novo motivo
    select status, cancellation_reason into v_item_status, v_item_reason
    from public.table_tab_items where id = v_item_3_cancelled_id;
    if v_item_status <> 'cancelled' or v_item_reason <> 'Cancelado anteriormente' then
      raise exception 'TESTE 6 FALHOU: item 3 teve seu motivo anterior sobrescrito na tabela: %', v_item_reason;
    end if;

    select status, cancellation_reason into v_item_status, v_item_reason
    from public.table_tab_items where id = v_item_2_id;
    if v_item_status <> 'cancelled' or v_item_reason <> 'Cancelamento misto' then
      raise exception 'TESTE 6 FALHOU: item 2 não foi cancelado com novo motivo na tabela: status=%, motivo=%', v_item_status, v_item_reason;
    end if;

    raise notice '[OK] TESTE 6: Lote misto de itens ativos e já cancelados validado com sucesso.';
  end;

  raise notice '===============================================================';
  raise notice 'TODOS OS TESTES SQL DA RPC FORAM 100%% APROVADOS!';
  raise notice '===============================================================';
end;
$$;

-- ============================================================================
-- TESTES ADICIONAIS: EXECUÇÃO COMO OS PAPÉIS REAIS anon E authenticated
-- ============================================================================

-- ----------------------------------------------------------------------------
-- TESTE 7: Execução como o papel real anon
-- O papel anon tem o privilégio EXECUTE revogado da função cancel_table_tab_items_batch.
-- A tentativa de chamada deve ser rejeitada pelo próprio PostgreSQL com SQLSTATE 42501.
-- ----------------------------------------------------------------------------
set local role anon;

do $$
declare
  v_caught_code text;
begin
  begin
    perform public.cancel_table_tab_items_batch(
      'noma-a',
      array['81111111-1111-4111-a111-111111111111'::uuid],
      'Tentativa direta como papel anon'
    );
  exception when others then
    get stacked diagnostics v_caught_code = returned_sqlstate;
  end;

  if v_caught_code <> '42501' then
    raise exception 'TESTE 7 FALHOU: esperava SQLSTATE 42501 para papel real anon, obteve %', v_caught_code;
  end if;

  raise notice '[OK] TESTE 7: Execução como papel real anon bloqueada com SQLSTATE 42501 (privilégio revogado).';
end;
$$;

reset role;

-- ----------------------------------------------------------------------------
-- TESTE 8: Execução como o papel real authenticated
-- ----------------------------------------------------------------------------
-- 8a: Usuário authenticated sem vínculo com o restaurante
-- Possui privilégio EXECUTE na função, mas a validação interna de lock_owned_table_visit
-- barra a operação com SQLSTATE 42501 ('Sua conta não possui acesso ativo a este restaurante.').
set local role authenticated;

do $$
declare
  v_user_no_link uuid := 'a0000000-0000-4000-a000-000000000003';
  v_user_waiter_a uuid := 'a0000000-0000-4000-a000-000000000001';
  v_member_a_id uuid := 'd1111111-1111-4111-a111-111111111111';
  v_item_1_id uuid := '81111111-1111-4111-a111-111111111111';
  v_item_6_auth_id uuid := '81111111-1111-4111-a111-666666666666';
  v_item_status text;
  v_item_reason text;
  v_cancelled_by uuid;
  v_cancelled_at timestamptz;
  v_caught_code text;
  v_count integer;
begin
  -- 8a: Usuário authenticated sem vínculo com o restaurante
  perform set_config('request.jwt.claim.sub', v_user_no_link::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_user_no_link, 'is_anonymous', false)::text, true);

  begin
    perform public.cancel_table_tab_items_batch(
      'noma-a',
      array[v_item_6_auth_id],
      'Tentativa authenticated sem vínculo'
    );
  exception when others then
    get stacked diagnostics v_caught_code = returned_sqlstate;
  end;

  if v_caught_code <> '42501' then
    raise exception 'TESTE 8a FALHOU: esperava SQLSTATE 42501 para authenticated sem vínculo, obteve %', v_caught_code;
  end if;

  raise notice '[OK] TESTE 8a: Papel real authenticated sem vínculo bloqueado com SQLSTATE 42501 pela validação da equipe.';

  -- 8b: Garçom com papel real authenticated vinculado ao restaurante cancela item ativo novo
  -- Possui privilégio EXECUTE e vínculo ativo: chamada é autorizada e cancela o item ativo novo.
  perform set_config('request.jwt.claim.sub', v_user_waiter_a::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_user_waiter_a, 'is_anonymous', false)::text, true);

  -- 1. Confere no banco que o item 6 está ativo antes da operação
  select status, cancellation_reason into v_item_status, v_item_reason
  from public.table_tab_items where id = v_item_6_auth_id;

  if v_item_status <> 'active' or v_item_reason is not null then
    raise exception 'PRE-TESTE 8b FALHOU: item 6 deveria estar active com motivo nulo no banco, obteve status=%, motivo=%',
      v_item_status, v_item_reason;
  end if;

  -- 2. Executa a RPC cancel_table_tab_items_batch como papel real authenticated
  select count(*) into v_count
  from public.cancel_table_tab_items_batch(
    'noma-a',
    array[v_item_6_auth_id],
    'Cancelado pelo garçom em papel real authenticated'
  )
  where status = 'cancelled'
    and already_cancelled = false
    and cancellation_reason = 'Cancelado pelo garçom em papel real authenticated';

  if v_count <> 1 then
    raise exception 'TESTE 8b FALHOU: esperava retorno de 1 item cancelado com already_cancelled=false e motivo correspondente, obteve %', v_count;
  end if;

  -- 3. Confere diretamente no banco de dados que o item 6 ficou cancelado com o motivo informado e metadados de auditoria
  select status, cancellation_reason, cancelled_by_member_id, cancelled_at
  into v_item_status, v_item_reason, v_cancelled_by, v_cancelled_at
  from public.table_tab_items where id = v_item_6_auth_id;

  if v_item_status <> 'cancelled' then
    raise exception 'TESTE 8b FALHOU: item 6 não ficou com status cancelled no banco (status=%)', v_item_status;
  end if;

  if v_item_reason <> 'Cancelado pelo garçom em papel real authenticated' then
    raise exception 'TESTE 8b FALHOU: item 6 no banco não possui o motivo esperado: %', v_item_reason;
  end if;

  if v_cancelled_by <> v_member_a_id or v_cancelled_at is null then
    raise exception 'TESTE 8b FALHOU: auditoria de cancelamento incompleta para item 6 (cancelled_by=%, cancelled_at=%)',
      v_cancelled_by, v_cancelled_at;
  end if;

  raise notice '[OK] TESTE 8b: Execução com papel real authenticated cancelou item ativo novo e conferência no banco confirmou status=cancelled e motivo persistido.';
  raise notice '===============================================================';
  raise notice 'TODOS OS TESTES (INCLUINDO PAPÉIS REAIS) 100%% APROVADOS!';
  raise notice '===============================================================';
end;
$$;

reset role;

rollback;

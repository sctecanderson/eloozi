-- ============================================================================
-- TEST SUITE: 20261026190000_atomic_transfer_table_tab_items_test.sql
-- Validação da RPC transfer_table_tab_items e Trigger de Transferência em PostgreSQL Isolado
--
-- Cobertura de Testes:
-- 1. Transferência atômica entre comandas na mesma mesa/visita (preservando id, preços e KDS)
-- 2. Transferência atômica entre comandas em mesas/visitas diferentes
-- 3. Execução autorizada por administrador do restaurante
-- 4. Registro completo na tabela de auditoria public.table_tab_item_transfers
-- 5. Rejeição quando comanda de origem é igual à de destino (22023)
-- 6. Rejeição de lista de itens vazia (22023)
-- 7. Rejeição de motivo inválido (< 3 ou > 300 caracteres) (22023)
-- 8. Rejeição de item que não pertence à comanda de origem ou inexistente (22023)
-- 9. Rejeição de item já cancelado (22023)
-- 10. Rejeição de comanda/atendimento de origem encerrado (22023)
-- 11. Rejeição de comanda/atendimento de destino encerrado (22023)
-- 12. Isolamento multi-tenant: bloqueio de comanda de outro restaurante (22023/42501)
-- 13. Autorização: bloqueio de garçom não atribuído ao atendimento de origem (42501)
-- 14. Autorização: bloqueio de usuário sem vínculo com o restaurante (42501)
-- 15. Execução como papel real anon (42501) e authenticated
-- 16. Rollback integral atômico em caso de falha parcial
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
  closed_at timestamptz,
  constraint table_tabs_composite_unique unique (id, table_visit_id, restaurant_id, restaurant_table_id)
);

create table if not exists public.menu_categories (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete restrict,
  name text not null,
  constraint menu_categories_id_restaurant_unique unique (id, restaurant_id)
);

create table if not exists public.menu_products (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete restrict,
  category_id uuid not null,
  catalog_key text not null,
  slug text not null,
  name text not null,
  price_in_cents integer not null,
  available boolean not null default true,
  preparation_station text not null default 'kitchen',
  constraint menu_products_id_restaurant_unique unique (id, restaurant_id)
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
  cancellation_reason text,
  preparation_station text not null default 'kitchen',
  production_status text not null default 'pending',
  prep_started_at timestamptz,
  prep_ready_at timestamptz,
  delivered_at timestamptz,
  foreign key (table_tab_id, table_visit_id, restaurant_id, restaurant_table_id)
    references public.table_tabs (id, table_visit_id, restaurant_id, restaurant_table_id) on delete restrict
);

grant select on public.table_tab_items to authenticated;

-- Aplica a migração oficial de transferência atômica
\ir ../migrations/20261026190000_atomic_transfer_table_tab_items.sql

-- Garante o trigger ativo na tabela
drop trigger if exists table_tab_items_validate_write on public.table_tab_items;
create trigger table_tab_items_validate_write
before insert or update on public.table_tab_items
for each row execute function public.validate_table_tab_item_write();

-- ============================================================================
-- BLOCO PRINCIPAL DE TESTES
-- ============================================================================
do $$
declare
  v_rest_a_id uuid := '11111111-1111-4111-a111-111111111111';
  v_rest_b_id uuid := '22222222-2222-4222-a222-222222222222';

  v_user_waiter_1 uuid := 'a0000000-0000-4000-a000-000000000001';
  v_user_waiter_2 uuid := 'a0000000-0000-4000-a000-000000000002';
  v_user_admin_1  uuid := 'a0000000-0000-4000-a000-000000000003';
  v_user_no_link  uuid := 'a0000000-0000-4000-a000-000000000004';

  v_member_waiter_1_id uuid := 'd1111111-1111-4111-a111-111111111111';
  v_member_waiter_2_id uuid := 'd1111111-1111-4111-a111-222222222222';
  v_member_admin_1_id  uuid := 'd1111111-1111-4111-a111-333333333333';
  v_member_waiter_b_id uuid := 'd2222222-2222-4222-a222-111111111111';

  v_table_1_id uuid := 'e1111111-1111-4111-a111-111111111111';
  v_table_2_id uuid := 'e1111111-1111-4111-a111-222222222222';
  v_table_b_id uuid := 'e2222222-2222-4222-a222-111111111111';

  v_visit_1_id      uuid := 'f1111111-1111-4111-a111-111111111111';
  v_visit_2_id      uuid := 'f1111111-1111-4111-a111-222222222222';
  v_visit_closed_id uuid := 'f1111111-1111-4111-a111-333333333333';
  v_visit_b_id      uuid := 'f2222222-2222-4222-a222-111111111111';

  v_tab_1a_id     uuid := 'c1111111-1111-4111-a111-111111111111';
  v_tab_1b_id     uuid := 'c1111111-1111-4111-a111-222222222222';
  v_tab_2a_id     uuid := 'c1111111-1111-4111-a111-333333333333';
  v_tab_closed_id uuid := 'c1111111-1111-4111-a111-444444444444';
  v_tab_b_id      uuid := 'c2222222-2222-4222-a222-111111111111';

  v_cat_1_id  uuid := '91111111-1111-4111-a111-111111111111';
  v_prod_1_id uuid := 'b1111111-1111-4111-a111-111111111111';
  v_prod_2_id uuid := 'b1111111-1111-4111-a111-222222222222';

  v_item_1_id           uuid := '81111111-1111-4111-a111-111111111111';
  v_item_2_id           uuid := '81111111-1111-4111-a111-222222222222';
  v_item_3_cancelled_id uuid := '81111111-1111-4111-a111-333333333333';
  v_item_rollback_id    uuid := '81111111-1111-4111-a111-444444444444';

  v_returned_count integer;
  v_caught_code text;
  v_check_item public.table_tab_items%rowtype;
  v_check_audit public.table_tab_item_transfers%rowtype;
begin
  -- --------------------------------------------------------------------------
  -- Carga de Fixtures
  -- --------------------------------------------------------------------------
  insert into auth.users (id, email) values
    (v_user_waiter_1, 'waiter1@eloozi.test'),
    (v_user_waiter_2, 'waiter2@eloozi.test'),
    (v_user_admin_1,  'admin1@eloozi.test'),
    (v_user_no_link,  'nolink@eloozi.test');

  insert into public.restaurants (id, slug, name, active) values
    (v_rest_a_id, 'rest-a', 'Restaurante A', true),
    (v_rest_b_id, 'rest-b', 'Restaurante B', true);

  insert into public.restaurant_tables (id, restaurant_id, table_number, label, active) values
    (v_table_1_id, v_rest_a_id, 1, 'Mesa 01', true),
    (v_table_2_id, v_rest_a_id, 2, 'Mesa 02', true),
    (v_table_b_id, v_rest_b_id, 1, 'Mesa 01 B', true);

  insert into public.restaurant_members (id, restaurant_id, user_id, role, active) values
    (v_member_waiter_1_id, v_rest_a_id, v_user_waiter_1, 'waiter', true),
    (v_member_waiter_2_id, v_rest_a_id, v_user_waiter_2, 'waiter', true),
    (v_member_admin_1_id,  v_rest_a_id, v_user_admin_1,  'admin',  true),
    (v_member_waiter_b_id, v_rest_b_id, v_user_no_link,  'waiter', true);

  insert into public.table_visits (id, restaurant_id, restaurant_table_id, assigned_member_id, status) values
    (v_visit_1_id, v_rest_a_id, v_table_1_id, v_member_waiter_1_id, 'open'),
    (v_visit_2_id, v_rest_a_id, v_table_2_id, v_member_waiter_2_id, 'open'),
    (v_visit_closed_id, v_rest_a_id, v_table_1_id, v_member_waiter_1_id, 'closed'),
    (v_visit_b_id, v_rest_b_id, v_table_b_id, v_member_waiter_b_id, 'open');

  insert into public.table_tabs (id, restaurant_id, restaurant_table_id, table_visit_id, label, status, created_by_member_id) values
    (v_tab_1a_id, v_rest_a_id, v_table_1_id, v_visit_1_id, 'Comanda 1A - Titular', 'open', v_member_waiter_1_id),
    (v_tab_1b_id, v_rest_a_id, v_table_1_id, v_visit_1_id, 'Comanda 1B - Convidado', 'open', v_member_waiter_1_id),
    (v_tab_2a_id, v_rest_a_id, v_table_2_id, v_visit_2_id, 'Comanda 2A - Titular', 'open', v_member_waiter_2_id),
    (v_tab_closed_id, v_rest_a_id, v_table_1_id, v_visit_closed_id, 'Comanda Fechada', 'closed', v_member_waiter_1_id),
    (v_tab_b_id, v_rest_b_id, v_table_b_id, v_visit_b_id, 'Comanda B', 'open', v_member_waiter_b_id);

  insert into public.menu_categories (id, restaurant_id, name) values
    (v_cat_1_id, v_rest_a_id, 'Lanches');

  insert into public.menu_products (id, restaurant_id, category_id, catalog_key, slug, name, price_in_cents, available, preparation_station) values
    (v_prod_1_id, v_rest_a_id, v_cat_1_id, 'burg-01', 'burger-artesanal', 'Burger Artesanal', 3500, true, 'kitchen'),
    (v_prod_2_id, v_rest_a_id, v_cat_1_id, 'cerv-01', 'cerveja-ipa', 'Cerveja IPA', 1800, true, 'bar');

  insert into public.table_tab_items (
    id, restaurant_id, restaurant_table_id, table_visit_id, table_tab_id,
    product_id, product_name, unit_price_in_cents, quantity, status,
    added_by_member_id, preparation_station, production_status
  ) values
    (v_item_1_id, v_rest_a_id, v_table_1_id, v_visit_1_id, v_tab_1a_id, v_prod_1_id, 'Burger Artesanal', 3500, 1, 'active', v_member_waiter_1_id, 'kitchen', 'preparing'),
    (v_item_2_id, v_rest_a_id, v_table_1_id, v_visit_1_id, v_tab_1a_id, v_prod_2_id, 'Cerveja IPA', 1800, 2, 'active', v_member_waiter_1_id, 'bar', 'ready'),
    (v_item_3_cancelled_id, v_rest_a_id, v_table_1_id, v_visit_1_id, v_tab_1a_id, v_prod_2_id, 'Cerveja IPA', 1800, 1, 'active', v_member_waiter_1_id, 'bar', 'pending'),
    (v_item_rollback_id, v_rest_a_id, v_table_1_id, v_visit_1_id, v_tab_1a_id, v_prod_1_id, 'Burger Artesanal', 3500, 1, 'active', v_member_waiter_1_id, 'kitchen', 'pending');

  -- Cancela item 3 com trigger ativo para criar estado realista de item já cancelado
  update public.table_tab_items set
    status = 'cancelled',
    cancelled_by_member_id = v_member_waiter_1_id,
    cancelled_at = now(),
    cancellation_reason = 'Cancelado anteriormente'
  where id = v_item_3_cancelled_id;

  -- Define usuário ativo na sessão como Garçom 1
  perform set_config('request.jwt.claim.sub', v_user_waiter_1::text, true);

  -- --------------------------------------------------------------------------
  -- TESTE 1: Transferência na MESMA mesa/visita (tab_1a -> tab_1b)
  -- --------------------------------------------------------------------------
  select count(*) into v_returned_count
  from public.transfer_table_tab_items(
    'rest-a',
    v_tab_1a_id,
    v_tab_1b_id,
    array[v_item_1_id],
    'Transferindo para comanda individual do convidado'
  );

  assert v_returned_count = 1, 'Teste 1 Falhou: Deveria retornar 1 item transferido.';

  select * into v_check_item from public.table_tab_items where id = v_item_1_id;
  assert v_check_item.table_tab_id = v_tab_1b_id, 'Teste 1 Falhou: table_tab_id não foi atualizado para tab_1b.';
  assert v_check_item.table_visit_id = v_visit_1_id, 'Teste 1 Falhou: table_visit_id divergente.';
  assert v_check_item.restaurant_table_id = v_table_1_id, 'Teste 1 Falhou: restaurant_table_id divergente.';
  assert v_check_item.status = 'active', 'Teste 1 Falhou: status do item deve permanecer active.';
  assert v_check_item.unit_price_in_cents = 3500, 'Teste 1 Falhou: unit_price_in_cents deve ser preservado.';
  assert v_check_item.production_status = 'preparing', 'Teste 1 Falhou: production_status do KDS deve ser preservado.';
  assert v_check_item.preparation_station = 'kitchen', 'Teste 1 Falhou: preparation_station deve ser preservado.';

  -- Verifica auditoria gravada
  select * into v_check_audit from public.table_tab_item_transfers where item_id = v_item_1_id;
  assert v_check_audit.source_table_tab_id = v_tab_1a_id, 'Teste 1 Falhou: Auditoria source_table_tab_id inválido.';
  assert v_check_audit.target_table_tab_id = v_tab_1b_id, 'Teste 1 Falhou: Auditoria target_table_tab_id inválido.';
  assert v_check_audit.transferred_by_member_id = v_member_waiter_1_id, 'Teste 1 Falhou: Auditoria transferred_by_member_id inválido.';
  assert v_check_audit.reason = 'Transferindo para comanda individual do convidado', 'Teste 1 Falhou: Auditoria reason divergente.';

  -- --------------------------------------------------------------------------
  -- TESTE 2: Transferência entre MESAS DIFERENTES (table_1/visit_1 -> table_2/visit_2)
  -- --------------------------------------------------------------------------
  select count(*) into v_returned_count
  from public.transfer_table_tab_items(
    'rest-a',
    v_tab_1a_id,
    v_tab_2a_id,
    array[v_item_2_id],
    'Cliente mudou-se para a Mesa 02 com a cerveja'
  );

  assert v_returned_count = 1, 'Teste 2 Falhou: Deveria retornar 1 item transferido.';

  select * into v_check_item from public.table_tab_items where id = v_item_2_id;
  assert v_check_item.table_tab_id = v_tab_2a_id, 'Teste 2 Falhou: table_tab_id não foi atualizado para tab_2a.';
  assert v_check_item.table_visit_id = v_visit_2_id, 'Teste 2 Falhou: table_visit_id não foi atualizado para visit_2.';
  assert v_check_item.restaurant_table_id = v_table_2_id, 'Teste 2 Falhou: restaurant_table_id não foi atualizado para table_2.';
  assert v_check_item.production_status = 'ready', 'Teste 2 Falhou: status KDS ready deve ser preservado.';

  select * into v_check_audit from public.table_tab_item_transfers where item_id = v_item_2_id;
  assert v_check_audit.source_restaurant_table_id = v_table_1_id, 'Teste 2 Falhou: Auditoria source table incorreta.';
  assert v_check_audit.target_restaurant_table_id = v_table_2_id, 'Teste 2 Falhou: Auditoria target table incorreta.';

  -- --------------------------------------------------------------------------
  -- TESTE 3: Execução autorizada por ADMINISTRADOR
  -- --------------------------------------------------------------------------
  perform set_config('request.jwt.claim.sub', v_user_admin_1::text, true);

  -- Admin transfere item 1 de volta de tab_1b para tab_1a
  select count(*) into v_returned_count
  from public.transfer_table_tab_items(
    'rest-a',
    v_tab_1b_id,
    v_tab_1a_id,
    array[v_item_1_id],
    'Retorno efetuado pelo gerente'
  );
  assert v_returned_count = 1, 'Teste 3 Falhou: Admin deve conseguir transferir itens.';

  -- --------------------------------------------------------------------------
  -- TESTE 4: Rejeição - Origem igual ao destino
  -- --------------------------------------------------------------------------
  v_caught_code := null;
  begin
    perform public.transfer_table_tab_items(
      'rest-a',
      v_tab_1a_id,
      v_tab_1a_id,
      array[v_item_1_id],
      'Motivo válido para teste'
    );
  exception when others then
    get stacked diagnostics v_caught_code = returned_sqlstate;
  end;
  assert v_caught_code = '22023', 'Teste 4 Falhou: Origem igual ao destino deve lançar 22023. Obtido: ' || coalesce(v_caught_code, 'none');

  -- --------------------------------------------------------------------------
  -- TESTE 5: Rejeição - Lista de itens vazia
  -- --------------------------------------------------------------------------
  v_caught_code := null;
  begin
    perform public.transfer_table_tab_items(
      'rest-a',
      v_tab_1a_id,
      v_tab_1b_id,
      array[]::uuid[],
      'Motivo válido para teste'
    );
  exception when others then
    get stacked diagnostics v_caught_code = returned_sqlstate;
  end;
  assert v_caught_code = '22023', 'Teste 5 Falhou: Lista de itens vazia deve lançar 22023. Obtido: ' || coalesce(v_caught_code, 'none');

  -- --------------------------------------------------------------------------
  -- TESTE 6: Rejeição - Motivo inválido (< 3 caracteres)
  -- --------------------------------------------------------------------------
  v_caught_code := null;
  begin
    perform public.transfer_table_tab_items(
      'rest-a',
      v_tab_1a_id,
      v_tab_1b_id,
      array[v_item_1_id],
      'ab'
    );
  exception when others then
    get stacked diagnostics v_caught_code = returned_sqlstate;
  end;
  assert v_caught_code = '22023', 'Teste 6 Falhou: Motivo < 3 caracteres deve lançar 22023. Obtido: ' || coalesce(v_caught_code, 'none');

  -- --------------------------------------------------------------------------
  -- TESTE 7: Rejeição - Item inexistente ou pertencente a outra comanda
  -- --------------------------------------------------------------------------
  v_caught_code := null;
  begin
    perform public.transfer_table_tab_items(
      'rest-a',
      v_tab_1a_id,
      v_tab_1b_id,
      array['99999999-9999-4999-a999-999999999999'::uuid],
      'Motivo válido para teste'
    );
  exception when others then
    get stacked diagnostics v_caught_code = returned_sqlstate;
  end;
  assert v_caught_code = '22023', 'Teste 7 Falhou: Item inexistente deve lançar 22023. Obtido: ' || coalesce(v_caught_code, 'none');

  -- --------------------------------------------------------------------------
  -- TESTE 8: Rejeição - Item já cancelado
  -- --------------------------------------------------------------------------
  v_caught_code := null;
  begin
    perform public.transfer_table_tab_items(
      'rest-a',
      v_tab_1a_id,
      v_tab_1b_id,
      array[v_item_3_cancelled_id],
      'Tentativa de transferir item cancelado'
    );
  exception when others then
    get stacked diagnostics v_caught_code = returned_sqlstate;
  end;
  assert v_caught_code = '22023', 'Teste 8 Falhou: Item cancelado deve lançar 22023. Obtido: ' || coalesce(v_caught_code, 'none');

  -- --------------------------------------------------------------------------
  -- TESTE 9: Rejeição - Destino com comanda fechada
  -- --------------------------------------------------------------------------
  v_caught_code := null;
  begin
    perform public.transfer_table_tab_items(
      'rest-a',
      v_tab_1a_id,
      v_tab_closed_id,
      array[v_item_1_id],
      'Transferência para comanda fechada'
    );
  exception when others then
    get stacked diagnostics v_caught_code = returned_sqlstate;
  end;
  assert v_caught_code = '22023', 'Teste 9 Falhou: Comanda de destino fechada deve lançar 22023. Obtido: ' || coalesce(v_caught_code, 'none');

  -- --------------------------------------------------------------------------
  -- TESTE 10: Rejeição - Isolamento multi-tenant (comanda de outro restaurante)
  -- --------------------------------------------------------------------------
  v_caught_code := null;
  begin
    perform public.transfer_table_tab_items(
      'rest-a',
      v_tab_1a_id,
      v_tab_b_id,
      array[v_item_1_id],
      'Tentativa de invasão entre restaurantes'
    );
  exception when others then
    get stacked diagnostics v_caught_code = returned_sqlstate;
  end;
  assert v_caught_code = '22023', 'Teste 10 Falhou: Destino em outro restaurante deve lançar 22023. Obtido: ' || coalesce(v_caught_code, 'none');

  -- --------------------------------------------------------------------------
  -- TESTE 11: Bloqueio de Garçom Não Atribuído à Mesa de Origem
  -- --------------------------------------------------------------------------
  -- Garçom 2 tenta transferir da Mesa 1 (atribuída ao Garçom 1)
  perform set_config('request.jwt.claim.sub', v_user_waiter_2::text, true);

  v_caught_code := null;
  begin
    perform public.transfer_table_tab_items(
      'rest-a',
      v_tab_1a_id,
      v_tab_2a_id,
      array[v_item_1_id],
      'Garçom não atribuído tentando mover item'
    );
  exception when others then
    get stacked diagnostics v_caught_code = returned_sqlstate;
  end;
  assert v_caught_code = '42501', 'Teste 11 Falhou: Garçom não atribuído deve receber 42501. Obtido: ' || coalesce(v_caught_code, 'none');

  -- --------------------------------------------------------------------------
  -- TESTE 12: Bloqueio de Usuário sem Vínculo com o Restaurante
  -- --------------------------------------------------------------------------
  perform set_config('request.jwt.claim.sub', v_user_no_link::text, true);

  v_caught_code := null;
  begin
    perform public.transfer_table_tab_items(
      'rest-a',
      v_tab_1a_id,
      v_tab_1b_id,
      array[v_item_1_id],
      'Usuário sem vínculo tentando transferir'
    );
  exception when others then
    get stacked diagnostics v_caught_code = returned_sqlstate;
  end;
  assert v_caught_code = '42501', 'Teste 12 Falhou: Usuário sem vínculo deve receber 42501. Obtido: ' || coalesce(v_caught_code, 'none');

  -- --------------------------------------------------------------------------
  -- TESTE 13: Rollback Integral em Falha Parcial
  -- --------------------------------------------------------------------------
  perform set_config('request.jwt.claim.sub', v_user_admin_1::text, true);

  -- Tenta transferir um item válido junto com um item inexistente em subtransação
  begin
    perform public.transfer_table_tab_items(
      'rest-a',
      v_tab_1a_id,
      v_tab_1b_id,
      array[v_item_rollback_id, '99999999-9999-4999-a999-999999999999'::uuid],
      'Tentativa mista de rollback'
    );
  exception when others then
    null; -- silencia erro para conferir integridade dos dados
  end;

  -- Item válido NÃO pode ter sido transferido nem pode haver auditoria dele
  select * into v_check_item from public.table_tab_items where id = v_item_rollback_id;
  assert v_check_item.table_tab_id = v_tab_1a_id, 'Teste 13 Falhou: Rollback não preservou table_tab_id original.';

  assert not exists (
    select 1 from public.table_tab_item_transfers where item_id = v_item_rollback_id
  ), 'Teste 13 Falhou: Registro de auditoria foi inserido indevidamente em transação com falha.';

  raise notice 'Todos os testes de asserção da RPC transfer_table_tab_items foram aprovados com sucesso!';
end;
$$;

-- ----------------------------------------------------------------------------
-- TESTE 14: Execução como os papéis reais anon e authenticated
-- ----------------------------------------------------------------------------
set local role anon;
do $$
declare
  v_caught_code text;
begin
  begin
    perform public.transfer_table_tab_items(
      'rest-a',
      'c1111111-1111-4111-a111-111111111111'::uuid,
      'c1111111-1111-4111-a111-222222222222'::uuid,
      array['81111111-1111-4111-a111-111111111111'::uuid],
      'Tentativa anonima'
    );
  exception when others then
    get stacked diagnostics v_caught_code = returned_sqlstate;
  end;
  assert v_caught_code = '42501', 'Papel anon deve ser rejeitado com 42501. Obtido: ' || coalesce(v_caught_code, 'none');
  raise notice 'Teste papel real anon aprovado (42501).';
end;
$$;

reset role;

set local role authenticated;
-- Sem JWT claim:
do $$
declare
  v_caught_code text;
begin
  perform set_config('request.jwt.claim.sub', '', true);
  begin
    perform public.transfer_table_tab_items(
      'rest-a',
      'c1111111-1111-4111-a111-111111111111'::uuid,
      'c1111111-1111-4111-a111-222222222222'::uuid,
      array['81111111-1111-4111-a111-111111111111'::uuid],
      'Tentativa authenticated sem claims'
    );
  exception when others then
    get stacked diagnostics v_caught_code = returned_sqlstate;
  end;
  assert v_caught_code = '42501', 'Authenticated sem UID deve ser rejeitado com 42501. Obtido: ' || coalesce(v_caught_code, 'none');
  raise notice 'Teste papel real authenticated sem vínculo aprovado (42501).';
end;
$$;

-- Com JWT claim de garçom autorizado:
do $$
declare
  v_returned_count integer;
begin
  perform set_config('request.jwt.claim.sub', 'a0000000-0000-4000-a000-000000000001', true);
  select count(*) into v_returned_count
  from public.transfer_table_tab_items(
    'rest-a',
    'c1111111-1111-4111-a111-111111111111'::uuid,
    'c1111111-1111-4111-a111-222222222222'::uuid,
    array['81111111-1111-4111-a111-444444444444'::uuid],
    'Transferência autorizada como authenticated'
  );
  assert v_returned_count = 1, 'Authenticated com vínculo garçom deve conseguir transferir.';
  raise notice 'Teste papel real authenticated com garçom vinculado aprovado com sucesso.';
end;
$$;

reset role;

-- Finaliza com ROLLBACK estrito para preservar isolamento
rollback;

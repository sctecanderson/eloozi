-- ============================================================================
-- FIXTURES: concurrency_transfer_fixtures.sql
-- Cenário de Concorrência Real com Duas Sessões para Transferência Atômica de Itens
-- ============================================================================

begin;

-- Garante roles e schemas
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

-- 1. Restaurante
insert into public.restaurants (id, slug, name, active)
values (
  'a1111111-1111-1111-1111-111111111111',
  'conc-transfer-rest',
  'Restaurante Concorrência Transfer',
  true
)
on conflict (id) do update set active = true, slug = 'conc-transfer-rest';

-- 2. Colaborador Garçom
insert into auth.users (id, email)
values ('b1111111-1111-1111-1111-111111111111', 'garcom-conc-transfer@eloozi.com')
on conflict (id) do nothing;

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
  quantity smallint not null,
  line_total_in_cents integer not null,
  status text not null default 'active' check (status in ('active', 'cancelled')),
  added_by_member_id uuid not null references public.restaurant_members(id),
  cancelled_at timestamptz,
  cancelled_by_member_id uuid references public.restaurant_members(id),
  cancellation_reason text,
  preparation_station text not null default 'kitchen',
  created_at timestamptz not null default now(),
  constraint table_tab_items_tab_same_context
    foreign key (table_tab_id, table_visit_id, restaurant_id, restaurant_table_id)
    references public.table_tabs (id, table_visit_id, restaurant_id, restaurant_table_id) on delete restrict
);

insert into public.restaurant_members (id, restaurant_id, user_id, role, active)
values (
  'c1111111-1111-1111-1111-111111111111',
  'a1111111-1111-1111-1111-111111111111',
  'b1111111-1111-1111-1111-111111111111',
  'waiter',
  true
)
on conflict (id) do update set active = true, role = 'waiter';

-- 3. Mesas 1 e 2
insert into public.restaurant_tables (id, restaurant_id, table_number, label, active)
values
  ('d1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', 1, 'Mesa Origem', true),
  ('d2222222-2222-2222-2222-222222222222', 'a1111111-1111-1111-1111-111111111111', 2, 'Mesa Destino', true)
on conflict (id) do update set active = true;

-- 4. Limpa itens e transferências anteriores das fixtures
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'table_tab_item_transfers') then
    delete from public.table_tab_item_transfers where restaurant_id = 'a1111111-1111-1111-1111-111111111111';
  end if;
end;
$$;

delete from public.table_tab_items
where restaurant_id = 'a1111111-1111-1111-1111-111111111111';

delete from public.table_tabs
where restaurant_id = 'a1111111-1111-1111-1111-111111111111';

delete from public.table_visits
where restaurant_id = 'a1111111-1111-1111-1111-111111111111';

-- 5. Atendimentos Abertos
insert into public.table_visits (id, restaurant_id, restaurant_table_id, assigned_member_id, status)
values
  ('e1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', 'd1111111-1111-1111-1111-111111111111', 'c1111111-1111-1111-1111-111111111111', 'open'),
  ('e2222222-2222-2222-2222-222222222222', 'a1111111-1111-1111-1111-111111111111', 'd2222222-2222-2222-2222-222222222222', 'c1111111-1111-1111-1111-111111111111', 'open');

-- 6. Comandas Abertas
insert into public.table_tabs (id, restaurant_id, restaurant_table_id, table_visit_id, label, status, created_by_member_id)
values
  ('f1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', 'd1111111-1111-1111-1111-111111111111', 'e1111111-1111-1111-1111-111111111111', 'Comanda Origem', 'open', 'c1111111-1111-1111-1111-111111111111'),
  ('f2222222-2222-2222-2222-222222222222', 'a1111111-1111-1111-1111-111111111111', 'd2222222-2222-2222-2222-222222222222', 'e2222222-2222-2222-2222-222222222222', 'Comanda Destino', 'open', 'c1111111-1111-1111-1111-111111111111');

-- 7. Categoria e Produto
insert into public.menu_categories (id, restaurant_id, name)
values ('10000000-0000-0000-0000-000000000001', 'a1111111-1111-1111-1111-111111111111', 'Pratos')
on conflict (id) do nothing;

insert into public.menu_products (id, restaurant_id, category_id, catalog_key, slug, name, price_in_cents, available, preparation_station)
values (
  '20000000-0000-0000-0000-000000000001',
  'a1111111-1111-1111-1111-111111111111',
  '10000000-0000-0000-0000-000000000001',
  'produto-conc-1',
  'produto-conc-1',
  'Hambúrguer Especial Concorrência',
  3500,
  true,
  'kitchen'
)
on conflict (id) do nothing;

-- 8. Item Único na Comanda de Origem
insert into public.table_tab_items (
  id,
  restaurant_id,
  restaurant_table_id,
  table_visit_id,
  table_tab_id,
  product_id,
  product_name,
  unit_price_in_cents,
  quantity,
  line_total_in_cents,
  status,
  added_by_member_id,
  preparation_station
) values (
  '30000000-0000-0000-0000-000000000001',
  'a1111111-1111-1111-1111-111111111111',
  'd1111111-1111-1111-1111-111111111111',
  'e1111111-1111-1111-1111-111111111111',
  'f1111111-1111-1111-1111-111111111111',
  '20000000-0000-0000-0000-000000000001',
  'Hambúrguer Especial Concorrência',
  3500,
  1,
  3500,
  'active',
  'c1111111-1111-1111-1111-111111111111',
  'kitchen'
);

commit;

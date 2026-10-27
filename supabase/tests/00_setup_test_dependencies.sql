-- ============================================================================
-- 00_setup_test_dependencies.sql
-- Preparação de Dependências Reais para Ambiente de Banco de Dados Isolado
--
-- ATENÇÃO: Executar exclusivamente em banco local/descartável de teste.
-- NUNCA executar em banco de produção ou remoto.
-- ============================================================================

begin;

-- 1. Criação do schema de autenticação e papéis compatíveis com Supabase
create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  created_at timestamptz not null default now()
);

-- Papéis de banco do Supabase (se ainda não existirem no PostgreSQL)
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role noinherit;
  end if;
end;
$$;

-- Funções utilitárias de autenticação Supabase (auth.uid e auth.jwt)
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
$$;

-- Publicação Realtime do Supabase (necessária para migrações que registram tabelas no Realtime)
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end;
$$;

-- 2. Tabela public.restaurants (Definição real de 20261007173000 + 20261010130000)
create table if not exists public.restaurants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  subtitle text,
  active boolean not null default true,
  service_fee_percent numeric not null default 10,
  timezone text not null default 'America/Sao_Paulo',
  created_at timestamptz not null default now(),

  constraint restaurants_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint restaurants_name_not_empty check (length(btrim(name)) > 0),
  constraint restaurants_service_fee_range check (service_fee_percent >= 0 and service_fee_percent <= 30),
  constraint restaurants_timezone_not_empty check (length(btrim(timezone)) > 0)
);

-- 3. Tabela public.restaurant_tables (Definição real completa de produção)
create table if not exists public.restaurant_tables (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete restrict,
  table_number smallint not null,
  label text not null default '',
  active boolean not null default true,
  is_active boolean not null default true,
  deleted_at timestamptz default null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),

  constraint restaurant_tables_number_range check (table_number between 1 and 999),
  constraint restaurant_tables_id_restaurant_unique unique (id, restaurant_id)
);

alter table public.restaurant_tables
  add column if not exists label text not null default '',
  add column if not exists active boolean not null default true,
  add column if not exists is_active boolean not null default true,
  add column if not exists deleted_at timestamptz default null,
  add column if not exists revision integer not null default 1;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'restaurant_tables_id_restaurant_unique'
  ) then
    alter table public.restaurant_tables
      add constraint restaurant_tables_id_restaurant_unique unique (id, restaurant_id);
  end if;
end;
$$;

-- Remove explicitamente a FK antiga de reservations (se existir da execução anterior)
-- antes de substituir a unicidade global por índice parcial. Não utiliza CASCADE indiscriminado.
do $$
begin
  if exists (
    select 1 from information_schema.tables 
    where table_schema = 'public' and table_name = 'reservations'
  ) then
    alter table public.reservations
      drop constraint if exists reservations_restaurant_table_fk;
  end if;
end;
$$;

-- Remove constraint única global se existir e aplica o índice parcial real com deleted_at is null
alter table public.restaurant_tables
  drop constraint if exists restaurant_tables_unique_number;

drop index if exists public.restaurant_tables_unique_number;

create unique index if not exists restaurant_tables_unique_number
  on public.restaurant_tables (restaurant_id, table_number)
  where deleted_at is null;

-- 4. Tabela public.restaurant_members (Definição real completa de produção)
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

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'restaurant_members_id_restaurant_unique'
  ) then
    alter table public.restaurant_members
      add constraint restaurant_members_id_restaurant_unique unique (id, restaurant_id);
  end if;
end;
$$;

create index if not exists restaurant_members_user_id_idx
  on public.restaurant_members (user_id);

-- 5. Habilitação de RLS e Políticas Originais de Acesso
alter table public.restaurants enable row level security;
alter table public.restaurant_tables enable row level security;
alter table public.restaurant_members enable row level security;

revoke all privileges on table public.restaurants, public.restaurant_tables, public.restaurant_members from public, anon, authenticated;

grant select on table public.restaurants to anon, authenticated;
grant select on table public.restaurant_tables, public.restaurant_members to authenticated;

-- Políticas reais das dependências
drop policy if exists restaurants_read_active on public.restaurants;
create policy restaurants_read_active
  on public.restaurants for select
  to anon, authenticated
  using (active = true);

drop policy if exists restaurant_members_read_own on public.restaurant_members;
create policy restaurant_members_read_own
  on public.restaurant_members for select
  to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists restaurant_tables_read_by_members on public.restaurant_tables;
create policy restaurant_tables_read_by_members
  on public.restaurant_tables for select
  to authenticated
  using (
    exists (
      select 1
      from public.restaurant_members as member
      where member.restaurant_id = restaurant_tables.restaurant_id
        and member.user_id = (select auth.uid())
        and member.active = true
    )
  );

-- Políticas restritivas reais (AS RESTRICTIVE) que exigem restaurante ativo
drop policy if exists restaurant_members_require_active_restaurant on public.restaurant_members;
create policy restaurant_members_require_active_restaurant
  on public.restaurant_members
  as restrictive
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.restaurants as restaurant
      where restaurant.id = restaurant_members.restaurant_id
        and restaurant.active = true
    )
  );

drop policy if exists restaurant_tables_require_active_restaurant on public.restaurant_tables;
create policy restaurant_tables_require_active_restaurant
  on public.restaurant_tables
  as restrictive
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.restaurants as restaurant
      where restaurant.id = restaurant_tables.restaurant_id
        and restaurant.active = true
    )
  );

commit;

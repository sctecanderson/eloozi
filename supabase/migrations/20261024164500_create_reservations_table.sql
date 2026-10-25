-- Migration: Criação da tabela de reservas para vinculação entre Admin e Salão
create table if not exists public.reservations (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  table_number smallint not null,
  customer_name text not null,
  phone text not null default '',
  date date not null default current_date,
  time text not null default '20:00',
  reservation_time text not null default '20:00',
  status text not null default 'confirmed',
  guests_count smallint not null default 2,
  notes text not null default '',
  created_at timestamptz not null default now(),

  constraint reservations_status_check
    check (status in ('confirmed', 'confirmada', 'agendada', 'reservada', 'seated', 'cancelled'))
);

create index if not exists reservations_restaurant_date_idx
  on public.reservations (restaurant_id, date);

alter table public.reservations enable row level security;

create policy reservations_read_policy
  on public.reservations
  for select
  to authenticated, anon
  using (true);

create policy reservations_write_policy
  on public.reservations
  for all
  to authenticated
  using (true)
  with check (true);

-- Habilita escuta Realtime
do $$
begin
  if not exists (
    select 1 from pg_publication_tables 
    where pubname = 'supabase_realtime' and tablename = 'reservations'
  ) then
    alter publication supabase_realtime add table public.reservations;
  end if;
end;
$$;

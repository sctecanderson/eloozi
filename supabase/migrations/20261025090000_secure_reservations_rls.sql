-- Migration: 20261025090000_secure_reservations_rls.sql
-- Description: Implementação segura, idempotente e adaptativa de public.reservations.
-- Suporta tanto banco novo quanto tabela preexistente (20261024164500).
-- Garante isolamento multi-tenant, bloqueio de acesso anônimo/público,
-- permissões estritas para admin (CRUD) e garçom (leitura e RPC de atendimento),
-- imutabilidade de restaurant_id, unicidade estável de importação (origin_id)
-- e RPC seat_table_reservation com ID estritamente obrigatório (sem seleção automática),
-- validação estrita da data civil operacional no fuso do restaurante (sem margens inventadas)
-- e serialização por bloqueio pessimista na reserva alvo.

begin;

-- ============================================================================
-- 1. CRIAÇÃO IDEMPOTENTE E ADAPTAÇÃO DE public.reservations
-- ============================================================================
create table if not exists public.reservations (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  table_id uuid,
  table_number smallint not null,
  customer_name text not null,
  phone text not null default '',
  date date not null default current_date,
  time text not null default '20:00',
  reservation_time text not null default '20:00',
  status text not null default 'confirmed',
  guests_count smallint not null default 2,
  notes text not null default '',
  origin_id text,
  created_at timestamptz not null default now()
);

-- Adaptação estrutural caso a tabela já exista de migrações anteriores
alter table public.reservations
  add column if not exists table_id uuid,
  add column if not exists phone text not null default '',
  add column if not exists date date not null default current_date,
  add column if not exists time text not null default '20:00',
  add column if not exists reservation_time text not null default '20:00',
  add column if not exists status text not null default 'confirmed',
  add column if not exists guests_count smallint not null default 2,
  add column if not exists notes text not null default '',
  add column if not exists origin_id text,
  add column if not exists created_at timestamptz not null default now();

-- Restrições de integridade no banco de dados
alter table public.reservations
  drop constraint if exists reservations_table_number_range,
  add constraint reservations_table_number_range check (table_number between 1 and 999);

alter table public.reservations
  drop constraint if exists reservations_customer_name_not_empty,
  add constraint reservations_customer_name_not_empty check (length(btrim(customer_name)) > 0);

alter table public.reservations
  drop constraint if exists reservations_guests_count_range,
  add constraint reservations_guests_count_range check (guests_count between 1 and 99);

alter table public.reservations
  drop constraint if exists reservations_status_check,
  add constraint reservations_status_check
    check (status in ('confirmed', 'confirmada', 'agendada', 'reservada', 'seated', 'cancelled'));

alter table public.reservations
  drop constraint if exists reservations_time_format_check,
  add constraint reservations_time_format_check
    check (time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

-- Remove chave estrangeira legada incompatível com índice parcial se existir
alter table public.reservations
  drop constraint if exists reservations_restaurant_table_fk;

-- Popula table_id para registros pré-existentes a partir das mesas ativas correspondentes
update public.reservations as r
set table_id = t.id
from public.restaurant_tables as t
where r.table_id is null
  and t.restaurant_id = r.restaurant_id
  and t.table_number = r.table_number
  and t.deleted_at is null;

-- Integridade referencial estável para a identidade da mesa com isolamento estrito por restaurante
-- Referencia o índice único total (id, restaurant_id) de restaurant_tables
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'reservations_restaurant_table_fk'
  ) then
    alter table public.reservations
      add constraint reservations_restaurant_table_fk
      foreign key (table_id, restaurant_id)
      references public.restaurant_tables (id, restaurant_id)
      on delete restrict
      not valid;
  end if;
end;
$$;

-- Gatilho de sincronização e validação da identidade estável da mesa
create or replace function public.sync_reservation_table()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog, pg_temp
as $$
declare
  v_table record;
begin
  -- Em atualizações: se o número da mesa mudou mas o table_id não foi explicitamente alterado,
  -- limpa o table_id antigo para permitir a re-resolução da nova mesa
  if tg_op = 'UPDATE' then
    if new.table_number is distinct from old.table_number and new.table_id is not distinct from old.table_id then
      new.table_id := null;
    elsif new.table_id is distinct from old.table_id and new.table_number is not distinct from old.table_number then
      new.table_number := null;
    end if;
  end if;

  -- Se table_id foi fornecido (ou mantido), valida correspondência com o restaurante e confere table_number
  if new.table_id is not null then
    select id, table_number, deleted_at, active, is_active
    into v_table
    from public.restaurant_tables
    where id = new.table_id
      and restaurant_id = new.restaurant_id;

    if not found then
      raise exception 'A mesa informada (ID %) não pertence ao restaurante %.', new.table_id, new.restaurant_id
        using errcode = '22023';
    end if;

    -- Não permite associar nova reserva ou trocar mesa para uma mesa excluída
    if v_table.deleted_at is not null and (tg_op = 'INSERT' or (tg_op = 'UPDATE' and new.table_id is distinct from old.table_id)) then
      raise exception 'A mesa informada (ID %) está excluída.', new.table_id
        using errcode = '22023';
    end if;

    if new.table_number is null then
      new.table_number := v_table.table_number;
    elsif new.table_number <> v_table.table_number then
      raise exception 'O número da mesa informado (%) diverge da mesa referenciada (%).', new.table_number, v_table.table_number
        using errcode = '22023';
    end if;
  else
    -- Se table_id não foi fornecido, resolve a partir da mesa ativa atual
    if new.table_number is null then
      raise exception 'É obrigatório informar o número da mesa ou o identificador da mesa.'
        using errcode = '22023';
    end if;

    select id, table_number, deleted_at, active, is_active
    into v_table
    from public.restaurant_tables
    where restaurant_id = new.restaurant_id
      and table_number = new.table_number
      and deleted_at is null
    limit 1;

    if not found then
      raise exception 'Mesa % inexistente ou excluída no restaurante %.', new.table_number, new.restaurant_id
        using errcode = '22023';
    end if;

    new.table_id := v_table.id;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_sync_reservation_table on public.reservations;
create trigger trg_sync_reservation_table
before insert or update of table_id, table_number, restaurant_id on public.reservations
for each row
execute function public.sync_reservation_table();

-- Índices operacionais e de unicidade para importações seguras
create index if not exists reservations_restaurant_date_idx
  on public.reservations (restaurant_id, date);

create index if not exists reservations_restaurant_table_status_idx
  on public.reservations (restaurant_id, table_number, date, status);

create index if not exists reservations_restaurant_table_id_idx
  on public.reservations (restaurant_id, table_id);

create unique index if not exists reservations_restaurant_origin_id_uidx
  on public.reservations (restaurant_id, origin_id)
  where origin_id is not null;

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

-- ============================================================================
-- 2. HABILITAÇÃO DE RLS E REVOGAÇÃO DE PERMISSÕES PÚBLICAS/ANÔNIMAS
-- ============================================================================
alter table public.reservations enable row level security;

revoke all on table public.reservations from public, anon;
grant select, insert, update, delete on table public.reservations to authenticated;

-- Remoção dinâmica de todas as políticas anteriores na tabela para evitar vazamento
do $$
declare
  pol record;
begin
  for pol in (
    select policyname
    from pg_policies
    where schemaname = 'public' and tablename = 'reservations'
  ) loop
    execute format('drop policy if exists %I on public.reservations', pol.policyname);
  end loop;
end;
$$;

-- ============================================================================
-- 3. GATILHO DE INTEGRIDADE: IMUTABILIDADE DE restaurant_id
-- ============================================================================
create or replace function public.protect_reservation_restaurant_id()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog, pg_temp
as $$
begin
  if new.restaurant_id is distinct from old.restaurant_id then
    raise exception 'A alteração de restaurant_id em reservas é estritamente proibida.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_protect_reservation_restaurant_id on public.reservations;
create trigger trg_protect_reservation_restaurant_id
before update on public.reservations
for each row
execute function public.protect_reservation_restaurant_id();

-- ============================================================================
-- 4. POLÍTICAS DE ROW LEVEL SECURITY (RLS)
-- ============================================================================

-- 4.1 SELECT: Membros ativos (garçom ou admin) do respectivo restaurante
create policy reservations_select_member
on public.reservations
for select
to authenticated
using (
  (not coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false))
  and exists (
    select 1
    from public.restaurant_members as m
    where m.restaurant_id = reservations.restaurant_id
      and m.user_id = (select auth.uid())
      and m.active = true
      and m.role in ('admin', 'waiter')
  )
);

-- 4.2 INSERT: Administrador ativo do respectivo restaurante
create policy reservations_insert_admin
on public.reservations
for insert
to authenticated
with check (
  (not coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false))
  and exists (
    select 1
    from public.restaurant_members as m
    where m.restaurant_id = reservations.restaurant_id
      and m.user_id = (select auth.uid())
      and m.active = true
      and m.role = 'admin'
  )
);

-- 4.3 UPDATE: Administrador ativo do respectivo restaurante
create policy reservations_update_admin
on public.reservations
for update
to authenticated
using (
  (not coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false))
  and exists (
    select 1
    from public.restaurant_members as m
    where m.restaurant_id = reservations.restaurant_id
      and m.user_id = (select auth.uid())
      and m.active = true
      and m.role = 'admin'
  )
)
with check (
  (not coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false))
  and exists (
    select 1
    from public.restaurant_members as m
    where m.restaurant_id = reservations.restaurant_id
      and m.user_id = (select auth.uid())
      and m.active = true
      and m.role = 'admin'
  )
);

-- 4.4 DELETE: Administrador ativo do respectivo restaurante
create policy reservations_delete_admin
on public.reservations
for delete
to authenticated
using (
  (not coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false))
  and exists (
    select 1
    from public.restaurant_members as m
    where m.restaurant_id = reservations.restaurant_id
      and m.user_id = (select auth.uid())
      and m.active = true
      and m.role = 'admin'
  )
);

-- ============================================================================
-- 5. RPC TRANSACIONAL: seat_table_reservation
-- Permite que Garçom ou Admin confirme a chegada do cliente na mesa.
-- EXIGE ID EXPLÍCITO DA RESERVA (SEM SELEÇÃO AUTOMÁTICA).
-- Não introduz margens arbitrárias: exige estritamente a data civil atual do restaurante.
-- ============================================================================

-- Remove overloads antigos que pudessem permitir seleção automática ou assinaturas legadas
drop function if exists public.seat_table_reservation(uuid, smallint, uuid);
drop function if exists public.seat_table_reservation(uuid, smallint);

create or replace function public.seat_table_reservation(
  p_restaurant_id uuid,
  p_table_number smallint,
  p_reservation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_is_anon boolean := coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false);
  v_is_member boolean;
  v_target_table public.restaurant_tables%rowtype;
  v_current_active_table_id uuid;
  v_tz text;
  v_curr_date date;
  v_target_row public.reservations%rowtype;
  v_updated_row public.reservations%rowtype;
begin
  -- 1. Validação estrita: ID da reserva é obrigatório (elimina seleção automática)
  if p_reservation_id is null then
    return jsonb_build_object(
      'success', false,
      'code', 'INVALID_RESERVATION_ID',
      'message', 'O ID da reserva é obrigatório para confirmar o atendimento.'
    );
  end if;

  if p_restaurant_id is null or p_table_number is null then
    return jsonb_build_object(
      'success', false,
      'code', 'INVALID_PARAMETERS',
      'message', 'Restaurante e número de mesa são parâmetros obrigatórios.'
    );
  end if;

  -- 2. Verificação estrita de autenticação real (não anônima)
  if v_uid is null or v_is_anon then
    raise exception 'Autenticação necessária.' using errcode = '42501';
  end if;

  -- 3. Verificação de membro ativo (garçom ou admin) em restaurante ativo
  select exists (
    select 1
    from public.restaurant_members as m
    join public.restaurants as r on r.id = m.restaurant_id
    where m.restaurant_id = p_restaurant_id
      and m.user_id = v_uid
      and m.active = true
      and r.active = true
      and m.role in ('admin', 'waiter')
  ) into v_is_member;

  if not v_is_member then
    raise exception 'Acesso não autorizado para operar reservas deste restaurante.'
      using errcode = '42501';
  end if;

  -- 4. Bloqueio pessimista focado EXCLUSIVAMENTE na reserva solicitada
  select * into v_target_row
  from public.reservations
  where id = p_reservation_id
    and restaurant_id = p_restaurant_id
  for update;

  if not found then
    return jsonb_build_object(
      'success', false,
      'code', 'RESERVATION_NOT_FOUND',
      'message', 'A reserva especificada não foi encontrada neste restaurante.'
    );
  end if;

  -- 5. Validação rigorosa da mesa vinculada (exclusão lógica, atividade e reutilização de número)
  -- Vínculo não resolvido deve exigir reconciliação explícita, sem associar silenciosamente
  -- uma reserva antiga a uma mesa nova que reutilizou o número.
  if v_target_row.table_id is null then
    return jsonb_build_object(
      'success', false,
      'code', 'TABLE_NOT_LINKED',
      'message', 'A reserva não possui vínculo com uma mesa confirmada e requer reconciliação.'
    );
  end if;

  select * into v_target_table
  from public.restaurant_tables
  where id = v_target_row.table_id
    and restaurant_id = p_restaurant_id;

  if not found then
    return jsonb_build_object(
      'success', false,
      'code', 'TABLE_NOT_FOUND',
      'message', 'Mesa vinculada à reserva não foi encontrada no restaurante.'
    );
  end if;

  -- 5.1 Rejeita mesa com exclusão lógica
  if v_target_table.deleted_at is not null then
    return jsonb_build_object(
      'success', false,
      'code', 'TABLE_DELETED',
      'message', 'A mesa vinculada a esta reserva foi excluída e não pode ser atendida.'
    );
  end if;

  -- 5.2 Respeita indicadores de atividade do projeto (active e is_active)
  if not (coalesce(v_target_table.active, false) = true and coalesce(v_target_table.is_active, true) = true) then
    return jsonb_build_object(
      'success', false,
      'code', 'TABLE_INACTIVE',
      'message', 'A mesa vinculada a esta reserva está inativa ou bloqueada.'
    );
  end if;

  -- 5.3 Validação de correspondência de número de mesa
  if v_target_table.table_number <> p_table_number or v_target_row.table_number <> p_table_number then
    return jsonb_build_object(
      'success', false,
      'code', 'TABLE_MISMATCH',
      'message', format('A reserva informada pertence à Mesa %s, não à Mesa %s.', v_target_row.table_number, p_table_number)
    );
  end if;

  -- 5.4 Detecção de reutilização de número por outra mesa após exclusão
  select id into v_current_active_table_id
  from public.restaurant_tables
  where restaurant_id = p_restaurant_id
    and table_number = p_table_number
    and deleted_at is null
  limit 1;

  if v_current_active_table_id is not null and v_current_active_table_id <> v_target_table.id then
    return jsonb_build_object(
      'success', false,
      'code', 'TABLE_REPLACED',
      'message', 'O número desta mesa foi reutilizado por outra mesa após a exclusão da mesa original da reserva.'
    );
  end if;

  -- 7. Validação da data civil operacional no fuso horário do restaurante
  -- Regra sem margens arbitrárias: a reserva deve corresponder à data civil corrente no fuso do restaurante.
  -- Nota de documentação: Atendimentos que atravessam meia-noite pertencem à data civil em que são confirmados.
  select coalesce(r.timezone, 'America/Sao_Paulo')
  into v_tz
  from public.restaurants as r
  where r.id = p_restaurant_id;

  if v_tz is null or length(btrim(v_tz)) = 0 then
    v_tz := 'America/Sao_Paulo';
  end if;

  begin
    v_curr_date := (now() at time zone v_tz)::date;
  exception when others then
    v_tz := 'America/Sao_Paulo';
    v_curr_date := (now() at time zone 'America/Sao_Paulo')::date;
  end;

  if v_target_row.date <> v_curr_date then
    return jsonb_build_object(
      'success', false,
      'code', 'DATE_MISMATCH',
      'message', format('A reserva informada é para %s, divergente da data operacional atual (%s).', v_target_row.date, v_curr_date)
    );
  end if;

  -- 8. Idempotência estrita: se já atendida, devolve os dados sem nova transição
  if v_target_row.status = 'seated' then
    return jsonb_build_object(
      'success', false,
      'code', 'ALREADY_SEATED',
      'message', 'Esta reserva já foi marcada como atendida anteriormente.',
      'reservation', to_jsonb(v_target_row)
    );
  end if;

  -- 9. Tratamento de cancelamento e status inválido
  if v_target_row.status = 'cancelled' then
    return jsonb_build_object(
      'success', false,
      'code', 'CANCELLED',
      'message', 'A reserva informada foi cancelada e não pode ser atendida.'
    );
  end if;

  if v_target_row.status not in ('confirmed', 'confirmada', 'agendada', 'reservada') then
    return jsonb_build_object(
      'success', false,
      'code', 'INVALID_STATUS',
      'message', format('Status da reserva não permite atendimento: %s.', v_target_row.status)
    );
  end if;

  -- 10. Transição atômica condicional para 'seated'
  update public.reservations
  set status = 'seated'
  where id = v_target_row.id
    and restaurant_id = p_restaurant_id
    and status in ('confirmed', 'confirmada', 'agendada', 'reservada')
  returning * into v_updated_row;

  if not found then
    -- Em caso de corrida ou alteração concorrente externa
    select * into v_target_row
    from public.reservations
    where id = p_reservation_id
      and restaurant_id = p_restaurant_id;

    if v_target_row.status = 'seated' then
      return jsonb_build_object(
        'success', false,
        'code', 'ALREADY_SEATED',
        'message', 'Esta reserva já foi atendida concorrentemente.',
        'reservation', to_jsonb(v_target_row)
      );
    else
      return jsonb_build_object(
        'success', false,
        'code', 'CONCURRENT_UPDATE',
        'message', 'A reserva foi alterada concorrentemente por outro operador.'
      );
    end if;
  end if;

  return jsonb_build_object(
    'success', true,
    'code', 'SEATED_SUCCESS',
    'message', 'Reserva confirmada e marcada como atendida com sucesso.',
    'reservation', to_jsonb(v_updated_row)
  );
end;
$$;

revoke all on function public.seat_table_reservation(uuid, smallint, uuid) from public, anon;
grant execute on function public.seat_table_reservation(uuid, smallint, uuid) to authenticated;

commit;

-- 01_stage1_assert.sql
-- Assertivas do Cenário 1: Confirma criação de public.reservations com banco limpo
do $$
begin
  if not exists (
    select 1 from information_schema.tables 
    where table_schema = 'public' and table_name = 'reservations'
  ) then
    raise exception 'FALHA CENÁRIO 1: Tabela public.reservations não foi criada a partir do zero!';
  end if;

  if not exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' and table_name = 'reservations' and column_name = 'origin_id'
  ) then
    raise exception 'FALHA CENÁRIO 1: Coluna origin_id não foi criada!';
  end if;

  if not exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' and table_name = 'reservations' and column_name = 'table_id'
  ) then
    raise exception 'FALHA CENÁRIO 1: Coluna table_id não foi criada!';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'reservations_restaurant_table_fk'
  ) then
    raise exception 'FALHA CENÁRIO 1: Foreign key reservations_restaurant_table_fk não foi criada!';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'trg_protect_reservation_restaurant_id'
  ) then
    raise exception 'FALHA CENÁRIO 1: Gatilho trg_protect_reservation_restaurant_id não foi criado!';
  end if;

  if not exists (
    select 1 from pg_proc
    where proname = 'seat_table_reservation' and pronargs = 3
  ) then
    raise exception 'FALHA CENÁRIO 1: RPC seat_table_reservation(uuid, smallint, uuid) não foi criada!';
  end if;

  raise notice '✓ SUCESSO CENÁRIO 1: Criação de public.reservations a partir de banco limpo validada com sucesso.';
end;
$$;

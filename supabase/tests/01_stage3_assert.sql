-- 01_stage3_assert.sql
-- Assertivas finais do Cenário 3: Confirma que após upgrade, políticas permissivas foram purgadas
do $$
declare
  v_bad_count integer;
  v_good_count integer;
begin
  -- 1. Garante que as políticas permissivas legadas foram totalmente eliminadas
  select count(*) into v_bad_count
  from pg_policies
  where schemaname = 'public' and tablename = 'reservations'
    and policyname in ('reservations_read_policy', 'reservations_write_policy');

  if v_bad_count <> 0 then
    raise exception 'FALHA CENÁRIO 3: Políticas permissivas legadas NÃO foram purgadas durante o upgrade!';
  end if;

  -- 2. Garante que as 4 políticas estritas foram instaladas
  select count(*) into v_good_count
  from pg_policies
  where schemaname = 'public' and tablename = 'reservations'
    and policyname in (
      'reservations_select_member',
      'reservations_insert_admin',
      'reservations_update_admin',
      'reservations_delete_admin'
    );

  if v_good_count <> 4 then
    raise exception 'FALHA CENÁRIO 3: As 4 políticas seguras não estão ativas após upgrade (encontradas: %)!', v_good_count;
  end if;

  -- 3. Confere presença de colunas adaptadas (ex.: origin_id, table_id)
  if not exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' and table_name = 'reservations' and column_name = 'origin_id'
  ) then
    raise exception 'FALHA CENÁRIO 3: Coluna origin_id não foi adicionada no upgrade!';
  end if;

  if not exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' and table_name = 'reservations' and column_name = 'table_id'
  ) then
    raise exception 'FALHA CENÁRIO 3: Coluna table_id não foi adicionada no upgrade!';
  end if;

  raise notice '✓ SUCESSO CENÁRIO 3: Upgrade a partir de reservas legadas removeu políticas permissivas e instalou modelo seguro.';
end;
$$;

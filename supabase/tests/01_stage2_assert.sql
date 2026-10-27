-- 01_stage2_assert.sql
-- Assertivas do Cenário 2: Confirma idempotência na reaplicação da migração de segurança
do $$
declare
  v_count_policies integer;
begin
  if not exists (
    select 1 from information_schema.tables 
    where table_schema = 'public' and table_name = 'reservations'
  ) then
    raise exception 'FALHA CENÁRIO 2: Tabela reservations sumiu após reaplicação!';
  end if;

  select count(*) into v_count_policies
  from pg_policies
  where schemaname = 'public' and tablename = 'reservations';

  if v_count_policies <> 4 then
    raise exception 'FALHA CENÁRIO 2: Idempotência violada. Número incorreto de políticas após reaplicação: %', v_count_policies;
  end if;

  raise notice '✓ SUCESSO CENÁRIO 2: Reaplicação da migração executada com sucesso (100%% idempotente).';
end;
$$;

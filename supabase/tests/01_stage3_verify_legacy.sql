-- 01_stage3_verify_legacy.sql
-- Assertivas intermediárias do Cenário 3: Confirma que o modelo legado possuía políticas permissivas
do $$
declare
  v_perm_count integer;
begin
  select count(*) into v_perm_count
  from pg_policies
  where schemaname = 'public' and tablename = 'reservations'
    and policyname in ('reservations_read_policy', 'reservations_write_policy');

  if v_perm_count <> 2 then
    raise exception 'FALHA CENÁRIO 3 (Intermediária): Políticas permissivas legadas não foram criadas pela migração 20261024164500 (encontradas: %)!', v_perm_count;
  end if;

  raise notice '✓ CENÁRIO 3 (Intermediária): Tabela legada configurada com 2 políticas permissivas (USING true).';
end;
$$;

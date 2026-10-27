-- ============================================================================
-- ASSERT: assert_concurrency_transfer.sql
-- Validação do Estado Final do Banco de Dados após Disputa Concorrente
-- ============================================================================

do $$
declare
  v_item record;
  v_audit_count integer;
  v_audit record;
begin
  -- 1. Verifica estado do item transferido
  select * into v_item
  from public.table_tab_items
  where id = '30000000-0000-0000-0000-000000000001';

  if not found then
    raise exception 'ASSERT FALHOU: Item de teste não encontrado após a transferência concorrente!';
  end if;

  if v_item.table_tab_id <> 'f2222222-2222-2222-2222-222222222222' then
    raise exception 'ASSERT FALHOU: Item deveria estar na comanda de destino f2222222..., mas está em %', v_item.table_tab_id;
  end if;

  if v_item.table_visit_id <> 'e2222222-2222-2222-2222-222222222222' then
    raise exception 'ASSERT FALHOU: Atendimento do item não foi atualizado para Mesa 2!';
  end if;

  if v_item.restaurant_table_id <> 'd2222222-2222-2222-2222-222222222222' then
    raise exception 'ASSERT FALHOU: Mesa do item não foi atualizada para Mesa 2!';
  end if;

  if v_item.status <> 'active' then
    raise exception 'ASSERT FALHOU: Status do item deveria ser active, mas é %', v_item.status;
  end if;

  -- 2. Verifica registro de auditoria na tabela table_tab_item_transfers
  select count(*) into v_audit_count
  from public.table_tab_item_transfers
  where item_id = '30000000-0000-0000-0000-000000000001';

  if v_audit_count <> 1 then
    raise exception 'ASSERT FALHOU: Deveria haver exatamente 1 registro de auditoria, mas há %', v_audit_count;
  end if;

  select * into v_audit
  from public.table_tab_item_transfers
  where item_id = '30000000-0000-0000-0000-000000000001';

  if v_audit.source_table_tab_id <> 'f1111111-1111-1111-1111-111111111111'
    or v_audit.target_table_tab_id <> 'f2222222-2222-2222-2222-222222222222'
    or v_audit.transferred_by_member_id <> 'c1111111-1111-1111-1111-111111111111'
  then
    raise exception 'ASSERT FALHOU: Dados da auditoria de transferência divergentes!';
  end if;

  raise notice 'ASSERT_TRANSFER_CONCURRENCY_PASSED';
end;
$$;

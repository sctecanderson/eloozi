-- ============================================================================
-- CONCURRENCY TEST: concurrency_transfer_session1.sql
-- Sessão 1: Transação que adquire locks exclusivos e retém por 2.5 segundos
-- ============================================================================

set application_name = 'eloozi_transfer_session1';
set statement_timeout = 30000;

-- Define identidade do garçom para a sessão
select set_config('request.jwt.claim.sub', 'b1111111-1111-1111-1111-111111111111', false);
select set_config('request.jwt.claims', '{"sub":"b1111111-1111-1111-1111-111111111111","role":"authenticated"}', false);

begin;

-- Executa transferência do item na Sessão 1
select public.transfer_table_tab_items(
  p_restaurant_slug => 'conc-transfer-rest',
  p_source_tab_id => 'f1111111-1111-1111-1111-111111111111'::uuid,
  p_target_tab_id => 'f2222222-2222-2222-2222-222222222222'::uuid,
  p_item_ids => array['30000000-0000-0000-0000-000000000001'::uuid],
  p_reason => 'Transferência concorrente Sessão 1 para Mesa 2'
);

-- Mantém locks ativos por 2.5 segundos para forçar a Sessão 2 a aguardar na fila de bloqueios
select pg_sleep(2.5);

commit;

do $$
begin
  raise notice 'TRANSFER_SESSION_1_SUCCESS';
end;
$$;

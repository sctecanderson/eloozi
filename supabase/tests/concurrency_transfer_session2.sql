-- ============================================================================
-- CONCURRENCY TEST: concurrency_transfer_session2.sql
-- Sessão 2: Disputa simultânea pelo mesmo item da comanda
-- Deve aguardar o lock da Sessão 1 e ser rejeitada após o commit da Sessão 1
-- ============================================================================

set application_name = 'eloozi_transfer_session2';
set statement_timeout = 30000;

-- Define identidade do garçom para a sessão
select set_config('request.jwt.claim.sub', 'b1111111-1111-1111-1111-111111111111', false);
select set_config('request.jwt.claims', '{"sub":"b1111111-1111-1111-1111-111111111111","role":"authenticated"}', false);

-- Aguarda 300ms para garantir que a Sessão 1 já iniciou e adquiriu os locks FOR UPDATE
select pg_sleep(0.3);

do $$
declare
  v_err_code text;
  v_err_msg text;
  v_res jsonb;
begin
  begin
    -- Tenta transferir concorrentemente o MESMO item que a Sessão 1 está transferindo
    -- Esta chamada ficará travada aguardando os locks da Sessão 1
    v_res := public.transfer_table_tab_items(
      p_restaurant_slug => 'conc-transfer-rest',
      p_source_tab_id => 'f1111111-1111-1111-1111-111111111111'::uuid,
      p_target_tab_id => 'f2222222-2222-2222-2222-222222222222'::uuid,
      p_item_ids => array['30000000-0000-0000-0000-000000000001'::uuid],
      p_reason => 'Transferência concorrente Sessão 2 disputa de lock'
    );

    -- Se chegou aqui sem erro, o lock concorrente falhou em proteger a atomicidade!
    raise exception 'FALHA DE CONCORRÊNCIA: Sessão 2 conseguiu transferir item já transferido pela Sessão 1!';
  exception
    when others then
      get stacked diagnostics v_err_code = returned_sqlstate, v_err_msg = message_text;
      -- O código esperado é 22023 (item não pertence mais à comanda de origem)
      if v_err_code = '22023' or v_err_msg like '%não pertence à comanda de origem%' then
        raise notice 'TRANSFER_SESSION_2_BLOCKED_AND_REJECTED';
      else
        raise exception 'Erro inesperado na Sessão 2: [%] %', v_err_code, v_err_msg;
      end if;
  end;
end;
$$;

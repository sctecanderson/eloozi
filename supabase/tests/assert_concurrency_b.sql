-- assert_concurrency_b.sql
-- Assertivas de estado final no banco para o Cenário B (Ordem Confirmação-Primeiro)
do $$
declare
  v_res_status text;
  v_res_notes text;
begin
  select status, notes into v_res_status, v_res_notes
  from public.reservations
  where id = '66666666-6666-6666-6666-666666666666';

  -- Na ordem confirmação-primeiro, o status final DEVE SER ESTRITAMENTE 'seated'.
  if v_res_status <> 'seated' then
    raise exception 'FALHA DE ASSERTIVA CENÁRIO B: Reserva deveria estar "seated", mas está "%" (foi indevidamente alterada para cancelada)!', v_res_status;
  end if;

  -- As notas não podem ter sido sobrescritas pelo cancelamento bloqueado
  if v_res_notes = 'Cancelada pelo Admin concorrentemente' then
    raise exception 'FALHA DE ASSERTIVA CENÁRIO B: Notas foram sobrescritas pelo cancelamento, violando o isolamento transacional!';
  end if;

  raise notice '✓ ASSERTIVAS CENÁRIO B APROVADAS: Zero linhas canceladas e status final estritamente "seated" com dados preservados.';
end;
$$;

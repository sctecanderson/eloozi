-- assert_concurrency_a.sql
-- Assertivas de estado final no banco para o Cenário A (Disputa Concorrente)
do $$
declare
  v_res_a_status text;
  v_res_b_status text;
begin
  select status into v_res_a_status
  from public.reservations
  where id = '44444444-4444-4444-4444-444444444444';

  if v_res_a_status <> 'seated' then
    raise exception 'FALHA DE ASSERTIVA CENÁRIO A: Reserva disputada deveria estar "seated", mas está "%"!', v_res_a_status;
  end if;

  select status into v_res_b_status
  from public.reservations
  where id = '55555555-5555-5555-5555-555555555555';

  if v_res_b_status <> 'confirmed' then
    raise exception 'FALHA DE ASSERTIVA CENÁRIO A: Segunda reserva da mesma mesa deveria ter permanecido "confirmed", mas está "%"!', v_res_b_status;
  end if;

  raise notice '✓ ASSERTIVAS CENÁRIO A APROVADAS: Reserva A = seated, Reserva B da mesma mesa = confirmed intacta.';
end;
$$;

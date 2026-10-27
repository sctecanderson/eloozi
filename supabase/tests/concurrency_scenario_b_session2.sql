-- concurrency_scenario_b_session2.sql
-- Sessão 2: Cancelamento concorrente da mesma reserva pelo Administrador
set application_name = 'eloozi_session_b2';

begin;
set local statement_timeout = '15s';
set local role authenticated;
-- Identidade do Admin do Restaurante (tem permissão de UPDATE via RLS)
set local "request.jwt.claim.sub" = '11111111-0000-0000-0000-111111111111';
set local "request.jwt.claims" = '{"sub":"11111111-0000-0000-0000-111111111111","role":"authenticated","is_anonymous":false}';

select pg_sleep(0.4);

select clock_timestamp() as session2_cancel_start;

-- O UPDATE requer lock exclusivo na linha da reserva e aguardará o COMMIT da Sessão 1.
-- Ao acordar após o COMMIT da Sessão 1, a reserva já estará com status = 'seated'.
-- Como o predicado filtra por confirmed/agendada/reservada, o comando deve afetar EXATAMENTE ZERO LINHAS.
update public.reservations
set status = 'cancelled', notes = 'Cancelada pelo Admin concorrentemente'
where id = '66666666-6666-6666-6666-666666666666'
  and status in ('confirmed', 'agendada', 'reservada');

select clock_timestamp() as session2_cancel_finish;
commit;

-- concurrency_scenario_a_session2.sql
-- Sessão 2: Tenta confirmar a mesma reserva e aguarda o término da Sessão 1.
set application_name = 'eloozi_session_a2';

begin;
set local statement_timeout = '15s';
set local role authenticated;
set local "request.jwt.claim.sub" = '33333333-3333-3333-3333-333333333333';
set local "request.jwt.claims" = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","is_anonymous":false}';

-- Pausa curta inicial (0.4s) para garantir que a Sessão 1 já adquiriu o row lock
select pg_sleep(0.4);

select clock_timestamp() as session2_call_start;

-- Esta chamada deve entrar em espera bloqueada (Lock Wait) até o commit da Sessão 1
select public.seat_table_reservation(
  '11111111-1111-1111-1111-111111111111'::uuid,
  10::smallint,
  '44444444-4444-4444-4444-444444444444'::uuid
) as session2_rpc_result;

select clock_timestamp() as session2_call_finish;
commit;

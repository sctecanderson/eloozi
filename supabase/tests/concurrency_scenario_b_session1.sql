-- concurrency_scenario_b_session1.sql
-- Sessão 1: Confirmação da Reserva (seat_table_reservation) com lock de 4 segundos
set application_name = 'eloozi_session_b1';

begin;
set local statement_timeout = '15s';
set local role authenticated;
set local "request.jwt.claim.sub" = '33333333-3333-3333-3333-333333333333';
set local "request.jwt.claims" = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","is_anonymous":false}';

select clock_timestamp() as session1_confirm_start;

select public.seat_table_reservation(
  '11111111-1111-1111-1111-111111111111'::uuid,
  10::smallint,
  '66666666-6666-6666-6666-666666666666'::uuid
) as session1_rpc_result;

select pg_sleep(4);

select clock_timestamp() as session1_confirm_commit;
commit;

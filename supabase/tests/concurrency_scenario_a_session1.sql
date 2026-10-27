-- concurrency_scenario_a_session1.sql
-- Sessão 1: Executa a RPC seat_table_reservation e retém a transação aberta por 4 segundos.
set application_name = 'eloozi_session_a1';

begin;
set local statement_timeout = '15s';
set local role authenticated;
set local "request.jwt.claim.sub" = '33333333-3333-3333-3333-333333333333';
set local "request.jwt.claims" = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","is_anonymous":false}';

select clock_timestamp() as session1_start;

select public.seat_table_reservation(
  '11111111-1111-1111-1111-111111111111'::uuid,
  10::smallint,
  '44444444-4444-4444-4444-444444444444'::uuid
) as session1_rpc_result;

-- Mantém a transação aberta e o lock exclusivo de linha retido
select pg_sleep(4);

select clock_timestamp() as session1_committing;
commit;

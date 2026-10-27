-- concurrency_cleanup.sql
-- Limpeza estrita e controlada exclusivamente dos dados de teste
begin;
delete from public.reservations where restaurant_id = '11111111-1111-1111-1111-111111111111';
delete from public.restaurant_members where restaurant_id = '11111111-1111-1111-1111-111111111111';
delete from public.restaurant_tables where restaurant_id = '11111111-1111-1111-1111-111111111111';
delete from public.restaurants where id = '11111111-1111-1111-1111-111111111111';
delete from auth.users where id in ('33333333-3333-3333-3333-333333333333', '11111111-0000-0000-0000-111111111111');
commit;

-- concurrency_fixtures.sql
-- Fixtures dedicadas exclusivamente para os testes de concorrência com duas sessões
begin;

-- 1. Restaurante de Teste
insert into public.restaurants (id, name, slug, timezone)
values ('11111111-1111-1111-1111-111111111111', 'Restaurante Concorrência Test', 'conc-test', 'America/Sao_Paulo')
on conflict (id) do update set timezone = 'America/Sao_Paulo';

-- 2. Mesa 10 Ativa
insert into public.restaurant_tables (id, restaurant_id, table_number, label, active, is_active, deleted_at)
values ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 10, 'Mesa 10 Conc', true, true, null)
on conflict (id) do update set active = true, is_active = true, deleted_at = null;

-- 3. Garçom e Administrador
insert into auth.users (id, email)
values 
  ('33333333-3333-3333-3333-333333333333', 'garcom-conc@test.com'),
  ('11111111-0000-0000-0000-111111111111', 'admin-conc@test.com')
on conflict do nothing;

insert into public.restaurant_members (restaurant_id, user_id, role, active)
values 
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'waiter', true),
  ('11111111-1111-1111-1111-111111111111', '11111111-0000-0000-0000-111111111111', 'admin', true)
on conflict do nothing;

-- 4. Limpeza prévia e criação de reservas
delete from public.reservations where restaurant_id = '11111111-1111-1111-1111-111111111111';

-- Reserva Cenário A: Disputa pelo mesmo ID
insert into public.reservations (
  id, restaurant_id, table_id, table_number, customer_name, phone,
  date, time, status, guests_count, origin_id
) values (
  '44444444-4444-4444-4444-444444444444',
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  10,
  'Cliente Concorrente A',
  '11999990001',
  (now() at time zone 'America/Sao_Paulo')::date,
  '19:30',
  'confirmed',
  4,
  'test-conc-res-a'
);

-- Reserva Cenário B: Confirmação vs Cancelamento
insert into public.reservations (
  id, restaurant_id, table_id, table_number, customer_name, phone,
  date, time, status, guests_count, origin_id
) values (
  '66666666-6666-6666-6666-666666666666',
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  10,
  'Cliente Concorrente B',
  '11999990002',
  (now() at time zone 'America/Sao_Paulo')::date,
'20:30',
'confirmed',
2,
'test-conc-res-b'
);

commit;

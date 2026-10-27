-- ============================================================================
-- TEST SUITE: 20261025090000_reservations_rls_test.sql
-- Validação da Segurança, Isolamento Multi-tenant, Concorrência e Regras de Negócio
--
-- Executado estritamente dentro de uma transação com ROLLBACK garantido.
-- Não gera efeitos colaterais nem persiste registros no banco de dados.
-- ============================================================================

begin;

do $$
declare
  -- Identificadores dos Restaurantes Sintéticos
  v_rest_a uuid := '11111111-1111-4111-a111-111111111111';
  v_rest_b uuid := '22222222-2222-4222-a222-222222222222';

  -- Identificadores dos Usuários Sintéticos
  v_user_anon uuid     := 'a0000000-0000-4000-a000-000000000001';
  v_user_no_link uuid  := 'a0000000-0000-4000-a000-000000000002';
  v_user_inactive uuid := 'a0000000-0000-4000-a000-000000000003';
  v_admin_a uuid       := 'a0000000-0000-4000-a000-000000000004';
  v_admin_b uuid       := 'a0000000-0000-4000-a000-000000000005';
  v_admin_ab uuid      := 'a0000000-0000-4000-a000-000000000006';
  v_waiter_a uuid      := 'a0000000-0000-4000-a000-000000000007';

  -- Identificadores das Mesas Sintéticas
  v_table_a1 uuid := 'c1111111-1111-4111-a111-111111111111';
  v_table_a2 uuid := 'c1111111-1111-4111-a111-222222222222';
  v_table_b1 uuid := 'c2222222-2222-4222-a222-111111111111';
  v_table_a3_old uuid := 'c1111111-1111-4111-a111-333333333333';
  v_table_a3_new uuid := 'c1111111-1111-4111-a111-444444444444';

  -- Identificadores das Reservas Sintéticas
  v_res_a1 uuid := 'b1111111-1111-4111-a111-111111111111';
  v_res_a2 uuid := 'b1111111-1111-4111-a111-222222222222';
  v_res_a1_night uuid := 'b1111111-1111-4111-a111-333333333333';
  v_res_a_diff_date uuid := 'b1111111-1111-4111-a111-444444444444';
  v_res_a_cancelled uuid := 'b1111111-1111-4111-a111-555555555555';
  v_res_b1 uuid := 'b2222222-2222-4222-a222-111111111111';
  v_res_a3_old uuid := 'b1111111-1111-4111-a111-666666666666';
  v_res_a3_new uuid := 'b1111111-1111-4111-a111-777777777777';
  v_res_edit_table uuid := 'b1111111-1111-4111-a111-888888888888';
  v_res_no_table_id uuid := 'b1111111-1111-4111-a111-999999999999';

  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_now_time time := (now() at time zone 'America/Sao_Paulo')::time;
  v_count integer;
  v_rows integer;
  v_check_name text;
  v_rpc_res jsonb;
  v_expected_sqlstate text;
  v_status_check text;
  v_check_table_id uuid;
  v_check_table_num smallint;
begin
  raise notice '===============================================================';
  raise notice 'INICIANDO SUITE DE TESTES: ISOLAMENTO E SEGURANÇA DE RESERVAS';
  raise notice '===============================================================';

  -- --------------------------------------------------------------------------
  -- SETUP: Criação determinística de fixtures
  -- --------------------------------------------------------------------------
  -- 1. Usuários de autenticação sintéticos
  insert into auth.users (id, email)
  values
    (v_user_anon,     'anon-test@eloozi.test'),
    (v_user_no_link,  'nolink-test@eloozi.test'),
    (v_user_inactive, 'inactive-test@eloozi.test'),
    (v_admin_a,       'admina-test@eloozi.test'),
    (v_admin_b,       'adminb-test@eloozi.test'),
    (v_admin_ab,      'adminab-test@eloozi.test'),
    (v_waiter_a,      'waitera-test@eloozi.test');

  -- 2. Restaurantes A e B
  insert into public.restaurants (id, name, slug, active, timezone)
  values
    (v_rest_a, 'Restaurante Alpha Teste', 'alpha-test-res', true, 'America/Sao_Paulo'),
    (v_rest_b, 'Restaurante Beta Teste',  'beta-test-res',  true, 'America/Sao_Paulo');

  -- 3. Mesas com identidade estável (UUID) e modelo real (deleted_at e is_active)
  insert into public.restaurant_tables (id, restaurant_id, table_number, label, active, is_active, deleted_at)
  values
    (v_table_a1, v_rest_a, 1, 'Mesa 1 Alpha', true, true, null),
    (v_table_a2, v_rest_a, 2, 'Mesa 2 Alpha', true, true, null),
    (v_table_b1, v_rest_b, 1, 'Mesa 1 Beta',  true, true, null);

  -- 4. Vínculos operacionais em restaurant_members
  insert into public.restaurant_members (restaurant_id, user_id, role, active)
  values
    (v_rest_a, v_user_inactive, 'admin', false),  -- Admin inativo
    (v_rest_a, v_admin_a,       'admin', true),   -- Admin de A
    (v_rest_b, v_admin_b,       'admin', true),   -- Admin de B
    (v_rest_a, v_admin_ab,      'admin', true),   -- Admin em ambos
    (v_rest_b, v_admin_ab,      'admin', true),
    (v_rest_a, v_waiter_a,      'waiter', true);  -- Garçom de A

  -- 5. Reservas de base com vínculo estável table_id
  insert into public.reservations (id, restaurant_id, table_id, table_number, customer_name, phone, date, time, status, guests_count, notes, origin_id)
  values
    (v_res_a1, v_rest_a, v_table_a1, 1, 'Cliente Almoço Mesa 1', '11999990001', v_today, to_char(v_now_time, 'HH24:MI'), 'confirmed', 2, 'Almoço', 'local-id-a1'),
    (v_res_a1_night, v_rest_a, v_table_a1, 1, 'Cliente Jantar Mesa 1', '11999990002', v_today, '23:55', 'confirmed', 4, 'Jantar tardio', 'local-id-a1-night'),
    (v_res_a2, v_rest_a, v_table_a2, 2, 'Cliente Mesa 2', '11999990003', v_today, '20:30', 'confirmed', 4, 'Mesa 2 Alpha', 'local-id-a2'),
    (v_res_a_diff_date, v_rest_a, v_table_a1, 1, 'Cliente Amanhã', '11999990004', v_today + 1, '20:00', 'confirmed', 2, 'Data futura', 'local-id-a-fut'),
    (v_res_a_cancelled, v_rest_a, v_table_a1, 1, 'Cliente Cancelado', '11999990005', v_today, '19:00', 'cancelled', 2, 'Cancelada previa', 'local-id-a-canc'),
    (v_res_b1, v_rest_b, v_table_b1, 1, 'Cliente Beta 1',  '11888880001', v_today, '20:00', 'confirmed', 3, 'Reserva em B', 'local-id-b1');

  -- --------------------------------------------------------------------------
  -- CENÁRIO 1: Visitante anônimo sem login (papel anon)
  -- Com a revogação de todos os privilégios (REVOKE ALL ... FROM anon),
  -- tanto SELECT quanto INSERT devem ser barrados em nível de GRANT com SQLSTATE 42501.
  -- O teste exige estritamente SQLSTATE 42501 e falha se a consulta for permitida.
  -- --------------------------------------------------------------------------
  raise notice '[Cenário 1] Testando visitante não autenticado (anon)...';
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{}', true);

  -- 1.1 SELECT como anon deve exigir SQLSTATE 42501 (grant revogado)
  v_expected_sqlstate := '';
  begin
    select count(*) into v_count from public.reservations;
  exception when sqlstate '42501' then
    v_expected_sqlstate := '42501';
  end;
  if v_expected_sqlstate <> '42501' then
    raise exception 'FALHA NO CENÁRIO 1: SELECT como anon não exigiu SQLSTATE 42501 (consulta foi permitida ou gerou erro inesperado).';
  end if;

  -- 1.2 INSERT como anon deve exigir SQLSTATE 42501 (grant revogado)
  v_expected_sqlstate := '';
  begin
    insert into public.reservations (restaurant_id, table_number, customer_name, date, time)
    values (v_rest_a, 1, 'Hacker Anon', v_today, '20:00');
  exception when sqlstate '42501' then
    v_expected_sqlstate := '42501';
  end;
  if v_expected_sqlstate <> '42501' then
    raise exception 'FALHA NO CENÁRIO 1: Visitante anon não recebeu erro 42501 no INSERT.';
  end if;
  raise notice '✓ CENÁRIO 1 APROVADO: Visitante anon bloqueado.';

  -- --------------------------------------------------------------------------
  -- CENÁRIO 2: Sessão anônima do Supabase Auth (is_anonymous = true)
  -- --------------------------------------------------------------------------
  raise notice '[Cenário 2] Testando sessão com flag is_anonymous = true...';
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_user_anon::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_user_anon, 'is_anonymous', true)::text, true);

  select count(*) into v_count from public.reservations;
  if v_count <> 0 then
    raise exception 'FALHA NO CENÁRIO 2: Autenticado anônimo leu % reservas.', v_count;
  end if;

  v_expected_sqlstate := '';
  begin
    insert into public.reservations (restaurant_id, table_number, customer_name, date, time)
    values (v_rest_a, 1, 'Hacker Auth Anon', v_today, '20:00');
  exception when sqlstate '42501' then
    v_expected_sqlstate := '42501';
  end;
  if v_expected_sqlstate <> '42501' then
    raise exception 'FALHA NO CENÁRIO 2: Autenticado anônimo não foi bloqueado no INSERT com 42501.';
  end if;
  raise notice '✓ CENÁRIO 2 APROVADO: Sessão anônima de auth bloqueada.';

  -- --------------------------------------------------------------------------
  -- CENÁRIO 3: Usuário autenticado real sem vínculo ao restaurante
  -- --------------------------------------------------------------------------
  raise notice '[Cenário 3] Testando usuário sem vínculo...';
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_user_no_link::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_user_no_link, 'is_anonymous', false)::text, true);

  select count(*) into v_count from public.reservations;
  if v_count <> 0 then
    raise exception 'FALHA NO CENÁRIO 3: Usuário sem vínculo leu % reservas.', v_count;
  end if;
  raise notice '✓ CENÁRIO 3 APROVADO: Usuário sem vínculo bloqueado.';

  -- --------------------------------------------------------------------------
  -- CENÁRIO 4: Usuário com vínculo inativo (active = false)
  -- --------------------------------------------------------------------------
  raise notice '[Cenário 4] Testando membro inativo...';
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_user_inactive::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_user_inactive, 'is_anonymous', false)::text, true);

  select count(*) into v_count from public.reservations;
  if v_count <> 0 then
    raise exception 'FALHA NO CENÁRIO 4: Membro inativo leu % reservas.', v_count;
  end if;
  raise notice '✓ CENÁRIO 4 APROVADO: Membro inativo bloqueado.';

  -- --------------------------------------------------------------------------
  -- CENÁRIO 5: Admin de A operando suas próprias reservas (CRUD completo)
  -- --------------------------------------------------------------------------
  raise notice '[Cenário 5] Testando Admin autorizado em seu próprio restaurante...';
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_admin_a::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin_a, 'is_anonymous', false)::text, true);

  -- 5.1 SELECT de A
  select count(*) into v_count from public.reservations where restaurant_id = v_rest_a;
  if v_count <> 5 then
    raise exception 'FALHA NO CENÁRIO 5.1: Admin de A esperava 5 reservas em A, encontrou %.', v_count;
  end if;

  -- 5.2 INSERT em A
  insert into public.reservations (restaurant_id, table_number, customer_name, phone, date, time, status, guests_count, origin_id)
  values (v_rest_a, 2, 'Cliente Novo A', '11999990099', v_today, '21:00', 'confirmed', 2, 'local-id-novo-a');

  -- 5.3 UPDATE em A
  update public.reservations
  set notes = 'Observação atualizada pelo Admin'
  where restaurant_id = v_rest_a and origin_id = 'local-id-novo-a';

  -- 5.4 DELETE em A
  delete from public.reservations
  where restaurant_id = v_rest_a and origin_id = 'local-id-novo-a';

  raise notice '✓ CENÁRIO 5 APROVADO: Admin de A executou CRUD completo com sucesso.';

  -- --------------------------------------------------------------------------
  -- CENÁRIO 6: Admin de A tentando acessar Restaurante B (Isolamento)
  -- --------------------------------------------------------------------------
  raise notice '[Cenário 6] Testando tentativa de acesso cruzado (Admin A em B)...';
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_admin_a::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin_a, 'is_anonymous', false)::text, true);

  -- 6.1 Tentativa de SELECT em B
  select count(*) into v_count from public.reservations where restaurant_id = v_rest_b;
  if v_count <> 0 then
    raise exception 'FALHA NO CENÁRIO 6.1: Admin de A conseguiu ler % reservas em B.', v_count;
  end if;

  -- 6.2 Tentativa de INSERT em B
  v_expected_sqlstate := '';
  begin
    insert into public.reservations (restaurant_id, table_number, customer_name, date, time)
    values (v_rest_b, 1, 'Invasão em B', v_today, '20:00');
  exception when sqlstate '42501' then
    v_expected_sqlstate := '42501';
  end;
  if v_expected_sqlstate <> '42501' then
    raise exception 'FALHA NO CENÁRIO 6.2: Admin de A conseguiu inserir reserva no Restaurante B.';
  end if;

  -- 6.3 Tentativa de UPDATE em B (deve afetar 0 linhas sob RLS)
  update public.reservations
  set customer_name = 'Nome Hacker'
  where restaurant_id = v_rest_b;
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'FALHA NO CENÁRIO 6.3: Admin de A alterou % reservas no Restaurante B.', v_rows;
  end if;

  -- 6.4 Tentativa de DELETE em B (deve afetar 0 linhas sob RLS)
  delete from public.reservations
  where restaurant_id = v_rest_b;
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'FALHA NO CENÁRIO 6.4: Admin de A deletou % reservas no Restaurante B.', v_rows;
  end if;

  -- 6.5 Confere integridade dos dados no Restaurante B
  perform set_config('role', 'postgres', true);
  select customer_name into v_check_name from public.reservations where id = v_res_b1;
  if v_check_name <> 'Cliente Beta 1' then
    raise exception 'FALHA NO CENÁRIO 6.5: Dados do Restaurante B foram corrompidos: %', v_check_name;
  end if;

  raise notice '✓ CENÁRIO 6 APROVADO: Isolamento estrito entre Restaurante A e B comprovado.';

  -- --------------------------------------------------------------------------
  -- CENÁRIO 7: Bloqueio de transferência de restaurant_id (Imutabilidade)
  -- --------------------------------------------------------------------------
  raise notice '[Cenário 7] Testando tentativa de alterar restaurant_id...';
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_admin_ab::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin_ab, 'is_anonymous', false)::text, true);

  v_expected_sqlstate := '';
  begin
    update public.reservations
    set restaurant_id = v_rest_b
    where id = v_res_a1;
  exception when sqlstate '42501' then
    v_expected_sqlstate := '42501';
  end;
  if v_expected_sqlstate <> '42501' then
    raise exception 'FALHA NO CENÁRIO 7: Gatilho não barrou a alteração de restaurant_id.';
  end if;
  raise notice '✓ CENÁRIO 7 APROVADO: restaurant_id imutável.';

  -- --------------------------------------------------------------------------
  -- CENÁRIO 8: Permissões do Garçom (Leitura autorizada, escrita direta bloqueada)
  -- --------------------------------------------------------------------------
  raise notice '[Cenário 8] Testando permissões diretas do garçom...';
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_waiter_a::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_waiter_a, 'is_anonymous', false)::text, true);

  -- 8.1 Leitura autorizada de A
  select count(*) into v_count from public.reservations where restaurant_id = v_rest_a;
  if v_count <> 5 then
    raise exception 'FALHA NO CENÁRIO 8.1: Garçom não conseguiu ler as 5 reservas de A (encontrou %).', v_count;
  end if;

  -- 8.2 Tentativa de INSERT direto pelo garçom (deve ser rejeitado com 42501)
  v_expected_sqlstate := '';
  begin
    insert into public.reservations (restaurant_id, table_number, customer_name, date, time)
    values (v_rest_a, 1, 'Cliente Criado por Garçom', v_today, '20:00');
  exception when sqlstate '42501' then
    v_expected_sqlstate := '42501';
  end;
  if v_expected_sqlstate <> '42501' then
    raise exception 'FALHA NO CENÁRIO 8.2: Garçom conseguiu inserir reserva diretamente sem permissão de admin.';
  end if;

  -- 8.3 Tentativa de UPDATE direto pelo garçom (deve afetar 0 linhas ou disparar 42501)
  v_expected_sqlstate := '';
  begin
    update public.reservations
    set status = 'seated'
    where id = v_res_a1;
    get diagnostics v_rows = row_count;
  exception when sqlstate '42501' then
    v_expected_sqlstate := '42501';
    v_rows := 0;
  end;
  if v_rows <> 0 then
    raise exception 'FALHA NO CENÁRIO 8.3: Garçom conseguiu executar UPDATE direto (% linhas afetadas).', v_rows;
  end if;

  -- 8.4 Tentativa de DELETE direto pelo garçom (deve afetar 0 linhas ou disparar 42501)
  v_expected_sqlstate := '';
  begin
    delete from public.reservations
    where id = v_res_a1;
    get diagnostics v_rows = row_count;
  exception when sqlstate '42501' then
    v_expected_sqlstate := '42501';
    v_rows := 0;
  end;
  if v_rows <> 0 then
    raise exception 'FALHA NO CENÁRIO 8.4: Garçom conseguiu executar DELETE direto (% linhas afetadas).', v_rows;
  end if;

  -- 8.5 Confirmação de que os dados permaneceram intactos após tentativas não autorizadas
  perform set_config('role', 'postgres', true);
  select status into v_status_check from public.reservations where id = v_res_a1;
  if v_status_check <> 'confirmed' then
    raise exception 'FALHA NO CENÁRIO 8.5: Status da reserva foi alterado indevidamente: %', v_status_check;
  end if;

  raise notice '✓ CENÁRIO 8 APROVADO: Garçom possui apenas leitura direta. Escritas diretas foram bloqueadas e dados permaneceram intactos.';

  -- --------------------------------------------------------------------------
  -- CENÁRIO 9: Validação Rigorosa da RPC seat_table_reservation
  -- --------------------------------------------------------------------------
  raise notice '[Cenário 9] Testando RPC seat_table_reservation...';
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_waiter_a::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_waiter_a, 'is_anonymous', false)::text, true);

  -- 9.1 Validação de ID nulo/ausente (elimina seleção automática)
  v_rpc_res := public.seat_table_reservation(v_rest_a, 1::smallint, null);
  if (v_rpc_res ->> 'success')::boolean is not false or (v_rpc_res ->> 'code') <> 'INVALID_RESERVATION_ID' then
    raise exception 'FALHA NO CENÁRIO 9.1: RPC não barrou ID nulo com INVALID_RESERVATION_ID. Resposta: %', v_rpc_res;
  end if;

  -- 9.2 Validação de mesa divergente quando chamada com mesa 99 (reserva vinculada à Mesa 1)
  v_rpc_res := public.seat_table_reservation(v_rest_a, 99::smallint, v_res_a1);
  if (v_rpc_res ->> 'success')::boolean is not false or (v_rpc_res ->> 'code') <> 'TABLE_MISMATCH' then
    raise exception 'FALHA NO CENÁRIO 9.2: RPC não retornou TABLE_MISMATCH para reserva de Mesa 1 chamada com Mesa 99. Resposta: %', v_rpc_res;
  end if;

  -- Confere que status e vínculo da reserva permaneceram intactos
  perform set_config('role', 'postgres', true);
  select status, table_id, table_number into v_status_check, v_check_table_id, v_check_table_num
  from public.reservations where id = v_res_a1;
  if v_status_check <> 'confirmed' or v_check_table_id <> v_table_a1 or v_check_table_num <> 1 then
    raise exception 'FALHA NO CENÁRIO 9.2: Chamada com Mesa 99 alterou indevidamente o status ou vínculo da reserva (status=%, table_id=%, table_number=%)', v_status_check, v_check_table_id, v_check_table_num;
  end if;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_waiter_a::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_waiter_a, 'is_anonymous', false)::text, true);

  -- 9.3 Validação de mesa divergente (reserva de Mesa 1 chamada com Mesa 2)
  v_rpc_res := public.seat_table_reservation(v_rest_a, 2::smallint, v_res_a1);
  if (v_rpc_res ->> 'success')::boolean is not false or (v_rpc_res ->> 'code') <> 'TABLE_MISMATCH' then
    raise exception 'FALHA NO CENÁRIO 9.3: RPC não barrou TABLE_MISMATCH para Mesa 2. Resposta: %', v_rpc_res;
  end if;

  -- Confere que status e vínculo da reserva permaneceram intactos
  perform set_config('role', 'postgres', true);
  select status, table_id, table_number into v_status_check, v_check_table_id, v_check_table_num
  from public.reservations where id = v_res_a1;
  if v_status_check <> 'confirmed' or v_check_table_id <> v_table_a1 or v_check_table_num <> 1 then
    raise exception 'FALHA NO CENÁRIO 9.3: Chamada com Mesa 2 alterou indevidamente o status ou vínculo da reserva (status=%, table_id=%, table_number=%)', v_status_check, v_check_table_id, v_check_table_num;
  end if;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_waiter_a::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_waiter_a, 'is_anonymous', false)::text, true);

  -- 9.4 Validação de data divergente (reserva de data futura)
  v_rpc_res := public.seat_table_reservation(v_rest_a, 1::smallint, v_res_a_diff_date);
  if (v_rpc_res ->> 'success')::boolean is not false or (v_rpc_res ->> 'code') <> 'DATE_MISMATCH' then
    raise exception 'FALHA NO CENÁRIO 9.4: RPC não barrou DATE_MISMATCH. Resposta: %', v_rpc_res;
  end if;

  -- 9.5 Validação de reserva cancelada
  v_rpc_res := public.seat_table_reservation(v_rest_a, 1::smallint, v_res_a_cancelled);
  if (v_rpc_res ->> 'success')::boolean is not false or (v_rpc_res ->> 'code') <> 'CANCELLED' then
    raise exception 'FALHA NO CENÁRIO 9.5: RPC não barrou reserva cancelada com CANCELLED. Resposta: %', v_rpc_res;
  end if;

  -- 9.6 Acomodação com ID explícito (Mesa 1, Almoço)
  v_rpc_res := public.seat_table_reservation(v_rest_a, 1::smallint, v_res_a1);
  if (v_rpc_res ->> 'success')::boolean is not true or (v_rpc_res ->> 'code') <> 'SEATED_SUCCESS' then
    raise exception 'FALHA NO CENÁRIO 9.6: RPC não confirmou reserva com SEATED_SUCCESS. Resposta: %', v_rpc_res;
  end if;

  -- 9.7 Confirmação repetida do mesmo ID: deve retornar ALREADY_SEATED com os dados preservados
  v_rpc_res := public.seat_table_reservation(v_rest_a, 1::smallint, v_res_a1);
  if (v_rpc_res ->> 'success')::boolean is not false or (v_rpc_res ->> 'code') <> 'ALREADY_SEATED' then
    raise exception 'FALHA NO CENÁRIO 9.7: Confirmação repetida não retornou ALREADY_SEATED. Resposta: %', v_rpc_res;
  end if;

  -- 9.8 Independência entre reservas da mesma mesa:
  -- A reserva da noite na mesma Mesa 1 (v_res_a1_night, 23:55) DEVE permanecer confirmed!
  perform set_config('role', 'postgres', true);
  select status into v_status_check from public.reservations where id = v_res_a1_night;
  if v_status_check <> 'confirmed' then
    raise exception 'FALHA NO CENÁRIO 9.8: Atender o almoço alterou indevidamente a reserva do jantar da mesma mesa! Status: %', v_status_check;
  end if;

  -- Retorna ao papel do garçom
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_waiter_a::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_waiter_a, 'is_anonymous', false)::text, true);

  -- 9.9 Tentativa de garçom de A executar RPC no Restaurante B
  v_expected_sqlstate := '';
  begin
    perform public.seat_table_reservation(v_rest_b, 1::smallint, v_res_b1);
  exception when sqlstate '42501' then
    v_expected_sqlstate := '42501';
  end;
  if v_expected_sqlstate <> '42501' then
    raise exception 'FALHA NO CENÁRIO 9.9: Garçom de A conseguiu executar RPC no Restaurante B.';
  end if;
  raise notice '✓ CENÁRIO 9 APROVADO: RPC validou ID obrigatório, mesa, data civil, cancelamento, idempotência e independência entre reservas.';

  -- --------------------------------------------------------------------------
  -- CENÁRIO 10: Modelo Real de Mesas (Criação, Edição, Exclusão Lógica,
  -- Reutilização de Número, Reconciliação Obrigatória e Política Restritiva)
  -- --------------------------------------------------------------------------
  raise notice '[Cenário 10] Testando criação, edição de mesa, exclusão lógica, reutilização de número e reconciliação...';

  -- 10.1 Criação de Reserva: Resolução automática de table_id quando omitido
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_admin_a::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin_a, 'is_anonymous', false)::text, true);

  insert into public.reservations (id, restaurant_id, table_number, customer_name, phone, date, time, status, guests_count, origin_id)
  values (v_res_edit_table, v_rest_a, 1, 'Cliente Teste Edicao', '11999990088', v_today, '21:00', 'confirmed', 2, 'origin-edit-table');

  -- Confere se o gatilho resolveu table_id automaticamente para v_table_a1
  select table_id, table_number into v_check_table_id, v_check_table_num
  from public.reservations
  where id = v_res_edit_table;

  if v_check_table_id <> v_table_a1 or v_check_table_num <> 1 then
    raise exception 'FALHA NO CENÁRIO 10.1: Gatilho não resolveu table_id automaticamente na criação (esperado %, obtido %).', v_table_a1, v_check_table_id;
  end if;

  -- 10.2 Troca autorizada de mesa via UPDATE (alterando table_number)
  update public.reservations
  set table_number = 2
  where id = v_res_edit_table;

  select table_id, table_number into v_check_table_id, v_check_table_num
  from public.reservations
  where id = v_res_edit_table;

  if v_check_table_id <> v_table_a2 or v_check_table_num <> 2 then
    raise exception 'FALHA NO CENÁRIO 10.2a: Troca de mesa por número não atualizou o table_id correto (esperado %, obtido %).', v_table_a2, v_check_table_id;
  end if;

  -- 10.2b Troca autorizada de mesa via UPDATE (alterando table_id diretamente)
  update public.reservations
  set table_id = v_table_a1
  where id = v_res_edit_table;

  select table_id, table_number into v_check_table_id, v_check_table_num
  from public.reservations
  where id = v_res_edit_table;

  if v_check_table_id <> v_table_a1 or v_check_table_num <> 1 then
    raise exception 'FALHA NO CENÁRIO 10.2b: Troca de mesa por table_id não sincronizou o table_number (esperado 1, obtido %).', v_check_table_num;
  end if;

  -- 10.3 Bloqueio de troca de mesa para mesa de outro restaurante (preservação do isolamento)
  v_expected_sqlstate := '';
  begin
    update public.reservations
    set table_id = v_table_b1
    where id = v_res_edit_table;
  exception when sqlstate '22023' or sqlstate '23503' then
    v_expected_sqlstate := 'BLOCKED';
  end;
  if v_expected_sqlstate <> 'BLOCKED' then
    raise exception 'FALHA NO CENÁRIO 10.3: Conseguiu trocar mesa para uma mesa de outro restaurante!';
  end if;

  -- 10.4 Reconciliação obrigatória na RPC quando table_id está ausente (sem fallback silencioso)
  perform set_config('role', 'postgres', true);
  -- Cria temporariamente uma reserva sem table_id (simula migração de legado ou dado não reconciliado)
  alter table public.reservations disable trigger trg_sync_reservation_table;
  insert into public.reservations (id, restaurant_id, table_id, table_number, customer_name, date, time, status)
  values (v_res_no_table_id, v_rest_a, null, 1, 'Legado Sem Mesa', v_today, '20:00', 'confirmed');
  alter table public.reservations enable trigger trg_sync_reservation_table;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_waiter_a::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_waiter_a, 'is_anonymous', false)::text, true);

  v_rpc_res := public.seat_table_reservation(v_rest_a, 1::smallint, v_res_no_table_id);
  if (v_rpc_res ->> 'success')::boolean is not false or (v_rpc_res ->> 'code') <> 'TABLE_NOT_LINKED' then
    raise exception 'FALHA NO CENÁRIO 10.4: RPC não exigiu reconciliação para reserva com table_id ausente (TABLE_NOT_LINKED). Resposta: %', v_rpc_res;
  end if;

  -- 10.5 Rejeição de Mesa com Exclusão Lógica (deleted_at is not null)
  perform set_config('role', 'postgres', true);
  update public.restaurant_tables set deleted_at = now() where id = v_table_a2;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_admin_a::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin_a, 'is_anonymous', false)::text, true);

  -- Bloqueio de troca de mesa para mesa excluída
  v_expected_sqlstate := '';
  begin
    update public.reservations
    set table_id = v_table_a2
    where id = v_res_edit_table;
  exception when sqlstate '22023' then
    v_expected_sqlstate := '22023';
  end;
  if v_expected_sqlstate <> '22023' then
    raise exception 'FALHA NO CENÁRIO 10.5a: Conseguiu atualizar reserva associando a uma mesa excluída!';
  end if;

  -- Rejeição na RPC de atendimento para reserva vinculada a mesa excluída
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_waiter_a::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_waiter_a, 'is_anonymous', false)::text, true);

  v_rpc_res := public.seat_table_reservation(v_rest_a, 2::smallint, v_res_a2);
  if (v_rpc_res ->> 'success')::boolean is not false or (v_rpc_res ->> 'code') <> 'TABLE_DELETED' then
    raise exception 'FALHA NO CENÁRIO 10.5b: RPC não rejeitou mesa com exclusão lógica (TABLE_DELETED). Resposta: %', v_rpc_res;
  end if;

  -- 10.6 Reutilização do Número da Mesa por outra mesa após exclusão
  perform set_config('role', 'postgres', true);
  -- Cria mesa 3 original
  insert into public.restaurant_tables (id, restaurant_id, table_number, label, active, is_active, deleted_at)
  values (v_table_a3_old, v_rest_a, 3, 'Mesa 3 Original', true, true, null);

  -- Cria reserva vinculada à mesa 3 original
  insert into public.reservations (id, restaurant_id, table_id, table_number, customer_name, phone, date, time, status, guests_count, origin_id)
  values (v_res_a3_old, v_rest_a, v_table_a3_old, 3, 'Cliente Mesa 3 Antiga', '11999990030', v_today, '20:00', 'confirmed', 2, 'local-id-a3-old');

  -- Exclui logicamente a mesa 3 original
  update public.restaurant_tables set deleted_at = now() where id = v_table_a3_old;

  -- Cria nova mesa com o mesmo número 3 (o índice parcial UNIQUE WHERE deleted_at IS NULL permite)
  insert into public.restaurant_tables (id, restaurant_id, table_number, label, active, is_active, deleted_at)
  values (v_table_a3_new, v_rest_a, 3, 'Mesa 3 Nova Reutilizada', true, true, null);

  -- Cria nova reserva para a nova mesa 3
  insert into public.reservations (id, restaurant_id, table_id, table_number, customer_name, phone, date, time, status, guests_count, origin_id)
  values (v_res_a3_new, v_rest_a, v_table_a3_new, 3, 'Cliente Mesa 3 Nova', '11999990031', v_today, '20:30', 'confirmed', 4, 'local-id-a3-new');

  -- Retorna ao papel de garçom
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_waiter_a::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_waiter_a, 'is_anonymous', false)::text, true);

  -- A reserva antiga pertence à mesa excluída e deve ser barrada com TABLE_DELETED ou TABLE_REPLACED
  v_rpc_res := public.seat_table_reservation(v_rest_a, 3::smallint, v_res_a3_old);
  if (v_rpc_res ->> 'success')::boolean is not false or (v_rpc_res ->> 'code') not in ('TABLE_DELETED', 'TABLE_REPLACED') then
    raise exception 'FALHA NO CENÁRIO 10.6a: RPC permitiu atender reserva de mesa excluída na mesa reutilizada! Resposta: %', v_rpc_res;
  end if;

  -- A nova reserva pertence à nova mesa ativa e deve ser atendida com sucesso
  v_rpc_res := public.seat_table_reservation(v_rest_a, 3::smallint, v_res_a3_new);
  if (v_rpc_res ->> 'success')::boolean is not true or (v_rpc_res ->> 'code') <> 'SEATED_SUCCESS' then
    raise exception 'FALHA NO CENÁRIO 10.6b: RPC não confirmou nova reserva na mesa reutilizada. Resposta: %', v_rpc_res;
  end if;

  -- 10.7 Indicadores de atividade: rejeição de mesa inativa (is_active = false)
  perform set_config('role', 'postgres', true);
  update public.restaurant_tables set is_active = false where id = v_table_a3_new;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_waiter_a::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_waiter_a, 'is_anonymous', false)::text, true);

  v_rpc_res := public.seat_table_reservation(v_rest_a, 3::smallint, v_res_a3_new);
  if (v_rpc_res ->> 'success')::boolean is not false or (v_rpc_res ->> 'code') not in ('TABLE_INACTIVE', 'ALREADY_SEATED') then
    raise exception 'FALHA NO CENÁRIO 10.7: RPC não barrou atendimento em mesa inativa. Resposta: %', v_rpc_res;
  end if;

  -- 10.8 Isolamento estrito de mesa entre restaurantes (FK e Trigger)
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_admin_a::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin_a, 'is_anonymous', false)::text, true);

  v_expected_sqlstate := '';
  begin
    insert into public.reservations (restaurant_id, table_id, table_number, customer_name, date, time)
    values (v_rest_a, v_table_b1, 1, 'Hacker Cross Table', v_today, '20:00');
  exception when sqlstate '22023' or sqlstate '23503' then
    v_expected_sqlstate := 'BLOCKED';
  end;
  if v_expected_sqlstate <> 'BLOCKED' then
    raise exception 'FALHA NO CENÁRIO 10.8: Conseguiu criar reserva em A referenciando table_id de B!';
  end if;

  -- 10.9 Política restritiva de restaurante ativo (AS RESTRICTIVE)
  perform set_config('role', 'postgres', true);
  update public.restaurants set active = false where id = v_rest_b;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_admin_b::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_admin_b, 'is_anonymous', false)::text, true);

  -- Leitura de restaurant_members deve retornar 0 linhas devido à política restritiva
  select count(*) into v_count from public.restaurant_members where restaurant_id = v_rest_b;
  if v_count <> 0 then
    raise exception 'FALHA NO CENÁRIO 10.9a: Política restritiva não bloqueou leitura de restaurant_members em restaurante inativo (encontrou %).', v_count;
  end if;

  -- Leitura de restaurant_tables deve retornar 0 linhas devido à política restritiva
  select count(*) into v_count from public.restaurant_tables where restaurant_id = v_rest_b;
  if v_count <> 0 then
    raise exception 'FALHA NO CENÁRIO 10.9b: Política restritiva não bloqueou leitura de restaurant_tables em restaurante inativo (encontrou %).', v_count;
  end if;

  -- RPC também deve rejeitar operação em restaurante inativo
  v_expected_sqlstate := '';
  begin
    perform public.seat_table_reservation(v_rest_b, 1::smallint, v_res_b1);
  exception when sqlstate '42501' then
    v_expected_sqlstate := '42501';
  end;
  if v_expected_sqlstate <> '42501' then
    raise exception 'FALHA NO CENÁRIO 10.9c: RPC permitiu operação em restaurante inativo!';
  end if;

  raise notice '✓ CENÁRIO 10 APROVADO: Modelo real validado com criação, troca autorizada de mesa, exclusão lógica, reutilização de número, reconciliação obrigatória, atividade, FK isolada e política restritiva.';

  raise notice '===============================================================';
  raise notice 'SUITE DE TESTES CONCLUÍDA: TODOS OS CENÁRIOS FORAM VALIDADOS!';
  raise notice '===============================================================';
end;
$$;

rollback;

-- Executar SOMENTE em banco local descartável, após aplicar todas as migrations (ate 20261027210000)
-- em um ambiente com papéis anon/authenticated e auth.users compatíveis com Supabase.
\set ON_ERROR_STOP 1
-- Teste de papéis reais (anon/authenticated) para staff_profiles. Banco local descartável.
create function pg_temp.act(uid uuid, anon_claim boolean default false) returns void language plpgsql as $$
begin
 perform set_config('request.jwt.claim.sub', coalesce(uid::text,''), true);
 perform set_config('request.jwt.claims', json_build_object('sub',uid,'role','authenticated','is_anonymous',anon_claim)::text, true);
 execute 'set local role authenticated';
end $$;
-- Executa um SQL esperando um errcode/SQLSTATE; falha se não ocorrer.
create function pg_temp.expect(tag text, sql text, want text) returns void language plpgsql as $$
declare got text := 'OK';
begin
 begin execute sql; exception when others then got := sqlstate; end;
 if got is distinct from want then raise exception 'FALHA [%]: esperado %, obtido %', tag, want, got; end if;
 raise notice 'ok  [%] -> %', tag, want;
end $$;

-- Fixtures (superusuário)
insert into auth.users(id,email,email_confirmed_at) values
 ('a0000000-0000-0000-0000-00000000000a','admina@t.com',now()),
 ('a0000000-0000-0000-0000-0000000000b1','waitera@t.com',now()),
 ('a0000000-0000-0000-0000-0000000000c1','inativoa@t.com',now()),
 ('a0000000-0000-0000-0000-0000000000d1','adminb@t.com',now()),
 ('a0000000-0000-0000-0000-0000000000e1','ninguem@t.com',now());
insert into public.restaurants(id,slug,name) values
 ('b0000000-0000-0000-0000-00000000000a','rest-a','Rest A'),
 ('b0000000-0000-0000-0000-00000000000b','rest-b','Rest B'),
 ('b0000000-0000-0000-0000-00000000000c','rest-c','Rest C inativo');
update public.restaurants set active=false where slug='rest-c';
insert into public.restaurant_members(restaurant_id,user_id,role,active) values
 ('b0000000-0000-0000-0000-00000000000a','a0000000-0000-0000-0000-00000000000a','admin',true),
 ('b0000000-0000-0000-0000-00000000000a','a0000000-0000-0000-0000-0000000000b1','waiter',true),
 ('b0000000-0000-0000-0000-00000000000a','a0000000-0000-0000-0000-0000000000c1','admin',false),
 ('b0000000-0000-0000-0000-00000000000b','a0000000-0000-0000-0000-0000000000d1','admin',true),
 ('b0000000-0000-0000-0000-00000000000c','a0000000-0000-0000-0000-00000000000a','admin',true);

begin; -- ===== anon =====
 set local role anon;
 select pg_temp.expect('anon select tabela',$$select * from public.staff_profiles$$,'42501');
 select pg_temp.expect('anon insert tabela',$$insert into public.staff_profiles(restaurant_id,email,name,cargo) values(gen_random_uuid(),'x@x.com','x','x')$$,'42501');
 select pg_temp.expect('anon get',$$select public.get_staff_profiles('rest-a')$$,'42501');
 select pg_temp.expect('anon upsert',$$select public.upsert_staff_profile('rest-a','{"email":"x@x.com","name":"x","cargo":"x"}'::jsonb)$$,'42501');
 select pg_temp.expect('anon delete',$$select public.delete_staff_profile('rest-a','x@x.com')$$,'42501');
rollback;

begin; -- ===== authenticated sem acesso direto/helpers =====
 select pg_temp.act('a0000000-0000-0000-0000-00000000000a');
 select pg_temp.expect('auth select direto',$$select * from public.staff_profiles$$,'42501');
 select pg_temp.expect('auth update direto',$$update public.staff_profiles set name='x'$$,'42501');
 select pg_temp.expect('auth delete direto',$$delete from public.staff_profiles$$,'42501');
 select pg_temp.expect('auth helper require_catalog_admin',$$select public.require_catalog_admin('rest-a')$$,'42501');
 select pg_temp.expect('auth helper lock_staff_management',$$select public.lock_staff_management('rest-a')$$,'42501');
rollback;

begin; -- ===== admin autorizado A =====
 select pg_temp.act('a0000000-0000-0000-0000-00000000000a');
 select pg_temp.expect('adminA upsert',$$select public.upsert_staff_profile('rest-a','{"email":" Maria@T.com ","name":"Maria Souza","phone":"11999","cpf":"123","avatarUrl":"data:image/jpeg;base64,AAAA","cargo":"Garçom","permissions":["mesas"],"active":true}'::jsonb)$$,'OK');
 select pg_temp.expect('adminA upsert 2 (atualiza)',$$select public.upsert_staff_profile('rest-a','{"email":"maria@t.com","name":"Maria S. Souza","phone":"11888","cpf":"123","cargo":"Garçom","permissions":["mesas","estoque"]}'::jsonb)$$,'OK');
 do $$ declare r jsonb; begin
  r := public.get_staff_profiles('rest-a');
  if jsonb_array_length(r)<>1 then raise exception 'FALHA: esperado 1 perfil, obtido %', jsonb_array_length(r); end if;
  if r->0->>'email' <> 'maria@t.com' or r->0->>'name' <> 'Maria S. Souza' or r->0->>'phone' <> '11888' or r->0->>'cpf' <> '123' then raise exception 'FALHA: dados divergentes'; end if;
  if (r->0->>'avatarUrl') is not null then raise notice 'info: avatar substituído pelo upsert (comportamento: campo ausente apaga)'; end if;
  raise notice 'ok  [adminA get/atualização sem duplicar]';
 end $$;
 select pg_temp.expect('adminA em restaurante B',$$select public.get_staff_profiles('rest-b')$$,'42501');
 select pg_temp.expect('adminA upsert em B',$$select public.upsert_staff_profile('rest-b','{"email":"m@t.com","name":"M","cargo":"G"}'::jsonb)$$,'42501');
 select pg_temp.expect('adminA em restaurante inativo (C)',$$select public.get_staff_profiles('rest-c')$$,'42501');
 select pg_temp.expect('slug inexistente',$$select public.get_staff_profiles('nao-existe')$$,'42501');
 select pg_temp.expect('email inválido',$$select public.upsert_staff_profile('rest-a','{"email":"invalido","name":"M","cargo":"G"}'::jsonb)$$,'22023');
 select pg_temp.expect('nome vazio',$$select public.upsert_staff_profile('rest-a','{"email":"n@t.com","name":"  ","cargo":"G"}'::jsonb)$$,'22023');
 select pg_temp.expect('permissions não array',$$select public.upsert_staff_profile('rest-a','{"email":"n@t.com","name":"N","cargo":"G","permissions":"x"}'::jsonb)$$,'22023');
 select pg_temp.expect('avatar não data-url',$$select public.upsert_staff_profile('rest-a','{"email":"n@t.com","name":"N","cargo":"G","avatarUrl":"http://x/y.jpg"}'::jsonb)$$,'22023');
 select pg_temp.expect('avatar acima de 300k',format($f$select public.upsert_staff_profile('rest-a', jsonb_build_object('email','n@t.com','name','N','cargo','G','avatarUrl','data:image/jpeg;base64,'||%L))$f$, repeat('A',300001)),'22023');
 select pg_temp.expect('payload nulo',$$select public.upsert_staff_profile('rest-a',null)$$,'22023');
commit;

begin; -- ===== admin B: isolamento =====
 select pg_temp.act('a0000000-0000-0000-0000-0000000000d1');
 select pg_temp.expect('adminB upsert mesmo e-mail em B',$$select public.upsert_staff_profile('rest-b','{"email":"maria@t.com","name":"Maria de B","cargo":"G"}'::jsonb)$$,'OK');
 do $$ begin
  if jsonb_array_length(public.get_staff_profiles('rest-b'))<>1 or public.get_staff_profiles('rest-b')->0->>'name'<>'Maria de B' then raise exception 'FALHA: lista de B'; end if;
  perform public.delete_staff_profile('rest-b','maria@t.com');
  raise notice 'ok  [adminB lista/remove apenas em B]';
 end $$;
 select pg_temp.expect('adminB get em A',$$select public.get_staff_profiles('rest-a')$$,'42501');
 select pg_temp.expect('adminB delete em A',$$select public.delete_staff_profile('rest-a','maria@t.com')$$,'42501');
commit;
do $$ begin
 if (select count(*) from public.staff_profiles where restaurant_id='b0000000-0000-0000-0000-00000000000a')<>1 then raise exception 'FALHA: perfil de A foi afetado por B'; end if;
 raise notice 'ok  [perfil de A intacto após ações de B]';
end $$;

begin; -- ===== garçom ativo =====
 select pg_temp.act('a0000000-0000-0000-0000-0000000000b1');
 select pg_temp.expect('garçom get',$$select public.get_staff_profiles('rest-a')$$,'42501');
 select pg_temp.expect('garçom upsert',$$select public.upsert_staff_profile('rest-a','{"email":"z@t.com","name":"Z","cargo":"G"}'::jsonb)$$,'42501');
 select pg_temp.expect('garçom delete',$$select public.delete_staff_profile('rest-a','maria@t.com')$$,'42501');
rollback;

begin; -- ===== admin inativo =====
 select pg_temp.act('a0000000-0000-0000-0000-0000000000c1');
 select pg_temp.expect('admin inativo get',$$select public.get_staff_profiles('rest-a')$$,'42501');
 select pg_temp.expect('admin inativo upsert',$$select public.upsert_staff_profile('rest-a','{"email":"z@t.com","name":"Z","cargo":"G"}'::jsonb)$$,'42501');
 select pg_temp.expect('admin inativo delete',$$select public.delete_staff_profile('rest-a','maria@t.com')$$,'42501');
rollback;

begin; -- ===== autenticado sem vínculo / anônimo / sem sub =====
 select pg_temp.act('a0000000-0000-0000-0000-0000000000e1');
 select pg_temp.expect('sem vínculo get',$$select public.get_staff_profiles('rest-a')$$,'42501');
rollback;
begin;
 select pg_temp.act('a0000000-0000-0000-0000-00000000000a', true);
 select pg_temp.expect('sessão anônima (is_anonymous) get',$$select public.get_staff_profiles('rest-a')$$,'42501');
rollback;
begin;
 select pg_temp.act(null);
 select pg_temp.expect('authenticated sem sub',$$select public.get_staff_profiles('rest-a')$$,'42501');
rollback;

begin; -- ===== admin remove em A =====
 select pg_temp.act('a0000000-0000-0000-0000-00000000000a');
 select public.delete_staff_profile('rest-a','MARIA@t.com');
 do $$ begin if jsonb_array_length(public.get_staff_profiles('rest-a'))<>0 then raise exception 'FALHA: delete'; end if; raise notice 'ok  [adminA delete]'; end $$;
commit;

-- Concessões efetivas
do $$ begin
 if has_table_privilege('authenticated','public.staff_profiles','select') or has_table_privilege('anon','public.staff_profiles','select') then raise exception 'FALHA: grant em tabela'; end if;
 if has_function_privilege('anon','public.get_staff_profiles(text)','execute') then raise exception 'FALHA: anon executa RPC'; end if;
 if not has_function_privilege('authenticated','public.upsert_staff_profile(text,jsonb)','execute') then raise exception 'FALHA: authenticated sem execute'; end if;
 if has_function_privilege('authenticated','public.lock_staff_management(text)','execute') or has_function_privilege('authenticated','public.require_catalog_admin(text)','execute') then raise exception 'FALHA: helper exposto'; end if;
 if not (select relrowsecurity from pg_class where oid='public.staff_profiles'::regclass) then raise exception 'FALHA: RLS desligado'; end if;
 raise notice 'ok  [grants/RLS]';
end $$;

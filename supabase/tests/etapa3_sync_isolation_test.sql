-- Internal-only helper: direct callers, including legitimate tenant/platform admins,
-- must use the authorized business RPCs. Compare every column of every target table.
select stage3.check_true(not exists(
 select 1 from pg_proc p where p.pronamespace='public'::regnamespace
 and p.prosrc like '%perform public.sync_restaurant_tables_to_plan_limit%'
 and (not p.prosecdef or p.proowner<>(select proowner from pg_proc where oid='public.sync_restaurant_tables_to_plan_limit(uuid)'::regprocedure))
),'todos os chamadores internos sao SECURITY DEFINER do mesmo proprietario');
select p.oid::regprocedure::text,p.proowner::regrole,p.prosecdef,p.proacl
from pg_proc p where p.oid='public.sync_restaurant_tables_to_plan_limit(uuid)'::regprocedure
or (p.pronamespace='public'::regnamespace and p.prosrc like '%perform public.sync_restaurant_tables_to_plan_limit%');
insert into auth.users(id,email) values
 ('d3000000-0000-4000-8000-000000000010','stage3-unrelated@example.test'),
 ('d3000000-0000-4000-8000-000000000011','stage3-waiter@example.test'),
 ('d3000000-0000-4000-8000-000000000012','stage3-inactive@example.test');
insert into public.restaurant_members(restaurant_id,user_id,role,active) values
 ('e3000000-0000-4000-8000-000000000002','d3000000-0000-4000-8000-000000000011','waiter',true),
 ('e3000000-0000-4000-8000-000000000002','d3000000-0000-4000-8000-000000000012','admin',false);
do $$ declare r record; before_rows jsonb; after_rows jsonb; got text; begin
 for r in select * from (values
  ('anon','anon',null::text),
  ('admin A','authenticated','d3000000-0000-4000-8000-000000000001'),
  ('sem vinculo','authenticated','d3000000-0000-4000-8000-000000000010'),
  ('garcom','authenticated','d3000000-0000-4000-8000-000000000011'),
  ('admin inativo','authenticated','d3000000-0000-4000-8000-000000000012'),
  ('admin alvo','authenticated','d3000000-0000-4000-8000-000000000002'),
  ('platform admin','authenticated','d3000000-0000-4000-8000-000000000003'),
  ('service role direto','service_role',null::text)
 ) f(label,db_role,uid) loop
  select jsonb_agg(to_jsonb(t) order by id) into before_rows from public.restaurant_tables t where restaurant_id='e3000000-0000-4000-8000-000000000002';
  perform set_config('request.jwt.claim.sub',coalesce(r.uid,''),false);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',r.uid,'role',r.db_role)::text,false);
  execute format('set local role %I',r.db_role);
  got:='NO_ERROR';
  begin perform public.sync_restaurant_tables_to_plan_limit('e3000000-0000-4000-8000-000000000002');
  exception when others then got:=sqlstate; end;
  reset role;
  select jsonb_agg(to_jsonb(t) order by id) into after_rows from public.restaurant_tables t where restaurant_id='e3000000-0000-4000-8000-000000000002';
  perform stage3.check_true(got='42501' and before_rows is not distinct from after_rows,r.label||': negado e TODAS as mesas preservadas');
 end loop;
end $$;
select 'PASS: oito perfis sem EXECUTE direto; alvo integralmente preservado em cada tentativa';

-- Legitimate plan change and catalog sync through platform RPCs.
set request.jwt.claim.sub='d3000000-0000-4000-8000-000000000003';
set request.jwt.claims='{"sub":"d3000000-0000-4000-8000-000000000003","role":"authenticated"}';
set role authenticated;
select public.update_restaurant_saas_plan('e3000000-0000-4000-8000-000000000002','pro');
reset role;
select stage3.check_true((select active and is_active from public.restaurant_tables where restaurant_id='e3000000-0000-4000-8000-000000000002' and table_number=900),'alteracao de plano autorizada sincroniza mesa');
set role authenticated;
select public.update_platform_plan_catalog(9990,5,17990,20,27990,null,true,false,false,true);
reset role;
select stage3.check_true((select max_tables=20 from public.restaurants where id='e3000000-0000-4000-8000-000000000002'),'sync de catalogo autorizado funciona');

-- Waiter can close/release own visit through RPC without direct helper permission.
set request.jwt.claim.sub='d3000000-0000-4000-8000-000000000011';
set request.jwt.claims='{"sub":"d3000000-0000-4000-8000-000000000011","role":"authenticated"}';
set role authenticated;
select stage3.check_true((public.close_table_visit('stage3-b',(public.open_table_visit('stage3-b',900)).id)).status='closed','garcom encerra atendimento por RPC');
select public.open_table_visit('stage3-b',900);
select public.reset_and_release_table((select id from public.restaurant_tables where restaurant_id='e3000000-0000-4000-8000-000000000002' and table_number=900));
reset role;
select stage3.check_true(not exists(select 1 from public.table_visits where restaurant_id='e3000000-0000-4000-8000-000000000002' and status='open'),'garcom libera mesa por RPC');
set request.jwt.claim.sub='d3000000-0000-4000-8000-000000000002';
set request.jwt.claims='{"sub":"d3000000-0000-4000-8000-000000000002","role":"authenticated"}';
set role authenticated;
select public.delete_restaurant_table('stage3-b',900);
reset role;
reset request.jwt.claims;
reset request.jwt.claim.sub;
select 'PASS: chamadores plano, catalogo, encerramento, liberacao e exclusao preservados';

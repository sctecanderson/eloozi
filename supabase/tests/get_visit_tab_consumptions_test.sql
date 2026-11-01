begin;
create schema consumption_test;
create function consumption_test.ok(value boolean, label text) returns void language plpgsql as $$
begin
  if value is distinct from true then raise exception 'FAIL: %', label; end if;
  raise notice 'PASS: %', label;
end $$;
create function consumption_test.as(user_id uuid, query text) returns jsonb language plpgsql as $$
declare result jsonb;
begin
  perform set_config('request.jwt.claim.sub', user_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub',user_id,'role','authenticated')::text, true);
  set local role authenticated;
  execute query into result;
  reset role;
  return result;
exception when others then
  reset role;
  raise;
end $$;

insert into auth.users(id,email,is_anonymous) values
 ('a7100000-0000-4000-8000-000000000001','consumption-waiter@local.test',false),
 ('a7100000-0000-4000-8000-000000000002','consumption-unlinked@local.test',false);
insert into public.restaurants(id,name,slug,subscription_plan,max_tables,subscription_expires_at,service_fee_percent,unlimited_tables)
values
 ('b7100000-0000-4000-8000-000000000001','Consumption A','consumption-a','premium',null,now()+interval '30 days',10,true),
 ('b7100000-0000-4000-8000-000000000002','Consumption B','consumption-b','premium',null,now()+interval '30 days',0,true);
insert into public.restaurant_members(restaurant_id,user_id,role,active) values
 ('b7100000-0000-4000-8000-000000000001','a7100000-0000-4000-8000-000000000001','waiter',true);
insert into public.restaurant_tables(restaurant_id,table_number) values
 ('b7100000-0000-4000-8000-000000000001',1),('b7100000-0000-4000-8000-000000000002',1);
insert into public.menu_categories(id,restaurant_id,catalog_key,name,slug,active) values
 ('c7100000-0000-4000-8000-000000000001','b7100000-0000-4000-8000-000000000001','consumption-cat','Food','food',true);
insert into public.menu_products(id,restaurant_id,category_id,catalog_key,slug,name,price_in_cents,available,preparation_station)
values('d7100000-0000-4000-8000-000000000001','b7100000-0000-4000-8000-000000000001','c7100000-0000-4000-8000-000000000001','meal','meal','Meal',125,true,'none');

do $$
declare
  user_id constant uuid := 'a7100000-0000-4000-8000-000000000001';
  visit_id uuid;
  tab_a uuid := 'f7100000-0000-4000-8000-000000000001';
  tab_b uuid := 'f7100000-0000-4000-8000-000000000002';
  tabs jsonb;
  one_a jsonb;
  one_b jsonb;
  unlinked jsonb;
begin
  visit_id := (consumption_test.as(user_id,$q$select to_jsonb(public.open_table_visit('consumption-a',1))$q$)->>'id')::uuid;
  perform consumption_test.as(user_id,format($q$select to_jsonb(public.create_table_tab('consumption-a',%L,'Person A',%L))$q$,visit_id,tab_a));
  perform consumption_test.as(user_id,format($q$select to_jsonb(public.create_table_tab('consumption-a',%L,'Person B',%L))$q$,visit_id,tab_b));
  perform consumption_test.as(user_id,format($q$select to_jsonb(public.add_table_tab_item('consumption-a',%L,%L,2,gen_random_uuid()))$q$,tab_a,'d7100000-0000-4000-8000-000000000001'::uuid));
  perform consumption_test.as(user_id,format($q$select to_jsonb(public.add_table_tab_item('consumption-a',%L,%L,3,gen_random_uuid()))$q$,tab_b,'d7100000-0000-4000-8000-000000000001'::uuid));

  tabs := consumption_test.as(user_id,format($q$select public.get_visit_tab_consumptions(%L,%L)$q$,'b7100000-0000-4000-8000-000000000001'::uuid,visit_id));
  perform consumption_test.ok(jsonb_array_length(tabs)=2,'retorna uma linha de consumo por comanda aberta');
  perform consumption_test.ok((select count(*)=2 from jsonb_array_elements(tabs) e where e->>'tableTabId' in (tab_a::text,tab_b::text)),'retorno limitado às comandas abertas da visita-alvo');
  perform consumption_test.ok((select (e->>'totalInCents')::bigint=250 from jsonb_array_elements(tabs) e where e->>'tableTabId'=tab_a::text),'total da primeira comanda usa valores oficiais');
  perform consumption_test.ok((select (e->>'totalInCents')::bigint=375 from jsonb_array_elements(tabs) e where e->>'tableTabId'=tab_b::text),'total da segunda comanda usa valores oficiais');

  one_a := consumption_test.as(user_id,format($q$select public.get_table_tab_consumption(%L,%L)$q$,'b7100000-0000-4000-8000-000000000001'::uuid,tab_a));
  one_b := consumption_test.as(user_id,format($q$select public.get_table_tab_consumption(%L,%L)$q$,'b7100000-0000-4000-8000-000000000001'::uuid,tab_b));
  perform consumption_test.ok((select (e->>'totalInCents')::bigint=(one_a->>'totalInCents')::bigint and e->'items'=one_a->'items' from jsonb_array_elements(tabs) e where e->>'tableTabId'=tab_a::text),'lote corresponde à RPC individual para a comanda A');
  perform consumption_test.ok((select (e->>'totalInCents')::bigint=(one_b->>'totalInCents')::bigint and e->'items'=one_b->'items' from jsonb_array_elements(tabs) e where e->>'tableTabId'=tab_b::text),'lote corresponde à RPC individual para a comanda B');

  unlinked := consumption_test.as('a7100000-0000-4000-8000-000000000002',format($q$select public.get_visit_tab_consumptions(%L,%L)$q$,'b7100000-0000-4000-8000-000000000001'::uuid,visit_id));
  perform consumption_test.ok(unlinked='[]'::jsonb,'usuário sem vínculo não recebe consumos por RLS');
  unlinked := consumption_test.as(user_id,format($q$select public.get_visit_tab_consumptions(%L,%L)$q$,'b7100000-0000-4000-8000-000000000002'::uuid,visit_id));
  perform consumption_test.ok(unlinked='[]'::jsonb,'combinação restaurante/visita divergente não retorna dados');
end $$;
rollback;

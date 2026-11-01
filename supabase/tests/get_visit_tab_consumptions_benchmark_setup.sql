-- Fixture sintética somente no PostgreSQL descartável criado pelo runner.
insert into auth.users(id,email,is_anonymous) values
 ('a7200000-0000-4000-8000-000000000001','bench@local.test',false);
insert into public.restaurants(id,name,slug,subscription_plan,max_tables,subscription_expires_at,service_fee_percent,unlimited_tables)
 values('b7200000-0000-4000-8000-000000000001','Perf Bench','perf-bench','premium',null,now()+interval '30 days',10,true);
insert into public.restaurant_members(restaurant_id,user_id,role,active) values
 ('b7200000-0000-4000-8000-000000000001','a7200000-0000-4000-8000-000000000001','waiter',true);
insert into public.restaurant_tables(id,restaurant_id,table_number) values
 ('c7200000-0000-4000-8000-000000000001','b7200000-0000-4000-8000-000000000001',1);
insert into public.menu_categories(id,restaurant_id,catalog_key,name,slug,active) values
 ('d7200000-0000-4000-8000-000000000001','b7200000-0000-4000-8000-000000000001','cat','Food','food',true);
insert into public.menu_products(id,restaurant_id,category_id,catalog_key,slug,name,price_in_cents,available,preparation_station)
 values('d7200000-0000-4000-8000-000000000002','b7200000-0000-4000-8000-000000000001','d7200000-0000-4000-8000-000000000001','prod','prod','Item',125,true,'none');

create schema perf_test;
create function perf_test.as(query text) returns jsonb language plpgsql as $$
declare result jsonb;
begin
  perform set_config('request.jwt.claim.sub','a7200000-0000-4000-8000-000000000001',true);
  perform set_config('request.jwt.claims','{"sub":"a7200000-0000-4000-8000-000000000001","role":"authenticated"}',true);
  set local role authenticated;
  execute query into result;
  reset role;
  return result;
exception when others then reset role; raise;
end $$;

do $$
declare visit_id uuid; i integer; tab_id uuid;
begin
  visit_id := (perf_test.as($q$select to_jsonb(public.open_table_visit('perf-bench',1))$q$)->>'id')::uuid;
  for i in 1..20 loop
    tab_id := ('f7200000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid;
    perform perf_test.as(format($q$select to_jsonb(public.create_table_tab('perf-bench',%L,%L,%L))$q$,visit_id,'Person '||i,tab_id));
  end loop;
end $$;

-- Os dados sintéticos respeitam as FKs/checks. O trigger operacional é desativado
-- somente enquanto esta massa de teste local é gerada e reativado na mesma transação.
begin;
alter table public.table_tab_items disable trigger user;
insert into public.table_tab_items(id,restaurant_id,restaurant_table_id,table_visit_id,table_tab_id,product_id,product_name,unit_price_in_cents,quantity,added_by_member_id,created_at,preparation_station,production_status,prep_delivered_at)
select gen_random_uuid(), 'b7200000-0000-4000-8000-000000000001',
       'c7200000-0000-4000-8000-000000000001', visit.id, tab.id,
       'd7200000-0000-4000-8000-000000000002', 'Item', 125, 1, member.id,
       tab.created_at + (g.n * interval '1 millisecond'), 'none', 'delivered',
       tab.created_at + (g.n * interval '1 millisecond')
from public.table_visits visit
join public.restaurant_members member on member.restaurant_id=visit.restaurant_id
join public.table_tabs tab on tab.table_visit_id=visit.id and tab.restaurant_id=visit.restaurant_id
cross join generate_series(1,500) as g(n)
where visit.restaurant_id='b7200000-0000-4000-8000-000000000001'
  and visit.status='open' and tab.status='open';
alter table public.table_tab_items enable trigger user;
commit;
analyze public.table_tab_items;

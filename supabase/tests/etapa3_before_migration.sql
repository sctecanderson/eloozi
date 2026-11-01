-- Run after predecessors, BEFORE 20261028223000, in a disposable local database.
create schema stage3;
grant usage on schema stage3 to anon, authenticated, service_role;
create function stage3.check_true(ok boolean, label text) returns text language plpgsql as $$
begin if ok is distinct from true then raise exception 'FAIL: %',label; end if; return 'PASS: '||label; end $$;
create function stage3.expect_error(command text, expected text) returns text language plpgsql as $$
declare actual text := 'NO_ERROR';
begin
 begin execute command; exception when others then actual := sqlstate; end;
 if actual <> expected then raise exception 'FAIL expected %, got %: %',expected,actual,command; end if;
 return 'PASS expected SQLSTATE '||expected;
end $$;
insert into auth.users(id,email) values
 ('d3000000-0000-4000-8000-000000000001','stage3-a@example.test'),
 ('d3000000-0000-4000-8000-000000000002','stage3-b@example.test'),
 ('d3000000-0000-4000-8000-000000000003','stage3-platform@example.test');
insert into public.platform_admins(user_id,active) values('d3000000-0000-4000-8000-000000000003',true);
insert into public.restaurants(id,name,slug,subscription_plan,max_tables,monthly_price_cents,subscription_expires_at) values
 ('e3000000-0000-4000-8000-000000000001','Stage3 A','stage3-a','basic',7,8700,'2031-01-01'),
 ('e3000000-0000-4000-8000-000000000002','Stage3 B','stage3-b','pro',23,13700,'2031-01-01'),
 ('e3000000-0000-4000-8000-000000000004','Stage3 Premium','stage3-premium','premium',50,21700,'2031-01-01');
insert into public.restaurant_members(restaurant_id,user_id,role,active)
select id,case when slug='stage3-b' then 'd3000000-0000-4000-8000-000000000002'::uuid else 'd3000000-0000-4000-8000-000000000001'::uuid end,'admin',true
from public.restaurants where slug like 'stage3-%';
insert into public.subscription_invoices(restaurant_id,plan_id,payment_method,amount_cents,status,external_reference,paid_at)
select id,subscription_plan,'pix',monthly_price_cents,'paid','stage3-old-'||slug,now() from public.restaurants where slug like 'stage3-%';
insert into public.subscription_invoices(restaurant_id,plan_id,payment_method,amount_cents,status,external_reference)
values('e3000000-0000-4000-8000-000000000001','basic','pix',8700,'pending','stage3-old-pending');
create table stage3.old_restaurants as select id,subscription_plan,max_tables,monthly_price_cents,subscription_started_at,subscription_expires_at,billing_cycle_days from public.restaurants where slug like 'stage3-%';
create table stage3.old_invoices as select * from public.subscription_invoices where restaurant_id in(select id from stage3.old_restaurants);
create table stage3.old_policies as select * from pg_policies where schemaname='public' and tablename='inventory_items';
create table stage3.old_finance as select pg_get_functiondef('public.get_restaurant_financial_report(uuid,timestamptz,timestamptz)'::regprocedure) definition;
-- Exercise the OLD access rules for Basic, Pro and Premium before migration.
create table stage3.old_access(plan text primary key, finance jsonb, inventory_count integer);
grant select,insert on stage3.old_access to authenticated;
do $$ declare r record; report jsonb; n integer; begin
 for r in select rest.*,m.user_id from public.restaurants rest join public.restaurant_members m on m.restaurant_id=rest.id where rest.slug like 'stage3-%' loop
  perform set_config('request.jwt.claim.sub',r.user_id::text,false);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',r.user_id,'role','authenticated')::text,false);
  set local role authenticated;
  insert into public.inventory_items(restaurant_id,name,current_quantity) values(r.id,'Stage3 stock',10);
  update public.inventory_items set current_quantity=11 where restaurant_id=r.id;
  select count(*) into n from public.inventory_items where restaurant_id=r.id;
  report := public.get_restaurant_financial_report(r.id,'2026-01-01','2032-01-01');
  insert into stage3.old_access values(r.subscription_plan,report,n);
  reset role;
 end loop;
end $$;
select 'PASS: fixtures e acessos anteriores Basic/Pro/Premium registrados antes da migration';

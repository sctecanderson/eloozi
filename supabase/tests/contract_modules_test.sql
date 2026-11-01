begin;
create schema cm;
create table cm.results(label text);
create function cm.ok(b boolean,label text) returns void language plpgsql as $$ begin if b is distinct from true then raise exception 'FAIL: %',label;end if;insert into cm.results values('PASS: '||label);end $$;
create function cm.call(uid text,q text) returns jsonb language plpgsql as $$ declare v jsonb;begin
 perform set_config('request.jwt.claim.sub',uid,true);perform set_config('request.jwt.claims',jsonb_build_object('sub',uid,'role','authenticated','is_anonymous',false)::text,true);
 set local role authenticated;execute q into v;reset role;return jsonb_build_object('state','00000','data',v);
 exception when others then reset role;return jsonb_build_object('state',sqlstate,'error',sqlerrm);end $$;
select cm.ok(not exists(select 1 from public.restaurants r join contract_before.rows b using(id) where to_jsonb(r)-'contract_rights_model'<>b.snapshot),'migration preserves every existing restaurant field');
insert into auth.users(id,email) values ('a7000000-0000-4000-8000-000000000001','admin@contract.test'),('a7000000-0000-4000-8000-000000000002','waiter@contract.test'),('a7000000-0000-4000-8000-000000000003','inactive@contract.test'),('a7000000-0000-4000-8000-000000000004','outsider@contract.test');
insert into public.restaurants(id,name,slug,subscription_plan) values
 ('b7000000-0000-4000-8000-000000000003','New Basic','new-basic','basic'),
 ('b7000000-0000-4000-8000-000000000004','New Pro','new-pro','pro'),
 ('b7000000-0000-4000-8000-000000000005','New Premium','new-premium','premium');
insert into public.restaurant_members(restaurant_id,user_id,role,active)
 select id,'a7000000-0000-4000-8000-000000000001','admin',true from public.restaurants where slug in ('legacy-contract','legacy-trial','new-basic','new-pro','new-premium');
insert into public.restaurant_members(restaurant_id,user_id,role,active) values
 ('b7000000-0000-4000-8000-000000000005','a7000000-0000-4000-8000-000000000002','waiter',true),
 ('b7000000-0000-4000-8000-000000000005','a7000000-0000-4000-8000-000000000003','admin',false);
insert into public.inventory_items(id,restaurant_id,name,unit_measure,current_quantity,alert_threshold)
 select ('c7'||substring(id::text from 3))::uuid,id,'Fixture','un',10,1 from public.restaurants where slug in ('legacy-contract','legacy-trial','new-basic','new-pro','new-premium');
do $$ declare r record;allowed boolean;q jsonb;n integer;uid text:='a7000000-0000-4000-8000-000000000001'; before_rows jsonb;begin
 for r in select * from public.restaurants where slug in ('legacy-contract','legacy-trial','new-basic','new-pro','new-premium') loop
  allowed:=r.slug in ('legacy-contract','legacy-trial','new-premium');
  q:=cm.call(uid,format('select public.get_restaurant_module_access(%L)',r.id));
  perform cm.ok(q->>'state'='00000' and (q#>>'{data,inventory}')::boolean=allowed and (q#>>'{data,finance}')::boolean=allowed,r.slug||' RPC module decision');
  q:=cm.call(uid,format('select to_jsonb(count(*)) from public.inventory_items where restaurant_id=%L',r.id));
  perform cm.ok((q->>'data')::integer=case when allowed then 1 else 0 end,r.slug||' direct table SELECT gate');
  q:=cm.call(uid,format('with u as(update public.inventory_items set current_quantity=11 where restaurant_id=%L returning id) select to_jsonb(count(*)) from u',r.id));
  perform cm.ok((q->>'data')::integer=case when allowed then 1 else 0 end,r.slug||' direct UPDATE gate');
  q:=cm.call(uid,format('insert into public.inventory_items(restaurant_id,name,unit_measure,current_quantity,alert_threshold) values(%L,''Additional'',''un'',1,1) returning to_jsonb(id)',r.id));
  perform cm.ok(q->>'state'=case when allowed then '00000' else '42501' end,r.slug||' INSERT gate');
  q:=cm.call(uid,format('select public.get_restaurant_financial_report(%L,now()-interval ''1 day'',now())',r.id));
  perform cm.ok(q->>'state'=case when allowed then '00000' else '42501' end,r.slug||' financial RPC gate');
 end loop;
 for uid in select unnest(array['a7000000-0000-4000-8000-000000000002','a7000000-0000-4000-8000-000000000003','a7000000-0000-4000-8000-000000000004']) loop
  q:=cm.call(uid,'select public.get_restaurant_financial_report(''b7000000-0000-4000-8000-000000000005'',now()-interval ''1 day'',now())');
  perform cm.ok(q->>'state'='42501','premium does not grant finance to waiter/inactive/outsider');
 end loop;
 q:=cm.call('a7000000-0000-4000-8000-000000000004','select public.get_restaurant_module_access(''b7000000-0000-4000-8000-000000000005'')');
 perform cm.ok(q->>'state'='42501','cross restaurant access decision denied');
 select jsonb_agg(to_jsonb(i) order by id) into before_rows from public.inventory_items i where restaurant_id='b7000000-0000-4000-8000-000000000003';
 q:=cm.call('a7000000-0000-4000-8000-000000000001','with d as(delete from public.inventory_items where restaurant_id=''b7000000-0000-4000-8000-000000000003'' returning id)select to_jsonb(count(*)) from d');
 perform cm.ok(q->>'data'='0','blocked DELETE affects zero rows');
 perform cm.ok((select jsonb_agg(to_jsonb(i) order by id)=before_rows from public.inventory_items i where restaurant_id='b7000000-0000-4000-8000-000000000003'),'denied inventory operations preserve every field');
 begin update public.restaurants set contract_rights_model='legacy' where slug='new-basic';raise exception 'FAIL: immutable model';exception when insufficient_privilege then perform cm.ok(true,'even owner UPDATE cannot silently convert model');end;
 q:=cm.call('a7000000-0000-4000-8000-000000000001','select public.save_restaurant_identity(''new-basic'',1,''{"contract_rights_model":"legacy"}'')');
 perform cm.ok(q->>'state'='42501','generic identity payload rejects model injection');
 update public.restaurants set subscription_plan='premium',subscription_is_trial=false where slug='legacy-trial';
 perform cm.ok((select contract_rights_model='legacy' from public.restaurants where slug='legacy-trial'),'plan/payment field updates preserve legacy explicitly');
end $$;
-- Real creation and renewal writers; no change to their implementations.
insert into public.platform_admins(user_id) values('a7000000-0000-4000-8000-000000000001');
select cm.ok(cm.call('a7000000-0000-4000-8000-000000000001','select public.create_platform_restaurant(''b7000000-0000-4000-8000-000000000010'',''Created platform'',''created-platform'')')->>'state'='00000','platform creation RPC succeeds');
select cm.ok((select contract_rights_model='commercial_v1' from public.restaurants where slug='created-platform'),'platform writer assigns explicit new model');
select cm.ok(cm.call('a7000000-0000-4000-8000-000000000004','select public.register_trial_restaurant_onboarding(''New trial'',''created-trial'',''5511999999999'')')->>'state'='00000','self onboarding RPC succeeds');
select cm.ok((select contract_rights_model='commercial_v1' and subscription_is_trial and billing_cycle_days=7 from public.restaurants where slug='created-trial'),'new trial model explicit, trial duration unchanged');
select cm.ok(cm.call('a7000000-0000-4000-8000-000000000001','select public.update_restaurant_saas_plan(''b7000000-0000-4000-8000-000000000001'',''pro'')')->>'state'='00000','real plan writer succeeds');
select cm.ok((select contract_rights_model='legacy' from public.restaurants where slug='legacy-contract'),'real plan writer preserves legacy');
insert into public.subscription_invoices(id,restaurant_id,plan_id,billing_cycle,payment_method,amount_cents,external_reference) values('e7000000-0000-4000-8000-000000000001','b7000000-0000-4000-8000-000000000001','basic','monthly','pix',9990,'contract-renewal');
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select set_config('request.jwt.claim.role','service_role',true);
set local role service_role;
select public.confirm_subscription_invoice_payment('e7000000-0000-4000-8000-000000000001','contract-renewal',9990,'b7000000-0000-4000-8000-000000000001');
reset role;
select cm.ok((select contract_rights_model='legacy' from public.restaurants where slug='legacy-contract'),'real payment confirmation preserves legacy, old invoice adds no new model');
-- Remove platform privilege before testing tenant restrictions again.
delete from public.platform_admins where user_id='a7000000-0000-4000-8000-000000000001';
insert into public.menu_categories(id,restaurant_id,catalog_key,name,slug,active) select ('d7'||substring(id::text from 3))::uuid,id,'fixture','Fixture','fixture',true from public.restaurants where slug in ('new-basic','new-premium');
insert into public.menu_products(id,restaurant_id,category_id,catalog_key,slug,name,price_in_cents,available) select ('f7'||substring(id::text from 3))::uuid,id,('d7'||substring(id::text from 3))::uuid,'fixture','fixture','Fixture',1000,true from public.restaurants where slug in ('new-basic','new-premium');
do $$ declare r record;q jsonb;payload jsonb;before_row jsonb;uid text:='a7000000-0000-4000-8000-000000000001';begin
 for r in select * from public.restaurants where slug in ('new-basic','new-premium') loop
  select to_jsonb(p) into payload from public.menu_products p where restaurant_id=r.id;
  before_row:=payload;
  payload:=payload||jsonb_build_object('inventory_item_id',('c7'||substring(r.id::text from 3))::uuid);
  q:=cm.call(uid,format('select to_jsonb(public.save_menu_product(%L,%L,%s,%L::jsonb))',r.slug,payload->>'id',payload->>'revision',payload));
  perform cm.ok(q->>'state'=case when r.slug='new-basic' then '42501' else '00000' end,r.slug||' real product RPC link gate');
  if r.slug='new-basic' then
   perform cm.ok((select to_jsonb(p)=before_row from public.menu_products p where restaurant_id=r.id),'denied product RPC leaves entire product unchanged');
   q:=cm.call(uid,format('with u as(update public.menu_products set inventory_item_id=%L where restaurant_id=%L returning id) select to_jsonb(count(*)) from u',payload->>'inventory_item_id',r.id));
   perform cm.ok(q->>'state'='42501','direct product table cannot bypass link gate');
  end if;
 end loop;
 q:=cm.call('a7000000-0000-4000-8000-000000000004','select to_jsonb(public.has_contract_module(''b7000000-0000-4000-8000-000000000005'',''inventory''))');
 perform cm.ok(q->>'data'='false','contract helper does not reveal foreign rights');
end $$;
insert into public.restaurant_alerts(restaurant_id,type,title,message) values('b7000000-0000-4000-8000-000000000003','low_stock','Stock fixture','Quantity 5');
select cm.ok(cm.call('a7000000-0000-4000-8000-000000000001','select to_jsonb(count(*)) from public.restaurant_alerts where restaurant_id=''b7000000-0000-4000-8000-000000000003'' and type=''low_stock''')->>'data'='0','stock alerts do not bypass contract gate');
select cm.ok(cm.call('a7000000-0000-4000-8000-000000000002','with u as(update public.inventory_items set current_quantity=12 where restaurant_id=''b7000000-0000-4000-8000-000000000005'' returning id) select to_jsonb(count(*)) from u')->>'data'='2','premium waiter keeps authorized stock UPDATE');
select cm.ok(cm.call('a7000000-0000-4000-8000-000000000002','insert into public.inventory_items(restaurant_id,name)values(''b7000000-0000-4000-8000-000000000005'',''forbidden'') returning to_jsonb(id)')->>'state'='42501','premium waiter cannot create inventory');
select cm.ok(cm.call('a7000000-0000-4000-8000-000000000003','select to_jsonb(count(*)) from public.inventory_items where restaurant_id=''b7000000-0000-4000-8000-000000000005''')->>'data'='0','inactive member sees zero inventory rows');
select cm.ok(cm.call('a7000000-0000-4000-8000-000000000004','select to_jsonb(count(*)) from public.inventory_items where restaurant_id=''b7000000-0000-4000-8000-000000000005''')->>'data'='0','foreign member sees zero inventory rows');
select cm.ok(cm.call('a7000000-0000-4000-8000-000000000001','update public.restaurants set contract_rights_model=''legacy'' where slug=''new-basic'' returning to_jsonb(id)')->>'state'='42501','authenticated direct model tampering denied');
do $$ declare state text:='NO_ERROR';begin
 begin set local role anon;perform public.get_restaurant_module_access('b7000000-0000-4000-8000-000000000005');exception when others then state:=sqlstate;end;reset role;
 perform cm.ok(state='42501','anon module RPC denied by ACL');
 state:='NO_ERROR';begin set local role anon;perform * from public.inventory_items;exception when others then state:=sqlstate;end;reset role;
 perform cm.ok(state='42501','anon inventory table denied by ACL');
end $$;
select label from cm.results;
rollback;

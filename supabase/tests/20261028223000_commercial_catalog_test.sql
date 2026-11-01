-- Dedicated executable assertions, native PostgreSQL. No remote database.
select stage3.check_true(not exists(
 select * from stage3.old_restaurants except select id,subscription_plan,max_tables,monthly_price_cents,subscription_started_at,subscription_expires_at,billing_cycle_days from public.restaurants
),'migration preserva contratos, capacidades, precos e vencimentos existentes');
select stage3.check_true(not exists(select * from stage3.old_invoices except select * from public.subscription_invoices),'migration preserva integralmente faturas pagas e pendentes');
select stage3.check_true(not exists(select * from stage3.old_policies except select * from pg_policies where schemaname='public' and tablename='inventory_items'),'politicas anteriores de estoque preservadas');
select stage3.check_true((select definition=pg_get_functiondef('public.get_restaurant_financial_report(uuid,timestamptz,timestamptz)'::regprocedure) from stage3.old_finance),'financeiro preserva definicao anterior');

-- Catalog RPC: legacy six/seven-argument calls and named payload matching TypeScript.
set request.jwt.claim.sub='d3000000-0000-4000-8000-000000000003';
set request.jwt.claims='{"sub":"d3000000-0000-4000-8000-000000000003","role":"authenticated"}';
set role authenticated;
select stage3.check_true((public.update_platform_plan_catalog(9990,5,17990,20,27990,80)->>'premiumUnlimitedTables')::boolean=false,'6 argumentos: Premium numerico continua limitado');
select stage3.check_true((public.update_platform_plan_catalog(9990,5,17990,20,27990,70,false)->>'premiumMaxTables')::integer=70,'7 argumentos: limite legado respeitado');
select stage3.expect_error('select public.update_platform_plan_catalog(9990,5,17990,20,27990,null)','22023');
select stage3.expect_error('select public.update_platform_plan_catalog(9990,5,17990,20,27990,70,false,null,null,true)','22023');
select stage3.expect_error('select public.update_platform_plan_catalog(9990,0,17990,20,27990,70)','22023');
select stage3.expect_error('select public.update_platform_plan_catalog(9990,null,17990,20,27990,70)','22023');
select stage3.expect_error('select public.update_platform_plan_catalog(9990,5,17990,null,27990,70)','22023');
select stage3.expect_error('select public.update_platform_plan_catalog(9990,5,17990,20,27990,null,false,false,false,false)','22023');
select stage3.check_true((public.update_platform_plan_catalog(
 p_basic_price_cents=>9990,p_basic_max_tables=>5,p_pro_price_cents=>17990,p_pro_max_tables=>20,
 p_premium_price_cents=>27990,p_premium_max_tables=>null,p_sync_existing_restaurants=>false,
 p_premium_unlimited_tables=>true)->>'premiumUnlimitedTables')::boolean,'payload nomeado: ilimitado explicito');
reset role;
select stage3.check_true(not exists(select * from stage3.old_restaurants except select id,subscription_plan,max_tables,monthly_price_cents,subscription_started_at,subscription_expires_at,billing_cycle_days from public.restaurants),'edicao do catalogo sem sync preserva contratos existentes');

-- New operational fixtures use approved capacities, independent of legacy contracts.
insert into public.restaurants(id,name,slug,max_tables,subscription_expires_at) values
 ('e3000000-0000-4000-8000-000000000003','Stage3 race','stage3-race',1,'2031-01-01'),
 ('e3000000-0000-4000-8000-000000000005','Stage3 quota','stage3-quota',5,'2031-01-01');
insert into public.restaurant_members(restaurant_id,user_id,role,active) values
 ('e3000000-0000-4000-8000-000000000005','d3000000-0000-4000-8000-000000000001','admin',true);
set request.jwt.claim.sub='d3000000-0000-4000-8000-000000000001';
set request.jwt.claims='{"sub":"d3000000-0000-4000-8000-000000000001","role":"authenticated"}';
set role authenticated;
do $$ declare s jsonb; p text; price integer; quota integer; begin
 s:=public.get_restaurant_billing_summary('e3000000-0000-4000-8000-000000000001');
 foreach p in array array['basic','pro','premium'] loop
  price:=case p when 'basic' then 9990 when 'pro' then 17990 else 27990 end;
  perform stage3.check_true((s->'catalog'->p->>'monthly_price_cents')::integer=price,p||' preco mensal');
  perform stage3.check_true((s->'catalog'->p->>'yearly_price_cents')::integer=price*11,p||' preco anual 11x');
 end loop;
 perform stage3.check_true((s#>>'{catalog,basic,max_tables}')::integer=5,'Basic 5 mesas');
 perform stage3.check_true((s#>>'{catalog,pro,max_tables}')::integer=20,'Pro 20 mesas');
 perform stage3.check_true(s#>'{catalog,premium,max_tables}'='null'::jsonb and (s#>>'{catalog,premium,unlimited_tables}')::boolean,'Premium ilimitado explicito');
end $$;
select 'PASS: precos mensais/anuais e capacidades 5/20/ilimitado pela RPC';
select stage3.expect_error('select public.update_platform_plan_catalog(9990,5,17990,20,27990,70)','42501');
select stage3.expect_error($q$select public.get_restaurant_billing_summary('e3000000-0000-4000-8000-000000000002')$q$,'42501');
select stage3.expect_error($q$select public.get_admin_tables('stage3-b')$q$,'42501');
select stage3.expect_error($q$select public.open_table_visit('stage3-b',1)$q$,'42501');
select stage3.expect_error($q$select public.confirm_subscription_invoice_payment(gen_random_uuid(),'x',9990,'e3000000-0000-4000-8000-000000000001')$q$,'42501');
reset role;

-- Repeat real stock CRUD and financial RPC after migration for every legacy plan.
do $$ declare r record; report jsonb; n integer; old record; begin
 for r in select rest.*,m.user_id from public.restaurants rest join public.restaurant_members m on m.restaurant_id=rest.id where rest.id in(select id from stage3.old_restaurants) loop
  select * into old from stage3.old_access where plan=r.subscription_plan;
  perform set_config('request.jwt.claim.sub',r.user_id::text,false);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',r.user_id,'role','authenticated')::text,false);
  set local role authenticated;
  insert into public.inventory_items(restaurant_id,name,current_quantity) values(r.id,'Stage3 temporary',12);
  update public.inventory_items set current_quantity=13 where restaurant_id=r.id and name='Stage3 temporary';
  delete from public.inventory_items where restaurant_id=r.id and name='Stage3 temporary';
  select count(*) into n from public.inventory_items where restaurant_id=r.id;
  report:=public.get_restaurant_financial_report(r.id,'2026-01-01','2032-01-01');
  perform stage3.check_true(n=old.inventory_count and report=old.finance,r.subscription_plan||' preserva estoque/financeiro');
  reset role;
 end loop;
end $$;
select 'PASS: CRUD estoque e RPC financeiro preservados para contratos Basic/Pro/Premium';

set request.jwt.claim.sub='d3000000-0000-4000-8000-000000000001';
set request.jwt.claims='{"sub":"d3000000-0000-4000-8000-000000000001","role":"authenticated"}';
set role authenticated;
select stage3.check_true((select count(*)=0 from public.inventory_items where restaurant_id='e3000000-0000-4000-8000-000000000002'),'RLS estoque isola restaurante B');
select stage3.expect_error($q$insert into public.inventory_items(restaurant_id,name) values('e3000000-0000-4000-8000-000000000002','Intruso')$q$,'42501');
select stage3.expect_error($q$select public.get_restaurant_financial_report('e3000000-0000-4000-8000-000000000002',now(),now())$q$,'42501');
select stage3.expect_error($q$select public.get_kds_active_items('stage3-a')$q$,'42501');
select stage3.expect_error($q$select public.get_kds_active_items('stage3-b')$q$,'42501');
select stage3.check_true(public.get_kds_active_items('stage3-premium')='[]'::jsonb,'Premium autorizado acessa KDS');
reset role;
set request.jwt.claim.sub='d3000000-0000-4000-8000-000000000002';
set request.jwt.claims='{"sub":"d3000000-0000-4000-8000-000000000002","role":"authenticated"}';
set role authenticated;
select stage3.check_true(public.get_kds_active_items('stage3-b')='[]'::jsonb,'Pro autorizado acessa KDS');
reset role;
set request.jwt.claim.sub='d3000000-0000-4000-8000-000000000001';
set request.jwt.claims='{"sub":"d3000000-0000-4000-8000-000000000001","role":"authenticated"}';

-- Numeric identifiers above quota are valid; only ACTIVE COUNT is limited.
insert into public.restaurant_tables(restaurant_id,table_number,active,is_active)
select 'e3000000-0000-4000-8000-000000000005',n,true,true from generate_series(101,105) n;
select stage3.expect_error($q$insert into public.restaurant_tables(restaurant_id,table_number,active,is_active) values('e3000000-0000-4000-8000-000000000005',106,true,true)$q$,'P0001');
insert into public.restaurant_tables(restaurant_id,table_number,active,is_active) values('e3000000-0000-4000-8000-000000000005',106,false,false);
select stage3.expect_error($q$update public.restaurant_tables set active=true,is_active=true where restaurant_id='e3000000-0000-4000-8000-000000000005' and table_number=106$q$,'P0001');
set role authenticated;
select stage3.check_true((public.open_table_visit('stage3-quota',105)).status='open','abre mesa 105 com capacidade 5');
select stage3.check_true((select (e->>'isLockedByPlan')::boolean=false from jsonb_array_elements(public.get_admin_tables('stage3-quota')) e where e->>'tableNumber'='105'),'mesa alta nao bloqueada pelo numero');
select public.open_table_visit('stage3-quota',n) from generate_series(101,104) n;
reset role;

-- Pre-existing open tabs above a downgraded quota can finish; sync preserves visits.
insert into public.table_tabs(restaurant_id,restaurant_table_id,table_visit_id,label,created_by_member_id)
select v.restaurant_id,v.restaurant_table_id,v.id,'Stage3 open',v.assigned_member_id from public.table_visits v where v.restaurant_id='e3000000-0000-4000-8000-000000000005';
update public.restaurants set max_tables=1 where id='e3000000-0000-4000-8000-000000000005';
select public.sync_restaurant_tables_to_plan_limit('e3000000-0000-4000-8000-000000000005');
select stage3.check_true((select count(*)=5 from public.restaurant_tables where restaurant_id='e3000000-0000-4000-8000-000000000005' and active and is_active),'sync preserva cinco mesas ocupadas apesar da nova cota 1');
set role authenticated;
select stage3.check_true((public.open_table_visit('stage3-quota',105)).status='open','atendimento existente acima do numero da cota continua acessivel');
select stage3.expect_error($q$select public.close_table_visit('stage3-quota',(select v.id from public.table_visits v join public.restaurant_tables t on t.id=v.restaurant_table_id where t.restaurant_id='e3000000-0000-4000-8000-000000000005' and t.table_number=105 and v.status='open'))$q$,'22023');
do $$ declare v record; tab_id uuid; begin
 for v in select * from public.table_visits where restaurant_id='e3000000-0000-4000-8000-000000000005' and status='open' loop
  select id into tab_id from public.table_tabs where table_visit_id=v.id;
  perform stage3.check_true((public.close_table_tab('stage3-quota',tab_id,false)).status='closed','fecha comanda acima da cota');
  perform stage3.check_true((public.close_table_visit('stage3-quota',v.id)).status='closed','fecha visita acima da cota');
 end loop;
end $$;
select 'PASS: cinco comandas/visitas acima da cota foram concluidas pelas RPCs';
reset role;
select stage3.check_true((select count(*)=1 from public.restaurant_tables where restaurant_id='e3000000-0000-4000-8000-000000000005' and active and is_active),'apos conclusao mantem quota ativa');

-- Payment: amount/reference/tenant checks, synchronization, renewal once.
reset request.jwt.claims;
reset request.jwt.claim.sub;
insert into public.restaurant_tables(restaurant_id,table_number,active,is_active)
select 'e3000000-0000-4000-8000-000000000005',n,false,false from generate_series(201,225) n;
insert into public.subscription_invoices(id,restaurant_id,plan_id,billing_cycle,payment_method,amount_cents,external_reference) values
 ('e3000000-0000-4000-8000-000000000090','e3000000-0000-4000-8000-000000000005','pro','yearly','pix',197890,'stage3-upgrade'),
 ('e3000000-0000-4000-8000-000000000091','e3000000-0000-4000-8000-000000000005','premium','monthly','pix',27990,'stage3-unlimited'),
 ('e3000000-0000-4000-8000-000000000099','e3000000-0000-4000-8000-000000000003','basic','monthly','pix',9990,'stage3-concurrent');
select stage3.expect_error($q$select public.confirm_subscription_invoice_payment('e3000000-0000-4000-8000-000000000090','stage3-upgrade',197890,'e3000000-0000-4000-8000-000000000002')$q$,'42501');
select stage3.expect_error($q$select public.confirm_subscription_invoice_payment('e3000000-0000-4000-8000-000000000090','wrong',197890,'e3000000-0000-4000-8000-000000000005')$q$,'22023');
select stage3.expect_error($q$select public.confirm_subscription_invoice_payment('e3000000-0000-4000-8000-000000000090','stage3-upgrade',1,'e3000000-0000-4000-8000-000000000005')$q$,'22023');
set role service_role;
select public.confirm_subscription_invoice_payment('e3000000-0000-4000-8000-000000000090','stage3-upgrade',197890,'e3000000-0000-4000-8000-000000000005');
reset role;
select stage3.check_true((select max_tables=20 and not unlimited_tables and subscription_expires_at='2032-01-01'::timestamptz from public.restaurants where id='e3000000-0000-4000-8000-000000000005'),'pagamento Pro anual aplica 20 mesas e 365 dias');
select stage3.check_true((select count(*)=20 from public.restaurant_tables where restaurant_id='e3000000-0000-4000-8000-000000000005' and active and is_active),'pagamento reativa mesas inativas ate a cota 20');
select stage3.check_true((public.confirm_subscription_invoice_payment('e3000000-0000-4000-8000-000000000090','stage3-upgrade',197890,'e3000000-0000-4000-8000-000000000005')->>'already_paid')::boolean,'repeticao informa already_paid');
select stage3.check_true((select subscription_expires_at='2032-01-01'::timestamptz from public.restaurants where id='e3000000-0000-4000-8000-000000000005'),'repeticao nao renova novamente');
select stage3.check_true((select count(*)=1 from public.platform_audit_logs where details->>'invoice_id'='e3000000-0000-4000-8000-000000000090'),'repeticao nao duplica auditoria');
select public.confirm_subscription_invoice_payment('e3000000-0000-4000-8000-000000000091','stage3-unlimited',27990,'e3000000-0000-4000-8000-000000000005');
select stage3.check_true((select max_tables is null and unlimited_tables from public.restaurants where id='e3000000-0000-4000-8000-000000000005'),'pagamento Premium aplica ilimitado explicito');
select stage3.check_true((select count(*)=31 from public.restaurant_tables where restaurant_id='e3000000-0000-4000-8000-000000000005' and active and is_active),'pagamento Premium reativa todas as 31 mesas');
select stage3.check_true(not exists(select * from stage3.old_restaurants except select id,subscription_plan,max_tables,monthly_price_cents,subscription_started_at,subscription_expires_at,billing_cycle_days from public.restaurants),'pagamento isola outros contratos');
set request.jwt.claim.sub='';
set request.jwt.claims='{"role":"anon"}';
set role anon;
select stage3.expect_error($q$select public.get_restaurant_billing_summary('e3000000-0000-4000-8000-000000000001')$q$,'42501');
select stage3.expect_error('select public.update_platform_plan_catalog(9990,5,17990,20,27990,70)','42501');
reset role;
reset request.jwt.claims;
reset request.jwt.claim.sub;
select 'PASS: suite SQL comercial sequencial concluida';

-- Keep known authorization failures visible without suppressing the independent races.
create table stage3.security_findings(test text, expected text, actual text, changed_other_tenant boolean);
insert into public.restaurant_tables(restaurant_id,table_number,active,is_active)
 values('e3000000-0000-4000-8000-000000000002',900,false,false);
do $$ declare got text := 'NO_ERROR'; changed boolean; begin
 perform set_config('request.jwt.claim.sub','d3000000-0000-4000-8000-000000000001',false);
 perform set_config('request.jwt.claims','{"sub":"d3000000-0000-4000-8000-000000000001","role":"authenticated"}',false);
 set local role authenticated;
 begin
  perform public.sync_restaurant_tables_to_plan_limit('e3000000-0000-4000-8000-000000000002');
 exception when others then got:=sqlstate; end;
 reset role;
 select active and is_active into changed from public.restaurant_tables where restaurant_id='e3000000-0000-4000-8000-000000000002' and table_number=900;
 insert into stage3.security_findings values('sync bloqueia administrador de outro restaurante','42501',got,changed);
end $$;
select case when expected=actual and not changed_other_tenant then 'PASS' else 'FAIL' end || ': ' || row_to_json(f)::text from stage3.security_findings f;
reset request.jwt.claims;
reset request.jwt.claim.sub;

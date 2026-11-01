begin;
create schema pt;
create table pt.results(label text);
create function pt.ok(b boolean,label text) returns void language plpgsql as $$begin if b is distinct from true then raise exception 'FAIL: %',label;end if;insert into pt.results values('PASS: '||label);end $$;
create function pt.call(uid text,q text) returns jsonb language plpgsql as $$declare res jsonb;begin
 perform set_config('request.jwt.claim.sub',uid,true);perform set_config('request.jwt.claim.role','authenticated',true);perform set_config('request.jwt.claims',jsonb_build_object('sub',uid,'role','authenticated','is_anonymous',false)::text,true);
 set local role authenticated;execute q into res;reset role;return jsonb_build_object('state','00000','data',res);
 exception when others then reset role;return jsonb_build_object('state',sqlstate,'message',sqlerrm);end $$;
select pt.ok(not exists(select 1 from trial_before.restaurants b join public.restaurants r using(id) where b.snapshot<>to_jsonb(r)),'all existing restaurant fields preserved by migration');
select pt.ok(not exists(select snapshot from trial_before.invoices except select to_jsonb(i) from public.subscription_invoices i),'existing invoices untouched');
select pt.ok((select not (subscription_quote_private.effective_subscription(id)->>'known_trial')::boolean and subscription_quote_private.effective_plan(id)='pro' from public.restaurants where slug='old-trial-no-proof'),'unknown old trial is not reconstructed or granted a new trial');
insert into auth.users(id,email) values('a8000000-0000-4000-8000-000000000001','new-trial@test.local'),('a8000000-0000-4000-8000-000000000002','buyer@test.local'),('a8000000-0000-4000-8000-000000000003','outsider@test.local');
select pt.ok(pt.call('a8000000-0000-4000-8000-000000000001','select public.register_trial_restaurant_onboarding(''Trial Premium'',''premium-trial'',''5511999999999'')')->>'state'='00000','real onboarding creates trial');
do $$declare rid uuid;e jsonb;t subscription_quote_private.trial_terms;begin
 select id into rid from public.restaurants where slug='premium-trial';
 select * into t from subscription_quote_private.trial_terms where restaurant_id=rid;
 perform pt.ok(t.original_end-t.original_start=interval '168 hours','original trial exactly 168 hours');
 e:=subscription_quote_private.effective_subscription(rid);
 perform pt.ok(e->>'plan'='premium' and (e->>'unlimited_tables')::boolean and (e->>'trial_active')::boolean,'initial Premium unlimited');
 insert into public.restaurant_tables(restaurant_id,table_number)select rid,n from generate_series(4,30)n;
 perform pt.ok((select count(*)=30 from public.restaurant_tables where restaurant_id=rid),'trial supports 30 active tables');
 e:=subscription_quote_private.effective_subscription(rid,t.original_end-interval '1 microsecond');perform pt.ok((e->>'trial_active')::boolean,'instant before end Premium');
 e:=subscription_quote_private.effective_subscription(rid,t.original_end);perform pt.ok(not (e->>'trial_active')::boolean and e->>'billing_status'='expired','exact end expires without grace');
 e:=subscription_quote_private.effective_subscription(rid,t.original_end+interval '1 microsecond');perform pt.ok(e->>'billing_status'='expired','instant after end remains expired');
 perform pt.ok(pt.call('a8000000-0000-4000-8000-000000000001',format('select public.get_restaurant_module_access(%L)',rid))#>>'{data,finance}'='true','trial includes finance through real authorization');
 perform pt.ok(pt.call('a8000000-0000-4000-8000-000000000003',format('select public.get_effective_subscription(%L)',rid))->>'state'='42501','foreign user cannot inspect private effective state');
 perform pt.ok(pt.call('a8000000-0000-4000-8000-000000000001',format('select subscription_quote_private.effective_subscription(%L,now()+interval ''1 year'')',rid))->>'state'='42501','client cannot provide evaluation clock');
 perform pt.ok(pt.call('a8000000-0000-4000-8000-000000000001',format('select public.save_restaurant_identity(''premium-trial'',1,''{"original_trial_end":"2099-01-01"}'')',rid))->>'state'='42501','generic payload cannot change trial date');
 begin update subscription_quote_private.trial_terms set original_end=original_end+interval '1 day' where restaurant_id=rid;raise exception 'FAIL immutable';exception when insufficient_privilege then perform pt.ok(true,'authoritative trial terms immutable');end;
end $$;
-- Explicit new-contract fixtures: purchase after 48 hours, no historical inference.
insert into public.restaurants(id,name,slug,subscription_plan,subscription_is_trial,subscription_started_at,subscription_expires_at,max_tables,unlimited_tables) values
 ('b8000000-0000-4000-8000-000000000001','Monthly','trial-monthly','premium',true,now()-interval '48 hours',now()+interval '120 hours',null,true),
 ('b8000000-0000-4000-8000-000000000002','Annual','trial-annual','premium',true,now()-interval '48 hours',now()+interval '120 hours',null,true);
insert into public.restaurants(id,name,slug,subscription_plan,subscription_is_trial,subscription_started_at,subscription_expires_at,max_tables,unlimited_tables)values('b8000000-0000-4000-8000-000000000003','Premium buyer','trial-premium','premium',true,now()-interval '48 hours',now()+interval '120 hours',null,true);
insert into public.restaurant_members(restaurant_id,user_id,role,active)select id,'a8000000-0000-4000-8000-000000000002','admin',true from public.restaurants where slug in ('trial-monthly','trial-annual','trial-premium');
insert into subscription_quote_private.trial_terms(restaurant_id,original_start,original_end,evidence_source)select id,now()-interval '48 hours',now()+interval '120 hours','onboarding_premium_168h' from public.restaurants where slug in ('trial-monthly','trial-annual','trial-premium');
insert into public.subscription_invoices(id,restaurant_id,plan_id,billing_cycle,payment_method,amount_cents,external_reference)
select 'e8000000-0000-4000-8000-000000000001','b8000000-0000-4000-8000-000000000001','basic','monthly','pix',basic_price_cents,'trial-monthly' from public.platform_settings where id='default';
insert into public.subscription_invoices(id,restaurant_id,plan_id,billing_cycle,payment_method,amount_cents,external_reference)
select 'e8000000-0000-4000-8000-000000000002','b8000000-0000-4000-8000-000000000002','pro','yearly','credit_card',pro_price_cents*11,'trial-annual' from public.platform_settings where id='default';
insert into public.subscription_invoices(id,restaurant_id,plan_id,billing_cycle,payment_method,amount_cents,external_reference)select 'e8000000-0000-4000-8000-000000000003','b8000000-0000-4000-8000-000000000003','premium','monthly','pix',premium_price_cents,'trial-premium' from public.platform_settings where id='default';
do $$declare r record;q jsonb;t subscription_quote_private.trial_terms;c subscription_quote_private.cycles;e jsonb;before_end timestamptz;begin
 for r in select * from public.subscription_invoices where external_reference in ('trial-monthly','trial-annual','trial-premium') loop
  select * into t from subscription_quote_private.trial_terms where restaurant_id=r.restaurant_id;
  perform set_config('request.jwt.claim.role','service_role',true);perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  set local role service_role;q:=public.confirm_subscription_invoice_payment(r.id,r.external_reference,r.amount_cents,r.restaurant_id);reset role;
  perform pt.ok((q->>'success')::boolean,'trusted server payment confirmation '||r.billing_cycle);
  select * into c from subscription_quote_private.cycles where restaurant_id=r.restaurant_id;
  perform pt.ok(c.starts_at=t.original_end and c.starts_at-now()=interval '120 hours','48h purchase preserves 120 free hours');
  perform pt.ok(c.ends_at-c.starts_at=case r.billing_cycle when 'yearly' then interval '8760 hours' else interval '720 hours' end,'full paid duration '||r.billing_cycle);
  perform pt.ok(c.contracted_price_cents=r.amount_cents and (select confirmed_credit_cents=r.amount_cents from subscription_quote_private.cycle_payments where invoice_id=r.id),'confirmed amount allocated to same cycle');
  e:=subscription_quote_private.effective_subscription(r.restaurant_id);
  perform pt.ok(e->>'plan'='premium' and (e->>'trial_active')::boolean,'purchase keeps effective Premium');
  perform pt.ok((select subscription_plan=r.plan_id and not subscription_is_trial from public.restaurants where id=r.restaurant_id),'contracted plan separated from trial flag');
  e:=subscription_quote_private.effective_subscription(r.restaurant_id,t.original_end);
  perform pt.ok(e->>'plan'=r.plan_id and (case when r.plan_id='premium' then (e->>'unlimited_tables')::boolean and e->>'max_tables' is null else (e->>'max_tables')::integer=case r.plan_id when 'basic' then 5 else 20 end end),'exact boundary applies paid plan quota');
  set local role service_role;q:=public.confirm_subscription_invoice_payment(r.id,r.external_reference,r.amount_cents,r.restaurant_id);reset role;
  perform pt.ok((q->>'already_paid')::boolean and (select count(*)=1 from subscription_quote_private.cycles where restaurant_id=r.restaurant_id),'repeat does not duplicate or append paid cycle');
  perform pt.ok((select original_end=t.original_end from subscription_quote_private.trial_terms where restaurant_id=r.restaurant_id),'payment never changes original trial end');
 end loop;
end $$;
select pt.ok(pt.call('a8000000-0000-4000-8000-000000000002','select public.get_restaurant_module_access(''b8000000-0000-4000-8000-000000000001'')')#>>'{data,inventory}'='true','Basic buyer retains inventory during trial');
select pt.ok(pt.call('a8000000-0000-4000-8000-000000000002','select public.get_kds_active_items(''trial-monthly'')')->>'state'='00000','Basic buyer retains KDS during trial');
-- Simulate the post-boundary state with explicit trusted fixtures, not a client clock.
insert into public.restaurants(id,name,slug,subscription_plan,subscription_is_trial,max_tables,unlimited_tables,subscription_expires_at)values
 ('b8000000-0000-4000-8000-000000000010','Ended unpaid','ended-unpaid','premium',true,null,true,now()+interval '7 days'),
 ('b8000000-0000-4000-8000-000000000011','Ended Basic','ended-basic','premium',false,null,true,now()+interval '30 days');
insert into public.restaurant_members(restaurant_id,user_id,role,active)select id,'a8000000-0000-4000-8000-000000000002','admin',true from public.restaurants where slug in ('ended-unpaid','ended-basic');
insert into public.restaurant_tables(restaurant_id,table_number)select r.id,n from public.restaurants r cross join generate_series(1,6)n where r.slug in ('ended-unpaid','ended-basic');
insert into public.table_visits(restaurant_id,restaurant_table_id,assigned_member_id,status,opened_at)select r.id,t.id,m.id,'open',now()-interval '2 hours' from public.restaurants r join public.restaurant_tables t on t.restaurant_id=r.id and t.table_number=6 join public.restaurant_members m on m.restaurant_id=r.id where r.slug in ('ended-unpaid','ended-basic');
insert into public.table_tabs(restaurant_id,restaurant_table_id,table_visit_id,label,created_by_member_id)select v.restaurant_id,v.restaurant_table_id,v.id,'Existing attendance',v.assigned_member_id from public.table_visits v join public.restaurants r on r.id=v.restaurant_id where r.slug in ('ended-unpaid','ended-basic');
insert into subscription_quote_private.trial_terms(restaurant_id,original_start,original_end,evidence_source)select id,now()-interval '168 hours 1 second',now()-interval '1 second','onboarding_premium_168h' from public.restaurants where slug in ('ended-unpaid','ended-basic');
insert into public.subscription_invoices(id,restaurant_id,plan_id,billing_cycle,payment_method,amount_cents,external_reference,status,paid_at)select 'e8000000-0000-4000-8000-000000000011','b8000000-0000-4000-8000-000000000011','basic','monthly','pix',basic_price_cents,'fixture-past-end','paid',now()-interval '48 hours' from public.platform_settings where id='default';
with cy as(insert into subscription_quote_private.cycles(restaurant_id,plan_id,billing_cycle,starts_at,ends_at,contracted_price_cents,evidence_source)select restaurant_id,'basic','monthly',now()-interval '1 second',now()+interval '720 hours'-interval '1 second',amount_cents,'trial_purchase_v1' from public.subscription_invoices where external_reference='fixture-past-end' returning id,contracted_price_cents)
insert into subscription_quote_private.cycle_payments select 'e8000000-0000-4000-8000-000000000011',id,contracted_price_cents from cy;
update public.restaurants set subscription_plan='basic',max_tables=5,unlimited_tables=false where slug='ended-basic';
do $$declare r record;q jsonb;before_tables jsonb;visit_id uuid;tab_id uuid;begin
 for r in select * from public.restaurants where slug in ('ended-basic','ended-unpaid') loop
  select id into visit_id from public.table_visits where restaurant_id=r.id and status='open';
  select id into tab_id from public.table_tabs where table_visit_id=visit_id;
  select jsonb_agg(to_jsonb(t) order by id) into before_tables from public.restaurant_tables t where restaurant_id=r.id;
  q:=pt.call('a8000000-0000-4000-8000-000000000002',format('select public.get_public_restaurant(%L)',r.slug));
  perform pt.ok(q#>>'{data,subscriptionPlan}'='basic' and not (q#>>'{data,unlimitedTables}')::boolean,'post-boundary interface receives Basic quota');
  q:=pt.call('a8000000-0000-4000-8000-000000000002',format('select public.get_admin_tables(%L)',r.slug));
  perform pt.ok(q->>'state'='00000' and before_tables=(select jsonb_agg(to_jsonb(t) order by id) from public.restaurant_tables t where restaurant_id=r.id),'read RPC does not synchronize or mutate tables');
  q:=pt.call('a8000000-0000-4000-8000-000000000002',format('select to_jsonb(public.open_table_visit(%L,6))',r.slug));
  perform pt.ok(q->>'state'='00000','existing visit remains accessible after trial');
  q:=pt.call('a8000000-0000-4000-8000-000000000002',format('select to_jsonb(public.open_table_visit(%L,5))',r.slug));
  perform pt.ok(q->>'state'='P0001','new operation outside quota or expired trial denied');
  perform pt.ok(before_tables=(select jsonb_agg(to_jsonb(t) order by id) from public.restaurant_tables t where restaurant_id=r.id),'denied operation leaves all tables unchanged');
  q:=pt.call('a8000000-0000-4000-8000-000000000002',format('select public.get_kds_active_items(%L)',r.slug));perform pt.ok(q->>'state'='42501','post-trial Basic has no KDS');
  q:=pt.call('a8000000-0000-4000-8000-000000000002',format('select public.get_restaurant_module_access(%L)',r.id));perform pt.ok(q#>>'{data,inventory}'='false' and q#>>'{data,finance}'='false','post-trial Basic has no exclusive modules');
  q:=pt.call('a8000000-0000-4000-8000-000000000002',format('select public.request_table_assistance(%L,''close_table_request'')',(select restaurant_table_id from public.table_visits where id=visit_id)));
  perform pt.ok(q#>>'{data,success}'='true','bill request for an existing visit remains available after trial');
  q:=pt.call('a8000000-0000-4000-8000-000000000002',format('select to_jsonb(public.close_table_tab(%L,%L,false))',r.slug,tab_id));perform pt.ok(q#>>'{data,status}'='closed','existing tab closes after trial');
  q:=pt.call('a8000000-0000-4000-8000-000000000002',format('select to_jsonb(public.close_table_visit(%L,%L))',r.slug,visit_id));perform pt.ok(q#>>'{data,status}'='closed','existing visit closes after trial');
  perform pt.ok((select count(*)=6 from public.restaurant_tables where restaurant_id=r.id),'quota transition never deletes tables');
 end loop;
end $$;
select pt.ok(subscription_quote_private.effective_subscription('b8000000-0000-4000-8000-000000000010')->>'billing_status'='expired','unpaid trial expires without grace in real server state');
insert into public.restaurant_members(restaurant_id,user_id,role,active)select id,'a8000000-0000-4000-8000-000000000003','waiter',true from public.restaurants where slug='premium-trial';
select pt.ok(pt.call('a8000000-0000-4000-8000-000000000003',format('select public.get_restaurant_module_access(%L)',(select id from public.restaurants where slug='premium-trial')))#>>'{data,finance}'='false','trial Premium does not grant administrator finance role to waiter');
select pt.ok((select count(*)=1 from public.subscription_invoices where external_reference='legacy-paid' and amount_cents=7777 and status='paid'),'old paid invoice and discounted price preserved');
select pt.ok((select contract_rights_model='legacy' and max_tables=17 and monthly_price_cents=7777 from public.restaurants where slug='legacy-custom'),'legacy custom capacity and price untouched');
select pt.ok(not exists(select 1 from subscription_quote_private.cycle_payments where invoice_id='e8000000-0000-4000-8000-000000000098'),'old invoice receives no fabricated cycle allocation');
do $$declare q jsonb;state text;amount integer;begin
 select amount_cents into amount from public.subscription_invoices where external_reference='trial-monthly';
 perform set_config('request.jwt.claim.role','service_role',true);perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 set local role service_role;q:=public.confirm_subscription_invoice_payment('e8000000-0000-4000-8000-000000000098','legacy-paid',7777,'b8000000-0000-4000-8000-000000000098');reset role;
 perform pt.ok((q->>'already_paid')::boolean and (select to_jsonb(r)=b.snapshot from public.restaurants r join trial_before.restaurants b using(id) where r.slug='legacy-custom') and not exists(select 1 from subscription_quote_private.cycle_payments where invoice_id='e8000000-0000-4000-8000-000000000098'),'repeat of legacy paid invoice preserves contract and creates no cycle evidence');
 state:='NO_ERROR';begin set local role service_role;perform public.confirm_subscription_invoice_payment('e8000000-0000-4000-8000-000000000001','trial-monthly',amount+1,'b8000000-0000-4000-8000-000000000001');exception when others then state:=sqlstate;end;reset role;
 perform pt.ok(state='22023','payment amount validation remains strict even for duplicate event');
 state:='NO_ERROR';begin set local role service_role;perform public.acquire_or_create_pending_subscription_invoice('b8000000-0000-4000-8000-000000000001','pro','monthly','pix',amount);exception when others then state:=sqlstate;end;reset role;
 perform pt.ok(state='22023','additional plan transition blocked before invoice emission');
 perform pt.ok((select subscription_expires_at=c.ends_at from public.restaurants r join subscription_quote_private.cycles c on c.restaurant_id=r.id where r.slug='trial-monthly'),'duplicate events preserve restaurant expiry exactly');
end $$;
-- Regularization after an unpaid expiration: paid access, never a fresh trial.
insert into public.subscription_invoices(id,restaurant_id,plan_id,billing_cycle,payment_method,amount_cents,external_reference)select 'e8000000-0000-4000-8000-000000000010','b8000000-0000-4000-8000-000000000010','basic','monthly','pix',basic_price_cents,'late-regularization' from public.platform_settings where id='default';
do $$declare q jsonb;e jsonb;amount integer;begin
 select amount_cents into amount from public.subscription_invoices where external_reference='late-regularization';
 perform set_config('request.jwt.claim.role','service_role',true);perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 set local role service_role;q:=public.confirm_subscription_invoice_payment('e8000000-0000-4000-8000-000000000010','late-regularization',amount,'b8000000-0000-4000-8000-000000000010');reset role;
 e:=subscription_quote_private.effective_subscription('b8000000-0000-4000-8000-000000000010');
 perform pt.ok(e->>'billing_status'='active' and not (e->>'trial_active')::boolean and e->>'plan'='basic','regularization restores paid Basic, without a new trial');
 perform pt.ok((e->>'paid_end')::timestamptz-(e->>'paid_start')::timestamptz=interval '720 hours','late confirmed payment retains its full paid cycle');
end $$;
-- Preserve ordinary same-plan/same-cycle renewal after the original trial ends.
insert into public.subscription_invoices(id,restaurant_id,plan_id,billing_cycle,payment_method,amount_cents,external_reference)select 'e8000000-0000-4000-8000-000000000012','b8000000-0000-4000-8000-000000000011','basic','monthly','pix',basic_price_cents,'same-plan-renewal' from public.platform_settings where id='default';
do $$declare old_end timestamptz;amount integer;q jsonb;e jsonb;begin
 select max(ends_at) into old_end from subscription_quote_private.cycles where restaurant_id='b8000000-0000-4000-8000-000000000011';
 select amount_cents into amount from public.subscription_invoices where external_reference='same-plan-renewal';
 perform set_config('request.jwt.claim.role','service_role',true);perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 set local role service_role;q:=public.confirm_subscription_invoice_payment('e8000000-0000-4000-8000-000000000012','same-plan-renewal',amount,'b8000000-0000-4000-8000-000000000011');reset role;
 perform pt.ok((select count(*)=2 from subscription_quote_private.cycles where restaurant_id='b8000000-0000-4000-8000-000000000011'),'renewal records a separate proven cycle');
 perform pt.ok((select subscription_expires_at=old_end+interval '720 hours' from public.restaurants where slug='ended-basic'),'renewal preserves full future paid period');
 e:=subscription_quote_private.effective_subscription('b8000000-0000-4000-8000-000000000011');
 perform pt.ok((e->>'paid_end')::timestamptz=old_end and (e->>'expires_at')::timestamptz=old_end+interval '720 hours','current cycle is identified separately from accumulated coverage');
 e:=subscription_quote_private.effective_subscription('b8000000-0000-4000-8000-000000000011',old_end);
 perform pt.ok(e->>'billing_status'='active' and (e->>'paid_start')::timestamptz=old_end,'next proven cycle starts exactly at previous paid boundary');
end $$;
-- The other real restaurant-creation entry point also captures a single trial.
insert into public.platform_admins(user_id)values('a8000000-0000-4000-8000-000000000003');
do $$declare q jsonb;e jsonb;saved_trial_end timestamptz;begin
 q:=pt.call('a8000000-0000-4000-8000-000000000003','select public.create_platform_restaurant(''b8000000-0000-4000-8000-000000000100'',''Platform trial'',''platform-trial'')');
 perform pt.ok(q->>'state'='00000','real platform restaurant creation starts trial');
 select t.original_end into saved_trial_end from subscription_quote_private.trial_terms t where restaurant_id='b8000000-0000-4000-8000-000000000100';
 e:=subscription_quote_private.effective_subscription('b8000000-0000-4000-8000-000000000100');
 perform pt.ok(e->>'plan'='premium' and (e->>'unlimited_tables')::boolean and (select subscription_plan='premium' and subscription_is_trial and unlimited_tables and max_tables is null from public.restaurants where id='b8000000-0000-4000-8000-000000000100') and (select t.original_end-t.original_start=interval '168 hours' from subscription_quote_private.trial_terms t where restaurant_id='b8000000-0000-4000-8000-000000000100'),'platform creation grants exactly 168 hours Premium unlimited');
 q:=pt.call('a8000000-0000-4000-8000-000000000003','select public.create_platform_restaurant(''b8000000-0000-4000-8000-000000000100'',''Platform trial'',''platform-trial'')');
 perform pt.ok(q->>'state'='00000' and (select t.original_end=saved_trial_end from subscription_quote_private.trial_terms t where restaurant_id='b8000000-0000-4000-8000-000000000100'),'repeating platform creation cannot restart trial');
end $$;
select 'TRIAL ASSERTIONS: '||count(*) from pt.results;
select label from pt.results;
rollback;

begin;
create schema dg;
create table dg.results(label text);
create function dg.ok(b boolean,label text) returns void language plpgsql as $$begin if b is distinct from true then raise exception 'FAIL: %',label;end if;insert into dg.results values(label);end$$;
create function dg.admin(rid uuid,plan text default null,action text default 'schedule',uid text default 'a9000000-0000-4000-8000-000000000001') returns jsonb language plpgsql as $$declare q text;r jsonb;begin
 q:=case action when 'cancel' then format('select public.cancel_subscription_downgrade(%L)',rid) when 'get' then format('select public.get_scheduled_subscription_change(%L)',rid) else format('select public.schedule_subscription_downgrade(%L,%L)',rid,plan) end;
 perform set_config('request.jwt.claim.sub',uid,true);perform set_config('request.jwt.claims',jsonb_build_object('sub',uid,'role','authenticated')::text,true);
 set local role authenticated;execute q into r;reset role;return jsonb_build_object('state','00000','data',r);
 exception when others then reset role;return jsonb_build_object('state',sqlstate,'message',sqlerrm);end$$;
create table dg.fixtures(label text primary key,rid uuid,cycle_id uuid,ends_at timestamptz);
create function dg.seed(label text,mode text default 'live',cy text default 'monthly',prepaid integer default 1) returns uuid language plpgsql as $$
#variable_conflict use_variable
declare rid uuid:=gen_random_uuid();cid uuid;iid uuid;st timestamptz;en timestamptz;duration interval;price integer;n integer;begin
 duration:=case cy when 'yearly' then interval '8760 hours' else interval '720 hours' end;
 en:=case mode when 'ended' then now()-interval '1 hour' when 'trial' then now()+interval '120 hours'+duration else now()+interval '10 days' end;
 st:=en-duration;
 insert into public.restaurants(id,name,slug,subscription_plan,subscription_is_trial,subscription_expires_at,billing_cycle_days,max_tables,unlimited_tables)values(rid,label,'dg-'||rid,'premium',false,en+(prepaid-1)*duration,case cy when 'yearly' then 365 else 30 end,null,true);
 insert into public.restaurant_members(restaurant_id,user_id,role,active)values(rid,'a9000000-0000-4000-8000-000000000001','admin',true);
 insert into subscription_quote_private.trial_terms values(rid,st-interval '168 hours',st,'onboarding_premium_168h');
 select premium_price_cents*case cy when 'yearly' then 11 else 1 end into price from public.platform_settings where id='default';
 for n in 1..prepaid loop
  iid:=gen_random_uuid();cid:=gen_random_uuid();
  insert into public.subscription_invoices(id,restaurant_id,plan_id,billing_cycle,payment_method,amount_cents,status,paid_at,external_reference)values(iid,rid,'premium',cy,'pix',price,'paid',st-interval '1 hour',iid::text);
  insert into subscription_quote_private.cycles values(cid,rid,'premium',cy,st+(n-1)*duration,en+(n-1)*duration,price,'trial_purchase_v1');
  insert into subscription_quote_private.cycle_payments values(iid,cid,price);
 end loop;
 insert into dg.fixtures values(label,rid,cid,en+(prepaid-1)*duration);return rid;
end$$;
create function dg.reserve(rid uuid,plan text default 'basic',cy text default 'monthly') returns jsonb language sql as $$select tu.server(format('select public.acquire_or_create_pending_subscription_invoice(%L,%L,%L,''pix'',1,p_quote_token=>%L)',rid,plan,cy,(select 'scheduled-downgrade:'||id::text from subscription_quote_private.plan_changes where restaurant_id=rid and state in ('scheduled','reserved'))))$$;

do $$declare rid uuid;q jsonb;before_r jsonb;before_cycles jsonb;invoice_count integer;iid uuid;cy text;expiry timestamptz;begin
 rid:=dg.seed('live');select to_jsonb(r) into before_r from public.restaurants r where id=rid;
 select jsonb_agg(to_jsonb(c) order by id) into before_cycles from subscription_quote_private.cycles c where restaurant_id=rid;
 select count(*) into invoice_count from public.subscription_invoices where restaurant_id=rid;
 q:=dg.admin(rid,'pro');perform dg.ok(q->>'state'='00000','schedule authorized: '||q::text);
 perform dg.ok((select to_jsonb(r)=before_r from public.restaurants r where id=rid),'schedule changes no restaurant field');
 perform dg.ok((select jsonb_agg(to_jsonb(c) order by id)=before_cycles from subscription_quote_private.cycles c where restaurant_id=rid),'immutable original cycles untouched');
 perform dg.ok((select count(*)=invoice_count from public.subscription_invoices where restaurant_id=rid),'no invoice, charge, refund or credit on schedule');
 perform dg.ok(subscription_quote_private.effective_plan(rid)='premium','Premium remains during current cycle');
 perform dg.ok(subscription_quote_private.effective_subscription(rid,(select ends_at from dg.fixtures where label='live')-interval '1 microsecond')->>'plan'='premium','instant before boundary preserves plan');
 perform dg.ok(subscription_quote_private.effective_subscription(rid,(select ends_at from dg.fixtures where label='live'))->>'billing_status'='grace_period','boundary without payment follows existing grace');
 perform dg.ok(subscription_quote_private.effective_subscription(rid,(select ends_at from dg.fixtures where label='live')+interval '73 hours')->>'billing_status'='expired','unpaid expiry never activates lower plan or grants days');
 perform dg.ok(dg.reserve(rid,'pro')->>'state'='22023','future downgrade cannot emit before boundary');
 perform dg.ok(dg.admin(rid,'basic')->>'state'='00000','replace scheduled request');
 perform dg.ok((select count(*)=1 from subscription_quote_private.plan_changes where restaurant_id=rid and state='scheduled' and target_plan='basic'),'one active replacement');
 perform dg.ok(dg.admin(rid,null,'cancel')->>'state'='00000','cancel before reservation');
 perform dg.ok(dg.admin(rid,null,'cancel')->>'state'='00000','cancel idempotent');
 perform dg.ok((select count(*)=invoice_count from public.subscription_invoices where restaurant_id=rid),'cancel causes no invoice');
 perform dg.ok(dg.admin(rid,'premium')->>'state'='22023','same plan not downgrade');
 perform dg.ok(dg.admin(rid,'basic','schedule','a9000000-0000-4000-8000-000000000002')->>'state'='42501','foreign admin/user denied');
 perform dg.ok(dg.admin(rid,null,'cancel','a9000000-0000-4000-8000-000000000002')->>'state'='42501','foreign user cannot cancel');
 perform dg.ok(tu.client(format('select public.schedule_subscription_downgrade(%L,''basic'')',rid),'anon')->>'state'='42501','anon denied');
 perform dg.ok(tu.client(format('select to_jsonb(x) from subscription_quote_private.plan_changes x where restaurant_id=%L',rid),'authenticated')->>'state'='42501','private schedule not directly readable');
 perform dg.ok(tu.client(format('select public.acquire_or_create_pending_subscription_invoice(%L,''basic'',''monthly'',''pix'',1)',rid),'authenticated')->>'state'='42501','client cannot forge reservation');
 perform dg.ok(tu.client(format('with changed as(update public.restaurants set subscription_plan=''basic'' where id=%L returning id)select to_jsonb(count(*)) from changed',rid),'authenticated')->>'state'='42501','direct client plan update refused');
 update public.restaurant_members set active=false where restaurant_id=rid and user_id='a9000000-0000-4000-8000-000000000001';
 perform dg.ok(dg.admin(rid,'basic')->>'state'='42501','inactive admin denied');
 update public.restaurant_members set active=true,role='waiter' where restaurant_id=rid and user_id='a9000000-0000-4000-8000-000000000001';
 perform dg.ok(dg.admin(rid,'basic')->>'state'='42501','waiter denied');
 perform dg.ok(dg.admin(rid,null,'cancel')->>'state'='42501','waiter cannot cancel');
 update public.restaurant_members set role='admin' where restaurant_id=rid and user_id='a9000000-0000-4000-8000-000000000001';
 insert into public.platform_admins(user_id,active)values('a9000000-0000-4000-8000-000000000002',true);
 perform dg.ok(dg.admin(rid,'basic','schedule','a9000000-0000-4000-8000-000000000002')->>'state'='00000','active platform admin may schedule');
 perform dg.ok(dg.admin(rid,null,'cancel','a9000000-0000-4000-8000-000000000002')->>'state'='00000','active platform admin may cancel');
 delete from public.platform_admins where user_id='a9000000-0000-4000-8000-000000000002';
 perform dg.ok((select to_jsonb(r)=before_r from public.restaurants r where id=rid),'negative requests change no restaurant data');
 for cy in select unnest(array['monthly','yearly']) loop
  rid:=dg.seed('ended-'||cy,'ended',cy);select subscription_expires_at into expiry from public.restaurants where id=rid;
  perform dg.ok(dg.admin(rid,'basic')->>'state'='00000','schedule expired cycle '||cy);
  q:=dg.reserve(rid,'basic',cy);perform dg.ok(q->>'state'='00000','reserve renewal '||cy||q::text);
  iid:=(q#>>'{result,invoice,id}')::uuid;
  perform dg.ok((select amount_cents=basic_price_cents*case cy when 'yearly' then 11 else 1 end from public.subscription_invoices,public.platform_settings where subscription_invoices.id=iid and platform_settings.id='default'),'server full price, client 1 ignored '||cy);
  perform dg.ok((dg.reserve(rid,'basic',cy)#>>'{result,invoice,id}')::uuid=iid,'same invoice retry '||cy);
  perform dg.ok(dg.admin(rid,null,'cancel')->>'state'='22023','no cancellation once charge reserved '||cy);
  perform dg.ok(dg.admin(rid,'pro')->>'state'='22023','no replacement while invoice outstanding '||cy);
  perform dg.ok(subscription_quote_private.effective_plan(rid)='premium','unpaid renewal does not downgrade '||cy);
  perform dg.ok(subscription_quote_private.effective_subscription(rid)->>'billing_status'='grace_period','pending payment retains existing grace, not active new cycle '||cy);
  perform dg.ok((select subscription_expires_at=expiry from public.restaurants where id=rid),'unpaid never adds days '||cy);
  q:=tu.server(format('select public.claim_subscription_invoice_gateway_emission(%L)',iid));perform dg.ok((q#>>'{result,claimed}')::boolean,'emission claim revalidated '||cy);
  q:=tu.pay(iid);perform dg.ok(q->>'state'='00000' and (q#>>'{result,success}')::boolean,'same transactional confirmation applies downgrade '||cy||q::text);
  perform dg.ok(subscription_quote_private.effective_plan(rid)='basic','Basic effective only after paid renewal '||cy);
  perform dg.ok((select count(*)=1 from subscription_quote_private.cycles c join subscription_quote_private.cycle_payments p on p.cycle_id=c.id where p.invoice_id=iid and c.starts_at>=expiry and c.ends_at-c.starts_at=case cy when 'yearly' then interval '8760 hours' else interval '720 hours' end),'new independent cycle full duration '||cy);
  perform dg.ok((tu.pay(iid)#>>'{result,already_paid}')::boolean,'confirmation replay idempotent '||cy);
  q:=tu.server(format('select public.acquire_or_create_pending_subscription_invoice(%L,''basic'',%L,''pix'',1,p_quote_token=>%L)',rid,cy,(select 'scheduled-downgrade:'||s.id::text from subscription_quote_private.plan_changes s where s.restaurant_id=rid and s.state='completed')));
  perform dg.ok((q#>>'{result,invoice,id}')::uuid=iid and q#>>'{result,invoice,status}'='paid','checkout retry after confirmation returns the same paid invoice '||cy);
  perform dg.ok((select count(*)=1 from subscription_quote_private.plan_change_receipts where invoice_id=iid),'one receipt '||cy);
  q:=dg.reserve(rid,'basic',cy);perform dg.ok(q->>'state'='00000','normal same-plan renewal remains possible after downgrade '||cy||q::text);
 end loop;
 rid:=dg.seed('trial-paid','trial');select to_jsonb(r) into before_r from public.restaurants r where id=rid;
 q:=dg.admin(rid,'basic');perform dg.ok(q->>'state'='00000','schedule during proved Premium trial with future paid plan');
 perform dg.ok(subscription_quote_private.effective_plan(rid)='premium' and (subscription_quote_private.effective_subscription(rid)->>'trial_active')::boolean,'full trial remains Premium');
 perform dg.ok((q#>>'{data,scheduled_change,not_before}')::timestamptz>(subscription_quote_private.effective_subscription(rid)->>'original_trial_end')::timestamptz,'already-paid future period preserved too');
 perform dg.ok((select to_jsonb(r)=before_r from public.restaurants r where id=rid),'no trial date/flag/plan changed');
 perform dg.ok(subscription_quote_private.effective_subscription(rid,(subscription_quote_private.effective_subscription(rid)->>'original_trial_end')::timestamptz)->>'plan'='premium','trial end still enters already-paid Premium, not scheduled lower tier');
 -- A free Premium experience is not a paid Premium contract to downgrade.
 rid:=gen_random_uuid();insert into public.restaurants(id,name,slug,subscription_plan,subscription_is_trial,subscription_expires_at,max_tables,unlimited_tables)values(rid,'First purchase','dg-first-'||rid,'premium',true,now()+interval '120 hours',null,true);
 insert into subscription_quote_private.trial_terms values(rid,now()-interval '48 hours',now()+interval '120 hours','onboarding_premium_168h');
 insert into public.restaurant_members(restaurant_id,user_id,role,active)values(rid,'a9000000-0000-4000-8000-000000000001','admin',true);
 perform dg.ok(dg.admin(rid,null,'get')#>>'{data,current_plan}' is null,'server does not classify free Premium as a paid contract');
 q:=dg.reserve(rid,'basic');perform dg.ok(q->>'state'='00000','first trial purchase still reserves through original checkout');
 iid:=(q#>>'{result,invoice,id}')::uuid;q:=tu.pay(iid);perform dg.ok((q#>>'{result,success}')::boolean,'first purchase confirmation still applies original 30-day paid cycle');
 perform dg.ok(subscription_quote_private.effective_plan(rid)='premium' and (subscription_quote_private.effective_subscription(rid)->>'trial_active')::boolean,'first Basic purchase retains full remaining Premium trial after new migration');
 rid:=dg.seed('multiple-prepaid','live','monthly',3);q:=dg.admin(rid,'basic');
 perform dg.ok((q#>>'{data,scheduled_change,not_before}')::timestamptz=(select ends_at from dg.fixtures where label='multiple-prepaid'),'all prepaid cycles protected to last paid boundary');
 perform dg.ok(dg.reserve(rid)->>'state'='22023','no charge against earlier prepaid cycle');
 perform dg.ok(not (dg.admin((select f.rid from tu.fixtures f where f.label='upgrade-changed-evidence'),null,'get')#>>'{data,available}')::boolean,'unresolved upgrade evidence prevents competing scheduling');
 -- Old paid data without authoritative allocation cannot be reconstructed.
 insert into public.restaurants(name,slug,subscription_plan,subscription_expires_at)values('Legacy','dg-legacy','premium',now()+interval '1 day')returning id into rid;
 perform dg.ok(dg.admin(rid,'basic')->>'state'='42501','membership checked before legacy state');
 insert into public.restaurant_members(restaurant_id,user_id,role,active)values(rid,'a9000000-0000-4000-8000-000000000001','admin',true);
 perform dg.ok(dg.admin(rid,'basic')->>'state'='22023','legacy without evidence unavailable, no dates fabricated');
 -- Payment after intervening state change is preserved for review, never silently applied.
 rid:=dg.seed('state-changed','ended');perform dg.admin(rid,'basic');iid:=(dg.reserve(rid)#>>'{result,invoice,id}')::uuid;
 update public.restaurants set active=false where id=rid;
 q:=tu.pay(iid);perform dg.ok((q#>>'{result,requires_review}')::boolean,'late changed state receipt requires review');
 perform dg.ok((select status='paid' from public.subscription_invoices where id=iid),'received payment not discarded');
 perform dg.ok(not exists(select 1 from subscription_quote_private.cycle_payments where invoice_id=iid),'review does not allocate credit or add cycle');
 perform dg.ok((tu.pay(iid)#>>'{result,already_paid}')::boolean,'review replay idempotent');
 -- Race fixtures consumed by independent psql sessions in the runner.
 perform dg.seed('race-schedule','ended');rid:=dg.seed('race-payment','ended');perform dg.admin(rid,'basic');
 iid:=(dg.reserve(rid)#>>'{result,invoice,id}')::uuid;update public.subscription_invoices set external_reference=id::text where id=iid;
end$$;
select 'PASS: '||count(*)||' scheduled downgrade SQL assertions' from dg.results;
commit;

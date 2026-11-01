begin;
create schema tu;
create table tu.checks(label text);
create function tu.ok(b boolean,label text)returns void language plpgsql as $$begin if b is distinct from true then raise exception 'FAIL: %',label;end if;insert into tu.checks values(label);end$$;
create function tu.server(q text)returns jsonb language plpgsql as $$
#variable_conflict use_variable
declare r jsonb;begin
 set local role service_role;perform set_config('request.jwt.claim.sub','',true);perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 execute q into r;reset role;return jsonb_build_object('state','00000','result',r);
exception when others then reset role;return jsonb_build_object('state',sqlstate,'message',sqlerrm);end$$;
create function tu.admin(rid uuid,plan text,cycle text,uid uuid default 'a9000000-0000-4000-8000-000000000001')returns jsonb language plpgsql as $$
#variable_conflict use_variable
declare r jsonb;begin
 set local role authenticated;perform set_config('request.jwt.claim.sub',uid::text,true);perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',uid)::text,true);
 select public.quote_subscription_transition(rid,plan,cycle) into r;reset role;return jsonb_build_object('state','00000','result',r);
exception when others then reset role;return jsonb_build_object('state',sqlstate,'message',sqlerrm);end$$;
insert into auth.users(id,email)values('a9000000-0000-4000-8000-000000000001','owner@trial-upgrades.invalid'),('a9000000-0000-4000-8000-000000000002','outsider@trial-upgrades.invalid');
create table tu.fixtures(label text primary key,rid uuid,cycle_id uuid,start_at timestamptz,end_at timestamptz,base_invoice uuid);
create function tu.seed(label text,cycle text default 'monthly')returns uuid language plpgsql as $$
#variable_conflict use_variable
declare rid uuid:=gen_random_uuid();iid uuid:=gen_random_uuid();q jsonb;c subscription_quote_private.cycles;price integer;begin
 insert into public.restaurants(id,name,slug,subscription_plan,subscription_is_trial,subscription_started_at,subscription_expires_at,max_tables,unlimited_tables)values(rid,label,label,'premium',true,now()-interval '48 hours',now()+interval '120 hours',null,true);
 insert into public.restaurant_members(restaurant_id,user_id,role,active)values(rid,'a9000000-0000-4000-8000-000000000001','admin',true);
 insert into subscription_quote_private.trial_terms values(rid,now()-interval '48 hours',now()+interval '120 hours','onboarding_premium_168h');
 select basic_price_cents*case cycle when 'yearly' then 11 else 1 end into price from public.platform_settings where id='default';
 insert into public.subscription_invoices(id,restaurant_id,plan_id,billing_cycle,payment_method,amount_cents,external_reference)values(iid,rid,'basic',cycle,'pix',price,iid::text);
 q:=tu.server(format('select public.confirm_subscription_invoice_payment(%L,%L,%s,%L)',iid,iid,price,rid));
 perform tu.ok(q->>'state'='00000','first purchase succeeds under new migration: '||label);
 select * into c from subscription_quote_private.cycles where restaurant_id=rid;
 insert into tu.fixtures values(label,rid,c.id,c.starts_at,c.ends_at,iid);
 return rid;
end$$;
create function tu.reserve(rid uuid,plan text,cycle text default 'monthly',method text default 'pix')returns jsonb language sql as $$select tu.server(format('select public.acquire_or_create_pending_subscription_invoice(%L,%L,%L,%L,1,p_quote_token=>%L)',rid,plan,cycle,method,subscription_quote_private.upgrade_quote(rid,plan,cycle)->>'quote_token'))$$;
create function tu.pay(iid uuid)returns jsonb language plpgsql as $$
#variable_conflict use_variable
declare i public.subscription_invoices;begin
 update public.subscription_invoices set external_reference=id::text where id=iid returning * into i;
 return tu.server(format('select public.confirm_subscription_invoice_payment(%L,%L,%s,%L)',iid,iid,i.amount_cents,i.restaurant_id));end$$;
create function tu.client(q text,db_role text)returns jsonb language plpgsql as $$declare r jsonb;begin
 execute format('set local role %I',db_role);perform set_config('request.jwt.claim.sub','a9000000-0000-4000-8000-000000000001',true);perform set_config('request.jwt.claims',jsonb_build_object('role',db_role,'sub','a9000000-0000-4000-8000-000000000001')::text,true);
 execute q into r;reset role;return jsonb_build_object('state','00000','result',r);
exception when others then reset role;return jsonb_build_object('state',sqlstate);end$$;
do $$
#variable_conflict use_variable
declare rid uuid;cy text;q jsonb;res jsonb;iid uuid;old_snapshot jsonb;expected bigint;target text;e jsonb;begin
 for cy in select unnest(array['monthly','yearly']) loop
  rid:=tu.seed('upgrade-'||cy,cy);
  select to_jsonb(c) into old_snapshot from subscription_quote_private.cycles c where restaurant_id=rid;
  perform tu.ok(tu.admin(rid,'pro',cy,'a9000000-0000-4000-8000-000000000002')->>'state'='42501','other restaurant/outsider cannot quote');
  perform tu.ok(not (tu.admin(rid,'pro',case cy when 'monthly' then 'yearly' else 'monthly' end)->'result'->>'available')::boolean,'periodicity switch blocked before invoice');
  for target in select unnest(array['pro','premium']) loop
   q:=tu.admin(rid,target,cy)->'result';
   select (case target when 'pro' then pro_price_cents-basic_price_cents else premium_price_cents-pro_price_cents end)*case cy when 'yearly' then 11 else 1 end into expected from public.platform_settings where id='default';
   perform tu.ok((q->>'available')::boolean and (q->>'amount_to_charge_cents')::bigint=expected,'server quote exact same-cycle difference '||target||'/'||cy);
   res:=tu.reserve(rid,target,cy);iid:=(res->'result'->'invoice'->>'id')::uuid;
   perform tu.ok(res->>'state'='00000' and (res->'result'->'invoice'->>'amount_cents')::bigint=expected,'client amount 1 ignored; authoritative difference persisted: '||res::text);
   perform tu.ok((tu.reserve(rid,target,cy)->'result'->'invoice'->>'id')::uuid=iid,'repeat reservation reuses invoice');
   perform tu.ok(tu.reserve(rid,case target when 'pro' then 'premium' else 'pro' end,cy)->>'state'='22023','pending invoice holds all credit across targets');
   perform tu.ok(tu.reserve(rid,target,cy,'credit_card')->>'state'='22023','pending invoice prevents method double charge');
   res:=tu.server(format('select public.claim_subscription_invoice_gateway_emission(%L)',iid));
   perform tu.ok(res->>'state'='00000' and (res->'result'->>'claimed')::boolean,'emission revalidated under locks');
   res:=tu.pay(iid);perform tu.ok(res->>'state'='00000' and (res->'result'->>'success')::boolean,'confirmed upgrade applied');
   perform tu.ok((tu.pay(iid)->'result'->>'already_paid')::boolean,'replayed confirmation idempotent');
   perform tu.ok((select count(*)=1 from subscription_quote_private.cycle_payments where invoice_id=iid),'one payment allocation only');
   perform tu.ok((select to_jsonb(c)=old_snapshot from subscription_quote_private.cycles c where restaurant_id=rid),'immutable cycle intact including original price/dates');
   e:=subscription_quote_private.effective_subscription(rid);
   perform tu.ok(e->>'plan'='premium' and (e->>'unlimited_tables')::boolean and e->>'contracted_plan'=target,'effective Premium retained; future target tracked');
   perform tu.ok((tu.client(format('select to_jsonb(public.has_contract_module(%L,''inventory'') and public.has_contract_module(%L,''finance''))',rid,rid),'authenticated')->>'result')::boolean,'real module decision keeps inventory/finance during upgraded trial');
   select subscription_quote_private.effective_subscription(rid,start_at) into e from tu.fixtures where fixtures.rid=rid;
   perform tu.ok(e->>'plan'=target and case target when 'pro' then (e->>'max_tables')::integer=20 and not (e->>'unlimited_tables')::boolean else (e->>'unlimited_tables')::boolean end,'final target and capacity effective at exact start');
   perform tu.ok((select sum(cp.confirmed_credit_cents)=(q->>'full_amount_cents')::bigint from subscription_quote_private.cycle_payments cp join subscription_quote_private.cycles c on c.id=cp.cycle_id where c.restaurant_id=rid),'credit sum exact; no duplicate or other cycle credit');
  end loop;
  perform tu.ok(not (tu.admin(rid,'basic',cy)->'result'->>'available')::boolean,'downgrade blocked');
 end loop;
 -- Direct Basic -> Premium.
 rid:=tu.seed('upgrade-direct');q:=tu.admin(rid,'premium','monthly')->'result';
 select premium_price_cents-basic_price_cents into expected from public.platform_settings where id='default';
 perform tu.ok((q->>'amount_to_charge_cents')::bigint=expected,'direct Basic Premium full difference');
 iid:=(tu.reserve(rid,'premium')->'result'->'invoice'->>'id')::uuid;
 perform tu.ok((tu.pay(iid)->'result'->>'success')::boolean,'direct upgrade confirmed');
end$$;
-- Explicit historical fixtures for late receipts; no mutation of immutable clocks.
do $$
#variable_conflict use_variable
declare rid uuid;iid uuid;cid uuid;upgrade_id uuid;ended boolean;st timestamptz;en timestamptz;q jsonb;bp integer;pp integer;begin
 select basic_price_cents,pro_price_cents into bp,pp from public.platform_settings where id='default';
 foreach ended in array array[false,true] loop
  rid:=gen_random_uuid();iid:=gen_random_uuid();cid:=gen_random_uuid();upgrade_id:=gen_random_uuid();
  st:=case when ended then now()-interval '720 hours 1 second' else now()-interval '1 hour' end;en:=st+interval '720 hours';
  insert into public.restaurants(id,name,slug,subscription_plan,subscription_is_trial,subscription_expires_at)values(rid,'Late receipt','late-'||rid,'basic',false,en);
  insert into subscription_quote_private.trial_terms values(rid,st-interval '168 hours',st,'onboarding_premium_168h');
  insert into public.subscription_invoices(id,restaurant_id,plan_id,billing_cycle,payment_method,amount_cents,status,paid_at,external_reference)values(iid,rid,'basic','monthly','pix',bp,'paid',st-interval '1 day',iid::text);
  insert into subscription_quote_private.cycles values(cid,rid,'basic','monthly',st,en,bp,'trial_purchase_v1');
  insert into subscription_quote_private.cycle_payments values(iid,cid,bp);
  insert into public.subscription_invoices(id,restaurant_id,plan_id,billing_cycle,payment_method,amount_cents,external_reference)values(upgrade_id,rid,'pro','monthly','pix',pp-bp,upgrade_id::text);
  insert into subscription_quote_private.trial_upgrades(invoice_id,cycle_id,from_plan,target_plan,full_amount_cents,credit_cents,charge_cents,trial_end,quoted_at)values(upgrade_id,cid,'basic','pro',pp,bp,pp-bp,st,st-interval '1 hour');
  update public.subscription_invoices set external_reference=null where id=upgrade_id;
  q:=tu.server(format('select public.claim_subscription_invoice_gateway_emission(%L)',upgrade_id));
  perform tu.ok(q->>'state'='22023','emission after trial end denied');
  q:=tu.pay(upgrade_id);perform tu.ok(q->>'state'='00000','late confirmation accepted receipt: '||q::text);q:=q->'result';
  perform tu.ok((q->>'requires_review')::boolean,'any payment confirmed after trial requires explicit reconciliation');
  perform tu.ok((select status='paid' from public.subscription_invoices where id=upgrade_id),'payment receipt preserved even when review needed');
  perform tu.ok((select subscription_expires_at=en from public.restaurants where id=rid),'late receipt never adds days');
  if ended then
   perform tu.ok(not exists(select 1 from subscription_quote_private.cycle_payments where invoice_id=upgrade_id),'review does not invent usable credit');
   perform tu.ok(tu.reserve(rid,'premium')->>'state'='22023','review blocks further charges');
  else
   -- Explicit historical fixture: upgrade actually confirmed BEFORE trial end.
   -- No date mutation or late upgrade; only the ordinary renewal runs at the real current clock.
   rid:=gen_random_uuid();iid:=gen_random_uuid();cid:=gen_random_uuid();upgrade_id:=gen_random_uuid();st:=now()-interval '1 hour';en:=st+interval '720 hours';
   insert into public.restaurants(id,name,slug,subscription_plan,subscription_is_trial,subscription_expires_at)values(rid,'Amended renewal','renew-amended-'||rid,'pro',false,en);
   insert into subscription_quote_private.trial_terms values(rid,st-interval '168 hours',st,'onboarding_premium_168h');
   insert into public.subscription_invoices(id,restaurant_id,plan_id,billing_cycle,payment_method,amount_cents,status,paid_at,external_reference)values(iid,rid,'basic','monthly','pix',bp,'paid',st-interval '24 hours',iid::text),(upgrade_id,rid,'pro','monthly','pix',pp-bp,'paid',st-interval '1 hour',upgrade_id::text);
   insert into subscription_quote_private.cycles values(cid,rid,'basic','monthly',st,en,bp,'trial_purchase_v1');
   insert into subscription_quote_private.cycle_payments values(iid,cid,bp),(upgrade_id,cid,pp-bp);
   insert into subscription_quote_private.trial_upgrades(invoice_id,cycle_id,from_plan,target_plan,full_amount_cents,credit_cents,charge_cents,trial_end,quoted_at)values(upgrade_id,cid,'basic','pro',pp,bp,pp-bp,st,st-interval '2 hours');
   insert into subscription_quote_private.trial_upgrade_receipts values(upgrade_id,st-interval '1 hour','applied',null);
   q:=tu.reserve(rid,'pro');perform tu.ok(q->>'state'='00000','normal renewal after upgrade reserved');
   upgrade_id:=(q->'result'->'invoice'->>'id')::uuid;
   -- A trusted caller supplies full catalog price in the ordinary path.
   update public.subscription_invoices set amount_cents=pp where id=upgrade_id;
   q:=tu.pay(upgrade_id);perform tu.ok(q->>'state'='00000','normal renewal after upgrade confirmed');
   perform tu.ok((select count(*)=2 from subscription_quote_private.cycles where restaurant_id=rid),'renewal creates separate cycle; upgrade never does');
  end if;
 end loop;
end$$;
-- Persist a real fixture for independent-session races in the runner.
do $$
#variable_conflict use_variable
declare rid uuid;other uuid;q jsonb;iid uuid;snapshot jsonb;oldquote jsonb;expected bigint;begin
 rid:=tu.seed('upgrade-stale-quote');other:=tu.seed('upgrade-other');
 insert into public.restaurant_members(restaurant_id,user_id,role,active)values(other,'a9000000-0000-4000-8000-000000000002','admin',true);
 perform tu.ok(tu.admin(rid,'pro','monthly','a9000000-0000-4000-8000-000000000002')->>'state'='42501','admin of actual other restaurant denied');
 select to_jsonb(r) into snapshot from public.restaurants r where id=rid;
 perform tu.ok(tu.client(format('select public.acquire_or_create_pending_subscription_invoice(%L,''pro'',''monthly'',''pix'',1)',rid),'authenticated')->>'state'='42501','client cannot reserve with invented amount');
 perform tu.ok(tu.client(format('select public.acquire_or_create_pending_subscription_invoice(%L,''pro'',''monthly'',''pix'',1)',rid),'anon')->>'state'='42501','anon cannot reserve');
 perform tu.ok(tu.client('select public.confirm_subscription_invoice_payment(gen_random_uuid(),''forged'',1,gen_random_uuid())','authenticated')->>'state'='42501','client cannot confirm');
 perform tu.ok(tu.client('select public.claim_subscription_invoice_gateway_emission(gen_random_uuid())','authenticated')->>'state'='42501','client cannot claim gateway emission');
 perform tu.ok(tu.client('select to_jsonb(u) from subscription_quote_private.trial_upgrades u limit 1','authenticated')->>'state'='42501','client cannot access private financial evidence');
 perform tu.ok((select to_jsonb(r)=snapshot from public.restaurants r where id=rid) and (select count(*)=1 from public.subscription_invoices where restaurant_id=rid),'negative authorization leaves subscription and invoices unchanged');
 oldquote:=tu.admin(rid,'premium','monthly')->'result';
 iid:=(tu.reserve(rid,'pro')->'result'->'invoice'->>'id')::uuid;
 perform tu.ok(tu.server(format('select public.confirm_subscription_invoice_payment(%L,%L,8000,%L)',iid,iid,other))->>'state'='42501','wrong restaurant confirmation denied');
 update public.subscription_invoices set external_reference=iid::text where id=iid;
 perform tu.ok(tu.server(format('select public.confirm_subscription_invoice_payment(%L,%L,1,%L)',iid,iid,rid))->>'state'='22023','tampered payment amount denied');
 perform tu.ok((tu.pay(iid)->'result'->>'success')::boolean,'intervening upgrade confirmed');
 select premium_price_cents-pro_price_cents into expected from public.platform_settings where id='default';
 perform tu.ok(tu.server(format('select public.acquire_or_create_pending_subscription_invoice(%L,''premium'',''monthly'',''pix'',1,p_quote_token=>%L)',rid,oldquote->>'quote_token'))->>'state'='22023','stale displayed quote cannot issue a different amount');
 q:=tu.reserve(rid,'premium');iid:=(q->'result'->'invoice'->>'id')::uuid;
 perform tu.ok((q->'result'->'invoice'->>'amount_cents')::bigint=expected and (oldquote->>'amount_to_charge_cents')::bigint>expected,'stale quote recalculated under lock against new same-cycle credit');
 begin update subscription_quote_private.trial_upgrades set full_amount_cents=full_amount_cents+1 where invoice_id=iid;raise exception 'FAIL mutable intent';exception when insufficient_privilege then perform tu.ok(true,'upgrade evidence immutable');end;
 begin update subscription_quote_private.cycle_payments set confirmed_credit_cents=confirmed_credit_cents+1 where cycle_id=(select cycle_id from tu.fixtures where fixtures.rid=rid);raise exception 'FAIL mutable allocation';exception when insufficient_privilege then perform tu.ok(true,'allocations immutable');end;
 update public.restaurant_members set role='waiter' where restaurant_id=rid;
 perform tu.ok(tu.admin(rid,'premium','monthly')->>'state'='42501','waiter cannot quote');
 update public.restaurant_members set role='admin',active=false where restaurant_id=rid;
 perform tu.ok(tu.admin(rid,'premium','monthly')->>'state'='42501','inactive admin cannot quote');
 update public.restaurant_members set active=true where restaurant_id=rid;
 perform tu.ok((tu.pay(iid)->'result'->>'success')::boolean,'new credit accepted exactly once');
 -- Evidence changed between reservation and emission/confirmation: no silent success.
 rid:=tu.seed('upgrade-changed-evidence');iid:=(tu.reserve(rid,'pro')->'result'->'invoice'->>'id')::uuid;
 select to_jsonb(r) into snapshot from public.restaurants r where id=rid;
 update public.subscription_invoices set status='refunded' where id=(select base_invoice from tu.fixtures where fixtures.rid=rid);
 perform tu.ok(tu.server(format('select public.claim_subscription_invoice_gateway_emission(%L)',iid))->>'state'='22023','changed payment evidence blocks new emission');
 q:=tu.pay(iid);perform tu.ok(q->>'state'='00000' and (q->'result'->>'requires_review')::boolean,'already-received money recorded for changed evidence');
 perform tu.ok((select status='paid' from public.subscription_invoices where id=iid),'review preserves gateway receipt');
 perform tu.ok((select to_jsonb(r)=snapshot from public.restaurants r where id=rid),'review does not modify subscription/dates/rights');
 perform tu.ok(not exists(select 1 from subscription_quote_private.cycle_payments where invoice_id=iid),'reviewed difference never treated as full cycle or available credit');
 rid:=tu.seed('upgrade-safe-retry');iid:=(tu.reserve(rid,'pro')->'result'->'invoice'->>'id')::uuid;
 update public.subscription_invoices set status='failed' where id=iid;
 q:=tu.reserve(rid,'pro');perform tu.ok((q->'result'->'invoice'->>'id')::uuid=iid and q->'result'->'invoice'->>'status'='pending','proven no-POST local failure reuses same invoice and intent');
 -- No history / unpaid old invoices: never guessed as a source of discount.
 insert into public.restaurants(id,name,slug)values(gen_random_uuid(),'No evidence','upgrade-no-evidence')returning id into rid;
 insert into public.restaurant_members(restaurant_id,user_id,role,active)values(rid,'a9000000-0000-4000-8000-000000000001','admin',true);
 q:=tu.admin(rid,'pro','monthly')->'result';perform tu.ok(not (q->>'available')::boolean,'missing historical evidence blocks discount');
 perform tu.ok(tu.reserve(rid,'pro')->>'state'='22023' and not exists(select 1 from public.subscription_invoices where restaurant_id=rid),'unproven transition blocked before invoice/gateway');
end$$;
select tu.seed('upgrade-race');
select 'UPGRADE ASSERTIONS: '||count(*) from tu.checks;
select label from tu.checks;
commit;

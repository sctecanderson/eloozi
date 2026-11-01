begin;
alter table public.platform_audit_logs drop constraint platform_audit_logs_action_check;
alter table public.platform_audit_logs add constraint platform_audit_logs_action_check check(action in ('plan_changed','cycle_renewed','table_deleted','restaurant_suspended','restaurant_restored','catalog_updated','branding_updated','payment_reconciliation_required'));
-- Append-only amendments: original trial/cycle evidence is never rewritten.
create table subscription_quote_private.trial_upgrades (
 invoice_id uuid primary key references public.subscription_invoices(id),
 cycle_id uuid not null references subscription_quote_private.cycles(id),
 operation text not null default 'trial_prepaid_upgrade' check(operation='trial_prepaid_upgrade'),
 from_plan text not null check(from_plan in ('basic','pro')),
 target_plan text not null check(target_plan in ('pro','premium')),
 full_amount_cents bigint not null check(full_amount_cents>0),
 credit_cents bigint not null check(credit_cents>0),
 charge_cents bigint not null check(charge_cents>0 and charge_cents=full_amount_cents-credit_cents),
 quoted_at timestamptz not null default clock_timestamp(),
 trial_end timestamptz not null,
 check((from_plan='basic' and target_plan in ('pro','premium')) or (from_plan='pro' and target_plan='premium'))
);
create table subscription_quote_private.trial_upgrade_receipts (
 invoice_id uuid primary key references subscription_quote_private.trial_upgrades(invoice_id),
 received_at timestamptz not null default clock_timestamp(),
 disposition text not null check(disposition in ('applied','review_required')),
 reason text
);
create index on subscription_quote_private.trial_upgrades(cycle_id);
alter table subscription_quote_private.trial_upgrades enable row level security;
alter table subscription_quote_private.trial_upgrade_receipts enable row level security;
create trigger immutable_trial_upgrades before update or delete on subscription_quote_private.trial_upgrades for each row execute function subscription_quote_private.immutable_evidence();
create trigger immutable_trial_upgrade_receipts before update or delete on subscription_quote_private.trial_upgrade_receipts for each row execute function subscription_quote_private.immutable_evidence();
-- Also protect allocations, including the original first purchase.
create trigger immutable_cycle_payments before update or delete on subscription_quote_private.cycle_payments for each row execute function subscription_quote_private.immutable_evidence();

create function subscription_quote_private.cycle_final_plan(p_cycle uuid) returns text language sql stable security definer set search_path='' as $$
 select coalesce((select u.target_plan from subscription_quote_private.trial_upgrades u
 join subscription_quote_private.trial_upgrade_receipts r using(invoice_id)
 join subscription_quote_private.cycle_payments cp using(invoice_id)
 join public.subscription_invoices i on i.id=u.invoice_id
 where u.cycle_id=p_cycle and cp.cycle_id=p_cycle and r.disposition='applied' and i.status='paid'
 and i.paid_at is not null and i.amount_cents=u.charge_cents and cp.confirmed_credit_cents=u.charge_cents
 order by case u.target_plan when 'premium' then 3 else 2 end desc limit 1),
 (select plan_id from subscription_quote_private.cycles where id=p_cycle))
$$;

create function subscription_quote_private.confirmed_cycle_credit(p_cycle uuid) returns bigint language sql stable security definer set search_path='' as $$
 select case when bool_and(i.status='paid' and i.paid_at is not null and nullif(btrim(i.external_reference),'') is not null
 and i.restaurant_id=c.restaurant_id and i.billing_cycle=c.billing_cycle and i.amount_cents=cp.confirmed_credit_cents
 and (i.plan_id=c.plan_id and cp.confirmed_credit_cents=c.contracted_price_cents or exists(select 1 from subscription_quote_private.trial_upgrades u join subscription_quote_private.trial_upgrade_receipts r using(invoice_id) where u.invoice_id=i.id and u.cycle_id=c.id and r.disposition='applied' and u.charge_cents=i.amount_cents)))
 and bool_or(i.plan_id=c.plan_id and cp.confirmed_credit_cents=c.contracted_price_cents)
 then sum(cp.confirmed_credit_cents) else null end
 from subscription_quote_private.cycles c join subscription_quote_private.cycle_payments cp on cp.cycle_id=c.id join public.subscription_invoices i on i.id=cp.invoice_id where c.id=p_cycle
$$;
create function subscription_quote_private.upgrade_quote(p_id uuid,p_plan text,p_cycle text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare t subscription_quote_private.trial_terms;c subscription_quote_private.cycles;held subscription_quote_private.trial_upgrades;full_price bigint;credit bigint;current_plan text;reason text;q jsonb;begin
 q:=jsonb_build_object('available',false,'operation','trial_prepaid_upgrade','target_plan',p_plan,'billing_cycle',p_cycle,'payment_authorized',false,'requires_revalidation',true);
 select * into t from subscription_quote_private.trial_terms where restaurant_id=p_id and evidence_source='onboarding_premium_168h' and original_end-original_start=interval '168 hours';
 if t.restaurant_id is null then reason:='Histórico confiável do trial indisponível.';
 elsif clock_timestamp()<t.original_start or clock_timestamp()>=t.original_end then reason:='Upgrade antecipado disponível somente durante o trial vigente.';
 elsif p_plan is null or p_plan not in ('basic','pro','premium') or p_cycle is null or p_cycle not in ('monthly','yearly') then reason:='Plano ou periodicidade inválidos.';
 elsif (select count(*) from subscription_quote_private.cycles where restaurant_id=p_id and ends_at>clock_timestamp())<>1 then reason:='É necessário identificar um único ciclo futuro comprovado.';
 else
  select * into c from subscription_quote_private.cycles where restaurant_id=p_id and ends_at>clock_timestamp();
  current_plan:=subscription_quote_private.cycle_final_plan(c.id);
  select h.* into held from subscription_quote_private.trial_upgrades h where h.cycle_id=c.id and not exists(select 1 from subscription_quote_private.trial_upgrade_receipts receipt where receipt.invoice_id=h.invoice_id) limit 1;
  q:=q||jsonb_build_object('current_plan',current_plan,'cycle_id',c.id,'effective_at',c.starts_at,'expires_at',c.ends_at);
  if held.invoice_id is not null and held.target_plan<>p_plan then reason:='Há outro upgrade pendente. Conclua ou reconcilie a cobrança antes de usar o crédito.';
  elsif c.evidence_source is distinct from 'trial_purchase_v1' or c.starts_at<>t.original_end then reason:='O ciclo futuro não tem origem comprovada neste trial.';
  elsif c.billing_cycle<>p_cycle then reason:='Troca entre mensal e anual não está disponível nesta etapa.';
  elsif array_position(array['basic','pro','premium'],p_plan)<=array_position(array['basic','pro','premium'],current_plan) then reason:='Escolha um plano superior; renovação antecipada e downgrade não estão disponíveis durante o trial contratado.';
  elsif exists(select 1 from public.subscription_invoices i where i.restaurant_id=p_id and i.status='paid' and not exists(select 1 from subscription_quote_private.cycle_payments cp where cp.invoice_id=i.id)) then reason:='Há pagamento sem alocação confiável; reconciliação necessária.';
  elsif not exists(select 1 from subscription_quote_private.cycle_payments cp join public.subscription_invoices i on i.id=cp.invoice_id where cp.cycle_id=c.id and i.restaurant_id=p_id and i.status='paid' and i.paid_at is not null and nullif(btrim(i.external_reference),'') is not null and i.plan_id=c.plan_id and i.billing_cycle=c.billing_cycle and i.amount_cents=c.contracted_price_cents and cp.confirmed_credit_cents=c.contracted_price_cents) then reason:='Pagamento original do ciclo não comprovado.';
  else
   credit:=subscription_quote_private.confirmed_cycle_credit(c.id);
   select (case p_plan when 'basic' then basic_price_cents when 'pro' then pro_price_cents else premium_price_cents end)::bigint * case p_cycle when 'yearly' then 11 else 1 end into full_price from public.platform_settings where id='default';
   if held.invoice_id is not null then full_price:=held.full_amount_cents;end if;
   if credit is null then reason:='Evidência de crédito mudou; reconciliação necessária.';
   elsif exists(select 1 from public.restaurants where id=p_id and (not active or subscription_plan<>current_plan or subscription_expires_at<>c.ends_at)) then reason:='Estado contratual mudou; reconciliação necessária.';
   elsif full_price is null or full_price<=credit then reason:='Diferença não positiva ou catálogo inválido; nenhuma cobrança será emitida.';
   else return q||jsonb_build_object('available',true,'full_amount_cents',full_price,'credit_cents',credit,'amount_to_charge_cents',full_price-credit,'original_trial_end',t.original_end,'quoted_at',clock_timestamp(),'quote_token',md5(c.id::text||'/'||current_plan||'/'||p_plan||'/'||p_cycle||'/'||full_price::text||'/'||credit::text),'reason',null);
   end if;
  end if;
 end if;
 return q||jsonb_build_object('reason',reason,'message',reason);
end $$;

alter function public.quote_subscription_transition(uuid,text,text) set schema subscription_quote_private;
alter function subscription_quote_private.quote_subscription_transition(uuid,text,text) rename to quote_before_trial_upgrades;
create function public.quote_subscription_transition(p_restaurant_id uuid,p_target_plan text,p_billing_cycle text) returns jsonb language plpgsql stable security definer set search_path='' as $$begin
 if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) or not(public.is_platform_admin() or exists(select 1 from public.restaurant_members where restaurant_id=p_restaurant_id and user_id=auth.uid() and active and role='admin')) then raise exception 'Acesso administrativo negado.' using errcode='42501';end if;
 if exists(select 1 from subscription_quote_private.trial_terms where restaurant_id=p_restaurant_id and evidence_source='onboarding_premium_168h') and exists(select 1 from subscription_quote_private.cycles where restaurant_id=p_restaurant_id) then
  return subscription_quote_private.upgrade_quote(p_restaurant_id,p_target_plan,p_billing_cycle);
 end if;
 return subscription_quote_private.quote_before_trial_upgrades(p_restaurant_id,p_target_plan,p_billing_cycle);
end $$;
revoke all on function public.quote_subscription_transition(uuid,text,text) from public,anon;
grant execute on function public.quote_subscription_transition(uuid,text,text) to authenticated;

alter function subscription_quote_private.effective_subscription(uuid,timestamptz) rename to effective_before_trial_upgrades;
create function subscription_quote_private.effective_subscription(p_id uuid,p_at timestamptz default statement_timestamp()) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare e jsonb;c uuid;plan text;begin
 e:=subscription_quote_private.effective_before_trial_upgrades(p_id,p_at);
 if coalesce((e->>'known_trial')::boolean,false) and e->>'paid_start' is not null then
  select id into c from subscription_quote_private.cycles where restaurant_id=p_id and starts_at=(e->>'paid_start')::timestamptz and ends_at=(e->>'paid_end')::timestamptz and evidence_source='trial_purchase_v1';
  plan:=subscription_quote_private.cycle_final_plan(c);
  e:=e||jsonb_build_object('contracted_plan',plan,'expires_at',coalesce((select max(cy.ends_at) from subscription_quote_private.cycles cy where cy.restaurant_id=p_id and cy.evidence_source='trial_purchase_v1' and cy.billing_cycle=e->>'billing_cycle' and subscription_quote_private.cycle_final_plan(cy.id)=plan and subscription_quote_private.confirmed_cycle_credit(cy.id) is not null),(e->>'expires_at')::timestamptz));
  if not (e->>'trial_active')::boolean and p_at>=(e->>'paid_start')::timestamptz then
   e:=e||jsonb_build_object('plan',plan,'max_tables',case plan when 'basic' then 5 when 'pro' then 20 else null end,'unlimited_tables',plan='premium');
  end if;
 end if;
 return e;
end $$;

-- Existing public signatures remain; base routines are private and uncallable by clients.
alter function public.acquire_or_create_pending_subscription_invoice(uuid,text,text,text,integer,timestamptz,text,text,uuid) set schema subscription_quote_private;
alter function subscription_quote_private.acquire_or_create_pending_subscription_invoice(uuid,text,text,text,integer,timestamptz,text,text,uuid) rename to reserve_before_trial_upgrades;
alter function public.confirm_subscription_invoice_payment(uuid,text,integer,uuid) set schema subscription_quote_private;
alter function subscription_quote_private.confirm_subscription_invoice_payment(uuid,text,integer,uuid) rename to confirm_before_trial_upgrades;
-- Renewal after an amendment compares the final contracted plan, not the original immutable plan.
do $$declare d text;begin
 d:=pg_get_functiondef('subscription_quote_private.reserve_before_trial_upgrades(uuid,text,text,text,integer,timestamptz,text,text,uuid)'::regprocedure);
 d:=replace(d,'c.plan_id<>p_plan_id','subscription_quote_private.cycle_final_plan(c.id)<>p_plan_id');execute d;
 d:=pg_get_functiondef('subscription_quote_private.confirm_before_trial_upgrades(uuid,text,integer,uuid)'::regprocedure);
 d:=replace(d,'v_invoice.plan_id<>v_last_cycle.plan_id','v_invoice.plan_id<>subscription_quote_private.cycle_final_plan(v_last_cycle.id)');execute d;
end $$;

create function public.acquire_or_create_pending_subscription_invoice(p_restaurant_id uuid,p_plan_id text,p_billing_cycle text,p_payment_method text,p_amount_cents integer,p_pix_expires_at timestamptz default null,p_card_brand text default null,p_card_last4 text default null,p_created_by uuid default null,p_quote_token text default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare q jsonb;i public.subscription_invoices;u subscription_quote_private.trial_upgrades;begin
 perform public.assert_trusted_billing_server();
 perform 1 from public.restaurants where id=p_restaurant_id for update;
 if not found then raise exception 'Restaurante inexistente.' using errcode='22023';end if;
 -- A reservation continues to hold its credit even if PIX expires or gateway fails/gets uncertain.
 select x.* into u from subscription_quote_private.trial_upgrades x join subscription_quote_private.cycles c on c.id=x.cycle_id where c.restaurant_id=p_restaurant_id and not exists(select 1 from subscription_quote_private.trial_upgrade_receipts r where r.invoice_id=x.invoice_id) limit 1;
 if found then
  select * into i from public.subscription_invoices where id=u.invoice_id;
  if i.plan_id<>p_plan_id or i.billing_cycle<>p_billing_cycle or i.payment_method<>p_payment_method then raise exception 'Há upgrade pendente. Conclua ou reconcilie a cobrança existente antes de usar o crédito novamente.' using errcode='22023';end if;
  q:=subscription_quote_private.upgrade_quote(p_restaurant_id,p_plan_id,p_billing_cycle);
  if p_quote_token is distinct from q->>'quote_token' or p_quote_token is null then raise exception 'Cotação mudou ou expirou. Atualize os valores antes de pagar.' using errcode='22023';end if;
  -- Safe retry only when no gateway POST can be outstanding. Same invoice/intent/credit.
  if i.status='failed' and i.external_reference is null and i.gateway_emission_status is null and clock_timestamp()<u.trial_end then
   update public.subscription_invoices set status='pending' where id=i.id returning * into i;
  end if;
  return jsonb_build_object('reused',true,'invoice',to_jsonb(i),'operation',u.operation);
 end if;
 if exists(select 1 from subscription_quote_private.trial_upgrade_receipts r join subscription_quote_private.trial_upgrades amendment using(invoice_id) join subscription_quote_private.cycles c on c.id=amendment.cycle_id where c.restaurant_id=p_restaurant_id and r.disposition='review_required') then raise exception 'Pagamento recebido exige reconciliação administrativa antes de outra cobrança.' using errcode='22023';end if;
 if exists(select 1 from subscription_quote_private.trial_terms where restaurant_id=p_restaurant_id and evidence_source='onboarding_premium_168h' and original_end>clock_timestamp()) and exists(select 1 from subscription_quote_private.cycles where restaurant_id=p_restaurant_id) then
  q:=subscription_quote_private.upgrade_quote(p_restaurant_id,p_plan_id,p_billing_cycle);
  if not (q->>'available')::boolean then raise exception '%',q->>'reason' using errcode='22023';end if;
  if p_quote_token is distinct from q->>'quote_token' or p_quote_token is null then raise exception 'Cotação mudou. Confira os novos valores antes de pagar.' using errcode='22023';end if;
  if p_payment_method not in ('pix','credit_card','debit_card') or p_payment_method is null then raise exception 'Método inválido.' using errcode='22023';end if;
  if exists(select 1 from public.subscription_invoices where restaurant_id=p_restaurant_id and status='pending') then raise exception 'Existe cobrança pendente; reconcilie antes do upgrade.' using errcode='22023';end if;
  insert into public.subscription_invoices(restaurant_id,plan_id,billing_cycle,payment_method,amount_cents,pix_expires_at,card_brand,card_last4,created_by)
  values(p_restaurant_id,p_plan_id,p_billing_cycle,p_payment_method,(q->>'amount_to_charge_cents')::integer,p_pix_expires_at,p_card_brand,p_card_last4,p_created_by) returning * into i;
  insert into subscription_quote_private.trial_upgrades(invoice_id,cycle_id,from_plan,target_plan,full_amount_cents,credit_cents,charge_cents,trial_end)
  values(i.id,(q->>'cycle_id')::uuid,q->>'current_plan',p_plan_id,(q->>'full_amount_cents')::bigint,(q->>'credit_cents')::bigint,i.amount_cents,(q->>'original_trial_end')::timestamptz);
  return jsonb_build_object('reused',false,'invoice',to_jsonb(i),'operation','trial_prepaid_upgrade','quote',q);
 end if;
 if exists(select 1 from public.restaurants r where r.id=p_restaurant_id and r.subscription_plan<>p_plan_id and (not r.subscription_is_trial or exists(select 1 from public.subscription_invoices paid where paid.restaurant_id=r.id and paid.status='paid'))) then
  raise exception 'Transição indisponível: sem ciclo futuro de trial comprovado. Upgrade de período pago e downgrade não estão integrados; nenhuma cobrança foi emitida.' using errcode='22023';
 end if;
 return subscription_quote_private.reserve_before_trial_upgrades(p_restaurant_id,p_plan_id,p_billing_cycle,p_payment_method,p_amount_cents,p_pix_expires_at,p_card_brand,p_card_last4,p_created_by);
end $$;

create function public.confirm_subscription_invoice_payment(p_invoice_id uuid,p_external_reference text,p_paid_amount_cents integer,p_restaurant_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare u subscription_quote_private.trial_upgrades;i public.subscription_invoices;c subscription_quote_private.cycles;r subscription_quote_private.trial_upgrade_receipts;credit bigint;why text;begin
 perform public.assert_trusted_billing_server();
 -- Common lock order: restaurant, then invoice (also used by reservation/emission).
 perform 1 from public.restaurants where id=p_restaurant_id for update;
 select * into u from subscription_quote_private.trial_upgrades where invoice_id=p_invoice_id;
 if not found then return subscription_quote_private.confirm_before_trial_upgrades(p_invoice_id,p_external_reference,p_paid_amount_cents,p_restaurant_id);end if;
 select * into i from public.subscription_invoices where id=p_invoice_id for update;
 if i.restaurant_id is distinct from p_restaurant_id then raise exception 'Fatura de outro restaurante.' using errcode='42501';end if;
 if nullif(btrim(p_external_reference),'') is null or btrim(i.external_reference) is distinct from btrim(p_external_reference) or p_paid_amount_cents is distinct from i.amount_cents or i.amount_cents<>u.charge_cents then raise exception 'Valor ou referência de pagamento divergente.' using errcode='22023';end if;
 select * into r from subscription_quote_private.trial_upgrade_receipts where invoice_id=i.id;
 if found then return jsonb_build_object('success',r.disposition='applied','status','paid','already_paid',true,'requires_review',r.disposition='review_required','reason',r.reason,'invoice_id',i.id);end if;
 if i.status not in ('pending','expired','failed') then raise exception 'Estado de fatura inválido para confirmação.' using errcode='22023';end if;
 select * into c from subscription_quote_private.cycles where id=u.cycle_id;
 credit:=subscription_quote_private.confirmed_cycle_credit(c.id);
 if clock_timestamp()>=u.trial_end then why:='Trial encerrado; pagamento recebido requer reconciliação, sem aplicar upgrade de período pago.';
 elsif subscription_quote_private.cycle_final_plan(c.id)<>u.from_plan or credit is distinct from u.credit_cents
 or exists(select 1 from public.restaurants where id=p_restaurant_id and (not active or subscription_plan<>u.from_plan or subscription_expires_at<>c.ends_at)) then why:='Estado do ciclo mudou após a reserva; pagamento recebido requer reconciliação.';
 elsif c.restaurant_id<>p_restaurant_id or c.billing_cycle<>i.billing_cycle or i.plan_id<>u.target_plan or c.starts_at<>u.trial_end then why:='Evidência divergente; pagamento recebido requer reconciliação.';
 end if;
 update public.subscription_invoices set status='paid',paid_at=clock_timestamp(),gateway_emission_status='issued' where id=i.id;
 insert into subscription_quote_private.trial_upgrade_receipts(invoice_id,disposition,reason) values(i.id,case when why is null then 'applied' else 'review_required' end,why);
 if why is null then
  insert into subscription_quote_private.cycle_payments(invoice_id,cycle_id,confirmed_credit_cents)values(i.id,c.id,i.amount_cents);
  update public.restaurants set subscription_plan=u.target_plan,max_tables=case u.target_plan when 'pro' then 20 else null end,unlimited_tables=u.target_plan='premium',monthly_price_cents=(u.full_amount_cents/case c.billing_cycle when 'yearly' then 11 else 1 end)::integer where id=p_restaurant_id;
  perform public.sync_restaurant_tables_to_plan_limit(p_restaurant_id);
 end if;
 insert into public.platform_audit_logs(action,target_restaurant_id,target_restaurant_name,actor_email,details)select case when why is null then 'plan_changed' else 'payment_reconciliation_required' end,p_restaurant_id,name,'asaas_verified_server',jsonb_build_object('operation',u.operation,'invoice_id',i.id,'cycle_id',c.id,'amount_cents',i.amount_cents,'reason',why) from public.restaurants where id=p_restaurant_id;
 return jsonb_build_object('success',why is null,'status','paid','invoice_id',i.id,'already_paid',false,'requires_review',why is not null,'reason',why,'plan_id',u.target_plan,'subscription_expires_at',c.ends_at,'unlimited_tables',u.target_plan='premium','max_tables',case u.target_plan when 'pro' then 20 else null end);
end $$;

alter function public.claim_subscription_invoice_gateway_emission(uuid) set schema subscription_quote_private;
alter function subscription_quote_private.claim_subscription_invoice_gateway_emission(uuid) rename to claim_before_trial_upgrades;
create function public.claim_subscription_invoice_gateway_emission(p_invoice_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare i public.subscription_invoices;u subscription_quote_private.trial_upgrades;c subscription_quote_private.cycles;credit bigint;begin
 perform public.assert_trusted_billing_server();
 select * into i from public.subscription_invoices where id=p_invoice_id;
 perform 1 from public.restaurants where id=i.restaurant_id for update;
 select * into i from public.subscription_invoices where id=p_invoice_id for update;
 select * into u from subscription_quote_private.trial_upgrades where invoice_id=i.id;
 if found and i.external_reference is null and i.gateway_emission_status is null then
  select * into c from subscription_quote_private.cycles where id=u.cycle_id;
  credit:=subscription_quote_private.confirmed_cycle_credit(c.id);
  if clock_timestamp()>=u.trial_end or subscription_quote_private.cycle_final_plan(c.id)<>u.from_plan or credit is distinct from u.credit_cents
  or exists(select 1 from public.restaurants where id=i.restaurant_id and (not active or subscription_plan<>u.from_plan or subscription_expires_at<>c.ends_at)) then
   raise exception 'Trial ou estado mudou após a reserva. Não emitir nova cobrança; reconcilie a tentativa existente.' using errcode='22023';
  end if;
 end if;
 return subscription_quote_private.claim_before_trial_upgrades(p_invoice_id);
end $$;
revoke all on function public.claim_subscription_invoice_gateway_emission(uuid) from public,anon,authenticated;
grant execute on function public.claim_subscription_invoice_gateway_emission(uuid) to service_role;
revoke all on function public.acquire_or_create_pending_subscription_invoice(uuid,text,text,text,integer,timestamptz,text,text,uuid,text) from public,anon,authenticated;
revoke all on function public.confirm_subscription_invoice_payment(uuid,text,integer,uuid) from public,anon,authenticated;
grant execute on function public.acquire_or_create_pending_subscription_invoice(uuid,text,text,text,integer,timestamptz,text,text,uuid,text),public.confirm_subscription_invoice_payment(uuid,text,integer,uuid) to service_role;
revoke all on all tables in schema subscription_quote_private from public,anon,authenticated,service_role;
revoke all on all functions in schema subscription_quote_private from public,anon,authenticated,service_role;
commit;

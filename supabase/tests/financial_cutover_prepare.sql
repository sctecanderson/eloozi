do $$
begin
  if current_database() <> 'postgres'
     or inet_server_addr() is distinct from '127.0.0.1'::inet then
    raise exception 'Safety guard: test only accepts disposable PostgreSQL on 127.0.0.1.';
  end if;
end $$;

create schema cutover_test;
create function cutover_test.ok(p_ok boolean, p_label text) returns void
language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FAIL: %', p_label; end if;
  raise notice 'PASS: %', p_label;
end $$;

insert into public.restaurants (
  id, slug, name, active, subscription_plan, subscription_is_trial,
  subscription_started_at, subscription_expires_at, billing_cycle_days,
  max_tables, monthly_price_cents
) values
  ('c1000000-0000-4000-8000-000000000001','cutover-legacy','Legacy sintético',true,'basic',false,
   now()-interval '60 days',now()+interval '5 days',30,13,7777),
  ('c1000000-0000-4000-8000-000000000002','cutover-old-trial','Trial antigo sem evidência',true,'pro',true,
   now()-interval '4 days',now()+interval '3 days',30,20,17777),
  ('c1000000-0000-4000-8000-000000000003','cutover-proven-trial','Trial com evidência',true,'basic',true,
   now()-interval '48 hours',now()+interval '120 hours',30,5,9990),
  ('c1000000-0000-4000-8000-000000000004','cutover-inflight-trial','Trial com fatura em trânsito',true,'basic',true,
   now()-interval '48 hours',now()+interval '120 hours',30,5,9990),
  ('c1000000-0000-4000-8000-000000000005','cutover-late-payment-trial','Trial para pagamento atrasado',true,'basic',true,
   now()-interval '48 hours',now()+interval '120 hours',30,5,9990);

alter table public.restaurants disable trigger protect_contract_rights_model;
update public.restaurants set contract_rights_model='legacy'
where id in ('c1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000002');
alter table public.restaurants enable trigger protect_contract_rights_model;

insert into public.subscription_invoices (
  id,restaurant_id,plan_id,billing_cycle,payment_method,amount_cents,status,
  external_reference,paid_at,created_at
) values
  ('c2000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','basic','monthly','pix',7777,'paid','legacy-paid-cutover',now()-interval '20 days',now()-interval '21 days'),
  ('c2000000-0000-4000-8000-000000000002','c1000000-0000-4000-8000-000000000001','basic','monthly','pix',7777,'pending','legacy-issued-cutover',null,now()-interval '1 hour'),
  ('c2000000-0000-4000-8000-000000000003','c1000000-0000-4000-8000-000000000005','basic','monthly','pix',9990,'pending',null,null,now()-interval '2 hours'),
  ('c2000000-0000-4000-8000-000000000004','c1000000-0000-4000-8000-000000000003','basic','monthly','pix',9990,'paid','trial-cycle-paid',now()-interval '1 day',now()-interval '2 days'),
  ('c2000000-0000-4000-8000-000000000005','c1000000-0000-4000-8000-000000000004','basic','monthly','pix',9990,'pending',null,null,now()-interval '10 minutes');

update public.subscription_invoices
set gateway_emission_status='in_progress',
    gateway_emission_claim_id='c3000000-0000-4000-8000-000000000001',
    gateway_emission_started_at=now()-interval '2 minutes'
where id='c2000000-0000-4000-8000-000000000005';

insert into subscription_quote_private.trial_terms(restaurant_id,original_start,original_end,evidence_source)
values
 ('c1000000-0000-4000-8000-000000000003',now()-interval '48 hours',now()+interval '120 hours','onboarding_premium_168h'),
 ('c1000000-0000-4000-8000-000000000004',now()-interval '48 hours',now()+interval '120 hours','onboarding_premium_168h'),
 ('c1000000-0000-4000-8000-000000000005',now()-interval '48 hours',now()+interval '120 hours','onboarding_premium_168h');
insert into subscription_quote_private.cycles(id,restaurant_id,plan_id,billing_cycle,starts_at,ends_at,contracted_price_cents)
values ('c4000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000003','basic','monthly',now()-interval '1 day',now()+interval '29 days',9990);
insert into subscription_quote_private.cycle_payments(invoice_id,cycle_id,confirmed_credit_cents)
values ('c2000000-0000-4000-8000-000000000004','c4000000-0000-4000-8000-000000000001',9990);

create table cutover_test.restaurant_before as
select id,contract_rights_model,subscription_plan,subscription_is_trial,subscription_started_at,subscription_expires_at,
       billing_cycle_days,max_tables,monthly_price_cents
from public.restaurants where id::text like 'c1000000-0000-4000-8000-00000000000_';
create table cutover_test.invoice_before as
select id,restaurant_id,plan_id,billing_cycle,payment_method,amount_cents,status,
       external_reference,paid_at,created_at,pix_qr_code_payload,pix_expires_at,
       gateway_emission_status,gateway_emission_claim_id,gateway_emission_started_at
from public.subscription_invoices where id::text like 'c2000000-0000-4000-8000-00000000000_';
create table cutover_test.trial_before as
select * from subscription_quote_private.trial_terms
where restaurant_id in ('c1000000-0000-4000-8000-000000000003','c1000000-0000-4000-8000-000000000004','c1000000-0000-4000-8000-000000000005');
create table cutover_test.cycles_before as
select * from subscription_quote_private.cycles
where restaurant_id='c1000000-0000-4000-8000-000000000003';
create table cutover_test.cycle_payments_before as
select cp.* from subscription_quote_private.cycle_payments cp
join subscription_quote_private.cycles c on c.id=cp.cycle_id
where c.restaurant_id='c1000000-0000-4000-8000-000000000003';

select cutover_test.ok((select count(*)=5 from cutover_test.restaurant_before),'synthetic legacy/trial restaurants prepared');
select cutover_test.ok((select count(*)=5 from cutover_test.invoice_before),'paid, issued-pending, unlinked-pending and in-flight invoices prepared');
select cutover_test.ok((select count(*)=3 from cutover_test.trial_before),'proved trial fixtures prepared');
select cutover_test.ok((select count(*)=1 from cutover_test.cycles_before),'prepaid cycle fixture prepared');
select cutover_test.ok((select count(*)=1 from cutover_test.cycle_payments_before),'confirmed payment allocation fixture prepared');
select 'FIXTURE_PREPARED: synthetic only; no gateway calls.';


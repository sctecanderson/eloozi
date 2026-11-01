select cutover_test.ok(
  (select count(*)=5 from cutover_test.restaurant_before b join public.restaurants r using(id)
   where row(b.contract_rights_model,b.subscription_plan,b.subscription_is_trial,
             b.subscription_started_at,b.subscription_expires_at,b.billing_cycle_days,
             b.max_tables,b.monthly_price_cents)
         is not distinct from
         row(r.contract_rights_model,r.subscription_plan,r.subscription_is_trial,
             r.subscription_started_at,r.subscription_expires_at,r.billing_cycle_days,
             r.max_tables,r.monthly_price_cents)),
  'legacy plan, trial flag, price, table limit and subscription dates are preserved'
);

select cutover_test.ok(
  (select count(*)=3 from cutover_test.invoice_before b join public.subscription_invoices i using(id)
   where row(b.restaurant_id,b.plan_id,b.billing_cycle,b.payment_method,b.amount_cents,b.status,
             b.external_reference,b.paid_at,b.created_at,b.pix_qr_code_payload,b.pix_expires_at)
         is not distinct from
         row(i.restaurant_id,i.plan_id,i.billing_cycle,i.payment_method,i.amount_cents,i.status,
             i.external_reference,i.paid_at,i.created_at,i.pix_qr_code_payload,i.pix_expires_at)
     and (b.status='paid' or b.external_reference is not null)),
  'paid and externally linked invoices keep all payment and contract fields'
);

select cutover_test.ok(
  (select count(*)=2 from cutover_test.invoice_before b join public.subscription_invoices i using(id)
   where b.id in ('c2000000-0000-4000-8000-000000000003','c2000000-0000-4000-8000-000000000005')
     and i.status=b.status and i.amount_cents=b.amount_cents
     and i.external_reference is not distinct from b.external_reference
     and i.paid_at is not distinct from b.paid_at
     and i.created_at=b.created_at
     and i.gateway_emission_status='needs_reconciliation'
     and i.gateway_emission_started_at is not distinct from b.gateway_emission_started_at
     and i.gateway_emission_claim_id is not distinct from b.gateway_emission_claim_id),
  'unlinked pending invoices are quarantined without changing payment, dates or in-flight claim evidence'
);

select cutover_test.ok(
  not exists(select * from cutover_test.trial_before except
             select * from subscription_quote_private.trial_terms
             where restaurant_id in ('c1000000-0000-4000-8000-000000000003','c1000000-0000-4000-8000-000000000004','c1000000-0000-4000-8000-000000000005')),
  'trial evidence and original end dates are unchanged by quarantine'
);
select cutover_test.ok(
  not exists(select * from cutover_test.cycles_before except
             select * from subscription_quote_private.cycles
             where restaurant_id='c1000000-0000-4000-8000-000000000003'),
  'existing paid cycle is unchanged by quarantine'
);
select cutover_test.ok(
  not exists(select * from cutover_test.cycle_payments_before except
             select cp.* from subscription_quote_private.cycle_payments cp
             join subscription_quote_private.cycles c on c.id=cp.cycle_id
             where c.restaurant_id='c1000000-0000-4000-8000-000000000003'),
  'confirmed payment allocation is unchanged by quarantine'
);

select cutover_test.ok(
  (subscription_quote_private.effective_subscription('c1000000-0000-4000-8000-000000000003')->>'trial_active')::boolean
  and subscription_quote_private.effective_subscription('c1000000-0000-4000-8000-000000000003')->>'plan'='premium',
  'proved active trial retains Premium effective access'
);
select cutover_test.ok(
  (subscription_quote_private.effective_subscription('c1000000-0000-4000-8000-000000000002')->>'known_trial')::boolean is false
  and subscription_quote_private.effective_plan('c1000000-0000-4000-8000-000000000002')='pro',
  'legacy trial without evidence is not reconstructed or upgraded'
);

do $$
declare state text;
begin
  begin
    perform public.create_subscription_checkout('c1000000-0000-4000-8000-000000000001','pro','monthly','pix',null);
    raise exception 'FAIL: direct legacy checkout RPC unexpectedly returned.';
  exception when insufficient_privilege then
    get stacked diagnostics state = returned_sqlstate;
    if state <> '42501' then raise; end if;
  end;
end $$;
select cutover_test.ok(
  not exists(select 1 from public.subscription_invoices where restaurant_id='c1000000-0000-4000-8000-000000000001' and created_at > now()-interval '1 minute' and id not in (select id from cutover_test.invoice_before)),
  'legacy checkout entry point remains blocked; no invoice was created'
);

select set_config('request.jwt.claim.role','service_role',false);
select set_config('request.jwt.claims','{"role":"service_role"}',false);
select cutover_test.ok(
  (public.claim_subscription_invoice_gateway_emission('c2000000-0000-4000-8000-000000000003')->>'claimed')::boolean is false
  and public.claim_subscription_invoice_gateway_emission('c2000000-0000-4000-8000-000000000003')->>'reason'='needs_reconciliation',
  'quarantined invoice cannot issue a duplicate payment'
);
select cutover_test.ok(
  (public.claim_subscription_invoice_gateway_emission('c2000000-0000-4000-8000-000000000002')->>'claimed')::boolean is false
  and public.claim_subscription_invoice_gateway_emission('c2000000-0000-4000-8000-000000000002')->>'reason'='already_issued',
  'invoice with an external reference is not re-emitted'
);

-- A verified late event can still attach and confirm a quarantined payment.
select public.attach_subscription_invoice_external_reference(
  'c2000000-0000-4000-8000-000000000003','late-confirmed-local-only',null
);
select public.confirm_subscription_invoice_payment(
  'c2000000-0000-4000-8000-000000000003','late-confirmed-local-only',9990,
  'c1000000-0000-4000-8000-000000000005'
);
select cutover_test.ok(
  (select status='paid' from public.subscription_invoices where id='c2000000-0000-4000-8000-000000000003'),
  'verified late payment remains confirmable after quarantine'
);
select cutover_test.ok(
  (select count(*)=1 from subscription_quote_private.cycles where restaurant_id='c1000000-0000-4000-8000-000000000005')
  and (select count(*)=1 from subscription_quote_private.cycle_payments where invoice_id='c2000000-0000-4000-8000-000000000003'),
  'late payment creates one cycle and one payment allocation'
);
select cutover_test.ok(
  (subscription_quote_private.effective_subscription('c1000000-0000-4000-8000-000000000005')->>'trial_active')::boolean
  and subscription_quote_private.effective_subscription('c1000000-0000-4000-8000-000000000005')->>'plan'='premium',
  'late paid Basic plan does not shorten the original active Premium trial'
);
select public.confirm_subscription_invoice_payment(
  'c2000000-0000-4000-8000-000000000003','late-confirmed-local-only',9990,
  'c1000000-0000-4000-8000-000000000005'
);
select cutover_test.ok(
  (select count(*)=1 from subscription_quote_private.cycles where restaurant_id='c1000000-0000-4000-8000-000000000005')
  and (select count(*)=1 from subscription_quote_private.cycle_payments where invoice_id='c2000000-0000-4000-8000-000000000003')
  and (select count(*)=1 from public.platform_audit_logs where details->>'invoice_id'='c2000000-0000-4000-8000-000000000003'),
  'replayed confirmation is idempotent and does not add cycles or allocations'
);
select 'RESULTADO_FINAL: PASS - migration de quarentena, preservação e reconciliação local sintética.';


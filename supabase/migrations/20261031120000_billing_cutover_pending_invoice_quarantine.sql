-- Cutover safety for subscription billing.
-- Apply only after 20261026233815 has introduced the gateway emission columns.
-- Pending invoices without an external gateway reference are ambiguous: the old
-- edge function may have completed a gateway POST but failed before persisting
-- its response. Keep the invoice and contract untouched and prevent a new POST
-- until explicit reconciliation attaches a verified payment or resolves it.
begin;

update public.subscription_invoices
set gateway_emission_status = 'needs_reconciliation'
where status = 'pending'
  and nullif(btrim(external_reference), '') is null
  and (gateway_emission_status is null or gateway_emission_status = 'in_progress');

commit;

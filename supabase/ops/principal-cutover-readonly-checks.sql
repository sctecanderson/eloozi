-- Inspection only. Run with a protected connection to the explicitly verified principal.
-- Keep output private. This file neither calls the gateway nor mutates data.
begin isolation level repeatable read read only;
set local statement_timeout = '10s';
set local timezone = 'UTC';
set local search_path = '';

select current_database() as database_name, current_setting('server_version') as server_version,
       transaction_timestamp() as snapshot_utc;
select count(*) as history_rows, max(version) as latest_version,
       md5(string_agg(to_jsonb(m)::text,chr(10) order by version)) as history_fingerprint
from supabase_migrations.schema_migrations m;

select count(*) as restaurants,
       md5(string_agg(jsonb_build_object('id',r.id,'plan',r.subscription_plan,
         'price',r.monthly_price_cents,'max_tables',r.max_tables,
         'started',r.subscription_started_at,'expires',r.subscription_expires_at,
         'days',r.billing_cycle_days,'active',r.active)::text,chr(10) order by r.id))
         as existing_contract_fields_fingerprint
from public.restaurants r;
select coalesce(to_jsonb(r)->>'contract_rights_model','<column absent>') as rights_model,
       coalesce(to_jsonb(r)->>'subscription_is_trial','<column absent>') as trial_flag,
       count(*) from public.restaurants r group by 1,2 order by 1,2;

select status, billing_cycle, payment_method,
       (nullif(btrim(external_reference),'') is not null) as has_external_reference,
       to_jsonb(i)->>'gateway_emission_status' as emission_state,
       count(*) as invoices, sum(amount_cents) as amount_cents
from public.subscription_invoices i group by 1,2,3,4,5 order by 1,2,3,4,5;

select n.nspname,c.relname,c.relrowsecurity,c.relforcerowsecurity
from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in
 ('reservations','restaurants','subscription_invoices','restaurant_tables','table_visits','table_tabs','table_tab_items');
select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check
from pg_catalog.pg_policies where schemaname='public' and tablename='reservations'
order by policyname;
select count(*) as unsafe_reservation_policies from pg_catalog.pg_policies
where schemaname='public' and tablename='reservations' and (qual='true' or with_check='true');

select n.nspname,p.proname,pg_catalog.pg_get_function_identity_arguments(p.oid) as arguments,
       p.prosecdef,p.provolatile,p.proconfig,p.proacl,
       md5(replace(p.prosrc,chr(13),'')) as normalized_body_fingerprint
from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in
 ('create_subscription_checkout','acquire_or_create_pending_subscription_invoice',
  'claim_subscription_invoice_gateway_emission','attach_subscription_invoice_gateway_reference',
  'confirm_subscription_invoice_payment','get_effective_subscription',
  'get_restaurant_module_access','preview_table_tabs_payment','close_table_tabs',
  'get_visit_tab_consumptions','seat_table_reservation') order by p.proname,arguments;

select n.nspname,c.relname,count(*) as columns
from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
join pg_catalog.pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
where n.nspname='subscription_quote_private' and c.relkind in ('r','p') group by 1,2 order by 1,2;
commit;

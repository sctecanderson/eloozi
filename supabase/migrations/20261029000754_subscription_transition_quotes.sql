begin;
-- Evidence only. No backfill, triggers or integration with checkout/confirmation.
create schema subscription_quote_private;
revoke all on schema subscription_quote_private from public, anon, authenticated, service_role;
create table subscription_quote_private.trial_terms (
 restaurant_id uuid primary key references public.restaurants(id),
 original_start timestamptz not null,
 original_end timestamptz not null,
 check (original_end > original_start)
);
create table subscription_quote_private.cycles (
 id uuid primary key default gen_random_uuid(),
 restaurant_id uuid not null references public.restaurants(id),
 plan_id text not null check(plan_id in ('basic','pro','premium')),
 billing_cycle text not null check(billing_cycle in ('monthly','yearly')),
 starts_at timestamptz not null,
 ends_at timestamptz not null,
 contracted_price_cents bigint not null check(contracted_price_cents>0),
 check(ends_at-starts_at = case billing_cycle when 'monthly' then interval '720 hours' else interval '8760 hours' end)
);
create table subscription_quote_private.cycle_payments (
 invoice_id uuid primary key references public.subscription_invoices(id),
 cycle_id uuid not null references subscription_quote_private.cycles(id),
 confirmed_credit_cents bigint not null check(confirmed_credit_cents>0)
);
create index on subscription_quote_private.cycles(restaurant_id,ends_at);
create index on subscription_quote_private.cycle_payments(cycle_id);
alter table subscription_quote_private.trial_terms enable row level security;
alter table subscription_quote_private.cycles enable row level security;
alter table subscription_quote_private.cycle_payments enable row level security;
revoke all on all tables in schema subscription_quote_private from public, anon, authenticated, service_role;

create function public.quote_subscription_transition(
 p_restaurant_id uuid, p_target_plan text, p_billing_cycle text
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
 r public.restaurants%rowtype;
 s public.platform_settings%rowtype;
 c subscription_quote_private.cycles%rowtype;
 t subscription_quote_private.trial_terms%rowtype;
 result jsonb; reason text; operation text;
 full_price bigint; credit bigint:=0; charge bigint; prorated bigint;
 effective timestamptz; expiry timestamptz;
 cycle_count integer; paid bigint; valid_payments boolean;
 ratio numeric; duration interval; n timestamptz:=now();
 current_rank integer; target_rank integer;
begin
 if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) then
  raise exception 'Conta administrativa necessaria.' using errcode='42501';
 end if;
 -- Authorize BEFORE exposing restaurant state or existence.
 if not public.is_platform_admin() and not exists(select 1 from public.restaurant_members m
  where m.restaurant_id=p_restaurant_id and m.user_id=auth.uid() and m.active and m.role='admin') then
  raise exception 'Acesso administrativo negado.' using errcode='42501';
 end if;
 if p_target_plan is null or p_target_plan not in ('basic','pro','premium')
 or p_billing_cycle is null or p_billing_cycle not in ('monthly','yearly') then
  raise exception 'Plano ou ciclo invalido.' using errcode='22023';
 end if;
 select * into r from public.restaurants where id=p_restaurant_id;
 if not found then raise exception 'Restaurante inexistente.' using errcode='22023'; end if;
 select * into s from public.platform_settings where id='default';
 full_price := case p_target_plan when 'basic' then s.basic_price_cents when 'pro' then s.pro_price_cents else s.premium_price_cents end::bigint;
 if p_billing_cycle='yearly' then full_price:=full_price*11; end if;
 duration:=case p_billing_cycle when 'monthly' then interval '720 hours' else interval '8760 hours' end;
 result:=jsonb_build_object('available',false,'message','transição indisponível',
  'operation',null,'current_plan',r.subscription_plan,'target_plan',p_target_plan,
  'billing_cycle',p_billing_cycle,'full_amount_cents',full_price,'credit_cents',null,
  'amount_to_charge_cents',null,'effective_at',null,'expires_at',null,
  'quoted_at',n,'payment_authorized',false,'requires_revalidation',true,
  'evidence',jsonb_build_object('catalog_source','platform_settings/default'));
 <<calculate>> begin
  if full_price is null or full_price<=0 then reason:='invalid_catalog'; exit calculate; end if;
  select * into t from subscription_quote_private.trial_terms where restaurant_id=r.id;
  select count(*) into cycle_count from subscription_quote_private.cycles where restaurant_id=r.id and ends_at>n;
  if cycle_count>1 then reason:='multiple_unelapsed_cycles_unsupported'; exit calculate; end if;
  if exists(select 1 from public.subscription_invoices i where i.restaurant_id=r.id and i.status='paid'
   and not exists(select 1 from subscription_quote_private.cycle_payments p where p.invoice_id=i.id)) then
   reason:='unallocated_confirmed_payments'; exit calculate;
  end if;
  if cycle_count=0 then
   if r.subscription_is_trial and t.original_start<=n and t.original_end>n and r.subscription_expires_at=t.original_end then
    operation:='trial_purchase'; charge:=full_price; effective:=t.original_end; expiry:=effective+duration;
   else
    reason:='missing_reliable_cycle_history'; exit calculate;
   end if;
  else
   select * into c from subscription_quote_private.cycles where restaurant_id=r.id and ends_at>n;
   result:=result||jsonb_build_object('evidence',jsonb_build_object('cycle_id',c.id,'starts_at',c.starts_at,'ends_at',c.ends_at,
    'contracted_price_cents',c.contracted_price_cents,'current_billing_cycle',c.billing_cycle,
    'validation','unverified','catalog_source','platform_settings/default'));
   -- Every cent must be confirmed, allocated to exactly THIS cycle and backed by a paid invoice.
   select coalesce(sum(p.confirmed_credit_cents),0),coalesce(bool_and(i.status='paid' and i.paid_at is not null
    and nullif(btrim(i.external_reference),'') is not null and i.restaurant_id=r.id
    and i.billing_cycle=c.billing_cycle and p.confirmed_credit_cents<=i.amount_cents),false)
    into paid,valid_payments from subscription_quote_private.cycle_payments p
    join public.subscription_invoices i on i.id=p.invoice_id where p.cycle_id=c.id;
   if not valid_payments or paid<>c.contracted_price_cents then reason:='unconfirmed_or_inconsistent_cycle_payments'; exit calculate; end if;
   if r.subscription_expires_at is distinct from c.ends_at or r.subscription_plan is distinct from c.plan_id then
    reason:='contract_state_mismatch_or_accumulated_periods'; exit calculate;
   end if;
   result:=jsonb_set(result,'{evidence,validation}','"confirmed_payments_and_contract_state"'::jsonb);
   if c.billing_cycle<>p_billing_cycle then reason:='billing_cycle_change_unsupported'; exit calculate; end if;
   current_rank:=case c.plan_id when 'basic' then 1 when 'pro' then 2 else 3 end;
   target_rank:=case p_target_plan when 'basic' then 1 when 'pro' then 2 else 3 end;
   if c.starts_at>n then
    if t.original_start is null or t.original_start>n or t.original_end<=n or c.starts_at<>t.original_end then
     reason:='future_cycle_outside_proven_trial_unsupported'; exit calculate;
    end if;
    if target_rank<=current_rank then reason:='future_trial_cycle_only_upgrade_supported'; exit calculate; end if;
    if full_price<c.contracted_price_cents then reason:='target_below_contracted_price'; exit calculate; end if;
    operation:='trial_paid_upgrade'; credit:=paid; charge:=full_price-credit;
    effective:=c.starts_at; expiry:=c.ends_at;
   elsif r.subscription_is_trial then
    reason:='trial_and_active_paid_cycle_conflict'; exit calculate;
   elsif target_rank=current_rank then
    operation:='renewal'; charge:=full_price; effective:=c.ends_at; expiry:=effective+duration;
   elsif target_rank<current_rank then
    operation:='scheduled_downgrade'; charge:=0; effective:=c.ends_at; expiry:=effective+duration;
   else
    if full_price<c.contracted_price_cents then reason:='target_below_contracted_price'; exit calculate; end if;
    ratio:=extract(epoch from(c.ends_at-n))/extract(epoch from(c.ends_at-c.starts_at));
    -- Integer cents: debit rounds UP, earned credit DOWN, using exact numeric seconds.
    prorated:=ceil(full_price::numeric*ratio); credit:=floor(paid::numeric*ratio);
    charge:=greatest(prorated-credit,0); operation:='paid_upgrade'; effective:=n; expiry:=c.ends_at;
   end if;
  end if;
 end calculate;
 if reason is not null then return result||jsonb_build_object('reason',reason); end if;
 return result||jsonb_build_object('available',true,'message','cotação calculada','reason',null,
  'operation',operation,'credit_cents',credit,'amount_to_charge_cents',charge,
  'prorated_target_amount_cents',prorated,'effective_at',effective,'expires_at',expiry,
  'next_cycle_amount_cents',case when operation='scheduled_downgrade' then full_price else null end);
end $$;
revoke all on function public.quote_subscription_transition(uuid,text,text) from public, anon, authenticated, service_role;
grant execute on function public.quote_subscription_transition(uuid,text,text) to authenticated;
comment on function public.quote_subscription_transition(uuid,text,text) is
 'Read-only quote, not payment authorization. No legacy cycle inference. Revalidate before issuing/confirming payment.';
commit;

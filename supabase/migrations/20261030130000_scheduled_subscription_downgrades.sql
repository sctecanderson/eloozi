begin;
-- No backfill. Dates, paid cycles and old contracts remain untouched.
create table subscription_quote_private.plan_changes (
 id uuid primary key default gen_random_uuid(),
 restaurant_id uuid not null references public.restaurants(id),
 anchor_cycle_id uuid not null references subscription_quote_private.cycles(id),
 from_plan text not null check(from_plan in ('pro','premium')),
 target_plan text not null check(target_plan in ('basic','pro')),
 billing_cycle text not null check(billing_cycle in ('monthly','yearly')),
 not_before timestamptz not null,
 state text not null default 'scheduled' check(state in ('scheduled','reserved','completed','cancelled','superseded','review_required')),
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default clock_timestamp(),
 check(array_position(array['basic','pro','premium'],target_plan)<array_position(array['basic','pro','premium'],from_plan))
);
create unique index one_open_plan_change on subscription_quote_private.plan_changes(restaurant_id) where state in ('scheduled','reserved','review_required');
create table subscription_quote_private.plan_change_invoices (
 invoice_id uuid primary key references public.subscription_invoices(id),
 change_id uuid unique not null references subscription_quote_private.plan_changes(id)
);
create table subscription_quote_private.plan_change_receipts (
 invoice_id uuid primary key references subscription_quote_private.plan_change_invoices(invoice_id),
 disposition text not null check(disposition in ('applied','review_required')),
 reason text,
 received_at timestamptz not null default clock_timestamp()
);
alter table subscription_quote_private.plan_changes enable row level security;
alter table subscription_quote_private.plan_change_invoices enable row level security;
alter table subscription_quote_private.plan_change_receipts enable row level security;
create trigger immutable_plan_change_invoices before update or delete on subscription_quote_private.plan_change_invoices for each row execute function subscription_quote_private.immutable_evidence();
create trigger immutable_plan_change_receipts before update or delete on subscription_quote_private.plan_change_receipts for each row execute function subscription_quote_private.immutable_evidence();

create function subscription_quote_private.assert_plan_change_admin(p_id uuid) returns void language plpgsql stable security definer set search_path='' as $$begin
 if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) or not(public.is_platform_admin() or exists(select 1 from public.restaurant_members where restaurant_id=p_id and user_id=auth.uid() and active and role='admin')) then raise exception 'Acesso administrativo negado.' using errcode='42501';end if;
end $$;

-- Use the LAST fully evidenced paid cycle, including all prepaid cycles, never expiry alone.
create function subscription_quote_private.downgrade_context(p_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare c subscription_quote_private.cycles;r public.restaurants;reason text;begin
 select * into r from public.restaurants where id=p_id;
 select * into c from subscription_quote_private.cycles where restaurant_id=p_id order by ends_at desc,id limit 1;
 if r.id is null or not r.active then reason:='Restaurante indisponível.';
 elsif not exists(select 1 from subscription_quote_private.trial_terms where restaurant_id=p_id and evidence_source='onboarding_premium_168h') or c.evidence_source is distinct from 'trial_purchase_v1' then reason:='Histórico de ciclos insuficiente. Nenhum contrato antigo será reconstruído.';
 elsif exists(select 1 from subscription_quote_private.cycles x where x.restaurant_id=p_id and (x.evidence_source is distinct from 'trial_purchase_v1' or subscription_quote_private.confirmed_cycle_credit(x.id) is null)) then reason:='Há ciclo sem pagamento comprovado.';
 elsif exists(select 1 from public.subscription_invoices i where i.restaurant_id=p_id and i.status='paid' and not exists(select 1 from subscription_quote_private.cycle_payments cp where cp.invoice_id=i.id)) then reason:='Pagamento sem alocação confiável exige reconciliação.';
 elsif exists(select 1 from subscription_quote_private.trial_upgrades u join subscription_quote_private.cycles cy on cy.id=u.cycle_id where cy.restaurant_id=p_id and not exists(select 1 from subscription_quote_private.trial_upgrade_receipts receipt where receipt.invoice_id=u.invoice_id)) then reason:='Há upgrade pendente de confirmação ou reconciliação.';
 elsif r.subscription_expires_at is distinct from c.ends_at or r.subscription_plan is distinct from subscription_quote_private.cycle_final_plan(c.id) then reason:='Estado contratual divergente. Reconcilie antes de agendar.';
 end if;
 return jsonb_build_object('available',reason is null,'reason',reason,'anchor_cycle_id',c.id,'current_plan',coalesce(subscription_quote_private.cycle_final_plan(c.id),case when not r.subscription_is_trial then r.subscription_plan end),'billing_cycle',c.billing_cycle,'not_before',c.ends_at);
end $$;

create function public.get_scheduled_subscription_change(p_restaurant_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare q jsonb;s subscription_quote_private.plan_changes;begin
 perform subscription_quote_private.assert_plan_change_admin(p_restaurant_id);
 q:=subscription_quote_private.downgrade_context(p_restaurant_id);
 select * into s from subscription_quote_private.plan_changes where restaurant_id=p_restaurant_id and state in ('scheduled','reserved','review_required') order by created_at desc limit 1;
 return q||jsonb_build_object('scheduled_change',case when s.id is null then null else to_jsonb(s)-'created_by' end,'can_renew',coalesce((q->>'available')::boolean and (q->>'anchor_cycle_id')::uuid=s.anchor_cycle_id and s.state in ('scheduled','reserved') and statement_timestamp()>=s.not_before,false));
end $$;

create function public.schedule_subscription_downgrade(p_restaurant_id uuid,p_target_plan text) returns jsonb language plpgsql security definer set search_path='' as $$
declare q jsonb;s subscription_quote_private.plan_changes;begin
 perform subscription_quote_private.assert_plan_change_admin(p_restaurant_id);
 perform 1 from public.restaurants where id=p_restaurant_id for update;
 q:=subscription_quote_private.downgrade_context(p_restaurant_id);
 if not (q->>'available')::boolean then raise exception '%',q->>'reason' using errcode='22023';end if;
 if p_target_plan is null or p_target_plan not in ('basic','pro') or array_position(array['basic','pro','premium'],p_target_plan)>=array_position(array['basic','pro','premium'],q->>'current_plan') then raise exception 'Escolha um plano inferior ao contrato pago.' using errcode='22023';end if;
 select * into s from subscription_quote_private.plan_changes where restaurant_id=p_restaurant_id and state in ('scheduled','reserved','review_required');
 if s.state in ('reserved','review_required') then raise exception 'Há cobrança vinculada. Conclua ou reconcilie antes de substituir.' using errcode='22023';end if;
 if exists(select 1 from public.subscription_invoices where restaurant_id=p_restaurant_id and (status='pending' or status in ('failed','expired') and (external_reference is not null or gateway_emission_status is not null))) then raise exception 'Conclua ou reconcilie a cobrança pendente antes de agendar.' using errcode='22023';end if;
 if s.target_plan=p_target_plan and s.anchor_cycle_id=(q->>'anchor_cycle_id')::uuid then return public.get_scheduled_subscription_change(p_restaurant_id);end if;
 update subscription_quote_private.plan_changes set state='superseded' where id=s.id;
 insert into subscription_quote_private.plan_changes(restaurant_id,anchor_cycle_id,from_plan,target_plan,billing_cycle,not_before,created_by)
 values(p_restaurant_id,(q->>'anchor_cycle_id')::uuid,q->>'current_plan',p_target_plan,q->>'billing_cycle',(q->>'not_before')::timestamptz,auth.uid());
 return public.get_scheduled_subscription_change(p_restaurant_id);
end $$;
create function public.cancel_subscription_downgrade(p_restaurant_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$begin
 perform subscription_quote_private.assert_plan_change_admin(p_restaurant_id);
 perform 1 from public.restaurants where id=p_restaurant_id for update;
 if exists(select 1 from subscription_quote_private.plan_changes where restaurant_id=p_restaurant_id and state in ('reserved','review_required')) then raise exception 'Há cobrança vinculada. Conclua ou reconcilie antes de cancelar.' using errcode='22023';end if;
 update subscription_quote_private.plan_changes set state='cancelled' where restaurant_id=p_restaurant_id and state='scheduled';
 return public.get_scheduled_subscription_change(p_restaurant_id);
end $$;

create function subscription_quote_private.valid_downgrade_invoice(p_invoice uuid) returns boolean language sql stable security definer set search_path='' as $$
 select coalesce((select s.state='reserved' and statement_timestamp()>=s.not_before and (q->>'available')::boolean
 and (q->>'anchor_cycle_id')::uuid=s.anchor_cycle_id and q->>'current_plan'=s.from_plan
 and i.plan_id=s.target_plan and i.billing_cycle=s.billing_cycle
 from subscription_quote_private.plan_change_invoices link join subscription_quote_private.plan_changes s on s.id=link.change_id
 join public.subscription_invoices i on i.id=link.invoice_id cross join lateral subscription_quote_private.downgrade_context(s.restaurant_id) q
 where link.invoice_id=p_invoice and i.restaurant_id=s.restaurant_id),false)
$$;

-- Reuse the existing transactional confirmation: only its guarded transition check changes.
-- Fail closed if an unexpected deployed definition differs from the prerequisite migration.
do $$declare d text;old text;begin
 d:=pg_get_functiondef('subscription_quote_private.confirm_before_trial_upgrades(uuid,text,integer,uuid)'::regprocedure);
 old:='if found and (v_now<v_trial.original_end or v_invoice.plan_id<>subscription_quote_private.cycle_final_plan(v_last_cycle.id) or v_invoice.billing_cycle<>v_last_cycle.billing_cycle) then';
 if strpos(d,old)=0 then raise exception 'Unexpected confirmation prerequisite';end if;
 d:=replace(d,old,replace(old,' then',' and not subscription_quote_private.valid_downgrade_invoice(v_invoice.id) then'));execute d;
end $$;

-- After an applied downgrade, renewal compares the last paid cycle, never an older tier.
do $$declare d text;old text;begin
 d:=pg_get_functiondef('subscription_quote_private.reserve_before_trial_upgrades(uuid,text,text,text,integer,timestamptz,text,text,uuid)'::regprocedure);
 old:='c.evidence_source=''trial_purchase_v1'' and (now()<t.original_end or subscription_quote_private.cycle_final_plan(c.id)<>p_plan_id or c.billing_cycle<>p_billing_cycle)';
 if strpos(d,old)=0 then raise exception 'Unexpected reservation prerequisite';end if;
 d:=replace(d,old,old||' and (not exists(select 1 from subscription_quote_private.plan_changes pc where pc.restaurant_id=p_restaurant_id and pc.state=''completed'') or c.id=(select last.id from subscription_quote_private.cycles last where last.restaurant_id=p_restaurant_id order by last.ends_at desc,last.id limit 1))');execute d;
end $$;

alter function public.acquire_or_create_pending_subscription_invoice(uuid,text,text,text,integer,timestamptz,text,text,uuid,text) set schema subscription_quote_private;
alter function subscription_quote_private.acquire_or_create_pending_subscription_invoice(uuid,text,text,text,integer,timestamptz,text,text,uuid,text) rename to reserve_before_scheduled_downgrades;
create function public.acquire_or_create_pending_subscription_invoice(p_restaurant_id uuid,p_plan_id text,p_billing_cycle text,p_payment_method text,p_amount_cents integer,p_pix_expires_at timestamptz default null,p_card_brand text default null,p_card_last4 text default null,p_created_by uuid default null,p_quote_token text default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare s subscription_quote_private.plan_changes;i public.subscription_invoices;q jsonb;price integer;begin
 perform public.assert_trusted_billing_server();
 perform 1 from public.restaurants where id=p_restaurant_id for update;
 -- Reuse the existing opaque quote-token transport to bind retries to ONE schedule,
 -- including an HTTP retry after its payment has already been confirmed.
 if p_quote_token like 'scheduled-downgrade:%' then
  select * into s from subscription_quote_private.plan_changes where id::text=substring(p_quote_token from 21) and restaurant_id=p_restaurant_id;
  if not found or s.state in ('cancelled','superseded') then raise exception 'Agendamento mudou. Atualize antes de pagar.' using errcode='22023';end if;
  if s.target_plan is distinct from p_plan_id or s.billing_cycle is distinct from p_billing_cycle then raise exception 'Destino ou periodicidade divergente do agendamento.' using errcode='22023';end if;
  select inv.* into i from subscription_quote_private.plan_change_invoices link join public.subscription_invoices inv on inv.id=link.invoice_id where link.change_id=s.id;
  if found and s.state in ('completed','review_required') then
   if i.payment_method is distinct from p_payment_method then raise exception 'Método divergente da cobrança vinculada.' using errcode='22023';end if;
   return jsonb_build_object('reused',true,'invoice',to_jsonb(i),'operation','scheduled_downgrade');
  end if;
 end if;
 select * into s from subscription_quote_private.plan_changes where restaurant_id=p_restaurant_id and state in ('scheduled','reserved','review_required');
 if not found then return subscription_quote_private.reserve_before_scheduled_downgrades(p_restaurant_id,p_plan_id,p_billing_cycle,p_payment_method,p_amount_cents,p_pix_expires_at,p_card_brand,p_card_last4,p_created_by,p_quote_token);end if;
 if p_quote_token is distinct from 'scheduled-downgrade:'||s.id::text then raise exception 'Confirme o agendamento atualizado antes de pagar.' using errcode='22023';end if;
 if s.state='review_required' then raise exception 'Pagamento exige reconciliação antes de nova cobrança.' using errcode='22023';end if;
 if statement_timestamp()<s.not_before then raise exception 'Plano atual preservado. Renovação do plano agendado disponível a partir de %.',s.not_before using errcode='22023';end if;
 if p_plan_id is distinct from s.target_plan or p_billing_cycle is distinct from s.billing_cycle then raise exception 'Use o plano e a periodicidade agendados, ou cancele o agendamento antes de iniciar uma cobrança.' using errcode='22023';end if;
 if p_payment_method is null or p_payment_method not in ('pix','credit_card','debit_card') then raise exception 'Método inválido.' using errcode='22023';end if;
 q:=subscription_quote_private.downgrade_context(p_restaurant_id);
 if not (q->>'available')::boolean or (q->>'anchor_cycle_id')::uuid<>s.anchor_cycle_id then raise exception 'Estado mudou. Atualize ou reconcilie o agendamento.' using errcode='22023';end if;
 select inv.* into i from subscription_quote_private.plan_change_invoices link join public.subscription_invoices inv on inv.id=link.invoice_id where link.change_id=s.id;
 if found then
  if i.payment_method<>p_payment_method then raise exception 'Há cobrança vinculada com outro método.' using errcode='22023';end if;
  if i.status='failed' and i.external_reference is null and i.gateway_emission_status is null then update public.subscription_invoices set status='pending' where id=i.id returning * into i;end if;
  return jsonb_build_object('reused',true,'invoice',to_jsonb(i),'operation','scheduled_downgrade');
 end if;
 if exists(select 1 from public.subscription_invoices where restaurant_id=p_restaurant_id and (status='pending' or status in ('failed','expired') and (external_reference is not null or gateway_emission_status is not null))) then raise exception 'Há cobrança pendente a reconciliar.' using errcode='22023';end if;
 select (case s.target_plan when 'basic' then basic_price_cents else pro_price_cents end)*case s.billing_cycle when 'yearly' then 11 else 1 end into price from public.platform_settings where id='default';
 if price is null or price<=0 then raise exception 'Catálogo inválido.' using errcode='22023';end if;
 insert into public.subscription_invoices(restaurant_id,plan_id,billing_cycle,payment_method,amount_cents,pix_expires_at,card_brand,card_last4,created_by)
 values(p_restaurant_id,s.target_plan,s.billing_cycle,p_payment_method,price,p_pix_expires_at,p_card_brand,p_card_last4,p_created_by) returning * into i;
 insert into subscription_quote_private.plan_change_invoices values(i.id,s.id);
 update subscription_quote_private.plan_changes set state='reserved' where id=s.id;
 return jsonb_build_object('reused',false,'invoice',to_jsonb(i),'operation','scheduled_downgrade');
end $$;

alter function public.confirm_subscription_invoice_payment(uuid,text,integer,uuid) set schema subscription_quote_private;
alter function subscription_quote_private.confirm_subscription_invoice_payment(uuid,text,integer,uuid) rename to confirm_before_scheduled_downgrades;
create function public.confirm_subscription_invoice_payment(p_invoice_id uuid,p_external_reference text,p_paid_amount_cents integer,p_restaurant_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare i public.subscription_invoices;receipt subscription_quote_private.plan_change_receipts;s subscription_quote_private.plan_changes;result jsonb;why text;begin
 perform public.assert_trusted_billing_server();
 perform 1 from public.restaurants where id=p_restaurant_id for update;
 select change.* into s from subscription_quote_private.plan_change_invoices link join subscription_quote_private.plan_changes change on change.id=link.change_id where link.invoice_id=p_invoice_id;
 if not found then return subscription_quote_private.confirm_before_scheduled_downgrades(p_invoice_id,p_external_reference,p_paid_amount_cents,p_restaurant_id);end if;
 select * into i from public.subscription_invoices where id=p_invoice_id for update;
 if i.restaurant_id is distinct from p_restaurant_id then raise exception 'Fatura de outro restaurante.' using errcode='42501';end if;
 if nullif(btrim(p_external_reference),'') is null or btrim(i.external_reference) is distinct from btrim(p_external_reference) or p_paid_amount_cents is distinct from i.amount_cents then raise exception 'Valor ou referência divergente.' using errcode='22023';end if;
 select * into receipt from subscription_quote_private.plan_change_receipts where invoice_id=i.id;
 if found then return jsonb_build_object('success',receipt.disposition='applied','status','paid','already_paid',true,'requires_review',receipt.disposition='review_required','reason',receipt.reason,'invoice_id',i.id,'plan_id',i.plan_id);end if;
 if i.status not in ('pending','expired','failed') then raise exception 'Estado inválido da fatura.' using errcode='22023';end if;
 if not subscription_quote_private.valid_downgrade_invoice(i.id) then
  why:='Estado do ciclo mudou após emissão. Pagamento recebido exige reconciliação; nenhum plano ou dia aplicado.';
  update public.subscription_invoices set status='paid',paid_at=clock_timestamp(),gateway_emission_status='issued' where id=i.id;
  update subscription_quote_private.plan_changes set state='review_required' where id=s.id;
  result:=jsonb_build_object('success',false,'status','paid','already_paid',false,'requires_review',true,'reason',why,'invoice_id',i.id);
  insert into public.platform_audit_logs(action,target_restaurant_id,target_restaurant_name,actor_email,details)select 'payment_reconciliation_required',id,name,'asaas_verified_server',jsonb_build_object('invoice_id',i.id,'operation','scheduled_downgrade','reason',why) from public.restaurants where id=p_restaurant_id;
 else
  result:=subscription_quote_private.confirm_before_scheduled_downgrades(p_invoice_id,p_external_reference,p_paid_amount_cents,p_restaurant_id);
  update subscription_quote_private.plan_changes set state='completed' where id=s.id;
 end if;
 insert into subscription_quote_private.plan_change_receipts(invoice_id,disposition,reason)values(i.id,case when why is null then 'applied' else 'review_required' end,why);
 return result;
end $$;

alter function public.claim_subscription_invoice_gateway_emission(uuid) set schema subscription_quote_private;
alter function subscription_quote_private.claim_subscription_invoice_gateway_emission(uuid) rename to claim_before_scheduled_downgrades;
create function public.claim_subscription_invoice_gateway_emission(p_invoice_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$declare i public.subscription_invoices;begin
 perform public.assert_trusted_billing_server();
 select * into i from public.subscription_invoices where id=p_invoice_id;
 perform 1 from public.restaurants where id=i.restaurant_id for update;
 select * into i from public.subscription_invoices where id=p_invoice_id for update;
 if exists(select 1 from subscription_quote_private.plan_change_invoices where invoice_id=i.id) and i.external_reference is null and i.gateway_emission_status is null and not subscription_quote_private.valid_downgrade_invoice(i.id) then raise exception 'Agendamento mudou. Nenhuma nova cobrança será emitida.' using errcode='22023';end if;
 return subscription_quote_private.claim_before_scheduled_downgrades(p_invoice_id);
end $$;

revoke all on all tables in schema subscription_quote_private from public,anon,authenticated,service_role;
revoke all on all functions in schema subscription_quote_private from public,anon,authenticated,service_role;
revoke all on function public.get_scheduled_subscription_change(uuid),public.schedule_subscription_downgrade(uuid,text),public.cancel_subscription_downgrade(uuid) from public,anon;
grant execute on function public.get_scheduled_subscription_change(uuid),public.schedule_subscription_downgrade(uuid,text),public.cancel_subscription_downgrade(uuid) to authenticated;
revoke all on function public.acquire_or_create_pending_subscription_invoice(uuid,text,text,text,integer,timestamptz,text,text,uuid,text),public.confirm_subscription_invoice_payment(uuid,text,integer,uuid),public.claim_subscription_invoice_gateway_emission(uuid) from public,anon,authenticated;
grant execute on function public.acquire_or_create_pending_subscription_invoice(uuid,text,text,text,integer,timestamptz,text,text,uuid,text),public.confirm_subscription_invoice_payment(uuid,text,integer,uuid),public.claim_subscription_invoice_gateway_emission(uuid) to service_role;
commit;

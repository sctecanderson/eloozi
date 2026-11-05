-- Migration: 20261102210000_subscription_test_grants.sql
-- Subscriptions: Test Grants control for SuperAdmin verification

create schema if not exists billing_private;

create table if not exists billing_private.subscription_test_grants (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  target_plan text not null check (target_plan = 'basic'),
  billing_cycle text not null check (billing_cycle = 'monthly'),
  amount_cents integer not null check (amount_cents = 500),
  authorized_by uuid not null references auth.users(id) on delete restrict,
  authorized_at timestamptz not null default timezone('utc', now()),
  expires_at timestamptz not null,
  status text not null default 'authorized' check (status in ('authorized', 'reserved', 'consumed', 'revoked')),
  reserved_at timestamptz,
  reserved_invoice_id uuid references public.subscription_invoices(id) on delete set null,
  consumed_at timestamptz,
  notes text
);

create index if not exists idx_subscription_test_grants_restaurant on billing_private.subscription_test_grants(restaurant_id);
create index if not exists idx_subscription_test_grants_status on billing_private.subscription_test_grants(status);

-- RPC 1: authorize_subscription_test_grant (executado por SuperAdmin)
create or replace function public.authorize_subscription_test_grant(
  p_restaurant_id uuid,
  p_target_plan text default 'basic',
  p_billing_cycle text default 'monthly',
  p_amount_cents integer default 500,
  p_validity_minutes integer default 30,
  p_notes text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, billing_private
as $$
declare
  v_user_id uuid := auth.uid();
  v_grant billing_private.subscription_test_grants%rowtype;
  v_expires_at timestamptz;
begin
  -- Exige SuperAdmin validado exclusivamente em public.platform_admins
  if not exists (
    select 1 from public.platform_admins where user_id = v_user_id and active = true
  ) then
    raise exception 'Apenas SuperAdmin pode autorizar test grant.' using errcode = '42501';
  end if;

  -- Restrito especificamente ao ChurrasBrusque
  if p_restaurant_id <> 'efcb9f44-c33b-47ec-8125-b20e57b9fd1e'::uuid then
    raise exception 'Test grant restrito ao restaurante ChurrasBrusque.' using errcode = '22023';
  end if;

  -- Restrito ao plano Básico, ciclo mensal e 500 centavos
  if p_target_plan <> 'basic' or p_billing_cycle <> 'monthly' or p_amount_cents <> 500 then
    raise exception 'Test grant restrito a Básico mensal de 500 centavos.' using errcode = '22023';
  end if;

  -- Validade curta: entre 5 e 60 minutos (default 30)
  if p_validity_minutes is null or p_validity_minutes < 5 or p_validity_minutes > 60 then
    raise exception 'Validade deve estar entre 5 e 60 minutos.' using errcode = '22023';
  end if;

  v_expires_at := timezone('utc', now()) + (p_validity_minutes || ' minutes')::interval;

  -- Revoga grants anteriores ainda não consumidos do mesmo restaurante
  update billing_private.subscription_test_grants
  set status = 'revoked', notes = coalesce(notes, '') || ' [superseded]'
  where restaurant_id = p_restaurant_id and status in ('authorized', 'reserved') and reserved_invoice_id is null;

  insert into billing_private.subscription_test_grants (
    restaurant_id, target_plan, billing_cycle, amount_cents,
    authorized_by, authorized_at, expires_at, status, notes
  ) values (
    p_restaurant_id, p_target_plan, p_billing_cycle, p_amount_cents,
    v_user_id, timezone('utc', now()), v_expires_at, 'authorized', p_notes
  ) returning * into v_grant;

  return jsonb_build_object(
    'grant_id', v_grant.id,
    'restaurant_id', v_grant.restaurant_id,
    'target_plan', v_grant.target_plan,
    'billing_cycle', v_grant.billing_cycle,
    'amount_cents', v_grant.amount_cents,
    'expires_at', v_grant.expires_at,
    'status', v_grant.status
  );
end;
$$;

-- RPC 2: reserve_test_grant_invoice (chamado pelo asaas-checkout no servidor confiável)
create or replace function billing_private.reserve_test_grant_invoice(
  p_restaurant_id uuid,
  p_grant_id uuid,
  p_user_id uuid,
  p_pix_expires_at timestamptz default null
) returns jsonb
language plpgsql
security definer
set search_path = public, billing_private
as $$
declare
  v_grant billing_private.subscription_test_grants%rowtype;
  v_invoice public.subscription_invoices%rowtype;
  v_now timestamptz := timezone('utc', now());
begin
  perform public.assert_trusted_billing_server();

  if p_restaurant_id is null or p_grant_id is null then
    raise exception 'Parâmetros obrigatórios ausentes.' using errcode = '22023';
  end if;

  -- Lock no restaurante para serializar checkout
  perform 1 from public.restaurants where id = p_restaurant_id for update;

  -- Lock no grant
  select * into v_grant
  from billing_private.subscription_test_grants
  where id = p_grant_id
  for update;

  if not found then
    raise exception 'Test grant não encontrado.' using errcode = '22023';
  end if;

  if v_grant.restaurant_id <> p_restaurant_id then
    raise exception 'Test grant não pertence ao restaurante.' using errcode = '42501';
  end if;

  if v_grant.restaurant_id <> 'efcb9f44-c33b-47ec-8125-b20e57b9fd1e'::uuid then
    raise exception 'Test grant restrito ao ChurrasBrusque.' using errcode = '22023';
  end if;

  if v_grant.target_plan <> 'basic' or v_grant.billing_cycle <> 'monthly' or v_grant.amount_cents <> 500 then
    raise exception 'Test grant restrito a Básico mensal de 500 centavos.' using errcode = '22023';
  end if;

  if v_grant.status = 'consumed' then
    raise exception 'Test grant já foi consumido.' using errcode = '22023';
  end if;

  if v_grant.status = 'revoked' then
    raise exception 'Test grant revogado.' using errcode = '22023';
  end if;

  if v_now > v_grant.expires_at then
    raise exception 'Test grant expirado.' using errcode = '22023';
  end if;

  -- Se já reservado (repetição/concorrência), reutiliza a mesma fatura
  if v_grant.status = 'reserved' then
    select * into v_invoice
    from public.subscription_invoices
    where id = v_grant.reserved_invoice_id
    for update;

    if not found then
      raise exception 'Fatura reservada não encontrada.' using errcode = 'P0002';
    end if;

    if v_invoice.gateway_emission_status = 'needs_reconciliation' then
      raise exception 'Emissão anterior com resultado incerto. Reconcilie antes de nova tentativa.' using errcode = '22023';
    end if;

    return jsonb_build_object(
      'reused', true,
      'invoice', to_jsonb(v_invoice),
      'grant_id', v_grant.id
    );
  end if;

  -- Se authorized: cria a nova fatura vinculada ao grant atomicamente
  insert into public.subscription_invoices (
    restaurant_id, plan_id, billing_cycle, payment_method, amount_cents, status,
    pix_expires_at, created_by, gateway_emission_status
  ) values (
    p_restaurant_id, 'basic', 'monthly', 'pix', 500, 'pending',
    coalesce(p_pix_expires_at, v_now + interval '30 minutes'),
    p_user_id, null
  ) returning * into v_invoice;

  update billing_private.subscription_test_grants
  set status = 'reserved',
      reserved_at = v_now,
      reserved_invoice_id = v_invoice.id
  where id = v_grant.id;

  return jsonb_build_object(
    'reused', false,
    'invoice', to_jsonb(v_invoice),
    'grant_id', v_grant.id
  );
end;
$$;

-- Trigger para consumo atômico do test grant ao quitar a fatura
create or replace function billing_private.on_subscription_invoice_paid_consume_grant()
returns trigger
language plpgsql
security definer
set search_path = public, billing_private
as $$
begin
  if new.status = 'paid' and (old.status is distinct from 'paid') then
    update billing_private.subscription_test_grants
    set status = 'consumed',
        consumed_at = timezone('utc', now())
    where reserved_invoice_id = new.id and status in ('authorized', 'reserved');
  end if;
  return new;
end;
$$;

drop trigger if exists trg_consume_test_grant on public.subscription_invoices;
create trigger trg_consume_test_grant
after update on public.subscription_invoices
for each row
when (new.status = 'paid' and old.status is distinct from 'paid')
execute function billing_private.on_subscription_invoice_paid_consume_grant();

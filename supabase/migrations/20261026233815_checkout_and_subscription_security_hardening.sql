begin;

-- ============================================================================
-- ELOOZI — ETAPA 1: BLINDAGEM DE SEGURANÇA DO CHECKOUT E DAS ASSINATURAS
-- ============================================================================
-- Escopo exclusivo desta migração incremental (alinhado ao esquema real do projeto):
-- 1. Remover INSERT/UPDATE/DELETE direto de clientes sobre public.subscription_invoices.
-- 2. Desativar e revogar o RPC de checkout simulado no cliente (create_subscription_checkout).
-- 3. Coordenar a reserva/reuso de fatura PIX pendente por restaurante
--    (acquire_or_create_pending_subscription_invoice), com lock transacional,
--    SEM alterar automaticamente o estado de faturas existentes.
-- 4. Controlar a autorização de emissão no Asaas por fatura (claim único):
--    apenas a solicitação que obtiver o claim pode executar POST /payments.
--    Resultados incertos ficam em 'needs_reconciliation' e nunca geram novo POST.
-- 5. Expirar faturas apenas após reconciliação explícita com o Asaas
--    (expire_subscription_invoice_after_reconciliation).
-- 6. Blindar confirm_subscription_invoice_payment (service_role, parâmetros
--    obrigatórios, esquema real de platform_settings/platform_audit_logs) e
--    aceitar pagamento confirmado pelo Asaas mesmo que a fatura tenha sido
--    expirada localmente (webhook atrasado não é perdido).
--
-- Nenhuma fatura existente tem status alterado por esta migração.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. VERIFICAÇÃO DE PAPEL DE SERVIDOR CONFIÁVEL (defesa em profundidade)
-- ----------------------------------------------------------------------------
create or replace function public.assert_trusted_billing_server()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_jwt_role text;
  v_db_role text;
begin
  v_jwt_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
    ''
  );
  v_db_role := coalesce(nullif(current_setting('role', true), ''), session_user, '');

  if v_jwt_role in ('anon', 'authenticated')
     or v_db_role in ('anon', 'authenticated')
     or (
       v_jwt_role <> 'service_role'
       and v_db_role not in ('service_role', 'postgres', 'supabase_admin')
       and session_user not in ('service_role', 'postgres', 'supabase_admin')
     )
  then
    raise exception 'Não autorizado: operação de cobrança permitida exclusivamente ao processo confiável de servidor.'
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.assert_trusted_billing_server() from public, anon, authenticated;
grant execute on function public.assert_trusted_billing_server() to service_role;

-- ----------------------------------------------------------------------------
-- 1. BLINDAGEM DE public.subscription_invoices (RLS E GRANTS)
-- ----------------------------------------------------------------------------
alter table public.subscription_invoices enable row level security;

drop policy if exists subscription_invoices_insert on public.subscription_invoices;
drop policy if exists subscription_invoices_update on public.subscription_invoices;
drop policy if exists subscription_invoices_delete on public.subscription_invoices;

revoke all on table public.subscription_invoices from public, anon, authenticated;
grant select on table public.subscription_invoices to authenticated;
grant all on table public.subscription_invoices to service_role;

-- Colunas de controle da emissão no gateway (nulas para faturas existentes; nenhum dado é alterado)
alter table public.subscription_invoices
  add column if not exists gateway_emission_status text,
  add column if not exists gateway_emission_claim_id uuid,
  add column if not exists gateway_emission_started_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'subscription_invoices_gateway_emission_status_check'
  ) then
    alter table public.subscription_invoices
      add constraint subscription_invoices_gateway_emission_status_check
      check (gateway_emission_status is null
             or gateway_emission_status in ('in_progress', 'issued', 'needs_reconciliation'));
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- 2. DESABILITAÇÃO DO RPC DE CHECKOUT DIRETO/FALLBACK NO CLIENTE
-- ----------------------------------------------------------------------------
create or replace function public.create_subscription_checkout(
  p_restaurant_id uuid,
  p_target_plan text,
  p_billing_cycle text default 'monthly',
  p_payment_method text default 'pix',
  p_card_data jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'Checkout direto ou simulado no cliente desabilitado por segurança. Utilize o endpoint de servidor verificado com o Asaas.'
    using errcode = '42501';
end;
$$;

revoke all on function public.create_subscription_checkout(uuid, text, text, text, jsonb) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 3. RESERVA / REUSO DE FATURA PENDENTE (SEM EXPIRAÇÃO AUTOMÁTICA)
-- ----------------------------------------------------------------------------
drop index if exists public.idx_subscription_invoices_unique_active_pending_pix;
drop function if exists public.acquire_or_create_pending_subscription_invoice(uuid, text, text, text, integer, timestamptz, text, text, uuid);

create or replace function public.acquire_or_create_pending_subscription_invoice(
  p_restaurant_id uuid,
  p_plan_id text,
  p_billing_cycle text,
  p_payment_method text,
  p_amount_cents integer,
  p_pix_expires_at timestamptz default null,
  p_card_brand text default null,
  p_card_last4 text default null,
  p_created_by uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := timezone('utc', now());
  v_existing public.subscription_invoices%rowtype;
  v_created public.subscription_invoices%rowtype;
begin
  perform public.assert_trusted_billing_server();

  if p_restaurant_id is null then
    raise exception 'Restaurante é obrigatório.' using errcode = '22023';
  end if;
  if p_plan_id not in ('basic', 'pro', 'premium') then
    raise exception 'Plano inválido: %', p_plan_id using errcode = '22023';
  end if;
  if p_billing_cycle not in ('monthly', 'yearly') then
    raise exception 'Ciclo de faturamento inválido: %', p_billing_cycle using errcode = '22023';
  end if;
  if p_payment_method not in ('pix', 'credit_card', 'debit_card') then
    raise exception 'Método de pagamento inválido: %', p_payment_method using errcode = '22023';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'Valor da fatura inválido.' using errcode = '22023';
  end if;

  -- Serializa requisições concorrentes de checkout do mesmo restaurante
  perform 1 from public.restaurants where id = p_restaurant_id for update;
  if not found then
    raise exception 'Restaurante não encontrado.' using errcode = 'P0002';
  end if;

  -- Reutiliza fatura pendente existente da mesma combinação (PIX ou CARTÃO),
  -- garantindo idempotência e prevenindo criação de faturas concorrentes para a mesma tentativa de checkout.
  select * into v_existing
  from public.subscription_invoices
  where restaurant_id = p_restaurant_id
    and plan_id = p_plan_id
    and billing_cycle = p_billing_cycle
    and payment_method = p_payment_method
    and amount_cents = p_amount_cents
    and status = 'pending'
  order by created_at desc, id desc
  limit 1
  for update;

  if found then
    return jsonb_build_object('reused', true, 'invoice', to_jsonb(v_existing));
  end if;

  insert into public.subscription_invoices (
    restaurant_id, plan_id, billing_cycle, payment_method, amount_cents, status,
    pix_expires_at, card_brand, card_last4, created_by
  ) values (
    p_restaurant_id, p_plan_id, p_billing_cycle, p_payment_method, p_amount_cents, 'pending',
    case when p_payment_method = 'pix' then coalesce(p_pix_expires_at, v_now + interval '30 minutes') else null end,
    p_card_brand, p_card_last4, p_created_by
  )
  returning * into v_created;

  return jsonb_build_object('reused', false, 'invoice', to_jsonb(v_created));
end;
$$;

revoke all on function public.acquire_or_create_pending_subscription_invoice(uuid, text, text, text, integer, timestamptz, text, text, uuid) from public, anon, authenticated;
grant execute on function public.acquire_or_create_pending_subscription_invoice(uuid, text, text, text, integer, timestamptz, text, text, uuid) to service_role;

-- ----------------------------------------------------------------------------
-- 4. CLAIM ÚNICO DE EMISSÃO NO GATEWAY (apenas 1 solicitação pode fazer POST /payments)
-- ----------------------------------------------------------------------------
create or replace function public.claim_subscription_invoice_gateway_emission(p_invoice_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice public.subscription_invoices%rowtype;
  v_claim uuid;
  v_now timestamptz := timezone('utc', now());
begin
  perform public.assert_trusted_billing_server();

  select * into v_invoice from public.subscription_invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'Fatura não encontrada.' using errcode = 'P0002';
  end if;

  if v_invoice.status <> 'pending' then
    return jsonb_build_object('claimed', false, 'reason', 'not_pending', 'status', v_invoice.status);
  end if;

  if v_invoice.external_reference is not null and btrim(v_invoice.external_reference) <> '' then
    return jsonb_build_object('claimed', false, 'reason', 'already_issued',
      'external_reference', v_invoice.external_reference);
  end if;

  if v_invoice.gateway_emission_status is not null then
    return jsonb_build_object('claimed', false, 'reason', v_invoice.gateway_emission_status,
      'started_at', v_invoice.gateway_emission_started_at);
  end if;

  v_claim := gen_random_uuid();
  update public.subscription_invoices
  set gateway_emission_status = 'in_progress',
      gateway_emission_claim_id = v_claim,
      gateway_emission_started_at = v_now
  where id = p_invoice_id;

  return jsonb_build_object('claimed', true, 'claim_id', v_claim, 'started_at', v_now);
end;
$$;

-- Libera o claim somente quando é certo que nenhum POST /payments foi enviado
create or replace function public.release_subscription_invoice_gateway_emission(p_invoice_id uuid, p_claim_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_trusted_billing_server();
  update public.subscription_invoices
  set gateway_emission_status = null,
      gateway_emission_claim_id = null,
      gateway_emission_started_at = null
  where id = p_invoice_id
    and gateway_emission_claim_id = p_claim_id
    and gateway_emission_status = 'in_progress'
    and external_reference is null;
  return found;
end;
$$;

-- Resultado incerto do POST: bloqueia novos POSTs e exige reconciliação
create or replace function public.mark_subscription_invoice_emission_uncertain(p_invoice_id uuid, p_claim_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_trusted_billing_server();
  update public.subscription_invoices
  set gateway_emission_status = 'needs_reconciliation'
  where id = p_invoice_id
    and gateway_emission_claim_id = p_claim_id
    and gateway_emission_status = 'in_progress';
  return found;
end;
$$;

-- Vincula o ID da cobrança no Asaas (pelo dono do claim ou após reconciliação verificada)
create or replace function public.attach_subscription_invoice_external_reference(
  p_invoice_id uuid,
  p_external_reference text,
  p_claim_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice public.subscription_invoices%rowtype;
  v_ext text := nullif(btrim(coalesce(p_external_reference, '')), '');
begin
  perform public.assert_trusted_billing_server();

  if v_ext is null then
    raise exception 'Referência externa obrigatória.' using errcode = '22023';
  end if;

  select * into v_invoice from public.subscription_invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'Fatura não encontrada.' using errcode = 'P0002';
  end if;

  if v_invoice.external_reference is not null and btrim(v_invoice.external_reference) <> '' then
    if btrim(v_invoice.external_reference) <> v_ext then
      raise exception 'Divergência: a fatura já está vinculada a outra cobrança do Asaas.' using errcode = '22023';
    end if;
    return jsonb_build_object('attached', true, 'already_attached', true);
  end if;

  if p_claim_id is not null and v_invoice.gateway_emission_claim_id is distinct from p_claim_id then
    raise exception 'Claim de emissão inválido para esta fatura.' using errcode = '42501';
  end if;

  if exists (
    select 1 from public.subscription_invoices
    where external_reference = v_ext and id <> p_invoice_id
  ) then
    raise exception 'Cobrança do Asaas já vinculada a outra fatura.' using errcode = '22023';
  end if;

  update public.subscription_invoices
  set external_reference = v_ext,
      gateway_emission_status = 'issued'
  where id = p_invoice_id;

  return jsonb_build_object('attached', true, 'already_attached', false);
end;
$$;

-- Expira fatura pendente somente após o Asaas confirmar que a cobrança não pode mais ser paga
create or replace function public.expire_subscription_invoice_after_reconciliation(
  p_invoice_id uuid,
  p_asaas_status text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice public.subscription_invoices%rowtype;
begin
  perform public.assert_trusted_billing_server();

  if p_asaas_status is null
     or p_asaas_status not in ('DELETED', 'REFUNDED') then
    raise exception 'Estado do Asaas não permite expirar a fatura: %', coalesce(p_asaas_status, '(nulo)')
      using errcode = '22023';
  end if;

  select * into v_invoice from public.subscription_invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'Fatura não encontrada.' using errcode = 'P0002';
  end if;

  if v_invoice.status <> 'pending' then
    return false;
  end if;

  update public.subscription_invoices set status = 'expired' where id = p_invoice_id;
  return true;
end;
$$;

revoke all on function public.claim_subscription_invoice_gateway_emission(uuid) from public, anon, authenticated;
revoke all on function public.release_subscription_invoice_gateway_emission(uuid, uuid) from public, anon, authenticated;
revoke all on function public.mark_subscription_invoice_emission_uncertain(uuid, uuid) from public, anon, authenticated;
revoke all on function public.attach_subscription_invoice_external_reference(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.expire_subscription_invoice_after_reconciliation(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_subscription_invoice_gateway_emission(uuid) to service_role;
grant execute on function public.release_subscription_invoice_gateway_emission(uuid, uuid) to service_role;
grant execute on function public.mark_subscription_invoice_emission_uncertain(uuid, uuid) to service_role;
grant execute on function public.attach_subscription_invoice_external_reference(uuid, text, uuid) to service_role;
grant execute on function public.expire_subscription_invoice_after_reconciliation(uuid, text) to service_role;

-- ----------------------------------------------------------------------------
-- 4.9. INFRAESTRUTURA DURÁVEL: WEBHOOK INBOX (billing_private)
-- ----------------------------------------------------------------------------
create schema if not exists billing_private;

revoke all on schema billing_private from public, anon, authenticated;
grant usage on schema billing_private to service_role;

create table if not exists billing_private.webhook_inbox (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'asaas',
  event_id text not null,
  event_type text not null,
  payload jsonb not null,
  received_at timestamptz not null default clock_timestamp(),
  status text not null check (status in ('received', 'processing', 'processed', 'failed', 'review_required', 'quarantined')),
  claim_id uuid,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0,
  next_retry_at timestamptz,
  processed_at timestamptz,
  disposition text check (disposition in ('confirmed', 'review_required', 'already_paid', 'rejected')),
  last_error text,
  created_at timestamptz not null default clock_timestamp(),

  constraint uq_webhook_inbox_provider_event unique (provider, event_id),
  constraint check_event_id_not_empty check (length(btrim(event_id)) > 0)
);

alter table billing_private.webhook_inbox enable row level security;
revoke all on table billing_private.webhook_inbox from public, anon, authenticated;
grant all on table billing_private.webhook_inbox to service_role;

-- ----------------------------------------------------------------------------
-- 5. PONTE SEGURA PARA O WEBHOOK v7 ATIVO: confirm_subscription_invoice_payment(uuid, text)
-- ----------------------------------------------------------------------------
-- Preserva a sobrecarga legada sem mutação financeira direta na fatura.
-- Se payment.id estiver ausente (prefixo asaas_pay_ ou nulo), isola o evento em quarentena.
-- Se fatura for desconhecida, falha fechado levantando exceção (resulta em HTTP 500 no v7).
drop function if exists public.confirm_subscription_invoice_payment(uuid, text);

create or replace function public.confirm_subscription_invoice_payment(
  p_invoice_id uuid,
  p_external_reference text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ext text := nullif(btrim(coalesce(p_external_reference, '')), '');
  v_is_fallback boolean := false;
  v_inbox_id uuid;
begin
  perform public.assert_trusted_billing_server();

  if p_invoice_id is null then
    raise exception 'ID da fatura é obrigatório.' using errcode = '22023';
  end if;

  -- Se a fatura for inexistente, grava em quarentena e responde HTTP 200 à v7.
  -- Isso evita 15 retentativas inúteis do Asaas que pausariam a fila da conta.
  if not exists (select 1 from public.subscription_invoices where id = p_invoice_id) then
    insert into billing_private.webhook_inbox (
      provider,
      event_id,
      event_type,
      payload,
      status,
      disposition,
      last_error
    ) values (
      'asaas',
      'quarantine:v7:unknown_invoice:' || p_invoice_id::text,
      'PAYMENT_RECEIVED',
      jsonb_build_object(
        'source', 'v7_bridge',
        'invoice_id', p_invoice_id,
        'external_reference', v_ext,
        'quarantine_reason', 'unknown_invoice'
      ),
      'quarantined',
      'rejected',
      'Fatura ' || p_invoice_id::text || ' inexistente no banco local.'
    )
    on conflict on constraint uq_webhook_inbox_provider_event do nothing
    returning id into v_inbox_id;

    return jsonb_build_object(
      'bridged', true,
      'quarantined', true,
      'disposition', 'rejected',
      'reason', 'unknown_invoice',
      'inbox_id', v_inbox_id,
      'idempotent', v_inbox_id is null,
      'invoice_id', p_invoice_id,
      'external_reference', v_ext
    );
  end if;

  -- Detecta se payment.id estava ausente na v7 (passando fallback 'asaas_pay_<invoiceId>' ou nulo)
  v_is_fallback := (v_ext is null) or (v_ext = 'asaas_pay_' || p_invoice_id::text) or (v_ext like 'asaas_pay_%');

  if v_is_fallback then
    -- Grava em quarentena sem consultar Asaas e sem tentar quitar
    insert into billing_private.webhook_inbox (
      provider,
      event_id,
      event_type,
      payload,
      status,
      disposition,
      last_error
    ) values (
      'asaas',
      'quarantine:v7:no_payment_id:' || p_invoice_id::text,
      'PAYMENT_RECEIVED',
      jsonb_build_object(
        'source', 'v7_bridge',
        'invoice_id', p_invoice_id,
        'external_reference', coalesce(v_ext, 'asaas_pay_' || p_invoice_id::text),
        'quarantine_reason', 'missing_payment_id'
      ),
      'quarantined',
      'rejected',
      'payment.id ausente no payload (fallback asaas_pay_<invoiceId> detectado na v7)'
    )
    on conflict on constraint uq_webhook_inbox_provider_event do nothing
    returning id into v_inbox_id;

    return jsonb_build_object(
      'bridged', true,
      'quarantined', true,
      'disposition', 'rejected',
      'inbox_id', v_inbox_id,
      'idempotent', v_inbox_id is null,
      'invoice_id', p_invoice_id,
      'external_reference', coalesce(v_ext, 'asaas_pay_' || p_invoice_id::text)
    );
  end if;

  -- Fluxo normal de pagamento com payment.id legítimo: grava como 'received' na Inbox
  insert into billing_private.webhook_inbox (
    provider,
    event_id,
    event_type,
    payload,
    status
  ) values (
    'asaas',
    'bridge:v7:' || v_ext,
    'PAYMENT_RECEIVED',
    jsonb_build_object(
      'source', 'v7_bridge',
      'invoice_id', p_invoice_id,
      'external_reference', v_ext
    ),
    'received'
  )
  on conflict on constraint uq_webhook_inbox_provider_event do nothing
  returning id into v_inbox_id;

  return jsonb_build_object(
    'bridged', true,
    'quarantined', false,
    'status', 'received',
    'inbox_id', v_inbox_id,
    'idempotent', v_inbox_id is null,
    'invoice_id', p_invoice_id,
    'external_reference', v_ext
  );
end;
$$;

revoke all on function public.confirm_subscription_invoice_payment(uuid, text) from public, anon, authenticated;
grant execute on function public.confirm_subscription_invoice_payment(uuid, text) to service_role;

-- ----------------------------------------------------------------------------
-- 5.1. FUNÇÃO CANÔNICA DE PAGAMENTO: confirm_subscription_invoice_payment(uuid, text, integer, uuid)
-- ----------------------------------------------------------------------------
drop function if exists public.confirm_subscription_invoice_payment(uuid, text, integer, uuid);

create or replace function public.confirm_subscription_invoice_payment(
  p_invoice_id uuid,
  p_external_reference text,
  p_paid_amount_cents integer,
  p_restaurant_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ext_ref text;
  v_invoice public.subscription_invoices%rowtype;
  v_restaurant public.restaurants%rowtype;
  v_settings public.platform_settings%rowtype;
  v_cycle_days integer;
  v_max_tables integer;
  v_monthly_equiv_cents integer;
  v_new_expires_at timestamptz;
  v_audit_action text;
  v_actor_email text;
  v_previous_status text;
  v_now timestamptz := timezone('utc', now());
begin
  perform public.assert_trusted_billing_server();

  if p_invoice_id is null then
    raise exception 'ID da fatura (p_invoice_id) é obrigatório.' using errcode = '22023';
  end if;
  if p_restaurant_id is null then
    raise exception 'ID do restaurante vinculado (p_restaurant_id) é obrigatório.' using errcode = '22023';
  end if;
  v_ext_ref := nullif(btrim(coalesce(p_external_reference, '')), '');
  if v_ext_ref is null then
    raise exception 'ID externo da cobrança no Asaas (p_external_reference) é obrigatório.' using errcode = '22023';
  end if;
  if p_paid_amount_cents is null or p_paid_amount_cents <= 0 then
    raise exception 'O valor pago confirmado pelo gateway (p_paid_amount_cents) é obrigatório.' using errcode = '22023';
  end if;

  select * into v_invoice from public.subscription_invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'Fatura não encontrada.' using errcode = 'P0002';
  end if;

  if v_invoice.restaurant_id <> p_restaurant_id then
    raise exception 'Divergência de segurança: a fatura informada não pertence ao restaurante vinculado.'
      using errcode = '42501';
  end if;

  if v_invoice.external_reference is null or btrim(v_invoice.external_reference) = '' then
    raise exception 'Divergência de segurança: a fatura não possui referência externa (external_reference) vinculada.'
      using errcode = '22023';
  end if;
  if btrim(v_invoice.external_reference) <> v_ext_ref then
    raise exception 'Divergência de segurança: o ID externo informado não corresponde à cobrança registrada na fatura.'
      using errcode = '22023';
  end if;

  if p_paid_amount_cents <> v_invoice.amount_cents then
    raise exception 'Divergência de valor: o valor confirmado (%) difere do valor da fatura (%).',
      p_paid_amount_cents, v_invoice.amount_cents using errcode = '22023';
  end if;

  if v_invoice.status = 'paid' then
    select * into v_restaurant from public.restaurants where id = v_invoice.restaurant_id;
    return jsonb_build_object(
      'success', true, 'invoice_id', v_invoice.id, 'status', 'paid', 'already_paid', true,
      'paid_at', v_invoice.paid_at, 'plan_id', v_invoice.plan_id,
      'billing_cycle', v_invoice.billing_cycle, 'amount_cents', v_invoice.amount_cents,
      'subscription_expires_at', v_restaurant.subscription_expires_at,
      'max_tables', v_restaurant.max_tables
    );
  end if;

  -- Pagamento confirmado pelo Asaas é aceito mesmo que a fatura tenha sido expirada/falhada
  -- localmente (ex.: webhook atrasado). Apenas faturas estornadas são recusadas.
  if v_invoice.status not in ('pending', 'expired', 'failed') then
    raise exception 'A fatura não pode ser confirmada no estado atual: %.', v_invoice.status
      using errcode = '22023';
  end if;
  v_previous_status := v_invoice.status;

  select * into v_restaurant from public.restaurants where id = v_invoice.restaurant_id for update;
  if not found then
    raise exception 'Restaurante vinculado à fatura não encontrado.' using errcode = 'P0002';
  end if;

  select * into v_settings from public.platform_settings where id = 'default';
  if not found then
    raise exception 'Configurações de catálogo de planos (platform_settings id=default) não encontradas.'
      using errcode = 'P0002';
  end if;

  if v_invoice.plan_id = 'basic' then
    v_monthly_equiv_cents := v_settings.basic_price_cents;
    v_max_tables := v_settings.basic_max_tables;
  elsif v_invoice.plan_id = 'pro' then
    v_monthly_equiv_cents := v_settings.pro_price_cents;
    v_max_tables := v_settings.pro_max_tables;
  elsif v_invoice.plan_id = 'premium' then
    v_monthly_equiv_cents := v_settings.premium_price_cents;
    v_max_tables := v_settings.premium_max_tables;
  else
    raise exception 'Plano inválido na fatura: %', v_invoice.plan_id using errcode = '22023';
  end if;

  if v_monthly_equiv_cents is null or v_monthly_equiv_cents <= 0
     or v_max_tables is null or v_max_tables <= 0 then
    raise exception 'Catálogo de planos em platform_settings inválido para o plano %.', v_invoice.plan_id
      using errcode = '22023';
  end if;

  v_cycle_days := case when v_invoice.billing_cycle = 'yearly' then 365 else 30 end;

  if v_restaurant.subscription_expires_at is not null and v_restaurant.subscription_expires_at > v_now then
    v_new_expires_at := v_restaurant.subscription_expires_at + (v_cycle_days || ' days')::interval;
  else
    v_new_expires_at := v_now + (v_cycle_days || ' days')::interval;
  end if;

  update public.subscription_invoices
  set status = 'paid', paid_at = v_now, external_reference = v_ext_ref,
      gateway_emission_status = 'issued'
  where id = v_invoice.id;

  update public.restaurants
  set subscription_plan = v_invoice.plan_id,
      subscription_expires_at = v_new_expires_at,
      billing_cycle_days = v_cycle_days,
      max_tables = v_max_tables,
      monthly_price_cents = v_monthly_equiv_cents,
      active = true
  where id = v_invoice.restaurant_id;

  v_audit_action := case
    when v_invoice.plan_id <> v_restaurant.subscription_plan then 'plan_changed'
    else 'cycle_renewed'
  end;

  if v_invoice.created_by is not null then
    select u.email into v_actor_email from auth.users as u where u.id = v_invoice.created_by;
  end if;

  insert into public.platform_audit_logs (
    action, target_restaurant_id, target_restaurant_name, actor_email, details
  ) values (
    v_audit_action, v_restaurant.id, v_restaurant.name,
    coalesce(v_actor_email, 'asaas_verified_server'),
    jsonb_build_object(
      'invoice_id', v_invoice.id,
      'plan_id', v_invoice.plan_id,
      'billing_cycle', v_invoice.billing_cycle,
      'amount_cents', v_invoice.amount_cents,
      'payment_method', v_invoice.payment_method,
      'external_reference', v_ext_ref,
      'previous_invoice_status', v_previous_status,
      'new_expires_at', v_new_expires_at
    )
  );

  return jsonb_build_object(
    'success', true, 'invoice_id', v_invoice.id, 'status', 'paid', 'already_paid', false,
    'late_confirmation', v_previous_status <> 'pending',
    'paid_at', v_now, 'plan_id', v_invoice.plan_id, 'billing_cycle', v_invoice.billing_cycle,
    'amount_cents', v_invoice.amount_cents, 'subscription_expires_at', v_new_expires_at,
    'max_tables', v_max_tables
  );
end;
$$;

revoke all on function public.confirm_subscription_invoice_payment(uuid, text, integer, uuid) from public, anon, authenticated;
grant execute on function public.confirm_subscription_invoice_payment(uuid, text, integer, uuid) to service_role;

commit;

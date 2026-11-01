-- Migration: 20261101140000_inbox_consumer_queue_infrastructure.sql
-- Description: Helper functions, queue indexing, atomic financial protection, and secure cron trigger for Webhook Inbox.
-- Security: SECURITY DEFINER with empty search_path, restricted strictly to service_role and postgres.

create schema if not exists billing_private;

-- 1. Fila e indice de performance para claim concorrente
create index if not exists idx_webhook_inbox_queue
  on billing_private.webhook_inbox (status, next_retry_at, lease_expires_at)
  where status in ('received', 'processing');

-- 2. Claim atomico de eventos com controle de concorrencia e lease de visibilidade
create or replace function billing_private.claim_webhook_inbox_event(
  p_worker_id uuid,
  p_lease_seconds integer default 60
)
returns table (
  id uuid,
  event_id text,
  event_type text,
  payload jsonb,
  attempt_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
begin
  perform public.assert_trusted_billing_server();

  if p_worker_id is null then
    raise exception 'Worker ID e obrigatorio para claim.' using errcode = '22023';
  end if;

  -- 2.1 Varredura preventiva: eventos cujo lease expirou e ja atingiram o limite de 5 tentativas
  -- sao movidos para review_required e failed, impedindo que fiquem presos em processing
  update billing_private.webhook_inbox w
  set status = 'failed',
      disposition = 'review_required',
      claim_id = null,
      lease_expires_at = null,
      last_error = coalesce(w.last_error, 'Lease expirou apos atingir o limite maximo de tentativas (' || w.attempt_count::text || ').')
  where w.status = 'processing'
    and w.lease_expires_at < v_now
    and w.attempt_count >= 5;

  -- 2.2 Reivindicacao concorrente via FOR UPDATE SKIP LOCKED
  return query
  with candidate as (
    select i.id
    from billing_private.webhook_inbox i
    where (
      -- Evento recem-chegado pronto para processamento
      (i.status = 'received' and (i.next_retry_at is null or i.next_retry_at <= v_now))
      or
      -- Reivindicacao de lease expirado com menos de 5 tentativas
      (i.status = 'processing' and i.lease_expires_at < v_now and i.attempt_count < 5)
    )
    order by i.received_at asc
    for update skip locked
    limit 1
  )
  update billing_private.webhook_inbox i
  set status = 'processing',
      claim_id = p_worker_id,
      claimed_at = v_now,
      lease_expires_at = v_now + (greatest(coalesce(p_lease_seconds, 60), 10) || ' seconds')::interval,
      attempt_count = i.attempt_count + 1
  from candidate
  where i.id = candidate.id
  returning i.id, i.event_id, i.event_type, i.payload, i.attempt_count;
end;
$$;

comment on function billing_private.claim_webhook_inbox_event(uuid, integer) is
  'Reivindica atomicamente o proximo evento da fila de inbox usando FOR UPDATE SKIP LOCKED e lease de visibilidade, varrendo leases expirados exauridos.';

-- 3. Tratamento de falha com suporte a retentativa (backoff) ou envio para revisao
create or replace function billing_private.fail_webhook_inbox_event(
  p_inbox_id uuid,
  p_worker_id uuid,
  p_error text,
  p_retryable boolean default true,
  p_retry_delay_seconds integer default 60
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_current_attempts integer;
begin
  perform public.assert_trusted_billing_server();

  select attempt_count into v_current_attempts
  from billing_private.webhook_inbox
  where id = p_inbox_id
    and claim_id = p_worker_id
    and status = 'processing'
  for update;

  if not found then
    return false;
  end if;

  if coalesce(p_retryable, false) and v_current_attempts < 5 then
    -- Falha transitoria: reagenda para nova tentativa apos o delay (status = received)
    update billing_private.webhook_inbox
    set status = 'received',
        next_retry_at = v_now + (greatest(coalesce(p_retry_delay_seconds, 60), 5) || ' seconds')::interval,
        last_error = p_error,
        claim_id = null,
        lease_expires_at = null
    where id = p_inbox_id;
  else
    -- Falha permanente ou esgotamento de 5 tentativas: move para review_required
    update billing_private.webhook_inbox
    set status = 'failed',
        disposition = 'review_required',
        last_error = p_error,
        claim_id = null,
        lease_expires_at = null
    where id = p_inbox_id;
  end if;

  return true;
end;
$$;

comment on function billing_private.fail_webhook_inbox_event(uuid, uuid, text, boolean, integer) is
  'Registra erro de processamento do evento, reagendando em caso transitorio ou marcando review_required em caso terminal ou limite de retentativas.';

-- 4. Protecao financeira atomica: Validacao de lease e quitacao na mesma transacao
create or replace function billing_private.confirm_and_complete_inbox_payment(
  p_inbox_id uuid,
  p_worker_id uuid,
  p_invoice_id uuid,
  p_external_reference text,
  p_paid_amount_cents integer,
  p_restaurant_id uuid,
  p_disposition text default 'confirmed'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_inbox billing_private.webhook_inbox%rowtype;
  v_result jsonb;
  v_status text;
  v_disposition text;
begin
  perform public.assert_trusted_billing_server();

  if p_inbox_id is null or p_worker_id is null then
    raise exception 'Parametros p_inbox_id e p_worker_id sao obrigatorios.' using errcode = '22023';
  end if;

  -- 4.1 Trava o registro na inbox e valida se este worker ainda detem o lease valido
  select * into v_inbox
  from billing_private.webhook_inbox
  where id = p_inbox_id
  for update;

  if not found then
    raise exception 'Registro de Inbox % nao encontrado.', p_inbox_id using errcode = 'P0002';
  end if;

  if v_inbox.status is distinct from 'processing' then
    raise exception 'Estado invalido da inbox (%): esperado processing.', v_inbox.status using errcode = '22023';
  end if;

  if v_inbox.claim_id is distinct from p_worker_id then
    raise exception 'Conflito de posse: worker % nao e o titular do claim %.', p_worker_id, v_inbox.claim_id using errcode = '42501';
  end if;

  if v_inbox.lease_expires_at is null or v_inbox.lease_expires_at <= v_now then
    raise exception 'Lease expirado em % (agora %). Quitacao abortada para evitar corrida concorrente.',
      v_inbox.lease_expires_at, v_now using errcode = '55P03';
  end if;

  -- 4.2 Executa a quitacao canonica de 4 argumentos
  v_result := public.confirm_subscription_invoice_payment(
    p_invoice_id,
    p_external_reference,
    p_paid_amount_cents,
    p_restaurant_id
  );

  -- 4.3 Maquina de estados: se review_required, status DEVE ser review_required, NUNCA processed
  v_disposition := coalesce(p_disposition, 'confirmed');
  if (coalesce(v_result->>'requires_review', 'false'))::boolean is true or v_disposition = 'review_required' then
    v_status := 'review_required';
    v_disposition := 'review_required';
  else
    v_status := 'processed';
  end if;

  update billing_private.webhook_inbox
  set status = v_status,
      disposition = v_disposition,
      processed_at = v_now,
      claim_id = null,
      lease_expires_at = null,
      last_error = case when v_status = 'review_required' then coalesce(v_result->>'reason', 'Reconciliacao manual exigida') else null end
  where id = p_inbox_id;

  return v_result;
end;
$$;

comment on function billing_private.confirm_and_complete_inbox_payment(uuid, uuid, uuid, text, integer, uuid, text) is
  'Quitacao financeira atomica: valida lease e claim_id ativo na inbox, executa quitacao canonica e conclui a inbox na mesma transacao sem marcar review_required como processed.';

-- 5. Conclusao atomica de eventos que nao demandam quitacao financeira (ex: ja pagos ou rejeitados)
create or replace function billing_private.complete_webhook_inbox_event(
  p_inbox_id uuid,
  p_worker_id uuid,
  p_disposition text default 'confirmed'
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_status text;
  v_disposition text;
begin
  perform public.assert_trusted_billing_server();

  v_disposition := coalesce(p_disposition, 'confirmed');
  if v_disposition = 'review_required' then
    v_status := 'review_required';
  else
    v_status := 'processed';
  end if;

  update billing_private.webhook_inbox
  set status = v_status,
      disposition = v_disposition,
      processed_at = v_now,
      claim_id = null,
      lease_expires_at = null
  where id = p_inbox_id
    and claim_id = p_worker_id
    and status = 'processing';

  return found;
end;
$$;

comment on function billing_private.complete_webhook_inbox_event(uuid, uuid, text) is
  'Finaliza o ciclo do evento na inbox marcando processed apenas para confirmed; se review_required, marca status = review_required.';

-- 6. Funcao de disparo seguro do Cron via pg_net
create or replace function billing_private.trigger_inbox_consumer_cron()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret text;
  v_request_id bigint;
begin
  -- Busca o segredo de forma segura no Vault sem expor em logs
  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'INBOX_CONSUMER_SECRET'
  limit 1;

  if v_secret is null then
    raise exception 'INBOX_CONSUMER_SECRET ausente no Vault.' using errcode = '22023';
  end if;

  -- Invoca net.http_post de forma sanitizada, retornando estritamente o request_id
  execute $cmd$
    select net.http_post(
      url := 'https://llhujxzefujdsthpezag.supabase.co/functions/v1/inbox-consumer',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-inbox-consumer-secret', $1
      ),
      body := '{"source": "pg_cron"}'::jsonb,
      timeout_milliseconds := 55000
    )
  $cmd$ into v_request_id using v_secret;

  return v_request_id;
end;
$$;

comment on function billing_private.trigger_inbox_consumer_cron() is
  'Disparo seguro do cron via pg_net que obtem o secret do Vault sem expo-lo e retorna estritamente o request_id sanitizado.';

-- 7. Privilegios e permissoes estritas (somente service_role e postgres)
revoke all on function billing_private.claim_webhook_inbox_event(uuid, integer) from public, anon, authenticated;
grant execute on function billing_private.claim_webhook_inbox_event(uuid, integer) to service_role;

revoke all on function billing_private.fail_webhook_inbox_event(uuid, uuid, text, boolean, integer) from public, anon, authenticated;
grant execute on function billing_private.fail_webhook_inbox_event(uuid, uuid, text, boolean, integer) to service_role;

revoke all on function billing_private.confirm_and_complete_inbox_payment(uuid, uuid, uuid, text, integer, uuid, text) from public, anon, authenticated;
grant execute on function billing_private.confirm_and_complete_inbox_payment(uuid, uuid, uuid, text, integer, uuid, text) to service_role;

revoke all on function billing_private.complete_webhook_inbox_event(uuid, uuid, text) from public, anon, authenticated;
grant execute on function billing_private.complete_webhook_inbox_event(uuid, uuid, text) to service_role;

revoke all on function billing_private.trigger_inbox_consumer_cron() from public, anon, authenticated;
grant execute on function billing_private.trigger_inbox_consumer_cron() to postgres, service_role;

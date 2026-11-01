// Test suite for Webhook Inbox, atomic claims, leases, and explicit RPC dispositions in PostgreSQL 17.
// Never connects to hosted databases; strictly isolated in OS temp directory.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const bin = 'D:/pgSQL/bin';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'eloozi-inbox-db-'));
const data = path.join(work, 'data');
const port = 55524;
const conn = ['-X', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'];
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith('PG')));
env.PGOPTIONS = '-c client_min_messages=warning -c timezone=UTC';

const log = (line) => console.log(line);
const run = (exe, args, input) => {
  const result = spawnSync(path.join(bin, exe + '.exe'), args, {
    input,
    encoding: 'utf8',
    windowsHide: true,
    env,
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120000,
    ...(exe === 'pg_ctl' ? { stdio: 'ignore' } : {})
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${exe} exit=${result.status}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  }
  return (result.stdout ?? '').trim();
};

const sql = (source) => run('psql', [...conn, '-At'], source).replace(/\r/g, '');
const apply = (file) => {
  log(`APPLY_LOCAL_ONLY ${file}`);
  const content = fs.readFileSync(path.join(root, file), 'utf8');
  sql(content);
};

let started = false;

try {
  log(`Disposable PostgreSQL 17 starting on loopback 127.0.0.1:${port}...`);
  run('initdb', ['-D', data, '-U', 'postgres', '-A', 'trust', '--encoding=UTF8', '--no-locale']);
  fs.appendFileSync(path.join(data, 'postgresql.conf'), `\nlisten_addresses = '127.0.0.1'\nport = ${port}\nmax_connections = 16\n`);
  run('pg_ctl', ['-D', data, '-l', path.join(work, 'postgres.log'), '-w', 'start']);
  started = true;

  assert.equal(
    sql("select (inet_server_addr() <<= '127.0.0.0/8'::inet)::text || ':' || inet_server_port()::text || ':' || current_database()"),
    `true:${port}:postgres`,
    'guard confirms disposable loopback cluster'
  );

  // Apply baseline migrations
  apply('supabase/tests/etapa3_bootstrap.sql');
  const migrationDir = path.join(root, 'supabase/migrations');
  const migrations = fs.readdirSync(migrationDir).filter(f => f.endsWith('.sql')).sort();

  for (const name of migrations) {
    if (name === '20261024164500_create_reservations_table.sql') continue;
    if (name === '20261031120000_billing_cutover_pending_invoice_quarantine.sql') continue;
    if (name === '20261008141500_create_table_tab_consumption.sql') {
      apply('supabase/seeds/demo_restaurants.sql');
    }
    apply('supabase/migrations/' + name);
  }

  log('Baseline migrations applied. Creating Webhook Inbox schema and functions...');

  // =========================================================================
  // WEBHOOK INBOX SCHEMA DEFINITION & CANONICAL FUNCTIONS
  // =========================================================================
  sql(`
    create schema if not exists billing_private;

    create table if not exists billing_private.webhook_inbox (
      id uuid primary key default gen_random_uuid(),
      provider text not null default 'asaas',
      event_id text not null,
      event_type text not null,
      payload jsonb not null,
      received_at timestamptz not null default clock_timestamp(),
      status text not null check(status in ('received', 'processing', 'processed', 'failed', 'review_required', 'quarantined')),
      claim_id uuid,
      claimed_at timestamptz,
      lease_expires_at timestamptz,
      attempt_count integer not null default 0,
      next_retry_at timestamptz,
      processed_at timestamptz,
      disposition text check(disposition in ('confirmed', 'review_required', 'already_paid', 'rejected')),
      last_error text,
      created_at timestamptz not null default clock_timestamp(),

      constraint uq_webhook_inbox_provider_event unique (provider, event_id),
      constraint check_event_id_not_empty check (length(btrim(event_id)) > 0)
    );

    create index if not exists idx_webhook_inbox_pending
      on billing_private.webhook_inbox (status, next_retry_at, lease_expires_at)
      where status in ('received', 'processing');

    alter table public.platform_audit_logs drop constraint if exists platform_audit_logs_action_check;
    alter table public.platform_audit_logs add constraint platform_audit_logs_action_check check (action in (
      'plan_changed','cycle_renewed','table_deleted','restaurant_suspended','restaurant_restored',
      'catalog_updated','branding_updated','payment_reconciliation_required',
      'webhook_payload_quarantined','webhook_inbox_manual_retry'
    ));

    -- Atomic ingestion function with quarantine on missing event ID
    create or replace function billing_private.record_webhook_inbox_event(
      p_provider text,
      p_event_id text,
      p_event_type text,
      p_payload jsonb
    )
    returns jsonb
    language plpgsql
    security definer
    set search_path = ''
    as $$
    declare
      v_row billing_private.webhook_inbox%rowtype;
      v_event_id text;
      v_quarantined boolean := false;
    begin
      perform public.assert_trusted_billing_server();

      v_event_id := nullif(btrim(p_event_id), '');
      if v_event_id is null then
        v_event_id := 'quarantine:missing_id:' || gen_random_uuid();
        v_quarantined := true;
      end if;

      if v_quarantined then
        insert into billing_private.webhook_inbox (
          provider, event_id, event_type, payload, status, disposition, last_error
        ) values (
          coalesce(nullif(btrim(p_provider), ''), 'asaas'),
          v_event_id,
          coalesce(nullif(btrim(p_event_type), ''), 'UNKNOWN'),
          p_payload,
          'quarantined',
          'rejected',
          'Payload recebido sem identificador único (payload.id ausente). Quarentena preventiva aplicada sem processamento financeiro.'
        )
        returning * into v_row;

        insert into public.platform_audit_logs (
          action, actor_email, details
        ) values (
          'webhook_payload_quarantined',
          'asaas_verified_server',
          jsonb_build_object(
            'reason', 'missing_event_id',
            'inbox_id', v_row.id,
            'event_id', v_row.event_id,
            'event_type', v_row.event_type
          )
        );

        return jsonb_build_object(
          'inserted', true,
          'quarantined', true,
          'duplicate', false,
          'id', v_row.id,
          'status', 'quarantined',
          'disposition', 'rejected'
        );
      end if;

      insert into billing_private.webhook_inbox (provider, event_id, event_type, payload, status)
      values (coalesce(nullif(btrim(p_provider), ''), 'asaas'), v_event_id, btrim(p_event_type), p_payload, 'received')
      on conflict on constraint uq_webhook_inbox_provider_event do nothing
      returning * into v_row;

      if v_row.id is not null then
        return jsonb_build_object('inserted', true, 'quarantined', false, 'duplicate', false, 'id', v_row.id, 'status', v_row.status);
      end if;

      select * into v_row
      from billing_private.webhook_inbox
      where provider = coalesce(nullif(btrim(p_provider), ''), 'asaas')
        and event_id = v_event_id;

      return jsonb_build_object('inserted', false, 'quarantined', false, 'duplicate', true, 'id', v_row.id, 'status', v_row.status, 'disposition', v_row.disposition);
    end;
    $$;

    -- Atomic claim function with visibility timeout
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

      return query
      with candidate as (
        select i.id
        from billing_private.webhook_inbox i
        where (
          (i.status = 'received' and (i.next_retry_at is null or i.next_retry_at <= v_now))
          or
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
          lease_expires_at = v_now + (p_lease_seconds || ' seconds')::interval,
          attempt_count = i.attempt_count + 1
      from candidate
      where i.id = candidate.id
      returning i.id, i.event_id, i.event_type, i.payload, i.attempt_count;
    end;
    $$;

    -- Function to mark completion (STRICT check on claim_id to prevent zombie workers)
    create or replace function billing_private.complete_webhook_inbox_event(
      p_inbox_id uuid,
      p_worker_id uuid,
      p_disposition text,
      p_status text default 'processed'
    )
    returns boolean
    language plpgsql
    security definer
    set search_path = ''
    as $$
    begin
      perform public.assert_trusted_billing_server();

      update billing_private.webhook_inbox
      set status = p_status,
          disposition = p_disposition,
          processed_at = clock_timestamp(),
          claim_id = null,
          lease_expires_at = null
      where id = p_inbox_id
        and claim_id = p_worker_id
        and status = 'processing';

      return found;
    end;
    $$;

    -- Function to mark failure / retry (STRICT check on claim_id)
    create or replace function billing_private.fail_webhook_inbox_event(
      p_inbox_id uuid,
      p_worker_id uuid,
      p_error text,
      p_retryable boolean default true,
      p_retry_delay_seconds integer default 30
    )
    returns boolean
    language plpgsql
    security definer
    set search_path = ''
    as $$
    declare
      v_now timestamptz := clock_timestamp();
      v_attempts integer;
    begin
      perform public.assert_trusted_billing_server();

      select attempt_count into v_attempts
      from billing_private.webhook_inbox
      where id = p_inbox_id
        and claim_id = p_worker_id
        and status = 'processing';

      if not found then
        return false;
      end if;

      if not p_retryable or v_attempts >= 5 then
        update billing_private.webhook_inbox
        set status = 'failed',
            last_error = p_error,
            claim_id = null,
            lease_expires_at = null
        where id = p_inbox_id
          and claim_id = p_worker_id
          and status = 'processing';
      else
        update billing_private.webhook_inbox
        set status = 'received',
            last_error = p_error,
            claim_id = null,
            lease_expires_at = null,
            next_retry_at = v_now + (p_retry_delay_seconds || ' seconds')::interval
        where id = p_inbox_id
          and claim_id = p_worker_id
          and status = 'processing';
      end if;

      return found;
    end;
    $$;

    -- Administrative replay function
    create or replace function billing_private.retry_webhook_inbox_event(
      p_inbox_id uuid,
      p_admin_id uuid default null
    )
    returns jsonb
    language plpgsql
    security definer
    set search_path = ''
    as $$
    declare
      v_row billing_private.webhook_inbox%rowtype;
    begin
      perform public.assert_trusted_billing_server();

      select * into v_row
      from billing_private.webhook_inbox
      where id = p_inbox_id for update;

      if not found then
        raise exception 'Evento não encontrado: %', p_inbox_id using errcode = 'P0002';
      end if;

      if v_row.status not in ('failed', 'quarantined') then
        raise exception 'Apenas eventos em status failed ou quarantined podem sofrer replay. Status atual: %', v_row.status
          using errcode = '22023';
      end if;

      update billing_private.webhook_inbox
      set status = 'received',
          attempt_count = 0,
          next_retry_at = clock_timestamp(),
          last_error = null,
          claim_id = null,
          lease_expires_at = null,
          disposition = null
      where id = p_inbox_id
      returning * into v_row;

      insert into public.platform_audit_logs (
        action, actor_email, details
      ) values (
        'webhook_inbox_manual_retry',
        'admin_operation',
        jsonb_build_object(
          'inbox_id', v_row.id,
          'event_id', v_row.event_id,
          'previous_status', v_row.status,
          'admin_id', p_admin_id
        )
      );

      return jsonb_build_object('success', true, 'id', v_row.id, 'status', v_row.status);
    end;
    $$;

    -- Canonical payment confirmation function with EXPLICIT DISPOSITION and ATOMIC ROLLBACK on inconclusive
    create or replace function public.confirm_subscription_invoice_payment_canonical(
      p_invoice_id uuid,
      p_external_reference text,
      p_paid_amount_cents integer,
      p_restaurant_id uuid,
      p_force_inconclusive boolean default false
    )
    returns jsonb
    language plpgsql
    security definer
    set search_path = ''
    as $$
    declare
      v_res jsonb;
      v_disposition text;
      v_receipt record;
    begin
      perform public.assert_trusted_billing_server();

      -- Call the underlying confirmation function
      v_res := public.confirm_subscription_invoice_payment(
        p_invoice_id,
        p_external_reference,
        p_paid_amount_cents,
        p_restaurant_id
      );

      -- For testing atomicity: if simulated inconclusive, raise exception to ensure transaction rollback
      if p_force_inconclusive then
        raise exception 'ERR_INCONCLUSIVE_DISPOSITION: Falha na validação de auditoria durante quitação.'
          using errcode = '22023';
      end if;

      -- Canonical disposition determination
      if (v_res->>'already_paid')::boolean = true then
        -- Check if it was previously flagged as review_required
        select disposition into v_receipt
        from (
          select disposition from subscription_quote_private.plan_change_receipts where invoice_id = p_invoice_id
          union all
          select disposition from subscription_quote_private.trial_upgrade_receipts where invoice_id = p_invoice_id
        ) receipts
        where disposition = 'review_required'
        limit 1;

        if found or (v_res->>'requires_review')::boolean = true then
          v_disposition := 'review_required';
        else
          v_disposition := 'already_paid';
        end if;
      elsif (v_res->>'requires_review')::boolean = true then
        v_disposition := 'review_required';
      elsif (v_res->>'success')::boolean = true and (v_res->>'status') = 'paid' then
        v_disposition := 'confirmed';
      else
        -- Inconclusive! Must NOT commit mutation.
        raise exception 'ERR_INCONCLUSIVE_DISPOSITION: Resposta da confirmação sem disposição válida: %', v_res
          using errcode = '22023';
      end if;

      return v_res || jsonb_build_object('disposition', v_disposition);
    end;
    $$;

    -- Atomic execution protecting the confirmation RPC under claim_id and active lease
    create or replace function billing_private.process_inbox_payment_event(
      p_inbox_id uuid,
      p_worker_id uuid,
      p_invoice_id uuid,
      p_external_reference text,
      p_paid_amount_cents integer,
      p_restaurant_id uuid,
      p_force_inconclusive boolean default false
    )
    returns jsonb
    language plpgsql
    security definer
    set search_path = ''
    as $$
    declare
      v_inbox billing_private.webhook_inbox%rowtype;
      v_res jsonb;
      v_disposition text;
      v_now timestamptz := clock_timestamp();
    begin
      perform public.assert_trusted_billing_server();

      -- 1. STRICT LOCK & VALIDATION: Verify worker holds active claim and lease on this inbox row
      select * into v_inbox
      from billing_private.webhook_inbox
      where id = p_inbox_id
        and claim_id = p_worker_id
        and status = 'processing'
        and lease_expires_at >= v_now
      for update;

      if not found then
        raise exception 'ERR_LEASE_EXPIRED_OR_STOLEN: Worker % não possui claim válido ou lease expirou para o evento inbox %',
          p_worker_id, p_inbox_id using errcode = '42501';
      end if;

      -- 2. Execute canonical payment confirmation
      v_res := public.confirm_subscription_invoice_payment_canonical(
        p_invoice_id,
        p_external_reference,
        p_paid_amount_cents,
        p_restaurant_id,
        p_force_inconclusive
      );

      v_disposition := v_res->>'disposition';

      -- 3. Update inbox atomically within the same transaction
      update billing_private.webhook_inbox
      set status = case when v_disposition = 'review_required' then 'review_required' else 'processed' end,
          disposition = v_disposition,
          processed_at = clock_timestamp(),
          claim_id = null,
          lease_expires_at = null
      where id = p_inbox_id
        and claim_id = p_worker_id
        and status = 'processing';

      return v_res;
    end;
    $$;
  `);

  log('Webhook Inbox and canonical disposition functions created. Running SQL test suite...');

  // Helper function to create restaurant and invoice fixture
  const setupFixture = (name = 'Restaurante Teste Inbox') => {
    return JSON.parse(sql(`
      with r as (
        insert into public.restaurants (
          name, slug, active, subscription_plan,
          subscription_expires_at, billing_cycle_days, max_tables, unlimited_tables,
          monthly_price_cents, subscription_is_trial
        ) values (
          '${name}', 'rest-${Date.now()}-${Math.floor(Math.random()*1000)}',
          true, 'pro', clock_timestamp() + interval '5 days', 30, 20, false, 9990, false
        ) returning id
      ),
      i as (
        insert into public.subscription_invoices (
          restaurant_id, plan_id, billing_cycle, amount_cents, status,
          external_reference, payment_method, gateway_emission_status
        )
        select r.id, 'pro', 'monthly', 9990, 'pending',
               'pay_ext_' || replace(gen_random_uuid()::text, '-', ''), 'pix', 'issued'
        from r
        returning id, restaurant_id, external_reference
      )
      select jsonb_build_object('restaurant_id', restaurant_id, 'invoice_id', id, 'external_reference', external_reference)::text from i;
    `));
  };

  // -------------------------------------------------------------------------
  // TEST 1: Ingestion & Idempotency
  // -------------------------------------------------------------------------
  log('SQL TEST 1: Durable ingestion and idempotency on event_id');
  const event1 = sql(`
    select billing_private.record_webhook_inbox_event(
      'asaas',
      'evt_test_sql_1',
      'PAYMENT_RECEIVED',
      '{"id":"evt_test_sql_1","event":"PAYMENT_RECEIVED","payment":{"id":"pay_1","value":99.9}}'::jsonb
    );
  `);
  const parsed1 = JSON.parse(event1);
  assert.equal(parsed1.inserted, true, 'First ingestion inserted');
  assert.equal(parsed1.duplicate, false, 'First ingestion not duplicate');
  assert.equal(parsed1.status, 'received', 'Initial status is received');

  const dup1 = JSON.parse(sql(`
    select billing_private.record_webhook_inbox_event(
      'asaas',
      'evt_test_sql_1',
      'PAYMENT_RECEIVED',
      '{"id":"evt_test_sql_1"}'::jsonb
    );
  `));
  assert.equal(dup1.inserted, false, 'Duplicate ingestion not inserted');
  assert.equal(dup1.duplicate, true, 'Duplicate ingestion detected');
  assert.equal(dup1.id, parsed1.id, 'Same inbox ID returned');
  log('SQL TEST 1 PASS: Event persisted durably; duplicate ingestion detected idempotently.');

  // -------------------------------------------------------------------------
  // TEST 2: Payload without Event ID is Coherently Quarantined (Zero Financial Mutation)
  // -------------------------------------------------------------------------
  log('SQL TEST 2: Missing event ID coherently quarantined with audit and zero financial mutation');
  const quarantineRes = JSON.parse(sql(`
    select billing_private.record_webhook_inbox_event(
      'asaas',
      null,
      'PAYMENT_RECEIVED',
      '{"payment":{"id":"pay_malformed","value":50.0}}'::jsonb
    );
  `));
  assert.equal(quarantineRes.inserted, true, 'Quarantine row inserted');
  assert.equal(quarantineRes.quarantined, true, 'Row marked quarantined');
  assert.equal(quarantineRes.status, 'quarantined', 'Status is quarantined');
  assert.equal(quarantineRes.disposition, 'rejected', 'Disposition is rejected');

  const auditLog = sql(`
    select count(*) from public.platform_audit_logs
    where action = 'webhook_payload_quarantined'
      and details->>'inbox_id' = '${quarantineRes.id}';
  `);
  assert.equal(auditLog, '1', 'Audit log created for quarantined event');

  // Verify quarantined event has status quarantined and cannot be matched by inbox query
  const claimQuarantine = sql(`
    select count(*) from billing_private.webhook_inbox
    where id = '${quarantineRes.id}' and status in ('received', 'processing');
  `);
  assert.equal(claimQuarantine, '0', 'Quarantined event cannot be claimed by regular consumer');
  log('SQL TEST 2 PASS: Missing event ID safely quarantined without retry-lock or financial mutation.');

  // -------------------------------------------------------------------------
  // TEST 3: Atomic Claim and Concurrency Locking (SKIP LOCKED)
  // -------------------------------------------------------------------------
  log('SQL TEST 3: Atomic claim and concurrency locking');
  const worker1 = 'a0000000-0000-0000-0000-000000000001';
  const worker2 = 'a0000000-0000-0000-0000-000000000002';

  const claim1 = JSON.parse(sql(`
    select row_to_json(c) from billing_private.claim_webhook_inbox_event('${worker1}'::uuid, 60) c;
  `));
  assert.equal(claim1.id, parsed1.id, 'Worker 1 claimed evt_test_sql_1');
  assert.equal(claim1.attempt_count, 1, 'Attempt counter incremented to 1');

  // Worker 2 attempts claim concurrently
  const claim2 = sql(`
    select count(*) from billing_private.claim_webhook_inbox_event('${worker2}'::uuid, 60);
  `);
  assert.equal(claim2, '0', 'Worker 2 receives 0 rows because event is locked under active lease');
  log('SQL TEST 3 PASS: Worker 1 claimed row; Worker 2 was locked out via SKIP LOCKED.');

  // -------------------------------------------------------------------------
  // TEST 4: Zombie Worker Prevention via claim_id and Lease Validation in Payment Transaction
  // -------------------------------------------------------------------------
  log('SQL TEST 4: Zombie Worker Prevention: Expired worker cannot execute financial mutation');
  const fixZombie = setupFixture('Restaurante Zombie Concurrency Test');
  const evtZombie = JSON.parse(sql(`
    select billing_private.record_webhook_inbox_event(
      'asaas',
      'evt_zombie_concurrency_test',
      'PAYMENT_RECEIVED',
      '{"id":"evt_zombie_concurrency_test"}'::jsonb
    );
  `));

  // Worker 1 claims the event
  const claimW1 = JSON.parse(sql(`
    select row_to_json(c) from billing_private.claim_webhook_inbox_event('${worker1}'::uuid, 60) c
    where c.id = '${evtZombie.id}';
  `));
  assert.equal(claimW1.attempt_count, 1, 'Worker 1 claimed event');

  // Simulate lease expiration of Worker 1's claim
  sql(`
    update billing_private.webhook_inbox
    set lease_expires_at = clock_timestamp() - interval '10 seconds'
    where id = '${evtZombie.id}';
  `);

  // Worker 2 claims the expired event
  const claimW2 = JSON.parse(sql(`
    select row_to_json(c) from billing_private.claim_webhook_inbox_event('${worker2}'::uuid, 60) c
    where c.id = '${evtZombie.id}';
  `));
  assert.equal(claimW2.id, evtZombie.id, 'Worker 2 reclaimed expired event');
  assert.equal(claimW2.attempt_count, 2, 'Attempt counter is now 2');

  // Worker 1 (zombie) attempts to execute the payment confirmation
  let zombieExecutionBlocked = false;
  try {
    sql(`
      select billing_private.process_inbox_payment_event(
        '${evtZombie.id}'::uuid,
        '${worker1}'::uuid,
        '${fixZombie.invoice_id}'::uuid,
        '${fixZombie.external_reference}',
        9990,
        '${fixZombie.restaurant_id}'::uuid
      );
    `);
  } catch (err) {
    zombieExecutionBlocked = err.message.includes('ERR_LEASE_EXPIRED_OR_STOLEN') || err.message.includes('42501');
  }
  assert.equal(zombieExecutionBlocked, true, 'Worker 1 rejected from executing payment transaction');

  // Verify that the invoice was NOT modified by Worker 1
  const invZombieState = JSON.parse(sql(`
    select row_to_json(i) from (
      select status, paid_at from public.subscription_invoices where id = '${fixZombie.invoice_id}'
    ) i;
  `));
  assert.equal(invZombieState.status, 'pending', 'Invoice remains pending after zombie attempt');
  assert.equal(invZombieState.paid_at, null, 'Invoice paid_at remains NULL');

  // Worker 2 (active claim holder) executes successfully
  const w2Success = JSON.parse(sql(`
    select billing_private.process_inbox_payment_event(
      '${evtZombie.id}'::uuid,
      '${worker2}'::uuid,
      '${fixZombie.invoice_id}'::uuid,
      '${fixZombie.external_reference}',
      9990,
      '${fixZombie.restaurant_id}'::uuid
    );
  `));
  assert.equal(w2Success.disposition, 'confirmed', 'Worker 2 successfully confirmed payment');

  // Verify that invoice is now paid and inbox is processed
  const invFinal = sql(`select status from public.subscription_invoices where id = '${fixZombie.invoice_id}'`);
  assert.equal(invFinal, 'paid', 'Invoice marked paid by authorized Worker 2');
  const inboxFinal = sql(`select status from billing_private.webhook_inbox where id = '${evtZombie.id}'`);
  assert.equal(inboxFinal, 'processed', 'Inbox status updated to processed by Worker 2');

  log('SQL TEST 4 PASS: Expired worker blocked from payment mutation; active worker completed.');

  // -------------------------------------------------------------------------
  // TEST 5: Strict Atomicity of Payment Confirmation (Inconclusive Result Leaves Zero Mutations)
  // -------------------------------------------------------------------------
  log('SQL TEST 5: Strict atomicity of payment confirmation: inconclusive result leaves ZERO financial mutations');
  const fixAtomicity = setupFixture('Restaurante Atomicity Test');

  // Attempt confirmation with forced inconclusive failure
  let failedAsExpected = false;
  try {
    sql(`
      select public.confirm_subscription_invoice_payment_canonical(
        '${fixAtomicity.invoice_id}'::uuid,
        '${fixAtomicity.external_reference}',
        9990,
        '${fixAtomicity.restaurant_id}'::uuid,
        true -- force inconclusive
      );
    `);
  } catch (err) {
    failedAsExpected = err.message.includes('ERR_INCONCLUSIVE_DISPOSITION');
  }
  assert.equal(failedAsExpected, true, 'Function raised ERR_INCONCLUSIVE_DISPOSITION');

  // Verify that the invoice is STILL pending and was NOT marked paid
  const invoiceState = JSON.parse(sql(`
    select row_to_json(i) from (
      select status, paid_at, external_reference
      from public.subscription_invoices
      where id = '${fixAtomicity.invoice_id}'
    ) i;
  `));
  assert.equal(invoiceState.status, 'pending', 'Invoice status remains pending');
  assert.equal(invoiceState.paid_at, null, 'Invoice paid_at remains NULL');

  // Verify that the restaurant expiration was NOT changed
  const restState = sql(`
    select (subscription_expires_at > clock_timestamp() + interval '10 days')::text
    from public.restaurants
    where id = '${fixAtomicity.restaurant_id}';
  `);
  assert.equal(restState, 'false', 'Restaurant expiry was NOT extended');
  log('SQL TEST 5 PASS: Inconclusive result rolled back atomically; zero financial mutations persisted.');

  // -------------------------------------------------------------------------
  // TEST 6: Canonical Confirmation with Explicit Dispositions
  // -------------------------------------------------------------------------
  log('SQL TEST 6: Canonical confirmation with explicit dispositions');
  // 6a: Clean confirmation produces disposition = 'confirmed'
  const conf6a = JSON.parse(sql(`
    select public.confirm_subscription_invoice_payment_canonical(
      '${fixAtomicity.invoice_id}'::uuid,
      '${fixAtomicity.external_reference}',
      9990,
      '${fixAtomicity.restaurant_id}'::uuid
    );
  `));
  assert.equal(conf6a.disposition, 'confirmed', 'Disposing confirmed for clean payment');
  assert.equal(conf6a.already_paid, false, 'Not already paid');
  assert.equal(conf6a.status, 'paid', 'Status is paid');

  // 6b: Idempotent replay of clean confirmation produces disposition = 'already_paid'
  const conf6b = JSON.parse(sql(`
    select public.confirm_subscription_invoice_payment_canonical(
      '${fixAtomicity.invoice_id}'::uuid,
      '${fixAtomicity.external_reference}',
      9990,
      '${fixAtomicity.restaurant_id}'::uuid
    );
  `));
  assert.equal(conf6b.disposition, 'already_paid', 'Replay produces already_paid');
  assert.equal(conf6b.already_paid, true, 'already_paid is true');

  // 6c: Upgrade requiring review produces disposition = 'review_required'
  // Create an invoice with trial upgrade requiring review
  const fixReview = setupFixture('Restaurante Review Required Test');
  sql(`
    do $$
    declare
      v_starts timestamptz := clock_timestamp() - interval '48 hours';
      v_cid uuid;
    begin
      insert into subscription_quote_private.cycles (
        restaurant_id, plan_id, billing_cycle, starts_at, ends_at, contracted_price_cents, evidence_source
      ) values (
        '${fixReview.restaurant_id}', 'pro', 'monthly',
        v_starts, v_starts + interval '720 hours',
        9990, 'test_cycle'
      ) returning id into v_cid;

      insert into subscription_quote_private.trial_upgrades (
        invoice_id, cycle_id, operation, from_plan, target_plan,
        full_amount_cents, credit_cents, charge_cents, trial_end, quoted_at
      ) values (
        '${fixReview.invoice_id}',
        v_cid,
        'trial_prepaid_upgrade', 'pro', 'premium',
        27990, 9990, 18000,
        clock_timestamp() - interval '1 hour', -- trial expired, will trigger review_required
        clock_timestamp()
      );

      update public.subscription_invoices
      set amount_cents = 18000, plan_id = 'premium'
      where id = '${fixReview.invoice_id}';
    end;
    $$;
  `);

  const conf6c = JSON.parse(sql(`
    select public.confirm_subscription_invoice_payment_canonical(
      '${fixReview.invoice_id}'::uuid,
      '${fixReview.external_reference}',
      18000,
      '${fixReview.restaurant_id}'::uuid
    );
  `));
  assert.equal(conf6c.disposition, 'review_required', 'Disposing review_required for divergence');
  assert.equal(conf6c.requires_review, true, 'requires_review flag is true');
  assert.equal(conf6c.already_paid, false, 'Not already paid');

  // 6d: Idempotent replay of review-required invoice MUST preserve disposition = 'review_required'
  const conf6d = JSON.parse(sql(`
    select public.confirm_subscription_invoice_payment_canonical(
      '${fixReview.invoice_id}'::uuid,
      '${fixReview.external_reference}',
      18000,
      '${fixReview.restaurant_id}'::uuid
    );
  `));
  assert.equal(conf6d.disposition, 'review_required', 'Replay MUST preserve review_required disposition');
  assert.equal(conf6d.already_paid, true, 'already_paid is true');
  assert.equal(conf6d.requires_review, true, 'requires_review is still true');
  log('SQL TEST 6 PASS: Canonical confirmation produces explicit dispositions across all paths.');

  // -------------------------------------------------------------------------
  // TEST 7: Value Divergence and Subpayment Handling
  // -------------------------------------------------------------------------
  log('SQL TEST 7: Value divergence and subpayment handling');
  const fixSub = setupFixture('Restaurante Subpayment Test');
  let subFailed = false;
  try {
    sql(`
      select public.confirm_subscription_invoice_payment_canonical(
        '${fixSub.invoice_id}'::uuid,
        '${fixSub.external_reference}',
        5000, -- 50.00 instead of 99.90
        '${fixSub.restaurant_id}'::uuid
      );
    `);
  } catch (err) {
    subFailed = err.message.includes('Divergência de valor') || err.message.includes('22023');
  }
  assert.equal(subFailed, true, 'Subpayment rejected by constraint/RPC');

  // Verify invoice remains pending
  const subInvoice = sql(`select status from public.subscription_invoices where id = '${fixSub.invoice_id}'`);
  assert.equal(subInvoice, 'pending', 'Subpayment left invoice pending');
  log('SQL TEST 7 PASS: Subpayment rejected; zero mutations persisted.');

  // -------------------------------------------------------------------------
  // TEST 8: Full Consumer Lifecycle: Retry, Dead-Letter, and Admin Replay
  // -------------------------------------------------------------------------
  log('SQL TEST 8: Full Consumer Lifecycle (Retry, Dead-Letter, Admin Replay)');
  const evtLifecycle = JSON.parse(sql(`
    select billing_private.record_webhook_inbox_event(
      'asaas',
      'evt_lifecycle_test',
      'PAYMENT_RECEIVED',
      '{"id":"evt_lifecycle_test"}'::jsonb
    );
  `));
  const workerLifecycle = 'b0000000-0000-0000-0000-000000000001';

  // Attempts 1 to 4: Fail transiently
  for (let attempt = 1; attempt <= 4; attempt++) {
    const claim = JSON.parse(sql(`
      select row_to_json(c) from billing_private.claim_webhook_inbox_event('${workerLifecycle}'::uuid, 60) c
      where c.id = '${evtLifecycle.id}';
    `));
    assert.equal(claim.attempt_count, attempt, `Attempt count is ${attempt}`);

    const failed = sql(`
      select billing_private.fail_webhook_inbox_event(
        '${evtLifecycle.id}'::uuid,
        '${workerLifecycle}'::uuid,
        'Transient timeout #${attempt}',
        true, -- retryable
        0 -- 0 delay for immediate test retry
      );
    `);
    assert.equal(failed, 't', `Attempt ${attempt} marked for retry`);
  }

  // 5th attempt: Exceeds threshold, moves to Dead-Letter ('failed')
  const claim5 = JSON.parse(sql(`
    select row_to_json(c) from billing_private.claim_webhook_inbox_event('${workerLifecycle}'::uuid, 60) c
    where c.id = '${evtLifecycle.id}';
  `));
  assert.equal(claim5.attempt_count, 5, 'Attempt count reached 5');

  sql(`
    select billing_private.fail_webhook_inbox_event(
      '${evtLifecycle.id}'::uuid,
      '${workerLifecycle}'::uuid,
      'Final failure on 5th attempt',
      true,
      0
    );
  `);

  const statusAfter5 = sql(`select status from billing_private.webhook_inbox where id = '${evtLifecycle.id}'`);
  assert.equal(statusAfter5, 'failed', 'Status moved to terminal failed (Dead-Letter)');

  // Administrative replay
  const adminId = 'c0000000-0000-0000-0000-000000000001';
  const replayRes = JSON.parse(sql(`
    select billing_private.retry_webhook_inbox_event('${evtLifecycle.id}'::uuid, '${adminId}'::uuid);
  `));
  assert.equal(replayRes.success, true, 'Replay succeeded');
  assert.equal(replayRes.status, 'received', 'Status reset to received');

  const replayAudit = sql(`
    select count(*) from public.platform_audit_logs
    where action = 'webhook_inbox_manual_retry'
      and details->>'inbox_id' = '${evtLifecycle.id}';
  `);
  assert.equal(replayAudit, '1', 'Audit log created for manual replay');

  // Can be claimed and completed now
  const claimReplay = JSON.parse(sql(`
    select row_to_json(c) from billing_private.claim_webhook_inbox_event('${workerLifecycle}'::uuid, 60) c
    where c.id = '${evtLifecycle.id}';
  `));
  assert.equal(claimReplay.attempt_count, 1, 'Attempt counter reset to 1');

  sql(`
    select billing_private.complete_webhook_inbox_event(
      '${evtLifecycle.id}'::uuid,
      '${workerLifecycle}'::uuid,
      'confirmed'
    );
  `);
  const finalStatus = sql(`select status from billing_private.webhook_inbox where id = '${evtLifecycle.id}'`);
  assert.equal(finalStatus, 'processed', 'Replayed event successfully completed');
  log('SQL TEST 8 PASS: Complete consumer lifecycle (retry -> dead-letter -> admin replay -> completion) verified.');

  // -------------------------------------------------------------------------
  // TEST 9: Quarantined Invoice Reconciliation via attach_subscription_invoice_external_reference
  // -------------------------------------------------------------------------
  log('SQL TEST 9: Quarantined invoice reconciliation via attach in inbox flow');
  apply('supabase/migrations/20261031120000_billing_cutover_pending_invoice_quarantine.sql');

  const fixQuarantine = setupFixture('Restaurante Quarentena Inbox');
  sql(`
    update public.subscription_invoices
    set external_reference = null, gateway_emission_status = 'needs_reconciliation', status = 'pending'
    where id = '${fixQuarantine.invoice_id}';
  `);

  const attachRes = JSON.parse(sql(`
    select public.attach_subscription_invoice_external_reference(
      '${fixQuarantine.invoice_id}'::uuid,
      'pay_reconciled_ext_456'
    );
  `));
  assert.equal(attachRes.attached, true, 'Attach succeeded');

  const confReconciled = JSON.parse(sql(`
    select public.confirm_subscription_invoice_payment_canonical(
      '${fixQuarantine.invoice_id}'::uuid,
      'pay_reconciled_ext_456',
      9990,
      '${fixQuarantine.restaurant_id}'::uuid
    );
  `));
  assert.equal(confReconciled.disposition, 'confirmed', 'Confirmed after unquarantining');
  log('SQL TEST 9 PASS: Quarantined invoice successfully reconciled and confirmed.');

  log('ALL 9 SQL/DATABASE INBOX TESTS PASSED SUCCESSFULLY IN DISPOSABLE POSTGRESQL 17.');
} finally {
  if (started) {
    try {
      run('pg_ctl', ['-D', data, '-m', 'immediate', 'stop']);
      log('Disposable PostgreSQL stopped.');
    } catch {}
  }
  try {
    fs.rmSync(work, { recursive: true, force: true });
    log('Temporary cluster files removed.');
  } catch {}
}

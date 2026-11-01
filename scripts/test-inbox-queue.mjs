import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';

console.log('=== TEST SUITE 1: Disposable PostgreSQL Queue Lifecycle & State Machine ===');

const benchDir = 'C:\\Users\\Anderson\\AppData\\Local\\Eloozi\\PrivateRestoreBench\\3d1bf2ea-a25f-4c8e-85a4-d0bd26fee92e';
const bin = path.join(benchDir, 'pgsql', 'bin');
const data = path.join(benchDir, 'data');
const serverLog = path.join(benchDir, 'server.log');

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith('PG')));
env.PGCONNECT_TIMEOUT = '5';
env.PGCLIENTENCODING = 'UTF8';
env.PGOPTIONS = '-c statement_timeout=60000 -c timezone=UTC -c lc_messages=C';

function runCmd(exe, args) {
  const isPgCtlStart = path.basename(exe).toLowerCase().startsWith('pg_ctl') && args.includes('start');
  const r = spawnSync(exe, args, {
    encoding: 'utf8',
    env,
    windowsHide: true,
    timeout: 120000,
    maxBuffer: 32 * 1024 * 1024,
    ...(isPgCtlStart ? { stdio: 'ignore' } : {})
  });
  return {
    stdout: (r.stdout ?? '').trim(),
    stderr: (r.stderr ?? '').trim(),
    status: r.status
  };
}

function sql(cmd, db = 'eloozi_consumer_test') {
  const r = runCmd(path.join(bin, 'psql.exe'), [
    '-X', '-q', '-w', '-h', '127.0.0.1', '-p', '55992', '-U', 'postgres', '-d', db,
    '-v', 'ON_ERROR_STOP=1', '-At', '-c', cmd
  ]);
  if (r.status !== 0) {
    throw new Error(`psql error: ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

function sqlFile(filePath, db = 'eloozi_consumer_test') {
  const r = runCmd(path.join(bin, 'psql.exe'), [
    '-X', '-q', '-w', '-h', '127.0.0.1', '-p', '55992', '-U', 'postgres', '-d', db,
    '-v', 'ON_ERROR_STOP=1', '-f', filePath
  ]);
  if (r.status !== 0) {
    throw new Error(`psql error: ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

let clusterStarted = false;
try {
  console.log('Starting local PostgreSQL cluster on isolated port 55992...');
  const startRes = runCmd(path.join(bin, 'pg_ctl.exe'), ['-D', data, '-l', serverLog, '-w', '-t', '25', 'start']);
  assert.equal(startRes.status, 0, 'Cluster failed to start');
  clusterStarted = true;

  // Prepare database eloozi_consumer_test
  const dbCheck = sql("select count(*) from pg_database where datname = 'eloozi_consumer_test'", 'postgres');
  if (dbCheck !== '0') {
    sql('drop database eloozi_consumer_test with (force)', 'postgres');
  }
  sql('create database eloozi_consumer_test', 'postgres');
  console.log('Created database eloozi_consumer_test.');

  // Create minimal required schema: vault, net, assert_trusted_billing_server, webhook_inbox, restaurants, subscription_invoices
  sql(`
    create schema if not exists vault;
    create table if not exists vault.decrypted_secrets (
      id uuid primary key default gen_random_uuid(),
      name text unique not null,
      decrypted_secret text not null
    );

    create schema if not exists net;
    create table if not exists net.http_request_queue (
      id bigserial primary key,
      url text not null,
      headers jsonb not null,
      body jsonb,
      timeout_milliseconds integer
    );

    create or replace function net.http_post(
      url text,
      headers jsonb default '{}'::jsonb,
      body jsonb default '{}'::jsonb,
      timeout_milliseconds integer default 5000
    ) returns bigint language plpgsql as $$
    declare v_id bigint;
    begin
      insert into net.http_request_queue (url, headers, body, timeout_milliseconds)
      values (url, headers, body, timeout_milliseconds) returning id into v_id;
      return v_id;
    end;
    $$;

    create schema if not exists billing_private;
    create or replace function public.assert_trusted_billing_server() returns void language plpgsql as $$ begin end; $$;

    create table public.restaurants (
      id uuid primary key,
      name text not null,
      max_tables integer not null default 10,
      subscription_expires_at timestamptz
    );

    create table public.subscription_invoices (
      id uuid primary key,
      restaurant_id uuid not null references public.restaurants(id),
      external_reference text,
      amount_cents integer not null,
      status text not null default 'pending',
      paid_at timestamptz,
      plan_id text not null default 'pro',
      billing_cycle text not null default 'monthly'
    );

    -- Mock canonical confirm_subscription_invoice_payment with requires_review simulation
    create or replace function public.confirm_subscription_invoice_payment(
      p_invoice_id uuid,
      p_external_reference text,
      p_paid_amount_cents integer,
      p_restaurant_id uuid
    ) returns jsonb language plpgsql as $$
    declare
      v_inv public.subscription_invoices;
    begin
      select * into v_inv from public.subscription_invoices where id = p_invoice_id for update;
      if not found then raise exception 'Fatura nao encontrada.' using errcode = 'P0002'; end if;
      if v_inv.restaurant_id <> p_restaurant_id then raise exception 'Restaurante incorreto.' using errcode = '42501'; end if;
      if v_inv.external_reference is distinct from p_external_reference then raise exception 'Referencia divergente.' using errcode = '22023'; end if;
      if v_inv.amount_cents <> p_paid_amount_cents then raise exception 'Valor divergente.' using errcode = '22023'; end if;

      -- Se a fatura simular divergencia de ciclo que exige revisao
      if v_inv.plan_id = 'requires_review_sim' then
        return jsonb_build_object(
          'success', false,
          'status', 'paid',
          'already_paid', false,
          'requires_review', true,
          'reason', 'Estado do ciclo mudou apos emissao. Exige reconciliacao manual.',
          'invoice_id', p_invoice_id
        );
      end if;

      update public.subscription_invoices
      set status = 'paid', paid_at = clock_timestamp()
      where id = p_invoice_id;

      return jsonb_build_object('success', true, 'status', 'paid', 'invoice_id', p_invoice_id);
    end;
    $$;

    create table billing_private.webhook_inbox (
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
      constraint uq_webhook_inbox_provider_event unique (provider, event_id)
    );
  `);

  // Apply migration
  const migrationPath = 'D:\\PROJETOS\\Elozi\\supabase\\migrations\\20261101140000_inbox_consumer_queue_infrastructure.sql';
  sqlFile(migrationPath);
  console.log('Applied migration 20261101140000_inbox_consumer_queue_infrastructure.sql successfully.');

  const worker1 = '00000000-0000-0000-0000-000000000001';
  const worker2 = '00000000-0000-0000-0000-000000000002';
  const restaurantId = '11111111-1111-1111-1111-111111111111';
  sql(`insert into public.restaurants (id, name) values ('${restaurantId}', 'Restaurante Teste');`);

  // -------------------------------------------------------------------------
  // TEST 1: Estado CONFIRMED -> status deve ser 'processed'
  // -------------------------------------------------------------------------
  const invConfirmed = '22222222-2222-2222-2222-222222222221';
  const payConfirmed = 'pay_confirmed_001';
  sql(`insert into public.subscription_invoices (id, restaurant_id, external_reference, amount_cents, status) values ('${invConfirmed}', '${restaurantId}', '${payConfirmed}', 9990, 'pending');`);

  const inboxConfirmedId = sql(`
    insert into billing_private.webhook_inbox (provider, event_id, event_type, payload, status)
    values ('asaas', 'evt_conf_1', 'PAYMENT_RECEIVED', '{"invoice_id": "${invConfirmed}", "external_reference": "${payConfirmed}"}'::jsonb, 'received')
    returning id;
  `);

  const claim1 = JSON.parse(sql(`select row_to_json(c) from billing_private.claim_webhook_inbox_event('${worker1}', 60) c;`));
  assert.equal(claim1.id, inboxConfirmedId);

  const res1 = JSON.parse(sql(`
    select billing_private.confirm_and_complete_inbox_payment(
      '${inboxConfirmedId}', '${worker1}', '${invConfirmed}', '${payConfirmed}', 9990, '${restaurantId}', 'confirmed'
    );
  `));
  assert.equal(res1.status, 'paid');

  const row1 = JSON.parse(sql(`select row_to_json(i) from billing_private.webhook_inbox i where id = '${inboxConfirmedId}';`));
  assert.equal(row1.status, 'processed', 'Confirmed event status must be processed');
  assert.equal(row1.disposition, 'confirmed', 'Confirmed event disposition must be confirmed');
  assert.equal(row1.claim_id, null, 'claim_id must be cleared');
  console.log('PASS (State 1/5): confirmed event transitions to status = processed.');

  // -------------------------------------------------------------------------
  // TEST 2: Estado REVIEW_REQUIRED -> status DEVE SER 'review_required', NUNCA 'processed'
  // -------------------------------------------------------------------------
  const invReview = '22222222-2222-2222-2222-222222222222';
  const payReview = 'pay_review_002';
  sql(`insert into public.subscription_invoices (id, restaurant_id, external_reference, amount_cents, status, plan_id) values ('${invReview}', '${restaurantId}', '${payReview}', 9990, 'pending', 'requires_review_sim');`);

  const inboxReviewId = sql(`
    insert into billing_private.webhook_inbox (provider, event_id, event_type, payload, status)
    values ('asaas', 'evt_rev_2', 'PAYMENT_RECEIVED', '{"invoice_id": "${invReview}", "external_reference": "${payReview}"}'::jsonb, 'received')
    returning id;
  `);

  const claim2 = JSON.parse(sql(`select row_to_json(c) from billing_private.claim_webhook_inbox_event('${worker1}', 60) c;`));
  assert.equal(claim2.id, inboxReviewId);

  const res2 = JSON.parse(sql(`
    select billing_private.confirm_and_complete_inbox_payment(
      '${inboxReviewId}', '${worker1}', '${invReview}', '${payReview}', 9990, '${restaurantId}', 'review_required'
    );
  `));
  assert.equal(res2.requires_review, true);

  const row2 = JSON.parse(sql(`select row_to_json(i) from billing_private.webhook_inbox i where id = '${inboxReviewId}';`));
  assert.equal(row2.status, 'review_required', 'review_required event MUST NOT terminate as processed!');
  assert.notEqual(row2.status, 'processed', 'review_required event CANNOT have status = processed');
  assert.equal(row2.disposition, 'review_required');
  assert.equal(row2.claim_id, null);
  console.log('PASS (State 2/5): review_required event transitions to status = review_required (NEVER processed).');

  // -------------------------------------------------------------------------
  // TEST 3: Falha Transitória -> status DEVE RETORNAR para 'received' com backoff
  // -------------------------------------------------------------------------
  const inboxTransientId = sql(`
    insert into billing_private.webhook_inbox (provider, event_id, event_type, payload, status)
    values ('asaas', 'evt_trans_3', 'PAYMENT_RECEIVED', '{}'::jsonb, 'received')
    returning id;
  `);

  const claim3 = JSON.parse(sql(`select row_to_json(c) from billing_private.claim_webhook_inbox_event('${worker1}', 60) c;`));
  assert.equal(claim3.id, inboxTransientId);
  assert.equal(claim3.attempt_count, 1);

  // Registra falha transitória com retryable = true
  const failTransient = sql(`
    select billing_private.fail_webhook_inbox_event('${inboxTransientId}', '${worker1}', 'Timeout temporario de gateway', true, 45);
  `);
  assert.equal(failTransient, 't');

  const row3 = JSON.parse(sql(`select row_to_json(i) from billing_private.webhook_inbox i where id = '${inboxTransientId}';`));
  assert.equal(row3.status, 'received', 'Transient failure must return to received');
  assert.equal(row3.attempt_count, 1, 'Attempt count must be retained');
  assert.notEqual(row3.next_retry_at, null, 'next_retry_at must be set');
  assert.equal(row3.claim_id, null, 'claim_id must be released');
  console.log('PASS (State 3/5): transient failure returns to status = received with backoff.');

  // -------------------------------------------------------------------------
  // TEST 4: Falha Permanente -> status DEVE SER 'failed' e disposition 'review_required'
  // -------------------------------------------------------------------------
  // Avança o relógio de retry
  sql(`update billing_private.webhook_inbox set next_retry_at = clock_timestamp() - interval '1 second' where id = '${inboxTransientId}';`);
  const claim4 = JSON.parse(sql(`select row_to_json(c) from billing_private.claim_webhook_inbox_event('${worker1}', 60) c;`));
  assert.equal(claim4.id, inboxTransientId);
  assert.equal(claim4.attempt_count, 2);

  // Registra falha permanente com retryable = false
  const failPermanent = sql(`
    select billing_private.fail_webhook_inbox_event('${inboxTransientId}', '${worker1}', 'Fatura cancelada no gateway', false);
  `);
  assert.equal(failPermanent, 't');

  const row4 = JSON.parse(sql(`select row_to_json(i) from billing_private.webhook_inbox i where id = '${inboxTransientId}';`));
  assert.equal(row4.status, 'failed', 'Permanent failure must set status = failed');
  assert.equal(row4.disposition, 'review_required', 'Permanent failure disposition must be review_required');
  assert.equal(row4.claim_id, null);
  console.log('PASS (State 4/5): permanent failure transitions to status = failed and disposition = review_required.');

  // -------------------------------------------------------------------------
  // TEST 5: Lease Expirado -> Reivindicação Concorrente e Varredura Exaurida
  // -------------------------------------------------------------------------
  // Caso 5A: Lease expirado com tentativa < 5 -> outro worker consegue reivindicar
  const inboxLeaseId = sql(`
    insert into billing_private.webhook_inbox (provider, event_id, event_type, payload, status)
    values ('asaas', 'evt_lease_5', 'PAYMENT_RECEIVED', '{}'::jsonb, 'received')
    returning id;
  `);

  // Worker 1 pega
  sql(`select row_to_json(c) from billing_private.claim_webhook_inbox_event('${worker1}', 60) c;`);
  // Força expiração do lease do worker 1
  sql(`update billing_private.webhook_inbox set lease_expires_at = clock_timestamp() - interval '10 seconds' where id = '${inboxLeaseId}';`);

  // Worker 2 consegue reivindicar porque lease expirou e attempts < 5
  const claim5B = JSON.parse(sql(`select row_to_json(c) from billing_private.claim_webhook_inbox_event('${worker2}', 60) c;`));
  assert.equal(claim5B.id, inboxLeaseId);
  assert.equal(claim5B.attempt_count, 2);

  // Caso 5B: Lease expirado com tentativa >= 5 -> varrido automaticamente para failed / review_required
  sql(`
    update billing_private.webhook_inbox
    set attempt_count = 5,
        lease_expires_at = clock_timestamp() - interval '10 seconds'
    where id = '${inboxLeaseId}';
  `);

  // Próximo claim de qualquer worker dispara o sweep
  sql(`select count(*) from billing_private.claim_webhook_inbox_event('${worker1}', 60);`);

  const row5Swept = JSON.parse(sql(`select row_to_json(i) from billing_private.webhook_inbox i where id = '${inboxLeaseId}';`));
  assert.equal(row5Swept.status, 'failed', 'Exhausted expired event must be swept to failed');
  assert.equal(row5Swept.disposition, 'review_required', 'Exhausted expired event must be review_required');
  assert.equal(row5Swept.claim_id, null);
  console.log('PASS (State 5/5): expired lease with attempts < 5 is re-claimed; with >= 5 is swept to failed/review_required.');

} finally {
  if (clusterStarted) {
    console.log('Stopping local PostgreSQL cluster...');
    runCmd(path.join(bin, 'pg_ctl.exe'), ['-D', data, '-m', 'immediate', 'stop']);
    console.log('Stopped local PostgreSQL cluster.');
  }
}

console.log('=== QUEUE LIFECYCLE & STATE MACHINE TESTS COMPLETED SUCCESSFULLY ===');

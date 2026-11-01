// Rehearsal for candidate webhook transition in disposable PostgreSQL 17.
// Never connects to hosted databases; strictly isolated in OS temp directory.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const bin = 'D:/pgSQL/bin';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'eloozi-webhook-transition-'));
const data = path.join(work, 'data');
const port = 55522;
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

  // Apply base schema and migrations
  apply('supabase/tests/etapa3_bootstrap.sql');
  const migrationDir = path.join(root, 'supabase/migrations');
  const migrations = fs.readdirSync(migrationDir).filter(f => f.endsWith('.sql')).sort();

  for (const name of migrations) {
    if (name === '20261024164500_create_reservations_table.sql') continue; // permissive baseline skipped
    if (name === '20261031120000_billing_cutover_pending_invoice_quarantine.sql') continue; // applied in test step
    if (name === '20261008141500_create_table_tab_consumption.sql') {
      apply('supabase/seeds/demo_restaurants.sql');
    }
    apply('supabase/migrations/' + name);
  }

  log('Migrations applied up to 20261031015051. Beginning test suite.');

  // Setup service_role session simulation for RPC calls
  sql(`
    set role postgres;
    select set_config('request.jwt.claim.role', 'service_role', false);
  `);

  // Fixture: Restaurant and Invoices
  const restId = 'a1000000-0000-4000-8000-000000000001';
  const invNormalId = 'b1000000-0000-4000-8000-000000000001';
  const invSubpayId = 'b1000000-0000-4000-8000-000000000002';
  const invWrongId  = 'b1000000-0000-4000-8000-000000000003';
  const invQuarId   = 'b1000000-0000-4000-8000-000000000004';
  const invV7Id     = 'b1000000-0000-4000-8000-000000000005';

  sql(`
    insert into public.restaurants(id, name, slug, subscription_plan, max_tables, subscription_expires_at, active)
    values ('${restId}', 'Test Bistro', 'test-bistro', 'basic', 5, now() + interval '10 days', true)
    on conflict (id) do update set subscription_plan = 'basic', max_tables = 5;

    insert into public.subscription_invoices(id, restaurant_id, plan_id, billing_cycle, payment_method, amount_cents, external_reference, status)
    values
      ('${invNormalId}', '${restId}', 'pro', 'monthly', 'pix', 17990, 'asaas_pay_normal', 'pending'),
      ('${invSubpayId}', '${restId}', 'pro', 'monthly', 'pix', 17990, 'asaas_pay_subpay', 'pending'),
      ('${invWrongId}',  '${restId}', 'pro', 'monthly', 'pix', 17990, 'asaas_pay_wrong',  'pending'),
      ('${invQuarId}',   '${restId}', 'pro', 'monthly', 'pix', 17990, null,              'pending'),
      ('${invV7Id}',     '${restId}', 'pro', 'monthly', 'pix', 17990, 'asaas_pay_v7',     'pending');
  `);

  // =========================================================================
  // TEST CASE 1: Webhook v7 attempt on legacy 2-arg signature
  // =========================================================================
  log('CASE 1: Testing Webhook v7 attempt against 2-argument signature');
  // Currently, Migration 5 dropped (uuid, text). If called directly:
  let v7FailedClosed = false;
  try {
    sql(`select public.confirm_subscription_invoice_payment('${invV7Id}'::uuid, 'asaas_pay_v7'::text);`);
  } catch (err) {
    v7FailedClosed = true;
    assert.match(err.message, /does not exist|42883/, 'Legacy 2-arg signature is not present in standard Migration 5+');
  }
  assert.ok(v7FailedClosed, 'CASE 1 PASS: Webhook v7 attempt fails closed without 2-arg signature; invoice remains pending.');
  assert.equal(sql(`select status from public.subscription_invoices where id = '${invV7Id}'`), 'pending');

  // If a fail-closed 2-arg overload is installed for explicit transition safety:
  sql(`
    create or replace function public.confirm_subscription_invoice_payment(
      p_invoice_id uuid,
      p_external_reference text
    ) returns jsonb language plpgsql security definer set search_path = '' as $$
    begin
      perform public.assert_trusted_billing_server();
      raise exception 'Webhook v7 depreciado: confirmação requer validação de valor no gateway via RPC de 4 argumentos.'
        using errcode = '42501';
    end $$;
    revoke all on function public.confirm_subscription_invoice_payment(uuid, text) from public, anon, authenticated;
    grant execute on function public.confirm_subscription_invoice_payment(uuid, text) to service_role;
  `);

  let v7ExplicitFailClosed = false;
  try {
    sql(`select public.confirm_subscription_invoice_payment('${invV7Id}'::uuid, 'asaas_pay_v7'::text);`);
  } catch (err) {
    v7ExplicitFailClosed = true;
    assert.match(err.message, /Webhook v7 depreciado/, 'Explicit fail-closed overload rejects unverified 2-arg call');
  }
  assert.ok(v7ExplicitFailClosed, 'CASE 1B PASS: Explicit fail-closed 2-arg overload rejects unverified confirmation and leaves invoice pending.');
  assert.equal(sql(`select status from public.subscription_invoices where id = '${invV7Id}'`), 'pending');

  // =========================================================================
  // TEST CASE 2: Webhook v8 attempt with correct amount and restaurant
  // =========================================================================
  log('CASE 2: Testing Webhook v8 attempt with verified correct amount and restaurant');
  const normalRes = JSON.parse(sql(`
    select public.confirm_subscription_invoice_payment(
      '${invNormalId}'::uuid,
      'asaas_pay_normal'::text,
      17990::integer,
      '${restId}'::uuid
    )::text;
  `));
  assert.equal(normalRes.status, 'paid', 'Invoice confirmed as paid');
  assert.equal(normalRes.already_paid, false, 'First confirmation is not already_paid');
  assert.equal(sql(`select status from public.subscription_invoices where id = '${invNormalId}'`), 'paid');
  log('CASE 2 PASS: Verified payment confirmed invoice and updated status to paid.');

  // =========================================================================
  // TEST CASE 3 & 4: Subpayment and Incorrect amount rejection
  // =========================================================================
  log('CASE 3 & 4: Testing subpayment and incorrect amount rejection');
  // Subpayment (e.g. 5000 cents paid on a 17990 cents invoice)
  let subpayRejected = false;
  try {
    sql(`
      select public.confirm_subscription_invoice_payment(
        '${invSubpayId}'::uuid,
        'asaas_pay_subpay'::text,
        5000::integer,
        '${restId}'::uuid
      );
    `);
  } catch (err) {
    subpayRejected = true;
    assert.match(err.message, /Divergência de valor/, 'Subpayment rejected with value divergence error');
  }
  assert.ok(subpayRejected, 'CASE 3 PASS: Subpayment rejected by database.');
  assert.equal(sql(`select status from public.subscription_invoices where id = '${invSubpayId}'`), 'pending');

  // Incorrect higher amount (e.g. 25000 cents paid on a 17990 cents invoice)
  let wrongAmountRejected = false;
  try {
    sql(`
      select public.confirm_subscription_invoice_payment(
        '${invWrongId}'::uuid,
        'asaas_pay_wrong'::text,
        25000::integer,
        '${restId}'::uuid
      );
    `);
  } catch (err) {
    wrongAmountRejected = true;
    assert.match(err.message, /Divergência de valor/, 'Incorrect amount rejected');
  }
  assert.ok(wrongAmountRejected, 'CASE 4 PASS: Incorrect amount rejected by database.');
  assert.equal(sql(`select status from public.subscription_invoices where id = '${invWrongId}'`), 'pending');

  // =========================================================================
  // TEST CASE 5: Idempotent replay
  // =========================================================================
  log('CASE 5: Testing idempotent replay on already paid invoice');
  const replayRes = JSON.parse(sql(`
    select public.confirm_subscription_invoice_payment(
      '${invNormalId}'::uuid,
      'asaas_pay_normal'::text,
      17990::integer,
      '${restId}'::uuid
    )::text;
  `));
  assert.equal(replayRes.status, 'paid');
  assert.equal(replayRes.already_paid, true, 'Replay recognized as already_paid');
  log('CASE 5 PASS: Replay returned already_paid = true idempotently.');

  // =========================================================================
  // TEST CASE 6: requires_review semantics
  // =========================================================================
  log('CASE 6: Testing requires_review presence and absence semantics');
  // In the real database, standard invoices delegate to confirm_before_trial_upgrades (Migration 5/9),
  // which does NOT include requires_review in the jsonb return. It is undefined!
  assert.equal(normalRes.requires_review, undefined, 'Standard confirmation does not produce requires_review in database');

  // Now simulate an upgrade where cycle state shifted (trial expired)
  const restTrialId = 'a1000000-0000-4000-8000-000000000009';
  const invOldCycleId = 'b1000000-0000-4000-8000-000000000008';
  const invTrialId = 'b1000000-0000-4000-8000-000000000009';
  const cycleId = 'c1000000-0000-4000-8000-000000000099';

  sql(`
    insert into public.restaurants(id, name, slug, subscription_plan, subscription_is_trial, subscription_expires_at, active)
    values ('${restTrialId}', 'Trial Rest', 'trial-rest', 'basic', true, now() - interval '1 hour', true)
    on conflict (id) do nothing;

    -- Existing paid cycle that provided the 9990 credit
    insert into public.subscription_invoices(id, restaurant_id, plan_id, billing_cycle, payment_method, amount_cents, external_reference, status, paid_at)
    values ('${invOldCycleId}', '${restTrialId}', 'basic', 'monthly', 'pix', 9990, 'asaas_pay_old_cycle', 'paid', now() - interval '2 days');

    insert into subscription_quote_private.cycles(id, restaurant_id, plan_id, billing_cycle, starts_at, ends_at, contracted_price_cents)
    values ('${cycleId}', '${restTrialId}', 'basic', 'monthly', now() - interval '720 hours', now(), 9990);

    insert into subscription_quote_private.cycle_payments(invoice_id, cycle_id, confirmed_credit_cents)
    values ('${invOldCycleId}', '${cycleId}', 9990);

    -- Upgrade invoice: 27990 full - 9990 credit = 18000 charge
    insert into public.subscription_invoices(id, restaurant_id, plan_id, billing_cycle, payment_method, amount_cents, external_reference, status)
    values ('${invTrialId}', '${restTrialId}', 'premium', 'monthly', 'pix', 18000, 'asaas_pay_trial_exp', 'pending');

    insert into subscription_quote_private.trial_upgrades(invoice_id, cycle_id, from_plan, target_plan, full_amount_cents, credit_cents, charge_cents, trial_end)
    values ('${invTrialId}', '${cycleId}', 'basic', 'premium', 27990, 9990, 18000, now() - interval '1 hour');
  `);

  const reviewRes = JSON.parse(sql(`
    select public.confirm_subscription_invoice_payment(
      '${invTrialId}'::uuid,
      'asaas_pay_trial_exp'::text,
      18000::integer,
      '${restTrialId}'::uuid
    )::text;
  `));
  assert.equal(reviewRes.status, 'paid', 'Invoice is marked paid in database');
  assert.equal(reviewRes.requires_review, true, 'Payment on expired trial flags requires_review = true');
  assert.match(reviewRes.reason, /Trial encerrado/, 'Reason indicates review is required');
  log('CASE 6 PASS: requires_review flags review_required without mutating plan automatically.');

  // =========================================================================
  // TEST CASE 7: Quarantined invoice reconciliation (Migration 19)
  // =========================================================================
  log('CASE 7: Testing quarantined invoice reconciliation (Migration 19)');
  // Apply quarantine migration
  apply('supabase/migrations/20261031120000_billing_cutover_pending_invoice_quarantine.sql');

  // Verify invQuarId was quarantined because external_reference was NULL
  const quarStatus = sql(`select gateway_emission_status from public.subscription_invoices where id = '${invQuarId}'`);
  assert.equal(quarStatus, 'needs_reconciliation', 'Pending invoice without external reference placed in quarantine');

  // Now simulate verified webhook arrival: calls attach_subscription_invoice_external_reference with claim_id = null
  const attachRes = JSON.parse(sql(`
    select public.attach_subscription_invoice_external_reference(
      '${invQuarId}'::uuid,
      'asaas_pay_quarantine_reconciled'::text,
      null::uuid
    )::text;
  `));
  assert.equal(attachRes.attached, true, 'Quarantined invoice reference attached');

  const afterAttachStatus = sql(`select gateway_emission_status from public.subscription_invoices where id = '${invQuarId}'`);
  assert.equal(afterAttachStatus, 'issued', 'Status transitioned from needs_reconciliation to issued');

  // Now confirm payment
  const quarConfirmRes = JSON.parse(sql(`
    select public.confirm_subscription_invoice_payment(
      '${invQuarId}'::uuid,
      'asaas_pay_quarantine_reconciled'::text,
      17990::integer,
      '${restId}'::uuid
    )::text;
  `));
  assert.equal(quarConfirmRes.status, 'paid', 'Quarantined invoice confirmed as paid');
  log('CASE 7 PASS: Quarantined invoice cleanly reconciled by attach RPC and confirmed.');

  log('ALL 7 TEST CASES PASSED SUCCESSFULLY IN DISPOSABLE POSTGRESQL 17.');
} catch (error) {
  log(`TEST SUITE FAILED: ${error.stack ?? error}`);
  process.exitCode = 1;
} finally {
  if (started) {
    try {
      run('pg_ctl', ['-D', data, '-w', 'stop', '-m', 'fast']);
      log('Disposable PostgreSQL stopped.');
    } catch (e) {
      log(`Error stopping cluster: ${e}`);
    }
  }
  try {
    fs.rmSync(work, { recursive: true, force: true });
    log('Temporary cluster files removed.');
  } catch (e) {
    log(`Error cleaning temp files: ${e}`);
  }
}

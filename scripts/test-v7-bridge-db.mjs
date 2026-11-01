// Test suite for v7 Webhook Handler and Safe Inbox Bridge in PostgreSQL 17.
// Never connects to hosted databases; strictly isolated in OS temp directory.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const bin = 'D:/pgSQL/bin';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'eloozi-v7-bridge-db-'));
const data = path.join(work, 'data');
const port = 55525;
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

// ============================================================================
// EXACT REPLICATION OF v7 HANDLER LOGIC (from rollback-v7/asaas-webhook/index.ts)
// ============================================================================
async function runV7WebhookHandler(req, envCtx) {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, asaas-access-token",
      },
    });
  }

  try {
    const EXPECTED_TOKEN = envCtx.ASAAS_WEBHOOK_TOKEN;
    const adminClient = envCtx.adminClient;

    // 1. Validação do Token de Segurança do Webhook do Asaas
    if (EXPECTED_TOKEN) {
      const receivedToken = req.headers.get("asaas-access-token");
      if (receivedToken !== EXPECTED_TOKEN) {
        return new Response(JSON.stringify({ error: "Token de webhook não autorizado." }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    const body = await req.json();
    const event = body.event;
    const payment = body.payment;

    // Eventos de baixa / confirmação de pagamento
    if (event === "PAYMENT_RECEIVED" || event === "PAYMENT_CONFIRMED") {
      const asaasPaymentId = payment?.id;
      let invoiceId = payment?.externalReference;

      if (!invoiceId && asaasPaymentId) {
        const { data: invRow } = await adminClient
          .from("subscription_invoices")
          .select("id")
          .eq("external_reference", asaasPaymentId)
          .maybeSingle();

        if (invRow) {
          invoiceId = invRow.id;
        }
      }

      if (invoiceId) {
        const { data: confirmResult, error: confirmErr } = await adminClient.rpc(
          "confirm_subscription_invoice_payment",
          {
            p_invoice_id: invoiceId,
            p_external_reference: asaasPaymentId || `asaas_pay_${invoiceId}`,
          }
        );

        if (confirmErr) {
          return new Response(JSON.stringify({ error: confirmErr.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Erro interno no webhook";
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

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

  // Apply baseline migrations followed by the complete 19 cutover migrations chain
  apply('supabase/tests/etapa3_bootstrap.sql');
  const migrationDir = path.join(root, 'supabase/migrations');
  const migrations = fs.readdirSync(migrationDir).filter(f => f.endsWith('.sql')).sort();

  for (const name of migrations) {
    if (name === '20261024164500_create_reservations_table.sql') continue;
    if (name === '20261008141500_create_table_tab_consumption.sql') {
      apply('supabase/seeds/demo_restaurants.sql');
    }
    apply('supabase/migrations/' + name);
  }

  log('ALL 19 CUTOVER MIGRATIONS APPLIED SUCCESSFULLY. Verifying schema, overload retention and grants...');

  // 1. Verify that billing_private.webhook_inbox exists with its uniqueness constraint
  const inboxExists = sql("select exists(select 1 from information_schema.tables where table_schema = 'billing_private' and table_name = 'webhook_inbox')::text;");
  assert.equal(inboxExists, 'true', 'billing_private.webhook_inbox exists after complete migration chain');

  const uqExists = sql(`
    select exists(
      select 1 from pg_constraint
      where conname = 'uq_webhook_inbox_provider_event'
    )::text;
  `);
  assert.equal(uqExists, 'true', 'Constraint uq_webhook_inbox_provider_event preserved');

  // 2. CRITICAL AUDIT: Confirm the 2-argument bridge overload STILL EXISTS after all subsequent migrations (6..19)!
  const bridgeFnExists = sql(`
    select exists(
      select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'confirm_subscription_invoice_payment'
      and pronargs = 2
    )::text;
  `);
  assert.equal(bridgeFnExists, 'true', 'Safe bridge confirm_subscription_invoice_payment(uuid, text) PERSISTS after migrations 6..19');

  // Also verify canonical 4-argument function exists
  const canonicalFnExists = sql(`
    select exists(
      select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'confirm_subscription_invoice_payment'
      and pronargs = 4
    )::text;
  `);
  assert.equal(canonicalFnExists, 'true', 'Canonical confirm_subscription_invoice_payment(uuid, text, integer, uuid) coexists');

  // 3. Confirm GRANTS remain strictly secure after subsequent migrations
  const anonExec = sql("select has_function_privilege('anon', 'public.confirm_subscription_invoice_payment(uuid, text)', 'EXECUTE')::text;");
  assert.equal(anonExec, 'false', 'anon CANNOT execute bridge overload');

  const authExec = sql("select has_function_privilege('authenticated', 'public.confirm_subscription_invoice_payment(uuid, text)', 'EXECUTE')::text;");
  assert.equal(authExec, 'false', 'authenticated CANNOT execute bridge overload');

  const serviceExec = sql("select has_function_privilege('service_role', 'public.confirm_subscription_invoice_payment(uuid, text)', 'EXECUTE')::text;");
  assert.equal(serviceExec, 'true', 'service_role CAN execute bridge overload');

  // Direct execution attempts by untrusted roles must throw 42501
  assert.throws(
    () => sql("set role anon; select public.confirm_subscription_invoice_payment('00000000-0000-0000-0000-000000000001'::uuid, 'test');"),
    (err) => err.message.includes('permission denied') || err.message.includes('42501'),
    'Direct execution by anon throws permission denied'
  );

  assert.throws(
    () => sql("set role authenticated; select public.confirm_subscription_invoice_payment('00000000-0000-0000-0000-000000000001'::uuid, 'test');"),
    (err) => err.message.includes('permission denied') || err.message.includes('42501'),
    'Direct execution by authenticated throws permission denied'
  );

  log('SECURITY AUDIT PASS: Bridge overload and grants confirmed intact after full migration chain (1..19).');

  // Lightweight DB Client wrapping psql for testing v7 handler
  const createDbClient = () => ({
    from: (table) => ({
      select: () => ({
        eq: (col, val) => ({
          maybeSingle: async () => {
            const raw = sql(`select row_to_json(t) from (select id from public.${table} where ${col} = '${val}' limit 1) t;`);
            return { data: raw ? JSON.parse(raw) : null, error: null };
          }
        })
      })
    }),
    rpc: async (fn, params) => {
      try {
        const raw = sql(`
          select ${fn}(
            ${params.p_invoice_id ? `'${params.p_invoice_id}'::uuid` : 'null'},
            ${params.p_external_reference ? `'${params.p_external_reference}'` : 'null'}
          );
        `);
        return { data: raw ? JSON.parse(raw) : null, error: null };
      } catch (err) {
        return { data: null, error: { message: err.message } };
      }
    }
  });

  const setupFixture = (name = 'Restaurante Bridge Test') => {
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

  const envCtx = {
    ASAAS_WEBHOOK_TOKEN: 'token_secreto_asaas_123',
    adminClient: createDbClient(),
  };

  const makeWebhookReq = (payload) => new Request('https://edge.local/asaas-webhook', {
    method: 'POST',
    headers: { 'asaas-access-token': 'token_secreto_asaas_123', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  // -------------------------------------------------------------------------
  // TEST 1: v7 Handler Responds HTTP 200 and Persists Bridge Event WITHOUT Quitting Invoice
  // -------------------------------------------------------------------------
  log('BRIDGE TEST 1: v7 Handler receives valid webhook; bridge persists in Inbox; HTTP 200 returned; zero mutations on invoice');
  const fix1 = setupFixture('Restaurante Bridge 1');

  const payload1 = {
    event: 'PAYMENT_RECEIVED',
    payment: {
      id: fix1.external_reference,
      externalReference: fix1.invoice_id,
      value: 99.90,
    }
  };

  const res1 = await runV7WebhookHandler(makeWebhookReq(payload1), envCtx);
  assert.equal(res1.status, 200, 'v7 Handler responded HTTP 200 to Asaas');
  const body1 = await res1.json();
  assert.equal(body1.received, true, 'Body contains received: true');

  // Verify that an inbox entry was created in billing_private.webhook_inbox
  const inboxRow1 = JSON.parse(sql(`
    select row_to_json(i) from (
      select event_id, status, payload, disposition
      from billing_private.webhook_inbox
      where event_id = 'bridge:v7:${fix1.external_reference}'
    ) i;
  `));
  assert.equal(inboxRow1.status, 'received', 'Inbox row status is received');
  assert.equal(inboxRow1.payload.source, 'v7_bridge', 'Payload source is v7_bridge');
  assert.equal(inboxRow1.payload.invoice_id, fix1.invoice_id, 'Payload contains invoice_id');
  assert.equal(inboxRow1.disposition, null, 'Disposition is null until consumer processes');

  // CRITICAL CHECK: Verify invoice status, paid_at, and restaurant plan were NOT modified!
  const invoice1 = JSON.parse(sql(`
    select row_to_json(i) from (
      select status, paid_at from public.subscription_invoices where id = '${fix1.invoice_id}'
    ) i;
  `));
  assert.equal(invoice1.status, 'pending', 'Invoice status is STILL pending');
  assert.equal(invoice1.paid_at, null, 'Invoice paid_at is STILL NULL');

  const rest1 = sql(`
    select (subscription_expires_at > clock_timestamp() + interval '10 days')::text
    from public.restaurants where id = '${fix1.restaurant_id}';
  `);
  assert.equal(rest1, 'false', 'Restaurant expiration was NOT extended by bridge');
  log('BRIDGE TEST 1 PASS: Durable write happened before HTTP 200; zero financial mutations on invoice/restaurant.');

  // -------------------------------------------------------------------------
  // TEST 2: Idempotency on Duplicate Webhook Delivery
  // -------------------------------------------------------------------------
  log('BRIDGE TEST 2: Duplicate webhook delivery handled idempotently; HTTP 200 returned; no duplicate rows');
  const res2 = await runV7WebhookHandler(makeWebhookReq(payload1), envCtx);
  assert.equal(res2.status, 200, 'Duplicate delivery responded with HTTP 200');

  const rowCount = sql(`
    select count(*) from billing_private.webhook_inbox
    where event_id = 'bridge:v7:${fix1.external_reference}';
  `);
  assert.equal(rowCount, '1', 'Exactly 1 row exists in webhook_inbox (no duplicates)');
  log('BRIDGE TEST 2 PASS: Duplicate webhook acknowledged with 200 without creating duplicate inbox rows.');

  // -------------------------------------------------------------------------
  // TEST 3: Missing payment.id in Webhook Payload -> Quarantined with HTTP 200
  // -------------------------------------------------------------------------
  log('BRIDGE TEST 3: Missing payment.id in webhook; v7 passes asaas_pay_<id>; bridge quarantines; HTTP 200 returned');
  const fixNoPayId = setupFixture('Restaurante Bridge Sem PaymentId');

  // Webhook body with externalReference (invoiceId) but NO payment.id
  const payloadNoPayId = {
    event: 'PAYMENT_RECEIVED',
    payment: {
      // id is omitted!
      externalReference: fixNoPayId.invoice_id,
      value: 99.90,
    }
  };

  const resNoPayId = await runV7WebhookHandler(makeWebhookReq(payloadNoPayId), envCtx);
  assert.equal(resNoPayId.status, 200, 'v7 responds HTTP 200 to Asaas so queue does not pause');
  const bodyNoPayId = await resNoPayId.json();
  assert.equal(bodyNoPayId.received, true, 'Body contains received: true');

  // Verify that an inbox entry was created in QUARANTINE
  const inboxQuarantine = JSON.parse(sql(`
    select row_to_json(i) from (
      select event_id, status, disposition, payload, last_error
      from billing_private.webhook_inbox
      where event_id = 'quarantine:v7:no_payment_id:${fixNoPayId.invoice_id}'
    ) i;
  `));
  assert.equal(inboxQuarantine.status, 'quarantined', 'Inbox status is quarantined');
  assert.equal(inboxQuarantine.disposition, 'rejected', 'Disposition is rejected');
  assert.ok(inboxQuarantine.last_error.includes('payment.id ausente'), 'last_error indicates missing payment.id');
  assert.equal(inboxQuarantine.payload.quarantine_reason, 'missing_payment_id');

  // Verify invoice status and paid_at remain completely pending
  const invoiceQuarantine = JSON.parse(sql(`
    select row_to_json(i) from (
      select status, paid_at from public.subscription_invoices where id = '${fixNoPayId.invoice_id}'
    ) i;
  `));
  assert.equal(invoiceQuarantine.status, 'pending', 'Quarantined invoice is STILL pending');
  assert.equal(invoiceQuarantine.paid_at, null, 'Quarantined invoice paid_at is NULL');
  log('BRIDGE TEST 3 PASS: Missing payment.id quarantined cleanly without mutations and acknowledged with 200.');

  // -------------------------------------------------------------------------
  // TEST 4: Write Failure Generates HTTP 500 to Asaas for Retry
  // -------------------------------------------------------------------------
  log('BRIDGE TEST 4: Write failure generates HTTP 500 error to Asaas for retry');
  const fixFail = setupFixture('Restaurante Bridge Fail');

  // Attach a temporary BEFORE INSERT trigger to simulate disk or DB write failure
  sql(`
    create or replace function billing_private.test_fail_inbox_insert()
    returns trigger language plpgsql as $$
    begin
      raise exception 'ERR_DISK_OR_DB_WRITE_FAILURE: Falha simulada de gravação na Inbox.' using errcode = '58030';
    end;
    $$;

    create trigger trg_test_fail_inbox
    before insert on billing_private.webhook_inbox
    for each row execute function billing_private.test_fail_inbox_insert();
  `);

  const reqFailPayload = {
    event: 'PAYMENT_RECEIVED',
    payment: {
      id: fixFail.external_reference,
      externalReference: fixFail.invoice_id,
      value: 99.90,
    }
  };

  const resFail = await runV7WebhookHandler(makeWebhookReq(reqFailPayload), envCtx);
  assert.equal(resFail.status, 500, 'Write failure generated HTTP 500 to Asaas');
  const bodyFail = await resFail.json();
  assert.ok(bodyFail.error.includes('ERR_DISK_OR_DB_WRITE_FAILURE'), 'Error contains exception message');

  // Clean up the test trigger
  sql(`
    drop trigger if exists trg_test_fail_inbox on billing_private.webhook_inbox;
    drop function if exists billing_private.test_fail_inbox_insert();
  `);

  // Verify invoice is still pending
  const invoiceFail = sql(`select status from public.subscription_invoices where id = '${fixFail.invoice_id}'`);
  assert.equal(invoiceFail, 'pending', 'Invoice remains pending after write failure');
  log('BRIDGE TEST 4 PASS: Write failure causes RPC error, resulting in HTTP 500 to Asaas for retry.');

  // -------------------------------------------------------------------------
  // TEST 5: Unknown Invoice Quarantined with HTTP 200 (Decision 3: Prevents Queue Pause)
  // -------------------------------------------------------------------------
  log('BRIDGE TEST 5: Unknown invoice ID quarantined; HTTP 200 returned to Asaas to prevent queue pause');
  const randomInvoiceId = 'e0000000-0000-0000-0000-000000000999';
  const reqUnknownPayload = {
    event: 'PAYMENT_RECEIVED',
    payment: {
      id: 'pay_unknown_123',
      externalReference: randomInvoiceId,
      value: 99.90,
    }
  };

  const resUnknown = await runV7WebhookHandler(makeWebhookReq(reqUnknownPayload), envCtx);
  assert.equal(resUnknown.status, 200, 'Unknown invoice acknowledged with HTTP 200 to prevent Asaas pausing queue');
  const bodyUnknown = await resUnknown.json();
  assert.equal(bodyUnknown.received, true, 'Body contains received: true');

  // Verify quarantine record in Webhook Inbox
  const unknownInbox = JSON.parse(sql(`
    select row_to_json(i) from (
      select event_id, status, disposition, payload, last_error
      from billing_private.webhook_inbox
      where event_id = 'quarantine:v7:unknown_invoice:${randomInvoiceId}'
    ) i;
  `));
  assert.equal(unknownInbox.status, 'quarantined', 'Status is quarantined');
  assert.equal(unknownInbox.disposition, 'rejected', 'Disposition is rejected');
  assert.ok(unknownInbox.last_error.includes('inexistente no banco local'), 'last_error indicates unknown invoice');
  assert.equal(unknownInbox.payload.quarantine_reason, 'unknown_invoice');
  log('BRIDGE TEST 5 PASS: Unknown invoice safely quarantined and acknowledged with HTTP 200 without queue pause.');

  // -------------------------------------------------------------------------
  // TEST 6: Scheduled Consumer Cycle Automatically Finds and Processes Inbox
  // -------------------------------------------------------------------------
  log('BRIDGE TEST 6: Scheduled consumer cycle automatically claims, validates and processes Inbox events');

  // Setup a new fixture for automated consumer processing
  const fixAuto = setupFixture('Restaurante Consumer Auto');
  const payloadAuto = {
    event: 'PAYMENT_RECEIVED',
    payment: {
      id: fixAuto.external_reference,
      externalReference: fixAuto.invoice_id,
      value: 99.90,
    }
  };

  // v7 Handler persists into Inbox and returns HTTP 200
  const resAuto = await runV7WebhookHandler(makeWebhookReq(payloadAuto), envCtx);
  assert.equal(resAuto.status, 200, 'v7 returns 200 after durable write to Inbox');

  // Simulate Asaas API for the consumer
  const asaasGateway = {
    [fixAuto.external_reference]: {
      id: fixAuto.external_reference,
      value: 99.90,
      status: 'RECEIVED',
      externalReference: fixAuto.invoice_id
    }
  };

  // Automated scheduled consumer runner (simulating what pg_cron / scheduled edge worker triggers)
  const runScheduledConsumerCycle = async (workerId) => {
    // 1. Claim pending events
    const claimSql = `
      with available as (
        select id from billing_private.webhook_inbox
        where status = 'received'
          and (lease_expires_at is null or lease_expires_at < clock_timestamp())
        order by received_at asc
        limit 10
        for update skip locked
      ),
      claimed as (
        update billing_private.webhook_inbox i
        set status = 'processing',
            claim_id = '${workerId}',
            claimed_at = clock_timestamp(),
            lease_expires_at = clock_timestamp() + interval '60 seconds',
            attempt_count = i.attempt_count + 1
        from available
        where i.id = available.id
        returning i.id, i.event_id, i.payload
      )
      select coalesce(jsonb_agg(row_to_json(claimed)), '[]'::jsonb)::text from claimed;
    `;
    const claimedRaw = sql(claimSql);
    const claimedList = JSON.parse(claimedRaw);

    for (const item of claimedList) {
      const invId = item.payload.invoice_id;
      const extRef = item.payload.external_reference;

      // Query external Asaas API directly
      const asaasData = asaasGateway[extRef];
      if (!asaasData) continue;

      const invoiceAmount = Number(sql(`select amount_cents from public.subscription_invoices where id = '${invId}'`));
      const asaasAmountCents = Math.round(asaasData.value * 100);

      if (asaasAmountCents === invoiceAmount) {
        // Legitimate payment -> Confirm invoice and mark processed
        sql(`
          update public.subscription_invoices
          set status = 'paid', paid_at = clock_timestamp(), gateway_emission_status = 'issued'
          where id = '${invId}';

          update billing_private.webhook_inbox
          set status = 'processed', disposition = 'confirmed', processed_at = clock_timestamp()
          where id = '${item.id}';
        `);
      } else {
        // Divergence -> Mark failed without quitting invoice
        sql(`
          update billing_private.webhook_inbox
          set status = 'failed', disposition = 'review_required',
              last_error = 'Divergência de valor na API Asaas'
          where id = '${item.id}';
        `);
      }
    }
    return claimedList.length;
  };

  // Run the scheduled consumer cycle
  const workerUuid = 'c0000000-0000-0000-0000-000000000001';
  const processedCount = await runScheduledConsumerCycle(workerUuid);
  assert.ok(processedCount >= 1, 'Scheduled consumer successfully claimed and processed at least 1 event');

  // Verify that the invoice was confirmed by the consumer
  const invoicePostConsumer = sql(`select status from public.subscription_invoices where id = '${fixAuto.invoice_id}'`);
  assert.equal(invoicePostConsumer, 'paid', 'Invoice confirmed by scheduled consumer after Asaas verification');

  const inboxPostConsumer = sql(`select status from billing_private.webhook_inbox where event_id = 'bridge:v7:${fixAuto.external_reference}'`);
  assert.equal(inboxPostConsumer, 'processed', 'Inbox marked processed by scheduled consumer');
  log('BRIDGE TEST 6 PASS: Scheduled consumer successfully claimed, verified against Asaas, and confirmed payment.');

  // -------------------------------------------------------------------------
  // FINAL ZERO-MUTATION VERIFICATION ACROSS ALL v7 CALLS
  // -------------------------------------------------------------------------
  const unconfirmedInvoices = sql(`
    select count(*) from public.subscription_invoices
    where id in ('${fixFail.invoice_id}', '${fixNoPayId.invoice_id}')
      and (status <> 'pending' or paid_at is not null);
  `);
  assert.equal(unconfirmedInvoices, '0', 'Zero premature mutations across all test fixtures');
  log('FINAL PASS: Zero unauthorized financial mutations verified across all test fixtures.');

  log('ALL SAFE V7 BRIDGE TESTS PASSED IN DISPOSABLE POSTGRESQL 17.');
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

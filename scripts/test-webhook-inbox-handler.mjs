// Test suite for Webhook Handler prototype with unified HTTP policy and consumer worker.
// Runs locally in Node.js 24 with standard Web API Request/Response.
import assert from 'node:assert/strict';

// Helper for PII minimization (Allowlist approach)
function sanitizeWebhookPayload(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const sanitized = {
    id: typeof raw.id === 'string' ? raw.id.trim() : null,
    event: typeof raw.event === 'string' ? raw.event.trim() : null,
    dateCreated: typeof raw.dateCreated === 'string' ? raw.dateCreated.trim() : null,
  };
  if (raw.payment && typeof raw.payment === 'object') {
    sanitized.payment = {
      id: typeof raw.payment.id === 'string' ? raw.payment.id.trim() : null,
      status: typeof raw.payment.status === 'string' ? raw.payment.status.trim() : null,
      value: typeof raw.payment.value === 'number' ? raw.payment.value : null,
      netValue: typeof raw.payment.netValue === 'number' ? raw.payment.netValue : null,
      billingType: typeof raw.payment.billingType === 'string' ? raw.payment.billingType.trim() : null,
      externalReference: typeof raw.payment.externalReference === 'string' ? raw.payment.externalReference.trim() : null,
      customer: typeof raw.payment.customer === 'string' ? raw.payment.customer.trim() : null,
    };
  }
  return sanitized;
}

// ============================================================================
// 1. INGESTION HANDLER: UNIFIED HTTP POLICY AT THE EDGE
// ============================================================================
async function handleAsaasWebhookInboxRequest(req, env) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, asaas-access-token",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // 1. Validate Secret Token: unauthenticated requests are NEVER persisted
    const expectedToken = (env.asaasWebhookToken ?? "").trim();
    if (!expectedToken) {
      return jsonResponse({ error: "Segredo ASAAS_WEBHOOK_TOKEN não configurado no servidor." }, 500);
    }
    const receivedToken = (req.headers.get("asaas-access-token") ?? "").trim();
    if (!receivedToken || receivedToken !== expectedToken) {
      return jsonResponse({ error: "Token de webhook não autorizado." }, 401);
    }

    const rawPayload = await req.json();

    // 2. Sanitize PII before any persistence (Minimization)
    const sanitizedPayload = sanitizeWebhookPayload(rawPayload);
    const asaasEventId = sanitizedPayload.id;
    const eventType = sanitizedPayload.event ?? "";
    const adminClient = env.createSupabaseClient(env.supabaseUrl, env.supabaseServiceRoleKey);

    // 3. Handle Missing Event ID: Quarantine in DB and ACK with HTTP 200 to prevent provider queue lockout
    if (!asaasEventId) {
      const { data: qRecord, error: qErr } = await adminClient.rpc("record_webhook_inbox_event", {
        p_provider: "asaas",
        p_event_id: null,
        p_event_type: eventType || "UNKNOWN",
        p_payload: sanitizedPayload,
      });

      if (qErr) {
        return jsonResponse({ error: "Falha na gravação do evento anômalo.", retryable: true }, 503);
      }

      return jsonResponse({
        received: true,
        quarantined: true,
        reason: "missing_event_id",
        inbox_id: qRecord?.id,
      }, 200);
    }

    // Ignore non-payment events with HTTP 200
    if (eventType !== "PAYMENT_RECEIVED" && eventType !== "PAYMENT_CONFIRMED") {
      return jsonResponse({ received: true, ignored: true, event: eventType }, 200);
    }

    // 4. Persist Event Durably to Webhook Inbox
    const { data: inboxRecord, error: inboxErr } = await adminClient.rpc(
      "record_webhook_inbox_event",
      {
        p_provider: "asaas",
        p_event_id: asaasEventId,
        p_event_type: eventType,
        p_payload: sanitizedPayload,
      }
    );

    // POLICY: If persistence fails, respond with error to Asaas (provider retries)
    if (inboxErr || !inboxRecord) {
      return jsonResponse({
        error: inboxErr?.message || "Falha na persistência durável do evento no banco de dados.",
        retryable: true,
      }, 503);
    }

    // POLICY: Once durably persisted, respond with HTTP 200 to Asaas immediately.
    // The event is now under full responsibility of the internal inbox consumer.
    return jsonResponse({
      received: true,
      inbox_id: inboxRecord.id,
      status: inboxRecord.status,
      duplicate: Boolean(inboxRecord.duplicate),
      event_id: asaasEventId,
    }, 200);

  } catch (err) {
    return jsonResponse({ error: err.message, retryable: true }, 500);
  }
}

// ============================================================================
// 2. INTERNAL INBOX CONSUMER WORKER
// ============================================================================
async function processInboxQueueItem(item, workerId, env) {
  const adminClient = env.createSupabaseClient(env.supabaseUrl, env.supabaseServiceRoleKey);
  const payment = item.payload?.payment;
  const asaasPaymentId = typeof payment?.id === "string" ? payment.id.trim() : "";

  if (!asaasPaymentId) {
    await adminClient.rpc("fail_webhook_inbox_event", {
      p_inbox_id: item.id,
      p_worker_id: workerId,
      p_error: "ID do pagamento ausente no payload",
      p_retryable: false,
    });
    return { status: "failed", reason: "missing_payment_id" };
  }

  // 1. Verify Payment with Asaas API
  const fetchImpl = env.fetchFn ?? fetch;
  let verifyRes;
  try {
    verifyRes = await fetchImpl(`${env.asaasBaseUrl}/payments/${encodeURIComponent(asaasPaymentId)}`, {
      method: "GET",
      headers: { "Content-Type": "application/json", access_token: env.asaasApiKey },
    });
  } catch (fetchErr) {
    // Transient failure: reschedule internally
    await adminClient.rpc("fail_webhook_inbox_event", {
      p_inbox_id: item.id,
      p_worker_id: workerId,
      p_error: `Erro de rede ao verificar Asaas: ${fetchErr.message}`,
      p_retryable: true,
      p_retry_delay_seconds: 30,
    });
    return { status: "retry_scheduled", reason: "network_error" };
  }

  if (!verifyRes.ok) {
    await adminClient.rpc("fail_webhook_inbox_event", {
      p_inbox_id: item.id,
      p_worker_id: workerId,
      p_error: `Asaas API retornou HTTP ${verifyRes.status}`,
      p_retryable: true,
      p_retry_delay_seconds: 60,
    });
    return { status: "retry_scheduled", reason: "api_status_error" };
  }

  const verifiedPayment = await verifyRes.json();
  const verifiedExternalRef = typeof verifiedPayment.externalReference === "string" ? verifiedPayment.externalReference.trim() : "";
  if (!verifiedExternalRef) {
    await adminClient.rpc("fail_webhook_inbox_event", {
      p_inbox_id: item.id,
      p_worker_id: workerId,
      p_error: "Divergência: cobrança no Asaas sem externalReference",
      p_retryable: false,
    });
    return { status: "failed", reason: "missing_external_reference" };
  }

  // 2. Query Invoice
  const { data: invoice } = await adminClient
    .from("subscription_invoices")
    .select("*")
    .eq("id", verifiedExternalRef)
    .maybeSingle();

  if (!invoice) {
    await adminClient.rpc("fail_webhook_inbox_event", {
      p_inbox_id: item.id,
      p_worker_id: workerId,
      p_error: "Fatura correspondente não encontrada",
      p_retryable: false,
    });
    return { status: "failed", reason: "invoice_not_found" };
  }

  // 3. Verify Amount (Subpayment check)
  const verifiedAmountCents = Math.round(Number(verifiedPayment.value) * 100);
  if (verifiedAmountCents !== Number(invoice.amount_cents)) {
    await adminClient.rpc("fail_webhook_inbox_event", {
      p_inbox_id: item.id,
      p_worker_id: workerId,
      p_error: `Divergência de valor: pago (${verifiedAmountCents}) difere da fatura (${invoice.amount_cents})`,
      p_retryable: false,
    });
    return { status: "failed", reason: "subpayment_or_value_mismatch" };
  }

  // 4. Confirm Payment via process_inbox_payment_event (Atomic claim + RPC)
  const { data: rpcResult, error: rpcErr } = await adminClient.rpc(
    "process_inbox_payment_event",
    {
      p_inbox_id: item.id,
      p_worker_id: workerId,
      p_invoice_id: invoice.id,
      p_external_reference: asaasPaymentId,
      p_paid_amount_cents: verifiedAmountCents,
      p_restaurant_id: invoice.restaurant_id,
    }
  );

  if (rpcErr) {
    await adminClient.rpc("fail_webhook_inbox_event", {
      p_inbox_id: item.id,
      p_worker_id: workerId,
      p_error: rpcErr.message,
      p_retryable: false,
    });
    return { status: "failed", reason: rpcErr.message };
  }

  return {
    status: rpcResult?.disposition === "review_required" ? "review_required" : "processed",
    disposition: rpcResult?.disposition,
  };
}

// ============================================================================
// IN-MEMORY MOCKS FOR SUPABASE AND ASAAS APIS
// ============================================================================
function createMockEnvironment() {
  const inbox = new Map();
  const invoices = new Map();
  const asaasPayments = new Map();
  let dbFails = false;

  const mockSupabaseClient = {
    from: (table) => {
      if (table === "subscription_invoices") {
        return {
          select: () => ({
            eq: (col, val) => ({
              maybeSingle: async () => ({ data: invoices.get(val) || null, error: null }),
            }),
          }),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    },
    rpc: async (fn, params) => {
      if (dbFails) {
        return { data: null, error: { message: "Database connection failed" } };
      }
      if (fn === "record_webhook_inbox_event") {
        const { p_event_id, p_event_type, p_payload } = params;
        if (!p_event_id) {
          const qId = `q_${Date.now()}_${Math.random()}`;
          const qRow = {
            id: qId,
            event_id: `quarantine:missing_id:${qId}`,
            status: "quarantined",
            disposition: "rejected",
            payload: p_payload,
          };
          inbox.set(qRow.event_id, qRow);
          return { data: { inserted: true, quarantined: true, id: qId, status: "quarantined", disposition: "rejected" }, error: null };
        }
        if (inbox.has(p_event_id)) {
          const row = inbox.get(p_event_id);
          return { data: { inserted: false, duplicate: true, id: row.id, status: row.status, disposition: row.disposition }, error: null };
        }
        const id = `inbox_${Date.now()}_${Math.random()}`;
        const row = { id, event_id: p_event_id, status: "received", payload: p_payload, attempt_count: 0 };
        inbox.set(p_event_id, row);
        return { data: { inserted: true, duplicate: false, id, status: "received" }, error: null };
      }
      if (fn === "fail_webhook_inbox_event") {
        const row = Array.from(inbox.values()).find(r => r.id === params.p_inbox_id);
        if (row) {
          row.status = params.p_retryable ? "received" : "failed";
          row.last_error = params.p_error;
        }
        return { data: true, error: null };
      }
      if (fn === "process_inbox_payment_event") {
        const inv = invoices.get(params.p_invoice_id);
        if (!inv) return { data: null, error: { message: "Fatura não encontrada" } };
        const row = Array.from(inbox.values()).find(r => r.id === params.p_inbox_id);
        if (inv.requires_review) {
          if (row) { row.status = "review_required"; row.disposition = "review_required"; }
          return { data: { success: false, status: "paid", disposition: "review_required" }, error: null };
        }
        if (row) { row.status = "processed"; row.disposition = "confirmed"; }
        return { data: { success: true, status: "paid", disposition: "confirmed" }, error: null };
      }
      throw new Error(`Unexpected rpc ${fn}`);
    },
  };

  const mockFetch = async (url) => {
    const match = url.match(/\/payments\/([^/?]+)/);
    if (match) {
      const paymentId = decodeURIComponent(match[1]);
      const p = asaasPayments.get(paymentId);
      if (p) {
        return new Response(JSON.stringify(p), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    }
    return new Response(JSON.stringify({ error: "Route not found" }), { status: 404 });
  };

  return {
    inbox,
    invoices,
    asaasPayments,
    setDbFails: (val) => { dbFails = val; },
    env: {
      asaasWebhookToken: "valid_secret_token_123",
      asaasApiKey: "asaas_api_key_mock",
      asaasBaseUrl: "https://sandbox.asaas.com/api/v3",
      supabaseUrl: "https://mock.supabase.co",
      supabaseServiceRoleKey: "mock_key",
      createSupabaseClient: () => mockSupabaseClient,
      fetchFn: mockFetch,
    },
  };
}

// ============================================================================
// EXECUTE HANDLER TESTS
// ============================================================================
async function runTests() {
  console.log("Running Unified HTTP Policy and Consumer Worker Test Suite...");

  // TEST 1: Database persistence failure returns HTTP 503 to Asaas (Asaas retries)
  console.log("HTTP POLICY TEST 1: Persistence failure returns HTTP 503 to Asaas");
  {
    const envCtx = createMockEnvironment();
    envCtx.setDbFails(true); // simulate DB outage
    const req = new Request("https://mock/webhook", {
      method: "POST",
      headers: { "asaas-access-token": "valid_secret_token_123" },
      body: JSON.stringify({
        id: "evt_db_fail",
        event: "PAYMENT_RECEIVED",
        payment: { id: "pay_1", value: 99.9 },
      }),
    });
    const res = await handleAsaasWebhookInboxRequest(req, envCtx.env);
    assert.equal(res.status, 503, "Returns 503 when DB fails to persist");
    const body = await res.json();
    assert.equal(body.retryable, true, "Marked as retryable for Asaas");
    console.log("HTTP POLICY TEST 1 PASS: Persistence failure returns 503 retryable to Asaas.");
  }

  // TEST 2: Successful persistence returns HTTP 200 immediately to Asaas
  console.log("HTTP POLICY TEST 2: Successful persistence returns HTTP 200 immediately to Asaas");
  {
    const envCtx = createMockEnvironment();
    const req = new Request("https://mock/webhook", {
      method: "POST",
      headers: { "asaas-access-token": "valid_secret_token_123" },
      body: JSON.stringify({
        id: "evt_success_ack",
        event: "PAYMENT_RECEIVED",
        payment: { id: "pay_1", value: 99.9 },
      }),
    });
    const res = await handleAsaasWebhookInboxRequest(req, envCtx.env);
    assert.equal(res.status, 200, "Returns HTTP 200 to Asaas upon durable storage");
    const body = await res.json();
    assert.equal(body.received, true);
    assert.equal(body.status, "received");
    console.log("HTTP POLICY TEST 2 PASS: Event persisted; HTTP 200 returned to Asaas.");
  }

  // TEST 3: Missing event ID quarantined and returns HTTP 200 to Asaas (prevents queue lock)
  console.log("HTTP POLICY TEST 3: Missing event ID quarantined and ACKed with 200");
  {
    const envCtx = createMockEnvironment();
    const req = new Request("https://mock/webhook", {
      method: "POST",
      headers: { "asaas-access-token": "valid_secret_token_123" },
      body: JSON.stringify({
        event: "PAYMENT_RECEIVED",
        payment: { id: "pay_1", value: 99.9 },
      }),
    });
    const res = await handleAsaasWebhookInboxRequest(req, envCtx.env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.quarantined, true);
    console.log("HTTP POLICY TEST 3 PASS: Missing event ID quarantined without pausing queue.");
  }

  // TEST 4: Invalid Token returns HTTP 401 (never persisted)
  console.log("HTTP POLICY TEST 4: Invalid Token returns HTTP 401 without DB persistence");
  {
    const envCtx = createMockEnvironment();
    const req = new Request("https://mock/webhook", {
      method: "POST",
      headers: { "asaas-access-token": "BAD_TOKEN" },
      body: JSON.stringify({ id: "evt_bad_token", event: "PAYMENT_RECEIVED", payment: { id: "pay_1" } }),
    });
    const res = await handleAsaasWebhookInboxRequest(req, envCtx.env);
    assert.equal(res.status, 401);
    assert.equal(envCtx.inbox.size, 0, "Unauthenticated request was not persisted");
    console.log("HTTP POLICY TEST 4 PASS: Bad token rejected with 401.");
  }

  // TEST 5: Internal Consumer Handles Subpayment: Asaas already got 200, consumer marks failed internally
  console.log("CONSUMER TEST 5: Subpayment handled internally without Asaas retrying");
  {
    const envCtx = createMockEnvironment();
    envCtx.invoices.set("inv_sub", { id: "inv_sub", amount_cents: 9990, restaurant_id: "rest_1" });
    envCtx.asaasPayments.set("pay_sub", { id: "pay_sub", value: 50.0, externalReference: "inv_sub" });

    // Ingest event (Asaas receives 200)
    const req = new Request("https://mock/webhook", {
      method: "POST",
      headers: { "asaas-access-token": "valid_secret_token_123" },
      body: JSON.stringify({
        id: "evt_sub",
        event: "PAYMENT_RECEIVED",
        payment: { id: "pay_sub", value: 50.0 },
      }),
    });
    const res = await handleAsaasWebhookInboxRequest(req, envCtx.env);
    assert.equal(res.status, 200, "Asaas got 200");

    // Consumer processes item
    const inboxItem = envCtx.inbox.get("evt_sub");
    const workerRes = await processInboxQueueItem(inboxItem, "worker-1", envCtx.env);
    assert.equal(workerRes.status, "failed");
    assert.equal(workerRes.reason, "subpayment_or_value_mismatch");
    assert.equal(inboxItem.status, "failed", "Inbox row marked failed internally");
    console.log("CONSUMER TEST 5 PASS: Subpayment marked failed internally; no simultaneous Asaas retries.");
  }

  // TEST 6: Internal Consumer Handles Review Required
  console.log("CONSUMER TEST 6: Review Required handled internally without Asaas retrying");
  {
    const envCtx = createMockEnvironment();
    envCtx.invoices.set("inv_rev", { id: "inv_rev", amount_cents: 18000, restaurant_id: "rest_1", requires_review: true });
    envCtx.asaasPayments.set("pay_rev", { id: "pay_rev", value: 180.0, externalReference: "inv_rev" });

    // Ingest event (Asaas receives 200)
    const req = new Request("https://mock/webhook", {
      method: "POST",
      headers: { "asaas-access-token": "valid_secret_token_123" },
      body: JSON.stringify({
        id: "evt_rev",
        event: "PAYMENT_RECEIVED",
        payment: { id: "pay_rev", value: 180.0 },
      }),
    });
    const res = await handleAsaasWebhookInboxRequest(req, envCtx.env);
    assert.equal(res.status, 200);

    // Consumer processes item
    const inboxItem = envCtx.inbox.get("evt_rev");
    const workerRes = await processInboxQueueItem(inboxItem, "worker-1", envCtx.env);
    assert.equal(workerRes.status, "review_required");
    assert.equal(inboxItem.status, "review_required");
    console.log("CONSUMER TEST 6 PASS: review_required handled internally without Asaas retrying.");
  }

  // TEST 7: Internal Consumer Handles Transient API Failure
  console.log("CONSUMER TEST 7: Transient API failure rescheduled internally");
  {
    const envCtx = createMockEnvironment();
    // Payment not in asaasPayments will trigger HTTP 404 from Asaas API mock
    const req = new Request("https://mock/webhook", {
      method: "POST",
      headers: { "asaas-access-token": "valid_secret_token_123" },
      body: JSON.stringify({
        id: "evt_transient",
        event: "PAYMENT_RECEIVED",
        payment: { id: "pay_transient_missing", value: 99.9 },
      }),
    });
    await handleAsaasWebhookInboxRequest(req, envCtx.env);

    // Consumer processes item
    const inboxItem = envCtx.inbox.get("evt_transient");
    const workerRes = await processInboxQueueItem(inboxItem, "worker-1", envCtx.env);
    assert.equal(workerRes.status, "retry_scheduled");
    assert.equal(inboxItem.status, "received", "Inbox row reset to received for backoff retry");
    console.log("CONSUMER TEST 7 PASS: Transient failure rescheduled internally without Asaas retrying.");
  }

  // TEST 8: Valid Payment Processed Atomically by Consumer
  console.log("CONSUMER TEST 8: Valid Payment confirmed atomically by consumer");
  {
    const envCtx = createMockEnvironment();
    envCtx.invoices.set("inv_clean", { id: "inv_clean", amount_cents: 9990, restaurant_id: "rest_1" });
    envCtx.asaasPayments.set("pay_clean", { id: "pay_clean", value: 99.9, externalReference: "inv_clean" });

    const req = new Request("https://mock/webhook", {
      method: "POST",
      headers: { "asaas-access-token": "valid_secret_token_123" },
      body: JSON.stringify({
        id: "evt_clean",
        event: "PAYMENT_RECEIVED",
        payment: { id: "pay_clean", value: 99.9 },
      }),
    });
    await handleAsaasWebhookInboxRequest(req, envCtx.env);

    const inboxItem = envCtx.inbox.get("evt_clean");
    const workerRes = await processInboxQueueItem(inboxItem, "worker-1", envCtx.env);
    assert.equal(workerRes.status, "processed");
    assert.equal(workerRes.disposition, "confirmed");
    assert.equal(inboxItem.status, "processed");
    console.log("CONSUMER TEST 8 PASS: Payment processed cleanly and inbox marked processed.");
  }

  // TEST 9: PII Sanitization verification
  console.log("HTTP TEST 9: PII Sanitization Strips Sensitive Data Prior to Storage");
  {
    const envCtx = createMockEnvironment();
    const req = new Request("https://mock/webhook", {
      method: "POST",
      headers: { "asaas-access-token": "valid_secret_token_123" },
      body: JSON.stringify({
        id: "evt_pii",
        event: "PAYMENT_RECEIVED",
        payment: {
          id: "pay_pii",
          value: 99.9,
          // PII to be stripped
          creditCard: { creditCardNumber: "4111111111111111", creditCardBrand: "VISA", creditCardToken: "secret_token_xyz" },
          customer: "cus_12345",
          customerEmail: "cliente@privado.com.br",
          customerPhone: "11988887777",
          cpfCnpj: "123.456.789-00",
          postalCode: "01001-000",
        },
      }),
    });
    await handleAsaasWebhookInboxRequest(req, envCtx.env);
    const stored = envCtx.inbox.get("evt_pii");
    assert.ok(stored, "Event stored in inbox");
    const storedPayment = stored.payload.payment;
    assert.equal(storedPayment.id, "pay_pii");
    assert.equal(storedPayment.customer, "cus_12345");
    assert.equal(storedPayment.creditCard, undefined, "Credit card object stripped");
    assert.equal(storedPayment.customerEmail, undefined, "Email stripped");
    assert.equal(storedPayment.customerPhone, undefined, "Phone stripped");
    assert.equal(storedPayment.cpfCnpj, undefined, "CPF/CNPJ stripped");
    console.log("HTTP TEST 9 PASS: Customer PII completely sanitized and stripped from storage payload.");
  }

  console.log("ALL 9 UNIFIED HTTP POLICY & CONSUMER TESTS PASSED SUCCESSFULLY.");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});

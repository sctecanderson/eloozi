import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { timingSafeEqual } from "node:crypto";

/**
 * Comparação em tempo constante para mitigar ataques de temporização (timing attacks).
 * Protege contra vazamento de tamanho e previne RangeError quando os buffers têm comprimentos distintos.
 */
export function constantTimeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }
  const enc = new TextEncoder();
  const bufA = enc.encode(a);
  const bufB = enc.encode(b);

  if (bufA.byteLength !== bufB.byteLength) {
    // Executa operação de comparação uniforme para evitar vazamento de temporização e RangeError
    timingSafeEqual(bufA, bufA);
    return false;
  }

  return timingSafeEqual(bufA, bufB);
}

/**
 * Parsing monetário estrito para centavos inteiros (BigInt).
 * Elimina completamente operações de ponto flutuante (IEEE 754) e rejeita
 * expressamente formatos ambíguos (ex: múltiplos separadores, mais de 2 casas, notação científica).
 */
export function parseCentsFromMonetary(val: unknown): bigint {
  if (val === null || val === undefined) {
    throw new Error("Valor monetário ausente ou nulo.");
  }

  let str: string;
  if (typeof val === "number") {
    if (!Number.isFinite(val) || val < 0) {
      throw new Error(`Número monetário inválido ou negativo: ${val}`);
    }
    str = val.toFixed(2);
  } else if (typeof val === "string") {
    str = val.trim();
  } else {
    throw new Error(`Tipo inválido para valor monetário: ${typeof val}`);
  }

  if (!str) {
    throw new Error("String monetária vazia.");
  }

  if (str.startsWith("-") || str.includes("e") || str.includes("E")) {
    throw new Error(`Formato monetário não aceita números negativos ou notação científica: "${str}"`);
  }

  let intPart = "";
  let decPart = "00";

  // Formato 1: Dígitos com ponto decimal canônico (1 ou 2 casas): ^\d+(\.\d{1,2})?$
  if (/^\d+(\.\d{1,2})?$/.test(str)) {
    const parts = str.split(".");
    intPart = parts[0];
    decPart = (parts[1] || "0").padEnd(2, "0");
  }
  // Formato 2: Dígitos com vírgula decimal brasileira simples: ^\d+(,\d{1,2})?$
  else if (/^\d+(,\d{1,2})?$/.test(str)) {
    const parts = str.split(",");
    intPart = parts[0];
    decPart = (parts[1] || "0").padEnd(2, "0");
  }
  // Formato 3: Padrão brasileiro com separador de milhar por ponto E decimal obrigatório por vírgula: ^\d{1,3}(\.\d{3})+,\d{1,2}$
  else if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(str)) {
    const cleaned = str.replace(/\./g, "");
    const parts = cleaned.split(",");
    intPart = parts[0];
    decPart = (parts[1] || "0").padEnd(2, "0");
  }
  // Qualquer outro formato (ex: vírgula de milhar com ponto decimal, 3+ casas decimais, caracteres alfabéticos) é ambíguo
  else {
    throw new Error(`Formato monetário ambíguo ou inválido rejeitado: "${str}"`);
  }

  const cents = BigInt(intPart) * 100n + BigInt(decPart);
  if (cents < 0n) {
    throw new Error(`Centavos não podem ser negativos: ${cents}`);
  }
  return cents;
}

/**
 * Extração e desambiguação de identificadores de cobrança.
 * Diferencia explicitamente:
 * - payment.id (ID da cobrança no Asaas, gravado na fatura como external_reference)
 * - externalReference (ID da fatura no nosso sistema, invoice_id)
 * Coloca fallbacks sintéticos ('asaas_pay_*', strings vazias ou nulas) imediatamente em quarentena.
 */
export function extractBillingIdentifiers(payload: Record<string, unknown> | null | undefined): {
  paymentId: string | null;
  invoiceId: string | null;
  isFallback: boolean;
  isSynthetic: boolean;
} {
  if (!payload || typeof payload !== "object") {
    return { paymentId: null, invoiceId: null, isFallback: true, isSynthetic: false };
  }

  let paymentId: string | null = null;
  let invoiceId: string | null = null;

  // Formato A (Ponte v7):
  // { source: 'v7_bridge', invoice_id: '<uuid>', external_reference: '<pay_id>' }
  if (typeof payload.invoice_id === "string") {
    invoiceId = payload.invoice_id.trim();
  }
  if (typeof payload.external_reference === "string") {
    paymentId = payload.external_reference.trim();
  }

  // Formato B (Webhook nativo do Asaas):
  // { event: 'PAYMENT_RECEIVED', payment: { id: '<pay_id>', externalReference: '<invoice_uuid>', value: 99.90 } }
  if (payload.payment && typeof payload.payment === "object") {
    const p = payload.payment as Record<string, unknown>;
    if (typeof p.id === "string" && !paymentId) {
      paymentId = p.id.trim();
    }
    if (typeof p.externalReference === "string" && !invoiceId) {
      invoiceId = p.externalReference.trim();
    }
  }

  // Detecção estrita de fallback sintético
  const isFallback =
    !paymentId ||
    paymentId.startsWith("asaas_pay_") ||
    paymentId.startsWith("quarantine:") ||
    paymentId === "null" ||
    paymentId === "undefined" ||
    paymentId === "";

  const isSynthetic =
    Boolean(payload.synthetic) ||
    Boolean((payload.payment as Record<string, unknown> | undefined)?.synthetic) ||
    (typeof paymentId === "string" && paymentId.startsWith("synthetic:"));

  return { paymentId, invoiceId, isFallback, isSynthetic };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, content-type, x-inbox-consumer-secret",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
    });
  }

  // 1. Autenticação Unificada: Token de alta entropia x-inbox-consumer-secret
  // Funciona com verify_jwt: false, eliminando exposição de service_role_key em pg_net / cron.job
  const expectedSecret = (Deno.env.get("INBOX_CONSUMER_SECRET") ?? "").trim();
  if (!expectedSecret) {
    return new Response(JSON.stringify({ error: "Segredo INBOX_CONSUMER_SECRET não configurado no servidor." }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const receivedSecret = req.headers.get("x-inbox-consumer-secret");
  if (!constantTimeEqual(receivedSecret, expectedSecret)) {
    return new Response(JSON.stringify({ error: "Acesso não autorizado ao consumidor." }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 2. Inicialização dos Clientes e URLs Autoritativas
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const asaasBaseUrl = (
    Deno.env.get("ASAAS_BASE_URL") ??
    Deno.env.get("ASAAS_API_URL") ??
    "https://api.asaas.com/v3"
  ).trim().replace(/\/+$/, "");
  const asaasApiKey = (Deno.env.get("ASAAS_API_KEY") ?? "").trim();

  const supabase = createClient(supabaseUrl, supabaseKey);
  const workerId = crypto.randomUUID();
  const summary = {
    worker_id: workerId,
    claimed: 0,
    processed: 0,
    quarantined: 0,
    retried: 0,
    failed: 0,
    items: [] as Array<Record<string, unknown>>,
  };

  try {
    // 3. Claim Atômico do Próximo Lote (Lease de 60 segundos com varredura automática de leases expirados exauridos)
    const { data: claimedEvents, error: claimErr } = await supabase.rpc("claim_webhook_inbox_event", {
      p_worker_id: workerId,
      p_lease_seconds: 60,
    });

    if (claimErr) {
      return new Response(JSON.stringify({ error: `Erro ao reivindicar eventos: ${claimErr.message}` }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!claimedEvents || claimedEvents.length === 0) {
      return new Response(JSON.stringify({ message: "Zero eventos pendentes na fila.", worker_id: workerId }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    summary.claimed = claimedEvents.length;

    for (const event of claimedEvents) {
      const inboxId = event.id;
      const rawPayload = event.payload as Record<string, unknown>;
      const { paymentId, invoiceId, isFallback, isSynthetic } = extractBillingIdentifiers(rawPayload);

      // CASO 1: Fallback Sintético -> Quarentena Imediata Sem Consulta ao Gateway
      if (isFallback || !invoiceId) {
        await supabase.rpc("fail_webhook_inbox_event", {
          p_inbox_id: inboxId,
          p_worker_id: workerId,
          p_error: "Fallback sintético (asaas_pay_*) ou fatura ausente. Evento isolado sem consulta ao Asaas.",
          p_retryable: false,
        });
        summary.quarantined++;
        summary.items.push({ id: inboxId, status: "quarantined", reason: "synthetic_fallback" });
        continue;
      }

      // CASO 2: Evento Sintético de Teste Local -> NUNCA Consulta Gateway Real
      if (isSynthetic) {
        if (Boolean(rawPayload.simulate_transient_failure) && event.attempt_count === 1) {
          await supabase.rpc("fail_webhook_inbox_event", {
            p_inbox_id: inboxId,
            p_worker_id: workerId,
            p_error: "Falha transitória simulada em bancada de testes.",
            p_retryable: true,
            p_retry_delay_seconds: 5,
          });
          summary.retried++;
          summary.items.push({ id: inboxId, status: "retry_scheduled", reason: "simulated_transient" });
          continue;
        }

        const mockAmountCents = parseCentsFromMonetary(rawPayload.amount_cents ?? 9990);
        const { data: invRow } = await supabase
          .from("subscription_invoices")
          .select("id, restaurant_id, amount_cents")
          .eq("id", invoiceId)
          .maybeSingle();

        if (invRow && BigInt(invRow.amount_cents) === mockAmountCents) {
          // Proteção Financeira Atômica: RPC única que valida lease e quita na mesma transação
          const { error: confErr } = await supabase.rpc("confirm_and_complete_inbox_payment", {
            p_inbox_id: inboxId,
            p_worker_id: workerId,
            p_invoice_id: invoiceId,
            p_external_reference: paymentId,
            p_paid_amount_cents: Number(mockAmountCents),
            p_restaurant_id: invRow.restaurant_id,
            p_disposition: "confirmed",
          });

          if (!confErr) {
            summary.processed++;
            summary.items.push({ id: inboxId, status: "processed", disposition: "confirmed" });
            continue;
          } else {
            summary.failed++;
            summary.items.push({ id: inboxId, status: "failed", error: confErr.message });
            continue;
          }
        }
      }

      // CASO 3: Pagamento Real -> Verificação Obrigatória na API Asaas
      let asaasData: Record<string, unknown>;
      try {
        const asaasRes = await fetch(`${asaasBaseUrl}/payments/${encodeURIComponent(paymentId!)}`, {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            access_token: asaasApiKey,
          },
        });

        if (!asaasRes.ok) {
          await supabase.rpc("fail_webhook_inbox_event", {
            p_inbox_id: inboxId,
            p_worker_id: workerId,
            p_error: `API Asaas retornou HTTP ${asaasRes.status}`,
            p_retryable: true,
            p_retry_delay_seconds: 60,
          });
          summary.retried++;
          summary.items.push({ id: inboxId, status: "retry_scheduled", error: `Asaas HTTP ${asaasRes.status}` });
          continue;
        }

        asaasData = await asaasRes.json();
      } catch (networkErr: unknown) {
        const errMsg = networkErr instanceof Error ? networkErr.message : String(networkErr);
        await supabase.rpc("fail_webhook_inbox_event", {
          p_inbox_id: inboxId,
          p_worker_id: workerId,
          p_error: `Falha de rede ao consultar Asaas: ${errMsg}`,
          p_retryable: true,
          p_retry_delay_seconds: 30,
        });
        summary.retried++;
        summary.items.push({ id: inboxId, status: "retry_scheduled", error: errMsg });
        continue;
      }

      // 4. Validação de Integridade: Conferir externalReference do Asaas com a fatura esperada
      const asaasExternalRef = typeof asaasData.externalReference === "string" ? asaasData.externalReference.trim() : "";
      if (asaasExternalRef !== invoiceId) {
        await supabase.rpc("fail_webhook_inbox_event", {
          p_inbox_id: inboxId,
          p_worker_id: workerId,
          p_error: `Divergência de externalReference: Asaas possui "${asaasExternalRef}", esperado "${invoiceId}"`,
          p_retryable: false,
        });
        summary.failed++;
        summary.items.push({ id: inboxId, status: "failed", reason: "external_reference_mismatch" });
        continue;
      }

      // 5. Consulta da Fatura no Banco
      const { data: invoice, error: invErr } = await supabase
        .from("subscription_invoices")
        .select("id, restaurant_id, amount_cents, status")
        .eq("id", invoiceId)
        .maybeSingle();

      if (invErr || !invoice) {
        await supabase.rpc("fail_webhook_inbox_event", {
          p_inbox_id: inboxId,
          p_worker_id: workerId,
          p_error: `Fatura ${invoiceId} não localizada no banco de dados.`,
          p_retryable: false,
        });
        summary.failed++;
        summary.items.push({ id: inboxId, status: "failed", reason: "invoice_not_found" });
        continue;
      }

      // 6. Comparação Estrita de Valor (Centavos Inteiros sem Ponto Flutuante)
      let asaasCents: bigint;
      try {
        asaasCents = parseCentsFromMonetary(asaasData.value);
      } catch (parseErr: unknown) {
        const pMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
        await supabase.rpc("fail_webhook_inbox_event", {
          p_inbox_id: inboxId,
          p_worker_id: workerId,
          p_error: `Erro ao interpretar valor retornado pelo Asaas: ${pMsg}`,
          p_retryable: false,
        });
        summary.failed++;
        summary.items.push({ id: inboxId, status: "failed", reason: "invalid_monetary_value" });
        continue;
      }

      const expectedInvoiceCents = BigInt(invoice.amount_cents);
      if (asaasCents !== expectedInvoiceCents) {
        await supabase.rpc("fail_webhook_inbox_event", {
          p_inbox_id: inboxId,
          p_worker_id: workerId,
          p_error: `Subpagamento ou divergência de valor: pago no Asaas (${asaasCents} centavos), esperado (${expectedInvoiceCents} centavos)`,
          p_retryable: false,
        });
        summary.failed++;
        summary.items.push({ id: inboxId, status: "failed", reason: "amount_mismatch" });
        continue;
      }

      // 7. Proteção Financeira Atômica: Validação de lease e quitação na mesma transação
      const { data: rpcResult, error: rpcErr } = await supabase.rpc("confirm_and_complete_inbox_payment", {
        p_inbox_id: inboxId,
        p_worker_id: workerId,
        p_invoice_id: invoice.id,
        p_external_reference: paymentId,
        p_paid_amount_cents: Number(asaasCents),
        p_restaurant_id: invoice.restaurant_id,
        p_disposition: "confirmed",
      });

      if (rpcErr) {
        // Se a transação abortou porque o lease expirou, o erro é fail-closed
        await supabase.rpc("fail_webhook_inbox_event", {
          p_inbox_id: inboxId,
          p_worker_id: workerId,
          p_error: `Falha na quitação atômica: ${rpcErr.message}`,
          p_retryable: false,
        });
        summary.failed++;
        summary.items.push({ id: inboxId, status: "failed", reason: rpcErr.message });
        continue;
      }

      const disposition = (rpcResult as Record<string, unknown>)?.disposition === "review_required" ? "review_required" : "confirmed";
      summary.processed++;
      summary.items.push({ id: inboxId, status: "processed", disposition });
    }

    return new Response(JSON.stringify(summary), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (globalErr: unknown) {
    const gMsg = globalErr instanceof Error ? globalErr.message : String(globalErr);
    return new Response(JSON.stringify({ error: gMsg, worker_id: workerId }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});

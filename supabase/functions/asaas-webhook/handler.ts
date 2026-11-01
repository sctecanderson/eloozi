export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, asaas-access-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export interface WebhookHandlerEnv {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  asaasWebhookToken: string;
  asaasApiKey: string;
  asaasBaseUrl: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createSupabaseClient: (url: string, key: string) => any;
  fetchFn?: typeof fetch;
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function toCents(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.round(num * 100);
}

function isConfirmedAsaasStatus(status: unknown): boolean {
  return status === "CONFIRMED" || status === "RECEIVED";
}

function expectedBillingTypeForMethod(method: unknown): string {
  return method === "pix" ? "PIX" : "CREDIT_CARD";
}

function isMissingRpcSignature(error: any, functionName: string): boolean {
  if (!error) return false;
  if (error.code === "PGRST202" || error.code === "42883") return true;
  const message = String(error.message ?? "").toLowerCase();
  return message.includes(functionName.toLowerCase()) &&
    (message.includes("could not find the function") || message.includes("does not exist"));
}

async function confirmSubscriptionPayment(
  adminClient: any,
  invoice: { id: string; restaurant_id: string },
  externalReference: string,
  paidAmountCents: number,
): Promise<{ data: any; error: any }> {
  const fn = "confirm_subscription_invoice_payment";
  const current = await adminClient.rpc(fn, {
    p_invoice_id: invoice.id,
    p_external_reference: externalReference,
    p_paid_amount_cents: paidAmountCents,
    p_restaurant_id: invoice.restaurant_id,
  });
  if (!isMissingRpcSignature(current?.error, fn)) return current;
  // A narrow compatibility path for the old, server-only RPC during rollout.
  return adminClient.rpc(fn, {
    p_invoice_id: invoice.id,
    p_external_reference: externalReference,
  });
}

export async function handleAsaasWebhookRequest(
  req: Request,
  env: WebhookHandlerEnv,
): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // 1. Exigir segredo configurado no servidor (nunca aceitar webhook sem token válido)
    const expectedToken = (env.asaasWebhookToken ?? "").trim();
    if (!expectedToken) {
      return jsonResponse(
        { error: "Segredo ASAAS_WEBHOOK_TOKEN não configurado no servidor." },
        500,
      );
    }

    const receivedToken = (req.headers.get("asaas-access-token") ?? "").trim();
    if (!receivedToken || receivedToken !== expectedToken) {
      return jsonResponse({ error: "Token de webhook inválido." }, 401);
    }

    const asaasApiKey = (env.asaasApiKey ?? "").trim();
    if (!asaasApiKey) {
      return jsonResponse(
        { error: "Chave ASAAS_API_KEY não configurada no servidor." },
        500,
      );
    }

    const asaasBaseUrl = (env.asaasBaseUrl ?? "").trim().replace(/\/+$/, "");
    if (!asaasBaseUrl) {
      return jsonResponse({ error: "Gateway Asaas não configurado no servidor (ASAAS_BASE_URL ausente)." }, 500);
    }
    const fetchImpl = env.fetchFn ?? fetch;

    const payload = await req.json();
    const event = typeof payload?.event === "string" ? payload.event.trim() : "";
    const payment = payload?.payment;

    if (!event || !payment) {
      return jsonResponse({ error: "Payload de webhook inválido." }, 400);
    }

    // Processar apenas eventos de pagamento confirmado/recebido
    if (event !== "PAYMENT_RECEIVED" && event !== "PAYMENT_CONFIRMED") {
      return jsonResponse({
        received: true,
        ignored: true,
        event,
      });
    }

    const asaasPaymentId = typeof payment?.id === "string" ? payment.id.trim() : "";
    if (!asaasPaymentId) {
      return jsonResponse({ error: "ID do pagamento Asaas ausente no webhook." }, 400);
    }

    // 2. Consultar diretamente a API do Asaas para validar estado real, valor e vínculo
    //    (não confiar apenas no payload recebido no webhook)
    const verifyRes = await fetchImpl(
      `${asaasBaseUrl}/payments/${encodeURIComponent(asaasPaymentId)}`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          access_token: asaasApiKey,
        },
      },
    );

    if (!verifyRes.ok) {
      return jsonResponse(
        { error: "Falha ao verificar autenticidade da cobrança na API do Asaas." },
        502,
      );
    }

    const verifiedPayment = await verifyRes.json();

    if (!verifiedPayment?.id || String(verifiedPayment.id).trim() !== asaasPaymentId) {
      return jsonResponse(
        { error: "Divergência de segurança: ID do pagamento não confere com a API do Asaas." },
        422,
      );
    }

    if (!isConfirmedAsaasStatus(verifiedPayment.status)) {
      return jsonResponse(
        {
          received: true,
          confirmed: false,
          status: verifiedPayment.status ?? "PENDING",
          message: "Cobrança ainda não consta como paga na API do Asaas.",
        },
        200,
      );
    }

    // Exigir que a cobrança verificada na API do Asaas possua externalReference apontando para a fatura local
    const verifiedExternalRef =
      typeof verifiedPayment.externalReference === "string"
        ? verifiedPayment.externalReference.trim()
        : "";

    if (!verifiedExternalRef) {
      return jsonResponse(
        {
          error:
            "Divergência de segurança: a cobrança no Asaas não possui vínculo de fatura (externalReference ausente).",
        },
        422,
      );
    }

    const adminClient = env.createSupabaseClient(env.supabaseUrl, env.supabaseServiceRoleKey);

    // 3. Localizar a fatura vinculada por id = verifiedExternalRef
    const { data: invoice } = await adminClient
      .from("subscription_invoices")
      .select("*")
      .eq("id", verifiedExternalRef)
      .maybeSingle();

    if (!invoice) {
      return jsonResponse(
        { error: "Fatura correspondente não encontrada para o pagamento informado." },
        404,
      );
    }

    // Validar que externalReference no Asaas aponta exatamente para esta fatura
    if (String(invoice.id).trim() !== verifiedExternalRef) {
      return jsonResponse(
        { error: "Divergência de segurança: externalReference não corresponde à fatura." },
        422,
      );
    }

    // Validar correspondência exata do valor pago em centavos
    const verifiedAmountCents = toCents(verifiedPayment.value);
    if (verifiedAmountCents !== Number(invoice.amount_cents)) {
      return jsonResponse(
        {
          error: `Divergência de segurança: valor pago no Asaas (${verifiedAmountCents}) difere do valor da fatura (${invoice.amount_cents}).`,
        },
        422,
      );
    }

    // Validar tipo de cobrança quando informado pelo Asaas
    if (verifiedPayment.billingType) {
      const expectedType = expectedBillingTypeForMethod(invoice.payment_method);
      if (String(verifiedPayment.billingType) !== expectedType) {
        return jsonResponse(
          {
            error: `Divergência de segurança: método de pagamento no Asaas (${verifiedPayment.billingType}) difere do método da fatura (${expectedType}).`,
          },
          422,
        );
      }
    }

    // Se a fatura já possui external_reference salvo, ele deve coincidir exatamente com asaasPaymentId.
    // Se a fatura for legítima sem external_reference salvo localmente (ex.: falha de rede após criar no Asaas),
    // reconciliar de forma segura vinculando external_reference = asaasPaymentId via RPC dedicada ou update após todas as validações acima.
    const savedExtRef =
      typeof invoice.external_reference === "string" ? invoice.external_reference.trim() : "";

    if (savedExtRef && savedExtRef !== asaasPaymentId) {
      return jsonResponse(
        {
          error:
            "Divergência de segurança: o ID externo salvo na fatura não corresponde ao pagamento do Asaas.",
        },
        422,
      );
    }

    if (!savedExtRef) {
      // Usar a RPC atômica attach_subscription_invoice_external_reference com claim_id nulo para reconciliação legítima.
      // Jamais utilizar fallback direto: preservar o erro caso a RPC falhe ou rejeite vínculo concorrente.
      const { data: attachData, error: attachErr } = await adminClient.rpc(
        "attach_subscription_invoice_external_reference",
        {
          p_invoice_id: invoice.id,
          p_external_reference: asaasPaymentId,
          p_claim_id: null,
        },
      );

      if (attachErr || !attachData || attachData.attached !== true) {
        if (isMissingRpcSignature(attachErr, "attach_subscription_invoice_external_reference")) {
          return jsonResponse({
            error: "A referência do pagamento foi verificada; a reconciliação será repetida quando o banco estiver atualizado.",
            payment_received: true,
            retryable: true,
          }, 503);
        }
        return jsonResponse(
          { error: attachErr?.message || "Não foi possível vincular a referência externa reconciliada da fatura." },
          422,
        );
      }
      invoice.external_reference = asaasPaymentId;
    }

    // 4. Confirmar pagamento via RPC restrita ao service_role (com todos os 4 parâmetros obrigatórios)
    const { data: rpcResult, error: rpcErr } = await confirmSubscriptionPayment(
      adminClient, invoice, asaasPaymentId, verifiedAmountCents,
    );

    if (rpcErr) {
      return jsonResponse(
        { error: rpcErr.message || "Falha ao confirmar fatura no banco de dados." },
        422,
      );
    }

    return jsonResponse({
      received: true,
      confirmed: !rpcResult?.requires_review,
      requires_review: Boolean(rpcResult?.requires_review),
      already_paid: Boolean(rpcResult?.already_paid),
      invoice_id: invoice.id,
      result: rpcResult,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Erro ao processar webhook Asaas.";
    return jsonResponse({ error: message }, 500);
  }
}

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export interface CheckoutHandlerEnv {
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
  asaasApiKey: string;
  asaasBaseUrl: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createSupabaseClient: (url: string, key: string, options?: any) => any;
  fetchFn?: typeof fetch;
  /** Tempo após o qual um claim de emissão sem conclusão é considerado parado (padrão 10 min). */
  staleEmissionMs?: number;
  nowFn?: () => number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

export const PIX_PROCESSING_MESSAGE =
  "A cobrança PIX desta fatura está em processamento. Aguarde alguns instantes e tente novamente.";
export const PIX_RECONCILIATION_MESSAGE =
  "Não foi possível confirmar com segurança o estado da cobrança PIX no Asaas. A fatura precisa de reconciliação e nenhuma nova cobrança foi emitida. Tente novamente em instantes.";

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

async function isUserAuthorizedForRestaurant(
  adminClient: any,
  userId: string,
  restaurantId: string,
): Promise<boolean> {
  if (!userId || !restaurantId) return false;

  const { data: memberData } = await adminClient
    .from("restaurant_members")
    .select("role, active")
    .eq("restaurant_id", restaurantId)
    .eq("user_id", userId)
    .eq("active", true)
    .eq("role", "admin")
    .maybeSingle();

  if (memberData) return true;

  // SuperAdmin real validado exclusivamente em public.platform_admins
  const { data: platformAdminData } = await adminClient
    .from("platform_admins")
    .select("user_id, active")
    .eq("user_id", userId)
    .eq("active", true)
    .maybeSingle();

  return Boolean(platformAdminData?.active);
}

type AsaasSearchResult =
  | { kind: "error" }
  | { kind: "none" }
  | { kind: "multiple" }
  | { kind: "mismatch" }
  | { kind: "one"; payment: any };

/**
 * Busca no Asaas cobranças vinculadas à fatura (externalReference = invoice.id).
 * Qualquer falha, resultado múltiplo ou divergência de valor/método é tratado como ambíguo.
 */
export async function searchAsaasPaymentsByInvoice(
  fetchImpl: typeof fetch,
  asaasBaseUrl: string,
  asaasApiKey: string,
  invoice: { id: string; amount_cents: number; payment_method: string },
): Promise<AsaasSearchResult> {
  let data: any;
  try {
    const res = await fetchImpl(
      `${asaasBaseUrl}/payments?externalReference=${encodeURIComponent(String(invoice.id).trim())}`,
      { method: "GET", headers: { "Content-Type": "application/json", access_token: asaasApiKey } },
    );
    if (!res.ok) return { kind: "error" };
    data = await res.json();
  } catch {
    return { kind: "error" };
  }

  if (!data || !Array.isArray(data.data)) return { kind: "error" };

  const matching = data.data.filter(
    (item: any) =>
      item?.id &&
      String(item.externalReference ?? "").trim() === String(invoice.id).trim() &&
      item.deleted !== true,
  );

  if (matching.length === 0) return { kind: "none" };
  if (matching.length > 1) return { kind: "multiple" };

  const payment = matching[0];
  if (toCents(payment.value) !== Number(invoice.amount_cents)) return { kind: "mismatch" };
  if (payment.billingType && String(payment.billingType) !== expectedBillingTypeForMethod(invoice.payment_method)) {
    return { kind: "mismatch" };
  }
  return { kind: "one", payment };
}

async function getAsaasPayment(
  fetchImpl: typeof fetch,
  asaasBaseUrl: string,
  asaasApiKey: string,
  paymentId: string,
): Promise<{ ok: true; payment: any } | { ok: false }> {
  try {
    const res = await fetchImpl(`${asaasBaseUrl}/payments/${encodeURIComponent(paymentId)}`, {
      method: "GET",
      headers: { "Content-Type": "application/json", access_token: asaasApiKey },
    });
    if (!res.ok) return { ok: false };
    const payment = await res.json();
    if (!payment?.id) return { ok: false };
    return { ok: true, payment };
  } catch {
    return { ok: false };
  }
}

async function getAsaasPixQrCode(
  fetchImpl: typeof fetch,
  asaasBaseUrl: string,
  asaasApiKey: string,
  paymentId: string,
): Promise<any | null> {
  try {
    const res = await fetchImpl(`${asaasBaseUrl}/payments/${encodeURIComponent(paymentId)}/pixQrCode`, {
      method: "GET",
      headers: { "Content-Type": "application/json", access_token: asaasApiKey },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.payload ? data : null;
  } catch {
    return null;
  }
}

interface PixContext {
  adminClient: any;
  fetchImpl: typeof fetch;
  baseUrl: string;
  apiKey: string;
  restaurant: any;
  restaurantId: string;
  user: any;
  targetPlan: string;
  billingCycle: string;
  amountCents: number;
  valueReais: number;
  description: string;
  cleanCpfCnpj: string;
  payerInfo: any;
  pixExpiresAt: string;
  staleEmissionMs: number;
  now: () => number;
}

function reconciliationResponse(invoiceId: string): Response {
  return jsonResponse(
    { error: PIX_RECONCILIATION_MESSAGE, needs_reconciliation: true, invoice_id: invoiceId },
    409,
  );
}

function processingResponse(invoiceId: string): Response {
  return jsonResponse({ error: PIX_PROCESSING_MESSAGE, processing: true, invoice_id: invoiceId }, 409);
}

async function acquirePixInvoice(ctx: PixContext): Promise<any | null> {
  const { data, error } = await ctx.adminClient.rpc("acquire_or_create_pending_subscription_invoice", {
    p_restaurant_id: ctx.restaurantId,
    p_plan_id: ctx.targetPlan,
    p_billing_cycle: ctx.billingCycle,
    p_payment_method: "pix",
    p_amount_cents: ctx.amountCents,
    p_pix_expires_at: ctx.pixExpiresAt,
    p_card_brand: null,
    p_card_last4: null,
    p_created_by: ctx.user.id,
  });
  if (error || !data?.invoice) return null;
  return data.invoice;
}

async function ensureAsaasCustomer(ctx: PixContext): Promise<{ ok: true; id: string } | { ok: false; status: number; error: string }> {
  try {
    const searchRes = await ctx.fetchImpl(`${ctx.baseUrl}/customers?cpfCnpj=${ctx.cleanCpfCnpj}`, {
      method: "GET",
      headers: { "Content-Type": "application/json", access_token: ctx.apiKey },
    });
    if (!searchRes.ok) return { ok: false, status: 502, error: "Falha ao consultar cliente no gateway Asaas." };
    const searchData = await searchRes.json();
    if (searchData?.data?.length > 0) return { ok: true, id: searchData.data[0].id };

    const createRes = await ctx.fetchImpl(`${ctx.baseUrl}/customers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", access_token: ctx.apiKey },
      body: JSON.stringify({
        name: ctx.payerInfo?.name || ctx.restaurant.name || "Restaurante Eloozi",
        cpfCnpj: ctx.cleanCpfCnpj,
        email: ctx.user.email || undefined,
        mobilePhone: (ctx.payerInfo?.phone || ctx.restaurant.phone || "").replace(/\D/g, "") || undefined,
        externalReference: ctx.restaurant.id,
        notificationDisabled: false,
      }),
    });
    const createData = await createRes.json();
    if (!createRes.ok || !createData?.id) {
      return {
        ok: false,
        status: 400,
        error: createData?.errors?.[0]?.description || "Não foi possível cadastrar o cliente no Asaas. Verifique o CPF/CNPJ.",
      };
    }
    return { ok: true, id: createData.id };
  } catch {
    return { ok: false, status: 502, error: "Falha de comunicação ao consultar cliente no Asaas." };
  }
}

function pendingPixResponse(invoice: any, ctx: PixContext, extra: Record<string, unknown>): Response {
  return jsonResponse({
    success: true,
    invoice_id: invoice.id,
    plan_id: ctx.targetPlan,
    billing_cycle: ctx.billingCycle,
    amount_cents: invoice.amount_cents,
    payment_method: "pix",
    status: "pending",
    ...extra,
  });
}

/**
 * Fatura já vinculada a uma cobrança do Asaas: decide o estado consultando o Asaas.
 * Nunca emite nova cobrança para esta fatura.
 */
async function handleIssuedPixInvoice(
  ctx: PixContext,
  invoice: any,
  externalReference: string,
  attempt: number,
): Promise<Response> {
  const result = await getAsaasPayment(ctx.fetchImpl, ctx.baseUrl, ctx.apiKey, externalReference);
  if (!result.ok) return reconciliationResponse(invoice.id);
  const payment = result.payment;

  if (String(payment.id).trim() !== externalReference) {
    return jsonResponse({ error: "Divergência de segurança: ID da cobrança no Asaas não confere." }, 422);
  }
  if (String(payment.externalReference ?? "").trim() !== String(invoice.id).trim()) {
    return jsonResponse({ error: "Divergência de segurança: cobrança no Asaas vinculada a outra fatura." }, 422);
  }
  if (toCents(payment.value) !== Number(invoice.amount_cents)) {
    return jsonResponse({ error: "Divergência de segurança: valor da cobrança no Asaas difere da fatura." }, 422);
  }

  // Cobrança já paga no Asaas (inclusive com webhook atrasado): confirma em vez de gerar nova
  if (isConfirmedAsaasStatus(payment.status)) {
    const { data: rpcResult, error: rpcErr } = await ctx.adminClient.rpc("confirm_subscription_invoice_payment", {
      p_invoice_id: invoice.id,
      p_external_reference: externalReference,
      p_paid_amount_cents: toCents(payment.value),
      p_restaurant_id: invoice.restaurant_id,
    });
    if (rpcErr) return jsonResponse({ error: rpcErr.message || "Falha ao confirmar fatura." }, 422);
    return jsonResponse({
      success: true,
      invoice_id: invoice.id,
      plan_id: rpcResult?.plan_id ?? invoice.plan_id,
      billing_cycle: rpcResult?.billing_cycle ?? invoice.billing_cycle,
      amount_cents: invoice.amount_cents,
      payment_method: "pix",
      status: "paid",
      already_paid: Boolean(rpcResult?.already_paid),
      subscription_expires_at: rpcResult?.subscription_expires_at ?? null,
      max_tables: rpcResult?.max_tables ?? null,
    });
  }

  // Cobrança PENDING ou OVERDUE no Asaas: no Asaas, cobranças OVERDUE continuam pagáveis via Pix
  // (o Asaas não invalida o pagamento, recebendo webhooks normalmente).
  // Portanto, preservamos e recuperamos a cobrança existente recarregando o QR Code da MESMA cobrança.
  if (payment.status === "PENDING" || payment.status === "OVERDUE") {
    const nowMs = ctx.now();
    const localQrValid =
      payment.status === "PENDING" &&
      invoice.pix_qr_code_payload &&
      (!invoice.pix_expires_at || Date.parse(invoice.pix_expires_at) > nowMs);

    if (localQrValid) {
      const qr = await getAsaasPixQrCode(ctx.fetchImpl, ctx.baseUrl, ctx.apiKey, externalReference);
      return pendingPixResponse(invoice, ctx, {
        reused_pending_invoice: true,
        pix_qr_code_payload: invoice.pix_qr_code_payload,
        pix_qr_code_image: qr?.encodedImage ? `data:image/png;base64,${qr.encodedImage}` : undefined,
        pix_expires_at: invoice.pix_expires_at,
        asaas_payment_id: externalReference,
      });
    }

    // QR Code local vencido/ausente ou cobrança OVERDUE que segue pagável: recarrega o QR da MESMA cobrança existente
    const qr = await getAsaasPixQrCode(ctx.fetchImpl, ctx.baseUrl, ctx.apiKey, externalReference);
    if (!qr) return reconciliationResponse(invoice.id);
    const expirationDate = qr.expirationDate ? new Date(qr.expirationDate).toISOString() : ctx.pixExpiresAt;
    await ctx.adminClient
      .from("subscription_invoices")
      .update({ pix_qr_code_payload: qr.payload, pix_expires_at: expirationDate })
      .eq("id", invoice.id);
    return pendingPixResponse(invoice, ctx, {
      reused_pending_invoice: true,
      pix_qr_code_payload: qr.payload,
      pix_qr_code_image: qr.encodedImage ? `data:image/png;base64,${qr.encodedImage}` : undefined,
      pix_expires_at: expirationDate,
      asaas_payment_id: externalReference,
    });
  }

  // Somente estados terminais irrevogáveis confirmados pelo Asaas permitem expirar a fatura (ex.: cobrança cancelada/excluída)
  if (payment.deleted === true || payment.status === "REFUNDED") {
    const { error: expErr } = await ctx.adminClient.rpc("expire_subscription_invoice_after_reconciliation", {
      p_invoice_id: invoice.id,
      p_asaas_status: payment.deleted === true ? "DELETED" : "REFUNDED",
    });
    if (expErr) return reconciliationResponse(invoice.id);
    const next = await acquirePixInvoice(ctx);
    if (!next) return jsonResponse({ error: "Erro ao reservar nova fatura de assinatura." }, 500);
    return processPixInvoice(ctx, next, attempt + 1);
  }

  return reconciliationResponse(invoice.id);
}

/** Emissão autorizada pelo claim: única solicitação que pode executar POST /payments. */
async function emitPixWithClaim(ctx: PixContext, invoice: any, claimId: string): Promise<Response> {
  const customer = await ensureAsaasCustomer(ctx);
  if (!customer.ok) {
    // Nenhum POST /payments foi enviado: é seguro liberar o claim
    await ctx.adminClient.rpc("release_subscription_invoice_gateway_emission", {
      p_invoice_id: invoice.id,
      p_claim_id: claimId,
    });
    return jsonResponse({ error: customer.error }, customer.status);
  }

  let res: Response;
  try {
    res = await ctx.fetchImpl(`${ctx.baseUrl}/payments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", access_token: ctx.apiKey },
      body: JSON.stringify({
        customer: customer.id,
        billingType: "PIX",
        value: ctx.valueReais,
        dueDate: new Date(ctx.now()).toISOString().split("T")[0],
        description: ctx.description,
        externalReference: invoice.id,
      }),
    });
  } catch {
    // Timeout / falha de rede: resultado incerto. Bloqueia novos POSTs e exige reconciliação.
    await ctx.adminClient.rpc("mark_subscription_invoice_emission_uncertain", {
      p_invoice_id: invoice.id,
      p_claim_id: claimId,
    });
    return reconciliationResponse(invoice.id);
  }

  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (res.ok && body?.id) {
    const paymentId = String(body.id).trim();
    const { data: attachData, error: attachErr } = await ctx.adminClient.rpc("attach_subscription_invoice_external_reference", {
      p_invoice_id: invoice.id,
      p_external_reference: paymentId,
      p_claim_id: claimId,
    });
    if (attachErr || !attachData || attachData.attached !== true) {
      await ctx.adminClient.rpc("mark_subscription_invoice_emission_uncertain", {
        p_invoice_id: invoice.id,
        p_claim_id: claimId,
      });
      return reconciliationResponse(invoice.id);
    }

    const qr = await getAsaasPixQrCode(ctx.fetchImpl, ctx.baseUrl, ctx.apiKey, paymentId);
    if (!qr) {
      return jsonResponse(
        {
          error: "Cobrança PIX registrada no Asaas, mas o QR Code ainda não pôde ser carregado. Tente novamente para recuperar a mesma cobrança.",
          invoice_id: invoice.id,
          asaas_payment_id: paymentId,
        },
        502,
      );
    }
    const expirationDate = qr.expirationDate ? new Date(qr.expirationDate).toISOString() : ctx.pixExpiresAt;
    await ctx.adminClient
      .from("subscription_invoices")
      .update({ pix_qr_code_payload: qr.payload, pix_expires_at: expirationDate })
      .eq("id", invoice.id);

    return pendingPixResponse(invoice, ctx, {
      reused_pending_invoice: false,
      pix_qr_code_payload: qr.payload,
      pix_qr_code_image: qr.encodedImage ? `data:image/png;base64,${qr.encodedImage}` : undefined,
      pix_expires_at: expirationDate,
      asaas_payment_id: paymentId,
    });
  }

  // Rejeição definitiva de validação pelo Asaas (4xx exceto 408/409/429): nenhuma cobrança criada
  if (res.status >= 400 && res.status < 500 && ![408, 409, 429].includes(res.status)) {
    await ctx.adminClient
      .from("subscription_invoices")
      .update({ status: "failed" })
      .eq("id", invoice.id)
      .is("external_reference", null);
    return jsonResponse(
      { error: body?.errors?.[0]?.description || "Erro ao gerar cobrança PIX no Asaas." },
      400,
    );
  }

  // 5xx, 408, 409, 429 ou resposta sem ID: incerto
  await ctx.adminClient.rpc("mark_subscription_invoice_emission_uncertain", {
    p_invoice_id: invoice.id,
    p_claim_id: claimId,
  });
  return reconciliationResponse(invoice.id);
}

/** Fluxo PIX: reconciliação segura antes de qualquer alteração ou nova emissão. */
async function processPixInvoice(ctx: PixContext, invoice: any, attempt: number): Promise<Response> {
  if (attempt > 2) return reconciliationResponse(invoice.id);

  const ext = typeof invoice.external_reference === "string" ? invoice.external_reference.trim() : "";
  if (ext) return handleIssuedPixInvoice(ctx, invoice, ext, attempt);

  const { data: claim, error: claimErr } = await ctx.adminClient.rpc(
    "claim_subscription_invoice_gateway_emission",
    { p_invoice_id: invoice.id },
  );
  if (claimErr || !claim) return reconciliationResponse(invoice.id);

  if (claim.claimed && claim.claim_id) return emitPixWithClaim(ctx, invoice, claim.claim_id);

  if (claim.reason === "already_issued" && claim.external_reference) {
    return handleIssuedPixInvoice(
      ctx,
      { ...invoice, external_reference: claim.external_reference },
      String(claim.external_reference).trim(),
      attempt,
    );
  }

  if (claim.reason === "not_pending") {
    return jsonResponse(
      { error: "A fatura não está mais pendente. Atualize a página para ver o estado atual.", invoice_id: invoice.id },
      409,
    );
  }

  const startedMs = Date.parse(claim.started_at ?? "");
  const stale = !Number.isFinite(startedMs) || ctx.now() - startedMs > ctx.staleEmissionMs;

  // Outra solicitação detém a emissão e ainda está dentro da janela: não faz POST
  if (claim.reason === "in_progress" && !stale) return processingResponse(invoice.id);

  // needs_reconciliation ou claim parado (timeout/reinício): busca segura no Asaas, sem POST
  const search = await searchAsaasPaymentsByInvoice(ctx.fetchImpl, ctx.baseUrl, ctx.apiKey, invoice);

  if (search.kind === "one") {
    const paymentId = String(search.payment.id).trim();
    const { data: attachData, error: attachErr } = await ctx.adminClient.rpc("attach_subscription_invoice_external_reference", {
      p_invoice_id: invoice.id,
      p_external_reference: paymentId,
      p_claim_id: null,
    });
    if (attachErr || !attachData || attachData.attached !== true) return reconciliationResponse(invoice.id);
    return handleIssuedPixInvoice(ctx, { ...invoice, external_reference: paymentId }, paymentId, attempt);
  }

  if (search.kind === "none") {
    // Após timeout ou resposta incerta, não expirar automaticamente nem fazer novo POST apenas
    // porque uma busca retornou vazia (mesmo após 10 minutos).
    // Mantém a operação em reconciliação até haver evidência suficiente para uma ação segura.
    return reconciliationResponse(invoice.id);
  }

  // error | multiple | mismatch: ambíguo, não emite
  return reconciliationResponse(invoice.id);
}

export async function handleAsaasCheckoutRequest(
  req: Request,
  env: CheckoutHandlerEnv,
): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const fetchImpl = env.fetchFn ?? fetch;
  const nowFn = env.nowFn ?? (() => Date.now());
  const ASAAS_API_KEY = (env.asaasApiKey ?? "").trim();
  const ASAAS_BASE_URL = (env.asaasBaseUrl || "https://api.asaas.com/v3").trim().replace(/\/+$/, "");

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Não autenticado." }, 401);

    if (!ASAAS_API_KEY) {
      return jsonResponse({ error: "Gateway Asaas não configurado no servidor (ASAAS_API_KEY ausente)." }, 500);
    }

    const userClient = env.createSupabaseClient(env.supabaseUrl, env.supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user },
      error: authErr,
    } = await userClient.auth.getUser();
    if (authErr || !user?.id) return jsonResponse({ error: "Sessão inválida ou expirada." }, 401);

    const adminClient = env.createSupabaseClient(env.supabaseUrl, env.supabaseServiceRoleKey);
    const body = await req.json();
    const action = typeof body?.action === "string" ? body.action.trim() : "checkout";

    // =========================================================================
    // AÇÃO 1: VERIFICAÇÃO DIRETA DE PAGAMENTO NO ASAAS ("Validar pagamento")
    // =========================================================================
    if (action === "verify_payment") {
      const invoiceId = typeof body?.invoiceId === "string" ? body.invoiceId.trim() : "";
      if (!invoiceId) return jsonResponse({ error: "invoiceId é obrigatório para validar o pagamento." }, 400);

      const { data: invoice, error: invoiceErr } = await adminClient
        .from("subscription_invoices")
        .select("*")
        .eq("id", invoiceId)
        .maybeSingle();
      if (invoiceErr || !invoice) return jsonResponse({ error: "Fatura não encontrada." }, 404);

      if (body?.restaurantId && body.restaurantId !== invoice.restaurant_id) {
        return jsonResponse({ error: "Divergência de segurança: a fatura não pertence ao restaurante informado." }, 403);
      }

      const authorized = await isUserAuthorizedForRestaurant(adminClient, user.id, invoice.restaurant_id);
      if (!authorized) return jsonResponse({ error: "Acesso restrito ao administrador do restaurante." }, 403);

      let externalReference =
        typeof invoice.external_reference === "string" ? invoice.external_reference.trim() : "";

      // Reconciliação segura de fatura sem referência: exige exatamente 1 cobrança compatível no Asaas
      if (!externalReference) {
        const search = await searchAsaasPaymentsByInvoice(fetchImpl, ASAAS_BASE_URL, ASAAS_API_KEY, invoice);
        if (search.kind !== "one") {
          return jsonResponse(
            {
              error:
                search.kind === "none"
                  ? "Fatura sem cobrança vinculada no Asaas. Gere uma cobrança válida."
                  : PIX_RECONCILIATION_MESSAGE,
              needs_reconciliation: search.kind !== "none",
            },
            422,
          );
        }
        externalReference = String(search.payment.id).trim();
        const { data: attachData, error: attachErr } = await adminClient.rpc("attach_subscription_invoice_external_reference", {
          p_invoice_id: invoice.id,
          p_external_reference: externalReference,
          p_claim_id: null,
        });
        if (attachErr || !attachData || attachData.attached !== true) {
          return jsonResponse({ error: "Não foi possível vincular a referência externa reconciliada da fatura." }, 500);
        }
        invoice.external_reference = externalReference;
      }

      const paymentResult = await getAsaasPayment(fetchImpl, ASAAS_BASE_URL, ASAAS_API_KEY, externalReference);
      if (!paymentResult.ok) {
        return jsonResponse({ error: "Não foi possível consultar o status da cobrança na API do Asaas." }, 502);
      }
      const paymentData = paymentResult.payment;

      if (String(paymentData.id).trim() !== externalReference) {
        return jsonResponse({ error: "Divergência de segurança: ID da cobrança retornado pelo Asaas não confere." }, 422);
      }
      const asaasExtRef =
        typeof paymentData.externalReference === "string" ? paymentData.externalReference.trim() : "";
      if (!asaasExtRef || asaasExtRef !== String(invoice.id).trim()) {
        return jsonResponse(
          { error: "Divergência de segurança: a cobrança no Asaas não possui vínculo válido (externalReference) com esta fatura." },
          422,
        );
      }
      const asaasAmountCents = toCents(paymentData.value);
      if (asaasAmountCents !== Number(invoice.amount_cents)) {
        return jsonResponse(
          {
            error: `Divergência de segurança: valor da cobrança no Asaas (${asaasAmountCents}) difere do valor da fatura (${invoice.amount_cents}).`,
          },
          422,
        );
      }

      if (!isConfirmedAsaasStatus(paymentData.status)) {
        return jsonResponse({
          success: true,
          invoice_id: invoice.id,
          plan_id: invoice.plan_id,
          billing_cycle: invoice.billing_cycle,
          amount_cents: invoice.amount_cents,
          payment_method: invoice.payment_method,
          status: "pending",
          asaas_status: paymentData.status ?? "PENDING",
        });
      }

      const { data: rpcResult, error: rpcErr } = await adminClient.rpc("confirm_subscription_invoice_payment", {
        p_invoice_id: invoice.id,
        p_external_reference: String(paymentData.id).trim(),
        p_paid_amount_cents: asaasAmountCents,
        p_restaurant_id: invoice.restaurant_id,
      });
      if (rpcErr || !rpcResult?.status || rpcResult.status !== "paid") {
        return jsonResponse({ error: rpcErr?.message || "Falha ao confirmar fatura no servidor." }, 422);
      }

      return jsonResponse({
        success: true,
        invoice_id: invoice.id,
        plan_id: rpcResult?.plan_id ?? invoice.plan_id,
        billing_cycle: rpcResult?.billing_cycle ?? invoice.billing_cycle,
        amount_cents: invoice.amount_cents,
        payment_method: invoice.payment_method,
        status: "paid",
        already_paid: Boolean(rpcResult?.already_paid),
        subscription_expires_at: rpcResult?.subscription_expires_at ?? null,
        max_tables: rpcResult?.max_tables ?? null,
      });
    }

    // =========================================================================
    // AÇÃO 2: CRIAÇÃO DE CHECKOUT (PIX OU CARTÃO)
    // =========================================================================
    const {
      restaurantId,
      targetPlan,
      billingCycle = "monthly",
      paymentMethod = "pix",
      cardData,
      payerInfo,
    } = body;

    if (!restaurantId || !targetPlan) {
      return jsonResponse({ error: "restaurantId e targetPlan são obrigatórios." }, 400);
    }
    if (!["basic", "pro", "premium"].includes(targetPlan)) return jsonResponse({ error: "Plano inválido." }, 400);
    if (!["monthly", "yearly"].includes(billingCycle)) {
      return jsonResponse({ error: "Ciclo de faturamento inválido." }, 400);
    }
    if (!["pix", "credit_card", "debit_card"].includes(paymentMethod)) {
      return jsonResponse({ error: "Método de pagamento inválido." }, 400);
    }

    const authorized = await isUserAuthorizedForRestaurant(adminClient, user.id, restaurantId);
    if (!authorized) return jsonResponse({ error: "Acesso restrito ao administrador do restaurante." }, 403);

    const { data: restaurant, error: restErr } = await adminClient
      .from("restaurants")
      .select("*")
      .eq("id", restaurantId)
      .single();
    if (restErr || !restaurant) return jsonResponse({ error: "Restaurante não encontrado." }, 404);

    // Catálogo real em public.platform_settings (id = 'default'), sem fallback fixo
    const { data: settings, error: settingsErr } = await adminClient
      .from("platform_settings")
      .select("*")
      .eq("id", "default")
      .maybeSingle();
    if (settingsErr || !settings) {
      return jsonResponse(
        {
          error:
            "Não foi possível carregar o catálogo oficial de planos e preços (platform_settings id='default'). Cobrança cancelada por segurança.",
        },
        500,
      );
    }

    let monthlyEquivCents = 0;
    let maxTables = 0;
    let planTitle = "";
    if (targetPlan === "basic") {
      monthlyEquivCents = Number(settings.basic_price_cents);
      maxTables = Number(settings.basic_max_tables);
      planTitle = "Plano Básico";
    } else if (targetPlan === "pro") {
      monthlyEquivCents = Number(settings.pro_price_cents);
      maxTables = Number(settings.pro_max_tables);
      planTitle = "Plano Profissional";
    } else if (targetPlan === "premium") {
      monthlyEquivCents = Number(settings.premium_price_cents);
      maxTables = Number(settings.premium_max_tables);
      planTitle = "Plano Premium Enterprise";
    }

    if (!Number.isFinite(monthlyEquivCents) || monthlyEquivCents <= 0 || !Number.isFinite(maxTables) || maxTables <= 0) {
      return jsonResponse(
        { error: "Configuração de preço ou limite de mesas inválida em platform_settings. Cobrança cancelada por segurança." },
        500,
      );
    }

    const amountCents = billingCycle === "yearly" ? monthlyEquivCents * 10 : monthlyEquivCents;
    const valueReais = Number((amountCents / 100).toFixed(2));
    const cleanCpfCnpj = (payerInfo?.cpfCnpj || "").replace(/\D/g, "");
    if (cleanCpfCnpj.length !== 11 && cleanCpfCnpj.length !== 14) {
      return jsonResponse(
        { error: "Informe um CPF (11 dígitos) ou CNPJ (14 dígitos) válido para cobrança no Asaas." },
        400,
      );
    }

    const description = `Assinatura Eloozi - ${planTitle} (${billingCycle === "yearly" ? "Anual" : "Mensal"}) - ${restaurant.name}`;
    const pixExpiresAt = new Date(nowFn() + 30 * 60 * 1000).toISOString();

    // =========================================================================
    // FLUXO A: PIX — reserva da fatura + claim único de emissão + reconciliação
    // =========================================================================
    if (paymentMethod === "pix") {
      const ctx: PixContext = {
        adminClient,
        fetchImpl,
        baseUrl: ASAAS_BASE_URL,
        apiKey: ASAAS_API_KEY,
        restaurant,
        restaurantId,
        user,
        targetPlan,
        billingCycle,
        amountCents,
        valueReais,
        description,
        cleanCpfCnpj,
        payerInfo,
        pixExpiresAt,
        staleEmissionMs: env.staleEmissionMs ?? 10 * 60 * 1000,
        now: nowFn,
      };
      const invoice = await acquirePixInvoice(ctx);
      if (!invoice) return jsonResponse({ error: "Erro ao reservar fatura de assinatura no banco de dados." }, 500);
      return await processPixInvoice(ctx, invoice, 0);
    }

    // =========================================================================
    // FLUXO B: CARTÃO DE CRÉDITO — Protegido contra clique duplo e repetição após incerteza
    // =========================================================================
    // Se o restaurante já está com plano ativo pago correspondente ou se a fatura já foi paga
    const { data: latestPaid } = await adminClient
      .from("subscription_invoices")
      .select("*")
      .eq("restaurant_id", restaurantId)
      .eq("plan_id", targetPlan)
      .eq("billing_cycle", billingCycle)
      .eq("payment_method", paymentMethod)
      .eq("status", "paid")
      .order("created_at", { ascending: false })
      .limit(1);

    if (latestPaid?.[0]) {
      return jsonResponse({
        success: true,
        invoice_id: latestPaid[0].id,
        plan_id: targetPlan,
        billing_cycle: billingCycle,
        amount_cents: amountCents,
        payment_method: paymentMethod,
        status: "paid",
        already_paid: true,
        asaas_payment_id: latestPaid[0].external_reference,
      });
    }

    const { data: reservedData, error: reserveErr } = await adminClient.rpc(
      "acquire_or_create_pending_subscription_invoice",
      {
        p_restaurant_id: restaurantId,
        p_plan_id: targetPlan,
        p_billing_cycle: billingCycle,
        p_payment_method: paymentMethod,
        p_amount_cents: amountCents,
        p_pix_expires_at: null,
        p_card_brand: cardData?.card_brand || null,
        p_card_last4: cardData?.card_last4 || null,
        p_created_by: user.id,
      },
    );
    if (reserveErr || !reservedData?.invoice) {
      return jsonResponse({ error: reserveErr?.message || "Erro ao reservar fatura de assinatura no banco de dados." }, 500);
    }
    const invoice = reservedData.invoice;

    // Se a fatura foi marcada como paid (por ex. chamada concorrente acabou de confirmar):
    if (invoice.status === "paid") {
      return jsonResponse({
        success: true,
        invoice_id: invoice.id,
        plan_id: targetPlan,
        billing_cycle: billingCycle,
        amount_cents: amountCents,
        payment_method: paymentMethod,
        status: "paid",
        already_paid: true,
        asaas_payment_id: invoice.external_reference,
      });
    }

    // Se a fatura reutilizada já foi emitida ou possui referência externa, nunca faz novo POST
    const existingCardExt = typeof invoice.external_reference === "string" ? invoice.external_reference.trim() : "";
    if (existingCardExt) {
      const getRes = await getAsaasPayment(fetchImpl, ASAAS_BASE_URL, ASAAS_API_KEY, existingCardExt);
      if (!getRes.ok) return reconciliationResponse(invoice.id);
      const pay = getRes.payment;
      if (isConfirmedAsaasStatus(pay.status)) {
        const { data: confData, error: confErr } = await adminClient.rpc("confirm_subscription_invoice_payment", {
          p_invoice_id: invoice.id,
          p_external_reference: existingCardExt,
          p_paid_amount_cents: toCents(pay.value),
          p_restaurant_id: restaurantId,
        });
        if (confErr || !confData?.status || confData.status !== "paid") {
          return reconciliationResponse(invoice.id);
        }
        return jsonResponse({
          success: true,
          invoice_id: invoice.id,
          plan_id: targetPlan,
          billing_cycle: billingCycle,
          amount_cents: amountCents,
          payment_method: paymentMethod,
          status: "paid",
          already_paid: Boolean(confData.already_paid),
          subscription_expires_at: confData.subscription_expires_at ?? null,
          max_tables: confData.max_tables ?? maxTables,
          asaas_payment_id: existingCardExt,
        });
      }
      return jsonResponse({
        success: true,
        invoice_id: invoice.id,
        plan_id: targetPlan,
        billing_cycle: billingCycle,
        amount_cents: amountCents,
        payment_method: paymentMethod,
        status: "pending",
        asaas_payment_id: existingCardExt,
      });
    }

    // Se já está marcado como needs_reconciliation (após timeout ou resposta incerta): busca cobrança antes de qualquer ação
    if (invoice.gateway_emission_status === "needs_reconciliation") {
      const search = await searchAsaasPaymentsByInvoice(fetchImpl, ASAAS_BASE_URL, ASAAS_API_KEY, invoice);
      if (search.kind === "one") {
        const paymentId = String(search.payment.id).trim();
        const { data: attachData, error: attachErr } = await adminClient.rpc("attach_subscription_invoice_external_reference", {
          p_invoice_id: invoice.id,
          p_external_reference: paymentId,
          p_claim_id: null,
        });
        if (attachErr || !attachData || attachData.attached !== true) {
          // Falha ao vincular ou resposta inconsistente: preserva fatura e retorna resposta de reconciliação
          return reconciliationResponse(invoice.id);
        }

        if (isConfirmedAsaasStatus(search.payment.status)) {
          const { data: confData, error: confErr } = await adminClient.rpc("confirm_subscription_invoice_payment", {
            p_invoice_id: invoice.id,
            p_external_reference: paymentId,
            p_paid_amount_cents: toCents(search.payment.value),
            p_restaurant_id: restaurantId,
          });
          if (confErr || !confData?.status || confData.status !== "paid") {
            // Falha ao confirmar ou resultado inconsistente: preserva fatura e exige reconciliação segura
            return reconciliationResponse(invoice.id);
          }
          return jsonResponse({
            success: true,
            invoice_id: invoice.id,
            plan_id: targetPlan,
            billing_cycle: billingCycle,
            amount_cents: amountCents,
            payment_method: paymentMethod,
            status: "paid",
            already_paid: Boolean(confData.already_paid),
            subscription_expires_at: confData.subscription_expires_at ?? null,
            max_tables: confData.max_tables ?? maxTables,
            asaas_payment_id: paymentId,
          });
        }
        return jsonResponse({
          success: true,
          invoice_id: invoice.id,
          plan_id: targetPlan,
          billing_cycle: billingCycle,
          amount_cents: amountCents,
          payment_method: paymentMethod,
          status: "pending",
          asaas_payment_id: paymentId,
        });
      }
      // Se não há evidência incontestável ou se deu erro/mismatch, mantém em reconciliação sem novo POST
      return reconciliationResponse(invoice.id);
    }

    const { data: claim } = await adminClient.rpc("claim_subscription_invoice_gateway_emission", {
      p_invoice_id: invoice.id,
    });
    if (!claim?.claimed) {
      if (claim?.reason === "needs_reconciliation") {
        return reconciliationResponse(invoice.id);
      }
      return processingResponse(invoice.id);
    }

    const rawCardNumber = (cardData?.card_number || "").replace(/\D/g, "");
    const holderName = (cardData?.holder_name || payerInfo?.name || restaurant.name).trim();
    const expMonth = String(cardData?.exp_month || "").padStart(2, "0");
    const expYear = String(cardData?.exp_year || "");
    const ccv = String(cardData?.cvv || "").trim();

    if (!rawCardNumber || !holderName || !expMonth || !expYear || !ccv) {
      await adminClient.from("subscription_invoices").update({ status: "failed" }).eq("id", invoice.id);
      return jsonResponse({ error: "Dados completos do cartão são obrigatórios para cobrança no Asaas." }, 400);
    }

    const cardCtx = {
      fetchImpl,
      baseUrl: ASAAS_BASE_URL,
      apiKey: ASAAS_API_KEY,
      cleanCpfCnpj,
      payerInfo,
      restaurant,
      user,
    } as unknown as PixContext;
    const customer = await ensureAsaasCustomer(cardCtx);
    if (!customer.ok) {
      await adminClient.rpc("release_subscription_invoice_gateway_emission", {
        p_invoice_id: invoice.id,
        p_claim_id: claim.claim_id,
      });
      await adminClient.from("subscription_invoices").update({ status: "failed" }).eq("id", invoice.id);
      return jsonResponse({ error: customer.error }, customer.status);
    }

    const remoteIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "177.54.144.10";

    let cardRes: Response;
    try {
      cardRes = await fetchImpl(`${ASAAS_BASE_URL}/payments`, {
        method: "POST",
        headers: { "Content-Type": "application/json", access_token: ASAAS_API_KEY },
        body: JSON.stringify({
          customer: customer.id,
          billingType: "CREDIT_CARD",
          value: valueReais,
          dueDate: new Date(nowFn()).toISOString().split("T")[0],
          description,
          externalReference: invoice.id,
          creditCard: { holderName, number: rawCardNumber, expiryMonth: expMonth, expiryYear: expYear, ccv },
          creditCardHolderInfo: {
            name: holderName,
            email: user.email || "financeiro@eloozi.com.br",
            cpfCnpj: cleanCpfCnpj,
            postalCode: (payerInfo?.postalCode || "01310100").replace(/\D/g, ""),
            addressNumber: payerInfo?.addressNumber || "100",
            phone: (payerInfo?.phone || restaurant.phone || "11999999999").replace(/\D/g, ""),
          },
          remoteIp,
        }),
      });
    } catch {
      await adminClient.rpc("mark_subscription_invoice_emission_uncertain", {
        p_invoice_id: invoice.id,
        p_claim_id: claim.claim_id,
      });
      return reconciliationResponse(invoice.id);
    }

    let cardResData: any = null;
    try {
      cardResData = await cardRes.json();
    } catch {
      cardResData = null;
    }

    if (!cardRes.ok || !cardResData?.id) {
      if (cardRes.status >= 400 && cardRes.status < 500 && ![408, 409, 429].includes(cardRes.status)) {
        await adminClient.from("subscription_invoices").update({ status: "failed" }).eq("id", invoice.id);
        return jsonResponse(
          { error: cardResData?.errors?.[0]?.description || "Transação recusada pela operadora do cartão." },
          400,
        );
      }
      await adminClient.rpc("mark_subscription_invoice_emission_uncertain", {
        p_invoice_id: invoice.id,
        p_claim_id: claim.claim_id,
      });
      return reconciliationResponse(invoice.id);
    }

    const cardPaymentId = String(cardResData.id).trim();
    const { data: attachData, error: attachErr } = await adminClient.rpc("attach_subscription_invoice_external_reference", {
      p_invoice_id: invoice.id,
      p_external_reference: cardPaymentId,
      p_claim_id: claim.claim_id,
    });

    if (attachErr || !attachData || attachData.attached !== true) {
      // Falha ao vincular ou resposta inconsistente após POST bem-sucedido no gateway:
      // Marca como incerto para reconciliação segura e não retorna sucesso prematuro
      await adminClient.rpc("mark_subscription_invoice_emission_uncertain", {
        p_invoice_id: invoice.id,
        p_claim_id: claim.claim_id,
      });
      return reconciliationResponse(invoice.id);
    }

    const confirmedCents = toCents(cardResData.value);
    if (!isConfirmedAsaasStatus(cardResData.status) || confirmedCents !== amountCents) {
      return jsonResponse({
        success: true,
        invoice_id: invoice.id,
        plan_id: targetPlan,
        billing_cycle: billingCycle,
        amount_cents: amountCents,
        payment_method: paymentMethod,
        status: "pending",
        asaas_payment_id: cardPaymentId,
      });
    }

    const { data: confirmData, error: confirmErr } = await adminClient.rpc("confirm_subscription_invoice_payment", {
      p_invoice_id: invoice.id,
      p_external_reference: cardPaymentId,
      p_paid_amount_cents: confirmedCents,
      p_restaurant_id: restaurantId,
    });
    if (confirmErr || !confirmData?.status || confirmData.status !== "paid") {
      // Cobrança confirmada no Asaas mas RPC de ativação falhou ou retornou resultado inconsistente:
      // Preserva a fatura e retorna resposta de reconciliação, sem emitir nova cobrança
      return reconciliationResponse(invoice.id);
    }

    if (cardData?.save_card && cardData?.card_last4) {
      await adminClient.from("restaurant_payment_methods").update({ is_default: false }).eq("restaurant_id", restaurantId);
      await adminClient.from("restaurant_payment_methods").insert({
        restaurant_id: restaurantId,
        method_type: paymentMethod,
        holder_name: holderName,
        card_brand: cardData.card_brand || "card",
        card_last4: cardData.card_last4,
        exp_month: Number(expMonth),
        exp_year: Number(expYear),
        gateway_token: cardResData.creditCard?.creditCardToken || `asaas_${cardPaymentId}`,
        is_default: true,
      });
    }

    return jsonResponse({
      success: true,
      invoice_id: invoice.id,
      plan_id: targetPlan,
      billing_cycle: billingCycle,
      amount_cents: amountCents,
      payment_method: paymentMethod,
      status: "paid",
      subscription_expires_at: confirmData?.subscription_expires_at ?? null,
      max_tables: confirmData?.max_tables ?? maxTables,
      asaas_payment_id: cardPaymentId,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Erro interno no servidor de pagamentos.";
    return jsonResponse({ error: message }, 500);
  }
}

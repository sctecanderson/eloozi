import { supabase } from '../../lib/supabase';

export type SubscriptionPlanId = 'basic' | 'pro' | 'premium';
export type BillingCycle = 'monthly' | 'yearly';
export type PaymentMethodType = 'pix' | 'credit_card' | 'debit_card';
export type InvoiceStatus = 'pending' | 'paid' | 'failed' | 'expired' | 'refunded';
export type RestaurantBillingStatus = 'active' | 'grace_period' | 'expired';

export interface PlanCatalogItem {
  plan_id?: SubscriptionPlanId;
  name: string;
  monthly_price_cents: number;
  yearly_price_cents: number;
  max_tables: number | null;
  unlimited_tables?: boolean;
  features: string[];
}

export interface SubscriptionInvoiceItem {
  id: string;
  plan_id: SubscriptionPlanId;
  billing_cycle: BillingCycle;
  amount_cents: number;
  payment_method: PaymentMethodType;
  status: InvoiceStatus;
  pix_qr_code_payload: string | null;
  pix_expires_at: string | null;
  card_brand: string | null;
  card_last4: string | null;
  external_reference: string | null;
  paid_at: string | null;
  created_at: string;
}

export interface SavedPaymentMethod {
  id: string;
  method_type: 'credit_card' | 'debit_card';
  holder_name: string | null;
  card_brand: string | null;
  card_last4: string | null;
  exp_month: number | null;
  exp_year: number | null;
  is_default: boolean;
  created_at: string;
}

export interface RestaurantBillingSummary {
  restaurant: {
    id: string;
    name: string;
    slug: string;
    subscription_plan: SubscriptionPlanId;
    subscription_started_at: string;
    subscription_expires_at: string;
    billing_cycle_days: number;
    max_tables: number | null;
    unlimited_tables?: boolean;
    monthly_price_cents: number;
    active: boolean;
    billing_status: RestaurantBillingStatus;
    days_remaining: number;
  };
  usage: {
    tables_count: number;
    products_count: number;
  };
  catalog: {
    basic: PlanCatalogItem;
    pro: PlanCatalogItem;
    premium: PlanCatalogItem;
  };
  invoices: SubscriptionInvoiceItem[];
  payment_methods: SavedPaymentMethod[];
}

export interface CheckoutResult {
  invoice_id: string;
  plan_id: SubscriptionPlanId;
  billing_cycle: BillingCycle;
  amount_cents: number;
  payment_method: PaymentMethodType;
  status: InvoiceStatus;
  reused_pending_invoice?: boolean;
  already_paid?: boolean;
  pix_qr_code_payload?: string;
  pix_qr_code_image?: string;
  pix_expires_at?: string;
  subscription_expires_at?: string;
  max_tables?: number | null;
  unlimited_tables?: boolean;
}

async function extractFunctionErrorMessage(
  err: unknown,
  fallbackMessage: string,
): Promise<string> {
  if (!err || typeof err !== 'object') {
    return fallbackMessage;
  }

  const maybeContext = (err as { context?: { json?: () => Promise<{ error?: string }> } }).context;
  if (maybeContext && typeof maybeContext.json === 'function') {
    try {
      const errBody = await maybeContext.json();
      if (errBody && typeof errBody.error === 'string' && errBody.error.trim().length > 0) {
        return errBody.error.trim();
      }
    } catch {
      // Ignora erro de parse do body
    }
  }

  const maybeMessage = (err as { message?: string }).message;
  if (typeof maybeMessage === 'string' && maybeMessage.trim().length > 0) {
    return maybeMessage.trim();
  }

  return fallbackMessage;
}

export type SubscriptionInvoice = SubscriptionInvoiceItem;
export type BillingSummaryResponse = RestaurantBillingSummary;

export async function fetchRestaurantBillingSummary(
  restaurantId: string,
): Promise<RestaurantBillingSummary> {
  const { data, error } = await supabase.rpc('get_restaurant_billing_summary', {
    p_restaurant_id: restaurantId,
  });

  if (error) {
    throw new Error(error.message || 'Falha ao carregar informações financeiras do restaurante.');
  }

  return data as RestaurantBillingSummary;
}

export const fetchBillingSummary = fetchRestaurantBillingSummary;

export async function createSubscriptionCheckout(params: {
  quoteToken?: string;
  restaurantId: string;
  targetPlan: SubscriptionPlanId;
  billingCycle: BillingCycle;
  paymentMethod: PaymentMethodType;
  cardData?: {
    holder_name?: string;
    card_number?: string;
    card_brand?: string;
    card_last4?: string;
    exp_month?: number;
    exp_year?: number;
    cvv?: string;
    save_card?: boolean;
  } | null;
  payerInfo?: {
    cpfCnpj?: string;
    name?: string;
    postalCode?: string;
    addressNumber?: string;
    phone?: string;
  } | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabaseClient?: any;
}): Promise<CheckoutResult> {
  const client = params.supabaseClient ?? supabase;

  // Checkout exclusivamente via endpoint de servidor (asaas-checkout).
  // Nenhum fallback local ou modo de simulação enviado pelo navegador é permitido.
  const { data: fnData, error: fnError } = await client.functions.invoke('asaas-checkout', {
    body: {
      action: 'checkout',
      restaurantId: params.restaurantId,
      targetPlan: params.targetPlan,
      quoteToken: params.quoteToken,
      billingCycle: params.billingCycle,
      paymentMethod: params.paymentMethod,
      cardData: params.cardData || null,
      payerInfo: params.payerInfo || null,
    },
  });

  if (fnError) {
    const message = await extractFunctionErrorMessage(
      fnError,
      'Falha ao comunicar com o gateway de pagamentos Asaas.',
    );
    throw new Error(message);
  }

  if (fnData?.error) {
    throw new Error(String(fnData.error));
  }

  if (!fnData?.invoice_id) {
    throw new Error('Resposta inválida do servidor de pagamentos Asaas.');
  }

  return {
    invoice_id: fnData.invoice_id,
    plan_id: fnData.plan_id,
    billing_cycle: fnData.billing_cycle,
    amount_cents: fnData.amount_cents,
    payment_method: fnData.payment_method,
    status: fnData.status,
    reused_pending_invoice: Boolean(fnData.reused_pending_invoice),
    pix_qr_code_payload: fnData.pix_qr_code_payload,
    pix_qr_code_image: fnData.pix_qr_code_image,
    pix_expires_at: fnData.pix_expires_at,
    subscription_expires_at: fnData.subscription_expires_at,
    max_tables: fnData.max_tables ?? null,
    unlimited_tables: Boolean(fnData.unlimited_tables),
  };
}

export async function confirmSubscriptionInvoice(
  invoiceId: string,
  options?: {
    restaurantId?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabaseClient?: any;
  },
): Promise<CheckoutResult> {
  const trimmedInvoiceId = (invoiceId || '').trim();
  if (!trimmedInvoiceId) {
    throw new Error('ID da fatura é obrigatório para validar o pagamento.');
  }

  const client = options?.supabaseClient ?? supabase;

  // Validação de pagamento consulta exclusivamente o endpoint de servidor,
  // que verifica o status real diretamente na API do Asaas antes de confirmar.
  const { data: fnData, error: fnError } = await client.functions.invoke('asaas-checkout', {
    body: {
      action: 'verify_payment',
      invoiceId: trimmedInvoiceId,
      restaurantId: options?.restaurantId,
    },
  });

  if (fnError) {
    const message = await extractFunctionErrorMessage(
      fnError,
      'Não foi possível validar o pagamento no servidor.',
    );
    throw new Error(message);
  }

  if (fnData?.error) {
    throw new Error(String(fnData.error));
  }

  if (!fnData?.invoice_id || !fnData?.status) {
    throw new Error('Resposta inválida ao verificar status do pagamento.');
  }

  return {
    invoice_id: fnData.invoice_id,
    plan_id: fnData.plan_id,
    billing_cycle: fnData.billing_cycle,
    amount_cents: fnData.amount_cents,
    payment_method: fnData.payment_method,
    status: fnData.status,
    already_paid: Boolean(fnData.already_paid),
    subscription_expires_at: fnData.subscription_expires_at,
    max_tables: fnData.max_tables ?? null,
    unlimited_tables: Boolean(fnData.unlimited_tables),
  };
}

export async function deleteSavedPaymentMethod(
  restaurantId: string,
  methodId: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc('delete_restaurant_payment_method', {
    p_restaurant_id: restaurantId,
    p_method_id: methodId,
  });

  if (error) {
    throw new Error(error.message || 'Não foi possível remover o cartão salvo.');
  }

  return Boolean(data);
}

export function formatCurrencyBRL(cents: number): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format((cents || 0) / 100);
}

export interface ResolvedCatalogPlanView {
  planId: SubscriptionPlanId;
  valid: boolean;
  canCheckout: boolean;
  validationMessage: string | null;
  monthlyPriceCents: number | null;
  yearlyPriceCents: number | null;
  yearlyMonthlyEquivalentCents: number | null;
  maxTables: number | null;
  unlimitedTables: boolean;
  primaryPriceLabel: string;
  primaryPeriodSuffix: string;
  secondaryBillingLabel: string | null;
  tablesBenefitLabel: string;
  comparisonTablesLabel: string;
  yearlySavingsCents: number;
  yearlyFreeMonthsEquivalent: number | null;
  yearlySavingsBadgeLabel: string | null;
}

export interface ResolvedCatalogView {
  plans: Record<SubscriptionPlanId, ResolvedCatalogPlanView>;
  hasAnyInvalidPlan: boolean;
  globalWarningMessage: string | null;
  yearlyToggleBadgeLabel: string | null;
}

function isValidPriceCents(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function isValidMaxTables(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

export function resolvePlanCatalogItemView(
  planId: SubscriptionPlanId,
  rawItem: Partial<PlanCatalogItem> | null | undefined,
  cycle: BillingCycle,
): ResolvedCatalogPlanView {
  const hasMonthlyPrice = isValidPriceCents(rawItem?.monthly_price_cents);
  const hasYearlyPrice = isValidPriceCents(rawItem?.yearly_price_cents);
  const isExplicitUnlimited =
    rawItem?.unlimited_tables === true &&
    (rawItem?.max_tables === null || rawItem?.max_tables === undefined);
  const hasFiniteMaxTables = rawItem?.unlimited_tables !== true && isValidMaxTables(rawItem?.max_tables);
  const hasValidCapacity = isExplicitUnlimited || hasFiniteMaxTables;

  const monthlyPriceCents = hasMonthlyPrice ? rawItem!.monthly_price_cents! : null;
  const yearlyPriceCents = hasYearlyPrice ? rawItem!.yearly_price_cents! : null;
  const maxTables = hasFiniteMaxTables ? rawItem!.max_tables! : null;
  const unlimitedTables = isExplicitUnlimited;

  const valid = hasMonthlyPrice && hasYearlyPrice && hasValidCapacity;
  const canCheckout = valid;

  let validationMessage: string | null = null;
  if (!valid) {
    validationMessage =
      'Dados deste plano indisponíveis ou incompletos no catálogo do servidor. Contratação temporariamente bloqueada.';
  }

  const yearlyMonthlyEquivalentCents =
    yearlyPriceCents !== null ? Math.round(yearlyPriceCents / 12) : null;

  let primaryPriceLabel = 'Indisponível';
  let primaryPeriodSuffix = '';
  let secondaryBillingLabel: string | null = null;

  if (cycle === 'monthly') {
    if (monthlyPriceCents !== null) {
      primaryPriceLabel = formatCurrencyBRL(monthlyPriceCents);
      primaryPeriodSuffix = '/mês';
      if (yearlyPriceCents !== null) {
        secondaryBillingLabel = `Ou ${formatCurrencyBRL(yearlyPriceCents)}/ano no ciclo anual`;
      }
    }
  } else {
    if (yearlyPriceCents !== null && yearlyMonthlyEquivalentCents !== null) {
      primaryPriceLabel = formatCurrencyBRL(yearlyMonthlyEquivalentCents);
      primaryPeriodSuffix = '/mês (equivalente)';
      secondaryBillingLabel = `Total cobrado no ano: ${formatCurrencyBRL(yearlyPriceCents)}`;
    }
  }

  let yearlySavingsCents = 0;
  let yearlyFreeMonthsEquivalent: number | null = null;
  let yearlySavingsBadgeLabel: string | null = null;

  if (monthlyPriceCents !== null && yearlyPriceCents !== null && monthlyPriceCents > 0) {
    const annualAtMonthlyRate = monthlyPriceCents * 12;
    if (yearlyPriceCents < annualAtMonthlyRate) {
      yearlySavingsCents = annualAtMonthlyRate - yearlyPriceCents;
      const exactFreeMonths = yearlySavingsCents / monthlyPriceCents;
      if (Math.abs(exactFreeMonths - Math.round(exactFreeMonths)) < 1e-6 && Math.round(exactFreeMonths) >= 1) {
        const months = Math.round(exactFreeMonths);
        yearlyFreeMonthsEquivalent = months;
        yearlySavingsBadgeLabel = months === 1 ? '1 MÊS GRÁTIS' : `${months} MESES GRÁTIS`;
      } else {
        const pct = Math.round((yearlySavingsCents / annualAtMonthlyRate) * 100);
        if (pct > 0) {
          yearlySavingsBadgeLabel = `ECONOMIZE ${pct}%`;
        }
      }
    }
  }

  const tablesBenefitLabel = unlimitedTables
    ? 'Mesas simultâneas ilimitadas'
    : maxTables !== null
      ? `Até ${maxTables} ${maxTables === 1 ? 'mesa simultânea' : 'mesas simultâneas'}`
      : 'Limite de mesas indisponível no catálogo';

  const comparisonTablesLabel = unlimitedTables
    ? 'Ilimitadas'
    : maxTables !== null
      ? `Até ${maxTables} mesas`
      : 'Indisponível';

  return {
    planId,
    valid,
    canCheckout,
    validationMessage,
    monthlyPriceCents,
    yearlyPriceCents,
    yearlyMonthlyEquivalentCents,
    maxTables,
    unlimitedTables,
    primaryPriceLabel,
    primaryPeriodSuffix,
    secondaryBillingLabel,
    tablesBenefitLabel,
    comparisonTablesLabel,
    yearlySavingsCents,
    yearlyFreeMonthsEquivalent,
    yearlySavingsBadgeLabel,
  };
}

export function resolveSubscriptionCatalogView(
  catalog: Partial<Record<SubscriptionPlanId, Partial<PlanCatalogItem> | null>> | null | undefined,
  cycle: BillingCycle,
): ResolvedCatalogView {
  const basic = resolvePlanCatalogItemView('basic', catalog?.basic, cycle);
  const pro = resolvePlanCatalogItemView('pro', catalog?.pro, cycle);
  const premium = resolvePlanCatalogItemView('premium', catalog?.premium, cycle);

  const allPlans = [basic, pro, premium];
  const hasAnyInvalidPlan = allPlans.some((p) => !p.valid);

  const globalWarningMessage = hasAnyInvalidPlan
    ? 'Algumas informações do catálogo de planos não puderam ser validadas no servidor. Os planos afetados estão bloqueados para contratação até a normalização.'
    : null;

  let yearlyToggleBadgeLabel: string | null = null;
  if (allPlans.every((p) => p.valid && p.yearlySavingsCents > 0)) {
    const firstFreeMonths = basic.yearlyFreeMonthsEquivalent;
    if (
      firstFreeMonths !== null &&
      allPlans.every((p) => p.yearlyFreeMonthsEquivalent === firstFreeMonths)
    ) {
      yearlyToggleBadgeLabel =
        firstFreeMonths === 1 ? '1 MÊS GRÁTIS' : `${firstFreeMonths} MESES GRÁTIS`;
    } else {
      yearlyToggleBadgeLabel = 'DESCONTO ANUAL';
    }
  }

  return {
    plans: { basic, pro, premium },
    hasAnyInvalidPlan,
    globalWarningMessage,
    yearlyToggleBadgeLabel,
  };
}

export function detectCardBrand(cardNumber: string): string {
  const clean = cardNumber.replace(/\D/g, '');
  if (/^4/.test(clean)) return 'visa';
  if (/^(5[1-5]|2[2-7])/.test(clean)) return 'mastercard';
  if (/^(4011|4312|4389|4514|4576|5041|5066|5090|6277|6362|6363|650|651|655)/.test(clean)) {
    return 'elo';
  }
  if (/^3[47]/.test(clean)) return 'amex';
  if (/^(606282|3841)/.test(clean)) return 'hipercard';
  return 'card';
}

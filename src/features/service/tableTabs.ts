import { supabase } from '../../lib/supabase';

export interface TableTab {
  id: string;
  restaurant_id: string;
  restaurant_table_id: string;
  table_visit_id: string;
  label: string;
  status: 'open' | 'closed';
  created_by_member_id: string;
  created_at: string;
  closed_by_member_id: string | null;
  closed_at: string | null;
  subtotal_in_cents?: number | null;
  service_fee_percent?: number | null;
  service_fee_in_cents?: number | null;
  total_in_cents?: number | null;
  service_fee_accepted?: boolean | null;
}

export interface TabClosureCalculation {
  subtotalInCents: number;
  serviceFeePercent: number;
  serviceFeeInCents: number;
  totalInCents: number;
  serviceFeeAccepted: boolean;
}

/**
 * Arredondamento decimal exato (round half away from zero),
 * correspondente à aritmética da função round(numeric) do PostgreSQL:
 * round(calculated_subtotal * (applied_fee_pct / 100.0))::integer
 * Evita perdas de precisão de ponto flutuante binário IEEE 754 (onde 50 * 0.29 resulta em 14.499999999999998).
 * Suporta percentuais inteiros (ex: 10, 29) e fracionários (ex: 10.5, 12.75).
 */
export function calculateTabClosureFee(
  subtotalInCents: number,
  feePercent: number,
): number {
  if (subtotalInCents <= 0 || feePercent <= 0) return 0;

  const safeSubtotal = Math.max(0, Math.round(subtotalInCents));
  const safeFeePercent = Math.max(0, Math.min(30, feePercent));

  // Converte a taxa decimal para escala inteira exata
  const pctStr = String(safeFeePercent);
  const dotIdx = pctStr.indexOf('.');
  const scale = dotIdx >= 0 ? pctStr.length - dotIdx - 1 : 0;
  const factor = Math.pow(10, scale);
  const intPct = Math.round(safeFeePercent * factor);

  const numerator = BigInt(safeSubtotal) * BigInt(intPct);
  const denominator = BigInt(100) * BigInt(factor);

  // Arredondamento half-up (half away from zero) idêntico ao PostgreSQL
  const remainder = numerator % denominator;
  let quotient = numerator / denominator;
  if (remainder * 2n >= denominator) {
    quotient += 1n;
  }

  return Number(quotient);
}

/**
 * Calcula a prévia financeira centralizada do fechamento de uma comanda.
 * Centraliza os cálculos para o modal de encerramento e para os testes.
 */
export function calculateTabClosurePreview(
  subtotalInCents: number,
  restaurantFeePercent: number,
  serviceFeeAccepted: boolean,
): TabClosureCalculation {
  const safeSubtotal = Math.max(0, Math.round(subtotalInCents));
  const hasFee = restaurantFeePercent > 0;
  const isFeeApplicable = hasFee && serviceFeeAccepted;

  const feeInCents = isFeeApplicable
    ? calculateTabClosureFee(safeSubtotal, restaurantFeePercent)
    : 0;

  const totalInCents = safeSubtotal + feeInCents;

  return {
    subtotalInCents: safeSubtotal,
    serviceFeePercent: isFeeApplicable ? restaurantFeePercent : 0,
    serviceFeeInCents: feeInCents,
    totalInCents,
    serviceFeeAccepted: isFeeApplicable,
  };
}

export interface TableTabGuest {
  guest_session_id: string;
  table_tab_id: string;
  table_visit_id: string;
  restaurant_id: string;
  restaurant_table_id: string;
  linked_by_member_id: string;
  linked_at: string;
}

export interface ConfirmedTabGuest {
  id: string;
  confirmed_at: string;
  expires_at: string;
}

export interface TableTabsState {
  tabs: TableTab[];
  guests: ConfirmedTabGuest[];
  links: TableTabGuest[];
}

function operationError(
  error: { code?: string; message: string },
  fallback: string,
) {
  return new Error(
    error.code === '42501' || error.code === '22023'
      ? error.message
      : fallback,
  );
}

export async function getTableTabsState(
  restaurantId: string,
  tableVisitId: string,
): Promise<TableTabsState> {
  const [tabsResult, guestsResult, linksResult] = await Promise.all([
    supabase
      .from('table_tabs')
      .select('*')
      .eq('restaurant_id', restaurantId)
      .eq('table_visit_id', tableVisitId)
      .eq('status', 'open')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .overrideTypes<TableTab[], { merge: false }>(),

    supabase
      .from('guest_sessions')
      .select('id, confirmed_at, expires_at')
      .eq('restaurant_id', restaurantId)
      .eq('table_visit_id', tableVisitId)
      .eq('status', 'active')
      .order('confirmed_at', { ascending: true })
      .order('id', { ascending: true })
      .overrideTypes<ConfirmedTabGuest[], { merge: false }>(),

    supabase
      .from('table_tab_guests')
      .select('*')
      .eq('restaurant_id', restaurantId)
      .eq('table_visit_id', tableVisitId)
      .overrideTypes<TableTabGuest[], { merge: false }>(),
  ]);

  if (tabsResult.error || guestsResult.error || linksResult.error) {
    throw new Error(
      'Não foi possível carregar as comandas e os clientes. Tente novamente.',
    );
  }

  return {
    tabs: tabsResult.data ?? [],
    guests: guestsResult.data ?? [],
    links: linksResult.data ?? [],
  };
}

export async function createTableTab(
  restaurantSlug: string,
  tableVisitId: string,
  label: string,
  tableTabId: string,
): Promise<TableTab> {
  const { data, error } = await supabase
    .rpc('create_table_tab', {
      p_restaurant_slug: restaurantSlug,
      p_table_visit_id: tableVisitId,
      p_label: label.trim(),
      p_table_tab_id: tableTabId,
    })
    .single()
    .overrideTypes<TableTab, { merge: false }>();

  if (error) {
    throw operationError(error, 'Não foi possível criar a comanda.');
  }

  if (
    !data ||
    data.id !== tableTabId ||
    data.table_visit_id !== tableVisitId
  ) {
    throw new Error(
      'Não foi possível confirmar a criação. Atualize a lista antes de tentar novamente.',
    );
  }

  return data;
}

export async function linkGuestToTableTab(
  restaurantSlug: string,
  tableTabId: string,
  guestSessionId: string,
): Promise<TableTabGuest> {
  const { data, error } = await supabase
    .rpc('link_guest_to_table_tab', {
      p_restaurant_slug: restaurantSlug,
      p_table_tab_id: tableTabId,
      p_guest_session_id: guestSessionId,
    })
    .single()
    .overrideTypes<TableTabGuest, { merge: false }>();

  if (error) {
    throw operationError(error, 'Não foi possível vincular o cliente.');
  }

  if (
    !data ||
    data.table_tab_id !== tableTabId ||
    data.guest_session_id !== guestSessionId
  ) {
    throw new Error('O vínculo não foi confirmado pelo servidor.');
  }

  return data;
}

export async function closeTableTab(
  restaurantSlug: string,
  tableTabId: string,
  finalServiceFeeAccepted?: boolean,
): Promise<TableTab> {
  if (!tableTabId || !tableTabId.trim()) {
    throw new Error('Informe a comanda que deseja encerrar.');
  }

  const { data, error } = await supabase
    .rpc('close_table_tab', {
      p_restaurant_slug: restaurantSlug,
      p_table_tab_id: tableTabId,
      p_final_service_fee_accepted: finalServiceFeeAccepted ?? null,
    })
    .single()
    .overrideTypes<TableTab, { merge: false }>();

  if (error) {
    throw operationError(error, 'Não foi possível encerrar a comanda.');
  }

  if (!data) {
    // Obter confirmação por leitura autorizada caso a RPC não retorne o payload
    const { data: verified, error: readError } = await supabase
      .from('table_tabs')
      .select('*')
      .eq('id', tableTabId)
      .maybeSingle();

    if (readError || !verified || verified.id !== tableTabId || verified.status !== 'closed') {
      throw new Error('O encerramento não foi confirmado pelo servidor.');
    }
    return verified as TableTab;
  }

  if (data.id !== tableTabId || data.status !== 'closed') {
    throw new Error('O encerramento não foi confirmado pelo servidor.');
  }

  return data;
}

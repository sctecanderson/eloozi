import { supabase } from '../../lib/supabase';
import type { TableTab } from './tableTabs';
import { calculateTabClosureFee } from './tableTabs';

export function getOpenTabIds(tabs: Array<{ id: string; status: string }>): string[] {
  return [...new Set(tabs.filter(tab => tab.status === 'open').map(tab => tab.id))];
}

export function createSplitBillBasis(
  isJointSelection: boolean,
  selectedTabId: string | null,
  totalInCents: number,
) {
  return {
    kind: isJointSelection ? 'joint' as const : 'individual' as const,
    tabId: isJointSelection ? null : selectedTabId,
    totalInCents,
  };
}

export function aggregateOpenTabs(
  tabs: Array<{ id: string; status: string }>,
  consumptions: Record<string, {
    status: string;
    totalInCents: number;
    isStale?: boolean;
  } | undefined>,
  feePercent: number,
) {
  let subtotalInCents = 0;
  let serviceFeeInCents = 0;
  let incomplete = false;

  for (const tab of tabs) {
    if (tab.status !== 'open') continue;
    const consumption = consumptions[tab.id];
    if (!consumption || consumption.status !== 'loaded' || consumption.isStale) {
      incomplete = true;
      continue;
    }
    subtotalInCents += consumption.totalInCents;
    serviceFeeInCents += calculateTabClosureFee(consumption.totalInCents, feePercent);
  }

  return {
    subtotalInCents,
    serviceFeeInCents,
    totalInCents: subtotalInCents + serviceFeeInCents,
    incomplete,
  };
}

export function collectOpenTabItems<T extends { id: string; status: string }>(
  tabs: Array<{ id: string; status: string }>,
  consumptions: Record<string, { items: T[] } | undefined>,
): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const tab of tabs) {
    if (tab.status !== 'open') continue;
    for (const item of consumptions[tab.id]?.items ?? []) {
      if (item.status !== 'active' || seen.has(item.id)) continue;
      seen.add(item.id);
      result.push(item);
    }
  }
  return result;
}

export interface TabsPaymentPreview {
  restaurantId: string;
  tableId: string;
  visitId: string;
  previewToken: string;
  tabs: Array<{ id: string; label: string; subtotalInCents: number; serviceFeeInCents: number; totalInCents: number }>;
  totalInCents: number;
}
export interface TabsPaymentResult {
  paymentId: string;
  tabs: TableTab[];
  totalInCents: number;
  openTabsCount: number;
}
const money = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object';
const sameIds = (rows: Array<{ id: string }>, ids: string[]) =>
  rows.length === ids.length && new Set(ids).size === ids.length && [...rows.map(r => r.id)].sort().join(',') === [...ids].sort().join(',');

/** Only the server computes totals; the token also detects consumption/fee changes. */
export async function previewTabsPayment(slug: string, ids: string[], fee: boolean): Promise<TabsPaymentPreview> {
  const { data, error } = await supabase.rpc('preview_table_tabs_payment', {
    p_restaurant_slug: slug, p_table_tab_ids: ids, p_service_fee_accepted: fee,
  });
  if (error) throw new Error(error.message || 'Não foi possível conferir as comandas.');
  if (!record(data) || typeof data.restaurantId !== 'string' || typeof data.tableId !== 'string'
    || typeof data.visitId !== 'string' || typeof data.previewToken !== 'string' || !data.previewToken
    || !money(data.totalInCents) || !Array.isArray(data.tabs)
    || !data.tabs.every(t => record(t) && typeof t.id === 'string' && typeof t.label === 'string'
      && money(t.subtotalInCents) && money(t.serviceFeeInCents) && money(t.totalInCents)
      && t.totalInCents === t.subtotalInCents + t.serviceFeeInCents)
    || !sameIds(data.tabs, ids) || data.tabs.reduce((sum, t) => sum + t.totalInCents, 0) !== data.totalInCents) {
    throw new Error('O servidor não confirmou os valores das comandas selecionadas.');
  }
  return data as unknown as TabsPaymentPreview;
}

export async function confirmTabsPayment(slug: string, ids: string[], fee: boolean, paymentId: string, preview: TabsPaymentPreview): Promise<TabsPaymentResult> {
  const { data, error } = await supabase.rpc('close_table_tabs', {
    p_restaurant_slug: slug, p_table_tab_ids: ids, p_service_fee_accepted: fee,
    p_payment_id: paymentId, p_preview_token: preview.previewToken,
  });
  if (error) throw new Error(error.message || 'Não foi possível confirmar a quitação.');
  if (!record(data) || data.paymentId !== paymentId || !Array.isArray(data.tabs)
    || !data.tabs.every(t => record(t) && typeof t.id === 'string' && t.status === 'closed'
      && t.restaurant_id === preview.restaurantId && t.table_visit_id === preview.visitId
      && t.restaurant_table_id === preview.tableId && money(t.total_in_cents))
    || !sameIds(data.tabs, ids) || data.totalInCents !== preview.totalInCents
    || data.tabs.reduce((sum, t) => sum + t.total_in_cents, 0) !== data.totalInCents
    || !money(data.openTabsCount)) {
    throw new Error('O servidor não confirmou a quitação de todas as comandas. Atualize antes de continuar.');
  }
  return data as unknown as TabsPaymentResult;
}

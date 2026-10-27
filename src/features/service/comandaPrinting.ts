import { calculateTabClosurePreview } from './tableTabs';
import type { ThermalBillItem } from '../../components/ThermalReceiptPrint';

export interface ComandaPrintPayload {
  restaurantName: string;
  tableNumber: number;
  tabLabel: string;
  items: ThermalBillItem[];
  subtotalInCents: number;
  serviceFeePercent: number;
  serviceFeeInCents: number;
  totalInCents: number;
  paperWidth: '58mm' | '80mm';
}

export interface PrintableComanda {
  label: string;
  tableNumber: number;
  status: 'open' | 'preparing' | 'ready' | 'waiting_bill' | 'closed' | string;
  subtotalInCents?: number | null;
  serviceFeePercent?: number | null;
  serviceFeeInCents?: number | null;
  totalInCents: number;
  serviceFeeAccepted?: boolean | null;
  items: Array<{
    product_name: string;
    quantity: number;
    unit_price_in_cents: number;
    line_total_in_cents: number;
    status: string;
  }>;
}

/**
 * Função de produção compartilhada que extrai o demonstrativo contábil para impressão térmica.
 * Garante que:
 * 1. Comandas fechadas utilizem snapshots persistidos e imutáveis (sem recalcular com a taxa atual do restaurante).
 * 2. Comandas abertas utilizem a prévia decimal exata e sejam identificadas como "(Pré-conta)".
 */
export function buildComandaPrintPayload(
  card: PrintableComanda,
  restaurantName?: string | null,
  restaurantFeePercent?: number | null
): ComandaPrintPayload {
  const isClosed = card.status === 'closed';
  const activeItems = (card.items || []).filter((it) => it.status === 'active');

  let subtotalInCents = 0;
  let feePercent = 0;
  let feeInCents = 0;
  let grandTotalInCents = 0;
  let tabLabel = card.label;

  if (isClosed) {
    // 1. Snapshot persistido: não recalcula pela configuração atual do restaurante
    subtotalInCents = card.subtotalInCents ?? card.totalInCents;
    feePercent = card.serviceFeePercent ?? 0;
    feeInCents = card.serviceFeeAccepted === false ? 0 : (card.serviceFeeInCents ?? 0);
    grandTotalInCents = card.totalInCents;
    tabLabel = `${card.label}`;
  } else {
    // 2. Comanda aberta: reutiliza cálculo de prévia decimal e rotula pré-conta
    const calculatedSubtotal = activeItems.reduce((acc, cur) => acc + (cur.line_total_in_cents || 0), 0);
    const feeRate = restaurantFeePercent ?? 10;

    const preview = calculateTabClosurePreview(calculatedSubtotal, feeRate, true);
    subtotalInCents = preview.subtotalInCents;
    feePercent = preview.serviceFeePercent;
    feeInCents = preview.serviceFeeInCents;
    grandTotalInCents = preview.totalInCents;
    tabLabel = `${card.label} (Pré-conta)`;
  }

  const receiptItems: ThermalBillItem[] = activeItems.map((it) => ({
    name: it.product_name,
    quantity: it.quantity,
    unitPriceInCents: it.unit_price_in_cents,
    totalInCents: it.line_total_in_cents,
  }));

  return {
    restaurantName: restaurantName || 'NOMA Restaurante e Bar',
    tableNumber: card.tableNumber,
    tabLabel,
    items: receiptItems,
    subtotalInCents,
    serviceFeePercent: feePercent,
    serviceFeeInCents: feeInCents,
    totalInCents: grandTotalInCents,
    paperWidth: '80mm',
  };
}

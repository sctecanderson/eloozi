import { supabase } from '../../lib/supabase';
import { getTimezoneUtcRange, toTimezoneDateString } from './staffDateUtils';

export interface TabItemRow {
  id: string;
  table_tab_id: string;
  product_id?: string;
  product_name: string;
  quantity: number;
  unit_price_in_cents: number;
  line_total_in_cents: number;
  status: 'active' | 'cancelled';
  production_status?: string;
  created_at?: string;
}

export interface StaffHistoryRecord {
  id: string;
  tableVisitId: string;
  tableTabId: string | null;
  tableNumber: number | null;
  tableLabel: string | null;
  tabLabel: string;
  status: 'closed';
  openedAt: string;
  closedAt: string;
  durationMinutes: number;
  itemsCount: number;
  confirmedGuestsCount: number | null;
  subtotalInCents: number;
  serviceFeePercent: number | null;
  serviceFeeInCents: number;
  serviceFeeAccepted: boolean;
  totalInCents: number;
  items: TabItemRow[];
  closedByMemberId: string | null;
  assignedMemberId: string | null;
  relatedTabsCount?: number;
  recordType?: 'tab' | 'visit' | 'closure';
  visitStatus?: 'open' | 'closed';
  visitOpenedAt?: string | null;
  visitClosedAt?: string | null;
}

export interface HistorySummary {
  totalAttendances: number;
  totalVisits: number;
  totalTabs: number;
  totalEncerramentos: number;
  ticketMedioInCents: number;
  tempoMedioMinutes: number;
}

export type HistoryPeriod = 'hoje' | '7dias' | '30dias' | 'custom';
export type HistoryCategoryFilter = 'todos' | 'mesas' | 'contas' | 'encerramentos';

/**
 * Calcula o intervalo UTC para consultas no banco de dados respeitando o timezone configurado do restaurante.
 * Correção: a data civil calculada com Date.UTC NÃO pode ser novamente convertida para o fuso
 * do restaurante via toTimezoneDateString, pois isso retrocederia outro dia em fusos negativos (ex: America/Sao_Paulo).
 * Hoje + 6 dias anteriores resulta em exatamente 7 datas civis.
 * Hoje + 29 dias anteriores resulta em exatamente 30 datas civis.
 */
export function getHistoryPeriodUtcRange(
  period: HistoryPeriod,
  customDateStr: string | null,
  timeZone: string,
  referenceDateInput?: Date | string
): { startUtc: string; endUtc: string } {
  const refDate = referenceDateInput
    ? (typeof referenceDateInput === 'string' ? new Date(referenceDateInput) : referenceDateInput)
    : new Date();

  const todayStr = toTimezoneDateString(refDate, timeZone);

  if (period === 'custom' && customDateStr) {
    const { startUtc, nextDayStartUtc } = getTimezoneUtcRange(customDateStr, timeZone);
    return { startUtc, endUtc: nextDayStartUtc };
  }

  const { startUtc: todayStartUtc, nextDayStartUtc: todayEndUtc } = getTimezoneUtcRange(todayStr, timeZone);

  if (period === 'hoje') {
    return { startUtc: todayStartUtc, endUtc: todayEndUtc };
  }

  const daysBack = period === '7dias' ? 6 : 29;
  const [y, m, d] = todayStr.split('-').map(Number);

  // Aritmética pura de datas civis usando Date.UTC para transição correta de mês e ano
  const targetUtcDate = new Date(Date.UTC(y, m - 1, d - daysBack, 12, 0, 0));
  const pastY = targetUtcDate.getUTCFullYear();
  const pastM = String(targetUtcDate.getUTCMonth() + 1).padStart(2, '0');
  const pastD = String(targetUtcDate.getUTCDate()).padStart(2, '0');
  const pastDateStr = `${pastY}-${pastM}-${pastD}`;

  // Obter o início exato em UTC daquela data civil no fuso do restaurante
  const { startUtc: pastStartUtc } = getTimezoneUtcRange(pastDateStr, timeZone);

  return {
    startUtc: pastStartUtc,
    endUtc: todayEndUtc,
  };
}

/**
 * Agrupa comandas por atendimento de mesa (tableVisitId), consolidando valores
 * e itens de todas as comandas da visita sem duplicidade e sem descartar nada.
 */
export function groupRecordsByTableVisit(records: StaffHistoryRecord[]): StaffHistoryRecord[] {
  const visitGroups = new Map<string, StaffHistoryRecord[]>();

  for (const r of records) {
    const key = r.tableVisitId || r.id;
    const group = visitGroups.get(key) || [];
    group.push(r);
    visitGroups.set(key, group);
  }

  const grouped: StaffHistoryRecord[] = [];

  for (const [visitId, group] of visitGroups.entries()) {
    if (group.length === 1 && group[0].recordType === 'visit') {
      grouped.push(group[0]);
      continue;
    }

    group.sort((a, b) => new Date(a.openedAt).getTime() - new Date(b.openedAt).getTime());

    const first = group[0];
    const last = group[group.length - 1];

    const openedAtMs = Math.min(...group.map((r) => new Date(r.openedAt).getTime()));
    const closedAtMs = Math.max(...group.map((r) => new Date(r.closedAt).getTime()));
    const openedAt = new Date(openedAtMs).toISOString();
    const closedAt = new Date(closedAtMs).toISOString();
    const durationMinutes = Math.max(1, Math.round((closedAtMs - openedAtMs) / 60000));

    const subtotalInCents = group.reduce((sum, r) => sum + r.subtotalInCents, 0);
    const serviceFeeInCents = group.reduce((sum, r) => sum + r.serviceFeeInCents, 0);
    const totalInCents = group.reduce((sum, r) => sum + r.totalInCents, 0);
    const anyFeeAccepted = group.some((r) => r.serviceFeeAccepted);

    const allItems: TabItemRow[] = [];
    for (const r of group) {
      if (r.items) {
        allItems.push(...r.items);
      }
    }
    const activeItems = allItems.filter((i) => i.status === 'active');
    const itemsCount = activeItems.reduce((acc, it) => acc + (it.quantity || 1), 0);

    let totalGuests: number | null = null;
    let hasKnownGuests = false;
    for (const r of group) {
      if (r.confirmedGuestsCount !== null) {
        hasKnownGuests = true;
        totalGuests = (totalGuests ?? 0) + r.confirmedGuestsCount;
      }
    }
    if (!hasKnownGuests) {
      totalGuests = 0;
    }

    const tableNum = first.tableNumber;
    const tableLabel = first.tableLabel;
    const tableNumStr = tableNum !== null ? `Mesa ${String(tableNum).padStart(2, '0')}` : 'Mesa Indisponível';
    const tabLabel = group.length > 1
      ? `${tableNumStr} (${group.length} comandas)`
      : (first.tabLabel || tableNumStr);

    grouped.push({
      id: `visit-${visitId}`,
      tableVisitId: visitId,
      tableTabId: null,
      tableNumber: tableNum,
      tableLabel: tableLabel,
      tabLabel,
      status: 'closed',
      openedAt,
      closedAt,
      durationMinutes,
      itemsCount,
      confirmedGuestsCount: totalGuests,
      subtotalInCents,
      serviceFeePercent: group.length === 1 ? first.serviceFeePercent : null,
      serviceFeeInCents,
      serviceFeeAccepted: anyFeeAccepted,
      totalInCents,
      items: allItems,
      closedByMemberId: last.closedByMemberId,
      assignedMemberId: first.assignedMemberId,
      relatedTabsCount: group.length,
      recordType: 'visit',
      visitStatus: first.visitStatus,
      visitOpenedAt: first.visitOpenedAt,
      visitClosedAt: first.visitClosedAt,
    });
  }

  grouped.sort((a, b) => new Date(b.closedAt).getTime() - new Date(a.closedAt).getTime());
  return grouped;
}

/**
 * Filtra os registros em memória por texto de busca e categoria selecionada.
 * - 'mesas': agrupa todas as comandas por tableVisitId, consolidando consumo total e itens sem duplicidade.
 * - 'contas': exibe cada comanda individual fechada.
 * - 'encerramentos': monta EXCLUSIVAMENTE a partir de visitas comprovadamente encerradas (table_visits com status='closed'
 *    e closed_at real). Comanda fechada com visita ainda aberta NÃO aparece em Encerramentos. Cada visita fechada
 *    aparece uma única vez com seus horários reais da visita.
 */
export function filterHistoryRecords(
  records: StaffHistoryRecord[],
  searchQuery: string,
  categoryFilter: HistoryCategoryFilter
): StaffHistoryRecord[] {
  let filtered: StaffHistoryRecord[] = [];

  if (categoryFilter === 'mesas') {
    filtered = groupRecordsByTableVisit(records);
  } else if (categoryFilter === 'contas') {
    filtered = records.filter((r) => r.tableTabId !== null);
  } else if (categoryFilter === 'encerramentos') {
    // 1. Filtrar APENAS comandas cuja mesa/visita foi comprovadamente encerrada (table_visits com status='closed')
    // Comanda fechada com visita ainda aberta NÃO aparece em Encerramentos.
    const closedVisitTabs = records.filter(
      (r) => r.visitStatus === 'closed' && Boolean(r.visitClosedAt)
    );

    // 2. Agrupar por tableVisitId para que cada visita fechada apareça UMA ÚNICA VEZ
    const visitGroups = new Map<string, StaffHistoryRecord[]>();
    for (const r of closedVisitTabs) {
      const key = r.tableVisitId;
      const group = visitGroups.get(key) || [];
      group.push(r);
      visitGroups.set(key, group);
    }

    const closures: StaffHistoryRecord[] = [];
    for (const [visitId, group] of visitGroups.entries()) {
      group.sort((a, b) => new Date(a.openedAt).getTime() - new Date(b.openedAt).getTime());
      const first = group[0];
      const last = group[group.length - 1];

      // Usar opened_at e closed_at REAIS da visita
      const realVisitOpenedAt = first.visitOpenedAt || first.openedAt;
      const realVisitClosedAt = first.visitClosedAt || last.closedAt;
      const startMs = new Date(realVisitOpenedAt).getTime();
      const endMs = new Date(realVisitClosedAt).getTime();
      const durationMinutes = Math.max(1, Math.round((endMs - startMs) / 60000));

      const subtotalInCents = group.reduce((sum, r) => sum + r.subtotalInCents, 0);
      const serviceFeeInCents = group.reduce((sum, r) => sum + r.serviceFeeInCents, 0);
      const totalInCents = group.reduce((sum, r) => sum + r.totalInCents, 0);
      const anyFeeAccepted = group.some((r) => r.serviceFeeAccepted);

      const allItems: TabItemRow[] = [];
      for (const r of group) {
        if (r.items) allItems.push(...r.items);
      }
      const activeItems = allItems.filter((i) => i.status === 'active');
      const itemsCount = activeItems.reduce((acc, it) => acc + (it.quantity || 1), 0);

      let totalGuests = 0;
      for (const r of group) {
        if (r.confirmedGuestsCount !== null) {
          totalGuests += r.confirmedGuestsCount;
        }
      }

      const tableNum = first.tableNumber;
      const tableLabel = first.tableLabel;
      const tableNumStr = tableNum !== null ? `Mesa ${String(tableNum).padStart(2, '0')}` : 'Mesa Indisponível';

      closures.push({
        id: `closure-${visitId}`,
        tableVisitId: visitId,
        tableTabId: null,
        tableNumber: tableNum,
        tableLabel,
        tabLabel: `${tableNumStr} — Encerramento de Atendimento`,
        status: 'closed',
        openedAt: realVisitOpenedAt,
        closedAt: realVisitClosedAt,
        durationMinutes,
        itemsCount,
        confirmedGuestsCount: totalGuests,
        subtotalInCents,
        serviceFeePercent: group.length === 1 ? first.serviceFeePercent : null,
        serviceFeeInCents,
        serviceFeeAccepted: anyFeeAccepted,
        totalInCents,
        items: allItems,
        closedByMemberId: last.closedByMemberId,
        assignedMemberId: first.assignedMemberId,
        relatedTabsCount: group.length,
        recordType: 'closure',
        visitStatus: 'closed',
        visitOpenedAt: realVisitOpenedAt,
        visitClosedAt: realVisitClosedAt,
      });
    }

    closures.sort((a, b) => new Date(b.closedAt).getTime() - new Date(a.closedAt).getTime());
    filtered = closures;
  } else {
    // 'todos'
    filtered = records;
  }

  // Filtro de busca textual
  const trimmed = searchQuery.trim().toLowerCase();
  if (!trimmed) {
    return filtered;
  }

  return filtered.filter((r) => {
    if (r.tableNumber !== null) {
      const tableNumStr = String(r.tableNumber).padStart(2, '0');
      const tableNumRaw = String(r.tableNumber);
      if (tableNumStr.includes(trimmed) || tableNumRaw.includes(trimmed)) return true;
    }
    if (r.tableLabel && r.tableLabel.toLowerCase().includes(trimmed)) return true;
    if (r.tabLabel && r.tabLabel.toLowerCase().includes(trimmed)) return true;
    if (r.id && r.id.toLowerCase().includes(trimmed)) return true;
    return false;
  });
}

/**
 * Calcula o resumo consolidado de atendimentos, ticket médio e tempo médio.
 * Diferencia visitas de mesas e contas individuais nos indicadores.
 * Previne contagem dupla somando apenas comandas distintas ou visitas únicas.
 */
export function calculateHistorySummary(records: StaffHistoryRecord[]): HistorySummary {
  if (records.length === 0) {
    return {
      totalAttendances: 0,
      totalVisits: 0,
      totalTabs: 0,
      totalEncerramentos: 0,
      ticketMedioInCents: 0,
      tempoMedioMinutes: 0,
    };
  }

  const distinctVisits = new Set<string>();
  const distinctTabs = new Set<string>();
  const distinctClosedVisits = new Set<string>();

  for (const r of records) {
    if (r.tableVisitId) {
      distinctVisits.add(r.tableVisitId);
      if (r.visitStatus === 'closed' && r.visitClosedAt) {
        distinctClosedVisits.add(r.tableVisitId);
      } else if (r.recordType === 'closure') {
        distinctClosedVisits.add(r.tableVisitId);
      }
    }
    if (r.tableTabId) {
      distinctTabs.add(r.tableTabId);
    }
  }

  const isGroupedByVisit = records.every((r) => r.recordType === 'visit' || r.recordType === 'closure');
  let totalRevenueInCents = 0;
  let totalDurationMinutes = 0;

  if (isGroupedByVisit) {
    for (const r of records) {
      totalRevenueInCents += r.totalInCents;
      totalDurationMinutes += Math.max(0, r.durationMinutes);
    }
  } else {
    const processedTabs = new Set<string>();
    for (const r of records) {
      totalDurationMinutes += Math.max(0, r.durationMinutes);
      if (r.tableTabId) {
        if (!processedTabs.has(r.tableTabId)) {
          processedTabs.add(r.tableTabId);
          totalRevenueInCents += r.totalInCents;
        }
      } else {
        totalRevenueInCents += r.totalInCents;
      }
    }
  }

  const totalAttendances = records.length;
  const totalVisits = distinctVisits.size;
  const totalTabs = distinctTabs.size;
  const totalEncerramentos = distinctClosedVisits.size;

  const ticketMedioInCents = totalAttendances > 0 ? Math.round(totalRevenueInCents / totalAttendances) : 0;
  const tempoMedioMinutes = totalAttendances > 0 ? Math.round(totalDurationMinutes / totalAttendances) : 0;

  return {
    totalAttendances,
    totalVisits,
    totalTabs,
    totalEncerramentos,
    ticketMedioInCents,
    tempoMedioMinutes,
  };
}

/**
 * Formata duração em minutos para o formato visual "1h 24min" ou "42min".
 */
export function formatHistoryDuration(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes));
  if (m < 60) {
    return `${m}min`;
  }
  const hours = Math.floor(m / 60);
  const remMinutes = m % 60;
  if (remMinutes === 0) {
    return `${hours}h`;
  }
  return `${hours}h ${remMinutes}min`;
}

/**
 * Formata horário no fuso do restaurante (ex: "13:57").
 */
export function formatTimeOfDay(isoString: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(isoString));
  } catch {
    return isoString.slice(11, 16);
  }
}

/**
 * Formata data no fuso do restaurante (ex: "24/10/2026").
 */
export function formatDate(isoString: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      timeZone,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(new Date(isoString));
  } catch {
    return isoString.slice(0, 10);
  }
}

/**
 * Gera string CSV estruturada com escape RFC-4180 e UTF-8 BOM.
 * Remove dados fictícios de fallback: quando indisponível, exporta "Indisponível".
 * Preserva zero quando confirmado.
 */
export function exportHistoryToCsv(records: StaffHistoryRecord[], timeZone: string): string {
  const headers = [
    'Data',
    'Mesa',
    'Ambiente',
    'Comanda',
    'UUID',
    'Entrada',
    'Saída',
    'Duração (min)',
    'Itens Ativos',
    'Acessos Confirmados',
    'Subtotal (R$)',
    'Taxa Serviço (%)',
    'Taxa Aceita',
    'Taxa Serviço (R$)',
    'Total (R$)',
  ];

  function escapeCsvCell(cell: unknown): string {
    if (cell === null || cell === undefined) return '';
    const str = String(cell);
    if (str.includes(',') || str.includes(';') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  const rows = records.map((r) => {
    const dateFormatted = formatDate(r.closedAt || r.openedAt, timeZone);
    const timeIn = formatTimeOfDay(r.openedAt, timeZone);
    const timeOut = formatTimeOfDay(r.closedAt, timeZone);
    const subtotalFormatted = (r.subtotalInCents / 100).toFixed(2).replace('.', ',');
    const feeFormatted = (r.serviceFeeInCents / 100).toFixed(2).replace('.', ',');
    const totalFormatted = (r.totalInCents / 100).toFixed(2).replace('.', ',');

    const tableNumStr = r.tableNumber !== null ? String(r.tableNumber).padStart(2, '0') : 'Indisponível';
    const tableLabelStr = r.tableLabel ? r.tableLabel : 'Indisponível';
    const guestsStr = r.confirmedGuestsCount !== null ? String(r.confirmedGuestsCount) : 'Indisponível';

    return [
      escapeCsvCell(dateFormatted),
      escapeCsvCell(tableNumStr),
      escapeCsvCell(tableLabelStr),
      escapeCsvCell(r.tabLabel),
      escapeCsvCell(r.id),
      escapeCsvCell(timeIn),
      escapeCsvCell(timeOut),
      escapeCsvCell(r.durationMinutes),
      escapeCsvCell(r.itemsCount),
      escapeCsvCell(guestsStr),
      escapeCsvCell(subtotalFormatted),
      escapeCsvCell(r.serviceFeePercent ?? 0),
      escapeCsvCell(r.serviceFeeAccepted ? 'Sim' : 'Não'),
      escapeCsvCell(feeFormatted),
      escapeCsvCell(totalFormatted),
    ].join(';');
  });

  return '\uFEFF' + [headers.join(';'), ...rows].join('\r\n');
}

/**
 * Consulta atendimentos finalizados com snapshots contábeis completos no Supabase.
 * - Pagina e busca em lotes para não descartar dados após limites padrão.
 * - Trata explicitamente erros de visitas, mesas, itens e acessos.
 * - Remove fallbacks fictícios (tableNumber ?? 1, "Salão principal", guestsCount || 1).
 * - Consulta status real de table_visits para diferenciar comandas de visitas abertas vs encerradas.
 */
export async function fetchStaffHistoryData(
  restaurantId: string,
  memberId: string,
  role: 'admin' | 'waiter',
  timeZone: string,
  period: HistoryPeriod,
  customDateStr: string | null = null
): Promise<StaffHistoryRecord[]> {
  if (!restaurantId) return [];

  const { startUtc, endUtc } = getHistoryPeriodUtcRange(period, customDateStr, timeZone);

  // 1. Consultar comandas encerradas no período com paginação por range
  const allTabs: Array<{
    id: string;
    label: string | null;
    status: string;
    created_at: string;
    closed_at: string | null;
    table_visit_id: string;
    restaurant_table_id: string | null;
    closed_by_member_id: string | null;
    subtotal_in_cents: number | null;
    service_fee_percent: number | null;
    service_fee_in_cents: number | null;
    total_in_cents: number | null;
    service_fee_accepted: boolean | null;
  }> = [];

  let tabFrom = 0;
  const TAB_PAGE_SIZE = 1000;
  let hasMoreTabs = true;

  while (hasMoreTabs) {
    const { data: tabsChunk, error: tabsErr } = await supabase
      .from('table_tabs')
      .select(`
        id,
        label,
        status,
        created_at,
        closed_at,
        table_visit_id,
        restaurant_table_id,
        closed_by_member_id,
        subtotal_in_cents,
        service_fee_percent,
        service_fee_in_cents,
        total_in_cents,
        service_fee_accepted
      `)
      .eq('restaurant_id', restaurantId)
      .eq('status', 'closed')
      .gte('closed_at', startUtc)
      .lt('closed_at', endUtc)
      .order('closed_at', { ascending: false })
      .range(tabFrom, tabFrom + TAB_PAGE_SIZE - 1);

    if (tabsErr) {
      throw new Error(`Erro ao carregar comandas do histórico: ${tabsErr.message}`);
    }

    if (tabsChunk && tabsChunk.length > 0) {
      allTabs.push(...tabsChunk);
      if (tabsChunk.length < TAB_PAGE_SIZE) {
        hasMoreTabs = false;
      } else {
        tabFrom += TAB_PAGE_SIZE;
      }
    } else {
      hasMoreTabs = false;
    }
  }

  // 2. Consultar atendimentos de mesa (table_visits) encerrados no período com paginação
  const allVisits: Array<{
    id: string;
    status: string;
    opened_at: string;
    closed_at: string | null;
    restaurant_table_id: string;
    assigned_member_id: string | null;
  }> = [];

  let visitFrom = 0;
  const VISIT_PAGE_SIZE = 1000;
  let hasMoreVisits = true;

  while (hasMoreVisits) {
    let visitsQuery = supabase
      .from('table_visits')
      .select(`
        id,
        status,
        opened_at,
        closed_at,
        restaurant_table_id,
        assigned_member_id
      `)
      .eq('restaurant_id', restaurantId)
      .eq('status', 'closed')
      .gte('closed_at', startUtc)
      .lt('closed_at', endUtc);

    if (role === 'waiter' && memberId) {
      visitsQuery = visitsQuery.eq('assigned_member_id', memberId);
    }

    const { data: visitsChunk, error: visitsErr } = await visitsQuery
      .range(visitFrom, visitFrom + VISIT_PAGE_SIZE - 1);

    if (visitsErr) {
      throw new Error(`Erro ao carregar atendimentos de mesa do histórico: ${visitsErr.message}`);
    }

    if (visitsChunk && visitsChunk.length > 0) {
      allVisits.push(...visitsChunk);
      if (visitsChunk.length < VISIT_PAGE_SIZE) {
        hasMoreVisits = false;
      } else {
        visitFrom += VISIT_PAGE_SIZE;
      }
    } else {
      hasMoreVisits = false;
    }
  }

  // 3. Consultar mesas do restaurante com tratamento explícito de erro
  const { data: tablesData, error: tablesErr } = await supabase
    .from('restaurant_tables')
    .select('id, table_number, label')
    .eq('restaurant_id', restaurantId);

  if (tablesErr) {
    throw new Error(`Erro ao carregar mesas do histórico: ${tablesErr.message}`);
  }

  const tablesMap = new Map<string, { table_number: number; label: string | null }>();
  for (const t of tablesData || []) {
    tablesMap.set(t.id, { table_number: t.table_number, label: t.label });
  }

  // Mapa de status e horários reais das visitas
  const visitsMap = new Map<
    string,
    { id: string; status: 'open' | 'closed'; opened_at: string; closed_at: string | null; restaurant_table_id: string; assigned_member_id: string | null }
  >();

  for (const v of allVisits) {
    visitsMap.set(v.id, {
      id: v.id,
      status: v.status as 'open' | 'closed',
      opened_at: v.opened_at,
      closed_at: v.closed_at,
      restaurant_table_id: v.restaurant_table_id,
      assigned_member_id: v.assigned_member_id,
    });
  }

  const CHUNK_SIZE = 100;

  // Carregar status de visitas vinculadas às comandas que ainda não foram consultadas (ex.: mesas ainda abertas)
  const visitIdsFromTabs = Array.from(new Set(allTabs.map((t) => t.table_visit_id).filter(Boolean)));
  const missingVisitIds = visitIdsFromTabs.filter((id) => !visitsMap.has(id));

  if (missingVisitIds.length > 0) {
    for (let i = 0; i < missingVisitIds.length; i += CHUNK_SIZE) {
      const chunk = missingVisitIds.slice(i, i + CHUNK_SIZE);
      const { data: missingVisits, error: missingErr } = await supabase
        .from('table_visits')
        .select('id, status, opened_at, closed_at, restaurant_table_id, assigned_member_id')
        .eq('restaurant_id', restaurantId)
        .in('id', chunk);

      if (missingErr) {
        throw new Error(`Erro ao verificar status das visitas vinculadas: ${missingErr.message}`);
      }

      if (missingVisits) {
        for (const mv of missingVisits) {
          visitsMap.set(mv.id, {
            id: mv.id,
            status: mv.status as 'open' | 'closed',
            opened_at: mv.opened_at,
            closed_at: mv.closed_at,
            restaurant_table_id: mv.restaurant_table_id,
            assigned_member_id: mv.assigned_member_id,
          });
        }
      }
    }
  }

  const tabIds = allTabs.map((t) => t.id);

  // 4. Consultar itens das comandas do histórico em lotes (sem descartar após 200)
  const itemsMap = new Map<string, TabItemRow[]>();

  if (tabIds.length > 0) {
    for (let i = 0; i < tabIds.length; i += CHUNK_SIZE) {
      const chunk = tabIds.slice(i, i + CHUNK_SIZE);
      let itemFrom = 0;
      const ITEM_PAGE_SIZE = 1000;
      let hasMoreItems = true;

      while (hasMoreItems) {
        const { data: itemsChunk, error: itemsErr } = await supabase
          .from('table_tab_items')
          .select('id, table_tab_id, product_name, quantity, unit_price_in_cents, line_total_in_cents, status, production_status, created_at')
          .eq('restaurant_id', restaurantId)
          .in('table_tab_id', chunk)
          .range(itemFrom, itemFrom + ITEM_PAGE_SIZE - 1);

        if (itemsErr) {
          throw new Error(`Erro ao carregar itens do histórico: ${itemsErr.message}`);
        }

        if (itemsChunk && itemsChunk.length > 0) {
          for (const item of itemsChunk) {
            const list = itemsMap.get(item.table_tab_id) || [];
            list.push(item as TabItemRow);
            itemsMap.set(item.table_tab_id, list);
          }
          if (itemsChunk.length < ITEM_PAGE_SIZE) {
            hasMoreItems = false;
          } else {
            itemFrom += ITEM_PAGE_SIZE;
          }
        } else {
          hasMoreItems = false;
        }
      }
    }

    // 5. Consultar clientes confirmados (table_tab_guests) em lotes (sem descartar após 200)
    const guestsCountMap = new Map<string, number>();

    for (let i = 0; i < tabIds.length; i += CHUNK_SIZE) {
      const chunk = tabIds.slice(i, i + CHUNK_SIZE);
      let guestFrom = 0;
      const GUEST_PAGE_SIZE = 1000;
      let hasMoreGuests = true;

      while (hasMoreGuests) {
        const { data: guestsChunk, error: guestsErr } = await supabase
          .from('table_tab_guests')
          .select('table_tab_id, guest_session_id')
          .eq('restaurant_id', restaurantId)
          .in('table_tab_id', chunk)
          .range(guestFrom, guestFrom + GUEST_PAGE_SIZE - 1);

        if (guestsErr) {
          throw new Error(`Erro ao carregar acessos de clientes do histórico: ${guestsErr.message}`);
        }

        if (guestsChunk && guestsChunk.length > 0) {
          for (const g of guestsChunk) {
            guestsCountMap.set(g.table_tab_id, (guestsCountMap.get(g.table_tab_id) || 0) + 1);
          }
          if (guestsChunk.length < GUEST_PAGE_SIZE) {
            hasMoreGuests = false;
          } else {
            guestFrom += GUEST_PAGE_SIZE;
          }
        } else {
          hasMoreGuests = false;
        }
      }
    }

    // 6. Montar lista de registros consolidados
    const records: StaffHistoryRecord[] = [];

    for (const tab of allTabs) {
      const visit = visitsMap.get(tab.table_visit_id);
      const tableId = tab.restaurant_table_id || visit?.restaurant_table_id || '';
      const table = tableId ? tablesMap.get(tableId) : undefined;

      const tableNumber = table?.table_number ?? null;
      const tableLabel = table?.label?.trim() ? table.label.trim() : null;

      // Quando a consulta foi bem-sucedida e não houver vínculos, mostre 0 acessos (não "Indisponível")
      const confirmedGuestsCount = guestsCountMap.get(tab.id) ?? 0;

      const items = itemsMap.get(tab.id) || [];
      const activeItems = items.filter((i) => i.status === 'active');

      const openedAt = visit?.opened_at || tab.created_at;
      const closedAt = tab.closed_at || visit?.closed_at || openedAt;

      const startMs = new Date(openedAt).getTime();
      const endMs = new Date(closedAt).getTime();
      const durationMinutes = Math.max(1, Math.round((endMs - startMs) / 60000));

      const subtotalInCents = tab.subtotal_in_cents ?? activeItems.reduce((acc, it) => acc + (it.line_total_in_cents || 0), 0);
      const serviceFeePercent = tab.service_fee_percent;
      const serviceFeeInCents = tab.service_fee_in_cents ?? 0;
      const serviceFeeAccepted = tab.service_fee_accepted ?? true;
      const totalInCents = tab.total_in_cents ?? (subtotalInCents + (serviceFeeAccepted ? serviceFeeInCents : 0));

      const tableDisplay = tableNumber !== null ? `Mesa ${String(tableNumber).padStart(2, '0')}` : 'Comanda';
      const tabLabel = tab.label?.trim() ? tab.label.trim() : tableDisplay;

      records.push({
        id: tab.id,
        tableVisitId: tab.table_visit_id,
        tableTabId: tab.id,
        tableNumber,
        tableLabel,
        tabLabel,
        status: 'closed',
        openedAt,
        closedAt,
        durationMinutes,
        itemsCount: activeItems.reduce((sum, it) => sum + (it.quantity || 1), 0),
        confirmedGuestsCount,
        subtotalInCents,
        serviceFeePercent,
        serviceFeeInCents,
        serviceFeeAccepted,
        totalInCents,
        items,
        closedByMemberId: tab.closed_by_member_id,
        assignedMemberId: visit?.assigned_member_id || null,
        relatedTabsCount: 1,
        recordType: 'tab',
        visitStatus: visit?.status === 'closed' ? 'closed' : 'open',
        visitOpenedAt: visit?.opened_at ?? null,
        visitClosedAt: visit?.status === 'closed' ? (visit.closed_at ?? null) : null,
      });
    }

    // 7. Visitas encerradas no período que não tiveram comandas
    const visitsWithTabs = new Set(allTabs.map((t) => t.table_visit_id));
    for (const v of allVisits) {
      if (v.status === 'closed' && v.closed_at && !visitsWithTabs.has(v.id)) {
        const table = tablesMap.get(v.restaurant_table_id);
        const tableNumber = table?.table_number ?? null;
        const tableLabel = table?.label?.trim() ? table.label.trim() : null;
        const startMs = new Date(v.opened_at).getTime();
        const endMs = new Date(v.closed_at).getTime();
        const durationMinutes = Math.max(1, Math.round((endMs - startMs) / 60000));
        const tableDisplay = tableNumber !== null ? `Mesa ${String(tableNumber).padStart(2, '0')}` : 'Mesa Indisponível';

        records.push({
          id: `visit-${v.id}`,
          tableVisitId: v.id,
          tableTabId: null,
          tableNumber,
          tableLabel,
          tabLabel: `${tableDisplay} — Sem consumo`,
          status: 'closed',
          openedAt: v.opened_at,
          closedAt: v.closed_at,
          durationMinutes,
          itemsCount: 0,
          confirmedGuestsCount: 0,
          subtotalInCents: 0,
          serviceFeePercent: 0,
          serviceFeeInCents: 0,
          serviceFeeAccepted: false,
          totalInCents: 0,
          items: [],
          closedByMemberId: null,
          assignedMemberId: v.assigned_member_id,
          relatedTabsCount: 0,
          recordType: 'closure',
          visitStatus: 'closed',
          visitOpenedAt: v.opened_at,
          visitClosedAt: v.closed_at,
        });
      }
    }

    records.sort((a, b) => new Date(b.closedAt).getTime() - new Date(a.closedAt).getTime());
    return records;
  }

  return [];
}

import { supabase } from '../../lib/supabase';
import { isQueryTimeoutError } from '../../lib/queryErrors';
import { fetchActiveKdsItems, advanceKdsItemStatus } from '../kds/kdsService';
import { attendWaiterRequest, completeWaiterRequest } from './serviceRequests';
import { attendBillRequest, completeBillRequest } from './billRequests';

export type ChamadoCategory = 'ready_order' | 'waiter_call' | 'bill_request';

export function shouldRefreshReadyOrderQueue(payload: {
  new?: { production_status?: string | null };
  old?: { production_status?: string | null };
}): boolean {
  return payload.new?.production_status === 'ready'
    || payload.new?.production_status === 'delivered'
    || payload.old?.production_status === 'ready';
}

export interface ChamadoItem {
  id: string;
  category: ChamadoCategory;
  tableNumber: number;
  tableName: string;
  tableSector?: string | null;
  tabLabel?: string | null;
  description: string;
  createdAt: string;
  prepReadyAt?: string | null;
  status: 'pending' | 'attended' | 'ready';
  productName?: string;
  quantity?: number;
  preparationStation?: 'kitchen' | 'bar' | 'none';
  includeServiceFee?: boolean | null;
  tableTabId?: string;
  tableVisitId?: string;
}

export interface ChamadosSummary {
  readyOrdersCount: number;
  waiterCallsCount: number;
  billRequestsCount: number;
  totalPendingCount: number;
}

export interface ToastNotification {
  id: string;
  chamadoId: string;
  category: ChamadoCategory;
  message: string;
  tableNumber: number;
  createdAt: number;
}

export interface FetchChamadosResult {
  items: ChamadoItem[];
  isPartial: boolean;
  partialWarning: string | null;
  kdsAvailable: boolean;
  errors: {
    kdsError: string | null;
    serviceRequestsError: string | null;
  };
}

/**
 * Verifica se um erro do KDS decorre de limitação do plano (ex: básico) e não de falha técnica.
 */
export function isKdsPlanLimitation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('plano') ||
    msg.includes('upgrade') ||
    msg.includes('básico') ||
    msg.includes('basic') ||
    msg.includes('exclusivo para planos pro')
  );
}

/**
 * Calcula o sumário dos chamados por categoria e total com garantia estrita
 * de contagem única por categoria e ID, mesmo que haja registros duplicados na entrada.
 */
export function calculateChamadosSummary(items: ChamadoItem[]): ChamadosSummary {
  const seen = new Set<string>();
  let readyOrdersCount = 0;
  let waiterCallsCount = 0;
  let billRequestsCount = 0;

  for (const item of items) {
    const key = `${item.category}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    switch (item.category) {
      case 'ready_order':
        readyOrdersCount++;
        break;
      case 'waiter_call':
        waiterCallsCount++;
        break;
      case 'bill_request':
        billRequestsCount++;
        break;
    }
  }

  return {
    readyOrdersCount,
    waiterCallsCount,
    billRequestsCount,
    totalPendingCount: seen.size,
  };
}

/**
 * Lógica pura de produção para processamento de novos chamados e geração de avisos:
 * - Carga inicial: registra todos IDs conhecidos sem emitir popups.
 * - Chegada durante uso: gera avisos apenas para IDs inéditos e define som apropriado.
 */
export interface ProcessIncomingChamadosResult {
  updatedKnownIds: Set<string>;
  newToasts: ToastNotification[];
  shouldPlaySound: 'ready' | 'waiter' | null;
}

export function processIncomingChamados(
  currentItems: ChamadoItem[],
  knownIds: Set<string>,
  isInitialLoad: boolean,
): ProcessIncomingChamadosResult {
  const nextKnownIds = new Set(knownIds);
  const newToasts: ToastNotification[] = [];
  let shouldPlaySound: 'ready' | 'waiter' | null = null;

  if (isInitialLoad) {
    for (const item of currentItems) {
      nextKnownIds.add(item.id);
    }
    return {
      updatedKnownIds: nextKnownIds,
      newToasts: [],
      shouldPlaySound: null,
    };
  }

  for (const item of currentItems) {
    if (!nextKnownIds.has(item.id)) {
      nextKnownIds.add(item.id);

      newToasts.push({
        id: `${item.id}-${Date.now()}`,
        chamadoId: item.id,
        category: item.category,
        message: formatToastMessage(item),
        tableNumber: item.tableNumber,
        createdAt: Date.now(),
      });

      if (!shouldPlaySound) {
        shouldPlaySound = item.category === 'ready_order' ? 'ready' : 'waiter';
      }
    }
  }

  return {
    updatedKnownIds: nextKnownIds,
    newToasts,
    shouldPlaySound,
  };
}

/**
 * Lógica pura de produção para remover da fila de avisos chamados que foram resolvidos
 * antes de seu respectivo popup aparecer.
 */
export function purgeResolvedToasts(
  toastQueue: ToastNotification[],
  currentPendingItems: ChamadoItem[],
): ToastNotification[] {
  const pendingIdSet = new Set(currentPendingItems.map((i) => i.id));
  return toastQueue.filter((t) => pendingIdSet.has(t.chamadoId));
}

/**
 * Formata o tempo decorrido desde o timestamp ISO real (ex: "Agora", "12min", "1h 24min").
 */
export function formatElapsedTime(isoTimestamp: string, now: number = Date.now()): string {
  const ts = new Date(isoTimestamp).getTime();
  if (Number.isNaN(ts)) return 'Agora';
  const diffMinutes = Math.max(0, Math.floor((now - ts) / 60000));
  if (diffMinutes < 1) return 'Agora';
  if (diffMinutes < 60) return `${diffMinutes}min`;
  const hours = Math.floor(diffMinutes / 60);
  const remainingMins = diffMinutes % 60;
  if (remainingMins === 0) return `${hours}h`;
  return `${hours}h ${remainingMins}min`;
}

/**
 * Retorna o valor de exibição do badge no menu inferior.
 * Retorna null quando a contagem for 0 ou negativa (badge escondido).
 */
export function formatBadgeCount(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  return String(Math.floor(count));
}

/**
 * Monta a mensagem compacta do popup que desliza do topo.
 */
export function formatToastMessage(item: {
  category: ChamadoCategory;
  tableNumber: number;
  preparationStation?: string;
  productName?: string;
}): string {
  const tableStr = `Mesa ${String(item.tableNumber).padStart(2, '0')}`;
  switch (item.category) {
    case 'waiter_call':
      return `${tableStr} chamou o garçom`;
    case 'bill_request':
      return `${tableStr} pediu a conta`;
    case 'ready_order': {
      const station = item.preparationStation === 'bar' ? 'bar' : 'cozinha';
      return `Pedido da ${tableStr} pronto na ${station === 'bar' ? 'copa/bar' : 'cozinha'}`;
    }
  }
}

/**
 * Busca todas as pendências ativas das três categorias autorizadas.
 * Em caso de falha parcial de consulta (rede/permissão), sinaliza que os dados estão
 * incompletos e preserva os últimos dados válidos daquela categoria.
 */
export async function fetchPendingChamados(
  restaurantSlug: string,
  restaurantId: string,
  previousItems?: ChamadoItem[],
): Promise<FetchChamadosResult> {
  let kdsReadyItems: ChamadoItem[] = [];
  let serviceItems: ChamadoItem[] = [];
  let kdsAvailable = true;
  let kdsError: string | null = null;
  let serviceRequestsError: string | null = null;

  // 1. Busca Pedidos Prontos via KDS
  try {
    const kdsItems = await fetchActiveKdsItems(restaurantSlug);
    const readyItems = kdsItems.filter((i) => i.production_status === 'ready');
    for (const item of readyItems) {
      kdsReadyItems.push({
        id: item.id,
        category: 'ready_order',
        tableNumber: item.table_number,
        tableName: item.table_name || `Mesa ${String(item.table_number).padStart(2, '0')}`,
        productName: item.product_name,
        quantity: item.quantity,
        preparationStation: item.preparation_station,
        description: `${item.quantity}x ${item.product_name}`,
        createdAt: item.prep_ready_at || item.created_at,
        prepReadyAt: item.prep_ready_at,
        status: 'ready',
        tableTabId: item.table_tab_id,
        tableVisitId: item.table_visit_id,
      });
    }
  } catch (err) {
    if (isKdsPlanLimitation(err)) {
      // Módulo indisponível por plano/configuração (não é erro técnico)
      kdsAvailable = false;
      kdsReadyItems = [];
    } else {
      // Erro real de rede, servidor ou permissão
      kdsError = err instanceof Error ? err.message : 'Falha na esteira KDS.';
      console.warn('Falha ao consultar KDS:', kdsError);
      // Preserva dados anteriores válidos desta categoria
      if (previousItems) {
        kdsReadyItems = previousItems.filter((i) => i.category === 'ready_order');
      }
    }
  }

  // 2. Busca Chamados do Garçom e Pedidos de Conta via service_requests
  try {
    const { data, error } = await supabase
      .from('service_requests')
      .select(`
        id,
        restaurant_id,
        restaurant_table_id,
        table_visit_id,
        table_tab_id,
        request_type,
        status,
        created_at,
        include_service_fee,
        table:restaurant_tables(table_number, label),
        tab:table_tabs(label)
      `)
      .eq('restaurant_id', restaurantId)
      .in('request_type', ['waiter', 'bill'])
      .in('status', ['pending', 'attended'])
      .order('created_at', { ascending: true });

    if (error) {
      serviceRequestsError = isQueryTimeoutError(error)
        ? 'A consulta de chamados excedeu o tempo limite. Atualize novamente; isso não significa que seu acesso foi negado.'
        : error.message || 'Erro ao carregar solicitações de serviço.';
      console.error('Erro ao buscar service_requests:', error);
      if (previousItems) {
        serviceItems = previousItems.filter(
          (i) => i.category === 'waiter_call' || i.category === 'bill_request',
        );
      }
    } else if (data && Array.isArray(data)) {
      for (const req of data) {
        const tableRecord = req.table as { table_number?: number; label?: string } | null;
        const tabRecord = req.tab as { label?: string } | null;
        const tableNum = tableRecord?.table_number ?? 0;
        const tableName = tableNum > 0 ? `Mesa ${String(tableNum).padStart(2, '0')}` : 'Mesa';
        const tableSector = tableRecord?.label || null;
        const tabLabel = tabRecord?.label || null;

        if (req.request_type === 'waiter') {
          serviceItems.push({
            id: req.id,
            category: 'waiter_call',
            tableNumber: tableNum,
            tableName,
            tableSector,
            tabLabel,
            description: 'Cliente solicitou atendimento do garçom',
            createdAt: req.created_at,
            status: req.status,
            tableVisitId: req.table_visit_id ?? undefined,
            tableTabId: req.table_tab_id ?? undefined,
          });
        } else if (req.request_type === 'bill') {
          serviceItems.push({
            id: req.id,
            category: 'bill_request',
            tableNumber: tableNum,
            tableName,
            tableSector,
            tabLabel,
            description: req.include_service_fee
              ? 'Cliente pediu a conta (com taxa de serviço)'
              : 'Cliente pediu a conta (sem taxa de serviço)',
            createdAt: req.created_at,
            status: req.status,
            includeServiceFee: req.include_service_fee,
            tableVisitId: req.table_visit_id ?? undefined,
            tableTabId: req.table_tab_id ?? undefined,
          });
        }
      }
    }
  } catch (err) {
    serviceRequestsError = isQueryTimeoutError(err)
      ? 'A consulta de chamados excedeu o tempo limite. Atualize novamente; isso não significa que seu acesso foi negado.'
      : err instanceof Error ? err.message : 'Falha na consulta de chamados.';
    console.error('Falha de rede/exceção em service_requests:', err);
    if (previousItems) {
      serviceItems = previousItems.filter(
        (i) => i.category === 'waiter_call' || i.category === 'bill_request',
      );
    }
  }

  // Se ambas as categorias falharam e não há dados anteriores para exibir, lança erro
  if (kdsError && serviceRequestsError && kdsReadyItems.length === 0 && serviceItems.length === 0) {
    throw new Error(`Falha ao carregar chamados: ${serviceRequestsError}`);
  }

  // Combina itens e ordena cronologicamente
  const combined = [...kdsReadyItems, ...serviceItems].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  const isPartial = Boolean(kdsError || serviceRequestsError);
  let partialWarning: string | null = null;
  if (kdsError && !serviceRequestsError) {
    partialWarning = `Dados parciais: falha ao atualizar pedidos da cozinha (${kdsError}). Exibindo últimos registros.`;
  } else if (serviceRequestsError && !kdsError) {
    partialWarning = `Dados parciais: falha ao atualizar chamados e contas (${serviceRequestsError}). Exibindo últimos registros.`;
  } else if (kdsError && serviceRequestsError) {
    partialWarning = 'Dados parciais: falha na sincronização do salão e da cozinha. Exibindo últimos registros.';
  }

  return {
    items: combined,
    isPartial,
    partialWarning,
    kdsAvailable,
    errors: {
      kdsError,
      serviceRequestsError,
    },
  };
}

/**
 * Operação real: Confirmar entrega do pedido pronto da cozinha/bar.
 */
export async function executeDeliverReadyOrder(
  restaurantSlug: string,
  itemId: string,
): Promise<{ success: boolean; error?: string }> {
  const result = await advanceKdsItemStatus(restaurantSlug, itemId, 'delivered');
  if (!result.success) {
    return { success: false, error: result.error || 'Não foi possível confirmar a entrega.' };
  }
  return { success: true };
}

/**
 * Operação real: Atender chamado do garçom.
 */
export async function executeAttendWaiterCall(
  restaurantSlug: string,
  requestId: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    await attendWaiterRequest(restaurantSlug, requestId);
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Falha ao atender o chamado.',
    };
  }
}

/**
 * Operação real: Atender pedido de conta.
 * NÃO fecha a comanda, NÃO registra pagamento e NÃO encerra a mesa.
 */
export async function executeAttendBillRequest(
  restaurantSlug: string,
  requestId: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    await attendBillRequest(restaurantSlug, requestId);
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Falha ao marcar conta como atendida.',
    };
  }
}

export async function executeCompleteServiceCall(restaurantSlug: string, requestId: string, kind: 'waiter' | 'bill') {
  try {
    if (kind === 'waiter') await completeWaiterRequest(restaurantSlug, requestId);
    else await completeBillRequest(restaurantSlug, requestId);
    return { success: true };
  } catch (cause) {
    return { success: false, error: cause instanceof Error ? cause.message : 'Não foi possível concluir o atendimento.' };
  }
}

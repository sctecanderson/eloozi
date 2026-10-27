import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router';
import type { StaffAccess } from '../auth/staffAuth';
import { supabase } from '../../lib/supabase';
import { useRestaurant } from '../restaurants/RestaurantProvider';
import { printTableBillThermal } from '../../components/ThermalReceiptPrint';
import {
  closeTableTab,
  calculateTabClosurePreview,
  type TableTab,
} from './tableTabs';
import { buildComandaPrintPayload } from './comandaPrinting';
import { transferTabConsumptionItems } from './tabConsumption';
import { validateCancellationReason } from './cancellationRules';
import {
  COMANDAS_PER_PAGE,
  computePaginationInfo,
  paginateList,
  getPaginationPageNumbers,
} from './comandasPagination';

interface TabItemRow {
  id: string;
  table_tab_id: string;
  product_id?: string;
  product_name: string;
  quantity: number;
  unit_price_in_cents: number;
  line_total_in_cents: number;
  status: 'active' | 'cancelled';
  production_status?: 'pending' | 'preparing' | 'ready' | 'delivered';
}

export interface ComandaCardData {
  id: string;
  tabId: string;
  label: string;
  tableId: string;
  tableNumber: number;
  tableArea: string;
  visitId: string;
  openedAt: string;
  closedAt: string | null;
  status: 'open' | 'preparing' | 'ready' | 'waiting_bill' | 'closed';
  itemsCount: number;
  linkedGuestsCount: number;
  totalInCents: number;
  subtotalInCents?: number | null;
  serviceFeePercent?: number | null;
  serviceFeeInCents?: number | null;
  serviceFeeAccepted?: boolean | null;
  items: TabItemRow[];
}

const currency = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

function formatElapsed(openedAt: string): string {
  const diffMs = Date.now() - new Date(openedAt).getTime();
  const mins = Math.max(0, Math.floor(diffMs / 60000));
  if (mins < 60) {
    return `${mins}min`;
  }
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${remMins}min`;
}

function formatDateTime(dateStr: string): string {
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(dateStr));
  } catch {
    return dateStr;
  }
}

export function ComandasPage() {
  const access = useOutletContext<StaffAccess>();
  const { restaurant } = useRestaurant();
  const { restaurantSlug: paramSlug } = useParams<{ restaurantSlug: string }>();
  const navigate = useNavigate();

  const currentSlug = restaurant?.slug || paramSlug || '';

  const [cards, setCards] = useState<ComandaCardData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [feedbackToast, setFeedbackToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  // Filtros e ordenação
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'todas' | 'abertas' | 'preparo' | 'prontas' | 'finalizadas'>('todas');
  const [sortOrder, setSortOrder] = useState<'newest' | 'total' | 'table'>('newest');

  // Paginação e controle de menu flutuante
  const [currentPage, setCurrentPage] = useState(1);
  const [activeMenuCardId, setActiveMenuCardId] = useState<string | null>(null);

  // Modais de Ações Especializadas
  const [viewingCard, setViewingCard] = useState<ComandaCardData | null>(null);
  const [closingCard, setClosingCard] = useState<ComandaCardData | null>(null);
  const [closingFeeAccepted, setClosingFeeAccepted] = useState(true);
  const [transferringCard, setTransferringCard] = useState<ComandaCardData | null>(null);
  const [transferOccupiedTables, setTransferOccupiedTables] = useState<Array<{ id: string; table_number: number; label: string | null }>>([]);
  const [transferTargetTableId, setTransferTargetTableId] = useState('');
  const [transferTargetTabs, setTransferTargetTabs] = useState<Array<{ id: string; label: string }>>([]);
  const [transferTargetTabId, setTransferTargetTabId] = useState('');
  const [transferReason, setTransferReason] = useState('');
  const [transferReasonError, setTransferReasonError] = useState('');
  const [busyAction, setBusyAction] = useState(false);
  const submittingRef = useRef(false);

  // Fechar o menu "Mais" ao clicar fora ou pressionar Escape
  useEffect(() => {
    if (!activeMenuCardId) return;

    function handleClickOutside(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-more-menu]')) {
        setActiveMenuCardId(null);
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setActiveMenuCardId(null);
      }
    }

    document.addEventListener('click', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('click', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [activeMenuCardId]);

  // Carregar comandas reais do banco de dados com snapshots contábeis completos
  const loadComandas = useCallback(async () => {
    try {
      setError('');

      const [tabsRes, visitsRes, tablesRes, itemsRes, guestsRes] = await Promise.all([
        supabase
          .from('table_tabs')
          .select('id, label, status, created_at, closed_at, table_visit_id, restaurant_table_id, subtotal_in_cents, service_fee_percent, service_fee_in_cents, total_in_cents, service_fee_accepted')
          .eq('restaurant_id', access.restaurantId)
          .order('created_at', { ascending: false }),

        supabase
          .from('table_visits')
          .select('id, status, opened_at, closed_at, restaurant_table_id, assigned_member_id')
          .eq('restaurant_id', access.restaurantId),

        supabase
          .from('restaurant_tables')
          .select('id, table_number, label')
          .eq('restaurant_id', access.restaurantId),

        supabase
          .from('table_tab_items')
          .select('id, table_tab_id, product_id, product_name, quantity, unit_price_in_cents, line_total_in_cents, status, production_status')
          .eq('restaurant_id', access.restaurantId),

        supabase
          .from('table_tab_guests')
          .select('table_tab_id, guest_session_id')
          .eq('restaurant_id', access.restaurantId),
      ]);

      if (tabsRes.error) throw new Error(tabsRes.error.message);

      const tablesMap = new Map<string, { table_number: number; label?: string }>();
      if (tablesRes.data) {
        for (const t of tablesRes.data) {
          tablesMap.set(t.id, { table_number: t.table_number, label: t.label ?? undefined });
        }
      }

      const visitsMap = new Map<string, { opened_at: string; closed_at: string | null; status: string; restaurant_table_id: string }>();
      if (visitsRes.data) {
        for (const v of visitsRes.data) {
          visitsMap.set(v.id, {
            opened_at: v.opened_at,
            closed_at: v.closed_at,
            status: v.status,
            restaurant_table_id: v.restaurant_table_id,
          });
        }
      }

      const itemsMap = new Map<string, TabItemRow[]>();
      if (itemsRes.data) {
        for (const it of itemsRes.data) {
          const list = itemsMap.get(it.table_tab_id) || [];
          list.push(it as TabItemRow);
          itemsMap.set(it.table_tab_id, list);
        }
      }

      const guestsCountMap = new Map<string, number>();
      if (guestsRes.data) {
        for (const g of guestsRes.data) {
          guestsCountMap.set(g.table_tab_id, (guestsCountMap.get(g.table_tab_id) || 0) + 1);
        }
      }

      const assembled: ComandaCardData[] = (tabsRes.data || []).map((tab) => {
        const visit = visitsMap.get(tab.table_visit_id);
        const tableId = tab.restaurant_table_id || visit?.restaurant_table_id || '';
        const table = tablesMap.get(tableId);

        const items = itemsMap.get(tab.id) || [];
        const activeItems = items.filter((i) => i.status === 'active');
        const calculatedSubtotal = activeItems.reduce((acc, cur) => acc + (cur.line_total_in_cents || 0), 0);
        const linkedGuests = guestsCountMap.get(tab.id) || 0;

        // Determinar status operacional
        let cardStatus: ComandaCardData['status'] = 'open';
        if (tab.status === 'closed') {
          cardStatus = 'closed';
        } else if (activeItems.some((i) => i.production_status === 'ready')) {
          cardStatus = 'ready';
        } else if (activeItems.some((i) => i.production_status === 'preparing' || i.production_status === 'pending')) {
          cardStatus = 'preparing';
        } else {
          cardStatus = 'open';
        }

        const rawLabel = table?.label?.trim() || '';
        const isStandardArea = [
          'salão',
          'salao',
          'varanda',
          'área externa',
          'area externa',
          'balcão',
          'deck',
          'terraço',
          'mezanino',
        ].includes(rawLabel.toLowerCase());

        const tableArea = isStandardArea ? rawLabel : 'Salão principal';

        // Snapshot contábil imutável para comandas encerradas
        const persistentTotal = tab.total_in_cents != null ? tab.total_in_cents : calculatedSubtotal;
        const persistentSubtotal = tab.subtotal_in_cents != null ? tab.subtotal_in_cents : calculatedSubtotal;

        return {
          id: tab.id,
          tabId: tab.id,
          label: tab.label?.startsWith('Comanda ') ? tab.label : `Comanda ${tab.label || 'Mesa'}`,
          tableId,
          tableNumber: table?.table_number ?? 1,
          tableArea,
          visitId: tab.table_visit_id,
          openedAt: visit?.opened_at || tab.created_at,
          closedAt: tab.closed_at,
          status: cardStatus,
          itemsCount: activeItems.length,
          linkedGuestsCount: linkedGuests,
          totalInCents: cardStatus === 'closed' ? persistentTotal : calculatedSubtotal,
          subtotalInCents: cardStatus === 'closed' ? persistentSubtotal : calculatedSubtotal,
          serviceFeePercent: tab.service_fee_percent != null ? Number(tab.service_fee_percent) : null,
          serviceFeeInCents: tab.service_fee_in_cents != null ? tab.service_fee_in_cents : null,
          serviceFeeAccepted: tab.service_fee_accepted != null ? tab.service_fee_accepted : null,
          items,
        };
      });

      setCards(assembled);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha ao carregar as comandas.');
    } finally {
      setLoading(false);
    }
  }, [access.restaurantId]);

  useEffect(() => {
    void loadComandas();
  }, [loadComandas, refreshTick]);

  // Atualização em tempo real via Supabase
  useEffect(() => {
    const channel = supabase
      .channel(`staff-comandas-sync:${access.restaurantId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'table_tabs', filter: `restaurant_id=eq.${access.restaurantId}` },
        () => setRefreshTick((t) => t + 1),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'table_tab_items', filter: `restaurant_id=eq.${access.restaurantId}` },
        () => setRefreshTick((t) => t + 1),
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [access.restaurantId]);

  // Contadores para os 4 Cards de Métricas (calculados sobre o total real antes de paginação)
  const { countAbertas, countPreparo, countProntas, totalTurnoCents } = useMemo(() => {
    let abertas = 0;
    let preparo = 0;
    let prontas = 0;
    let turno = 0;

    for (const c of cards) {
      if (c.status !== 'closed') {
        abertas++;
        if (c.status === 'preparing') preparo++;
        if (c.status === 'ready') prontas++;
      }
      turno += c.totalInCents;
    }

    return {
      countAbertas: abertas,
      countPreparo: preparo,
      countProntas: prontas,
      totalTurnoCents: turno,
    };
  }, [cards]);

  // Filtro e ordenação das comandas (conjunto completo)
  const filteredCards = useMemo(() => {
    return cards
      .filter((card) => {
        // Filtro de status
        if (statusFilter === 'abertas' && card.status !== 'open') return false;
        if (statusFilter === 'preparo' && card.status !== 'preparing') return false;
        if (statusFilter === 'prontas' && card.status !== 'ready') return false;
        if (statusFilter === 'finalizadas' && card.status !== 'closed') return false;

        // Filtro de busca
        if (searchQuery.trim() !== '') {
          const q = searchQuery.toLowerCase();
          const matchLabel = card.label.toLowerCase().includes(q);
          const matchTable = `mesa ${card.tableNumber}`.includes(q) || String(card.tableNumber) === q;
          const matchArea = card.tableArea.toLowerCase().includes(q);
          if (!matchLabel && !matchTable && !matchArea) return false;
        }

        return true;
      })
      .sort((a, b) => {
        if (sortOrder === 'total') return b.totalInCents - a.totalInCents;
        if (sortOrder === 'table') return a.tableNumber - b.tableNumber;
        return new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime();
      });
  }, [cards, statusFilter, searchQuery, sortOrder]);

  // Ao alterar busca, filtro de status ou ordenação, retornar à primeira página
  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, statusFilter, sortOrder]);

  // Cálculo da paginação com limite de 5 itens por página
  const paginationInfo = useMemo(() => {
    return computePaginationInfo(filteredCards.length, currentPage, COMANDAS_PER_PAGE);
  }, [filteredCards.length, currentPage]);

  const { totalPages, displayText } = paginationInfo;

  // Ajustar página atual caso uma exclusão/atualização reduza o total de páginas
  useEffect(() => {
    if (currentPage > totalPages && totalPages > 0) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  // Itens fatiados para a página visível
  const paginatedCards = useMemo(() => {
    return paginateList(filteredCards, currentPage, COMANDAS_PER_PAGE);
  }, [filteredCards, currentPage]);

  // Números de página para renderização da barra
  const pageNumbers = useMemo(() => {
    return getPaginationPageNumbers(currentPage, totalPages);
  }, [currentPage, totalPages]);

  // ==========================================================================
  // AÇÃO 4: IMPRESSÃO DE COMANDAS (FUNÇÃO DE PRODUÇÃO COMPARTILHADA)
  // - Para finalizadas: usa snapshots contábeis persistidos (sem recalcular taxa atual)
  // - Para abertas: usa a prévia decimal exata e identifica como pré-conta
  // ==========================================================================
  function handlePrintReceipt(card: ComandaCardData) {
    const payload = buildComandaPrintPayload(
      card,
      restaurant?.name,
      restaurant?.serviceFeePercent
    );
    printTableBillThermal(payload);
  }

  // ==========================================================================
  // AÇÃO 1: VER COMANDA PELO UUID (Não reabre comanda finalizada)
  // ==========================================================================
  function handleOpenComandaDetails(card: ComandaCardData) {
    setViewingCard(card);
  }

  // ==========================================================================
  // AÇÃO 3: MODAL DE FECHAMENTO COM CONFERÊNCIA DE TAXA
  // ==========================================================================
  function handleOpenCloseModal(card: ComandaCardData) {
    setActiveMenuCardId(null);
    const hasConfiguredFee = (restaurant?.serviceFeePercent ?? 0) > 0;
    setClosingFeeAccepted(hasConfiguredFee);
    setClosingCard(card);
  }

  async function handleConfirmCloseTab() {
    if (!closingCard || submittingRef.current || busyAction) return;
    submittingRef.current = true;
    setBusyAction(true);

    try {
      const restaurantFee = restaurant?.serviceFeePercent ?? 0;
      const feeAccepted = restaurantFee > 0 ? closingFeeAccepted : false;

      const result = await closeTableTab(currentSlug, closingCard.tabId, feeAccepted);

      setFeedbackToast({
        type: 'success',
        message: `Comanda "${closingCard.label}" encerrada com sucesso! Total: ${currency.format((result.total_in_cents ?? 0) / 100)}`,
      });

      setClosingCard(null);
      if (viewingCard?.tabId === closingCard.tabId) {
        setViewingCard(null);
      }
      setRefreshTick((t) => t + 1);
    } catch (err) {
      setFeedbackToast({
        type: 'error',
        message: err instanceof Error ? err.message : 'Falha ao fechar a comanda.',
      });
    } finally {
      submittingRef.current = false;
      setBusyAction(false);
    }
  }

  // ==========================================================================
  // AÇÃO 2: FLUXO DE TRANSFERÊNCIA DA COMANDA
  // - Requer seleção explícita da comanda de destino (sem auto-selecionar a primeira da mesa)
  // - Cancelamento + recriação foi removido por risco de perda parcial, alteração de preço
  //   e reinício do status de preparo na cozinha (KDS).
  // - Permanece desabilitado indicando a lacuna arquitetural de ausência de RPC transacional.
  // ==========================================================================
  async function loadTargetTabs(tableId: string) {
    setTransferTargetTabId('');
    if (!tableId) {
      setTransferTargetTabs([]);
      return;
    }
    try {
      const { data: visit } = await supabase
        .from('table_visits')
        .select('id')
        .eq('restaurant_table_id', tableId)
        .eq('status', 'open')
        .order('opened_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!visit) {
        setTransferTargetTabs([]);
        return;
      }

      const { data: tabs } = await supabase
        .from('table_tabs')
        .select('id, label')
        .eq('table_visit_id', visit.id)
        .eq('status', 'open')
        .order('created_at', { ascending: true });

      setTransferTargetTabs(tabs || []);
    } catch {
      setTransferTargetTabs([]);
    }
  }

  async function handleTransferTableChange(tableId: string) {
    setTransferTargetTableId(tableId);
    await loadTargetTabs(tableId);
  }

  async function handleOpenTransferModal(card: ComandaCardData) {
    setActiveMenuCardId(null);
    if (card.status === 'closed') {
      setFeedbackToast({
        type: 'error',
        message: 'Comandas finalizadas não podem ser transferidas.',
      });
      return;
    }

    setTransferringCard(card);
    setTransferTargetTableId('');
    setTransferTargetTabs([]);
    setTransferTargetTabId('');
    setTransferReason('');
    setTransferReasonError('');
    setBusyAction(true);

    try {
      const { data: activeVisits, error: visitsErr } = await supabase
        .from('table_visits')
        .select(`
          restaurant_table_id,
          restaurant_tables (
            id,
            table_number,
            label
          )
        `)
        .eq('restaurant_id', access.restaurantId)
        .eq('status', 'open');

      if (visitsErr) throw visitsErr;

      const otherTables = (activeVisits || [])
        .map((v) => v.restaurant_tables as unknown as { id: string; table_number: number; label: string | null } | null)
        .filter((t): t is { id: string; table_number: number; label: string | null } =>
          t != null && t.table_number !== card.tableNumber
        );

      const uniqueMap = new Map<string, { id: string; table_number: number; label: string | null }>();
      for (const t of otherTables) {
        uniqueMap.set(t.id, t);
      }
      const uniqueTables = Array.from(uniqueMap.values()).sort((a, b) => a.table_number - b.table_number);

      setTransferOccupiedTables(uniqueTables);
      // Deixa o destino sem seleção inicial e exige escolha explícita do operador
      setTransferTargetTableId('');
      setTransferTargetTabs([]);
      setTransferTargetTabId('');
    } catch {
      setFeedbackToast({
        type: 'error',
        message: 'Não foi possível carregar as outras mesas ocupadas.',
      });
    } finally {
      setBusyAction(false);
    }
  }

  async function handleConfirmTransferTab() {
    if (!transferringCard) return;

    if (!transferTargetTabId) {
      setTransferReasonError('Selecione a comanda de destino.');
      return;
    }

    const validation = validateCancellationReason(transferReason);
    if (!validation.valid) {
      setTransferReasonError(validation.error || 'Informe um motivo entre 3 e 300 caracteres.');
      return;
    }

    const activeItemIds = transferringCard.items
      .filter((i) => i.status === 'active')
      .map((i) => i.id);

    if (activeItemIds.length === 0) {
      setFeedbackToast({
        type: 'error',
        message: 'Esta comanda não possui itens ativos para transferir.',
      });
      return;
    }

    setBusyAction(true);
    try {
      const res = await transferTabConsumptionItems({
        restaurantSlug: currentSlug,
        sourceTabId: transferringCard.id,
        targetTabId: transferTargetTabId,
        itemIds: activeItemIds,
        reason: validation.normalized,
      });

      setFeedbackToast({
        type: 'success',
        message: `${res.transferredIds.length} ${res.transferredIds.length === 1 ? 'item transferido' : 'itens transferidos'} com sucesso!`,
      });
      setTransferringCard(null);
      await loadComandas();
    } catch (err: any) {
      setFeedbackToast({
        type: 'error',
        message: err instanceof Error ? err.message : 'Falha ao transferir itens da comanda.',
      });
    } finally {
      setBusyAction(false);
    }
  }

  return (
    <div className="space-y-4 max-w-md mx-auto pb-6">
      {/* Toast Informativo / Feedback */}
      {feedbackToast && (
        <div
          role="status"
          className={`p-3 rounded-2xl border text-xs flex items-center justify-between shadow-lg animate-in fade-in slide-in-from-top-2 duration-150 ${
            feedbackToast.type === 'success'
              ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-900 dark:text-emerald-200'
              : 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-800 text-red-900 dark:text-red-200'
          }`}
        >
          <span>{feedbackToast.message}</span>
          <button
            type="button"
            onClick={() => setFeedbackToast(null)}
            className="ml-2 p-1 font-bold opacity-60 hover:opacity-100"
            aria-label="Fechar aviso"
          >
            ✕
          </button>
        </div>
      )}

      {/* Mensagem de Erro de Carga */}
      {error && (
        <div role="alert" className="p-3 rounded-2xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/40 text-xs text-red-800 dark:text-red-300">
          {error}
        </div>
      )}

      {/* B. 4 Cards de Métricas Rápidas (Grid 4 Colunas) */}
      <div className="grid grid-cols-4 gap-2">
        {/* Card 1: Abertas */}
        <div className="bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-300 border border-rose-200/60 dark:border-rose-900/40 rounded-2xl p-2.5 text-center flex flex-col items-center justify-center shadow-xs">
          <svg className="w-4 h-4 mb-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
            <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
          </svg>
          <span className="text-base font-extrabold leading-none">{countAbertas}</span>
          <span className="text-[10px] font-semibold mt-1 leading-none">Abertas</span>
        </div>

        {/* Card 2: Em preparo */}
        <div className="bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300 border border-amber-200/60 dark:border-amber-900/40 rounded-2xl p-2.5 text-center flex flex-col items-center justify-center shadow-xs">
          <svg className="w-4 h-4 mb-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M6 13.87A4 4 0 0 1 7.41 6a5.11 5.11 0 0 1 1.05-1.54 5 5 0 0 1 7.08 0A5.11 5.11 0 0 1 16.59 6 4 4 0 0 1 18 13.87V21H6Z" />
            <line x1="6" y1="17" x2="18" y2="17" />
          </svg>
          <span className="text-base font-extrabold leading-none">{countPreparo}</span>
          <span className="text-[10px] font-semibold mt-1 leading-none">Em preparo</span>
        </div>

        {/* Card 3: Prontas */}
        <div className="bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300 border border-emerald-200/60 dark:border-emerald-900/40 rounded-2xl p-2.5 text-center flex flex-col items-center justify-center shadow-xs">
          <svg className="w-4 h-4 mb-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
          <span className="text-base font-extrabold leading-none">{countProntas}</span>
          <span className="text-[10px] font-semibold mt-1 leading-none">Prontas</span>
        </div>

        {/* Card 4: Do turno */}
        <div className="bg-sky-50 dark:bg-sky-950/30 text-sky-700 dark:text-sky-300 border border-sky-200/60 dark:border-sky-900/40 rounded-2xl p-2.5 text-center flex flex-col items-center justify-center shadow-xs">
          <svg className="w-4 h-4 mb-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <line x1="18" y1="20" x2="18" y2="10" />
            <line x1="12" y1="20" x2="12" y2="4" />
            <line x1="6" y1="20" x2="6" y2="14" />
          </svg>
          <span className="text-xs font-extrabold leading-none truncate max-w-full">
            {currency.format(totalTurnoCents / 100).replace(',00', '')}
          </span>
          <span className="text-[10px] font-semibold mt-1 leading-none">do turno</span>
        </div>
      </div>

      {/* C. Busca e Filtros de Status */}
      <div className="space-y-2.5">
        <div className="flex items-center gap-2">
          {/* Input de busca */}
          <div className="relative flex-1 flex items-center rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3.5 py-2.5 shadow-xs">
            <svg className="w-4 h-4 text-zinc-400 shrink-0 mr-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Buscar comanda, mesa ou cliente..."
              className="w-full text-xs text-zinc-800 dark:text-white placeholder:text-zinc-400 bg-transparent focus:outline-none"
            />
          </div>

          {/* Botão de Ordenação */}
          <button
            type="button"
            title="Alternar ordenação"
            aria-label="Alternar ordenação"
            onClick={() => {
              setSortOrder((prev) => (prev === 'newest' ? 'total' : prev === 'total' ? 'table' : 'newest'));
            }}
            className="w-10 h-10 rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 flex items-center justify-center text-zinc-600 dark:text-zinc-300 shadow-xs hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors cursor-pointer shrink-0"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <line x1="4" y1="21" x2="4" y2="14" />
              <line x1="4" y1="10" x2="4" y2="3" />
              <line x1="12" y1="21" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12" y2="3" />
              <line x1="20" y1="21" x2="20" y2="16" />
              <line x1="20" y1="12" x2="20" y2="3" />
              <line x1="1" y1="14" x2="7" y2="14" />
              <line x1="9" y1="8" x2="15" y2="8" />
              <line x1="17" y1="16" x2="23" y2="16" />
            </svg>
          </button>
        </div>

        {/* Pílulas Horizontais de Status */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none">
          {[
            { id: 'todas', label: 'Todas' },
            { id: 'abertas', label: 'Abertas' },
            { id: 'preparo', label: 'Em preparo' },
            { id: 'prontas', label: 'Prontas' },
            { id: 'finalizadas', label: 'Finalizadas' },
          ].map((tab) => {
            const isActive = statusFilter === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setStatusFilter(tab.id as typeof statusFilter)}
                className={`rounded-xl px-4 py-2 text-xs font-semibold shadow-xs shrink-0 transition-colors cursor-pointer ${
                  isActive
                    ? 'bg-[#4A1505] text-white'
                    : 'bg-white dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 border border-zinc-200/80 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-700/60'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* D. Lista de Cards de Comandas Paginada */}
      {loading ? (
        <div className="py-12 text-center text-xs text-zinc-400">
          Carregando comandas…
        </div>
      ) : filteredCards.length === 0 ? (
        <div className="bg-white dark:bg-zinc-900 rounded-3xl p-8 border border-zinc-200/80 dark:border-zinc-800 text-center my-6 shadow-xs">
          <div className="w-14 h-14 rounded-full bg-[#FAF4EE] dark:bg-zinc-800 flex items-center justify-center text-[#782006] dark:text-amber-300 mx-auto mb-3">
            <svg className="w-7 h-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
              <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
            </svg>
          </div>
          <h4 className="font-bold text-sm text-zinc-900 dark:text-white mb-1">
            Nenhuma comanda encontrada
          </h4>
          <p className="text-xs text-zinc-400 dark:text-zinc-500 max-w-xs mx-auto">
            Não há comandas cadastradas para o filtro selecionado. Quando os atendimentos forem iniciados, as comandas aparecerão aqui.
          </p>
        </div>
      ) : (
        <div className="space-y-3.5">
          {paginatedCards.map((card) => {
            const timeElapsed = formatElapsed(card.openedAt);

            return (
              <div
                key={card.id}
                onClick={() => handleOpenComandaDetails(card)}
                className="bg-white dark:bg-zinc-900 rounded-3xl p-4 border border-zinc-200/80 dark:border-zinc-800 shadow-xs hover:border-amber-900/30 transition-all cursor-pointer"
              >
                {/* 1. Cabeçalho do Card */}
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-11 h-11 rounded-2xl bg-[#FAF4EE] dark:bg-zinc-800 flex items-center justify-center text-[#782006] dark:text-amber-200 shrink-0">
                      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <path d="M3 9h18" />
                        <path d="M5 9v9" />
                        <path d="M19 9v9" />
                        <path d="M4 14h16" />
                      </svg>
                    </div>

                    <div className="min-w-0">
                      <h4 className="font-bold text-sm text-zinc-900 dark:text-white leading-tight truncate">
                        {card.label}
                      </h4>
                      <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5 truncate">
                        Mesa {String(card.tableNumber).padStart(2, '0')} • {card.tableArea}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {/* Badge de Status */}
                    {card.status === 'ready' ? (
                      <span className="bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 font-semibold text-xs px-2.5 py-1 rounded-full flex items-center gap-1.5 border border-rose-200/50">
                        <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse" />
                        Aguardando conta
                      </span>
                    ) : card.status === 'preparing' ? (
                      <span className="bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 font-semibold text-xs px-2.5 py-1 rounded-full flex items-center gap-1.5 border border-amber-200/50">
                        <span className="w-2 h-2 rounded-full bg-amber-500" />
                        Em preparo
                      </span>
                    ) : card.status === 'closed' ? (
                      <span className="bg-zinc-100 dark:bg-zinc-800 text-zinc-500 font-semibold text-xs px-2.5 py-1 rounded-full flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-zinc-400" />
                        Finalizada
                      </span>
                    ) : (
                      <span className="bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 font-semibold text-xs px-2.5 py-1 rounded-full flex items-center gap-1.5 border border-emerald-200/50">
                        <span className="w-2 h-2 rounded-full bg-emerald-500" />
                        Aberta
                      </span>
                    )}

                    <svg className="w-4 h-4 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </div>
                </div>

                {/* 2. Linha de Informações Operacionais */}
                <div className="flex items-center justify-between py-2.5 border-y border-zinc-100 dark:border-zinc-800 my-3 text-xs">
                  <div className="flex items-center gap-3 text-zinc-600 dark:text-zinc-300 font-medium">
                    {/* Qtd Itens */}
                    <div className="flex items-center gap-1">
                      <svg className="w-3.5 h-3.5 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <path d="M18 2v6a3 3 0 0 1-3 3 3 3 0 0 1-3-3V2" />
                        <path d="M15 2v14a2 2 0 0 1-2 2h-2" />
                        <path d="M6 2v20" />
                      </svg>
                      <span>{card.itemsCount} {card.itemsCount === 1 ? 'item' : 'itens'}</span>
                    </div>

                    {/* Acessos / Pessoas */}
                    <div className="flex items-center gap-1">
                      <svg className="w-3.5 h-3.5 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                        <circle cx="9" cy="7" r="4" />
                      </svg>
                      <span>
                        {card.linkedGuestsCount > 0
                          ? `${card.linkedGuestsCount} ${card.linkedGuestsCount === 1 ? 'acesso vinculado' : 'acessos'}`
                          : '1 pessoa'}
                      </span>
                    </div>

                    {/* Tempo */}
                    <div className="flex items-center gap-1">
                      <svg className="w-3.5 h-3.5 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <circle cx="12" cy="12" r="10" />
                        <polyline points="12 6 12 12 16 14" />
                      </svg>
                      <span>{timeElapsed}</span>
                    </div>
                  </div>

                  {/* Valor Total */}
                  <div className="text-right">
                    <span className="text-[10px] text-zinc-400 block leading-tight">Total</span>
                    <span className="text-sm font-extrabold text-zinc-900 dark:text-white leading-tight">
                      {currency.format(card.totalInCents / 100)}
                    </span>
                  </div>
                </div>

                {/* 3. Barra de Ações do Card (Organizada em 2 Linhas Equilibradas) */}
                <div
                  onClick={(e) => e.stopPropagation()}
                  className="space-y-2 pt-2 border-t border-zinc-100 dark:border-zinc-800/80 mt-3"
                >
                  {/* Linha 1: Botão Principal "Ver comanda" em Toda a Largura */}
                  <button
                    type="button"
                    onClick={() => handleOpenComandaDetails(card)}
                    className="w-full bg-[#4A1505] hover:bg-[#381004] text-white font-bold py-2.5 px-4 rounded-xl text-xs flex items-center justify-center gap-2 shadow-xs transition-colors cursor-pointer active:scale-[0.99]"
                  >
                    <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                    <span>Ver comanda</span>
                  </button>

                  {/* Linha 2: 3 Colunas Equilibradas (Imprimir, Transferir, Mais) */}
                  <div className="grid grid-cols-3 gap-2 relative" data-more-menu>
                    {/* Imprimir */}
                    <button
                      type="button"
                      onClick={() => handlePrintReceipt(card)}
                      className="w-full py-2 px-1 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-[11px] font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700/60 flex items-center justify-center gap-1.5 transition-colors cursor-pointer truncate shadow-xs active:scale-[0.98]"
                      title="Imprimir cupom de conferência"
                    >
                      <svg className="w-3.5 h-3.5 shrink-0 text-zinc-500 dark:text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M6 9V2h12v7" />
                        <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                        <path d="M6 14h12v8H6z" />
                      </svg>
                      <span className="truncate">Imprimir</span>
                    </button>

                    {/* Transferir */}
                    <button
                      type="button"
                      disabled={card.status === 'closed' || busyAction}
                      onClick={() => void handleOpenTransferModal(card)}
                      className="w-full py-2 px-1 rounded-xl border flex items-center justify-center gap-1.5 transition-colors truncate shadow-xs border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-[11px] font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700/60 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 active:scale-[0.98]"
                      title={card.status === 'closed' ? 'Comandas finalizadas não podem ser transferidas' : 'Transferir itens desta comanda para outra mesa'}
                    >
                      <svg className="w-3.5 h-3.5 shrink-0 text-zinc-500 dark:text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M16 3h5v5" />
                        <path d="M4 20 21 3" />
                        <path d="M21 16v5h-5" />
                        <path d="m15 15 6 6" />
                        <path d="M4 4l5 5" />
                      </svg>
                      <span className="truncate">Transferir</span>
                    </button>

                    {/* Mais */}
                    <button
                      type="button"
                      onClick={() => setActiveMenuCardId((prev) => (prev === card.id ? null : card.id))}
                      aria-expanded={activeMenuCardId === card.id}
                      className={`w-full py-2 px-1 rounded-xl border transition-colors flex items-center justify-center gap-1 cursor-pointer shadow-xs active:scale-[0.98] ${
                        activeMenuCardId === card.id
                          ? 'border-amber-900/30 dark:border-amber-400/40 bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200 font-bold'
                          : 'border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-[11px] font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700/60'
                      }`}
                      title="Mais opções"
                    >
                      <svg className="w-3.5 h-3.5 shrink-0 text-zinc-500 dark:text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <circle cx="12" cy="12" r="1.5" />
                        <circle cx="19" cy="12" r="1.5" />
                        <circle cx="5" cy="12" r="1.5" />
                      </svg>
                      <span className="truncate">Mais</span>
                    </button>

                    {/* Menu Dropdown de Mais Ações */}
                    {activeMenuCardId === card.id && (
                      <div
                        role="menu"
                        aria-orientation="vertical"
                        className="absolute right-0 bottom-full mb-1.5 w-52 bg-white dark:bg-zinc-800 rounded-2xl shadow-xl border border-zinc-200 dark:border-zinc-700 p-1.5 z-30 animate-in fade-in zoom-in-95 duration-150"
                      >
                        {card.status !== 'closed' && (
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => handleOpenCloseModal(card)}
                            className="w-full text-left px-3 py-2 rounded-xl text-xs font-semibold text-amber-900 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/50 flex items-center gap-2 transition-colors cursor-pointer"
                          >
                            <svg className="w-3.5 h-3.5 text-amber-700 dark:text-amber-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <rect x="2" y="5" width="20" height="14" rx="2" />
                              <line x1="2" y1="10" x2="22" y2="10" />
                            </svg>
                            <span>Fechar comanda</span>
                          </button>
                        )}

                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setActiveMenuCardId(null);
                            handlePrintReceipt(card);
                          }}
                          className="w-full text-left px-3 py-2 rounded-xl text-xs font-semibold text-zinc-800 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700/60 flex items-center gap-2 transition-colors cursor-pointer"
                        >
                          <svg className="w-3.5 h-3.5 text-zinc-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polyline points="6 9 6 2 18 2 18 9" />
                            <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                            <rect x="6" y="14" width="12" height="8" />
                          </svg>
                          <span>Reimprimir cupom</span>
                        </button>

                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setActiveMenuCardId(null);
                            if (typeof navigator !== 'undefined' && navigator.clipboard) {
                              void navigator.clipboard.writeText(card.tabId);
                              setFeedbackToast({ type: 'success', message: 'ID da comanda copiado para a área de transferência!' });
                            }
                          }}
                          className="w-full text-left px-3 py-2 rounded-xl text-xs font-semibold text-zinc-800 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700/60 flex items-center gap-2 transition-colors cursor-pointer"
                        >
                          <svg className="w-3.5 h-3.5 text-zinc-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                          </svg>
                          <span>Copiar ID da comanda</span>
                        </button>

                        {card.status === 'closed' && (
                          <div className="px-3 py-1.5 text-[11px] text-zinc-400 dark:text-zinc-500 border-t border-zinc-100 dark:border-zinc-700/60 mt-1">
                            Comanda finalizada (histórico)
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* E. Informação e Controles de Paginação (Abaixo da Lista) */}
      {!loading && filteredCards.length > 0 && (
        <div className="pt-2 pb-6 space-y-3">
          {/* Texto de Contagem Real */}
          <div className="text-center text-xs font-semibold text-zinc-500 dark:text-zinc-400">
            {displayText}
          </div>

          {/* Barra de Paginação (se houver mais de 1 página) */}
          {totalPages > 1 && (
            <nav aria-label="Paginação de comandas" className="flex items-center justify-center gap-1.5 flex-wrap">
              {/* Botão Anterior */}
              <button
                type="button"
                disabled={currentPage === 1}
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                className="px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-semibold text-zinc-700 dark:text-zinc-300 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-zinc-50 dark:hover:bg-zinc-700/60 transition-colors shadow-xs cursor-pointer"
              >
                Anterior
              </button>

              {/* Páginas Numeradas */}
              {pageNumbers.map((page, idx) => {
                if (page === '...') {
                  return (
                    <span key={`dots-${idx}`} className="px-2 py-2 text-xs text-zinc-400 dark:text-zinc-600 select-none">
                      …
                    </span>
                  );
                }

                const isCurrent = page === currentPage;
                return (
                  <button
                    key={page}
                    type="button"
                    aria-current={isCurrent ? 'page' : undefined}
                    onClick={() => setCurrentPage(page as number)}
                    className={`min-w-[36px] h-9 px-2.5 rounded-xl text-xs font-bold transition-colors shadow-xs flex items-center justify-center cursor-pointer ${
                      isCurrent
                        ? 'bg-[#4A1505] text-white'
                        : 'border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700/60'
                    }`}
                  >
                    {page}
                  </button>
                );
              })}

              {/* Botão Próxima */}
              <button
                type="button"
                disabled={currentPage === totalPages}
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                className="px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-semibold text-zinc-700 dark:text-zinc-300 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-zinc-50 dark:hover:bg-zinc-700/60 transition-colors shadow-xs cursor-pointer"
              >
                Próxima
              </button>
            </nav>
          )}
        </div>
      )}

      {/* =====================================================================
          MODAL 1: DETALHES COMPLETOS DA COMANDA PELO UUID ("Ver comanda")
          - Exibe detalhes reais mesmo de atendimentos finalizados ou visitas anteriores
          - Visualizar comanda finalizada NUNCA a reabre
         ===================================================================== */}
      {viewingCard && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="viewing-modal-title"
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto"
        >
          <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-3xl p-5 max-w-md w-full shadow-2xl space-y-4 animate-in fade-in zoom-in-95 duration-150 my-auto">
            {/* Cabeçalho do Modal de Detalhes */}
            <div className="flex items-start justify-between gap-3 border-b border-zinc-100 dark:border-zinc-800 pb-3">
              <div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                  Mesa {String(viewingCard.tableNumber).padStart(2, '0')} • {viewingCard.tableArea}
                </span>
                <h3 id="viewing-modal-title" className="text-base font-extrabold text-zinc-900 dark:text-white mt-0.5">
                  {viewingCard.label}
                </h3>
                <div className="flex items-center gap-1.5 mt-1">
                  <span className="text-[10px] font-mono text-zinc-400 select-all">
                    UUID: {viewingCard.tabId}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      if (typeof navigator !== 'undefined' && navigator.clipboard) {
                        void navigator.clipboard.writeText(viewingCard.tabId);
                        setFeedbackToast({ type: 'success', message: 'UUID copiado!' });
                      }
                    }}
                    title="Copiar UUID"
                    className="text-[10px] text-amber-800 dark:text-amber-400 hover:underline cursor-pointer"
                  >
                    (copiar)
                  </button>
                </div>
              </div>

              {/* Badge de Status */}
              <div>
                {viewingCard.status === 'ready' ? (
                  <span className="bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 font-semibold text-xs px-2.5 py-1 rounded-full border border-rose-200/50">
                    Aguardando conta
                  </span>
                ) : viewingCard.status === 'preparing' ? (
                  <span className="bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 font-semibold text-xs px-2.5 py-1 rounded-full border border-amber-200/50">
                    Em preparo
                  </span>
                ) : viewingCard.status === 'closed' ? (
                  <span className="bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 font-semibold text-xs px-2.5 py-1 rounded-full">
                    Finalizada (Histórico)
                  </span>
                ) : (
                  <span className="bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 font-semibold text-xs px-2.5 py-1 rounded-full border border-emerald-200/50">
                    Aberta
                  </span>
                )}
              </div>
            </div>

            {/* Informações de Tempo e Pessoas */}
            <div className="grid grid-cols-2 gap-2 text-xs bg-zinc-50 dark:bg-zinc-800/40 p-3 rounded-2xl border border-zinc-100 dark:border-zinc-800">
              <div>
                <span className="text-[10px] text-zinc-400 block font-medium">Abertura:</span>
                <strong className="text-zinc-800 dark:text-zinc-200 font-semibold">
                  {formatDateTime(viewingCard.openedAt)}
                </strong>
              </div>
              <div>
                <span className="text-[10px] text-zinc-400 block font-medium">Encerramento:</span>
                <strong className="text-zinc-800 dark:text-zinc-200 font-semibold">
                  {viewingCard.closedAt ? formatDateTime(viewingCard.closedAt) : 'Em andamento'}
                </strong>
              </div>
            </div>

            {/* Lista Detalhada de Itens Lançados */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold text-zinc-900 dark:text-zinc-100">
                  Itens Lançados ({viewingCard.items.length})
                </span>
                <span className="text-[11px] text-zinc-400">
                  {viewingCard.items.filter((i) => i.status === 'active').length} ativos
                </span>
              </div>

              <div className="max-h-56 overflow-y-auto space-y-1.5 pr-1 divide-y divide-zinc-100 dark:divide-zinc-800">
                {viewingCard.items.length === 0 ? (
                  <p className="text-xs text-zinc-400 italic py-3 text-center">
                    Nenhum item lançado nesta comanda.
                  </p>
                ) : (
                  viewingCard.items.map((item) => (
                    <div key={item.id} className="pt-1.5 first:pt-0 flex items-center justify-between text-xs">
                      <div className="min-w-0 pr-2">
                        <div className="flex items-center gap-1.5">
                          <span className="font-bold text-zinc-900 dark:text-zinc-100">
                            {item.quantity}x
                          </span>
                          <span className={`truncate ${item.status === 'cancelled' ? 'line-through text-zinc-400' : 'text-zinc-800 dark:text-zinc-200 font-medium'}`}>
                            {item.product_name}
                          </span>
                        </div>
                        {item.status === 'cancelled' ? (
                          <span className="text-[10px] text-rose-600 font-semibold">Cancelado</span>
                        ) : (
                          <span className="text-[10px] text-zinc-400 font-normal">
                            {currency.format(item.unit_price_in_cents / 100)} cada
                          </span>
                        )}
                      </div>
                      <span className="font-bold text-zinc-900 dark:text-zinc-100 shrink-0">
                        {item.status === 'cancelled' ? 'R$ 0,00' : currency.format(item.line_total_in_cents / 100)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Resumo Financeiro */}
            <div className="pt-2 border-t border-zinc-100 dark:border-zinc-800 space-y-1 text-xs">
              <div className="flex justify-between text-zinc-600 dark:text-zinc-400">
                <span>Subtotal</span>
                <span className="font-semibold text-zinc-800 dark:text-zinc-200">
                  {currency.format((viewingCard.subtotalInCents ?? viewingCard.totalInCents) / 100)}
                </span>
              </div>

              {viewingCard.status === 'closed' ? (
                viewingCard.serviceFeeInCents != null && viewingCard.serviceFeeInCents > 0 ? (
                  <div className="flex justify-between text-zinc-600 dark:text-zinc-400">
                    <span>Taxa de serviço ({viewingCard.serviceFeePercent ?? 0}%)</span>
                    <span className="font-semibold text-zinc-800 dark:text-zinc-200">
                      {currency.format(viewingCard.serviceFeeInCents / 100)}
                    </span>
                  </div>
                ) : (
                  <div className="flex justify-between text-zinc-400">
                    <span>Taxa de serviço</span>
                    <span>Não inclusa</span>
                  </div>
                )
              ) : (
                (() => {
                  const restFee = restaurant?.serviceFeePercent ?? 10;
                  const preview = calculateTabClosurePreview(viewingCard.totalInCents, restFee, true);
                  return (
                    <div className="flex justify-between text-zinc-600 dark:text-zinc-400">
                      <span>Taxa de serviço sugerida ({preview.serviceFeePercent}%)</span>
                      <span className="font-semibold text-zinc-800 dark:text-zinc-200">
                        {currency.format(preview.serviceFeeInCents / 100)}
                      </span>
                    </div>
                  );
                })()
              )}

              <div className="flex justify-between text-sm font-extrabold text-zinc-900 dark:text-white pt-1 border-t border-zinc-200/60 dark:border-zinc-800">
                <span>Total {viewingCard.status === 'closed' ? 'pago' : 'a pagar'}</span>
                <span className="text-[#782006] dark:text-amber-400">
                  {currency.format(viewingCard.totalInCents / 100)}
                </span>
              </div>
            </div>

            {/* Rodapé do Modal de Detalhes */}
            <div className="flex flex-col gap-2 pt-2">
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => handlePrintReceipt(viewingCard)}
                  className="flex-1 py-2.5 px-3 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-bold text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-700/60 flex items-center justify-center gap-1.5 transition-colors cursor-pointer shadow-xs"
                >
                  <svg className="w-4 h-4 text-zinc-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M6 9V2h12v7" />
                    <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                    <path d="M6 14h12v8H6z" />
                  </svg>
                  <span>{viewingCard.status === 'closed' ? 'Imprimir recibo' : 'Imprimir pré-conta'}</span>
                </button>

                {viewingCard.status !== 'closed' && (
                  <button
                    type="button"
                    onClick={() => {
                      const target = viewingCard;
                      setViewingCard(null);
                      handleOpenCloseModal(target);
                    }}
                    className="flex-1 py-2.5 px-3 rounded-xl bg-amber-800 hover:bg-amber-900 text-white text-xs font-bold transition-colors cursor-pointer shadow-xs flex items-center justify-center gap-1.5"
                  >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="2" y="5" width="20" height="14" rx="2" />
                      <line x1="2" y1="10" x2="22" y2="10" />
                    </svg>
                    <span>Fechar comanda</span>
                  </button>
                )}
              </div>

              <button
                type="button"
                onClick={() => setViewingCard(null)}
                className="w-full py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-xs font-semibold text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700/60 transition cursor-pointer"
              >
                Fechar detalhes
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          MODAL 2: TRANSFERÊNCIA DE COMANDA ("Transferir")
          - Exige seleção explícita da comanda de destino (sem auto-selecionar a primeira da mesa)
          - Cancelamento + recriação foi removido por risco de perda parcial, alteração de preço
            e reinício do status de preparo na cozinha (KDS).
          - Permanece desabilitado indicando a lacuna arquitetural de ausência de RPC transacional.
         ===================================================================== */}
      {transferringCard && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="transfer-modal-title"
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4"
        >
          <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-3xl p-5 max-w-sm w-full shadow-2xl space-y-4 animate-in fade-in zoom-in-95 duration-150">
            <div>
              <span className="text-[10px] font-bold uppercase tracking-wider text-amber-700 dark:text-amber-400">
                Transferência de itens da comanda
              </span>
              <h3 id="transfer-modal-title" className="text-base font-extrabold text-zinc-900 dark:text-white mt-0.5">
                Transferir "{transferringCard.label}"
              </h3>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
                Origem: Mesa {String(transferringCard.tableNumber).padStart(2, '0')} ({transferringCard.tableArea})
              </p>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label htmlFor="target-transfer-table" className="block text-xs font-bold text-zinc-700 dark:text-zinc-300 mb-1">
                  Mesa de destino:
                </label>
                {transferOccupiedTables.length === 0 ? (
                  <p className="text-xs text-zinc-500 bg-zinc-50 dark:bg-zinc-800/60 p-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700">
                    Não há outras mesas em atendimento no salão no momento.
                  </p>
                ) : (
                  <select
                    id="target-transfer-table"
                    value={transferTargetTableId}
                    onChange={(e) => void handleTransferTableChange(e.target.value)}
                    disabled={busyAction}
                    className="w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2.5 text-xs text-zinc-900 dark:text-white cursor-pointer focus:border-amber-600 focus:outline-none"
                  >
                    <option value="">Selecione a mesa de destino...</option>
                    {transferOccupiedTables.map((t) => (
                      <option key={t.id} value={t.id}>
                        Mesa {String(t.table_number).padStart(2, '0')} {t.label ? `(${t.label})` : '— Em atendimento'}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div>
                <label htmlFor="target-transfer-tab" className="block text-xs font-bold text-zinc-700 dark:text-zinc-300 mb-1">
                  Comanda de destino (seleção explícita):
                </label>
                <select
                  id="target-transfer-tab"
                  value={transferTargetTabId}
                  onChange={(e) => {
                    setTransferTargetTabId(e.target.value);
                    setTransferReasonError('');
                  }}
                  disabled={busyAction || transferTargetTabs.length === 0}
                  className="w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2.5 text-xs text-zinc-900 dark:text-white cursor-pointer focus:border-amber-600 focus:outline-none disabled:bg-zinc-100 dark:disabled:bg-zinc-800/50 disabled:cursor-not-allowed"
                >
                  <option value="">Selecione a comanda de destino...</option>
                  {transferTargetTabs.map((tab) => (
                    <option key={tab.id} value={tab.id}>
                      {tab.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <div className="flex justify-between items-center mb-1">
                  <label htmlFor="target-transfer-reason" className="block text-xs font-bold text-zinc-700 dark:text-zinc-300">
                    Motivo da transferência (auditoria) <span className="text-rose-500">*</span>:
                  </label>
                  <span className="text-[10px] text-zinc-400">
                    {transferReason.trim().length}/300
                  </span>
                </div>
                <textarea
                  id="target-transfer-reason"
                  rows={2}
                  value={transferReason}
                  disabled={busyAction}
                  onChange={(e) => {
                    setTransferReason(e.target.value);
                    setTransferReasonError('');
                  }}
                  placeholder="Ex.: Mudança de mesa do cliente, reagrupamento..."
                  className="w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-xs text-zinc-900 dark:text-white placeholder:text-zinc-400 focus:border-amber-600 focus:outline-none resize-none"
                />
                {transferReasonError && (
                  <p className="text-[11px] text-rose-500 font-medium mt-1">{transferReasonError}</p>
                )}
              </div>

              <div className="p-3 rounded-2xl bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-200/60 dark:border-zinc-700/60 space-y-1">
                <div className="flex justify-between text-zinc-600 dark:text-zinc-400">
                  <span>Itens ativos na comanda:</span>
                  <span className="font-bold text-zinc-900 dark:text-white">
                    {transferringCard.items.filter((i) => i.status === 'active').length} itens
                  </span>
                </div>
                <div className="flex justify-between text-zinc-600 dark:text-zinc-400">
                  <span>Subtotal da comanda:</span>
                  <span className="font-bold text-zinc-900 dark:text-white">
                    {currency.format(transferringCard.totalInCents / 100)}
                  </span>
                </div>
              </div>
            </div>

            <div className="flex gap-2 pt-1">
              <button
                type="button"
                disabled={
                  busyAction ||
                  !transferTargetTabId ||
                  transferTargetTabs.length === 0 ||
                  transferReason.trim().length < 3 ||
                  transferringCard.items.filter((i) => i.status === 'active').length === 0
                }
                onClick={() => void handleConfirmTransferTab()}
                className="flex-1 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-semibold text-xs shadow-xs disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed transition"
              >
                {busyAction ? 'Transferindo...' : 'Confirmar transferência'}
              </button>
              <button
                type="button"
                disabled={busyAction}
                onClick={() => setTransferringCard(null)}
                className="px-4 py-2.5 rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 cursor-pointer"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          MODAL 3: FECHAMENTO DE COMANDA COM CONFERÊNCIA DE TAXA ("Fechar comanda")
          - Exibe subtotal, escolha explícita da taxa e total final
          - Não executa fechamento automático; aguarda confirmação explícita
         ===================================================================== */}
      {closingCard && (() => {
        const activeItems = closingCard.items.filter((it) => it.status === 'active');
        const calculatedSubtotal = activeItems.reduce((acc, cur) => acc + (cur.line_total_in_cents || 0), 0);
        const restaurantFee = restaurant?.serviceFeePercent ?? 0;
        const hasFeeConfigured = restaurantFee > 0;

        const preview = calculateTabClosurePreview(calculatedSubtotal, restaurantFee, closingFeeAccepted);
        const baseFeeInCents = calculateTabClosurePreview(calculatedSubtotal, restaurantFee, true).serviceFeeInCents;

        return (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="close-modal-title"
            className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4"
          >
            <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-3xl p-5 max-w-sm w-full shadow-2xl space-y-4 animate-in fade-in zoom-in-95 duration-150">
              <div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-amber-700 dark:text-amber-400">
                  Fechamento individual de comanda
                </span>
                <h3 id="close-modal-title" className="text-base font-extrabold text-zinc-900 dark:text-white mt-0.5">
                  Fechar "{closingCard.label}"
                </h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
                  Mesa {String(closingCard.tableNumber).padStart(2, '0')} • {closingCard.tableArea}
                </p>
              </div>

              {/* Prévia financeira com escolha explícita de taxa */}
              <div className="p-3.5 rounded-2xl bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-200/80 dark:border-zinc-700/60 space-y-2.5 text-xs">
                <div className="flex justify-between items-center text-zinc-600 dark:text-zinc-300">
                  <span>Subtotal dos itens ({activeItems.length})</span>
                  <span className="font-semibold text-zinc-900 dark:text-white">
                    {currency.format(preview.subtotalInCents / 100)}
                  </span>
                </div>

                {hasFeeConfigured && (
                  <div className="space-y-1.5 pt-1.5 border-t border-zinc-200/50 dark:border-zinc-700/50">
                    <div className="flex items-center justify-between">
                      <label className="flex items-center gap-2 cursor-pointer select-none text-zinc-700 dark:text-zinc-200 font-medium">
                        <input
                          type="checkbox"
                          checked={closingFeeAccepted}
                          onChange={(e) => setClosingFeeAccepted(e.target.checked)}
                          disabled={busyAction}
                          className="w-4 h-4 rounded text-amber-800 focus:ring-amber-800 dark:bg-zinc-700 dark:border-zinc-600 cursor-pointer"
                        />
                        <span>Taxa de serviço ({restaurantFee}%)</span>
                      </label>
                      <span
                        className={`font-semibold ${
                          closingFeeAccepted
                            ? 'text-zinc-900 dark:text-white'
                            : 'text-zinc-400 line-through'
                        }`}
                      >
                        {currency.format(baseFeeInCents / 100)}
                      </span>
                    </div>
                    <p className="text-[11px] text-zinc-500 dark:text-zinc-400 pl-6">
                      {closingFeeAccepted
                        ? 'Taxa opcional incluída no total.'
                        : 'Taxa opcional retirada por solicitação do cliente.'}
                    </p>
                  </div>
                )}

                <div className="flex justify-between items-center pt-2 border-t border-zinc-200/80 dark:border-zinc-700/60 font-bold text-sm">
                  <span className="text-zinc-900 dark:text-white">Total para pagamento</span>
                  <span className="text-[#782006] dark:text-amber-400 text-base">
                    {currency.format(preview.totalInCents / 100)}
                  </span>
                </div>
              </div>

              {/* Botões de Ação do Fechamento */}
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  disabled={busyAction}
                  onClick={() => void handleConfirmCloseTab()}
                  className="flex-1 py-2.5 rounded-xl bg-amber-800 hover:bg-amber-900 text-white font-semibold text-xs transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shadow-xs"
                >
                  {busyAction ? 'Encerrando…' : 'Confirmar encerramento'}
                </button>
                <button
                  type="button"
                  disabled={busyAction}
                  onClick={() => setClosingCard(null)}
                  className="px-4 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 font-medium text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 transition cursor-pointer"
                >
                  Cancelar
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

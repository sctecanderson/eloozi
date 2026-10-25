import { useEffect, useState, useMemo, useCallback } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router';
import type { StaffAccess } from '../auth/staffAuth';
import { supabase } from '../../lib/supabase';
import { useRestaurant } from '../restaurants/RestaurantProvider';
import { printTableBillThermal } from '../../components/ThermalReceiptPrint';

interface TabItemRow {
  id: string;
  table_tab_id: string;
  product_name: string;
  quantity: number;
  unit_price_in_cents: number;
  line_total_in_cents: number;
  status: 'active' | 'cancelled';
  production_status?: 'pending' | 'preparing' | 'ready' | 'delivered';
}

interface ComandaCardData {
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

export function ComandasPage() {
  const access = useOutletContext<StaffAccess>();
  const { restaurant } = useRestaurant();
  const { restaurantSlug: paramSlug } = useParams<{ restaurantSlug: string }>();
  const navigate = useNavigate();

  const currentSlug = restaurant?.slug || paramSlug || '';

  const [cards, setCards] = useState<ComandaCardData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshTick, setRefreshTick] = useState(0);

  // Filtros
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'todas' | 'abertas' | 'preparo' | 'prontas' | 'finalizadas'>('todas');
  const [sortOrder, setSortOrder] = useState<'newest' | 'total' | 'table'>('newest');

  // Carregar comandas reais do banco de dados
  const loadComandas = useCallback(async () => {
    try {
      setError('');

      const [tabsRes, visitsRes, tablesRes, itemsRes, guestsRes] = await Promise.all([
        supabase
          .from('table_tabs')
          .select('id, label, status, created_at, closed_at, table_visit_id, restaurant_table_id')
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
          .select('id, table_tab_id, product_name, quantity, unit_price_in_cents, line_total_in_cents, status, production_status')
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
        const totalInCents = activeItems.reduce((acc, cur) => acc + (cur.line_total_in_cents || 0), 0);
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
          totalInCents,
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

  // Contadores para os 4 Cards de Métricas
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

  // Filtro e ordenação das comandas
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

  // Impressão rápida de conferência
  function handlePrintReceipt(card: ComandaCardData) {
    const activeItems = card.items.filter((it) => it.status === 'active');
    const feePercent = restaurant?.serviceFeePercent ?? 10;
    const feeInCents = Math.round((card.totalInCents * feePercent) / 100);
    const grandTotal = card.totalInCents + feeInCents;

    printTableBillThermal({
      restaurantName: restaurant?.name || 'NOMA Restaurante e Bar',
      tableNumber: card.tableNumber,
      tabLabel: card.label,
      items: activeItems.map((it) => ({
        name: it.product_name,
        quantity: it.quantity,
        unitPriceInCents: it.unit_price_in_cents,
        totalInCents: it.line_total_in_cents,
      })),
      subtotalInCents: card.totalInCents,
      serviceFeePercent: feePercent,
      serviceFeeInCents: feeInCents,
      totalInCents: grandTotal,
      paperWidth: '80mm',
    });
  }

  // Redirecionamento ao clicar no card ou em "Abrir comanda"
  function handleOpenComanda(card: ComandaCardData) {
    navigate(`/${currentSlug}/equipe?mesa=${card.tableNumber}`);
  }

  return (
    <div className="space-y-4 max-w-md mx-auto pb-6">
      {/* Mensagem de Erro */}
      {error && (
        <div className="p-3 rounded-2xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/40 text-xs text-red-800 dark:text-red-300">
          {error}
        </div>
      )}

      {/* B. 4 Cards de Métricas Rápidas (Grid 4 Colunas) */}
      <div className="grid grid-cols-4 gap-2">
        {/* Card 1: Abertas */}
        <div className="bg-rose-50 dark:bg-rose-950/30 text-rose-700 dark:text-rose-300 border border-rose-200/60 dark:border-rose-900/40 rounded-2xl p-2.5 text-center flex flex-col items-center justify-center shadow-xs">
          <svg className="w-4 h-4 mb-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
            <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
          </svg>
          <span className="text-base font-extrabold leading-none">{countAbertas}</span>
          <span className="text-[10px] font-semibold mt-1 leading-none">Abertas</span>
        </div>

        {/* Card 2: Em preparo */}
        <div className="bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300 border border-amber-200/60 dark:border-amber-900/40 rounded-2xl p-2.5 text-center flex flex-col items-center justify-center shadow-xs">
          <svg className="w-4 h-4 mb-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M6 13.87A4 4 0 0 1 7.41 6a5.11 5.11 0 0 1 1.05-1.54 5 5 0 0 1 7.08 0A5.11 5.11 0 0 1 16.59 6 4 4 0 0 1 18 13.87V21H6Z" />
            <line x1="6" y1="17" x2="18" y2="17" />
          </svg>
          <span className="text-base font-extrabold leading-none">{countPreparo}</span>
          <span className="text-[10px] font-semibold mt-1 leading-none">Em preparo</span>
        </div>

        {/* Card 3: Prontas */}
        <div className="bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300 border border-emerald-200/60 dark:border-emerald-900/40 rounded-2xl p-2.5 text-center flex flex-col items-center justify-center shadow-xs">
          <svg className="w-4 h-4 mb-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
          <span className="text-base font-extrabold leading-none">{countProntas}</span>
          <span className="text-[10px] font-semibold mt-1 leading-none">Prontas</span>
        </div>

        {/* Card 4: Do turno */}
        <div className="bg-sky-50 dark:bg-sky-950/30 text-sky-700 dark:text-sky-300 border border-sky-200/60 dark:border-sky-900/40 rounded-2xl p-2.5 text-center flex flex-col items-center justify-center shadow-xs">
          <svg className="w-4 h-4 mb-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
            <svg className="w-4 h-4 text-zinc-400 shrink-0 mr-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
            onClick={() => {
              setSortOrder((prev) => (prev === 'newest' ? 'total' : prev === 'total' ? 'table' : 'newest'));
            }}
            className="w-10 h-10 rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 flex items-center justify-center text-zinc-600 dark:text-zinc-300 shadow-xs hover:bg-zinc-50 transition cursor-pointer shrink-0"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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

          {/* Botão de Modo Lista */}
          <button
            type="button"
            title="Modo de visualização"
            className="w-10 h-10 rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 flex items-center justify-center text-zinc-600 dark:text-zinc-300 shadow-xs hover:bg-zinc-50 transition cursor-pointer shrink-0"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="8" y1="6" x2="21" y2="6" />
              <line x1="8" y1="12" x2="21" y2="12" />
              <line x1="8" y1="18" x2="21" y2="18" />
              <line x1="3" y1="6" x2="3.01" y2="6" />
              <line x1="3" y1="12" x2="3.01" y2="12" />
              <line x1="3" y1="18" x2="3.01" y2="18" />
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
                    : 'bg-white dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 border border-zinc-200/80 dark:border-zinc-700 hover:bg-zinc-50'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* D. Lista de Cards de Comandas */}
      {loading ? (
        <div className="py-12 text-center text-xs text-zinc-400">
          Carregando comandas…
        </div>
      ) : filteredCards.length === 0 ? (
        <div className="bg-white dark:bg-zinc-900 rounded-3xl p-8 border border-zinc-200/80 dark:border-zinc-800 text-center my-6 shadow-xs">
          <div className="w-14 h-14 rounded-full bg-[#FAF4EE] dark:bg-zinc-800 flex items-center justify-center text-[#782006] dark:text-amber-300 mx-auto mb-3">
            <svg className="w-7 h-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
          {filteredCards.map((card) => {
            const timeElapsed = formatElapsed(card.openedAt);

            return (
              <div
                key={card.id}
                onClick={() => handleOpenComanda(card)}
                className="bg-white dark:bg-zinc-900 rounded-3xl p-4 border border-zinc-200/80 dark:border-zinc-800 shadow-sm hover:border-amber-900/30 transition-all cursor-pointer"
              >
                {/* 1. Cabeçalho do Card */}
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-11 h-11 rounded-2xl bg-[#FAF4EE] dark:bg-zinc-800 flex items-center justify-center text-[#782006] dark:text-amber-200 shrink-0">
                      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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

                    <svg className="w-4 h-4 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </div>
                </div>

                {/* 2. Linha de Informações Operacionais */}
                <div className="flex items-center justify-between py-2.5 border-y border-zinc-100 dark:border-zinc-800 my-3 text-xs">
                  <div className="flex items-center gap-3 text-zinc-600 dark:text-zinc-300 font-medium">
                    {/* Qtd Itens */}
                    <div className="flex items-center gap-1">
                      <svg className="w-3.5 h-3.5 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M18 2v6a3 3 0 0 1-3 3 3 3 0 0 1-3-3V2" />
                        <path d="M15 2v14a2 2 0 0 1-2 2h-2" />
                        <path d="M6 2v20" />
                      </svg>
                      <span>{card.itemsCount} {card.itemsCount === 1 ? 'item' : 'itens'}</span>
                    </div>

                    {/* Acessos / Pessoas */}
                    <div className="flex items-center gap-1">
                      <svg className="w-3.5 h-3.5 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
                      <svg className="w-3.5 h-3.5 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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

                {/* 3. Barra de Ações do Card */}
                <div
                  onClick={(e) => e.stopPropagation()}
                  className="flex items-center justify-between gap-2 pt-0.5"
                >
                  <div className="flex items-center gap-1.5">
                    {/* Imprimir */}
                    <button
                      type="button"
                      onClick={() => handlePrintReceipt(card)}
                      className="px-2.5 py-1.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-[11px] font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 flex items-center gap-1.5 transition cursor-pointer"
                    >
                      <svg className="w-3.5 h-3.5 text-zinc-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M6 9V2h12v7" />
                        <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                        <path d="M6 14h12v8H6z" />
                      </svg>
                      <span>Imprimir</span>
                    </button>

                    {/* Transferir */}
                    <button
                      type="button"
                      onClick={() => handleOpenComanda(card)}
                      className="px-2.5 py-1.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-[11px] font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 flex items-center gap-1.5 transition cursor-pointer"
                    >
                      <svg className="w-3.5 h-3.5 text-zinc-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M16 3h5v5" />
                        <path d="M4 20 21 3" />
                        <path d="M21 16v5h-5" />
                        <path d="m15 15 6 6" />
                        <path d="M4 4l5 5" />
                      </svg>
                      <span>Transferir</span>
                    </button>

                    {/* Mais Ações */}
                    <button
                      type="button"
                      onClick={() => handleOpenComanda(card)}
                      className="px-2 py-1.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-[11px] font-semibold text-zinc-500 hover:bg-zinc-50 transition cursor-pointer"
                      title="Mais ações"
                    >
                      ••• Mais ações
                    </button>
                  </div>

                  {/* Botão Primário Largo */}
                  {card.status === 'ready' ? (
                    <button
                      type="button"
                      onClick={() => handleOpenComanda(card)}
                      className="bg-[#4A1505] hover:bg-[#381004] text-white font-bold px-4 py-2 rounded-xl text-xs flex items-center gap-1.5 shadow-sm transition cursor-pointer shrink-0"
                    >
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="2" y="5" width="20" height="14" rx="2" />
                        <line x1="2" y1="10" x2="22" y2="10" />
                      </svg>
                      <span>Fechar conta</span>
                    </button>
                  ) : card.status === 'preparing' ? (
                    <button
                      type="button"
                      onClick={() => handleOpenComanda(card)}
                      className="bg-[#4A1505] hover:bg-[#381004] text-white font-bold px-4 py-2 rounded-xl text-xs flex items-center gap-1.5 shadow-sm transition cursor-pointer shrink-0"
                    >
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                      <span>Ver itens</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleOpenComanda(card)}
                      className="bg-[#4A1505] hover:bg-[#381004] text-white font-bold px-4 py-2 rounded-xl text-xs flex items-center gap-1.5 shadow-sm transition cursor-pointer shrink-0"
                    >
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
                        <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
                      </svg>
                      <span>Abrir comanda</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

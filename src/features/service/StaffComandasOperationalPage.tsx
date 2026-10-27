import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useNavigate, useOutletContext, useSearchParams } from 'react-router';
import type { StaffAccess } from '../auth/staffAuth';
import { useRestaurant } from '../restaurants/RestaurantProvider';
import { ThemeToggleButton } from '../theme/ThemeToggleButton';
import {
  listSalonOpenTableVisits,
  listRestaurantTables,
  type SalonTableVisit,
  type RestaurantTableItem,
} from './tableVisits';
import {
  getOperationalContext,
  saveOperationalContext,
  clearOperationalContext,
  validateOperationalContext,
  updateOperationalTab,
  updateOperationalSearch,
  updateOperationalScroll,
  isTableLocallyAuthorized,
  setTableLocallyAuthorized,
  type StaffOperationalContext,
} from './staffOperationalContext';
import { TableTabsPanel } from './TableTabsPanel';
import { GuestConfirmationForm } from './GuestConfirmationForm';
import { TableDetailsTabPanel } from './TableDetailsTabPanel';

function formatMinutes(dateStr?: string | null): string {
  if (!dateStr) return '';
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const mins = Math.max(0, Math.floor(diffMs / 60000));
  if (mins < 60) return `${mins}min`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${remMins}min`;
}

export function StaffComandasOperationalPage() {
  const access = useOutletContext<StaffAccess>();
  const { restaurant } = useRestaurant();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const mesaParam = searchParams.get('mesa');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [closedVisitNotice, setClosedVisitNotice] = useState<string | null>(null);

  const [occupiedVisits, setOccupiedVisits] = useState<SalonTableVisit[]>([]);
  const [allTables, setAllTables] = useState<RestaurantTableItem[]>([]);

  // Contexto operacional ativo
  const [activeContext, setActiveContext] = useState<StaffOperationalContext | null>(null);
  const [activeVisit, setActiveVisit] = useState<SalonTableVisit | null>(null);
  const [activeTable, setActiveTable] = useState<RestaurantTableItem | null>(null);

  // Sub-aba da mesa: 'access' | 'tab' | 'details' (padrão é 'tab' = Comandas)
  const [tableActiveTab, setTableActiveTab] = useState<'access' | 'tab' | 'details'>('tab');
  const [showConfirmedToast, setShowConfirmedToast] = useState(false);
  const [openTabsCount, setOpenTabsCount] = useState<number>(0);

  // Estado restaurado para Tab e Catálogo
  const [restoredTabId, setRestoredTabId] = useState<string | null>(null);
  const [restoredSearch, setRestoredSearch] = useState<string>('');

  // Carregar mesas e validar contexto
  const loadDataAndResolveContext = useCallback(async () => {
    if (!restaurant?.id) return;
    setLoading(true);
    setError(null);

    try {
      const [visits, tables] = await Promise.all([
        listSalonOpenTableVisits(restaurant.id),
        listRestaurantTables(restaurant.id),
      ]);

      setOccupiedVisits(visits);
      setAllTables(tables);

      // Cenário 1: Parâmetro ?mesa=XX na URL
      if (mesaParam) {
        const tableNum = parseInt(mesaParam, 10);
        const matchingVisit = visits.find((v) => v.table.table_number === tableNum);
        const matchingTable = tables.find((t) => t.table_number === tableNum);

        if (matchingVisit && matchingTable) {
          const newCtx: StaffOperationalContext = {
            restaurantId: restaurant.id,
            restaurantSlug: restaurant.slug,
            tableId: matchingVisit.restaurant_table_id || matchingTable.id,
            tableNumber: tableNum,
            tableVisitId: matchingVisit.id,
            tableTabId: null,
            searchQuery: '',
            scrollPosition: 0,
            updatedAt: Date.now(),
          };
          saveOperationalContext(newCtx);
          setActiveContext(newCtx);
          setActiveVisit(matchingVisit);
          setActiveTable(matchingTable);
          setClosedVisitNotice(null);
          setLoading(false);
          return;
        } else {
          setClosedVisitNotice(
            `A Mesa ${mesaParam} não está em atendimento ou a visita foi encerrada. Selecione outra mesa em atendimento abaixo.`
          );
          clearOperationalContext(restaurant.id);
          setActiveContext(null);
          setActiveVisit(null);
          setActiveTable(null);
          setLoading(false);
          return;
        }
      }

      // Cenário 2: Restaurar contexto persistido com validação via UUID
      const storedCtx = getOperationalContext(restaurant.id);
      if (storedCtx && storedCtx.tableVisitId) {
        const validation = await validateOperationalContext(
          storedCtx,
          access.memberId,
          access.role
        );

        if (validation.status === 'valid') {
          const matchingVisit = visits.find((v) => v.id === validation.tableVisitId);
          const matchingTable = tables.find((t) => t.table_number === validation.tableNumber);

          if (matchingVisit && matchingTable) {
            setActiveContext(storedCtx);
            setActiveVisit(matchingVisit);
            setActiveTable(matchingTable);
            setRestoredTabId(validation.tableTabId);
            setRestoredSearch(storedCtx.searchQuery || '');
            setClosedVisitNotice(null);
            setLoading(false);
            return;
          }
        } else if (validation.status === 'visit_closed') {
          setClosedVisitNotice(
            `O atendimento da Mesa ${validation.tableNumber} foi encerrado enquanto você estava fora. Selecione outra mesa em atendimento abaixo.`
          );
          clearOperationalContext(restaurant.id);
          setActiveContext(null);
          setActiveVisit(null);
          setActiveTable(null);
          setLoading(false);
          return;
        } else {
          clearOperationalContext(restaurant.id);
          setActiveContext(null);
          setActiveVisit(null);
          setActiveTable(null);
          setLoading(false);
          return;
        }
      }

      // Cenário 3: Nenhum contexto selecionado
      // NÃO auto-seleciona a primeira mesa: exibe seletor das mesas ocupadas!
      setActiveContext(null);
      setActiveVisit(null);
      setActiveTable(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Falha ao carregar atendimentos operacionais.'
      );
    } finally {
      setLoading(false);
    }
  }, [restaurant?.id, restaurant?.slug, mesaParam, access?.memberId, access?.role]);

  useEffect(() => {
    void loadDataAndResolveContext();
  }, [loadDataAndResolveContext]);

  // Restauração e sincronização de Scroll
  useEffect(() => {
    if (!activeVisit || !restaurant?.id) return;

    if (activeContext?.scrollPosition && activeContext.scrollPosition > 0) {
      window.scrollTo({ top: activeContext.scrollPosition, behavior: 'instant' });
    }

    let scrollTimer: ReturnType<typeof setTimeout> | undefined;
    function handleScroll() {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        updateOperationalScroll(restaurant.id, window.scrollY);
      }, 150);
    }

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      clearTimeout(scrollTimer);
      window.removeEventListener('scroll', handleScroll);
    };
  }, [activeVisit?.id, restaurant?.id, activeContext?.scrollPosition]);

  // Selecionar uma mesa ocupada a partir do seletor
  function handleSelectOccupiedTable(visit: SalonTableVisit) {
    if (!restaurant?.id) return;

    const matchingTable = allTables.find((t) => t.table_number === visit.table.table_number);
    const newCtx: StaffOperationalContext = {
      restaurantId: restaurant.id,
      restaurantSlug: restaurant.slug,
      tableId: visit.restaurant_table_id || (matchingTable ? matchingTable.id : ''),
      tableNumber: visit.table.table_number,
      tableVisitId: visit.id,
      tableTabId: null,
      searchQuery: '',
      scrollPosition: 0,
      updatedAt: Date.now(),
    };

    saveOperationalContext(newCtx);
    setActiveContext(newCtx);
    setActiveVisit(visit);
    setActiveTable(matchingTable || null);
    setRestoredTabId(null);
    setRestoredSearch('');
    setClosedVisitNotice(null);
    setTableActiveTab('tab');
    setSearchParams({ mesa: String(visit.table.table_number) });
  }

  // Desfazer seleção para escolher outra mesa
  function handleBackToSelector() {
    setSearchParams({});
    setActiveVisit(null);
    setActiveTable(null);
    if (restaurant?.id) {
      clearOperationalContext(restaurant.id);
    }
  }

  // Navegar entre mesas ocupadas (Anterior / Próxima)
  function handleCycleTable(direction: 'prev' | 'next') {
    if (occupiedVisits.length <= 1 || !activeVisit) return;
    const currentIndex = occupiedVisits.findIndex((v) => v.id === activeVisit.id);
    if (currentIndex === -1) return;

    const nextIndex =
      direction === 'next'
        ? (currentIndex + 1) % occupiedVisits.length
        : (currentIndex - 1 + occupiedVisits.length) % occupiedVisits.length;

    const nextVisit = occupiedVisits[nextIndex];
    handleSelectOccupiedTable(nextVisit);
  }

  const isMyVisit =
    !!activeVisit && activeVisit.assigned_member_id === access.memberId;
  const isOtherStaffVisit =
    !!activeVisit &&
    !!activeVisit.assigned_member_id &&
    activeVisit.assigned_member_id !== access.memberId;

  return (
    <div className="w-full space-y-4 pb-12 animate-in fade-in duration-200">
      {/* Mensagem de Erro Geral */}
      {error && (
        <div
          role="alert"
          className="p-3.5 rounded-2xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 text-xs text-rose-800 dark:text-rose-200 flex items-center justify-between"
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={() => void loadDataAndResolveContext()}
            className="font-bold underline ml-2"
          >
            Tentar novamente
          </button>
        </div>
      )}

      {/* Loading inicial */}
      {loading && (
        <div className="py-12 text-center">
          <p role="status" className="text-xs text-zinc-500 dark:text-zinc-400">
            Carregando operação de comandas…
          </p>
        </div>
      )}

      {/* =========================================================================
          CENÁRIO 1: NENHUMA MESA SELECIONADA OU VISITA ANTERIOR ENCERRADA
          Exibe o seletor das mesas ocupadas em atendimento (sem auto-seleção).
         ========================================================================= */}
      {!loading && !activeVisit && (
        <div className="space-y-4">
          {/* Topo do Seletor */}
          <div className="flex items-center justify-between py-1">
            <div>
              <h1 className="text-xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
                Comandas em Atendimento
              </h1>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                Selecione uma mesa ocupada para gerenciar comandas e lançar consumo.
              </p>
            </div>
            <ThemeToggleButton />
          </div>

          {/* Aviso se a visita foi encerrada enquanto o garçom estava fora */}
          {closedVisitNotice && (
            <div
              role="status"
              className="rounded-2xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 p-4 text-xs text-amber-900 dark:text-amber-200 flex items-start gap-3 shadow-xs animate-in fade-in duration-150"
            >
              <svg
                className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <div className="flex-1">
                <p className="font-bold">{closedVisitNotice}</p>
                <p className="text-[11px] text-amber-800/80 dark:text-amber-300/80 mt-0.5">
                  Escolha outra mesa em atendimento abaixo para continuar o atendimento.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setClosedVisitNotice(null)}
                className="text-amber-600 dark:text-amber-400 p-1 opacity-70 hover:opacity-100"
                aria-label="Fechar aviso"
              >
                ✕
              </button>
            </div>
          )}

          {/* Lista das Mesas Ocupadas */}
          {occupiedVisits.length > 0 ? (
            <div className="space-y-2.5">
              <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-400 block px-1">
                Mesas ocupadas ({occupiedVisits.length})
              </span>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {occupiedVisits.map((visit) => {
                  const tblNum = visit.table?.table_number;
                  const matchingTable = allTables.find((t) => t.table_number === tblNum);
                  const tblLabel = matchingTable?.label || 'Salão principal';
                  const isMy = visit.assigned_member_id === access.memberId;
                  const elapsed = formatMinutes(visit.opened_at) || 'Em atendimento';

                  return (
                    <button
                      key={visit.id}
                      type="button"
                      onClick={() => handleSelectOccupiedTable(visit)}
                      className="flex items-center justify-between p-4 rounded-2xl border border-stone-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:border-amber-900/30 dark:hover:border-amber-700/50 shadow-sm transition-all text-left cursor-pointer group active:scale-[0.99]"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-12 h-12 rounded-2xl bg-[#FAF3ED] dark:bg-zinc-800 text-[#8A3A1B] dark:text-amber-400 flex items-center justify-center shrink-0 shadow-xs">
                          <svg
                            className="w-6 h-6"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <path d="M4 18v3" />
                            <path d="M20 18v3" />
                            <path d="M19 18H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2z" />
                            <path d="M7 7V4a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v3" />
                          </svg>
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-extrabold text-base text-zinc-900 dark:text-zinc-100">
                              Mesa {String(tblNum).padStart(2, '0')}
                            </span>
                            <span
                              className="w-2.5 h-2.5 rounded-full bg-emerald-500 shrink-0"
                              title="Em atendimento"
                            />
                          </div>
                          <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                            {tblLabel} • {elapsed}
                          </span>
                          {isMy && (
                            <span className="inline-block mt-1 text-[10px] font-semibold text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 px-2 py-0.5 rounded-full">
                              Em atendimento por você
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-1 text-xs font-bold text-[#8A3A1B] dark:text-amber-400 group-hover:translate-x-1 transition-transform">
                        <span>Acessar</span>
                        <svg
                          className="w-4 h-4"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                        >
                          <polyline points="9 18 15 12 9 6" />
                        </svg>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="py-12 px-4 text-center rounded-3xl bg-white dark:bg-zinc-900 border border-stone-200/80 dark:border-zinc-800 shadow-sm space-y-3">
              <div className="w-14 h-14 rounded-full bg-stone-100 dark:bg-zinc-800 text-stone-500 dark:text-zinc-400 mx-auto flex items-center justify-center">
                <svg
                  className="w-7 h-7"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                >
                  <path d="M4 18v3" />
                  <path d="M20 18v3" />
                  <path d="M19 18H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2z" />
                  <path d="M7 7V4a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v3" />
                </svg>
              </div>
              <div className="space-y-1">
                <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
                  Nenhuma mesa em atendimento no momento
                </h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 max-w-xs mx-auto">
                  Abra um atendimento no Salão para começar a registrar comandas e lançar itens.
                </p>
              </div>
              <div>
                <button
                  type="button"
                  onClick={() => navigate(`/${restaurant.slug}/equipe`)}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#4A1505] hover:bg-[#381004] text-white text-xs font-bold shadow-xs transition-colors cursor-pointer"
                >
                  <span>Ir para o Salão (Atendimento)</span>
                  <svg
                    className="w-4 h-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* =========================================================================
          CENÁRIO 2: MESA OPERACIONAL SELECIONADA
          Tela Operacional Fiel: Mesa em Atendimento, Comandas, Catálogo e Consumo.
         ========================================================================= */}
      {!loading && activeVisit && (
        <div className="space-y-4">
          {/* Topo: Nome do restaurante + Tema */}
          <div className="flex items-center justify-between py-1">
            <div className="flex flex-col">
              <span className="text-xs font-black tracking-wider uppercase text-zinc-900 dark:text-zinc-100">
                {restaurant?.name || 'NOMA'}
              </span>
              <span className="text-[10px] font-semibold tracking-widest uppercase text-zinc-400">
                {restaurant?.subtitle || 'RESTAURANTE E BAR'}
              </span>
            </div>
            <ThemeToggleButton />
          </div>

          {/* Barra de Navegação: Voltar / Trocar de mesa e Navegador de Mesas */}
          <div className="flex items-center justify-between w-full py-1">
            <button
              type="button"
              onClick={handleBackToSelector}
              className="inline-flex items-center gap-2 text-xs font-bold text-zinc-700 dark:text-zinc-200 hover:text-zinc-900 transition-colors cursor-pointer"
            >
              <span className="w-8 h-8 rounded-full border border-amber-900/15 bg-[#FAF4EE] dark:bg-zinc-800 flex items-center justify-center text-zinc-700 dark:text-zinc-200 shadow-xs">
                <svg
                  className="w-4 h-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                >
                  <polyline points="15 18 9 12 15 6" />
                </svg>
              </span>
              <span>Voltar</span>
            </button>

            {occupiedVisits.length > 1 && (
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => handleCycleTable('prev')}
                  aria-label="Mesa anterior"
                  className="w-8 h-8 rounded-full border border-amber-900/15 bg-[#FAF4EE] dark:bg-zinc-800 flex items-center justify-center text-zinc-700 dark:text-zinc-200 hover:bg-amber-100/50 active:scale-95 transition cursor-pointer"
                >
                  <svg
                    className="w-4 h-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                  >
                    <polyline points="15 18 9 12 15 6" />
                  </svg>
                </button>
                <span className="text-xs font-bold text-zinc-700 dark:text-zinc-300 min-w-[64px] text-center">
                  Mesa {String(activeVisit.table.table_number).padStart(2, '0')}
                </span>
                <button
                  type="button"
                  onClick={() => handleCycleTable('next')}
                  aria-label="Próxima mesa"
                  className="w-8 h-8 rounded-full border border-amber-900/15 bg-[#FAF4EE] dark:bg-zinc-800 flex items-center justify-center text-zinc-700 dark:text-zinc-200 hover:bg-amber-100/50 active:scale-95 transition cursor-pointer"
                >
                  <svg
                    className="w-4 h-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                  >
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </button>
              </div>
            )}
          </div>

          {/* Card Principal de Identificação da Mesa */}
          <div className="rounded-3xl border border-amber-900/10 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-2xl bg-[#FAF3ED] dark:bg-zinc-800 text-[#8A3A1B] dark:text-amber-400 flex items-center justify-center shrink-0 shadow-xs">
                  <svg
                    className="w-6 h-6"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M4 18v3" />
                    <path d="M20 18v3" />
                    <path d="M19 18H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2z" />
                    <path d="M7 7V4a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v3" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-base font-extrabold text-zinc-900 dark:text-white leading-tight">
                    Mesa {String(activeVisit.table.table_number).padStart(2, '0')}
                  </h2>
                  <span className="text-xs text-zinc-500 dark:text-zinc-400 block mt-0.5">
                    {activeTable?.label || 'Salão principal'}
                  </span>
                </div>
              </div>

              {/* Tag de Atendimento */}
              {isMyVisit ? (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-bold bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 border border-emerald-200/60 dark:border-emerald-800">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                  Em atendimento por você
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-bold bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 border border-amber-200/60 dark:border-amber-800">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
                  Outro garçom
                </span>
              )}
            </div>

            {/* Linha com 3 Métricas */}
            <div className="grid grid-cols-3 gap-2 mt-3.5">
              <div className="bg-[#FAF4EE]/70 dark:bg-zinc-800/60 rounded-2xl p-2.5 flex items-center gap-2">
                <svg
                  className="w-4 h-4 text-zinc-500 dark:text-zinc-400 shrink-0"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
                <div className="flex flex-col min-w-0">
                  <span className="text-[10px] text-zinc-400 font-medium leading-none">Início</span>
                  <span className="text-xs font-bold text-zinc-900 dark:text-white mt-1">
                    {activeVisit?.opened_at
                      ? new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(
                          new Date(activeVisit.opened_at)
                        )
                      : '--:--'}
                  </span>
                </div>
              </div>

              <div className="bg-[#FAF4EE]/70 dark:bg-zinc-800/60 rounded-2xl p-2.5 flex items-center gap-2">
                <svg
                  className="w-4 h-4 text-zinc-500 dark:text-zinc-400 shrink-0"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
                <div className="flex flex-col min-w-0">
                  <span className="text-[10px] text-zinc-400 font-medium leading-none">Ocupação</span>
                  <span className="text-xs font-bold text-zinc-900 dark:text-white mt-1">
                    4 pessoas
                  </span>
                </div>
              </div>

              <div className="bg-[#FAF4EE]/70 dark:bg-zinc-800/60 rounded-2xl p-2.5 flex items-center gap-2">
                <svg
                  className="w-4 h-4 text-zinc-500 dark:text-zinc-400 shrink-0"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M5 22h14" />
                  <path d="M5 2h14" />
                  <path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22" />
                  <path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2" />
                </svg>
                <div className="flex flex-col min-w-0">
                  <span className="text-[10px] text-zinc-400 font-medium leading-none">Tempo</span>
                  <span className="text-xs font-bold text-zinc-900 dark:text-white mt-1">
                    {formatMinutes(activeVisit?.opened_at) || '1h 24min'}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Barra de Abas Superiores (Tabs da Mesa) */}
          <div className="flex items-center justify-around border-b border-amber-900/10 dark:border-zinc-800 pt-1">
            <button
              type="button"
              onClick={() => setTableActiveTab('access')}
              className={`pb-2.5 text-xs font-bold transition-all cursor-pointer ${
                tableActiveTab === 'access'
                  ? 'text-[#4A1505] dark:text-amber-300 border-b-2 border-[#4A1505]'
                  : 'text-zinc-400 dark:text-zinc-500 hover:text-zinc-600'
              }`}
            >
              Acesso da mesa
            </button>
            <button
              type="button"
              onClick={() => setTableActiveTab('tab')}
              className={`pb-2.5 text-xs font-bold transition-all cursor-pointer ${
                tableActiveTab === 'tab'
                  ? 'text-[#4A1505] dark:text-amber-300 border-b-2 border-[#4A1505]'
                  : 'text-zinc-400 dark:text-zinc-500 hover:text-zinc-600'
              }`}
            >
              Comanda
            </button>
            <button
              type="button"
              onClick={() => setTableActiveTab('details')}
              className={`pb-2.5 text-xs font-bold transition-all cursor-pointer ${
                tableActiveTab === 'details'
                  ? 'text-[#4A1505] dark:text-amber-300 border-b-2 border-[#4A1505]'
                  : 'text-zinc-400 dark:text-zinc-500 hover:text-zinc-600'
              }`}
            >
              Detalhes
            </button>
          </div>

          {/* Conteúdo da Aba Ativa */}
          <div className="space-y-4 pt-1">
            {/* Mesa em atendimento por outro garçom */}
            {isOtherStaffVisit && access.role !== 'admin' && (
              <div className="rounded-3xl border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/30 p-4 shadow-xs">
                <div className="flex items-center gap-2 text-amber-800 dark:text-amber-300 font-bold text-xs mb-1">
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                    <line x1="12" y1="9" x2="12" y2="13" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                  Mesa em atendimento por outro membro da equipe
                </div>
                <p className="text-xs text-amber-700 dark:text-amber-200 leading-relaxed">
                  Apenas o garçom responsável pode administrar comandas ou encerrar o atendimento.
                </p>
              </div>
            )}

            {/* ABA 1: ACESSO DA MESA */}
            {tableActiveTab === 'access' && (
              <GuestConfirmationForm
                restaurantSlug={restaurant.slug}
                tableNumber={activeVisit.table.table_number}
                onConfirmed={() => {
                  setTableLocallyAuthorized(
                    restaurant.id,
                    activeVisit.table.table_number,
                    activeVisit.id
                  );
                  setTableActiveTab('tab');
                  setShowConfirmedToast(true);
                }}
              />
            )}

            {/* ABA 2: COMANDA (CRIAÇÃO, CONSUMO DAS COMANDAS E CATÁLOGO) */}
            {tableActiveTab === 'tab' && (
              <TableTabsPanel
                restaurantSlug={restaurant.slug}
                restaurantId={restaurant.id}
                tableVisitId={activeVisit.id}
                tableNumber={activeVisit.table.table_number}
                role={access.role}
                onOpenTabsCountChange={setOpenTabsCount}
                showSuccessToast={showConfirmedToast}
                onCloseSuccessToast={() => setShowConfirmedToast(false)}
                initialTabId={restoredTabId}
                onTabSelected={(tabId) => {
                  setRestoredTabId(tabId);
                  updateOperationalTab(restaurant.id, tabId);
                }}
                initialSearchQuery={restoredSearch}
                onSearchQueryChange={(query) => {
                  setRestoredSearch(query);
                  updateOperationalSearch(restaurant.id, query);
                }}
              />
            )}

            {/* ABA 3: DETALHES (GESTÃO E ENCERRAMENTO DA MESA) */}
            {tableActiveTab === 'details' && (
              <TableDetailsTabPanel
                restaurantSlug={restaurant.slug}
                restaurantId={restaurant.id}
                tableVisit={activeVisit}
                tableNumber={activeVisit.table.table_number}
                tableItem={activeTable || undefined}
                freeTables={allTables
                  .filter(
                    (t) =>
                      t.table_number !== activeVisit.table.table_number &&
                      !occupiedVisits.some((v) => v.table.table_number === t.table_number)
                  )
                  .map((t) => ({
                    id: t.id,
                    table_number: t.table_number,
                    label: t.label,
                  }))}
                onCloseVisitSuccess={() => {
                  clearOperationalContext(restaurant.id);
                  setActiveVisit(null);
                  setActiveContext(null);
                  void loadDataAndResolveContext();
                }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

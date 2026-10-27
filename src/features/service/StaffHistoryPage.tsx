import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router';
import type { StaffAccess } from '../auth/staffAuth';
import { useRestaurant } from '../restaurants/RestaurantProvider';
import { ComandasPage } from './ComandasPage';
import {
  fetchStaffHistoryData,
  filterHistoryRecords,
  calculateHistorySummary,
  exportHistoryToCsv,
  formatHistoryDuration,
  formatTimeOfDay,
  formatDate,
  type StaffHistoryRecord,
  type HistoryPeriod,
  type HistoryCategoryFilter,
} from './staffHistory';

export function StaffHistoryPage() {
  const { restaurantSlug = '' } = useParams<{ restaurantSlug: string }>();
  const access = useOutletContext<StaffAccess>();
  const { restaurant } = useRestaurant();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const abaParam = searchParams.get('aba');
  const [activeSubTab, setActiveSubTab] = useState<'atendimentos' | 'comandas'>(
    abaParam === 'comandas' ? 'comandas' : 'atendimentos'
  );

  useEffect(() => {
    if (abaParam === 'comandas') {
      setActiveSubTab('comandas');
    } else if (abaParam === 'atendimentos') {
      setActiveSubTab('atendimentos');
    }
  }, [abaParam]);

  const timezone = restaurant?.timezone || 'America/Sao_Paulo';

  // Estados de dados
  const [allRecords, setAllRecords] = useState<StaffHistoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filtros
  const [period, setPeriod] = useState<HistoryPeriod>('hoje');
  const [customDate, setCustomDate] = useState<string | null>(null);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<HistoryCategoryFilter>('todos');
  const [searchQuery, setSearchQuery] = useState('');

  // Paginação ("Carregar mais")
  const [visibleCount, setVisibleCount] = useState(10);

  // Accordion (card expandido)
  const [expandedCardId, setExpandedCardId] = useState<string | null>(null);

  // Modal de Resumo (somente leitura por UUID)
  const [modalRecord, setModalRecord] = useState<StaffHistoryRecord | null>(null);
  const [copiedUuid, setCopiedUuid] = useState(false);

  // Toast feedback
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Carregar dados de histórico
  const loadHistory = useCallback(async () => {
    if (!access?.restaurantId) return;

    setLoading(true);
    setError(null);

    try {
      const data = await fetchStaffHistoryData(
        access.restaurantId,
        access.memberId,
        access.role,
        timezone,
        period,
        customDate
      );
      setAllRecords(data);
      setVisibleCount(10);
      setExpandedCardId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao carregar histórico de atendimentos.');
    } finally {
      setLoading(false);
    }
  }, [access?.restaurantId, access?.memberId, access?.role, timezone, period, customDate]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  // Filtragem dos registros pelo texto e categoria
  const filteredRecords = useMemo(() => {
    return filterHistoryRecords(allRecords, searchQuery, categoryFilter);
  }, [allRecords, searchQuery, categoryFilter]);

  // Resumo consolidado de KPIs (calculado sobre todo o conjunto filtrado do período, sem duplicar receita)
  const summary = useMemo(() => {
    return calculateHistorySummary(filteredRecords);
  }, [filteredRecords]);

  // Registros visíveis com "Carregar mais"
  const visibleRecords = useMemo(() => {
    return filteredRecords.slice(0, visibleCount);
  }, [filteredRecords, visibleCount]);

  const hasMore = visibleCount < filteredRecords.length;

  // Ação de exportar CSV
  const handleExportCsv = useCallback(() => {
    if (filteredRecords.length === 0) {
      setToastMessage('Nenhum atendimento disponível para exportação.');
      setTimeout(() => setToastMessage(null), 3000);
      return;
    }

    try {
      const csvContent = exportHistoryToCsv(filteredRecords, timezone);
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      const fileDate = customDate || new Date().toISOString().slice(0, 10);
      link.setAttribute('download', `historico_atendimentos_${period}_${fileDate}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      setToastMessage('Relatório CSV exportado com sucesso!');
      setTimeout(() => setToastMessage(null), 3000);
    } catch {
      setToastMessage('Falha ao gerar o arquivo de exportação.');
      setTimeout(() => setToastMessage(null), 3000);
    }
  }, [filteredRecords, timezone, period, customDate]);

  // Copiar UUID no modal de resumo
  const handleCopyUuid = useCallback((uuid: string) => {
    if (navigator.clipboard) {
      void navigator.clipboard.writeText(uuid);
      setCopiedUuid(true);
      setTimeout(() => setCopiedUuid(false), 2000);
    }
  }, []);

  const formatBrl = (cents: number) => {
    return (cents / 100).toLocaleString('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    });
  };

  // Rótulo da data selecionada
  const dateLabel = useMemo(() => {
    if (period === 'hoje') {
      const todayStr = new Intl.DateTimeFormat('pt-BR', {
        timeZone: timezone,
        day: '2-digit',
        month: '2-digit',
      }).format(new Date());
      return `Hoje • ${todayStr}`;
    }
    if (period === '7dias') {
      return 'Últimos 7 dias';
    }
    if (period === '30dias') {
      return 'Últimos 30 dias';
    }
    if (period === 'custom' && customDate) {
      const [y, m, d] = customDate.split('-');
      return `${d}/${m}/${y}`;
    }
    return 'Selecionar data';
  }, [period, customDate, timezone]);

  return (
    <div className="w-full space-y-4 pb-12 animate-in fade-in duration-200">
      {/* Toast informativo */}
      {toastMessage && (
        <div
          role="status"
          className="fixed top-4 left-1/2 -translate-x-1/2 z-50 max-w-sm w-[90%] bg-zinc-900 text-white text-xs font-semibold py-2.5 px-4 rounded-2xl shadow-xl border border-zinc-700/60 flex items-center justify-between animate-in fade-in duration-150"
        >
          <span>{toastMessage}</span>
          <button
            type="button"
            onClick={() => setToastMessage(null)}
            className="ml-2 text-zinc-400 hover:text-white p-1"
            aria-label="Fechar aviso"
          >
            ✕
          </button>
        </div>
      )}

      {/* Botão discreto de voltar para Mais */}
      <div>
        <button
          type="button"
          onClick={() => navigate(`/${restaurantSlug}/equipe/mais`)}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-stone-600 dark:text-zinc-400 hover:text-stone-900 dark:hover:text-zinc-100 transition-colors cursor-pointer py-1 group"
        >
          <svg
            className="w-4 h-4 transform group-hover:-translate-x-0.5 transition-transform"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
          <span>Voltar para Mais</span>
        </button>
      </div>

      {/* Título e Subtítulo */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
          {activeSubTab === 'atendimentos' ? 'Histórico de Atendimentos' : 'Listagem de Comandas'}
        </h1>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
          {activeSubTab === 'atendimentos'
            ? 'Revise atendimentos concluídos e movimentações do turno.'
            : 'Consulte, filtre por status e imprima comandas em atendimento e finalizadas.'}
        </p>
      </div>

      {/* Sub-abas do Histórico: Atendimentos vs Comandas */}
      <div className="flex items-center gap-1.5 p-1 bg-stone-200/60 dark:bg-zinc-800/80 rounded-2xl">
        <button
          type="button"
          onClick={() => {
            setActiveSubTab('atendimentos');
            setSearchParams({ aba: 'atendimentos' });
          }}
          className={`flex-1 py-2 px-3 text-xs font-bold rounded-xl transition-all cursor-pointer ${
            activeSubTab === 'atendimentos'
              ? 'bg-white dark:bg-zinc-900 text-[#4A1505] dark:text-amber-300 shadow-xs'
              : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
          }`}
        >
          Histórico de Atendimentos
        </button>
        <button
          type="button"
          onClick={() => {
            setActiveSubTab('comandas');
            setSearchParams({ aba: 'comandas' });
          }}
          className={`flex-1 py-2 px-3 text-xs font-bold rounded-xl transition-all cursor-pointer ${
            activeSubTab === 'comandas'
              ? 'bg-white dark:bg-zinc-900 text-[#4A1505] dark:text-amber-300 shadow-xs'
              : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
          }`}
        >
          Listagem de Comandas
        </button>
      </div>

      {/* Exibição da Listagem de Comandas */}
      {activeSubTab === 'comandas' && (
        <div className="pt-2">
          <ComandasPage />
        </div>
      )}

      {/* Exibição do Histórico de Atendimentos */}
      {activeSubTab === 'atendimentos' && (
        <>
          {/* Card de Resumo de KPIs */}
          <div className="rounded-3xl bg-white dark:bg-zinc-900 border border-stone-200/80 dark:border-zinc-800 p-4 shadow-sm flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4">
        <div className="grid grid-cols-3 gap-2 sm:gap-4 flex-1">
          {/* Métrica 1: Atendimentos */}
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-full bg-[#FAF3ED] dark:bg-zinc-800 text-[#8A3A1B] dark:text-amber-400 flex items-center justify-center shrink-0">
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M4 18v3" />
                <path d="M20 18v3" />
                <path d="M19 18H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2z" />
                <path d="M7 7V4a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v3" />
              </svg>
            </div>
            <div className="min-w-0">
              <strong className="block text-base sm:text-lg font-bold text-zinc-900 dark:text-zinc-100 leading-tight">
                {loading || error ? '—' : summary.totalAttendances}
              </strong>
              <span className="block text-[11px] text-zinc-500 dark:text-zinc-400 truncate">
                {categoryFilter === 'mesas'
                  ? `${summary.totalVisits} ${summary.totalVisits === 1 ? 'mesa' : 'mesas'}`
                  : categoryFilter === 'contas'
                  ? `${summary.totalTabs} ${summary.totalTabs === 1 ? 'conta' : 'contas'}`
                  : categoryFilter === 'encerramentos'
                  ? `${summary.totalEncerramentos} ${summary.totalEncerramentos === 1 ? 'encerramento' : 'encerramentos'}`
                  : `${summary.totalVisits} ${summary.totalVisits === 1 ? 'mesa' : 'mesas'} • ${summary.totalTabs} ${summary.totalTabs === 1 ? 'conta' : 'contas'}`}
              </span>
            </div>
          </div>

          {/* Métrica 2: Ticket Médio */}
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-full bg-[#FAF3ED] dark:bg-zinc-800 text-[#8A3A1B] dark:text-amber-400 flex items-center justify-center shrink-0">
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" />
                <path d="M12 6v2" />
                <path d="M12 16v2" />
              </svg>
            </div>
            <div className="min-w-0">
              <strong className="block text-base sm:text-lg font-bold text-zinc-900 dark:text-zinc-100 leading-tight">
                {loading || error ? '—' : formatBrl(summary.ticketMedioInCents)}
              </strong>
              <span className="block text-[11px] text-zinc-500 dark:text-zinc-400 truncate">
                ticket médio
              </span>
            </div>
          </div>

          {/* Métrica 3: Tempo Médio */}
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-full bg-[#FAF3ED] dark:bg-zinc-800 text-[#8A3A1B] dark:text-amber-400 flex items-center justify-center shrink-0">
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
            </div>
            <div className="min-w-0">
              <strong className="block text-base sm:text-lg font-bold text-zinc-900 dark:text-zinc-100 leading-tight">
                {loading || error ? '—' : formatHistoryDuration(summary.tempoMedioMinutes)}
              </strong>
              <span className="block text-[11px] text-zinc-500 dark:text-zinc-400 truncate">
                tempo médio
              </span>
            </div>
          </div>
        </div>

        {/* Botão Exportar */}
        <div className="shrink-0 flex items-center justify-end border-t sm:border-t-0 sm:border-l border-stone-200 dark:border-zinc-800 pt-3 sm:pt-0 sm:pl-4">
          <button
            type="button"
            onClick={handleExportCsv}
            disabled={loading || filteredRecords.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-stone-300 dark:border-zinc-700 hover:bg-stone-50 dark:hover:bg-zinc-800 text-xs font-bold text-zinc-800 dark:text-zinc-200 transition-all cursor-pointer shadow-xs disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <svg
              className="w-3.5 h-3.5 text-[#8A3A1B] dark:text-amber-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <span>Exportar</span>
          </button>
        </div>
      </div>

      {/* Barra de Busca e Seleção de Data */}
      <div className="space-y-2.5">
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
          {/* Campo de Busca */}
          <div className="relative flex-1">
            <svg
              className="w-4 h-4 text-zinc-400 absolute left-3.5 top-1/2 -translate-y-1/2"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Buscar mesa, comanda ou cliente..."
              className="w-full pl-9.5 pr-8 py-2.5 rounded-2xl border border-stone-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-xs font-semibold text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-[#8A3A1B]/30 focus:border-[#8A3A1B] shadow-xs"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 p-1"
                aria-label="Limpar busca"
              >
                ✕
              </button>
            )}
          </div>

          {/* Dropdown Seletor de Data */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowDatePicker((curr) => !curr)}
              className="w-full sm:w-auto inline-flex items-center justify-between gap-2 px-3.5 py-2.5 rounded-2xl border border-stone-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-xs font-semibold text-zinc-800 dark:text-zinc-200 shadow-xs cursor-pointer hover:bg-stone-50 dark:hover:bg-zinc-800 transition-colors"
            >
              <div className="inline-flex items-center gap-1.5">
                <svg
                  className="w-4 h-4 text-zinc-500"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect width="18" height="18" x="3" y="4" rx="2" ry="2" />
                  <line x1="16" y1="2" x2="16" y2="6" />
                  <line x1="8" y1="2" x2="8" y2="6" />
                  <line x1="3" y1="10" x2="21" y2="10" />
                </svg>
                <span>{dateLabel}</span>
              </div>
              <svg
                className="w-3.5 h-3.5 text-zinc-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>

            {/* Menu Dropdown de Seleção de Data */}
            {showDatePicker && (
              <div className="absolute right-0 top-full mt-1.5 z-30 w-64 rounded-2xl bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 shadow-xl p-3 space-y-2 animate-in fade-in duration-100">
                <label
                  htmlFor="history-custom-date"
                  className="block text-[11px] font-bold text-zinc-700 dark:text-zinc-300"
                >
                  Escolher dia específico:
                </label>
                <input
                  id="history-custom-date"
                  type="date"
                  value={customDate || new Date().toISOString().slice(0, 10)}
                  onChange={(e) => {
                    setCustomDate(e.target.value);
                    setPeriod('custom');
                    setShowDatePicker(false);
                  }}
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 dark:border-zinc-700 text-xs bg-stone-50 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => {
                    setCustomDate(null);
                    setPeriod('hoje');
                    setShowDatePicker(false);
                  }}
                  className="w-full text-center text-xs font-bold text-[#7C2D12] dark:text-amber-400 hover:underline py-1"
                >
                  Redefinir para hoje
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Atalhos Rápidos de Período */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setPeriod('hoje');
              setCustomDate(null);
            }}
            className={`px-4 py-1.5 rounded-full text-xs font-bold transition-all cursor-pointer shadow-2xs ${
              period === 'hoje'
                ? 'bg-[#7C2D12] text-white shadow-xs'
                : 'bg-stone-100 dark:bg-zinc-800 text-stone-700 dark:text-zinc-300 hover:bg-stone-200 dark:hover:bg-zinc-700'
            }`}
          >
            Hoje
          </button>
          <button
            type="button"
            onClick={() => {
              setPeriod('7dias');
              setCustomDate(null);
            }}
            className={`px-4 py-1.5 rounded-full text-xs font-bold transition-all cursor-pointer shadow-2xs ${
              period === '7dias'
                ? 'bg-[#7C2D12] text-white shadow-xs'
                : 'bg-stone-100 dark:bg-zinc-800 text-stone-700 dark:text-zinc-300 hover:bg-stone-200 dark:hover:bg-zinc-700'
            }`}
          >
            7 dias
          </button>
          <button
            type="button"
            onClick={() => {
              setPeriod('30dias');
              setCustomDate(null);
            }}
            className={`px-4 py-1.5 rounded-full text-xs font-bold transition-all cursor-pointer shadow-2xs ${
              period === '30dias'
                ? 'bg-[#7C2D12] text-white shadow-xs'
                : 'bg-stone-100 dark:bg-zinc-800 text-stone-700 dark:text-zinc-300 hover:bg-stone-200 dark:hover:bg-zinc-700'
            }`}
          >
            30 dias
          </button>
        </div>

        {/* Filtros de Categoria */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
          {/* Todos */}
          <button
            type="button"
            onClick={() => setCategoryFilter('todos')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer whitespace-nowrap shadow-2xs ${
              categoryFilter === 'todos'
                ? 'bg-[#7C2D12] text-white shadow-xs'
                : 'bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-stone-50 dark:hover:bg-zinc-800'
            }`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
              <line x1="8" y1="6" x2="21" y2="6" />
              <line x1="8" y1="12" x2="21" y2="12" />
              <line x1="8" y1="18" x2="21" y2="18" />
              <line x1="3" y1="6" x2="3.01" y2="6" />
              <line x1="3" y1="12" x2="3.01" y2="12" />
              <line x1="3" y1="18" x2="3.01" y2="18" />
            </svg>
            <span>Todos</span>
          </button>

          {/* Mesas */}
          <button
            type="button"
            onClick={() => setCategoryFilter('mesas')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer whitespace-nowrap shadow-2xs ${
              categoryFilter === 'mesas'
                ? 'bg-[#7C2D12] text-white shadow-xs'
                : 'bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-stone-50 dark:hover:bg-zinc-800'
            }`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
              <path d="M4 18v3" />
              <path d="M20 18v3" />
              <path d="M19 18H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2z" />
            </svg>
            <span>Mesas</span>
          </button>

          {/* Contas */}
          <button
            type="button"
            onClick={() => setCategoryFilter('contas')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer whitespace-nowrap shadow-2xs ${
              categoryFilter === 'contas'
                ? 'bg-[#7C2D12] text-white shadow-xs'
                : 'bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-stone-50 dark:hover:bg-zinc-800'
            }`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
            </svg>
            <span>Contas</span>
          </button>

          {/* Encerramentos */}
          <button
            type="button"
            onClick={() => setCategoryFilter('encerramentos')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer whitespace-nowrap shadow-2xs ${
              categoryFilter === 'encerramentos'
                ? 'bg-[#7C2D12] text-white shadow-xs'
                : 'bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-stone-50 dark:hover:bg-zinc-800'
            }`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
            <span>Encerramentos</span>
          </button>
        </div>

        {/* Banner Informativo quando o filtro Encerramentos estiver selecionado */}
        {categoryFilter === 'encerramentos' && (
          <div className="p-3 rounded-2xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200/80 dark:border-amber-800/80 text-amber-900 dark:text-amber-200 text-xs flex items-start gap-2.5 animate-in fade-in duration-150">
            <svg className="w-4 h-4 shrink-0 text-amber-700 dark:text-amber-400 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <div className="space-y-0.5">
              <strong className="block font-bold">Encerramentos de Atendimento (Mesas Concluídas)</strong>
              <p className="text-[11px] text-amber-800 dark:text-amber-300 leading-relaxed">
                Este filtro exibe o encerramento definitivo de visitas de mesas no salão. Relatórios de fechamento de caixa ou encerramento fiscal de turno não estão disponíveis nesta versão do sistema.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Estados de Carregamento, Erro ou Lista */}
      {loading ? (
        <div className="py-12 text-center space-y-3">
          <div className="w-8 h-8 border-3 border-[#7C2D12] border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-xs text-zinc-500 font-medium">Carregando histórico de atendimentos...</p>
        </div>
      ) : error ? (
        <div className="rounded-2xl border border-red-200 dark:border-red-900/60 bg-red-50/50 dark:bg-red-950/20 p-5 text-center space-y-3">
          <p className="text-xs font-semibold text-red-700 dark:text-red-300">{error}</p>
          <button
            type="button"
            onClick={() => void loadHistory()}
            className="px-4 py-2 rounded-xl bg-red-600 text-white text-xs font-bold hover:bg-red-700 transition-all cursor-pointer"
          >
            Tentar novamente
          </button>
        </div>
      ) : filteredRecords.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-stone-300 dark:border-zinc-800 p-8 text-center space-y-2 bg-white/50 dark:bg-zinc-900/50">
          <div className="w-12 h-12 rounded-full bg-stone-100 dark:bg-zinc-800 text-stone-400 mx-auto flex items-center justify-center">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="8" y1="12" x2="16" y2="12" />
            </svg>
          </div>
          <p className="text-sm font-bold text-zinc-800 dark:text-zinc-200">
            Nenhum atendimento encontrado
          </p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 max-w-xs mx-auto">
            Não há registros de atendimentos finalizados para os filtros e período selecionados.
          </p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {visibleRecords.map((record) => {
            const isExpanded = expandedCardId === record.id;
            const timeIn = formatTimeOfDay(record.openedAt, timezone);
            const timeOut = formatTimeOfDay(record.closedAt, timezone);
            const durationLabel = formatHistoryDuration(record.durationMinutes);
            const formattedTotal = formatBrl(record.totalInCents);

            return (
              <div
                key={record.id}
                className="rounded-2xl bg-white dark:bg-zinc-900 border border-stone-200/80 dark:border-zinc-800 shadow-sm transition-all overflow-hidden"
              >
                {/* Linha Principal do Card (Cabeçalho Recolhível) */}
                <button
                  type="button"
                  onClick={() => setExpandedCardId(isExpanded ? null : record.id)}
                  className="w-full p-3.5 flex items-center justify-between gap-3 text-left hover:bg-stone-50/60 dark:hover:bg-zinc-800/40 transition-colors cursor-pointer"
                  aria-expanded={isExpanded}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {/* Ícone Mesa */}
                    <div className="w-10 h-10 rounded-full bg-[#FAF3ED] dark:bg-zinc-800 text-[#8A3A1B] dark:text-amber-400 flex items-center justify-center shrink-0">
                      <svg
                        className="w-5 h-5"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M4 18v3" />
                        <path d="M20 18v3" />
                        <path d="M19 18H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2z" />
                      </svg>
                    </div>

                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-sm text-zinc-900 dark:text-zinc-100">
                          {record.tableNumber !== null ? `Mesa ${String(record.tableNumber).padStart(2, '0')}` : 'Mesa Indisponível'}
                        </span>
                        <span className="bg-stone-800 dark:bg-stone-700 text-stone-100 text-[10px] font-bold px-2 py-0.5 rounded-full">
                          Encerrado
                        </span>
                      </div>
                      <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate mt-0.5">
                        {record.tabLabel} • {record.tableLabel || 'Indisponível'}
                      </p>
                    </div>
                  </div>

                  {/* Lado Direito: Horários (se recolhido) + Valor + Chevron */}
                  <div className="flex items-center gap-3 shrink-0">
                    {!isExpanded && (
                      <div className="hidden sm:block text-right">
                        <div className="inline-flex items-center gap-1 text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                          <svg className="w-3.5 h-3.5 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                            <circle cx="12" cy="12" r="10" />
                            <polyline points="12 6 12 12 16 14" />
                          </svg>
                          <span>{durationLabel}</span>
                        </div>
                        <span className="block text-[11px] text-zinc-400 dark:text-zinc-500">
                          {timeIn} – {timeOut}
                        </span>
                      </div>
                    )}

                    <strong className="text-sm sm:text-base font-bold text-zinc-900 dark:text-zinc-100">
                      {formattedTotal}
                    </strong>

                    <div className="text-zinc-400">
                      <svg
                        className={`w-4 h-4 transform transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </div>
                  </div>
                </button>

                {/* Conteúdo Expandido */}
                {isExpanded && (
                  <div className="px-3.5 pb-3.5 pt-1 border-t border-stone-100 dark:border-zinc-800/80 space-y-3 animate-in fade-in duration-150">
                    {/* Faixa destacada de tempos */}
                    <div className="bg-[#FAF4EE] dark:bg-zinc-800/60 p-3 rounded-xl border border-amber-900/5 dark:border-zinc-700/40 flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <svg className="w-4 h-4 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                          <circle cx="12" cy="12" r="10" />
                          <polyline points="12 6 12 12 16 14" />
                        </svg>
                        <div>
                          <span className="block text-[10px] uppercase font-bold text-zinc-400">Entrada</span>
                          <span className="font-bold text-zinc-800 dark:text-zinc-200">{timeIn}</span>
                        </div>
                      </div>

                      <svg className="w-4 h-4 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                        <line x1="5" y1="12" x2="19" y2="12" />
                        <polyline points="12 5 19 12 12 19" />
                      </svg>

                      <div>
                        <span className="block text-[10px] uppercase font-bold text-zinc-400">Saída</span>
                        <span className="font-bold text-zinc-800 dark:text-zinc-200">{timeOut}</span>
                      </div>

                      <div className="border-l border-stone-300 dark:border-zinc-700 pl-3">
                        <span className="block text-[10px] uppercase font-bold text-zinc-400">Duração</span>
                        <span className="font-bold text-zinc-800 dark:text-zinc-200">{durationLabel}</span>
                      </div>
                    </div>

                    {/* Linha de Tags e Botão "Abrir resumo" */}
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                      <div className="flex flex-wrap items-center gap-1.5 text-xs">
                        {/* Qtd itens */}
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-stone-100 dark:bg-zinc-800 text-stone-700 dark:text-zinc-300 font-semibold">
                          <svg className="w-3.5 h-3.5 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                            <path d="M18 2v20" />
                            <path d="M6 2v20" />
                            <path d="M2 7h20" />
                          </svg>
                          <span>{record.itemsCount} itens</span>
                        </span>

                        {/* Acessos confirmados */}
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300 border border-emerald-200/50 dark:border-emerald-800/50 font-semibold">
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                            <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
                            <circle cx="12" cy="7" r="4" />
                          </svg>
                          <span>
                            {record.confirmedGuestsCount !== null
                              ? `${record.confirmedGuestsCount} ${record.confirmedGuestsCount === 1 ? 'acesso confirmado' : 'acessos confirmados'}`
                              : 'Acessos indisponíveis'}
                          </span>
                        </span>

                        {/* Taxa de serviço snapshot */}
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-stone-100 dark:bg-zinc-800 text-stone-700 dark:text-zinc-300 font-semibold">
                          <svg className="w-3.5 h-3.5 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                            <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
                            <line x1="7" y1="7" x2="7.01" y2="7" />
                          </svg>
                          <span>
                            {record.serviceFeeAccepted && (record.serviceFeePercent || 0) > 0
                              ? `Taxa ${record.serviceFeePercent}%`
                              : 'Sem taxa'}
                          </span>
                        </span>
                      </div>

                      {/* Botão Abrir Resumo */}
                      <button
                        type="button"
                        onClick={() => setModalRecord(record)}
                        className="inline-flex items-center gap-1 px-3.5 py-1.5 rounded-xl bg-[#7C2D12] hover:bg-[#6A260F] text-white text-xs font-bold transition-all cursor-pointer shadow-xs active:scale-95 ml-auto"
                      >
                        <span>Abrir resumo</span>
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                          <polyline points="9 18 15 12 9 6" />
                        </svg>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {/* Botão "Carregar mais atendimentos" */}
          {hasMore ? (
            <div className="pt-2">
              <button
                type="button"
                onClick={() => setVisibleCount((prev) => prev + 10)}
                className="w-full py-3 rounded-2xl border border-stone-300 dark:border-zinc-700 text-stone-800 dark:text-zinc-200 hover:bg-stone-100 dark:hover:bg-zinc-800 text-xs font-bold transition-all flex items-center justify-center gap-2 cursor-pointer shadow-xs active:scale-[0.99]"
              >
                <svg className="w-4 h-4 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                  <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                </svg>
                <span>Carregar mais atendimentos</span>
              </button>
            </div>
          ) : (
            <p className="text-center text-[11px] text-zinc-400 dark:text-zinc-500 pt-3">
              Todos os atendimentos do período foram exibidos.
            </p>
          )}
        </div>
      )}

      {/* Modal Resumo do Atendimento (Somente Leitura por UUID) */}
      {modalRecord && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="summary-modal-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in duration-150"
        >
          <div className="w-full max-w-md rounded-3xl bg-white dark:bg-zinc-900 p-5 shadow-2xl border border-stone-200 dark:border-zinc-800 space-y-4 max-h-[90vh] overflow-y-auto animate-in zoom-in-95 duration-150">
            {/* Cabeçalho do Modal */}
            <div className="flex items-start justify-between gap-3 border-b border-stone-100 dark:border-zinc-800 pb-3">
              <div>
                <h3 id="summary-modal-title" className="text-base font-bold text-zinc-900 dark:text-zinc-100">
                  Resumo do Atendimento
                </h3>
                <div className="flex items-center gap-1.5 mt-1">
                  <span className="text-[11px] font-mono text-zinc-500 dark:text-zinc-400 truncate max-w-[200px]">
                    UUID: {modalRecord.id}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleCopyUuid(modalRecord.id)}
                    className="text-[10px] text-[#7C2D12] dark:text-amber-400 font-bold hover:underline cursor-pointer"
                  >
                    {copiedUuid ? 'Copiado!' : 'Copiar'}
                  </button>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setModalRecord(null)}
                className="w-8 h-8 rounded-full bg-stone-100 dark:bg-zinc-800 text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 flex items-center justify-center cursor-pointer transition-colors"
                aria-label="Fechar resumo"
              >
                ✕
              </button>
            </div>

            {/* Informações Gerais do Atendimento */}
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="bg-stone-50 dark:bg-zinc-800/60 p-2.5 rounded-xl">
                <span className="block text-[10px] uppercase font-bold text-zinc-400">Mesa</span>
                <strong className="text-zinc-800 dark:text-zinc-200 text-sm">
                  {modalRecord.tableNumber !== null ? `Mesa ${String(modalRecord.tableNumber).padStart(2, '0')}` : 'Mesa Indisponível'} ({modalRecord.tableLabel || 'Ambiente indisponível'})
                </strong>
              </div>

              <div className="bg-stone-50 dark:bg-zinc-800/60 p-2.5 rounded-xl">
                <span className="block text-[10px] uppercase font-bold text-zinc-400">Comanda</span>
                <strong className="text-zinc-800 dark:text-zinc-200 text-sm truncate block">
                  {modalRecord.tabLabel}
                </strong>
              </div>

              <div className="bg-stone-50 dark:bg-zinc-800/60 p-2.5 rounded-xl">
                <span className="block text-[10px] uppercase font-bold text-zinc-400">Data</span>
                <span className="font-semibold text-zinc-800 dark:text-zinc-200">
                  {formatDate(modalRecord.closedAt || modalRecord.openedAt, timezone)}
                </span>
              </div>

              <div className="bg-stone-50 dark:bg-zinc-800/60 p-2.5 rounded-xl">
                <span className="block text-[10px] uppercase font-bold text-zinc-400">Horário e Duração</span>
                <span className="font-semibold text-zinc-800 dark:text-zinc-200">
                  {formatTimeOfDay(modalRecord.openedAt, timezone)} – {formatTimeOfDay(modalRecord.closedAt, timezone)} ({formatHistoryDuration(modalRecord.durationMinutes)})
                </span>
              </div>
            </div>

            {/* Lista de Itens Consumidos */}
            <div className="space-y-2">
              <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-500">
                Itens Consumidos ({modalRecord.items.length})
              </h4>
              {modalRecord.items.length === 0 ? (
                <p className="text-xs text-zinc-400 italic">Sem itens detalhados registrados.</p>
              ) : (
                <div className="rounded-xl border border-stone-200 dark:border-zinc-800 divide-y divide-stone-100 dark:divide-zinc-800 max-h-48 overflow-y-auto">
                  {modalRecord.items.map((it) => (
                    <div key={it.id} className="p-2.5 flex items-center justify-between text-xs">
                      <div>
                        <span className="font-bold text-zinc-800 dark:text-zinc-200">
                          {it.quantity}x {it.product_name}
                        </span>
                        <span className="block text-[10px] text-zinc-400">
                          {formatBrl(it.unit_price_in_cents)} cada
                        </span>
                      </div>
                      <strong className="text-zinc-800 dark:text-zinc-200 font-semibold">
                        {formatBrl(it.line_total_in_cents)}
                      </strong>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Demonstrativo Contábil do Snapshot */}
            <div className="rounded-2xl bg-stone-50 dark:bg-zinc-800/80 p-3.5 space-y-2 border border-stone-200/60 dark:border-zinc-700/60 text-xs">
              <div className="flex items-center justify-between text-zinc-600 dark:text-zinc-400">
                <span>Subtotal dos itens</span>
                <span className="font-semibold text-zinc-800 dark:text-zinc-200">
                  {formatBrl(modalRecord.subtotalInCents)}
                </span>
              </div>

              <div className="flex items-center justify-between text-zinc-600 dark:text-zinc-400">
                <span>
                  Taxa de serviço ({modalRecord.serviceFeePercent ?? 0}%)
                  {!modalRecord.serviceFeeAccepted && ' (Recusada)'}
                </span>
                <span className="font-semibold text-zinc-800 dark:text-zinc-200">
                  {modalRecord.serviceFeeAccepted ? formatBrl(modalRecord.serviceFeeInCents) : 'R$ 0,00'}
                </span>
              </div>

              <div className="border-t border-stone-200 dark:border-zinc-700 pt-2 flex items-center justify-between text-sm font-bold text-zinc-900 dark:text-zinc-100">
                <span>Total Final</span>
                <span className="text-[#7C2D12] dark:text-amber-400 text-base">
                  {formatBrl(modalRecord.totalInCents)}
                </span>
              </div>
            </div>

            {/* Botão de Fechar */}
            <button
              type="button"
              onClick={() => setModalRecord(null)}
              className="w-full py-3 rounded-xl bg-stone-800 hover:bg-stone-900 text-white font-bold text-xs transition-all cursor-pointer shadow-xs"
            >
              Fechar Resumo
            </button>
          </div>
        </div>
      )}
        </>
      )}
    </div>
  );
}

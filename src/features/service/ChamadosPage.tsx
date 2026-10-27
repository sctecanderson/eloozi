import { useState, useEffect, useMemo } from 'react';
import { useStaffChamados } from './StaffChamadosContext';
import { formatElapsedTime, ChamadoCategory, ChamadoItem } from './staffChamados';

export function ChamadosPage() {
  const {
    chamados,
    summary,
    totalPendingCount,
    loading,
    error,
    busyActionId,
    refresh,
    deliverOrder,
    attendWaiter,
    attendBill,
  } = useStaffChamados();

  const [activeCategory, setActiveCategory] = useState<'all' | ChamadoCategory>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [now, setNow] = useState<number>(() => Date.now());

  // Atualiza os minutos decorridos a cada 10 segundos
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 10000);
    return () => clearInterval(timer);
  }, []);

  // Filtragem dos chamados por categoria e termo de busca
  const filteredChamados = useMemo(() => {
    return chamados.filter((item) => {
      // Filtro de categoria
      if (activeCategory !== 'all' && item.category !== activeCategory) {
        return false;
      }

      // Filtro de busca textual
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase().trim();
        const matchesTable = item.tableName.toLowerCase().includes(query) ||
          String(item.tableNumber).includes(query);
        const matchesProduct = item.productName?.toLowerCase().includes(query) ?? false;
        const matchesTab = item.tabLabel?.toLowerCase().includes(query) ?? false;
        const matchesSector = item.tableSector?.toLowerCase().includes(query) ?? false;
        const matchesDesc = item.description.toLowerCase().includes(query);

        return matchesTable || matchesProduct || matchesTab || matchesSector || matchesDesc;
      }

      return true;
    });
  }, [chamados, activeCategory, searchQuery]);

  return (
    <div className="w-full space-y-4 pb-28">
      {/* =========================================================
          CABEÇALHO DA SEÇÃO / CARDS DE RESUMO (MÉTRICAS DO TURNO)
         ========================================================= */}
      <div className="grid grid-cols-4 gap-2 pt-1">
        {/* Card 1: Chamados Garçom */}
        <button
          type="button"
          onClick={() => setActiveCategory((prev) => (prev === 'waiter_call' ? 'all' : 'waiter_call'))}
          className={`flex flex-col items-center justify-center p-2.5 rounded-2xl border transition-all cursor-pointer ${
            activeCategory === 'waiter_call'
              ? 'bg-[#FDF2F0] border-rose-400 ring-2 ring-rose-300 dark:bg-rose-950/40'
              : 'bg-[#FDF2F0]/80 dark:bg-rose-950/20 border-rose-200/60 dark:border-rose-900/30 hover:opacity-90'
          }`}
        >
          <div className="text-rose-600 dark:text-rose-400 mb-1">
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
          </div>
          <span className="text-base font-extrabold text-rose-950 dark:text-rose-100 leading-tight">
            {summary.waiterCallsCount}
          </span>
          <span className="text-[10px] font-semibold text-rose-700 dark:text-rose-300">
            Garçom
          </span>
        </button>

        {/* Card 2: Pedidos de Conta */}
        <button
          type="button"
          onClick={() => setActiveCategory((prev) => (prev === 'bill_request' ? 'all' : 'bill_request'))}
          className={`flex flex-col items-center justify-center p-2.5 rounded-2xl border transition-all cursor-pointer ${
            activeCategory === 'bill_request'
              ? 'bg-[#FFF9EB] border-amber-400 ring-2 ring-amber-300 dark:bg-amber-950/40'
              : 'bg-[#FFF9EB]/80 dark:bg-amber-950/20 border-amber-200/60 dark:border-amber-900/30 hover:opacity-90'
          }`}
        >
          <div className="text-amber-600 dark:text-amber-400 mb-1">
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
            </svg>
          </div>
          <span className="text-base font-extrabold text-amber-950 dark:text-amber-100 leading-tight">
            {summary.billRequestsCount}
          </span>
          <span className="text-[10px] font-semibold text-amber-700 dark:text-amber-300">
            Contas
          </span>
        </button>

        {/* Card 3: Pedidos Prontos */}
        <button
          type="button"
          onClick={() => setActiveCategory((prev) => (prev === 'ready_order' ? 'all' : 'ready_order'))}
          className={`flex flex-col items-center justify-center p-2.5 rounded-2xl border transition-all cursor-pointer ${
            activeCategory === 'ready_order'
              ? 'bg-[#F0FDF4] border-emerald-400 ring-2 ring-emerald-300 dark:bg-emerald-950/40'
              : 'bg-[#F0FDF4]/80 dark:bg-emerald-950/20 border-emerald-200/60 dark:border-emerald-900/30 hover:opacity-90'
          }`}
        >
          <div className="text-emerald-600 dark:text-emerald-400 mb-1">
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
          </div>
          <span className="text-base font-extrabold text-emerald-950 dark:text-emerald-100 leading-tight">
            {summary.readyOrdersCount}
          </span>
          <span className="text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
            Prontos
          </span>
        </button>

        {/* Card 4: Total Pendente */}
        <button
          type="button"
          onClick={() => setActiveCategory('all')}
          className={`flex flex-col items-center justify-center p-2.5 rounded-2xl border transition-all cursor-pointer ${
            activeCategory === 'all'
              ? 'bg-[#FAF4EE] border-[#4A1505] ring-2 ring-[#4A1505]/20 dark:bg-zinc-800'
              : 'bg-[#FAF4EE]/70 dark:bg-zinc-800/50 border-amber-900/10 dark:border-zinc-700 hover:opacity-90'
          }`}
        >
          <div className="text-[#4A1505] dark:text-amber-400 mb-1">
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20v-6M6 20V10M18 20V4" />
            </svg>
          </div>
          <span className="text-base font-extrabold text-[#4A1505] dark:text-amber-100 leading-tight">
            {totalPendingCount}
          </span>
          <span className="text-[10px] font-semibold text-zinc-700 dark:text-zinc-300">
            Pendentes
          </span>
        </button>
      </div>

      {/* =========================================================
          CAMPO DE BUSCA
         ========================================================= */}
      <div className="relative">
        <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-zinc-400">
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </div>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Buscar chamado, mesa ou comanda..."
          className="w-full pl-10 pr-4 py-2.5 bg-white dark:bg-zinc-900 border border-amber-900/10 dark:border-zinc-800 rounded-2xl text-xs text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-[#4A1505]/20 shadow-sm"
        />
        {searchQuery && (
          <button
            type="button"
            onClick={() => setSearchQuery('')}
            className="absolute inset-y-0 right-0 pr-3 flex items-center text-zinc-400 hover:text-zinc-600"
            aria-label="Limpar busca"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      {/* =========================================================
          FILTROS POR PILLS (Todas, Prontos, Garçom, Contas)
         ========================================================= */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1 no-scrollbar">
        <button
          type="button"
          onClick={() => setActiveCategory('all')}
          className={`px-4 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition cursor-pointer ${
            activeCategory === 'all'
              ? 'bg-[#4A1505] text-white shadow-sm'
              : 'bg-white dark:bg-zinc-900 border border-amber-900/10 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-amber-50/50'
          }`}
        >
          Todas ({totalPendingCount})
        </button>
        <button
          type="button"
          onClick={() => setActiveCategory('ready_order')}
          className={`px-4 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition cursor-pointer ${
            activeCategory === 'ready_order'
              ? 'bg-[#4A1505] text-white shadow-sm'
              : 'bg-white dark:bg-zinc-900 border border-amber-900/10 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-amber-50/50'
          }`}
        >
          Prontos ({summary.readyOrdersCount})
        </button>
        <button
          type="button"
          onClick={() => setActiveCategory('waiter_call')}
          className={`px-4 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition cursor-pointer ${
            activeCategory === 'waiter_call'
              ? 'bg-[#4A1505] text-white shadow-sm'
              : 'bg-white dark:bg-zinc-900 border border-amber-900/10 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-amber-50/50'
          }`}
        >
          Garçom ({summary.waiterCallsCount})
        </button>
        <button
          type="button"
          onClick={() => setActiveCategory('bill_request')}
          className={`px-4 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition cursor-pointer ${
            activeCategory === 'bill_request'
              ? 'bg-[#4A1505] text-white shadow-sm'
              : 'bg-white dark:bg-zinc-900 border border-amber-900/10 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-amber-50/50'
          }`}
        >
          Conta ({summary.billRequestsCount})
        </button>
      </div>

      {/* =========================================================
          ALERTA DE ERRO
         ========================================================= */}
      {error && (
        <div role="alert" className="p-3.5 rounded-2xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900 text-xs text-rose-800 dark:text-rose-200 flex items-center justify-between gap-3 shadow-sm">
          <span>⚠️ {error}</span>
          <button
            type="button"
            onClick={() => void refresh()}
            className="underline font-bold shrink-0 cursor-pointer"
          >
            Tentar novamente
          </button>
        </div>
      )}

      {/* =========================================================
          LISTA DE CARDS DE CHAMADOS
         ========================================================= */}
      {loading && chamados.length === 0 ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="p-4 bg-white dark:bg-zinc-900 rounded-3xl border border-amber-900/10 animate-pulse space-y-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-zinc-200 dark:bg-zinc-800 rounded-2xl" />
                <div className="space-y-1.5 flex-1">
                  <div className="w-28 h-3.5 bg-zinc-200 dark:bg-zinc-800 rounded" />
                  <div className="w-20 h-2.5 bg-zinc-200 dark:bg-zinc-800 rounded" />
                </div>
              </div>
              <div className="w-full h-8 bg-zinc-100 dark:bg-zinc-800/60 rounded-xl" />
            </div>
          ))}
        </div>
      ) : filteredChamados.length === 0 ? (
        <div className="py-12 px-4 text-center rounded-3xl bg-white/70 dark:bg-zinc-900/70 border border-dashed border-amber-900/15 dark:border-zinc-800">
          <div className="w-12 h-12 mx-auto rounded-full bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 flex items-center justify-center mb-3">
            <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <p className="text-sm font-bold text-zinc-800 dark:text-zinc-200">
            Nenhum chamado pendente
          </p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
            {activeCategory !== 'all' || searchQuery
              ? 'Nenhum resultado corresponde ao filtro atual.'
              : 'Tudo em dia com o salão! Novos chamados aparecerão aqui em tempo real.'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredChamados.map((item) => (
            <ChamadoCard
              key={item.id}
              item={item}
              now={now}
              isBusy={busyActionId === item.id}
              onDeliver={deliverOrder}
              onAttendWaiter={attendWaiter}
              onAttendBill={attendBill}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface ChamadoCardProps {
  item: ChamadoItem;
  now: number;
  isBusy: boolean;
  onDeliver: (id: string) => Promise<boolean>;
  onAttendWaiter: (id: string) => Promise<boolean>;
  onAttendBill: (id: string) => Promise<boolean>;
}

function ChamadoCard({
  item,
  now,
  isBusy,
  onDeliver,
  onAttendWaiter,
  onAttendBill,
}: ChamadoCardProps) {
  const isReady = item.category === 'ready_order';
  const isWaiter = item.category === 'waiter_call';
  const isBill = item.category === 'bill_request';

  return (
    <article
      className="bg-white dark:bg-zinc-900 rounded-3xl p-4 border border-amber-900/10 dark:border-zinc-800 shadow-sm space-y-3 transition-all hover:shadow-md"
    >
      {/* Linha Superior: Ícone da Mesa + Título + Status Badge */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className={`w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 ${
              isReady
                ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                : isBill
                  ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
                  : 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300'
            }`}
          >
            {isReady ? (
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 4v2" />
                <path d="M4 18h16a1 1 0 0 0 1-1A9 9 0 0 0 3 17a1 1 0 0 0 1 1z" />
                <path d="M2 20h20" />
              </svg>
            ) : isBill ? (
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
              </svg>
            ) : (
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
            )}
          </div>

          <div className="min-w-0">
            <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 truncate">
              {isReady
                ? `${item.quantity || 1}x ${item.productName || 'Item pronto'}`
                : isBill
                  ? item.tabLabel ? `Conta: ${item.tabLabel}` : 'Pedido de Conta'
                  : 'Chamado do Garçom'}
            </h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
              <span className="font-semibold text-zinc-700 dark:text-zinc-300">{item.tableName}</span>
              {item.tableSector && <span> • {item.tableSector}</span>}
              {!isBill && item.tabLabel && <span> • {item.tabLabel}</span>}
            </p>
          </div>
        </div>

        {/* Badge de Estado */}
        <div className="shrink-0">
          <span
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold ${
              isReady
                ? 'bg-emerald-50 text-emerald-700 border border-emerald-200/60 dark:bg-emerald-950/40 dark:text-emerald-300'
                : isBill
                  ? 'bg-amber-50 text-amber-800 border border-amber-200/60 dark:bg-amber-950/40 dark:text-amber-300'
                  : 'bg-rose-50 text-rose-800 border border-rose-200/60 dark:bg-rose-950/40 dark:text-rose-300'
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                isReady ? 'bg-emerald-500' : isBill ? 'bg-amber-500' : 'bg-rose-500 animate-pulse'
              }`}
            />
            {isReady ? 'Pronto' : isBill ? 'Aguardando conta' : 'Chamando'}
          </span>
        </div>
      </div>

      {/* Linha Intermediária: Detalhes e Tempo Decorrido Real */}
      <div className="flex items-center justify-between text-xs text-zinc-600 dark:text-zinc-400 pt-1 border-t border-amber-900/5 dark:border-zinc-800/80">
        <div className="flex items-center gap-3">
          {isReady && item.preparationStation && (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-zinc-500">
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M6 13.87A4 4 0 0 1 7.41 6a5.11 5.11 0 0 1 1.05-1.54 5 5 0 0 1 7.08 0A5.11 5.11 0 0 1 16.59 6 4 4 0 0 1 18 13.87V21H6Z" />
                <line x1="6" y1="17" x2="18" y2="17" />
              </svg>
              {item.preparationStation === 'bar' ? 'Bar / Copa' : 'Cozinha'}
            </span>
          )}

          {isBill && item.includeServiceFee !== null && item.includeServiceFee !== undefined && (
            <span
              className={`inline-flex items-center gap-1 text-[11px] font-semibold ${
                item.includeServiceFee ? 'text-emerald-700 dark:text-emerald-400' : 'text-zinc-500'
              }`}
            >
              {item.includeServiceFee ? 'Com taxa de serviço' : 'Sem taxa de serviço'}
            </span>
          )}

          {isWaiter && (
            <span className="text-[11px] text-zinc-500">
              Solicitado pelo cliente
            </span>
          )}
        </div>

        {/* Cronômetro / Tempo decorrido real */}
        <div className="flex items-center gap-1 text-[11px] text-zinc-500 dark:text-zinc-400">
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          <span className="font-medium">{formatElapsedTime(item.createdAt, now)}</span>
        </div>
      </div>

      {/* Linha de Ações */}
      <div className="flex items-center justify-end gap-2 pt-1">
        {isReady && (
          <button
            type="button"
            disabled={isBusy}
            onClick={() => void onDeliver(item.id)}
            className="flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-[#4A1505] hover:bg-[#381004] text-white font-bold text-xs shadow-sm transition disabled:opacity-50 cursor-pointer"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <span>{isBusy ? 'Confirmando...' : 'Entregar'}</span>
          </button>
        )}

        {isWaiter && (
          <button
            type="button"
            disabled={isBusy}
            onClick={() => void onAttendWaiter(item.id)}
            className="flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-[#4A1505] hover:bg-[#381004] text-white font-bold text-xs shadow-sm transition disabled:opacity-50 cursor-pointer"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="8.5" cy="7" r="4" />
              <polyline points="17 11 19 13 23 9" />
            </svg>
            <span>{isBusy ? 'Atendendo...' : 'Atender agora'}</span>
          </button>
        )}

        {isBill && (
          <button
            type="button"
            disabled={isBusy}
            onClick={() => void onAttendBill(item.id)}
            className="flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-[#4A1505] hover:bg-[#381004] text-white font-bold text-xs shadow-sm transition disabled:opacity-50 cursor-pointer"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
            <span>{isBusy ? 'Atendendo...' : 'Marcar como atendida'}</span>
          </button>
        )}
      </div>
    </article>
  );
}

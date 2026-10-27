import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { closeTableVisit, type SalonTableVisit, type RestaurantTableItem } from './tableVisits';
import { closeTableTab } from './tableTabs';
import { printTableBillThermal } from '../../components/ThermalReceiptPrint';
import type { TableDisplayItem } from './StaffServicePage';

interface TableDetailsTabPanelProps {
  restaurantSlug: string;
  restaurantId: string;
  tableVisit: SalonTableVisit;
  tableNumber: number;
  tableInfo?: TableDisplayItem;
  tableItem?: RestaurantTableItem;
  freeTables?: Array<{ id: string; table_number: number; label?: string; capacity?: number }>;
  onCloseVisitSuccess: () => void;
}

interface DetailTabItem {
  id: string;
  label: string;
  status: 'open' | 'closed';
  created_at: string;
  closed_at: string | null;
}

interface DetailGuestSession {
  id: string;
  status: string;
  created_at: string;
  confirmed_at?: string | null;
}

interface DetailConsumptionItem {
  id: string;
  table_tab_id: string;
  product_name: string;
  unit_price_in_cents: number;
  quantity: number;
  line_total_in_cents: number;
  status: string;
  created_at: string;
  cancelled_at?: string | null;
  cancellation_reason?: string | null;
}

const currency = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

export function TableDetailsTabPanel({
  restaurantSlug,
  restaurantId,
  tableVisit,
  tableNumber,
  tableInfo,
  tableItem,
  freeTables = [],
  onCloseVisitSuccess,
}: TableDetailsTabPanelProps) {
  const [tabs, setTabs] = useState<DetailTabItem[]>([]);
  const [guestSessions, setGuestSessions] = useState<DetailGuestSession[]>([]);
  const [items, setItems] = useState<DetailConsumptionItem[]>([]);
  const [feePercent, setFeePercent] = useState<number>(10);
  const [restaurantName, setRestaurantName] = useState<string>('Restaurante');
  const [loading, setLoading] = useState<boolean>(true);

  // Modais de ações
  const [isCloseConfirmOpen, setIsCloseConfirmOpen] = useState(false);
  const [busyClose, setBusyClose] = useState(false);
  const [isObsModalOpen, setIsObsModalOpen] = useState(false);
  const [isTransferModalOpen, setIsTransferModalOpen] = useState(false);
  const [targetTransferTableId, setTargetTransferTableId] = useState<string>('');
  const [transferNotice, setTransferNotice] = useState<string>('');

  // Observações salvas
  const [tableObservation, setTableObservation] = useState<string>(() => {
    try {
      return localStorage.getItem(`elozi_table_obs_${restaurantId}_${tableVisit.id}`) || '';
    } catch {
      return '';
    }
  });
  const [obsInput, setObsInput] = useState<string>('');

  // Código confirmado em cache
  const confirmedCode = useMemo(() => {
    try {
      return (
        localStorage.getItem(`elozi_table_code_${restaurantId}_${tableVisit.id}`) ||
        sessionStorage.getItem(`elozi_table_code_${restaurantId}_${tableVisit.id}`) ||
        ''
      );
    } catch {
      return '';
    }
  }, [restaurantId, tableVisit.id]);

  useEffect(() => {
    let disposed = false;

    async function loadData() {
      setLoading(true);
      try {
        const [tabsRes, guestsRes, itemsRes, restRes] = await Promise.all([
          supabase
            .from('table_tabs')
            .select('id, label, status, created_at, closed_at')
            .eq('table_visit_id', tableVisit.id)
            .order('created_at', { ascending: true }),
          supabase
            .from('guest_sessions')
            .select('id, status, created_at, confirmed_at')
            .eq('restaurant_id', restaurantId)
            .eq('table_visit_id', tableVisit.id)
            .eq('status', 'active'),
          supabase
            .from('table_tab_items')
            .select('id, table_tab_id, product_name, unit_price_in_cents, quantity, line_total_in_cents, status, created_at, cancelled_at, cancellation_reason')
            .eq('table_visit_id', tableVisit.id),
          supabase
            .from('restaurants')
            .select('name, service_fee_percent')
            .eq('id', restaurantId)
            .maybeSingle(),
        ]);

        if (disposed) return;

        if (tabsRes.data) {
          setTabs(tabsRes.data as DetailTabItem[]);
        }
        if (guestsRes.data) {
          setGuestSessions(guestsRes.data as DetailGuestSession[]);
        }
        if (itemsRes.data) {
          setItems(itemsRes.data as DetailConsumptionItem[]);
        }
        if (restRes.data) {
          setFeePercent(restRes.data.service_fee_percent ?? 10);
          setRestaurantName(restRes.data.name || 'Restaurante');
        }
      } catch (e) {
        console.error('Erro ao carregar detalhes da mesa:', e);
      } finally {
        if (!disposed) {
          setLoading(false);
        }
      }
    }

    void loadData();

    return () => {
      disposed = true;
    };
  }, [restaurantId, tableVisit.id]);

  // Cálculos financeiros consolidados
  const subtotalInCents = useMemo(() => {
    return items
      .filter((it) => it.status === 'active')
      .reduce((acc, it) => acc + (it.line_total_in_cents || 0), 0);
  }, [items]);

  const feeInCents = useMemo(() => {
    return Math.round((subtotalInCents * feePercent) / 100);
  }, [subtotalInCents, feePercent]);

  const totalInCents = subtotalInCents + feeInCents;

  // Cliente vinculada primária
  const primaryClientName = useMemo(() => {
    const firstTab = tabs.find((t) => !t.label.toLowerCase().includes('conjunt'));
    if (firstTab) return firstTab.label;
    if (tabs.length > 0) return tabs[0].label;
    return 'Não informado';
  }, [tabs]);

  const confirmedGuestsCount = guestSessions.length;

  // Horários formatados
  const openedAtFormatted = useMemo(() => {
    if (!tableVisit.opened_at) return '--:--';
    try {
      return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(
        new Date(tableVisit.opened_at),
      );
    } catch {
      return '--:--';
    }
  }, [tableVisit.opened_at]);

  const lastUpdateFormatted = useMemo(() => {
    let latestTs = tableVisit.opened_at;
    for (const it of items) {
      if (it.created_at && (!latestTs || new Date(it.created_at) > new Date(latestTs))) {
        latestTs = it.created_at;
      }
    }
    for (const tb of tabs) {
      if (tb.created_at && (!latestTs || new Date(tb.created_at) > new Date(latestTs))) {
        latestTs = tb.created_at;
      }
    }
    if (!latestTs) return openedAtFormatted;
    try {
      return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(
        new Date(latestTs),
      );
    } catch {
      return openedAtFormatted;
    }
  }, [tableVisit.opened_at, items, tabs, openedAtFormatted]);

  // Histórico rápido (Eventos cronológicos da linha do tempo)
  const timelineEvents = useMemo(() => {
    const events: Array<{ timestamp: number; time: string; title: string; description: string }> = [];

    // 1. Abertura da mesa
    if (tableVisit.opened_at) {
      const d = new Date(tableVisit.opened_at);
      events.push({
        timestamp: d.getTime(),
        time: new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(d),
        title: 'Mesa assumida',
        description: 'Atendimento iniciado por você',
      });
    }

    // 2. Acessos confirmados
    for (const g of guestSessions) {
      const ts = g.confirmed_at || g.created_at;
      if (ts) {
        const d = new Date(ts);
        events.push({
          timestamp: d.getTime(),
          time: new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(d),
          title: 'Acesso confirmado',
          description: `${confirmedGuestsCount} acesso(s) confirmado(s) na mesa`,
        });
        break; // Apenas um evento representativo da confirmação de acessos
      }
    }

    // 3. Comandas criadas
    for (const tab of tabs) {
      if (tab.created_at) {
        const d = new Date(tab.created_at);
        events.push({
          timestamp: d.getTime(),
          time: new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(d),
          title: 'Comanda criada',
          description: `Comanda “${tab.label}” criada`,
        });
      }
    }

    // 4. Pedido registrado (último lançamento de itens)
    if (items.length > 0) {
      const sortedItems = [...items].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
      const latest = sortedItems[0];
      const d = new Date(latest.created_at);
      events.push({
        timestamp: d.getTime(),
        time: new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(d),
        title: 'Pedido registrado',
        description: `${items.filter((it) => it.status === 'active').length} item(ns) em produção/consumo`,
      });
    }

    // 5. Itens cancelados (Auditoria na linha do tempo)
    for (const it of items) {
      if (it.status === 'cancelled' && it.cancelled_at) {
        const d = new Date(it.cancelled_at);
        events.push({
          timestamp: d.getTime(),
          time: new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(d),
          title: `Item cancelado (${it.quantity}x ${it.product_name})`,
          description: `Motivo: ${it.cancellation_reason || 'Não informado'}`,
        });
      }
    }

    // Ordenar cronologicamente
    return events.sort((a, b) => a.timestamp - b.timestamp);
  }, [tableVisit.opened_at, guestSessions, confirmedGuestsCount, tabs, items]);

  // Ação: Fechar Mesa
  async function handleConfirmClose() {
    if (busyClose) return;

    const openTabs = tabs.filter((t) => t.status === 'open');
    if (openTabs.length > 0) {
      alert('Encerre todas as comandas abertas antes de finalizar o atendimento da mesa.');
      setIsCloseConfirmOpen(false);
      return;
    }

    setBusyClose(true);

    try {
      // 1. Encerrar o atendimento da visita
      await closeTableVisit(restaurantSlug, tableVisit.id);

      // 2. Notificar pai para limpar cache e redirecionar
      onCloseVisitSuccess();
    } catch (e) {
      console.error('Erro ao fechar mesa:', e);
      alert(e instanceof Error ? e.message : 'Não foi possível encerrar a mesa.');
    } finally {
      setBusyClose(false);
      setIsCloseConfirmOpen(false);
    }
  }

  // Ação: Imprimir comanda
  function handlePrintReceipt() {
    printTableBillThermal({
      restaurantName,
      tableNumber,
      tabLabel: `Mesa ${String(tableNumber).padStart(2, '0')}`,
      items: items.map((it) => ({
        name: it.product_name,
        quantity: it.quantity,
        unitPriceInCents: it.unit_price_in_cents,
        totalInCents: it.line_total_in_cents,
      })),
      subtotalInCents,
      serviceFeePercent: feePercent,
      serviceFeeInCents: feeInCents,
      totalInCents,
      paperWidth: '80mm',
    });
  }

  return (
    <div className="space-y-4">
      {/* Aviso de transferência se houver */}
      {transferNotice && (
        <div className="p-3 rounded-2xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/40 text-xs text-amber-900 dark:text-amber-200 flex items-center justify-between">
          <span>{transferNotice}</span>
          <button
            type="button"
            onClick={() => setTransferNotice('')}
            className="text-amber-700 font-bold ml-2 cursor-pointer"
          >
            ✕
          </button>
        </div>
      )}

      {/* =========================================================
          BLOCO 1: RESUMO DA MESA
         ========================================================= */}
      <div className="rounded-3xl border border-zinc-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 shadow-xs space-y-3.5">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-[#F7EFE9] dark:bg-zinc-800 text-[#8B1E0F] dark:text-amber-400 flex items-center justify-center shrink-0">
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
              <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
            </svg>
          </div>
          <div>
            <h3 className="font-bold text-sm text-zinc-900 dark:text-white leading-tight">Resumo da mesa</h3>
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">Informações principais desta mesa.</p>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2">
          {/* 1. Status */}
          <div className="bg-[#FAF6F0] dark:bg-zinc-800/60 rounded-2xl p-2.5 border border-amber-900/5 dark:border-zinc-800 flex flex-col justify-between">
            <div className="flex items-center gap-1.5 text-[10px] text-zinc-500 dark:text-zinc-400 font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
              <span>Status</span>
            </div>
            <span className="text-xs font-bold text-zinc-900 dark:text-white mt-1 truncate">
              {tableVisit.status === 'open' ? 'Ativa' : 'Encerrada'}
            </span>
          </div>

          {/* 2. Cliente vinculada */}
          <div className="bg-[#FAF6F0] dark:bg-zinc-800/60 rounded-2xl p-2.5 border border-amber-900/5 dark:border-zinc-800 flex flex-col justify-between">
            <div className="flex items-center gap-1.5 text-[10px] text-zinc-500 dark:text-zinc-400 font-medium">
              <svg className="w-3.5 h-3.5 text-zinc-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
              <span className="truncate">Cliente vinculada</span>
            </div>
            <span className="text-xs font-bold text-zinc-900 dark:text-white mt-1 truncate" title={primaryClientName}>
              {primaryClientName}
            </span>
          </div>

          {/* 3. Código vinculado */}
          <div className="bg-[#FAF6F0] dark:bg-zinc-800/60 rounded-2xl p-2.5 border border-amber-900/5 dark:border-zinc-800 flex flex-col justify-between">
            <div className="flex items-center gap-1.5 text-[10px] text-zinc-500 dark:text-zinc-400 font-medium">
              <svg className="w-3.5 h-3.5 text-zinc-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 5v14" />
                <path d="M8 5v14" />
                <path d="M12 5v14" />
                <path d="M17 5v14" />
                <path d="M21 5v14" />
              </svg>
              <span className="truncate">Código vinculado</span>
            </div>
            <span className="text-xs font-bold font-mono text-zinc-900 dark:text-white mt-1 tracking-wider">
              {confirmedCode || '---'}
            </span>
          </div>

          {/* 4. Acessos confirmados */}
          <div className="bg-[#FAF6F0] dark:bg-zinc-800/60 rounded-2xl p-2.5 border border-amber-900/5 dark:border-zinc-800 flex flex-col justify-between">
            <div className="flex items-center gap-1.5 text-[10px] text-zinc-500 dark:text-zinc-400 font-medium">
              <svg className="w-3.5 h-3.5 text-zinc-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                <polyline points="10 17 15 12 10 7" />
                <line x1="15" y1="12" x2="3" y2="12" />
              </svg>
              <span className="truncate">Acessos confirmados</span>
            </div>
            <span className="text-xs font-bold text-zinc-900 dark:text-white mt-1">
              {confirmedGuestsCount} {confirmedGuestsCount === 1 ? 'acesso' : 'acessos'}
            </span>
          </div>

          {/* 5. Capacidade */}
          <div className="bg-[#FAF6F0] dark:bg-zinc-800/60 rounded-2xl p-2.5 border border-amber-900/5 dark:border-zinc-800 flex flex-col justify-between">
            <div className="flex items-center gap-1.5 text-[10px] text-zinc-500 dark:text-zinc-400 font-medium">
              <svg className="w-3.5 h-3.5 text-zinc-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
              <span className="truncate">Capacidade</span>
            </div>
            <span className="text-xs font-bold text-zinc-900 dark:text-white mt-1">
              {tableInfo?.capacity ? `${tableInfo.capacity} pessoas` : '4 pessoas'}
            </span>
          </div>

          {/* 6. Local */}
          <div className="bg-[#FAF6F0] dark:bg-zinc-800/60 rounded-2xl p-2.5 border border-amber-900/5 dark:border-zinc-800 flex flex-col justify-between">
            <div className="flex items-center gap-1.5 text-[10px] text-zinc-500 dark:text-zinc-400 font-medium">
              <svg className="w-3.5 h-3.5 text-zinc-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                <circle cx="12" cy="10" r="3" />
              </svg>
              <span className="truncate">Local</span>
            </div>
            <span className="text-xs font-bold text-zinc-900 dark:text-white mt-1 truncate">
              {tableInfo?.area || tableItem?.label || 'Salão principal'}
            </span>
          </div>
        </div>
      </div>

      {/* =========================================================
          BLOCO 2: RESUMO FINANCEIRO
         ========================================================= */}
      <div className="rounded-3xl border border-zinc-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 shadow-xs space-y-3.5">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-[#F7EFE9] dark:bg-zinc-800 text-[#8B1E0F] dark:text-amber-400 flex items-center justify-center shrink-0">
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" />
              <path d="M12 6v2m0 8v2" />
            </svg>
          </div>
          <div>
            <h3 className="font-bold text-sm text-zinc-900 dark:text-white leading-tight">Resumo financeiro</h3>
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">Valores desta mesa até o momento.</p>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-2.5 items-center">
          <div>
            <span className="text-[10px] text-zinc-400 font-medium block">Subtotal</span>
            <span className="text-xs font-bold text-zinc-900 dark:text-white mt-0.5 block">
              {currency.format(subtotalInCents / 100)}
            </span>
          </div>

          <div>
            <span className="text-[10px] text-zinc-400 font-medium block">
              Taxa de serviço ({feePercent}%)
            </span>
            <span className="text-xs font-bold text-zinc-900 dark:text-white mt-0.5 block">
              {currency.format(feeInCents / 100)}
            </span>
          </div>

          <div>
            <span className="text-[10px] text-zinc-400 font-medium block">Descontos</span>
            <span className="text-xs font-bold text-zinc-900 dark:text-white mt-0.5 block">
              {currency.format(0)}
            </span>
          </div>

          <div className="bg-rose-50/80 dark:bg-rose-950/30 border border-rose-200/60 dark:border-rose-900/40 rounded-xl p-2.5">
            <span className="text-[10px] font-semibold text-[#8B1E0F] dark:text-rose-300 block leading-tight">
              Total atual
            </span>
            <span className="text-sm font-extrabold text-[#8B1E0F] dark:text-rose-200 mt-0.5 block">
              {currency.format(totalInCents / 100)}
            </span>
          </div>
        </div>
      </div>

      {/* =========================================================
          BLOCO 3: AÇÕES RÁPIDAS
         ========================================================= */}
      <div className="space-y-2 pt-1">
        <span className="text-xs font-bold text-zinc-700 dark:text-zinc-300 block">
          Ações rápidas
        </span>

        <div className="grid grid-cols-4 gap-2">
          {/* 1. Transferir mesa */}
          <button
            type="button"
            onClick={() => {
              if (freeTables.length > 0) {
                setTargetTransferTableId(freeTables[0].id);
              }
              setIsTransferModalOpen(true);
            }}
            className="p-3 rounded-2xl border border-zinc-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition flex flex-col items-center justify-center gap-1.5 shadow-2xs cursor-pointer text-center"
          >
            <svg className="w-4 h-4 text-[#8B1E0F] dark:text-rose-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M16 3h5v5" />
              <path d="M4 20 21 3" />
              <path d="M21 16v5h-5" />
              <path d="m15 15 6 6" />
              <path d="M4 4l5 5" />
            </svg>
            <span className="text-[11px] font-semibold text-zinc-700 dark:text-zinc-200">
              Transferir mesa
            </span>
          </button>

          {/* 2. Imprimir comanda */}
          <button
            type="button"
            onClick={handlePrintReceipt}
            className="p-3 rounded-2xl border border-zinc-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition flex flex-col items-center justify-center gap-1.5 shadow-2xs cursor-pointer text-center"
          >
            <svg className="w-4 h-4 text-[#8B1E0F] dark:text-rose-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="6 9 6 2 18 2 18 9" />
              <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
              <rect x="6" y="14" width="12" height="8" />
            </svg>
            <span className="text-[11px] font-semibold text-zinc-700 dark:text-zinc-200">
              Imprimir comanda
            </span>
          </button>

          {/* 3. Adicionar observação */}
          <button
            type="button"
            onClick={() => {
              setObsInput(tableObservation);
              setIsObsModalOpen(true);
            }}
            className="p-3 rounded-2xl border border-zinc-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition flex flex-col items-center justify-center gap-1.5 shadow-2xs cursor-pointer text-center"
          >
            <svg className="w-4 h-4 text-[#8B1E0F] dark:text-rose-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
            <span className="text-[11px] font-semibold text-zinc-700 dark:text-zinc-200">
              Adicionar observação
            </span>
          </button>

          {/* 4. Fechar mesa */}
          <button
            type="button"
            onClick={() => setIsCloseConfirmOpen(true)}
            className="p-3 rounded-2xl border border-rose-200 dark:border-rose-900/60 bg-rose-50/50 dark:bg-rose-950/30 hover:bg-rose-100/60 transition flex flex-col items-center justify-center gap-1.5 shadow-2xs cursor-pointer text-center"
          >
            <svg className="w-4 h-4 text-rose-600 dark:text-rose-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="15" y1="9" x2="9" y2="15" />
              <line x1="9" y1="9" x2="15" y2="15" />
            </svg>
            <span className="text-[11px] font-semibold text-rose-700 dark:text-rose-300">
              Fechar mesa
            </span>
          </button>
        </div>
      </div>

      {/* =========================================================
          BLOCO 4: OBSERVAÇÕES E ATENDIMENTO
         ========================================================= */}
      <div className="rounded-3xl border border-zinc-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 shadow-xs space-y-3.5">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-[#F7EFE9] dark:bg-zinc-800 text-[#8B1E0F] dark:text-amber-400 flex items-center justify-center shrink-0">
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
              <polyline points="10 9 9 9 8 9" />
            </svg>
          </div>
          <div>
            <h3 className="font-bold text-sm text-zinc-900 dark:text-white leading-tight">Observações e atendimento</h3>
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">Informações importantes para o atendimento.</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          {/* 1. Divisão / Comandas */}
          <div className="bg-[#FAF6F0] dark:bg-zinc-800/60 rounded-2xl p-3 border border-amber-900/5 dark:border-zinc-800 space-y-1">
            <div className="flex items-center gap-1.5 text-zinc-400">
              <svg className="w-4 h-4 text-[#8B1E0F] dark:text-amber-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              <span className="text-[11px] font-semibold text-zinc-600 dark:text-zinc-300">Divisão</span>
            </div>
            <p className="text-xs text-zinc-800 dark:text-zinc-200 font-medium leading-relaxed">
              {tabs.length > 1
                ? `Dividido em ${tabs.length} comandas (${tabs.map((t) => t.label).join(', ')})`
                : tabs.length === 1
                ? `Cliente prefere dividir em 1 pessoa (${tabs[0].label})`
                : 'Sem comandas abertas no momento.'}
            </p>
          </div>

          {/* 2. Alergias / Restrições */}
          <div className="bg-[#FAF6F0] dark:bg-zinc-800/60 rounded-2xl p-3 border border-amber-900/5 dark:border-zinc-800 space-y-1">
            <div className="flex items-center gap-1.5 text-zinc-400">
              <svg className="w-4 h-4 text-[#8B1E0F] dark:text-amber-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
              </svg>
              <span className="text-[11px] font-semibold text-zinc-600 dark:text-zinc-300">Alergias / Restrições</span>
            </div>
            <p className="text-xs text-zinc-800 dark:text-zinc-200 font-medium leading-relaxed">
              {tableObservation || 'Sem alergias informadas'}
            </p>
          </div>

          {/* 3. Início do Atendimento */}
          <div className="bg-[#FAF6F0] dark:bg-zinc-800/60 rounded-2xl p-3 border border-amber-900/5 dark:border-zinc-800 space-y-1">
            <div className="flex items-center gap-1.5 text-zinc-400">
              <svg className="w-4 h-4 text-[#8B1E0F] dark:text-amber-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              <span className="text-[11px] font-semibold text-zinc-600 dark:text-zinc-300">Início do atendimento</span>
            </div>
            <p className="text-xs text-zinc-800 dark:text-zinc-200 font-medium">
              Atendimento iniciado às <strong className="font-bold text-zinc-900 dark:text-white">{openedAtFormatted}</strong>
            </p>
          </div>

          {/* 4. Última Atualização */}
          <div className="bg-[#FAF6F0] dark:bg-zinc-800/60 rounded-2xl p-3 border border-amber-900/5 dark:border-zinc-800 space-y-1">
            <div className="flex items-center gap-1.5 text-zinc-400">
              <svg className="w-4 h-4 text-[#8B1E0F] dark:text-amber-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
              <span className="text-[11px] font-semibold text-zinc-600 dark:text-zinc-300">Última atualização</span>
            </div>
            <p className="text-xs text-zinc-800 dark:text-zinc-200 font-medium">
              Última atualização às <strong className="font-bold text-zinc-900 dark:text-white">{lastUpdateFormatted}</strong>
            </p>
          </div>
        </div>
      </div>

      {/* =========================================================
          BLOCO 5: HISTÓRICO RÁPIDO (TIMELINE DINÂMICA)
         ========================================================= */}
      <div className="rounded-3xl border border-zinc-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 shadow-xs space-y-3.5">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-[#F7EFE9] dark:bg-zinc-800 text-[#8B1E0F] dark:text-amber-400 flex items-center justify-center shrink-0">
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="8" y1="6" x2="21" y2="6" />
              <line x1="8" y1="12" x2="21" y2="12" />
              <line x1="8" y1="18" x2="21" y2="18" />
              <line x1="3" y1="6" x2="3.01" y2="6" />
              <line x1="3" y1="12" x2="3.01" y2="12" />
              <line x1="3" y1="18" x2="3.01" y2="18" />
            </svg>
          </div>
          <div>
            <h3 className="font-bold text-sm text-zinc-900 dark:text-white leading-tight">Histórico rápido</h3>
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">Últimos eventos desta mesa.</p>
          </div>
        </div>

        <div className="pl-2 pt-1 pb-1">
          <div className="relative border-l-2 border-red-200 dark:border-red-900/60 ml-2 space-y-4 py-1">
            {timelineEvents.map((evt, idx) => (
              <div key={idx} className="relative pl-5 flex items-start justify-between gap-3">
                <span className="absolute -left-[5px] top-1 w-2.5 h-2.5 rounded-full bg-[#8B1E0F] dark:bg-rose-500 ring-4 ring-white dark:ring-zinc-900" />
                <div className="flex-1 min-w-0">
                  <h4 className="text-xs font-bold text-zinc-900 dark:text-white leading-tight">
                    {evt.title}
                  </h4>
                  <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">
                    {evt.description}
                  </p>
                </div>
                <span className="text-[11px] font-semibold text-zinc-400 dark:text-zinc-500 shrink-0 tabular-nums">
                  {evt.time}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* =========================================================
          MODAL: FECHAR MESA (CONFIRMAÇÃO)
         ========================================================= */}
      {isCloseConfirmOpen && (() => {
        const openTabsCount = tabs.filter((t) => t.status === 'open').length;

        return (
          <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
            <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-3xl p-5 max-w-sm w-full shadow-2xl space-y-4">
              <div>
                <h3 className="font-bold text-sm text-zinc-900 dark:text-white">
                  Encerrar atendimento da Mesa {String(tableNumber).padStart(2, '0')}?
                </h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
                  Deseja encerrar o atendimento e fechar a Mesa {String(tableNumber).padStart(2, '0')}?
                </p>

                {openTabsCount > 0 ? (
                  <div className="mt-3 p-3 rounded-2xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/50 text-xs text-amber-900 dark:text-amber-200">
                    <p className="font-semibold">Mesa possui {openTabsCount} comanda(s) aberta(s).</p>
                    <p className="mt-0.5 text-[11px]">Encerre todas as comandas abertas antes de finalizar o atendimento da mesa.</p>
                  </div>
                ) : (
                  <div className="mt-3 p-3 rounded-2xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900/50 flex items-center justify-between">
                    <span className="text-xs font-semibold text-rose-900 dark:text-rose-200">Total a fechar:</span>
                    <span className="text-sm font-extrabold text-[#8B1E0F] dark:text-rose-300">
                      {currency.format(totalInCents / 100)}
                    </span>
                  </div>
                )}
              </div>

              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  disabled={busyClose || openTabsCount > 0}
                  onClick={() => void handleConfirmClose()}
                  className="flex-1 py-2.5 rounded-xl bg-red-700 hover:bg-red-800 text-white font-bold text-xs shadow-xs transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                >
                  {busyClose ? 'Fechando mesa...' : 'Confirmar fechamento'}
                </button>
                <button
                  type="button"
                  disabled={busyClose}
                  onClick={() => setIsCloseConfirmOpen(false)}
                  className="px-4 py-2.5 rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 cursor-pointer"
                >
                  Cancelar
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* =========================================================
          MODAL: ADICIONAR OBSERVAÇÃO
         ========================================================= */}
      {isObsModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-3xl p-5 max-w-sm w-full shadow-2xl space-y-4">
            <div>
              <h3 className="font-bold text-sm text-zinc-900 dark:text-white">
                Observações da Mesa {String(tableNumber).padStart(2, '0')}
              </h3>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
                Informe restrições, alergias ou notas de preferência dos clientes desta mesa.
              </p>
            </div>

            <textarea
              value={obsInput}
              onChange={(e) => setObsInput(e.target.value)}
              rows={3}
              placeholder="Ex: Cliente alérgico a camarão. Prefere conta separada."
              className="w-full rounded-2xl border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 p-3 text-xs text-zinc-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-[#8B1E0F]"
            />

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  const trimmed = obsInput.trim();
                  setTableObservation(trimmed);
                  try {
                    localStorage.setItem(`elozi_table_obs_${restaurantId}_${tableVisit.id}`, trimmed);
                  } catch {}
                  setIsObsModalOpen(false);
                }}
                className="flex-1 py-2.5 rounded-xl bg-[#4A1505] hover:bg-[#381004] text-white font-semibold text-xs shadow-xs transition cursor-pointer"
              >
                Salvar observação
              </button>
              <button
                type="button"
                onClick={() => setIsObsModalOpen(false)}
                className="px-4 py-2.5 rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 cursor-pointer"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =========================================================
          MODAL: TRANSFERIR MESA
         ========================================================= */}
      {isTransferModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-3xl p-5 max-w-sm w-full shadow-2xl space-y-4">
            <div>
              <h3 className="font-bold text-sm text-zinc-900 dark:text-white">
                Transferir atendimento da Mesa {String(tableNumber).padStart(2, '0')}
              </h3>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
                Selecione a mesa de destino livre para onde os clientes serão transferidos.
              </p>
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-zinc-600 dark:text-zinc-300 mb-1">
                Mesa de destino
              </label>
              {freeTables.length === 0 ? (
                <p className="text-xs text-zinc-400 italic py-2">
                  Não há outras mesas livres no momento no salão.
                </p>
              ) : (
                <select
                  value={targetTransferTableId}
                  onChange={(e) => setTargetTransferTableId(e.target.value)}
                  className="w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-xs text-zinc-900 dark:text-white"
                >
                  {freeTables.map((t) => (
                    <option key={t.id} value={t.id}>
                      Mesa {t.table_number}{t.label ? ` (${t.label})` : ''} — {t.capacity ? `${t.capacity} pessoas` : 'Livre'}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="flex gap-2 pt-1">
              <button
                type="button"
                disabled={freeTables.length === 0 || !targetTransferTableId}
                onClick={() => {
                  const dest = freeTables.find((t) => t.id === targetTransferTableId);
                  setIsTransferModalOpen(false);
                  if (dest) {
                    setTransferNotice(`Para transferir para a Mesa ${dest.table_number}, abra o atendimento na nova mesa ou mova os itens nas comandas.`);
                  }
                }}
                className="flex-1 py-2.5 rounded-xl bg-[#4A1505] hover:bg-[#381004] text-white font-semibold text-xs shadow-xs transition disabled:opacity-50 cursor-pointer"
              >
                Confirmar transferência
              </button>
              <button
                type="button"
                onClick={() => setIsTransferModalOpen(false)}
                className="px-4 py-2.5 rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 cursor-pointer"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

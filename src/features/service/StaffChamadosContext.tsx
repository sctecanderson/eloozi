import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router';
import {
  ChamadoItem,
  ChamadosSummary,
  ToastNotification,
  calculateChamadosSummary,
  fetchPendingChamados,
  processIncomingChamados,
  purgeResolvedToasts,
  executeDeliverReadyOrder,
  executeAttendWaiterCall,
  executeAttendBillRequest,
  executeCompleteServiceCall,
  shouldRefreshReadyOrderQueue,
} from './staffChamados';
import { supabase } from '../../lib/supabase';
import { playDishReadySound, playWaiterCallSound } from '../../lib/soundAlerts';
import { createRefreshCoalescer } from '../../lib/refreshCoalescer';

interface StaffChamadosContextValue {
  chamados: ChamadoItem[];
  summary: ChamadosSummary;
  totalPendingCount: number;
  loading: boolean;
  error: string | null;
  busyActionId: string | null;
  refresh: () => Promise<void>;
  deliverOrder: (itemId: string) => Promise<boolean>;
  attendWaiter: (requestId: string) => Promise<boolean>;
  attendBill: (requestId: string) => Promise<boolean>;
  completeService: (requestId: string) => Promise<boolean>;
}

const StaffChamadosContext = createContext<StaffChamadosContextValue | null>(null);

export function useStaffChamados(): StaffChamadosContextValue {
  const context = useContext(StaffChamadosContext);
  if (!context) {
    throw new Error('useStaffChamados deve ser utilizado dentro de StaffChamadosProvider');
  }
  return context;
}

interface StaffChamadosProviderProps {
  restaurantSlug: string;
  restaurantId: string;
  children: React.ReactNode;
}

export function StaffChamadosProvider({
  restaurantSlug,
  restaurantId,
  children,
}: StaffChamadosProviderProps) {
  const [chamados, setChamados] = useState<ChamadoItem[]>([]);
  const chamadosRef = useRef<ChamadoItem[]>([]);
  chamadosRef.current = chamados;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyActionId, setBusyActionId] = useState<string | null>(null);

  // Trava síncrona com ref para bloquear cliques duplos antes do próximo render
  const actionLockRef = useRef(false);

  // Fila de avisos e aviso ativo (popup deslizante de 3s)
  const [toastQueue, setToastQueue] = useState<ToastNotification[]>([]);
  const [activeToast, setActiveToast] = useState<ToastNotification | null>(null);

  const knownIdsRef = useRef<Set<string>>(new Set());
  const isInitialLoadRef = useRef(true);
  const activeToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  // Controle de versão de requisição para evitar que respostas lentas sobrescrevam consultas recentes
  const requestIdRef = useRef(0);
  const requestLoadRef = useRef<(() => Promise<void>) | null>(null);

  const navigate = useNavigate();
  const location = useLocation();

  // Função central para buscar e reconciliar chamados com proteção contra concorrência e falhas parciais
  const loadChamados = useCallback(async () => {
    const currentFetchId = ++requestIdRef.current;

    try {
      const result = await fetchPendingChamados(
        restaurantSlug,
        restaurantId,
        chamadosRef.current,
      );

      // Descarta resposta antiga caso outra requisição tenha sido disparada
      if (currentFetchId !== requestIdRef.current || !mountedRef.current) {
        return;
      }

      // Processa chegada e deduplicação usando a lógica de produção compartilhada
      const { updatedKnownIds, newToasts, shouldPlaySound } = processIncomingChamados(
        result.items,
        knownIdsRef.current,
        isInitialLoadRef.current,
      );

      knownIdsRef.current = updatedKnownIds;

      if (isInitialLoadRef.current) {
        isInitialLoadRef.current = false;
      } else {
        if (newToasts.length > 0) {
          setToastQueue((prev) => [...prev, ...newToasts]);
        }
        if (shouldPlaySound === 'ready') {
          playDishReadySound();
        } else if (shouldPlaySound === 'waiter') {
          playWaiterCallSound();
        }
      }

      // Remove da fila de toasts chamados que já foram atendidos/entregues
      setToastQueue((prev) => purgeResolvedToasts(prev, result.items));

      setChamados(result.items);

      // Sinaliza falha parcial caso alguma categoria tenha falhado na consulta
      if (result.isPartial && result.partialWarning) {
        setError(result.partialWarning);
      } else {
        setError(null);
      }
    } catch (err) {
      if (currentFetchId !== requestIdRef.current || !mountedRef.current) {
        return;
      }
      setError(err instanceof Error ? err.message : 'Falha ao sincronizar chamados.');
    } finally {
      if (currentFetchId === requestIdRef.current && mountedRef.current) {
        setLoading(false);
      }
    }
  }, [restaurantSlug, restaurantId]);

  const requestLoadChamados = useCallback(() => {
    return requestLoadRef.current?.() ?? loadChamados();
  }, [loadChamados]);

  // Efeito ao trocar restaurante ou montar o Provider
  useEffect(() => {
    mountedRef.current = true;

    // Ao trocar restaurante, limpa imediatamente lista, IDs conhecidos, fila, popup e timers
    requestIdRef.current++;
    isInitialLoadRef.current = true;
    knownIdsRef.current.clear();
    actionLockRef.current = false;

    if (activeToastTimerRef.current) {
      clearTimeout(activeToastTimerRef.current);
      activeToastTimerRef.current = null;
    }

    setChamados([]);
    setToastQueue([]);
    setActiveToast(null);
    setError(null);
    setLoading(true);

    const refreshQueue = createRefreshCoalescer(loadChamados, 100);
    requestLoadRef.current = refreshQueue.request;
    void refreshQueue.request();

    // Reconciliação Realtime com Supabase
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleReload = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (mountedRef.current) {
          void requestLoadChamados();
        }
      }, 250);
    };

    const channel = supabase
      .channel(`staff-chamados-realtime:${restaurantId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'service_requests',
          filter: `restaurant_id=eq.${restaurantId}`,
        },
        scheduleReload,
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'table_tab_items',
          filter: `restaurant_id=eq.${restaurantId}`,
        },
        (payload) => {
          if (shouldRefreshReadyOrderQueue(payload)) {
            scheduleReload();
          }
        },
      )
      .subscribe((status) => {
        // Reconcilia dados ao reconectar o canal Realtime (SUBSCRIBED)
        if (status === 'SUBSCRIBED') {
          void requestLoadChamados();
        }
      });

    // Reconciliação ao reconectar internet ou ao voltar foco à aba
    const handleSync = () => {
      void requestLoadChamados();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void requestLoadChamados();
      }
    };

    window.addEventListener('online', handleSync);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Limpeza de estado e resposta pendente ao trocar sessão/logout
    const { data: authListener } = supabase.auth.onAuthStateChange((event) => {
      // A carga inicial já está em andamento; eventos de inicialização e
      // renovação do token não mudam a identidade que pode ver a fila.
      if (event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED') return;
      requestIdRef.current++;
      isInitialLoadRef.current = true;
      knownIdsRef.current.clear();
      setChamados([]);
      setToastQueue([]);
      setActiveToast(null);
      void requestLoadChamados();
    });

    return () => {
      mountedRef.current = false;
      refreshQueue.dispose();
      if (requestLoadRef.current === refreshQueue.request) {
        requestLoadRef.current = null;
      }
      if (debounceTimer) clearTimeout(debounceTimer);
      if (activeToastTimerRef.current) clearTimeout(activeToastTimerRef.current);
      window.removeEventListener('online', handleSync);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      authListener?.subscription.unsubscribe();
      void supabase.removeChannel(channel);
    };
  }, [restaurantSlug, restaurantId, loadChamados, requestLoadChamados]);

  // Avanço automático da fila de avisos (popups de 3 segundos sem sobreposição)
  useEffect(() => {
    if (activeToast) return;

    if (toastQueue.length > 0) {
      const nextToast = toastQueue[0];
      setToastQueue((prev) => prev.slice(1));
      setActiveToast(nextToast);

      if (activeToastTimerRef.current) clearTimeout(activeToastTimerRef.current);
      activeToastTimerRef.current = setTimeout(() => {
        if (mountedRef.current) {
          setActiveToast(null);
        }
      }, 3000);
    }
  }, [activeToast, toastQueue]);

  // Limpeza de timer de aviso ao desmontar
  useEffect(() => {
    return () => {
      if (activeToastTimerRef.current) clearTimeout(activeToastTimerRef.current);
    };
  }, []);

  // Handlers operacionais com trava síncrona (actionLockRef) e liberação em finally
  const deliverOrder = useCallback(
    async (itemId: string): Promise<boolean> => {
      if (actionLockRef.current) return false;
      actionLockRef.current = true;
      setBusyActionId(itemId);
      setError(null);

      try {
        const res = await executeDeliverReadyOrder(restaurantSlug, itemId);
        if (!res.success) {
          setError(res.error || 'Não foi possível confirmar entrega.');
          return false;
        }

        // Remove localmente e retira da fila de toasts
        setChamados((prev) => prev.filter((i) => i.id !== itemId));
        setToastQueue((prev) => prev.filter((t) => t.chamadoId !== itemId));
        if (activeToast?.chamadoId === itemId) {
          setActiveToast(null);
        }
        return true;
      } finally {
        actionLockRef.current = false;
        setBusyActionId(null);
      }
    },
    [restaurantSlug, activeToast],
  );

  const attendWaiter = useCallback(
    async (requestId: string): Promise<boolean> => {
      if (actionLockRef.current) return false;
      actionLockRef.current = true;
      setBusyActionId(requestId);
      setError(null);

      try {
        const res = await executeAttendWaiterCall(restaurantSlug, requestId);
        if (!res.success) {
          setError(res.error || 'Não foi possível atender o chamado.');
          return false;
        }

        ++requestIdRef.current;
        setChamados((prev) => prev.map((i) => i.id === requestId ? { ...i, status: 'attended' } : i));
        await requestLoadChamados();
        setToastQueue((prev) => prev.filter((t) => t.chamadoId !== requestId));
        if (activeToast?.chamadoId === requestId) {
          setActiveToast(null);
        }
        return true;
      } finally {
        actionLockRef.current = false;
        setBusyActionId(null);
      }
    },
    [restaurantSlug, activeToast, requestLoadChamados],
  );

  const attendBill = useCallback(
    async (requestId: string): Promise<boolean> => {
      if (actionLockRef.current) return false;
      actionLockRef.current = true;
      setBusyActionId(requestId);
      setError(null);

      try {
        const res = await executeAttendBillRequest(restaurantSlug, requestId);
        if (!res.success) {
          setError(res.error || 'Não foi possível atender o pedido de conta.');
          return false;
        }

        ++requestIdRef.current;
        setChamados((prev) => prev.map((i) => i.id === requestId ? { ...i, status: 'attended' } : i));
        await requestLoadChamados();
        setToastQueue((prev) => prev.filter((t) => t.chamadoId !== requestId));
        if (activeToast?.chamadoId === requestId) {
          setActiveToast(null);
        }
        return true;
      } finally {
        actionLockRef.current = false;
        setBusyActionId(null);
      }
    },
    [restaurantSlug, activeToast, requestLoadChamados],
  );

  const completeService = useCallback(async (requestId: string): Promise<boolean> => {
    if (actionLockRef.current) return false;
    const item = chamadosRef.current.find(i => i.id === requestId);
    if (!item || item.category === 'ready_order' || item.status !== 'attended') return false;
    actionLockRef.current = true;
    ++requestIdRef.current;
    setBusyActionId(requestId);
    setError(null);
    try {
      const result = await executeCompleteServiceCall(restaurantSlug, requestId, item.category === 'bill_request' ? 'bill' : 'waiter');
      if (!result.success) { setError(result.error || 'Não foi possível concluir.'); return false; }
      ++requestIdRef.current;
      setChamados(prev => prev.filter(i => i.id !== requestId));
      return true;
    } finally {
      actionLockRef.current = false;
      setBusyActionId(null);
      await requestLoadChamados();
    }
  }, [restaurantSlug, requestLoadChamados]);

  const summary = calculateChamadosSummary(chamados);

  return (
    <StaffChamadosContext.Provider
      value={{
        chamados,
        summary,
        totalPendingCount: summary.totalPendingCount,
        loading,
        error,
        busyActionId,
        refresh: loadChamados,
        deliverOrder,
        attendWaiter,
        attendBill,
        completeService,
      }}
    >
      {/* Popup compacto deslizando do topo (Toast Notification de 3 segundos) */}
      {activeToast && (
        <div
          role="status"
          aria-live="polite"
          onClick={() => {
            if (!location.pathname.includes('/chamados')) {
              navigate(`/${restaurantSlug}/equipe/chamados`);
            }
            setActiveToast(null);
          }}
          className="fixed top-3 left-1/2 -translate-x-1/2 z-50 w-[92%] max-w-md bg-[#2B1D17] text-white rounded-2xl shadow-2xl p-3.5 border border-amber-900/30 flex items-center justify-between gap-3 cursor-pointer transition-all transform animate-bounce-short hover:opacity-95"
          style={{
            boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.4), 0 8px 10px -6px rgba(0, 0, 0, 0.3)',
          }}
        >
          <div className="flex items-center gap-3 min-w-0">
            <div
              className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                activeToast.category === 'ready_order'
                  ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                  : activeToast.category === 'bill_request'
                    ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                    : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
              }`}
            >
              {activeToast.category === 'ready_order' ? (
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 4v2" />
                  <path d="M4 18h16a1 1 0 0 0 1-1A9 9 0 0 0 3 17a1 1 0 0 0 1 1z" />
                  <path d="M2 20h20" />
                </svg>
              ) : activeToast.category === 'bill_request' ? (
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
              <p className="text-xs font-bold text-white truncate">{activeToast.message}</p>
              <p className="text-[10px] text-amber-200/80 truncate">Toque para visualizar na Central de Chamados</p>
            </div>
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setActiveToast(null);
            }}
            className="p-1 rounded-lg text-zinc-400 hover:text-white transition shrink-0 cursor-pointer"
            aria-label="Fechar notificação"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      )}
      {children}
    </StaffChamadosContext.Provider>
  );
}

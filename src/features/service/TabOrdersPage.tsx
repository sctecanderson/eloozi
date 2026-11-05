import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { supabase } from '../../lib/supabase';
import { useTableContext, getTableQueryString } from '../tables/useTableContext';
import { useRestaurant } from '../restaurants/RestaurantProvider';
import { usePublicMenu } from '../menu/PublicMenuProvider';
import { getGuestTabState } from './guestTab';
import type { GuestTabState } from './guestTab';
import {
    getGuestSessionState,
    issueGuestConfirmationCode,
    startGuestSession,
} from '../tables/guestSessions';
import type {
    GuestConfirmationCode,
    GuestSession,
} from '../tables/guestSessions';
import { ServiceActionPopup, type ServiceActionType } from './ServiceActionPopup';
import { groupTabConsumptionItems } from './tabGrouping';
import { getWaiterRequestState } from './serviceRequests';
import {
    secondsUntil,
    formatCountdown,
    formatConfirmationDigits,
    getActiveTabStep,
    isWaiterCallActive,
} from './customerTabVisual';

const currency = new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
});

/**
 * Componente principal da página de Comanda.
 * Valida a mesa e usa key de contexto exclusivo no componente interno
 * para garantir destruição e recriação imediata de todo estado local ao mudar de mesa/restaurante.
 */
export function TabOrdersPage() {
    const { restaurantSlug = '' } = useParams();
    const table = useTableContext();
    const { restaurant } = useRestaurant();

    const hasValidTable = table.status === 'unverified';
    const tableNumber = hasValidTable ? Number(table.tableNumber) : null;
    const tableQuery = hasValidTable ? getTableQueryString(table) : '';

    if (table.status === 'expired') {
        return (
            <div className="tab-orders-page">
                <header className="tab-orders-header">
                    <div className="tab-orders-title-row">
                        <h1 className="tab-orders-title">Comanda Digital</h1>
                        <span className="tab-orders-status-badge" style={{ backgroundColor: '#fee2e2', color: '#991b1b' }}>
                            Atendimento Indisponível
                        </span>
                    </div>
                </header>

                <div className="tab-hero-card">
                    <div className="tab-hero-icon" style={{ background: '#fee2e2', color: '#dc2626' }}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <circle cx="12" cy="12" r="10" />
                            <line x1="15" y1="9" x2="9" y2="15" />
                            <line x1="9" y1="9" x2="15" y2="15" />
                        </svg>
                    </div>
                    <h2>Atendimento temporariamente indisponível</h2>
                    <p>
                        Os serviços digitais deste estabelecimento estão suspensos no momento. Por gentileza, solicite atendimento diretamente à equipe presencial.
                    </p>
                    <Link
                        to={`/${restaurantSlug}`}
                        className="tab-hero-primary-btn"
                        style={{ maxWidth: '280px', minHeight: '44px', fontSize: '14px', textDecoration: 'none' }}
                    >
                        Ver Cardápio Digital
                    </Link>
                </div>
            </div>
        );
    }

    if (table.status === 'loading') {
        return (
            <div className="tab-orders-page">
                <div className="tab-hero-card" style={{ padding: '48px 16px', textAlign: 'center' }}>
                    <p role="status" className="text-xs opacity-60">
                        Identificando sua mesa pelo QR Code…
                    </p>
                </div>
            </div>
        );
    }

    if (table.status === 'invalid') {
        return (
            <div className="tab-orders-page">
                <header className="tab-orders-header">
                    <div className="tab-orders-title-row">
                        <h1 className="tab-orders-title">Comanda Digital</h1>
                        <span className="tab-orders-status-badge" style={{ backgroundColor: '#fee2e2', color: '#991b1b' }}>
                            Mesa Inválida
                        </span>
                    </div>

                    <div className="tab-orders-meta-row">
                        <span className="tab-meta-item">
                            <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                                <path d="M9 6a3 3 0 11-6 0 3 3 0 016 0zM17 6a3 3 0 11-6 0 3 3 0 016 0zM12.93 17c.046-.327.07-.66.07-1a6.97 6.97 0 00-1.5-4.33A5 5 0 0119 16v1h-6.07zM6 11a5 5 0 015 5v1H1v-1a5 5 0 015-5z" />
                            </svg>
                            {restaurant?.name || 'Restaurante'}
                        </span>
                    </div>
                </header>

                <div className="tab-hero-card" style={{ borderColor: '#fca5a5', background: '#fff5f5' }}>
                    <div className="tab-hero-icon" style={{ background: '#fee2e2', color: '#b91c1c' }}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="10" />
                            <line x1="12" y1="8" x2="12" y2="12" />
                            <line x1="12" y1="16" x2="12.01" y2="16" />
                        </svg>
                    </div>
                    <h2 style={{ color: '#991b1b' }}>Mesa não encontrada ou inativa</h2>
                    <p style={{ color: '#7f1d1d' }}>
                        {table.reason || 'Não foi possível validar a mesa no estabelecimento. Verifique a conexão ou aponte novamente a câmera para o QR Code da mesa.'}
                    </p>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', width: '100%', maxWidth: '280px' }}>
                        <button
                            type="button"
                            className="tab-hero-primary-btn"
                            onClick={() => (table.retry ? table.retry() : window.location.reload())}
                        >
                            Tentar Novamente
                        </button>
                        <Link
                            to={`/${restaurantSlug}`}
                            style={{ fontSize: '13px', color: '#7f1d1d', textDecoration: 'underline', textAlign: 'center', marginTop: '4px' }}
                        >
                            Ver Cardápio Digital
                        </Link>
                    </div>
                </div>

                <nav className="home-bottom-nav" aria-label="Ações da mesa">
                    <Link to={`/${restaurantSlug}`}>
                        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                            <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" />
                        </svg>
                        <span>Início</span>
                    </Link>

                    <button
                        type="button"
                        disabled
                        style={{ opacity: 0.45, cursor: 'not-allowed' }}
                        title="Identifique sua mesa por QR Code primeiro"
                    >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                        </svg>
                        <span>Chamar Garçom</span>
                    </button>

                    <Link to={`/${restaurantSlug}/comanda`} className="active" aria-current="page">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M4 2v20l3-2 3 2 3-2 3 2 3-2 3 2V2l-3 2-3-2-3 2-3-2-3 2-3-2z" />
                            <line x1="8" y1="8" x2="16" y2="8" />
                            <line x1="8" y1="12" x2="16" y2="12" />
                            <line x1="8" y1="16" x2="12" y2="16" />
                        </svg>
                        <span>Comanda</span>
                    </Link>
                </nav>
            </div>
        );
    }

    if (!hasValidTable || tableNumber === null) {
        return (
            <div className="tab-orders-page">
                <header className="tab-orders-header">
                    <div className="tab-orders-title-row">
                        <h1 className="tab-orders-title">Comanda Digital</h1>
                        <span className="tab-orders-status-badge">
                            Mesa Não Identificada
                        </span>
                    </div>

                    <div className="tab-orders-meta-row">
                        <span className="tab-meta-item">
                            <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                                <path d="M9 6a3 3 0 11-6 0 3 3 0 016 0zM17 6a3 3 0 11-6 0 3 3 0 016 0zM12.93 17c.046-.327.07-.66.07-1a6.97 6.97 0 00-1.5-4.33A5 5 0 0119 16v1h-6.07zM6 11a5 5 0 015 5v1H1v-1a5 5 0 015-5z" />
                            </svg>
                            {restaurant?.name || 'Restaurante'}
                        </span>
                        <span className="tab-meta-divider">/</span>
                        <span className="tab-meta-item">
                            <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" />
                            </svg>
                            QR Code Necessário
                        </span>
                    </div>
                </header>

                <div className="tab-hero-card">
                    <div className="tab-hero-icon" style={{ background: '#f3eee6', color: '#705e50' }}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="3" y="3" width="7" height="7" />
                            <rect x="14" y="3" width="7" height="7" />
                            <rect x="3" y="14" width="7" height="7" />
                            <rect x="14" y="14" width="7" height="7" />
                        </svg>
                    </div>
                    <h2>Mesa não identificada</h2>
                    <p>
                        Para abrir sua comanda, chamar o garçom e acompanhar seus pedidos em tempo real, aponte a câmera do seu celular para o QR Code da sua mesa.
                    </p>
                    <Link
                        to={`/${restaurantSlug}`}
                        className="tab-hero-primary-btn"
                        style={{ maxWidth: '280px', minHeight: '44px', fontSize: '14px', textDecoration: 'none' }}
                    >
                        Ver Cardápio Digital
                    </Link>
                </div>

                <nav className="home-bottom-nav" aria-label="Ações da mesa">
                    <Link to={`/${restaurantSlug}`}>
                        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                            <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" />
                        </svg>
                        <span>Início</span>
                    </Link>

                    <button
                        type="button"
                        disabled
                        style={{ opacity: 0.45, cursor: 'not-allowed' }}
                        title="Identifique sua mesa por QR Code primeiro"
                    >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                        </svg>
                        <span>Chamar Garçom</span>
                    </button>

                    <Link to={`/${restaurantSlug}/comanda`} className="active" aria-current="page">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M4 2v20l3-2 3 2 3-2 3 2 3-2 3 2V2l-3 2-3-2-3 2-3-2-3 2-3-2z" />
                            <line x1="8" y1="8" x2="16" y2="8" />
                            <line x1="8" y1="12" x2="16" y2="12" />
                            <line x1="8" y1="16" x2="12" y2="16" />
                        </svg>
                        <span>Comanda</span>
                    </Link>
                </nav>
            </div>
        );
    }

    return (
        <TabOrdersContent
            key={`${restaurantSlug}:${tableNumber}`}
            restaurantSlug={restaurantSlug}
            tableNumber={tableNumber}
            tableQuery={tableQuery}
        />
    );
}

interface TabFlowStepsProps {
    currentStep: 1 | 2 | 3;
}

function TabFlowSteps({ currentStep }: TabFlowStepsProps) {
    return (
        <div className="tab-flow-steps">
            <div className="tab-flow-step">
                <span className={`tab-flow-step-num ${currentStep === 1 ? 'active' : currentStep > 1 ? 'done' : ''}`}>
                    {currentStep > 1 ? '✓' : '1'}
                </span>
                <span className={`tab-flow-step-label ${currentStep === 1 ? 'active-pill' : ''}`}>
                    Aguardando o garçom confirmar
                </span>
            </div>
            <div className="tab-flow-divider" />
            <div className="tab-flow-step">
                <span className={`tab-flow-step-num ${currentStep === 2 ? 'active' : currentStep > 2 ? 'done' : ''}`}>
                    {currentStep > 2 ? '✓' : '2'}
                </span>
                <span className={`tab-flow-step-label ${currentStep === 2 ? 'active-pill' : ''}`}>
                    Garçom inicia o atendimento
                </span>
            </div>
            <div className="tab-flow-divider" />
            <div className="tab-flow-step">
                <span className={`tab-flow-step-num ${currentStep === 3 ? 'active' : ''}`}>
                    3
                </span>
                <span className={`tab-flow-step-label ${currentStep === 3 ? 'active-pill' : ''}`}>
                    Pedidos em registro
                </span>
            </div>
        </div>
    );
}

interface TabOrdersContentProps {
    restaurantSlug: string;
    tableNumber: number;
    tableQuery: string;
}

function TabOrdersContent({
    restaurantSlug,
    tableNumber,
    tableQuery,
}: TabOrdersContentProps) {
    const { restaurant } = useRestaurant();
    const { menu } = usePublicMenu();
    const tableLabel = `Mesa ${String(tableNumber).padStart(2, '0')}`;

    const [activeAction, setActiveAction] = useState<ServiceActionType>(null);
    const [tabState, setTabState] = useState<GuestTabState | null>(null);
    const [guestSession, setGuestSession] = useState<GuestSession | null>(null);
    const [confirmationCode, setConfirmationCode] = useState<GuestConfirmationCode | null>(null);
    const [codeRemaining, setCodeRemaining] = useState(0);
    const [isGeneratingCode, setIsGeneratingCode] = useState(false);
    const [hasActiveWaiterCall, setHasActiveWaiterCall] = useState(false);
    const [copyFeedback, setCopyFeedback] = useState<'idle' | 'copied' | 'error'>('idle');

    // Separação entre primeira carga do contexto e sincronização em segundo plano
    const [isInitialLoading, setIsInitialLoading] = useState(true);
    const isInitialLoadingRef = useRef(true);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [syncWarning, setSyncWarning] = useState<string | null>(null);

    const requestVersion = useRef(0);
    const actionVersion = useRef(0);
    const isMountedRef = useRef(true);

    // Coordenação de requisições em trânsito e controle de concorrência
    const isFetchingRef = useRef(false);
    const hasPendingRefreshRef = useRef(false);
    const lastFetchTimeRef = useRef(0);

    // Status do canal Realtime e temporizadores
    const channelStatusRef = useRef<'SUBSCRIBED' | 'DISCONNECTED' | 'CONNECTING'>('CONNECTING');
    const realtimeDebounceTimerRef = useRef<number | null>(null);
    const pollingTimerRef = useRef<number | null>(null);

    const HEARTBEAT_INTERVAL_MS = 30_000;
    const FALLBACK_INTERVAL_MS = 8_000;

    useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
        };
    }, []);

    // Função de busca atômica protegida contra concorrência e respostas obsoletas
    const executeRefresh = useCallback(async () => {
        if (!isMountedRef.current) return;

        if (isFetchingRef.current) {
            // Se já há consulta em andamento, anota necessidade de nova sincronização ao terminar
            hasPendingRefreshRef.current = true;
            return;
        }

        isFetchingRef.current = true;
        hasPendingRefreshRef.current = false;
        const currentReqVersion = ++requestVersion.current;
        const isRequestValid = () => isMountedRef.current && currentReqVersion === requestVersion.current;

        try {
            const [sessionRes, tabRes, waiterRes] = await Promise.all([
                getGuestSessionState(restaurantSlug, tableNumber),
                getGuestTabState(restaurantSlug, tableNumber),
                getWaiterRequestState(restaurantSlug, tableNumber).catch(() => ({ guestSessionId: null, request: null })),
            ]);

            if (isRequestValid()) {
                setGuestSession(sessionRes.session);
                setConfirmationCode(sessionRes.code);
                setCodeRemaining(sessionRes.code ? secondsUntil(sessionRes.code.expires_at) : 0);
                setTabState(tabRes);
                const req = waiterRes?.request;
                setHasActiveWaiterCall(isWaiterCallActive(req));
                if (isInitialLoadingRef.current) {
                    isInitialLoadingRef.current = false;
                    setIsInitialLoading(false);
                }
                setErrorMessage(null);
                setSyncWarning(null);
                lastFetchTimeRef.current = Date.now();
            }
        } catch (err) {
            if (isRequestValid()) {
                const message = err instanceof Error
                    ? err.message
                    : 'Não foi possível carregar as informações da mesa.';

                if (isInitialLoadingRef.current) {
                    isInitialLoadingRef.current = false;
                    setIsInitialLoading(false);
                    setErrorMessage(message);
                } else {
                    setSyncWarning('Não foi possível sincronizar os dados da mesa em tempo real.');
                }
            }
        } finally {
            isFetchingRef.current = false;

            // Se novos eventos foram recebidos durante a consulta, dispara a busca pendente imediatamente
            if (isMountedRef.current && hasPendingRefreshRef.current) {
                hasPendingRefreshRef.current = false;
                void executeRefresh();
            }
        }
    }, [restaurantSlug, tableNumber]);

    const refresh = executeRefresh;

    // Agendamento adaptativo de polling (30s com Realtime ativo vs 8s com Realtime offline)
    const scheduleNextPoll = useCallback(() => {
        if (!isMountedRef.current) return;
        if (pollingTimerRef.current !== null) {
            window.clearTimeout(pollingTimerRef.current);
            pollingTimerRef.current = null;
        }

        // Se a aba estiver oculta, não agenda consultas periódicas
        if (document.hidden) return;

        const delay = channelStatusRef.current === 'SUBSCRIBED'
            ? HEARTBEAT_INTERVAL_MS
            : FALLBACK_INTERVAL_MS;

        pollingTimerRef.current = window.setTimeout(() => {
            pollingTimerRef.current = null;
            if (!isMountedRef.current) return;

            if (!document.hidden) {
                void executeRefresh();
            }
            scheduleNextPoll();
        }, delay);
    }, [executeRefresh]);

    // Agrupamento de eventos Realtime com debounce curto (150ms)
    const scheduleRealtimeRefresh = useCallback(() => {
        if (!isMountedRef.current) return;

        if (document.hidden) {
            hasPendingRefreshRef.current = true;
            return;
        }

        if (realtimeDebounceTimerRef.current !== null) {
            window.clearTimeout(realtimeDebounceTimerRef.current);
        }

        realtimeDebounceTimerRef.current = window.setTimeout(() => {
            realtimeDebounceTimerRef.current = null;
            if (isMountedRef.current) {
                void executeRefresh();
            }
        }, 150);
    }, [executeRefresh]);

    // Carga inicial ao montar o componente ou alterar de mesa
    useEffect(() => {
        void executeRefresh();
    }, [executeRefresh]);

    // Temporizador do código de confirmação
    useEffect(() => {
        if (!confirmationCode || codeRemaining <= 0) return;

        const interval = window.setInterval(() => {
            const next = secondsUntil(confirmationCode.expires_at);
            setCodeRemaining(next);
            if (next <= 0) {
                window.clearInterval(interval);
            }
        }, 1000);

        return () => window.clearInterval(interval);
    }, [confirmationCode, codeRemaining]);

    // Inscrição Realtime no Supabase restrita à mesa atual com fallback e coordenação de visibilidade
    useEffect(() => {
        const userId = tabState?.userId;
        const guestId = tabState?.guestSessionId || guestSession?.id;
        const tabId = tabState?.tabId;

        channelStatusRef.current = 'CONNECTING';

        let channel = supabase.channel(`tab-realtime:${restaurantSlug}:${tableNumber}:${guestId ?? 'session'}`);

        if (userId) {
            channel = channel
                .on('postgres_changes', { event: '*', schema: 'public', table: 'guest_sessions', filter: `user_id=eq.${userId}` }, scheduleRealtimeRefresh);
        }
        if (guestId) {
            channel = channel
                .on('postgres_changes', { event: '*', schema: 'public', table: 'guest_sessions', filter: `id=eq.${guestId}` }, scheduleRealtimeRefresh)
                .on('postgres_changes', { event: '*', schema: 'public', table: 'table_tab_guests', filter: `guest_session_id=eq.${guestId}` }, scheduleRealtimeRefresh);
        }
        if (tabId) {
            channel = channel
                .on('postgres_changes', { event: '*', schema: 'public', table: 'table_tabs', filter: `id=eq.${tabId}` }, scheduleRealtimeRefresh)
                .on('postgres_changes', { event: '*', schema: 'public', table: 'table_tab_items', filter: `table_tab_id=eq.${tabId}` }, scheduleRealtimeRefresh);
        }

        channel = channel.on('postgres_changes', { event: '*', schema: 'public', table: 'table_visits' }, scheduleRealtimeRefresh);

        channel.subscribe((status) => {
            if (!isMountedRef.current) return;

            if (status === 'SUBSCRIBED') {
                const wasDisconnected = channelStatusRef.current !== 'SUBSCRIBED';
                channelStatusRef.current = 'SUBSCRIBED';
                setSyncWarning(null);

                // Se estava desconectado e reconectou, executa sincronização imediata
                if (wasDisconnected && (Date.now() - lastFetchTimeRef.current >= 2_000 || hasPendingRefreshRef.current)) {
                    void executeRefresh();
                }
                scheduleNextPoll();
            } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
                channelStatusRef.current = 'DISCONNECTED';
                scheduleNextPoll(); // Adota polling de fallback mais frequente
            }
        });

        function handleVisibilityChange() {
            if (!isMountedRef.current) return;
            if (!document.hidden) {
                // Ao reabrir a aba: se há atualização pendente ou se passaram mais de 4s da última busca
                const elapsed = Date.now() - lastFetchTimeRef.current;
                if (hasPendingRefreshRef.current || elapsed >= 4_000) {
                    void executeRefresh();
                }
                scheduleNextPoll();
            } else {
                // Aba em segundo plano: pausa o timer periódico
                if (pollingTimerRef.current !== null) {
                    window.clearTimeout(pollingTimerRef.current);
                    pollingTimerRef.current = null;
                }
            }
        }

        function handleOnline() {
            if (!isMountedRef.current) return;
            if (!document.hidden) {
                void executeRefresh();
                scheduleNextPoll();
            }
        }

        document.addEventListener('visibilitychange', handleVisibilityChange);
        window.addEventListener('online', handleOnline);

        // Dispara o primeiro agendamento adaptativo de polling
        scheduleNextPoll();

        return () => {
            if (pollingTimerRef.current !== null) {
                window.clearTimeout(pollingTimerRef.current);
                pollingTimerRef.current = null;
            }
            if (realtimeDebounceTimerRef.current !== null) {
                window.clearTimeout(realtimeDebounceTimerRef.current);
                realtimeDebounceTimerRef.current = null;
            }
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            window.removeEventListener('online', handleOnline);
            void supabase.removeChannel(channel);
        };
    }, [
        tabState?.userId,
        tabState?.guestSessionId,
        tabState?.tabId,
        guestSession?.id,
        restaurantSlug,
        tableNumber,
        scheduleRealtimeRefresh,
        scheduleNextPoll,
        executeRefresh,
    ]);

    // Geração de comanda protegida contra concorrência e desmontagem
    async function handleGenerateCode() {
        if (isGeneratingCode) return;
        setIsGeneratingCode(true);
        setErrorMessage(null);

        const currentAction = ++actionVersion.current;
        const isActionValid = () => isMountedRef.current && currentAction === actionVersion.current;

        try {
            const session = await startGuestSession(restaurantSlug, tableNumber);
            if (!isActionValid()) return;

            setGuestSession(session);

            if (session.status === 'pending') {
                if (!isActionValid()) return;
                const code = await issueGuestConfirmationCode(session.id);
                if (!isActionValid()) return;

                setConfirmationCode(code);
                setCodeRemaining(secondsUntil(code.expires_at));
            }

            if (isActionValid()) {
                refresh();
            }
        } catch (err) {
            if (isActionValid()) {
                setErrorMessage(
                    err instanceof Error
                        ? err.message
                        : 'Não foi possível gerar a comanda para o garçom.',
                );
            }
        } finally {
            if (isActionValid()) {
                setIsGeneratingCode(false);
            }
        }
    }

    function handleResetTab() {
        setTabState(null);
        setGuestSession(null);
        setConfirmationCode(null);
        void handleGenerateCode();
    }

    // Cópia estrita dos 6 dígitos numéricos sem espaço com feedback visual
    async function handleCopyCode() {
        if (!confirmationCode?.code) return;
        const codeInfo = formatConfirmationDigits(confirmationCode.code);
        if (!codeInfo.raw) return;
        try {
            await navigator.clipboard.writeText(codeInfo.raw);
            setCopyFeedback('copied');
            setTimeout(() => {
                if (isMountedRef.current) setCopyFeedback('idle');
            }, 2500);
        } catch {
            setCopyFeedback('error');
            setTimeout(() => {
                if (isMountedRef.current) setCopyFeedback('idle');
            }, 3000);
        }
    }

    // =========================================================================
    // MÁQUINA DE ESTADOS MUTUAMENTE EXCLUSIVOS
    // Garante que nunca ocorram exibições sobrepostas ou contraditórias na tela.
    // =========================================================================

    // 1. Identificar se o atendimento ou comanda foi encerrado
    const isRevokedOrClosed =
        tabState?.status === 'closed' ||
        guestSession?.status === 'revoked';

    // 2. Identificar se a sessão é pendente (aguardando garçom confirmar no painel dele)
    const isPendingSession =
        !isRevokedOrClosed &&
        (guestSession?.status === 'pending' ||
            (tabState?.status === 'waiting' && tabState?.guestStatus === 'pending'));

    // 3. Identificar se há código emitido válido (com tempo restante)
    const hasValidCode =
        isPendingSession &&
        !!confirmationCode &&
        codeRemaining > 0;

    // 4. Identificar se a sessão expirou no servidor
    const isExpiredSession =
        !isRevokedOrClosed &&
        (((guestSession?.status as string | undefined) === 'expired') ||
            (tabState?.status === 'hidden' && (guestSession?.status as string | undefined) === 'expired'));

    // 5. Identificar itens reais na comanda vinculada
    const readyTab = tabState?.status === 'ready' ? tabState : null;
    const realItems =
        tabState?.status === 'ready'
            ? tabState.items
            : tabState?.status === 'closed' && tabState.items
                ? tabState.items
                : [];
    const hasRealItems = realItems.length > 0;

    // 6. Identificar se a comanda está vinculada e aberta
    const isTabLinked =
        !isRevokedOrClosed &&
        !isPendingSession &&
        !isExpiredSession &&
        tabState?.status === 'ready';

    // 7. Identificar se a mesa foi confirmada no sistema, aguardando o garçom vincular a comanda
    // IMPORTANTE: Nunca é verdadeiro quando guestStatus for 'pending'!
    const isActiveConfirmed =
        !isRevokedOrClosed &&
        !isPendingSession &&
        !isExpiredSession &&
        !isTabLinked &&
        (guestSession?.status === 'active' ||
            (tabState?.status === 'waiting' && tabState?.guestStatus === 'active'));

    // Determinar o modo único da tela
    type TabScreenMode =
        | 'closed'
        | 'ready'
        | 'active_linked_tab'
        | 'active_waiting_tab'
        | 'pending_with_code'
        | 'pending_no_code'
        | 'initial';

    let mode: TabScreenMode = 'initial';

    if (isRevokedOrClosed) {
        mode = 'closed';
    } else if (isTabLinked) {
        mode = hasRealItems ? 'ready' : 'active_linked_tab';
    } else if (isActiveConfirmed) {
        mode = 'active_waiting_tab';
    } else if (isPendingSession) {
        mode = hasValidCode ? 'pending_with_code' : 'pending_no_code';
    } else {
        mode = 'initial';
    }

    // Auto-geração na chegada caso a mesa ainda não possua código emitido
    useEffect(() => {
        if (!isInitialLoading && mode === 'initial' && !isGeneratingCode && !errorMessage) {
            void handleGenerateCode();
        }
    }, [isInitialLoading, mode, isGeneratingCode, errorMessage]);

    const getProductImage = (name: string) => {
        const found = menu?.products.find((p) =>
            p.name.toLowerCase().includes(name.toLowerCase()) ||
            name.toLowerCase().includes(p.name.toLowerCase())
        );
        return found?.images[0]?.url;
    };


    const getCustomerItemStatus = (item: (typeof realItems)[number]) => {
        if (item.status === 'cancelled') {
            return {
                label: 'Cancelado',
                className: 'tab-order-status-cancelled',
            };
        }

        const prod = item.production_status || 'delivered';
        const station = item.preparation_station || 'kitchen';

        switch (prod) {
            case 'pending':
                return {
                    label: 'Pedido recebido (Aguardando preparo)',
                    className: 'tab-order-status-pending',
                };
            case 'preparing':
                return {
                    label: station === 'bar' ? 'Em preparo no bar' : 'Em preparo na cozinha',
                    className: station === 'bar' ? 'tab-order-status-preparing-bar' : 'tab-order-status-preparing-kitchen',
                };
            case 'ready':
                return {
                    label: 'Pronto! Garçom levando à mesa',
                    className: 'tab-order-status-ready',
                };
            case 'delivered':
            default:
                return {
                    label: 'Pedido entregue',
                    className: 'tab-order-status-delivered',
                };
        }
    };

    const groupedItems = groupTabConsumptionItems(realItems);

    const displayItems = groupedItems.map((group) => {
        const statusInfo = getCustomerItemStatus(group.latestItem);
        return {
            id: group.key,
            name: group.productName,
            isCancelled: group.isCancelled,
            status: statusInfo.label,
            statusClass: statusInfo.className,
            quantity: group.quantity,
            unitPriceInCents: group.unitPriceInCents,
            imageUrl: getProductImage(group.productName),
        };
    });

    const subtotalInCents =
        tabState?.status === 'ready'
            ? tabState.totalInCents
            : tabState?.status === 'closed'
                ? (tabState.totalInCents ?? 0)
                : 0;
    const feePercent = typeof restaurant.serviceFeePercent === 'number' ? restaurant.serviceFeePercent : 10;
    const serviceFeeInCents = feePercent > 0 ? Math.round(subtotalInCents * (feePercent / 100)) : 0;
    const totalInCents = subtotalInCents + serviceFeeInCents;

    const codeDisplay = formatConfirmationDigits(confirmationCode?.code);
    const activeStep = getActiveTabStep(mode);

    // Badge do Header
    const statusBadgeText = isInitialLoading
        ? 'Carregando…'
        : mode === 'closed'
            ? 'Atendimento Encerrado'
            : mode === 'ready'
                ? 'Comanda Aberta'
                : mode === 'active_linked_tab'
                    ? 'Comanda Conectada'
                    : mode === 'active_waiting_tab'
                        ? 'Mesa Confirmada'
                        : 'Aguardando Garçom';

    const statusBadgeClass = `tab-orders-status-badge ${
        mode === 'closed'
            ? 'tab-closed-badge'
            : (mode === 'ready' || mode === 'active_linked_tab')
                ? 'active'
                : 'waiting'
    }`;

    return (
        <div className="tab-orders-page">
            {/* Header da Comanda */}
            <header className="tab-orders-header">
                <div className="tab-orders-title-row">
                    <h1 className="tab-orders-title">Consumo da {tableLabel}</h1>
                    <span className={statusBadgeClass}>
                        <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <circle cx="12" cy="12" r="10" />
                            <polyline points="12 6 12 12 16 14" />
                        </svg>
                        <span>{statusBadgeText}</span>
                    </span>
                </div>

                <div className="tab-orders-meta-row">
                    <span className="tab-meta-item">
                        <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                            <circle cx="9" cy="7" r="4" />
                            <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                        </svg>
                        <span>{tableLabel}</span>
                    </span>
                    <span className="tab-meta-divider">/</span>
                    <span className="tab-meta-item">
                        <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                        </svg>
                        <span>
                            {(mode === 'ready' || mode === 'active_linked_tab') && tabState?.status === 'ready'
                                ? `Comanda: ${tabState.tab.label}`
                                : 'Atendimento Digital'}
                        </span>
                    </span>
                </div>
            </header>

            {/* Aviso discreto de sincronização em segundo plano (mantém a tela intacta) */}
            {syncWarning && !isInitialLoading && !errorMessage && (
                <div style={{
                    background: '#fffbeb',
                    border: '1px solid #fef3c7',
                    borderRadius: '12px',
                    padding: '10px 14px',
                    marginBottom: '16px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    fontSize: '13px',
                    color: '#92400e',
                }}>
                    <span>⚠️ {syncWarning}</span>
                    <button
                        type="button"
                        onClick={refresh}
                        style={{
                            background: '#fef3c7',
                            border: 'none',
                            borderRadius: '6px',
                            padding: '4px 10px',
                            fontSize: '12px',
                            fontWeight: 700,
                            color: '#78350f',
                            cursor: 'pointer',
                        }}
                    >
                        Atualizar
                    </button>
                </div>
            )}

            {/* Estado de Carregamento Inicial (somente na primeira consulta da montagem) */}
            {isInitialLoading && (
                <div className="tab-hero-card">
                    <div className="tab-code-waiting-pulse">
                        <span className="tab-pulse-dot" />
                        <span>Carregando dados da {tableLabel}…</span>
                    </div>
                </div>
            )}

            {/* Falha na Primeira Consulta (com botão de tentar novamente) */}
            {!isInitialLoading && errorMessage && (
                <div className="tab-hero-card" style={{ borderColor: '#fca5a5', background: '#fff5f5' }}>
                    <div className="tab-hero-icon" style={{ background: '#fee2e2', color: '#b91c1c' }}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="10" />
                            <line x1="12" y1="8" x2="12" y2="12" />
                            <line x1="12" y1="16" x2="12.01" y2="16" />
                        </svg>
                    </div>
                    <h2 style={{ color: '#991b1b' }}>Falha ao conectar</h2>
                    <p style={{ color: '#7f1d1d' }}>{errorMessage}</p>
                    <button
                        type="button"
                        className="tab-hero-primary-btn"
                        onClick={refresh}
                    >
                        Tentar Novamente
                    </button>
                </div>
            )}

            {/* CONTEÚDO MUTUAMENTE EXCLUSIVO (sem piscar nem sobrepor cards) */}
            {!isInitialLoading && !errorMessage && (
                <>
                    {/* ESTADO PENDENTE / APRESENTAR AO GARÇOM */}
                    {(mode === 'pending_with_code' || mode === 'pending_no_code' || mode === 'initial') && (
                        <div className="tab-hero-card tab-code-card-ref">
                            <div className="tab-card-grid-icon">
                                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                    <rect x="3" y="3" width="7" height="7" rx="2" />
                                    <rect x="14" y="3" width="7" height="7" rx="2" />
                                    <rect x="3" y="14" width="7" height="7" rx="2" />
                                    <rect x="14" y="14" width="7" height="7" rx="2" />
                                </svg>
                            </div>

                            <h2 className="tab-card-title">Informe este código ao garçom</h2>
                            <p className="tab-card-description">
                                O garçom inserirá este número no sistema para iniciar o atendimento e começar a registrar os pedidos da sua mesa.
                            </p>

                            <div className="tab-dashed-code-box">
                                <span className="tab-dashed-digits">
                                    {confirmationCode?.code
                                        ? `${codeDisplay.group1} ${codeDisplay.group2}`
                                        : isGeneratingCode
                                            ? '--- ---'
                                            : '000 000'}
                                </span>
                                <button
                                    type="button"
                                    onClick={handleCopyCode}
                                    className="tab-copy-code-btn"
                                    title="Copiar código"
                                    aria-label="Copiar código numérico"
                                    disabled={!confirmationCode?.code}
                                >
                                    {copyFeedback === 'copied' ? (
                                        <svg className="w-5 h-5 text-emerald-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                            <polyline points="20 6 9 17 4 12" />
                                        </svg>
                                    ) : (
                                        <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                                        </svg>
                                    )}
                                </button>
                            </div>

                            {copyFeedback === 'copied' && (
                                <span className="tab-copy-feedback-success" role="status">
                                    ✓ Código copiado (somente números)!
                                </span>
                            )}
                            {copyFeedback === 'error' && (
                                <span className="tab-copy-feedback-error" role="alert">
                                    Não foi possível copiar automaticamente.
                                </span>
                            )}

                            <div className="tab-code-timer-badge">
                                <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <circle cx="12" cy="12" r="10" />
                                    <polyline points="12 6 12 12 16 14" />
                                </svg>
                                <span>Válido por:</span>
                                <strong>{formatCountdown(codeRemaining)}</strong>
                            </div>

                            <TabFlowSteps currentStep={1} />

                            <div className="tab-lamp-info-box">
                                <div className="tab-lamp-icon-circle">
                                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M9 18h6" />
                                        <path d="M10 22h4" />
                                        <path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14" />
                                    </svg>
                                </div>
                                <p className="tab-lamp-text">
                                    Assim que o garçom confirmar, você poderá acompanhar todos os pedidos da mesa em tempo real.
                                </p>
                            </div>

                            <hr className="tab-card-divider" />

                            <button
                                type="button"
                                className="tab-card-renew-btn"
                                onClick={handleGenerateCode}
                                disabled={isGeneratingCode}
                            >
                                <svg className={`w-4 h-4 ${isGeneratingCode ? 'animate-spin' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                                </svg>
                                <span>{isGeneratingCode ? 'Gerando novo código…' : 'Gerar novo código'}</span>
                            </button>
                        </div>
                    )}

                    {/* ESTADO: Presença Confirmada (Sessão Active) -> Aguardando Garçom Vincular Comanda */}
                    {mode === 'active_waiting_tab' && (
                        <div className="tab-hero-card tab-code-card-ref">
                            <div className="tab-card-grid-icon" style={{ background: '#ecfdf5', color: '#059669' }}>
                                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                    <polyline points="20 6 9 17 4 12" />
                                </svg>
                            </div>

                            <h2 className="tab-card-title">Presença Confirmada!</h2>
                            <p className="tab-card-description">
                                {tabState?.assignedWaiterName ? (
                                    <>
                                        O garçom <strong>{tabState.assignedWaiterName}</strong> já confirmou sua mesa no sistema. Ele está preparando sua comanda e logo começará a lançar os pedidos.
                                    </>
                                ) : (
                                    'O garçom já confirmou sua mesa no sistema. Ele está preparando sua comanda e logo começará a lançar os pedidos.'
                                )}
                            </p>

                            <TabFlowSteps currentStep={2} />

                            <div className="tab-lamp-info-box">
                                <div className="tab-lamp-icon-circle">
                                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M9 18h6" />
                                        <path d="M10 22h4" />
                                        <path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14" />
                                    </svg>
                                </div>
                                <p className="tab-lamp-text">
                                    O garçom iniciou seu atendimento. Em instantes sua comanda estará conectada.
                                </p>
                            </div>

                            <div className="tab-code-waiting-pulse">
                                <span className="tab-pulse-dot" />
                                <span>Sincronizando com o atendimento…</span>
                            </div>
                        </div>
                    )}

                    {/* ESTADO 3: Comanda Vinculada (Sessão Active + Comanda Aberta) -> Aguardando Primeiro Pedido */}
                    {mode === 'active_linked_tab' && (
                        <div className="tab-hero-card tab-code-card-ref">
                            <div className="tab-card-grid-icon" style={{ background: '#ecfdf5', color: '#059669' }}>
                                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                    <polyline points="20 6 9 17 4 12" />
                                </svg>
                            </div>

                            <h2 className="tab-card-title">Comanda Conectada!</h2>
                            <p className="tab-card-description">
                                {tabState?.assignedWaiterName ? (
                                    <>
                                        Sua comanda foi conectada pelo garçom <strong>{tabState.assignedWaiterName}</strong>. Os pedidos estão sendo registrados e aparecerão aqui em tempo real.
                                    </>
                                ) : (
                                    'Sua comanda foi conectada com sucesso. Os pedidos estão sendo registrados e aparecerão aqui em tempo real.'
                                )}
                            </p>

                            <TabFlowSteps currentStep={3} />

                            <div className="tab-lamp-info-box">
                                <div className="tab-lamp-icon-circle">
                                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M9 18h6" />
                                        <path d="M10 22h4" />
                                        <path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14" />
                                    </svg>
                                </div>
                                <p className="tab-lamp-text">
                                    Assim que os pedidos forem registrados pelo garçom, seu consumo detalhado será exibido aqui automaticamente.
                                </p>
                            </div>

                            <div className="tab-code-waiting-pulse">
                                <span className="tab-pulse-dot" />
                                <span>Aguardando lançamento dos pedidos…</span>
                            </div>

                            <div style={{ marginTop: '16px', display: 'flex', justifyContent: 'center', width: '100%' }}>
                                <Link
                                    to={`/${restaurantSlug}${tableQuery}`}
                                    className="tab-hero-primary-btn"
                                    style={{ maxWidth: '240px', minHeight: '44px', fontSize: '14px', textDecoration: 'none' }}
                                >
                                    Ver Cardápio
                                </Link>
                            </div>
                        </div>
                    )}

                    {/* ESTADO 4: Comanda Pronta COM Itens -> Acompanhamento dos Pedidos / Consumo */}
                    {mode === 'ready' && (
                        <section className="tab-orders-section">
                            <div className="tab-orders-section-heading">
                                <h2>Pedidos da Mesa</h2>
                                <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className="clock-icon">
                                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" />
                                </svg>
                            </div>

                            <ul className="tab-orders-list">
                                        {displayItems.map((item) => {
                                            const isCancelled = item.isCancelled;
                                            return (
                                                <li
                                                    key={item.id}
                                                    className={`tab-order-item ${isCancelled ? 'tab-order-item-cancelled' : ''}`}
                                                >
                                                    <div className={`tab-order-avatar ${isCancelled ? 'tab-order-avatar-cancelled' : ''}`}>
                                                        {item.imageUrl ? (
                                                            <img src={item.imageUrl} alt={item.name} loading="lazy" />
                                                        ) : (
                                                            <span className="tab-order-avatar-fallback">🍽️</span>
                                                        )}
                                                    </div>

                                                    <div className="tab-order-details">
                                                        <span className={`tab-order-name ${isCancelled ? 'line-through text-gray-400' : ''}`}>
                                                            {item.name}
                                                        </span>
                                                        <span className={`tab-order-status ${item.statusClass}`}>
                                                            {item.status}
                                                        </span>
                                                    </div>

                                                    <div className="tab-order-pricing">
                                                        <div className="tab-order-price-row">
                                                            <span className={`tab-order-qty ${isCancelled ? 'line-through text-gray-400' : ''}`}>
                                                                {item.quantity}x
                                                            </span>
                                                            <strong className={`tab-order-price ${isCancelled ? 'line-through text-gray-400 font-normal' : ''}`}>
                                                                {currency.format((item.unitPriceInCents * item.quantity) / 100)}
                                                            </strong>
                                                        </div>
                                                        {item.quantity > 1 && (
                                                            <span className={`tab-order-unit-price ${isCancelled ? 'line-through text-gray-400' : ''}`}>
                                                                {currency.format(item.unitPriceInCents / 100)} cada
                                                            </span>
                                                        )}
                                                    </div>
                                                </li>
                                            );
                                        })}
                                    </ul>

                                    <div className="tab-orders-summary">
                                        <div className="tab-summary-row">
                                            <span>Subtotal</span>
                                            <strong>{currency.format(subtotalInCents / 100)}</strong>
                                        </div>
                                        {feePercent > 0 && (
                                            <div className="tab-summary-row">
                                                <span>Taxa de Serviço ({feePercent}% - opcional)</span>
                                                <strong>{currency.format(serviceFeeInCents / 100)}</strong>
                                            </div>
                                        )}
                                        <div className="tab-summary-row total">
                                            <span>Total</span>
                                            <strong className="tab-grand-total">{currency.format(totalInCents / 100)}</strong>
                                        </div>
                                    </div>

                                    <div className="tab-orders-cta-block">
                                        <button
                                            type="button"
                                            className="tab-request-bill-btn"
                                            onClick={() => setActiveAction('bill')}
                                        >
                                            Solicitar a Conta
                                        </button>
                                    </div>
                        </section>
                    )}

                    {/* ESTADO 6: Conta Encerrada pelo Garçom */}
                    {mode === 'closed' && (
                        <div className="tab-closed-box">
                            <div className="closed-icon">✓</div>
                            <h2>Atendimento Encerrado</h2>
                            <p>
                                A conta desta mesa foi encerrada pela equipe. Agradecemos muito pela sua visita!
                            </p>
                            <button
                                type="button"
                                className="tab-hero-primary-btn"
                                onClick={handleResetTab}
                                disabled={isGeneratingCode}
                            >
                                {isGeneratingCode ? 'Iniciando…' : 'Abrir Nova Comanda'}
                            </button>
                        </div>
                    )}
                </>
            )}

            {/* Barra Inferior */}
            <nav className="home-bottom-nav" aria-label="Ações da mesa">
                <Link to={`/${restaurantSlug}${tableQuery}`}>
                    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" />
                    </svg>
                    <span>Início</span>
                </Link>

                <button
                    type="button"
                    onClick={() => setActiveAction('waiter')}
                >
                    <div className="relative inline-flex items-center justify-center">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                        </svg>
                        {hasActiveWaiterCall && (
                            <span
                                className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-rose-600 rounded-full border-2 border-white dark:border-zinc-900 shadow-sm"
                                aria-label="Chamado ativo"
                            />
                        )}
                    </div>
                    <span>Chamar Garçom</span>
                </button>

                <Link to={`/${restaurantSlug}/comanda${tableQuery}`} className="active" aria-current="page">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M4 2v20l3-2 3 2 3-2 3 2 3-2 3 2V2l-3 2-3-2-3 2-3-2-3 2-3-2z" />
                        <line x1="8" y1="8" x2="16" y2="8" />
                        <line x1="8" y1="12" x2="16" y2="12" />
                        <line x1="8" y1="16" x2="12" y2="16" />
                    </svg>
                    <span>Comanda</span>
                </Link>
            </nav>

            <ServiceActionPopup
                isOpen={!!activeAction}
                mode={activeAction}
                onClose={() => setActiveAction(null)}
            />
        </div>
    );
}

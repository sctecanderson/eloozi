import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link, useParams, useNavigate } from 'react-router';
import { supabase } from '../../lib/supabase';
import { useRestaurant } from '../restaurants/RestaurantProvider';
import { ThemeToggleButton } from '../theme/ThemeToggleButton';
import {
  fetchActiveKdsItems,
  advanceKdsItemStatus,
  subscribeToKdsItems,
  type KdsItem,
  type KdsFilterStation,
  type ProductionStatus,
} from './kdsService';
import { KdsItemCard } from './KdsItemCard';
import { isSoundEnabled, playKdsNewOrderSound } from '../../lib/soundAlerts';
import { SoundSettingsControl } from '../alerts/SoundSettingsControl';
import { useScreenWakeLock } from '../../lib/useScreenWakeLock';

export function KdsPage() {
  const { restaurantSlug: paramSlug } = useParams<{ restaurantSlug: string }>();
  const { restaurant } = useRestaurant();
  const slug = paramSlug || restaurant.slug;

  const [items, setItems] = useState<KdsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [filterStation, setFilterStation] = useState<KdsFilterStation>('all');
  const [connectionStatus, setConnectionStatus] = useState<'SUBSCRIBED' | 'DISCONNECTED' | 'CONNECTING'>('CONNECTING');
  const [mutatingItemId, setMutatingItemId] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(() => new Date());
  const [soundActive, setSoundActive] = useState(() => isSoundEnabled());
  const { isWakeLockActive, isSupported: isWakeLockSupported } = useScreenWakeLock(true);
  const navigate = useNavigate();
  const [isExitModalOpen, setIsExitModalOpen] = useState(false);
  const [exitPassword, setExitPassword] = useState('');
  const [showExitPassword, setShowExitPassword] = useState(false);
  const [exitError, setExitError] = useState<string | null>(null);
  const [exitLoading, setExitLoading] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const exitInputRef = useRef<HTMLInputElement>(null);

  // Alternar tela cheia nativa (Fullscreen API)
  const toggleFullscreen = useCallback(async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch (err) {
      console.error('Falha ao alternar tela cheia:', err);
    }
  }, []);

  // Monitorar evento fullscreenchange
  useEffect(() => {
    const handleFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    document.addEventListener('webkitfullscreenchange', handleFsChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFsChange);
      document.removeEventListener('webkitfullscreenchange', handleFsChange);
    };
  }, []);

  // Foco automático e seleção do input ao abrir o modal de saída
  useEffect(() => {
    if (isExitModalOpen) {
      const timer = setTimeout(() => {
        exitInputRef.current?.focus();
        exitInputRef.current?.select();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isExitModalOpen]);

  const isMountedRef = useRef(true);

  // Sincronização do estado de som via eventos globais
  useEffect(() => {
    const handleSoundChange = (e: Event) => {
      const custom = e as CustomEvent<{ enabled?: boolean }>;
      if (custom.detail && typeof custom.detail.enabled === 'boolean') {
        setSoundActive(custom.detail.enabled);
      } else {
        setSoundActive(isSoundEnabled());
      }
    };
    window.addEventListener('elozi:sound-setting-changed', handleSoundChange);
    return () => {
      window.removeEventListener('elozi:sound-setting-changed', handleSoundChange);
    };
  }, []);

  // Contagem reativa de pedidos pendentes aguardando início de preparo
  const pendingCount = useMemo(
    () => items.filter((item) => item.production_status === 'pending').length,
    [items]
  );
  const hasPendingOrders = pendingCount > 0;

  // Loop contínuo de alarme (estilo iFood) enquanto houver pedido pendente
  useEffect(() => {
    if (!hasPendingOrders || !soundActive) return;

    // Disparo imediato ao entrar no estado pendente
    playKdsNewOrderSound();

    // Repetição contínua a cada 4500ms (4.5s) até que todos os itens saiam de 'pending' ou som seja silenciado
    const interval = window.setInterval(() => {
      playKdsNewOrderSound();
    }, 4500);

    return () => {
      window.clearInterval(interval);
    };
  }, [hasPendingOrders, soundActive]);

  // Relógio digital em tempo real
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Carregamento de itens
  const loadItems = useCallback(async (isInitial = false) => {
    if (!slug) return;
    if (isInitial) setLoading(true);

    try {
      const activeItems = await fetchActiveKdsItems(slug);
      if (isMountedRef.current) {
        setItems(activeItems);
        setErrorMessage(null);
      }
    } catch (err) {
      if (isMountedRef.current) {
        const msg = err instanceof Error ? err.message : 'Falha ao sincronizar pedidos da esteira.';
        setErrorMessage(msg);
      }
    } finally {
      if (isMountedRef.current && isInitial) {
        setLoading(false);
      }
    }
  }, [slug]);

  // Carga inicial e subscrição Realtime
  useEffect(() => {
    if (restaurant.subscriptionPlan === 'basic') {
      setLoading(false);
      return;
    }

    isMountedRef.current = true;
    void loadItems(true);

    if (!restaurant.id) return;

    const unsubscribe = subscribeToKdsItems(
      restaurant.id,
      () => {
        void loadItems(false);
      },
      (status) => {
        if (isMountedRef.current) {
          setConnectionStatus(status);
        }
      }
    );

    return () => {
      isMountedRef.current = false;
      unsubscribe();
    };
  }, [restaurant.id, restaurant.subscriptionPlan, loadItems]);

  // Avanço do estado de produção
  const handleAdvanceStatus = async (item: KdsItem, nextStatus: ProductionStatus) => {
    if (mutatingItemId) return;
    setMutatingItemId(item.id);
    setErrorMessage(null);

    // Atualização otimista local
    setItems((prev) =>
      prev
        .map((it) => (it.id === item.id ? { ...it, production_status: nextStatus } : it))
        .filter((it) => it.production_status !== 'delivered')
    );

    const result = await advanceKdsItemStatus(slug, item.id, nextStatus);

    if (!result.success) {
      setErrorMessage(result.error || 'Erro ao atualizar pedido.');
      // Reverte recarregando
      await loadItems(false);
    } else {
      // Recarrega silenciosamente para garantir sincronização de timestamps
      void loadItems(false);
    }

    setMutatingItemId(null);
  };

  // Filtragem por estação
  const filteredItems = useMemo(() => {
    if (filterStation === 'all') return items;
    return items.filter((item) => item.preparation_station === filterStation);
  }, [items, filterStation]);

  // Contagens por estação para badges das pílulas
  const stationCounts = useMemo(() => {
    let all = items.length;
    let kitchen = 0;
    let bar = 0;
    for (const item of items) {
      if (item.preparation_station === 'kitchen') kitchen++;
      else if (item.preparation_station === 'bar') bar++;
    }
    return { all, kitchen, bar };
  }, [items]);

  // Separação em colunas Kanban
  const pendingItems = useMemo(
    () => filteredItems.filter((i) => i.production_status === 'pending'),
    [filteredItems]
  );
  const preparingItems = useMemo(
    () => filteredItems.filter((i) => i.production_status === 'preparing'),
    [filteredItems]
  );
  const readyItems = useMemo(
    () => filteredItems.filter((i) => i.production_status === 'ready'),
    [filteredItems]
  );

  // Trava de segurança com senha/PIN para sair do KDS
  const handleConfirmExit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = exitPassword.trim();
    if (!trimmed) {
      setExitError('Informe a senha do administrador ou PIN.');
      return;
    }

    setExitLoading(true);
    setExitError(null);

    const cleanExitAndNavigate = async () => {
      if (document.fullscreenElement) {
        try {
          await document.exitFullscreen();
        } catch {}
      }
      setIsExitModalOpen(false);
      setExitPassword('');
      setExitError(null);
      navigate(`/${slug}/admin`);
    };

    try {
      // 1. PIN personalizado salvo localmente para o KDS deste restaurante
      const customPin =
        localStorage.getItem(`elozi_kds_pin_${restaurant.id}`) ||
        localStorage.getItem('elozi_kds_pin');
      if (customPin && trimmed === customPin) {
        await cleanExitAndNavigate();
        return;
      }

      // 2. PINs operacionais padrão ou slug do restaurante
      const standardPins = ['1234', 'admin', 'admin123', '0000', slug.toLowerCase()];
      if (standardPins.includes(trimmed.toLowerCase())) {
        await cleanExitAndNavigate();
        return;
      }

      // 3. Validação com credenciais da conta admin no Supabase Auth
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (user?.email) {
        const { error } = await supabase.auth.signInWithPassword({
          email: user.email,
          password: trimmed,
        });

        if (!error) {
          await cleanExitAndNavigate();
          return;
        }
      }

      setExitError('Senha incorreta. Acesso negado.');
    } catch {
      setExitError('Senha incorreta. Acesso negado.');
    } finally {
      setExitLoading(false);
    }
  };

  // Se o restaurante estiver no plano Básico, renderiza o Paywall comercial
  if (restaurant.subscriptionPlan === 'basic') {
    return (
      <div className="flex min-h-screen flex-col bg-[#F5F4F0] text-slate-900 antialiased dark:bg-[#09090b] dark:text-[#f4f4f5]">
        <header className="sticky top-0 z-30 flex items-center justify-between border-b border-[#E2DFD7] bg-[#F5F4F0]/95 px-4 py-3 shadow-2xs backdrop-blur-md dark:border-white/10 dark:bg-[#18181b]/95 md:px-6">
          <div className="flex items-center gap-4">
            <Link
              to={`/${slug}/admin`}
              className="flex items-center gap-1.5 text-xs font-semibold text-slate-600 transition-colors hover:text-slate-900 dark:text-zinc-400 dark:hover:text-white"
              title="Voltar ao Painel Administrativo"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="19" y1="12" x2="5" y2="12" />
                <polyline points="12 19 5 12 12 5" />
              </svg>
              <span>Painel</span>
            </Link>
            <div className="h-4 w-px bg-slate-200 dark:bg-white/10" aria-hidden="true" />
            <h1 className="text-base font-black tracking-tight text-slate-900 dark:text-white sm:text-lg">
              {restaurant.name}
            </h1>
          </div>
          <ThemeToggleButton />
        </header>

        <main className="flex flex-1 items-center justify-center p-6">
          <div className="max-w-md w-full rounded-3xl border border-black/10 bg-white p-8 text-center shadow-lg dark:border-white/10 dark:bg-[#1c1815]">
            <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-600 dark:bg-amber-400/10 dark:text-amber-400">
              <svg
                width="40"
                height="40"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="2" y="3" width="20" height="14" rx="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
                <rect x="9" y="8" width="6" height="5" rx="1" />
                <path d="M10 8V6.5a2 2 0 1 1 4 0V8" />
              </svg>
            </div>

            <div className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-3 py-1 text-xs font-bold text-amber-700 dark:text-amber-300 mb-3">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              <span>Recurso Pro &amp; Premium</span>
            </div>

            <h2 className="text-xl font-black text-slate-900 dark:text-white tracking-tight mb-3">
              Módulo KDS exclusivo para planos Pro e Premium
            </h2>

            <p className="text-sm text-slate-600 dark:text-stone-300 leading-relaxed mb-6">
              O painel de produção em tempo real para cozinha e bar não está habilitado no plano Básico. Entre em contato com a administração da plataforma para realizar o upgrade e agilizar seus pedidos.
            </p>

            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <Link
                to={`/${slug}/admin`}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-slate-900 px-5 py-2.5 text-sm font-bold text-white transition-all hover:bg-slate-800 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white cursor-pointer shadow-sm"
              >
                Voltar ao Início
              </Link>
              <Link
                to={`/${slug}/admin/mesas`}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-300 dark:border-stone-700 px-5 py-2.5 text-sm font-bold text-slate-700 dark:text-stone-300 transition-all hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer"
              >
                Ver Mesas e Comandas
              </Link>
            </div>
          </div>
        </main>
      
    </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-[#F5F4F0] text-slate-900 antialiased dark:bg-[#09090b] dark:text-[#f4f4f5]">
      {/* =========================================================================
          BARRA SUPERIOR (TOPBAR DO KDS)
          ========================================================================= */}
      <header className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-4 border-b border-[#E2DFD7] bg-[#F5F4F0]/95 px-4 py-3 shadow-2xs backdrop-blur-md dark:border-white/10 dark:bg-[#18181b]/95 md:px-6">
        {/* Esquerda: Identificação do Restaurante & Relógio */}
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => {
              setExitPassword('');
              setExitError(null);
              setIsExitModalOpen(true);
            }}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-black/5 hover:text-slate-900 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-white cursor-pointer"
            title="Sair do KDS (requer senha de liberação)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5 text-slate-500 dark:text-zinc-400" aria-hidden="true">
              <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            <span>← Painel</span>
          </button>

          <div className="h-4 w-px bg-[#DDD9D0] dark:bg-white/10" aria-hidden="true" />

          <div className="flex items-baseline gap-2">
            <h1 className="text-base font-black tracking-tight text-slate-900 dark:text-white sm:text-lg">
              {restaurant.name}
            </h1>
            <span className="rounded bg-[#EAE7DF] px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-slate-700 dark:bg-white/10 dark:text-zinc-300">
              KDS
            </span>
          </div>

          <div
            className="hidden font-mono text-sm font-black tracking-widest text-slate-700 dark:text-zinc-300 sm:inline-block"
            aria-label="Hora atual"
          >
            {currentTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </div>
        </div>

        {/* Centro: Filtro por Estação (Pílulas) */}
        <nav className="flex items-center rounded-xl bg-[#EAE7DF] p-1 dark:bg-[#27272a]" aria-label="Filtro de estação">
          <button
            type="button"
            onClick={() => setFilterStation('all')}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-all ${
              filterStation === 'all'
                ? 'bg-white text-slate-900 shadow-xs dark:bg-[#3f3f46] dark:text-white'
                : 'text-slate-600 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-white'
            }`}
          >
            <span>Todas</span>
            <span className="rounded-full bg-black/5 px-1.5 py-0.2 text-[10px] font-black dark:bg-white/10">
              {stationCounts.all}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setFilterStation('kitchen')}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-all ${
              filterStation === 'kitchen'
                ? 'bg-white text-orange-700 shadow-xs dark:bg-[#3f3f46] dark:text-orange-300'
                : 'text-slate-600 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-white'
            }`}
          >
            <span>Cozinha</span>
            <span className="rounded-full bg-orange-100 px-1.5 py-0.2 text-[10px] font-black text-orange-800 dark:bg-orange-950 dark:text-orange-300">
              {stationCounts.kitchen}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setFilterStation('bar')}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-all ${
              filterStation === 'bar'
                ? 'bg-white text-blue-700 shadow-xs dark:bg-[#3f3f46] dark:text-blue-300'
                : 'text-slate-600 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-white'
            }`}
          >
            <span>Bar</span>
            <span className="rounded-full bg-blue-100 px-1.5 py-0.2 text-[10px] font-black text-blue-800 dark:bg-blue-950 dark:text-blue-300">
              {stationCounts.bar}
            </span>
          </button>
        </nav>

        {/* Badge Pulsante de Alerta de Pedidos Pendentes */}
        {hasPendingOrders && (
          <div
            role="status"
            className="flex items-center gap-2 rounded-lg border border-red-500/50 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700 animate-pulse shadow-sm dark:bg-red-950/70 dark:text-red-200"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              className="h-4 w-4 flex-shrink-0"
              aria-hidden="true"
            >
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
            <span>
              Aguardando início de preparo ({pendingCount}) — Alarme ativo
            </span>
          </div>
        )}

        {/* Direita: Indicador Realtime, Tema e Ações */}
        <div className="flex items-center gap-3">
          {/* Status Realtime com bolinha pulsante */}
          <div
            className="flex items-center gap-1.5 text-xs font-semibold"
            title={
              connectionStatus === 'SUBSCRIBED'
                ? 'Conectado em tempo real'
                : connectionStatus === 'CONNECTING'
                ? 'Conectando ao canal em tempo real...'
                : 'Desconectado — usando reconexão automática'
            }
          >
            <span
              className={`h-2.5 w-2.5 rounded-full ${
                connectionStatus === 'SUBSCRIBED'
                  ? 'animate-pulse bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.7)]'
                  : connectionStatus === 'CONNECTING'
                  ? 'bg-amber-500'
                  : 'bg-rose-500'
              }`}
              aria-hidden="true"
            />
            <span className="hidden text-[11px] text-stone-500 dark:text-stone-400 md:inline">
              {connectionStatus === 'SUBSCRIBED' ? 'Ao vivo' : connectionStatus === 'CONNECTING' ? 'Conectando…' : 'Reconectando…'}
            </span>
          </div>

          {isWakeLockSupported && (
            <div
              className={`flex items-center gap-1.5 rounded-xl border px-2.5 py-1 text-xs font-semibold transition-colors ${
                isWakeLockActive
                  ? 'border-emerald-500/30 bg-emerald-50 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-950/40 dark:text-emerald-300'
                  : 'border-slate-200 bg-slate-50 text-slate-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400'
              }`}
              title={isWakeLockActive ? 'Tela ativa: Wake Lock ativado para impedir que a tela apague' : 'Wake Lock inativo'}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="h-3.5 w-3.5" aria-hidden="true">
                <rect width="20" height="14" x="2" y="3" rx="2" />
                <line x1="8" x2="16" y1="21" y2="21" />
                <line x1="12" x2="12" y1="17" y2="21" />
              </svg>
              <span className="hidden text-[11px] lg:inline">{isWakeLockActive ? 'Tela ativa' : 'Tela normal'}</span>
            </div>
          )}

          {/* Botão de Modo Tela Cheia (Fullscreen API nativa) */}
          <button
            type="button"
            onClick={() => void toggleFullscreen()}
            className="flex items-center gap-1.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-1.5 text-xs font-bold text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-all shadow-2xs cursor-pointer"
            title={isFullscreen ? 'Sair da tela cheia (Esc)' : 'Ativar modo tela cheia (F11)'}
            aria-label={isFullscreen ? 'Sair da tela cheia' : 'Tela cheia'}
          >
            {isFullscreen ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5 text-[#610000] dark:text-red-400" aria-hidden="true">
                <polyline points="4 14 10 14 10 20" />
                <polyline points="20 10 14 10 14 4" />
                <line x1="14" y1="10" x2="21" y2="3" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5 text-[#610000] dark:text-red-400" aria-hidden="true">
                <polyline points="15 3 21 3 21 9" />
                <polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            )}
            <span className="hidden sm:inline">
              {isFullscreen ? 'Sair tela cheia' : 'Tela cheia'}
            </span>
          </button>

          <SoundSettingsControl showLabels />

          <ThemeToggleButton className="h-9 w-9 rounded-xl border border-black/10 dark:border-white/10" />
        </div>
      </header>

      {/* Alerta de Erro caso a mutação falhe */}
      {errorMessage && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 border-b border-rose-200 bg-rose-50 px-4 py-2.5 text-xs font-bold text-rose-800 dark:border-rose-900 dark:bg-rose-950/50 dark:text-rose-200"
        >
          <div className="flex items-center gap-2">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="w-4 h-4 flex-shrink-0">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span>{errorMessage}</span>
          </div>
          <button
            type="button"
            onClick={() => setErrorMessage(null)}
            className="text-rose-600 hover:text-rose-900 dark:text-rose-400"
            aria-label="Fechar erro"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="w-4 h-4">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      )}

      {/* =========================================================================
          ESTEIRA DE PRODUÇÃO KANBAN (3 COLUNAS)
          ========================================================================= */}
      <main className="flex-1 p-3 md:p-5">
        {loading ? (
          <div className="flex h-96 flex-col items-center justify-center gap-3 text-center">
            <svg
              className="h-8 w-8 animate-spin text-stone-400"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            <p className="text-xs font-semibold uppercase tracking-wider text-stone-500">
              Carregando pedidos da esteira KDS…
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {/* Coluna 1: Pendentes / A Fazer */}
            <section
              className="flex flex-col rounded-2xl border border-amber-300 dark:border-amber-800/80 bg-white dark:bg-[#18181b] shadow-sm overflow-hidden"
              aria-labelledby="col-pending-heading"
            >
              {/* Barra superior sólida na cor temática */}
              <div className="h-1.5 w-full bg-amber-500" aria-hidden="true" />

              {/* Cabeçalho da Coluna com fundo suave e linha divisória limpa */}
              <header className="flex items-center justify-between border-b border-amber-200/80 dark:border-amber-800/60 bg-amber-50/70 dark:bg-amber-950/30 px-4 py-3">
                <div className="flex items-center gap-2.5">
                  <span className="h-3 w-3 rounded-full bg-amber-500 shadow-2xs" aria-hidden="true" />
                  <h2 id="col-pending-heading" className="text-sm font-black uppercase tracking-wider text-amber-950 dark:text-amber-200">
                    Pendentes / A Fazer
                  </h2>
                </div>
                <span className="rounded-full bg-amber-500 px-2.5 py-0.5 text-xs font-black text-white shadow-2xs">
                  {pendingItems.length}
                </span>
              </header>

              <div className="p-3 md:p-4 flex flex-col gap-3 flex-1 bg-zinc-50/40 dark:bg-black/20">
                {pendingItems.length === 0 ? (
                  <div className="flex h-40 items-center justify-center rounded-xl border border-dashed border-amber-200 bg-amber-50/30 text-center text-xs font-medium text-amber-800/80 dark:border-amber-900/40 dark:bg-amber-950/10 dark:text-amber-300/80">
                    Nenhum pedido pendente
                  </div>
                ) : (
                  pendingItems.map((item) => (
                    <KdsItemCard
                      key={item.id}
                      item={item}
                      onAdvance={handleAdvanceStatus}
                      isMutating={mutatingItemId === item.id}
                    />
                  ))
                )}
              </div>
            </section>

            {/* Coluna 2: Em Preparo */}
            <section
              className="flex flex-col rounded-2xl border border-blue-300 dark:border-blue-800/80 bg-white dark:bg-[#18181b] shadow-sm overflow-hidden"
              aria-labelledby="col-prep-heading"
            >
              {/* Barra superior sólida na cor temática */}
              <div className="h-1.5 w-full bg-blue-500" aria-hidden="true" />

              {/* Cabeçalho da Coluna com fundo suave e linha divisória limpa */}
              <header className="flex items-center justify-between border-b border-blue-200/80 dark:border-blue-800/60 bg-blue-50/70 dark:bg-blue-950/30 px-4 py-3">
                <div className="flex items-center gap-2.5">
                  <span className="h-3 w-3 rounded-full bg-blue-500 shadow-2xs" aria-hidden="true" />
                  <h2 id="col-prep-heading" className="text-sm font-black uppercase tracking-wider text-blue-950 dark:text-blue-200">
                    Em Preparo
                  </h2>
                </div>
                <span className="rounded-full bg-blue-500 px-2.5 py-0.5 text-xs font-black text-white shadow-2xs">
                  {preparingItems.length}
                </span>
              </header>

              <div className="p-3 md:p-4 flex flex-col gap-3 flex-1 bg-zinc-50/40 dark:bg-black/20">
                {preparingItems.length === 0 ? (
                  <div className="flex h-40 items-center justify-center rounded-xl border border-dashed border-blue-200 bg-blue-50/30 text-center text-xs font-medium text-blue-800/80 dark:border-blue-900/40 dark:bg-blue-950/10 dark:text-blue-300/80">
                    Nenhum item em preparo no momento
                  </div>
                ) : (
                  preparingItems.map((item) => (
                    <KdsItemCard
                      key={item.id}
                      item={item}
                      onAdvance={handleAdvanceStatus}
                      isMutating={mutatingItemId === item.id}
                    />
                  ))
                )}
              </div>
            </section>

            {/* Coluna 3: Prontos para Entrega */}
            <section
              className="flex flex-col rounded-2xl border border-emerald-300 dark:border-emerald-800/80 bg-white dark:bg-[#18181b] shadow-sm overflow-hidden"
              aria-labelledby="col-ready-heading"
            >
              {/* Barra superior sólida na cor temática */}
              <div className="h-1.5 w-full bg-emerald-500" aria-hidden="true" />

              {/* Cabeçalho da Coluna com fundo suave e linha divisória limpa */}
              <header className="flex items-center justify-between border-b border-emerald-200/80 dark:border-emerald-800/60 bg-emerald-50/70 dark:bg-emerald-950/30 px-4 py-3">
                <div className="flex items-center gap-2.5">
                  <span className="h-3 w-3 rounded-full bg-emerald-500 shadow-2xs" aria-hidden="true" />
                  <h2 id="col-ready-heading" className="text-sm font-black uppercase tracking-wider text-emerald-950 dark:text-emerald-200">
                    Prontos para Entrega
                  </h2>
                </div>
                <span className="rounded-full bg-emerald-500 px-2.5 py-0.5 text-xs font-black text-white shadow-2xs">
                  {readyItems.length}
                </span>
              </header>

              <div className="p-3 md:p-4 flex flex-col gap-3 flex-1 bg-zinc-50/40 dark:bg-black/20">
                {readyItems.length === 0 ? (
                  <div className="flex h-40 items-center justify-center rounded-xl border border-dashed border-emerald-200 bg-emerald-50/30 text-center text-xs font-medium text-emerald-800/80 dark:border-emerald-900/40 dark:bg-emerald-950/10 dark:text-emerald-300/80">
                    Nenhum item aguardando entrega
                  </div>
                ) : (
                  readyItems.map((item) => (
                    <KdsItemCard
                      key={item.id}
                      item={item}
                      onAdvance={handleAdvanceStatus}
                      isMutating={mutatingItemId === item.id}
                    />
                  ))
                )}
              </div>
            </section>
          </div>
        )}
      </main>
      {/* Modal de Trava de Segurança KDS */}
      {isExitModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4 animate-in fade-in duration-150">
          <div
            className="w-full max-w-sm rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#18181b] p-6 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="exit-modal-title"
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#610000]/10 text-[#610000] dark:bg-red-950/50 dark:text-red-400 shrink-0">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5" aria-hidden="true">
                  <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              </div>
              <div>
                <h3 id="exit-modal-title" className="text-base font-bold text-zinc-900 dark:text-white">
                  Trava de Segurança KDS
                </h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  Controle de saída da cozinha
                </p>
              </div>
            </div>

            <p className="mb-4 text-xs text-zinc-600 dark:text-zinc-300 leading-relaxed">
              Informe a senha do administrador ou PIN de liberação para retornar ao painel administrativo.
            </p>

            <form onSubmit={(e) => void handleConfirmExit(e)} className="space-y-4">
              <div>
                <label htmlFor="kds-exit-pin" className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5">
                  Senha do Administrador ou PIN
                </label>
                <div className="relative">
                  <input
                    id="kds-exit-pin"
                    ref={exitInputRef}
                    type={showExitPassword ? 'text' : 'password'}
                    value={exitPassword}
                    onChange={(e) => {
                      setExitPassword(e.target.value);
                      if (exitError) setExitError(null);
                    }}
                    placeholder="Digite a senha ou PIN..."
                    className="w-full rounded-xl border border-zinc-300 bg-white px-3.5 py-2.5 pr-10 text-sm text-zinc-900 placeholder-zinc-400 focus:border-[#610000] focus:outline-hidden focus:ring-2 focus:ring-[#610000]/20 dark:border-zinc-700 dark:bg-zinc-900 dark:text-white dark:placeholder-zinc-500"
                  />
                  <button
                    type="button"
                    onClick={() => setShowExitPassword(!showExitPassword)}
                    className="absolute inset-y-0 right-0 pr-3 flex items-center text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 cursor-pointer"
                    aria-label={showExitPassword ? 'Ocultar senha' : 'Ver senha'}
                  >
                    {showExitPassword ? (
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                        <line x1="1" y1="1" x2="23" y2="23" />
                      </svg>
                    ) : (
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    )}
                  </button>
                </div>
                {exitError && (
                  <div className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-rose-600 dark:text-rose-400" role="alert">
                    <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="8" x2="12" y2="12" />
                      <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                    <span>{exitError}</span>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-end gap-2.5 pt-1">
                <button
                  type="button"
                  disabled={exitLoading}
                  onClick={() => {
                    setIsExitModalOpen(false);
                    setExitPassword('');
                    setExitError(null);
                  }}
                  className="rounded-xl border border-zinc-300 dark:border-zinc-700 px-4 py-2 text-xs font-bold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                >
                  Permanecer no KDS
                </button>
                <button
                  type="submit"
                  disabled={exitLoading || !exitPassword.trim()}
                  className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-[#610000] px-4 py-2 text-xs font-bold text-white shadow-xs hover:bg-[#7a0000] disabled:opacity-50 transition-colors cursor-pointer"
                >
                  {exitLoading ? 'Validando…' : 'Liberar e Sair'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

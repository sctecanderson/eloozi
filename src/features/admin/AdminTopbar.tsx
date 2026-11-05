import { useState, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { ThemeToggleButton } from '../theme/ThemeToggleButton';
import {
  fetchUnreadAlerts,
  markAlertAsRead,
  markAllAlertsAsRead,
  subscribeToAlerts,
  type RestaurantAlert,
} from '../alerts/alertService';
import { type RestaurantIdentity } from '../restaurants/RestaurantProvider';
import {
  playWaiterCallSound,
  playDishReadySound,
  playLowStockSound,
} from '../../lib/soundAlerts';
import { SoundSettingsControl } from '../alerts/SoundSettingsControl';
import { signOutStaff } from '../auth/staffAuth';
import { useTheme } from '../theme/ThemeContext';

interface AdminTopbarProps {
  restaurant: RestaurantIdentity;
  onOpenMobileMenu?: () => void;
}

function getAlertMeta(type: RestaurantAlert['type'], slug: string) {
  switch (type) {
    case 'dish_ready':
      return {
        color: '#16a34a',
        targetLink: `/${slug}/admin/mesas`,
        linkLabel: 'Ver mesas',
      };
    case 'call_waiter':
      return {
        color: '#2563eb',
        targetLink: `/${slug}/admin/mesas`,
        linkLabel: 'Ver mesas',
      };
    case 'close_table_request':
      return {
        color: '#d97706',
        targetLink: `/${slug}/admin/mesas`,
        linkLabel: 'Ver mesas',
      };
    case 'low_stock':
      return {
        color: '#ea580c',
        targetLink: `/${slug}/admin/catalogo`,
        linkLabel: 'Ver catálogo',
      };
    default:
      return {
        color: '#6b7280',
        targetLink: `/${slug}/admin`,
        linkLabel: 'Ver detalhes',
      };
  }
}

function renderAlertIcon(type: RestaurantAlert['type'], size = 18) {
  if (type === 'dish_ready') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
        <polyline points="22 4 12 14.01 9 11.01" />
      </svg>
    );
  }
  if (type === 'call_waiter') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      </svg>
    );
  }
  if (type === 'close_table_request') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z" />
        <path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" />
        <path d="M12 6v12" />
      </svg>
    );
  }
  if (type === 'low_stock') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}

export function AdminTopbar({ restaurant, onOpenMobileMenu }: AdminTopbarProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const isKds = location.pathname.includes('/kds');
  const { theme } = useTheme();
  const isDark = theme === 'dark';

  const [alerts, setAlerts] = useState<RestaurantAlert[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [markingId, setMarkingId] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);
  const [toasts, setToasts] = useState<RestaurantAlert[]>([]);

  // Menu Dropdown do Administrador
  const [adminMenuOpen, setAdminMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const adminMenuRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Fechar dropdown de alertas e de admin ao clicar fora
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
      if (adminMenuRef.current && !adminMenuRef.current.contains(event.target as Node)) {
        setAdminMenuOpen(false);
      }
    }
    if (isOpen || adminMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, adminMenuOpen]);

  // Carga inicial de alertas não lidos
  useEffect(() => {
    let active = true;
    void fetchUnreadAlerts(restaurant.id)
      .then((data) => {
        if (active) setAlerts(data);
      })
      .catch((err) => {
        console.error('Erro ao buscar alertas:', err);
      });

    return () => {
      active = false;
    };
  }, [restaurant.id]);

  // Realtime subscription para novos alertas
  useEffect(() => {
    const unsubscribe = subscribeToAlerts(
      restaurant.id,
      () => {
        void fetchUnreadAlerts(restaurant.id)
          .then((data) => setAlerts(data))
          .catch((err) => console.error('Erro ao buscar alertas:', err));
      },
      (newAlert: RestaurantAlert) => {
        setAlerts((prev) => [newAlert, ...prev.filter((a) => a.id !== newAlert.id)]);

        if (newAlert.type === 'dish_ready') {
          playDishReadySound();
        } else if (newAlert.type === 'call_waiter' || newAlert.type === 'close_table_request') {
          playWaiterCallSound();
        } else if (newAlert.type === 'low_stock') {
          playLowStockSound();
        } else {
          playLowStockSound();
        }

        setToasts((prev) => [newAlert, ...prev.filter((t) => t.id !== newAlert.id)].slice(0, 4));
        setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.id !== newAlert.id));
        }, 6000);
      }
    );
    return () => {
      unsubscribe();
    };
  }, [restaurant.id]);

  const removeToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  const handleMarkAsRead = async (alertId: string) => {
    setMarkingId(alertId);
    try {
      await markAlertAsRead(alertId);
      setAlerts((prev) => prev.filter((a) => a.id !== alertId));
    } catch (err) {
      console.error('Erro ao marcar alerta como lido:', err);
    } finally {
      setMarkingId(null);
    }
  };

  const handleMarkAllAsRead = async () => {
    setMarkingAll(true);
    try {
      await markAllAlertsAsRead(restaurant.id);
      setAlerts([]);
    } catch (err) {
      console.error('Erro ao marcar todos como lidos:', err);
    } finally {
      setMarkingAll(false);
    }
  };

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await signOutStaff();
      navigate(`/${restaurant.slug}/acesso`, { replace: true });
    } catch (err) {
      console.error('Erro ao sair:', err);
    } finally {
      setLoggingOut(false);
    }
  }

  const unreadCount = alerts.length;

  return (
    <header
      className={`admin-topbar print:hidden px-6 py-2.5 sm:py-3 flex items-center justify-between gap-4 border-b transition-colors duration-200 ${
        isDark
          ? 'bg-[#18181b] border-zinc-800 text-white'
          : 'bg-white border-zinc-200/80 text-zinc-900 shadow-2xs'
      }`}
    >
      {/* Lado Esquerdo: Botão mobile + Título e Subtítulo Compactos */}
      <div className="flex items-center gap-3">
        {onOpenMobileMenu && (
          <button
            type="button"
            onClick={onOpenMobileMenu}
            aria-label="Abrir menu de navegação"
            className="md:hidden p-1.5 -ml-1 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors cursor-pointer"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="w-5 h-5"
              aria-hidden="true"
            >
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
        )}
        <div className="flex flex-col justify-center leading-tight">
          <span className="text-xs font-black uppercase tracking-wider text-[#610000] dark:text-red-400">
            ADMINISTRAÇÃO
          </span>
          <span className="text-[11px] text-zinc-500 dark:text-zinc-400 font-medium">
            Gerencie seu restaurante
          </span>
        </div>
      </div>

      {/* Lado Direito: Indicador do restaurante, sons, notificações, tema e perfil */}
      <div className="flex items-center gap-3 sm:gap-4">
        {/* Indicador do restaurante ativo com bolinha verde (● NOMA) */}
        <div
          className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold border transition-colors ${
            isDark
              ? 'border-emerald-500/30 bg-emerald-950/40 text-emerald-400'
              : 'border-emerald-300 bg-emerald-50 text-emerald-800'
          }`}
        >
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span className="uppercase tracking-wider font-extrabold">{restaurant.name}</span>
        </div>

        {/* Controle de Áudio e Toques Personalizáveis: EXCLUSIVO para KDS */}
        {isKds && <SoundSettingsControl />}

        {/* Central de Notificações / Alertas */}
        <div ref={dropdownRef} className="relative">
          <button
            type="button"
            onClick={() => setIsOpen((prev) => !prev)}
            aria-label={`Central de Alertas: ${unreadCount} notificações não lidas`}
            className="relative p-2 rounded-xl text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
              <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
            </svg>
            {unreadCount > 0 && (
              <span className="absolute top-1 right-1 bg-red-600 text-white text-[10px] font-bold min-w-[16px] h-4 rounded-full flex items-center justify-center px-1 leading-none shadow-xs">
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </button>

          {/* Dropdown de Alertas */}
          {isOpen && (
            <div
              className={`absolute top-[calc(100%+8px)] right-0 w-80 sm:w-96 max-h-[440px] rounded-xl shadow-2xl border p-0 z-50 flex flex-col overflow-hidden ${
                isDark
                  ? 'bg-zinc-900 border-zinc-700 text-zinc-100'
                  : 'bg-white border-zinc-200 text-zinc-900'
              }`}
            >
              <div
                className={`p-3.5 border-b flex items-center justify-between ${
                  isDark ? 'bg-zinc-800/60 border-zinc-700' : 'bg-zinc-50 border-zinc-200'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-bold text-xs uppercase tracking-wide">Alertas do Restaurante</span>
                  {unreadCount > 0 && (
                    <span className="text-[11px] font-bold bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300 px-2 py-0.5 rounded-full">
                      {unreadCount} novo{unreadCount > 1 ? 's' : ''}
                    </span>
                  )}
                </div>
                {unreadCount > 0 && (
                  <button
                    type="button"
                    onClick={() => void handleMarkAllAsRead()}
                    disabled={markingAll}
                    className="text-xs text-blue-600 hover:text-blue-700 font-semibold cursor-pointer"
                  >
                    {markingAll ? 'Marcando…' : 'Marcar todos'}
                  </button>
                )}
              </div>

              <div className="overflow-y-auto flex-1 max-h-[340px] divide-y divide-zinc-100 dark:divide-zinc-800">
                {alerts.length === 0 ? (
                  <div className="p-8 text-center text-zinc-400 dark:text-zinc-500 flex flex-col items-center gap-2">
                    <svg
                      width="28"
                      height="28"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="opacity-40"
                      aria-hidden="true"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <polyline points="9 11 12 14 22 4" />
                      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                    </svg>
                    <span className="text-xs font-semibold">Nenhum alerta pendente</span>
                  </div>
                ) : (
                  alerts.map((alert) => (
                    <div
                      key={alert.id}
                      className="p-3.5 flex items-start gap-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors"
                    >
                      <div className="mt-0.5 shrink-0" style={{ color: getAlertMeta(alert.type, restaurant.slug).color }}>
                        {renderAlertIcon(alert.type)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-bold text-zinc-900 dark:text-white leading-tight">
                          {alert.title}
                        </p>
                        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 leading-snug">
                          {alert.message}
                        </p>
                        <span className="text-[10px] text-zinc-400 block mt-1">
                          {new Date(alert.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleMarkAsRead(alert.id)}
                        disabled={markingId === alert.id}
                        title="Marcar como lido"
                        aria-label="Marcar como lido"
                        className="p-1 text-zinc-400 hover:text-emerald-600 rounded transition-colors"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        {/* Alternador de tema */}
        <ThemeToggleButton className="admin-theme-toggle" />

        {/* Avatar / Botão do Administrador com Dropdown Sair exclusivo */}
        <div ref={adminMenuRef} className="relative">
          <button
            type="button"
            onClick={() => setAdminMenuOpen((prev) => !prev)}
            aria-label="Menu do Administrador"
            aria-expanded={adminMenuOpen}
            className={`flex items-center gap-2 p-1.5 rounded-xl border transition-all cursor-pointer ${
              isDark
                ? 'border-zinc-700 bg-zinc-800/80 hover:bg-zinc-800 text-white'
                : 'border-zinc-200 bg-white hover:bg-zinc-50 text-zinc-900 shadow-2xs'
            }`}
          >
            {/* Avatar Vinho Escuro com 'A' */}
            <div className="w-7 h-7 rounded-lg bg-[#610000] text-white flex items-center justify-center font-extrabold text-xs shadow-2xs">
              A
            </div>
            <span className="hidden md:inline-block text-xs font-bold text-zinc-800 dark:text-zinc-200">
              Administrador
            </span>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`text-zinc-400 transition-transform ${adminMenuOpen ? 'rotate-180' : ''}`}
              aria-hidden="true"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>

          {/* Dropdown exclusivo com ação de Sair */}
          {adminMenuOpen && (
            <div
              className={`absolute right-0 mt-2 w-48 rounded-xl shadow-xl border p-1.5 z-50 transition-all ${
                isDark
                  ? 'bg-zinc-900 border-zinc-700 text-white shadow-black/50'
                  : 'bg-white border-zinc-200 text-zinc-900 shadow-zinc-900/15'
              }`}
            >
              <button
                type="button"
                disabled={loggingOut}
                onClick={() => void handleLogout()}
                className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-xs font-bold text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors text-left cursor-pointer disabled:opacity-50"
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
                <span>{loggingOut ? 'Saindo…' : 'Sair'}</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Toasts Flutuantes de Alertas em Tempo Real */}
      {toasts.length > 0 && (
        <div
          style={{
            position: 'fixed',
            top: '16px',
            right: '16px',
            zIndex: 99999,
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            maxWidth: '380px',
            width: 'calc(100vw - 32px)',
            pointerEvents: 'none',
          }}
          aria-live="polite"
        >
          {toasts.map((toast) => {
            const meta = getAlertMeta(toast.type, restaurant.slug);
            return (
              <div
                key={toast.id}
                style={{
                  pointerEvents: 'auto',
                  backgroundColor: isDark ? '#18181b' : '#ffffff',
                  color: isDark ? '#f4f4f5' : '#18181b',
                  borderRadius: '12px',
                  border: `1px solid ${isDark ? '#27272a' : '#e5e7eb'}`,
                  borderLeft: `4px solid ${meta.color}`,
                  boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.15)',
                  padding: '12px 14px',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '12px',
                }}
              >
                <div style={{ color: meta.color, flexShrink: 0, marginTop: '2px' }}>
                  {renderAlertIcon(toast.type, 20)}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ margin: 0, fontSize: '13px', fontWeight: 600 }}>{toast.title}</p>
                  <p style={{ margin: '2px 0 6px', fontSize: '12px', opacity: 0.8, lineHeight: 1.4 }}>{toast.message}</p>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <a
                      href={meta.targetLink}
                      onClick={() => removeToast(toast.id)}
                      style={{ fontSize: '11px', fontWeight: 600, color: meta.color, textDecoration: 'none' }}
                      className="hover:underline"
                    >
                      {meta.linkLabel} →
                    </a>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => removeToast(toast.id)}
                  aria-label="Fechar notificação"
                  style={{
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '2px',
                    color: '#9ca3af',
                    borderRadius: '4px',
                    flexShrink: 0,
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </header>
  );
}

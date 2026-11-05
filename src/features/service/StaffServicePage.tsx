import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router';
import { supabase } from '../../lib/supabase';
import type { StaffAccess } from '../auth/staffAuth';
import {
    closeTableVisit,
    listRestaurantTables,
    listSalonOpenTableVisits,
    openTableVisit,
} from './tableVisits';
import type { RestaurantTableItem, SalonTableVisit } from './tableVisits';
import { GuestConfirmationForm } from './GuestConfirmationForm';
import { ConfirmedGuestCount } from './ConfirmedGuestCount';
import { TableTabsPanel } from './TableTabsPanel';
import { TableDetailsTabPanel } from './TableDetailsTabPanel';
import {
    countActiveTableServiceRequests,
    dismissTableServiceRequests,
} from './serviceRequests';
import {
  subscribeToAlerts,
  type RestaurantAlert,
} from '../alerts/alertService';
import {
  playLowStockSound,
} from '../../lib/soundAlerts';
import { SoundSettingsControl } from '../alerts/SoundSettingsControl';
import { useScreenWakeLock } from '../../lib/useScreenWakeLock';
import { ThemeToggleButton } from '../theme/ThemeToggleButton';
import { useRestaurant } from '../restaurants/RestaurantProvider';
import {
  listReservations,
  seatReservationArrival,
  toReservationItem,
  isConfirmedReservation,
  getOperationalDate,
  isValidUuid,
  type ReservationItem,
} from '../reservations/reservationService';

export type TableStatus = 'free' | 'occupied' | 'waiting' | 'reserved' | 'cleaning';

export interface TableDisplayItem {
  id: string;
  table_number: number;
  label?: string;
  name?: string;
  area?: string;
  status: TableStatus;
  timeElapsed: string;
  visit?: SalonTableVisit;
  reservation?: ReservationItem;
  capacity?: number;
}

function TableIcon({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9h18" />
      <path d="M5 9v9" />
      <path d="M19 9v9" />
      <path d="M4 14h16" />
    </svg>
  );
}

function UsersIcon({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function ClockIcon({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function HomeIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  );
}

function UserIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

function HourglassIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 22h14" />
      <path d="M5 2h14" />
      <path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22" />
      <path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2" />
    </svg>
  );
}

function CalendarIcon({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

function SparklesIcon({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
      <path d="M5 3v4" />
      <path d="M19 17v4" />
      <path d="M3 5h4" />
      <path d="M17 19h4" />
    </svg>
  );
}

function formatMinutes(dateStr?: string | null): string {
  if (!dateStr) return '';
  const diffMs = Date.now() - new Date(dateStr).getTime();
  if (diffMs < 0) return '0m';
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
}

function getStaffAlertMeta(alert: RestaurantAlert, restaurantSlug: string) {
  let color = '#2563eb';
  let badgeLabel = 'Chamado de Mesa';
  let actionLabel = 'Atender no Salão';

  if (alert.type === 'dish_ready') {
    color = '#16a34a';
    badgeLabel = 'Prato Pronto (Cozinha)';
    actionLabel = 'Buscar no Balcão';
  } else if (alert.type === 'close_table_request') {
    color = '#d97706';
    badgeLabel = 'Pediu a Conta';
    actionLabel = 'Fechar Conta';
  } else if (alert.type === 'low_stock') {
    color = '#ea580c';
    badgeLabel = 'Estoque Crítico';
    actionLabel = 'Ver Estoque';
  }

  const targetLink =
    alert.type === 'low_stock'
      ? `/${restaurantSlug}/admin/catalogo`
      : `/${restaurantSlug}/equipe`;

  return { color, badgeLabel, actionLabel, targetLink };
}

// Busca reservas ativas do salão diretamente no Supabase com data operacional no fuso do restaurante
async function fetchSalonReservations(restaurantId: string, timezone?: string | null): Promise<ReservationItem[]> {
  const opDate = getOperationalDate(timezone);
  const dbRes = await listReservations(restaurantId, {
    startDate: opDate,
    endDate: opDate,
    status: ['confirmed', 'confirmada', 'agendada', 'reservada'],
  });
  return dbRes.map(toReservationItem);
}

export function StaffServicePage() {
    const { restaurantSlug } = useParams();
    const access = useOutletContext<StaffAccess>();

    if (!restaurantSlug) {
        return <p role="alert">Restaurante não identificado.</p>;
    }

    return (
        <StaffSalonManager
            key={`${restaurantSlug}:${access.memberId}`}
            restaurantSlug={restaurantSlug}
            restaurantId={access.restaurantId}
            memberId={access.memberId}
            role={access.role}
        />
    );
}

function getTableAuthorizedKey(restaurantId: string, tableNumber: number, visitId?: string) {
    return `noma_mesa_autorizada_${restaurantId}_${tableNumber}${visitId ? `_${visitId}` : ''}`;
}

function isTableLocallyAuthorized(restaurantId: string, tableNumber: number, visitId?: string): boolean {
    try {
        if (visitId && localStorage.getItem(getTableAuthorizedKey(restaurantId, tableNumber, visitId)) === 'true') {
            return true;
        }
        return localStorage.getItem(getTableAuthorizedKey(restaurantId, tableNumber)) === 'true';
    } catch {
        return false;
    }
}

function setTableLocallyAuthorized(restaurantId: string, tableNumber: number, visitId?: string) {
    try {
        localStorage.setItem(getTableAuthorizedKey(restaurantId, tableNumber), 'true');
        if (visitId) {
            localStorage.setItem(getTableAuthorizedKey(restaurantId, tableNumber, visitId), 'true');
        }
    } catch {
        // ignore
    }
}

function clearTableLocallyAuthorized(restaurantId: string, tableNumber: number, visitId?: string) {
    try {
        localStorage.removeItem(getTableAuthorizedKey(restaurantId, tableNumber));
        if (visitId) {
            localStorage.removeItem(getTableAuthorizedKey(restaurantId, tableNumber, visitId));
        }
    } catch {
        // ignore
    }
}

function StaffSalonManager({
    restaurantSlug,
    restaurantId,
    memberId,
    role,
}: {
    restaurantSlug: string;
    restaurantId: string;
    memberId: string;
    role: 'admin' | 'waiter';
}) {
    const submitting = useRef(false);
    const salonInitialLoaded = useRef(false);
    useScreenWakeLock(true);
    const { restaurant } = useRestaurant();

    const [searchParams, setSearchParams] = useSearchParams();
    const navigate = useNavigate();
    const mesaParam = searchParams.get('mesa');
    const selectedTableNumber = mesaParam ? parseInt(mesaParam, 10) : null;
    const viewMode: 'salon' | 'detail' = selectedTableNumber !== null ? 'detail' : 'salon';

    // Estados reais do Supabase
    const [allTables, setAllTables] = useState<RestaurantTableItem[]>([]);
    const [salonVisits, setSalonVisits] = useState<SalonTableVisit[]>([]);

    const currentTableVisit = selectedTableNumber !== null
        ? salonVisits.find((v) => v.table.table_number === selectedTableNumber)
        : undefined;

    const isMyVisit = !!currentTableVisit && currentTableVisit.assigned_member_id === memberId;
    const isOtherStaffVisit = !!currentTableVisit && currentTableVisit.assigned_member_id !== memberId;
    const isTableFree = !currentTableVisit;
    const [reservations, setReservations] = useState<ReservationItem[]>([]);
    const [reservationsError, setReservationsError] = useState<string | null>(null);
    const [activeRequestsMap, setActiveRequestsMap] = useState<Map<number, number>>(new Map());

    // Filtros e ordenação
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedSector, setSelectedSector] = useState<string>('Todas');
    const statusParam = searchParams.get('status') as TableStatus | null;
    const [statusFilter, setStatusFilter] = useState<'all' | TableStatus>(() => {
        if (statusParam && ['free', 'occupied', 'waiting', 'reserved', 'cleaning'].includes(statusParam)) {
            return statusParam;
        }
        return 'all';
    });

    useEffect(() => {
        if (statusParam && ['free', 'occupied', 'waiting', 'reserved', 'cleaning'].includes(statusParam)) {
            setStatusFilter(statusParam);
        } else if (!statusParam) {
            setStatusFilter('all');
        }
    }, [statusParam]);
    const [sortAsc, setSortAsc] = useState(true);
    const [viewLayout, setViewLayout] = useState<'grid' | 'list'>('grid');
    const [moreDrawerOpen, setMoreDrawerOpen] = useState(false);

    // Carregamento e sincronização
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [refresh, setRefresh] = useState(0);

    // Detalhe da mesa: comandas e chamados ativos
    const [openTabsCount, setOpenTabsCount] = useState<number>(0);
    const [activeRequestsOnTable, setActiveRequestsOnTable] = useState<number>(0);
    const [tableActiveTab, setTableActiveTab] = useState<'access' | 'tab' | 'details'>(() => {
        if (selectedTableNumber !== null && currentTableVisit?.id) {
            if (isTableLocallyAuthorized(restaurantId, selectedTableNumber, currentTableVisit.id)) {
                return 'tab';
            }
        }
        return 'access';
    });
    const [showConfirmedToast, setShowConfirmedToast] = useState(false);
    const [busyAction, setBusyAction] = useState(false);
    const [actionError, setActionError] = useState('');
    const [confirmCloseMesa, setConfirmCloseMesa] = useState(false);
    const [confirmDismissRequests, setConfirmDismissRequests] = useState(false);

    const handleOpenTabsCountChange = useCallback((count: number) => {
        setOpenTabsCount(count);
    }, []);

    // Notificações e Toasts Flutuantes em Tempo Real
    const [toasts, setToasts] = useState<RestaurantAlert[]>([]);
    const removeToast = (id: string) => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
    };



    // Timer de 30s para atualizar tempos decorridos e checar virada de data operacional (meia-noite)
    const [, setTick] = useState(0);
    const lastOpDateRef = useRef<string>(getOperationalDate(restaurant?.timezone));
    useEffect(() => {
        const interval = window.setInterval(() => {
            setTick((t) => t + 1);
            const currentOpDate = getOperationalDate(restaurant?.timezone);
            if (currentOpDate !== lastOpDateRef.current) {
                lastOpDateRef.current = currentOpDate;
                setRefresh((c) => c + 1);
            }
        }, 30000);
        return () => window.clearInterval(interval);
    }, [restaurant?.timezone]);

    // Subscrição a alertas sonoros e notificações
    useEffect(() => {
        if (!restaurantId) return;

        const unsubscribe = subscribeToAlerts(
            restaurantId,
            () => {
                setRefresh((c) => c + 1);
            },
            (newAlert) => {
                // Centralização: avisos de garçom, conta e pedido pronto são gerenciados
                // exclusivamente pelo StaffChamadosProvider (evita duplicidade de som e toast de 6000ms).
                if (
                    newAlert.type === 'call_waiter' ||
                    newAlert.type === 'close_table_request' ||
                    newAlert.type === 'dish_ready'
                ) {
                    return;
                }

                // Alertas de outros tipos (ex: estoque crítico) continuam no salão
                playLowStockSound();
                setToasts((prev) => [newAlert, ...prev.filter((t) => t.id !== newAlert.id)].slice(0, 4));
                setTimeout(() => {
                    setToasts((prev) => prev.filter((t) => t.id !== newAlert.id));
                }, 6000);
            }
        );

        return () => {
            unsubscribe();
        };
    }, [restaurantId]);

    // Carregar quantidade de chamados da mesa selecionada
    useEffect(() => {
        if (selectedTableNumber === null) {
            setActiveRequestsOnTable(0);
            return;
        }

        let disposed = false;
        async function fetchTableRequestsCount() {
            try {
                const count = await countActiveTableServiceRequests(
                    restaurantId,
                    selectedTableNumber!,
                );
                if (!disposed) {
                    setActiveRequestsOnTable(count);
                }
            } catch {
                // Silencia falha transitória
            }
        }

        void fetchTableRequestsCount();

        return () => {
            disposed = true;
        };
    }, [restaurantId, selectedTableNumber, refresh]);

    // Carrega mesas, atendimentos, chamados ativos e reservas em tempo real do Supabase
    useEffect(() => {
        let disposed = false;

        async function loadSalonData() {
            if (!salonInitialLoaded.current) {
                setLoading(true);
            }
            setError('');

            try {
                const [loadedTables, openVisits, requestsRes] = await Promise.all([
                    listRestaurantTables(restaurantId),
                    listSalonOpenTableVisits(restaurantId),
                    supabase
                        .from('service_requests')
                        .select('id, status, table:restaurant_tables!inner(table_number)')
                        .eq('restaurant_id', restaurantId)
                        .in('status', ['pending', 'attended']),
                ]);

                let loadedReservations: ReservationItem[] = [];
                let resError: string | null = null;
                try {
                    loadedReservations = await fetchSalonReservations(restaurantId, restaurant?.timezone);
                } catch (rErr) {
                    resError = rErr instanceof Error ? rErr.message : 'Falha ao consultar reservas';
                    console.error('Erro na consulta de reservas do salão:', rErr);
                }

                if (!disposed) {
                    setAllTables(loadedTables);
                    setSalonVisits(openVisits);
                    setReservations(loadedReservations);
                    setReservationsError(resError);

                    const reqMap = new Map<number, number>();
                    if (requestsRes.data && Array.isArray(requestsRes.data)) {
                        for (const r of requestsRes.data) {
                            const tblNum = (r.table as { table_number?: number })?.table_number;
                            if (tblNum) {
                                reqMap.set(tblNum, (reqMap.get(tblNum) || 0) + 1);
                            }
                        }
                    }
                    setActiveRequestsMap(reqMap);

                    salonInitialLoaded.current = true;
                }
            } catch (cause) {
                if (!disposed) {
                    setError(
                        cause instanceof Error
                            ? cause.message
                            : 'Não foi possível carregar os dados das mesas.',
                    );
                }
            } finally {
                if (!disposed) {
                    setLoading(false);
                }
            }
        }

        void loadSalonData();

        return () => {
            disposed = true;
        };
    }, [restaurantId, refresh]);

    // Realtime listeners no Supabase (mesas, atendimentos, chamados e reservas)
    useEffect(() => {
        function scheduleRefresh() {
            if (!document.hidden) {
                setRefresh((c) => c + 1);
            }
        }

        const pollInterval = window.setInterval(scheduleRefresh, 10000);
        document.addEventListener('visibilitychange', scheduleRefresh);
        window.addEventListener('online', scheduleRefresh);

        const baseChannel = supabase
            .channel(`salon-realtime-waiter:${restaurantId}`)
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'table_visits',
                    filter: `restaurant_id=eq.${restaurantId}`,
                },
                scheduleRefresh,
            )
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'restaurant_tables',
                    filter: `restaurant_id=eq.${restaurantId}`,
                },
                scheduleRefresh,
            )
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'service_requests',
                    filter: `restaurant_id=eq.${restaurantId}`,
                },
                scheduleRefresh,
            );

            baseChannel.on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'reservations',
                    filter: `restaurant_id=eq.${restaurantId}`,
                },
                scheduleRefresh,
            );

        const channel = baseChannel.subscribe();

        return () => {
            window.clearInterval(pollInterval);
            document.removeEventListener('visibilitychange', scheduleRefresh);
            window.removeEventListener('online', scheduleRefresh);
            void supabase.removeChannel(channel);
        };
    }, [restaurantId]);

    // Quantidade total de chamados ativos no restaurante
    const totalActiveRequestsCount = useMemo(() => {
        let count = 0;
        for (const c of activeRequestsMap.values()) {
            count += c;
        }
        return count;
    }, [activeRequestsMap]);

    // Mapeamento rigoroso de status: Livre, Em atendimento, Aguardando e Reservada
    const displayTables: TableDisplayItem[] = useMemo(() => {
        return allTables.map((table) => {
            const activeRes = reservations.find(
                (r) =>
                    r.tableNumber === table.table_number &&
                    (!r.status || ['confirmed', 'confirmada', 'agendada', 'reservada'].includes(r.status)),
            );
            const visit = salonVisits.find((v) => v.table.table_number === table.table_number);
            const activeReqCount = activeRequestsMap.get(table.table_number) || 0;

            let status: TableStatus = 'free';
            let timeElapsed = '';

            if (visit) {
                if (activeReqCount > 0) {
                    status = 'waiting';
                    timeElapsed = formatMinutes(visit.opened_at);
                } else {
                    status = 'occupied';
                    timeElapsed = formatMinutes(visit.opened_at);
                }
            } else if (activeRes) {
                status = 'reserved';
                timeElapsed = activeRes.time || '';
            } else {
                status = 'free';
                timeElapsed = '';
            }

            const rawLabel = table.label?.trim() || '';
            const isStandardArea = [
                'salão',
                'salao',
                'varanda',
                'área externa',
                'area externa',
                'balcão',
                'balcao',
                'deck',
                'terraço',
                'terraco',
                'mezanino',
            ].includes(rawLabel.toLowerCase());

            const name = rawLabel && !isStandardArea ? rawLabel : `Mesa ${String(table.table_number).padStart(2, '0')}`;
            const area = rawLabel && isStandardArea ? rawLabel : 'Salão';

            return {
                id: table.id,
                table_number: table.table_number,
                label: table.label,
                name,
                area,
                status,
                timeElapsed,
                visit,
                reservation: activeRes,
            };
        });
    }, [allTables, salonVisits, reservations, activeRequestsMap]);

    // Contadores para os 4 Cards de Métricas (Livres, Ocupadas, Em espera, Reservadas)
    const counts = useMemo(() => {
        let free = 0;
        let occupied = 0;
        let waiting = 0;
        let reserved = 0;

        for (const t of displayTables) {
            if (t.status === 'free') free++;
            else if (t.status === 'occupied') occupied++;
            else if (t.status === 'waiting') waiting++;
            else if (t.status === 'reserved') reserved++;
        }

        return { free, occupied, waiting, reserved };
    }, [displayTables]);

    // Extrair ambientes únicos para os Chips de filtro
    const sectors = useMemo(() => {
        const set = new Set<string>();
        for (const t of allTables) {
            if (t.label && t.label.trim()) {
                set.add(t.label.trim());
            }
        }
        if (set.size === 0) {
            return ['Todas', 'Salão', 'Varanda', 'Área externa'];
        }
        return ['Todas', ...Array.from(set)];
    }, [allTables]);

    // Filtragem e ordenação das mesas no Salão
    const filteredTables = useMemo(() => {
        const result = displayTables.filter((t) => {
            if (statusFilter !== 'all' && t.status !== statusFilter) {
                return false;
            }

            if (selectedSector !== 'Todas') {
                if (!t.label || !t.label.toLowerCase().includes(selectedSector.toLowerCase())) {
                    return false;
                }
            }

            if (searchQuery.trim()) {
                const q = searchQuery.trim().toLowerCase();
                const numStr = String(t.table_number);
                const numPadded = numStr.padStart(2, '0');
                const label = (t.label || '').toLowerCase();
                return numStr.includes(q) || numPadded.includes(q) || label.includes(q);
            }

            return true;
        });

        return result.sort((a, b) => {
            return sortAsc ? a.table_number - b.table_number : b.table_number - a.table_number;
        });
    }, [displayTables, statusFilter, selectedSector, searchQuery, sortAsc]);

    // Detalhe da mesa selecionada
    const selectedTable = allTables.find((t) => t.table_number === selectedTableNumber);
    const selectedTableInfo = displayTables.find((t) => t.table_number === selectedTableNumber);
    const selectedReservation = reservations.find(
        (r) =>
            r.tableNumber === selectedTableNumber &&
            (!r.status || ['confirmed', 'confirmada', 'agendada', 'reservada'].includes(r.status)),
    );

    // Lista de todas as reservas ativas da mesa selecionada
    const tableActiveReservations = useMemo(() => {
        if (selectedTableNumber === null) return [];
        return reservations.filter(
            (r) => r.tableNumber === selectedTableNumber && isConfirmedReservation(r),
        );
    }, [reservations, selectedTableNumber]);

    // Validação de Sessão Ativa no Carregamento: nunca forçar tela de código se a mesa já tiver comandas ou sessões ativas
    useEffect(() => {
        if (selectedTableNumber === null) return;

        let disposed = false;

        async function checkActiveTableAccess() {
            if (selectedTableNumber === null) return;

            // Se não houver atendimento aberto, a mesa está livre
            if (!currentTableVisit) {
                setTableActiveTab('access');
                return;
            }

            // 1. Checa autorização em cache local para esta visita
            if (isTableLocallyAuthorized(restaurantId, selectedTableNumber, currentTableVisit.id)) {
                setTableActiveTab('tab');
                return;
            }

            // 2. Checa no banco de dados se os clientes da visita já tiveram o código validado (sessão ativa de guest)
            try {
                const { data: guestSessions } = await supabase
                    .from('guest_sessions')
                    .select('id')
                    .eq('restaurant_id', restaurantId)
                    .eq('table_visit_id', currentTableVisit.id)
                    .eq('status', 'active')
                    .gt('expires_at', new Date().toISOString())
                    .limit(1);

                if (disposed) return;

                const hasActiveGuestSession = (guestSessions?.length ?? 0) > 0;

                if (hasActiveGuestSession) {
                    setTableLocallyAuthorized(restaurantId, selectedTableNumber, currentTableVisit.id);
                    setTableActiveTab('tab');
                } else {
                    setTableActiveTab('access');
                }
            } catch {
                setTableActiveTab('access');
            }
        }

        void checkActiveTableAccess();

        return () => {
            disposed = true;
        };
    }, [selectedTableNumber, currentTableVisit?.id, isMyVisit, role, restaurantId]);

    // Navegação entre mesas no Detalhe (< Mesa XX >)
    function handleNavigateTable(direction: 'prev' | 'next') {
        if (allTables.length === 0 || selectedTableNumber === null) return;
        const currentIndex = allTables.findIndex((t) => t.table_number === selectedTableNumber);
        if (currentIndex === -1) {
            setSearchParams({ mesa: String(allTables[0].table_number) });
            return;
        }

        let newIndex = direction === 'prev' ? currentIndex - 1 : currentIndex + 1;
        if (newIndex < 0) newIndex = allTables.length - 1;
        if (newIndex >= allTables.length) newIndex = 0;

        setSearchParams({ mesa: String(allTables[newIndex].table_number) });
        setActionError('');
        setConfirmCloseMesa(false);
    }

    // Ação: Assumir atendimento da mesa
    // Abertura de visita e confirmação de reserva são passos separados e explícitos.
    async function handleAssumeTable(tableNum: number, reservationId?: string) {
        if (submitting.current || busyAction) return;

        submitting.current = true;
        setBusyAction(true);
        setActionError('');

        let visitOpened = false;

        try {
            // 1. Abertura do atendimento da mesa
            await openTableVisit(restaurantSlug, tableNum);
            visitOpened = true;

            // 2. Confirmação segura da reserva via RPC com ID explícito (se informado)
            if (reservationId && isValidUuid(reservationId)) {
                const seatResult = await seatReservationArrival(
                    restaurantId,
                    tableNum,
                    reservationId,
                );

                if (seatResult.success && seatResult.reservation?.id) {
                    const seatedId = seatResult.reservation.id;
                    // Atualiza EXCLUSIVAMENTE a reserva confirmada e validada pelo servidor
                    setReservations((prev) =>
                        prev.map((r) =>
                            r.id === seatedId ? { ...r, status: 'seated' } : r,
                        ),
                    );
                } else if (seatResult.code === 'ALREADY_SEATED') {
                    const seatedId = seatResult.reservation?.id ?? reservationId;
                    setReservations((prev) =>
                        prev.map((r) =>
                            r.id === seatedId ? { ...r, status: 'seated' } : r,
                        ),
                    );
                } else {
                    console.warn('Aviso ao confirmar reserva via RPC:', seatResult.code, seatResult.message);
                    setActionError(
                        `Atendimento aberto na Mesa ${tableNum}, mas a confirmação da reserva falhou: ${seatResult.message}`,
                    );
                }
            }

            setTableActiveTab('access');
            setRefresh((c) => c + 1);
        } catch (cause) {
            if (visitOpened) {
                setActionError(
                    cause instanceof Error
                        ? `Atendimento aberto na Mesa ${tableNum}, mas ocorreu um erro posterior: ${cause.message}`
                        : `Atendimento aberto na Mesa ${tableNum}, mas ocorreu um erro posterior.`,
                );
            } else {
                setActionError(
                    cause instanceof Error
                        ? cause.message
                        : 'Não foi possível assumir a mesa.',
                );
            }
        } finally {
            submitting.current = false;
            setBusyAction(false);
        }
    }

    // Ação: Encerrar atendimento da mesa
    async function handleCloseVisit(visitId: string) {
        if (submitting.current || busyAction) return;

        if (openTabsCount > 0) {
            setActionError('Encerre todas as comandas abertas antes de finalizar o atendimento da mesa.');
            return;
        }

        submitting.current = true;
        setBusyAction(true);
        setActionError('');

        try {
            await closeTableVisit(restaurantSlug, visitId);
            setConfirmCloseMesa(false);
            if (selectedTableNumber !== null) {
                clearTableLocallyAuthorized(restaurantId, selectedTableNumber, visitId);
            }
            setTableActiveTab('access');
            setRefresh((c) => c + 1);
            setSearchParams((prev) => {
                const next = new URLSearchParams(prev);
                next.delete('mesa');
                return next;
            });
            setToasts((prev) => [
                ...prev,
                {
                    id: crypto.randomUUID(),
                    restaurant_id: restaurantId,
                    type: 'system',
                    title: 'Mesa encerrada',
                    message: `Mesa ${String(selectedTableNumber).padStart(2, '0')} encerrada com sucesso!`,
                    is_read: false,
                    reference_id: null,
                    created_at: new Date().toISOString(),
                },
            ]);
        } catch (cause) {
            setActionError(
                cause instanceof Error
                    ? cause.message
                    : 'Não foi possível encerrar o atendimento da mesa.',
            );
        } finally {
            submitting.current = false;
            setBusyAction(false);
        }
    }

    // Ação: Encerrar chamados da mesa selecionada
    async function handleDismissTableRequests(tableNum: number) {
        if (submitting.current || busyAction) return;

        submitting.current = true;
        setBusyAction(true);
        setActionError('');

        try {
            await dismissTableServiceRequests(restaurantSlug, tableNum);
            setConfirmDismissRequests(false);
            setTableActiveTab('access');
            setRefresh((c) => c + 1);
        } catch (cause) {
            setActionError(
                cause instanceof Error
                    ? cause.message
                    : 'Não foi possível encerrar os chamados da mesa.',
            );
        } finally {
            submitting.current = false;
            setBusyAction(false);
        }
    }

    // Estado vazio: Nenhuma mesa cadastrada
    if (!loading && allTables.length === 0) {
        return (
            <section className="mx-auto max-w-xl pb-24 px-4 text-center">
                <div className="tab-hero-card mt-8 p-8 rounded-3xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-sm">
                    <div className="w-14 h-14 rounded-2xl bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 mx-auto mb-4 flex items-center justify-center">
                        <svg className="w-7 h-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                            <line x1="3" y1="9" x2="21" y2="9" />
                            <line x1="9" y1="21" x2="9" y2="9" />
                        </svg>
                    </div>
                    <h2 className="text-xl font-bold text-zinc-900 dark:text-white mb-2">Nenhuma mesa cadastrada</h2>
                    <p className="text-xs text-zinc-600 dark:text-zinc-400 mb-6 leading-relaxed">
                        Este restaurante ainda não possui mesas ativas cadastradas no sistema. Cadastre as mesas no painel administrativo para iniciar os atendimentos do salão.
                    </p>
                    <Link
                        to={`/${restaurantSlug}/admin/mesas`}
                        className="inline-flex items-center justify-center px-6 py-3 rounded-xl bg-[#4A1505] text-white font-bold text-xs shadow-md transition-all hover:bg-[#610000]"
                    >
                        Cadastrar Mesas no Painel
                    </Link>
                </div>
            </section>
        );
    }

    return (
        <section className="w-full">
            {error && (
                <div role="alert" className="mb-4 text-xs text-red-700 bg-red-50 dark:bg-red-950/30 dark:text-red-300 p-3.5 rounded-2xl border border-red-200 dark:border-red-900/40">
                    {error}
                </div>
            )}

            {/* =========================================================
                PARTE 1: VISÃO GERAL DO SALÃO
               ========================================================= */}
            {viewMode === 'salon' && (
                <div className="space-y-3 pb-28">
                    {/* Aviso de indisponibilidade pontual do módulo de reservas sem afetar o salão */}
                    {reservationsError && (
                        <div className="p-2.5 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-xs text-amber-800 dark:text-amber-300 flex items-center justify-between gap-2 mt-2">
                            <span>⚠️ Reservas do salão indisponíveis: {reservationsError}. Mesas e pedidos continuam ativos.</span>
                            <button
                                type="button"
                                onClick={() => setRefresh((c) => c + 1)}
                                className="underline font-bold cursor-pointer shrink-0"
                            >
                                Recarregar
                            </button>
                        </div>
                    )}

                    {/* A. 4 Cards de Métricas Superiores em 1 Linha com 4 Colunas */}
                    <div className="grid grid-cols-4 gap-2 mt-2">
                        {/* 1. Livres (Verde Suave) */}
                        <button
                            type="button"
                            onClick={() => setStatusFilter((curr) => (curr === 'free' ? 'all' : 'free'))}
                            className={`bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 border border-emerald-100 dark:border-emerald-900/40 rounded-2xl p-2 text-center flex flex-col items-center justify-center transition-all ${
                                statusFilter === 'free' ? 'ring-2 ring-emerald-500 shadow-xs' : 'hover:bg-emerald-100/60'
                            }`}
                        >
                            <TableIcon className="w-5 h-5 text-emerald-600 dark:text-emerald-400 mb-0.5" />
                            <span className="text-xl font-black leading-none">{counts.free}</span>
                            <span className="text-[11px] font-semibold mt-1">Livres</span>
                        </button>

                        {/* 2. Ocupadas (Coral/Vermelho Suave) */}
                        <button
                            type="button"
                            onClick={() => setStatusFilter((curr) => (curr === 'occupied' ? 'all' : 'occupied'))}
                            className={`bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300 border border-rose-100 dark:border-rose-900/40 rounded-2xl p-2 text-center flex flex-col items-center justify-center transition-all ${
                                statusFilter === 'occupied' ? 'ring-2 ring-rose-500 shadow-xs' : 'hover:bg-rose-100/60'
                            }`}
                        >
                            <UsersIcon className="w-5 h-5 text-rose-600 dark:text-rose-400 mb-0.5" />
                            <span className="text-xl font-black leading-none">{counts.occupied}</span>
                            <span className="text-[11px] font-semibold mt-1">Ocupadas</span>
                        </button>

                        {/* 3. Em espera (Amarelo Suave) */}
                        <button
                            type="button"
                            onClick={() => setStatusFilter((curr) => (curr === 'waiting' ? 'all' : 'waiting'))}
                            className={`bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300 border border-amber-100 dark:border-amber-900/40 rounded-2xl p-2 text-center flex flex-col items-center justify-center transition-all ${
                                statusFilter === 'waiting' ? 'ring-2 ring-amber-500 shadow-xs' : 'hover:bg-amber-100/60'
                            }`}
                        >
                            <ClockIcon className="w-5 h-5 text-amber-600 dark:text-amber-400 mb-0.5" />
                            <span className="text-xl font-black leading-none">{counts.waiting}</span>
                            <span className="text-[11px] font-semibold mt-1">Em espera</span>
                        </button>

                        {/* 4. Reservadas (Roxo Suave - Paridade com o Admin) */}
                        <button
                            type="button"
                            onClick={() => setStatusFilter((curr) => (curr === 'reserved' ? 'all' : 'reserved'))}
                            className={`bg-purple-50 text-purple-700 dark:bg-purple-950/30 dark:text-purple-300 border border-purple-200 dark:border-purple-800 rounded-2xl p-2 text-center flex flex-col items-center justify-center transition-all ${
                                statusFilter === 'reserved' ? 'ring-2 ring-purple-500 shadow-xs' : 'hover:bg-purple-100/60'
                            }`}
                        >
                            <CalendarIcon className="w-5 h-5 text-purple-700 dark:text-purple-400 mb-0.5" />
                            <span className="text-xl font-black leading-none">{counts.reserved}</span>
                            <span className="text-[11px] font-semibold mt-1">Reservadas</span>
                        </button>
                    </div>

                    {/* B. Barra de Busca e Filtros de Ambientes */}
                    <div className="flex items-center gap-2 mt-3">
                        <div className="relative flex-1">
                            <span className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-zinc-400">
                                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <circle cx="11" cy="11" r="8" />
                                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                                </svg>
                            </span>
                            <input
                                type="text"
                                placeholder="Buscar mesa (ex.: 02, 14)..."
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                className="w-full pl-10 pr-9 py-2.5 rounded-2xl border border-zinc-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-sm text-zinc-900 dark:text-white placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-[#4A1505]/20 shadow-xs transition-all"
                            />
                            {searchQuery && (
                                <button
                                    type="button"
                                    onClick={() => setSearchQuery('')}
                                    className="absolute inset-y-0 right-0 pr-3 flex items-center text-zinc-400 hover:text-zinc-600"
                                >
                                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                        <line x1="18" y1="6" x2="6" y2="18" />
                                        <line x1="6" y1="6" x2="18" y2="18" />
                                    </svg>
                                </button>
                            )}
                        </div>

                        <button
                            type="button"
                            onClick={() => setSortAsc((prev) => !prev)}
                            title="Ordenar mesas"
                            className="w-10 h-10 rounded-2xl border border-zinc-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-900 flex items-center justify-center text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 shrink-0 shadow-xs transition-colors"
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

                        <button
                            type="button"
                            onClick={() => setViewLayout((prev) => (prev === 'grid' ? 'list' : 'grid'))}
                            title="Alternar visualização"
                            className="w-10 h-10 rounded-2xl border border-zinc-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-900 flex items-center justify-center text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 shrink-0 shadow-xs transition-colors"
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

                    {/* Pílulas de Ambientes */}
                    <div className="flex items-center gap-2 overflow-x-auto pb-1 mt-2.5 no-scrollbar">
                        {sectors.map((sec) => (
                            <button
                                key={sec}
                                type="button"
                                onClick={() => setSelectedSector(sec)}
                                className={`px-4 py-2 rounded-2xl text-xs font-bold whitespace-nowrap transition-all ${
                                    selectedSector === sec
                                        ? 'bg-[#4A1505] text-white shadow-xs'
                                        : 'border border-zinc-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800'
                                }`}
                            >
                                {sec}
                            </button>
                        ))}
                    </div>

                    {/* C. Grade de Cards de Mesas Padronizados (Mesmo Tamanho e Fundo Branco) */}
                    <div className={`mt-3 ${viewLayout === 'grid' ? 'grid grid-cols-2 gap-3' : 'space-y-2.5'}`}>
                        {filteredTables.map((t) => {
                            const isLivre = t.status === 'free';
                            const isOccupied = t.status === 'occupied';
                            const isWaiting = t.status === 'waiting';
                            const isReserved = t.status === 'reserved';
                            const isCleaning = t.status === 'cleaning';

                            return (
                                <button
                                    key={t.id}
                                    type="button"
                                    onClick={() => {
                                        if (isOccupied || salonVisits.some((v) => v.table.table_number === t.table_number)) {
                                            navigate(`/${restaurantSlug}/equipe/comandas?mesa=${t.table_number}`);
                                        } else {
                                            setSearchParams({ mesa: String(t.table_number) });
                                        }
                                    }}
                                    className="h-[92px] min-h-[92px] w-full text-left rounded-2xl p-3.5 bg-white dark:bg-zinc-900 border border-zinc-200/80 dark:border-zinc-800 shadow-xs relative flex items-center justify-between gap-2.5 transition-all hover:border-zinc-400 dark:hover:border-zinc-700 active:scale-[0.98]"
                                >
                                    {/* Canto Esquerdo: Avatar Circular Suave */}
                                    <div className="w-11 h-11 rounded-full flex items-center justify-center shrink-0 bg-[#fceddf] dark:bg-zinc-800 text-[#7c4424] dark:text-[#f8a87b]">
                                        {isOccupied ? (
                                            <UsersIcon className="w-5 h-5" />
                                        ) : isCleaning ? (
                                            <SparklesIcon className="w-5 h-5" />
                                        ) : (
                                            <TableIcon className="w-5 h-5" />
                                        )}
                                    </div>

                                    {/* Centro: Nome/Número da Mesa, Área e Status */}
                                    <div className="flex-1 min-w-0 flex flex-col justify-center">
                                        <div className="flex flex-col">
                                            <span className="font-extrabold text-base text-zinc-900 dark:text-zinc-100 tracking-tight leading-tight truncate">
                                                {t.name || `Mesa ${t.table_number}`}
                                            </span>
                                            <span className="text-[11px] text-zinc-400 dark:text-zinc-500 font-medium truncate">
                                                {t.area || 'Salão'}
                                            </span>
                                        </div>
                                        <div className="mt-0.5 truncate">
                                            {isLivre && (
                                                <span className="text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                                                    Livre
                                                </span>
                                            )}
                                            {isOccupied && (
                                                <span className="text-[11px] font-semibold text-zinc-600 dark:text-zinc-300 flex items-center gap-1">
                                                    <ClockIcon className="w-3 h-3 shrink-0" /> {t.timeElapsed || 'Em atendimento'}
                                                </span>
                                            )}
                                            {isWaiting && (
                                                <span className="text-[11px] font-bold text-amber-600 dark:text-amber-400 flex items-center gap-1">
                                                    <ClockIcon className="w-3 h-3 shrink-0" /> {t.timeElapsed || 'Aguardando'}
                                                </span>
                                            )}
                                            {isReserved && (
                                                <span className="text-[11px] font-bold text-purple-600 dark:text-purple-400 flex items-center gap-1">
                                                    <CalendarIcon className="w-3 h-3 shrink-0" /> {t.timeElapsed ? `Reserva ${t.timeElapsed}` : 'Reservada'}
                                                </span>
                                            )}
                                            {isCleaning && (
                                                <span className="text-[11px] font-medium text-amber-700 dark:text-amber-400 flex items-center gap-1">
                                                    <ClockIcon className="w-3 h-3 shrink-0" /> {t.timeElapsed || '5min'}
                                                </span>
                                            )}
                                        </div>
                                    </div>

                                    {/* Canto Direito: Bolinha Indicadora Colorida e Seta '>' */}
                                    <div className="flex flex-col items-end justify-between self-stretch shrink-0 py-0.5">
                                        {/* Bolinha Indicadora de Status */}
                                        {isLivre && (
                                            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" title="Livre" />
                                        )}
                                        {isOccupied && (
                                            <span className="w-2.5 h-2.5 rounded-full bg-rose-500" title="Em atendimento" />
                                        )}
                                        {isWaiting && (
                                            <span className="w-2.5 h-2.5 rounded-full bg-amber-500 animate-pulse" title="Aguardando" />
                                        )}
                                        {isReserved && (
                                            <span className="w-2.5 h-2.5 rounded-full bg-purple-600" title="Reservada" />
                                        )}
                                        {isCleaning && (
                                            <span className="w-2.5 h-2.5 rounded-full bg-amber-500" title="Em limpeza" />
                                        )}

                                        {/* Seta '>' */}
                                        <span className="text-sm font-bold text-zinc-400">
                                            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                                <polyline points="9 18 15 12 9 6" />
                                            </svg>
                                        </span>
                                    </div>
                                </button>
                            );
                        })}
                    </div>

                    {filteredTables.length === 0 && (
                        <div className="py-12 text-center rounded-3xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
                            <p className="text-xs text-zinc-500 dark:text-zinc-400 font-medium">
                                Nenhuma mesa encontrada com os filtros selecionados.
                            </p>
                        </div>
                    )}
                </div>
            )}

            {/* =========================================================
                PARTE 2: DETALHE DA MESA
               ========================================================= */}
            {viewMode === 'detail' && selectedTableNumber !== null && (
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

                    {isTableFree ? (
                        <>
                            {/* Navegação: Voltar à esquerda e Seletor à direita */}
                            <div className="flex items-center justify-between w-full py-1">
                                <button
                                    type="button"
                                    onClick={() => setSearchParams({})}
                                    className="inline-flex items-center gap-2 text-xs font-bold text-zinc-700 dark:text-zinc-200 hover:text-zinc-900 transition-colors"
                                >
                                    <span className="w-8 h-8 rounded-full border border-amber-900/15 bg-[#FAF4EE] dark:bg-zinc-800 flex items-center justify-center text-zinc-700 dark:text-zinc-200 shadow-xs">
                                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                            <polyline points="15 18 9 12 15 6" />
                                        </svg>
                                    </span>
                                    Voltar
                                </button>

                                <div className="flex items-center gap-2.5">
                                    <button
                                        type="button"
                                        onClick={() => handleNavigateTable('prev')}
                                        aria-label="Mesa anterior"
                                        className="w-8 h-8 rounded-full border border-amber-900/15 bg-[#FAF4EE] dark:bg-zinc-800 flex items-center justify-center text-zinc-700 dark:text-zinc-200 hover:bg-amber-100/50 active:scale-95 transition"
                                    >
                                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                            <polyline points="15 18 9 12 15 6" />
                                        </svg>
                                    </button>
                                    <span className="font-bold text-sm text-zinc-900 dark:text-zinc-100 min-w-[64px] text-center">
                                        {selectedTableInfo?.name || `Mesa ${String(selectedTableNumber).padStart(2, '0')}`}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => handleNavigateTable('next')}
                                        aria-label="Próxima mesa"
                                        className="w-8 h-8 rounded-full border border-amber-900/15 bg-[#FAF4EE] dark:bg-zinc-800 flex items-center justify-center text-zinc-700 dark:text-zinc-200 hover:bg-amber-100/50 active:scale-95 transition"
                                    >
                                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                            <polyline points="9 18 15 12 9 6" />
                                        </svg>
                                    </button>
                                </div>
                            </div>

                            {/* Banner Panorâmico com Foto Grande no Topo */}
                            <div className="h-64 w-full rounded-t-3xl overflow-hidden relative shadow-sm bg-zinc-900">
                                <img
                                    src="https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?auto=format&fit=crop&w=1200&q=80"
                                    alt={`Mesa ${selectedTableNumber}`}
                                    className="w-full h-full object-cover brightness-[0.75]"
                                />
                                <div className="absolute inset-0 bg-gradient-to-b from-black/50 via-transparent to-black/30" />

                                {/* Textos no Topo Esquerdo */}
                                <div className="absolute top-6 left-5 text-white">
                                    <h2 className="text-3xl font-extrabold tracking-tight leading-none drop-shadow-sm">
                                        {selectedTableInfo?.name || `Mesa ${String(selectedTableNumber).padStart(2, '0')}`}
                                    </h2>
                                    <p className="text-sm text-zinc-200 mt-1 font-medium drop-shadow-xs">
                                        {selectedTableInfo?.area || selectedTable?.label || 'Salão principal'}
                                    </p>
                                </div>

                                {/* Badge Flutuante no Topo Direito */}
                                <div className="absolute top-5 right-5">
                                    {selectedTableInfo?.status === 'reserved' ? (
                                        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-purple-600/95 text-white text-xs font-bold backdrop-blur-md shadow-xs">
                                            <span className="w-1.5 h-1.5 rounded-full bg-white shrink-0" />
                                            Reservada
                                        </span>
                                    ) : (
                                        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-100 text-emerald-800 text-xs font-bold shadow-xs">
                                            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                <path d="M4 18v3M20 18v3M3 11h18M5 11l1-6h12l1 6" />
                                            </svg>
                                            Livre
                                        </span>
                                    )}
                                </div>
                            </div>

                            {/* Card de Reserva se houver */}
                            {selectedTableInfo?.status === 'reserved' && tableActiveReservations.length > 0 && (
                                <div className="rounded-2xl border border-purple-200 dark:border-purple-800 bg-purple-50/70 dark:bg-purple-950/30 p-4 text-xs space-y-2">
                                    <div className="flex items-center gap-2 text-purple-800 dark:text-purple-300 font-bold mb-1">
                                        <CalendarIcon className="w-4 h-4 text-purple-700 dark:text-purple-400" />
                                        {tableActiveReservations.length === 1
                                            ? 'Mesa com Reserva Confirmada'
                                            : `Mesa com ${tableActiveReservations.length} Reservas Agendadas`}
                                    </div>

                                    {tableActiveReservations.length === 1 ? (
                                        <p className="text-purple-700 dark:text-purple-200 leading-relaxed">
                                            Reserva para <strong>{tableActiveReservations[0].customerName}</strong> às <strong>{tableActiveReservations[0].time}</strong> ({tableActiveReservations[0].guestsCount} pessoas).
                                        </p>
                                    ) : (
                                        <div className="space-y-1.5 pt-1">
                                            <p className="text-purple-600 dark:text-purple-300 font-medium">
                                                Selecione qual cliente está chegando para acomodá-lo:
                                            </p>
                                            {tableActiveReservations.map((res) => (
                                                <div key={res.id} className="flex items-center justify-between p-2 rounded-xl bg-white/70 dark:bg-zinc-800/70 border border-purple-100 dark:border-purple-900/50">
                                                    <div>
                                                        <span className="font-bold text-zinc-900 dark:text-zinc-100">{res.customerName}</span>
                                                        <span className="text-zinc-500 text-[11px] ml-2 dark:text-zinc-300">({res.time} • {res.guestsCount}p)</span>
                                                    </div>
                                                    <button
                                                        type="button"
                                                        disabled={busyAction}
                                                        onClick={() => void handleAssumeTable(selectedTableNumber, res.id)}
                                                        className="px-3 py-1 rounded-lg bg-purple-700 hover:bg-purple-800 text-white font-bold text-[11px] shadow-xs cursor-pointer transition disabled:opacity-50"
                                                    >
                                                        Acomodar este
                                                    </button>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Card de Ação Principal: Mesa Disponível (Sobreposto) */}
                            <div className="-mt-12 relative z-10 bg-[#FCF9F5] dark:bg-zinc-900 rounded-3xl p-5 shadow-sm border border-amber-900/10">
                                <div className="flex items-center gap-3.5">
                                    <div className="w-14 h-14 rounded-full bg-[#F5EBE1] dark:bg-zinc-800 flex items-center justify-center shrink-0 text-[#7C2D12] dark:text-amber-200">
                                        <svg className="w-7 h-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <path d="M3 10h18" />
                                            <path d="M5 10v9" />
                                            <path d="M19 10v9" />
                                            <path d="M5 14h14" />
                                            <path d="M8 14v5" />
                                            <path d="M16 14v5" />
                                        </svg>
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <h3 className="text-lg font-bold text-zinc-900 dark:text-white leading-tight">
                                            {tableActiveReservations.length > 0 ? 'Iniciar Atendimento' : 'Mesa disponível'}
                                        </h3>
                                        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 leading-relaxed">
                                            {tableActiveReservations.length > 0
                                                ? 'Abra o atendimento da mesa e vincule a reserva confirmada.'
                                                : 'Esta mesa está livre e pronta para atendimento.'}
                                        </p>
                                    </div>
                                </div>

                                {tableActiveReservations.length === 1 ? (
                                    <div className="mt-4 space-y-2">
                                        <button
                                            type="button"
                                            disabled={busyAction}
                                            onClick={() => void handleAssumeTable(selectedTableNumber, tableActiveReservations[0].id)}
                                            className="w-full py-3.5 rounded-2xl bg-[#610000] hover:bg-[#4a0000] active:bg-[#320e03] text-white font-bold text-sm shadow-md flex items-center justify-center gap-2 transition-all disabled:opacity-50 cursor-pointer"
                                        >
                                            <svg className="w-4 h-4 fill-white shrink-0" viewBox="0 0 24 24">
                                                <polygon points="5 3 19 12 5 21 5 3" />
                                            </svg>
                                            {busyAction ? 'Iniciando atendimento…' : `Assumir mesa (Confirmando ${tableActiveReservations[0].customerName})`}
                                        </button>
                                        <button
                                            type="button"
                                            disabled={busyAction}
                                            onClick={() => void handleAssumeTable(selectedTableNumber)}
                                            className="w-full py-2.5 rounded-xl border border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 font-semibold text-xs transition disabled:opacity-50 cursor-pointer"
                                        >
                                            Assumir mesa sem vincular reserva (cliente avulso)
                                        </button>
                                    </div>
                                ) : tableActiveReservations.length > 1 ? (
                                    <div className="mt-4">
                                        <button
                                            type="button"
                                            disabled={busyAction}
                                            onClick={() => void handleAssumeTable(selectedTableNumber)}
                                            className="w-full py-3 rounded-xl border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 font-semibold text-xs transition disabled:opacity-50 cursor-pointer"
                                        >
                                            Assumir mesa sem vincular reserva (cliente avulso)
                                        </button>
                                    </div>
                                ) : (
                                    <button
                                        type="button"
                                        disabled={busyAction}
                                        onClick={() => void handleAssumeTable(selectedTableNumber)}
                                        className="w-full py-3.5 mt-4 rounded-2xl bg-[#610000] hover:bg-[#4a0000] active:bg-[#320e03] text-white font-bold text-sm shadow-md flex items-center justify-center gap-2 transition-all disabled:opacity-50 cursor-pointer"
                                    >
                                        <svg className="w-4 h-4 fill-white shrink-0" viewBox="0 0 24 24">
                                            <polygon points="5 3 19 12 5 21 5 3" />
                                        </svg>
                                        {busyAction ? 'Iniciando atendimento…' : 'Assumir atendimento desta mesa'}
                                    </button>
                                )}
                            </div>

                            {/* Card "Informações da mesa" (3 Mini-Cards Lado a Lado) */}
                            <div className="mt-4">
                                <div className="font-bold text-sm text-zinc-800 dark:text-zinc-200 mb-3 flex items-center gap-2">
                                    <div className="w-5 h-5 rounded-full bg-[#faede6] dark:bg-zinc-800 flex items-center justify-center text-[#610000] dark:text-rose-400">
                                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                            <path d="M4 18v3M20 18v3M3 11h18M5 11l1-6h12l1 6" />
                                        </svg>
                                    </div>
                                    Informações da mesa
                                </div>

                                <div className="grid grid-cols-3 gap-2.5">
                                    {/* 1. Local */}
                                    <div className="flex items-center gap-2 p-2.5 rounded-2xl border border-amber-900/10 dark:border-zinc-800 bg-[#FCF9F5] dark:bg-zinc-900 shadow-xs">
                                        <div className="text-[#a83a22] dark:text-rose-400 shrink-0">
                                            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                                                <circle cx="12" cy="10" r="3" />
                                            </svg>
                                        </div>
                                        <div className="flex flex-col min-w-0">
                                            <span className="text-[11px] text-zinc-400 font-medium leading-tight">Local</span>
                                            <span className="text-xs font-bold text-zinc-900 dark:text-white truncate mt-0.5">
                                                {selectedTableInfo?.area || selectedTable?.label || 'Salão principal'}
                                            </span>
                                        </div>
                                    </div>

                                    {/* 2. Capacidade */}
                                    <div className="flex items-center gap-2 p-2.5 rounded-2xl border border-amber-900/10 dark:border-zinc-800 bg-[#FCF9F5] dark:bg-zinc-900 shadow-xs">
                                        <div className="text-[#a83a22] dark:text-rose-400 shrink-0">
                                            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                                                <circle cx="9" cy="7" r="4" />
                                                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                                                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                                            </svg>
                                        </div>
                                        <div className="flex flex-col min-w-0">
                                            <span className="text-[11px] text-zinc-400 font-medium leading-tight">Capacidade</span>
                                            <span className="text-xs font-bold text-zinc-900 dark:text-white truncate mt-0.5">
                                                4 pessoas
                                            </span>
                                        </div>
                                    </div>

                                    {/* 3. Tempo livre */}
                                    <div className="flex items-center gap-2 p-2.5 rounded-2xl border border-amber-900/10 dark:border-zinc-800 bg-[#FCF9F5] dark:bg-zinc-900 shadow-xs">
                                        <div className="text-[#a83a22] dark:text-rose-400 shrink-0">
                                            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                <circle cx="12" cy="12" r="10" />
                                                <polyline points="12 6 12 12 16 14" />
                                            </svg>
                                        </div>
                                        <div className="flex flex-col min-w-0">
                                            <span className="text-[11px] text-zinc-400 font-medium leading-tight">Tempo livre</span>
                                            <span className="text-xs font-bold text-zinc-900 dark:text-white truncate mt-0.5">
                                                Livre agora
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Card Educativo "Como o cliente encontra o código?" */}
                            <div className="relative bg-[#FCF9F5] dark:bg-zinc-900 rounded-3xl p-5 pr-32 border border-amber-900/10 shadow-sm overflow-hidden min-h-[125px] flex flex-col justify-center">
                                <div className="flex items-start gap-2.5">
                                    <img src="/icons/ideia.png" alt="Dica" className="w-6 h-6 object-contain shrink-0 mt-0.5" />
                                    <div>
                                        <h4 className="font-extrabold text-sm text-zinc-900 dark:text-white leading-snug">
                                            Como o cliente encontra o código?
                                        </h4>
                                        <p className="text-xs text-zinc-500 mt-1.5 leading-relaxed dark:text-zinc-300">
                                            O cliente escaneia o QR Code da mesa e um código de 6 dígitos é gerado automaticamente.
                                        </p>
                                    </div>
                                </div>
                                <img
                                    src="/icons/mao.png"
                                    alt="Código no celular"
                                    className="absolute bottom-0 right-1 h-[118px] w-auto object-contain object-bottom pointer-events-none select-none"
                                />
                            </div>
                        </>
                    ) : (
                        <>
                            {/* Botão Voltar simples */}
                            <div className="py-0.5">
                                <button
                                    type="button"
                                    onClick={() => setSearchParams({})}
                                    className="inline-flex items-center gap-1.5 text-xs font-bold text-zinc-700 dark:text-zinc-200 hover:text-zinc-900 transition-colors py-1 cursor-pointer"
                                >
                                    <svg className="w-4 h-4 text-zinc-500 dark:text-zinc-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                        <polyline points="15 18 9 12 15 6" />
                                    </svg>
                                    Voltar
                                </button>
                            </div>

                            {/* Cabeçalho Compacto da Mesa em Atendimento */}
                            <div className="bg-[#FCF9F5] dark:bg-zinc-900 rounded-3xl p-4 border border-amber-900/10 dark:border-zinc-800 shadow-xs">
                                {/* Linha Superior: Ícone + Título/Área + Badge */}
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                        <div className="w-12 h-12 rounded-2xl bg-[#FAF4EE] dark:bg-zinc-800 flex items-center justify-center text-[#7C2D12] dark:text-amber-200 shrink-0">
                                            <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                                <path d="M4 18v3M20 18v3M3 11h18M5 11l1-6h12l1 6" />
                                                <path d="M4 11c0 2 1.5 3 3 3s3-1 3-3c0 2 1.5 3 3 3s3-1 3-3c0 2 1.5 3 3 3s3-1 3-3" />
                                            </svg>
                                        </div>
                                        <div>
                                            <h2 className="text-xl font-extrabold text-zinc-900 dark:text-white leading-tight">
                                                {selectedTableInfo?.name || `Mesa ${String(selectedTableNumber).padStart(2, '0')}`}
                                            </h2>
                                            <p className="text-xs text-zinc-400 dark:text-zinc-500 font-medium mt-0.5">
                                                {selectedTableInfo?.area || selectedTable?.label || 'Salão principal'}
                                            </p>
                                        </div>
                                    </div>

                                    {/* Badge Status */}
                                    {(isMyVisit || role === 'admin') ? (
                                        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-900/40 text-xs font-semibold shadow-2xs">
                                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0 animate-pulse" />
                                            Em atendimento por você
                                        </span>
                                    ) : (
                                        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-900/40 text-xs font-semibold shadow-2xs">
                                            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
                                            Outro garçom
                                        </span>
                                    )}
                                </div>

                                {/* Linha com 3 Métricas */}
                                <div className="grid grid-cols-3 gap-2 mt-3.5">
                                    <div className="bg-[#FAF4EE]/70 dark:bg-zinc-800/60 rounded-2xl p-2.5 flex items-center gap-2">
                                        <ClockIcon className="w-4 h-4 text-zinc-500 dark:text-zinc-400 shrink-0" />
                                        <div className="flex flex-col min-w-0">
                                            <span className="text-[10px] text-zinc-400 font-medium leading-none">Início</span>
                                            <span className="text-xs font-bold text-zinc-900 dark:text-white mt-1">
                                                {currentTableVisit?.opened_at
                                                    ? new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(new Date(currentTableVisit.opened_at))
                                                    : '--:--'}
                                            </span>
                                        </div>
                                    </div>

                                    <div className="bg-[#FAF4EE]/70 dark:bg-zinc-800/60 rounded-2xl p-2.5 flex items-center gap-2">
                                        <UsersIcon className="w-4 h-4 text-zinc-500 dark:text-zinc-400 shrink-0" />
                                        <div className="flex flex-col min-w-0">
                                            <span className="text-[10px] text-zinc-400 font-medium leading-none">Ocupação</span>
                                            <span className="text-xs font-bold text-zinc-900 dark:text-white mt-1">
                                                {selectedTableInfo?.capacity ? `${selectedTableInfo.capacity} pessoas` : '4 pessoas'}
                                            </span>
                                        </div>
                                    </div>

                                    <div className="bg-[#FAF4EE]/70 dark:bg-zinc-800/60 rounded-2xl p-2.5 flex items-center gap-2">
                                        <HourglassIcon className="w-4 h-4 text-zinc-500 dark:text-zinc-400 shrink-0" />
                                        <div className="flex flex-col min-w-0">
                                            <span className="text-[10px] text-zinc-400 font-medium leading-none">Tempo</span>
                                            <span className="text-xs font-bold text-zinc-900 dark:text-white mt-1">
                                                {formatMinutes(currentTableVisit?.opened_at) || '1h 24min'}
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
                                {isOtherStaffVisit && role !== 'admin' && (
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
                                            Apenas o garçom responsável pode confirmar clientes, administrar comandas ou encerrar o atendimento.
                                        </p>
                                    </div>
                                )}

                                {/* Se for minha visita ou admin */}
                                {(isMyVisit || role === 'admin') && currentTableVisit && (
                                    <>
                                        {/* Chamados da mesa específica se houver */}
                                        {activeRequestsOnTable > 0 && (
                                            <div className="rounded-2xl border border-amber-300/80 bg-amber-50/90 dark:bg-amber-950/40 dark:border-amber-900/50 p-3 text-xs">
                                                <div className="flex items-center justify-between gap-2">
                                                    <div>
                                                        <span className="font-semibold text-amber-950 dark:text-amber-200">
                                                            Chamados desta mesa:
                                                        </span>{' '}
                                                        <span className="text-amber-900 dark:text-amber-300 font-bold">
                                                            {activeRequestsOnTable} ativo{activeRequestsOnTable > 1 ? 's' : ''}
                                                        </span>
                                                    </div>
                                                    {!confirmDismissRequests && (
                                                        <button
                                                            type="button"
                                                            disabled={busyAction}
                                                            onClick={() => setConfirmDismissRequests(true)}
                                                            className="rounded-lg bg-amber-700 hover:bg-amber-800 px-2.5 py-1 text-xs font-semibold text-white transition-colors disabled:opacity-50"
                                                        >
                                                            Encerrar chamados
                                                        </button>
                                                    )}
                                                </div>
                                                {confirmDismissRequests && (
                                                    <div className="mt-2 pt-2 border-t border-amber-200 dark:border-amber-900/40">
                                                        <p className="text-amber-900 dark:text-amber-200 mb-2">
                                                            Encerrar {activeRequestsOnTable} chamado(s) da Mesa {String(selectedTableNumber).padStart(2, '0')}? A ação cancela chamados pendentes/em atendimento sem fechar comandas.
                                                        </p>
                                                        <div className="flex gap-2">
                                                            <button
                                                                type="button"
                                                                disabled={busyAction}
                                                                onClick={() => void handleDismissTableRequests(selectedTableNumber!)}
                                                                className="rounded-lg bg-amber-700 hover:bg-amber-800 px-3 py-1 font-medium text-white transition-colors disabled:opacity-50"
                                                            >
                                                                {busyAction ? 'Encerrando…' : 'Confirmar encerramento'}
                                                            </button>
                                                            <button
                                                                type="button"
                                                                disabled={busyAction}
                                                                onClick={() => setConfirmDismissRequests(false)}
                                                                className="rounded-lg border border-amber-300 dark:border-amber-800 bg-white dark:bg-zinc-800 px-3 py-1 font-medium text-amber-900 dark:text-amber-200"
                                                            >
                                                                Cancelar
                                                            </button>
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        )}

                                        {/* ABA 1: ACESSO DA MESA (TECLADO NUMÉRICO E CÓDIGO DE 6 DÍGITOS) */}
                                        {tableActiveTab === 'access' && (
                                            <GuestConfirmationForm
                                                restaurantSlug={restaurantSlug}
                                                tableNumber={selectedTableNumber}
                                                onConfirmed={() => {
                                                    if (selectedTableNumber !== null) {
                                                        setTableLocallyAuthorized(restaurantId, selectedTableNumber, currentTableVisit?.id);
                                                    }
                                                    setRefresh((c) => c + 1);
                                                    setTableActiveTab('tab');
                                                    setShowConfirmedToast(true);
                                                }}
                                            />
                                        )}

                                        {/* ABA 2: COMANDA (CRIAÇÃO E CONSUMO DAS COMANDAS) */}
                                        {tableActiveTab === 'tab' && (
                                            <TableTabsPanel
                                                restaurantSlug={restaurantSlug}
                                                restaurantId={restaurantId}
                                                tableVisitId={currentTableVisit.id}
                                                tableNumber={selectedTableNumber}
                                                role={role}
                                                onOpenTabsCountChange={handleOpenTabsCountChange}
                                                onRequestCloseVisit={() => setConfirmCloseMesa(true)}
                                                showSuccessToast={showConfirmedToast}
                                                onCloseSuccessToast={() => setShowConfirmedToast(false)}
                                            />
                                        )}

                                        {/* ABA 3: DETALHES (GESTÃO E ENCERRAMENTO DA MESA) */}
                                        {tableActiveTab === 'details' && currentTableVisit && (
                                            <TableDetailsTabPanel
                                                restaurantSlug={restaurantSlug}
                                                restaurantId={restaurantId}
                                                tableVisit={currentTableVisit}
                                                tableNumber={selectedTableNumber!}
                                                tableInfo={selectedTableInfo}
                                                tableItem={selectedTable}
                                                freeTables={allTables
                                                    .filter((t) => t.table_number !== selectedTableNumber && !salonVisits.some((v) => v.table.table_number === t.table_number))
                                                    .map((t) => {
                                                        const info = displayTables.find((d) => d.table_number === t.table_number);
                                                        return {
                                                            id: t.id,
                                                            table_number: t.table_number,
                                                            label: t.label,
                                                            capacity: info?.capacity,
                                                        };
                                                    })}
                                                onCloseVisitSuccess={() => {
                                                    if (selectedTableNumber !== null && currentTableVisit?.id) {
                                                        clearTableLocallyAuthorized(restaurantId, selectedTableNumber, currentTableVisit.id);
                                                    }
                                                    setTableActiveTab('access');
                                                    setRefresh((c) => c + 1);
                                                    setSearchParams((prev) => {
                                                        const next = new URLSearchParams(prev);
                                                        next.delete('mesa');
                                                        return next;
                                                    });
                                                    setToasts((prev) => [
                                                        ...prev,
                                                        {
                                                            id: crypto.randomUUID(),
                                                            restaurant_id: restaurantId,
                                                            type: 'system',
                                                            title: 'Mesa encerrada',
                                                            message: `Mesa ${String(selectedTableNumber).padStart(2, '0')} encerrada com sucesso!`,
                                                            is_read: false,
                                                            reference_id: null,
                                                            created_at: new Date().toISOString(),
                                                        },
                                                    ]);
                                                }}
                                            />
                                        )}
                                        {/* Ação: Encerrar atendimento da mesa */}
                                        <div className="mt-4 pt-3 border-t border-amber-900/10 dark:border-zinc-800">
                                            {confirmCloseMesa ? (
                                                <div className="rounded-2xl border border-rose-200 dark:border-rose-900/60 bg-rose-50/70 dark:bg-rose-950/40 p-4 space-y-3">
                                                    <div>
                                                        <h4 className="text-xs font-bold text-rose-950 dark:text-rose-200">
                                                            Encerrar atendimento da Mesa {String(selectedTableNumber).padStart(2, '0')}?
                                                        </h4>
                                                        <p className="text-xs text-rose-800 dark:text-rose-300 mt-1 leading-relaxed">
                                                            Todas as sessões de clientes vinculadas a esta mesa serão revogadas e o atendimento será finalizado.
                                                        </p>
                                                        {openTabsCount > 0 && (
                                                            <div className="mt-2 p-2.5 rounded-xl bg-amber-100/80 dark:bg-amber-900/40 border border-amber-300 dark:border-amber-700 text-xs font-semibold text-amber-950 dark:text-amber-200">
                                                                Atenção: existem {openTabsCount} comanda(s) aberta(s). Todas as comandas devem ser fechadas antes de encerrar o atendimento.
                                                            </div>
                                                        )}
                                                    </div>
                                                    <div className="flex gap-2">
                                                        <button
                                                            type="button"
                                                            disabled={busyAction || openTabsCount > 0}
                                                            onClick={() => void handleCloseVisit(currentTableVisit.id)}
                                                            className="flex-1 py-2.5 rounded-xl bg-red-700 hover:bg-red-800 text-white font-bold text-xs shadow-xs transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                                                        >
                                                            {busyAction ? 'Encerrando…' : 'Confirmar encerramento da mesa'}
                                                        </button>
                                                        <button
                                                            type="button"
                                                            disabled={busyAction}
                                                            onClick={() => setConfirmCloseMesa(false)}
                                                            className="px-4 py-2.5 rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700 cursor-pointer"
                                                        >
                                                            Cancelar
                                                        </button>
                                                    </div>
                                                </div>
                                            ) : (
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        if (openTabsCount > 0) {
                                                            setActionError(`Existem ${openTabsCount} comanda(s) aberta(s). Encerre todas as comandas antes de finalizar o atendimento da mesa.`);
                                                            return;
                                                        }
                                                        setConfirmCloseMesa(true);
                                                        setActionError('');
                                                    }}
                                                    disabled={busyAction}
                                                    className={`w-full py-3 px-4 rounded-2xl font-bold text-xs flex items-center justify-center gap-2 transition shadow-xs cursor-pointer ${
                                                        openTabsCount > 0
                                                            ? 'border border-zinc-300 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800 text-zinc-400 dark:text-zinc-500 cursor-not-allowed'
                                                            : 'border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/60'
                                                    }`}
                                                >
                                                    <svg className="w-4 h-4 text-red-600 dark:text-red-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                        <circle cx="12" cy="12" r="10" />
                                                        <line x1="15" y1="9" x2="9" y2="15" />
                                                        <line x1="9" y1="9" x2="15" y2="15" />
                                                    </svg>
                                                    <span>
                                                        {openTabsCount > 0
                                                            ? `Encerre as comandas para finalizar a mesa (${openTabsCount} aberta${openTabsCount > 1 ? 's' : ''})`
                                                            : `Encerrar atendimento da Mesa ${String(selectedTableNumber).padStart(2, '0')}`}
                                                    </span>
                                                </button>
                                            )}
                                        </div>
                                    </>
                                )}
                            </div>
                        </>
                    )}
                </div>
            )}

            {/* =========================================================
                MODAL/DRAWER: OPÇÕES DO SALÃO (BOTÃO MAIS)
               ========================================================= */}
            {moreDrawerOpen && (
                <div
                    className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-end justify-center p-4"
                    onClick={() => setMoreDrawerOpen(false)}
                >
                    <div
                        className="w-full max-w-sm rounded-3xl bg-white dark:bg-zinc-900 p-5 shadow-2xl border border-zinc-200 dark:border-zinc-800"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="w-10 h-1 bg-zinc-300 dark:bg-zinc-700 rounded-full mx-auto mb-4" />
                        <h3 className="text-sm font-bold text-zinc-900 dark:text-white mb-3">Opções do Salão</h3>

                        <div className="space-y-2">
                            <button
                                type="button"
                                onClick={() => {
                                    setTableActiveTab('access');
            setRefresh((c) => c + 1);
                                    setMoreDrawerOpen(false);
                                }}
                                className="w-full py-2.5 px-3 rounded-xl hover:bg-zinc-100 dark:hover:bg-zinc-800 text-left text-xs font-medium text-zinc-800 dark:text-zinc-200 flex items-center justify-between transition-colors"
                            >
                                <span>Atualizar mesas em tempo real</span>
                                <span>🔄</span>
                            </button>

                            <div className="py-2 border-t border-zinc-100 dark:border-zinc-800">
                                <SoundSettingsControl showLabels />
                            </div>

                            {role === 'admin' && (
                                <Link
                                    to={`/${restaurantSlug}/admin/mesas`}
                                    className="w-full py-2.5 px-3 rounded-xl hover:bg-zinc-100 dark:hover:bg-zinc-800 text-left text-xs font-medium text-zinc-800 dark:text-zinc-200 flex items-center justify-between transition-colors text-decoration-none block"
                                >
                                    <span>Painel Admin de Mesas e Reservas</span>
                                    <span>⚙️</span>
                                </Link>
                            )}
                        </div>

                        <button
                            type="button"
                            onClick={() => setMoreDrawerOpen(false)}
                            className="w-full mt-4 py-2.5 rounded-xl bg-zinc-100 dark:bg-zinc-800 text-xs font-bold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
                        >
                            Fechar
                        </button>
                    </div>
                </div>
            )}

            {/* =========================================================
                TOASTS FLUTUANTES EM TEMPO REAL PARA GARÇOM / EQUIPE
               ========================================================= */}
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
                        const meta = getStaffAlertMeta(toast, restaurantSlug);

                        return (
                            <div
                                key={toast.id}
                                style={{
                                    pointerEvents: 'auto',
                                    backgroundColor: 'var(--color-bg-panel, #ffffff)',
                                    color: 'var(--color-text-main, #1c1917)',
                                    borderRadius: '16px',
                                    border: '1px solid var(--color-border, #e5e7eb)',
                                    borderLeft: `4px solid ${meta.color}`,
                                    boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.15)',
                                    padding: '12px 14px',
                                    display: 'flex',
                                    alignItems: 'flex-start',
                                    gap: '12px',
                                }}
                            >
                                <div style={{ color: meta.color, flexShrink: 0, marginTop: '2px' }}>
                                    {toast.type === 'dish_ready' ? (
                                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                                            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                                            <polyline points="22 4 12 14.01 9 11.01" />
                                        </svg>
                                    ) : toast.type === 'close_table_request' ? (
                                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                                            <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z" />
                                            <path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" />
                                            <path d="M12 6v12" />
                                        </svg>
                                    ) : (
                                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                                            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                                            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                                        </svg>
                                    )}
                                </div>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px' }}>
                                        <span
                                            style={{
                                                fontSize: '10px',
                                                fontWeight: 700,
                                                textTransform: 'uppercase',
                                                color: meta.color,
                                                letterSpacing: '0.04em',
                                            }}
                                        >
                                            {meta.badgeLabel}
                                        </span>
                                    </div>
                                    <p
                                        style={{
                                            margin: 0,
                                            fontSize: '13px',
                                            fontWeight: 600,
                                            color: 'var(--color-text-main, #111827)',
                                        }}
                                    >
                                        {toast.title}
                                    </p>
                                    <p
                                        style={{
                                            margin: '2px 0 6px',
                                            fontSize: '12px',
                                            color: 'var(--color-text-muted, #4b5563)',
                                            lineHeight: 1.4,
                                        }}
                                    >
                                        {toast.message}
                                    </p>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                removeToast(toast.id);
                                                const match = toast.title.match(/Mesa\s+(\d+)/i);
                                                if (match && match[1]) {
                                                    setSearchParams({ mesa: match[1] });
                                                }
                                            }}
                                            style={{
                                                fontSize: '11px',
                                                fontWeight: 600,
                                                color: meta.color,
                                                background: 'transparent',
                                                border: 'none',
                                                cursor: 'pointer',
                                                padding: 0,
                                            }}
                                            className="hover:underline"
                                        >
                                            {meta.actionLabel} →
                                        </button>
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
                                        color: 'var(--color-text-muted, #9ca3af)',
                                        borderRadius: '4px',
                                        flexShrink: 0,
                                    }}
                                    className="hover:text-zinc-700 dark:hover:text-zinc-300"
                                >
                                    <svg
                                        width="16"
                                        height="16"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        aria-hidden="true"
                                    >
                                        <line x1="18" y1="6" x2="6" y2="18" />
                                        <line x1="6" y1="6" x2="18" y2="18" />
                                    </svg>
                                </button>
                            </div>
                        );
                    })}
                </div>
            )}
        </section>
    );
}

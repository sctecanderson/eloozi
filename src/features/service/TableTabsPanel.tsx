import { useEffect, useRef, useState, useMemo } from 'react';
import { Link } from 'react-router';
import { supabase } from '../../lib/supabase';
import {
  closeTableTab,
  createTableTab,
  getTableTabsState,
  linkGuestToTableTab,
  calculateTabClosurePreview,
  calculateTabClosureFee,
} from './tableTabs';
import type { TableTab, TableTabsState } from './tableTabs';
import {
  addTabConsumption,
  cancelTabConsumption,
  cancelTabConsumptionBatch,
  transferTabConsumptionItems,
  getTabConsumption,
} from './tabConsumption';
import type { TabConsumptionItem } from './tabConsumption';
import {
  paginateComandaItems,
  ITEMS_PAGE_SIZE,
  COLLAPSED_LIMIT,
} from './comandaItemsPagination';
import type { PaginationResult } from './comandaItemsPagination';
import {
  getIndividualTabs,
  shouldShowContaConjunta,
  isSharedLabel,
} from './contaConjuntaRules';
import {
  validateCancellationReason,
  formatMoveItemAuditReason,
  formatTransferTableAuditReason,
} from './cancellationRules';
import {
  paginateCatalogProducts,
  CATALOG_PAGE_SIZE,
} from './catalogPagination';
import {
  calculateSplitBill,
  parseSplitPeopleCount,
} from './splitBillRules';
import { useRestaurant } from '../restaurants/RestaurantProvider';
import { printTableBillThermal } from '../../components/ThermalReceiptPrint';

interface TableTabsPanelProps {
  restaurantSlug: string;
  restaurantId: string;
  tableVisitId: string;
  tableNumber?: number | string;
  role?: 'admin' | 'waiter';
  onOpenTabsCountChange?: (count: number) => void;
  showSuccessToast?: boolean;
  onCloseSuccessToast?: () => void;
  onNavigateToCatalog?: (tabId?: string) => void;
  initialTabId?: string | null;
  onTabSelected?: (tabId: string | null) => void;
  initialSearchQuery?: string;
  onSearchQueryChange?: (query: string) => void;
}

interface MenuCategoryItem {
  id: string;
  name: string;
  slug: string;
  sort_order: number;
}

interface MenuProductItem {
  id: string;
  category_id: string;
  name: string;
  short_description: string;
  description: string;
  price_in_cents: number;
  available: boolean;
  images?: Array<{ url: string; alt?: string }>;
  sort_order: number;
}

export interface TabConsumptionEntry {
  status: 'loading' | 'loaded' | 'error';
  items: TabConsumptionItem[];
  totalInCents: number;
  error?: string;
  isStale?: boolean;
}

export type ReloadConsumptionResult =
  | { status: 'success'; data: { items: TabConsumptionItem[]; totalInCents: number } }
  | { status: 'error'; error: string }
  | { status: 'discarded'; reason: 'unmounted' | 'visit_changed' | 'superseded' };

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export function TableTabsPanel(props: TableTabsPanelProps) {
  return (
    <TableTabsContent
      key={`${props.restaurantSlug}:${props.tableVisitId}`}
      {...props}
    />
  );
}

function TableTabsContent({
  restaurantSlug,
  restaurantId,
  tableVisitId,
  tableNumber,
  role = 'waiter',
  onOpenTabsCountChange,
  showSuccessToast,
  onCloseSuccessToast,
  initialTabId,
  onTabSelected,
  initialSearchQuery,
  onSearchQueryChange,
}: TableTabsPanelProps) {
  const submitting = useRef(false);
  const initialLoaded = useRef(false);
  const onOpenTabsCountChangeRef = useRef(onOpenTabsCountChange);
  onOpenTabsCountChangeRef.current = onOpenTabsCountChange;

  const { restaurant } = useRestaurant();

  // MÁQUINA DE ESTADOS DA ABA "COMANDA":
  // false = ESTADO 1: TELA 3 (Gestão de Comandas & Estado Vazio)
  // true  = ESTADO 2: TELA 4 (Modo Catálogo / Registro de Consumo)
  const [isCatalogOpen, setIsCatalogOpen] = useState(() => {
    try {
      return sessionStorage.getItem(`elz_catalog_mode_${tableVisitId}`) === 'true';
    } catch {
      return false;
    }
  });

  const [state, setState] = useState<TableTabsState>({
    tabs: [],
    guests: [],
    links: [],
  });

  const [selectedTabId, setSelectedTabId] = useState<string | null>(() => {
    if (initialTabId) return initialTabId;
    try {
      return sessionStorage.getItem(`elz_catalog_tab_${tableVisitId}`);
    } catch {
      return null;
    }
  });

  const currentVisitIdRef = useRef(tableVisitId);
  currentVisitIdRef.current = tableVisitId;
  const loadVersionRef = useRef(0);
  const catalogVersionRef = useRef(0);
  const tabVersionRef = useRef<Record<string, number>>({});
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const [tabConsumptions, setTabConsumptions] = useState<Record<string, TabConsumptionEntry>>({});
  const tabConsumptionsRef = useRef<Record<string, TabConsumptionEntry>>({});
  tabConsumptionsRef.current = tabConsumptions;

  // Edição e persistência de nome das comandas
  const [editingLabels, setEditingLabels] = useState<Record<string, string>>({});
  const [editingCardTabId, setEditingCardTabId] = useState<string | null>(null);

  // Modal / input inline para "Adicionar pessoa" no carrossel
  const [isAddingPerson, setIsAddingPerson] = useState(false);
  const [newPersonName, setNewPersonName] = useState('');
  const [newPersonGuestId, setNewPersonGuestId] = useState('');

  // Draft de criação de comanda na Tela 3
  const [isCreatingDraft, setIsCreatingDraft] = useState(false);
  const [draftName, setDraftName] = useState('');

  // Observações por comanda (Tela 4)
  const [tabObservations, setTabObservations] = useState<Record<string, string>>({});
  const [isEditingObservation, setIsEditingObservation] = useState(false);
  const [observationInput, setObservationInput] = useState('');

  // Catálogo de produtos e categorias (Tela 4) — estritamente real do banco
  const [categories, setCategories] = useState<MenuCategoryItem[]>([]);
  const [products, setProducts] = useState<MenuProductItem[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>('todos');
  const [searchQuery, setSearchQuery] = useState(initialSearchQuery || '');
  const [catalogPage, setCatalogPage] = useState<number>(1);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogReloadKey, setCatalogReloadKey] = useState(0);

  function retryLoadCatalog() {
    setCatalogReloadKey((k) => k + 1);
  }

  // Menus e ações de comanda
  const [activeMenuTabId, setActiveMenuTabId] = useState<string | null>(null);
  const [linkingGuestTabId, setLinkingGuestTabId] = useState<string | null>(null);
  const [selectedGuestId, setSelectedGuestId] = useState<string>('');
  const [closingTabId, setClosingTabId] = useState<string | null>(null);
  const [closingFeeAccepted, setClosingFeeAccepted] = useState<boolean>(true);
  const [restaurantFeePercent, setRestaurantFeePercent] = useState<number>(
    restaurant?.serviceFeePercent ?? 10,
  );

  // Modais de mover para outra pessoa e transferir para outra mesa
  const [isMovePersonModalOpen, setIsMovePersonModalOpen] = useState(false);
  const [moveItemId, setMoveItemId] = useState('');
  const [moveTargetTabId, setMoveTargetTabId] = useState('');
  const [moveReason, setMoveReason] = useState('');
  const [moveReasonError, setMoveReasonError] = useState('');

  const [isTransferTableModalOpen, setIsTransferTableModalOpen] = useState(false);
  const [transferItemId, setTransferItemId] = useState('');
  const [transferTargetTableId, setTransferTargetTableId] = useState('');
  const [transferTableTargetTabs, setTransferTableTargetTabs] = useState<Array<{ id: string; label: string }>>([]);
  const [transferTableTargetTabId, setTransferTableTargetTabId] = useState('');
  const [loadingTargetTabs, setLoadingTargetTabs] = useState(false);
  const [transferReason, setTransferReason] = useState('');
  const [transferReasonError, setTransferReasonError] = useState('');
  const [occupiedTables, setOccupiedTables] = useState<
    Array<{ id: string; table_number: number | string; label?: string | null; status?: string }>
  >([]);
  const [loadingOccupiedTables, setLoadingOccupiedTables] = useState(false);

  // Paginação e expansão dos itens da comanda selecionada
  const [isItemsExpanded, setIsItemsExpanded] = useState(false);
  const [itemsCurrentPage, setItemsCurrentPage] = useState(1);

  // Paginação independente por lista na visão de Conta Conjunta
  const [expandedContaConjuntaLists, setExpandedContaConjuntaLists] = useState<Record<string, boolean>>({});
  const [pageContaConjuntaLists, setPageContaConjuntaLists] = useState<Record<string, number>>({});

  // Modal de cancelamento de item com motivo obrigatório para auditoria
  interface CancellingItemState {
    itemIds: string[];
    productName: string;
    quantity: number;
    unitPriceInCents: number;
    lineTotalInCents: number;
    tabId: string;
  }
  const [cancellingItem, setCancellingItem] = useState<CancellingItemState | null>(null);
  const [cancellationReason, setCancellationReason] = useState('');
  const [cancellationSubmitting, setCancellationSubmitting] = useState(false);
  const [cancellationModalError, setCancellationModalError] = useState('');

  // Modal de Simulação de Divisão de Conta (Estimativa Visual)
  const [isSplitBillModalOpen, setIsSplitBillModalOpen] = useState(false);
  const [splitPeopleInput, setSplitPeopleInput] = useState('2');

  // Ao alterar a pessoa/comanda ou visita, atualiza corretamente a lista e a página selecionada
  useEffect(() => {
    setIsItemsExpanded(false);
    setItemsCurrentPage(1);
    setExpandedContaConjuntaLists({});
    setPageContaConjuntaLists({});
  }, [selectedTabId, tableVisitId]);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);

  // Auto-dismiss do Toast verde de confirmação
  useEffect(() => {
    if (showSuccessToast) {
      const timer = setTimeout(() => {
        onCloseSuccessToast?.();
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [showSuccessToast, onCloseSuccessToast]);

  // Carregar produtos e categorias reais para o catálogo (SEM FALLBACKS FICTÍCIOS)
  useEffect(() => {
    let disposed = false;

    async function loadCatalog() {
      const catVersion = ++catalogVersionRef.current;
      setCatalogLoading(true);
      setCatalogError(null);
      try {
        const [catsRes, prodsRes] = await Promise.all([
          supabase
            .from('menu_categories')
            .select('id, name, slug, sort_order')
            .eq('restaurant_id', restaurantId)
            .eq('active', true)
            .order('sort_order', { ascending: true }),
          supabase
            .from('menu_products')
            .select('id, category_id, name, short_description, description, price_in_cents, available, images, sort_order')
            .eq('restaurant_id', restaurantId)
            .eq('available', true)
            .order('sort_order', { ascending: true }),
        ]);

        if (disposed || !isMountedRef.current || catVersion !== catalogVersionRef.current) return;

        if (catsRes.error) {
          throw new Error(`Erro ao carregar categorias: ${catsRes.error.message}`);
        }
        if (prodsRes.error) {
          throw new Error(`Erro ao carregar produtos: ${prodsRes.error.message}`);
        }

        setCategories((catsRes.data as MenuCategoryItem[]) || []);
        setProducts((prodsRes.data as MenuProductItem[]) || []);
      } catch (cause) {
        if (!disposed && isMountedRef.current && catVersion === catalogVersionRef.current) {
          setCatalogError(
            cause instanceof Error
              ? cause.message
              : 'Não foi possível carregar o cardápio. Verifique a conexão e tente novamente.',
          );
          setCategories([]);
          setProducts([]);
        }
      } finally {
        if (!disposed && isMountedRef.current && catVersion === catalogVersionRef.current) {
          setCatalogLoading(false);
        }
      }
    }

    void loadCatalog();
    return () => {
      disposed = true;
    };
  }, [restaurantId, catalogReloadKey]);

  // Carregar comandas reais do banco (SEM auto-criar registros)
  useEffect(() => {
    let disposed = false;

    async function load() {
      const currentVersion = ++loadVersionRef.current;
      const targetVisitId = tableVisitId;

      if (!initialLoaded.current) {
        setLoading(true);
      }

      try {
        const [tabsResult, restaurantRes] = await Promise.all([
          getTableTabsState(restaurantId, targetVisitId),
          supabase
            .from('restaurants')
            .select('service_fee_percent')
            .eq('id', restaurantId)
            .maybeSingle(),
        ]);

        if (
          disposed ||
          !isMountedRef.current ||
          currentVersion !== loadVersionRef.current ||
          targetVisitId !== currentVisitIdRef.current
        ) {
          return;
        }

        setState(tabsResult);
        if (restaurantRes.data?.service_fee_percent !== undefined) {
          setRestaurantFeePercent(Number(restaurantRes.data.service_fee_percent));
        }

        const openTabsList = tabsResult.tabs.filter((t) => t.status === 'open');
        onOpenTabsCountChangeRef.current?.(openTabsList.length);

        // Seleção inteligente da comanda ativa
        let currentActiveTabId: string | null = null;
        try {
          const savedTabId = sessionStorage.getItem(`elz_catalog_tab_${targetVisitId}`);
          if (savedTabId && tabsResult.tabs.some((t) => t.id === savedTabId && t.status === 'open')) {
            currentActiveTabId = savedTabId;
          }
        } catch {}

        if (!currentActiveTabId) {
          setSelectedTabId((prev) => {
            if (prev && tabsResult.tabs.some((t) => t.id === prev && t.status === 'open')) {
              currentActiveTabId = prev;
              return prev;
            }
            const fallback = openTabsList[0]?.id || tabsResult.tabs[0]?.id || null;
            currentActiveTabId = fallback;
            return fallback;
          });
        } else {
          setSelectedTabId(currentActiveTabId);
        }

        if (currentActiveTabId) {
          try {
            sessionStorage.setItem(`elz_catalog_tab_${targetVisitId}`, currentActiveTabId);
          } catch {}
        }

        // Inicializa ou preserva entradas em tabConsumptions para as comandas abertas
        setTabConsumptions((prev) => {
          const next: Record<string, TabConsumptionEntry> = {};
          for (const tab of openTabsList) {
            const cur = prev[tab.id];
            if (cur) {
              next[tab.id] = cur;
            } else {
              next[tab.id] = {
                status: 'loading',
                items: [],
                totalInCents: 0,
                isStale: false,
              };
            }
          }
          return next;
        });

        // Carrega consumo de cada comanda aberta com versão compartilhada por comanda
        await Promise.all(
          openTabsList.map(async (tab) => {
            const tabId = tab.id;
            const tabVersion = (tabVersionRef.current[tabId] = (tabVersionRef.current[tabId] || 0) + 1);

            try {
              const c = await getTabConsumption(restaurantId, tabId);
              if (
                disposed ||
                !isMountedRef.current ||
                currentVisitIdRef.current !== targetVisitId
              ) {
                return;
              }
              if (tabVersionRef.current[tabId] !== tabVersion) return;

              setTabConsumptions((prev) => ({
                ...prev,
                [tabId]: {
                  status: 'loaded',
                  items: c.items,
                  totalInCents: c.totalInCents,
                  isStale: false,
                },
              }));
            } catch (cause) {
              if (
                disposed ||
                !isMountedRef.current ||
                currentVisitIdRef.current !== targetVisitId
              ) {
                return;
              }
              if (tabVersionRef.current[tabId] !== tabVersion) return;

              setTabConsumptions((prev) => {
                const cur = prev[tabId];
                const hadPreviousData = Boolean(cur && (cur.status === 'loaded' || cur.isStale));
                return {
                  ...prev,
                  [tabId]: {
                    status: 'error',
                    items: cur?.items ?? [],
                    totalInCents: cur?.totalInCents ?? 0,
                    error:
                      cause instanceof Error
                        ? cause.message
                        : 'Falha ao consultar consumo desta comanda.',
                    isStale: hadPreviousData,
                  },
                };
              });
            }
          }),
        );

        if (
          disposed ||
          !isMountedRef.current ||
          currentVersion !== loadVersionRef.current ||
          targetVisitId !== currentVisitIdRef.current
        ) {
          return;
        }

        initialLoaded.current = true;

        // REGRA DE RENDERIZAÇÃO AUTOMÁTICA DA ABA "COMANDA":
        // 1. Se a comanda ativa possuir itens lançados (items.length > 0): Renderize IMEDIATAMENTE a Tela 4.
        // 2. Se a comanda ativa não possuir itens: Exiba a Tela 3 (a não ser que o garçom já tenha aberto o catálogo via sessionStorage).
        const activeItemsCount = currentActiveTabId
          ? (tabConsumptionsRef.current[currentActiveTabId]?.items?.filter((it) => it.status === 'active')?.length ?? 0)
          : 0;

        let storedMode: string | null = null;
        try {
          storedMode = sessionStorage.getItem(`elz_catalog_mode_${targetVisitId}`);
        } catch {}

        if (activeItemsCount > 0) {
          setIsCatalogOpen(true);
          try {
            sessionStorage.setItem(`elz_catalog_mode_${targetVisitId}`, 'true');
          } catch {}
        } else if (storedMode === 'true') {
          setIsCatalogOpen(true);
        } else {
          setIsCatalogOpen(false);
        }
      } catch (cause) {
        if (
          !disposed &&
          isMountedRef.current &&
          currentVersion === loadVersionRef.current &&
          targetVisitId === currentVisitIdRef.current
        ) {
          setActionError(
            cause instanceof Error
              ? cause.message
              : 'Não foi possível carregar as comandas.',
          );
        }
      } finally {
        if (
          !disposed &&
          isMountedRef.current &&
          currentVersion === loadVersionRef.current &&
          targetVisitId === currentVisitIdRef.current
        ) {
          setLoading(false);
        }
      }
    }

    void load();

    const channel = supabase
      .channel(`table-items-waiter:${restaurantId}:${tableVisitId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'table_tab_items',
          filter: `table_visit_id=eq.${tableVisitId}`,
        },
        () => {
          if (!disposed && isMountedRef.current && currentVisitIdRef.current === tableVisitId) {
            void load();
          }
        },
      )
      .subscribe();

    return () => {
      disposed = true;
      void supabase.removeChannel(channel);
    };
  }, [restaurantId, tableVisitId, restaurantSlug, refresh]);

  // Função centralizada para recarregar consumo de comanda com controle de versão e resultado explícito
  async function reloadTabConsumption(tabId: string): Promise<ReloadConsumptionResult> {
    const targetVisitId = currentVisitIdRef.current;
    const tabVersion = (tabVersionRef.current[tabId] = (tabVersionRef.current[tabId] || 0) + 1);

    try {
      const updated = await getTabConsumption(restaurantId, tabId);
      if (!isMountedRef.current) {
        return { status: 'discarded', reason: 'unmounted' };
      }
      if (currentVisitIdRef.current !== targetVisitId) {
        return { status: 'discarded', reason: 'visit_changed' };
      }
      if (tabVersionRef.current[tabId] !== tabVersion) {
        return { status: 'discarded', reason: 'superseded' };
      }

      setTabConsumptions((prev) => ({
        ...prev,
        [tabId]: {
          status: 'loaded',
          items: updated.items,
          totalInCents: updated.totalInCents,
          isStale: false,
        },
      }));

      return {
        status: 'success',
        data: {
          items: updated.items,
          totalInCents: updated.totalInCents,
        },
      };
    } catch (cause) {
      const errorMsg =
        cause instanceof Error
          ? cause.message
          : 'Falha ao atualizar consumo da comanda.';

      if (!isMountedRef.current) {
        return { status: 'discarded', reason: 'unmounted' };
      }
      if (currentVisitIdRef.current !== targetVisitId) {
        return { status: 'discarded', reason: 'visit_changed' };
      }
      if (tabVersionRef.current[tabId] !== tabVersion) {
        return { status: 'discarded', reason: 'superseded' };
      }

      setTabConsumptions((prev) => {
        const cur = prev[tabId];
        const hadPreviousData = Boolean(cur && (cur.status === 'loaded' || cur.isStale));
        return {
          ...prev,
          [tabId]: {
            status: 'error',
            items: cur?.items ?? [],
            totalInCents: cur?.totalInCents ?? 0,
            error: errorMsg,
            isStale: hadPreviousData,
          },
        };
      });

      return { status: 'error', error: errorMsg };
    }
  }

  // Função para re-tentar consulta de consumo de uma comanda específica
  async function handleRetryTabConsumption(tabId: string) {
    const targetVisitId = currentVisitIdRef.current;
    const tabVersion = (tabVersionRef.current[tabId] = (tabVersionRef.current[tabId] || 0) + 1);

    if (!isMountedRef.current || targetVisitId !== currentVisitIdRef.current) return;

    setTabConsumptions((prev) => {
      const cur = prev[tabId];
      const hadPreviousData = Boolean(cur && (cur.status === 'loaded' || cur.isStale));
      return {
        ...prev,
        [tabId]: {
          status: 'loading',
          items: cur?.items ?? [],
          totalInCents: cur?.totalInCents ?? 0,
          isStale: hadPreviousData,
        },
      };
    });

    try {
      const c = await getTabConsumption(restaurantId, tabId);
      if (!isMountedRef.current || currentVisitIdRef.current !== targetVisitId) return;
      if (tabVersionRef.current[tabId] !== tabVersion) return;

      setTabConsumptions((prev) => ({
        ...prev,
        [tabId]: {
          status: 'loaded',
          items: c.items,
          totalInCents: c.totalInCents,
          isStale: false,
        },
      }));
    } catch (cause) {
      if (!isMountedRef.current || currentVisitIdRef.current !== targetVisitId) return;
      if (tabVersionRef.current[tabId] !== tabVersion) return;

      setTabConsumptions((prev) => {
        const cur = prev[tabId];
        const hadPreviousData = Boolean(cur && (cur.status === 'loaded' || cur.isStale));
        return {
          ...prev,
          [tabId]: {
            status: 'error',
            items: cur?.items ?? [],
            totalInCents: cur?.totalInCents ?? 0,
            error:
              cause instanceof Error
                ? cause.message
                : 'Falha ao recarregar consumo da comanda.',
            isStale: hadPreviousData,
          },
        };
      });
    }
  }

  const disabled = busy || loading;

  const activeGuests = state.guests.filter(
    (guest) => Date.parse(guest.expires_at) > Date.now(),
  );

  const openTabs = useMemo(() => {
    return state.tabs.filter((t) => t.status === 'open');
  }, [state.tabs]);

  const individualTabs = useMemo(() => {
    return getIndividualTabs(state.tabs);
  }, [state.tabs]);

  const hasMultiplePersons = individualTabs.length > 1;

  const selectedTab = useMemo(() => {
    return state.tabs.find((t) => t.id === selectedTabId) || null;
  }, [state.tabs, selectedTabId]);

  const sharedTab = useMemo(() => {
    if (!hasMultiplePersons) return null;
    return (
      state.tabs.find(
        (t) =>
          t.status === 'open' &&
          isSharedLabel(t.label),
      ) || null
    );
  }, [state.tabs, hasMultiplePersons]);

  const isSharedTabSelected = useMemo(() => {
    if (!hasMultiplePersons || !selectedTab) return false;
    return isSharedLabel(selectedTab.label);
  }, [selectedTab, hasMultiplePersons]);

  // Se houver apenas 1 pessoa (ou nenhuma) e a conta conjunta estava selecionada, redireciona para a pessoa individual
  useEffect(() => {
    if (individualTabs.length === 1 && selectedTab && isSharedLabel(selectedTab.label)) {
      handleSelectTab(individualTabs[0].id);
    }
  }, [individualTabs, selectedTab]);

  const selectedTabConsumption: TabConsumptionEntry = useMemo(() => {
    if (!selectedTabId) return { status: 'loaded', items: [], totalInCents: 0 };
    return (
      tabConsumptions[selectedTabId] || {
        status: 'loading',
        items: [],
        totalInCents: 0,
      }
    );
  }, [tabConsumptions, selectedTabId]);

  // Cálculos financeiros totais da mesa e identificação estrita de dados incompletos/erro/desatualizados
  const { tableSubtotal, tableFee, tableGrandTotal, tableTotalsIncomplete } = useMemo(() => {
    let subtotal = 0;
    let incomplete = false;

    // Se houver comandas abertas, cada uma DEVE ter entrada carregada e válida em tabConsumptions
    for (const t of openTabs) {
      const c = tabConsumptions[t.id];
      // Qualquer comanda sem entrada, em carregamento, com erro ou desatualizada torna o total da mesa incompleto
      if (!c || c.status !== 'loaded' || c.isStale) {
        incomplete = true;
      }
      if (c && c.status === 'loaded') {
        subtotal += c.totalInCents;
      }
    }

    const fee = calculateTabClosureFee(subtotal, restaurantFeePercent);
    const grand = subtotal + fee;
    return {
      tableSubtotal: subtotal,
      tableFee: fee,
      tableGrandTotal: grand,
      tableTotalsIncomplete: incomplete,
    };
  }, [openTabs, tabConsumptions, restaurantFeePercent]);

  // Cálculos financeiros específicos da pessoa/comanda selecionada (Tela 4)
  const { personSubtotal, personFee, personTotal, personConsumptionIncomplete } = useMemo(() => {
    const isError = selectedTabConsumption.status === 'error';
    const isLoading = selectedTabConsumption.status === 'loading';
    const isStale = Boolean(selectedTabConsumption.isStale);
    const subtotal = selectedTabConsumption.totalInCents;
    const fee = calculateTabClosureFee(subtotal, restaurantFeePercent);
    const total = subtotal + fee;
    return {
      personSubtotal: subtotal,
      personFee: fee,
      personTotal: total,
      personConsumptionIncomplete: isError || isLoading || isStale,
    };
  }, [selectedTabConsumption, restaurantFeePercent]);

  // Cálculos financeiros efetivos (se for Conta Conjunta, consolida a Mesa Toda)
  const { effectiveSubtotal, effectiveFee, effectiveTotal, effectiveIncomplete } = useMemo(() => {
    if (isSharedTabSelected) {
      return {
        effectiveSubtotal: tableSubtotal,
        effectiveFee: tableFee,
        effectiveTotal: tableGrandTotal,
        effectiveIncomplete: tableTotalsIncomplete,
      };
    }
    return {
      effectiveSubtotal: personSubtotal,
      effectiveFee: personFee,
      effectiveTotal: personTotal,
      effectiveIncomplete: personConsumptionIncomplete,
    };
  }, [
    isSharedTabSelected,
    tableSubtotal,
    tableFee,
    tableGrandTotal,
    tableTotalsIncomplete,
    personSubtotal,
    personFee,
    personTotal,
    personConsumptionIncomplete,
  ]);

  async function perform(
    operation: () => Promise<unknown>,
    successMessage: string | ((result: unknown) => string),
    onSuccess?: (result: unknown) => void,
  ) {
    if (submitting.current || disabled) return;

    submitting.current = true;
    setBusy(true);
    setActionError('');
    setNotice('');

    try {
      const result = await operation();
      onSuccess?.(result);
      const msg = typeof successMessage === 'function' ? successMessage(result) : successMessage;
      if (msg) {
        setNotice(msg);
      }
      setRefresh((current) => current + 1);
    } catch (cause) {
      setActionError(
        cause instanceof Error
          ? cause.message
          : 'Não foi possível concluir a operação.',
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  // Selecionar comanda ativa com persistência de sessão
  function handleSelectTab(tabId: string) {
    setSelectedTabId(tabId);
    onTabSelected?.(tabId);
    try {
      sessionStorage.setItem(`elz_catalog_tab_${tableVisitId}`, tabId);
    } catch {}
  }

  // Voltar do catálogo para a tela de comandas da mesa (Tela 3)
  function handleBackToComandas() {
    try {
      sessionStorage.removeItem(`elz_catalog_mode_${tableVisitId}`);
    } catch {}
    setIsCatalogOpen(false);
  }

  // Atualizar e persistir o nome (label) da comanda no banco e no estado local
  async function handleUpdateTabLabel(tabId: string, rawLabel: string) {
    const currentTab = state.tabs.find((t) => t.id === tabId);
    const trimmed = rawLabel.trim();
    const finalLabel = trimmed || currentTab?.label || 'Comanda';

    // Limpa o draft do editingLabels
    setEditingLabels((prev) => {
      const copy = { ...prev };
      delete copy[tabId];
      return copy;
    });

    if (currentTab && currentTab.label === finalLabel) {
      return;
    }

    // 1. Atualização otimista imediata na UI
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((t) => (t.id === tabId ? { ...t, label: finalLabel } : t)),
    }));

    // 2. Persistência direta no Supabase
    try {
      const { error } = await supabase
        .from('table_tabs')
        .update({ label: finalLabel })
        .eq('id', tabId);

      if (error) {
        console.error('Erro ao salvar label da comanda no Supabase:', error);
        setActionError('Não foi possível salvar o novo nome da comanda.');
        if (currentTab) {
          setState((prev) => ({
            ...prev,
            tabs: prev.tabs.map((t) => (t.id === tabId ? { ...t, label: currentTab.label } : t)),
          }));
        }
      } else {
        setNotice(`Nome atualizado para "${finalLabel}".`);
      }
    } catch (cause) {
      console.error('Falha de conexão ao salvar nome da comanda:', cause);
      setActionError('Falha ao conectar com o servidor para atualizar o nome.');
    }
  }

  // Criar nova comanda (com suporte opcional a vínculo com cliente celular)
  async function handleCreateComanda(nameToSave?: string, guestSessionIdToLink?: string) {
    if (submitting.current || disabled) return;

    const openCount = state.tabs.filter((t) => t.status === 'open').length;
    const trimmed = (nameToSave ?? draftName).trim();
    const finalLabel = trimmed || (openCount === 0 ? 'Pessoa 1' : `Pessoa ${openCount + 1}`);

    if (finalLabel.length > 80) {
      setActionError('O nome da comanda deve ter até 80 caracteres.');
      return;
    }

    const id = crypto.randomUUID();

    await perform(
      async () => {
        await createTableTab(restaurantSlug, tableVisitId, finalLabel, id);
        if (guestSessionIdToLink) {
          try {
            await linkGuestToTableTab(restaurantSlug, id, guestSessionIdToLink);
            await supabase
              .from('table_tabs')
              .update({ guest_session_id: guestSessionIdToLink })
              .eq('id', id);
          } catch (e) {
            console.warn('Não foi possível vincular o cliente à nova comanda:', e);
          }
        }
      },
      'Comanda criada com sucesso.',
      () => {
        setDraftName('');
        setIsCreatingDraft(false);
        setNewPersonGuestId('');
        handleSelectTab(id);
      },
    );
  }

  // Ação de transição: Garçom clica em "+ Adicionar items" na Tela 3
  async function handleTransitionToCatalog() {
    // Se ainda não existir nenhuma comanda criada, cria a primeira comanda e abre o catálogo
    if (state.tabs.length === 0) {
      const id = crypto.randomUUID();
      await perform(
        () => createTableTab(restaurantSlug, tableVisitId, 'Pessoa 1', id),
        'Pessoa 1 criada.',
        () => {
          handleSelectTab(id);
          try {
            sessionStorage.setItem(`elz_catalog_mode_${tableVisitId}`, 'true');
          } catch {}
          setIsCatalogOpen(true);
        },
      );
    } else {
      const targetId = selectedTabId || state.tabs[0]?.id;
      if (targetId) {
        handleSelectTab(targetId);
      }
      try {
        sessionStorage.setItem(`elz_catalog_mode_${tableVisitId}`, 'true');
      } catch {}
      setIsCatalogOpen(true);
    }
  }

  // Vincular cliente à comanda
  async function handleLinkGuest(tabId: string) {
    if (!selectedGuestId) {
      setActionError('Selecione um cliente confirmado.');
      return;
    }

    await perform(
      () => linkGuestToTableTab(restaurantSlug, tabId, selectedGuestId),
      'Cliente vinculado à comanda com sucesso.',
      () => {
        setSelectedGuestId('');
        setLinkingGuestTabId(null);
        setActiveMenuTabId(null);
      },
    );
  }

  // Abertura do modal de encerramento com reset explícito de taxa para a comanda
  function openCloseTabModal(tabId: string) {
    // Inicializa a escolha para esta comanda específica: true se o restaurante tiver taxa > 0, senão false
    setClosingFeeAccepted(restaurantFeePercent > 0);
    setClosingTabId(tabId);
  }

  // Encerrar comanda
  async function handleCloseTab(tabId: string) {
    if (submitting.current || busy || disabled) return;

    const tab = state.tabs.find((t) => t.id === tabId);
    if (!tab) return;

    const consumption = tabConsumptions[tabId];
    if (!consumption || consumption.status === 'loading') {
      setActionError('Aguarde a verificação do consumo da comanda antes de realizar o encerramento.');
      return;
    }
    if (consumption.status === 'error') {
      setActionError(
        'Não é possível encerrar a comanda pois a verificação de consumo falhou. Toque em "Tentar novamente" na comanda antes de prosseguir.',
      );
      return;
    }
    if (consumption.isStale) {
      setActionError(
        'O consumo desta comanda está desatualizado. Toque em "Tentar novamente" para atualizar os valores reais antes de encerrar.',
      );
      return;
    }

    const feeAccepted = restaurantFeePercent > 0 ? closingFeeAccepted : false;
    await perform(
      () => closeTableTab(restaurantSlug, tabId, feeAccepted),
      (res) => {
        const closed = res as TableTab | undefined;
        if (closed && closed.total_in_cents != null) {
          const formattedTotal = currency.format((closed.total_in_cents ?? 0) / 100);
          const feeDetail = closed.service_fee_accepted && (closed.service_fee_in_cents ?? 0) > 0
            ? ` (com taxa de ${currency.format((closed.service_fee_in_cents ?? 0) / 100)})`
            : closed.service_fee_percent && closed.service_fee_percent > 0
              ? ' (sem taxa de serviço)'
              : '';
          return `Comanda "${tab.label}" encerrada com sucesso. Total: ${formattedTotal}${feeDetail}.`;
        }
        return `Comanda "${tab.label}" encerrada com sucesso.`;
      },
      () => {
        setClosingTabId(null);
        setActiveMenuTabId(null);
        if (selectedTabId === tabId) {
          const remaining = state.tabs.filter((t) => t.id !== tabId && t.status === 'open');
          const nextTabId = remaining[0]?.id || null;
          setSelectedTabId(nextTabId);
          if (nextTabId) {
            try {
              sessionStorage.setItem(`elz_catalog_tab_${tableVisitId}`, nextTabId);
            } catch {}
          } else {
            try {
              sessionStorage.removeItem(`elz_catalog_tab_${tableVisitId}`);
              sessionStorage.removeItem(`elz_catalog_mode_${tableVisitId}`);
            } catch {}
            setIsCatalogOpen(false);
          }
        }
      },
    );
  }

  // Encerramento de comanda vazia via RPC autorizada ou acionamento de encerramento se houver consumo
  async function handleDeleteOrCloseTab(tabId: string) {
    const tab = state.tabs.find((t) => t.id === tabId);
    if (!tab) return;

    const consumption = tabConsumptions[tabId];
    if (!consumption || consumption.status === 'loading') {
      setActionError('Aguarde a verificação do consumo da comanda antes de realizar o encerramento.');
      return;
    }
    if (consumption.status === 'error') {
      setActionError(
        'Não é possível encerrar a comanda pois a verificação de consumo falhou. Toque em "Tentar novamente" na comanda antes de prosseguir.',
      );
      return;
    }
    if (consumption.isStale) {
      setActionError(
        'O consumo desta comanda está desatualizado. Toque em "Tentar novamente" para atualizar os valores reais antes de prosseguir.',
      );
      return;
    }

    const activeItems = consumption.items.filter((it) => it.status === 'active');
    const hasActiveItems = activeItems.length > 0;

    // Se a comanda NÃO possuir itens ativos (está vazia ou todos os itens foram cancelados)
    if (!hasActiveItems) {
      const confirmClose = window.confirm(`Deseja encerrar a comanda vazia “${tab.label}”?`);
      if (!confirmClose) return;

      await perform(
        () => closeTableTab(restaurantSlug, tabId, false),
        `Comanda vazia “${tab.label}” encerrada com sucesso.`,
        () => {
          setState((prev) => ({
            ...prev,
            tabs: prev.tabs.filter((t) => t.id !== tabId),
          }));

          if (selectedTabId === tabId) {
            const remaining = state.tabs.filter((t) => t.id !== tabId && t.status === 'open');
            const nextTabId = remaining[0]?.id || null;
            setSelectedTabId(nextTabId);
            if (nextTabId) {
              try {
                sessionStorage.setItem(`elz_catalog_tab_${tableVisitId}`, nextTabId);
              } catch {}
            } else {
              try {
                sessionStorage.removeItem(`elz_catalog_tab_${tableVisitId}`);
                sessionStorage.removeItem(`elz_catalog_mode_${tableVisitId}`);
              } catch {}
              setIsCatalogOpen(false);
            }
          }
        },
      );
    } else {
      // Se a comanda já possuir itens ativos (inclusive de valor zero): abre modal de conferência com opção de taxa
      openCloseTabModal(tabId);
    }
  }

  // Lançamento de produto na comanda selecionada (RPC real do Supabase sem mocks)
  async function handleQuickAddItem(product: MenuProductItem) {
    if (!selectedTabId) {
      setActionError('Selecione uma comanda/pessoa para lançar o item.');
      return;
    }

    try {
      sessionStorage.setItem(`elz_catalog_mode_${tableVisitId}`, 'true');
      sessionStorage.setItem(`elz_catalog_tab_${tableVisitId}`, selectedTabId);
    } catch {}

    const itemId = crypto.randomUUID();

    await perform(
      async () => {
        await addTabConsumption(restaurantSlug, selectedTabId, product.id, 1, itemId);
        await reloadTabConsumption(selectedTabId);
      },
      `${product.name} adicionado à comanda de ${selectedTab?.label || 'cliente'}.`,
    );
  }

  // Localiza um item e a sua respectiva comanda
  function findItemAndTab(itemId: string) {
    for (const [tabId, consumption] of Object.entries(tabConsumptions)) {
      const it = consumption.items.find((item) => item.id === itemId);
      if (it) {
        return { tabId, item: it };
      }
    }
    return null;
  }

  // Incrementar quantidade de item (+1)
  async function handleIncrementGroup(group: { primaryItemId: string; productName: string; unitPriceInCents: number }) {
    const targetId = group.primaryItemId;
    const found = findItemAndTab(targetId);
    if (!found) return;
    const { tabId, item: currentItem } = found;

    const newItemId = crypto.randomUUID();
    await perform(
      async () => {
        await addTabConsumption(restaurantSlug, tabId, currentItem.product_id, 1, newItemId);
        await reloadTabConsumption(tabId);
      },
      `${group.productName} (+1).`,
    );
  }

  // Solicita cancelamento com exigência de motivo
  function requestCancelItem(
    group: {
      itemIds: string[];
      productName: string;
      quantity: number;
      unitPriceInCents: number;
      lineTotalInCents: number;
    },
    quantityToCancel: number = group.quantity,
  ) {
    if (disabled || group.itemIds.length === 0) return;
    const tabId = selectedTabId || findItemAndTab(group.itemIds[0])?.tabId || '';
    const safeQty = Math.max(1, Math.min(quantityToCancel, group.quantity));
    const itemIdsToCancel =
      safeQty >= group.itemIds.length
        ? group.itemIds
        : group.itemIds.slice(group.itemIds.length - safeQty);

    setCancellingItem({
      itemIds: itemIdsToCancel,
      productName: group.productName,
      quantity: safeQty,
      unitPriceInCents: group.unitPriceInCents,
      lineTotalInCents: group.unitPriceInCents * safeQty,
      tabId,
    });
    setCancellationReason('');
    setCancellationModalError('');
  }

  // Executa cancelamento com motivo persistido na RPC autorizada
  async function handleConfirmCancellation() {
    if (!cancellingItem) return;

    const validation = validateCancellationReason(cancellationReason);
    if (!validation.valid) {
      setCancellationModalError(validation.error || 'Informe o motivo do cancelamento.');
      return;
    }

    setCancellationSubmitting(true);
    setCancellationModalError('');

    try {
      const result = await cancelTabConsumptionBatch(
        restaurantSlug,
        cancellingItem.itemIds,
        validation.normalized,
      );

      // Recarrega o consumo se pelo menos 1 item foi cancelado com sucesso
      if (result.cancelledIds.length > 0 && cancellingItem.tabId) {
        await reloadTabConsumption(cancellingItem.tabId);
      }

      if (result.failed.length === 0) {
        // Sucesso total
        setNotice(`${cancellingItem.quantity}x ${cancellingItem.productName} cancelado com sucesso.`);
        setCancellingItem(null);
        setCancellationReason('');
      } else if (result.cancelledIds.length > 0) {
        // Sucesso parcial: discrimina com clareza os itens cancelados e os que falharam sem abortar
        const failMsg = result.failed.map((f) => f.error).join('; ');
        setCancellationModalError(
          `${result.cancelledIds.length} item(ns) cancelado(s) com sucesso. ${result.failed.length} falharam: ${failMsg}`,
        );
        // Atualiza o estado do modal para manter apenas os itens pendentes que falharam
        setCancellingItem((prev) =>
          prev
            ? {
                ...prev,
                itemIds: result.failed.map((f) => f.id),
                quantity: result.failed.length,
                lineTotalInCents: prev.unitPriceInCents * result.failed.length,
              }
            : null,
        );
      } else {
        // Falha total sem nenhum cancelamento parcial indevido
        const failMsg = result.failed.map((f) => f.error).join('; ') || 'Falha ao cancelar os itens selecionados.';
        setCancellationModalError(failMsg);
      }
    } catch (cause) {
      console.error('Falha ao persistir cancelamento:', cause);
      // Em resultado incerto ou erro na chamada, recarrega o estado do servidor para garantir sincronismo
      if (cancellingItem.tabId) {
        try {
          await reloadTabConsumption(cancellingItem.tabId);
        } catch {
          // ignore reload error
        }
      }
      const msg = cause instanceof Error ? cause.message : 'Falha ao persistir o cancelamento no servidor.';
      setCancellationModalError(msg);
    } finally {
      setCancellationSubmitting(false);
    }
  }

  // Decrementar quantidade de item consolidado (-1)
  function handleDecrementGroup(group: { primaryItemId: string; itemIds: string[]; productName: string; lineTotalInCents: number; unitPriceInCents: number; quantity: number }) {
    requestCancelItem(group, 1);
  }

  // Remover grupo de item da comanda
  function handleRemoveGroup(group: { itemIds: string[]; productName: string; lineTotalInCents: number; unitPriceInCents?: number; quantity?: number }) {
    requestCancelItem({
      itemIds: group.itemIds,
      productName: group.productName,
      quantity: group.quantity || group.itemIds.length,
      unitPriceInCents: group.unitPriceInCents || Math.round(group.lineTotalInCents / Math.max(1, group.itemIds.length)),
      lineTotalInCents: group.lineTotalInCents,
    });
  }

  // Ação rápida: Garçom marca item pronto como entregue na mesa
  async function handleMarkDelivered(group: { itemIds: string[]; productName: string }) {
    if (disabled) return;

    // Atualização otimista imediata na UI
    setTabConsumptions((prev) => {
      const updated = { ...prev };
      for (const [tabId, cur] of Object.entries(updated)) {
        updated[tabId] = {
          ...cur,
          items: cur.items.map((it) =>
            group.itemIds.includes(it.id)
              ? {
                  ...it,
                  production_status: 'delivered' as const,
                  prep_delivered_at: new Date().toISOString(),
                }
              : it,
          ),
        };
      }
      return updated;
    });

    await perform(
      async () => {
        for (const itemId of group.itemIds) {
          try {
            const { error: rpcErr } = await supabase.rpc('update_tab_item_production_status', {
              p_restaurant_slug: restaurantSlug,
              p_item_id: itemId,
              p_target_status: 'delivered',
            });
            if (rpcErr) throw rpcErr;
          } catch {
            const { error } = await supabase
              .from('table_tab_items')
              .update({
                production_status: 'delivered',
                prep_delivered_at: new Date().toISOString(),
              })
              .eq('id', itemId);
            if (error) throw new Error(error.message);
          }
        }
      },
      `${group.productName} marcado como entregue.`,
    );
  }

  // Limpar itens da comanda atual com tratamento de erros parciais, confirmação, bloqueio estrito e recarregamento garantido
  async function handleClearPersonItems() {
    if (submitting.current || disabled || !selectedTabId) return;

    const targetTabId = selectedTabId;
    const targetVisitId = tableVisitId;
    const consumption = tabConsumptions[targetTabId];

    // Bloqueia se o consumo da comanda estiver ausente, carregando, com erro ou desatualizado
    if (!consumption || consumption.status === 'loading') {
      setActionError('Aguarde a verificação do consumo da comanda antes de limpar os itens.');
      return;
    }
    if (consumption.status === 'error') {
      setActionError(
        'Não é possível limpar itens pois a verificação de consumo falhou. Toque em "Tentar novamente" na comanda antes de prosseguir.',
      );
      return;
    }
    if (consumption.isStale) {
      setActionError(
        'O consumo desta comanda está desatualizado. Toque em "Atualizar consumo" antes de limpar os itens.',
      );
      return;
    }

    // Apenas itens com status 'active' podem ser cancelados
    const itemsToClear = consumption.items.filter((it) => it.status === 'active');
    if (itemsToClear.length === 0) return;

    // Abre o modal exigindo motivo de cancelamento em conformidade com a auditoria
    setCancellingItem({
      itemIds: itemsToClear.map((it) => it.id),
      productName: `Todos os itens (${itemsToClear.length})`,
      quantity: itemsToClear.reduce((acc, it) => acc + it.quantity, 0),
      unitPriceInCents: 0,
      lineTotalInCents: consumption.totalInCents,
      tabId: targetTabId,
    });
    setCancellationReason('');
    setCancellationModalError('');
  }

  // Finalizar e enviar para a cozinha
  function handleFinalizeAndSendToKitchen() {
    if (selectedTabConsumption.items.length === 0) {
      setActionError('Adicione pelo menos um item à comanda antes de enviar para a cozinha.');
      return;
    }

    setNotice(`Pedido de ${selectedTab?.label || 'Mesa'} enviado com sucesso para a cozinha!`);
  }

  const allActiveItems = useMemo(() => {
    const list: TabConsumptionItem[] = [];
    for (const c of Object.values(tabConsumptions)) {
      list.push(...c.items.filter((it) => it.status === 'active'));
    }
    return list;
  }, [tabConsumptions]);

  // Imprimir pré-conta térmica (bloqueia estritamente se houver dados incompletos, pendentes ou desatualizados)
  function handlePrintReceipt() {
    const isMesaView = isSharedTabSelected || !isCatalogOpen;

    if (isMesaView) {
      if (tableTotalsIncomplete) {
        setActionError(
          'Não é possível imprimir a pré-conta enquanto houver comanda com consumo incompleto, pendente ou desatualizado.',
        );
        return;
      }
    } else {
      if (
        !selectedTabConsumption ||
        selectedTabConsumption.status !== 'loaded' ||
        selectedTabConsumption.isStale
      ) {
        setActionError(
          'Não é possível imprimir a pré-conta enquanto o consumo desta comanda estiver incompleto, pendente ou desatualizado.',
        );
        return;
      }
    }

    const itemsToPrint = isSharedTabSelected
      ? allActiveItems
      : selectedTabConsumption.items.filter((it) => it.status === 'active');

    printTableBillThermal({
      restaurantName: restaurant?.name || 'NOMA Restaurante e Bar',
      tableNumber: tableNumber ?? '01',
      tabLabel: isSharedTabSelected ? 'Conta Conjunta (Mesa Toda)' : (selectedTab?.label || 'Comanda'),
      items: itemsToPrint.map((it) => ({
        name: it.product_name,
        quantity: it.quantity,
        unitPriceInCents: it.unit_price_in_cents,
        totalInCents: it.line_total_in_cents,
      })),
      subtotalInCents: isSharedTabSelected || !isCatalogOpen ? tableSubtotal : personSubtotal,
      serviceFeePercent: restaurantFeePercent,
      serviceFeeInCents: isSharedTabSelected || !isCatalogOpen ? tableFee : personFee,
      totalInCents: isSharedTabSelected || !isCatalogOpen ? tableGrandTotal : personTotal,
      paperWidth: '80mm',
    });
  }

  const filteredProducts = useMemo(() => {
    return products.filter((prod) => {
      const matchesSearch =
        searchQuery.trim() === '' ||
        prod.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        prod.short_description.toLowerCase().includes(searchQuery.toLowerCase());

      if (!matchesSearch) return false;
      if (selectedCategory === 'todos') return true;

      const cat = categories.find((c) => c.slug === selectedCategory || c.id === selectedCategory);
      if (!cat) return true;

      return prod.category_id === cat.id;
    });
  }, [products, searchQuery, selectedCategory, categories]);

  // Ao mudar de categoria ou busca, reseta para a primeira página do catálogo
  useEffect(() => {
    setCatalogPage(1);
  }, [selectedCategory, searchQuery]);

  const paginatedCatalog = useMemo(() => {
    return paginateCatalogProducts(filteredProducts, catalogPage, CATALOG_PAGE_SIZE);
  }, [filteredProducts, catalogPage]);

  const activeItems = selectedTabConsumption.items.filter((it) => it.status === 'active');

  type ProductionStatusGroup = 'pending' | 'in_preparation' | 'ready' | 'delivered';

  function groupItemsByProductAndStatus(items: TabConsumptionItem[]) {
    const map = new Map<
      string,
      {
        key: string;
        productId: string;
        productName: string;
        unitPriceInCents: number;
        quantity: number;
        lineTotalInCents: number;
        productionStatus: ProductionStatusGroup;
        itemIds: string[];
        primaryItemId: string;
      }
    >();

    for (const it of items) {
      if (it.status !== 'active') continue;
      const raw = it.production_status || 'pending';
      const prodStatus: ProductionStatusGroup =
        (raw as string) === 'in_preparation' || raw === 'preparing'
          ? 'in_preparation'
          : raw === 'ready'
            ? 'ready'
            : raw === 'delivered'
              ? 'delivered'
              : 'pending';

      const key = `${it.product_id}:${it.unit_price_in_cents}:${prodStatus}`;
      const existing = map.get(key);
      if (!existing) {
        map.set(key, {
          key,
          productId: it.product_id,
          productName: it.product_name,
          unitPriceInCents: it.unit_price_in_cents,
          quantity: it.quantity,
          lineTotalInCents: it.line_total_in_cents,
          productionStatus: prodStatus,
          itemIds: [it.id],
          primaryItemId: it.id,
        });
      } else {
        existing.quantity += it.quantity;
        existing.lineTotalInCents += it.line_total_in_cents;
        existing.itemIds.push(it.id);
      }
    }

    return Array.from(map.values());
  }

  // Itens consolidados/agrupados por produto E por status de produção KDS
  const groupedActiveItems = useMemo(() => {
    return groupItemsByProductAndStatus(activeItems);
  }, [activeItems]);

  const paginatedItemsResult = useMemo(() => {
    return paginateComandaItems(groupedActiveItems, isItemsExpanded, itemsCurrentPage);
  }, [groupedActiveItems, isItemsExpanded, itemsCurrentPage]);

  const totalActiveQuantity = useMemo(() => {
    if (isSharedTabSelected) {
      return allActiveItems.reduce((acc, it) => acc + it.quantity, 0);
    }
    return activeItems.reduce((acc, it) => acc + it.quantity, 0);
  }, [isSharedTabSelected, allActiveItems, activeItems]);

  function renderItemRow(group: {
    key: string;
    productId: string;
    productName: string;
    unitPriceInCents: number;
    quantity: number;
    lineTotalInCents: number;
    productionStatus: ProductionStatusGroup;
    itemIds: string[];
    primaryItemId: string;
  }) {
    const isReady = group.productionStatus === 'ready';

    return (
      <div
        key={group.key}
        className={`py-2.5 px-2 rounded-2xl flex items-center justify-between text-xs transition-all ${
          isReady
            ? 'bg-emerald-50/70 dark:bg-emerald-950/30 border border-emerald-300 dark:border-emerald-700 shadow-xs'
            : ''
        }`}
      >
        <div className="flex items-center gap-2.5 flex-1 min-w-0 pr-2">
          {/* Controles de incremento e decremento rápido */}
          <div className="flex items-center border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 rounded-xl overflow-hidden shrink-0 shadow-xs">
            <button
              type="button"
              onClick={() => void handleDecrementGroup(group)}
              className="w-6 h-6 flex items-center justify-center text-xs font-bold text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition cursor-pointer"
              title="Diminuir quantidade"
            >
              -
            </button>
            <span className="px-1.5 text-xs font-bold text-zinc-900 dark:text-white min-w-[20px] text-center">
              {group.quantity}
            </span>
            <button
              type="button"
              onClick={() => void handleIncrementGroup(group)}
              className="w-6 h-6 flex items-center justify-center text-xs font-bold text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition cursor-pointer"
              title="Aumentar quantidade"
            >
              +
            </button>
          </div>

          <div className="min-w-0 flex-1">
            <span className="font-semibold text-zinc-800 dark:text-zinc-200 block text-xs truncate">
              {group.productName}
            </span>
            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
              {group.quantity > 1 && (
                <span className="text-[10px] text-zinc-400 block shrink-0">
                  {currency.format(group.unitPriceInCents / 100)} cada
                </span>
              )}

              {/* Badges de Status de Produção */}
              {group.productionStatus === 'pending' && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-50 text-amber-700 border border-amber-200/60">
                  ● Aguardando início de preparo
                </span>
              )}
              {group.productionStatus === 'in_preparation' && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-sky-50 text-sky-700 border border-sky-200/60">
                  ● Em preparo na cozinha
                </span>
              )}
              {group.productionStatus === 'ready' && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-300 animate-pulse">
                  ● Pronto para servir
                </span>
              )}
              {group.productionStatus === 'delivered' && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-zinc-100 text-zinc-600 border border-zinc-200">
                  ✓ Entregue
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Ação rápida de entrega para o garçom */}
          {isReady && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => void handleMarkDelivered(group)}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white text-[11px] font-bold shadow-xs transition-colors cursor-pointer shrink-0"
              title="Confirmar entrega deste item na mesa"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <span>Marcar como entregue</span>
            </button>
          )}

          <span className="font-bold text-zinc-900 dark:text-white">
            {currency.format(group.lineTotalInCents / 100)}
          </span>
          <button
            type="button"
            onClick={() => void handleRemoveGroup(group)}
            title="Remover produto da comanda"
            className="text-zinc-300 hover:text-red-500 p-1 rounded cursor-pointer transition-colors"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 6h18" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        </div>
      </div>
    );
  }

  // Itens disponíveis para mover ou transferir
  const movableItems = useMemo(() => {
    if (isSharedTabSelected) {
      return allActiveItems;
    }
    return selectedTabConsumption.items.filter((it) => it.status === 'active');
  }, [isSharedTabSelected, allActiveItems, selectedTabConsumption.items]);

  const movableTargetTabs = useMemo(() => {
    const itemTabId = moveItemId ? findItemAndTab(moveItemId)?.tabId : selectedTabId;
    return state.tabs.filter((t) => t.status === 'open' && t.id !== itemTabId);
  }, [state.tabs, moveItemId, selectedTabId, tabConsumptions]);

  function handleOpenMovePersonModal() {
    if (movableItems.length === 0) {
      setActionError('Não há itens ativos lançados para mover.');
      return;
    }
    const firstItem = movableItems[0];
    setMoveItemId(firstItem.id);
    const itemTab = findItemAndTab(firstItem.id)?.tabId;
    const targets = state.tabs.filter((t) => t.status === 'open' && t.id !== itemTab);
    if (targets.length === 0) {
      setActionError('Não há outras pessoas/comandas abertas nesta mesa para receber o item.');
      return;
    }
    // Deixa o destino sem seleção inicial e exige escolha explícita
    setMoveTargetTabId('');
    setMoveReason('');
    setMoveReasonError('');
    setIsMovePersonModalOpen(true);
  }

  async function handleConfirmMovePerson() {
    if (!moveItemId || !moveTargetTabId) {
      setActionError('Selecione o item e a pessoa de destino.');
      return;
    }

    const validation = validateCancellationReason(moveReason);
    if (!validation.valid) {
      setMoveReasonError(validation.error || 'Informe a descrição do motivo para a auditoria.');
      return;
    }

    const found = findItemAndTab(moveItemId);
    if (!found) {
      setActionError('Item não encontrado.');
      return;
    }
    const { tabId: sourceTabId, item } = found;
    const sourceTab = state.tabs.find((t) => t.id === sourceTabId);
    const targetTab = state.tabs.find((t) => t.id === moveTargetTabId);

    const auditReason = formatMoveItemAuditReason(
      validation.normalized,
      sourceTab?.label || 'origem',
      targetTab?.label || 'destino',
    );

    await perform(
      async () => {
        try {
          await transferTabConsumptionItems({
            restaurantSlug,
            sourceTabId,
            targetTabId: moveTargetTabId,
            itemIds: [moveItemId],
            reason: auditReason,
          });

          await Promise.all([
            reloadTabConsumption(sourceTabId),
            reloadTabConsumption(moveTargetTabId),
          ]);
        } catch (err) {
          await reloadTabConsumption(sourceTabId).catch(() => {});
          throw err;
        }
      },
      `Item movido para ${targetTab?.label || 'outra pessoa'} com sucesso!`,
      () => {
        setIsMovePersonModalOpen(false);
        setMoveItemId('');
        setMoveTargetTabId('');
        setMoveReason('');
        setMoveReasonError('');
      },
    );
  }

  async function loadTransferTableTargetTabs(tableId: string) {
    setTransferTableTargetTabId('');
    if (!tableId) {
      setTransferTableTargetTabs([]);
      return;
    }
    setLoadingTargetTabs(true);
    try {
      const { data: visit, error: visitErr } = await supabase
        .from('table_visits')
        .select('id')
        .eq('restaurant_table_id', tableId)
        .eq('status', 'open')
        .order('opened_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (visitErr || !visit) {
        setTransferTableTargetTabs([]);
        setTransferTableTargetTabId('');
        return;
      }

      const { data: tabs, error: tabsErr } = await supabase
        .from('table_tabs')
        .select('id, label')
        .eq('table_visit_id', visit.id)
        .eq('status', 'open')
        .order('created_at', { ascending: true });

      if (tabsErr || !tabs) {
        setTransferTableTargetTabs([]);
        setTransferTableTargetTabId('');
        return;
      }

      setTransferTableTargetTabs(tabs);
      // Sem seleção inicial automática da comanda de destino
      setTransferTableTargetTabId('');
    } catch (e) {
      console.error('Erro ao buscar comandas da mesa de destino:', e);
      setTransferTableTargetTabs([]);
      setTransferTableTargetTabId('');
    } finally {
      setLoadingTargetTabs(false);
    }
  }

  async function handleOpenTransferTableModal() {
    if (movableItems.length === 0) {
      setActionError('Não há itens ativos lançados para transferir.');
      return;
    }
    setTransferItemId(movableItems[0].id);
    setTransferTargetTableId('');
    setTransferTableTargetTabs([]);
    setTransferTableTargetTabId('');
    setTransferReason('');
    setTransferReasonError('');
    setIsTransferTableModalOpen(true);
    setLoadingOccupiedTables(true);

    try {
      const { data: activeVisits, error: visitsErr } = await supabase
        .from('table_visits')
        .select(`
          restaurant_table_id,
          restaurant_tables (
            id,
            table_number,
            label
          )
        `)
        .eq('restaurant_id', restaurantId)
        .eq('status', 'open');

      if (visitsErr) throw visitsErr;

      const otherTables = (activeVisits || [])
        .map((v) => v.restaurant_tables as unknown as { id: string; table_number: number; label: string | null } | null)
        .filter((t): t is { id: string; table_number: number; label: string | null } =>
          t != null && String(t.table_number) !== String(tableNumber)
        );

      const uniqueMap = new Map<string, { id: string; table_number: number; label: string | null }>();
      for (const t of otherTables) {
        uniqueMap.set(t.id, t);
      }
      const uniqueTables = Array.from(uniqueMap.values()).sort((a, b) => Number(a.table_number) - Number(b.table_number));

      setOccupiedTables(uniqueTables);
      // Deixa o destino sem seleção inicial e exige escolha explícita do operador
      setTransferTargetTableId('');
      setTransferTableTargetTabs([]);
      setTransferTableTargetTabId('');
    } catch (e) {
      console.error('Erro ao buscar mesas ocupadas:', e);
      setActionError('Não foi possível carregar as outras mesas ocupadas.');
    } finally {
      setLoadingOccupiedTables(false);
    }
  }

  async function handleConfirmTransferTable() {
    if (!transferItemId || !transferTargetTableId) {
      setActionError('Selecione o item e a mesa de destino.');
      return;
    }

    if (!transferTableTargetTabId) {
      setTransferReasonError('Selecione a comanda de destino na mesa.');
      return;
    }

    const validation = validateCancellationReason(transferReason);
    if (!validation.valid) {
      setTransferReasonError(validation.error || 'Informe a descrição do motivo para a auditoria.');
      return;
    }

    const targetTable = occupiedTables.find((t) => t.id === transferTargetTableId);
    if (!targetTable) return;

    const found = findItemAndTab(transferItemId);
    if (!found) {
      setActionError('Item não encontrado.');
      return;
    }
    const { tabId: sourceTabId, item } = found;
    const auditReason = formatTransferTableAuditReason(
      validation.normalized,
      tableNumber || 'origem',
      targetTable.table_number,
    );

    // Salva o snapshot anterior para restauração imediata em caso de falha ou resposta incerta
    const previousConsumption = tabConsumptions[sourceTabId];

    // Atualização otimista no estado local
    setTabConsumptions((prev) => {
      const sourceCur = prev[sourceTabId];
      if (!sourceCur) return prev;
      return {
        ...prev,
        [sourceTabId]: {
          ...sourceCur,
          items: sourceCur.items.filter((i) => i.id !== transferItemId),
          totalInCents: Math.max(0, sourceCur.totalInCents - item.line_total_in_cents),
        },
      };
    });

    await perform(
      async () => {
        try {
          await transferTabConsumptionItems({
            restaurantSlug,
            sourceTabId,
            targetTabId: transferTableTargetTabId,
            itemIds: [transferItemId],
            reason: auditReason,
          });

          await reloadTabConsumption(sourceTabId);
        } catch (err) {
          // Se a RPC falhar ou a resposta for incerta, restaura o estado local e recarrega do servidor
          if (previousConsumption) {
            setTabConsumptions((prev) => ({
              ...prev,
              [sourceTabId]: previousConsumption,
            }));
          }
          await reloadTabConsumption(sourceTabId).catch(() => {});
          throw err;
        }
      },
      `Item transferido com sucesso para a Mesa ${targetTable.table_number}!`,
      () => {
        setIsTransferTableModalOpen(false);
        setTransferItemId('');
        setTransferTargetTableId('');
        setTransferTableTargetTabs([]);
        setTransferTableTargetTabId('');
        setTransferReason('');
        setTransferReasonError('');
      },
    );
  }

  return (
    <div className="space-y-4">
      {/* Toast verde temporário de acesso confirmado */}
      {showSuccessToast && (
        <div className="flex items-center justify-between p-3.5 rounded-2xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200/90 dark:border-emerald-800 text-emerald-900 dark:text-emerald-200 shadow-xs text-xs animate-fadeIn transition-all">
          <div className="flex items-center gap-2.5">
            <div className="w-5 h-5 rounded-full bg-emerald-500 text-white flex items-center justify-center font-bold text-[11px] shrink-0 shadow-xs">
              ✓
            </div>
            <span className="font-semibold text-emerald-950 dark:text-emerald-100">
              Acesso confirmado! Cliente vinculado à Mesa {String(tableNumber ?? '').padStart(2, '0')}.
            </span>
          </div>
          <button
            type="button"
            onClick={onCloseSuccessToast}
            className="text-emerald-700 dark:text-emerald-300 hover:text-emerald-900 p-1 -mr-1 rounded-lg cursor-pointer"
            aria-label="Fechar notificação"
          >
            ✕
          </button>
        </div>
      )}

      {/* Mensagens de feedback */}
      {actionError && (
        <div className="p-3 rounded-2xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/40 text-xs text-red-800 dark:text-red-300">
          {actionError}
        </div>
      )}

      {notice && (
        <div className="p-3 rounded-2xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/40 text-xs text-emerald-800 dark:text-emerald-300">
          {notice}
        </div>
      )}

      {/* ========================================================================= */}
      {/* ESTADO 1: TELA 3 — Gestão de Comandas & Estado Vazio (PADRÃO AO ENTRAR)   */}
      {/* ========================================================================= */}
      {!isCatalogOpen ? (
        <div className="space-y-4">
          {/* 2. Card "Comandas da mesa" */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-10 h-10 rounded-2xl bg-[#FAF4EE] dark:bg-zinc-800 flex items-center justify-center text-amber-900 dark:text-amber-200 shrink-0">
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                </div>
                <div>
                  <h3 className="font-bold text-sm text-zinc-900 dark:text-white leading-tight">
                    Comandas da mesa
                  </h3>
                  <p className="text-[11px] text-zinc-400 dark:text-zinc-500 leading-tight mt-0.5">
                    Crie uma ou mais comandas para registrar os pedidos.
                  </p>
                </div>
              </div>

              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  if (!isCreatingDraft) {
                    setIsCreatingDraft(true);
                    setDraftName('');
                  } else {
                    void handleCreateComanda();
                  }
                }}
                className="bg-[#4A1505] hover:bg-[#381004] text-white text-xs font-bold px-3.5 py-2 rounded-xl shadow-xs transition-colors shrink-0 flex items-center gap-1 cursor-pointer disabled:opacity-50"
              >
                <span>+</span>
                <span>Nova comanda</span>
              </button>
            </div>

            {/* Input de rascunho de nova comanda */}
            {isCreatingDraft && (
              <div className="border-2 border-[#4A1505] bg-white dark:bg-zinc-900 rounded-2xl p-2.5 flex items-center gap-2.5 shadow-xs transition-all">
                <div className="w-10 h-10 rounded-xl bg-[#FAF4EE] dark:bg-zinc-800 flex items-center justify-center text-amber-900/60 dark:text-amber-300 shrink-0">
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
                    <circle cx="12" cy="7" r="4" />
                  </svg>
                </div>

                <div className="flex-1 flex items-center gap-1.5">
                  <input
                    type="text"
                    autoFocus
                    value={draftName}
                    placeholder="Nome da comanda (opcional)"
                    onChange={(e) => setDraftName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void handleCreateComanda();
                      } else if (e.key === 'Escape') {
                        setIsCreatingDraft(false);
                        setDraftName('');
                      }
                    }}
                    className="w-full rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50/50 dark:bg-zinc-800/50 px-3 py-2 text-xs text-zinc-800 dark:text-white placeholder:text-zinc-400 focus:outline-none focus:border-[#4A1505] focus:bg-white dark:focus:bg-zinc-800 transition"
                  />
                  <button
                    type="button"
                    onClick={() => void handleCreateComanda()}
                    disabled={busy}
                    className="bg-[#4A1505] text-white text-xs font-semibold px-3 py-2 rounded-xl shrink-0 cursor-pointer disabled:opacity-50"
                  >
                    {busy ? 'Criando…' : 'Criar'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setIsCreatingDraft(false);
                      setDraftName('');
                    }}
                    className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 text-xs px-1.5 py-2 cursor-pointer"
                  >
                    ✕
                  </button>
                </div>
              </div>
            )}

            {/* Listagem das comandas cadastradas da mesa */}
            <div className="space-y-2">
              {state.tabs.filter((t) => t.status === 'open').length === 0 && !isCreatingDraft ? (
                <div
                  onClick={() => {
                    setIsCreatingDraft(true);
                    setDraftName('');
                  }}
                  className="border border-dashed border-amber-900/20 dark:border-zinc-800 bg-[#FCF9F5]/60 dark:bg-zinc-900/60 rounded-2xl p-4 flex items-center justify-center gap-2 text-xs text-zinc-500 cursor-pointer hover:bg-[#FCF9F5] transition"
                >
                  <span>+ Clique para criar a primeira comanda</span>
                </div>
              ) : (
                state.tabs.filter((t) => t.status === 'open').map((tab) => {
                  const isSelected = selectedTabId === tab.id;
                  const isMenuOpen = activeMenuTabId === tab.id;

                  return (
                    <div key={tab.id} className="relative">
                      <div
                        onClick={() => handleSelectTab(tab.id)}
                        className={`rounded-2xl p-2.5 flex items-center gap-2.5 transition-all cursor-pointer ${
                          isSelected
                            ? 'border-2 border-[#4A1505] bg-white dark:bg-zinc-900 shadow-xs'
                            : 'border border-amber-900/10 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:border-amber-900/30'
                        }`}
                      >
                        <div className="w-10 h-10 rounded-xl bg-[#FAF4EE] dark:bg-zinc-800 flex items-center justify-center text-amber-900/60 dark:text-amber-200 shrink-0">
                          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                            <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
                            <circle cx="12" cy="7" r="4" />
                          </svg>
                        </div>

                        <div className="flex-1 min-w-0" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="text"
                            value={
                              editingLabels[tab.id] !== undefined
                                ? editingLabels[tab.id]
                                : (tab.label || '')
                            }
                            placeholder="Nome da comanda (opcional)"
                            onChange={(e) => {
                              const val = e.target.value;
                              setEditingLabels((prev) => ({ ...prev, [tab.id]: val }));
                            }}
                            onFocus={() => handleSelectTab(tab.id)}
                            onBlur={(e) => {
                              void handleUpdateTabLabel(tab.id, e.target.value);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                e.currentTarget.blur();
                              } else if (e.key === 'Escape') {
                                setEditingLabels((prev) => {
                                  const copy = { ...prev };
                                  delete copy[tab.id];
                                  return copy;
                                });
                                e.currentTarget.blur();
                              }
                            }}
                            className="w-full rounded-xl border border-zinc-200/80 dark:border-zinc-700 bg-zinc-50/50 dark:bg-zinc-800/50 px-3 py-2 text-xs font-semibold text-zinc-800 dark:text-white placeholder:text-zinc-400 focus:outline-none focus:border-[#4A1505] focus:bg-white dark:focus:bg-zinc-800 transition cursor-text"
                          />
                        </div>

                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setActiveMenuTabId(isMenuOpen ? null : tab.id);
                          }}
                          className="w-8 h-8 rounded-xl flex items-center justify-center text-zinc-400 hover:text-zinc-700 dark:hover:text-white transition shrink-0 cursor-pointer"
                          aria-label="Opções da comanda"
                        >
                          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                            <circle cx="12" cy="5" r="1.8" />
                            <circle cx="12" cy="12" r="1.8" />
                            <circle cx="12" cy="19" r="1.8" />
                          </svg>
                        </button>
                      </div>

                      {/* Menu Popover das Opções (⋮) */}
                      {isMenuOpen && (
                        <div
                          onClick={(e) => e.stopPropagation()}
                          className="absolute right-2 top-14 z-30 w-52 rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-xl p-2 space-y-1 text-xs"
                        >
                          <button
                            type="button"
                            onClick={() => {
                              setLinkingGuestTabId(tab.id);
                              setActiveMenuTabId(null);
                            }}
                            className="w-full text-left px-3 py-2 rounded-xl text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 font-medium transition cursor-pointer"
                          >
                            Vincular cliente confirmado
                          </button>

                          {tab.status === 'open' ? (
                            <button
                              type="button"
                              onClick={() => {
                                setActiveMenuTabId(null);
                                void handleDeleteOrCloseTab(tab.id);
                              }}
                              className="w-full text-left px-3 py-2 rounded-xl text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 font-medium transition cursor-pointer"
                            >
                              {tabConsumptions[tab.id]?.status === 'error'
                                ? 'Verificar / Encerrar comanda'
                                : (tabConsumptions[tab.id]?.items.filter((it) => it.status === 'active').length ?? 0) === 0
                                  ? 'Encerrar comanda vazia'
                                  : 'Encerrar comanda'}
                            </button>
                          ) : (
                            <div className="px-3 py-2 text-zinc-400 font-medium">
                              Comanda encerrada
                            </div>
                          )}
                        </div>
                      )}

                      {/* Badges de status da comanda na Tela 3 */}
                      <div className="px-2 pt-1 flex items-center justify-between gap-2">
                        {state.links.some((l) => l.table_tab_id === tab.id) ? (
                          <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                            Conectado pelo celular
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setLinkingGuestTabId(tab.id)}
                            className="inline-flex items-center gap-1 text-[10px] text-amber-800 dark:text-amber-300 hover:underline cursor-pointer"
                          >
                            <span>📱</span>
                            <span>Vincular celular</span>
                          </button>
                        )}

                        {tabConsumptions[tab.id]?.status === 'error' ? (
                          <button
                            type="button"
                            onClick={() => void handleRetryTabConsumption(tab.id)}
                            className="text-[10px] text-rose-600 dark:text-rose-400 font-bold underline cursor-pointer hover:text-rose-800"
                          >
                            Erro no consumo · Tentar novamente
                          </button>
                        ) : tabConsumptions[tab.id]?.status === 'loading' ? (
                          <span className="text-[10px] text-zinc-400 font-medium">
                            Carregando consumo…
                          </span>
                        ) : null}
                      </div>

                      {/* Ação Visível: Fechar comanda para cada comanda aberta na guia Comanda (Tela 3) */}
                      {tab.status === 'open' && (
                        <div className="mt-2.5 pt-2 border-t border-zinc-100 dark:border-zinc-800/80 px-2 flex items-center justify-between gap-2">
                          <div className="text-[11px] font-semibold text-zinc-700 dark:text-zinc-200">
                            {tabConsumptions[tab.id]?.status === 'loading' ? (
                              <span className="text-zinc-400 font-normal">Calculando consumo…</span>
                            ) : tabConsumptions[tab.id]?.status === 'error' ? (
                              <span className="text-rose-500 font-normal">Erro no consumo</span>
                            ) : (
                              <span>
                                {currency.format((tabConsumptions[tab.id]?.totalInCents ?? 0) / 100)}
                                <span className="text-[10px] font-normal text-zinc-400 ml-1.5">
                                  ({(tabConsumptions[tab.id]?.items.filter((it) => it.status === 'active').length ?? 0)} {(tabConsumptions[tab.id]?.items.filter((it) => it.status === 'active').length ?? 0) === 1 ? 'item' : 'itens'})
                                </span>
                              </span>
                            )}
                          </div>

                          <button
                            type="button"
                            disabled={disabled || busy || tabConsumptions[tab.id]?.status === 'loading'}
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleDeleteOrCloseTab(tab.id);
                            }}
                            className="px-2.5 py-1.5 rounded-xl text-xs font-semibold text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40 hover:bg-rose-100 dark:hover:bg-rose-900/60 border border-rose-200 dark:border-rose-900/60 transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
                            title={`Fechar comanda ${tab.label}`}
                          >
                            <svg className="w-3.5 h-3.5 text-rose-600 dark:text-rose-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                            <span>Fechar comanda</span>
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* 3. Card Central de Estado Vazio / Carregamento / Erro */}
          <div className="bg-white dark:bg-zinc-900 rounded-3xl p-8 border border-zinc-200/60 dark:border-zinc-800 shadow-xs flex flex-col items-center text-center my-1 transition-all">
            {selectedTabConsumption.status === 'loading' ? (
              <>
                <div className="w-10 h-10 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-[#782006] dark:text-amber-400">
                  <div className="w-5 h-5 border-2 border-[#782006] border-t-transparent rounded-full animate-spin" />
                </div>
                <h4 className="font-bold text-sm text-zinc-900 dark:text-white mt-3.5">
                  Carregando consumo…
                </h4>
                <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1 max-w-[280px]">
                  Consultando os lançamentos da comanda selecionada no servidor.
                </p>
              </>
            ) : selectedTabConsumption.status === 'error' ? (
              <>
                <div className="w-16 h-16 rounded-full bg-rose-50 dark:bg-rose-950/30 flex items-center justify-center text-rose-600 dark:text-rose-400">
                  <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                </div>
                <h4 className="font-bold text-sm text-zinc-900 dark:text-white mt-3.5">
                  Falha ao consultar consumo
                </h4>
                <p className="text-xs text-rose-600 dark:text-rose-400 mt-1 max-w-[280px]">
                  {selectedTabConsumption.error || 'Não foi possível carregar os itens desta comanda.'}
                </p>
                {selectedTabConsumption.isStale && (
                  <p className="text-[11px] text-amber-700 dark:text-amber-300 mt-1">
                    Aviso: exibindo dados desatualizados em cache.
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => selectedTabId && void handleRetryTabConsumption(selectedTabId)}
                  className="bg-rose-600 hover:bg-rose-700 text-white font-bold py-2.5 px-5 rounded-2xl text-xs shadow-md mt-4 transition cursor-pointer flex items-center gap-1.5"
                >
                  <span>Tentar novamente</span>
                </button>
              </>
            ) : (
              <>
                <div className="w-16 h-16 rounded-full bg-[#FAF4EE] dark:bg-zinc-800 flex items-center justify-center text-[#782006] dark:text-amber-400">
                  <svg
                    className="w-8 h-8 text-[#782006] dark:text-amber-400"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
                    <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
                    <line x1="9" y1="12" x2="15" y2="12" />
                    <line x1="9" y1="16" x2="13" y2="16" />
                    <circle cx="18" cy="18" r="3.5" className="fill-[#FAF4EE] dark:fill-zinc-800" strokeWidth="1.8" />
                    <line x1="18" y1="16.2" x2="18" y2="19.8" strokeWidth="1.8" />
                    <line x1="16.2" y1="18" x2="19.8" y2="18" strokeWidth="1.8" />
                  </svg>
                </div>

                <h4 className="font-bold text-sm text-zinc-900 dark:text-white mt-3.5">
                  {selectedTabConsumption.items.length > 0
                    ? `${selectedTabConsumption.items.length} ${selectedTabConsumption.items.length === 1 ? 'item adicionado' : 'itens adicionados'}`
                    : 'Nenhum item adicionado'}
                </h4>
                <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1 max-w-[280px]">
                  {selectedTabConsumption.items.length > 0
                    ? 'Acesse os itens ou adicione novos produtos do cardápio.'
                    : 'Selecione uma comanda e adicione os itens do cardápio para começar.'}
                </p>

                {/* Botão Largo Primário: + Adicionar items (Transiciona para o Catálogo / Tela 4) */}
                <button
                  type="button"
                  onClick={() => void handleTransitionToCatalog()}
                  className="bg-[#4A1505] hover:bg-[#381004] text-white font-bold py-3 px-6 rounded-2xl text-xs shadow-md mt-4 transition cursor-pointer flex items-center gap-1.5"
                >
                  <span>+</span>
                  <span>{selectedTabConsumption.items.length > 0 ? 'Ver / Adicionar itens' : 'Adicionar items'}</span>
                </button>
              </>
            )}
          </div>

          {/* 4. Resumo Financeiro Inicial da Mesa e Ações Rápidas */}
          <div className="space-y-2 pt-1">
            {tableTotalsIncomplete && (
              <div className="rounded-2xl bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800 p-2.5 text-xs text-amber-800 dark:text-amber-200 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <svg className="w-4 h-4 text-amber-600 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  <span className="text-[11px] font-medium leading-tight">
                    Atenção: Os totais abaixo são parciais pois há comanda(s) com consumo pendente ou erro de consulta.
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setRefresh((r) => r + 1)}
                  className="font-bold underline text-amber-900 dark:text-amber-100 hover:text-black shrink-0 cursor-pointer text-[11px]"
                >
                  Recarregar
                </button>
              </div>
            )}

            <div className="grid grid-cols-3 gap-2 p-3 rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200/60 dark:border-zinc-800 shadow-xs">
              <div>
                <span className="text-[10px] text-zinc-400 font-medium block">Total da mesa</span>
                <span className="text-xs font-bold text-zinc-900 dark:text-white mt-0.5 block">
                  {tableTotalsIncomplete ? `${currency.format(tableSubtotal / 100)} (parcial)` : currency.format(tableSubtotal / 100)}
                </span>
              </div>

              <div>
                <span className="text-[10px] text-zinc-400 font-medium block">
                  Taxa de serviço ({restaurantFeePercent}%)
                </span>
                <span className="text-xs font-bold text-zinc-900 dark:text-white mt-0.5 block">
                  {currency.format(tableFee / 100)}
                </span>
              </div>

              <div>
                <span className="text-[10px] text-[#782006] dark:text-amber-300 font-medium block">
                  Total geral
                </span>
                <span className="text-sm font-extrabold text-[#782006] dark:text-amber-400 mt-0.5 block">
                  {tableTotalsIncomplete ? `${currency.format(tableGrandTotal / 100)}*` : currency.format(tableGrandTotal / 100)}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => setNotice('Selecione uma comanda para transferir itens.')}
                className="p-2.5 rounded-2xl border border-amber-900/10 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-xs flex items-center justify-center gap-1.5 text-[11px] font-semibold text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition cursor-pointer"
              >
                <svg className="w-3.5 h-3.5 text-[#782006] dark:text-amber-300 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 3v12" />
                  <path d="m8 7 4-4 4 4" />
                  <path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
                </svg>
                <span className="truncate">Transferir item</span>
              </button>

              <button
                type="button"
                onClick={() => setNotice('Crie ou selecione uma comanda para mover itens.')}
                className="p-2.5 rounded-2xl border border-amber-900/10 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-xs flex items-center justify-center gap-1.5 text-[11px] font-semibold text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition cursor-pointer"
              >
                <svg className="w-3.5 h-3.5 text-[#782006] dark:text-amber-300 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M16 3h5v5" />
                  <path d="M4 20 21 3" />
                  <path d="M21 16v5h-5" />
                  <path d="m15 15 6 6" />
                  <path d="M4 4l5 5" />
                </svg>
                <span className="truncate">Mover para outra comanda</span>
              </button>

              <button
                type="button"
                onClick={handlePrintReceipt}
                disabled={tableTotalsIncomplete}
                title={tableTotalsIncomplete ? 'Pré-conta indisponível enquanto houver comanda com consumo incompleto' : 'Imprimir pré-conta'}
                className="p-2.5 rounded-2xl border border-amber-900/10 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-xs flex items-center justify-center gap-1.5 text-[11px] font-semibold text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <svg className="w-3.5 h-3.5 text-[#782006] dark:text-amber-300 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M6 9V2h12v7" />
                  <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                  <path d="M6 14h12v8H6z" />
                </svg>
                <span className="truncate">Imprimir pré-conta</span>
              </button>
            </div>

            {/* Ação Visível em Tela 3: Dividir conta e Fechar comanda selecionada lado a lado */}
            <div className="grid grid-cols-2 gap-2 mt-2">
              <button
                type="button"
                onClick={() => setIsSplitBillModalOpen(true)}
                className="py-2.5 px-2 sm:px-3 rounded-2xl border border-amber-300 dark:border-amber-800/80 bg-amber-50/90 dark:bg-amber-950/40 hover:bg-amber-100 dark:hover:bg-amber-900/60 text-[#782006] dark:text-amber-300 font-semibold text-xs flex items-center justify-center gap-1.5 transition cursor-pointer text-center"
                title="Simular divisão estimada da conta"
              >
                <svg className="w-3.5 h-3.5 text-[#782006] dark:text-amber-300 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
                <span className="truncate">Dividir conta</span>
              </button>

              {selectedTab && selectedTab.status === 'open' && (
                <button
                  type="button"
                  disabled={disabled || busy || (selectedTabId ? tabConsumptions[selectedTabId]?.status === 'loading' : false)}
                  onClick={() => {
                    if (selectedTabId) {
                      void handleDeleteOrCloseTab(selectedTabId);
                    }
                  }}
                  className="py-2.5 px-2 sm:px-3 rounded-2xl border border-rose-200 dark:border-rose-900/50 bg-rose-50/80 dark:bg-rose-950/30 hover:bg-rose-100 dark:hover:bg-rose-900/50 text-rose-700 dark:text-rose-300 font-semibold text-xs flex items-center justify-center gap-1.5 transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed text-center"
                  title={`Fechar comanda ${selectedTab.label || 'cliente'}`}
                >
                  <svg className="w-3.5 h-3.5 text-rose-600 dark:text-rose-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  <span className="truncate">Fechar comanda</span>
                </button>
              )}
            </div>
          </div>
        </div>
      ) : (
        /* ========================================================================= */
        /* ESTADO 2: TELA 4 — MODO CATÁLOGO / REGISTRO DE CONSUMO ABERTO            */
        /* ========================================================================= */
        <div className="space-y-4">
          {/* Botão de retorno para a Tela 3 (Visão de Gestão de Comandas) */}
          <button
            type="button"
            onClick={handleBackToComandas}
            className="flex items-center gap-1.5 text-xs font-semibold text-zinc-500 hover:text-zinc-800 dark:hover:text-white transition cursor-pointer"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            <span>Voltar para comandas da mesa</span>
          </button>

          {/* A. Seletor de Comandas / Pessoas (Carrossel Horizontal) */}
          <div className="flex items-stretch gap-2.5 overflow-x-auto pb-1 scrollbar-none">
            {/* Botão + Adicionar pessoa (com input inline para nomear) */}
            {isAddingPerson ? (
              <div className="border-2 border-[#4A1505] bg-white dark:bg-zinc-900 rounded-2xl p-2.5 min-w-[150px] shrink-0 flex flex-col justify-between shadow-md">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[11px] font-bold text-zinc-700 dark:text-zinc-200">
                    Nova pessoa
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setIsAddingPerson(false);
                      setNewPersonName('');
                    }}
                    className="text-zinc-400 hover:text-zinc-600 text-xs p-0.5 cursor-pointer"
                  >
                    ✕
                  </button>
                </div>
                <input
                  type="text"
                  autoFocus
                  value={newPersonName}
                  onChange={(e) => setNewPersonName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      const name = newPersonName.trim();
                      const gId = newPersonGuestId;
                      setIsAddingPerson(false);
                      setNewPersonName('');
                      setNewPersonGuestId('');
                      void handleCreateComanda(name, gId);
                    } else if (e.key === 'Escape') {
                      setIsAddingPerson(false);
                      setNewPersonName('');
                      setNewPersonGuestId('');
                    }
                  }}
                  placeholder="Nome (ex: Lucas)"
                  className="w-full text-xs rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 px-2 py-1.5 text-zinc-900 dark:text-white placeholder:text-zinc-400 focus:outline-none focus:border-[#4A1505] mb-1.5"
                />

                {/* Seleção opcional de cliente com celular confirmado */}
                {activeGuests.length > 0 && (
                  <select
                    value={newPersonGuestId}
                    onChange={(e) => setNewPersonGuestId(e.target.value)}
                    className="w-full text-[10px] rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 px-1.5 py-1 text-zinc-700 dark:text-zinc-200 mb-2 focus:outline-none"
                  >
                    <option value="">📱 Celular (opcional)</option>
                    {activeGuests.map((g, idx) => {
                      const isLinked = state.links.some((l) => l.guest_session_id === g.id);
                      return (
                        <option key={g.id} value={g.id} disabled={isLinked}>
                          Cliente #{idx + 1} {isLinked ? '(já vinculado)' : ''}
                        </option>
                      );
                    })}
                  </select>
                )}

                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    const name = newPersonName.trim();
                    const gId = newPersonGuestId;
                    setIsAddingPerson(false);
                    setNewPersonName('');
                    setNewPersonGuestId('');
                    void handleCreateComanda(name, gId);
                  }}
                  className="bg-[#4A1505] text-white text-xs font-bold py-1.5 px-3 rounded-xl hover:bg-[#381004] transition cursor-pointer disabled:opacity-50"
                >
                  {busy ? 'Criando…' : 'Criar'}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setIsAddingPerson(true);
                  setNewPersonName('');
                }}
                disabled={disabled}
                className="border-2 border-dashed border-zinc-200 dark:border-zinc-700 hover:border-amber-900/40 bg-white/40 dark:bg-zinc-900/40 rounded-2xl p-2.5 flex flex-col items-center justify-center min-w-[85px] shrink-0 text-zinc-500 hover:text-zinc-800 transition cursor-pointer disabled:opacity-50"
              >
                <div className="w-6 h-6 rounded-full border border-zinc-300 dark:border-zinc-600 flex items-center justify-center text-zinc-600 dark:text-zinc-300 text-sm font-bold mb-1">
                  +
                </div>
                <span className="text-[11px] font-semibold text-zinc-600 dark:text-zinc-300 text-center leading-tight">
                  Adicionar pessoa
                </span>
              </button>
            )}

            {/* Cards individuais de cada comanda/pessoa */}
            {individualTabs.map((tab) => {
              const isSelected = selectedTabId === tab.id;
              const tabConsumption = tabConsumptions[tab.id];
              const tabTotal = tabConsumption?.totalInCents ?? 0;
              const linkedGuest = state.links.find((l) => l.table_tab_id === tab.id);
              const isMobileConnected = Boolean(linkedGuest);

              return (
                <div
                  key={tab.id}
                  onClick={() => handleSelectTab(tab.id)}
                  className={`rounded-2xl p-2.5 min-w-[115px] shrink-0 transition-all cursor-pointer flex flex-col justify-between ${
                    isSelected
                      ? 'border-2 border-[#4A1505] bg-[#FAF4EE] dark:bg-zinc-800 shadow-xs'
                      : 'border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:border-zinc-300'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="text-amber-900/80 dark:text-amber-300">
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                        <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
                        <circle cx="12" cy="7" r="4" />
                      </svg>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleDeleteOrCloseTab(tab.id);
                      }}
                      title={`Fechar comanda ${tab.label}`}
                      aria-label={`Fechar comanda ${tab.label}`}
                      className="text-zinc-400 hover:text-rose-600 p-0.5 rounded cursor-pointer transition-colors"
                    >
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M3 6h18" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  </div>

                  <div onClick={(e) => e.stopPropagation()}>
                    {editingCardTabId === tab.id ? (
                      <input
                        type="text"
                        autoFocus
                        value={editingLabels[tab.id] !== undefined ? editingLabels[tab.id] : (tab.label || '')}
                        onChange={(e) => {
                          const val = e.target.value;
                          setEditingLabels((prev) => ({ ...prev, [tab.id]: val }));
                        }}
                        onBlur={(e) => {
                          setEditingCardTabId(null);
                          void handleUpdateTabLabel(tab.id, e.target.value);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.currentTarget.blur();
                          } else if (e.key === 'Escape') {
                            setEditingCardTabId(null);
                          }
                        }}
                        className="font-bold text-xs text-zinc-900 dark:text-white bg-transparent border-b border-[#4A1505] focus:outline-none w-full"
                      />
                    ) : (
                      <h4
                        onDoubleClick={() => setEditingCardTabId(tab.id)}
                        onClick={() => handleSelectTab(tab.id)}
                        title="Clique para selecionar ou duplo clique para renomear"
                        className="font-bold text-xs text-zinc-900 dark:text-white truncate cursor-pointer hover:underline"
                      >
                        {tab.label}
                      </h4>
                    )}

                    <span className="text-[11px] font-semibold text-zinc-600 dark:text-zinc-300 block mt-0.5">
                      {tabConsumption?.status === 'error' ? (
                        <span className="text-rose-600 dark:text-rose-400 font-bold text-[10px]">
                          Erro · Indisponível
                        </span>
                      ) : tabConsumption?.status === 'loading' ? (
                        <span className="text-zinc-400 text-[10px]">Carregando…</span>
                      ) : (
                        <>
                          {tabConsumption?.isStale && (
                            <span className="text-amber-600 dark:text-amber-400 text-[9px] mr-1">
                              (desatualizado)
                            </span>
                          )}
                          {currency.format(tabTotal / 100)}
                        </>
                      )}
                    </span>

                    {tabConsumption?.status === 'error' && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleRetryTabConsumption(tab.id);
                        }}
                        className="text-[10px] text-rose-600 dark:text-rose-400 underline font-bold hover:text-rose-800 mt-0.5 block cursor-pointer"
                      >
                        Tentar novamente
                      </button>
                    )}

                    {/* Badge de celular vinculado no carrossel */}
                    {isMobileConnected ? (
                      <div className="flex items-center gap-1 mt-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
                        <span className="truncate">Conectado pelo celular</span>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setLinkingGuestTabId(tab.id);
                        }}
                        className="inline-flex items-center gap-1 text-[10px] text-amber-800 dark:text-amber-300 hover:underline mt-1 cursor-pointer"
                      >
                        <span>📱</span>
                        <span className="truncate">Vincular celular</span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Card "+ Conta conjunta (Mesa toda)" posicionado à direita, somente se houver mais de uma pessoa real */}
            {hasMultiplePersons && (() => {
              const isSelected = sharedTab ? selectedTabId === sharedTab.id : false;

              return (
                <div
                  onClick={async () => {
                    if (sharedTab) {
                      handleSelectTab(sharedTab.id);
                    } else {
                      const id = crypto.randomUUID();
                      await perform(
                        () => createTableTab(restaurantSlug, tableVisitId, 'Conta conjunta', id),
                        'Conta conjunta criada.',
                        () => {
                          handleSelectTab(id);
                        },
                      );
                    }
                  }}
                  className={`rounded-2xl p-2.5 min-w-[115px] shrink-0 transition-all cursor-pointer flex flex-col justify-between ${
                    isSelected
                      ? 'border-2 border-[#4A1505] bg-[#FAF4EE] dark:bg-zinc-800 shadow-xs'
                      : 'border border-dashed border-amber-900/30 dark:border-zinc-700 bg-amber-50/40 dark:bg-zinc-900/40 hover:border-amber-900/60'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="text-amber-900 dark:text-amber-300">
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                        <circle cx="9" cy="7" r="4" />
                        <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                      </svg>
                    </div>
                    {sharedTab && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleDeleteOrCloseTab(sharedTab.id);
                        }}
                        title="Remover ou encerrar conta conjunta"
                        className="text-zinc-400 hover:text-rose-600 p-0.5 rounded cursor-pointer transition-colors"
                      >
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M3 6h18" />
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                      </button>
                    )}
                  </div>

                  <div>
                    <h4 className="font-bold text-xs text-zinc-900 dark:text-white truncate">
                      {sharedTab ? 'Conta conjunta' : '+ Conta conjunta'}
                    </h4>
                    <span className="text-[11px] font-semibold text-zinc-600 dark:text-zinc-300 block mt-0.5">
                      {tableTotalsIncomplete
                        ? `${currency.format(tableSubtotal / 100)} (parcial)`
                        : tableSubtotal > 0
                          ? currency.format(tableSubtotal / 100)
                          : 'Mesa toda'}
                    </span>
                  </div>
                </div>
              );
            })()}
          </div>

          {/* B. Seção "Registrar consumo" & Catálogo */}
          <div className="space-y-3 pt-1">
            <div className="flex items-center gap-2.5">
              <div className="w-10 h-10 rounded-2xl bg-[#FAF4EE] dark:bg-zinc-800 flex items-center justify-center text-[#782006] dark:text-amber-300 shrink-0">
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 2v6a3 3 0 0 1-3 3 3 3 0 0 1-3-3V2" />
                  <path d="M15 2v14a2 2 0 0 1-2 2h-2" />
                  <path d="M6 2v20" />
                  <path d="M4 2v4a2 2 0 0 0 2 2h0a2 2 0 0 0 2-2V2" />
                </svg>
              </div>
              <div>
                <h3 className="font-bold text-sm text-zinc-900 dark:text-white leading-tight">
                  Registrar consumo
                </h3>
                <p className="text-[11px] text-zinc-400 dark:text-zinc-500 leading-tight mt-0.5">
                  Adicione itens à comanda de forma rápida.
                </p>
              </div>
            </div>

            {catalogLoading ? (
              <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-6 text-center space-y-2">
                <div className="w-6 h-6 border-2 border-[#4A1505] border-t-transparent rounded-full animate-spin mx-auto" />
                <p className="text-xs text-zinc-500 dark:text-zinc-400">Carregando cardápio…</p>
              </div>
            ) : catalogError ? (
              <div className="bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900/40 rounded-2xl p-4 text-center space-y-2">
                <p className="text-xs font-semibold text-rose-700 dark:text-rose-300">
                  {catalogError}
                </p>
                <button
                  type="button"
                  onClick={retryLoadCatalog}
                  className="px-3.5 py-1.5 bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold rounded-xl transition cursor-pointer"
                >
                  Tentar novamente
                </button>
              </div>
            ) : products.length === 0 ? (
              <div className="bg-zinc-50 dark:bg-zinc-900 border border-dashed border-zinc-300 dark:border-zinc-800 rounded-2xl p-6 text-center space-y-2">
                <div className="w-10 h-10 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-zinc-400 mx-auto">
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M6 2v20" />
                    <path d="M18 2v6a3 3 0 0 1-3 3 3 3 0 0 1-3-3V2" />
                  </svg>
                </div>
                <h4 className="text-xs font-bold text-zinc-800 dark:text-zinc-200">
                  Nenhum produto cadastrado no cardápio
                </h4>
                {role === 'admin' ? (
                  <div className="pt-1">
                    <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mb-2">
                      Como administrador, você pode cadastrar categorias e pratos agora.
                    </p>
                    <Link
                      to={`/${restaurantSlug}/admin/catalogo`}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#4A1505] hover:bg-[#381004] text-white text-xs font-bold rounded-xl transition shadow-xs"
                    >
                      <span>Cadastrar produtos no cardápio</span>
                      <span>→</span>
                    </Link>
                  </div>
                ) : (
                  <p className="text-[11px] text-zinc-500 dark:text-zinc-400 max-w-xs mx-auto">
                    Solicite ao administrador o cadastro de produtos no cardápio para realizar lançamentos.
                  </p>
                )}
              </div>
            ) : (
              <>
                {/* Campo de Busca */}
                <div className="relative flex items-center rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3.5 py-2.5 shadow-xs">
                  <svg className="w-4 h-4 text-zinc-400 shrink-0 mr-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => {
                      setSearchQuery(e.target.value);
                      setCatalogPage(1);
                      onSearchQueryChange?.(e.target.value);
                    }}
                    placeholder="Buscar prato ou bebida..."
                    className="w-full text-xs text-zinc-800 dark:text-white placeholder:text-zinc-400 bg-transparent focus:outline-none"
                  />
                  <svg className="w-4 h-4 text-zinc-400 shrink-0 ml-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </div>

                {/* Categorias horizontais com scroll */}
                {categories.length > 0 && (
                  <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedCategory('todos');
                        setCatalogPage(1);
                      }}
                      className={`rounded-xl px-3.5 py-2 text-xs font-semibold shadow-xs flex items-center gap-1.5 shrink-0 transition-colors cursor-pointer ${
                        selectedCategory === 'todos'
                          ? 'bg-[#4A1505] text-white'
                          : 'bg-white dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 border border-zinc-200/80 dark:border-zinc-700 hover:bg-zinc-50'
                      }`}
                    >
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                        <rect x="3" y="3" width="7" height="7" rx="1.5" />
                        <rect x="14" y="3" width="7" height="7" rx="1.5" />
                        <rect x="3" y="14" width="7" height="7" rx="1.5" />
                        <rect x="14" y="14" width="7" height="7" rx="1.5" />
                      </svg>
                      <span>Todos</span>
                    </button>

                    {categories.map((cat) => {
                      const isCatActive = selectedCategory === cat.slug || selectedCategory === cat.id;
                      return (
                        <button
                          key={cat.id}
                          type="button"
                          onClick={() => {
                            setSelectedCategory(cat.slug || cat.id);
                            setCatalogPage(1);
                          }}
                          className={`rounded-xl px-3.5 py-2 text-xs font-semibold shadow-xs flex items-center gap-1.5 shrink-0 transition-colors cursor-pointer ${
                            isCatActive
                              ? 'bg-[#4A1505] text-white'
                              : 'bg-white dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 border border-zinc-200/80 dark:border-zinc-700 hover:bg-zinc-50'
                          }`}
                        >
                          <span>{cat.name}</span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Lista compacta de produtos com paginação de até 5 cards */}
                <div className="space-y-2">
                  {filteredProducts.length === 0 ? (
                    <p className="text-xs text-zinc-400 italic py-2 text-center">
                      Nenhum produto encontrado com os filtros atuais.
                    </p>
                  ) : (
                    paginatedCatalog.displayedProducts.map((prod) => {
                      const imageUrl = prod.images?.[0]?.url;

                      return (
                        <div
                          key={prod.id}
                          className="bg-white dark:bg-zinc-900 border border-zinc-100 dark:border-zinc-800 rounded-2xl p-2.5 flex items-center justify-between gap-3 shadow-xs hover:border-zinc-200 transition"
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            {imageUrl ? (
                              <img
                                src={imageUrl}
                                alt={prod.name}
                                className="w-14 h-14 rounded-xl object-cover shrink-0 bg-zinc-100 dark:bg-zinc-800"
                              />
                            ) : (
                              <div className="w-14 h-14 rounded-xl bg-[#FAF4EE] dark:bg-zinc-800 flex items-center justify-center text-[#782006] shrink-0 font-bold text-sm">
                                {prod.name.charAt(0)}
                              </div>
                            )}

                            <div className="min-w-0">
                              <h4 className="font-bold text-xs text-zinc-900 dark:text-white leading-snug truncate">
                                {prod.name}
                              </h4>
                              <p className="text-[11px] text-zinc-400 dark:text-zinc-500 line-clamp-1 mt-0.5">
                                {prod.short_description || prod.description}
                              </p>
                              <span className="text-xs font-extrabold text-[#782006] dark:text-amber-400 mt-1 block">
                                {currency.format(prod.price_in_cents / 100)}
                              </span>
                            </div>
                          </div>

                          <button
                            type="button"
                            onClick={() => void handleQuickAddItem(prod)}
                            title="Adicionar à comanda selecionada"
                            className="w-8 h-8 rounded-full border border-amber-900/20 dark:border-zinc-700 bg-white dark:bg-zinc-800 flex items-center justify-center text-[#782006] dark:text-amber-300 font-bold text-base active:scale-95 shadow-xs hover:border-amber-900/50 hover:bg-[#FAF4EE] dark:hover:bg-zinc-700 transition cursor-pointer shrink-0"
                          >
                            +
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>

                {/* Controles de paginação do catálogo quando houver mais de 5 produtos */}
                {paginatedCatalog.isPaginated && (
                  <div className="flex flex-col sm:flex-row items-center justify-between gap-2 pt-2 border-t border-zinc-100 dark:border-zinc-800">
                    <span className="text-[11px] text-zinc-500 dark:text-zinc-400 font-medium">
                      {paginatedCatalog.rangeText}
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        disabled={!paginatedCatalog.hasPreviousPage}
                        onClick={() => setCatalogPage((p) => Math.max(1, p - 1))}
                        className="px-2.5 py-1 text-xs font-semibold rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                        aria-label="Página anterior do catálogo"
                      >
                        Anterior
                      </button>
                      {paginatedCatalog.pageNumbers.map((num) => (
                        <button
                          key={num}
                          type="button"
                          onClick={() => setCatalogPage(num)}
                          className={`w-7 h-7 text-xs font-bold rounded-lg transition-colors cursor-pointer ${
                            num === paginatedCatalog.currentPage
                              ? 'bg-[#4A1505] text-white shadow-xs'
                              : 'bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50'
                          }`}
                          aria-label={`Página ${num} do catálogo`}
                          aria-current={num === paginatedCatalog.currentPage ? 'page' : undefined}
                        >
                          {num}
                        </button>
                      ))}
                      <button
                        type="button"
                        disabled={!paginatedCatalog.hasNextPage}
                        onClick={() => setCatalogPage((p) => Math.min(paginatedCatalog.totalPages, p + 1))}
                        className="px-2.5 py-1 text-xs font-semibold rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                        aria-label="Próxima página do catálogo"
                      >
                        Próxima
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* C. Seção "Itens de [Nome da Comanda]" */}
          <div className="space-y-2.5 pt-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 min-w-0">
                {isSharedTabSelected ? (
                  <h4 className="font-bold text-xs text-[#782006] dark:text-amber-300 flex items-center gap-1.5">
                    <svg className="w-4 h-4 text-amber-900 dark:text-amber-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                      <circle cx="9" cy="7" r="4" />
                      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                    </svg>
                    Conta conjunta (Mesa toda)
                  </h4>
                ) : (
                  <>
                    <h4 className="font-bold text-xs text-zinc-900 dark:text-white shrink-0">
                      Itens de
                    </h4>
                    {selectedTab && (
                      <input
                        type="text"
                        value={
                          editingLabels[selectedTab.id] !== undefined
                            ? editingLabels[selectedTab.id]
                            : (selectedTab.label || '')
                        }
                        placeholder="Nome da comanda"
                        onChange={(e) => {
                          const val = e.target.value;
                          setEditingLabels((prev) => ({ ...prev, [selectedTab.id]: val }));
                        }}
                        onBlur={(e) => {
                          void handleUpdateTabLabel(selectedTab.id, e.target.value);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            e.currentTarget.blur();
                          }
                        }}
                        className="font-bold text-xs text-[#782006] dark:text-amber-300 bg-transparent border-b border-dashed border-amber-900/30 hover:border-amber-900 focus:border-[#4A1505] focus:outline-none px-1 py-0.5 rounded transition max-w-[140px] truncate"
                        title="Clique para renomear a comanda"
                      />
                    )}
                  </>
                )}
                <span className="text-xs text-zinc-400 shrink-0">
                  ({totalActiveQuantity})
                </span>
              </div>

              <div className="flex items-center gap-2">
                {activeItems.length > 0 && (() => {
                  const consumption = selectedTabId ? tabConsumptions[selectedTabId] : undefined;
                  const isClearBlocked =
                    !consumption ||
                    consumption.status !== 'loaded' ||
                    Boolean(consumption.isStale);

                  return (
                    <button
                      type="button"
                      disabled={disabled || isClearBlocked}
                      onClick={handleClearPersonItems}
                      title={
                        isClearBlocked
                          ? 'Não é possível limpar enquanto o consumo estiver carregando, com erro ou desatualizado'
                          : 'Limpar todos os itens da comanda'
                      }
                      className="text-xs text-zinc-400 hover:text-red-500 flex items-center gap-1 cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-zinc-400"
                    >
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M3 6h18" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                      <span>Limpar</span>
                    </button>
                  );
                })()}
              </div>
            </div>

            {/* Listagem de Itens: Consolidada para Conta Conjunta ou Individual */}
            {isSharedTabSelected ? (
              <div className="space-y-4">
                {/* 1. Itens compartilhados diretamente na mesa */}
                {(() => {
                  const sharedConsumption = sharedTab ? tabConsumptions[sharedTab.id] : undefined;
                  const sharedItems = sharedConsumption?.items ?? [];
                  const groupedShared = groupItemsByProductAndStatus(sharedItems);
                  const isSharedExpanded = expandedContaConjuntaLists['shared'] ?? false;
                  const sharedPage = pageContaConjuntaLists['shared'] ?? 1;
                  const paginatedShared = paginateComandaItems(groupedShared, isSharedExpanded, sharedPage);

                  return (
                    <div className="rounded-2xl p-3 bg-amber-50/50 dark:bg-amber-950/20 border border-amber-900/10 dark:border-amber-900/30 space-y-2">
                      <div className="flex items-center justify-between text-xs font-bold text-amber-950 dark:text-amber-200">
                        <span className="flex items-center gap-1.5">
                          <svg className="w-4 h-4 text-amber-900 dark:text-amber-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                            <circle cx="9" cy="7" r="4" />
                            <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                          </svg>
                          Itens compartilhados da mesa
                        </span>
                        <span className="font-extrabold text-amber-950 dark:text-amber-200">
                          {sharedConsumption?.status === 'error' ? (
                            <span className="text-rose-600 text-[11px]">Indisponível</span>
                          ) : sharedConsumption?.status === 'loading' ? (
                            <span className="text-zinc-400 text-[11px]">…</span>
                          ) : (
                            currency.format((sharedConsumption?.totalInCents ?? 0) / 100)
                          )}
                        </span>
                      </div>

                      {sharedConsumption?.status === 'error' ? (
                        <div className="p-2.5 rounded-xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900/40 text-xs flex items-center justify-between gap-2">
                          <span className="text-rose-700 dark:text-rose-300 text-[11px] font-medium">
                            {sharedConsumption.error || 'Erro ao carregar itens compartilhados'}
                          </span>
                          <button
                            type="button"
                            onClick={() => sharedTab && void handleRetryTabConsumption(sharedTab.id)}
                            className="text-rose-800 dark:text-rose-200 font-bold underline text-[11px] cursor-pointer"
                          >
                            Tentar novamente
                          </button>
                        </div>
                      ) : sharedConsumption?.status === 'loading' ? (
                        <p className="text-[11px] text-zinc-400 italic py-1">
                          Consultando itens coletivos…
                        </p>
                      ) : groupedShared.length === 0 ? (
                        <p className="text-[11px] text-amber-900/60 dark:text-amber-300/60 italic py-1">
                          Nenhum item lançado no coletivo. Novos pedidos aqui serão divididos pela mesa.
                        </p>
                      ) : (
                        <div className="space-y-2">
                          <div className="divide-y divide-amber-900/10 dark:divide-amber-900/20">
                            {paginatedShared.displayedItems.map((group) => renderItemRow(group))}
                          </div>

                          {groupedShared.length > 2 && (
                            <div className="pt-1">
                              {!isSharedExpanded ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setExpandedContaConjuntaLists((prev) => ({ ...prev, shared: true }))
                                  }
                                  className="w-full py-2 px-3 rounded-xl border border-dashed border-amber-900/30 hover:border-amber-900 bg-amber-100/50 hover:bg-amber-100 dark:bg-amber-900/20 text-amber-950 dark:text-amber-200 font-bold text-xs transition flex items-center justify-center gap-1.5 cursor-pointer"
                                >
                                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <polyline points="6 9 12 15 18 9" />
                                  </svg>
                                  <span>Ver mais (+{groupedShared.length - 2} itens)</span>
                                </button>
                              ) : (
                                paginatedShared.isPaginated && (
                                  <div className="flex flex-col sm:flex-row items-center justify-between gap-2 pt-1.5 border-t border-amber-900/10 dark:border-amber-900/20">
                                    <span className="text-[11px] text-amber-950/70 dark:text-amber-300/70 font-medium">
                                      {paginatedShared.rangeText}
                                    </span>
                                    <div className="flex items-center gap-1">
                                      <button
                                        type="button"
                                        disabled={!paginatedShared.hasPreviousPage}
                                        onClick={() =>
                                          setPageContaConjuntaLists((prev) => ({
                                            ...prev,
                                            shared: Math.max(1, (prev.shared || 1) - 1),
                                          }))
                                        }
                                        className="px-2 py-1 text-xs font-semibold rounded-lg border border-amber-900/20 bg-white dark:bg-zinc-800 text-amber-950 dark:text-amber-200 hover:bg-amber-50 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                                      >
                                        Anterior
                                      </button>
                                      {paginatedShared.pageNumbers.map((num) => (
                                        <button
                                          key={num}
                                          type="button"
                                          onClick={() =>
                                            setPageContaConjuntaLists((prev) => ({
                                              ...prev,
                                              shared: num,
                                            }))
                                          }
                                          className={`w-7 h-7 text-xs font-bold rounded-lg transition-colors cursor-pointer ${
                                            num === paginatedShared.currentPage
                                              ? 'bg-[#4A1505] text-white shadow-xs'
                                              : 'bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50'
                                          }`}
                                        >
                                          {num}
                                        </button>
                                      ))}
                                      <button
                                        type="button"
                                        disabled={!paginatedShared.hasNextPage}
                                        onClick={() =>
                                          setPageContaConjuntaLists((prev) => ({
                                            ...prev,
                                            shared: Math.min(paginatedShared.totalPages, (prev.shared || 1) + 1),
                                          }))
                                        }
                                        className="px-2 py-1 text-xs font-semibold rounded-lg border border-amber-900/20 bg-white dark:bg-zinc-800 text-amber-950 dark:text-amber-200 hover:bg-amber-50 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                                      >
                                        Próxima
                                      </button>
                                    </div>
                                  </div>
                                )
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* 2. Resumo discriminado por pessoa/comanda */}
                <div className="space-y-3 pt-1">
                  <h4 className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider px-1">
                    Itens por comanda da mesa
                  </h4>

                  {state.tabs
                    .filter(
                      (t) =>
                        t.status === 'open' &&
                        !t.label.toLowerCase().includes('conjunta') &&
                        !t.label.toLowerCase().includes('compartilhada') &&
                        !t.label.toLowerCase().includes('mesa toda'),
                    )
                    .map((personTab) => {
                      const personConsumption = tabConsumptions[personTab.id] || { status: 'loading', items: [], totalInCents: 0 };
                      const personGrouped = groupItemsByProductAndStatus(personConsumption.items);
                      const isPersonExpanded = expandedContaConjuntaLists[personTab.id] ?? false;
                      const personPage = pageContaConjuntaLists[personTab.id] ?? 1;
                      const paginatedPerson = paginateComandaItems(personGrouped, isPersonExpanded, personPage);

                      return (
                        <div
                          key={personTab.id}
                          className="rounded-2xl p-3 bg-white dark:bg-zinc-900 border border-zinc-200/70 dark:border-zinc-800 shadow-2xs space-y-2"
                        >
                          <div className="flex items-center justify-between text-xs pb-1 border-b border-zinc-100 dark:border-zinc-800">
                            <span className="font-bold text-zinc-900 dark:text-white flex items-center gap-1.5">
                              <span className="w-2 h-2 rounded-full bg-[#4A1505] dark:bg-amber-400 shrink-0" />
                              {personTab.label}
                              {personConsumption.isStale && (
                                <span className="text-[10px] font-normal text-amber-600 dark:text-amber-400">
                                  (desatualizado)
                                </span>
                              )}
                            </span>
                            <span className="font-extrabold text-zinc-900 dark:text-white">
                              {personConsumption.status === 'error' ? (
                                <span className="text-rose-600 text-[11px]">Indisponível</span>
                              ) : personConsumption.status === 'loading' ? (
                                <span className="text-zinc-400 text-[11px]">…</span>
                              ) : (
                                currency.format(personConsumption.totalInCents / 100)
                              )}
                            </span>
                          </div>

                          {personConsumption.status === 'loading' ? (
                            <p className="text-[11px] text-zinc-400 italic py-1">
                              Carregando itens…
                            </p>
                          ) : personConsumption.status === 'error' ? (
                            <div className="p-2.5 rounded-xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900/40 text-xs flex items-center justify-between gap-2">
                              <span className="text-rose-700 dark:text-rose-300 text-[11px] font-medium">
                                {personConsumption.error || 'Erro ao consultar consumo'}
                              </span>
                              <button
                                type="button"
                                onClick={() => void handleRetryTabConsumption(personTab.id)}
                                className="text-rose-800 dark:text-rose-200 font-bold underline text-[11px] cursor-pointer"
                              >
                                Tentar novamente
                              </button>
                            </div>
                          ) : personGrouped.length === 0 ? (
                            <p className="text-[11px] text-zinc-400 italic py-1">
                              Sem itens lançados para esta pessoa.
                            </p>
                          ) : (
                            <div className="space-y-2">
                              <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                                {paginatedPerson.displayedItems.map((group) => renderItemRow(group))}
                              </div>

                              {personGrouped.length > 2 && (
                                <div className="pt-1">
                                  {!isPersonExpanded ? (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setExpandedContaConjuntaLists((prev) => ({
                                          ...prev,
                                          [personTab.id]: true,
                                        }))
                                      }
                                      className="w-full py-2 px-3 rounded-xl border border-dashed border-[#4A1505]/30 hover:border-[#4A1505] bg-[#FAF4EE]/60 hover:bg-[#FAF4EE] dark:bg-zinc-800/40 dark:hover:bg-zinc-800 text-[#4A1505] dark:text-amber-300 font-bold text-xs transition flex items-center justify-center gap-1.5 cursor-pointer"
                                    >
                                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                        <polyline points="6 9 12 15 18 9" />
                                      </svg>
                                      <span>Ver mais (+{personGrouped.length - 2} itens)</span>
                                    </button>
                                  ) : (
                                    paginatedPerson.isPaginated && (
                                      <div className="flex flex-col sm:flex-row items-center justify-between gap-2 pt-1.5 border-t border-zinc-100 dark:border-zinc-800">
                                        <span className="text-[11px] text-zinc-500 font-medium">
                                          {paginatedPerson.rangeText}
                                        </span>
                                        <div className="flex items-center gap-1">
                                          <button
                                            type="button"
                                            disabled={!paginatedPerson.hasPreviousPage}
                                            onClick={() =>
                                              setPageContaConjuntaLists((prev) => ({
                                                ...prev,
                                                [personTab.id]: Math.max(1, (prev[personTab.id] || 1) - 1),
                                              }))
                                            }
                                            className="px-2 py-1 text-xs font-semibold rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                                          >
                                            Anterior
                                          </button>
                                          {paginatedPerson.pageNumbers.map((num) => (
                                            <button
                                              key={num}
                                              type="button"
                                              onClick={() =>
                                                setPageContaConjuntaLists((prev) => ({
                                                  ...prev,
                                                  [personTab.id]: num,
                                                }))
                                              }
                                              className={`w-7 h-7 text-xs font-bold rounded-lg transition-colors cursor-pointer ${
                                                num === paginatedPerson.currentPage
                                                  ? 'bg-[#4A1505] text-white shadow-xs'
                                                  : 'bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50'
                                              }`}
                                            >
                                              {num}
                                            </button>
                                          ))}
                                          <button
                                            type="button"
                                            disabled={!paginatedPerson.hasNextPage}
                                            onClick={() =>
                                              setPageContaConjuntaLists((prev) => ({
                                                ...prev,
                                                [personTab.id]: Math.min(paginatedPerson.totalPages, (prev[personTab.id] || 1) + 1),
                                              }))
                                            }
                                            className="px-2 py-1 text-xs font-semibold rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                                          >
                                            Próxima
                                          </button>
                                        </div>
                                      </div>
                                    )
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                </div>
              </div>
            ) : (
              <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {selectedTabConsumption.status === 'loading' ? (
                  <div className="p-4 rounded-2xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700 text-center space-y-1 my-2">
                    <div className="w-5 h-5 border-2 border-[#4A1505] border-t-transparent rounded-full animate-spin mx-auto" />
                    <p className="text-xs text-zinc-500">Consultando consumo no servidor…</p>
                  </div>
                ) : selectedTabConsumption.status === 'error' ? (
                  <div className="p-3.5 rounded-2xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900/40 text-center space-y-2 my-2">
                    <p className="text-xs font-semibold text-rose-700 dark:text-rose-300">
                      {selectedTabConsumption.error || 'Falha ao carregar o consumo desta comanda.'}
                    </p>
                    {selectedTabConsumption.isStale && (
                      <p className="text-[10px] text-amber-700 dark:text-amber-300">
                        Aviso: exibindo dados desatualizados em cache.
                      </p>
                    )}
                    <button
                      type="button"
                      onClick={() => selectedTabId && void handleRetryTabConsumption(selectedTabId)}
                      className="px-3.5 py-1.5 bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold rounded-xl transition cursor-pointer"
                    >
                      Tentar novamente
                    </button>
                  </div>
                ) : groupedActiveItems.length === 0 ? (
                  <p className="text-xs text-zinc-400 italic py-2">
                    Nenhum item lançado para esta comanda ainda. Clique no '+' acima para adicionar.
                  </p>
                ) : (
                  <div className="space-y-2">
                    <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                      {paginatedItemsResult.displayedItems.map((group) => renderItemRow(group))}
                    </div>

                    {/* Controles de "Ver mais" e Paginação numérica quando houver mais de 2 itens */}
                    {groupedActiveItems.length > 2 && (
                      <div className="pt-1">
                        {!isItemsExpanded ? (
                          <button
                            type="button"
                            onClick={() => setIsItemsExpanded(true)}
                            className="w-full py-2 px-3 rounded-xl border border-dashed border-[#4A1505]/30 hover:border-[#4A1505] bg-[#FAF4EE]/60 hover:bg-[#FAF4EE] dark:bg-zinc-800/40 dark:hover:bg-zinc-800 text-[#4A1505] dark:text-amber-300 font-bold text-xs transition flex items-center justify-center gap-1.5 cursor-pointer"
                          >
                            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <polyline points="6 9 12 15 18 9" />
                            </svg>
                            <span>Ver mais (+{groupedActiveItems.length - 2} itens)</span>
                          </button>
                        ) : (
                          <div className="space-y-2">
                            {/* Paginação se total > 5 */}
                            {paginatedItemsResult.isPaginated && (
                              <div className="flex flex-col sm:flex-row items-center justify-between gap-2 pt-1.5 border-t border-zinc-100 dark:border-zinc-800">
                                <span className="text-[11px] text-zinc-500 font-medium">
                                  {paginatedItemsResult.rangeText}
                                </span>
                                <div className="flex items-center gap-1">
                                  <button
                                    type="button"
                                    disabled={!paginatedItemsResult.hasPreviousPage}
                                    onClick={() => setItemsCurrentPage((p) => Math.max(1, p - 1))}
                                    className="px-2 py-1 text-xs font-semibold rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                                  >
                                    Anterior
                                  </button>
                                  {paginatedItemsResult.pageNumbers.map((num) => (
                                    <button
                                      key={num}
                                      type="button"
                                      onClick={() => setItemsCurrentPage(num)}
                                      className={`w-7 h-7 text-xs font-bold rounded-lg transition-colors cursor-pointer ${
                                        num === paginatedItemsResult.currentPage
                                          ? 'bg-[#4A1505] text-white shadow-xs'
                                          : 'bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50'
                                      }`}
                                    >
                                      {num}
                                    </button>
                                  ))}
                                  <button
                                    type="button"
                                    disabled={!paginatedItemsResult.hasNextPage}
                                    onClick={() => setItemsCurrentPage((p) => Math.min(paginatedItemsResult.totalPages, p + 1))}
                                    className="px-2 py-1 text-xs font-semibold rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                                  >
                                    Próxima
                                  </button>
                                </div>
                              </div>
                            )}

                            <div className="flex justify-end">
                              <button
                                type="button"
                                onClick={() => {
                                  setIsItemsExpanded(false);
                                  setItemsCurrentPage(1);
                                }}
                                className="text-[11px] font-semibold text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200 flex items-center gap-1 cursor-pointer py-1"
                              >
                                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <polyline points="18 15 12 9 6 15" />
                                </svg>
                                <span>Ver menos</span>
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Linha expansível para observações da pessoa */}
            <div className="pt-1">
              {isEditingObservation ? (
                <div className="p-2.5 rounded-2xl bg-[#FAF4EE] dark:bg-zinc-800/80 border border-amber-900/10 dark:border-zinc-700 space-y-2">
                  <textarea
                    autoFocus
                    rows={2}
                    value={observationInput}
                    onChange={(e) => setObservationInput(e.target.value)}
                    placeholder="Ex.: Carne ao ponto, sem cebola, gelo e limão à parte..."
                    className="w-full text-xs bg-transparent focus:outline-none text-zinc-800 dark:text-white placeholder:text-zinc-400 resize-none"
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setIsEditingObservation(false);
                        setObservationInput('');
                      }}
                      className="px-2.5 py-1 text-xs text-zinc-500 hover:text-zinc-700 cursor-pointer"
                    >
                      Cancelar
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (selectedTabId) {
                          setTabObservations((prev) => ({
                            ...prev,
                            [selectedTabId]: observationInput.trim(),
                          }));
                        }
                        setIsEditingObservation(false);
                      }}
                      className="px-3 py-1 bg-[#4A1505] text-white text-xs font-semibold rounded-xl cursor-pointer"
                    >
                      Salvar
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    if (selectedTabId) {
                      setObservationInput(tabObservations[selectedTabId] || '');
                    }
                    setIsEditingObservation(true);
                  }}
                  className="w-full bg-[#FAF4EE] dark:bg-zinc-800/80 hover:bg-[#F5ECE1] rounded-xl p-2.5 flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300 transition cursor-pointer"
                >
                  <svg className="w-4 h-4 text-amber-900/70 dark:text-amber-300 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="16" y1="13" x2="8" y2="13" />
                    <line x1="16" y1="17" x2="8" y2="17" />
                    <polyline points="10 9 9 9 8 9" />
                  </svg>
                  <span className="truncate">
                    {selectedTabId && tabObservations[selectedTabId]
                      ? `Obs: ${tabObservations[selectedTabId]}`
                      : 'Adicionar observação para esta pessoa'}
                  </span>
                </button>
              )}
            </div>
          </div>

          {/* D. Bloco Financeiro e Fechamento */}
          <div className="space-y-2 pt-1">
            {effectiveIncomplete && (
              <div className="rounded-2xl bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800 p-2.5 text-xs text-amber-800 dark:text-amber-200 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <svg className="w-4 h-4 text-amber-600 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  <span className="text-[11px] font-medium leading-tight">
                    {isSharedTabSelected
                      ? 'Atenção: Os totais abaixo são parciais pois há comanda(s) com consumo pendente ou erro de consulta.'
                      : 'Atenção: O consumo desta comanda está pendente ou com erro de consulta.'}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (isSharedTabSelected) {
                      setRefresh((r) => r + 1);
                    } else if (selectedTabId) {
                      void handleRetryTabConsumption(selectedTabId);
                    }
                  }}
                  className="font-bold underline text-amber-900 dark:text-amber-100 hover:text-black shrink-0 cursor-pointer text-[11px]"
                >
                  Recarregar
                </button>
              </div>
            )}

            <div className="grid grid-cols-3 gap-2 p-3 rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200/60 dark:border-zinc-800 shadow-xs">
              <div>
                <span className="text-[10px] text-zinc-400 font-medium block">Subtotal</span>
                <span className="text-xs font-bold text-zinc-900 dark:text-white mt-0.5 block">
                  {effectiveIncomplete ? `${currency.format(effectiveSubtotal / 100)} (parcial)` : currency.format(effectiveSubtotal / 100)}
                </span>
              </div>

              <div>
                <span className="text-[10px] text-zinc-400 font-medium block">
                  Taxa de serviço ({restaurantFeePercent}%)
                </span>
                <span className="text-xs font-bold text-zinc-900 dark:text-white mt-0.5 block">
                  {currency.format(effectiveFee / 100)}
                </span>
              </div>

              <div>
                <span className="text-[10px] text-[#782006] dark:text-amber-300 font-medium block">
                  {isSharedTabSelected ? 'Total da mesa' : 'Total da pessoa'}
                </span>
                <span className="text-sm font-extrabold text-[#782006] dark:text-amber-400 mt-0.5 block">
                  {effectiveIncomplete ? `${currency.format(effectiveTotal / 100)}*` : currency.format(effectiveTotal / 100)}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={handleOpenTransferTableModal}
                className="p-2.5 rounded-2xl border border-amber-900/10 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-xs flex items-center justify-center gap-1.5 text-[11px] font-semibold text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition cursor-pointer"
              >
                <svg className="w-3.5 h-3.5 text-[#782006] dark:text-amber-300 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 3v12" />
                  <path d="m8 7 4-4 4 4" />
                  <path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
                </svg>
                <span className="truncate">Transferir item</span>
              </button>

              <button
                type="button"
                onClick={handleOpenMovePersonModal}
                className="p-2.5 rounded-2xl border border-amber-900/10 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-xs flex items-center justify-center gap-1.5 text-[11px] font-semibold text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition cursor-pointer"
              >
                <svg className="w-3.5 h-3.5 text-[#782006] dark:text-amber-300 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M16 3h5v5" />
                  <path d="M4 20 21 3" />
                  <path d="M21 16v5h-5" />
                  <path d="m15 15 6 6" />
                  <path d="M4 4l5 5" />
                </svg>
                <span className="truncate">Mover para outra pessoa</span>
              </button>

              <button
                type="button"
                onClick={handlePrintReceipt}
                disabled={effectiveIncomplete}
                title={effectiveIncomplete ? 'Pré-conta indisponível enquanto houver comanda com consumo incompleto' : 'Imprimir pré-conta'}
                className="p-2.5 rounded-2xl border border-amber-900/10 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-xs flex items-center justify-center gap-1.5 text-[11px] font-semibold text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <svg className="w-3.5 h-3.5 text-[#782006] dark:text-amber-300 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M6 9V2h12v7" />
                  <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                  <path d="M6 14h12v8H6z" />
                </svg>
                <span className="truncate">Imprimir pré-conta</span>
              </button>
            </div>

            {/* Ação Visível: Dividir conta e Fechar comanda individual no respectivo contexto (Tela 4) */}
            <div className="grid grid-cols-2 gap-2 mt-2">
              <button
                type="button"
                onClick={() => setIsSplitBillModalOpen(true)}
                className="py-3 px-2 sm:px-3 rounded-2xl border border-amber-300 dark:border-amber-800/80 bg-amber-50/90 dark:bg-amber-950/40 hover:bg-amber-100 dark:hover:bg-amber-900/60 text-[#782006] dark:text-amber-300 font-bold text-xs flex items-center justify-center gap-1.5 shadow-xs transition cursor-pointer text-center"
                title="Simular divisão estimada da conta"
              >
                <svg className="w-4 h-4 text-[#782006] dark:text-amber-300 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
                <span className="truncate">Dividir conta</span>
              </button>

              {selectedTab && selectedTab.status === 'open' && (
                <button
                  type="button"
                  disabled={
                    disabled ||
                    busy ||
                    (selectedTabId ? tabConsumptions[selectedTabId]?.status === 'loading' : false)
                  }
                  onClick={() => {
                    if (selectedTabId) {
                      void handleDeleteOrCloseTab(selectedTabId);
                    }
                  }}
                  className="py-3 px-2 sm:px-3 rounded-2xl border border-rose-300 dark:border-rose-900/60 bg-rose-50/90 dark:bg-rose-950/40 hover:bg-rose-100 dark:hover:bg-rose-950/60 text-rose-700 dark:text-rose-300 font-bold text-xs flex items-center justify-center gap-1.5 shadow-xs transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed text-center"
                  title={isSharedTabSelected ? 'Fechar conta conjunta' : `Fechar comanda de ${selectedTab.label || 'cliente'}`}
                >
                  <svg className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  <span className="truncate">
                    {isSharedTabSelected
                      ? 'Fechar conta conjunta'
                      : `Fechar comanda de ${selectedTab.label || 'cliente'}`}
                  </span>
                </button>
              )}
            </div>

            <button
              type="button"
              onClick={handleFinalizeAndSendToKitchen}
              disabled={disabled || activeItems.length === 0 || selectedTabConsumption.status === 'error'}
              className="bg-[#4A1505] hover:bg-[#381004] text-white font-bold py-3.5 rounded-2xl w-full shadow-md flex items-center justify-center gap-2 mt-3 active:scale-95 transition cursor-pointer disabled:opacity-50"
            >
              <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
                <polyline points="10 9 9 9 8 9" />
              </svg>
              <span>Finalizar e enviar para a cozinha</span>
            </button>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL: SIMULAÇÃO DE DIVISÃO DE CONTA (ESTIMATIVA VISUAL ENTRE PESSOAS)   */}
      {/* ========================================================================= */}
      {isSplitBillModalOpen && (() => {
        const totalToSplitInCents = effectiveTotal;
        const activePeopleCount = parseSplitPeopleCount(splitPeopleInput);
        const splitResult = calculateSplitBill(totalToSplitInCents, activePeopleCount);

        return (
          <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
            <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-3xl p-5 max-w-sm w-full shadow-2xl space-y-4">
              {/* Cabeçalho */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-xl bg-amber-50 dark:bg-amber-950/40 text-[#782006] dark:text-amber-400 flex items-center justify-center shrink-0">
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                      <circle cx="9" cy="7" r="4" />
                      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="font-bold text-sm text-zinc-900 dark:text-white leading-tight">
                      Dividir conta
                    </h3>
                    <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                      Simulação visual para os clientes
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setIsSplitBillModalOpen(false)}
                  className="w-7 h-7 rounded-full bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-500 dark:text-zinc-300 flex items-center justify-center text-xs transition cursor-pointer"
                  aria-label="Fechar"
                >
                  ✕
                </button>
              </div>

              {/* Total Atual */}
              <div className="bg-[#FAF6F0] dark:bg-zinc-800/70 rounded-2xl p-3 border border-amber-900/10 dark:border-zinc-800 flex items-center justify-between">
                <div>
                  <span className="text-[10px] font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider block">
                    {isSharedTabSelected ? 'Total da conta conjunta' : `Total da comanda (${selectedTab?.label || 'cliente'})`}
                  </span>
                  <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
                    Subtotal + serviço ({restaurantFeePercent}%)
                  </span>
                </div>
                <span className="text-base font-black text-[#782006] dark:text-amber-400 tabular-nums">
                  {currency.format(totalToSplitInCents / 100)}
                </span>
              </div>

              {/* Seletor de Quantidade de Pessoas (com botões − / + e campo editável) */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label htmlFor="split-people-input" className="text-[11px] font-bold text-zinc-700 dark:text-zinc-300">
                    Quantidade de pessoas
                  </label>
                  <span className="text-[10px] text-zinc-400 dark:text-zinc-500">
                    A partir de 2 pessoas
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  {/* Botão − */}
                  <button
                    type="button"
                    disabled={activePeopleCount <= 2}
                    onClick={() => {
                      const next = Math.max(2, activePeopleCount - 1);
                      setSplitPeopleInput(String(next));
                    }}
                    className="w-11 h-11 rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed font-extrabold text-lg flex items-center justify-center transition shadow-xs cursor-pointer select-none"
                    aria-label="Diminuir uma pessoa"
                  >
                    −
                  </button>

                  {/* Campo numérico editável */}
                  <div className="flex-1 relative">
                    <input
                      id="split-people-input"
                      type="number"
                      min="2"
                      step="1"
                      value={splitPeopleInput}
                      onChange={(e) => setSplitPeopleInput(e.target.value)}
                      onBlur={() => {
                        setSplitPeopleInput(String(parseSplitPeopleCount(splitPeopleInput)));
                      }}
                      className="w-full h-11 px-3 text-center text-base font-extrabold text-zinc-900 dark:text-white bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-2xl focus:outline-hidden focus:ring-2 focus:ring-[#782006] dark:focus:ring-amber-400 tabular-nums shadow-xs"
                      aria-label="Número de pessoas para divisão da conta"
                    />
                  </div>

                  {/* Botão + */}
                  <button
                    type="button"
                    onClick={() => {
                      const next = activePeopleCount + 1;
                      setSplitPeopleInput(String(next));
                    }}
                    className="w-11 h-11 rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-700 font-extrabold text-lg flex items-center justify-center transition shadow-xs cursor-pointer select-none"
                    aria-label="Adicionar uma pessoa"
                  >
                    +
                  </button>
                </div>
              </div>

              {/* Resultado da Estimativa */}
              <div className="bg-amber-50/60 dark:bg-amber-950/20 border border-amber-200/80 dark:border-amber-900/40 rounded-2xl p-3.5 space-y-2.5">
                <div className="text-center pb-2 border-b border-amber-200/60 dark:border-amber-900/40">
                  <span className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400 block">
                    Valor estimado por pessoa ({activePeopleCount} {activePeopleCount === 1 ? 'pessoa' : 'pessoas'})
                  </span>
                  <div className="text-xl font-black text-[#782006] dark:text-amber-300 mt-0.5 tabular-nums">
                    {splitResult.hasRemainder ? (
                      <span>
                        {currency.format(splitResult.baseAmountInCents / 100)}
                        {' a '}
                        {currency.format((splitResult.baseAmountInCents + 1) / 100)}
                      </span>
                    ) : (
                      <span>
                        {currency.format(splitResult.baseAmountInCents / 100)}
                      </span>
                    )}
                  </div>
                  <span className="text-[10px] text-zinc-500 dark:text-zinc-400 mt-0.5 block">
                    {splitResult.summaryMessage}
                  </span>
                </div>

                {/* Demonstrativo individual (até 10 pessoas) ou consolidado compacto (> 10 pessoas) */}
                {!splitResult.isCompact ? (
                  <div className="space-y-1.5 pt-0.5">
                    <span className="text-[10px] font-bold text-zinc-600 dark:text-zinc-400 uppercase tracking-wider block">
                      Demonstrativo por pessoa ({splitResult.shares.length})
                    </span>
                    <div className="max-h-52 overflow-y-auto space-y-1 pr-0.5">
                      {splitResult.shares.map((share) => (
                        <div
                          key={share.personIndex}
                          className="flex items-center justify-between text-xs py-1 px-2.5 rounded-lg bg-white/80 dark:bg-zinc-800/80 border border-amber-900/5 dark:border-zinc-700/50"
                        >
                          <span className="font-medium text-zinc-700 dark:text-zinc-300">
                            {share.label}
                          </span>
                          <span className="font-bold text-zinc-900 dark:text-white tabular-nums">
                            {currency.format(share.amountInCents / 100)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1.5 pt-0.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold text-zinc-600 dark:text-zinc-400 uppercase tracking-wider block">
                        Demonstrativo consolidado ({activePeopleCount} pessoas)
                      </span>
                      <span className="text-[10px] bg-amber-200/60 dark:bg-amber-900/40 text-amber-900 dark:text-amber-200 px-1.5 py-0.5 rounded-md font-semibold">
                        Visão compacta
                      </span>
                    </div>

                    <div className="space-y-1.5">
                      {splitResult.compactGroups.map((grp, idx) => (
                        <div
                          key={idx}
                          className="flex items-center justify-between text-xs py-1.5 px-2.5 rounded-lg bg-white/80 dark:bg-zinc-800/80 border border-amber-900/5 dark:border-zinc-700/50"
                        >
                          <div>
                            <span className="font-bold text-zinc-800 dark:text-zinc-200">
                              {grp.label}
                            </span>
                            <span className="text-[10px] text-zinc-400 dark:text-zinc-500 block">
                              pagam cada uma:
                            </span>
                          </div>
                          <div className="text-right">
                            <span className="font-black text-[#782006] dark:text-amber-300 tabular-nums text-sm">
                              {currency.format(grp.amountInCents / 100)}
                            </span>
                            <span className="text-[10px] text-zinc-400 dark:text-zinc-500 block tabular-nums">
                              Subtotal: {currency.format(grp.totalGroupInCents / 100)}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Aviso explícito de estimativa (Exigência do Requisito) */}
              <div className="p-2.5 rounded-xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-800 text-[11px] text-zinc-600 dark:text-zinc-400 leading-relaxed flex items-start gap-2">
                <svg className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <span>
                  <strong>Estimativa para divisão entre pessoas:</strong> Este cálculo é apenas uma simulação visual. Não altera valores, não registra pagamentos e não fecha a comanda. O acerto é realizado diretamente entre os clientes.
                </span>
              </div>

              {/* Botão de Fechar */}
              <button
                type="button"
                onClick={() => setIsSplitBillModalOpen(false)}
                className="w-full py-2.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 dark:bg-zinc-100 dark:hover:bg-white text-white dark:text-zinc-900 font-bold text-xs shadow-xs transition cursor-pointer"
              >
                Concluir consulta
              </button>
            </div>
          </div>
        );
      })()}

      {/* Modal global de confirmação de encerramento de comanda com consumo */}
      {closingTabId && (() => {
        const tabToClose = state.tabs.find((t) => t.id === closingTabId);
        if (!tabToClose) return null;
        const closeConsumption = tabConsumptions[closingTabId];
        const isConsumptionBlocked =
          !closeConsumption ||
          closeConsumption.status === 'loading' ||
          closeConsumption.status === 'error' ||
          Boolean(closeConsumption.isStale);

        const subtotalInCents = closeConsumption?.totalInCents ?? 0;
        const preview = calculateTabClosurePreview(
          subtotalInCents,
          restaurantFeePercent,
          closingFeeAccepted,
        );
        const hasFeeConfigured = restaurantFeePercent > 0;
        const baseFeeInCents = calculateTabClosureFee(subtotalInCents, restaurantFeePercent);

        return (
          <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
            <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-3xl p-5 max-w-sm w-full shadow-2xl space-y-4">
              <div>
                <h3 className="font-bold text-sm text-zinc-900 dark:text-white">
                  Encerrar comanda “{tabToClose.label}”?
                </h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
                  Confira os valores e a opção de taxa de serviço antes de finalizar a comanda para pagamento.
                </p>
              </div>

              {closeConsumption?.status === 'loading' && (
                <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-200 text-xs">
                  Aguarde: verificando consumo da comanda...
                </div>
              )}

              {closeConsumption?.status === 'error' && (
                <div className="p-3 rounded-xl bg-rose-50 dark:bg-rose-950/30 text-rose-800 dark:text-rose-200 text-xs space-y-2">
                  <p>Falha ao verificar consumo da comanda.</p>
                  <button
                    type="button"
                    onClick={() => void handleRetryTabConsumption(closingTabId)}
                    className="text-xs font-semibold underline cursor-pointer"
                  >
                    Tentar novamente
                  </button>
                </div>
              )}

              {closeConsumption?.isStale && (
                <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-200 text-xs space-y-2">
                  <p>O consumo desta comanda está desatualizado.</p>
                  <button
                    type="button"
                    onClick={() => void handleRetryTabConsumption(closingTabId)}
                    className="text-xs font-semibold underline cursor-pointer"
                  >
                    Atualizar consumo
                  </button>
                </div>
              )}

              {closeConsumption?.status === 'loaded' && !closeConsumption.isStale && (
                <div className="p-3.5 rounded-2xl bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-200/80 dark:border-zinc-700/60 space-y-2 text-xs">
                  <div className="flex justify-between items-center text-zinc-600 dark:text-zinc-300">
                    <span>Subtotal dos itens</span>
                    <span className="font-semibold text-zinc-900 dark:text-white">
                      {currency.format(preview.subtotalInCents / 100)}
                    </span>
                  </div>

                  {hasFeeConfigured && (
                    <div className="space-y-1.5 pt-1.5 border-t border-zinc-200/50 dark:border-zinc-700/50">
                      <div className="flex items-center justify-between">
                        <label className="flex items-center gap-2 cursor-pointer select-none text-zinc-700 dark:text-zinc-200">
                          <input
                            type="checkbox"
                            checked={closingFeeAccepted}
                            onChange={(e) => setClosingFeeAccepted(e.target.checked)}
                            disabled={busy}
                            className="w-4 h-4 rounded text-amber-800 focus:ring-amber-800 dark:bg-zinc-700 dark:border-zinc-600 cursor-pointer"
                          />
                          <span className="font-medium">
                            Taxa de serviço ({restaurantFeePercent}%)
                          </span>
                        </label>
                        <span
                          className={`font-semibold ${
                            closingFeeAccepted
                              ? 'text-zinc-900 dark:text-white'
                              : 'text-zinc-400 line-through'
                          }`}
                        >
                          {currency.format(baseFeeInCents / 100)}
                        </span>
                      </div>
                      <p className="text-[11px] text-zinc-500 dark:text-zinc-400 pl-6">
                        {closingFeeAccepted
                          ? 'Taxa opcional incluída no total.'
                          : 'Taxa opcional retirada por solicitação do cliente.'}
                      </p>
                    </div>
                  )}

                  <div className="flex justify-between items-center pt-2 border-t border-zinc-200/80 dark:border-zinc-700/60 font-bold text-sm">
                    <span className="text-zinc-900 dark:text-white">Total para pagamento</span>
                    <span className="text-[#782006] dark:text-amber-400 text-base">
                      {currency.format(preview.totalInCents / 100)}
                    </span>
                  </div>
                </div>
              )}

              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy || isConsumptionBlocked}
                  onClick={() => void handleCloseTab(closingTabId)}
                  className="flex-1 py-2.5 rounded-xl bg-amber-800 hover:bg-amber-900 text-white font-semibold text-xs transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {busy ? 'Encerrando…' : 'Confirmar encerramento'}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setClosingTabId(null)}
                  className="px-4 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 font-medium text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 transition cursor-pointer"
                >
                  Cancelar
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Modal global de vínculo de cliente celular */}
      {linkingGuestTabId && (() => {
        const targetTab = state.tabs.find((t) => t.id === linkingGuestTabId);
        if (!targetTab) return null;
        const currentLink = state.links.find((l) => l.table_tab_id === targetTab.id);

        return (
          <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
            <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-3xl p-5 max-w-sm w-full shadow-2xl space-y-4">
              <div>
                <h3 className="font-bold text-sm text-zinc-900 dark:text-white">
                  Vincular celular à comanda “{targetTab.label}”
                </h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
                  Selecione o cliente confirmado na mesa para associar seus pedidos a esta comanda.
                </p>
              </div>

              {activeGuests.length === 0 ? (
                <p className="text-xs text-zinc-400 italic py-2">
                  Nenhum cliente confirmado na mesa no momento. Confirme o código de 6 dígitos na aba "Acesso da mesa".
                </p>
              ) : (
                <select
                  value={selectedGuestId}
                  onChange={(e) => setSelectedGuestId(e.target.value)}
                  className="w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-xs text-zinc-900 dark:text-white"
                >
                  <option value="">Selecione um cliente confirmado</option>
                  {activeGuests.map((g, idx) => {
                    const link = state.links.find((l) => l.guest_session_id === g.id);
                    const otherTab = link ? state.tabs.find((t) => t.id === link.table_tab_id)?.label : null;
                    return (
                      <option key={g.id} value={g.id}>
                        Cliente #{idx + 1} {otherTab ? `(Vinculado a ${otherTab})` : '(Livre)'}
                      </option>
                    );
                  })}
                </select>
              )}

              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy || !selectedGuestId}
                  onClick={async () => {
                    await perform(
                      async () => {
                        await linkGuestToTableTab(restaurantSlug, targetTab.id, selectedGuestId);
                        try {
                          await supabase
                            .from('table_tabs')
                            .update({ guest_session_id: selectedGuestId })
                            .eq('id', targetTab.id);
                        } catch {}
                      },
                      'Cliente vinculado à comanda com sucesso!',
                      () => {
                        setSelectedGuestId('');
                        setLinkingGuestTabId(null);
                      },
                    );
                  }}
                  className="flex-1 py-2.5 rounded-xl bg-[#4A1505] text-white font-semibold text-xs disabled:opacity-50 cursor-pointer"
                >
                  Confirmar vínculo
                </button>
                {currentLink && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={async () => {
                      await perform(
                        async () => {
                          await supabase.from('table_tab_guests').delete().eq('table_tab_id', targetTab.id);
                          try {
                            await supabase.from('table_tabs').update({ guest_session_id: null }).eq('id', targetTab.id);
                          } catch {}
                        },
                        'Vínculo de celular removido.',
                        () => {
                          setLinkingGuestTabId(null);
                        },
                      );
                    }}
                    className="px-3 py-2.5 rounded-xl border border-rose-200 dark:border-rose-900 text-rose-600 dark:text-rose-400 text-xs font-medium cursor-pointer hover:bg-rose-50"
                  >
                    Desvincular
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setLinkingGuestTabId(null);
                    setSelectedGuestId('');
                  }}
                  className="px-4 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 font-medium text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 transition cursor-pointer"
                >
                  Cancelar
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Modal Mover item para outra pessoa */}
      {isMovePersonModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-3xl p-5 max-w-sm w-full shadow-2xl space-y-4">
            <div>
              <h3 className="font-bold text-sm text-zinc-900 dark:text-white">
                Mover item para outra pessoa
              </h3>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
                Selecione o item e a pessoa/comanda da mesa para onde deseja transferi-lo.
              </p>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-[11px] font-semibold text-zinc-600 dark:text-zinc-300 mb-1">
                  Item a mover
                </label>
                <select
                  value={moveItemId}
                  onChange={(e) => {
                    const id = e.target.value;
                    setMoveItemId(id);
                    const itemTab = findItemAndTab(id)?.tabId;
                    const availableTargets = state.tabs.filter((t) => t.status === 'open' && t.id !== itemTab);
                    if (!availableTargets.some((t) => t.id === moveTargetTabId)) {
                      setMoveTargetTabId('');
                    }
                  }}
                  className="w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-xs text-zinc-900 dark:text-white"
                >
                  {movableItems.map((item) => {
                    const tabName = state.tabs.find((t) => t.id === item.table_tab_id)?.label || 'Comanda';
                    return (
                      <option key={item.id} value={item.id}>
                        {item.quantity}x {item.product_name} ({currency.format((item.line_total_in_cents || 0) / 100)}) — de {tabName}
                      </option>
                    );
                  })}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-zinc-600 dark:text-zinc-300 mb-1">
                  Pessoa / Comanda de destino <span className="text-rose-500">*</span>
                </label>
                {movableTargetTabs.length === 0 ? (
                  <p className="text-xs text-zinc-400 italic py-1">
                    Nenhuma outra pessoa aberta nesta mesa.
                  </p>
                ) : (
                  <select
                    value={moveTargetTabId}
                    onChange={(e) => setMoveTargetTabId(e.target.value)}
                    className="w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-xs text-zinc-900 dark:text-white cursor-pointer"
                  >
                    <option value="">Selecione a pessoa/comanda de destino...</option>
                    {movableTargetTabs.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label.toLowerCase().includes('conjunt') || t.label.toLowerCase().includes('compartilh')
                          ? 'Conta conjunta (Mesa toda)'
                          : t.label}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-zinc-600 dark:text-zinc-300 mb-1">
                  Motivo da movimentação (auditoria) <span className="text-rose-500">*</span>
                </label>
                <textarea
                  rows={2}
                  value={moveReason}
                  onChange={(e) => {
                    setMoveReason(e.target.value);
                    setMoveReasonError('');
                  }}
                  placeholder="Ex.: Solicitado pelo cliente, reorganização de pedidos..."
                  className="w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-xs text-zinc-900 dark:text-white placeholder:text-zinc-400 focus:border-[#4A1505] focus:outline-none resize-none"
                />
                {moveReasonError && (
                  <p className="text-[11px] text-rose-500 font-medium mt-1">{moveReasonError}</p>
                )}
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                type="button"
                disabled={busy || !moveItemId || !moveTargetTabId || movableTargetTabs.length === 0 || moveReason.trim().length < 3}
                onClick={handleConfirmMovePerson}
                className="flex-1 py-2.5 rounded-xl bg-[#4A1505] text-white font-semibold text-xs disabled:opacity-50 cursor-pointer hover:bg-[#381004] transition"
              >
                Mover item
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsMovePersonModalOpen(false);
                  setMoveItemId('');
                  setMoveTargetTabId('');
                  setMoveReason('');
                  setMoveReasonError('');
                }}
                className="px-4 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 font-medium text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 transition cursor-pointer"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Transferir item para outra mesa */}
      {isTransferTableModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-3xl p-5 max-w-sm w-full shadow-2xl space-y-4">
            <div>
              <h3 className="font-bold text-sm text-zinc-900 dark:text-white">
                Transferir item para outra mesa
              </h3>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
                Selecione o item e a mesa de destino com atendimento ativo.
              </p>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-[11px] font-semibold text-zinc-600 dark:text-zinc-300 mb-1">
                  Item a transferir
                </label>
                <select
                  value={transferItemId}
                  onChange={(e) => setTransferItemId(e.target.value)}
                  className="w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-xs text-zinc-900 dark:text-white"
                >
                  {movableItems.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.quantity}x {item.product_name} ({currency.format((item.line_total_in_cents || 0) / 100)})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-zinc-600 dark:text-zinc-300 mb-1">
                  Mesa de destino (ocupada)
                </label>
                {loadingOccupiedTables ? (
                  <p className="text-xs text-zinc-400 py-2">Carregando mesas ocupadas...</p>
                ) : occupiedTables.length === 0 ? (
                  <p className="text-xs text-zinc-400 italic py-2">
                    Não há outras mesas com atendimento ativo no momento.
                  </p>
                ) : (
                  <select
                    value={transferTargetTableId}
                    onChange={(e) => {
                      const newTableId = e.target.value;
                      setTransferTargetTableId(newTableId);
                      void loadTransferTableTargetTabs(newTableId);
                    }}
                    className="w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-xs text-zinc-900 dark:text-white cursor-pointer"
                  >
                    <option value="">Selecione a mesa de destino...</option>
                    {occupiedTables.map((t) => (
                      <option key={t.id} value={t.id}>
                        Mesa {t.table_number}{t.label ? ` (${t.label})` : ''}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-zinc-600 dark:text-zinc-300 mb-1">
                  Comanda de destino (seleção explícita) <span className="text-rose-500">*</span>
                </label>
                {loadingTargetTabs ? (
                  <p className="text-xs text-zinc-400 py-1.5">Carregando comandas da mesa...</p>
                ) : !transferTargetTableId ? (
                  <p className="text-xs text-zinc-400 italic py-1">
                    Selecione a mesa de destino para listar as comandas abertas.
                  </p>
                ) : transferTableTargetTabs.length === 0 ? (
                  <p className="text-xs text-rose-500 italic py-1">
                    A mesa selecionada não possui comanda aberta para receber o item.
                  </p>
                ) : (
                  <select
                    value={transferTableTargetTabId}
                    onChange={(e) => {
                      setTransferTableTargetTabId(e.target.value);
                      setTransferReasonError('');
                    }}
                    className="w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-xs text-zinc-900 dark:text-white cursor-pointer"
                  >
                    <option value="">Selecione a comanda de destino...</option>
                    {transferTableTargetTabs.map((tab) => (
                      <option key={tab.id} value={tab.id}>
                        {tab.label}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div>
                <div className="flex justify-between items-center mb-1">
                  <label className="block text-[11px] font-semibold text-zinc-600 dark:text-zinc-300">
                    Motivo da transferência (auditoria) <span className="text-rose-500">*</span>
                  </label>
                  <span className="text-[10px] text-zinc-400">
                    {transferReason.trim().length}/300
                  </span>
                </div>
                <textarea
                  rows={2}
                  value={transferReason}
                  onChange={(e) => {
                    setTransferReason(e.target.value);
                    setTransferReasonError('');
                  }}
                  placeholder="Ex.: Mudança de mesa do cliente, reagrupamento..."
                  className="w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-xs text-zinc-900 dark:text-white placeholder:text-zinc-400 focus:border-[#4A1505] focus:outline-none resize-none"
                />
                {transferReasonError && (
                  <p className="text-[11px] text-rose-500 font-medium mt-1">{transferReasonError}</p>
                )}
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                type="button"
                disabled={busy || !transferItemId || !transferTargetTableId || !transferTableTargetTabId || occupiedTables.length === 0 || transferReason.trim().length < 3}
                onClick={handleConfirmTransferTable}
                className="flex-1 py-2.5 rounded-xl bg-[#4A1505] text-white font-semibold text-xs disabled:opacity-50 cursor-pointer hover:bg-[#381004] transition"
              >
                Transferir item
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsTransferTableModalOpen(false);
                  setTransferItemId('');
                  setTransferTargetTableId('');
                  setTransferTableTargetTabs([]);
                  setTransferTableTargetTabId('');
                  setTransferReason('');
                  setTransferReasonError('');
                }}
                className="px-4 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 font-medium text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 transition cursor-pointer"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de Cancelamento de Produto com Motivo Obrigatório para Auditoria */}
      {cancellingItem && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-3xl p-5 max-w-sm w-full shadow-2xl space-y-4">
            <div>
              <h3 className="font-bold text-sm text-zinc-900 dark:text-white flex items-center gap-2">
                <svg className="w-4 h-4 text-rose-600 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 6h18" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                  <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
                Cancelar item da comanda
              </h3>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
                Confirme os dados do item e informe o motivo do cancelamento para fins de auditoria.
              </p>
            </div>

            {/* Confirmação clara: produto, quantidade e valor */}
            <div className="p-3.5 rounded-2xl bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-200/80 dark:border-zinc-700/60 space-y-1 text-xs">
              <div className="flex justify-between items-center text-zinc-900 dark:text-white font-bold">
                <span className="text-xs">{cancellingItem.quantity}x {cancellingItem.productName}</span>
                {cancellingItem.lineTotalInCents > 0 && (
                  <span className="font-semibold text-rose-700 dark:text-rose-400">
                    {currency.format(cancellingItem.lineTotalInCents / 100)}
                  </span>
                )}
              </div>
              {cancellingItem.unitPriceInCents > 0 && cancellingItem.quantity > 1 && (
                <p className="text-[11px] text-zinc-500">
                  {currency.format(cancellingItem.unitPriceInCents / 100)} cada
                </p>
              )}
            </div>

            {/* Descrição do motivo */}
            <div className="space-y-1">
              <label className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                Motivo do cancelamento <span className="text-rose-500">*</span>
              </label>
              <textarea
                autoFocus
                rows={3}
                value={cancellationReason}
                onChange={(e) => {
                  setCancellationReason(e.target.value);
                  setCancellationModalError('');
                }}
                placeholder="Ex.: Cliente desistiu, lançado por engano, produto esgotado..."
                className="w-full text-xs p-2.5 rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-white placeholder:text-zinc-400 focus:border-[#4A1505] focus:outline-none resize-none"
              />
              <div className="flex justify-between text-[11px] text-zinc-400">
                <span>Mínimo 3 caracteres</span>
                <span>{cancellationReason.trim().length}/300</span>
              </div>
            </div>

            {cancellationModalError && (
              <div className="p-2.5 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/40 text-xs text-rose-700 dark:text-rose-300">
                {cancellationModalError}
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <button
                type="button"
                disabled={cancellationSubmitting}
                onClick={() => {
                  setCancellingItem(null);
                  setCancellationReason('');
                  setCancellationModalError('');
                }}
                className="flex-1 py-2.5 rounded-xl border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 font-semibold text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 transition cursor-pointer"
              >
                Voltar
              </button>

              <button
                type="button"
                disabled={cancellationSubmitting || cancellationReason.trim().length < 3}
                onClick={() => void handleConfirmCancellation()}
                className="flex-1 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white font-bold text-xs transition cursor-pointer flex items-center justify-center gap-1.5"
              >
                {cancellationSubmitting ? (
                  <>
                    <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    <span>Cancelando...</span>
                  </>
                ) : (
                  <span>Confirmar</span>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

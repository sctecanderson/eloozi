import { useEffect, useRef, useState, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import {
  closeTableTab,
  createTableTab,
  getTableTabsState,
  linkGuestToTableTab,
} from './tableTabs';
import type { TableTab, TableTabsState } from './tableTabs';
import { addTabConsumption, cancelTabConsumption, getTabConsumption } from './tabConsumption';
import type { TabConsumptionItem } from './tabConsumption';
import { useRestaurant } from '../restaurants/RestaurantProvider';
import { printTableBillThermal } from '../../components/ThermalReceiptPrint';

interface TableTabsPanelProps {
  restaurantSlug: string;
  restaurantId: string;
  tableVisitId: string;
  tableNumber?: number | string;
  onOpenTabsCountChange?: (count: number) => void;
  showSuccessToast?: boolean;
  onCloseSuccessToast?: () => void;
  onNavigateToCatalog?: (tabId?: string) => void;
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

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

// Fallback realista caso o restaurante não possua cardápio cadastrado no banco ainda
const DEFAULT_FALLBACK_PRODUCTS: MenuProductItem[] = [
  {
    id: 'sample-caipirinha',
    category_id: 'sample-cat-bebidas',
    name: 'Caipirinha de limão',
    short_description: 'Cachaça, limão e açúcar',
    description: 'Tradicional caipirinha brasileira feita com cachaça artesanal e limão tahiti.',
    price_in_cents: 3600,
    available: true,
    images: [{ url: 'https://images.unsplash.com/photo-1551024709-8f23befc6f87?auto=format&fit=crop&w=300&q=80' }],
    sort_order: 1,
  },
  {
    id: 'sample-picanha',
    category_id: 'sample-cat-pratos',
    name: 'Picanha 300g',
    short_description: 'Ponto médio',
    description: 'Corte nobre grelhado na brasa, acompanhado de farofa crocante e vinagrete da casa.',
    price_in_cents: 8900,
    available: true,
    images: [{ url: 'https://images.unsplash.com/photo-1544025162-d76694265947?auto=format&fit=crop&w=300&q=80' }],
    sort_order: 2,
  },
  {
    id: 'sample-agua',
    category_id: 'sample-cat-bebidas',
    name: 'Água com gás',
    short_description: 'Água mineral 500ml',
    description: 'Garrafa de água mineral com gás 500ml servida gelada.',
    price_in_cents: 800,
    available: true,
    images: [{ url: 'https://images.unsplash.com/photo-1548839140-29a749e1bc4e?auto=format&fit=crop&w=300&q=80' }],
    sort_order: 3,
  },
  {
    id: 'sample-bruschetta',
    category_id: 'sample-cat-entradas',
    name: 'Bruschetta Italiana',
    short_description: 'Tomates marinados, manjericão e azeite',
    description: 'Fatias de pão rústico tostadas com azeite extravirgem, tomate fresco e manjericão.',
    price_in_cents: 3200,
    available: true,
    images: [{ url: 'https://images.unsplash.com/photo-1572695157366-5e585ab2b69f?auto=format&fit=crop&w=300&q=80' }],
    sort_order: 4,
  },
  {
    id: 'sample-petit-gateau',
    category_id: 'sample-cat-sobremesas',
    name: 'Petit Gâteau',
    short_description: 'Com sorvete de baunilha',
    description: 'Bolo quente de chocolate com recheio cremoso, servido com bola de sorvete de baunilha.',
    price_in_cents: 2800,
    available: true,
    images: [{ url: 'https://images.unsplash.com/photo-1606313564200-e75d5e30476c?auto=format&fit=crop&w=300&q=80' }],
    sort_order: 5,
  },
];

const DEFAULT_FALLBACK_CATEGORIES: MenuCategoryItem[] = [
  { id: 'sample-cat-entradas', name: 'Entradas', slug: 'entradas', sort_order: 1 },
  { id: 'sample-cat-pratos', name: 'Pratos', slug: 'pratos', sort_order: 2 },
  { id: 'sample-cat-bebidas', name: 'Bebidas', slug: 'bebidas', sort_order: 3 },
  { id: 'sample-cat-sobremesas', name: 'Sobremesas', slug: 'sobremesas', sort_order: 4 },
];

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
  onOpenTabsCountChange,
  showSuccessToast,
  onCloseSuccessToast,
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
    try {
      return sessionStorage.getItem(`elz_catalog_tab_${tableVisitId}`);
    } catch {
      return null;
    }
  });

  const [tabConsumptions, setTabConsumptions] = useState<
    Record<string, { items: TabConsumptionItem[]; totalInCents: number }>
  >({});

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

  // Catálogo de produtos e categorias (Tela 4)
  const [categories, setCategories] = useState<MenuCategoryItem[]>([]);
  const [products, setProducts] = useState<MenuProductItem[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>('todos');
  const [searchQuery, setSearchQuery] = useState('');

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

  const [isTransferTableModalOpen, setIsTransferTableModalOpen] = useState(false);
  const [transferItemId, setTransferItemId] = useState('');
  const [transferTargetTableId, setTransferTargetTableId] = useState('');
  const [occupiedTables, setOccupiedTables] = useState<
    Array<{ id: string; table_number: number | string; label?: string | null; status?: string }>
  >([]);
  const [loadingOccupiedTables, setLoadingOccupiedTables] = useState(false);

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

  // Carregar produtos e categorias para o catálogo
  useEffect(() => {
    let disposed = false;
    async function loadCatalog() {
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

        if (!disposed) {
          if (catsRes.data && catsRes.data.length > 0) {
            setCategories(catsRes.data as MenuCategoryItem[]);
          } else {
            setCategories(DEFAULT_FALLBACK_CATEGORIES);
          }

          if (prodsRes.data && prodsRes.data.length > 0) {
            setProducts(prodsRes.data as MenuProductItem[]);
          } else {
            setProducts(DEFAULT_FALLBACK_PRODUCTS);
          }
        }
      } catch {
        if (!disposed) {
          setCategories(DEFAULT_FALLBACK_CATEGORIES);
          setProducts(DEFAULT_FALLBACK_PRODUCTS);
        }
      }
    }

    void loadCatalog();
    return () => {
      disposed = true;
    };
  }, [restaurantId]);

  // Carregar comandas reais do banco (SEM auto-criar registros)
  useEffect(() => {
    let disposed = false;

    async function load() {
      if (!initialLoaded.current) {
        setLoading(true);
      }

      try {
        const [tabsResult, restaurantRes] = await Promise.all([
          getTableTabsState(restaurantId, tableVisitId),
          supabase
            .from('restaurants')
            .select('service_fee_percent')
            .eq('id', restaurantId)
            .maybeSingle(),
        ]);

        if (!disposed) {
          setState(tabsResult);
          if (restaurantRes.data?.service_fee_percent !== undefined) {
            setRestaurantFeePercent(Number(restaurantRes.data.service_fee_percent));
          }

          const openTabs = tabsResult.tabs.filter((t) => t.status === 'open');
          onOpenTabsCountChangeRef.current?.(openTabs.length);

          // Seleção inteligente da comanda ativa
          let currentActiveTabId: string | null = null;
          try {
            const savedTabId = sessionStorage.getItem(`elz_catalog_tab_${tableVisitId}`);
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
              const fallback = openTabs[0]?.id || tabsResult.tabs[0]?.id || null;
              currentActiveTabId = fallback;
              return fallback;
            });
          } else {
            setSelectedTabId(currentActiveTabId);
          }

          if (currentActiveTabId) {
            try {
              sessionStorage.setItem(`elz_catalog_tab_${tableVisitId}`, currentActiveTabId);
            } catch {}
          }

          // Carrega consumo de cada comanda aberta
          const consumptions: Record<
            string,
            { items: TabConsumptionItem[]; totalInCents: number }
          > = {};
          await Promise.all(
            openTabs.map(async (tab) => {
              try {
                const c = await getTabConsumption(restaurantId, tab.id);
                consumptions[tab.id] = { items: c.items, totalInCents: c.totalInCents };
              } catch {
                consumptions[tab.id] = { items: [], totalInCents: 0 };
              }
            }),
          );

          if (!disposed) {
            setTabConsumptions(consumptions);
            initialLoaded.current = true;

            // REGRA DE RENDERIZAÇÃO AUTOMÁTICA DA ABA "COMANDA":
            // 1. Se a comanda ativa possuir itens lançados (items.length > 0): Renderize IMEDIATAMENTE a Tela 4.
            // 2. Se a comanda ativa não possuir itens: Exiba a Tela 3 (a não ser que o garçom já tenha aberto o catálogo via sessionStorage).
            const activeItemsCount = currentActiveTabId
              ? (consumptions[currentActiveTabId]?.items?.filter((it) => it.status === 'active')?.length ?? 0)
              : 0;

            let storedMode: string | null = null;
            try {
              storedMode = sessionStorage.getItem(`elz_catalog_mode_${tableVisitId}`);
            } catch {}

            if (activeItemsCount > 0) {
              setIsCatalogOpen(true);
              try {
                sessionStorage.setItem(`elz_catalog_mode_${tableVisitId}`, 'true');
              } catch {}
            } else if (storedMode === 'true') {
              setIsCatalogOpen(true);
            } else {
              setIsCatalogOpen(false);
            }
          }
        }
      } catch (cause) {
        if (!disposed) {
          setActionError(
            cause instanceof Error
              ? cause.message
              : 'Não foi possível carregar as comandas.',
          );
        }
      } finally {
        if (!disposed) {
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
          if (!disposed) {
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

  const disabled = busy || loading;

  const activeGuests = state.guests.filter(
    (guest) => Date.parse(guest.expires_at) > Date.now(),
  );

  const selectedTab = useMemo(() => {
    return state.tabs.find((t) => t.id === selectedTabId) || null;
  }, [state.tabs, selectedTabId]);

  const sharedTab = useMemo(() => {
    return (
      state.tabs.find(
        (t) =>
          t.status === 'open' &&
          (t.label.toLowerCase().includes('conjunta') ||
            t.label.toLowerCase().includes('compartilhada') ||
            t.label.toLowerCase().includes('mesa toda')),
      ) || null
    );
  }, [state.tabs]);

  const isSharedTabSelected = useMemo(() => {
    if (!selectedTab) return false;
    const l = selectedTab.label.toLowerCase();
    return l.includes('conjunta') || l.includes('compartilhada') || l.includes('mesa toda');
  }, [selectedTab]);

  const selectedTabConsumption = useMemo(() => {
    if (!selectedTabId) return { items: [], totalInCents: 0 };
    return tabConsumptions[selectedTabId] || { items: [], totalInCents: 0 };
  }, [tabConsumptions, selectedTabId]);

  // Cálculos financeiros totais da mesa
  const { tableSubtotal, tableFee, tableGrandTotal } = useMemo(() => {
    let subtotal = 0;
    for (const c of Object.values(tabConsumptions)) {
      subtotal += c.totalInCents;
    }
    const fee =
      restaurantFeePercent > 0 ? Math.round((subtotal * restaurantFeePercent) / 100) : 0;
    const grand = subtotal + fee;
    return {
      tableSubtotal: subtotal,
      tableFee: fee,
      tableGrandTotal: grand,
    };
  }, [tabConsumptions, restaurantFeePercent]);

  // Cálculos financeiros específicos da pessoa/comanda selecionada (Tela 4)
  const { personSubtotal, personFee, personTotal } = useMemo(() => {
    const subtotal = selectedTabConsumption.totalInCents;
    const fee =
      restaurantFeePercent > 0 ? Math.round((subtotal * restaurantFeePercent) / 100) : 0;
    const total = subtotal + fee;
    return {
      personSubtotal: subtotal,
      personFee: fee,
      personTotal: total,
    };
  }, [selectedTabConsumption, restaurantFeePercent]);

  // Cálculos financeiros efetivos (se for Conta Conjunta, consolida a Mesa Toda)
  const { effectiveSubtotal, effectiveFee, effectiveTotal } = useMemo(() => {
    if (isSharedTabSelected) {
      return {
        effectiveSubtotal: tableSubtotal,
        effectiveFee: tableFee,
        effectiveTotal: tableGrandTotal,
      };
    }
    return {
      effectiveSubtotal: personSubtotal,
      effectiveFee: personFee,
      effectiveTotal: personTotal,
    };
  }, [isSharedTabSelected, tableSubtotal, tableFee, tableGrandTotal, personSubtotal, personFee, personTotal]);

  async function perform(
    operation: () => Promise<unknown>,
    successMessage: string,
    onSuccess?: () => void,
  ) {
    if (submitting.current || disabled) return;

    submitting.current = true;
    setBusy(true);
    setActionError('');
    setNotice('');

    try {
      await operation();
      onSuccess?.();
      setNotice(successMessage);
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

  // Encerrar comanda
  async function handleCloseTab(tabId: string) {
    const feeAccepted = restaurantFeePercent > 0 ? closingFeeAccepted : false;
    await perform(
      () => closeTableTab(restaurantSlug, tabId, feeAccepted),
      'Comanda encerrada com sucesso.',
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

  // Exclusão direta de comanda vazia (R$ 0,00) ou acionamento de encerramento se houver consumo
  async function handleDeleteOrCloseTab(tabId: string) {
    const tab = state.tabs.find((t) => t.id === tabId);
    if (!tab) return;

    const consumption = tabConsumptions[tabId];
    const activeItems = consumption?.items?.filter((it) => it.status === 'active') || [];
    const totalInCents = consumption?.totalInCents || 0;

    // Se a comanda estiver com R$ 0,00 (sem itens consumidos)
    if (totalInCents === 0 && activeItems.length === 0) {
      const confirmDelete = window.confirm(`Deseja remover a comanda vazia “${tab.label}”?`);
      if (!confirmDelete) return;

      await perform(
        async () => {
          // Remove vínculos de convidados caso existam
          try {
            await supabase.from('table_tab_guests').delete().eq('table_tab_id', tabId);
          } catch {
            // Ignora se não houver vínculos ou permissão
          }

          // Desativa/encerra a comanda (soft delete) usando closeTableTab ou update de status
          try {
            await closeTableTab(restaurantSlug, tabId, false);
          } catch {
            const { error } = await supabase
              .from('table_tabs')
              .update({
                status: 'closed',
                closed_at: new Date().toISOString(),
              })
              .eq('id', tabId);

            if (error) {
              throw new Error('Não foi possível remover a comanda: ' + error.message);
            }
          }
        },
        `Comanda “${tab.label}” desativada.`,
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
      // Se a comanda já possuir itens lançados: aciona o fluxo de encerramento de conta
      setClosingTabId(tabId);
    }
  }

  // Lançamento rápido de produto na comanda selecionada (Tela 4 com agrupamento automático)
  async function handleQuickAddItem(product: MenuProductItem) {
    if (!selectedTabId) {
      setActionError('Selecione uma comanda/pessoa para lançar o item.');
      return;
    }

    try {
      sessionStorage.setItem(`elz_catalog_mode_${tableVisitId}`, 'true');
      sessionStorage.setItem(`elz_catalog_tab_${tableVisitId}`, selectedTabId);
    } catch {}

    // REGRA DE AGRUPAMENTO:
    // Se o produto já existir na comanda ativa com o mesmo product_id e status pendente, incrementa quantidade
    const existing = selectedTabConsumption.items.find(
      (it) =>
        it.product_id === product.id &&
        it.status === 'active' &&
        (!it.production_status || it.production_status === 'pending'),
    );

    if (existing) {
      const newQty = existing.quantity + 1;
      const newTotal = newQty * existing.unit_price_in_cents;

      // Atualização otimista imediata na UI
      setTabConsumptions((prev) => {
        const cur = prev[selectedTabId] || { items: [], totalInCents: 0 };
        return {
          ...prev,
          [selectedTabId]: {
            items: cur.items.map((it) =>
              it.id === existing.id
                ? { ...it, quantity: newQty, line_total_in_cents: newTotal }
                : it,
            ),
            totalInCents: cur.totalInCents + existing.unit_price_in_cents,
          },
        };
      });

      if (!product.id.startsWith('sample-')) {
        const newItemId = crypto.randomUUID();
        await perform(
          () => addTabConsumption(restaurantSlug, selectedTabId, product.id, 1, newItemId),
          `${product.name} (+1) adicionado à comanda de ${selectedTab?.label || 'cliente'}.`,
        );
      } else {
        setNotice(`${product.name} (+1) atualizado na comanda de ${selectedTab?.label || 'cliente'}.`);
      }
      return;
    }

    // Se ainda não existia, cria novo item com quantidade 1
    const itemId = crypto.randomUUID();

    // Se o produto for do banco real (UUID)
    if (!product.id.startsWith('sample-')) {
      await perform(
        () => addTabConsumption(restaurantSlug, selectedTabId, product.id, 1, itemId),
        `${product.name} adicionado à comanda de ${selectedTab?.label || 'cliente'}.`,
      );
    } else {
      const newItem: TabConsumptionItem = {
        id: itemId,
        restaurant_id: restaurantId,
        restaurant_table_id: '',
        table_visit_id: tableVisitId,
        table_tab_id: selectedTabId,
        product_id: product.id,
        product_name: product.name,
        unit_price_in_cents: product.price_in_cents,
        quantity: 1,
        line_total_in_cents: product.price_in_cents,
        status: 'active',
        added_by_member_id: '',
        created_at: new Date().toISOString(),
        cancelled_by_member_id: null,
        cancelled_at: null,
        cancellation_reason: null,
      };

      setTabConsumptions((prev) => {
        const cur = prev[selectedTabId] || { items: [], totalInCents: 0 };
        return {
          ...prev,
          [selectedTabId]: {
            items: [...cur.items, newItem],
            totalInCents: cur.totalInCents + product.price_in_cents,
          },
        };
      });

      setNotice(`${product.name} adicionado à comanda de ${selectedTab?.label || 'cliente'}.`);
    }
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

  // Incrementar quantidade de item consolidado (+1)
  async function handleIncrementGroup(group: { primaryItemId: string; productName: string; unitPriceInCents: number }) {
    const targetId = group.primaryItemId;
    const found = findItemAndTab(targetId);
    if (!found) return;
    const { tabId, item: currentItem } = found;

    const newQty = currentItem.quantity + 1;
    const newTotal = newQty * currentItem.unit_price_in_cents;

    setTabConsumptions((prev) => {
      const cur = prev[tabId] || { items: [], totalInCents: 0 };
      return {
        ...prev,
        [tabId]: {
          items: cur.items.map((it) =>
            it.id === targetId ? { ...it, quantity: newQty, line_total_in_cents: newTotal } : it,
          ),
          totalInCents: cur.totalInCents + currentItem.unit_price_in_cents,
        },
      };
    });

    if (!currentItem.product_id.startsWith('sample-')) {
      const newItemId = crypto.randomUUID();
      await perform(
        () => addTabConsumption(restaurantSlug, tabId, currentItem.product_id, 1, newItemId),
        `${group.productName} (+1).`,
      );
    }
  }

  // Decrementar quantidade de item consolidado (-1)
  async function handleDecrementGroup(group: { primaryItemId: string; itemIds: string[]; productName: string; lineTotalInCents: number; unitPriceInCents: number; quantity: number }) {
    if (disabled || group.itemIds.length === 0) return;

    if (group.itemIds.length > 1) {
      const targetId = group.itemIds[group.itemIds.length - 1];
      const found = findItemAndTab(targetId);
      if (!found) return;
      const { tabId, item: currentItem } = found;

      setTabConsumptions((prev) => {
        const cur = prev[tabId] || { items: [], totalInCents: 0 };
        return {
          ...prev,
          [tabId]: {
            items: cur.items.filter((it) => it.id !== targetId),
            totalInCents: Math.max(0, cur.totalInCents - currentItem.line_total_in_cents),
          },
        };
      });

      if (!currentItem.product_id.startsWith('sample-')) {
        await perform(
          () => cancelTabConsumption(restaurantSlug, targetId, 'Item decrementado pelo garçom'),
          `${group.productName} (-1).`,
        );
      }
    } else {
      await handleRemoveGroup(group);
    }
  }

  // Remover grupo de item da comanda
  async function handleRemoveGroup(group: { itemIds: string[]; productName: string; lineTotalInCents: number }) {
    setTabConsumptions((prev) => {
      const updated = { ...prev };
      for (const [tabId, cur] of Object.entries(updated)) {
        const remaining = cur.items.filter((it) => !group.itemIds.includes(it.id));
        if (remaining.length !== cur.items.length) {
          const newTotal = remaining
            .filter((it) => it.status === 'active')
            .reduce((acc, it) => acc + it.line_total_in_cents, 0);
          updated[tabId] = { items: remaining, totalInCents: newTotal };
        }
      }
      return updated;
    });

    await perform(
      async () => {
        for (const id of group.itemIds) {
          if (!id.startsWith('sample-')) {
            await cancelTabConsumption(restaurantSlug, id, 'Cancelado pelo garçom');
          }
        }
      },
      `${group.productName} removido da comanda.`,
    );
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

  // Limpar itens da comanda atual
  function handleClearPersonItems() {
    if (!selectedTabId) return;
    setTabConsumptions((prev) => ({
      ...prev,
      [selectedTabId]: { items: [], totalInCents: 0 },
    }));
    setNotice(`Itens de ${selectedTab?.label} limpos.`);
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

  // Imprimir pré-conta térmica
  function handlePrintReceipt() {
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
    setMoveTargetTabId(targets[0].id);
    setIsMovePersonModalOpen(true);
  }

  async function handleConfirmMovePerson() {
    if (!moveItemId || !moveTargetTabId) {
      setActionError('Selecione o item e a pessoa de destino.');
      return;
    }

    const found = findItemAndTab(moveItemId);
    if (!found) {
      setActionError('Item não encontrado.');
      return;
    }
    const { tabId: sourceTabId, item } = found;
    const targetTab = state.tabs.find((t) => t.id === moveTargetTabId);

    const newItemId = crypto.randomUUID();

    // Atualização otimista imediata na UI
    setTabConsumptions((prev) => {
      const sourceCur = prev[sourceTabId] || { items: [], totalInCents: 0 };
      const targetCur = prev[moveTargetTabId] || { items: [], totalInCents: 0 };
      return {
        ...prev,
        [sourceTabId]: {
          items: sourceCur.items.filter((i) => i.id !== moveItemId),
          totalInCents: Math.max(0, sourceCur.totalInCents - item.line_total_in_cents),
        },
        [moveTargetTabId]: {
          items: [...targetCur.items, { ...item, id: newItemId, table_tab_id: moveTargetTabId }],
          totalInCents: targetCur.totalInCents + item.line_total_in_cents,
        },
      };
    });

    await perform(
      async () => {
        if (!item.product_id.startsWith('sample-')) {
          await cancelTabConsumption(
            restaurantSlug,
            moveItemId,
            `Movido para ${targetTab?.label || 'outra comanda'}`,
          );
          await addTabConsumption(
            restaurantSlug,
            moveTargetTabId,
            item.product_id,
            item.quantity,
            newItemId,
          );
        }
      },
      `Item movido para ${targetTab?.label || 'outra pessoa'} com sucesso!`,
      () => {
        setIsMovePersonModalOpen(false);
        setMoveItemId('');
        setMoveTargetTabId('');
      },
    );
  }

  async function handleOpenTransferTableModal() {
    if (movableItems.length === 0) {
      setActionError('Não há itens ativos lançados para transferir.');
      return;
    }
    setTransferItemId(movableItems[0].id);
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
      const uniqueTables = Array.from(uniqueMap.values()).sort((a, b) => a.table_number - b.table_number);

      setOccupiedTables(uniqueTables);
      if (uniqueTables.length > 0) {
        setTransferTargetTableId(uniqueTables[0].id);
      }
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

    const targetTable = occupiedTables.find((t) => t.id === transferTargetTableId);
    if (!targetTable) return;

    const found = findItemAndTab(transferItemId);
    if (!found) {
      setActionError('Item não encontrado.');
      return;
    }
    const { tabId: sourceTabId, item } = found;
    const newItemId = crypto.randomUUID();

    // Remove do estado local da mesa atual (otimista)
    setTabConsumptions((prev) => {
      const sourceCur = prev[sourceTabId] || { items: [], totalInCents: 0 };
      return {
        ...prev,
        [sourceTabId]: {
          items: sourceCur.items.filter((i) => i.id !== transferItemId),
          totalInCents: Math.max(0, sourceCur.totalInCents - item.line_total_in_cents),
        },
      };
    });

    await perform(
      async () => {
        // 1. Obter visita ativa da mesa de destino
        const { data: visit, error: visitErr } = await supabase
          .from('table_visits')
          .select('id')
          .eq('restaurant_table_id', transferTargetTableId)
          .eq('status', 'open')
          .order('started_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (visitErr || !visit) {
          throw new Error('Não foi encontrada sessão ativa para a Mesa ' + targetTable.table_number + '.');
        }

        // 2. Obter comanda aberta da mesa de destino
        const { data: targetTabs, error: tabsErr } = await supabase
          .from('table_tabs')
          .select('id')
          .eq('table_visit_id', visit.id)
          .eq('status', 'open')
          .order('created_at', { ascending: true })
          .limit(1);

        if (tabsErr || !targetTabs || targetTabs.length === 0) {
          throw new Error('A Mesa ' + targetTable.table_number + ' não possui comanda aberta para receber o item.');
        }

        const destTabId = targetTabs[0].id;

        // 3. Cancela na mesa de origem e adiciona na mesa de destino via RPC autorizada
        if (!item.product_id.startsWith('sample-')) {
          await cancelTabConsumption(
            restaurantSlug,
            transferItemId,
            `Transferido para Mesa ${targetTable.table_number}`,
          );
          await addTabConsumption(
            restaurantSlug,
            destTabId,
            item.product_id,
            item.quantity,
            newItemId,
          );
        }
      },
      `Item transferido com sucesso para a Mesa ${targetTable.table_number}!`,
      () => {
        setIsTransferTableModalOpen(false);
        setTransferItemId('');
        setTransferTargetTableId('');
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
                              {tabConsumptions[tab.id]?.totalInCents === 0 ? 'Excluir comanda' : 'Encerrar comanda'}
                            </button>
                          ) : (
                            <div className="px-3 py-2 text-zinc-400 font-medium">
                              Comanda encerrada
                            </div>
                          )}
                        </div>
                      )}

                      {/* Badge de status de celular na Tela 3 */}
                      <div className="px-2 pt-1">
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
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* 3. Card Central de Estado Vazio (Fiel a 3.jpg) */}
          <div className="bg-white dark:bg-zinc-900 rounded-3xl p-8 border border-zinc-200/60 dark:border-zinc-800 shadow-xs flex flex-col items-center text-center my-1 transition-all">
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
          </div>

          {/* 4. Resumo Financeiro Inicial da Mesa e Ações Rápidas */}
          <div className="space-y-2 pt-1">
            <div className="grid grid-cols-3 gap-2 p-3 rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200/60 dark:border-zinc-800 shadow-xs">
              <div>
                <span className="text-[10px] text-zinc-400 font-medium block">Total da mesa</span>
                <span className="text-xs font-bold text-zinc-900 dark:text-white mt-0.5 block">
                  {currency.format(tableSubtotal / 100)}
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
                  {currency.format(tableGrandTotal / 100)}
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
                className="p-2.5 rounded-2xl border border-amber-900/10 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-xs flex items-center justify-center gap-1.5 text-[11px] font-semibold text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition cursor-pointer"
              >
                <svg className="w-3.5 h-3.5 text-[#782006] dark:text-amber-300 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M6 9V2h12v7" />
                  <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                  <path d="M6 14h12v8H6z" />
                </svg>
                <span className="truncate">Imprimir pré-conta</span>
              </button>
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

            {/* Card "+ Conta conjunta (Mesa toda)" permanente */}
            {(() => {
              const sharedTab = state.tabs.find(
                (t) =>
                  t.status === 'open' &&
                  (t.label.toLowerCase().includes('conjunta') ||
                    t.label.toLowerCase().includes('compartilhada') ||
                    t.label.toLowerCase().includes('mesa toda')),
              );
              const isSelected = sharedTab ? selectedTabId === sharedTab.id : false;
              const sharedTotal = sharedTab ? (tabConsumptions[sharedTab.id]?.totalInCents ?? 0) : 0;

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
                      {tableSubtotal > 0 ? currency.format(tableSubtotal / 100) : 'Mesa toda'}
                    </span>
                  </div>
                </div>
              );
            })()}

            {/* Cards individuais de cada comanda/pessoa */}
            {state.tabs
              .filter(
                (t) =>
                  t.status === 'open' &&
                  !t.label.toLowerCase().includes('conjunta') &&
                  !t.label.toLowerCase().includes('compartilhada') &&
                  !t.label.toLowerCase().includes('mesa toda'),
              )
              .map((tab) => {
                const isSelected = selectedTabId === tab.id;
                const tabTotal = tabConsumptions[tab.id]?.totalInCents ?? 0;
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
                        title="Remover ou encerrar comanda"
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
                        {currency.format(tabTotal / 100)}
                      </span>

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

            {/* Campo de Busca */}
            <div className="relative flex items-center rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3.5 py-2.5 shadow-xs">
              <svg className="w-4 h-4 text-zinc-400 shrink-0 mr-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Buscar prato ou bebida..."
                className="w-full text-xs text-zinc-800 dark:text-white placeholder:text-zinc-400 bg-transparent focus:outline-none"
              />
              <svg className="w-4 h-4 text-zinc-400 shrink-0 ml-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </div>

            {/* Categorias horizontais com scroll */}
            <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none">
              <button
                type="button"
                onClick={() => setSelectedCategory('todos')}
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
                    onClick={() => setSelectedCategory(cat.slug || cat.id)}
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

            {/* Lista compacta de produtos */}
            <div className="space-y-2">
              {filteredProducts.map((prod) => {
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
              })}
            </div>
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

              {activeItems.length > 0 && (
                <button
                  type="button"
                  onClick={handleClearPersonItems}
                  className="text-xs text-zinc-400 hover:text-red-500 flex items-center gap-1 cursor-pointer transition-colors"
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M3 6h18" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                  <span>Limpar</span>
                </button>
              )}
            </div>

            {/* Listagem de Itens: Consolidada para Conta Conjunta ou Individual */}
            {isSharedTabSelected ? (
              <div className="space-y-4">
                {/* 1. Itens compartilhados diretamente na mesa */}
                {(() => {
                  const sharedItems = sharedTab ? (tabConsumptions[sharedTab.id]?.items ?? []) : [];
                  const groupedShared = groupItemsByProductAndStatus(sharedItems);

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
                          {currency.format((sharedTab ? (tabConsumptions[sharedTab.id]?.totalInCents ?? 0) : 0) / 100)}
                        </span>
                      </div>

                      {groupedShared.length === 0 ? (
                        <p className="text-[11px] text-amber-900/60 dark:text-amber-300/60 italic py-1">
                          Nenhum item lançado no coletivo. Novos pedidos aqui serão divididos pela mesa.
                        </p>
                      ) : (
                        <div className="divide-y divide-amber-900/10 dark:divide-amber-900/20">
                          {groupedShared.map((group) => renderItemRow(group))}
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
                      const personConsumption = tabConsumptions[personTab.id] || { items: [], totalInCents: 0 };
                      const personGrouped = groupItemsByProductAndStatus(personConsumption.items);

                      return (
                        <div
                          key={personTab.id}
                          className="rounded-2xl p-3 bg-white dark:bg-zinc-900 border border-zinc-200/70 dark:border-zinc-800 shadow-2xs space-y-2"
                        >
                          <div className="flex items-center justify-between text-xs pb-1 border-b border-zinc-100 dark:border-zinc-800">
                            <span className="font-bold text-zinc-900 dark:text-white flex items-center gap-1.5">
                              <span className="w-2 h-2 rounded-full bg-[#4A1505] dark:bg-amber-400 shrink-0" />
                              {personTab.label}
                            </span>
                            <span className="font-extrabold text-zinc-900 dark:text-white">
                              {currency.format(personConsumption.totalInCents / 100)}
                            </span>
                          </div>

                          {personGrouped.length === 0 ? (
                            <p className="text-[11px] text-zinc-400 italic py-1">
                              Sem itens lançados para esta pessoa.
                            </p>
                          ) : (
                            <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                              {personGrouped.map((group) => renderItemRow(group))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                </div>
              </div>
            ) : (
              <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {groupedActiveItems.length === 0 ? (
                  <p className="text-xs text-zinc-400 italic py-2">
                    Nenhum item lançado para esta comanda ainda. Clique no '+' acima para adicionar.
                  </p>
                ) : (
                  groupedActiveItems.map((group) => renderItemRow(group))
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
            <div className="grid grid-cols-3 gap-2 p-3 rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200/60 dark:border-zinc-800 shadow-xs">
              <div>
                <span className="text-[10px] text-zinc-400 font-medium block">Subtotal</span>
                <span className="text-xs font-bold text-zinc-900 dark:text-white mt-0.5 block">
                  {currency.format(effectiveSubtotal / 100)}
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
                  {currency.format(effectiveTotal / 100)}
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
                className="p-2.5 rounded-2xl border border-amber-900/10 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-xs flex items-center justify-center gap-1.5 text-[11px] font-semibold text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition cursor-pointer"
              >
                <svg className="w-3.5 h-3.5 text-[#782006] dark:text-amber-300 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M6 9V2h12v7" />
                  <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                  <path d="M6 14h12v8H6z" />
                </svg>
                <span className="truncate">Imprimir pré-conta</span>
              </button>
            </div>

            <button
              type="button"
              onClick={handleFinalizeAndSendToKitchen}
              disabled={disabled || activeItems.length === 0}
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

      {/* Modal global de confirmação de encerramento de comanda com consumo */}
      {closingTabId && (() => {
        const tabToClose = state.tabs.find((t) => t.id === closingTabId);
        if (!tabToClose) return null;
        return (
          <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
            <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-3xl p-5 max-w-sm w-full shadow-2xl space-y-4">
              <div>
                <h3 className="font-bold text-sm text-zinc-900 dark:text-white">
                  Encerrar comanda “{tabToClose.label}”?
                </h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
                  Esta comanda possui consumo registrado. Deseja fechar e calcular o total para pagamento?
                </p>
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleCloseTab(closingTabId)}
                  className="flex-1 py-2.5 rounded-xl bg-amber-800 hover:bg-amber-900 text-white font-semibold text-xs transition cursor-pointer disabled:opacity-50"
                >
                  {busy ? 'Encerrando…' : 'Confirmar encerramento'}
                </button>
                <button
                  type="button"
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
                    if (availableTargets.length > 0 && !availableTargets.some((t) => t.id === moveTargetTabId)) {
                      setMoveTargetTabId(availableTargets[0].id);
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
                  Pessoa / Comanda de destino
                </label>
                {movableTargetTabs.length === 0 ? (
                  <p className="text-xs text-zinc-400 italic py-1">
                    Nenhuma outra pessoa aberta nesta mesa.
                  </p>
                ) : (
                  <select
                    value={moveTargetTabId}
                    onChange={(e) => setMoveTargetTabId(e.target.value)}
                    className="w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-xs text-zinc-900 dark:text-white"
                  >
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
            </div>

            <div className="flex gap-2 pt-2">
              <button
                type="button"
                disabled={busy || !moveItemId || !moveTargetTabId || movableTargetTabs.length === 0}
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
                    onChange={(e) => setTransferTargetTableId(e.target.value)}
                    className="w-full rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-xs text-zinc-900 dark:text-white"
                  >
                    {occupiedTables.map((t) => (
                      <option key={t.id} value={t.id}>
                        Mesa {t.table_number}{t.label ? ` (${t.label})` : ''}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                type="button"
                disabled={busy || !transferItemId || !transferTargetTableId || occupiedTables.length === 0}
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
                }}
                className="px-4 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 font-medium text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 transition cursor-pointer"
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

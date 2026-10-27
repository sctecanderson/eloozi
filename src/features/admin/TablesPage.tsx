import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { useRestaurant } from "../restaurants/RestaurantProvider";
import {
  getAdminTables,
  saveTable,
  deleteTable,
  type AdminTable,
} from "./restaurantAdmin";
import { supabase } from "../../lib/supabase";
import { openTableVisit } from "../service/tableVisits";
import {
  getTableServiceRequestsSummary,
  dismissTableServiceRequests,
  type TableServiceRequestsSummary,
} from "../service/serviceRequests";
import {
  PrintableTableQRCodes,
  IndividualQrModal,
  BatchPrintPreviewModal,
} from "./PrintableTableQRCodes";
import { printTableBillThermal, type ThermalBillItem } from "../../components/ThermalReceiptPrint";
import {
  listReservations,
  createReservation,
  cancelReservation,
  seatReservationArrival,
  toReservationItem,
  isConfirmedReservation,
  getOperationalDate,
  analyzeLocalReservations,
  prepareLocalReservationsForImport,
  executeLocalReservationsImport,
  isWebLocksAvailable,
  withManifestLock,
  type ReservationItem,
  type LocalImportAnalysis,
  type LocalReservationPreviewItem,
  type ImportExecutionResult,
} from "../reservations/reservationService";

const money = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

const PLAN_LABELS: Record<string, string> = {
  basic: "Básico",
  pro: "Pro",
  premium: "Premium",
};

export type TableStatusType = "occupied" | "free" | "waiting" | "locked" | "reserved";

export interface TableItemView {
  id: string;
  tableNumber: number;
  label: string;
  status: TableStatusType;
  customerName: string;
  timeElapsed: string;
  totalFormatted: string;
  totalInCents: number;
  itemsSummary?: string;
  kitchenStatus?: "Em preparo" | "À mesa" | "Em atendimento" | "Conta solicitada" | "Mesa reservada";
  active: boolean;
  visitId: string | null;
  billPending: boolean;
  tabCount: number;
  revision: number;
}



function formatElapsedTime(openedAt?: string | null): string {
  if (!openedAt) return "-";
  const diffMs = Date.now() - new Date(openedAt).getTime();
  if (diffMs < 0) return "-";
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "Agora";
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? `${hours}h ${remMinutes}min` : `${hours}h`;
}

export function TablesPage() {
  const { restaurant: r } = useRestaurant();
  const [tables, setTables] = useState<AdminTable[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);

  // Mapa de visitas ativas reais do Supabase (para tempo de permanência e clientes)
  const [visitsMap, setVisitsMap] = useState<
    Map<string, { opened_at: string; client_name?: string; items_count?: number }>
  >(new Map());

  // Filtros
  const [searchQuery, setSearchQuery] = useState("");
  const [activePill, setActivePill] = useState<
    "all" | "occupied" | "free" | "waiting" | "locked" | "reserved"
  >("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [areaFilter, setAreaFilter] = useState("all");

  // Paginação
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 8;

  // Ações de Mesas (Criar / Editar)
  const [draft, setDraft] = useState<AdminTable | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);

  // Exclusão e Liberação de Mesa
  const [tableToDelete, setTableToDelete] = useState<TableItemView | null>(null);
  const [deletingTable, setDeletingTable] = useState(false);
  const [releasingTableId, setReleasingTableId] = useState<string | null>(null);

  // Menu de opções (3 pontos)
  const [openMenuTableId, setOpenMenuTableId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // QR Codes e Impressão
  const [viewingQrTable, setViewingQrTable] = useState<AdminTable | null>(null);
  const [isBatchPreviewOpen, setIsBatchPreviewOpen] = useState(false);
  const [singlePrintTable, setSinglePrintTable] = useState<AdminTable | null>(null);

  // Chamados de Garçom
  const [tableRequestsSummary, setTableRequestsSummary] =
    useState<TableServiceRequestsSummary | null>(null);
  const [loadingRequestsSummary, setLoadingRequestsSummary] = useState(false);
  const [confirmDismissRequests, setConfirmDismissRequests] = useState(false);
  const [dismissingRequests, setDismissingRequests] = useState(false);

  // =========================================================================
  // ESTADOS DOS 4 MODAIS DE AÇÕES RÁPIDAS
  // =========================================================================

  // 1. Abrir mesa (Iniciar novo atendimento)
  const [isOpenTableModalOpen, setIsOpenTableModalOpen] = useState(false);
  const [openTableNumber, setOpenTableNumber] = useState<number | null>(null);
  const [openCustomerName, setOpenCustomerName] = useState("");
  const [openGuestsCount, setOpenGuestsCount] = useState(2);
  const [openTableBusy, setOpenTableBusy] = useState(false);

  // 2. Comanda (Consultar / imprimir)
  const [isConsultTabModalOpen, setIsConsultTabModalOpen] = useState(false);
  const [selectedConsultTableId, setSelectedConsultTableId] = useState<string | null>(null);
  const [consultItems, setConsultItems] = useState<
    Array<{
      id: string;
      product_name: string;
      quantity: number;
      unit_price_in_cents: number;
      line_total_in_cents: number;
      status?: string;
      cancelled_at?: string | null;
      cancellation_reason?: string | null;
    }>
  >([]);
  const [loadingConsultItems, setLoadingConsultItems] = useState(false);

  // 3. Fechamento de mesa (Finalizar atendimento)
  const [isCloseTableModalOpen, setIsCloseTableModalOpen] = useState(false);
  const [selectedCloseTableId, setSelectedCloseTableId] = useState<string | null>(null);
  const [closePaymentMethod, setClosePaymentMethod] = useState<
    "pix" | "credit" | "debit" | "cash" | "other"
  >("pix");
  const [closeIncludeServiceFee, setCloseIncludeServiceFee] = useState(true);
  const [closePrintReceipt, setClosePrintReceipt] = useState(true);
  const [closeTableBusy, setCloseTableBusy] = useState(false);

  // 4. Reserva (Gerenciar reservas)
  const [isReservationModalOpen, setIsReservationModalOpen] = useState(false);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [localAnalysis, setLocalAnalysis] = useState<LocalImportAnalysis | null>(null);
  const [importResult, setImportResult] = useState<ImportExecutionResult | null>(null);
  const [isImporting, setIsImporting] = useState(false);

  const [reservations, setReservations] = useState<ReservationItem[]>([]);
  const [reservationsLoading, setReservationsLoading] = useState(false);
  const [reservationsError, setReservationsError] = useState<string | null>(null);
  const [isSubmittingReservation, setIsSubmittingReservation] = useState(false);
  const reservationsLoadVersionRef = useRef(0);

  const [reserveTableNumber, setReserveTableNumber] = useState<number | null>(null);
  const [reserveCustomerName, setReserveCustomerName] = useState("");
  const [reservePhone, setReservePhone] = useState("");
  const [reserveTime, setReserveTime] = useState("20:00");
  const [reserveGuestsCount, setReserveGuestsCount] = useState(2);
  const [reserveNotes, setReserveNotes] = useState("");

  const planLabel = PLAN_LABELS[r.subscriptionPlan ?? "basic"] ?? "Básico";

  // Carrega reservas reais do Supabase com base no fuso operacional do restaurante
  useEffect(() => {
    if (!r.id) {
      setReservations([]);
      setReservationsLoading(false);
      setReservationsError(null);
      setLocalAnalysis(null);
      setImportResult(null);
      return;
    }

    let disposed = false;
    const currentVersion = ++reservationsLoadVersionRef.current;

    async function load() {
      setReservationsLoading(true);
      setReservationsError(null);
      try {
        const opDate = getOperationalDate(r.timezone);
        const data = await listReservations(r.id, { startDate: opDate, endDate: opDate });
        if (!disposed && currentVersion === reservationsLoadVersionRef.current) {
          setReservations(data.map(toReservationItem));
        }
      } catch (err) {
        if (!disposed && currentVersion === reservationsLoadVersionRef.current) {
          setReservationsError(err instanceof Error ? err.message : 'Falha ao carregar reservas.');
        }
      } finally {
        if (!disposed && currentVersion === reservationsLoadVersionRef.current) {
          setReservationsLoading(false);
        }
      }
    }

    void load();

    // Inspeciona armazenamento local para checagem de dados pendentes
    try {
      const raw = localStorage.getItem(`elozi_reservas_${r.id}`);
      const activeTableNumbers = new Set(displayTables.map((t) => t.tableNumber));
      const analysis = analyzeLocalReservations(raw, activeTableNumbers, !loading && displayTables.length > 0, r.id);
      setLocalAnalysis(analysis);
    } catch {
      // ignore
    }

    // Canal Realtime para sincronização com garçons e outros aparelhos
    const channel = supabase
      .channel(`admin-reservations-${r.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'reservations',
          filter: `restaurant_id=eq.${r.id}`,
        },
        () => {
          void load();
        }
      )
      .subscribe();

    return () => {
      disposed = true;
      void supabase.removeChannel(channel);
    };
  }, [r.id, r.timezone]);

  // Fecha menu de 3 pontos ao clicar fora
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenuTableId(null);
      }
    }
    if (openMenuTableId) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [openMenuTableId]);

  // Carrega mesas reais do restaurante via Supabase RPC
  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError("");
    void getAdminTables(r.slug)
      .then((data) => {
        if (!disposed) setTables(data);
      })
      .catch((cause) => {
        if (!disposed)
          setError(
            cause instanceof Error ? cause.message : "Não foi possível carregar as mesas."
          );
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [r.slug, revision]);

  // Carrega visitas e comandas ativas reais do Supabase
  useEffect(() => {
    if (!r.id) return;
    let active = true;

    async function loadVisits() {
      try {
        const { data, error } = await supabase
          .from("table_visits")
          .select(`
            id,
            opened_at,
            restaurant_table_id,
            table_tabs (
              id,
              label,
              table_tab_items (
                id,
                quantity
              )
            )
          `)
          .eq("restaurant_id", r.id)
          .eq("status", "open");

        if (error || !data || !active) return;

        const map = new Map<
          string,
          { opened_at: string; client_name?: string; items_count?: number }
        >();

        data.forEach((v: any) => {
          const firstTab = v.table_tabs?.[0];
          const totalItems = (v.table_tabs || []).reduce(
            (acc: number, tab: any) =>
              acc +
              (tab.table_tab_items || []).reduce(
                (tAcc: number, item: any) => tAcc + (item.quantity || 1),
                0
              ),
            0
          );
          map.set(v.id, {
            opened_at: v.opened_at,
            client_name:
              firstTab?.label && firstTab.label !== "Comanda 1"
                ? firstTab.label
                : undefined,
            items_count: totalItems,
          });
        });

        if (active) {
          setVisitsMap(map);
        }
      } catch (err) {
        console.warn("[TablesPage] loadVisits error:", err);
      }
    }

    void loadVisits();
    return () => {
      active = false;
    };
  }, [r.id, revision]);

  // Supabase Realtime Listener para mesas, visitas e comandas
  useEffect(() => {
    if (!r.id) return;

    const channel = supabase
      .channel(`admin-tables-realtime-${r.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "restaurant_tables",
          filter: `restaurant_id=eq.${r.id}`,
        },
        () => setRevision((v) => v + 1)
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "table_visits",
          filter: `restaurant_id=eq.${r.id}`,
        },
        () => setRevision((v) => v + 1)
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "table_tabs",
        },
        () => setRevision((v) => v + 1)
      )
      .subscribe();

    const intervalTimer = window.setInterval(() => {
      if (!document.hidden && !draft && !submitting.current) {
        setRevision((v) => v + 1);
      }
    }, 15_000);

    return () => {
      void supabase.removeChannel(channel);
      window.clearInterval(intervalTimer);
    };
  }, [r.id, draft]);

  // Mapeamento 100% REAL de cada mesa vinda do Supabase
  const displayTables: TableItemView[] = useMemo(() => {
    return tables.map((t) => {
      const activeReservation = reservations.find(
        (res) => res.tableNumber === t.tableNumber && isConfirmedReservation(res)
      );
      const isLocked = !t.active || !!t.isLockedByPlan;
      const isWaiting = t.billPending;
      const isOccupied = !!t.visitId && !isWaiting;
      const isReserved = !isLocked && !isWaiting && !isOccupied && !!activeReservation;

      let status: TableStatusType = "free";
      if (isLocked) status = "locked";
      else if (isWaiting) status = "waiting";
      else if (isOccupied) status = "occupied";
      else if (isReserved) status = "reserved";

      const visitInfo = t.visitId ? visitsMap.get(t.visitId) : null;
      const timeElapsed =
        isOccupied || isWaiting
          ? formatElapsedTime(visitInfo?.opened_at)
          : isReserved && activeReservation?.time
          ? `Às ${activeReservation.time}`
          : "-";
      const totalFormatted =
        t.totalInCents > 0 ? money.format(t.totalInCents / 100) : "-";

      let kitchenStatus: TableItemView["kitchenStatus"] = undefined;
      if (isWaiting) kitchenStatus = "Conta solicitada";
      else if (isOccupied) kitchenStatus = "Em atendimento";
      else if (isReserved) kitchenStatus = "Mesa reservada";

      const customerName =
        visitInfo?.client_name || (isReserved && activeReservation?.customerName) || "-";

      const itemsSummary =
        visitInfo?.items_count && visitInfo.items_count > 0
          ? `${visitInfo.items_count} item(ns) lançado(s)`
          : t.tabCount > 0
          ? `${t.tabCount} comanda(s)`
          : isReserved && activeReservation
          ? `${activeReservation.guestsCount || 1} pessoa(s)${activeReservation.phone ? ` • ${activeReservation.phone}` : ""}`
          : undefined;

      return {
        id: t.id,
        tableNumber: t.tableNumber,
        label: t.label?.trim() || "Salão",
        status,
        customerName,
        timeElapsed,
        totalFormatted,
        totalInCents: t.totalInCents || 0,
        itemsSummary,
        kitchenStatus,
        active: t.active,
        visitId: t.visitId,
        billPending: t.billPending,
        tabCount: t.tabCount,
        revision: t.revision,
      };
    }).sort((a, b) => a.tableNumber - b.tableNumber);
  }, [tables, visitsMap, reservations]);

  // Métricas calculadas exclusivamente a partir dos dados reais
  const metrics = useMemo(() => {
    const total = displayTables.length;
    const occupied = displayTables.filter((t) => t.status === "occupied").length;
    const waiting = displayTables.filter((t) => t.status === "waiting").length;
    const free = displayTables.filter((t) => t.status === "free").length;
    const locked = displayTables.filter((t) => t.status === "locked").length;
    const reserved = displayTables.filter((t) => t.status === "reserved").length;

    const occupiedPercent = total > 0 ? Math.round((occupied / total) * 100) : 0;
    const waitingPercent = total > 0 ? Math.round((waiting / total) * 100) : 0;
    const freePercent = total > 0 ? Math.round((free / total) * 100) : 0;
    const reservedPercent = total > 0 ? Math.round((reserved / total) * 100) : 0;

    return {
      total,
      occupied,
      waiting,
      free,
      locked,
      reserved,
      occupiedPercent,
      waitingPercent,
      freePercent,
      reservedPercent,
    };
  }, [displayTables]);

  // Lista de mesas com comandos em andamento reais
  const activeOrdersTables = useMemo(() => {
    return displayTables.filter((t) => t.status === "occupied" || t.status === "waiting");
  }, [displayTables]);

  // Áreas reais existentes no restaurante para o select
  const availableAreas = useMemo(() => {
    const set = new Set<string>();
    tables.forEach((t) => {
      if (t.label && t.label.trim()) set.add(t.label.trim());
    });
    return Array.from(set).sort();
  }, [tables]);

  // Filtragem da tabela
  const filteredTables = useMemo(() => {
    return displayTables.filter((t) => {
      // 1. Filtro de Abas Rápidas (Pills)
      if (activePill !== "all" && t.status !== activePill) {
        return false;
      }

      // 2. Filtro do Select de Status
      if (statusFilter !== "all" && t.status !== statusFilter) {
        return false;
      }

      // 3. Filtro do Select de Área
      if (areaFilter !== "all" && t.label.toLowerCase() !== areaFilter.toLowerCase()) {
        return false;
      }

      // 4. Busca textual
      const q = searchQuery.toLowerCase().trim();
      if (q) {
        const numStr = String(t.tableNumber);
        const padStr = String(t.tableNumber).padStart(2, "0");
        const matchNum = numStr.includes(q) || padStr.includes(q);
        const matchLabel = t.label.toLowerCase().includes(q);
        const matchClient = t.customerName.toLowerCase().includes(q);
        if (!matchNum && !matchLabel && !matchClient) return false;
      }

      return true;
    });
  }, [displayTables, activePill, statusFilter, areaFilter, searchQuery]);

  // Paginação
  const totalPages = Math.max(1, Math.ceil(filteredTables.length / itemsPerPage));
  const paginatedTables = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    return filteredTables.slice(start, start + itemsPerPage);
  }, [filteredTables, currentPage, itemsPerPage]);

  // Salvar Mesa (Supabase)
  async function submitTable(e: FormEvent) {
    e.preventDefault();
    if (!draft || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await saveTable(r.slug, draft);
      setDraft(null);
      setNotice(`Mesa ${String(draft.tableNumber).padStart(2, "0")} salva com sucesso.`);
      setRevision((v) => v + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível salvar a mesa.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  // Excluir Mesa (Supabase)
  async function handleDeleteTable() {
    if (!tableToDelete || deletingTable) return;
    setDeletingTable(true);
    setError("");
    setNotice("");
    try {
      await deleteTable(r.slug, tableToDelete.tableNumber);
      setNotice(`Mesa ${String(tableToDelete.tableNumber).padStart(2, "0")} excluída com sucesso.`);
      setTableToDelete(null);
      setRevision((v) => v + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível excluir a mesa.");
    } finally {
      setDeletingTable(false);
    }
  }

  // Liberar / Resetar Mesa
  async function handleResetAndReleaseTable(table: TableItemView) {
    if (releasingTableId) return;
    const confirmRelease = window.confirm(
      `Liberar Mesa ${String(table.tableNumber).padStart(2, "0")}?\n\nIsso encerrará o atendimento em aberto no sistema, deixando a mesa livre para o próximo cliente.`
    );
    if (!confirmRelease) return;

    setReleasingTableId(table.id);
    try {
      const { error } = await supabase.rpc("reset_and_release_table", {
        p_table_id: table.id,
      });
      if (error) throw error;

      setNotice(`Mesa ${String(table.tableNumber).padStart(2, "0")} liberada com sucesso.`);
      setRevision((v) => v + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível liberar a mesa.");
    } finally {
      setReleasingTableId(null);
      setOpenMenuTableId(null);
    }
  }

  // Impressão em Lote e QR Code Individual
  const printableTables = tables
    .filter((t) => t.active)
    .sort((a, b) => a.tableNumber - b.tableNumber);

  function handleOpenBatchPrint() {
    if (printableTables.length === 0) {
      setError("Nenhuma mesa ativa cadastrada no restaurante para impressão.");
      return;
    }
    setSinglePrintTable(null);
    setIsBatchPreviewOpen(true);
  }

  function handleConfirmBatchPrint() {
    setIsBatchPreviewOpen(false);
    setSinglePrintTable(null);
    setTimeout(() => {
      window.print();
    }, 120);
  }

  function handlePrintSingleTable(table: AdminTable) {
    setViewingQrTable(null);
    setSinglePrintTable(table);
    setTimeout(() => {
      window.print();
    }, 120);
  }

  // Encerramento de chamados de garçom
  async function handleDismissTableRequests() {
    if (!draft || dismissingRequests) return;
    setDismissingRequests(true);
    setError("");
    setNotice("");
    try {
      const dismissed = await dismissTableServiceRequests(r.slug, draft.tableNumber);
      setConfirmDismissRequests(false);
      setNotice(
        `Chamados da Mesa ${String(draft.tableNumber).padStart(2, "0")} encerrados (${dismissed}).`
      );
      const updated = await getTableServiceRequestsSummary(r.id, draft.tableNumber);
      setTableRequestsSummary(updated);
      setRevision((v) => v + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao encerrar chamados.");
    } finally {
      setDismissingRequests(false);
    }
  }

  // =========================================================================
  // HANDLERS DAS 4 AÇÕES RÁPIDAS
  // =========================================================================

  // 1. ABRIR MESA (INICIAR ATENDIMENTO)
  async function handleConfirmOpenTable(e: FormEvent) {
    e.preventDefault();
    if (!openTableNumber) {
      setError("Selecione uma mesa para abrir.");
      return;
    }
    setOpenTableBusy(true);
    setError("");
    setNotice("");
    try {
      const visit = await openTableVisit(r.slug, openTableNumber);
      if (openCustomerName.trim() && visit?.id) {
        await supabase
          .from("table_tabs")
          .update({ label: openCustomerName.trim() })
          .eq("restaurant_id", r.id)
          .eq("table_visit_id", visit.id);
      }
      setNotice(`Mesa ${String(openTableNumber).padStart(2, "0")} aberta com sucesso!`);
      setIsOpenTableModalOpen(false);
      setOpenCustomerName("");
      setOpenTableNumber(null);
      setRevision((v) => v + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao abrir mesa.");
    } finally {
      setOpenTableBusy(false);
    }
  }

  // 2. CONSULTAR E IMPRIMIR COMANDA
  async function handleLoadTabItems(table: TableItemView) {
    setSelectedConsultTableId(table.id);
    if (!table.visitId) {
      setConsultItems([]);
      return;
    }
    setLoadingConsultItems(true);
    try {
      const { data, error } = await supabase
        .from("table_tab_items")
        .select("id, product_name, quantity, unit_price_in_cents, line_total_in_cents, status, cancelled_at, cancellation_reason")
        .eq("table_visit_id", table.visitId);

      if (error) throw error;
      setConsultItems(data || []);
    } catch (err) {
      console.warn("Falha ao carregar itens da comanda:", err);
    } finally {
      setLoadingConsultItems(false);
    }
  }

  function handlePrintCurrentBill(paperWidth: "80mm" | "58mm" = "80mm") {
    const table = displayTables.find((t) => t.id === selectedConsultTableId);
    if (!table) return;

    const activeItems = consultItems.filter((i) => i.status !== "cancelled");
    const items: ThermalBillItem[] =
      activeItems.length > 0
        ? activeItems.map((i) => ({
            name: i.product_name,
            quantity: i.quantity,
            unitPriceInCents: i.unit_price_in_cents,
            totalInCents: i.line_total_in_cents,
          }))
        : [
            {
              name: "Consumo geral da mesa",
              quantity: 1,
              unitPriceInCents: table.totalInCents,
              totalInCents: table.totalInCents,
            },
          ];

    const subtotal = table.totalInCents;
    const serviceFee = Math.round(subtotal * 0.1);
    const total = subtotal + serviceFee;

    printTableBillThermal({
      restaurantName: r.name,
      tableNumber: String(table.tableNumber).padStart(2, "0"),
      tabLabel: table.customerName !== "-" ? table.customerName : `Mesa ${String(table.tableNumber).padStart(2, "0")}`,
      timestamp: new Date(),
      items,
      subtotalInCents: subtotal,
      serviceFeePercent: 10,
      serviceFeeInCents: serviceFee,
      totalInCents: total,
      paperWidth,
    });
  }

  // 3. FECHAMENTO DE MESA E PAGAMENTO
  async function handleConfirmCloseTable() {
    const table = displayTables.find((t) => t.id === selectedCloseTableId);
    if (!table) return;

    setCloseTableBusy(true);
    setError("");
    setNotice("");
    try {
      const { error } = await supabase.rpc("reset_and_release_table", {
        p_table_id: table.id,
      });
      if (error) throw error;

      if (closePrintReceipt && table.totalInCents > 0) {
        const subtotal = table.totalInCents;
        const fee = closeIncludeServiceFee ? Math.round(subtotal * 0.1) : 0;
        printTableBillThermal({
          restaurantName: r.name,
          tableNumber: String(table.tableNumber).padStart(2, "0"),
          tabLabel: table.customerName !== "-" ? table.customerName : `Mesa ${String(table.tableNumber).padStart(2, "0")}`,
          timestamp: new Date(),
          items: [
            {
              name: "Total do Atendimento",
              quantity: 1,
              unitPriceInCents: subtotal,
              totalInCents: subtotal,
            },
          ],
          subtotalInCents: subtotal,
          serviceFeePercent: closeIncludeServiceFee ? 10 : 0,
          serviceFeeInCents: fee,
          totalInCents: subtotal + fee,
          paperWidth: "80mm",
        });
      }

      setNotice(
        `Mesa ${String(table.tableNumber).padStart(2, "0")} finalizada com sucesso! Pagamento registrado via ${closePaymentMethod.toUpperCase()}.`
      );
      setIsCloseTableModalOpen(false);
      setSelectedCloseTableId(null);
      setRevision((v) => v + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao fechar mesa.");
    } finally {
      setCloseTableBusy(false);
    }
  }

  // 4. RESERVA
  async function handleAddReservation(e: FormEvent) {
    e.preventDefault();
    if (isSubmittingReservation) return;

    if (!reserveTableNumber || !reserveCustomerName.trim()) {
      setError("Preencha o número da mesa e o nome do cliente para a reserva.");
      return;
    }

    const opDate = getOperationalDate(r.timezone);
    setIsSubmittingReservation(true);
    setError("");

    try {
      const created = await createReservation({
        restaurantId: r.id,
        tableNumber: reserveTableNumber,
        customerName: reserveCustomerName.trim(),
        phone: reservePhone.trim(),
        date: opDate,
        time: reserveTime,
        guestsCount: reserveGuestsCount,
        notes: reserveNotes.trim(),
      });

      const newItem = toReservationItem(created);
      setReservations((prev) => {
        const next = [newItem, ...prev.filter((item) => item.id !== newItem.id)];
        return next.sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.time.localeCompare(b.time));
      });
      setNotice(`Reserva confirmada para ${newItem.customerName} na Mesa ${String(newItem.tableNumber).padStart(2, "0")} às ${newItem.time}!`);
      setReserveCustomerName("");
      setReservePhone("");
      setReserveNotes("");
      setReserveTableNumber(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao cadastrar reserva.");
    } finally {
      setIsSubmittingReservation(false);
    }
  }

  async function handleCancelReservation(resId: string) {
    if (isSubmittingReservation) return;
    setIsSubmittingReservation(true);
    setError("");

    try {
      await cancelReservation(resId);
      setReservations((prev) => prev.filter((item) => item.id !== resId));
      setNotice("Reserva cancelada com sucesso.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao cancelar reserva.");
    } finally {
      setIsSubmittingReservation(false);
    }
  }

  async function handleSeatReservation(res: ReservationItem) {
    if (isSubmittingReservation) return;
    setIsSubmittingReservation(true);
    setError("");

    let visitOpened = false;
    try {
      // 1. Abertura do atendimento da mesa
      await openTableVisit(r.slug, res.tableNumber);
      visitOpened = true;

      // 2. Confirmação segura da reserva via RPC com ID explícito
      const seatResult = await seatReservationArrival(r.id, res.tableNumber, res.id);

      if (seatResult.success && seatResult.reservation?.id) {
        const seatedId = seatResult.reservation.id;
        // Atualiza EXCLUSIVAMENTE a reserva confirmada pelo servidor
        setReservations((prev) =>
          prev.map((item) =>
            item.id === seatedId ? { ...item, status: "seated" } : item
          )
        );
        setNotice(`Cliente ${seatResult.reservation.customer_name || res.customerName} acomodado na Mesa ${String(res.tableNumber).padStart(2, "0")}! Atendimento iniciado.`);
      } else if (seatResult.code === 'ALREADY_SEATED') {
        const seatedId = seatResult.reservation?.id ?? res.id;
        setReservations((prev) =>
          prev.map((item) =>
            item.id === seatedId ? { ...item, status: "seated" } : item
          )
        );
        setNotice(`Atendimento iniciado na Mesa ${String(res.tableNumber).padStart(2, "0")}. A reserva já constava como atendida no sistema.`);
      } else {
        setNotice(`Atendimento iniciado na Mesa ${String(res.tableNumber).padStart(2, "0")}, mas a confirmação da reserva falhou: ${seatResult.message}`);
      }

      setIsReservationModalOpen(false);
      setRevision((v) => v + 1);
    } catch (err) {
      if (visitOpened) {
        setError(
          err instanceof Error
            ? `Atendimento aberto na Mesa ${res.tableNumber}, mas ocorreu um erro: ${err.message}`
            : "Atendimento aberto, mas ocorreu um erro ao atualizar dados da reserva."
        );
      } else {
        setError(err instanceof Error ? err.message : "Falha ao iniciar atendimento da reserva.");
      }
    } finally {
      setIsSubmittingReservation(false);
    }
  }

  function handleOpenImportPreview() {
    const tablesReady = !loading && displayTables.length > 0;
    if (!tablesReady) {
      setError("Aguarde o carregamento das mesas do restaurante antes de analisar as reservas locais.");
      return;
    }
    const raw = localStorage.getItem(`elozi_reservas_${r.id}`);
    const activeTableNumbers = new Set(displayTables.map((t) => t.tableNumber));
    const analysis = analyzeLocalReservations(raw, activeTableNumbers, tablesReady, r.id);
    setLocalAnalysis(analysis);
    setImportResult(null);
    setIsImportModalOpen(true);
  }

  async function handleExecuteImport() {
    const tablesReady = !loading && displayTables.length > 0;
    if (!r.id || !tablesReady || isImporting) {
      if (!tablesReady) {
        setError("Não é possível importar reservas enquanto a lista de mesas não estiver carregada e validada.");
      }
      return;
    }

    if (!isWebLocksAvailable()) {
      setError("A API Web Locks não está disponível neste navegador para coordenar com segurança a importação entre abas.");
      return;
    }

    setIsImporting(true);
    setError("");

    let preparedItems: readonly LocalReservationPreviewItem[] = [];

    // FASE 1: Preparação atômica e persistência do manifesto estritamente sob Web Lock
    try {
      preparedItems = await withManifestLock(r.id, async () => {
        const raw = localStorage.getItem(`elozi_reservas_${r.id}`);
        const activeTableNumbers = new Set(displayTables.map((t) => t.tableNumber));
        return await prepareLocalReservationsForImport(r.id, raw, activeTableNumbers, tablesReady);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha na preparação do manifesto local.");
      setIsImporting(false);
      return;
    }

    // FASE 2: Operações de rede no Supabase executadas estritamente FORA do Web Lock
    try {
      const activeTableNumbers = new Set(displayTables.map((t) => t.tableNumber));
      const result = await executeLocalReservationsImport(r.id, preparedItems, tablesReady);
      setImportResult(result);

      if (result.importedCount > 0) {
        setNotice(`${result.importedCount} reserva(s) importada(s) para o banco de dados com sucesso!`);
        const opDate = getOperationalDate(r.timezone);
        const reloaded = await listReservations(r.id, { startDate: opDate, endDate: opDate });
        setReservations(reloaded.map(toReservationItem));
      }

      // Re-análise final da UI (somente leitura) mantendo o localStorage original intacto
      const postRaw = localStorage.getItem(`elozi_reservas_${r.id}`);
      setLocalAnalysis(analyzeLocalReservations(postRaw, activeTableNumbers, tablesReady, r.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha durante a importação para o banco de dados.");
    } finally {
      setIsImporting(false);
    }
  }

  return (
    <div className="mx-auto max-w-[1400px] space-y-5 text-zinc-900 dark:text-zinc-100 antialiased pb-12 pt-0">
      {/* Alertas de Feedback */}
      {error && (
        <div
          role="alert"
          className="flex items-center justify-between p-3.5 rounded-xl border bg-rose-50 text-rose-800 border-rose-200 dark:bg-rose-950/50 dark:text-rose-200 dark:border-rose-900 text-sm font-semibold"
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError("")}
            className="text-xs font-bold opacity-75 hover:opacity-100 cursor-pointer ml-3"
          >
            ✕
          </button>
        </div>
      )}

      {notice && (
        <div
          role="status"
          className="flex items-center justify-between p-3.5 rounded-xl border bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-200 dark:border-emerald-900 text-sm font-semibold"
        >
          <span>{notice}</span>
          <button
            type="button"
            onClick={() => setNotice("")}
            className="text-xs font-bold opacity-75 hover:opacity-100 cursor-pointer ml-3"
          >
            ✕
          </button>
        </div>
      )}

      {/* =========================================================================
          A. CABEÇALHO DA PÁGINA (TOPO)
          ========================================================================= */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pt-0">
        <div>
          <h1 className="text-2xl sm:text-3xl font-black tracking-tight text-zinc-900 dark:text-white">
            Mesas e comandos
          </h1>
          <p className="mt-1 text-xs sm:text-sm text-zinc-500 dark:text-zinc-400">
            Visualize o status das mesas, gerencie atendimentos e acompanhe os pedidos em tempo real.
          </p>
        </div>

        {/* Botão de Ação Primária: + Nova mesa */}
        <div className="flex items-center gap-2.5 flex-wrap">
          <button
            type="button"
            onClick={handleOpenBatchPrint}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#18181b] text-xs sm:text-sm font-semibold text-zinc-700 dark:text-zinc-200 shadow-2xs hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            title="Imprimir QR Codes de todas as mesas"
          >
            <svg
              className="w-4 h-4 text-zinc-500 dark:text-zinc-400"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
            >
              <polyline points="6 9 6 2 18 2 18 9" />
              <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
              <rect x="6" y="14" width="12" height="8" />
            </svg>
            <span className="hidden sm:inline">Imprimir QR (A4)</span>
          </button>

          <button
            type="button"
            onClick={() => {
              const nextNumber =
                tables.length > 0 ? Math.max(...tables.map((t) => t.tableNumber)) + 1 : 1;
              setDraft({
                id: crypto.randomUUID(),
                tableNumber: nextNumber,
                label: "",
                active: true,
                revision: 0,
                visitId: null,
                tabCount: 0,
                totalInCents: 0,
                billPending: false,
              });
            }}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[#610000] hover:bg-[#4d0000] active:scale-[0.98] text-white text-xs sm:text-sm font-semibold shadow-xs transition-all cursor-pointer"
          >
            <span className="text-base font-bold leading-none">+</span>
            <span>Nova mesa</span>
          </button>
        </div>
      </div>

      {/* =========================================================================
          B. LINHA DE CARDS DE RESUMO (MÉTRICAS REAIS SUPERIORES)
          ========================================================================= */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Card 1: Total de mesas */}
        <div
          onClick={() => setActivePill("all")}
          className={`bg-white dark:bg-[#18181b] border ${
            activePill === "all"
              ? "border-zinc-300 dark:border-zinc-700 ring-2 ring-[#610000]/10"
              : "border-zinc-200/80 dark:border-zinc-800"
          } rounded-2xl p-4 shadow-2xs flex items-center gap-3.5 transition-all hover:shadow-xs cursor-pointer`}
        >
          <div className="w-11 h-11 rounded-xl bg-[#f5ece3] text-[#785542] dark:bg-amber-950/40 dark:text-amber-300 flex items-center justify-center shrink-0">
            <svg
              className="w-5 h-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
            >
              <rect x="4" y="8" width="16" height="4" rx="1" />
              <line x1="6" y1="12" x2="6" y2="20" />
              <line x1="18" y1="12" x2="18" y2="20" />
              <path d="M7 8V4a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v4" />
            </svg>
          </div>
          <div className="min-w-0">
            <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
              Total de mesas
            </span>
            <div className="text-2xl font-extrabold text-zinc-900 dark:text-white mt-0.5 leading-tight">
              {metrics.total}
            </div>
            <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">
              {metrics.occupied} ocupada{metrics.occupied !== 1 ? "s" : ""}
            </p>
          </div>
        </div>

        {/* Card 2: Mesas ocupadas */}
        <div
          onClick={() => setActivePill("occupied")}
          className={`bg-white dark:bg-[#18181b] border ${
            activePill === "occupied"
              ? "border-rose-300 dark:border-rose-700 ring-2 ring-rose-500/10"
              : "border-zinc-200/80 dark:border-zinc-800"
          } rounded-2xl p-4 shadow-2xs flex items-center gap-3.5 transition-all hover:shadow-xs cursor-pointer`}
        >
          <div className="w-11 h-11 rounded-xl bg-[#f5ece3] text-[#785542] dark:bg-amber-950/40 dark:text-amber-300 flex items-center justify-center shrink-0">
            <svg
              className="w-5 h-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
            >
              <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
              Mesas ocupadas
            </span>
            <div className="text-2xl font-extrabold text-zinc-900 dark:text-white mt-0.5 leading-tight">
              {metrics.occupied}
            </div>
            <div className="flex items-center gap-2 mt-1">
              <div className="w-20 h-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
                <div
                  className="h-full bg-emerald-500 rounded-full transition-all"
                  style={{ width: `${metrics.occupiedPercent}%` }}
                />
              </div>
              <span className="text-[11px] text-zinc-400 dark:text-zinc-500 font-medium">
                {metrics.occupiedPercent}%
              </span>
            </div>
          </div>
        </div>

        {/* Card 3: Mesas em espera */}
        <div
          onClick={() => setActivePill("waiting")}
          className={`bg-white dark:bg-[#18181b] border ${
            activePill === "waiting"
              ? "border-amber-300 dark:border-amber-700 ring-2 ring-amber-500/10"
              : "border-zinc-200/80 dark:border-zinc-800"
          } rounded-2xl p-4 shadow-2xs flex items-center gap-3.5 transition-all hover:shadow-xs cursor-pointer`}
        >
          <div className="w-11 h-11 rounded-xl bg-amber-100/70 text-amber-600 dark:bg-amber-950/50 dark:text-amber-400 flex items-center justify-center shrink-0">
            <svg
              className="w-5 h-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
            >
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
              Mesas em espera
            </span>
            <div className="text-2xl font-extrabold text-zinc-900 dark:text-white mt-0.5 leading-tight">
              {metrics.waiting}
            </div>
            <div className="flex items-center gap-2 mt-1">
              <div className="w-20 h-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
                <div
                  className="h-full bg-amber-500 rounded-full transition-all"
                  style={{ width: `${metrics.waitingPercent}%` }}
                />
              </div>
              <span className="text-[11px] text-zinc-400 dark:text-zinc-500 font-medium">
                {metrics.waitingPercent}%
              </span>
            </div>
          </div>
        </div>

        {/* Card 4: Mesas livres */}
        <div
          onClick={() => setActivePill("free")}
          className={`bg-white dark:bg-[#18181b] border ${
            activePill === "free"
              ? "border-emerald-300 dark:border-emerald-700 ring-2 ring-emerald-500/10"
              : "border-zinc-200/80 dark:border-zinc-800"
          } rounded-2xl p-4 shadow-2xs flex items-center gap-3.5 transition-all hover:shadow-xs cursor-pointer`}
        >
          <div className="w-11 h-11 rounded-xl bg-emerald-100/70 text-emerald-600 dark:bg-emerald-950/50 dark:text-emerald-400 flex items-center justify-center shrink-0">
            <svg
              className="w-5 h-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
              Mesas livres
            </span>
            <div className="text-2xl font-extrabold text-zinc-900 dark:text-white mt-0.5 leading-tight">
              {metrics.free}
            </div>
            <div className="flex items-center gap-2 mt-1">
              <div className="w-20 h-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
                <div
                  className="h-full bg-emerald-500 rounded-full transition-all"
                  style={{ width: `${metrics.freePercent}%` }}
                />
              </div>
              <span className="text-[11px] text-zinc-400 dark:text-zinc-500 font-medium">
                {metrics.freePercent}%
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* =========================================================================
          C. ABAS DE FILTRO, BARRA DE BUSCA E FILTROS AVANÇADOS
          ========================================================================= */}
      <div className="space-y-3">
        {/* Linha 1: Input de Busca + Selects */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Input de Busca */}
          <div className="relative flex-1 min-w-[260px]">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              placeholder="Buscar por número da mesa, cliente ou pedido..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setCurrentPage(1);
              }}
              className="w-full rounded-xl border border-zinc-200 bg-white pl-9 pr-3.5 py-2.5 text-xs sm:text-sm text-zinc-800 placeholder-zinc-400 focus:border-[#610000] focus:outline-hidden focus:ring-2 focus:ring-[#610000]/15 dark:border-zinc-800 dark:bg-[#18181b] dark:text-zinc-100 dark:placeholder-zinc-500 shadow-2xs"
            />
          </div>

          {/* Select de Status */}
          <div className="relative shrink-0">
            <select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setCurrentPage(1);
              }}
              className="rounded-xl border border-zinc-200 bg-white px-3.5 py-2.5 text-xs sm:text-sm font-semibold text-zinc-700 focus:border-[#610000] focus:outline-hidden focus:ring-2 focus:ring-[#610000]/15 dark:border-zinc-800 dark:bg-[#18181b] dark:text-zinc-200 cursor-pointer shadow-2xs pr-8"
            >
              <option value="all">Status: Todos</option>
              <option value="occupied">Ocupadas</option>
              <option value="free">Livres</option>
              <option value="waiting">Em espera</option>
              <option value="locked">Bloqueadas</option>
              <option value="reserved">Reservadas</option>
            </select>
          </div>

          {/* Select de Área */}
          <div className="relative shrink-0">
            <select
              value={areaFilter}
              onChange={(e) => {
                setAreaFilter(e.target.value);
                setCurrentPage(1);
              }}
              className="rounded-xl border border-zinc-200 bg-white px-3.5 py-2.5 text-xs sm:text-sm font-semibold text-zinc-700 focus:border-[#610000] focus:outline-hidden focus:ring-2 focus:ring-[#610000]/15 dark:border-zinc-800 dark:bg-[#18181b] dark:text-zinc-200 cursor-pointer shadow-2xs pr-8"
            >
              <option value="all">Área: Todas</option>
              {availableAreas.map((area) => (
                <option key={area} value={area}>
                  {area}
                </option>
              ))}
            </select>
          </div>

          {/* Botão de Filtro Avançado */}
          <button
            type="button"
            className="p-2.5 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#18181b] text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors shadow-2xs cursor-pointer"
            title="Mais filtros"
          >
            <svg
              className="w-4 h-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
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
        </div>

        {/* Linha 2: Abas Estilo Pill */}
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => {
              setActivePill("all");
              setCurrentPage(1);
            }}
            className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer ${
              activePill === "all"
                ? "bg-[#610000] text-white shadow-xs"
                : "bg-white dark:bg-[#18181b] border border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            }`}
          >
            Todas ({metrics.total})
          </button>

          <button
            type="button"
            onClick={() => {
              setActivePill("occupied");
              setCurrentPage(1);
            }}
            className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer ${
              activePill === "occupied"
                ? "bg-[#610000] text-white shadow-xs"
                : "bg-white dark:bg-[#18181b] border border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            }`}
          >
            Ocupadas ({metrics.occupied})
          </button>

          <button
            type="button"
            onClick={() => {
              setActivePill("free");
              setCurrentPage(1);
            }}
            className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer ${
              activePill === "free"
                ? "bg-[#610000] text-white shadow-xs"
                : "bg-white dark:bg-[#18181b] border border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            }`}
          >
            Livres ({metrics.free})
          </button>

          <button
            type="button"
            onClick={() => {
              setActivePill("waiting");
              setCurrentPage(1);
            }}
            className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer ${
              activePill === "waiting"
                ? "bg-[#610000] text-white shadow-xs"
                : "bg-white dark:bg-[#18181b] border border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            }`}
          >
            Em espera ({metrics.waiting})
          </button>

          <button
            type="button"
            onClick={() => {
              setActivePill("locked");
              setCurrentPage(1);
            }}
            className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer ${
              activePill === "locked"
                ? "bg-[#610000] text-white shadow-xs"
                : "bg-white dark:bg-[#18181b] border border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            }`}
          >
            Bloqueadas ({metrics.locked})
          </button>

          <button
            type="button"
            onClick={() => {
              setActivePill("reserved");
              setCurrentPage(1);
            }}
            className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer ${
              activePill === "reserved"
                ? "bg-[#610000] text-white shadow-xs"
                : "bg-white dark:bg-[#18181b] border border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            }`}
          >
            Reservadas ({metrics.reserved})
          </button>
        </div>
      </div>

      {/* =========================================================================
          D. LAYOUT EM 2 COLUNAS (ÁREA PRINCIPAL + PAINEL LATERAL DIREITO)
          ========================================================================= */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* =====================================================================
            1. COLUNA ESQUERDA / CENTRAL (TABELA DE MESAS)
            ===================================================================== */}
        <div className="xl:col-span-8 2xl:col-span-9 space-y-4">
          <div className="bg-white dark:bg-[#18181b] border border-zinc-200/80 dark:border-zinc-800 rounded-2xl shadow-2xs overflow-hidden">
            {loading ? (
              <div className="py-16 text-center text-zinc-400 dark:text-zinc-500 text-sm">
                Carregando mesas do restaurante…
              </div>
            ) : filteredTables.length === 0 ? (
              <div className="py-16 text-center text-zinc-400 dark:text-zinc-500">
                <p className="text-base font-semibold text-zinc-700 dark:text-zinc-300">
                  {tables.length === 0
                    ? "Nenhuma mesa cadastrada no seu restaurante"
                    : activePill === "reserved"
                    ? "Nenhuma mesa reservada no momento"
                    : "Nenhuma mesa encontrada com os filtros selecionados"}
                </p>
                <p className="text-xs text-zinc-400 mt-1">
                  {tables.length === 0
                    ? "Clique no botão '+ Nova mesa' acima para cadastrar a primeira mesa do salão."
                    : activePill === "reserved"
                    ? "Você pode agendar uma nova reserva e guardar uma mesa livre para um cliente."
                    : "Tente alterar os termos da busca ou mudar os filtros de status."}
                </p>
                {activePill === "reserved" && (
                  <button
                    type="button"
                    onClick={() => {
                      const free = displayTables.find((t) => t.status === "free");
                      if (free) setReserveTableNumber(free.tableNumber);
                      setIsReservationModalOpen(true);
                    }}
                    className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[#610000] hover:bg-[#7a0000] text-white font-bold text-xs shadow-xs transition-colors cursor-pointer"
                  >
                    <span>+ Nova Reserva</span>
                  </button>
                )}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse min-w-[760px]">
                  <thead>
                    <tr className="border-b border-zinc-200/70 dark:border-zinc-800 text-[11px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider bg-zinc-50/50 dark:bg-zinc-900/50">
                      <th className="py-3.5 px-5">MESA</th>
                      <th className="py-3.5 px-4">ÁREA</th>
                      <th className="py-3.5 px-4">STATUS</th>
                      <th className="py-3.5 px-4">CLIENTE</th>
                      <th className="py-3.5 px-4">TEMPO</th>
                      <th className="py-3.5 px-4">CONTA</th>
                      <th className="py-3.5 px-5 text-right">AÇÕES</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
                    {paginatedTables.map((t) => {
                      const isMenuOpen = openMenuTableId === t.id;

                      // Indicador de cor da borda esquerda
                      let borderClass = "border-l-4 border-emerald-500";
                      if (t.status === "occupied") borderClass = "border-l-4 border-rose-500";
                      else if (t.status === "waiting") borderClass = "border-l-4 border-amber-500";
                      else if (t.status === "locked") borderClass = "border-l-4 border-zinc-400";
                      else if (t.status === "reserved") borderClass = "border-l-4 border-purple-500";

                      return (
                        <tr
                          key={t.id}
                          className="hover:bg-zinc-50/60 dark:hover:bg-zinc-800/40 transition-colors"
                        >
                          {/* MESA (com borda de status colorida) */}
                          <td className={`py-4 px-5 align-middle ${borderClass}`}>
                            <span className="font-black text-sm text-zinc-900 dark:text-white pl-2">
                              {String(t.tableNumber).padStart(2, "0")}
                            </span>
                          </td>

                          {/* ÁREA */}
                          <td className="py-4 px-4 align-middle">
                            <span className="text-xs text-zinc-600 dark:text-zinc-300 font-medium">
                              {t.label}
                            </span>
                          </td>

                          {/* STATUS */}
                          <td className="py-4 px-4 align-middle whitespace-nowrap">
                            {t.status === "occupied" && (
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400 border border-rose-200 dark:border-rose-800/60 shadow-2xs">
                                <svg
                                  className="w-3.5 h-3.5"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                >
                                  <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
                                  <circle cx="12" cy="7" r="4" />
                                </svg>
                                <span>Ocupada</span>
                              </span>
                            )}
                            {t.status === "free" && (
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800/60 shadow-2xs">
                                <svg
                                  className="w-3.5 h-3.5"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                >
                                  <polyline points="20 6 9 17 4 12" />
                                </svg>
                                <span>Livre</span>
                              </span>
                            )}
                            {t.status === "waiting" && (
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400 border border-amber-200 dark:border-amber-800/60 shadow-2xs">
                                <svg
                                  className="w-3.5 h-3.5"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                >
                                  <circle cx="12" cy="12" r="10" />
                                  <polyline points="12 6 12 12 16 14" />
                                </svg>
                                <span>Em espera</span>
                              </span>
                            )}
                            {t.status === "locked" && (
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700 shadow-2xs">
                                <span>Bloqueada</span>
                              </span>
                            )}
                            {t.status === "reserved" && (
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-purple-50 text-purple-700 dark:bg-purple-950/40 dark:text-purple-300 border border-purple-200 dark:border-purple-800/60 shadow-2xs">
                                <svg
                                  className="w-3.5 h-3.5"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                >
                                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                                  <line x1="16" y1="2" x2="16" y2="6" />
                                  <line x1="8" y1="2" x2="8" y2="6" />
                                  <line x1="3" y1="10" x2="21" y2="10" />
                                </svg>
                                <span>Reservada</span>
                              </span>
                            )}
                          </td>

                          {/* CLIENTE */}
                          <td className="py-4 px-4 align-middle whitespace-nowrap">
                            <span
                              className={`text-xs sm:text-sm ${
                                t.customerName !== "-"
                                  ? "font-semibold text-zinc-800 dark:text-zinc-200"
                                  : "text-zinc-400 dark:text-zinc-500"
                              }`}
                            >
                              {t.customerName}
                            </span>
                          </td>

                          {/* TEMPO */}
                          <td className="py-4 px-4 align-middle whitespace-nowrap">
                            <span
                              className={`text-xs ${
                                t.timeElapsed !== "-"
                                  ? "font-semibold text-zinc-700 dark:text-zinc-300"
                                  : "text-zinc-400 dark:text-zinc-500"
                              }`}
                            >
                              {t.timeElapsed}
                            </span>
                          </td>

                          {/* CONTA */}
                          <td className="py-4 px-4 align-middle whitespace-nowrap">
                            <span
                              className={`text-xs sm:text-sm ${
                                t.totalFormatted !== "-"
                                  ? "font-bold text-zinc-900 dark:text-white"
                                  : "text-zinc-400 dark:text-zinc-500"
                              }`}
                            >
                              {t.totalFormatted}
                            </span>
                          </td>

                          {/* AÇÕES */}
                          <td className="py-4 px-5 align-middle text-right">
                            <div className="relative inline-flex items-center justify-end gap-1.5">
                              {/* Botão Contextual: Ver pedido, Acomodar cliente ou Abrir mesa */}
                              {t.status === "occupied" || t.status === "waiting" ? (
                                <button
                                  type="button"
                                  onClick={() => {
                                    void handleLoadTabItems(t);
                                    setIsConsultTabModalOpen(true);
                                  }}
                                  className="px-3 py-1.5 rounded-xl border border-zinc-200/80 dark:border-zinc-700 bg-white hover:bg-zinc-50 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-xs font-semibold text-zinc-700 dark:text-zinc-200 shadow-2xs transition-colors whitespace-nowrap cursor-pointer"
                                >
                                  Ver pedido
                                </button>
                              ) : t.status === "reserved" ? (
                                <button
                                  type="button"
                                  onClick={() => {
                                    const res = reservations.find(
                                      (r) => r.tableNumber === t.tableNumber && isConfirmedReservation(r)
                                    );
                                    if (res) {
                                      void handleSeatReservation(res);
                                    } else {
                                      setOpenTableNumber(t.tableNumber);
                                      setIsOpenTableModalOpen(true);
                                    }
                                  }}
                                  className="px-3 py-1.5 rounded-xl border border-purple-300 bg-purple-600 hover:bg-purple-700 text-xs font-bold text-white shadow-2xs transition-colors whitespace-nowrap cursor-pointer"
                                  title="Acomodar cliente e abrir atendimento"
                                >
                                  Acomodar cliente
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setOpenTableNumber(t.tableNumber);
                                    setIsOpenTableModalOpen(true);
                                  }}
                                  className="px-3 py-1.5 rounded-xl border border-zinc-200/80 dark:border-zinc-700 bg-white hover:bg-zinc-50 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-xs font-semibold text-zinc-700 dark:text-zinc-200 shadow-2xs transition-colors whitespace-nowrap cursor-pointer"
                                >
                                  Abrir mesa
                                </button>
                              )}

                              {/* Menu 3 Pontos */}
                              <button
                                type="button"
                                onClick={() =>
                                  setOpenMenuTableId((prev) => (prev === t.id ? null : t.id))
                                }
                                className="p-1.5 rounded-xl border border-zinc-200/80 dark:border-zinc-700 bg-white hover:bg-zinc-50 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-white transition-colors cursor-pointer shadow-2xs"
                                title="Mais opções da mesa"
                              >
                                <svg
                                  className="w-4 h-4"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                >
                                  <circle cx="12" cy="12" r="1" />
                                  <circle cx="12" cy="5" r="1" />
                                  <circle cx="12" cy="19" r="1" />
                                </svg>
                              </button>

                              {/* Dropdown de Ações */}
                              {isMenuOpen && (
                                <div
                                  ref={menuRef}
                                  className="absolute right-0 top-10 z-30 w-48 rounded-xl border border-zinc-200 bg-white py-1.5 shadow-xl dark:border-zinc-700 dark:bg-zinc-900 animate-in fade-in zoom-in-95 text-left"
                                >
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setOpenMenuTableId(null);
                                      setDraft({
                                        id: t.id,
                                        tableNumber: t.tableNumber,
                                        label: t.label,
                                        active: t.active,
                                        revision: t.revision,
                                        visitId: t.visitId,
                                        tabCount: t.tabCount,
                                        totalInCents: t.totalInCents,
                                        billPending: t.billPending,
                                      });
                                    }}
                                    className="w-full px-3.5 py-2 text-xs font-semibold text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800 flex items-center gap-2 cursor-pointer"
                                  >
                                    <span>⚙️</span>
                                    <span>Configurar mesa</span>
                                  </button>

                                  <button
                                    type="button"
                                    onClick={() => {
                                      setOpenMenuTableId(null);
                                      setViewingQrTable({
                                        id: t.id,
                                        tableNumber: t.tableNumber,
                                        label: t.label,
                                        active: t.active,
                                        revision: t.revision,
                                        visitId: t.visitId,
                                        tabCount: t.tabCount,
                                        totalInCents: t.totalInCents,
                                        billPending: t.billPending,
                                      });
                                    }}
                                    className="w-full px-3.5 py-2 text-xs font-semibold text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800 flex items-center gap-2 cursor-pointer"
                                  >
                                    <span>📷</span>
                                    <span>Ver QR Code</span>
                                  </button>

                                  {(t.status === "occupied" || t.status === "waiting") && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setOpenMenuTableId(null);
                                        setSelectedCloseTableId(t.id);
                                        setIsCloseTableModalOpen(true);
                                      }}
                                      className="w-full px-3.5 py-2 text-xs font-semibold text-emerald-600 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950/40 flex items-center gap-2 cursor-pointer"
                                    >
                                      <span>💳</span>
                                      <span>Fechar conta</span>
                                    </button>
                                  )}

                                  {(t.status === "occupied" || t.status === "waiting") && (
                                    <button
                                      type="button"
                                      disabled={releasingTableId === t.id}
                                      onClick={() => void handleResetAndReleaseTable(t)}
                                      className="w-full px-3.5 py-2 text-xs font-semibold text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950/40 flex items-center gap-2 cursor-pointer"
                                    >
                                      <span>🧹</span>
                                      <span>Liberar / Limpar</span>
                                    </button>
                                  )}

                                  {t.status === "free" && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setOpenMenuTableId(null);
                                        setReserveTableNumber(t.tableNumber);
                                        setIsReservationModalOpen(true);
                                      }}
                                      className="w-full px-3.5 py-2 text-xs font-semibold text-purple-700 hover:bg-purple-50 dark:text-purple-300 dark:hover:bg-purple-950/40 flex items-center gap-2 cursor-pointer"
                                    >
                                      <span>📅</span>
                                      <span>Reservar mesa</span>
                                    </button>
                                  )}

                                  {t.status === "reserved" && (
                                    <>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setOpenMenuTableId(null);
                                          const res = reservations.find(
                                            (r) => r.tableNumber === t.tableNumber && isConfirmedReservation(r)
                                          );
                                          if (res) void handleSeatReservation(res);
                                        }}
                                        className="w-full px-3.5 py-2 text-xs font-semibold text-emerald-600 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950/40 flex items-center gap-2 cursor-pointer"
                                      >
                                        <span>👤</span>
                                        <span>Acomodar cliente</span>
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setOpenMenuTableId(null);
                                          setIsReservationModalOpen(true);
                                        }}
                                        className="w-full px-3.5 py-2 text-xs font-semibold text-purple-700 hover:bg-purple-50 dark:text-purple-300 dark:hover:bg-purple-950/40 flex items-center gap-2 cursor-pointer"
                                      >
                                        <span>📋</span>
                                        <span>Ver reservas</span>
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setOpenMenuTableId(null);
                                          const res = reservations.find(
                                            (r) => r.tableNumber === t.tableNumber && isConfirmedReservation(r)
                                          );
                                          if (res) handleCancelReservation(res.id);
                                        }}
                                        className="w-full px-3.5 py-2 text-xs font-semibold text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/40 flex items-center gap-2 cursor-pointer"
                                      >
                                        <span>❌</span>
                                        <span>Cancelar reserva</span>
                                      </button>
                                    </>
                                  )}

                                  <div className="my-1 border-t border-zinc-100 dark:border-zinc-800" />

                                  <button
                                    type="button"
                                    onClick={() => {
                                      setOpenMenuTableId(null);
                                      setTableToDelete(t);
                                    }}
                                    className="w-full px-3.5 py-2 text-xs font-semibold text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/40 flex items-center gap-2 cursor-pointer"
                                  >
                                    <span>🗑</span>
                                    <span>Excluir mesa</span>
                                  </button>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Rodapé da Tabela: Contador e Paginação */}
            <div className="flex flex-col sm:flex-row items-center justify-between gap-3 p-4 border-t border-zinc-100 dark:border-zinc-800/80 bg-zinc-50/40 dark:bg-zinc-900/40 text-xs">
              <p className="text-zinc-500 dark:text-zinc-400 font-medium">
                Mostrando{" "}
                <span className="font-bold text-zinc-800 dark:text-zinc-200">
                  {paginatedTables.length}
                </span>{" "}
                de{" "}
                <span className="font-bold text-zinc-800 dark:text-zinc-200">
                  {filteredTables.length}
                </span>{" "}
                mesas
              </p>

              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={currentPage <= 1}
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  className="w-7 h-7 rounded-lg border border-zinc-200 bg-white hover:bg-zinc-100 disabled:opacity-30 disabled:cursor-not-allowed dark:border-zinc-700 dark:bg-zinc-800 dark:hover:bg-zinc-700 flex items-center justify-center font-bold text-xs text-zinc-600 dark:text-zinc-300 transition-colors cursor-pointer"
                  title="Página anterior"
                >
                  ‹
                </button>

                {Array.from({ length: totalPages }, (_, i) => i + 1).map((pageNum) => (
                  <button
                    key={pageNum}
                    type="button"
                    onClick={() => setCurrentPage(pageNum)}
                    className={`w-7 h-7 rounded-lg font-bold text-xs transition-colors cursor-pointer ${
                      currentPage === pageNum
                        ? "bg-[#610000] text-white shadow-2xs"
                        : "border border-zinc-200 bg-white hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300"
                    }`}
                  >
                    {pageNum}
                  </button>
                ))}

                <button
                  type="button"
                  disabled={currentPage >= totalPages}
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  className="w-7 h-7 rounded-lg border border-zinc-200 bg-white hover:bg-zinc-100 disabled:opacity-30 disabled:cursor-not-allowed dark:border-zinc-700 dark:bg-zinc-800 dark:hover:bg-zinc-700 flex items-center justify-center font-bold text-xs text-zinc-600 dark:text-zinc-300 transition-colors cursor-pointer"
                  title="Próxima página"
                >
                  ›
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* =====================================================================
            2. COLUNA LATERAL DIREITA (WIDGETS DE ACOMPANHAMENTO)
            ===================================================================== */}
        <div className="xl:col-span-4 2xl:col-span-3 space-y-5">
          {/* Card Superior: Comandos em andamento */}
          <div className="bg-white dark:bg-[#18181b] border border-zinc-200/80 dark:border-zinc-800 rounded-2xl p-5 shadow-2xs">
            <div className="flex items-center justify-between pb-2 mb-2 border-b border-zinc-100 dark:border-zinc-800">
              <div className="flex items-center gap-2">
                <svg
                  className="w-4 h-4 text-zinc-700 dark:text-zinc-300"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z" />
                  <path d="M6 6h10" />
                  <path d="M6 10h10" />
                </svg>
                <h3 className="text-sm font-bold text-zinc-900 dark:text-white">
                  Comandos em andamento
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setActivePill("occupied")}
                className="text-xs font-semibold text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white transition-colors flex items-center gap-1 cursor-pointer"
              >
                <span>Ver todos</span>
                <span aria-hidden="true">→</span>
              </button>
            </div>

            {activeOrdersTables.length === 0 ? (
              <div className="py-8 text-center text-zinc-400 dark:text-zinc-500">
                <div className="w-8 h-8 mx-auto mb-2 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-400 dark:text-zinc-400 flex items-center justify-center">
                  <svg
                    className="w-4 h-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
                <p className="text-xs font-bold text-zinc-700 dark:text-zinc-300">
                  Nenhum comando em andamento
                </p>
                <p className="text-[11px] text-zinc-400 mt-0.5">
                  Todas as mesas estão livres no momento.
                </p>
              </div>
            ) : (
              <div className="space-y-3 pt-1">
                {activeOrdersTables.map((order) => (
                  <div
                    key={order.id}
                    onClick={() => {
                      void handleLoadTabItems(order);
                      setIsConsultTabModalOpen(true);
                    }}
                    className="flex items-center justify-between gap-2.5 py-1.5 border-b border-zinc-50 dark:border-zinc-800/40 last:border-0 hover:bg-zinc-50/60 dark:hover:bg-zinc-800/40 rounded-lg px-1 transition-colors cursor-pointer"
                    title="Clique para ver a comanda desta mesa"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="w-7 h-7 rounded-full bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-400 font-black text-xs flex items-center justify-center shrink-0">
                        {String(order.tableNumber).padStart(2, "0")}
                      </span>
                      <div className="min-w-0">
                        <p className="text-xs font-bold text-zinc-900 dark:text-white truncate">
                          Mesa {String(order.tableNumber).padStart(2, "0")}
                        </p>
                        <p className="text-[11px] text-zinc-400 dark:text-zinc-500 truncate">
                          {order.itemsSummary || "Atendimento ativo"}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[11px] text-zinc-400 dark:text-zinc-500 font-medium">
                        ⏱ {order.timeElapsed}
                      </span>
                      {order.status === "waiting" ? (
                        <span className="text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200/80 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-900 rounded-md px-1.5 py-0.5">
                          Conta solicitada
                        </span>
                      ) : (
                        <span className="text-[10px] font-semibold text-rose-700 bg-rose-50 border border-rose-200/80 dark:bg-rose-950/40 dark:text-rose-400 dark:border-rose-900 rounded-md px-1.5 py-0.5">
                          Em preparo
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Card Médio: Ações rápidas (4 BOTÕES 100% FUNCIONAIS) */}
          <div className="bg-white dark:bg-[#18181b] border border-zinc-200/80 dark:border-zinc-800 rounded-2xl p-5 shadow-2xs">
            <h3 className="text-sm font-bold text-zinc-900 dark:text-white mb-3.5 flex items-center gap-2">
              <svg
                className="w-4 h-4 text-[#610000] dark:text-rose-400"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <span>Ações rápidas</span>
            </h3>

            <div className="grid grid-cols-2 gap-2.5">
              {/* 1. Abrir mesa */}
              <button
                type="button"
                onClick={() => {
                  const free = displayTables.find((t) => t.status === "free");
                  setOpenTableNumber(free ? free.tableNumber : null);
                  setIsOpenTableModalOpen(true);
                }}
                className="p-3 rounded-xl border border-zinc-200/80 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-800/40 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors flex items-start gap-2.5 cursor-pointer shadow-2xs text-left"
              >
                <div className="p-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300 shrink-0">
                  <svg
                    className="w-4 h-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-bold text-zinc-900 dark:text-white leading-tight">
                    Abrir mesa
                  </p>
                  <p className="text-[10px] text-zinc-400 dark:text-zinc-500 mt-0.5 leading-tight">
                    Iniciar novo atendimento
                  </p>
                </div>
              </button>

              {/* 2. Comanda */}
              <button
                type="button"
                onClick={() => {
                  const firstOccupied = displayTables.find(
                    (t) => t.status === "occupied" || t.status === "waiting"
                  );
                  if (firstOccupied) {
                    void handleLoadTabItems(firstOccupied);
                  }
                  setIsConsultTabModalOpen(true);
                }}
                className="p-3 rounded-xl border border-zinc-200/80 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-800/40 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors flex items-start gap-2.5 cursor-pointer shadow-2xs text-left"
              >
                <div className="p-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300 shrink-0">
                  <svg
                    className="w-4 h-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="16" y1="13" x2="8" y2="13" />
                    <line x1="16" y1="17" x2="8" y2="17" />
                    <polyline points="10 9 9 9 8 9" />
                  </svg>
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-bold text-zinc-900 dark:text-white leading-tight">
                    Comanda
                  </p>
                  <p className="text-[10px] text-zinc-400 dark:text-zinc-500 mt-0.5 leading-tight">
                    Consultar / imprimir
                  </p>
                </div>
              </button>

              {/* 3. Fechamento de mesa */}
              <button
                type="button"
                onClick={() => {
                  const firstOccupied = displayTables.find(
                    (t) => t.status === "occupied" || t.status === "waiting"
                  );
                  setSelectedCloseTableId(firstOccupied ? firstOccupied.id : null);
                  setIsCloseTableModalOpen(true);
                }}
                className="p-3 rounded-xl border border-zinc-200/80 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-800/40 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors flex items-start gap-2.5 cursor-pointer shadow-2xs text-left"
              >
                <div className="p-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300 shrink-0">
                  <svg
                    className="w-4 h-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-bold text-zinc-900 dark:text-white leading-tight">
                    Fechamento de mesa
                  </p>
                  <p className="text-[10px] text-zinc-400 dark:text-zinc-500 mt-0.5 leading-tight">
                    Finalizar atendimento
                  </p>
                </div>
              </button>

              {/* 4. Reserva */}
              <button
                type="button"
                onClick={() => {
                  const free = displayTables.find((t) => t.status === "free");
                  setReserveTableNumber(free ? free.tableNumber : null);
                  setIsReservationModalOpen(true);
                }}
                className="p-3 rounded-xl border border-zinc-200/80 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-800/40 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors flex items-start gap-2.5 cursor-pointer shadow-2xs text-left"
              >
                <div className="p-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300 shrink-0">
                  <svg
                    className="w-4 h-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                    <line x1="16" y1="2" x2="16" y2="6" />
                    <line x1="8" y1="2" x2="8" y2="6" />
                    <line x1="3" y1="10" x2="21" y2="10" />
                  </svg>
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-bold text-zinc-900 dark:text-white leading-tight">
                    Reserva
                  </p>
                  <p className="text-[10px] text-zinc-400 dark:text-zinc-500 mt-0.5 leading-tight">
                    Gerenciar reservas
                  </p>
                </div>
              </button>
            </div>
          </div>

          {/* Card Inferior: Dica de Gestão */}
          <div className="bg-[#fbf7f2] dark:bg-amber-950/20 border border-[#f0e6dc] dark:border-amber-900/40 rounded-2xl p-4 shadow-2xs flex items-center gap-3 relative overflow-hidden">
            <div className="w-9 h-9 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300 flex items-center justify-center shrink-0">
              <svg
                className="w-5 h-5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
            </div>
            <div className="min-w-0 relative z-10">
              <p className="text-xs font-bold text-zinc-900 dark:text-white">
                Mantenha seu restaurante em dia!
              </p>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">
                Evite desperdícios, reduza custos e garanta a melhor experiência para seus clientes.
              </p>
            </div>

            {/* Marca d'água decorativa */}
            <div className="absolute right-0 bottom-0 pointer-events-none opacity-20 dark:opacity-10 translate-x-2 translate-y-2">
              <svg
                className="w-20 h-20 text-amber-800"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M12 2a10 10 0 0 0-10 10c0 5.523 4.477 10 10 10s10-4.477 10-10A10 10 0 0 0 12 2z" />
                <path d="M12 6v6l4 2" />
              </svg>
            </div>
          </div>
        </div>
      </div>

      {/* =========================================================================
          MODAIS DAS 4 AÇÕES RÁPIDAS
          ========================================================================= */}

      {/* 1. MODAL: ABRIR MESA (INICIAR NOVO ATENDIMENTO) */}
      {isOpenTableModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4 animate-in fade-in"
        >
          <div className="w-full max-w-md rounded-2xl bg-white dark:bg-zinc-900 p-6 shadow-2xl border border-zinc-200 dark:border-zinc-800 space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-zinc-100 dark:border-zinc-800">
              <div className="flex items-center gap-2">
                <span className="p-2 rounded-xl bg-[#610000]/10 text-[#610000] dark:bg-rose-950/40 dark:text-rose-400">
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                </span>
                <h3 className="font-bold text-base text-zinc-900 dark:text-white">
                  Abrir Atendimento de Mesa
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setIsOpenTableModalOpen(false)}
                className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 text-lg cursor-pointer"
              >
                ✕
              </button>
            </div>

            <form onSubmit={(e) => void handleConfirmOpenTable(e)} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
                  Selecione a Mesa Livre *
                </label>
                {displayTables.filter((t) => t.status === "free").length === 0 ? (
                  <p className="text-xs text-rose-600 font-semibold p-2 bg-rose-50 dark:bg-rose-950/40 rounded-xl">
                    Nenhuma mesa livre no momento. Todas estão ocupadas ou bloqueadas.
                  </p>
                ) : (
                  <select
                    required
                    value={openTableNumber ?? ""}
                    onChange={(e) => setOpenTableNumber(Number(e.target.value))}
                    className="w-full rounded-xl border border-zinc-200 bg-white p-2.5 text-xs sm:text-sm font-semibold text-zinc-800 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 shadow-2xs cursor-pointer"
                  >
                    <option value="">Selecione uma mesa...</option>
                    {displayTables
                      .filter((t) => t.status === "free")
                      .map((t) => (
                        <option key={t.id} value={t.tableNumber}>
                          Mesa {String(t.tableNumber).padStart(2, "0")} — {t.label}
                        </option>
                      ))}
                  </select>
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
                  Nome do Cliente / Identificação da Comanda
                </label>
                <input
                  type="text"
                  placeholder="Ex.: Camila Santos, Mesa VIP..."
                  value={openCustomerName}
                  onChange={(e) => setOpenCustomerName(e.target.value)}
                  className="w-full rounded-xl border border-zinc-200 bg-white p-2.5 text-xs sm:text-sm text-zinc-800 placeholder-zinc-400 focus:border-[#610000] focus:outline-hidden focus:ring-2 focus:ring-[#610000]/15 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 shadow-2xs"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
                  Quantidade de Pessoas
                </label>
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={openGuestsCount}
                  onChange={(e) => setOpenGuestsCount(Number(e.target.value))}
                  className="w-full rounded-xl border border-zinc-200 bg-white p-2.5 text-xs sm:text-sm text-zinc-800 focus:border-[#610000] focus:outline-hidden focus:ring-2 focus:ring-[#610000]/15 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 shadow-2xs"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-zinc-100 dark:border-zinc-800">
                <button
                  type="button"
                  onClick={() => setIsOpenTableModalOpen(false)}
                  className="px-4 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 text-xs font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={openTableBusy || !openTableNumber}
                  className="px-4 py-2 rounded-xl bg-[#610000] hover:bg-[#4d0000] disabled:opacity-50 text-white text-xs font-semibold shadow-xs transition-colors cursor-pointer"
                >
                  {openTableBusy ? "Iniciando…" : "Iniciar Atendimento"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 2. MODAL: CONSULTAR E IMPRIMIR COMANDA */}
      {isConsultTabModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4 animate-in fade-in"
        >
          <div className="w-full max-w-lg rounded-2xl bg-white dark:bg-zinc-900 p-6 shadow-2xl border border-zinc-200 dark:border-zinc-800 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-2 border-b border-zinc-100 dark:border-zinc-800">
              <div className="flex items-center gap-2">
                <span className="p-2 rounded-xl bg-[#610000]/10 text-[#610000] dark:bg-rose-950/40 dark:text-rose-400">
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                </span>
                <h3 className="font-bold text-base text-zinc-900 dark:text-white">
                  Consulta de Comanda
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setIsConsultTabModalOpen(false)}
                className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 text-lg cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div>
              <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
                Selecione a Mesa com Atendimento:
              </label>
              {displayTables.filter((t) => t.visitId !== null).length === 0 ? (
                <p className="text-xs text-zinc-500 p-3 bg-zinc-50 dark:bg-zinc-800/60 rounded-xl">
                  Nenhuma mesa com comanda aberta no momento. Todas estão liberadas.
                </p>
              ) : (
                <select
                  value={selectedConsultTableId ?? ""}
                  onChange={(e) => {
                    const table = displayTables.find((t) => t.id === e.target.value);
                    if (table) void handleLoadTabItems(table);
                    else setSelectedConsultTableId(null);
                  }}
                  className="w-full rounded-xl border border-zinc-200 bg-white p-2.5 text-xs sm:text-sm font-semibold text-zinc-800 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 shadow-2xs cursor-pointer"
                >
                  <option value="">Selecione uma mesa aberta...</option>
                  {displayTables
                    .filter((t) => t.visitId !== null)
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        Mesa {String(t.tableNumber).padStart(2, "0")} — {t.customerName !== "-" ? t.customerName : t.label} ({t.totalFormatted})
                      </option>
                    ))}
                </select>
              )}
            </div>

            {/* Detalhe da Comanda Selecionada */}
            {selectedConsultTableId && (() => {
              const table = displayTables.find((t) => t.id === selectedConsultTableId);
              if (!table) return null;

              const subtotal = table.totalInCents;
              const serviceFee = Math.round(subtotal * 0.1);
              const total = subtotal + serviceFee;

              return (
                <div className="space-y-3 pt-2">
                  <div className="p-3.5 rounded-xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200/80 dark:border-zinc-700/80 flex items-center justify-between">
                    <div>
                      <p className="font-bold text-sm text-zinc-900 dark:text-white">
                        Mesa {String(table.tableNumber).padStart(2, "0")} ({table.label})
                      </p>
                      <p className="text-xs text-zinc-500">
                        Cliente: <strong>{table.customerName}</strong> • Aberta há: {table.timeElapsed}
                      </p>
                    </div>
                    <span className="text-sm font-extrabold text-[#610000] dark:text-rose-400">
                      {money.format(total / 100)}
                    </span>
                  </div>

                  {/* Lista de Itens */}
                  <div>
                    <p className="text-xs font-bold text-zinc-700 dark:text-zinc-300 mb-1.5">
                      Itens lançados na comanda:
                    </p>
                    {loadingConsultItems ? (
                      <p className="text-xs text-zinc-400 py-3 text-center">Consultando itens…</p>
                    ) : consultItems.filter((i) => i.status !== "cancelled").length === 0 ? (
                      <div className="p-3 rounded-xl border border-dashed border-zinc-200 dark:border-zinc-800 text-xs text-zinc-500 text-center">
                        Nenhum item discriminado ou comanda em aberto sem pedidos.
                      </div>
                    ) : (
                      <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                        {consultItems
                          .filter((i) => i.status !== "cancelled")
                          .map((item) => (
                            <div
                              key={item.id}
                              className="flex items-center justify-between text-xs py-1 border-b border-zinc-100 dark:border-zinc-800 last:border-0"
                            >
                              <span className="text-zinc-800 dark:text-zinc-200">
                                <strong>{item.quantity}x</strong> {item.product_name}
                              </span>
                              <span className="font-mono text-zinc-700 dark:text-zinc-300">
                                {money.format(item.line_total_in_cents / 100)}
                              </span>
                            </div>
                          ))}
                      </div>
                    )}
                  </div>

                  {/* Auditoria de Itens Cancelados */}
                  {consultItems.filter((i) => i.status === "cancelled").length > 0 && (
                    <div className="pt-2 border-t border-zinc-200/80 dark:border-zinc-700/80">
                      <div className="flex items-center gap-1.5 mb-2">
                        <span className="w-2 h-2 rounded-full bg-rose-500 shrink-0" />
                        <p className="text-xs font-bold text-rose-700 dark:text-rose-400">
                          Itens cancelados (Auditoria):
                        </p>
                      </div>
                      <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                        {consultItems
                          .filter((i) => i.status === "cancelled")
                          .map((item) => {
                            const formattedTime = item.cancelled_at
                              ? new Date(item.cancelled_at).toLocaleTimeString("pt-BR", {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })
                              : "Horário indisponível";
                            return (
                              <div
                                key={item.id}
                                className="p-2.5 rounded-xl bg-rose-50/70 dark:bg-rose-950/30 border border-rose-200/60 dark:border-rose-900/40 text-xs space-y-1"
                              >
                                <div className="flex items-center justify-between">
                                  <span className="font-semibold text-zinc-800 dark:text-zinc-200 line-through opacity-80">
                                    <strong>{item.quantity}x</strong> {item.product_name}
                                  </span>
                                  <span className="text-[10px] text-zinc-500 font-medium">
                                    {formattedTime}
                                  </span>
                                </div>
                                <div className="text-[11px] text-rose-700 dark:text-rose-300 flex items-start gap-1">
                                  <span className="font-bold shrink-0">Motivo:</span>
                                  <span className="italic">{item.cancellation_reason || "Motivo não informado"}</span>
                                </div>
                              </div>
                            );
                          })}
                      </div>
                    </div>
                  )}

                  {/* Resumo Financeiro */}
                  <div className="p-3 rounded-xl bg-zinc-100/70 dark:bg-zinc-800/70 space-y-1 text-xs">
                    <div className="flex justify-between text-zinc-600 dark:text-zinc-400">
                      <span>Subtotal consumido:</span>
                      <span className="font-mono">{money.format(subtotal / 100)}</span>
                    </div>
                    <div className="flex justify-between text-zinc-600 dark:text-zinc-400">
                      <span>Taxa de serviço sugerida (10%):</span>
                      <span className="font-mono">{money.format(serviceFee / 100)}</span>
                    </div>
                    <div className="flex justify-between text-sm font-bold text-zinc-900 dark:text-white pt-1 border-t border-zinc-200 dark:border-zinc-700">
                      <span>Total estimado:</span>
                      <span className="font-mono text-[#610000] dark:text-rose-400">
                        {money.format(total / 100)}
                      </span>
                    </div>
                  </div>

                  {/* Ações de Impressão */}
                  <div className="flex flex-wrap gap-2 pt-2 border-t border-zinc-100 dark:border-zinc-800">
                    <button
                      type="button"
                      onClick={() => handlePrintCurrentBill("80mm")}
                      className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-zinc-900 hover:bg-black text-white text-xs font-semibold shadow-xs transition-colors cursor-pointer"
                    >
                      <span>🖨️ Imprimir Térmica (80mm)</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handlePrintCurrentBill("58mm")}
                      className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border border-zinc-300 hover:bg-zinc-100 text-zinc-700 dark:text-zinc-200 text-xs font-semibold transition-colors cursor-pointer"
                    >
                      <span>58mm</span>
                    </button>
                  </div>
                </div>
              );
            })()}

            <div className="flex justify-end pt-2 border-t border-zinc-100 dark:border-zinc-800">
              <button
                type="button"
                onClick={() => setIsConsultTabModalOpen(false)}
                className="px-4 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 text-xs font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 3. MODAL: FECHAMENTO DE MESA (FINALIZAR ATENDIMENTO) */}
      {isCloseTableModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4 animate-in fade-in"
        >
          <div className="w-full max-w-md rounded-2xl bg-white dark:bg-zinc-900 p-6 shadow-2xl border border-zinc-200 dark:border-zinc-800 space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-zinc-100 dark:border-zinc-800">
              <div className="flex items-center gap-2">
                <span className="p-2 rounded-xl bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-400">
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </span>
                <h3 className="font-bold text-base text-zinc-900 dark:text-white">
                  Fechamento de Conta da Mesa
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setIsCloseTableModalOpen(false)}
                className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 text-lg cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div>
              <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
                Selecione a Mesa a Fechar:
              </label>
              {displayTables.filter((t) => t.status === "occupied" || t.status === "waiting").length === 0 ? (
                <p className="text-xs text-zinc-500 p-3 bg-zinc-50 dark:bg-zinc-800/60 rounded-xl">
                  Nenhuma mesa com atendimento ativo para fechamento no momento.
                </p>
              ) : (
                <select
                  value={selectedCloseTableId ?? ""}
                  onChange={(e) => setSelectedCloseTableId(e.target.value)}
                  className="w-full rounded-xl border border-zinc-200 bg-white p-2.5 text-xs sm:text-sm font-semibold text-zinc-800 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 shadow-2xs cursor-pointer"
                >
                  <option value="">Selecione a mesa...</option>
                  {displayTables
                    .filter((t) => t.status === "occupied" || t.status === "waiting")
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        Mesa {String(t.tableNumber).padStart(2, "0")} — {t.customerName !== "-" ? t.customerName : t.label} ({t.totalFormatted})
                      </option>
                    ))}
                </select>
              )}
            </div>

            {selectedCloseTableId && (() => {
              const table = displayTables.find((t) => t.id === selectedCloseTableId);
              if (!table) return null;

              const subtotal = table.totalInCents;
              const fee = closeIncludeServiceFee ? Math.round(subtotal * 0.1) : 0;
              const finalTotal = subtotal + fee;

              return (
                <div className="space-y-3 pt-1">
                  {/* Total e Taxa de Serviço */}
                  <div className="p-3.5 rounded-xl bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-200/80 dark:border-zinc-700 space-y-2">
                    <div className="flex justify-between text-xs text-zinc-600 dark:text-zinc-400">
                      <span>Subtotal consumido:</span>
                      <span className="font-mono font-semibold">{money.format(subtotal / 100)}</span>
                    </div>

                    <label className="flex items-center justify-between text-xs cursor-pointer">
                      <span className="text-zinc-700 dark:text-zinc-300">Incluir taxa de serviço (10%):</span>
                      <input
                        type="checkbox"
                        checked={closeIncludeServiceFee}
                        onChange={(e) => setCloseIncludeServiceFee(e.target.checked)}
                        className="rounded text-[#610000] focus:ring-[#610000]"
                      />
                    </label>

                    <div className="flex justify-between text-base font-black text-zinc-900 dark:text-white pt-2 border-t border-zinc-200 dark:border-zinc-700">
                      <span>Total a Pagar:</span>
                      <span className="font-mono text-emerald-600 dark:text-emerald-400">
                        {money.format(finalTotal / 100)}
                      </span>
                    </div>
                  </div>

                  {/* Forma de Pagamento */}
                  <div>
                    <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5">
                      Forma de Pagamento:
                    </label>
                    <div className="grid grid-cols-3 gap-1.5 text-xs">
                      {[
                        ["pix", "PIX"],
                        ["credit", "Crédito"],
                        ["debit", "Débito"],
                        ["cash", "Dinheiro"],
                        ["other", "Outro"],
                      ].map(([val, label]) => (
                        <button
                          key={val}
                          type="button"
                          onClick={() => setClosePaymentMethod(val as any)}
                          className={`py-2 px-2 rounded-xl font-bold border transition-all cursor-pointer ${
                            closePaymentMethod === val
                              ? "bg-[#610000] text-white border-[#610000] shadow-xs"
                              : "border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50"
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Imprimir comprovante */}
                  <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400 cursor-pointer pt-1">
                    <input
                      type="checkbox"
                      checked={closePrintReceipt}
                      onChange={(e) => setClosePrintReceipt(e.target.checked)}
                      className="rounded text-[#610000] focus:ring-[#610000]"
                    />
                    <span>Emitir cupom fiscal / comprovante de fechamento</span>
                  </label>

                  <div className="flex justify-end gap-2 pt-2 border-t border-zinc-100 dark:border-zinc-800">
                    <button
                      type="button"
                      onClick={() => setIsCloseTableModalOpen(false)}
                      className="px-4 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 text-xs font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
                    >
                      Cancelar
                    </button>
                    <button
                      type="button"
                      disabled={closeTableBusy}
                      onClick={() => void handleConfirmCloseTable()}
                      className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold shadow-xs transition-colors cursor-pointer"
                    >
                      {closeTableBusy ? "Finalizando…" : "Confirmar Pagamento e Liberar"}
                    </button>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* 4. MODAL: RESERVA (GERENCIAR RESERVAS) */}
      {isReservationModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4 animate-in fade-in"
        >
          <div className="w-full max-w-lg rounded-2xl bg-white dark:bg-zinc-900 p-6 shadow-2xl border border-zinc-200 dark:border-zinc-800 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-2 border-b border-zinc-100 dark:border-zinc-800">
              <div className="flex items-center gap-2">
                <span className="p-2 rounded-xl bg-[#610000]/10 text-[#610000] dark:bg-rose-950/40 dark:text-rose-400">
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                    <line x1="16" y1="2" x2="16" y2="6" />
                    <line x1="8" y1="2" x2="8" y2="6" />
                    <line x1="3" y1="10" x2="21" y2="10" />
                  </svg>
                </span>
                <h3 className="font-bold text-base text-zinc-900 dark:text-white">
                  Gerenciamento de Reservas
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setIsReservationModalOpen(false)}
                className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 text-lg cursor-pointer"
              >
                ✕
              </button>
            </div>

            {/* Banner de Migração Explícita das Reservas Locais */}
            {localAnalysis && localAnalysis.total > 0 && (
              <div className="p-3.5 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-xs text-amber-900 dark:text-amber-200 space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-bold">Reservas em armazenamento local ({localAnalysis.total})</p>
                    <p className="text-[11px] text-amber-700 dark:text-amber-400 mt-0.5">
                      {localAnalysis.validCount} registro(s) prontos para importação.
                      {localAnalysis.invalidCount > 0 && ` (${localAnalysis.invalidCount} com inconsistências)`}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleOpenImportPreview}
                    className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs shrink-0 transition-colors cursor-pointer"
                  >
                    Ver Prévia de Importação
                  </button>
                </div>
              </div>
            )}

            {/* Formulário de Nova Reserva */}
            <form onSubmit={handleAddReservation} className="p-4 rounded-xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200/80 dark:border-zinc-700/80 space-y-3">
              <p className="text-xs font-bold text-zinc-800 dark:text-zinc-200">
                + Nova Reserva para Hoje
              </p>

              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-[11px] font-semibold text-zinc-600 dark:text-zinc-400 mb-1">
                    Mesa Livre *
                  </label>
                  <select
                    required
                    value={reserveTableNumber ?? ""}
                    onChange={(e) => setReserveTableNumber(Number(e.target.value))}
                    className="w-full rounded-xl border border-zinc-200 bg-white p-2 text-xs font-semibold text-zinc-800 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 shadow-2xs"
                  >
                    <option value="">Selecione...</option>
                    {displayTables
                      .filter((t) => t.status === "free")
                      .map((t) => (
                        <option key={t.id} value={t.tableNumber}>
                          Mesa {String(t.tableNumber).padStart(2, "0")} ({t.label})
                        </option>
                      ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-zinc-600 dark:text-zinc-400 mb-1">
                    Horário *
                  </label>
                  <input
                    type="time"
                    required
                    value={reserveTime}
                    onChange={(e) => setReserveTime(e.target.value)}
                    className="w-full rounded-xl border border-zinc-200 bg-white p-2 text-xs text-zinc-800 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 shadow-2xs"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-[11px] font-semibold text-zinc-600 dark:text-zinc-400 mb-1">
                    Nome do Titular *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="Ex.: Roberto Ferreira"
                    value={reserveCustomerName}
                    onChange={(e) => setReserveCustomerName(e.target.value)}
                    className="w-full rounded-xl border border-zinc-200 bg-white p-2 text-xs text-zinc-800 placeholder-zinc-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 shadow-2xs"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-zinc-600 dark:text-zinc-400 mb-1">
                    Telefone / WhatsApp
                  </label>
                  <input
                    type="tel"
                    placeholder="(11) 98765-4321"
                    value={reservePhone}
                    onChange={(e) => setReservePhone(e.target.value)}
                    className="w-full rounded-xl border border-zinc-200 bg-white p-2 text-xs text-zinc-800 placeholder-zinc-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 shadow-2xs"
                  />
                </div>
              </div>

              <div className="flex justify-end pt-1">
                <button
                  type="submit"
                  disabled={isSubmittingReservation}
                  className="px-4 py-1.5 rounded-xl bg-[#610000] hover:bg-[#4d0000] disabled:opacity-50 text-white text-xs font-semibold shadow-xs transition-colors cursor-pointer"
                >
                  {isSubmittingReservation ? "Gravando..." : "Registrar Reserva"}
                </button>
              </div>
            </form>

            {/* Lista de Reservas Ativas */}
            {(() => {
              if (reservationsLoading) {
                return (
                  <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 text-xs text-zinc-500 text-center animate-pulse">
                    Carregando reservas do servidor...
                  </div>
                );
              }

              if (reservationsError) {
                return (
                  <div className="p-3 rounded-xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 text-xs text-rose-700 dark:text-rose-400">
                    {reservationsError}
                  </div>
                );
              }

              const activeList = reservations.filter((res) => isConfirmedReservation(res));
              return (
                <div>
                  <p className="text-xs font-bold text-zinc-800 dark:text-zinc-200 mb-2">
                    Reservas Agendadas ({activeList.length}):
                  </p>
                  {activeList.length === 0 ? (
                    <div className="p-4 rounded-xl border border-dashed border-zinc-200 dark:border-zinc-800 text-xs text-zinc-400 text-center">
                      Nenhuma reserva ativa cadastrada para o dia.
                    </div>
                  ) : (
                    <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                      {activeList.map((res) => (
                        <div
                          key={res.id}
                          className="p-3 rounded-xl border border-zinc-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-900 flex items-center justify-between gap-3 text-xs shadow-2xs"
                        >
                          <div>
                            <p className="font-bold text-zinc-900 dark:text-white">
                              Mesa {String(res.tableNumber).padStart(2, "0")} — {res.customerName}
                            </p>
                            <p className="text-[11px] text-zinc-500">
                              Horário: <strong>{res.time}</strong> • {res.guestsCount} pessoas • {res.phone || "Sem tel."}
                            </p>
                          </div>

                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={isSubmittingReservation}
                              onClick={() => void handleSeatReservation(res)}
                              className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-bold text-[11px] transition-colors cursor-pointer"
                              title="Acomodar cliente e abrir atendimento"
                            >
                              Acomodar
                            </button>
                            <button
                              type="button"
                              disabled={isSubmittingReservation}
                              onClick={() => handleCancelReservation(res.id)}
                              className="p-1 rounded-lg text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 disabled:opacity-50 text-xs cursor-pointer"
                              title="Cancelar reserva"
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}

            <div className="flex justify-end pt-2 border-t border-zinc-100 dark:border-zinc-800">
              <button
                type="button"
                onClick={() => setIsReservationModalOpen(false)}
                className="px-4 py-2 rounded-xl bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-xs font-semibold text-zinc-700 dark:text-zinc-200 cursor-pointer"
              >
                Concluir
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 5. MODAL: PRÉVIA E IMPORTAÇÃO EXPLÍCITA DE RESERVAS LOCAIS */}
      {isImportModalOpen && localAnalysis && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in"
        >
          <div className="w-full max-w-xl rounded-2xl bg-white dark:bg-zinc-900 p-6 shadow-2xl border border-zinc-200 dark:border-zinc-800 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-2 border-b border-zinc-100 dark:border-zinc-800">
              <div>
                <h3 className="font-bold text-base text-zinc-900 dark:text-white">
                  Prévia de Importação das Reservas Locais
                </h3>
                <p className="text-xs text-zinc-500">
                  Os dados locais são preservados. Registros duplicados são evitados de forma segura.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsImportModalOpen(false)}
                className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 text-lg cursor-pointer"
              >
                ✕
              </button>
            </div>

            {/* Alerta de Manifesto ou Reconciliação se houver */}
            {localAnalysis.manifestError && (
              <div className="p-3.5 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-rose-800 dark:text-rose-200 text-xs">
                <strong>Atenção:</strong> {localAnalysis.manifestError}
              </div>
            )}

            {/* Resumo de Validação */}
            <div className="grid grid-cols-3 gap-2 text-center text-xs">
              <div className="p-2.5 rounded-xl bg-zinc-100 dark:bg-zinc-800">
                <span className="block font-bold text-zinc-900 dark:text-white text-sm">
                  {localAnalysis.total}
                </span>
                <span className="text-zinc-500 text-[11px]">Total no Storage</span>
              </div>
              <div className="p-2.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300">
                <span className="block font-bold text-sm">
                  {localAnalysis.validCount}
                </span>
                <span className="text-[11px]">Prontas para Importar</span>
              </div>
              <div className="p-2.5 rounded-xl bg-rose-50 dark:bg-rose-950/40 text-rose-800 dark:text-rose-300">
                <span className="block font-bold text-sm">
                  {localAnalysis.invalidCount}
                </span>
                <span className="text-[11px]">Incompletas / Inválidas</span>
              </div>
            </div>

            {/* Resultado da Execução, se já executado */}
            {importResult && (
              <div className="p-3.5 rounded-xl bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-200 dark:border-zinc-700 text-xs space-y-2">
                <p className="font-bold text-zinc-900 dark:text-white">
                  Resultado do Processamento:
                </p>
                <div className="flex flex-wrap gap-2 text-[11px] font-semibold">
                  <span className="px-2 py-1 rounded-md bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-300">
                    ✓ {importResult.importedCount} importada(s)
                  </span>
                  <span className="px-2 py-1 rounded-md bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-300">
                    ⟳ {importResult.alreadyExistsCount} já existente(s)
                  </span>
                  <span className="px-2 py-1 rounded-md bg-zinc-200 text-zinc-800 dark:bg-zinc-700 dark:text-zinc-300">
                    ⊘ {importResult.invalidCount} rejeitada(s)
                  </span>
                  {importResult.errorCount > 0 && (
                    <span className="px-2 py-1 rounded-md bg-rose-100 text-rose-800 dark:bg-rose-900/60 dark:text-rose-300">
                      ✕ {importResult.errorCount} com erro
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Lista dos Registros Analisados */}
            <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
              {localAnalysis.items.map((item, idx) => {
                const outcomeDetail = importResult?.details.find(
                  (d) => d.customerName === item.customerName && d.tableNumber === item.tableNumber && d.date === item.date && d.time === item.time
                );
                return (
                  <div
                    key={`${item.id}-${idx}`}
                    className={`p-3 rounded-xl border text-xs shadow-2xs ${
                      item.isValid
                        ? "border-emerald-200/80 bg-emerald-50/20 dark:border-emerald-900/40 dark:bg-emerald-950/10"
                        : "border-rose-200/80 bg-rose-50/20 dark:border-rose-900/40 dark:bg-rose-950/10"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-bold text-zinc-900 dark:text-white">
                          Mesa {String(item.tableNumber).padStart(2, "0")} — {item.customerName}
                        </p>
                        <p className="text-[11px] text-zinc-500 mt-0.5">
                          Data: <strong>{item.date || "(Ausente)"}</strong> às <strong>{item.time || "(Ausente)"}</strong> • {item.guestsCount} pessoas • Status original: <em>{item.status}</em>
                        </p>
                      </div>
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-bold shrink-0 ${
                          outcomeDetail
                            ? outcomeDetail.outcome === 'imported'
                              ? "bg-emerald-600 text-white"
                              : outcomeDetail.outcome === 'already_exists'
                              ? "bg-amber-600 text-white"
                              : "bg-rose-600 text-white"
                            : item.isValid
                            ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300"
                            : "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300"
                        }`}
                      >
                        {outcomeDetail
                          ? outcomeDetail.outcome === 'imported'
                            ? "Importada"
                            : outcomeDetail.outcome === 'already_exists'
                            ? "Já no banco"
                            : outcomeDetail.outcome === 'invalid'
                            ? "Rejeitada"
                            : "Erro"
                          : item.isValid
                          ? "Válida"
                          : "Incompleta"}
                      </span>
                    </div>

                    {!item.isValid && (
                      <p className="text-[11px] text-rose-600 dark:text-rose-400 mt-1.5 font-medium">
                        Motivo: {item.validationErrors.join(" • ")}
                      </p>
                    )}
                    {outcomeDetail && (
                      <p className="text-[11px] text-zinc-600 dark:text-zinc-400 mt-1">
                        Mensagem: {outcomeDetail.message}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Ações */}
            <div className="flex justify-between items-center pt-2 border-t border-zinc-100 dark:border-zinc-800">
              <button
                type="button"
                onClick={() => setIsImportModalOpen(false)}
                className="px-4 py-2 rounded-xl bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-xs font-semibold text-zinc-700 dark:text-zinc-200 cursor-pointer"
              >
                Fechar
              </button>
              <button
                type="button"
                disabled={isImporting || localAnalysis.validCount === 0}
                onClick={() => void handleExecuteImport()}
                className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-bold shadow-xs transition-colors cursor-pointer"
              >
                {isImporting ? "Importando para Nuvem..." : `Confirmar Importação (${localAnalysis.validCount} válidas)`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =========================================================================
          DEMAIS MODAIS DO SISTEMA
          ========================================================================= */}

      {/* Modal: Cadastrar / Configurar Mesa */}
      {draft && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4 animate-in fade-in"
        >
          <div className="w-full max-w-md rounded-2xl bg-white dark:bg-zinc-900 p-6 shadow-2xl border border-zinc-200 dark:border-zinc-800 space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-zinc-100 dark:border-zinc-800">
              <h3 className="font-bold text-base text-zinc-900 dark:text-white">
                {draft.revision ? "Configurar mesa" : "Cadastrar nova mesa"}
              </h3>
              <button
                type="button"
                onClick={() => setDraft(null)}
                className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 text-lg cursor-pointer"
              >
                ✕
              </button>
            </div>

            <form onSubmit={(e) => void submitTable(e)} className="space-y-4">
              <fieldset disabled={busy} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
                    Número da mesa
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={999}
                    required
                    value={draft.tableNumber || ""}
                    onChange={(e) =>
                      setDraft({ ...draft, tableNumber: Number(e.target.value) })
                    }
                    className="w-full rounded-xl border border-zinc-200 bg-white p-2.5 text-xs sm:text-sm text-zinc-800 focus:border-[#610000] focus:outline-hidden focus:ring-2 focus:ring-[#610000]/15 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 shadow-2xs"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
                    Área ou Identificação
                  </label>
                  <input
                    maxLength={80}
                    value={draft.label}
                    placeholder="Ex.: Salão ou Varanda"
                    onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                    className="w-full rounded-xl border border-zinc-200 bg-white p-2.5 text-xs sm:text-sm text-zinc-800 placeholder-zinc-400 focus:border-[#610000] focus:outline-hidden focus:ring-2 focus:ring-[#610000]/15 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 shadow-2xs"
                  />
                </div>

                <div className="pt-1">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={draft.active}
                      onChange={(e) => setDraft({ ...draft, active: e.target.checked })}
                      className="rounded text-[#610000] focus:ring-[#610000]"
                    />
                    <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                      Mesa ativa para atendimento digital
                    </span>
                  </label>
                  <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-1">
                    Ao desativar, os QR Codes existentes e o histórico permanecem protegidos.
                  </p>
                </div>

                {/* Chamados da Mesa */}
                {draft.revision > 0 && (
                  <div className="p-3 rounded-xl bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-200/80 dark:border-zinc-700/60 space-y-2">
                    <h4 className="text-xs font-bold text-zinc-800 dark:text-zinc-200">
                      Chamados de garçom ativos
                    </h4>
                    {loadingRequestsSummary ? (
                      <p className="text-[11px] text-zinc-400">Consultando chamados…</p>
                    ) : (
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-zinc-500">
                          {tableRequestsSummary?.totalCount ?? 0} chamado(s) em aberto
                        </span>
                        {(tableRequestsSummary?.totalCount ?? 0) > 0 && (
                          <button
                            type="button"
                            disabled={dismissingRequests}
                            onClick={() => void handleDismissTableRequests()}
                            className="text-xs font-bold text-amber-600 hover:underline cursor-pointer"
                          >
                            Encerrar chamados
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}

                <div className="flex justify-end gap-2 pt-2 border-t border-zinc-100 dark:border-zinc-800">
                  <button
                    type="button"
                    onClick={() => setDraft(null)}
                    className="px-4 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 text-xs font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    disabled={busy}
                    className="px-4 py-2 rounded-xl bg-[#610000] hover:bg-[#4d0000] disabled:opacity-50 text-white text-xs font-semibold shadow-xs transition-colors cursor-pointer"
                  >
                    {busy ? "Salvando…" : "Salvar mesa"}
                  </button>
                </div>
              </fieldset>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Excluir Mesa */}
      {tableToDelete && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4 animate-in fade-in"
        >
          <div className="w-full max-w-sm rounded-2xl bg-white dark:bg-zinc-900 p-5 shadow-2xl border border-zinc-200 dark:border-zinc-800 space-y-3">
            <h3 className="font-bold text-base text-zinc-900 dark:text-white">
              Excluir Mesa {String(tableToDelete.tableNumber).padStart(2, "0")}?
            </h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Esta ação removerá a mesa do salão. Tem certeza que deseja prosseguir?
            </p>
            <div className="flex justify-end gap-2 pt-2 border-t border-zinc-100 dark:border-zinc-800">
              <button
                type="button"
                disabled={deletingTable}
                onClick={() => setTableToDelete(null)}
                className="px-3.5 py-1.5 rounded-xl border border-zinc-200 dark:border-zinc-700 text-xs font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={deletingTable}
                onClick={() => void handleDeleteTable()}
                className="px-3.5 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold cursor-pointer"
              >
                {deletingTable ? "Excluindo…" : "Sim, excluir"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Individual de Visualização e Download do QR Code */}
      {viewingQrTable && (
        <IndividualQrModal
          restaurant={r}
          table={viewingQrTable}
          onClose={() => setViewingQrTable(null)}
          onPrintSingle={handlePrintSingleTable}
        />
      )}

      {/* Modal de Pré-visualização de Impressão em Lote (A4) */}
      {isBatchPreviewOpen && (
        <BatchPrintPreviewModal
          restaurant={r}
          printableTables={printableTables}
          totalTablesCount={tables.length}
          onClose={() => setIsBatchPreviewOpen(false)}
          onConfirmPrint={handleConfirmBatchPrint}
        />
      )}

      {/* Grade de Impressão em Folha A4 (Visível exclusivamente no window.print()) */}
      <PrintableTableQRCodes
        restaurant={r}
        tables={singlePrintTable ? [singlePrintTable] : printableTables}
      />
    </div>
  );
}

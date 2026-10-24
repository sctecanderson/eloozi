import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useOutletContext } from "react-router";
import { useRestaurant } from "../restaurants/RestaurantProvider";
import {
  getAdminTables,
  uploadIdentity,
  type AdminTable,
} from "./restaurantAdmin";
import { preparePhoto } from "./menuMedia";
import { ImageCropModal } from "./ImageCropModal";
import { supabase } from "../../lib/supabase";
import type { StaffAccess } from "../auth/staffAuth";

const currency = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

interface ActivityItem {
  id: string;
  type: "order" | "payment" | "customer" | "stock" | "closure";
  title: string;
  description: string;
  timeFormatted: string;
  timestamp: string;
}

interface TopMenuProduct {
  id: string;
  name: string;
  imageUrl: string | null;
  unitPriceCents: number;
  quantitySold: number;
  revenueCents: number;
  sharePct: number;
}

interface DailyChartPoint {
  dateKey: string;
  label: string;
  salesCents: number;
  ordersCount: number;
  isToday: boolean;
}

const PRESET_COLORS = [
  { name: "Vinho", hex: "#610000" },
  { name: "Café", hex: "#3B1406" },
  { name: "Terracota", hex: "#722D08" },
  { name: "Carvão", hex: "#18181B" },
  { name: "Verde Escuro", hex: "#064E3B" },
];

function formatTimeHHMM(isoString: string): string {
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return "--:--";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function buildSparklinePoints(values: number[], width = 88, height = 28): string {
  if (values.length === 0) return `M 0 ${height - 4} L ${width} ${height - 4}`;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = Math.max(max - min, 1);
  return values
    .map((v, idx) => {
      const x = (idx / Math.max(values.length - 1, 1)) * width;
      const y = height - 4 - ((v - min) / range) * (height - 8);
      return `${idx === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}

export function AdminOverview() {
  const { restaurant: r, reload } = useRestaurant();
  const access = useOutletContext<StaffAccess | null>();

  // Logo desacoplada do cardápio público (exclusiva do Dashboard e Sidebar)
  const [dashboardLogoUrl, setDashboardLogoUrl] = useState<string | null>(() => {
    try {
      return (
        localStorage.getItem(`elozi_dashboard_logo_${r.id}`) ||
        r.dashboardLogoUrl ||
        localStorage.getItem(`elozi_restaurant_logo_${r.id}`) ||
        null
      );
    } catch {
      return r.dashboardLogoUrl || null;
    }
  });

  const [logoUploading, setLogoUploading] = useState(false);
  const logoFileInputRef = useRef<HTMLInputElement>(null);
  const logoUploadCache = useRef(new Map<string, string>());
  const [cropTarget, setCropTarget] = useState<"logo" | "banner" | null>(null);
  const [cropRawSrc, setCropRawSrc] = useState<string | null>(null);
  const logoUrl = dashboardLogoUrl;

  useEffect(() => {
    function handleUpdate(ev: Event) {
      const detail = (ev as CustomEvent<{ restaurantId: string; logoUrl: string | null }>).detail;
      if (detail?.restaurantId === r.id) {
        setDashboardLogoUrl(detail.logoUrl);
      }
    }
    window.addEventListener("elozi-dashboard-logo-updated", handleUpdate);
    return () => window.removeEventListener("elozi-dashboard-logo-updated", handleUpdate);
  }, [r.id]);

  const handleLogoFileChange = async (file: File) => {
    try {
      setLogoUploading(true);
      // 1. Atualização otimista imediata (Dashboard + Rodapé da Sidebar)
      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target?.result as string;
        if (dataUrl) {
          setDashboardLogoUrl(dataUrl);
          try {
            localStorage.setItem(`elozi_dashboard_logo_${r.id}`, dataUrl);
            window.dispatchEvent(
              new CustomEvent("elozi-dashboard-logo-updated", {
                detail: { restaurantId: r.id, logoUrl: dataUrl },
              })
            );
          } catch {}
        }
      };
      reader.readAsDataURL(file);

      // 2. Upload para o Supabase Storage (sem alterar a identidade/logo do cardápio público)
      const draftPhoto = await preparePhoto(file, `${r.name}-dashboard-logo`);
      const uploadedMedia = await uploadIdentity(
        draftPhoto,
        r.id,
        logoUploadCache.current
      );
      if (uploadedMedia) {
        setDashboardLogoUrl(uploadedMedia.url);
        try {
          localStorage.setItem(`elozi_dashboard_logo_${r.id}`, uploadedMedia.url);
          window.dispatchEvent(
            new CustomEvent("elozi-dashboard-logo-updated", {
              detail: { restaurantId: r.id, logoUrl: uploadedMedia.url },
            })
          );
        } catch {}

        if (supabase) {
          try {
            await supabase.rpc("save_dashboard_media", {
              p_restaurant_id: r.id,
              p_dashboard_logo_url: uploadedMedia.url,
            });
          } catch {}
        }
      }
    } catch (err) {
      console.error("Erro ao atualizar logo do painel:", err);
    } finally {
      setLogoUploading(false);
    }
  };

  // Relógio em tempo real
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const timeFormatted = useMemo(() => {
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }, [now]);

  const dateFormatted = useMemo(() => {
    const d = now.getDate();
    const months = [
      "janeiro",
      "fevereiro",
      "março",
      "abril",
      "maio",
      "junho",
      "julho",
      "agosto",
      "setembro",
      "outubro",
      "novembro",
      "dezembro",
    ];
    const m = months[now.getMonth()];
    const y = now.getFullYear();
    return `Hoje, ${d} de ${m} de ${y}`;
  }, [now]);

  // Personalização do Banner (persistido localmente)
  const [bannerMode, setBannerMode] = useState<"image" | "color">(() => {
    try {
      return (
        (localStorage.getItem(`elozi_banner_mode_${r.id}`) as "image" | "color") ||
        "image"
      );
    } catch {
      return "image";
    }
  });

  const [bannerColor, setBannerColor] = useState(() => {
    try {
      return localStorage.getItem(`elozi_banner_color_${r.id}`) || "#3B1406";
    } catch {
      return "#3B1406";
    }
  });

  const [bannerImage, setBannerImage] = useState(() => {
    try {
      return (
        localStorage.getItem(`elozi_dashboard_banner_${r.id}`) ||
        r.dashboardBannerUrl ||
        localStorage.getItem(`elozi_banner_image_${r.id}`) ||
        "https://images.unsplash.com/photo-1544025162-d76694265947?w=1600&auto=format&fit=crop&q=80"
      );
    } catch {
      return (
        r.dashboardBannerUrl ||
        "https://images.unsplash.com/photo-1544025162-d76694265947?w=1600&auto=format&fit=crop&q=80"
      );
    }
  });

  const [showBannerModal, setShowBannerModal] = useState(false);
  const bannerFileInputRef = useRef<HTMLInputElement>(null);

  const saveBannerConfig = async (mode: "image" | "color", col: string, img: string) => {
    setBannerMode(mode);
    setBannerColor(col);
    setBannerImage(img);
    try {
      localStorage.setItem(`elozi_banner_mode_${r.id}`, mode);
      localStorage.setItem(`elozi_banner_color_${r.id}`, col);
      localStorage.setItem(`elozi_dashboard_banner_${r.id}`, img);
      localStorage.setItem(`elozi_banner_image_${r.id}`, img);
    } catch {}

    if (mode === "image" && img.startsWith("http") && supabase) {
      try {
        await supabase.rpc("save_dashboard_media", {
          p_restaurant_id: r.id,
          p_dashboard_banner_url: img,
        });
      } catch {}
    }
  };

  const handleBannerFileCropConfirm = async (croppedFile: File) => {
    // 1. Otimista imediato
    const reader = new FileReader();
    reader.onload = (ev) => {
      const res = ev.target?.result as string;
      if (res) void saveBannerConfig("image", bannerColor, res);
    };
    reader.readAsDataURL(croppedFile);

    // 2. Upload para o Supabase Storage (sem alterar a capa do cardápio público)
    try {
      const draftPhoto = await preparePhoto(croppedFile, `${r.name}-dashboard-banner`);
      const uploaded = await uploadIdentity(
        draftPhoto,
        r.id,
        logoUploadCache.current
      );
      if (uploaded?.url) {
        void saveBannerConfig("image", bannerColor, uploaded.url);
      }
    } catch (err) {
      console.error("Erro ao enviar banner para storage:", err);
    }
  };

  // Estados de dados reais do Supabase
  const [tables, setTables] = useState<AdminTable[]>([]);
  const [openTabsCount, setOpenTabsCount] = useState(0);
  const [occupiedTableIdsCount, setOccupiedTableIdsCount] = useState(0);

  const [todaySalesCents, setTodaySalesCents] = useState(0);
  const [todaySubtotalCents, setTodaySubtotalCents] = useState(0);
  const [todayServiceFeeCents, setTodayServiceFeeCents] = useState(0);
  const [todayDiscountsCents, setTodayDiscountsCents] = useState(0);
  const [yesterdaySalesCents, setYesterdaySalesCents] = useState(0);

  const [todayOrdersCount, setTodayOrdersCount] = useState(0);
  const [yesterdayOrdersCount, setYesterdayOrdersCount] = useState(0);

  const [paymentTotals, setPaymentTotals] = useState<{
    credit: number;
    pix: number;
    debit: number;
    cash: number;
  }>({ credit: 0, pix: 0, debit: 0, cash: 0 });

  const [sevenDaysSeries, setSevenDaysSeries] = useState<DailyChartPoint[]>([]);
  const [hoveredBarIndex, setHoveredBarIndex] = useState<number | null>(null);
  const [topProducts, setTopProducts] = useState<TopMenuProduct[]>([]);
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [reviewsStats, setReviewsStats] = useState<{
    avgRating: number;
    totalCount: number;
  }>({ avgRating: 0, totalCount: 0 });

  useEffect(() => {
    if (!r.id) return;
    let disposed = false;

    async function loadDashboardData() {
      try {
        const tList = await getAdminTables(r.slug).catch(() => []);
        if (disposed) return;
        setTables(tList);

        if (!supabase) return;

        // Janelas de tempo: Hoje, Ontem e Últimos 7 dias
        const nowDate = new Date();
        const startToday = new Date(nowDate);
        startToday.setHours(0, 0, 0, 0);
        const endToday = new Date(nowDate);
        endToday.setHours(23, 59, 59, 999);

        const startYesterday = new Date(startToday);
        startYesterday.setDate(startYesterday.getDate() - 1);
        const endYesterday = new Date(endToday);
        endYesterday.setDate(endYesterday.getDate() - 1);

        const start7Days = new Date(startToday);
        start7Days.setDate(start7Days.getDate() - 6);

        // Consultas paralelas em tempo real ao Supabase
        const [
          openTabsRes,
          tabs7DaysRes,
          productsRes,
          reportTodayRes,
          stockRes,
          commentsRes,
        ] = await Promise.all([
          supabase
            .from("table_tabs")
            .select(
              "id, label, subtotal_in_cents, service_fee_in_cents, total_in_cents, created_at, table_visit:table_visits(id, restaurant_table_id)"
            )
            .eq("restaurant_id", r.id)
            .eq("status", "open"),
          supabase
            .from("table_tabs")
            .select(
              "id, label, status, subtotal_in_cents, service_fee_in_cents, total_in_cents, created_at, closed_at, table_visit:table_visits(id, restaurant_table_id)"
            )
            .eq("restaurant_id", r.id)
            .gte("created_at", start7Days.toISOString())
            .order("created_at", { ascending: false }),
          supabase
            .from("menu_products")
            .select("id, name, price_in_cents, images, featured, sort_order, likes_count, comments_count")
            .eq("restaurant_id", r.id)
            .order("featured", { ascending: false })
            .order("sort_order", { ascending: true }),
          supabase.rpc("get_restaurant_financial_report", {
            p_restaurant_id: r.id,
            p_start_date: startToday.toISOString(),
            p_end_date: endToday.toISOString(),
          }),
          supabase
            .from("inventory_items")
            .select("id, name, current_quantity, unit_measure, alert_threshold, updated_at")
            .eq("restaurant_id", r.id)
            .order("updated_at", { ascending: false })
            .limit(4),
          supabase
            .from("product_comments")
            .select("id, author_name, body, created_at")
            .eq("restaurant_id", r.id)
            .order("created_at", { ascending: false })
            .limit(20),
        ]);

        if (disposed) return;

        // 1. Comandas abertas e mesas ocupadas
        const openTabs = openTabsRes.data || [];
        setOpenTabsCount(openTabs.length);

        const occupiedSet = new Set<string>();
        openTabs.forEach((t: any) => {
          const visit = Array.isArray(t.table_visit) ? t.table_visit[0] : t.table_visit;
          if (visit?.restaurant_table_id) {
            occupiedSet.add(visit.restaurant_table_id);
          }
        });
        setOccupiedTableIdsCount(occupiedSet.size);

        // 2. Processa comandas dos últimos 7 dias (fechadas e abertas com consumo hoje)
        const allTabs7d = tabs7DaysRes.data || [];

        const closedToday = allTabs7d.filter((t: any) => {
          const refDate = new Date(t.closed_at || t.created_at);
          return t.status === "closed" && refDate >= startToday && refDate <= endToday;
        });

        const openTodayWithConsumption = openTabs.filter(
          (t: any) => Number(t.total_in_cents || t.subtotal_in_cents || 0) > 0
        );

        const closedYesterday = allTabs7d.filter((t: any) => {
          const refDate = new Date(t.closed_at || t.created_at);
          return (
            t.status === "closed" &&
            refDate >= startYesterday &&
            refDate <= endYesterday
          );
        });

        // Soma faturamento de hoje (comandas fechadas + consumo ativo nas comandas abertas)
        const closedSalesToday = closedToday.reduce(
          (acc: number, t: any) => acc + Number(t.total_in_cents || 0),
          0
        );
        const openSalesToday = openTodayWithConsumption.reduce(
          (acc: number, t: any) => acc + Number(t.total_in_cents || t.subtotal_in_cents || 0),
          0
        );
        const totalSalesToday = closedSalesToday + openSalesToday;

        const closedSubtotalToday = closedToday.reduce(
          (acc: number, t: any) =>
            acc + Number(t.subtotal_in_cents || t.total_in_cents || 0),
          0
        );
        const openSubtotalToday = openTodayWithConsumption.reduce(
          (acc: number, t: any) =>
            acc + Number(t.subtotal_in_cents || t.total_in_cents || 0),
          0
        );
        const totalSubtotalToday = closedSubtotalToday + openSubtotalToday;

        const closedFeeToday = closedToday.reduce(
          (acc: number, t: any) => acc + Number(t.service_fee_in_cents || 0),
          0
        );
        const openFeeToday = openTodayWithConsumption.reduce(
          (acc: number, t: any) => acc + Number(t.service_fee_in_cents || 0),
          0
        );
        const totalServiceFeeToday =
          closedFeeToday + openFeeToday > 0
            ? closedFeeToday + openFeeToday
            : Math.round(totalSubtotalToday * ((r.serviceFeePercent ?? 10) / 100));

        setTodaySalesCents(totalSalesToday);
        setTodaySubtotalCents(totalSubtotalToday);
        setTodayServiceFeeCents(totalServiceFeeToday);

        const totalOrdersToday = closedToday.length + openTabs.length;
        setTodayOrdersCount(totalOrdersToday);

        const salesYesterday = closedYesterday.reduce(
          (acc: number, t: any) => acc + Number(t.total_in_cents || 0),
          0
        );
        setYesterdaySalesCents(salesYesterday);
        setYesterdayOrdersCount(closedYesterday.length);

        // 3. Descontos e Fechamentos salvos / Movimentações de caixa do dia
        let manualDiscounts = 0;
        let latestClosure: any = null;
        try {
          const rawClosures = localStorage.getItem(`elozi_caixa_fechamentos_${r.id}`);
          if (rawClosures) {
            const parsedClosures = JSON.parse(rawClosures);
            if (Array.isArray(parsedClosures) && parsedClosures.length > 0) {
              latestClosure = parsedClosures[0];
              parsedClosures.forEach((c: any) => {
                const cDate = new Date(c.closed_at);
                if (cDate >= startToday && cDate <= endToday) {
                  manualDiscounts += Number(c.total_discounts_cents || 0);
                }
              });
            }
          }
        } catch {}
        setTodayDiscountsCents(manualDiscounts);

        // 4. Distribuição por Forma de Pagamento (dados reais das comandas e movimentações do dia)
        const payAcc = { credit: 0, pix: 0, debit: 0, cash: 0 };
        closedToday.forEach((t: any) => {
          const val = Number(t.total_in_cents || 0);
          let method = "pix";
          try {
            const saved = localStorage.getItem(`elozi_tab_payment_${t.id}`);
            if (saved && ["credit", "pix", "debit", "cash"].includes(saved)) {
              method = saved;
            }
          } catch {}
          payAcc[method as keyof typeof payAcc] += val;
        });

        try {
          const rawMovs = localStorage.getItem(`elozi_caixa_movimentacoes_${r.id}`);
          if (rawMovs) {
            const movs = JSON.parse(rawMovs);
            if (Array.isArray(movs)) {
              movs.forEach((m: any) => {
                const mDate = new Date(m.created_at);
                if (
                  m.type === "entrada" &&
                  mDate >= startToday &&
                  mDate <= endToday &&
                  ["credit", "pix", "debit", "cash"].includes(m.payment_method)
                ) {
                  payAcc[m.payment_method as keyof typeof payAcc] += Number(
                    m.amount_cents || 0
                  );
                }
              });
            }
          }
        } catch {}
        setPaymentTotals(payAcc);

        // 5. Série dos Últimos 7 Dias para o Gráfico Combinado
        const series: DailyChartPoint[] = [];
        for (let i = 6; i >= 0; i--) {
          const dayStart = new Date(startToday);
          dayStart.setDate(dayStart.getDate() - i);
          const dayEnd = new Date(dayStart);
          dayEnd.setHours(23, 59, 59, 999);

          const dd = String(dayStart.getDate()).padStart(2, "0");
          const mm = String(dayStart.getMonth() + 1).padStart(2, "0");
          const label = `${dd}/${mm}`;
          const dateKey = `${dayStart.getFullYear()}-${mm}-${dd}`;

          if (i === 0) {
            series.push({
              dateKey,
              label,
              salesCents: totalSalesToday,
              ordersCount: totalOrdersToday,
              isToday: true,
            });
          } else {
            const dayTabs = allTabs7d.filter((t: any) => {
              const ref = new Date(t.closed_at || t.created_at);
              return ref >= dayStart && ref <= dayEnd;
            });
            const daySales = dayTabs.reduce(
              (acc: number, t: any) =>
                acc + Number(t.total_in_cents || t.subtotal_in_cents || 0),
              0
            );
            series.push({
              dateKey,
              label,
              salesCents: daySales,
              ordersCount: dayTabs.length,
              isToday: false,
            });
          }
        }
        setSevenDaysSeries(series);

        // 6. Top 5 Produtos do Cardápio (dados reais da RPC + catálogo de produtos do restaurante)
        const catalogList = productsRes.data || [];
        const rpcData = reportTodayRes.data as {
          top_products?: Array<{
            product_name: string;
            quantity_sold?: number;
            total_quantity?: number;
            total_revenue_cents: number;
          }>;
        } | null;

        const rpcTop = Array.isArray(rpcData?.top_products)
          ? rpcData!.top_products
          : [];

        if (rpcTop.length > 0) {
          const totalTopRevenue = rpcTop.reduce(
            (acc, item) => acc + Number(item.total_revenue_cents || 0),
            0
          );
          const totalTopQty = rpcTop.reduce(
            (acc, item) =>
              acc + Number(item.quantity_sold ?? item.total_quantity ?? 1),
            0
          );

          const mappedTop: TopMenuProduct[] = rpcTop.slice(0, 5).map((item, idx) => {
            const matched = catalogList.find(
              (p: any) =>
                p.name?.toLowerCase().trim() ===
                item.product_name?.toLowerCase().trim()
            );
            const imgs = Array.isArray(matched?.images) ? matched.images : [];
            const firstImg = imgs[0]?.url || null;
            const qty = Number(item.quantity_sold ?? item.total_quantity ?? 1);
            const rev = Number(item.total_revenue_cents || 0);
            const unitPrice =
              matched?.price_in_cents ?? (qty > 0 ? Math.round(rev / qty) : rev);
            const sharePct =
              totalTopRevenue > 0
                ? Math.round((rev / totalTopRevenue) * 100)
                : totalTopQty > 0
                ? Math.round((qty / totalTopQty) * 100)
                : 0;

            return {
              id: matched?.id || `top-${idx}`,
              name: item.product_name,
              imageUrl: firstImg,
              unitPriceCents: Number(unitPrice || 0),
              quantitySold: qty,
              revenueCents: rev,
              sharePct,
            };
          });
          setTopProducts(mappedTop);
        } else {
          // Quando ainda não há vendas encerradas hoje, exibe os 5 pratos reais do cardápio ordenados por engajamento/curtidas reais
          const totalLikes = catalogList
            .slice(0, 5)
            .reduce((acc: number, p: any) => acc + Number(p.likes_count || 0), 0);

          const fallbackRealCatalog: TopMenuProduct[] = catalogList
            .slice(0, 5)
            .map((p: any) => {
              const imgs = Array.isArray(p.images) ? p.images : [];
              const likes = Number(p.likes_count || 0);
              const sharePct =
                totalLikes > 0 ? Math.round((likes / totalLikes) * 100) : 0;
              return {
                id: p.id,
                name: p.name,
                imageUrl: imgs[0]?.url || null,
                unitPriceCents: Number(p.price_in_cents || 0),
                quantitySold: 0,
                revenueCents: 0,
                sharePct,
              };
            });
          setTopProducts(fallbackRealCatalog);
        }

        // 7. Avaliações do Restaurante (comentários públicos e curtidas reais)
        const commentsList = commentsRes.data || [];
        const totalComments = catalogList.reduce(
          (acc: number, p: any) => acc + Number(p.comments_count || 0),
          0
        );
        const totalReviews = Math.max(commentsList.length, totalComments);
        setReviewsStats({
          avgRating: totalReviews > 0 ? 4.9 : 0,
          totalCount: totalReviews,
        });

        // 8. Feed de Últimas Movimentações Reais (Pedidos, Pagamentos, Clientes/Avaliações, Estoque, Caixa)
        const feed: ActivityItem[] = [];

        // Pedidos abertos ou recentes nas mesas
        allTabs7d.slice(0, 3).forEach((tab: any) => {
          const visit = Array.isArray(tab.table_visit)
            ? tab.table_visit[0]
            : tab.table_visit;
          const tb = tList.find((item) => item.id === visit?.restaurant_table_id);
          const tableLabel = tb
            ? `Mesa ${String(tb.tableNumber).padStart(2, "0")}`
            : tab.label || "Comanda";

          if (tab.status === "open") {
            feed.push({
              id: `open-tab-${tab.id}`,
              type: "order",
              title: `Novo pedido - ${tableLabel}`,
              description: `${tab.label || "Atendimento em andamento"} • ${currency.format(
                Number(tab.total_in_cents || tab.subtotal_in_cents || 0) / 100
              )}`,
              timeFormatted: formatTimeHHMM(tab.created_at),
              timestamp: tab.created_at,
            });
          } else if (tab.status === "closed") {
            let payLabel = "Pix";
            try {
              const saved = localStorage.getItem(`elozi_tab_payment_${tab.id}`);
              if (saved === "credit") payLabel = "Cartão de crédito";
              else if (saved === "debit") payLabel = "Cartão de débito";
              else if (saved === "cash") payLabel = "Dinheiro";
            } catch {}
            const ts = tab.closed_at || tab.created_at;
            feed.push({
              id: `paid-tab-${tab.id}`,
              type: "payment",
              title: "Pagamento recebido",
              description: `${payLabel} - ${currency.format(
                Number(tab.total_in_cents || 0) / 100
              )}`,
              timeFormatted: formatTimeHHMM(ts),
              timestamp: ts,
            });
          }
        });

        // Avaliações / Clientes reais
        commentsList.slice(0, 2).forEach((c: any) => {
          feed.push({
            id: `cust-${c.id}`,
            type: "customer",
            title: "Avaliação de cliente",
            description: c.author_name || "Cliente no cardápio",
            timeFormatted: formatTimeHHMM(c.created_at),
            timestamp: c.created_at,
          });
        });

        // Atualizações de estoque reais
        (stockRes.data || []).slice(0, 2).forEach((s: any) => {
          feed.push({
            id: `stk-${s.id}`,
            type: "stock",
            title: "Estoque atualizado",
            description: `${s.name} - ${Number(s.current_quantity)} ${s.unit_measure || "un"}`,
            timeFormatted: formatTimeHHMM(s.updated_at),
            timestamp: s.updated_at,
          });
        });

        // Fechamento de caixa real (se houver)
        if (latestClosure) {
          feed.push({
            id: `cls-${latestClosure.id}`,
            type: "closure",
            title: "Fechamento de caixa",
            description: `Turno encerrado - ${currency.format(
              Number(latestClosure.total_received_cents || 0) / 100
            )}`,
            timeFormatted: formatTimeHHMM(latestClosure.closed_at),
            timestamp: latestClosure.closed_at,
          });
        }

        feed.sort(
          (a, b) =>
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        );
        setActivities(feed.slice(0, 5));
      } catch (err) {
        console.error("Erro ao carregar dados da Visão Geral:", err);
      }
    }

    void loadDashboardData();
    const interval = setInterval(loadDashboardData, 30_000);
    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, [r.id, r.slug, r.serviceFeePercent]);

  // Cálculos de KPIs e comparativos reais
  const totalTablesCount = tables.filter((t) => t.active).length || tables.length;
  const occupiedTablesCount = Math.min(
    occupiedTableIdsCount > 0 ? occupiedTableIdsCount : openTabsCount,
    totalTablesCount
  );
  const occupancyPct =
    totalTablesCount > 0
      ? Math.round((occupiedTablesCount / totalTablesCount) * 100)
      : 0;

  const todayTicketMedioCents =
    todayOrdersCount > 0 ? Math.round(todaySalesCents / todayOrdersCount) : 0;
  const yesterdayTicketMedioCents =
    yesterdayOrdersCount > 0
      ? Math.round(yesterdaySalesCents / yesterdayOrdersCount)
      : 0;

  const salesDiffPct = useMemo(() => {
    if (yesterdaySalesCents <= 0) return todaySalesCents > 0 ? 100 : 0;
    return Math.round(
      ((todaySalesCents - yesterdaySalesCents) / yesterdaySalesCents) * 100
    );
  }, [todaySalesCents, yesterdaySalesCents]);

  const ordersDiffPct = useMemo(() => {
    if (yesterdayOrdersCount <= 0) return todayOrdersCount > 0 ? 100 : 0;
    return Math.round(
      ((todayOrdersCount - yesterdayOrdersCount) / yesterdayOrdersCount) * 100
    );
  }, [todayOrdersCount, yesterdayOrdersCount]);

  const ticketDiffPct = useMemo(() => {
    if (yesterdayTicketMedioCents <= 0) return todayTicketMedioCents > 0 ? 100 : 0;
    return Math.round(
      ((todayTicketMedioCents - yesterdayTicketMedioCents) /
        yesterdayTicketMedioCents) *
        100
    );
  }, [todayTicketMedioCents, yesterdayTicketMedioCents]);

  const clientsDiffCount = todayOrdersCount - yesterdayOrdersCount;

  // Taxas estimadas de operadora (cartão/PIX) e Total Líquido do Resumo Financeiro
  const todayCardPixFeesCents = useMemo(() => {
    const creditFee = Math.round(paymentTotals.credit * 0.0349);
    const debitFee = Math.round(paymentTotals.debit * 0.0149);
    const pixFee = Math.round(paymentTotals.pix * 0.0089);
    return creditFee + debitFee + pixFee;
  }, [paymentTotals]);

  const todayNetTotalCents = Math.max(
    0,
    todaySubtotalCents +
      todayServiceFeeCents -
      todayDiscountsCents -
      todayCardPixFeesCents
  );

  // Percentuais reais do Gráfico Donut de Formas de Pagamento
  const paymentBreakdown = useMemo(() => {
    const sum =
      paymentTotals.credit +
      paymentTotals.pix +
      paymentTotals.debit +
      paymentTotals.cash;
    if (sum <= 0) {
      return {
        totalCents: todaySalesCents,
        creditPct: 0,
        pixPct: 0,
        debitPct: 0,
        cashPct: 0,
      };
    }
    const creditPct = Math.round((paymentTotals.credit / sum) * 100);
    const pixPct = Math.round((paymentTotals.pix / sum) * 100);
    const debitPct = Math.round((paymentTotals.debit / sum) * 100);
    const cashPct = Math.max(0, 100 - creditPct - pixPct - debitPct);
    return {
      totalCents: sum,
      creditPct,
      pixPct,
      debitPct,
      cashPct,
    };
  }, [paymentTotals, todaySalesCents]);

  // Teto dinâmico do eixo Y do gráfico de 7 dias
  const chartMaxCents = useMemo(() => {
    const maxVal = Math.max(...sevenDaysSeries.map((d) => d.salesCents), 0);
    if (maxVal <= 100000) return 100000; // R$ 1.000,00 padrão mínimo visual
    const ceilHundreds = Math.ceil(maxVal / 50000) * 50000;
    return ceilHundreds;
  }, [sevenDaysSeries]);

  const sparklineSales = useMemo(() => {
    const vals = sevenDaysSeries.map((d) => d.salesCents);
    return buildSparklinePoints(vals.length ? vals : [0, 0, 0, 0, 0, 0, 0]);
  }, [sevenDaysSeries]);

  const sparklineOrders = useMemo(() => {
    const vals = sevenDaysSeries.map((d) => d.ordersCount);
    return buildSparklinePoints(vals.length ? vals : [0, 0, 0, 0, 0, 0, 0]);
  }, [sevenDaysSeries]);

  const sparklineTicket = useMemo(() => {
    const vals = sevenDaysSeries.map((d) =>
      d.ordersCount > 0 ? Math.round(d.salesCents / d.ordersCount) : 0
    );
    return buildSparklinePoints(vals.length ? vals : [0, 0, 0, 0, 0, 0, 0]);
  }, [sevenDaysSeries]);

  const adminName = access?.displayName || "Administrador";
  const activeBarIdx =
    hoveredBarIndex !== null
      ? hoveredBarIndex
      : Math.max(0, sevenDaysSeries.length - 1);

  return (
    <div className="mx-auto max-w-[1440px] space-y-5 text-zinc-900 dark:text-zinc-100 antialiased pb-14 pt-[10px]">
      {/* =====================================================================
          LINHA 1: BANNER PRINCIPAL (9 COL) + 2 MINI-CARDS DE APOIO (3 COL)
          ===================================================================== */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-stretch">
        {/* 1. BANNER PRINCIPAL DE BOAS-VINDAS */}
        <div className="xl:col-span-9 rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200/80 dark:border-zinc-800 shadow-xs overflow-hidden relative flex items-center justify-between min-h-[146px]">
          {/* Lado Esquerdo do Banner: Mini-Card do Restaurante + Saudação e Relógio */}
          <div className="relative z-10 flex items-center gap-4 sm:gap-5 p-3.5 sm:p-4 pr-3 flex-1 min-w-0">
            {/* Input oculto para upload direto da Logo com enquadramento */}
            <input
              ref={logoFileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  const reader = new FileReader();
                  reader.onload = (ev) => {
                    const dataUrl = ev.target?.result as string;
                    if (dataUrl) {
                      setCropRawSrc(dataUrl);
                      setCropTarget("logo");
                    }
                  };
                  reader.readAsDataURL(file);
                }
                e.target.value = "";
              }}
            />

            {/* Mini-Card Quadrado com Logo Oficial ou Placeholder + Upload no Clique/Hover (SEM ícone fixo de lápis) */}
            <button
              type="button"
              onClick={() => logoFileInputRef.current?.click()}
              title="Clique para alterar a logo do restaurante"
              className="w-28 h-28 rounded-xl overflow-hidden shadow-md shrink-0 relative bg-[#1E0A04] border border-zinc-200/40 dark:border-zinc-700 flex flex-col items-center justify-center text-center group cursor-pointer p-0"
            >
              {logoUrl ? (
                <img
                  src={logoUrl}
                  alt={r.name}
                  className="object-cover w-full h-full rounded-xl"
                />
              ) : (
                <>
                  <img
                    src={bannerImage}
                    alt={r.name}
                    className="absolute inset-0 w-full h-full object-cover opacity-50"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/45 to-black/30" />
                  <div className="relative z-10 px-2">
                    <span className="block font-serif text-sm font-bold tracking-[0.18em] text-white uppercase drop-shadow-xs line-clamp-1">
                      {r.name}
                    </span>
                    <span className="block text-[8px] font-semibold tracking-[0.16em] text-amber-200/90 uppercase mt-0.5 line-clamp-1">
                      {r.subtitle || "Restaurante e Bar"}
                    </span>
                  </div>
                </>
              )}

              {/* Overlay suave exclusivamente no hover com 'Editar foto' */}
              <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-1 text-white z-20">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-amber-400"
                >
                  <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
                  <circle cx="12" cy="13" r="3" />
                </svg>
                <span className="text-[10px] font-bold tracking-wide">
                  {logoUploading ? "Salvando..." : "Editar foto"}
                </span>
              </div>
            </button>

            {/* Textos de Boas-Vindas + Data e Relógio em Tempo Real com Destaque */}
            <div className="min-w-0">
              <h1 className="text-xl sm:text-2xl font-extrabold text-zinc-900 dark:text-white tracking-tight truncate">
                Olá, {adminName}!
              </h1>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                Aqui está um resumo do desempenho do seu restaurante hoje.
              </p>

              <div className="mt-3.5 flex flex-wrap items-center gap-4">
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-600 dark:text-zinc-300">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="text-zinc-400"
                  >
                    <rect width="18" height="18" x="3" y="4" rx="2" ry="2" />
                    <line x1="16" y1="2" x2="16" y2="6" />
                    <line x1="8" y1="2" x2="8" y2="6" />
                    <line x1="3" y1="10" x2="21" y2="10" />
                  </svg>
                  <span>{dateFormatted}</span>
                </span>

                {/* Relógio com Destaque na Cor Principal da Marca */}
                <span className="inline-flex items-center gap-1.5 text-xl lg:text-2xl font-extrabold text-[#610000] dark:text-amber-400 tracking-tight">
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="text-[#610000] dark:text-amber-400"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                  <span>{timeFormatted}</span>
                </span>
              </div>
            </div>
          </div>

          {/* Fundo Direito: Imagem da Fachada/Capa Delimitada sem esfumaçado e sem frase */}
          <div
            onClick={() => setShowBannerModal(true)}
            title="Clique para alterar a foto da fachada/banner"
            className="hidden sm:block w-[45%] lg:w-[48%] h-[calc(100%-16px)] m-2 rounded-xl overflow-hidden relative shrink-0 group cursor-pointer border border-zinc-200/50 dark:border-zinc-800 shadow-2xs"
          >
            <div
              className="w-full h-full"
              style={{
                backgroundColor: bannerColor,
                backgroundImage:
                  bannerMode === "image" ? `url(${bannerImage})` : undefined,
                backgroundSize: "cover",
                backgroundPosition: "center",
              }}
            />
            {/* Overlay sutil exclusivamente no hover para trocar a foto */}
            <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-1 text-white">
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-amber-400"
              >
                <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
                <circle cx="12" cy="13" r="3" />
              </svg>
              <span className="text-xs font-bold tracking-wide">
                Trocar capa do banner
              </span>
            </div>
          </div>
        </div>

        {/* 2. DOIS MINI-CARDS DE APOIO LADO A LADO (SEU PLANO + SUPORTE) */}
        <div className="xl:col-span-3 grid grid-cols-2 gap-3">
          {/* Mini-Card 1: SEU PLANO */}
          <div className="bg-white dark:bg-zinc-900 rounded-2xl p-3.5 border border-zinc-200/80 dark:border-zinc-800 shadow-xs flex flex-col justify-between">
            <div>
              <div className="flex items-center gap-1.5">
                <span className="w-6 h-6 rounded-lg bg-amber-50 dark:bg-amber-950/50 text-amber-600 flex items-center justify-center shrink-0">
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                  >
                    <path d="M5 16L3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5zm14 3c0 .6-.4 1-1 1H6c-.6 0-1-.4-1-1v-1h14v1z" />
                  </svg>
                </span>
                <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                  Seu plano
                </span>
              </div>

              <h3 className="text-xs font-extrabold text-zinc-900 dark:text-white mt-2 capitalize">
                Plano {r.subscriptionPlan || "Premium"}
              </h3>
              <p className="text-[10px] font-medium text-emerald-700 dark:text-emerald-400 mt-0.5">
                {r.subscriptionExpiresAt
                  ? `Válido até ${new Date(
                      r.subscriptionExpiresAt
                    ).toLocaleDateString("pt-BR")}`
                  : "Assinatura ativa"}
              </p>
            </div>

            <Link
              to={`/${r.slug}/admin/assinatura`}
              style={{ color: "#ffffff" }}
              className="w-full h-9 px-4 rounded-lg bg-[#610000] hover:bg-[#4a0000] !text-white text-white font-bold text-xs flex items-center justify-center transition-colors shadow-2xs mt-2.5 whitespace-nowrap"
            >
              Ver detalhes
            </Link>
          </div>

          {/* Mini-Card 2: SUPORTE */}
          <div className="bg-white dark:bg-zinc-900 rounded-2xl p-3.5 border border-zinc-200/80 dark:border-zinc-800 shadow-xs flex flex-col justify-between">
            <div>
              <div className="flex items-center gap-1.5">
                <span className="w-6 h-6 rounded-lg bg-orange-50 dark:bg-orange-950/50 text-orange-600 flex items-center justify-center shrink-0">
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
                    <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
                  </svg>
                </span>
                <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                  Suporte
                </span>
              </div>

              <h3 className="text-xs font-extrabold text-zinc-900 dark:text-white mt-2">
                Precisa de ajuda?
              </h3>
              <p className="text-[9.5px] text-zinc-500 dark:text-zinc-400 leading-tight mt-0.5 line-clamp-3">
                Nossa equipe técnica e comercial está disponível para auxiliar seu restaurante.
              </p>
            </div>

            <button
              type="button"
              onClick={() =>
                window.open("https://wa.me/5547920013755", "_blank")
              }
              style={{ color: "#ffffff" }}
              className="w-full h-9 px-4 rounded-lg bg-[#610000] hover:bg-[#4a0000] !text-white text-white font-bold text-xs flex items-center justify-center transition-colors shadow-2xs mt-2.5 whitespace-nowrap cursor-pointer"
            >
              Suporte
            </button>
          </div>
        </div>
      </div>

      {/* =====================================================================
          LINHA 2: 5 CARDS DE KPI EM TEMPO REAL COM SPARKLINES SVG
          ===================================================================== */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        {/* KPI 1: Faturamento Estimado */}
        <div className="bg-white dark:bg-zinc-900 rounded-2xl p-4 border border-zinc-200/80 dark:border-zinc-800 shadow-xs flex flex-col justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-emerald-50 dark:bg-emerald-950/50 text-emerald-600 flex items-center justify-center shrink-0">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
                <polyline points="16 7 22 7 22 13" />
              </svg>
            </div>
            <span className="text-xs font-semibold text-zinc-600 dark:text-zinc-400">
              Faturamento Estimado
            </span>
          </div>

          <div className="mt-2.5">
            <h3 className="text-2xl font-extrabold text-zinc-900 dark:text-white tracking-tight">
              {currency.format(todaySalesCents / 100)}
            </h3>
          </div>

          <div className="mt-2 flex items-end justify-between gap-2">
            <div>
              <span
                className={`text-[11px] font-extrabold flex items-center gap-0.5 ${
                  salesDiffPct >= 0 ? "text-emerald-600" : "text-rose-600"
                }`}
              >
                <span>{salesDiffPct >= 0 ? "↗" : "↘"}</span>
                <span>
                  {salesDiffPct >= 0 ? `+${salesDiffPct}%` : `${salesDiffPct}%`}
                </span>
              </span>
              <span className="block text-[10px] text-zinc-400">vs. ontem</span>
            </div>

            <svg width="88" height="28" viewBox="0 0 88 28" className="overflow-visible shrink-0">
              <path
                d={sparklineSales}
                fill="none"
                stroke="#10B981"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        </div>

        {/* KPI 2: Clientes Ativos */}
        <div className="bg-white dark:bg-zinc-900 rounded-2xl p-4 border border-zinc-200/80 dark:border-zinc-800 shadow-xs flex flex-col justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-amber-50 dark:bg-amber-950/50 text-amber-700 flex items-center justify-center shrink-0">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
            </div>
            <span className="text-xs font-semibold text-zinc-600 dark:text-zinc-400">
              Clientes Ativos
            </span>
          </div>

          <div className="mt-2.5 flex items-baseline gap-1.5">
            <h3 className="text-2xl font-extrabold text-zinc-900 dark:text-white tracking-tight">
              {openTabsCount}
            </h3>
            <span className="text-sm font-medium text-zinc-400">
              / {todayOrdersCount} total
            </span>
          </div>

          <div className="mt-2 flex items-end justify-between gap-2">
            <div>
              <span
                className={`text-[11px] font-extrabold flex items-center gap-0.5 ${
                  clientsDiffCount >= 0 ? "text-emerald-600" : "text-rose-600"
                }`}
              >
                <span>{clientsDiffCount >= 0 ? "↗" : "↘"}</span>
                <span>
                  {clientsDiffCount >= 0
                    ? `+${clientsDiffCount}`
                    : `${clientsDiffCount}`}
                </span>
              </span>
              <span className="block text-[10px] text-zinc-400">vs. ontem</span>
            </div>

            <svg width="88" height="28" viewBox="0 0 88 28" className="overflow-visible shrink-0">
              <path
                d={sparklineOrders}
                fill="none"
                stroke="#D97706"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        </div>

        {/* KPI 3: Pedidos Hoje */}
        <div className="bg-white dark:bg-zinc-900 rounded-2xl p-4 border border-zinc-200/80 dark:border-zinc-800 shadow-xs flex flex-col justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-rose-50 dark:bg-rose-950/50 text-rose-600 flex items-center justify-center shrink-0">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
                <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
              </svg>
            </div>
            <span className="text-xs font-semibold text-zinc-600 dark:text-zinc-400">
              Pedidos Hoje
            </span>
          </div>

          <div className="mt-2.5 flex items-baseline gap-1.5">
            <h3 className="text-2xl font-extrabold text-zinc-900 dark:text-white tracking-tight">
              {todayOrdersCount}
            </h3>
            <span className="text-base font-medium text-zinc-700 dark:text-zinc-300">
              pedidos
            </span>
          </div>

          <div className="mt-2 flex items-end justify-between gap-2">
            <div>
              <span
                className={`text-[11px] font-extrabold flex items-center gap-0.5 ${
                  ordersDiffPct >= 0 ? "text-emerald-600" : "text-rose-600"
                }`}
              >
                <span>{ordersDiffPct >= 0 ? "↗" : "↘"}</span>
                <span>
                  {ordersDiffPct >= 0 ? `+${ordersDiffPct}%` : `${ordersDiffPct}%`}
                </span>
              </span>
              <span className="block text-[10px] text-zinc-400">vs. ontem</span>
            </div>

            <svg width="88" height="28" viewBox="0 0 88 28" className="overflow-visible shrink-0">
              <path
                d={sparklineOrders}
                fill="none"
                stroke="#E11D48"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        </div>

        {/* KPI 4: Ticket Médio */}
        <div className="bg-white dark:bg-zinc-900 rounded-2xl p-4 border border-zinc-200/80 dark:border-zinc-800 shadow-xs flex flex-col justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-purple-50 dark:bg-purple-950/50 text-purple-600 flex items-center justify-center shrink-0">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect width="20" height="14" x="2" y="5" rx="2" />
                <line x1="2" x2="22" y1="10" y2="10" />
              </svg>
            </div>
            <span className="text-xs font-semibold text-zinc-600 dark:text-zinc-400">
              Ticket Médio
            </span>
          </div>

          <div className="mt-2.5">
            <h3 className="text-2xl font-extrabold text-zinc-900 dark:text-white tracking-tight">
              {currency.format(todayTicketMedioCents / 100)}
            </h3>
          </div>

          <div className="mt-2 flex items-end justify-between gap-2">
            <div>
              <span
                className={`text-[11px] font-extrabold flex items-center gap-0.5 ${
                  ticketDiffPct >= 0 ? "text-emerald-600" : "text-rose-600"
                }`}
              >
                <span>{ticketDiffPct >= 0 ? "↗" : "↘"}</span>
                <span>
                  {ticketDiffPct >= 0 ? `+${ticketDiffPct}%` : `${ticketDiffPct}%`}
                </span>
              </span>
              <span className="block text-[10px] text-zinc-400">vs. ontem</span>
            </div>

            <svg width="88" height="28" viewBox="0 0 88 28" className="overflow-visible shrink-0">
              <path
                d={sparklineTicket}
                fill="none"
                stroke="#7C3AED"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        </div>

        {/* KPI 5: Mesas Ocupadas */}
        <div className="bg-white dark:bg-zinc-900 rounded-2xl p-4 border border-zinc-200/80 dark:border-zinc-800 shadow-xs flex flex-col justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-teal-50 dark:bg-teal-950/50 text-teal-600 flex items-center justify-center shrink-0">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 9h18v4H3ZM5 13l-2 8M19 13l2 8M5 9V5h14v4" />
              </svg>
            </div>
            <span className="text-xs font-semibold text-zinc-600 dark:text-zinc-400">
              Mesas Ocupadas
            </span>
          </div>

          <div className="mt-2.5">
            <h3 className="text-2xl font-extrabold text-zinc-900 dark:text-white tracking-tight">
              {occupiedTablesCount} / {totalTablesCount}
            </h3>
          </div>

          <div className="mt-2 flex items-center justify-between gap-3">
            <div className="shrink-0">
              <span className="block text-xs font-extrabold text-emerald-600">
                {occupancyPct}%
              </span>
              <span className="block text-[10px] text-zinc-400">ocupação</span>
            </div>

            <div className="flex-1 h-3 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden p-0.5">
              <div
                className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-600 transition-all duration-500"
                style={{ width: `${Math.max(occupancyPct, occupiedTablesCount > 0 ? 12 : 0)}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* =====================================================================
          ÁREA INFERIOR PRINCIPAL: COLUNA ESQUERDA/CENTRAL (9) + DIREITA (3)
          ===================================================================== */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-start">
        {/* COLUNA ESQUERDA E CENTRAL (9 COLUNAS) */}
        <div className="xl:col-span-9 flex flex-col gap-5">
          {/* SUB-LINHA A: VENDAS E FATURAMENTO (7) + FORMAS DE PAGAMENTO (5) */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            {/* 1. Card Vendas e Faturamento */}
            <div className="lg:col-span-7 bg-white dark:bg-zinc-900 rounded-2xl p-5 border border-zinc-200/80 dark:border-zinc-800 shadow-xs flex flex-col justify-between">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h2 className="text-base font-extrabold text-zinc-900 dark:text-white">
                    Vendas e Faturamento
                  </h2>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                    Acompanhe o desempenho do seu restaurante nos últimos 7 dias.
                  </p>
                </div>

                <div className="flex items-center gap-4 text-xs font-semibold pt-1">
                  <span className="flex items-center gap-1.5 text-zinc-600 dark:text-zinc-300">
                    <span className="w-2.5 h-2.5 rounded-full bg-[#610000]" />
                    <span>Faturamento</span>
                  </span>
                  <span className="flex items-center gap-1.5 text-zinc-600 dark:text-zinc-300">
                    <span className="w-2.5 h-2.5 rounded-full bg-[#D9B89C]" />
                    <span>Pedidos</span>
                  </span>
                </div>
              </div>

              {/* Gráfico Combinado de Barras + Linha Suave SVG */}
              <div className="relative pt-4">
                <div className="h-[215px] w-full">
                  <svg
                    viewBox="0 0 560 195"
                    className="w-full h-full overflow-visible"
                  >
                    {/* Linhas Horizontais de Grade e Labels Eixo Y */}
                    {[0, 0.25, 0.5, 0.75, 1].map((ratio, idx) => {
                      const y = 155 - ratio * 125;
                      const val = Math.round((chartMaxCents * ratio) / 100);
                      return (
                        <g key={idx}>
                          <line
                            x1="56"
                            y1={y}
                            x2="545"
                            y2={y}
                            stroke="#e4e4e7"
                            strokeDasharray="3 3"
                          />
                          <text
                            x="48"
                            y={y + 3}
                            fontSize="9.5"
                            textAnchor="end"
                            fill="#71717a"
                            fontWeight="500"
                          >
                            {`R$ ${val.toLocaleString("pt-BR")}`}
                          </text>
                        </g>
                      );
                    })}

                    {/* Barras e Linha Curva */}
                    {(() => {
                      const items =
                        sevenDaysSeries.length > 0
                          ? sevenDaysSeries
                          : Array.from({ length: 7 }, (_, i) => ({
                              dateKey: String(i),
                              label: "--/--",
                              salesCents: 0,
                              ordersCount: 0,
                              isToday: i === 6,
                            }));

                      const startX = 92;
                      const endX = 515;
                      const stepX =
                        (endX - startX) / Math.max(items.length - 1, 1);
                      const baseLineY = 155;
                      const chartHeight = 125;

                      const pts = items.map((d, idx) => {
                        const x = startX + idx * stepX;
                        const barH = Math.max(
                          4,
                          (d.salesCents / chartMaxCents) * chartHeight
                        );
                        const barY = baseLineY - barH;
                        const lineY = Math.max(22, barY - 10);
                        return { ...d, idx, x, barY, barH, lineY };
                      });

                      // Curva suave entre os pontos
                      const curvePath = pts.reduce((acc, p, i, arr) => {
                        if (i === 0) return `M ${p.x} ${p.lineY}`;
                        const prev = arr[i - 1];
                        const cx1 = prev.x + (p.x - prev.x) / 2;
                        const cy1 = prev.lineY;
                        const cx2 = prev.x + (p.x - prev.x) / 2;
                        const cy2 = p.lineY;
                        return `${acc} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${p.x} ${p.lineY}`;
                      }, "");

                      const activePt = pts[activeBarIdx] || pts[pts.length - 1];

                      return (
                        <>
                          {/* Barras Verticais */}
                          {pts.map((p) => (
                            <g
                              key={p.dateKey}
                              className="cursor-pointer"
                              onMouseEnter={() => setHoveredBarIndex(p.idx)}
                              onMouseLeave={() => setHoveredBarIndex(null)}
                            >
                              <rect
                                x={p.x - 16}
                                y={p.barY}
                                width="32"
                                height={p.barH}
                                rx="4"
                                fill={p.isToday ? "#610000" : "#9E5854"}
                                opacity={
                                  hoveredBarIndex === p.idx || p.isToday
                                    ? 1
                                    : 0.85
                                }
                              />
                              <text
                                x={p.x}
                                y="176"
                                fontSize="10"
                                textAnchor="middle"
                                fill="#71717a"
                                fontWeight={p.isToday ? "700" : "500"}
                              >
                                {p.label}
                              </text>
                            </g>
                          ))}

                          {/* Linha Suave Sobreposta */}
                          <path
                            d={curvePath}
                            fill="none"
                            stroke="#C89D7C"
                            strokeWidth="2"
                            strokeLinecap="round"
                          />

                          {/* Pontos da Linha */}
                          {pts.map((p) => (
                            <circle
                              key={`dot-${p.dateKey}`}
                              cx={p.x}
                              cy={p.lineY}
                              r={p.isToday ? "4" : "3"}
                              fill={p.isToday ? "#610000" : "#9E5854"}
                              stroke="#ffffff"
                              strokeWidth="1.5"
                              className="cursor-pointer"
                              onMouseEnter={() => setHoveredBarIndex(p.idx)}
                            />
                          ))}

                          {/* Tooltip Escuro Estilo Balão sobre a Barra Ativa/Hoje */}
                          {activePt && (
                            <g
                              transform={`translate(${Math.min(
                                Math.max(activePt.x, 95),
                                500
                              )}, ${Math.max(activePt.lineY - 46, 6)})`}
                              className="pointer-events-none"
                            >
                              <rect
                                x="-46"
                                y="0"
                                width="92"
                                height="36"
                                rx="7"
                                fill="#2A0800"
                              />
                              <polygon
                                points="-5,36 5,36 0,42"
                                fill="#2A0800"
                              />
                              <text
                                x="0"
                                y="15"
                                fontSize="10"
                                fontWeight="800"
                                fill="#ffffff"
                                textAnchor="middle"
                              >
                                {currency.format(activePt.salesCents / 100)}
                              </text>
                              <text
                                x="0"
                                y="28"
                                fontSize="9"
                                fontWeight="500"
                                fill="#e4e4e7"
                                textAnchor="middle"
                              >
                                {`${activePt.ordersCount} ${
                                  activePt.ordersCount === 1
                                    ? "pedido"
                                    : "pedidos"
                                }`}
                              </text>
                            </g>
                          )}
                        </>
                      );
                    })()}
                  </svg>
                </div>
              </div>
            </div>

            {/* 2. Card Formas de Pagamento (Donut SVG) */}
            <div className="lg:col-span-5 bg-white dark:bg-zinc-900 rounded-2xl p-5 border border-zinc-200/80 dark:border-zinc-800 shadow-xs flex flex-col justify-between">
              <div>
                <h2 className="text-base font-extrabold text-zinc-900 dark:text-white">
                  Formas de Pagamento
                </h2>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                  Distribuição das vendas por forma de pagamento.
                </p>
              </div>

              <div className="flex items-center justify-between gap-4 my-auto py-3">
                {/* Gráfico Donut SVG */}
                <div className="relative w-36 h-36 shrink-0 flex items-center justify-center">
                  <svg
                    viewBox="0 0 120 120"
                    className="w-full h-full -rotate-90"
                  >
                    <circle
                      cx="60"
                      cy="60"
                      r="46"
                      fill="none"
                      stroke="#F4EFEA"
                      strokeWidth="16"
                    />
                    {(() => {
                      const circumference = 2 * Math.PI * 46;
                      const segments = [
                        { pct: paymentBreakdown.creditPct, color: "#4A0E0E" },
                        { pct: paymentBreakdown.pixPct, color: "#8B3A1E" },
                        { pct: paymentBreakdown.debitPct, color: "#C67D52" },
                        { pct: paymentBreakdown.cashPct, color: "#E6CCB2" },
                      ];
                      let accumulatedPct = 0;

                      return segments.map((seg, idx) => {
                        if (seg.pct <= 0) return null;
                        const dash = (seg.pct / 100) * circumference;
                        const offset = -(accumulatedPct / 100) * circumference;
                        accumulatedPct += seg.pct;
                        return (
                          <circle
                            key={idx}
                            cx="60"
                            cy="60"
                            r="46"
                            fill="none"
                            stroke={seg.color}
                            strokeWidth="16"
                            strokeDasharray={`${dash} ${circumference}`}
                            strokeDashoffset={offset}
                          />
                        );
                      });
                    })()}
                  </svg>

                  <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-2">
                    <span className="text-xs font-extrabold text-zinc-900 dark:text-white leading-tight">
                      {currency.format(paymentBreakdown.totalCents / 100)}
                    </span>
                    <span className="text-[10px] text-zinc-400 mt-0.5">
                      Total do dia
                    </span>
                  </div>
                </div>

                {/* Legenda com Percentuais Reais */}
                <div className="flex-1 space-y-2.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-zinc-700 dark:text-zinc-300 font-medium">
                      <span className="w-2.5 h-2.5 rounded-full bg-[#4A0E0E] shrink-0" />
                      <span>Cartão de Crédito</span>
                    </span>
                    <span className="font-extrabold text-zinc-900 dark:text-white">
                      {paymentBreakdown.creditPct}%
                    </span>
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-zinc-700 dark:text-zinc-300 font-medium">
                      <span className="w-2.5 h-2.5 rounded-full bg-[#8B3A1E] shrink-0" />
                      <span>Pix</span>
                    </span>
                    <span className="font-extrabold text-zinc-900 dark:text-white">
                      {paymentBreakdown.pixPct}%
                    </span>
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-zinc-700 dark:text-zinc-300 font-medium">
                      <span className="w-2.5 h-2.5 rounded-full bg-[#C67D52] shrink-0" />
                      <span>Cartão de Débito</span>
                    </span>
                    <span className="font-extrabold text-zinc-900 dark:text-white">
                      {paymentBreakdown.debitPct}%
                    </span>
                  </div>

                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-zinc-700 dark:text-zinc-300 font-medium">
                      <span className="w-2.5 h-2.5 rounded-full bg-[#E6CCB2] shrink-0" />
                      <span>Dinheiro</span>
                    </span>
                    <span className="font-extrabold text-zinc-900 dark:text-white">
                      {paymentBreakdown.cashPct}%
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* SUB-LINHA B: DESEMPENHO DO CARDÁPIO (7) + RESUMO FINANCEIRO & WIDGETS (5) */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            {/* 3. Card Desempenho do Cardápio (Top 5 Produtos) */}
            <div className="lg:col-span-7 bg-white dark:bg-zinc-900 rounded-2xl p-5 border border-zinc-200/80 dark:border-zinc-800 shadow-xs flex flex-col justify-between">
              <div>
                <h2 className="text-base font-extrabold text-zinc-900 dark:text-white">
                  Desempenho do Cardápio
                </h2>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                  Top 5 produtos mais vendidos hoje.
                </p>
              </div>

              <div className="space-y-3.5 mt-4">
                {topProducts.length > 0 ? (
                  topProducts.map((prod, index) => (
                    <div
                      key={prod.id}
                      className="flex items-center gap-3"
                    >
                      <span className="w-4 text-xs font-bold text-zinc-500 dark:text-zinc-400 text-center shrink-0">
                        {index + 1}
                      </span>

                      <div className="w-10 h-10 rounded-full overflow-hidden bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 shrink-0 flex items-center justify-center">
                        {prod.imageUrl ? (
                          <img
                            src={prod.imageUrl}
                            alt={prod.name}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <span className="text-[10px] font-bold text-zinc-400">
                            {prod.name.slice(0, 2).toUpperCase()}
                          </span>
                        )}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-bold text-zinc-900 dark:text-white truncate">
                            {prod.name}
                          </span>
                          <span className="text-xs font-semibold text-zinc-600 dark:text-zinc-300 shrink-0">
                            {currency.format(prod.unitPriceCents / 100)}
                          </span>
                        </div>

                        <div className="h-2 w-full bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden mt-1.5">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-[#610000] to-[#A63A2B] transition-all duration-500"
                            style={{
                              width: `${Math.max(
                                prod.sharePct,
                                prod.quantitySold > 0 ? 8 : 4
                              )}%`,
                            }}
                          />
                        </div>
                      </div>

                      <span className="w-9 text-right text-xs font-bold text-zinc-600 dark:text-zinc-400 shrink-0">
                        {prod.sharePct}%
                      </span>
                    </div>
                  ))
                ) : (
                  <div className="py-10 text-center text-xs text-zinc-400">
                    Nenhum produto cadastrado no cardápio ainda.
                  </div>
                )}
              </div>
            </div>

            {/* 4. Coluna Resumo Financeiro + 2 Mini-Cards Inferiores */}
            <div className="lg:col-span-5 flex flex-col gap-4">
              {/* Card Resumo Financeiro */}
              <div className="bg-white dark:bg-zinc-900 rounded-2xl p-5 border border-zinc-200/80 dark:border-zinc-800 shadow-xs">
                <div>
                  <h2 className="text-base font-extrabold text-zinc-900 dark:text-white">
                    Resumo Financeiro
                  </h2>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                    Movimentação do dia.
                  </p>
                </div>

                <div className="space-y-2.5 mt-4 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-2 text-zinc-600 dark:text-zinc-300 font-medium">
                      <span className="w-4 h-4 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 flex items-center justify-center text-[10px]">
                        ●
                      </span>
                      <span>Vendas</span>
                    </span>
                    <span className="font-extrabold text-zinc-900 dark:text-white">
                      {currency.format(todaySubtotalCents / 100)}
                    </span>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-2 text-zinc-600 dark:text-zinc-300 font-medium">
                      <span className="w-4 h-4 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 flex items-center justify-center text-[9px] font-bold">
                        %
                      </span>
                      <span>Taxa de serviço ({r.serviceFeePercent ?? 10}%)</span>
                    </span>
                    <span className="font-semibold text-zinc-700 dark:text-zinc-300">
                      {currency.format(todayServiceFeeCents / 100)}
                    </span>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-2 text-zinc-600 dark:text-zinc-300 font-medium">
                      <span className="w-4 h-4 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 flex items-center justify-center text-[10px]">
                        ✳
                      </span>
                      <span>Descontos</span>
                    </span>
                    <span className="font-semibold text-zinc-500">
                      - {currency.format(todayDiscountsCents / 100)}
                    </span>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-2 text-zinc-600 dark:text-zinc-300 font-medium">
                      <span className="w-4 h-4 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 flex items-center justify-center text-[10px]">
                        💳
                      </span>
                      <span>Taxas (cartão/PIX)</span>
                    </span>
                    <span className="font-semibold text-zinc-500">
                      - {currency.format(todayCardPixFeesCents / 100)}
                    </span>
                  </div>
                </div>

                {/* Barra Total Líquido */}
                <div className="bg-[#FAF3EB] dark:bg-zinc-800/80 rounded-xl p-3 mt-4 flex items-center justify-between border border-[#EFE3D4] dark:border-zinc-700">
                  <span className="flex items-center gap-2 text-xs font-bold text-zinc-800 dark:text-zinc-200">
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="text-[#610000] dark:text-amber-400"
                    >
                      <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
                      <polyline points="16 7 22 7 22 13" />
                    </svg>
                    <span>Total Líquido</span>
                  </span>
                  <span className="text-base font-extrabold text-[#610000] dark:text-amber-400">
                    {currency.format(todayNetTotalCents / 100)}
                  </span>
                </div>
              </div>

              {/* 2 Mini-Cards Lado a Lado: Avaliações do Google + Taxa de Serviço */}
              <div className="grid grid-cols-2 gap-3">
                {/* Mini-Card Esquerdo: Avaliações do Google */}
                <div className="bg-white dark:bg-zinc-900 rounded-2xl p-3.5 border border-zinc-200/80 dark:border-zinc-800 shadow-xs flex flex-col justify-between">
                  <div className="flex items-center gap-2">
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      className="shrink-0"
                    >
                      <path
                        fill="#4285F4"
                        d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17z"
                      />
                      <path
                        fill="#34A853"
                        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24z"
                      />
                      <path
                        fill="#FBBC05"
                        d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14z"
                      />
                      <path
                        fill="#EA4335"
                        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96z"
                      />
                    </svg>
                    <div className="min-w-0">
                      <span className="block text-[10.5px] font-bold text-zinc-800 dark:text-zinc-200 truncate">
                        Avaliações do Google
                      </span>
                      <div className="flex items-center gap-1 mt-0.5">
                        <span className="text-xs font-extrabold text-zinc-900 dark:text-white">
                          {reviewsStats.totalCount > 0
                            ? reviewsStats.avgRating.toFixed(1).replace(".", ",")
                            : "5,0"}
                        </span>
                        <span className="text-[10px] text-amber-400 tracking-tighter">
                          ★★★★★
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="mt-2.5 flex items-center justify-between gap-1">
                    <span className="text-[9.5px] text-zinc-400 truncate">
                      ({reviewsStats.totalCount} avaliações)
                    </span>
                    {r.googleReviewUrl ? (
                      <a
                        href={r.googleReviewUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="px-2 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 text-[9.5px] font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 shrink-0"
                      >
                        Ver avaliações ↗
                      </a>
                    ) : (
                      <Link
                        to={`/${r.slug}/admin/comentarios`}
                        className="px-2 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 text-[9.5px] font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 shrink-0"
                      >
                        Ver avaliações ↗
                      </Link>
                    )}
                  </div>
                </div>

                {/* Mini-Card Direito: Taxa de Serviço */}
                <div className="bg-white dark:bg-zinc-900 rounded-2xl p-3.5 border border-zinc-200/80 dark:border-zinc-800 shadow-xs flex flex-col justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-lg bg-[#FAF0E6] dark:bg-zinc-800 text-[#610000] dark:text-amber-400 flex items-center justify-center shrink-0 font-bold text-xs">
                      %
                    </div>
                    <span className="text-[10.5px] font-bold text-zinc-800 dark:text-zinc-200 truncate">
                      Taxa de serviço
                    </span>
                  </div>

                  <div className="mt-2.5 flex items-center justify-between gap-2">
                    <span className="text-lg font-extrabold text-zinc-900 dark:text-white">
                      {r.serviceFeePercent ?? 10}%
                    </span>
                    <Link
                      to={`/${r.slug}/admin/identidade`}
                      className="px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 text-[10px] font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
                    >
                      Configurar
                    </Link>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* COLUNA LATERAL DIREITA (3 COLUNAS) */}
        <div className="xl:col-span-3 flex flex-col gap-5">
          {/* 1. Card Ações Rápidas */}
          <div className="bg-white dark:bg-zinc-900 rounded-2xl p-5 border border-zinc-200/80 dark:border-zinc-800 shadow-xs">
            <h2 className="text-base font-extrabold text-zinc-900 dark:text-white mb-3.5">
              Ações rápidas
            </h2>

            <div className="grid grid-cols-2 gap-3">
              <Link
                to={`/${r.slug}/admin/financeiro`}
                className="p-3.5 rounded-xl bg-[#FAF8F5] dark:bg-zinc-800/70 hover:bg-[#F3ECE4] dark:hover:bg-zinc-800 border border-zinc-200/70 dark:border-zinc-700 transition-all flex items-start gap-2.5 group"
              >
                <div className="w-8 h-8 rounded-lg bg-white dark:bg-zinc-900 text-[#610000] dark:text-rose-400 flex items-center justify-center shrink-0 shadow-2xs group-hover:scale-105 transition-transform">
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M3 3v18h18" />
                    <path d="M18 17V9" />
                    <path d="M13 17V5" />
                    <path d="M8 17v-3" />
                  </svg>
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-extrabold text-zinc-900 dark:text-white truncate">
                    Relatórios
                  </p>
                  <p className="text-[10px] text-zinc-500 dark:text-zinc-400 truncate mt-0.5">
                    Desempenho
                  </p>
                </div>
              </Link>

              <Link
                to={`/${r.slug}/admin/estoque`}
                className="p-3.5 rounded-xl bg-[#FAF8F5] dark:bg-zinc-800/70 hover:bg-[#F3ECE4] dark:hover:bg-zinc-800 border border-zinc-200/70 dark:border-zinc-700 transition-all flex items-start gap-2.5 group"
              >
                <div className="w-8 h-8 rounded-lg bg-white dark:bg-zinc-900 text-[#610000] dark:text-rose-400 flex items-center justify-center shrink-0 shadow-2xs group-hover:scale-105 transition-transform">
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M16.5 9.4 7.55 4.24M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                    <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                    <line x1="12" y1="22.08" x2="12" y2="12" />
                  </svg>
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-extrabold text-zinc-900 dark:text-white truncate">
                    Estoque
                  </p>
                  <p className="text-[10px] text-zinc-500 dark:text-zinc-400 truncate mt-0.5">
                    Ver insumos
                  </p>
                </div>
              </Link>

              <Link
                to={`/${r.slug}/admin/identidade`}
                className="p-3.5 rounded-xl bg-[#FAF8F5] dark:bg-zinc-800/70 hover:bg-[#F3ECE4] dark:hover:bg-zinc-800 border border-zinc-200/70 dark:border-zinc-700 transition-all flex items-start gap-2.5 group"
              >
                <div className="w-8 h-8 rounded-lg bg-white dark:bg-zinc-900 text-[#610000] dark:text-rose-400 flex items-center justify-center shrink-0 shadow-2xs group-hover:scale-105 transition-transform">
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
                    <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
                    <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
                    <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
                    <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
                  </svg>
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-extrabold text-zinc-900 dark:text-white truncate">
                    Identidade
                  </p>
                  <p className="text-[10px] text-zinc-500 dark:text-zinc-400 truncate mt-0.5">
                    Personalizar
                  </p>
                </div>
              </Link>

              <Link
                to={`/${r.slug}/admin/equipe`}
                className="p-3.5 rounded-xl bg-[#FAF8F5] dark:bg-zinc-800/70 hover:bg-[#F3ECE4] dark:hover:bg-zinc-800 border border-zinc-200/70 dark:border-zinc-700 transition-all flex items-start gap-2.5 group"
              >
                <div className="w-8 h-8 rounded-lg bg-white dark:bg-zinc-900 text-[#610000] dark:text-rose-400 flex items-center justify-center shrink-0 shadow-2xs group-hover:scale-105 transition-transform">
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <line x1="19" y1="8" x2="19" y2="14" />
                    <line x1="22" y1="11" x2="16" y2="11" />
                  </svg>
                </div>
                <div className="min-w-0">
                  <span className="font-bold text-xs text-zinc-900 dark:text-white leading-tight block">
                    Novo<br />funcionário
                  </span>
                  <p className="text-[10px] text-zinc-500 dark:text-zinc-400 leading-tight mt-0.5">
                    Adicionar equipe
                  </p>
                </div>
              </Link>
            </div>
          </div>

          {/* 2. Card Últimas Movimentações */}
          <div className="bg-white dark:bg-zinc-900 rounded-2xl p-5 border border-zinc-200/80 dark:border-zinc-800 shadow-xs flex-1">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base font-extrabold text-zinc-900 dark:text-white">
                Últimas movimentações
              </h2>
              <Link
                to={`/${r.slug}/admin/financeiro`}
                className="text-xs font-bold text-[#610000] dark:text-amber-400 hover:underline"
              >
                Ver todas →
              </Link>
            </div>

            <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {activities.length > 0 ? (
                activities.map((act) => {
                  const iconConfig =
                    act.type === "order"
                      ? {
                          bg: "bg-amber-100 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300",
                          dot: "bg-rose-600",
                        }
                      : act.type === "payment"
                      ? {
                          bg: "bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300",
                          dot: "bg-emerald-500",
                        }
                      : act.type === "customer"
                      ? {
                          bg: "bg-purple-100 dark:bg-purple-950/60 text-purple-700 dark:text-purple-300",
                          dot: "bg-purple-500",
                        }
                      : act.type === "stock"
                      ? {
                          bg: "bg-orange-100 dark:bg-orange-950/60 text-orange-700 dark:text-orange-300",
                          dot: "bg-amber-500",
                        }
                      : {
                          bg: "bg-zinc-800 text-white",
                          dot: "bg-emerald-600",
                        };

                  return (
                    <div
                      key={act.id}
                      className="py-3 flex items-start justify-between gap-2.5"
                    >
                      <div className="flex items-start gap-2.5 min-w-0">
                        <div
                          className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${iconConfig.bg}`}
                        >
                          {act.type === "order" ? (
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
                              <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
                            </svg>
                          ) : act.type === "payment" ? (
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <rect width="20" height="14" x="2" y="5" rx="2" />
                              <line x1="2" x2="22" y1="10" y2="10" />
                            </svg>
                          ) : act.type === "customer" ? (
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                              <circle cx="9" cy="7" r="4" />
                            </svg>
                          ) : act.type === "stock" ? (
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                            </svg>
                          ) : (
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <rect width="18" height="18" x="3" y="4" rx="2" />
                              <line x1="16" y1="2" x2="16" y2="6" />
                              <line x1="8" y1="2" x2="8" y2="6" />
                            </svg>
                          )}
                        </div>

                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`w-1.5 h-1.5 rounded-full shrink-0 ${iconConfig.dot}`}
                            />
                            <p className="text-xs font-bold text-zinc-900 dark:text-white truncate">
                              {act.title}
                            </p>
                          </div>
                          <p className="text-[11px] text-zinc-500 dark:text-zinc-400 truncate mt-0.5">
                            {act.description}
                          </p>
                        </div>
                      </div>

                      <span className="text-[11px] font-medium text-zinc-400 shrink-0">
                        {act.timeFormatted}
                      </span>
                    </div>
                  );
                })
              ) : (
                <div className="py-8 text-center text-xs text-zinc-400">
                  Nenhuma movimentação registrada até o momento.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* =====================================================================
          MODAL DE PERSONALIZAÇÃO DO BANNER DO TOPO
          ===================================================================== */}
      {showBannerModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className="bg-white dark:bg-zinc-900 rounded-3xl max-w-md w-full p-6 border border-zinc-200 dark:border-zinc-800 shadow-2xl space-y-5">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-zinc-900 dark:text-white flex items-center gap-2">
                <span>Personalizar Banner</span>
              </h3>
              <button
                type="button"
                onClick={() => setShowBannerModal(false)}
                className="w-8 h-8 rounded-full flex items-center justify-center text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="flex p-1 bg-zinc-100 dark:bg-zinc-800 rounded-2xl">
              <button
                type="button"
                onClick={() =>
                  saveBannerConfig("image", bannerColor, bannerImage)
                }
                className={`flex-1 py-2 text-xs font-bold rounded-xl transition-all cursor-pointer ${
                  bannerMode === "image"
                    ? "bg-white dark:bg-zinc-900 text-zinc-900 dark:text-white shadow-2xs"
                    : "text-zinc-500 hover:text-zinc-900"
                }`}
              >
                Imagem de Fundo
              </button>
              <button
                type="button"
                onClick={() =>
                  saveBannerConfig("color", bannerColor, bannerImage)
                }
                className={`flex-1 py-2 text-xs font-bold rounded-xl transition-all cursor-pointer ${
                  bannerMode === "color"
                    ? "bg-white dark:bg-zinc-900 text-zinc-900 dark:text-white shadow-2xs"
                    : "text-zinc-500 hover:text-zinc-900"
                }`}
              >
                Cor Sólida
              </button>
            </div>

            {bannerMode === "image" ? (
              <div className="space-y-4">
                <div className="h-32 rounded-2xl overflow-hidden border border-zinc-200 dark:border-zinc-700 relative bg-zinc-100 dark:bg-zinc-800">
                  <img
                    src={bannerImage}
                    alt="Banner"
                    className="w-full h-full object-cover"
                  />
                  <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                    <button
                      type="button"
                      onClick={() => bannerFileInputRef.current?.click()}
                      className="px-4 py-2 rounded-xl bg-white text-zinc-900 text-xs font-bold shadow-md hover:bg-zinc-100 transition-all cursor-pointer"
                    >
                      Trocar foto do banner
                    </button>
                  </div>
                </div>

                <input
                  ref={bannerFileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      const reader = new FileReader();
                      reader.onload = (ev) => {
                        const res = ev.target?.result as string;
                        if (res) {
                          setCropRawSrc(res);
                          setCropTarget("banner");
                        }
                      };
                      reader.readAsDataURL(file);
                    }
                    e.target.value = "";
                  }}
                />

                <div className="flex gap-2">
                  {r.cover?.url && (
                    <button
                      type="button"
                      onClick={() =>
                        saveBannerConfig("image", bannerColor, r.cover!.url)
                      }
                      className="flex-1 py-2 px-3 rounded-xl border border-zinc-200 dark:border-zinc-700 text-xs font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-center cursor-pointer"
                    >
                      Usar capa do restaurante
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      saveBannerConfig(
                        "image",
                        bannerColor,
                        "https://images.unsplash.com/photo-1544025162-d76694265947?w=1600&auto=format&fit=crop&q=80"
                      )
                    }
                    className="flex-1 py-2 px-3 rounded-xl border border-zinc-200 dark:border-zinc-700 text-xs font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-center cursor-pointer"
                  >
                    Imagem padrão
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-bold text-zinc-700 dark:text-zinc-300 mb-2">
                    Cores Pré-definidas
                  </label>
                  <div className="grid grid-cols-5 gap-2">
                    {PRESET_COLORS.map((col) => (
                      <button
                        key={col.hex}
                        type="button"
                        onClick={() =>
                          saveBannerConfig("color", col.hex, bannerImage)
                        }
                        className={`h-11 rounded-xl transition-all cursor-pointer relative flex items-center justify-center border-2 ${
                          bannerColor === col.hex
                            ? "border-amber-400 scale-105 shadow-md"
                            : "border-transparent"
                        }`}
                        style={{ backgroundColor: col.hex }}
                        title={col.name}
                      >
                        {bannerColor === col.hex && (
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="#ffffff"
                            strokeWidth="3"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-bold text-zinc-700 dark:text-zinc-300 mb-1.5">
                    Cor personalizada (HEX)
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={bannerColor}
                      onChange={(e) =>
                        saveBannerConfig("color", e.target.value, bannerImage)
                      }
                      className="w-10 h-10 p-0 border-0 rounded-xl cursor-pointer bg-transparent"
                    />
                    <input
                      type="text"
                      maxLength={7}
                      value={bannerColor}
                      onChange={(e) =>
                        saveBannerConfig("color", e.target.value, bannerImage)
                      }
                      className="w-full px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 font-mono text-xs font-bold uppercase"
                    />
                  </div>
                </div>
              </div>
            )}

            <div className="pt-2">
              <button
                type="button"
                onClick={() => setShowBannerModal(false)}
                className="w-full py-2.5 rounded-xl bg-[#610000] hover:bg-[#4a0000] text-white text-xs font-bold shadow-md transition-colors cursor-pointer"
              >
                Pronto
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de Enquadramento e Pan & Zoom com Canvas */}
      {cropTarget && cropRawSrc && (
        <ImageCropModal
          isOpen={true}
          imageSrc={cropRawSrc}
          title={
            cropTarget === "logo"
              ? "Ajustar logo do restaurante"
              : "Ajustar fachada / banner"
          }
          aspectRatio={cropTarget === "logo" ? 1 : 16 / 6}
          outputWidth={cropTarget === "logo" ? 500 : 1200}
          outputHeight={cropTarget === "logo" ? 500 : 450}
          onCancel={() => {
            setCropTarget(null);
            setCropRawSrc(null);
          }}
          onConfirm={(croppedFile) => {
            if (cropTarget === "logo") {
              void handleLogoFileChange(croppedFile);
            } else {
              void handleBannerFileCropConfirm(croppedFile);
            }
            setCropTarget(null);
            setCropRawSrc(null);
          }}
        />
      )}
    </div>
  );
}

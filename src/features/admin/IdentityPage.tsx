import { contactUrl, visibleContactUrls, type ContactChannels } from "../restaurants/contactChannels";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  useRestaurant,
  type RestaurantIdentity,
  type IdentityMedia,
} from "../restaurants/RestaurantProvider";
import { preparePhoto, type DraftPhoto } from "./menuMedia";
import { contrast, saveIdentity, uploadIdentity } from "./restaurantAdmin";
import { getAdminCatalog, type AdminProduct } from "./adminCatalog";

type Media = DraftPhoto | IdentityMedia | null;

function preview(m: Media) {
  return (m && (("previewUrl" in m && m.previewUrl) || m.url)) || "";
}

function release(m: Media) {
  if (m && "previewUrl" in m && m.previewUrl) URL.revokeObjectURL(m.previewUrl);
}

const FONT_OPTIONS = [
  { value: "Inter", label: "Inter", css: "'Inter', sans-serif" },
  { value: "Playfair Display", label: "Playfair Display", css: "'Playfair Display', serif" },
  { value: "Montserrat", label: "Montserrat", css: "'Montserrat', sans-serif" },
  { value: "Poppins", label: "Poppins", css: "'Poppins', sans-serif" },
  { value: "Roboto", label: "Roboto", css: "'Roboto', sans-serif" },
  { value: "Open Sans", label: "Open Sans", css: "'Open Sans', sans-serif" },
];

function getFontFamily(fontName: string) {
  const found = FONT_OPTIONS.find((f) => f.value === fontName);
  return found ? found.css : `'${fontName}', sans-serif`;
}

type TabKey = "logo-capa" | "cores" | "tipografia" | "informacoes" | "taxas" | "redes";

export function IdentityPage() {
  const { restaurant, reload } = useRestaurant();

  // Estados principais da identidade (Supabase)
  const [draft, setDraft] = useState<RestaurantIdentity>(() => ({
    ...restaurant,
    brandPrimaryColor:
      restaurant.brandPrimaryColor ||
      restaurant.brand_primary_color ||
      restaurant.theme.primary ||
      "#722D08",
    headerNameColor:
      restaurant.headerNameColor ||
      restaurant.header_name_color ||
      "#1c1917",
    headerSubtitleColor:
      restaurant.headerSubtitleColor ||
      restaurant.header_subtitle_color ||
      "#57534e",
    theme: {
      primary: restaurant.brandPrimaryColor || restaurant.theme.primary || "#722D08",
      background: restaurant.theme.background || "#FFF8EF",
      text: restaurant.theme.text || "#1c1917",
    },
  }));

  const [logo, setLogo] = useState<Media>(restaurant.logo);
  const [cover, setCover] = useState<Media>(restaurant.cover);
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [catalogProducts, setCatalogProducts] = useState<AdminProduct[]>([]);

  // Estados complementares de Design e Operação (Persistidos localmente)
  const [secondaryColor, setSecondaryColor] = useState(() => {
    try {
      return localStorage.getItem(`elozi_id_secondary_${restaurant.id}`) || "#D9B28C";
    } catch {
      return "#D9B28C";
    }
  });

  const [highlightColor, setHighlightColor] = useState(() => {
    try {
      return localStorage.getItem(`elozi_id_highlight_${restaurant.id}`) || "#E8DCCB";
    } catch {
      return "#E8DCCB";
    }
  });

  const [titleFont, setTitleFont] = useState(() => {
    try {
      return localStorage.getItem(`elozi_id_font_title_${restaurant.id}`) || "Inter";
    } catch {
      return "Inter";
    }
  });

  const [bodyFont, setBodyFont] = useState(() => {
    try {
      return localStorage.getItem(`elozi_id_font_body_${restaurant.id}`) || "Inter";
    } catch {
      return "Inter";
    }
  });

  const [highlightFont, setHighlightFont] = useState(() => {
    try {
      return localStorage.getItem(`elozi_id_font_highlight_${restaurant.id}`) || "Montserrat";
    } catch {
      return "Montserrat";
    }
  });

  const [couvertFee, setCouvertFee] = useState(() => {
    try {
      return localStorage.getItem(`elozi_id_couvert_${restaurant.id}`) || "0,00";
    } catch {
      return "0,00";
    }
  });

  const [wifiSsid, setWifiSsid] = useState(() => {
    try {
      return localStorage.getItem(`elozi_id_wifi_ssid_${restaurant.id}`) || "Wi-Fi Clientes";
    } catch {
      return "Wi-Fi Clientes";
    }
  });

  const [wifiPassword, setWifiPassword] = useState(() => {
    try {
      return localStorage.getItem(`elozi_id_wifi_pass_${restaurant.id}`) || "sabor2026";
    } catch {
      return "sabor2026";
    }
  });

  const [showWifi, setShowWifi] = useState(() => {
    try {
      const val = localStorage.getItem(`elozi_id_show_wifi_${restaurant.id}`);
      return val !== null ? val === "true" : true;
    } catch {
      return true;
    }
  });

  const loadContacts = (): ContactChannels => {
    if (restaurant.contactChannels) return restaurant.contactChannels;
    const legacy = (key: string, fallback = '') => {
      try { return localStorage.getItem(`elozi_id_${key}_${restaurant.id}`) || fallback; } catch { return fallback; }
    };
    return {
      instagram: { value: legacy('instagram'), enabled: true },
      whatsapp: { value: legacy('whatsapp', restaurant.phone), enabled: true },
      facebook: { value: legacy('facebook'), enabled: true },
    };
  };
  const [contacts, setContacts] = useState<ContactChannels>(loadContacts);
  const instagram = contacts.instagram.value, whatsapp = contacts.whatsapp.value, facebook = contacts.facebook.value;
  const setContactValue = (key: keyof ContactChannels, value: string) => setContacts(old => ({...old,[key]: {...old[key],value}}));
  const setInstagram = (value: string) => setContactValue('instagram',value);
  const setWhatsapp = (value: string) => setContactValue('whatsapp',value);
  const setFacebook = (value: string) => setContactValue('facebook',value);
  const publicContacts = visibleContactUrls(contacts);
  const [showAddressPhoneOnMenu, setShowAddressPhoneOnMenu] = useState(() => {
    try {
      const val = localStorage.getItem(`elozi_id_show_address_phone_${restaurant.id}`);
      return val !== null ? val === "true" : true;
    } catch {
      return true;
    }
  });

  const [bannerTitle, setBannerTitle] = useState(() => {
    try {
      return (
        localStorage.getItem(`elozi_id_banner_title_${restaurant.id}`) ||
        (restaurant as unknown as Record<string, unknown>).bannerTitle as string ||
        (restaurant as unknown as Record<string, unknown>).banner_title as string ||
        "Destaques da Semana"
      );
    } catch {
      return "Destaques da Semana";
    }
  });

  const [bannerSubtitle, setBannerSubtitle] = useState(() => {
    try {
      return (
        localStorage.getItem(`elozi_id_banner_subtitle_${restaurant.id}`) ||
        (restaurant as unknown as Record<string, unknown>).bannerSubtitle as string ||
        (restaurant as unknown as Record<string, unknown>).banner_subtitle as string ||
        "O melhor da nossa culinária contemporânea"
      );
    } catch {
      return "O melhor da nossa culinária contemporânea";
    }
  });

  // Salva extras no LocalStorage
  useEffect(() => {
    if (restaurant.id) {
      localStorage.setItem(`elozi_id_secondary_${restaurant.id}`, secondaryColor);
      localStorage.setItem(`elozi_id_highlight_${restaurant.id}`, highlightColor);
      localStorage.setItem(`elozi_id_font_title_${restaurant.id}`, titleFont);
      localStorage.setItem(`elozi_id_font_body_${restaurant.id}`, bodyFont);
      localStorage.setItem(`elozi_id_font_highlight_${restaurant.id}`, highlightFont);
      localStorage.setItem(`elozi_id_couvert_${restaurant.id}`, couvertFee);
      localStorage.setItem(`elozi_id_wifi_ssid_${restaurant.id}`, wifiSsid);
      localStorage.setItem(`elozi_id_wifi_pass_${restaurant.id}`, wifiPassword);
      localStorage.setItem(`elozi_id_show_wifi_${restaurant.id}`, String(showWifi));
      localStorage.setItem(`elozi_id_show_address_phone_${restaurant.id}`, String(showAddressPhoneOnMenu));
      localStorage.setItem(`elozi_id_banner_title_${restaurant.id}`, bannerTitle);
      localStorage.setItem(`elozi_id_banner_subtitle_${restaurant.id}`, bannerSubtitle);
    }
  }, [
    secondaryColor,
    highlightColor,
    titleFont,
    bodyFont,
    highlightFont,
    couvertFee,
    wifiSsid,
    wifiPassword,
    showWifi,
    showAddressPhoneOnMenu,
    bannerTitle,
    bannerSubtitle,
    restaurant.id,
  ]);

  // Carrega fontes do Google Fonts dinamicamente
  useEffect(() => {
    const linkId = "elozi-google-fonts-identity";
    if (!document.getElementById(linkId)) {
      const link = document.createElement("link");
      link.id = linkId;
      link.rel = "stylesheet";
      link.href =
        "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Montserrat:wght@400;600;700;800&family=Open+Sans:wght@400;600;700&family=Playfair+Display:ital,wght@0,600;0,700;0,800;1,600&family=Poppins:wght@400;500;600;700&family=Roboto:wght@400;500;700&display=swap";
      document.head.appendChild(link);
    }
  }, []);

  // Refs de arquivo
  const logoInputRef = useRef<HTMLInputElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);

  // Refs de inputs de cor invisíveis para acionar clique
  const colorInputPrimaryRef = useRef<HTMLInputElement>(null);
  const colorInputSecondaryRef = useRef<HTMLInputElement>(null);
  const colorInputHighlightRef = useRef<HTMLInputElement>(null);
  const colorInputBgRef = useRef<HTMLInputElement>(null);

  // Refs das seções para scroll suave pelas Abas
  const [activeTab, setActiveTab] = useState<TabKey>("logo-capa");
  const sectionLogoRef = useRef<HTMLDivElement>(null);
  const sectionCoresRef = useRef<HTMLDivElement>(null);
  const sectionTipoRef = useRef<HTMLDivElement>(null);
  const sectionInfoRef = useRef<HTMLDivElement>(null);
  const sectionTaxasRef = useRef<HTMLDivElement>(null);
  const sectionRedesRef = useRef<HTMLDivElement>(null);

  const scrollToSection = (tab: TabKey) => {
    setActiveTab(tab);
    const map: Record<TabKey, React.RefObject<HTMLDivElement | null>> = {
      "logo-capa": sectionLogoRef,
      cores: sectionCoresRef,
      tipografia: sectionTipoRef,
      informacoes: sectionInfoRef,
      taxas: sectionTaxasRef,
      redes: sectionRedesRef,
    };
    const target = map[tab]?.current;
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const live = useRef({ logo, cover });
  live.current = { logo, cover };
  const mounted = useRef(true);
  const processing = useRef(false);
  const submitting = useRef(false);
  const uploads = useRef(new Map<string, string>());

  // Carrega produtos reais do cardápio do restaurante para preview
  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    void getAdminCatalog(restaurant.slug)
      .then((c) => {
        if (!disposed) {
          const availableProducts = c.products.filter((p) => p.available);
          setCatalogProducts(availableProducts.length > 0 ? availableProducts : c.products);
        }
      })
      .catch(() => {});
    return () => {
      disposed = true;
      mounted.current = false;
      release(live.current.logo);
      release(live.current.cover);
    };
  }, [restaurant.slug]);

  const brandContrast = contrast(draft.brandPrimaryColor || draft.theme.primary, "#FFFFFF");
  const textContrast = contrast(draft.theme.text, draft.theme.background);
  const validColors =
    Number.isFinite(brandContrast) &&
    Number.isFinite(textContrast) &&
    brandContrast >= 4.5 &&
    textContrast >= 4.5;

  function field(key: keyof RestaurantIdentity, value: any) {
    setDraft((d) => ({ ...d, [key]: value }));
    setNotice("");
  }

  async function photo(file: File | undefined, key: "logo" | "cover") {
    if (!file || processing.current || submitting.current) return;
    processing.current = true;
    setPreparing(true);
    setError("");
    setNotice("");
    try {
      const prepared = await preparePhoto(
        file,
        key === "logo" ? "Logo do restaurante" : "Capa do restaurante",
        key === "logo" ? "logo" : "cover"
      );
      if (!mounted.current) {
        release(prepared);
        return;
      }
      release(live.current[key]);
      if (key === "logo") setLogo(prepared);
      else setCover(prepared);
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : "Não foi possível preparar a foto.");
    } finally {
      processing.current = false;
      if (mounted.current) setPreparing(false);
    }
  }

  function handleRemoveLogo() {
    release(logo);
    setLogo(null);
    setDraft((prev) => ({ ...prev, logo: null }));
  }

  function handleRemoveCover() {
    release(cover);
    setCover(null);
    setDraft((prev) => ({ ...prev, cover: null }));
  }

  function reset() {
    setContacts(loadContacts());
    release(logo);
    release(cover);
    setDraft({
      ...restaurant,
      brandPrimaryColor:
        restaurant.brandPrimaryColor ||
        restaurant.brand_primary_color ||
        restaurant.theme.primary ||
        "#722D08",
      headerNameColor:
        restaurant.headerNameColor ||
        restaurant.header_name_color ||
        "#1c1917",
      headerSubtitleColor:
        restaurant.headerSubtitleColor ||
        restaurant.header_subtitle_color ||
        "#57534e",
      theme: {
        primary: restaurant.brandPrimaryColor || restaurant.theme.primary || "#722D08",
        background: restaurant.theme.background || "#FFF8EF",
        text: restaurant.theme.text || "#1c1917",
      },
    });
    setLogo(restaurant.logo);
    setCover(restaurant.cover);
    setBannerTitle("Destaques da Semana");
    setBannerSubtitle("O melhor da nossa culinária contemporânea");
    setError("");
    setNotice("Alterações descartadas.");
  }

  function resetColors() {
    const primary = "#722D08";
    const background = "#FFF8EF";
    setDraft((d) => ({
      ...d,
      brandPrimaryColor: primary,
      theme: {
        ...d.theme,
        primary: primary,
        background: background,
      },
    }));
    setSecondaryColor("#D9B28C");
    setHighlightColor("#E8DCCB");
    setNotice("Cores restauradas para os padrões da marca.");
  }

  async function submit(event?: FormEvent) {
    if (event) event.preventDefault();
    if (submitting.current || processing.current) return;
    if (!validColors) {
      setError("Ajuste as cores para atingir contraste mínimo de 4,5:1 nos textos e botões.");
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const nextLogo = await uploadIdentity(logo, restaurant.id, uploads.current);
      const nextCover = await uploadIdentity(cover, restaurant.id, uploads.current);
      const saved = await saveIdentity({ ...draft, contactChannels: contacts }, nextLogo, nextCover);
      if (!mounted.current) return;
      release(logo);
      release(cover);
      setDraft(saved);
      if (saved.contactChannels) setContacts(saved.contactChannels);
      setLogo(saved.logo);
      setCover(saved.cover);
      setNotice("Identidade visual salva com sucesso! Seu cardápio foi atualizado.");
      await reload();
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : "Não foi possível salvar a identidade.");
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const primaryColor = draft.brandPrimaryColor || draft.theme.primary || "#722D08";
  const backgroundColor = draft.theme.background || "#FFF8EF";
  const textColor = draft.theme.text || "#1c1917";

  return (
    <div className="mx-auto max-w-[1440px] space-y-4 text-zinc-900 dark:text-zinc-100 antialiased pb-16 pt-[10px]">
      {/* =========================================================================
          1. CABEÇALHO DA PÁGINA (TOPO) COM ÍCONE DE PINCEL E 3 BOTÕES À DIREITA
          ========================================================================= */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <div className="w-12 h-12 rounded-2xl bg-[#F5E6D8] text-[#722D08] flex items-center justify-center shrink-0 shadow-2xs">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m18.37 2.63 3 3L13 14l-4 1 1-4 8.37-8.37z" />
              <path d="M9 15c-3 1-6 4-7 7 3-1 6-4 7-7z" />
            </svg>
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-white">
              Identidade visual
            </h1>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
              Personalize a aparência do seu cardápio digital e na tela do cliente, mantendo a identidade da sua marca.
            </p>
          </div>
        </div>

        {/* 3 Botões Alinhados Lado a Lado */}
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={() => window.open(`/${draft.slug || restaurant.slug}`, "_blank")}
            className="px-4 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-semibold text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-700/50 transition-colors flex items-center gap-2 shadow-2xs cursor-pointer"
            title="Abrir cardápio em nova aba"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            <span>Visualizar no cardápio</span>
          </button>

          <button
            type="button"
            onClick={reset}
            disabled={busy || preparing}
            className="px-4 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700/50 transition-colors shadow-2xs disabled:opacity-40 cursor-pointer flex items-center gap-1.5"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
            <span>Cancelar</span>
          </button>

          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || preparing}
            className="bg-[#610000] hover:bg-[#4a0000] text-white text-xs font-bold px-5 py-2.5 rounded-xl shadow-sm transition-all flex items-center gap-2 disabled:opacity-50 cursor-pointer"
          >
            {preparing ? (
              <>
                <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                </svg>
                <span>Preparando imagem…</span>
              </>
            ) : busy ? (
              <>
                <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 6v6l4 2" />
                </svg>
                <span>Salvando…</span>
              </>
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                  <polyline points="17 21 17 13 7 13 7 21" />
                  <polyline points="7 3 7 8 15 8" />
                </svg>
                <span>Salvar alterações</span>
              </>
            )}
          </button>
        </div>
      </div>

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
            className="text-rose-600 dark:text-rose-300 hover:text-rose-900 font-bold ml-2 cursor-pointer"
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
            className="text-emerald-600 dark:text-emerald-300 hover:text-emerald-900 font-bold ml-2 cursor-pointer"
          >
            ✕
          </button>
        </div>
      )}

      {/* =========================================================================
          2. BARRA DE ABAS ESTILO PILL CONTÍNUA (6 ABAS COM ÍCONES SVG)
          ========================================================================= */}
      <div className="bg-white dark:bg-[#18181b] rounded-2xl p-1.5 border border-zinc-200/80 dark:border-zinc-800 flex items-center gap-1.5 overflow-x-auto shadow-2xs">
        <button
          type="button"
          onClick={() => scrollToSection("logo-capa")}
          className={`flex items-center gap-2 px-4 py-2 text-xs font-bold rounded-xl transition-all cursor-pointer whitespace-nowrap ${
            activeTab === "logo-capa"
              ? "bg-[#610000] text-white shadow-xs"
              : "text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 hover:bg-zinc-100/60 dark:hover:bg-zinc-800/60"
          }`}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
            <circle cx="9" cy="9" r="2" />
            <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
          </svg>
          <span>Logo e capa</span>
        </button>

        <button
          type="button"
          onClick={() => scrollToSection("cores")}
          className={`flex items-center gap-2 px-4 py-2 text-xs font-bold rounded-xl transition-all cursor-pointer whitespace-nowrap ${
            activeTab === "cores"
              ? "bg-[#610000] text-white shadow-xs"
              : "text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 hover:bg-zinc-100/60 dark:hover:bg-zinc-800/60"
          }`}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
            <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
            <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
            <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
            <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
          </svg>
          <span>Cores da marca</span>
        </button>

        <button
          type="button"
          onClick={() => scrollToSection("tipografia")}
          className={`flex items-center gap-2 px-4 py-2 text-xs font-bold rounded-xl transition-all cursor-pointer whitespace-nowrap ${
            activeTab === "tipografia"
              ? "bg-[#610000] text-white shadow-xs"
              : "text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 hover:bg-zinc-100/60 dark:hover:bg-zinc-800/60"
          }`}
        >
          <span className="font-serif font-black text-xs leading-none">Aa</span>
          <span>Tipografia</span>
        </button>

        <button
          type="button"
          onClick={() => scrollToSection("informacoes")}
          className={`flex items-center gap-2 px-4 py-2 text-xs font-bold rounded-xl transition-all cursor-pointer whitespace-nowrap ${
            activeTab === "informacoes"
              ? "bg-[#610000] text-white shadow-xs"
              : "text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 hover:bg-zinc-100/60 dark:hover:bg-zinc-800/60"
          }`}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7" />
            <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
            <path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4" />
            <path d="M2 7h20" />
            <circle cx="12" cy="7" r="1" />
          </svg>
          <span>Informações</span>
        </button>

        <button
          type="button"
          onClick={() => scrollToSection("taxas")}
          className={`flex items-center gap-2 px-4 py-2 text-xs font-bold rounded-xl transition-all cursor-pointer whitespace-nowrap ${
            activeTab === "taxas"
              ? "bg-[#610000] text-white shadow-xs"
              : "text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 hover:bg-zinc-100/60 dark:hover:bg-zinc-800/60"
          }`}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" />
            <path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" />
            <path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" />
          </svg>
          <span>Taxas e avaliações</span>
        </button>

        <button
          type="button"
          onClick={() => scrollToSection("redes")}
          className={`flex items-center gap-2 px-4 py-2 text-xs font-bold rounded-xl transition-all cursor-pointer whitespace-nowrap ${
            activeTab === "redes"
              ? "bg-[#610000] text-white shadow-xs"
              : "text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 hover:bg-zinc-100/60 dark:hover:bg-zinc-800/60"
          }`}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="18" cy="5" r="3" />
            <circle cx="6" cy="12" r="3" />
            <circle cx="18" cy="19" r="3" />
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
            <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
          </svg>
          <span>Redes e horários</span>
        </button>
      </div>

      {/* =========================================================================
          3. ESTRUTURA PRINCIPAL: COLUNA ESQUERDA (8) + COLUNA DIREITA (4)
          ========================================================================= */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-start">
        {/* =====================================================================
            COLUNA ESQUERDA: 3 LINHAS DE CARDS CONFORME A IMAGEM DE REFERÊNCIA
            ===================================================================== */}
        <div className="xl:col-span-8 flex flex-col gap-5">
          {/* =========================================================================
              ABA 1: LOGO E CAPA + BANNER DE DESTAQUES (100% LARGURA)
              ========================================================================= */}
          {activeTab === "logo-capa" && (
            <>
              {/* CARD 1: Logo e capa */}
              <div
                ref={sectionLogoRef}
                id="logo-capa"
                className="w-full bg-white dark:bg-[#18181b] rounded-2xl border border-zinc-200/80 dark:border-zinc-800 p-5 sm:p-6 shadow-2xs space-y-4"
              >
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-[#FAF0E6] dark:bg-zinc-800 text-[#722D08] dark:text-rose-400 flex items-center justify-center shrink-0">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
                      <circle cx="9" cy="9" r="2" />
                      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
                    </svg>
                  </div>
                  <div>
                    <h2 className="text-sm font-bold text-zinc-900 dark:text-white">Logo e capa</h2>
                    <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                      Use imagens de alta qualidade para um resultado profissional.
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
                  {/* Logo do restaurante */}
                  <div className="space-y-2">
                    <span className="text-[11px] font-bold text-zinc-700 dark:text-zinc-300 block">
                      Logo do restaurante
                    </span>

                    <div className="h-36 rounded-xl bg-[#FBF8F5] dark:bg-zinc-900/60 border border-zinc-200/90 dark:border-zinc-800 flex items-center justify-center p-3 relative overflow-hidden group">
                      {preview(logo) ? (
                        <>
                          <img src={preview(logo)} alt="Logo" className="max-h-full max-w-full object-contain" />
                          <button
                            type="button"
                            onClick={handleRemoveLogo}
                            aria-label="Remover logo"
                            title="Remover logo"
                            className="absolute top-2 right-2 w-7 h-7 rounded-full bg-white/90 hover:bg-red-50 text-zinc-600 hover:text-red-600 shadow-sm flex items-center justify-center transition-colors border border-zinc-200 cursor-pointer z-10"
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <line x1="18" y1="6" x2="6" y2="18" />
                              <line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                          </button>
                        </>
                      ) : (
                        <div className="flex flex-col items-center justify-center text-center">
                          <span
                            className="font-black text-sm tracking-[0.2em] text-zinc-900 dark:text-white uppercase"
                            style={{ fontFamily: getFontFamily(titleFont) }}
                          >
                            {draft.name || "NOMA"}
                          </span>
                          <span className="text-[7px] font-bold tracking-[0.16em] text-zinc-500 uppercase mt-0.5">
                            {draft.subtitle || "RESTAURANTE E BAR"}
                          </span>
                        </div>
                      )}

                      <input
                        ref={logoInputRef}
                        type="file"
                        className="hidden"
                        accept="image/jpeg,image/png,image/webp"
                        onChange={(e) => {
                          void photo(e.target.files?.[0], "logo");
                          e.target.value = "";
                        }}
                      />
                    </div>

                    <button
                      type="button"
                      onClick={() => logoInputRef.current?.click()}
                      className="w-full py-2 px-3 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-bold text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-700/50 shadow-2xs flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="17 8 12 3 7 8" />
                        <line x1="12" y1="3" x2="12" y2="15" />
                      </svg>
                      <span>Trocar logo</span>
                    </button>

                    <p className="text-[10px] text-zinc-400 text-center leading-tight">
                      Recomendado: 192×108 px (JPG, PNG ou WebP)
                    </p>
                  </div>

                  {/* Capa do cardápio */}
                  <div className="space-y-2">
                    <span className="text-[11px] font-bold text-zinc-700 dark:text-zinc-300 block">
                      Capa do cardápio
                    </span>

                    <div className="h-36 rounded-xl overflow-hidden border border-zinc-200/90 dark:border-zinc-800 relative bg-zinc-100 dark:bg-zinc-800 group">
                      {preview(cover) ? (
                        <>
                          <img
                            src={preview(cover)}
                            alt="Capa"
                            className="w-full h-full object-cover"
                          />
                          <button
                            type="button"
                            onClick={handleRemoveCover}
                            aria-label="Remover capa"
                            title="Remover capa"
                            className="absolute top-2 right-2 w-7 h-7 rounded-full bg-white/90 hover:bg-red-50 text-zinc-600 hover:text-red-600 shadow-sm flex items-center justify-center transition-colors border border-zinc-200 cursor-pointer z-10"
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <line x1="18" y1="6" x2="6" y2="18" />
                              <line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                          </button>
                        </>
                      ) : (
                        <div className="w-full h-full flex flex-col items-center justify-center text-zinc-400 bg-zinc-50 dark:bg-zinc-900/40 p-2 text-center">
                          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mb-1 text-zinc-300 dark:text-zinc-600">
                            <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
                            <circle cx="9" cy="9" r="2" />
                            <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
                          </svg>
                          <span className="text-[11px] font-medium text-zinc-400">Sem capa definida</span>
                        </div>
                      )}

                      <input
                        ref={coverInputRef}
                        type="file"
                        className="hidden"
                        accept="image/jpeg,image/png,image/webp"
                        onChange={(e) => {
                          void photo(e.target.files?.[0], "cover");
                          e.target.value = "";
                        }}
                      />
                    </div>

                    <button
                      type="button"
                      onClick={() => coverInputRef.current?.click()}
                      className="w-full py-2 px-3 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-bold text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-700/50 shadow-2xs flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="17 8 12 3 7 8" />
                        <line x1="12" y1="3" x2="12" y2="15" />
                      </svg>
                      <span>Trocar capa</span>
                    </button>

                    <p className="text-[10px] text-zinc-400 text-center leading-tight">
                      Recomendado: 1920×1080 px (JPG, PNG ou WebP)
                    </p>
                  </div>
                </div>
              </div>

              {/* CARD BANNER DE DESTAQUES */}
              <div className="w-full bg-white dark:bg-[#18181b] rounded-2xl border border-zinc-200/80 dark:border-zinc-800 p-5 sm:p-6 shadow-2xs space-y-4">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-[#FAF0E6] dark:bg-zinc-800 text-[#722D08] dark:text-rose-400 flex items-center justify-center shrink-0">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                    </svg>
                  </div>
                  <div>
                    <h2 className="text-sm font-bold text-zinc-900 dark:text-white">Banner de destaques do cardápio</h2>
                    <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                      Personalize os textos do banner principal exibido no cardápio público.
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
                  <div>
                    <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
                      Título do banner de destaques
                    </label>
                    <input
                      type="text"
                      maxLength={80}
                      placeholder="Destaques da Semana"
                      value={bannerTitle}
                      onChange={(e) => setBannerTitle(e.target.value)}
                      className="w-full px-3.5 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-semibold text-zinc-800 dark:text-zinc-100"
                    />
                    <p className="text-[10px] text-zinc-400 mt-1">Exibido em destaque sobre a imagem do banner.</p>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
                      Subtítulo do banner de destaques
                    </label>
                    <input
                      type="text"
                      maxLength={140}
                      placeholder="O melhor da nossa culinária contemporânea"
                      value={bannerSubtitle}
                      onChange={(e) => setBannerSubtitle(e.target.value)}
                      className="w-full px-3.5 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-semibold text-zinc-800 dark:text-zinc-100"
                    />
                    <p className="text-[10px] text-zinc-400 mt-1">Linha explicativa curta logo abaixo do título.</p>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* =========================================================================
              ABA 2: CORES DA MARCA (100% LARGURA)
              ========================================================================= */}
          {activeTab === "cores" && (
            <div
              ref={sectionCoresRef}
              id="cores-marca"
              className="w-full bg-white dark:bg-[#18181b] rounded-2xl border border-zinc-200/80 dark:border-zinc-800 p-5 sm:p-6 shadow-2xs space-y-5"
            >
              <div>
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-[#FAF0E6] dark:bg-zinc-800 text-[#722D08] dark:text-rose-400 flex items-center justify-center shrink-0">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
                      <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
                      <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
                      <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
                      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
                    </svg>
                  </div>
                  <div>
                    <h2 className="text-sm font-bold text-zinc-900 dark:text-white">Cores da marca</h2>
                    <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                      Defina as cores que serão usadas no seu cardápio.
                    </p>
                  </div>
                </div>

                {/* 4 Cards de Cores */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5 pt-4">
                  {/* Principal */}
                  <div className="p-3 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-[#FAF8F5] dark:bg-zinc-900/60 text-center space-y-1.5">
                    <div
                      onClick={() => colorInputPrimaryRef.current?.click()}
                      className="h-16 w-full rounded-lg cursor-pointer shadow-2xs relative border border-black/10 transition-transform hover:scale-[1.02]"
                      style={{ backgroundColor: draft.brandPrimaryColor || "#722D08" }}
                    >
                      <input
                        ref={colorInputPrimaryRef}
                        type="color"
                        value={draft.brandPrimaryColor || "#722D08"}
                        onChange={(e) => {
                          const col = e.target.value;
                          setDraft((d) => ({
                            ...d,
                            brandPrimaryColor: col,
                            theme: { ...d.theme, primary: col },
                          }));
                        }}
                        className="sr-only"
                      />
                    </div>
                    <span className="text-xs font-bold text-zinc-800 dark:text-zinc-200 block truncate">
                      Principal
                    </span>
                    <span className="text-[10px] font-mono text-zinc-500 uppercase block">
                      {draft.brandPrimaryColor || "#722D08"}
                    </span>
                  </div>

                  {/* Secundária */}
                  <div className="p-3 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-[#FAF8F5] dark:bg-zinc-900/60 text-center space-y-1.5">
                    <div
                      onClick={() => colorInputSecondaryRef.current?.click()}
                      className="h-16 w-full rounded-lg cursor-pointer shadow-2xs relative border border-black/10 transition-transform hover:scale-[1.02]"
                      style={{ backgroundColor: secondaryColor || "#D9B28C" }}
                    >
                      <input
                        ref={colorInputSecondaryRef}
                        type="color"
                        value={secondaryColor || "#D9B28C"}
                        onChange={(e) => setSecondaryColor(e.target.value)}
                        className="sr-only"
                      />
                    </div>
                    <span className="text-xs font-bold text-zinc-800 dark:text-zinc-200 block truncate">
                      Secundária
                    </span>
                    <span className="text-[10px] font-mono text-zinc-500 uppercase block">
                      {secondaryColor || "#D9B28C"}
                    </span>
                  </div>

                  {/* Destaque */}
                  <div className="p-3 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-[#FAF8F5] dark:bg-zinc-900/60 text-center space-y-1.5">
                    <div
                      onClick={() => colorInputHighlightRef.current?.click()}
                      className="h-16 w-full rounded-lg cursor-pointer shadow-2xs relative border border-black/10 transition-transform hover:scale-[1.02]"
                      style={{ backgroundColor: highlightColor || "#E8DCCB" }}
                    >
                      <input
                        ref={colorInputHighlightRef}
                        type="color"
                        value={highlightColor || "#E8DCCB"}
                        onChange={(e) => setHighlightColor(e.target.value)}
                        className="sr-only"
                      />
                    </div>
                    <span className="text-xs font-bold text-zinc-800 dark:text-zinc-200 block truncate">
                      Destaque
                    </span>
                    <span className="text-[10px] font-mono text-zinc-500 uppercase block">
                      {highlightColor || "#E8DCCB"}
                    </span>
                  </div>

                  {/* Fundo */}
                  <div className="p-3 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-[#FAF8F5] dark:bg-zinc-900/60 text-center space-y-1.5">
                    <div
                      onClick={() => colorInputBgRef.current?.click()}
                      className="h-16 w-full rounded-lg cursor-pointer shadow-2xs relative border border-zinc-300 dark:border-zinc-700 transition-transform hover:scale-[1.02]"
                      style={{ backgroundColor: draft.theme?.background || "#FFF8EF" }}
                    >
                      <input
                        ref={colorInputBgRef}
                        type="color"
                        value={draft.theme?.background || "#FFF8EF"}
                        onChange={(e) => {
                          const col = e.target.value;
                          setDraft((d) => ({
                            ...d,
                            theme: { ...d.theme, background: col },
                          }));
                        }}
                        className="sr-only"
                      />
                    </div>
                    <span className="text-xs font-bold text-zinc-800 dark:text-zinc-200 block truncate">
                      Fundo
                    </span>
                    <span className="text-[10px] font-mono text-zinc-500 uppercase block">
                      {draft.theme?.background || "#FFF8EF"}
                    </span>
                  </div>
                </div>
              </div>

              {/* Botão largo Redefinir cores */}
              <button
                type="button"
                onClick={resetColors}
                className="w-full py-2.5 px-4 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-semibold text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-700/50 shadow-2xs flex items-center justify-center gap-2 transition-colors cursor-pointer"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
                <span>Redefinir cores padrão</span>
              </button>
            </div>
          )}

          {/* =========================================================================
              ABA 3: TIPOGRAFIA (100% LARGURA)
              ========================================================================= */}
          {activeTab === "tipografia" && (
            <div
              ref={sectionTipoRef}
              id="tipografia"
              className="w-full bg-white dark:bg-[#18181b] rounded-2xl border border-zinc-200/80 dark:border-zinc-800 p-5 sm:p-6 shadow-2xs space-y-5"
            >
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-[#FAF0E6] dark:bg-zinc-800 text-[#722D08] dark:text-rose-400 flex items-center justify-center shrink-0 font-serif font-black text-sm">
                  Aa
                </div>
                <div>
                  <h2 className="text-sm font-bold text-zinc-900 dark:text-white">Tipografia</h2>
                  <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                    Escolha as fontes para títulos, textos e destaques.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-1">
                {/* Fonte dos títulos */}
                <div className="space-y-2">
                  <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                    Fonte dos títulos
                  </label>
                  <select
                    value={titleFont}
                    onChange={(e) => setTitleFont(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-[#FAF8F5] dark:bg-zinc-800 text-xs font-semibold text-zinc-800 dark:text-zinc-100 cursor-pointer"
                  >
                    {FONT_OPTIONS.map((f) => (
                      <option key={f.value} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                  <div
                    className="p-3 rounded-xl bg-[#FAF8F5] dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-xs text-zinc-800 dark:text-zinc-200 text-center font-bold truncate shadow-2xs"
                    style={{ fontFamily: getFontFamily(titleFont) }}
                  >
                    Aa • O melhor sabor artesanal
                  </div>
                </div>

                {/* Fonte dos textos */}
                <div className="space-y-2">
                  <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                    Fonte dos textos
                  </label>
                  <select
                    value={bodyFont}
                    onChange={(e) => setBodyFont(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-[#FAF8F5] dark:bg-zinc-800 text-xs font-semibold text-zinc-800 dark:text-zinc-100 cursor-pointer"
                  >
                    {FONT_OPTIONS.map((f) => (
                      <option key={f.value} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                  <div
                    className="p-3 rounded-xl bg-[#FAF8F5] dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-xs text-zinc-700 dark:text-zinc-300 text-center truncate shadow-2xs"
                    style={{ fontFamily: getFontFamily(bodyFont) }}
                  >
                    Aa • Cardápio rápido e interativo
                  </div>
                </div>

                {/* Fonte de destaques */}
                <div className="space-y-2">
                  <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                    Fonte de destaques
                  </label>
                  <select
                    value={highlightFont}
                    onChange={(e) => setHighlightFont(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-[#FAF8F5] dark:bg-zinc-800 text-xs font-semibold text-zinc-800 dark:text-zinc-100 cursor-pointer"
                  >
                    {FONT_OPTIONS.map((f) => (
                      <option key={f.value} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                  <div
                    className="p-3 rounded-xl bg-[#FAF8F5] dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-xs text-zinc-800 dark:text-zinc-200 text-center font-bold tracking-wide truncate shadow-2xs"
                    style={{ fontFamily: getFontFamily(highlightFont) }}
                  >
                    Aa • Promoções e novidades
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* =========================================================================
              ABA 4: INFORMAÇÕES DO RESTAURANTE (100% LARGURA)
              ========================================================================= */}
          {activeTab === "informacoes" && (
            <div
              ref={sectionInfoRef}
              id="informacoes"
              className="w-full bg-white dark:bg-[#18181b] rounded-2xl border border-zinc-200/80 dark:border-zinc-800 p-5 sm:p-6 shadow-2xs space-y-4"
            >
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-[#FAF0E6] dark:bg-zinc-800 text-[#722D08] dark:text-rose-400 flex items-center justify-center shrink-0">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7" />
                    <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
                    <path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4" />
                    <path d="M2 7h20" />
                    <circle cx="12" cy="7" r="1" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-sm font-bold text-zinc-900 dark:text-white">
                    Informações do restaurante
                  </h2>
                  <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                    Essas informações aparecem no cardápio digital e na tela do cliente.
                  </p>
                </div>
              </div>

              {/* Grid de inputs */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
                <div>
                  <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
                    Nome do restaurante *
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={120}
                    value={draft.name}
                    onChange={(e) => field("name", e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs text-zinc-800 dark:text-zinc-100 font-medium focus:border-[#722D08] focus:outline-hidden"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
                    Complemento
                  </label>
                  <input
                    type="text"
                    maxLength={120}
                    placeholder="Ex: RESTAURANTE E BAR"
                    value={draft.subtitle || ""}
                    onChange={(e) => field("subtitle", e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs text-zinc-800 dark:text-zinc-100 font-medium focus:border-[#722D08] focus:outline-hidden uppercase"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
                    Endereço
                  </label>
                  <div className="relative">
                    <span className="absolute left-3 top-2.5 text-zinc-400">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
                        <circle cx="12" cy="10" r="3" />
                      </svg>
                    </span>
                    <input
                      type="text"
                      maxLength={300}
                      placeholder="Rua, número e bairro"
                      value={draft.address || ""}
                      onChange={(e) => field("address", e.target.value)}
                      className="w-full pl-8 pr-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs text-zinc-800 dark:text-zinc-100 font-medium focus:border-[#722D08] focus:outline-hidden"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
                    Telefone
                  </label>
                  <div className="relative">
                    <span className="absolute left-3 top-2.5 text-zinc-400">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
                      </svg>
                    </span>
                    <input
                      type="text"
                      maxLength={40}
                      placeholder="(00) 00000-0000"
                      value={draft.phone || ""}
                      onChange={(e) => field("phone", e.target.value)}
                      className="w-full pl-8 pr-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs text-zinc-800 dark:text-zinc-100 font-medium focus:border-[#722D08] focus:outline-hidden"
                    />
                  </div>
                </div>
              </div>

              {/* Barra inferior com toggle */}
              <div className="bg-[#FAF6F2] dark:bg-zinc-900/60 px-4 py-2.5 rounded-xl flex items-center justify-between border border-zinc-200/60 dark:border-zinc-800">
                <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-300 flex items-center gap-2">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-500">
                    <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                  <span>Exibir endereço e telefone no cardápio</span>
                </span>
                <button
                  type="button"
                  onClick={() => setShowAddressPhoneOnMenu(!showAddressPhoneOnMenu)}
                  className={`w-10 h-5 flex items-center rounded-full p-0.5 transition-colors cursor-pointer ${
                    showAddressPhoneOnMenu ? "bg-[#610000]" : "bg-zinc-300 dark:bg-zinc-700"
                  }`}
                >
                  <div
                    className={`bg-white w-4 h-4 rounded-full shadow-md transform transition-transform ${
                      showAddressPhoneOnMenu ? "translate-x-5" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>
            </div>
          )}

          {/* =========================================================================
              ABA 5: TAXAS E AVALIAÇÕES + WI-FI (100% LARGURA)
              ========================================================================= */}
          {activeTab === "taxas" && (
            <div className="flex flex-col gap-5">
              {/* CARD 5: Taxas, avaliações e experiência */}
              <div
                ref={sectionTaxasRef}
                id="taxas"
                className="w-full bg-white dark:bg-[#18181b] rounded-2xl border border-zinc-200/80 dark:border-zinc-800 p-5 sm:p-6 shadow-2xs space-y-4"
              >
                <div className="space-y-3.5">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-xl bg-[#FAF0E6] dark:bg-zinc-800 text-[#722D08] dark:text-rose-400 flex items-center justify-center shrink-0">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" />
                        <path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" />
                        <path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" />
                      </svg>
                    </div>
                    <div>
                      <h2 className="text-sm font-bold text-zinc-900 dark:text-white leading-tight">
                        Taxas, avaliações e experiência
                      </h2>
                      <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                        Configure taxas, link de avaliação e facilidades.
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
                    <div>
                      <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
                        Taxa de serviço (%)
                      </label>
                      <div className="relative">
                        <input
                          type="number"
                          min="0"
                          max="30"
                          step="0.5"
                          value={draft.serviceFeePercent}
                          onChange={(e) => {
                            const val = Number(e.target.value);
                            field("serviceFeePercent", Number.isFinite(val) ? Math.min(30, Math.max(0, val)) : 0);
                          }}
                          className="w-full px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-bold pr-7"
                        />
                        <span className="absolute right-2.5 top-2.5 text-xs font-bold text-zinc-400">%</span>
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
                        Taxa extra / Couvert (R$)
                      </label>
                      <div className="relative">
                        <span className="absolute left-3 top-2.5 text-xs font-bold text-zinc-400">R$</span>
                        <input
                          type="text"
                          maxLength={10}
                          placeholder="0,00"
                          value={couvertFee}
                          onChange={(e) => setCouvertFee(e.target.value)}
                          className="w-full pl-9 pr-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-bold"
                        />
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
                      Link de avaliação Google
                    </label>
                    <div className="relative">
                      <span className="absolute left-3 top-2.5 text-amber-500">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                        </svg>
                      </span>
                      <input
                        type="url"
                        maxLength={500}
                        placeholder="https://www.google.com/maps/place/..."
                        value={draft.googleReviewUrl || ""}
                        onChange={(e) => field("googleReviewUrl", e.target.value)}
                        className="w-full pl-8 pr-8 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs"
                      />
                      <span className="absolute right-3 top-2.5 text-zinc-400">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                          <polyline points="15 3 21 3 21 9" />
                          <line x1="10" y1="14" x2="21" y2="3" />
                        </svg>
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* CARD 6: Conectividade (Wi-Fi) */}
              <div
                className="w-full bg-white dark:bg-[#18181b] rounded-2xl border border-zinc-200/80 dark:border-zinc-800 p-5 sm:p-6 shadow-2xs space-y-4"
              >
                <div className="space-y-3.5">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-xl bg-[#FAF0E6] dark:bg-zinc-800 text-[#722D08] dark:text-rose-400 flex items-center justify-center shrink-0">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M5 12.55a11 11 0 0 1 14.08 0" />
                        <path d="M1.42 9a16 16 0 0 1 21.16 0" />
                        <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
                        <line x1="12" y1="20" x2="12.01" y2="20" />
                      </svg>
                    </div>
                    <div>
                      <h2 className="text-sm font-bold text-zinc-900 dark:text-white leading-tight">
                        Conectividade (Wi-Fi)
                      </h2>
                      <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                        Configure o Wi-Fi da sua casa para os clientes.
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
                    <div>
                      <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
                        Nome da rede (SSID)
                      </label>
                      <div className="relative">
                        <span className="absolute left-3 top-2.5 text-zinc-400">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M5 12.55a11 11 0 0 1 14.08 0" />
                            <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
                            <line x1="12" y1="20" x2="12.01" y2="20" />
                          </svg>
                        </span>
                        <input
                          type="text"
                          maxLength={60}
                          value={wifiSsid}
                          onChange={(e) => setWifiSsid(e.target.value)}
                          className="w-full pl-8 pr-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-medium"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
                        Senha do Wi-Fi
                      </label>
                      <div className="relative">
                        <span className="absolute left-3 top-2.5 text-zinc-400">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="7.5" cy="15.5" r="5.5" />
                            <path d="m21 2-9.6 9.6" />
                            <path d="m15.5 7.5 3 3L22 7l-3-3" />
                          </svg>
                        </span>
                        <input
                          type="text"
                          maxLength={60}
                          value={wifiPassword}
                          onChange={(e) => setWifiPassword(e.target.value)}
                          className="w-full pl-8 pr-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-medium"
                        />
                      </div>
                    </div>
                  </div>
                </div>

                <div className="pt-3 flex items-center justify-between border-t border-zinc-100 dark:border-zinc-800 mt-2">
                  <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-300 flex items-center gap-1.5">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-500">
                      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                    <span>Mostrar Wi-Fi no cardápio</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowWifi(!showWifi)}
                    className={`w-10 h-5 flex items-center rounded-full p-0.5 transition-colors cursor-pointer ${
                      showWifi ? "bg-[#610000]" : "bg-zinc-300 dark:bg-zinc-700"
                    }`}
                  >
                    <div
                      className={`bg-white w-4 h-4 rounded-full shadow-md transform transition-transform ${
                        showWifi ? "translate-x-5" : "translate-x-0"
                      }`}
                    />
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* =========================================================================
              ABA 6: REDES SOCIAIS, HORÁRIOS E POLÍTICAS (100% LARGURA)
              ========================================================================= */}
          {activeTab === "redes" && (
            <>
              {/* CARD 7: Redes sociais, horários e políticas */}
              <div
                ref={sectionRedesRef}
                id="redes-sociais"
                className="w-full bg-white dark:bg-[#18181b] rounded-2xl border border-zinc-200/80 dark:border-zinc-800 p-5 sm:p-6 shadow-2xs space-y-5"
              >
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-xl bg-[#FAF0E6] dark:bg-zinc-800 text-[#722D08] dark:text-rose-400 flex items-center justify-center shrink-0">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="18" cy="5" r="3" />
                      <circle cx="6" cy="12" r="3" />
                      <circle cx="18" cy="19" r="3" />
                      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                    </svg>
                  </div>
                  <div>
                    <h2 className="text-sm font-bold text-zinc-900 dark:text-white leading-tight">
                      Redes sociais, horários e políticas
                    </h2>
                    <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                      Canais de contato, horário de atendimento e avisos.
                    </p>
                  </div>
                </div>

                {/* Linha superior: 3 Canais de Contato */}
                <div>
                  <span className="text-xs font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider block mb-2">
                    Canais de contato
                  </span>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
                    <div>
                      <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
                        Instagram
                      </label>
                      <div className="relative">
                        <span className="absolute left-3 top-2.5 text-rose-500">
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect width="20" height="20" x="2" y="2" rx="5" ry="5" />
                            <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
                            <line x1="17.5" y1="6.5" x2="17.51" y2="6.5" />
                          </svg>
                        </span>
                        <input
                          type="text"
                          maxLength={100}
                          placeholder="@seurestaurante"
                          disabled={busy} aria-invalid={contacts.instagram.enabled && Boolean(instagram.trim()) && !contactUrl('instagram', instagram)}
                          aria-describedby="contact-instagram-help" id="contact-instagram" aria-label="Instagram"
                          value={instagram}
                          onChange={(e) => setInstagram(e.target.value)}
                          className="w-full pl-8 pr-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs"
                        />
                        <label className="mt-2 flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-200">
                          <input className="contact-channel-switch" type="checkbox" role="switch" checked={contacts.instagram.enabled} disabled={busy}
                            onChange={(e) => setContacts(old => ({...old, instagram: {...old.instagram, enabled: e.target.checked}}))}
                            aria-label="Mostrar Instagram no cardápio" />
                          Mostrar no cardápio · {contacts.instagram.enabled ? 'Ativado' : 'Oculto'}
                        </label>
                        <p id="contact-instagram-help" className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">{!instagram.trim() ? 'Sem valor: canal oculto.' : !contactUrl('instagram', instagram) ? 'Endereço inválido: canal oculto no cardápio.' : 'Desativar preserva o endereço salvo.'}</p>
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
                        WhatsApp
                      </label>
                      <div className="relative">
                        <span className="absolute left-3 top-2.5 text-emerald-500">
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
                          </svg>
                        </span>
                        <input
                          type="text"
                          maxLength={40}
                          placeholder="(11) 99999-9999"
                          disabled={busy} aria-invalid={contacts.whatsapp.enabled && Boolean(whatsapp.trim()) && !contactUrl('whatsapp', whatsapp)}
                          aria-describedby="contact-whatsapp-help" id="contact-whatsapp" aria-label="WhatsApp"
                          value={whatsapp}
                          onChange={(e) => setWhatsapp(e.target.value)}
                          className="w-full pl-8 pr-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs"
                        />
                        <label className="mt-2 flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-200">
                          <input className="contact-channel-switch" type="checkbox" role="switch" checked={contacts.whatsapp.enabled} disabled={busy}
                            onChange={(e) => setContacts(old => ({...old, whatsapp: {...old.whatsapp, enabled: e.target.checked}}))}
                            aria-label="Mostrar WhatsApp no cardápio" />
                          Mostrar no cardápio · {contacts.whatsapp.enabled ? 'Ativado' : 'Oculto'}
                        </label>
                        <p id="contact-whatsapp-help" className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">{!whatsapp.trim() ? 'Sem valor: canal oculto.' : !contactUrl('whatsapp', whatsapp) ? 'Endereço inválido: canal oculto no cardápio.' : 'Desativar preserva o endereço salvo.'}</p>
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
                        Facebook / Site
                      </label>
                      <div className="relative">
                        <span className="absolute left-3 top-2.5 text-blue-600">
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z" />
                          </svg>
                        </span>
                        <input
                          type="text"
                          maxLength={120}
                          placeholder="facebook.com/seurestaurante"
                          disabled={busy} aria-invalid={contacts.facebook.enabled && Boolean(facebook.trim()) && !contactUrl('facebook', facebook)}
                          aria-describedby="contact-facebook-help" id="contact-facebook" aria-label="Facebook / Site"
                          value={facebook}
                          onChange={(e) => setFacebook(e.target.value)}
                          className="w-full pl-8 pr-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs"
                        />
                        <label className="mt-2 flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-200">
                          <input className="contact-channel-switch" type="checkbox" role="switch" checked={contacts.facebook.enabled} disabled={busy}
                            onChange={(e) => setContacts(old => ({...old, facebook: {...old.facebook, enabled: e.target.checked}}))}
                            aria-label="Mostrar Facebook / Site no cardápio" />
                          Mostrar no cardápio · {contacts.facebook.enabled ? 'Ativado' : 'Oculto'}
                        </label>
                        <p id="contact-facebook-help" className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">{!facebook.trim() ? 'Sem valor: canal oculto.' : !contactUrl('facebook', facebook) ? 'Endereço inválido: canal oculto no cardápio.' : 'Desativar preserva o endereço salvo.'}</p>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Linha inferior: Operação (Horário de funcionamento e Política da casa / Avisos) */}
                <div className="pt-4 border-t border-zinc-100 dark:border-zinc-800">
                  <span className="text-xs font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider block mb-2">
                    Operação e avisos
                  </span>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
                        Horário de funcionamento
                      </label>
                      <div className="relative">
                        <span className="absolute left-3 top-2.5 text-zinc-400">
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="10" />
                            <polyline points="12 6 12 12 16 14" />
                          </svg>
                        </span>
                        <input
                          type="text"
                          maxLength={500}
                          placeholder="Seg a Sex: 11h às 23h • Sáb e Dom: 12h às 00h"
                          value={draft.openingHours || ""}
                          onChange={(e) => field("openingHours", e.target.value)}
                          className="w-full pl-8 pr-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
                        Política da casa / Avisos
                      </label>
                      <div className="relative">
                        <span className="absolute left-3 top-2.5 text-zinc-400">
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                            <polyline points="14 2 14 8 20 8" />
                            <line x1="16" y1="13" x2="8" y2="13" />
                            <line x1="16" y1="17" x2="8" y2="17" />
                            <polyline points="10 9 9 9 8 9" />
                          </svg>
                        </span>
                        <input
                          type="text"
                          maxLength={500}
                          placeholder="Não cobramos taxa de rolha nas terças. Área para fumantes disponível."
                          value={draft.description || ""}
                          onChange={(e) => field("description", e.target.value)}
                          className="w-full pl-8 pr-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* CARD BANNER DE DESTAQUES */}
              <div className="w-full bg-white dark:bg-[#18181b] rounded-2xl border border-zinc-200/80 dark:border-zinc-800 p-5 sm:p-6 shadow-2xs space-y-4">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-[#FAF0E6] dark:bg-zinc-800 text-[#722D08] dark:text-rose-400 flex items-center justify-center shrink-0">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                    </svg>
                  </div>
                  <div>
                    <h2 className="text-sm font-bold text-zinc-900 dark:text-white">Banner de destaques do cardápio</h2>
                    <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                      Personalize os textos do banner principal exibido no cardápio público.
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
                  <div>
                    <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
                      Título do banner de destaques
                    </label>
                    <input
                      type="text"
                      maxLength={80}
                      placeholder="Destaques da Semana"
                      value={bannerTitle}
                      onChange={(e) => setBannerTitle(e.target.value)}
                      className="w-full px-3.5 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-semibold text-zinc-800 dark:text-zinc-100"
                    />
                    <p className="text-[10px] text-zinc-400 mt-1">Exibido em destaque sobre a imagem do banner.</p>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
                      Subtítulo do banner de destaques
                    </label>
                    <input
                      type="text"
                      maxLength={140}
                      placeholder="O melhor da nossa culinária contemporânea"
                      value={bannerSubtitle}
                      onChange={(e) => setBannerSubtitle(e.target.value)}
                      className="w-full px-3.5 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-semibold text-zinc-800 dark:text-zinc-100"
                    />
                    <p className="text-[10px] text-zinc-400 mt-1">Linha explicativa curta logo abaixo do título.</p>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>


        {/* =====================================================================
            COLUNA DIREITA: PRÉVIA DO CARDÁPIO FIEL À IMAGEM DE REFERÊNCIA
            ===================================================================== */}
        <div className="xl:col-span-4 xl:sticky xl:top-4 space-y-3">
          <div className="bg-[#F7EFE6] dark:bg-zinc-900 rounded-3xl p-4 sm:p-5 border border-[#E8DCCB] dark:border-zinc-800 shadow-sm space-y-3">
            {/* Cabeçalho do Card de Prévia */}
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-full bg-white/80 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 flex items-center justify-center shadow-2xs">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </div>
              <div>
                <h3 className="text-xs sm:text-sm font-bold text-zinc-900 dark:text-white leading-tight">
                  Prévia do cardápio
                </h3>
                <p className="text-[10px] text-zinc-500 dark:text-zinc-400">
                  Veja como ficará a identidade visual na tela do cliente.
                </p>
              </div>
            </div>

            {/* Container Interno da Tela do Cliente (Reflete Cores, Fontes e Dados em Tempo Real) */}
            <div
              className="rounded-[28px] overflow-hidden border border-zinc-200/80 dark:border-zinc-800 shadow-inner p-3.5 space-y-3 relative select-none max-h-[740px] overflow-y-auto"
              style={{
                backgroundColor: backgroundColor,
                fontFamily: getFontFamily(bodyFont),
                color: textColor,
              }}
            >
              {/* 1. TOPO DO CARDÁPIO DO CLIENTE */}
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  {/* Esquerda: Logo / Nome */}
                  <div className="flex items-center gap-2 min-w-0">
                    {preview(logo) ? (
                      <div className="h-7 w-auto max-w-[80px] shrink-0 flex items-center justify-center">
                        <img src={preview(logo)} alt="Logo" className="max-h-7 w-auto object-contain" />
                      </div>
                    ) : (
                      <div className="min-w-0 flex flex-col">
                        <span
                          className="font-black text-xs tracking-[0.2em] uppercase leading-none truncate text-zinc-900"
                          style={{ fontFamily: getFontFamily(titleFont) }}
                        >
                          {draft.name || "NOMA"}
                        </span>
                        <span className="text-[7px] font-bold tracking-[0.16em] text-zinc-500 uppercase mt-0.5 truncate">
                          {draft.subtitle || "RESTAURANTE E BAR"}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Direita: Pill Consulta sem mesa + Alternador de Tema */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className="px-2 py-0.5 rounded-full border border-zinc-300 text-[9px] font-semibold text-zinc-700 bg-white/70 shadow-2xs">
                      Consulta sem mesa
                    </span>
                    <span className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] text-zinc-600">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
                      </svg>
                    </span>
                  </div>
                </div>

                {/* Abas do Cardápio: Home, Cardápio, Explorar */}
                <div className="flex items-center gap-4 border-b border-zinc-200/80 text-[11px] font-semibold pt-0.5">
                  <div
                    className="pb-1 font-bold border-b-2 transition-colors cursor-pointer"
                    style={{
                      color: primaryColor,
                      borderColor: primaryColor,
                    }}
                  >
                    Home
                  </div>
                  <div className="pb-1 text-zinc-500 cursor-pointer">
                    Cardápio
                  </div>
                  <div className="pb-1 text-zinc-500 cursor-pointer">
                    Explorar
                  </div>
                </div>
              </div>

              {/* 2. BANNER DESTAQUES DA SEMANA */}
              <div className="space-y-1">
                <div className="relative rounded-2xl overflow-hidden aspect-[16/9] shadow-xs p-3 flex flex-col justify-between text-white bg-zinc-900">
                  <img
                    src={
                      preview(cover) ||
                      catalogProducts[0]?.images[0]?.url ||
                      "https://images.unsplash.com/photo-1544025162-d76694265947?w=800&auto=format&fit=crop&q=80"
                    }
                    alt="Destaque da semana"
                    className="absolute inset-0 w-full h-full object-cover"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/35 to-black/20" />

                  {/* Título e Subtítulo */}
                  <div className="relative z-10 space-y-0.5">
                    <h4
                      className="text-sm font-bold leading-tight drop-shadow-sm text-white"
                      style={{ fontFamily: getFontFamily(titleFont), whiteSpace: "pre-line" }}
                    >
                      {bannerTitle || "Destaques da Semana"}
                    </h4>
                    <p className="text-[9px] text-white/85 line-clamp-1 leading-snug">
                      {bannerSubtitle || "O melhor da nossa culinária contemporânea"}
                    </p>
                  </div>
                </div>

                {/* Pontinhos do Carrossel */}
                <div className="flex items-center justify-center gap-1 py-0.5">
                  <span
                    className="w-3 h-1 rounded-full transition-all"
                    style={{ backgroundColor: primaryColor }}
                  />
                  <span className="w-1 h-1 rounded-full bg-zinc-300" />
                </div>
              </div>

              {/* 3. SEÇÃO DESTAQUES E ENTRADAS (2 CARDS) */}
              <div className="space-y-1.5">
                <h4
                  className="text-xs font-bold text-zinc-900"
                  style={{ fontFamily: getFontFamily(titleFont) }}
                >
                  Destaques e Entradas
                </h4>

                <div className="grid grid-cols-2 gap-2">
                  {/* Card 1 */}
                  <div className="bg-white rounded-xl border border-zinc-200/80 p-2 shadow-2xs flex flex-col justify-between space-y-1.5">
                    <div className="space-y-1">
                      <div className="relative aspect-[4/3] rounded-lg overflow-hidden bg-zinc-100">
                        <img
                          src={
                            catalogProducts[0]?.images[0]?.url ||
                            "https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=500&auto=format&fit=crop&q=80"
                          }
                          alt={catalogProducts[0]?.name || "Risoto de cogumelos"}
                          className="w-full h-full object-cover"
                        />
                        {(() => {
                          const p = catalogProducts[0];
                          const b = p ? (localStorage.getItem(`elozi_product_badge_${p.id}`) || (p as unknown as Record<string, unknown>).badge_text as string || (p as unknown as Record<string, unknown>).badgeText as string) : "Mais Pedido";
                          const c = p ? (localStorage.getItem(`elozi_product_badge_color_${p.id}`) || (p as unknown as Record<string, unknown>).badge_color as string || (p as unknown as Record<string, unknown>).badgeColor as string || "#D97706") : "#D97706";
                          return b ? (
                            <span
                              className="absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded-full text-[8.5px] font-bold tracking-wide shadow-xs text-white backdrop-blur-xs z-10 pointer-events-none"
                              style={{ backgroundColor: c }}
                            >
                              {b}
                            </span>
                          ) : null;
                        })()}
                      </div>

                      <div>
                        <div className="flex items-center justify-between gap-1">
                          <h5
                            className="text-[11px] font-bold text-zinc-900 line-clamp-1"
                            style={{ fontFamily: getFontFamily(titleFont) }}
                          >
                            {catalogProducts[0]?.name || "Risoto de cogumelos"}
                          </h5>
                          <span className="flex items-center gap-0.5 text-[8.5px] font-bold text-rose-500 shrink-0">
                            <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor">
                              <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
                            </svg>
                            <span>19</span>
                          </span>
                        </div>
                        <p className="text-[9px] text-zinc-500 line-clamp-1 leading-snug">
                          {catalogProducts[0]?.description || "Arroz arbóreo, cogumelos e parmesão."}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center justify-between pt-0.5">
                      <span className="text-[11px] font-bold text-zinc-900 font-mono">
                        {catalogProducts[0]
                          ? new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(
                              catalogProducts[0].price_in_cents / 100
                            )
                          : "R$ 40,00"}
                      </span>
                      <button
                        type="button"
                        className="px-1.5 py-0.5 rounded-md text-[8px] font-bold text-white shadow-2xs"
                        style={{ backgroundColor: primaryColor }}
                      >
                        Ver Prato +
                      </button>
                    </div>
                  </div>

                  {/* Card 2 */}
                  <div className="bg-white rounded-xl border border-zinc-200/80 p-2 shadow-2xs flex flex-col justify-between space-y-1.5">
                    <div className="space-y-1">
                      <div className="relative aspect-[4/3] rounded-lg overflow-hidden bg-zinc-100">
                        <img
                          src={
                            catalogProducts[1]?.images[0]?.url ||
                            "https://images.unsplash.com/photo-1572695157366-5e585ab2b69f?w=500&auto=format&fit=crop&q=80"
                          }
                          alt={catalogProducts[1]?.name || "Brownie com sorvete"}
                          className="w-full h-full object-cover"
                        />
                        {(() => {
                          const p = catalogProducts[1];
                          const b = p ? (localStorage.getItem(`elozi_product_badge_${p.id}`) || (p as unknown as Record<string, unknown>).badge_text as string || (p as unknown as Record<string, unknown>).badgeText as string) : null;
                          const c = p ? (localStorage.getItem(`elozi_product_badge_color_${p.id}`) || (p as unknown as Record<string, unknown>).badge_color as string || (p as unknown as Record<string, unknown>).badgeColor as string || "#D97706") : "#D97706";
                          return b ? (
                            <span
                              className="absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded-full text-[8.5px] font-bold tracking-wide shadow-xs text-white backdrop-blur-xs z-10 pointer-events-none"
                              style={{ backgroundColor: c }}
                            >
                              {b}
                            </span>
                          ) : null;
                        })()}
                      </div>

                      <div>
                        <div className="flex items-center justify-between gap-1">
                          <h5
                            className="text-[11px] font-bold text-zinc-900 line-clamp-1"
                            style={{ fontFamily: getFontFamily(titleFont) }}
                          >
                            {catalogProducts[1]?.name || "Brownie com sorvete"}
                          </h5>
                          <span className="flex items-center gap-0.5 text-[8.5px] font-bold text-rose-500 shrink-0">
                            <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor">
                              <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
                            </svg>
                            <span>12</span>
                          </span>
                        </div>
                        <p className="text-[9px] text-zinc-500 line-clamp-1 leading-snug">
                          {catalogProducts[1]?.description || "Chocolate e sorvete artesanal."}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center justify-between pt-0.5">
                      <span className="text-[11px] font-bold text-zinc-900 font-mono">
                        {catalogProducts[1]
                          ? new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(
                              catalogProducts[1].price_in_cents / 100
                            )
                          : "R$ 26,00"}
                      </span>
                      <button
                        type="button"
                        className="px-1.5 py-0.5 rounded-md text-[8px] font-bold text-white shadow-2xs"
                        style={{ backgroundColor: primaryColor }}
                      >
                        Ver Prato +
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* 3.1 CARD INFERIOR ESPELHADO: GOOGLE, WI-FI E REDES SOCIAIS */}
              {(Boolean(draft.googleReviewUrl) || showWifi || Boolean(publicContacts.instagram || publicContacts.whatsapp || publicContacts.facebook)) && (
                <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200/80 dark:border-zinc-800 overflow-hidden shadow-2xs">
                  <div
                    className={`grid grid-cols-1 ${
                      draft.googleReviewUrl && (showWifi || publicContacts.instagram || publicContacts.whatsapp || publicContacts.facebook)
                        ? "divide-y divide-zinc-100 dark:divide-zinc-800"
                        : ""
                    }`}
                  >
                    {/* Google */}
                    {draft.googleReviewUrl && (
                      <div className="p-2.5 space-y-1.5">
                        <div className="flex items-center justify-between gap-1">
                          <span className="font-bold text-[10px] text-zinc-800 dark:text-zinc-200 flex items-center gap-1">
                            <span className="text-[#4285F4] font-black text-[11px]">G</span>oogle
                          </span>
                          <span className="text-[7.5px] font-semibold text-emerald-700 bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800 px-1.5 py-0.2 rounded-full">
                            Avaliação oficial
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-1">
                          <div>
                            <div className="flex items-center gap-0.5 text-amber-500 text-[10px] leading-none">
                              <span>★</span>
                              <span>★</span>
                              <span>★</span>
                              <span>★</span>
                              <span>★</span>
                            </div>
                            <p className="text-[9px] font-bold text-zinc-800 dark:text-zinc-200 mt-0.5">Avalie no Google</p>
                          </div>
                          <span className="px-2 py-0.5 rounded-full bg-zinc-900 text-white text-[8px] font-bold flex items-center gap-0.5 shadow-2xs">
                            Avaliar ↗
                          </span>
                        </div>
                      </div>
                    )}

                    {/* Wi-Fi & Redes */}
                    {(showWifi || publicContacts.instagram || publicContacts.whatsapp || publicContacts.facebook) && (
                      <div className="p-2.5 space-y-2 bg-[#FAF6F2]/60 dark:bg-zinc-800/40">
                        <div className="flex items-center justify-between gap-1">
                          <span className="font-bold text-[10px] text-zinc-800 dark:text-zinc-200 flex items-center gap-1">
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-600 dark:text-zinc-300">
                              <path d="M5 12.55a11 11 0 0 1 14.08 0" />
                              <path d="M1.42 9a16 16 0 0 1 21.16 0" />
                              <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
                              <line x1="12" y1="20" x2="12.01" y2="20" />
                            </svg>
                            <span>{showWifi ? "Wi-Fi da Casa" : "Canais de Contato"}</span>
                          </span>
                          <span className="text-[7.5px] font-semibold text-emerald-700 bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800 px-1.5 py-0.2 rounded-full">
                            {showWifi ? "Conexão gratuita" : "Oficial"}
                          </span>
                        </div>

                        {showWifi && (
                          <div className="space-y-1">
                            <div className="flex items-center justify-between text-[8.5px]">
                              <span className="text-zinc-500 dark:text-zinc-400">Rede:</span>
                              <span className="font-bold text-zinc-800 dark:text-zinc-200 truncate">{wifiSsid}</span>
                            </div>
                            {wifiPassword && (
                              <div className="flex items-center justify-between bg-white dark:bg-zinc-800 px-2 py-1 rounded-md border border-zinc-200/80 dark:border-zinc-700 text-[8px]">
                                <div className="flex items-center gap-1 truncate">
                                  <span className="text-zinc-400 font-bold">Senha:</span>
                                  <span className="font-mono font-bold text-zinc-800 dark:text-zinc-200 truncate">{wifiPassword}</span>
                                </div>
                                <span className="text-[7.5px] font-semibold text-zinc-600 dark:text-zinc-400 shrink-0">Copiar</span>
                              </div>
                            )}
                          </div>
                        )}

                        {(publicContacts.instagram || publicContacts.whatsapp || publicContacts.facebook) && (
                          <div className="flex items-center justify-between pt-1 border-t border-zinc-200/60 dark:border-zinc-700">
                            <span className="text-[8px] text-zinc-500 dark:text-zinc-400 font-medium">Redes:</span>
                            <div className="flex items-center gap-1.5">
                              {publicContacts.instagram && (
                                <span className="w-5 h-5 rounded-full bg-white dark:bg-zinc-700 border border-zinc-200 dark:border-zinc-600 flex items-center justify-center text-rose-500 shadow-2xs">
                                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                    <rect width="20" height="20" x="2" y="2" rx="5" ry="5" />
                                    <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
                                    <line x1="17.5" y1="6.5" x2="17.51" y2="6.5" />
                                  </svg>
                                </span>
                              )}
                              {publicContacts.whatsapp && (
                                <span className="w-5 h-5 rounded-full bg-white dark:bg-zinc-700 border border-zinc-200 dark:border-zinc-600 flex items-center justify-center text-emerald-500 shadow-2xs">
                                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
                                  </svg>
                                </span>
                              )}
                              {publicContacts.facebook && (
                                <span className="w-5 h-5 rounded-full bg-white dark:bg-zinc-700 border border-zinc-200 dark:border-zinc-600 flex items-center justify-center text-blue-600 shadow-2xs">
                                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z" />
                                  </svg>
                                </span>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* 4. BARRA DE NAVEGAÇÃO INFERIOR FLUTUANTE (BOTTOM NAV) */}
              <div className="sticky bottom-1 z-20 pt-1">
                <div className="rounded-full bg-white/95 backdrop-blur-md shadow-md border border-zinc-200/80 py-1.5 px-4 flex justify-around items-center">
                  <div
                    className="flex flex-col items-center gap-0.5 cursor-pointer font-bold text-[8px]"
                    style={{ color: primaryColor }}
                  >
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" />
                    </svg>
                    <span>Início</span>
                  </div>

                  <div className="flex flex-col items-center gap-0.5 cursor-pointer text-zinc-500 hover:text-zinc-700 text-[8px]">
                    <svg
                      className="w-3.5 h-3.5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
                    </svg>
                    <span>Chamar Garçom</span>
                  </div>

                  <div className="flex flex-col items-center gap-0.5 cursor-pointer text-zinc-500 hover:text-zinc-700 text-[8px]">
                    <svg
                      className="w-3.5 h-3.5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                      <line x1="16" y1="13" x2="8" y2="13" />
                      <line x1="16" y1="17" x2="8" y2="17" />
                      <polyline points="10 9 9 9 8 9" />
                    </svg>
                    <span>Comanda</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

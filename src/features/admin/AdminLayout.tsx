import { TrialBanner } from "../billing/TrialBanner";
import { useState, useEffect, useRef } from "react";
import {
  Link,
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
  useOutletContext,
} from "react-router";
import { useRestaurant } from "../restaurants/RestaurantProvider";
import { signOutStaff, type StaffAccess } from "../auth/staffAuth";
import { useTheme } from "../theme/ThemeContext";
import { AdminTopbar } from "./AdminTopbar";
import { getPlatformAccess } from "../platform/platformRestaurants";

export function AdminLayout() {
  const access = useOutletContext<StaffAccess>();
  const { restaurant: r } = useRestaurant();
  const navigate = useNavigate();
  const location = useLocation();
  const { theme } = useTheme();
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  const [restaurantMenuOpen, setRestaurantMenuOpen] = useState(false);
  const restaurantMenuRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    try {
      setDashboardLogoUrl(
        localStorage.getItem(`elozi_dashboard_logo_${r.id}`) ||
        r.dashboardLogoUrl ||
        localStorage.getItem(`elozi_restaurant_logo_${r.id}`) ||
        null
      );
    } catch {}
    function handleLogoUpdate(ev: Event) {
      const detail = (ev as CustomEvent<{ restaurantId: string; logoUrl: string | null }>).detail;
      if (detail?.restaurantId === r.id) {
        setDashboardLogoUrl(detail.logoUrl);
      }
    }
    window.addEventListener("elozi-dashboard-logo-updated", handleLogoUpdate);
    return () => {
      window.removeEventListener("elozi-dashboard-logo-updated", handleLogoUpdate);
    };
  }, [r.id, r.dashboardLogoUrl]);

  const logoUrl = dashboardLogoUrl;

  const isFinanceRoute = location.pathname.includes('/financeiro') || location.pathname.includes('/fechamento');
  const isFechamentoActive = location.search.includes('tab=fechamento') || location.pathname.includes('/fechamento');
  const [financeExpanded, setFinanceExpanded] = useState(isFinanceRoute);

  useEffect(() => {
    if (isFinanceRoute) {
      setFinanceExpanded(true);
    }
  }, [isFinanceRoute]);

  const isDark = theme === 'dark';

  // Fechar dropdown do card do restaurante ao clicar fora
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        restaurantMenuRef.current &&
        !restaurantMenuRef.current.contains(event.target as Node)
      ) {
        setRestaurantMenuOpen(false);
      }
    }
    if (restaurantMenuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [restaurantMenuOpen]);

  useEffect(() => {
    void getPlatformAccess().then(setIsPlatformAdmin).catch(() => setIsPlatformAdmin(false));
  }, []);

  let diffDays: number | null = null;
  if (r.subscriptionExpiresAt) {
    const diffMs = new Date(r.subscriptionExpiresAt).getTime() - Date.now();
    diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  }

  const isTrial = r.subscriptionIsTrial === true;
  const isExpiringSoon = diffDays !== null && diffDays > 0 && diffDays <= 5;
  // Trial não tem período de tolerância (grace period)
  const isGracePeriod = !isTrial && ((diffDays !== null && diffDays <= 0 && diffDays >= -3) || r.billingStatus === 'grace_period');
  // Se for trial e expirou (diffDays <= 0 ou status expired), bloqueia imediatamente sem carência
  const isSevereOverdue = !isPlatformAdmin && (
    isTrial
      ? (diffDays !== null && diffDays <= 0) || r.billingStatus === 'expired'
      : (diffDays !== null && diffDays < -3) || (r.billingStatus === 'expired' && (diffDays === null || diffDays <= -3))
  );
  const isBillingTab = location.pathname.endsWith('/assinatura');

  // Mantém os itens originais do menu lateral (removidos: Atendimento, Minha conta e Sair)
  const links = [
    ["", "Visão geral", "home"],
    ["catalogo", "Cardápio", "menu"],
    ["kds", "KDS Cozinha/Bar", "kds"],
    ["estoque", "Estoque & Insumos", "package"],
    ["comentarios", "Comentários", "chat"],
    ["mesas", "Mesas e comandas", "table"],
    ["financeiro", "Financeiro / Caixa", "chart"],
    ["assinatura", "Assinatura & Planos", "card"],
    ["identidade", "Identidade visual", "brush"],
    ["midias", "Armazenamento", "cloud"],
    ["equipe", "Equipe e acessos", "user"],
  ] as const;

  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem('elozi_admin_sidebar_collapsed') === 'true';
    } catch {
      return false;
    }
  });
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);

  // Fechar drawer mobile ao navegar para outra rota
  useEffect(() => {
    setMobileDrawerOpen(false);
  }, [location.pathname]);

  // Fechar drawer ao pressionar Escape
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setMobileDrawerOpen(false);
      }
    }
    if (mobileDrawerOpen) {
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [mobileDrawerOpen]);

  const toggleSidebar = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('elozi_admin_sidebar_collapsed', String(next));
      } catch {}
      return next;
    });
  };

  return (
    <div
      className={`admin-app ${sidebarCollapsed ? 'sidebar-collapsed' : ''} print:block print:p-0 print:m-0 print:bg-white print:overflow-visible transition-colors duration-200`}
      style={{
        backgroundColor: isDark ? '#121212' : '#F8F9FA',
      }}
    >
      <a href="#admin-content" className="skip-link print:hidden">
        Pular para o conteúdo
      </a>

      {/* SIDEBAR GLOBAL DO ADMIN */}
      <aside
        className={`admin-sidebar ${sidebarCollapsed ? 'collapsed' : ''} print:hidden transition-all duration-200`}
        style={{
          backgroundColor: isDark ? '#18181b' : '#610000',
          borderColor: isDark ? '#27272a' : '#4a0000',
        }}
      >
        {/* Topo da Sidebar: Logo Eloozi branca */}
        <div className="admin-sidebar-header flex items-center justify-between gap-2 mb-6">
          <Link
            to={`/${r.slug}/admin`}
            className="admin-logo inline-flex items-center min-w-0 flex-1 overflow-hidden"
            title="Painel Elozi"
          >
            <img
              src="/landing/Eloozi.png"
              alt="Elozi"
              className="h-8 w-auto object-contain brightness-0 invert"
            />
          </Link>
          <button
            type="button"
            onClick={toggleSidebar}
            className="admin-sidebar-toggle text-white hover:bg-white/20 transition-colors"
            style={{
              borderColor: isDark ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.25)',
              background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.12)',
            }}
            aria-label={sidebarCollapsed ? "Expandir menu lateral" : "Recolher menu lateral"}
            title={sidebarCollapsed ? "Expandir menu lateral" : "Recolher menu lateral"}
          >
            {sidebarCollapsed ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect width="18" height="18" x="3" y="3" rx="2" />
                <path d="M9 3v18" />
                <path d="m13 15 3-3-3-3" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect width="18" height="18" x="3" y="3" rx="2" />
                <path d="M9 3v18" />
                <path d="m14 9-3 3 3 3" />
              </svg>
            )}
          </button>
        </div>

        {/* Itens de Navegação */}
        <nav aria-label="Administração" className="flex flex-col gap-1.5 flex-1">
          {links.map(([path, label, icon]) => {
            if (path === "financeiro") {
              const isMainFinanceActive = isFinanceRoute && !isFechamentoActive;
              return (
                <div key={path} className="flex flex-col gap-1">
                  <div className="flex items-center">
                    <NavLink
                      end
                      to={`/${r.slug}/admin/financeiro`}
                      title={label}
                      onClick={() => setFinanceExpanded(true)}
                      className={
                        `flex items-center gap-3 min-h-[42px] px-3.5 py-2.5 rounded-xl text-sm font-medium transition-all flex-1 ${
                          isMainFinanceActive
                            ? isDark
                              ? '!bg-zinc-800 !text-white !font-bold shadow-xs !shadow-none [&>svg]:!text-white'
                              : '!bg-white !text-[#610000] !font-bold shadow-sm !shadow-none [&>svg]:!text-[#610000]'
                            : isDark
                              ? '!text-zinc-400 hover:!text-white hover:!bg-zinc-800/60 [&>svg]:!text-zinc-400 hover:[&>svg]:!text-white'
                              : '!text-white/85 hover:!text-white hover:!bg-white/10 [&>svg]:!text-white/85 hover:[&>svg]:!text-white'
                        }`
                      }
                    >
                      <AdminIcon
                        name={icon}
                        style={{
                          color: isMainFinanceActive
                            ? (!isDark ? '#610000' : '#ffffff')
                            : (isDark ? '#a1a1aa' : 'rgba(255,255,255,0.85)'),
                        }}
                      />
                      <span className="truncate flex-1">{label}</span>
                      {!sidebarCollapsed && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setFinanceExpanded((prev) => !prev);
                          }}
                          className="p-1 rounded-md hover:bg-black/10 dark:hover:bg-white/10 text-current transition-transform cursor-pointer"
                          aria-label={financeExpanded ? "Recolher opções" : "Expandir opções"}
                        >
                          <svg
                            className={`w-3.5 h-3.5 transition-transform duration-200 ${
                              financeExpanded ? "rotate-180" : ""
                            }`}
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <polyline points="6 9 12 15 18 9" />
                          </svg>
                        </button>
                      )}
                    </NavLink>
                  </div>

                  {/* Sub-guia única adicional: + Fechamento de caixa */}
                  {financeExpanded && !sidebarCollapsed && (
                    <NavLink
                      to={`/${r.slug}/admin/financeiro?tab=fechamento`}
                      title="Fechamento de caixa"
                      className={
                        `flex items-center gap-2 py-2 pr-3 pl-10 rounded-xl text-xs font-semibold transition-all ${
                          isFechamentoActive
                            ? isDark
                              ? '!bg-zinc-800 !text-white !font-bold shadow-xs'
                              : '!bg-white !text-[#610000] !font-bold shadow-sm'
                            : isDark
                              ? '!text-zinc-400 hover:!text-white hover:!bg-zinc-800/50'
                              : '!text-white/80 hover:!text-white hover:!bg-white/10'
                        }`
                      }
                    >
                      <span className="text-[13px] font-bold leading-none">+</span>
                      <span className="truncate">Fechamento de caixa</span>
                    </NavLink>
                  )}
                </div>
              );
            }

            return (
              <NavLink
                end
                key={path}
                to={`/${r.slug}/admin${path ? `/${path}` : ""}`}
                title={label}
                className={({ isActive }) =>
                  `flex items-center gap-3 min-h-[42px] px-3.5 py-2.5 rounded-xl text-sm font-medium transition-all ${
                    isActive
                      ? isDark
                        ? '!bg-zinc-800 !text-white !font-bold shadow-xs !shadow-none [&>svg]:!text-white'
                        : '!bg-white !text-[#610000] !font-bold shadow-sm !shadow-none [&>svg]:!text-[#610000]'
                      : isDark
                        ? '!text-zinc-400 hover:!text-white hover:!bg-zinc-800/60 [&>svg]:!text-zinc-400 hover:[&>svg]:!text-white'
                        : '!text-white/85 hover:!text-white hover:!bg-white/10 [&>svg]:!text-white/85 hover:[&>svg]:!text-white'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <AdminIcon
                      name={icon}
                      style={{
                        color: isActive ? (!isDark ? '#610000' : '#ffffff') : (isDark ? '#a1a1aa' : 'rgba(255,255,255,0.85)'),
                      }}
                    />
                    <span className="truncate">{label}</span>
                  </>
                )}
              </NavLink>
            );
          })}
        </nav>

        {/* Rodapé da Sidebar: Novo Card do Restaurante */}
        <div ref={restaurantMenuRef} className="mt-auto pt-4 relative">
          {restaurantMenuOpen && (
            <div
              className={`absolute bottom-full left-0 mb-2 w-full min-w-[210px] rounded-xl shadow-xl border p-1.5 z-50 transition-all ${
                isDark
                  ? 'bg-zinc-900 border-zinc-700 text-white shadow-black/50'
                  : 'bg-white border-zinc-200 text-zinc-900 shadow-zinc-900/15'
              }`}
            >
              <Link
                to={`/${r.slug}/equipe`}
                onClick={() => setRestaurantMenuOpen(false)}
                className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-xs font-semibold transition-colors ${
                  isDark
                    ? 'hover:bg-zinc-800 text-zinc-200 hover:text-white'
                    : 'hover:bg-zinc-100 text-zinc-700 hover:text-[#610000]'
                }`}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                  <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                </svg>
                <span>Ir para Atendimento</span>
              </Link>
              <Link
                to={`/${r.slug}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setRestaurantMenuOpen(false)}
                className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-xs font-semibold transition-colors ${
                  isDark
                    ? 'hover:bg-zinc-800 text-zinc-200 hover:text-white'
                    : 'hover:bg-zinc-100 text-zinc-700 hover:text-[#610000]'
                }`}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
                <span>Ver Cardápio</span>
              </Link>
            </div>
          )}

          <button
            type="button"
            onClick={() => setRestaurantMenuOpen((prev) => !prev)}
            className={`w-full flex items-center gap-3 p-2.5 rounded-xl border transition-all text-left cursor-pointer ${
              isDark
                ? 'bg-zinc-900/80 border-zinc-800 hover:bg-zinc-800 text-white'
                : 'bg-white/10 border-white/15 hover:bg-white/20 text-white'
            }`}
            title={r.name}
            aria-label={`Menu de ${r.name}`}
          >
            {/* Avatar / Logo do Restaurante */}
            <div className="w-8 h-8 rounded-lg bg-white/20 border border-white/25 flex items-center justify-center shrink-0 overflow-hidden text-xs font-bold uppercase text-white">
              {logoUrl ? (
                <img src={logoUrl} alt={r.name} className="w-8 h-8 rounded-lg object-cover" />
              ) : (
                <span>{r.name.slice(0, 2)}</span>
              )}
            </div>

            {!sidebarCollapsed && (
              <>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-bold truncate leading-tight text-white">{r.name}</p>
                  <span className="text-[10px] text-white/70 block truncate">Restaurante</span>
                </div>
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className={`shrink-0 text-white/80 transition-transform ${restaurantMenuOpen ? 'rotate-90' : ''}`}
                  aria-hidden="true"
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </>
            )}
          </button>
        </div>
      </aside>

      {/* ÁREA DE CONTEÚDO PRINCIPAL (WORKSPACE) */}
      <div
        className="admin-workspace print:p-0 print:m-0 print:w-full print:block transition-colors duration-200"
        style={{
          backgroundColor: isDark ? '#121212' : '#F8F9FA',
        }}
      >
        <AdminTopbar restaurant={r} onOpenMobileMenu={() => setMobileDrawerOpen(true)} />

        {/* DRAWER LATERAL MOBILE (abaixo de 768px) */}
        {mobileDrawerOpen && (
          <div
            className="fixed inset-0 z-50 md:hidden flex"
            role="dialog"
            aria-modal="true"
            aria-label="Menu de navegação"
          >
            {/* Backdrop escurecido */}
            <div
              className="fixed inset-0 bg-black/60 backdrop-blur-xs transition-opacity"
              onClick={() => setMobileDrawerOpen(false)}
              aria-hidden="true"
            />

            {/* Conteúdo do Drawer */}
            <div
              className="relative w-[280px] max-w-[85vw] h-full flex flex-col z-10 shadow-2xl p-4 overflow-y-auto"
              style={{
                backgroundColor: isDark ? '#18181b' : '#610000',
              }}
            >
              {/* Topo do Drawer: Logo + Botão Fechar */}
              <div className="flex items-center justify-between gap-3 mb-6 pb-3 border-b border-white/10">
                <Link
                  to={`/${r.slug}/admin`}
                  onClick={() => setMobileDrawerOpen(false)}
                  className="inline-flex items-center min-w-0 flex-1 overflow-hidden"
                  title="Painel Elozi"
                >
                  <img
                    src="/landing/Eloozi.png"
                    alt="Elozi"
                    className="h-7 w-auto object-contain brightness-0 invert"
                  />
                </Link>
                <button
                  type="button"
                  onClick={() => setMobileDrawerOpen(false)}
                  className="p-1.5 rounded-lg text-white/80 hover:text-white hover:bg-white/10 transition-colors cursor-pointer shrink-0"
                  aria-label="Fechar menu"
                >
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>

              {/* Itens de Navegação com rótulos completos */}
              <nav aria-label="Navegação móvel" className="flex flex-col gap-1.5 flex-1">
                {links.map(([path, label, icon]) => {
                  if (path === "financeiro") {
                    const isMainFinanceActive = isFinanceRoute && !isFechamentoActive;
                    return (
                      <div key={path} className="flex flex-col gap-1">
                        <div className="flex items-center">
                          <NavLink
                            end
                            to={`/${r.slug}/admin/financeiro`}
                            title={label}
                            onClick={() => {
                              setFinanceExpanded(true);
                              setMobileDrawerOpen(false);
                            }}
                            className={
                              `flex items-center gap-3 min-h-[42px] px-3.5 py-2.5 rounded-xl text-sm font-medium transition-all flex-1 ${
                                isMainFinanceActive
                                  ? isDark
                                    ? '!bg-zinc-800 !text-white !font-bold shadow-xs !shadow-none [&>svg]:!text-white'
                                    : '!bg-white !text-[#610000] !font-bold shadow-sm !shadow-none [&>svg]:!text-[#610000]'
                                  : isDark
                                    ? '!text-zinc-400 hover:!text-white hover:!bg-zinc-800/60 [&>svg]:!text-zinc-400 hover:[&>svg]:!text-white'
                                    : '!text-white/85 hover:!text-white hover:!bg-white/10 [&>svg]:!text-white/85 hover:[&>svg]:!text-white'
                              }`
                            }
                          >
                            <AdminIcon
                              name={icon}
                              style={{
                                color: isMainFinanceActive
                                  ? (!isDark ? '#610000' : '#ffffff')
                                  : (isDark ? '#a1a1aa' : 'rgba(255,255,255,0.85)'),
                              }}
                            />
                            <span className="truncate flex-1">{label}</span>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setFinanceExpanded((prev) => !prev);
                              }}
                              className="p-1 rounded-md hover:bg-black/10 dark:hover:bg-white/10 text-current transition-transform cursor-pointer"
                              aria-label={financeExpanded ? "Recolher opções" : "Expandir opções"}
                            >
                              <svg
                                className={`w-3.5 h-3.5 transition-transform duration-200 ${
                                  financeExpanded ? "rotate-180" : ""
                                }`}
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <polyline points="6 9 12 15 18 9" />
                              </svg>
                            </button>
                          </NavLink>
                        </div>

                        {financeExpanded && (
                          <NavLink
                            to={`/${r.slug}/admin/financeiro?tab=fechamento`}
                            title="Fechamento de caixa"
                            onClick={() => setMobileDrawerOpen(false)}
                            className={
                              `flex items-center gap-2 py-2 pr-3 pl-10 rounded-xl text-xs font-semibold transition-all ${
                                isFechamentoActive
                                  ? isDark
                                    ? '!bg-zinc-800 !text-white !font-bold shadow-xs'
                                    : '!bg-white !text-[#610000] !font-bold shadow-sm'
                                  : isDark
                                    ? '!text-zinc-400 hover:!text-white hover:!bg-zinc-800/50'
                                    : '!text-white/80 hover:!text-white hover:!bg-white/10'
                              }`
                            }
                          >
                            <span className="text-[13px] font-bold leading-none">+</span>
                            <span className="truncate">Fechamento de caixa</span>
                          </NavLink>
                        )}
                      </div>
                    );
                  }

                  return (
                    <NavLink
                      end
                      key={path}
                      to={`/${r.slug}/admin${path ? `/${path}` : ""}`}
                      title={label}
                      onClick={() => setMobileDrawerOpen(false)}
                      className={({ isActive }) =>
                        `flex items-center gap-3 min-h-[42px] px-3.5 py-2.5 rounded-xl text-sm font-medium transition-all ${
                          isActive
                            ? isDark
                              ? '!bg-zinc-800 !text-white !font-bold shadow-xs !shadow-none [&>svg]:!text-white'
                              : '!bg-white !text-[#610000] !font-bold shadow-sm !shadow-none [&>svg]:!text-[#610000]'
                            : isDark
                              ? '!text-zinc-400 hover:!text-white hover:!bg-zinc-800/60 [&>svg]:!text-zinc-400 hover:[&>svg]:!text-white'
                              : '!text-white/85 hover:!text-white hover:!bg-white/10 [&>svg]:!text-white/85 hover:[&>svg]:!text-white'
                        }`
                      }
                    >
                      {({ isActive }) => (
                        <>
                          <AdminIcon
                            name={icon}
                            style={{
                              color: isActive ? (!isDark ? '#610000' : '#ffffff') : (isDark ? '#a1a1aa' : 'rgba(255,255,255,0.85)'),
                            }}
                          />
                          <span className="truncate">{label}</span>
                        </>
                      )}
                    </NavLink>
                  );
                })}
              </nav>

              {/* Rodapé do Drawer: Links rápidos e Perfil do Restaurante */}
              <div className="mt-auto pt-4 border-t border-white/10 flex flex-col gap-2">
                <Link
                  to={`/${r.slug}/equipe`}
                  onClick={() => setMobileDrawerOpen(false)}
                  className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-semibold transition-colors ${
                    isDark
                      ? 'text-zinc-300 hover:bg-zinc-800 hover:text-white'
                      : 'text-white/90 hover:bg-white/15 hover:text-white'
                  }`}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                  </svg>
                  <span>Ir para Atendimento</span>
                </Link>
                <Link
                  to={`/${r.slug}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setMobileDrawerOpen(false)}
                  className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-semibold transition-colors ${
                    isDark
                      ? 'text-zinc-300 hover:bg-zinc-800 hover:text-white'
                      : 'text-white/90 hover:bg-white/15 hover:text-white'
                  }`}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <polyline points="15 3 21 3 21 9" />
                    <line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                  <span>Ver Cardápio Público</span>
                </Link>
                <div className="flex items-center gap-2.5 pt-2 px-1">
                  <div className="w-7 h-7 rounded-lg bg-white/20 flex items-center justify-center shrink-0 overflow-hidden text-xs font-bold uppercase text-white">
                    {logoUrl ? (
                      <img src={logoUrl} alt={r.name} className="w-7 h-7 rounded-lg object-cover" />
                    ) : (
                      <span>{r.name.slice(0, 2)}</span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-bold text-white truncate leading-tight">{r.name}</p>
                    <span className="text-[10px] text-white/70 block truncate">Restaurante</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
        <TrialBanner />

        {/* Avisos de Faturamento / Assinatura */}
        {isExpiringSoon && !isGracePeriod && !isSevereOverdue && (
          <div
            role="alert"
            className="print:hidden"
            style={{
              padding: "10px 20px",
              background: "rgba(245, 158, 11, 0.12)",
              borderBottom: "1px solid rgba(245, 158, 11, 0.35)",
              color: "#b45309",
              fontSize: "13px",
              fontWeight: 500,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "12px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span>
                <strong>{isTrial ? 'Período de Teste Gratuito:' : 'Renovação de Assinatura:'}</strong> Restam apenas {diffDays} {diffDays === 1 ? 'dia' : 'dias'} para o término do seu {isTrial ? 'teste gratuito de 7 dias' : 'plano'}.
              </span>
            </div>
            <Link
              to={`/${r.slug}/admin/assinatura`}
              style={{
                background: "#d97706",
                color: "#ffffff",
                padding: "4px 12px",
                borderRadius: "6px",
                fontSize: "12px",
                fontWeight: 600,
                textDecoration: "none",
                whiteSpace: "nowrap",
              }}
            >
              Renovar Plano
            </Link>
          </div>
        )}

        {isGracePeriod && !isSevereOverdue && (
          <div
            role="alert"
            className="print:hidden"
            style={{
              padding: "10px 20px",
              background: "rgba(239, 68, 68, 0.12)",
              borderBottom: "1px solid rgba(239, 68, 68, 0.35)",
              color: "#b91c1c",
              fontSize: "13px",
              fontWeight: 500,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "12px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <span>
                <strong>Atenção (Período de Tolerância):</strong> Sua assinatura venceu. O sistema será bloqueado em breve se não for regularizado.
              </span>
            </div>
            <Link
              to={`/${r.slug}/admin/assinatura`}
              style={{
                background: "#dc2626",
                color: "#ffffff",
                padding: "4px 12px",
                borderRadius: "6px",
                fontSize: "12px",
                fontWeight: 600,
                textDecoration: "none",
                whiteSpace: "nowrap",
              }}
            >
              Regularizar Agora
            </Link>
          </div>
        )}

        <main id="admin-content" className="print:p-0 print:m-0 print:w-full print:block px-4 sm:px-6 lg:px-8 pt-[10px] pb-8">
          {isSevereOverdue && !isBillingTab ? (
            <div
              className="p-8 max-w-xl mx-auto my-12 text-center rounded-2xl border"
              style={{
                background: isDark ? "#18181b" : "#ffffff",
                borderColor: isDark ? "#27272a" : "#e5e7eb",
                boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.05)",
              }}
            >
              <div
                className="w-16 h-16 mx-auto mb-4 rounded-full flex items-center justify-center"
                style={{ background: "rgba(239, 68, 68, 0.1)", color: "#dc2626" }}
              >
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              </div>
              <h2 className="text-xl font-bold mb-2 text-zinc-900 dark:text-white">
                {isTrial ? 'Período de Teste Gratuito Expirado' : 'Acesso Administrativo Suspenso'}
              </h2>
              <p className="text-sm mb-6 leading-relaxed text-zinc-600 dark:text-zinc-400">
                {isTrial
                  ? 'Seu período de teste gratuito de 7 dias chegou ao fim. Para continuar utilizando o sistema, gerenciar seus pedidos e atender seus clientes, escolha um plano de assinatura.'
                  : 'O período de tolerância de 3 dias expirou e a assinatura deste restaurante está suspensa. Para restabelecer imediatamente as operações de salão, comandas e visualização da cozinha, efetue o pagamento da fatura em aberto.'}
              </p>
              <Link
                to={`/${r.slug}/admin/assinatura`}
                className="inline-flex items-center gap-2 px-6 py-3 rounded-xl font-semibold text-white shadow-sm transition-opacity hover:opacity-95"
                style={{ background: "#dc2626" }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect width="20" height="14" x="2" y="5" rx="2" />
                  <line x1="2" y1="10" x2="22" y2="10" />
                </svg>
                <span>Acessar Faturamento & Pagar</span>
              </Link>
            </div>
          ) : (
            <Outlet context={access} />
          )}
        </main>
      </div>
    </div>
  );
}

export function AdminIcon({
  name,
  className = "",
  style,
}: {
  name: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const paths: Record<string, string> = {
    home: "M3 10 12 3l9 7v11h-6v-7H9v7H3Z",
    menu: "M5 3h14v18H5ZM8 7h8M8 11h8M8 15h5",
    chat: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
    table: "M3 9h18v4H3ZM5 13l-2 8M19 13l2 8M5 9V5h14v4",
    kds: "M6 13.8a4.5 4.5 0 1 1 8.8-1.2 4 4 0 1 1 5.2 5.2H4a4 4 0 0 1 2-4z M6 18h12v3H6z",
    settings:
      "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2",
    brush: "m18.37 2.63 3 3L13 14l-4 1 1-4 8.37-8.37z M9 15c-3 1-6 4-7 7 3-1 6-4 7-7z",
    cloud: "M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z",
    media: "M3 3h18v18H3ZM3 17l6-7 5 6 3-3 4 5M16 7h1",
    user: "M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM4 21v-3a8 8 0 0 1 16 0v3Z",
    bell: "M5 17h14l-2-3V9a5 5 0 0 0-10 0v5ZM10 21h4",
    package: "M16.5 9.4 7.55 4.24M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16zM3.27 6.96 12 12.01l8.73-5.05M12 22.08V12",
    exit: "M10 3H4v18h6M9 12h12M17 8l4 4-4 4",
    card: "M2 5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5Zm0 5h20M6 15h2m4 0h6",
    chart: "M18 20V10M12 20V4M6 20v-6M3 20h18",
    lock: "M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2zM7 11V7a5 5 0 0 1 10 0v4",
  };
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ color: "inherit", ...style }}
      aria-hidden="true"
    >
      <path d={paths[name] || paths.menu} />
    </svg>
  );
}

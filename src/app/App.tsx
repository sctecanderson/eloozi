import { useEffect, lazy, Suspense, type CSSProperties } from "react";
import {
  Link,
  NavLink,
  Outlet,
  Route,
  Routes,
  useParams,
  useLocation,
} from "react-router";
import {
  RestaurantProvider,
  useRestaurant,
} from "../features/restaurants/RestaurantProvider";
import { PublicMenuProvider } from "../features/menu/PublicMenuProvider";
import { MenuPage } from "../features/menu/MenuPage";
import { HomePage } from "../features/menu/HomePage";
import { useTableContext, getTableQueryString, TableProvider } from "../features/tables/useTableContext";
import { RequireStaffAccess } from "../features/auth/RequireStaffAccess";
import { ThemeProvider, useTheme } from "../features/theme/ThemeContext";
import { ThemeToggleButton } from "../features/theme/ThemeToggleButton";
import { StaffCommissionProvider } from "../features/service/StaffCommissionContext";
import { SoundSettingsControl } from "../features/alerts/SoundSettingsControl";
import { StaffCommissionHeaderPill } from "../features/service/StaffCommissionHeaderPill";
import { LandingPage } from "../features/landing/LandingPage";

const ProductPage = lazy(() =>
  import("../features/menu/ProductPage").then((m) => ({
    default: m.ProductPage,
  })),
);
const ProductCommentsPage = lazy(() =>
  import("../features/comments/ProductCommentsPage").then((m) => ({
    default: m.ProductCommentsPage,
  })),
);
const ExplorePage = lazy(() =>
  import("../features/explore/ExplorePage").then((m) => ({
    default: m.ExplorePage,
  })),
);
const TabOrdersPage = lazy(() =>
  import("../features/service/TabOrdersPage").then((m) => ({
    default: m.TabOrdersPage,
  })),
);
const ResetPasswordPage = lazy(() =>
  import("../features/auth/ResetPasswordPage").then((m) => ({
    default: m.ResetPasswordPage,
  })),
);
const PublicOnboardingPage = lazy(() =>
  import("../features/onboarding/PublicOnboardingPage").then((m) => ({
    default: m.PublicOnboardingPage,
  })),
);
const FinancialReportPage = lazy(() =>
  import("../features/admin/FinancialReportPage").then((m) => ({
    default: m.FinancialReportPage,
  })),
);
const AccessPage = lazy(() =>
  import("../features/auth/AccessPage").then((m) => ({
    default: m.AccessPage,
  })),
);
const StaffServicePage = lazy(() =>
  import("../features/service/StaffServicePage").then((m) => ({
    default: m.StaffServicePage,
  })),
);
const StaffHistoryPage = lazy(() =>
  import("../features/service/StaffHistoryPage").then((m) => ({
    default: m.StaffHistoryPage,
  })),
);
const StaffProfilePage = lazy(() =>
  import("../features/service/StaffProfilePage").then((m) => ({
    default: m.StaffProfilePage,
  })),
);
const AdminCatalogPage = lazy(() =>
  import("../features/admin/AdminCatalogPage").then((m) => ({
    default: m.AdminCatalogPage,
  })),
);
const AdminCommentsPage = lazy(() =>
  import("../features/admin/AdminCommentsPage").then((m) => ({
    default: m.AdminCommentsPage,
  })),
);
const AdminLayout = lazy(() =>
  import("../features/admin/AdminLayout").then((m) => ({
    default: m.AdminLayout,
  })),
);
const IdentityPage = lazy(() =>
  import("../features/admin/IdentityPage").then((m) => ({
    default: m.IdentityPage,
  })),
);
const TablesPage = lazy(() =>
  import("../features/admin/TablesPage").then((m) => ({
    default: m.TablesPage,
  })),
);
const AdminOverview = lazy(() =>
  import("../features/admin/AdminOverview").then((m) => ({
    default: m.AdminOverview,
  })),
);
const MediaMaintenancePage = lazy(() =>
  import("../features/admin/MediaMaintenancePage").then((m) => ({
    default: m.MediaMaintenancePage,
  })),
);
const KdsPage = lazy(() =>
  import("../features/kds/KdsPage").then((m) => ({
    default: m.KdsPage,
  })),
);
const SubscriptionBillingPage = lazy(() =>
  import("../features/admin/SubscriptionBillingPage").then((m) => ({
    default: m.SubscriptionBillingPage,
  })),
);
const InventoryPage = lazy(() =>
  import("../features/inventory/InventoryPage").then((m) => ({
    default: m.InventoryPage,
  })),
);

const PlatformAccessPage = lazy(() =>
  import('../features/platform/PlatformAccessPage').then((module) => ({
    default: module.PlatformAccessPage,
  })),
);

const RequirePlatformAccess = lazy(() =>
  import('../features/platform/RequirePlatformAccess').then((module) => ({
    default: module.RequirePlatformAccess,
  })),
);

const PlatformRestaurantsPage = lazy(() =>
  import('../features/platform/PlatformRestaurantsPage').then((module) => ({
    default: module.PlatformRestaurantsPage,
  })),
);

const PlatformBackupsPage = lazy(() =>
  import('../features/platform/PlatformBackupsPage').then((module) => ({ default: module.PlatformBackupsPage })),
);
const PlatformDeletionPage = lazy(() =>
  import('../features/platform/PlatformDeletionPage').then((module) => ({ default: module.PlatformDeletionPage })),
);

const StaffManagementPage = lazy(() =>
  import('../features/admin/StaffManagementPage').then(m => ({ default: m.StaffManagementPage })),
);
const StaffInvitationPage = lazy(() =>
  import('../features/auth/StaffInvitationPage').then(m => ({ default: m.StaffInvitationPage })),
);

function RestaurantRoot() {
  const { restaurantSlug = "" } = useParams();
  return (
    <ThemeProvider>
      <RestaurantProvider key={restaurantSlug} slug={restaurantSlug}>
        <TableProvider>
          <Outlet />
        </TableProvider>
      </RestaurantProvider>
    </ThemeProvider>
  );
}

function PublicMenuLayout() {
  const { restaurantSlug = "" } = useParams();
  return (
    <PublicMenuProvider key={restaurantSlug} restaurantSlug={restaurantSlug}>
      <RestaurantLayout />
    </PublicMenuProvider>
  );
}

function RestaurantLayout() {
  const table = useTableContext();
  const tableQuery = getTableQueryString(table);
  const { restaurant } = useRestaurant();
  const { theme: themeMode } = useTheme();
  const location = useLocation();
  useEffect(() => {
    document.title = restaurant
      ? `${restaurant.name} · Cardápio`
      : "Restaurante não encontrado";
  }, [restaurant]);

  const isDark = themeMode === 'dark';
  const theme = {
    "--brand": restaurant.theme.primary,
    "--page": isDark ? "#14110f" : restaurant.theme.background,
    "--ink": isDark ? "#f7f3ee" : restaurant.theme.text,
  } as CSSProperties;
  const isExplore = location.pathname.split("/")[2] === "explorar";
  const isProduct = location.pathname.split("/")[2] === "produto";
  const isEquipe = location.pathname.split("/")[2] === "equipe";
  const isStaffHistory = isEquipe && location.pathname.split("/")[3] === "historico";
  const isStaffTableDetail = isEquipe && new URLSearchParams(location.search).has("mesa");
  if (isExplore) {
    return (
      <div className="restaurant explore-viewport" data-theme={themeMode} style={theme}>
        <a href="#content" className="skip-link">Pular para o feed</a>
        <main id="content" className="explore-main">
          <Suspense fallback={<div className="shell py-8 text-center"><p role="status" className="text-xs opacity-60">Carregando feed…</p></div>}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    );
  }
  if (isProduct) {
    return (
      <div className="restaurant product-viewport" data-theme={themeMode} style={theme}>
        <a href="#content" className="skip-link">Pular para o produto</a>
        <main id="content" className="product-main">
          <Suspense fallback={<div className="shell py-8 text-center"><p role="status" className="text-xs opacity-60">Carregando produto…</p></div>}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    );
  }
  if (location.pathname.split("/")[2] === "admin")
    return (
      <div className="restaurant" data-theme={themeMode} style={theme}>
        <Suspense
          fallback={
            <p className="shell py-8" role="status">
              Carregando administração…</p>
          }
        >
          <Outlet />
        </Suspense>
      </div>
    );

  if (isEquipe) {
    return (
      <StaffCommissionProvider>
        <div className="min-h-screen bg-[#FAF6F2] dark:bg-zinc-950 flex justify-center" data-theme={themeMode} style={theme}>
          <a
            href="#content"
            className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 z-50 bg-white p-2 rounded shadow text-xs text-zinc-900"
          >
            Pular para o conteúdo
          </a>
          <div className="w-full max-w-md md:max-w-lg min-h-screen flex flex-col relative px-4 pt-3 pb-28 shadow-xl bg-[#FAF6F2] dark:bg-zinc-950 border-x border-amber-900/5">
            {!isStaffTableDetail && (
              <header className="public-header">
                <Link
                  to={`/${restaurant.slug}/equipe`}
                  aria-label={`${restaurant.name}, início`}
                  className="wordmark"
                >
                  {restaurant.logo ? (
                    <img
                      src={restaurant.logo.url}
                      className="public-logo"
                      alt={restaurant.name}
                    />
                  ) : (
                    <>
                      {restaurant.name}
                      <span>{restaurant.subtitle}</span>
                    </>
                  )}
                </Link>
                <div className="public-header-actions">
                  <SoundSettingsControl />
                  <ThemeToggleButton />
                </div>
              </header>
            )}

            <main id="content" className="flex-1">
              <Suspense
                fallback={
                  <div className="py-6 text-center">
                    <p role="status" className="text-xs text-[var(--ink)] opacity-60">
                      Carregando equipe…
                    </p>
                  </div>
                }
              >
                <Outlet />
              </Suspense>
            </main>

            {/* Barra Inferior Fixa (BottomNav) */}
            <nav className="fixed bottom-0 left-0 right-0 z-40 flex justify-center pointer-events-none" aria-label="Navegação da equipe">
              <div className="w-full max-w-md md:max-w-lg px-4 pb-3 pointer-events-auto">
                <div className="bg-[#FCF9F5]/95 dark:bg-zinc-900/95 backdrop-blur-md rounded-3xl border border-amber-900/10 shadow-lg py-2.5 px-4 flex items-center justify-around">
                  {/* Itens: Atendimento, Comandas, Chamados, Mais */}
                  <NavLink
                    to={`/${restaurant.slug}/equipe`}
                    end
                    className={() => {
                      const isAtendimentoActive =
                        location.pathname === `/${restaurant.slug}/equipe` &&
                        !location.search.includes('status=waiting');
                      return `flex flex-col items-center gap-1 py-1.5 px-3 rounded-2xl transition-all cursor-pointer ${
                        isAtendimentoActive
                          ? 'bg-[#FAF4EE] dark:bg-zinc-800 text-[#4A1505] dark:text-amber-300 font-bold'
                          : 'text-zinc-600 dark:text-zinc-400 font-medium hover:text-zinc-900 dark:hover:text-zinc-200'
                      }`;
                    }}
                  >
                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 4v2" />
                      <path d="M4 18h16a1 1 0 0 0 1-1A9 9 0 0 0 3 17a1 1 0 0 0 1 1z" />
                      <path d="M2 20h20" />
                    </svg>
                    <span className="text-[11px] leading-tight">Atendimento</span>
                  </NavLink>

                  <NavLink
                    to={`/${restaurant.slug}/equipe/comandas`}
                    className={() => {
                      const isComandasActive =
                        location.pathname.includes('/comandas') ||
                        location.pathname.includes('/historico');
                      return `flex flex-col items-center gap-1 py-1.5 px-3 rounded-2xl transition-all cursor-pointer ${
                        isComandasActive
                          ? 'bg-[#FAF4EE] dark:bg-zinc-800 text-[#4A1505] dark:text-amber-300 font-bold'
                          : 'text-zinc-600 dark:text-zinc-400 font-medium hover:text-zinc-900 dark:hover:text-zinc-200'
                      }`;
                    }}
                  >
                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                      <line x1="16" y1="13" x2="8" y2="13" />
                      <line x1="16" y1="17" x2="8" y2="17" />
                    </svg>
                    <span className="text-[11px] leading-tight">Comandas</span>
                  </NavLink>

                  <NavLink
                    to={`/${restaurant.slug}/equipe?status=waiting`}
                    className={() => {
                      const isChamadosActive =
                        location.pathname === `/${restaurant.slug}/equipe` &&
                        location.search.includes('status=waiting');
                      return `flex flex-col items-center gap-1 py-1.5 px-3 rounded-2xl transition-all cursor-pointer ${
                        isChamadosActive
                          ? 'bg-[#FAF4EE] dark:bg-zinc-800 text-[#4A1505] dark:text-amber-300 font-bold'
                          : 'text-zinc-600 dark:text-zinc-400 font-medium hover:text-zinc-900 dark:hover:text-zinc-200'
                      }`;
                    }}
                  >
                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                    </svg>
                    <span className="text-[11px] leading-tight">Chamados</span>
                  </NavLink>

                  <NavLink
                    to={`/${restaurant.slug}/equipe/perfil`}
                    className={() => {
                      const isPerfilActive = location.pathname.includes('/perfil');
                      return `flex flex-col items-center gap-1 py-1.5 px-3 rounded-2xl transition-all cursor-pointer ${
                        isPerfilActive
                          ? 'bg-[#FAF4EE] dark:bg-zinc-800 text-[#4A1505] dark:text-amber-300 font-bold'
                          : 'text-zinc-600 dark:text-zinc-400 font-medium hover:text-zinc-900 dark:hover:text-zinc-200'
                      }`;
                    }}
                  >
                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                      <circle cx="12" cy="7" r="4" />
                    </svg>
                    <span className="text-[11px] leading-tight">Mais</span>
                  </NavLink>
                </div>
              </div>
            </nav>
          </div>
        </div>
      </StaffCommissionProvider>
    );
  }

  return (
    <StaffCommissionProvider>
      <div className="restaurant public-site" data-theme={themeMode} style={theme}>
        <a
          href="#content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 z-50 bg-white p-2 rounded shadow text-xs text-zinc-900"
        >
          Pular para o conteúdo
        </a>
        <div className="shell">
          {!isProduct && (
            <>
              <header className="public-header">
                <Link
                  to={`/${restaurant.slug}${tableQuery}`}
                  aria-label={`${restaurant.name}, início`}
                  className="wordmark"
                >
                  {restaurant.logo ? (
                    <img
                      src={restaurant.logo.url}
                      className="public-logo"
                      alt={restaurant.name}
                    />
                  ) : (
                    <>
                      {restaurant.name}
                      <span>{restaurant.subtitle}</span>
                    </>
                  )}
                </Link>
                <div className="public-header-actions">
                  <span className="badge public-table-badge">
                    {table.status === "unverified"
                      ? `Mesa ${table.tableNumber}`
                      : table.status === "invalid"
                        ? "Mesa inválida"
                        : table.status === "expired"
                          ? "Atendimento indisponível"
                          : table.status === "loading"
                            ? "Identificando mesa…"
                            : "Consulta sem mesa"}
                  </span>
                  <ThemeToggleButton />
                </div>
              </header>
              <nav className="tabs public-tabs" aria-label="Modo de visualização">
                <NavLink end to={`/${restaurant.slug}${tableQuery}`}>
                  Home
                </NavLink>
                <NavLink to={`/${restaurant.slug}/cardapio${tableQuery}`}>
                  Cardápio
                </NavLink>
                <NavLink to={`/${restaurant.slug}/explorar${tableQuery}`}>
                  Explorar
                </NavLink>
              </nav>
            </>
          )}
          <main id="content" className={`public-main ${isProduct ? 'product-main' : ''}`}>
            <Suspense
              fallback={
                <div className="py-6 text-center">
                  <p role="status" className="text-xs text-[var(--ink)] opacity-60">
                    Carregando…
                  </p>
                </div>
              }
            >
              <Outlet />
            </Suspense>
          </main>
        </div>
      </div>
    </StaffCommissionProvider>
  );
}
function Access() {
  return (
    <Suspense
      fallback={
        <div className="shell py-8 text-center">
          <p role="status" className="text-xs opacity-60">Carregando acesso…</p>
        </div>
      }
    >
      <AccessPage />
    </Suspense>
  );
}
function NotFound() {
  return (
    <main className="shell py-8">
      <h1>Página não encontrada</h1>
      <p>Confira o endereço do restaurante.</p>
      <Link to="/">Voltar ao início</Link>
    </main>
  );
}
function Start() {
  return (
    <main className="shell py-8">
      <span className="eyebrow">Cardápio Digital</span>
      <h1>Bem-vindo</h1>
      <p>
        Acesse o endereço ou escaneie o QR Code do seu restaurante para
        consultar o cardápio.</p>
      <div className="mt-6">
        <Link
          to="/criar-conta"
          className="inline-flex items-center gap-2 px-5 py-3 rounded-xl font-bold text-sm text-white shadow-sm transition-opacity hover:opacity-95"
          style={{ background: "#2B1D17" }}
        >
          <span>Testar Grátis por 7 Dias — Criar Meu Restaurante</span>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <line x1="5" y1="12" x2="19" y2="12" />
            <polyline points="12 5 19 12 12 19" />
          </svg>
        </Link>
      </div>

    </main>
  );
}
export function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="login" element={<Suspense fallback={<p role="status" className="shell py-8">Carregando…</p>}><PlatformAccessPage /></Suspense>} />
      <Route path="acesso" element={<Suspense fallback={<p role="status" className="shell py-8">Carregando…</p>}><PlatformAccessPage /></Suspense>} />
      <Route path="convite" element={<Suspense fallback={<p role="status" className="shell py-8">Carregando convite…</p>}><StaffInvitationPage /></Suspense>} />
      <Route path="redefinir-senha" element={<Suspense fallback={<p role="status" className="shell py-8">Carregando…</p>}><ResetPasswordPage /></Suspense>} />
      <Route path="criar-conta" element={<Suspense fallback={<p role="status" className="shell py-8">Carregando cadastro…</p>}><PublicOnboardingPage /></Suspense>} />
      <Route path=":restaurantSlug/acesso" element={<Suspense fallback={<p role="status" className="shell py-8">Carregando…</p>}><PlatformAccessPage /></Suspense>} />
      <Route
        path="plataforma"
        element={
          <Suspense
            fallback={
              <main className="shell py-10">
                <p role="status">Carregando Elozi…</p>
              </main>
            }
          >
            <Outlet />
          </Suspense>
        }
      >
        <Route path="acesso" element={<PlatformAccessPage />} />

        <Route element={<RequirePlatformAccess />}>
          <Route index element={<PlatformRestaurantsPage />} />
          <Route path="restaurantes/:restaurantId/backups" element={<PlatformBackupsPage />} />
          <Route path="restaurantes/:restaurantId/excluir" element={<PlatformDeletionPage />} />
          <Route
            path="restaurantes"
            element={<PlatformRestaurantsPage />}
          />
        </Route>

        <Route path="*" element={<NotFound />} />
      </Route>
      <Route path=":restaurantSlug" element={<RestaurantRoot />}>
        <Route element={<PublicMenuLayout />}>
          <Route index element={<HomePage />} />
          <Route path="cardapio" element={<MenuPage />} />
          <Route path="comanda" element={<TabOrdersPage />} />

          <Route path="produto/:productId/comentarios" element={<ProductCommentsPage />} />
          <Route path="produto/:productSlug" element={<ProductPage />} />
          <Route path="explorar" element={<ExplorePage />} />
        </Route>
        <Route element={<RestaurantLayout />}>
          <Route path="acesso" element={<PlatformAccessPage />} />
          <Route element={<RequireStaffAccess />}>
            <Route path="equipe" element={<StaffServicePage />} />
            <Route path="equipe/comandas" element={<StaffHistoryPage />} />
            <Route path="equipe/historico" element={<StaffHistoryPage />} />
            <Route path="equipe/perfil" element={<StaffProfilePage />} />
          </Route>

          <Route element={<RequireStaffAccess requiredRole="admin" />}>
            <Route path="admin/kds" element={<KdsPage />} />
            <Route path="admin" element={<AdminLayout />}>
              <Route index element={<AdminOverview />} />
              <Route path="catalogo" element={<AdminCatalogPage />} />
              <Route path="estoque" element={<InventoryPage />} />
              <Route path="comentarios" element={<AdminCommentsPage />} />
              <Route path="assinatura" element={<SubscriptionBillingPage />} />
              <Route path="financeiro" element={<FinancialReportPage />} />
              <Route path="fechamento-caixa" element={<FinancialReportPage />} />
              <Route path="identidade" element={<IdentityPage />} />
              <Route path="mesas" element={<TablesPage />} />
              <Route path="midias" element={<MediaMaintenancePage />} />
              <Route path="equipe" element={<StaffManagementPage />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Route>
          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>
    </Routes>
  );
}

import { visibleContactUrls } from "../restaurants/contactChannels";
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useRestaurant } from '../restaurants/RestaurantProvider';
import { useTableContext, getTableQueryString } from '../tables/useTableContext';
import { ServiceActionPopup, type ServiceActionType } from '../service/ServiceActionPopup';
import { usePublicMenu, PublicMenuStatus } from './PublicMenuProvider';
import type { Product } from '../../types/menu';

const currency = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

type HomeAction = 'waiter' | 'bill' | null;

function getCover(product: Product) {
  return product.images.find((image) => image.id === product.coverImageId)
    ?? product.images[0]
    ?? null;
}

function formatLikes(count: number) {
  const safeCount = Math.max(0, count);
  if (safeCount >= 1000) {
    return `${(safeCount / 1000).toFixed(1)}k`;
  }
  return String(safeCount);
}

function compareCatalogOrder(a: Product, b: Product): number {
  const featuredDiff = Number(b.featured) - Number(a.featured);
  if (featuredDiff !== 0) return featuredDiff;
  const sortDiff = a.sortOrder - b.sortOrder;
  if (sortDiff !== 0) return sortDiff;
  return a.id.localeCompare(b.id);
}

function compareByLikesCountDesc(a: Product, b: Product): number {
  const likesDiff = Math.max(0, b.likesCount ?? 0) - Math.max(0, a.likesCount ?? 0);
  if (likesDiff !== 0) return likesDiff;
  const sortDiff = a.sortOrder - b.sortOrder;
  if (sortDiff !== 0) return sortDiff;
  return a.id.localeCompare(b.id);
}

function HeartBadgeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
    </svg>
  );
}

function ProductCard({ product, restaurantSlug, tableQuery, likesCount }: {
  product: Product;
  restaurantSlug: string;
  tableQuery: string;
  likesCount: number;
}) {
  const image = getCover(product);
  const formattedLikes = formatLikes(likesCount);
  const badgeText = (() => {
    try {
      const stored = localStorage.getItem(`elozi_product_badge_${product.id}`);
      if (stored) return stored;
    } catch {}
    const meta = product as unknown as Record<string, unknown>;
    return (meta.badge_text as string) || (meta.badgeText as string) || null;
  })();
  const badgeColor = (() => {
    try {
      const stored = localStorage.getItem(`elozi_product_badge_color_${product.id}`);
      if (stored) return stored;
    } catch {}
    const meta = product as unknown as Record<string, unknown>;
    return (meta.badge_color as string) || (meta.badgeColor as string) || "#D97706";
  })();

  return (
    <Link
      to={`/${restaurantSlug}/produto/${product.slug}${tableQuery}`}
      className="home-dish-card"
      aria-label={`${product.name}, ${currency.format(product.priceInCents / 100)}, ${likesCount === 1 ? '1 curtida' : `${likesCount} curtidas`}. Ver prato`}
    >
      <div className="home-dish-image-wrap relative">
        {image ? (
          <img
            src={image.url}
            alt={image.alt}
            loading="lazy"
            decoding="async"
            className="home-dish-image"
          />
        ) : (
          <div className="home-dish-placeholder" aria-hidden="true">
            <div className="flex flex-col items-center justify-center gap-1.5 p-3 text-center">
              <span className="w-8 h-8 rounded-full bg-[#610000]/10 dark:bg-white/10 text-[#610000] dark:text-amber-300 flex items-center justify-center">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 8h1a4 4 0 0 1 0 8h-1" />
                  <path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z" />
                  <line x1="6" y1="1" x2="6" y2="4" />
                  <line x1="10" y1="1" x2="10" y2="4" />
                  <line x1="14" y1="1" x2="14" y2="4" />
                </svg>
              </span>
              <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-300 line-clamp-2">
                {product.name}
              </span>
            </div>
          </div>
        )}
        {badgeText && (
          <span
            className="absolute top-3 right-3 px-2.5 py-1 rounded-full text-[11px] font-bold tracking-wide shadow-md text-white backdrop-blur-sm z-10 pointer-events-none"
            style={{ backgroundColor: badgeColor }}
          >
            {badgeText}
          </span>
        )}
      </div>
      <div className="home-dish-copy">
        <div className="home-dish-title-row">
          <h3>{product.name}</h3>
          <span className="home-dish-inline-rating" aria-hidden="true">
            <HeartBadgeIcon />
            {formattedLikes}
          </span>
        </div>
        <p>{product.shortDescription || product.description || 'Ingredientes selecionados e preparo especial da casa.'}</p>
        <div className="home-dish-footer">
          <strong>{currency.format(product.priceInCents / 100)}</strong>
          {product.isOutOfStock ? (
            <span className="text-xs px-2 py-0.5 rounded border border-zinc-300 dark:border-zinc-700 text-zinc-500 font-medium">
              Esgotado
            </span>
          ) : (
            <span className="home-dish-btn">Ver Prato <b aria-hidden="true">+</b></span>
          )}
        </div>
      </div>
    </Link>
  );
}

function HomeIcon({ name }: { name: 'home' | 'waiter' | 'bill' }) {
  if (name === 'home') return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" />
    </svg>
  );
  if (name === 'waiter') return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  );
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  );
}

export function HomePage() {
  const { restaurantSlug = '' } = useParams();
  const { restaurant } = useRestaurant();
  const table = useTableContext();
  const { menu, getProductLikesCount } = usePublicMenu();
  const [activeBanner, setActiveBanner] = useState(0);
  const [activeAction, setActiveAction] = useState<ServiceActionType>(null);
  const [copiedWifi, setCopiedWifi] = useState(false);
  const bannerRail = useRef<HTMLDivElement>(null);
  const tableQuery = getTableQueryString(table);

  // Informações de Wi-Fi e Redes Sociais da Identidade Visual do restaurante
  const meta = restaurant as unknown as Record<string, unknown>;

  const wifiSsid = (() => {
    try {
      return (
        localStorage.getItem(`elozi_id_wifi_ssid_${restaurant.id}`) ||
        (meta.wifiSsid as string) ||
        (meta.wifi_ssid as string) ||
        "Wi-Fi Clientes"
      );
    } catch {
      return (meta.wifiSsid as string) || "Wi-Fi Clientes";
    }
  })();

  const wifiPassword = (() => {
    try {
      return (
        localStorage.getItem(`elozi_id_wifi_pass_${restaurant.id}`) ||
        (meta.wifiPassword as string) ||
        (meta.wifi_password as string) ||
        ""
      );
    } catch {
      return (meta.wifiPassword as string) || "";
    }
  })();

  const showWifi = (() => {
    try {
      const val = localStorage.getItem(`elozi_id_show_wifi_${restaurant.id}`);
      return val !== null ? val === "true" : true;
    } catch {
      return true;
    }
  })();

  const rawInstagram = (() => {
    try {
      return (
        localStorage.getItem(`elozi_id_instagram_${restaurant.id}`) ||
        (meta.instagram as string) ||
        ""
      );
    } catch {
      return (meta.instagram as string) || "";
    }
  })().trim();

  const rawWhatsapp = (() => {
    try {
      return (
        localStorage.getItem(`elozi_id_whatsapp_${restaurant.id}`) ||
        (meta.whatsapp as string) ||
        restaurant.phone ||
        ""
      );
    } catch {
      return restaurant.phone || "";
    }
  })().trim();

  const rawFacebook = (() => {
    try {
      return (
        localStorage.getItem(`elozi_id_facebook_${restaurant.id}`) ||
        (meta.facebook as string) ||
        ""
      );
    } catch {
      return (meta.facebook as string) || "";
    }
  })().trim();

  // A saved server configuration is authoritative, including disabled/empty channels.
  const channels = restaurant.contactChannels ?? {
    instagram: { value: rawInstagram, enabled: true },
    whatsapp: { value: rawWhatsapp, enabled: true },
    facebook: { value: rawFacebook, enabled: true },
  };
  const { instagram: instagramUrl, whatsapp: whatsappUrl, facebook: facebookUrl } = visibleContactUrls(channels);
  const hasReview = Boolean(restaurant.googleReviewUrl && restaurant.googleReviewUrl.trim().length > 0);
  const hasWifi = Boolean(showWifi && (wifiSsid || wifiPassword));
  const hasSocials = Boolean(instagramUrl || whatsappUrl || facebookUrl);
  const hasInfo = hasWifi || hasSocials;

  const bannerTitle = (() => {
    try {
      return (
        localStorage.getItem(`elozi_id_banner_title_${restaurant.id}`) ||
        (meta.bannerTitle as string) ||
        (meta.banner_title as string) ||
        "Destaques da Semana"
      );
    } catch {
      return (meta.bannerTitle as string) || "Destaques da Semana";
    }
  })();

  const bannerSubtitle = (() => {
    try {
      return (
        localStorage.getItem(`elozi_id_banner_subtitle_${restaurant.id}`) ||
        (meta.bannerSubtitle as string) ||
        (meta.banner_subtitle as string) ||
        "O melhor da nossa culinária contemporânea"
      );
    } catch {
      return (meta.bannerSubtitle as string) || "O melhor da nossa culinária contemporânea";
    }
  })();

  const handleCopyWifi = () => {
    if (!wifiPassword) return;
    navigator.clipboard
      .writeText(wifiPassword)
      .then(() => {
        setCopiedWifi(true);
        setTimeout(() => setCopiedWifi(false), 2000);
      })
      .catch(() => {
        // Fallback seguro caso clipboard API falhe
      });
  };

  if (!menu) return <PublicMenuStatus />;

  const products = [...menu.products]
    .filter((product) => product.available && product.restaurantId === menu.restaurantId)
    .sort(compareCatalogOrder);
  const featuredProducts = products.filter((product) => product.featured);
  const banners = (featuredProducts.length ? featuredProducts : products).slice(0, 5);
  const entryProducts = products.filter((product) => {
    const category = menu.categories.find((item) => item.id === product.categoryId);
    return /entrad|aperitivo|entrada|starter/i.test(`${category?.name ?? ''} ${category?.slug ?? ''}`);
  });
  const highlights = entryProducts.length ? entryProducts.slice(0, 8) : products.slice(0, 4);
  const highlightIds = new Set(highlights.map((product) => product.id));
  const remainingProducts = products.filter((product) => !highlightIds.has(product.id));
  // "Mais Amados" ordena por likesCount real decrescente, com desempate determinístico por sortOrder e id
  const lovedPool = remainingProducts.length > 0 ? remainingProducts : products;
  const otherProducts = [...lovedPool].sort((a, b) => {
    const likesA = getProductLikesCount(a.id);
    const likesB = getProductLikesCount(b.id);
    const likesDiff = likesB - likesA;
    if (likesDiff !== 0) return likesDiff;
    const sortDiff = a.sortOrder - b.sortOrder;
    if (sortDiff !== 0) return sortDiff;
    return a.id.localeCompare(b.id);
  }).slice(0, 8);

  function scrollToBanner(index: number) {
    const rail = bannerRail.current;
    const card = rail?.children.item(index);
    if (!rail || !(card instanceof HTMLElement)) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    rail.scrollTo({ left: card.offsetLeft - rail.offsetLeft, behavior: reducedMotion ? 'instant' : 'smooth' });
  }

  return (
    <div className="home-page">
      <section className="home-promo-section" aria-label="Destaques do restaurante">
        {banners.length ? (
          <div
            ref={bannerRail}
            className="home-promo-rail"
            role="region"
            aria-label="Destaques. Deslize para os lados."
            onScroll={(event) => {
              const rail = event.currentTarget;
              const cards = Array.from(rail.children);
              const nearest = cards.reduce((best, child, index) => {
                if (!(child instanceof HTMLElement)) return best;
                if (!(best.card instanceof HTMLElement)) return { card: child, index };
                return Math.abs(child.offsetLeft - rail.scrollLeft) < Math.abs(best.card.offsetLeft - rail.scrollLeft)
                  ? { card: child, index }
                  : best;
              }, { card: null as Element | null, index: 0 });
              setActiveBanner(nearest.index);
            }}
          >
            {banners.map((product, index) => {
              const image = getCover(product);
              return (
                <Link
                  key={product.id}
                  to={`/${restaurantSlug}/produto/${product.slug}${tableQuery}`}
                  className="home-promo-card"
                  aria-label={`Destaque ${index + 1}: ${product.name}. Ver prato`}
                >
                  {image ? (
                    <img src={image.url} alt={image.alt} className="home-promo-image" fetchPriority={index === 0 ? 'high' : 'auto'} decoding="async" />
                  ) : (
                    <div className="home-promo-image home-promo-fallback" aria-hidden="true" />
                  )}
                  <span className="home-promo-shade" />
                  <div className="home-promo-content">
                    <h2 className="home-promo-title" style={{ whiteSpace: "pre-line" }}>{bannerTitle}</h2>
                    <p className="home-promo-desc">{bannerSubtitle}</p>
                  </div>
                </Link>
              );
            })}
          </div>
        ) : (
          <div className="home-promo-empty">
            <span className="home-section-kicker">{restaurant.name} · {restaurant.subtitle}</span>
            <h1>Destaques da semana</h1>
            <p>O cardápio está sendo preparado. Volte em breve.</p>
          </div>
        )}
        {banners.length > 1 && (
          <div className="home-promo-dots" aria-label={`Destaque ${activeBanner + 1} de ${banners.length}`}>
            {banners.map((product, index) => (
              <button
                key={product.id}
                type="button"
                className={index === activeBanner ? 'active' : ''}
                aria-label={`Ver destaque ${index + 1}`}
                aria-current={index === activeBanner ? 'true' : undefined}
                onClick={() => scrollToBanner(index)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="home-section" aria-labelledby="home-highlights-title">
        <div className="home-section-heading">
          <h2 id="home-highlights-title">Destaques e Entradas</h2>
        </div>
        {highlights.length ? (
          <ul className="home-dish-rail" aria-label="Pratos em destaque. Deslize para os lados.">
            {highlights.map((product) => (
              <li key={product.id}>
                <ProductCard
                  product={product}
                  restaurantSlug={restaurantSlug}
                  tableQuery={tableQuery}
                  likesCount={getProductLikesCount(product.id)}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="home-empty">Este restaurante ainda não publicou produtos disponíveis.</p>
        )}
      </section>

      {otherProducts.length > 0 && (
        <section className="home-section" aria-labelledby="home-more-title">
          <div className="home-section-heading">
            <h2 id="home-more-title">Mais Amados</h2>
          </div>
          <ul className="home-loved-rail" aria-label="Mais amados do cardápio. Deslize para os lados.">
            {otherProducts.map((product) => {
              const image = getCover(product);
              const likesCount = getProductLikesCount(product.id);
              return (
                <li key={product.id}>
                  <Link
                    to={`/${restaurantSlug}/produto/${product.slug}${tableQuery}`}
                    className="home-loved-card"
                    aria-label={`Ver ${product.name}, ${likesCount === 1 ? '1 curtida' : `${likesCount} curtidas`}`}
                  >
                    {image ? <img src={image.url} alt={image.alt} loading="lazy" decoding="async" /> : <span aria-hidden="true" className="home-loved-placeholder" />}
                    <span className="home-loved-rating" aria-hidden="true">
                      <HeartBadgeIcon />
                      {formatLikes(likesCount)}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {(hasReview || hasInfo) && (
        <section className="home-google-review-section" aria-label="Avaliações, Wi-Fi e redes sociais do restaurante">
          <div className="home-google-card !p-0 overflow-hidden bg-white dark:bg-[#1c1815] border border-[#d6c9bb]/85 dark:border-zinc-800 rounded-2xl shadow-sm">
            <div
              className={`grid grid-cols-1 ${
                hasReview && hasInfo
                  ? "md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-zinc-200/80 dark:divide-zinc-800"
                  : ""
              }`}
            >
              {/* Lado Esquerdo: Google / Avaliação */}
              {hasReview && (
                <div className="p-4 sm:p-5 flex flex-col justify-between gap-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="home-google-badge">
                      <svg
                        viewBox="0 0 24 24"
                        width="18"
                        height="18"
                        aria-hidden="true"
                        className="home-google-g-icon"
                      >
                        <path
                          fill="#4285F4"
                          d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                        />
                        <path
                          fill="#34A853"
                          d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                        />
                        <path
                          fill="#FBBC05"
                          d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                        />
                        <path
                          fill="#EA4335"
                          d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                        />
                      </svg>
                      <span>Google</span>
                    </div>
                    <span className="home-google-verified-tag">Avaliação oficial</span>
                  </div>

                  <div className="space-y-1.5 py-0.5">
                    <div className="flex items-center gap-1.5" aria-hidden="true">
                      <div className="inline-flex items-center gap-0.5 text-amber-500 text-base leading-none">
                        <span>★</span>
                        <span>★</span>
                        <span>★</span>
                        <span>★</span>
                        <span>★</span>
                      </div>
                      <span className="text-[11px] text-zinc-500 dark:text-zinc-400 font-medium">
                        Experiência dos clientes
                      </span>
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 leading-tight">
                        Avalie este restaurante
                      </h3>
                      <p className="text-[11.5px] text-zinc-500 dark:text-zinc-400 leading-snug">
                        Sua avaliação será publicada no Google
                      </p>
                    </div>
                  </div>

                  <div className="flex justify-end pt-1">
                    <a
                      href={restaurant.googleReviewUrl!}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="home-google-action-btn"
                      aria-label={`Avaliar ${restaurant.name} no Google (abre em nova aba)`}
                    >
                      <span>Avaliar</span>
                      <span className="home-google-action-arrow" aria-hidden="true">↗</span>
                    </a>
                  </div>
                </div>
              )}

              {/* Lado Direito: Wi-Fi da Casa e Redes Sociais */}
              {hasInfo && (
                <div className="p-4 sm:p-5 flex flex-col justify-between gap-3.5">
                  {/* Cabeçalho Wi-Fi / Conectividade */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="inline-flex items-center gap-2 font-bold text-[13.5px] text-zinc-900 dark:text-zinc-100">
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="text-zinc-700 dark:text-zinc-300 shrink-0"
                        aria-hidden="true"
                      >
                        <path d="M5 12.55a11 11 0 0 1 14.08 0" />
                        <path d="M1.42 9a16 16 0 0 1 21.16 0" />
                        <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
                        <line x1="12" y1="20" x2="12.01" y2="20" />
                      </svg>
                      <span>{hasWifi ? "Wi-Fi da Casa" : "Canais de Contato"}</span>
                    </div>
                    <span className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800 px-2 py-0.5 rounded-full whitespace-nowrap">
                      {hasWifi ? "Conexão gratuita" : "Oficial"}
                    </span>
                  </div>

                  {/* Bloco de Wi-Fi (SSID e Senha) */}
                  {hasWifi && (
                    <div className="space-y-2 py-0.5">
                      <div className="flex items-center justify-between text-xs gap-2">
                        <span className="text-[11px] text-zinc-500 dark:text-zinc-400 font-medium">Nome da rede:</span>
                        <span className="font-bold text-zinc-900 dark:text-zinc-100 truncate">{wifiSsid}</span>
                      </div>

                      {wifiPassword ? (
                        <div className="flex items-center justify-between gap-2 bg-[#FAF6F2] dark:bg-zinc-800/80 rounded-xl px-3 py-1.5 border border-[#E8DCCB] dark:border-zinc-700">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="text-[10px] uppercase font-bold text-zinc-400 dark:text-zinc-500 shrink-0">Senha:</span>
                            <span className="text-xs font-mono font-bold text-zinc-900 dark:text-zinc-100 truncate">{wifiPassword}</span>
                          </div>
                          <button
                            type="button"
                            onClick={handleCopyWifi}
                            className="shrink-0 text-[11.5px] font-semibold px-2.5 py-1 rounded-lg bg-white dark:bg-zinc-700 border border-zinc-200 dark:border-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-600 text-zinc-800 dark:text-zinc-200 flex items-center gap-1 transition-all cursor-pointer shadow-2xs active:scale-95"
                            aria-label="Copiar senha do Wi-Fi"
                          >
                            {copiedWifi ? (
                              <>
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-600 dark:text-emerald-400">
                                  <polyline points="20 6 9 17 4 12" />
                                </svg>
                                <span className="text-emerald-600 dark:text-emerald-400 font-bold">Copiada!</span>
                              </>
                            ) : (
                              <>
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                                  <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                                </svg>
                                <span>Copiar senha</span>
                              </>
                            )}
                          </button>
                        </div>
                      ) : (
                        <div className="text-[11px] text-zinc-500 dark:text-zinc-400 italic">Rede aberta (sem senha).</div>
                      )}
                    </div>
                  )}

                  {/* Ícones de Redes Sociais */}
                  {hasSocials && (
                    <div className="flex items-center justify-between gap-2 pt-1 border-t border-zinc-100 dark:border-zinc-800">
                      <span className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400">
                        Redes sociais:
                      </span>
                      <div className="flex items-center gap-2">
                        {instagramUrl && (
                          <a
                            href={instagramUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={`Instagram de ${restaurant.name} (abre em nova aba)`}
                            className="w-8 h-8 rounded-full bg-zinc-100 dark:bg-zinc-800 hover:bg-rose-50 dark:hover:bg-rose-950/40 text-zinc-700 dark:text-zinc-300 hover:text-rose-600 border border-zinc-200/80 dark:border-zinc-700 flex items-center justify-center transition-all shadow-2xs hover:scale-105"
                          >
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <rect width="20" height="20" x="2" y="2" rx="5" ry="5" />
                              <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
                              <line x1="17.5" y1="6.5" x2="17.51" y2="6.5" />
                            </svg>
                          </a>
                        )}

                        {whatsappUrl && (
                          <a
                            href={whatsappUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={`WhatsApp de ${restaurant.name} (abre em nova aba)`}
                            className="w-8 h-8 rounded-full bg-zinc-100 dark:bg-zinc-800 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 text-zinc-700 dark:text-zinc-300 hover:text-emerald-600 border border-zinc-200/80 dark:border-zinc-700 flex items-center justify-center transition-all shadow-2xs hover:scale-105"
                          >
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
                            </svg>
                          </a>
                        )}

                        {facebookUrl && (
                          <a
                            href={facebookUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={`Facebook ou Site de ${restaurant.name} (abre em nova aba)`}
                            className="w-8 h-8 rounded-full bg-zinc-100 dark:bg-zinc-800 hover:bg-blue-50 dark:hover:bg-blue-950/40 text-zinc-700 dark:text-zinc-300 hover:text-blue-600 border border-zinc-200/80 dark:border-zinc-700 flex items-center justify-center transition-all shadow-2xs hover:scale-105"
                          >
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z" />
                            </svg>
                          </a>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      <nav className="home-bottom-nav" aria-label="Ações da mesa">
        <Link to={`/${restaurantSlug}${tableQuery}`} className="active" aria-current="page">
          <HomeIcon name="home" /><span>Início</span>
        </Link>
        <button type="button" onClick={() => setActiveAction('waiter')}>
          <HomeIcon name="waiter" /><span>Chamar Garçom</span>
        </button>
        <Link to={`/${restaurantSlug}/comanda${tableQuery}`}>
          <HomeIcon name="bill" /><span>Comanda</span>
        </Link>
      </nav>

      <ServiceActionPopup
        isOpen={!!activeAction}
        mode={activeAction}
        onClose={() => setActiveAction(null)}
      />
    </div>
  );
}

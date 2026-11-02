export const config = {
  runtime: 'edge',
};
export const runtime = 'edge';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export default async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);

  // 1. Extração robusta: query params (pela destination do rewrite) OU pathname original OU headers da Vercel
  let restaurantSlug = (url.searchParams.get('restaurantSlug') || '').trim();
  let productSlug = (url.searchParams.get('productSlug') || '').trim();

  if (!restaurantSlug || !productSlug) {
    const pathMatch = url.pathname.match(/^\/([^/]+)\/produto\/([^/?#]+)/);
    if (pathMatch) {
      restaurantSlug = decodeURIComponent(pathMatch[1]).trim();
      productSlug = decodeURIComponent(pathMatch[2]).trim();
    }
  }

  if (!restaurantSlug || !productSlug) {
    const headerPath =
      request.headers.get('x-matched-path') ||
      request.headers.get('x-invoke-path') ||
      request.headers.get('x-rewrite-url') ||
      '';
    const headerMatch = headerPath.match(/^\/([^/]+)\/produto\/([^/?#]+)/);
    if (headerMatch) {
      restaurantSlug = decodeURIComponent(headerMatch[1]).trim();
      productSlug = decodeURIComponent(headerMatch[2]).trim();
    }
  }

  const host =
    request.headers.get('x-forwarded-host') ||
    request.headers.get('host') ||
    'elozi.vercel.app';
  const proto = request.headers.get('x-forwarded-proto') || 'https';
  const origin = `${proto}://${host}`;
  const canonicalUrl = restaurantSlug && productSlug
    ? `${origin}/${encodeURIComponent(restaurantSlug)}/produto/${encodeURIComponent(productSlug)}`
    : origin;

  // Usa exclusivamente variáveis de ambiente configuradas na Vercel
  const rawSupabaseUrl = (process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '').trim();
  const supabaseKey = (
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    ''
  ).trim();

  let isValidSupabaseUrl = false;
  if (rawSupabaseUrl) {
    try {
      const parsed = new URL(rawSupabaseUrl);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        isValidSupabaseUrl = Boolean(parsed.hostname);
      }
    } catch {
      isValidSupabaseUrl = false;
    }
  }

  const isConfigured = isValidSupabaseUrl && Boolean(supabaseKey);

  let productName = 'Prato no Cardápio';
  let restaurantName = 'Elozi';
  let description = 'Confira os detalhes e faça seu pedido pelo cardápio digital.';
  let imageUrl = `${origin}/landing/preview-cardapio.png`;

  // Se configuração estiver ausente, inválida ou incompleta, não faz chamadas externas e usa fallback
  if (restaurantSlug && productSlug && isConfigured) {
    const supabaseUrl = rawSupabaseUrl;
    try {
      const [restRes, menuRes] = await Promise.all([
        fetch(`${supabaseUrl}/rest/v1/rpc/get_public_restaurant`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`,
          },
          body: JSON.stringify({ p_slug: restaurantSlug }),
        }),
        fetch(`${supabaseUrl}/rest/v1/rpc/get_public_menu`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`,
          },
          body: JSON.stringify({ p_restaurant_slug: restaurantSlug }),
        }),
      ]);

      if (restRes.ok) {
        const restData = (await restRes.json()) as { name?: string };
        if (restData?.name) {
          restaurantName = restData.name.trim();
        }
      }

      if (menuRes.ok) {
        const menuData = (await menuRes.json()) as {
          products?: Array<{
            slug: string;
            name: string;
            shortDescription?: string;
            description?: string;
            priceInCents?: number;
            coverImageId?: string;
            images?: Array<{ id: string; url: string; alt?: string }>;
          }>;
        };

        const product = menuData?.products?.find((p) => p.slug === productSlug);
        if (product) {
          productName = product.name.trim();
          const rawDesc =
            product.shortDescription?.trim() ||
            product.description?.trim() ||
            'Confira nosso cardápio digital.';

          let priceText = '';
          if (typeof product.priceInCents === 'number' && product.priceInCents > 0) {
            priceText = ` • R$ ${(product.priceInCents / 100).toFixed(2).replace('.', ',')}`;
          }
          description = `${rawDesc}${priceText}`;

          if (product.images && product.images.length > 0) {
            const cover =
              product.images.find((img) => img.id === product.coverImageId) ||
              product.images[0];
            if (cover?.url) {
              const urlVal = cover.url.trim();
              if (urlVal.startsWith('http://') || urlVal.startsWith('https://')) {
                imageUrl = urlVal;
              } else {
                imageUrl = `${origin}${urlVal.startsWith('/') ? '' : '/'}${urlVal}`;
              }
            }
          }
        }
      }
    } catch {
      // Mantém fallbacks caso ocorra indisponibilidade
    }
  }

  const ogTitle = `${productName} | ${restaurantName}`;

  const html = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(ogTitle)}</title>
  <meta name="description" content="${escapeHtml(description)}" />
  <link rel="icon" type="image/png" href="/icons/favicon.png" />
  <link rel="apple-touch-icon" href="/icons/favicon.png" />

  <!-- Open Graph / WhatsApp / Facebook -->
  <meta property="og:type" content="website" />
  <meta property="og:url" content="${escapeHtml(canonicalUrl)}" />
  <meta property="og:title" content="${escapeHtml(ogTitle)}" />
  <meta property="og:description" content="${escapeHtml(description)}" />
  <meta property="og:image" content="${escapeHtml(imageUrl)}" />
  <meta property="og:image:secure_url" content="${escapeHtml(imageUrl)}" />
  <meta property="og:image:alt" content="${escapeHtml(productName)}" />
  <meta property="og:site_name" content="${escapeHtml(restaurantName)}" />
  <meta property="og:locale" content="pt_BR" />

  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:url" content="${escapeHtml(canonicalUrl)}" />
  <meta name="twitter:title" content="${escapeHtml(ogTitle)}" />
  <meta name="twitter:description" content="${escapeHtml(description)}" />
  <meta name="twitter:image" content="${escapeHtml(imageUrl)}" />
  <meta name="twitter:image:alt" content="${escapeHtml(productName)}" />

  <script>
    if (typeof window !== 'undefined' && !/(bot|crawler|spider|whatsapp|facebookexternalhit|facebot|twitterbot|telegrambot|slackbot|discordbot|applebot|linkedin|skypeuripreview)/i.test(navigator.userAgent)) {
      window.location.replace("${escapeHtml(canonicalUrl)}");
    }
  </script>
</head>
<body>
  <main style="font-family: system-ui, -apple-system, sans-serif; max-width: 600px; margin: 40px auto; padding: 20px; text-align: center; color: #1c1917;">
    <img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(productName)}" style="width: 100%; max-height: 380px; object-fit: cover; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.1);" />
    <h1 style="font-size: 1.5rem; margin: 18px 0 8px;">${escapeHtml(productName)}</h1>
    <p style="font-size: 1rem; color: #57534e; margin: 0 0 20px;">${escapeHtml(description)}</p>
    <a href="${escapeHtml(canonicalUrl)}" style="display: inline-block; padding: 12px 28px; background: #ea580c; color: #ffffff; text-decoration: none; border-radius: 999px; font-weight: bold; font-size: 0.95rem;">
      Abrir cardápio do ${escapeHtml(restaurantName)}
    </a>
  </main>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
    },
  });
}

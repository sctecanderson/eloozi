import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/product-preview.ts';
import fs from 'node:fs';
import path from 'node:path';

test('Product Open Graph Preview Handler', async (t) => {
  const origFetch = globalThis.fetch;
  const origEnvUrl = process.env.VITE_SUPABASE_URL;
  const origEnvKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

  t.beforeEach(() => {
    process.env.VITE_SUPABASE_URL = 'https://mock.supabase.co';
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY = 'mock-key';
  });

  t.afterEach(() => {
    globalThis.fetch = origFetch;
    process.env.VITE_SUPABASE_URL = origEnvUrl;
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY = origEnvKey;
  });

  // Mock catalog with distinct products from different restaurants
  function setupMockFetch() {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : {};

      if (urlStr.includes('/rpc/get_public_restaurant')) {
        if (body.p_slug === 'noma') {
          return new Response(JSON.stringify({ name: 'NOMA' }), { status: 200 });
        }
        if (body.p_slug === 'brasa') {
          return new Response(JSON.stringify({ name: 'Brasa Burger' }), { status: 200 });
        }
      }

      if (urlStr.includes('/rpc/get_public_menu')) {
        if (body.p_restaurant_slug === 'noma') {
          return new Response(
            JSON.stringify({
              products: [
                {
                  slug: 'risoto-de-cogumelos',
                  name: 'Risoto de cogumelos',
                  shortDescription: 'Arroz arbóreo, cogumelos e parmesão.',
                  priceInCents: 4000,
                  coverImageId: 'capa-1',
                  images: [{ id: 'capa-1', url: '/images/noma/risoto-capa.png' }]
                },
                {
                  slug: 'burguer-da-casa',
                  name: 'Búrguer da casa',
                  shortDescription: 'Brioche, queijo e molho da casa.',
                  priceInCents: 4200,
                  coverImageId: 'capa-2',
                  images: [{ id: 'capa-2', url: '/images/noma/burguer-capa.png' }]
                }
              ]
            }),
            { status: 200 }
          );
        }

        if (body.p_restaurant_slug === 'brasa') {
          return new Response(
            JSON.stringify({
              products: [
                {
                  slug: 'brasa-duplo',
                  name: 'Brasa Duplo',
                  shortDescription: 'Duas carnes, cheddar e molho da casa.',
                  priceInCents: 4200,
                  coverImageId: 'capa-brasa-1',
                  images: [{ id: 'capa-brasa-1', url: 'https://cdn.example.com/brasa-duplo.webp' }]
                }
              ]
            }),
            { status: 200 }
          );
        }
      }

      return new Response('Not found', { status: 404 });
    };
  }

  await t.test('Produto 1: Risoto de cogumelos no NOMA (via query params do rewrite)', async () => {
    setupMockFetch();
    const req = new Request('https://elozi.vercel.app/api/product-preview?restaurantSlug=noma&productSlug=risoto-de-cogumelos', {
      headers: { host: 'elozi.vercel.app', 'x-forwarded-proto': 'https' },
    });

    const res = await handler(req);
    assert.equal(res.status, 200);
    const html = await res.text();

    assert.match(html, /<meta property="og:title" content="Risoto de cogumelos \| NOMA"/);
    assert.match(html, /<meta property="og:description" content="Arroz arbóreo, cogumelos e parmesão\. • R\$ 40,00"/);
    assert.match(html, /<meta property="og:url" content="https:\/\/elozi\.vercel\.app\/noma\/produto\/risoto-de-cogumelos"/);
    assert.match(html, /<meta property="og:image" content="https:\/\/elozi\.vercel\.app\/images\/noma\/risoto-capa\.png"/);
    assert.match(html, /<meta property="og:site_name" content="NOMA"/);
  });

  await t.test('Produto 2: Búrguer da casa no NOMA (via pathname original preservado)', async () => {
    setupMockFetch();
    const req = new Request('https://elozi.vercel.app/noma/produto/burguer-da-casa', {
      headers: { host: 'elozi.vercel.app', 'x-forwarded-proto': 'https' },
    });

    const res = await handler(req);
    assert.equal(res.status, 200);
    const html = await res.text();

    assert.match(html, /<meta property="og:title" content="Búrguer da casa \| NOMA"/);
    assert.match(html, /<meta property="og:description" content="Brioche, queijo e molho da casa\. • R\$ 42,00"/);
    assert.match(html, /<meta property="og:url" content="https:\/\/elozi\.vercel\.app\/noma\/produto\/burguer-da-casa"/);
    assert.match(html, /<meta property="og:image" content="https:\/\/elozi\.vercel\.app\/images\/noma\/burguer-capa\.png"/);
    assert.match(html, /<meta property="og:site_name" content="NOMA"/);
  });

  await t.test('Produto 3: Brasa Duplo no restaurante Brasa Burger (via header x-matched-path da Vercel)', async () => {
    setupMockFetch();
    const req = new Request('https://elozi.vercel.app/api/product-preview', {
      headers: {
        host: 'elozi.vercel.app',
        'x-forwarded-proto': 'https',
        'x-matched-path': '/brasa/produto/brasa-duplo',
      },
    });

    const res = await handler(req);
    assert.equal(res.status, 200);
    const html = await res.text();

    assert.match(html, /<meta property="og:title" content="Brasa Duplo \| Brasa Burger"/);
    assert.match(html, /<meta property="og:description" content="Duas carnes, cheddar e molho da casa\. • R\$ 42,00"/);
    assert.match(html, /<meta property="og:url" content="https:\/\/elozi\.vercel\.app\/brasa\/produto\/brasa-duplo"/);
    assert.match(html, /<meta property="og:image" content="https:\/\/cdn\.example\.com\/brasa-duplo\.webp"/);
    assert.match(html, /<meta property="og:site_name" content="Brasa Burger"/);
  });

  await t.test('Fallback seguro e sem dados privados quando produto não existe', async () => {
    setupMockFetch();
    const req = new Request('https://elozi.vercel.app/api/product-preview?restaurantSlug=noma&productSlug=produto-inexistente', {
      headers: { host: 'elozi.vercel.app', 'x-forwarded-proto': 'https' },
    });

    const res = await handler(req);
    assert.equal(res.status, 200);

    const html = await res.text();
    assert.match(html, /<title>Prato no Cardápio \| NOMA<\/title>/);
    assert.match(html, /preview-cardapio\.png/);
    assert.doesNotMatch(html, /mock-key/);
    assert.doesNotMatch(html, /service_role/);
  });

  await t.test('Sem variáveis de ambiente: não chama fetch e retorna fallback genérico seguro', async () => {
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response('Not found', { status: 404 });
    };

    delete process.env.VITE_SUPABASE_URL;
    delete process.env.SUPABASE_URL;
    delete process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
    delete process.env.SUPABASE_ANON_KEY;

    const req = new Request('https://elozi.vercel.app/api/product-preview?restaurantSlug=noma&productSlug=risoto-de-cogumelos', {
      headers: { host: 'elozi.vercel.app', 'x-forwarded-proto': 'https' },
    });

    const res = await handler(req);
    assert.equal(res.status, 200);
    assert.equal(fetchCalled, false, 'Fetch não deve ser chamado quando variáveis de ambiente estiverem ausentes');

    const html = await res.text();
    assert.match(html, /<meta property="og:title" content="Prato no Cardápio \| Elozi"/);
    assert.match(html, /preview-cardapio\.png/);
  });

  await t.test('Variável de ambiente com URL malformatada: não chama fetch e retorna fallback genérico seguro', async () => {
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response('Not found', { status: 404 });
    };

    process.env.VITE_SUPABASE_URL = 'http-nao-valido';
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY = 'mock-key';

    const req = new Request('https://elozi.vercel.app/api/product-preview?restaurantSlug=noma&productSlug=risoto-de-cogumelos', {
      headers: { host: 'elozi.vercel.app', 'x-forwarded-proto': 'https' },
    });

    const res = await handler(req);
    assert.equal(res.status, 200);
    assert.equal(fetchCalled, false, 'Fetch não deve ser chamado quando a URL for inválida');

    const html = await res.text();
    assert.match(html, /<meta property="og:title" content="Prato no Cardápio \| Elozi"/);
    assert.match(html, /preview-cardapio\.png/);
  });

  await t.test('index.html contém referências canônicas ao favicon e apple-touch-icon', () => {
    const indexPath = path.resolve('index.html');
    const indexHtml = fs.readFileSync(indexPath, 'utf8');

    assert.match(indexHtml, /<link rel="icon" type="image\/png" href="\/icons\/favicon\.png"\s*\/>/);
    assert.match(indexHtml, /<link rel="apple-touch-icon" href="\/icons\/favicon\.png"\s*\/>/);
  });
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const defaultPglitePath = path.resolve(
  import.meta.dirname,
  '../.tools/pglite/node_modules/@electric-sql/pglite/dist/index.js',
);
const PGLITE_MODULE_PATH = process.env.PGLITE_MODULE || defaultPglitePath;
const { PGlite } = await import(`file:///${PGLITE_MODULE_PATH.replace(/\\/g, '/')}`);

console.log('--- Iniciando Banco PostgreSQL Local Descartável (PGlite) ---');
const db = new PGlite();

await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role bypassrls;
  create publication supabase_realtime;
  create schema auth;
  create schema storage;
  create schema extensions;

  create table auth.users (
    id uuid primary key,
    email text,
    email_confirmed_at timestamptz default now(),
    is_anonymous boolean default false
  );

  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  $$;

  create function auth.jwt() returns jsonb language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
  $$;

  create function extensions.gen_random_bytes(integer) returns bytea language sql as $$
    select decode(repeat('00', $1), 'hex');
  $$;

  create table storage.buckets (
    id text primary key,
    name text,
    public boolean,
    file_size_limit bigint,
    allowed_mime_types text[]
  );

  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text,
    name text,
    metadata jsonb,
    created_at timestamptz default now(),
    updated_at timestamptz default now(),
    unique(bucket_id, name)
  );

  alter table storage.objects enable row level security;
`);

const migrationsDir = path.resolve(import.meta.dirname, '../supabase/migrations');
const migrationFiles = fs
  .readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

console.log(`Aplicando ${migrationFiles.length} migrations em banco vazio...`);

for (const file of migrationFiles) {
  if (file === '20261008141500_create_table_tab_consumption.sql') {
    const seedSql = fs.readFileSync(path.join(migrationsDir, '../seeds/demo_restaurants.sql'), 'utf-8');
    await db.exec(seedSql);
  }
  const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
  try {
    await db.exec(sql);
  } catch (err) {
    console.error(`ERRO aplicando migration: ${file}`);
    throw err;
  }
}

console.log(`PASS: Todas as ${migrationFiles.length} migrations (incluindo ${migrationFiles.at(-1)}) aplicadas sem erros.`);

const q = async (sql, params = []) => (await db.query(sql, params)).rows;

async function runAs(userId, role, fn) {
  await db.exec('begin;');
  try {
    if (role === 'anon' || !userId) {
      await db.exec(`select set_config('request.jwt.claim.sub', '', true);`);
      await db.exec(`select set_config('request.jwt.claim.role', 'anon', true);`);
      await db.exec(`select set_config('request.jwt.claims', '{"role":"anon"}', true);`);
      await db.exec('set local role anon;');
    } else {
      await db.exec(`select set_config('request.jwt.claim.sub', '${userId}', true);`);
      await db.exec(`select set_config('request.jwt.claim.role', '${role}', true);`);
      await db.exec(
        `select set_config('request.jwt.claims', '${JSON.stringify({ sub: userId, role })}', true);`,
      );
      await db.exec(`set local role ${role};`);
    }
    const res = await fn();
    await db.exec('commit;');
    return res;
  } catch (err) {
    await db.exec('rollback;');
    throw err;
  }
}

// ----------------------------------------------------------------------------
// 1. Verificar ausencia das colunas inexistentes na definicao final no catalogo do PostgreSQL
// ----------------------------------------------------------------------------
console.log('\n--- 1. Verificando definicao final de public.get_restaurant_billing_summary(uuid) em pg_proc ---');
const [procRow] = await q(`
  select pg_get_functiondef(p.oid) as func_def, p.prosecdef as security_definer, p.proconfig as config
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'get_restaurant_billing_summary';
`);

assert.ok(procRow, 'Função get_restaurant_billing_summary deve existir no schema public');
assert.equal(procRow.security_definer, true, 'Deve manter SECURITY DEFINER');
assert.ok(
  Array.isArray(procRow.config) && procRow.config.includes('search_path=""'),
  `Deve manter search_path seguro (atual: ${JSON.stringify(procRow.config)})`,
);

const forbiddenTokens = ['currency', 'due_date', 'pix_qr_code,', 'pix_copy_paste', 'invoice_url'];
for (const token of forbiddenTokens) {
  assert.ok(
    !procRow.func_def.includes(token),
    `A definição final NÃO pode conter referência à coluna inexistente: ${token}`,
  );
}

const requiredInvoiceCols = [
  'pix_qr_code_payload',
  'pix_expires_at',
  'card_brand',
  'card_last4',
  'external_reference',
];
for (const col of requiredInvoiceCols) {
  assert.ok(
    procRow.func_def.includes(col),
    `A definição final DEVE conter a coluna real exigida pelo frontend: ${col}`,
  );
}
console.log('PASS: Definição em pg_proc livre de colunas inexistentes e com todas as colunas reais, SECURITY DEFINER e search_path seguro.');

// ----------------------------------------------------------------------------
// 2. Fixtures locais isoladas
// ----------------------------------------------------------------------------
const userAdminRestA = '11111111-1111-4111-8111-111111111111';
const userWaiterRestA = '22222222-2222-4222-8222-222222222222';
const userInactiveAdminA = '33333333-3333-4333-8333-333333333333';
const userAdminRestB = '44444444-4444-4444-8444-444444444444';
const userUnrelated = '55555555-5555-4555-8555-555555555555';
const userPlatformAdmin = '66666666-6666-4666-8666-666666666666';

await db.exec(`
  insert into auth.users (id, email) values
    ('${userAdminRestA}', 'admin.a@teste.local'),
    ('${userWaiterRestA}', 'garcom.a@teste.local'),
    ('${userInactiveAdminA}', 'inativo.a@teste.local'),
    ('${userAdminRestB}', 'admin.b@teste.local'),
    ('${userUnrelated}', 'avulso@teste.local'),
    ('${userPlatformAdmin}', 'superadmin@teste.local');
`);

const [restA] = await q(`
  insert into public.restaurants (
    slug, name, subscription_plan, max_tables, monthly_price_cents,
    billing_cycle_days, subscription_is_trial, subscription_expires_at, active
  )
  values (
    'rest-billing-test-a', 'Restaurante Teste A', 'pro', 25, 14900,
    7, true, now() + interval '5 days', true
  )
  returning id;
`);

const [restB] = await q(`
  insert into public.restaurants (
    slug, name, subscription_plan, max_tables, monthly_price_cents,
    billing_cycle_days, subscription_is_trial, subscription_expires_at, active
  )
  values (
    'rest-billing-test-b', 'Restaurante Teste B', 'basic', 10, 9900,
    30, false, now() + interval '20 days', true
  )
  returning id;
`);

await db.exec(`
  insert into public.restaurant_members (restaurant_id, user_id, role, active) values
    ('${restA.id}', '${userAdminRestA}', 'admin', true),
    ('${restA.id}', '${userWaiterRestA}', 'waiter', true),
    ('${restA.id}', '${userInactiveAdminA}', 'admin', false),
    ('${restB.id}', '${userAdminRestB}', 'admin', true);

  insert into public.platform_admins (user_id, active)
  values ('${userPlatformAdmin}', true);

  insert into public.restaurant_tables (restaurant_id, table_number, label, active) values
    ('${restA.id}', 1, 'Mesa 01', true),
    ('${restA.id}', 2, 'Mesa 02', true);
`);

// ----------------------------------------------------------------------------
// 3. Cenário A: Admin autorizado SEM faturas
// ----------------------------------------------------------------------------
console.log('\n--- 2a. Chamada real da RPC por admin autorizado SEM faturas ---');
const summaryEmpty = await runAs(userAdminRestA, 'authenticated', async () => {
  const [row] = await q(`select public.get_restaurant_billing_summary($1::uuid) as summary;`, [restA.id]);
  return row.summary;
});

assert.ok(summaryEmpty, 'Resumo deve retornar objeto JSON');
assert.deepEqual(
  Object.keys(summaryEmpty).sort(),
  ['catalog', 'invoices', 'payment_methods', 'restaurant', 'usage'].sort(),
  'Chaves de topo do JSON devem corresponder exatamente a RestaurantBillingSummary',
);
assert.equal(summaryEmpty.restaurant.id, restA.id);
assert.equal(summaryEmpty.restaurant.slug, 'rest-billing-test-a');
assert.equal(summaryEmpty.restaurant.subscription_plan, 'pro');
assert.equal(summaryEmpty.restaurant.subscription_is_trial, true);
assert.equal(summaryEmpty.restaurant.billing_status, 'active');
assert.equal(summaryEmpty.usage.tables_count, 2);
assert.ok(Array.isArray(summaryEmpty.invoices) && summaryEmpty.invoices.length === 0, 'Sem faturas deve retornar []');
assert.ok(Array.isArray(summaryEmpty.payment_methods) && summaryEmpty.payment_methods.length === 0);
assert.ok(summaryEmpty.catalog.basic && summaryEmpty.catalog.pro && summaryEmpty.catalog.premium);
console.log('PASS: Cenário sem faturas retornou contrato JSON válido e invoices = [].');

// ----------------------------------------------------------------------------
// 4. Cenário B: Admin autorizado COM fatura Pix
// ----------------------------------------------------------------------------
console.log('\n--- 2b. Chamada real da RPC por admin autorizado COM fatura Pix ---');
const pixExpires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
const [pixInvoice] = await q(
  `insert into public.subscription_invoices (
    restaurant_id, plan_id, billing_cycle, payment_method, amount_cents,
    status, pix_qr_code_payload, pix_expires_at, card_brand, card_last4,
    external_reference, created_by, created_at
  ) values (
    $1, 'pro', 'monthly', 'pix', 14900,
    'pending', '00020126580014BR.GOV.BCB.PIX0136teste-pix-payload', $2, null, null,
    'pay_asaas_pix_001', $3, now() - interval '10 minutes'
  ) returning id;`,
  [restA.id, pixExpires, userAdminRestA],
);

const summaryWithPix = await runAs(userAdminRestA, 'authenticated', async () => {
  const [row] = await q(`select public.get_restaurant_billing_summary($1::uuid) as summary;`, [restA.id]);
  return row.summary;
});

assert.equal(summaryWithPix.invoices.length, 1, 'Deve retornar 1 fatura Pix');
const returnedPixInv = summaryWithPix.invoices[0];
const expectedInvoiceKeys = [
  'id',
  'plan_id',
  'billing_cycle',
  'amount_cents',
  'payment_method',
  'status',
  'pix_qr_code_payload',
  'pix_expires_at',
  'card_brand',
  'card_last4',
  'external_reference',
  'paid_at',
  'created_at',
].sort();

assert.deepEqual(
  Object.keys(returnedPixInv).sort(),
  expectedInvoiceKeys,
  'Chaves da fatura devem corresponder exatamente à interface SubscriptionInvoiceItem do billingService.ts',
);
assert.equal(returnedPixInv.id, pixInvoice.id);
assert.equal(returnedPixInv.payment_method, 'pix');
assert.equal(returnedPixInv.status, 'pending');
assert.equal(returnedPixInv.amount_cents, 14900);
assert.equal(returnedPixInv.pix_qr_code_payload, '00020126580014BR.GOV.BCB.PIX0136teste-pix-payload');
assert.ok(returnedPixInv.pix_expires_at, 'pix_expires_at deve estar preenchido');
assert.equal(returnedPixInv.external_reference, 'pay_asaas_pix_001');
assert.equal(returnedPixInv.card_brand, null);
assert.equal(returnedPixInv.card_last4, null);
console.log('PASS: Fatura Pix retornada com todas as colunas reais exigidas pelo frontend.');

// ----------------------------------------------------------------------------
// 5. Cenário C: Admin autorizado COM fatura de Cartão (e ordenação desc)
// ----------------------------------------------------------------------------
console.log('\n--- 2c. Chamada real da RPC por admin autorizado COM fatura de Cartão ---');
const [cardInvoice] = await q(
  `insert into public.subscription_invoices (
    restaurant_id, plan_id, billing_cycle, payment_method, amount_cents,
    status, pix_qr_code_payload, pix_expires_at, card_brand, card_last4,
    external_reference, paid_at, created_by, created_at
  ) values (
    $1, 'premium', 'yearly', 'credit_card', 199000,
    'paid', null, null, 'mastercard', '4444',
    'pay_asaas_card_002', now(), $2, now()
  ) returning id;`,
  [restA.id, userAdminRestA],
);

const summaryWithCard = await runAs(userAdminRestA, 'authenticated', async () => {
  const [row] = await q(`select public.get_restaurant_billing_summary($1::uuid) as summary;`, [restA.id]);
  return row.summary;
});

assert.equal(summaryWithCard.invoices.length, 2, 'Deve retornar as 2 faturas (Cartão mais recente + Pix)');
const returnedCardInv = summaryWithCard.invoices[0];
assert.deepEqual(Object.keys(returnedCardInv).sort(), expectedInvoiceKeys);
assert.equal(returnedCardInv.id, cardInvoice.id, 'Ordenação created_at DESC deve trazer a fatura mais recente primeiro');
assert.equal(returnedCardInv.payment_method, 'credit_card');
assert.equal(returnedCardInv.status, 'paid');
assert.equal(returnedCardInv.card_brand, 'mastercard');
assert.equal(returnedCardInv.card_last4, '4444');
assert.equal(returnedCardInv.external_reference, 'pay_asaas_card_002');
assert.ok(returnedCardInv.paid_at, 'paid_at deve estar preenchido na fatura paga');

// Também verificar acesso pelo Platform Admin (SuperAdmin)
const summaryByPlatformAdmin = await runAs(userPlatformAdmin, 'authenticated', async () => {
  const [row] = await q(`select public.get_restaurant_billing_summary($1::uuid) as summary;`, [restA.id]);
  return row.summary;
});
assert.equal(summaryByPlatformAdmin.invoices.length, 2, 'Platform Admin ativo deve conseguir consultar o resumo');

// Verificar limite de histórico (limit 24)
await db.exec(`
  insert into public.subscription_invoices (
    restaurant_id, plan_id, billing_cycle, payment_method, amount_cents,
    status, external_reference, created_by, created_at
  )
  select
    '${restA.id}', 'basic', 'monthly', 'pix', 9900,
    'expired', 'pay_bulk_' || g, '${userAdminRestA}', now() - (g || ' hours')::interval
  from generate_series(1, 28) as g;
`);
const summaryWithLimit = await runAs(userAdminRestA, 'authenticated', async () => {
  const [row] = await q(`select public.get_restaurant_billing_summary($1::uuid) as summary;`, [restA.id]);
  return row.summary;
});
assert.equal(summaryWithLimit.invoices.length, 24, 'Histórico de faturas deve respeitar o limite de 24 registros');
assert.equal(summaryWithLimit.invoices[0].id, cardInvoice.id, 'A fatura mais recente deve continuar no topo (created_at DESC)');
console.log('PASS: Fatura de Cartão, ordenação DESC, limite de 24 faturas e acesso de Platform Admin validados.');

// ----------------------------------------------------------------------------
// 6. Recusa para usuários sem autorização e admin de outro restaurante
// ----------------------------------------------------------------------------
console.log('\n--- 3. Verificando recusa para usuários não autorizados e admin de outro restaurante ---');

// 6a. Papel anon (GRANT revogado)
await assert.rejects(
  async () => {
    await runAs(null, 'anon', async () => {
      await q(`select public.get_restaurant_billing_summary($1::uuid);`, [restA.id]);
    });
  },
  (err) => err.message.includes('permission denied'),
  'Papel anon não deve ter permissão EXECUTE na função',
);

// 6b. Usuário autenticado sem vínculo com o restaurante
await assert.rejects(
  async () => {
    await runAs(userUnrelated, 'authenticated', async () => {
      await q(`select public.get_restaurant_billing_summary($1::uuid);`, [restA.id]);
    });
  },
  (err) => err.message.includes('Apenas administradores do restaurante ou da plataforma'),
  'Usuário sem vínculo deve ser recusado com 42501',
);

// 6c. Garçom (waiter) do próprio restaurante A
await assert.rejects(
  async () => {
    await runAs(userWaiterRestA, 'authenticated', async () => {
      await q(`select public.get_restaurant_billing_summary($1::uuid);`, [restA.id]);
    });
  },
  (err) => err.message.includes('Apenas administradores do restaurante ou da plataforma'),
  'Garçom do restaurante deve ser recusado com 42501',
);

// 6d. Admin inativo do restaurante A
await assert.rejects(
  async () => {
    await runAs(userInactiveAdminA, 'authenticated', async () => {
      await q(`select public.get_restaurant_billing_summary($1::uuid);`, [restA.id]);
    });
  },
  (err) => err.message.includes('Apenas administradores do restaurante ou da plataforma'),
  'Admin inativo deve ser recusado com 42501',
);

// 6e. Admin ativo de OUTRO restaurante (Restaurante B tentando ler Restaurante A)
await assert.rejects(
  async () => {
    await runAs(userAdminRestB, 'authenticated', async () => {
      await q(`select public.get_restaurant_billing_summary($1::uuid);`, [restA.id]);
    });
  },
  (err) => err.message.includes('Apenas administradores do restaurante ou da plataforma'),
  'Admin de outro restaurante deve ser recusado com 42501',
);

console.log('PASS: Todas as tentativas de acesso não autorizado (anon, avulso, garçom, admin inativo e admin de outro restaurante) foram recusadas.');
console.log('\n====================================================================');
console.log('VALIDAÇÃO SQL LOCAL CONCLUÍDA COM 100% DE SUCESSO!');
console.log('====================================================================\n');
process.exit(0);

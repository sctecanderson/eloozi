import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleAsaasCheckoutRequest } from '../supabase/functions/asaas-checkout/handler.ts';
import { handleAsaasWebhookRequest } from '../supabase/functions/asaas-webhook/handler.ts';

const CHURRASBRUSQUE_ID = 'efcb9f44-c33b-47ec-8125-b20e57b9fd1e';
const VALID_GRANT_ID = 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d';

interface InMemoryInvoice {
  id: string;
  restaurant_id: string;
  plan_id: 'basic' | 'pro' | 'premium';
  billing_cycle: 'monthly' | 'yearly';
  amount_cents: number;
  payment_method: 'pix' | 'credit_card' | 'debit_card';
  status: 'pending' | 'paid' | 'failed' | 'expired' | 'refunded';
  pix_qr_code_payload: string | null;
  pix_expires_at: string | null;
  card_brand: string | null;
  card_last4: string | null;
  external_reference: string | null;
  gateway_emission_status?: 'in_progress' | 'issued' | 'needs_reconciliation' | null;
  gateway_emission_claim_id?: string | null;
  gateway_emission_started_at?: string | null;
  paid_at: string | null;
  created_by: string | null;
  created_at: string;
}

interface InMemoryTestGrant {
  id: string;
  restaurant_id: string;
  target_plan: string;
  billing_cycle: string;
  amount_cents: number;
  authorized_by: string;
  authorized_at: string;
  expires_at: string;
  status: 'authorized' | 'reserved' | 'consumed' | 'revoked';
  reserved_at: string | null;
  reserved_invoice_id: string | null;
  consumed_at: string | null;
  notes: string | null;
}

function createTestGrantEnvironment(options?: {
  currentUser?: { id: string; email?: string } | null;
  isSuperAdmin?: boolean;
  grants?: InMemoryTestGrant[];
  invoices?: InMemoryInvoice[];
}) {
  let invoiceSeq = 100;
  const currentUser = options?.currentUser !== undefined
    ? options.currentUser
    : { id: 'user-superadmin-1', email: 'superadmin@eloozi.com' };

  const platformAdmins = options?.isSuperAdmin === false
    ? []
    : [{ user_id: currentUser?.id ?? '', active: true }];

  const restaurantMembers = [
    {
      restaurant_id: CHURRASBRUSQUE_ID,
      user_id: currentUser?.id ?? '',
      role: 'admin',
      active: true,
    },
  ];

  const restaurants: Record<string, any> = {
    [CHURRASBRUSQUE_ID]: {
      id: CHURRASBRUSQUE_ID,
      name: 'ChurrasBrusque',
      slug: 'churrasbrusque',
      subscription_plan: 'premium',
      subscription_is_trial: true,
      subscription_expires_at: '2026-11-09T12:44:47.640Z',
      active: true,
      max_tables: null,
      unlimited_tables: true,
      monthly_price_cents: 9990,
    },
  };

  const platformSettings = [
    {
      id: 'default',
      basic_price_cents: 9990,
      pro_price_cents: 19990,
      premium_price_cents: 27990,
      basic_max_tables: 5,
      pro_max_tables: 20,
      premium_max_tables: null,
      basic_unlimited_tables: false,
      pro_unlimited_tables: false,
      premium_unlimited_tables: true,
    },
  ];

  // Preserved historical invoice of R$ 99,90 with R$ 5,00 received
  const invoices: InMemoryInvoice[] = options?.invoices ?? [
    {
      id: 'c6f2f476-973d-4aaa-8633-8b16c227e4c7',
      restaurant_id: CHURRASBRUSQUE_ID,
      plan_id: 'basic',
      billing_cycle: 'monthly',
      amount_cents: 9990,
      payment_method: 'pix',
      status: 'pending',
      pix_qr_code_payload: '00020101...',
      pix_expires_at: '2026-11-02T17:12:48.000Z',
      card_brand: null,
      card_last4: null,
      external_reference: 'pay_o7fcywvga6a2ewoy',
      gateway_emission_status: 'issued',
      paid_at: null,
      created_by: 'owner-id',
      created_at: '2026-11-02T16:42:48.692Z',
    },
  ];

  const grants: InMemoryTestGrant[] = options?.grants ?? [
    {
      id: VALID_GRANT_ID,
      restaurant_id: CHURRASBRUSQUE_ID,
      target_plan: 'basic',
      billing_cycle: 'monthly',
      amount_cents: 500,
      authorized_by: 'user-superadmin-1',
      authorized_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      status: 'authorized',
      reserved_at: null,
      reserved_invoice_id: null,
      consumed_at: null,
      notes: 'Teste controlado ChurrasBrusque R$ 5,00',
    },
  ];

  let restaurantLock = Promise.resolve();
  function withRestaurantLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = restaurantLock;
    let release: () => void = () => {};
    restaurantLock = new Promise<void>((r) => { release = r; });
    return prev.then(async () => {
      try {
        return await fn();
      } finally {
        release();
      }
    });
  }

  function makeQueryBuilder(table: string) {
    const filters: Array<(row: Record<string, unknown>) => boolean> = [];
    let pendingUpdate: Record<string, unknown> | null = null;
    let pendingInsert: Record<string, unknown> | null = null;

    const executeSelect = () => {
      let source: Array<Record<string, unknown>> = [];
      if (table === 'restaurant_members') source = restaurantMembers;
      else if (table === 'platform_admins') source = platformAdmins;
      else if (table === 'restaurants') source = Object.values(restaurants);
      else if (table === 'platform_settings') source = platformSettings as any;
      else if (table === 'subscription_invoices') source = invoices as any;
      else if (table === 'subscription_test_grants') source = grants as any;

      return source.filter((r) => filters.every((f) => f(r)));
    };

    const applyMutationIfNeeded = () => {
      if (pendingUpdate && table === 'subscription_invoices') {
        for (const inv of invoices) {
          if (filters.every((f) => f(inv as any))) {
            Object.assign(inv, pendingUpdate);
          }
        }
      }
      if (pendingUpdate && table === 'subscription_test_grants') {
        for (const g of grants) {
          if (filters.every((f) => f(g as any))) {
            Object.assign(g, pendingUpdate);
          }
        }
      }
    };

    const builder: any = {
      select() { return builder; },
      insert(payload: Record<string, unknown>) {
        pendingInsert = payload;
        if (table === 'subscription_invoices') {
          const newInv: InMemoryInvoice = {
            id: (payload.id as string) || `inv-gen-${invoiceSeq++}`,
            restaurant_id: String(payload.restaurant_id),
            plan_id: payload.plan_id as any,
            billing_cycle: payload.billing_cycle as any,
            amount_cents: Number(payload.amount_cents),
            payment_method: payload.payment_method as any,
            status: (payload.status as any) || 'pending',
            pix_qr_code_payload: (payload.pix_qr_code_payload as string) ?? null,
            pix_expires_at: (payload.pix_expires_at as string) ?? null,
            card_brand: null,
            card_last4: null,
            external_reference: (payload.external_reference as string) ?? null,
            gateway_emission_status: (payload.gateway_emission_status as any) ?? null,
            paid_at: null,
            created_by: (payload.created_by as string) ?? null,
            created_at: new Date().toISOString(),
          };
          invoices.push(newInv);
          pendingInsert = newInv as any;
        }
        return builder;
      },
      update(payload: Record<string, unknown>) {
        pendingUpdate = payload;
        applyMutationIfNeeded();
        return builder;
      },
      eq(col: string, val: unknown) {
        filters.push((row) => row[col] === val);
        applyMutationIfNeeded();
        return builder;
      },
      single() {
        if (pendingInsert) return Promise.resolve({ data: pendingInsert, error: null });
        const rows = executeSelect();
        return Promise.resolve({ data: rows[0] ?? null, error: rows[0] ? null : { message: 'Not found' } });
      },
      maybeSingle() {
        const rows = executeSelect();
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
    };
    return builder;
  }

  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];

  const fakeSupabaseClient = {
    auth: {
      async getUser() {
        return { data: { user: currentUser }, error: currentUser ? null : { message: 'Unauthorized' } };
      },
    },
    from(table: string) {
      return makeQueryBuilder(table);
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args });

      if (fn === 'reserve_test_grant_invoice') {
        const restId = String(args.p_restaurant_id);
        const grantId = String(args.p_grant_id);

        return withRestaurantLock(async () => {
          const grant = grants.find((g) => g.id === grantId);
          if (!grant) {
            return { data: null, error: { message: 'Test grant não encontrado.' } };
          }
          if (grant.restaurant_id !== restId) {
            return { data: null, error: { message: 'Test grant não pertence ao restaurante.' } };
          }
          if (grant.restaurant_id !== CHURRASBRUSQUE_ID) {
            return { data: null, error: { message: 'Test grant restrito ao ChurrasBrusque.' } };
          }
          if (grant.target_plan !== 'basic' || grant.billing_cycle !== 'monthly' || grant.amount_cents !== 500) {
            return { data: null, error: { message: 'Test grant restrito a Básico mensal de 500 centavos.' } };
          }
          if (grant.status === 'consumed') {
            return { data: null, error: { message: 'Test grant já foi consumido.' } };
          }
          if (grant.status === 'revoked') {
            return { data: null, error: { message: 'Test grant revogado.' } };
          }
          if (Date.now() > Date.parse(grant.expires_at)) {
            return { data: null, error: { message: 'Test grant expirado.' } };
          }

          if (grant.status === 'reserved') {
            const reservedInv = invoices.find((i) => i.id === grant.reserved_invoice_id);
            if (!reservedInv) {
              return { data: null, error: { message: 'Fatura reservada não encontrada.' } };
            }
            if (reservedInv.gateway_emission_status === 'needs_reconciliation') {
              return { data: null, error: { message: 'Emissão anterior com resultado incerto. Reconcilie antes de nova tentativa.' } };
            }
            return {
              data: { reused: true, invoice: { ...reservedInv }, grant_id: grant.id },
              error: null,
            };
          }

          // Cria fatura atômica de 500 centavos
          const newInv: InMemoryInvoice = {
            id: `inv-test-grant-${invoiceSeq++}`,
            restaurant_id: restId,
            plan_id: 'basic',
            billing_cycle: 'monthly',
            amount_cents: 500,
            payment_method: 'pix',
            status: 'pending',
            pix_qr_code_payload: null,
            pix_expires_at: (args.p_pix_expires_at as string) ?? new Date(Date.now() + 30 * 60 * 1000).toISOString(),
            card_brand: null,
            card_last4: null,
            external_reference: null,
            gateway_emission_status: null,
            paid_at: null,
            created_by: String(args.p_user_id),
            created_at: new Date().toISOString(),
          };
          invoices.push(newInv);

          grant.status = 'reserved';
          grant.reserved_at = new Date().toISOString();
          grant.reserved_invoice_id = newInv.id;

          return {
            data: { reused: false, invoice: { ...newInv }, grant_id: grant.id },
            error: null,
          };
        });
      }

      if (fn === 'acquire_or_create_pending_subscription_invoice') {
        const restId = String(args.p_restaurant_id);
        return withRestaurantLock(async () => {
          const planId = args.p_plan_id as any;
          const cycle = args.p_billing_cycle as any;
          const method = args.p_payment_method as any;
          const amountCents = Number(args.p_amount_cents);

          const existing = invoices.find(
            (inv) =>
              inv.restaurant_id === restId &&
              inv.plan_id === planId &&
              inv.billing_cycle === cycle &&
              inv.payment_method === method &&
              inv.amount_cents === amountCents &&
              inv.status === 'pending',
          );
          if (existing) return { data: { reused: true, invoice: { ...existing } }, error: null };

          const created: InMemoryInvoice = {
            id: `inv-gen-${invoiceSeq++}`,
            restaurant_id: restId,
            plan_id: planId,
            billing_cycle: cycle,
            amount_cents: amountCents,
            payment_method: method,
            status: 'pending',
            pix_qr_code_payload: null,
            pix_expires_at: (args.p_pix_expires_at as string) ?? null,
            card_brand: null,
            card_last4: null,
            external_reference: null,
            gateway_emission_status: null,
            paid_at: null,
            created_by: String(args.p_created_by),
            created_at: new Date().toISOString(),
          };
          invoices.push(created);
          return { data: { reused: false, invoice: { ...created } }, error: null };
        });
      }

      if (fn === 'claim_subscription_invoice_gateway_emission') {
        const inv = invoices.find((i) => i.id === args.p_invoice_id);
        if (!inv) return { data: null, error: { message: 'Invoice not found' } };
        if (inv.gateway_emission_status === 'in_progress') {
          return { data: { claimed: false, reason: 'in_progress' }, error: null };
        }
        if (inv.gateway_emission_status === 'needs_reconciliation') {
          return { data: { claimed: false, reason: 'needs_reconciliation' }, error: null };
        }
        inv.gateway_emission_status = 'in_progress';
        return { data: { claimed: true, claim_id: 'claim-123' }, error: null };
      }

      if (fn === 'attach_subscription_invoice_external_reference') {
        const inv = invoices.find((i) => i.id === args.p_invoice_id);
        if (inv) {
          inv.external_reference = String(args.p_external_reference);
          inv.gateway_emission_status = 'issued';
          return { data: { attached: true }, error: null };
        }
        return { data: null, error: { message: 'Not found' } };
      }

      if (fn === 'mark_subscription_invoice_emission_uncertain') {
        const inv = invoices.find((i) => i.id === args.p_invoice_id);
        if (inv) inv.gateway_emission_status = 'needs_reconciliation';
        return { data: { success: true }, error: null };
      }

      if (fn === 'confirm_subscription_invoice_payment') {
        const inv = invoices.find((i) => i.id === args.p_invoice_id);
        if (!inv) return { data: null, error: { message: 'Not found' } };
        if (Number(args.p_paid_amount_cents) !== inv.amount_cents) {
          return { data: null, error: { message: `Divergência de valor: ${args.p_paid_amount_cents} difere de ${inv.amount_cents}` } };
        }
        inv.status = 'paid';
        inv.paid_at = new Date().toISOString();
        inv.external_reference = String(args.p_external_reference);
        restaurants[inv.restaurant_id].subscription_plan = inv.plan_id;
        restaurants[inv.restaurant_id].subscription_is_trial = false;

        // Consumo atômico do test grant ao confirmar pagamento da fatura
        const grant = grants.find((g) => g.reserved_invoice_id === inv.id);
        if (grant) {
          grant.status = 'consumed';
          grant.consumed_at = new Date().toISOString();
        }

        return {
          data: {
            success: true,
            status: 'paid',
            plan_id: inv.plan_id,
            billing_cycle: inv.billing_cycle,
            already_paid: false,
          },
          error: null,
        };
      }

      if (fn === 'consume_test_grant') {
        const grant = grants.find((g) => g.reserved_invoice_id === args.p_invoice_id);
        if (grant) {
          grant.status = 'consumed';
          grant.consumed_at = new Date().toISOString();
        }
        return { data: { success: true }, error: null };
      }

      return { data: null, error: null };
    },
  };

  return {
    fakeSupabaseClient,
    invoices,
    grants,
    restaurants,
    rpcCalls,
    currentUser,
  };
}

describe('Test Grant — Validação e Isolamento Local', () => {
  it('1. Requer autorização explícita de SuperAdmin (usuário comum recebe 403)', async () => {
    const { fakeSupabaseClient, invoices } = createTestGrantEnvironment({ isSuperAdmin: false });
    const gateway: typeof fetch = async () => new Response('{}', { status: 200 });
    const env = {
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-key',
      supabaseServiceRoleKey: 'service-key',
      asaasApiKey: 'mock-key',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: gateway,
    };

    const res = await handleAsaasCheckoutRequest(
      new Request('https://test.supabase.co/checkout', {
        method: 'POST',
        headers: { Authorization: 'Bearer mock-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restaurantId: CHURRASBRUSQUE_ID,
          targetPlan: 'basic',
          billingCycle: 'monthly',
          paymentMethod: 'pix',
          testGrantId: VALID_GRANT_ID,
          payerInfo: { cpfCnpj: '12345678909' },
        }),
      }),
      env,
    );

    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /Apenas SuperAdmin/);
    assert.equal(invoices.length, 1, 'Nenhuma fatura criada');
  });

  it('1b. Validação e Normalização de testGrantId: rejeita se não for UUID válido e nunca cai no checkout comum', async () => {
    const { fakeSupabaseClient, invoices } = createTestGrantEnvironment({ isSuperAdmin: true });
    let asaasCalled = false;
    const gateway: typeof fetch = async () => {
      asaasCalled = true;
      return new Response('{}', { status: 200 });
    };
    const env = {
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-key',
      supabaseServiceRoleKey: 'service-key',
      asaasApiKey: 'mock-key',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: gateway,
    };

    // Caso 1: string inválida 'not-a-uuid'
    const resInvalid = await handleAsaasCheckoutRequest(
      new Request('https://test.supabase.co/checkout', {
        method: 'POST',
        headers: { Authorization: 'Bearer mock-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restaurantId: CHURRASBRUSQUE_ID,
          targetPlan: 'basic',
          billingCycle: 'monthly',
          paymentMethod: 'pix',
          testGrantId: 'not-a-uuid-1234',
          payerInfo: { cpfCnpj: '12345678909' },
        }),
      }),
      env,
    );
    assert.equal(resInvalid.status, 400);
    assert.match((await resInvalid.json()).error, /deve ser um UUID válido/);
    assert.equal(asaasCalled, false, 'Não chamou Asaas');

    // Caso 2: string vazia
    const resEmpty = await handleAsaasCheckoutRequest(
      new Request('https://test.supabase.co/checkout', {
        method: 'POST',
        headers: { Authorization: 'Bearer mock-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restaurantId: CHURRASBRUSQUE_ID,
          targetPlan: 'basic',
          billingCycle: 'monthly',
          paymentMethod: 'pix',
          testGrantId: '',
          payerInfo: { cpfCnpj: '12345678909' },
        }),
      }),
      env,
    );
    assert.equal(resEmpty.status, 400);
    assert.match((await resEmpty.json()).error, /deve ser um UUID válido/);
    assert.equal(asaasCalled, false, 'Não chamou Asaas');
    assert.equal(invoices.length, 1, 'Fatura histórica preservada');
  });

  it('2. Checkout normal NÃO aplica o grant automaticamente e preserva o preço público (R$ 99,90)', async () => {
    const { fakeSupabaseClient, invoices } = createTestGrantEnvironment({ isSuperAdmin: true });
    let asaasCapturedValue = 0;
    const gateway: typeof fetch = async (url, init) => {
      const u = String(url);
      if (u.includes('/customers')) return new Response(JSON.stringify({ data: [{ id: 'cus_1' }] }), { status: 200 });
      if (u.endsWith('/payments/pay_o7fcywvga6a2ewoy')) {
        return new Response(JSON.stringify({
          id: 'pay_o7fcywvga6a2ewoy',
          status: 'PENDING',
          value: 99.9,
          externalReference: 'c6f2f476-973d-4aaa-8633-8b16c227e4c7',
        }), { status: 200 });
      }
      if (u.includes('/payments') && init?.method === 'POST') {
        const b = JSON.parse(String(init.body));
        asaasCapturedValue = b.value;
        return new Response(JSON.stringify({ id: 'pay_normal_99', status: 'PENDING', value: b.value }), { status: 200 });
      }
      if (u.includes('/pixQrCode')) return new Response(JSON.stringify({ payload: 'qr_normal' }), { status: 200 });
      return new Response('{}', { status: 200 });
    };

    const env = {
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-key',
      supabaseServiceRoleKey: 'service-key',
      asaasApiKey: 'mock-key',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: gateway,
    };

    // Chamada normal SEM testGrantId
    const res = await handleAsaasCheckoutRequest(
      new Request('https://test.supabase.co/checkout', {
        method: 'POST',
        headers: { Authorization: 'Bearer mock-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restaurantId: CHURRASBRUSQUE_ID,
          targetPlan: 'basic',
          billingCycle: 'monthly',
          paymentMethod: 'pix',
          payerInfo: { cpfCnpj: '12345678909' },
        }),
      }),
      env,
    );

    assert.equal(res.status, 200);
    const body = await res.json();
    // Reutiliza ou emite com 9990 centavos do catálogo oficial
    assert.equal(body.amount_cents, 9990);
    assert.equal(invoices[0].amount_cents, 9990, 'Fatura antiga mantida com 9990');
  });

  it('3. Test Grant restringe ao ChurrasBrusque, Básico mensal e 500 centavos', async () => {
    const { fakeSupabaseClient } = createTestGrantEnvironment({ isSuperAdmin: true });
    const gateway: typeof fetch = async () => new Response('{}', { status: 200 });
    const env = {
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-key',
      supabaseServiceRoleKey: 'service-key',
      asaasApiKey: 'mock-key',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: gateway,
    };

    // Tentativa para outro restaurante
    const resRest = await handleAsaasCheckoutRequest(
      new Request('https://test.supabase.co/checkout', {
        method: 'POST',
        headers: { Authorization: 'Bearer mock-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restaurantId: '00000000-0000-0000-0000-000000000000',
          targetPlan: 'basic',
          billingCycle: 'monthly',
          paymentMethod: 'pix',
          testGrantId: VALID_GRANT_ID,
          payerInfo: { cpfCnpj: '12345678909' },
        }),
      }),
      env,
    );
    assert.equal(resRest.status, 422);
    assert.match((await resRest.json()).error, /restrito ao restaurante ChurrasBrusque/);

    // Tentativa para plano Pro
    const resPlan = await handleAsaasCheckoutRequest(
      new Request('https://test.supabase.co/checkout', {
        method: 'POST',
        headers: { Authorization: 'Bearer mock-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restaurantId: CHURRASBRUSQUE_ID,
          targetPlan: 'pro',
          billingCycle: 'monthly',
          paymentMethod: 'pix',
          testGrantId: VALID_GRANT_ID,
          payerInfo: { cpfCnpj: '12345678909' },
        }),
      }),
      env,
    );
    assert.equal(resPlan.status, 422);
    assert.match((await resPlan.json()).error, /restrito a Básico mensal via Pix/);
  });

  it('4. Test Grant expirado é rejeitado', async () => {
    const { fakeSupabaseClient, grants } = createTestGrantEnvironment({ isSuperAdmin: true });
    grants[0].expires_at = new Date(Date.now() - 60000).toISOString(); // 1 minuto atrás

    const gateway: typeof fetch = async () => new Response('{}', { status: 200 });
    const env = {
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-key',
      supabaseServiceRoleKey: 'service-key',
      asaasApiKey: 'mock-key',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: gateway,
    };

    const res = await handleAsaasCheckoutRequest(
      new Request('https://test.supabase.co/checkout', {
        method: 'POST',
        headers: { Authorization: 'Bearer mock-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restaurantId: CHURRASBRUSQUE_ID,
          targetPlan: 'basic',
          billingCycle: 'monthly',
          paymentMethod: 'pix',
          testGrantId: VALID_GRANT_ID,
          payerInfo: { cpfCnpj: '12345678909' },
        }),
      }),
      env,
    );
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /expirado/);
  });

  it('5. Concorrência: duas chamadas simultâneas com o grant reutilizam a mesma fatura e não duplicam POST no Asaas', async () => {
    const { fakeSupabaseClient, invoices, grants } = createTestGrantEnvironment({ isSuperAdmin: true });
    let postPaymentsCount = 0;
    const gateway: typeof fetch = async (url, init) => {
      const u = String(url);
      if (u.includes('/customers')) return new Response(JSON.stringify({ data: [{ id: 'cus_1' }] }), { status: 200 });
      if (u.includes('/payments') && init?.method === 'POST') {
        postPaymentsCount++;
        // Simula latência no gateway para concorrência real
        await new Promise((r) => setTimeout(r, 20));
        return new Response(JSON.stringify({ id: 'pay_test_500', status: 'PENDING', value: 5.0 }), { status: 200 });
      }
      if (u.includes('/pixQrCode')) return new Response(JSON.stringify({ payload: 'qr_test_500' }), { status: 200 });
      return new Response('{}', { status: 200 });
    };

    const env = {
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-key',
      supabaseServiceRoleKey: 'service-key',
      asaasApiKey: 'mock-key',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: gateway,
    };

    const makeReq = () =>
      new Request('https://test.supabase.co/checkout', {
        method: 'POST',
        headers: { Authorization: 'Bearer mock-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restaurantId: CHURRASBRUSQUE_ID,
          targetPlan: 'basic',
          billingCycle: 'monthly',
          paymentMethod: 'pix',
          testGrantId: VALID_GRANT_ID,
          payerInfo: { cpfCnpj: '12345678909' },
        }),
      });

    const [res1, res2] = await Promise.all([
      handleAsaasCheckoutRequest(makeReq(), env),
      handleAsaasCheckoutRequest(makeReq(), env),
    ]);

    const [body1, body2] = await Promise.all([res1.json(), res2.json()]);

    assert.equal(postPaymentsCount, 1, 'Deve ocorrer exatamente UM POST /payments no Asaas');
    assert.equal(grants[0].status, 'reserved');

    const bodies = [body1, body2];
    const okBody = bodies.find((b) => b.amount_cents === 500);
    const lockedBody = bodies.find((b) => b.processing === true || b.needs_reconciliation === true);

    assert.ok(okBody, 'Uma requisição conclui a emissão com 500 centavos');
    assert.ok(lockedBody, 'A requisição concorrente é bloqueada com status 409 sem novo POST');
    assert.equal(okBody.invoice_id, lockedBody.invoice_id, 'Ambas requisições vinculadas ao mesmo ID de fatura');
    // Fatura anterior continua intacta em pending
    assert.equal(invoices[0].id, 'c6f2f476-973d-4aaa-8633-8b16c227e4c7');
    assert.equal(invoices[0].amount_cents, 9990);
    assert.equal(invoices[0].status, 'pending');
  });

  it('6. Repetição (Idempotência): chamada repetida recupera o QR Code da mesma fatura sem novo POST', async () => {
    const { fakeSupabaseClient, invoices } = createTestGrantEnvironment({ isSuperAdmin: true });
    let postPaymentsCount = 0;
    const gateway: typeof fetch = async (url, init) => {
      const u = String(url);
      if (u.includes('/customers')) return new Response(JSON.stringify({ data: [{ id: 'cus_1' }] }), { status: 200 });
      if (u.includes('/payments') && init?.method === 'POST') {
        postPaymentsCount++;
        return new Response(JSON.stringify({ id: 'pay_test_500', status: 'PENDING', value: 5.0 }), { status: 200 });
      }
      if (u.endsWith('/payments/pay_test_500')) {
        return new Response(JSON.stringify({ id: 'pay_test_500', status: 'PENDING', value: 5.0, externalReference: invoices[1]?.id }), { status: 200 });
      }
      if (u.includes('/pixQrCode')) return new Response(JSON.stringify({ payload: 'qr_test_500' }), { status: 200 });
      return new Response('{}', { status: 200 });
    };

    const env = {
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-key',
      supabaseServiceRoleKey: 'service-key',
      asaasApiKey: 'mock-key',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: gateway,
    };

    const makeReq = () =>
      new Request('https://test.supabase.co/checkout', {
        method: 'POST',
        headers: { Authorization: 'Bearer mock-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restaurantId: CHURRASBRUSQUE_ID,
          targetPlan: 'basic',
          billingCycle: 'monthly',
          paymentMethod: 'pix',
          testGrantId: VALID_GRANT_ID,
          payerInfo: { cpfCnpj: '12345678909' },
        }),
      });

    // 1ª chamada
    const res1 = await handleAsaasCheckoutRequest(makeReq(), env);
    assert.equal(res1.status, 200);
    assert.equal(postPaymentsCount, 1);

    // 2ª chamada (repetição idêntica)
    const res2 = await handleAsaasCheckoutRequest(makeReq(), env);
    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    assert.equal(postPaymentsCount, 1, 'Zero novos POST na repetição');
    assert.equal(body2.reused_pending_invoice, true);
    assert.equal(body2.amount_cents, 500);
  });

  it('7. Timeout / Incerteza no Gateway: marca needs_reconciliation e bloqueia nova emissão duplicada', async () => {
    const { fakeSupabaseClient, invoices } = createTestGrantEnvironment({ isSuperAdmin: true });
    let postPaymentsCount = 0;
    let simulateTimeout = true;

    const gateway: typeof fetch = async (url, init) => {
      const u = String(url);
      if (u.includes('/customers')) return new Response(JSON.stringify({ data: [{ id: 'cus_1' }] }), { status: 200 });
      if (u.includes('/payments') && init?.method === 'POST') {
        postPaymentsCount++;
        if (simulateTimeout) {
          throw new Error('Connection timeout to Asaas');
        }
        return new Response(JSON.stringify({ id: 'pay_test_500', status: 'PENDING', value: 5.0 }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };

    const env = {
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-key',
      supabaseServiceRoleKey: 'service-key',
      asaasApiKey: 'mock-key',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: gateway,
    };

    const makeReq = () =>
      new Request('https://test.supabase.co/checkout', {
        method: 'POST',
        headers: { Authorization: 'Bearer mock-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restaurantId: CHURRASBRUSQUE_ID,
          targetPlan: 'basic',
          billingCycle: 'monthly',
          paymentMethod: 'pix',
          testGrantId: VALID_GRANT_ID,
          payerInfo: { cpfCnpj: '12345678909' },
        }),
      });

    // 1ª chamada: timeout na chamada ao Asaas
    const res1 = await handleAsaasCheckoutRequest(makeReq(), env);
    assert.equal(res1.status, 409);
    const body1 = await res1.json();
    assert.equal(body1.needs_reconciliation, true);
    assert.equal(postPaymentsCount, 1);

    // Fatura de teste é marcada como needs_reconciliation
    const testInv = invoices.find((i) => i.amount_cents === 500);
    assert.ok(testInv);
    assert.equal(testInv?.gateway_emission_status, 'needs_reconciliation');

    // 2ª chamada: deve bloquear nova emissão sem reconciliar
    simulateTimeout = false;
    const res2 = await handleAsaasCheckoutRequest(makeReq(), env);
    assert.equal(res2.status, 500);
    const body2 = await res2.json();
    assert.match(body2.error, /resultado incerto/);
    assert.equal(postPaymentsCount, 1, 'Não deve emitir novo POST enquanto incerto');
  });

  it('8. Confirmação do pagamento de R$ 5,00: valida 500 == 500, ativa assinatura e consome grant', async () => {
    const { fakeSupabaseClient, invoices, grants, restaurants } = createTestGrantEnvironment({ isSuperAdmin: true });
    const gateway: typeof fetch = async (url, init) => {
      const u = String(url);
      if (u.includes('/customers')) return new Response(JSON.stringify({ data: [{ id: 'cus_1' }] }), { status: 200 });
      if (u.includes('/payments') && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'pay_test_500', status: 'PENDING', value: 5.0 }), { status: 200 });
      }
      if (u.includes('/pixQrCode')) return new Response(JSON.stringify({ payload: 'qr_test_500' }), { status: 200 });
      if (u.endsWith('/payments/pay_test_500')) {
        return new Response(JSON.stringify({
          id: 'pay_test_500',
          status: 'RECEIVED',
          value: 5.0,
          billingType: 'PIX',
          externalReference: invoices[1]?.id,
        }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };

    const env = {
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-key',
      supabaseServiceRoleKey: 'service-key',
      asaasApiKey: 'mock-key',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: gateway,
    };

    // 1. Cria checkout do test grant
    const resCheckout = await handleAsaasCheckoutRequest(
      new Request('https://test.supabase.co/checkout', {
        method: 'POST',
        headers: { Authorization: 'Bearer mock-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restaurantId: CHURRASBRUSQUE_ID,
          targetPlan: 'basic',
          billingCycle: 'monthly',
          paymentMethod: 'pix',
          testGrantId: VALID_GRANT_ID,
          payerInfo: { cpfCnpj: '12345678909' },
        }),
      }),
      env,
    );
    assert.equal(resCheckout.status, 200);
    const checkoutBody = await resCheckout.json();
    const testInvoiceId = checkoutBody.invoice_id;

    // 2. Confirmação do pagamento via verify_payment
    const resVerify = await handleAsaasCheckoutRequest(
      new Request('https://test.supabase.co/checkout', {
        method: 'POST',
        headers: { Authorization: 'Bearer mock-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'verify_payment',
          restaurantId: CHURRASBRUSQUE_ID,
          invoiceId: testInvoiceId,
        }),
      }),
      env,
    );
    assert.equal(resVerify.status, 200);
    const verifyBody = await resVerify.json();
    assert.equal(verifyBody.status, 'paid');
    assert.equal(verifyBody.plan_id, 'basic');

    // 3. Grant consumido
    assert.equal(grants[0].status, 'consumed');
    assert.ok(grants[0].consumed_at);

    // 4. Restaurante ativado no plano basic sem trial
    assert.equal(restaurants[CHURRASBRUSQUE_ID].subscription_plan, 'basic');
    assert.equal(restaurants[CHURRASBRUSQUE_ID].subscription_is_trial, false);

    // 5. Fatura anterior c6f2f476-... permanece intacta com seus R$ 99,90 e pending
    assert.equal(invoices[0].id, 'c6f2f476-973d-4aaa-8633-8b16c227e4c7');
    assert.equal(invoices[0].amount_cents, 9990);
    assert.equal(invoices[0].status, 'pending');
  });
});

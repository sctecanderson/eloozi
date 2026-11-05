import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSubscriptionCheckout,
  confirmSubscriptionInvoice,
} from '../src/features/billing/billingService.ts';
import { handleAsaasCheckoutRequest } from '../supabase/functions/asaas-checkout/handler.ts';
import { handleAsaasWebhookRequest } from '../supabase/functions/asaas-webhook/handler.ts';

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

interface InMemoryPlatformSettings {
  id: string;
  basic_price_cents: number | null;
  pro_price_cents: number | null;
  premium_price_cents: number | null;
  basic_max_tables: number | null;
  pro_max_tables: number | null;
  premium_max_tables: number | null;
  basic_unlimited_tables?: boolean | null;
  pro_unlimited_tables?: boolean | null;
  premium_unlimited_tables?: boolean | null;
}

function createFakeServerEnvironment(options?: {
  reservedAmountCents?: number;
  reviewConfirmation?: boolean;
  currentUser?: { id: string; email?: string } | null;
  restaurantMembers?: Array<{ restaurant_id: string; user_id: string; role: string; active: boolean }>;
  platformAdmins?: Array<{ user_id: string; active: boolean }>;
  invoices?: InMemoryInvoice[];
  platformSettings?: InMemoryPlatformSettings[];
  legacyConfirmOnly?: boolean;
}) {
  const currentUser =
    options?.currentUser === undefined
      ? { id: 'user-admin-1', email: 'owner@restaurante1.com' }
      : options.currentUser;

  const restaurantMembers = options?.restaurantMembers ?? [
    {
      restaurant_id: 'rest-1',
      user_id: 'user-admin-1',
      role: 'admin',
      active: true,
    },
  ];

  const platformAdmins = options?.platformAdmins ?? [
    {
      user_id: 'user-real-superadmin',
      active: true,
    },
  ];

  const platformSettings: InMemoryPlatformSettings[] = options?.platformSettings ?? [
    {
      id: 'default',
      basic_price_cents: 9900,
      pro_price_cents: 14900,
      premium_price_cents: 19900,
      basic_max_tables: 10,
      pro_max_tables: 25,
      premium_max_tables: 100,
    },
  ];

  const restaurants: Record<
    string,
    {
      id: string;
      name: string;
      slug: string;
      phone: string;
      subscription_plan: string;
      subscription_expires_at: string;
      billing_cycle_days: number;
      max_tables: number;
      monthly_price_cents: number;
    }
  > = {
    'rest-1': {
      id: 'rest-1',
      name: 'Restaurante Um',
      slug: 'restaurante-um',
      phone: '11999990001',
      subscription_plan: 'basic',
      subscription_expires_at: '2026-11-01T00:00:00.000Z',
      billing_cycle_days: 30,
      max_tables: 10,
      monthly_price_cents: 9900,
    },
    'rest-2': {
      id: 'rest-2',
      name: 'Restaurante Dois',
      slug: 'restaurante-dois',
      phone: '11999990002',
      subscription_plan: 'basic',
      subscription_expires_at: '2026-11-01T00:00:00.000Z',
      billing_cycle_days: 30,
      max_tables: 10,
      monthly_price_cents: 9900,
    },
  };

  const invoices: InMemoryInvoice[] = [...(options?.invoices ?? [])];
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  let invoiceSeq = invoices.length + 1;

  // Mutex in-memory por restaurante para simular o FOR UPDATE em public.restaurants
  const restaurantLocks = new Map<string, Promise<void>>();

  async function withRestaurantLock<T>(restaurantId: string, fn: () => Promise<T>): Promise<T> {
    const previous = restaurantLocks.get(restaurantId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((res) => {
      release = res;
    });
    restaurantLocks.set(restaurantId, previous.then(() => next));
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
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
      else if (table === 'platform_settings') {
        source = platformSettings as unknown as Array<Record<string, unknown>>;
      } else if (table === 'subscription_invoices') {
        source = invoices as unknown as Array<Record<string, unknown>>;
      }

      return source.filter((r) => filters.every((f) => f(r)));
    };

    const applyMutationIfNeeded = () => {
      if (pendingUpdate && table === 'subscription_invoices') {
        for (const inv of invoices) {
          if (filters.every((f) => f(inv as unknown as Record<string, unknown>))) {
            Object.assign(inv, pendingUpdate);
          }
        }
      }
    };

    const builder = {
      select() {
        return builder;
      },
      insert(payload: Record<string, unknown>) {
        pendingInsert = payload;
        if (table === 'subscription_invoices') {
          const newInv: InMemoryInvoice = {
            id: (payload.id as string) || `inv-gen-${invoiceSeq++}`,
            restaurant_id: String(payload.restaurant_id),
            plan_id: payload.plan_id as 'basic' | 'pro' | 'premium',
            billing_cycle: payload.billing_cycle as 'monthly' | 'yearly',
            amount_cents: Number(payload.amount_cents),
            payment_method: payload.payment_method as 'pix' | 'credit_card' | 'debit_card',
            status: (payload.status as InMemoryInvoice['status']) || 'pending',
            pix_qr_code_payload: (payload.pix_qr_code_payload as string) ?? null,
            pix_expires_at: (payload.pix_expires_at as string) ?? null,
            card_brand: (payload.card_brand as string) ?? null,
            card_last4: (payload.card_last4 as string) ?? null,
            external_reference: (payload.external_reference as string) ?? null,
            paid_at: null,
            created_by: (payload.created_by as string) ?? null,
            created_at: new Date().toISOString(),
          };
          invoices.push(newInv);
          pendingInsert = newInv as unknown as Record<string, unknown>;
        }
        return builder;
      },
      update(payload: Record<string, unknown>) {
        pendingUpdate = payload;
        return builder;
      },
      eq(col: string, val: unknown) {
        filters.push((row) => row[col] === val);
        applyMutationIfNeeded();
        return builder;
      },
      in(col: string, vals: unknown[]) {
        filters.push((row) => vals.includes(row[col]));
        applyMutationIfNeeded();
        return builder;
      },
      gt(col: string, val: unknown) {
        filters.push((row) => String(row[col] ?? '') > String(val));
        return builder;
      },
      order() {
        return builder;
      },
      limit(n: number) {
        const rows = executeSelect().slice(0, n);
        return Promise.resolve({ data: rows, error: null });
      },
      maybeSingle() {
        const rows = executeSelect();
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      single() {
        if (pendingInsert) {
          return Promise.resolve({ data: pendingInsert, error: null });
        }
        const rows = executeSelect();
        if (!rows[0]) {
          return Promise.resolve({ data: null, error: { message: 'Not found' } });
        }
        return Promise.resolve({ data: rows[0], error: null });
      },
    };

    return builder;
  }

  const fakeSupabaseClient = {
    auth: {
      async getUser() {
        if (!currentUser) {
          return { data: { user: null }, error: { message: 'Unauthorized' } };
        }
        return { data: { user: currentUser }, error: null };
      },
    },
    from(table: string) {
      return makeQueryBuilder(table);
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args });

      if (options?.legacyConfirmOnly && fn === 'confirm_subscription_invoice_payment' && 'p_paid_amount_cents' in args) {
        return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.confirm_subscription_invoice_payment with the supplied arguments' } };
      }

      if (fn === 'acquire_or_create_pending_subscription_invoice') {
        const restId = String(args.p_restaurant_id);
        return withRestaurantLock(restId, async () => {
          const planId = args.p_plan_id as 'basic' | 'pro' | 'premium';
          const cycle = args.p_billing_cycle as 'monthly' | 'yearly';
          const method = args.p_payment_method as 'pix' | 'credit_card' | 'debit_card';
          const amountCents = options?.reservedAmountCents ?? Number(args.p_amount_cents);
          const nowIso = new Date().toISOString();

          // Reutiliza fatura pendente existente da mesma combinação (PIX ou CARTÃO)
          const existing = invoices.find(
            (inv) =>
              inv.restaurant_id === restId &&
              inv.plan_id === planId &&
              inv.billing_cycle === cycle &&
              inv.payment_method === method &&
              inv.amount_cents === amountCents &&
              inv.status === 'pending',
          );

          if (existing) {
            return {
              data: { reused: true, invoice: { ...existing } },
              error: null,
            };
          }

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
            card_brand: (args.p_card_brand as string) ?? null,
            card_last4: (args.p_card_last4 as string) ?? null,
            external_reference: null,
            gateway_emission_status: null,
            gateway_emission_claim_id: null,
            gateway_emission_started_at: null,
            paid_at: null,
            created_by: (args.p_created_by as string) ?? null,
            created_at: nowIso,
          };
          invoices.push(created);

          return {
            data: { reused: false, invoice: { ...created } },
            error: null,
          };
        });
      }

      if (fn === 'claim_subscription_invoice_gateway_emission') {
        const inv = invoices.find((i) => i.id === args.p_invoice_id);
        if (!inv) return { data: null, error: { message: 'Fatura não encontrada.' } };
        if (inv.status !== 'pending') {
          return { data: { claimed: false, reason: 'invalid_status' }, error: null };
        }
        if (inv.external_reference) {
          return { data: { claimed: false, reason: 'already_issued' }, error: null };
        }
        if (inv.gateway_emission_status === 'needs_reconciliation') {
          return { data: { claimed: false, reason: 'needs_reconciliation' }, error: null };
        }
        if (inv.gateway_emission_status === 'in_progress') {
          const startedMs = inv.gateway_emission_started_at
            ? new Date(inv.gateway_emission_started_at).getTime()
            : 0;
          const isStale = Date.now() - startedMs > 120_000;
          if (!isStale) {
            return {
              data: {
                claimed: false,
                reason: 'in_progress',
                started_at: inv.gateway_emission_started_at,
              },
              error: null,
            };
          }
        }
        const claimId = `claim-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
        inv.gateway_emission_status = 'in_progress';
        inv.gateway_emission_claim_id = claimId;
        inv.gateway_emission_started_at = new Date().toISOString();
        return { data: { claimed: true, claim_id: claimId }, error: null };
      }

      if (fn === 'release_subscription_invoice_gateway_emission') {
        const inv = invoices.find((i) => i.id === args.p_invoice_id);
        if (inv && (!args.p_claim_id || inv.gateway_emission_claim_id === args.p_claim_id)) {
          inv.gateway_emission_status = null;
          inv.gateway_emission_claim_id = null;
          inv.gateway_emission_started_at = null;
        }
        return { data: { released: true }, error: null };
      }

      if (fn === 'mark_subscription_invoice_emission_uncertain') {
        const inv = invoices.find((i) => i.id === args.p_invoice_id);
        if (inv && (!args.p_claim_id || inv.gateway_emission_claim_id === args.p_claim_id)) {
          inv.gateway_emission_status = 'needs_reconciliation';
          inv.gateway_emission_claim_id = null;
        }
        return { data: { marked: true }, error: null };
      }

      if (fn === 'attach_subscription_invoice_external_reference') {
        const inv = invoices.find((i) => i.id === args.p_invoice_id);
        if (!inv) return { data: null, error: { message: 'Fatura não encontrada.' } };
        const ext = String(args.p_external_reference || '').trim();
        if (inv.external_reference && inv.external_reference !== ext) {
          return { data: null, error: { message: 'Divergência de external_reference.' } };
        }
        inv.external_reference = ext;
        inv.gateway_emission_status = 'issued';
        inv.gateway_emission_claim_id = null;
        return { data: { attached: true }, error: null };
      }

      if (fn === 'expire_subscription_invoice_after_reconciliation') {
        const inv = invoices.find((i) => i.id === args.p_invoice_id);
        if (inv && inv.status === 'pending') {
          inv.status = 'expired';
          inv.gateway_emission_status = null;
          inv.gateway_emission_claim_id = null;
        }
        return { data: { expired: true }, error: null };
      }

      if (fn !== 'confirm_subscription_invoice_payment') {
        return { data: null, error: { message: `Unexpected RPC ${fn}` } };
      }

      const inv = invoices.find((i) => i.id === args.p_invoice_id);
      if (!inv) {
        return { data: null, error: { message: 'Fatura não encontrada.' } };
      }
      if ('p_restaurant_id' in args && (!args.p_restaurant_id || inv.restaurant_id !== args.p_restaurant_id)) {
        return {
          data: null,
          error: { message: 'Divergência de segurança: restaurante inválido.' },
        };
      }
      const extRef = String(args.p_external_reference || '').trim();
      if (!extRef || !inv.external_reference || inv.external_reference !== extRef) {
        return {
          data: null,
          error: { message: 'Divergência de segurança: external_reference inválido ou ausente.' },
        };
      }
      if ('p_paid_amount_cents' in args && Number(args.p_paid_amount_cents) !== inv.amount_cents) {
        return {
          data: null,
          error: { message: 'Divergência de valor pago.' },
        };
      }

      const rest = restaurants[inv.restaurant_id];
      if(options?.reviewConfirmation){inv.status='paid';return {data:{status:'paid',success:false,requires_review:true,reason:'Pagamento recebido; reconciliação necessária.'},error:null};}
      if (inv.status === 'paid') {
        return {
          data: {
            invoice_id: inv.id,
            status: 'paid',
            already_paid: true,
            plan_id: inv.plan_id,
            billing_cycle: inv.billing_cycle,
            amount_cents: inv.amount_cents,
            subscription_expires_at: rest.subscription_expires_at,
            max_tables: rest.max_tables,
          },
          error: null,
        };
      }

      if (inv.status !== 'pending' && inv.status !== 'expired' && inv.status !== 'failed') {
        return {
          data: null,
          error: { message: `Status inválido para confirmação: ${inv.status}` },
        };
      }

      const isLate = inv.status !== 'pending';
      inv.status = 'paid';
      inv.external_reference = extRef;
      inv.paid_at = new Date().toISOString();

      const addDays = inv.billing_cycle === 'yearly' ? 365 : 30;
      const baseMs = Math.max(Date.now(), new Date(rest.subscription_expires_at).getTime());
      rest.subscription_expires_at = new Date(baseMs + addDays * 86400_000).toISOString();
      rest.subscription_plan = inv.plan_id;
      const ps = platformSettings.find((s) => s.id === 'default');
      const unlimitedTables =
        inv.plan_id === 'pro'
          ? Boolean(ps?.pro_unlimited_tables)
          : inv.plan_id === 'premium'
            ? Boolean(ps?.premium_unlimited_tables)
            : Boolean(ps?.basic_unlimited_tables);
      const maxTables = unlimitedTables
        ? null
        : inv.plan_id === 'pro'
          ? (ps?.pro_max_tables ?? 25)
          : inv.plan_id === 'premium'
            ? (ps?.premium_max_tables ?? 100)
            : (ps?.basic_max_tables ?? 10);
      rest.max_tables = maxTables as number;

      return {
        data: {
          invoice_id: inv.id,
          status: 'paid',
          already_paid: false,
          late_confirmation: isLate,
          plan_id: inv.plan_id,
          billing_cycle: inv.billing_cycle,
          amount_cents: inv.amount_cents,
          subscription_expires_at: rest.subscription_expires_at,
          max_tables: maxTables,
          unlimited_tables: unlimitedTables,
        },
        error: null,
      };
    },
  };

  return {
    fakeSupabaseClient,
    invoices,
    restaurants,
    rpcCalls,
  };
}

describe('Upgrade prepaid: transporte usa a reserva, nunca calcula créditos no mock',()=>{
 for(const cycle of ['monthly','yearly'] as const)for(const method of ['pix','credit_card'] as const){
  it(`${cycle}/${method}: envia somente diferença reservada; manual e webhook compartilham confirmação`,async()=>{
   const amount=cycle==='monthly'?8000:88000;
   const {fakeSupabaseClient,invoices,rpcCalls}=createFakeServerEnvironment({reservedAmountCents:amount});
   let posted=0;let lastPayment:Record<string,unknown>={};
   const gateway:typeof fetch=async(input,init)=>{
    const url=String(input);let body:unknown;
    if(url.includes('/customers?'))body={data:[{id:'cus_mock'}]};
    else if(init?.method==='POST' && url.endsWith('/payments')){posted++;lastPayment=JSON.parse(String(init.body));assert.equal(lastPayment.value,amount/100);body={id:'pay_diff',...lastPayment,status:method==='pix'?'PENDING':'CONFIRMED'};}
    else if(url.endsWith('/pixQrCode'))body={encodedImage:'mock-only',payload:'mock-payload',expirationDate:'2099-01-01'};
    else if(url.endsWith('/payments/pay_diff'))body={id:'pay_diff',...lastPayment,status:'CONFIRMED'};
    else throw new Error(`Unexpected mock request ${url}`);
    return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
   };
   const env={supabaseUrl:'https://mock.invalid',supabaseAnonKey:'anon-mock',supabaseServiceRoleKey:'service-mock',asaasApiKey:'mock-only',asaasBaseUrl:'https://mock.invalid',createSupabaseClient:()=>fakeSupabaseClient,fetchFn:gateway};
   const res=await handleAsaasCheckoutRequest(new Request('https://mock.invalid/checkout',{method:'POST',headers:{Authorization:'Bearer mocked','Content-Type':'application/json'},body:JSON.stringify({restaurantId:'rest-1',targetPlan:'pro',billingCycle:cycle,paymentMethod:method,amountCents:1,creditCents:999999,payerInfo:{cpfCnpj:'12345678909'},cardData:{card_number:'5555444433331111',holder_name:'MOCK',exp_month:'12',exp_year:'2028',cvv:'123'}})}),env);
   const result=await res.json();assert.equal(res.status,200,JSON.stringify(result));assert.equal(result.amount_cents,amount);assert.equal(posted,1);
   const verify=await handleAsaasCheckoutRequest(new Request('https://mock.invalid/checkout',{method:'POST',headers:{Authorization:'Bearer mocked','Content-Type':'application/json'},body:JSON.stringify({action:'verify_payment',restaurantId:'rest-1',invoiceId:invoices[0].id})}),env);
   assert.equal(verify.status,200,await verify.text());
   const webhook=await handleAsaasWebhookRequest(new Request('https://mock.invalid/webhook',{method:'POST',headers:{'Content-Type':'application/json','asaas-access-token':'mock-hook'},body:JSON.stringify({event:'PAYMENT_CONFIRMED',payment:{id:'pay_diff',externalReference:invoices[0].id}})}),{...env,asaasWebhookToken:'mock-hook'});
   assert.equal(webhook.status,200,await webhook.text());assert.equal(posted,1);
   const confirms=rpcCalls.filter(c=>c.fn==='confirm_subscription_invoice_payment');assert.ok(confirms.length>=2);assert.ok(confirms.every(c=>c.args.p_paid_amount_cents===amount));
  });
 }
 it('pagamento recebido para revisão não é anunciado como upgrade confirmado pelo webhook',async()=>{
  const {fakeSupabaseClient,invoices}=createFakeServerEnvironment({reviewConfirmation:true});
  // Existing fixture is an issued pending invoice, not a fabricated successful transition.
  invoices.push({id:'review',restaurant_id:'rest-1',plan_id:'pro',billing_cycle:'monthly',amount_cents:8000,payment_method:'pix',status:'pending',external_reference:'pay_review',paid_at:null,created_at:new Date().toISOString(),created_by:null,pix_qr_code_payload:null,pix_expires_at:null,card_brand:null,card_last4:null});
  const gateway:typeof fetch=async()=>new Response(JSON.stringify({id:'pay_review',status:'CONFIRMED',value:80,billingType:'PIX',externalReference:'review'}));
  const env={supabaseUrl:'https://mock.invalid',supabaseAnonKey:'mock',supabaseServiceRoleKey:'mock',asaasWebhookToken:'mock-hook',asaasApiKey:'mock',asaasBaseUrl:'https://mock.invalid',createSupabaseClient:()=>fakeSupabaseClient,fetchFn:gateway};
  const manual=await handleAsaasCheckoutRequest(new Request('https://mock.invalid',{method:'POST',headers:{Authorization:'Bearer mocked','Content-Type':'application/json'},body:JSON.stringify({action:'verify_payment',restaurantId:'rest-1',invoiceId:'review'})}),env);
  assert.equal(manual.status,409);assert.equal((await manual.json()).requires_review,true);
  const webhook=await handleAsaasWebhookRequest(new Request('https://mock.invalid',{method:'POST',headers:{'Content-Type':'application/json','asaas-access-token':'mock-hook'},body:JSON.stringify({event:'PAYMENT_CONFIRMED',payment:{id:'pay_review',externalReference:'review'}})}),env);
  const result=await webhook.json();assert.equal(webhook.status,200);assert.equal(result.received,true);assert.equal(result.confirmed,false);assert.equal(result.requires_review,true);assert.equal(invoices[0].status,'paid');
 });
});

describe('Preparação do corte financeiro principal', () => {
  it('pausa novas emissões antes de qualquer RPC financeira ou chamada ao gateway', async () => {
    const { fakeSupabaseClient, rpcCalls } = createFakeServerEnvironment();
    let gatewayCalls = 0;
    const response = await handleAsaasCheckoutRequest(new Request('https://mock.invalid/checkout', {
      method: 'POST',
      headers: { Authorization: 'Bearer mocked', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'checkout', restaurantId: 'rest-1', targetPlan: 'pro' }),
    }), {
      supabaseUrl: 'https://mock.invalid', supabaseAnonKey: 'mock', supabaseServiceRoleKey: 'mock',
      asaasApiKey: '', asaasBaseUrl: '', billingIssuancePaused: true,
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: async () => { gatewayCalls++; return new Response('{}'); },
    });
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.billing_paused, true);
    assert.equal(body.retryable, true);
    assert.equal(rpcCalls.length, 0);
    assert.equal(gatewayCalls, 0);
  });

  it('mantém verificação manual compatível com a RPC antiga durante o corte', async () => {
    const { fakeSupabaseClient, rpcCalls, invoices } = createFakeServerEnvironment({
      legacyConfirmOnly: true,
      invoices: [{
        id: 'cutover-legacy-invoice', restaurant_id: 'rest-1', plan_id: 'pro', billing_cycle: 'monthly',
        amount_cents: 14900, payment_method: 'pix', status: 'pending', pix_qr_code_payload: null,
        pix_expires_at: null, card_brand: null, card_last4: null, external_reference: 'pay-cutover-legacy',
        paid_at: null, created_by: null, created_at: new Date().toISOString(),
      }],
    });
    const response = await handleAsaasCheckoutRequest(new Request('https://mock.invalid/checkout', {
      method: 'POST',
      headers: { Authorization: 'Bearer mocked', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'verify_payment', restaurantId: 'rest-1', invoiceId: 'cutover-legacy-invoice' }),
    }), {
      supabaseUrl: 'https://mock.invalid', supabaseAnonKey: 'mock', supabaseServiceRoleKey: 'mock',
      asaasApiKey: 'mock-only', asaasBaseUrl: 'https://mock.invalid',
      billingIssuancePaused: true,
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: async () => new Response(JSON.stringify({
        id: 'pay-cutover-legacy', status: 'CONFIRMED', value: 149, billingType: 'PIX',
        externalReference: 'cutover-legacy-invoice',
      })),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.status, 'paid');
    assert.equal(invoices[0].status, 'paid');
    assert.equal(rpcCalls.length, 2);
    assert.equal('p_paid_amount_cents' in rpcCalls[0].args, true);
    assert.deepEqual(Object.keys(rpcCalls[1].args).sort(), ['p_external_reference', 'p_invoice_id']);
  });

  it('mantém webhook confirmado compatível com a RPC antiga durante o corte', async () => {
    const { fakeSupabaseClient, rpcCalls, invoices } = createFakeServerEnvironment({
      legacyConfirmOnly: true,
      invoices: [{
        id: 'cutover-webhook-invoice', restaurant_id: 'rest-1', plan_id: 'pro', billing_cycle: 'monthly',
        amount_cents: 14900, payment_method: 'pix', status: 'pending', pix_qr_code_payload: null,
        pix_expires_at: null, card_brand: null, card_last4: null, external_reference: 'pay-cutover-webhook',
        paid_at: null, created_by: null, created_at: new Date().toISOString(),
      }],
    });
    const response = await handleAsaasWebhookRequest(new Request('https://mock.invalid/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'asaas-access-token': 'mock-hook' },
      body: JSON.stringify({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay-cutover-webhook' } }),
    }), {
      supabaseUrl: 'https://mock.invalid', supabaseServiceRoleKey: 'mock', asaasWebhookToken: 'mock-hook',
      asaasApiKey: 'mock-only', asaasBaseUrl: 'https://mock.invalid',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: async () => new Response(JSON.stringify({
        id: 'pay-cutover-webhook', status: 'CONFIRMED', value: 149, billingType: 'PIX',
        externalReference: 'cutover-webhook-invoice',
      })),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.confirmed, true);
    assert.equal(invoices[0].status, 'paid');
    assert.equal(rpcCalls.length, 2);
    assert.deepEqual(Object.keys(rpcCalls[1].args).sort(), ['p_external_reference', 'p_invoice_id']);
  });
});

describe('ETAPA 1 — Blindagem de Segurança do Checkout e das Assinaturas', () => {
  it('1. Falha do Asaas no checkout lança erro explícito, não ativa fallback local e não aprova plano', async () => {
    let rpcCalled = false;
    const mockSupabase = {
      functions: {
        async invoke() {
          return {
            data: null,
            error: {
              message: 'Edge Function error',
              context: {
                async json() {
                  return { error: 'Serviço Asaas indisponível no momento.' };
                },
              },
            },
          };
        },
      },
      async rpc() {
        rpcCalled = true;
        return { data: { status: 'paid' }, error: null };
      },
    };

    await assert.rejects(
      async () => {
        await createSubscriptionCheckout({
          restaurantId: 'rest-1',
          targetPlan: 'pro',
          billingCycle: 'monthly',
          paymentMethod: 'credit_card',
          ...({ gatewayProvider: 'elozi_sandbox' } as Record<string, unknown>),
          supabaseClient: mockSupabase,
        });
      },
      (err: Error) => {
        assert.match(err.message, /Serviço Asaas indisponível no momento/);
        return true;
      },
    );

    assert.equal(
      rpcCalled,
      false,
      'Nunca deve chamar RPC create_subscription_checkout como fallback quando o Asaas falha.',
    );
  });

  it('2. Checkout consulta platform_settings com id="default" e recusa gerar cobrança se o catálogo estiver ausente ou inválido (sem fallback fixo)', async () => {
    const { fakeSupabaseClient, invoices } = createFakeServerEnvironment({
      // Simula ausência do registro id = 'default'
      platformSettings: [],
    });

    let asaasCalled = false;
    const mockFetch: typeof fetch = async () => {
      asaasCalled = true;
      return new Response('{}', { status: 200 });
    };

    const req = new Request('https://edge.local/asaas-checkout', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer valid-jwt',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        restaurantId: 'rest-1',
        targetPlan: 'pro',
        billingCycle: 'monthly',
        paymentMethod: 'pix',
        payerInfo: { cpfCnpj: '12345678909' },
      }),
    });

    const res = await handleAsaasCheckoutRequest(req, {
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-key',
      supabaseServiceRoleKey: 'service-role-key',
      asaasApiKey: 'test_asaas_key_not_real',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: mockFetch,
    });

    assert.equal(res.status, 500);
    const body = await res.json();
    assert.match(body.error, /platform_settings id='default'/);
    assert.equal(invoices.length, 0, 'Não deve criar fatura quando platform_settings está indisponível');
    assert.equal(asaasCalled, false, 'Não deve chamar Asaas com preços fixos de fallback');
  });

  it('3. Botão "Validar pagamento" consulta endpoint de servidor (verify_payment) e mantém pendente quando o Asaas retorna PENDING', async () => {
    const { fakeSupabaseClient, restaurants, rpcCalls } = createFakeServerEnvironment({
      invoices: [
        {
          id: 'inv-pix-pending-1',
          restaurant_id: 'rest-1',
          plan_id: 'pro',
          billing_cycle: 'monthly',
          amount_cents: 14900,
          payment_method: 'pix',
          status: 'pending',
          pix_qr_code_payload: '000201010212...',
          pix_expires_at: new Date(Date.now() + 20 * 60_000).toISOString(),
          card_brand: null,
          card_last4: null,
          external_reference: 'pay_asaas_pending_001',
          paid_at: null,
          created_by: 'user-admin-1',
          created_at: new Date().toISOString(),
        },
      ],
    });

    const originalExpires = restaurants['rest-1'].subscription_expires_at;

    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      assert.match(url, /\/payments\/pay_asaas_pending_001$/);
      return new Response(
        JSON.stringify({
          id: 'pay_asaas_pending_001',
          status: 'PENDING',
          value: 149.0,
          externalReference: 'inv-pix-pending-1',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };

    const clientAdapter = {
      functions: {
        async invoke(fnName: string, opts: { body: Record<string, unknown> }) {
          assert.equal(fnName, 'asaas-checkout');
          assert.equal(opts.body.action, 'verify_payment');
          const req = new Request('https://edge.local/asaas-checkout', {
            method: 'POST',
            headers: {
              Authorization: 'Bearer test-jwt',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(opts.body),
          });
          const res = await handleAsaasCheckoutRequest(req, {
            supabaseUrl: 'https://test.supabase.co',
            supabaseAnonKey: 'anon-key',
            supabaseServiceRoleKey: 'service-role-key',
            asaasApiKey: 'test_asaas_key_not_real',
            asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
            createSupabaseClient: () => fakeSupabaseClient,
            fetchFn: mockFetch,
          });
          const data = await res.json();
          return { data, error: res.ok ? null : new Error(data.error) };
        },
      },
    };

    const result = await confirmSubscriptionInvoice('inv-pix-pending-1', {
      restaurantId: 'rest-1',
      supabaseClient: clientAdapter,
    });

    assert.equal(result.status, 'pending');
    assert.equal(rpcCalls.length, 0, 'Não deve chamar confirm_subscription_invoice_payment se PENDING');
    assert.equal(restaurants['rest-1'].subscription_plan, 'basic');
    assert.equal(restaurants['rest-1'].subscription_expires_at, originalExpires);
  });

  it('4. SuperAdmin falso com "superadmin" no e-mail é bloqueado (403); apenas public.platform_admins ou admin do restaurante tem acesso', async () => {
    const { fakeSupabaseClient } = createFakeServerEnvironment({
      currentUser: {
        id: 'user-attacker-99',
        email: 'hacker+superadmin@gmail.com',
      },
      restaurantMembers: [],
      platformAdmins: [{ user_id: 'user-real-superadmin', active: true }],
    });

    let asaasCalled = false;
    const mockFetch: typeof fetch = async () => {
      asaasCalled = true;
      return new Response('{}', { status: 200 });
    };

    const req = new Request('https://edge.local/asaas-checkout', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer attacker-jwt',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        restaurantId: 'rest-1',
        targetPlan: 'pro',
        billingCycle: 'monthly',
        paymentMethod: 'pix',
        payerInfo: { cpfCnpj: '12345678909' },
      }),
    });

    const res = await handleAsaasCheckoutRequest(req, {
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-key',
      supabaseServiceRoleKey: 'service-role-key',
      asaasApiKey: 'test_asaas_key_not_real',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: mockFetch,
    });

    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /Acesso restrito ao administrador/);
    assert.equal(asaasCalled, false);
  });

  it('5. Previne PIX duplicado tanto para fatura pendente já existente quanto para requisições simultâneas ou respostas incertas do Asaas', async () => {
    const { fakeSupabaseClient, invoices } = createFakeServerEnvironment();

    let postPaymentsCount = 0;
    let createdAsaasPayment: Record<string, unknown> | null = null;

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (method === 'GET' && url.includes('/customers?cpfCnpj=')) {
        return new Response(
          JSON.stringify({ data: [{ id: 'cus_asaas_01' }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (method === 'POST' && url.endsWith('/payments')) {
        postPaymentsCount += 1;
        const body = JSON.parse(String(init?.body || '{}'));
        createdAsaasPayment = {
          id: 'pay_asaas_unique_pix_01',
          status: 'PENDING',
          value: body.value,
          billingType: 'PIX',
          externalReference: body.externalReference,
        };
        return new Response(JSON.stringify(createdAsaasPayment), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (method === 'GET' && url.includes('/payments?externalReference=')) {
        const list = createdAsaasPayment ? [createdAsaasPayment] : [];
        return new Response(JSON.stringify({ data: list }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (method === 'GET' && url.endsWith('/payments/pay_asaas_unique_pix_01')) {
        if (createdAsaasPayment) {
          return new Response(JSON.stringify(createdAsaasPayment), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      if (method === 'GET' && url.endsWith('/payments/pay_asaas_unique_pix_01/pixQrCode')) {
        return new Response(
          JSON.stringify({
            encodedImage: 'BASE64_QR',
            payload: '000201010212COPIAECOLA01',
            expirationDate: new Date(Date.now() + 30 * 60_000).toISOString(),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      throw new Error(`Unexpected call: ${method} ${url}`);
    };

    const makePixCheckoutReq = () =>
      new Request('https://edge.local/asaas-checkout', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-jwt',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          restaurantId: 'rest-1',
          targetPlan: 'pro',
          billingCycle: 'monthly',
          paymentMethod: 'pix',
          payerInfo: { cpfCnpj: '12345678909' },
        }),
      });

    // Primeira requisição cria a fatura e a cobrança PIX no Asaas
    const res1 = await handleAsaasCheckoutRequest(makePixCheckoutReq(), {
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-key',
      supabaseServiceRoleKey: 'service-role-key',
      asaasApiKey: 'test_asaas_key_not_real',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: mockFetch,
    });
    assert.equal(res1.status, 200);
    const data1 = await res1.json();

    // Segunda requisição (repetida/simultânea) reutiliza a mesma fatura e não faz novo POST /payments
    const res2 = await handleAsaasCheckoutRequest(makePixCheckoutReq(), {
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-key',
      supabaseServiceRoleKey: 'service-role-key',
      asaasApiKey: 'test_asaas_key_not_real',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: mockFetch,
    });
    assert.equal(res2.status, 200);
    const data2 = await res2.json();

    assert.equal(data2.reused_pending_invoice, true);
    assert.equal(data2.invoice_id, data1.invoice_id);
    assert.equal(invoices.length, 1, 'Deve existir apenas 1 fatura PIX pendente no banco');
    assert.equal(postPaymentsCount, 1, 'Deve ter chamado POST /payments no Asaas apenas 1 vez');
  });

  it('6. Reconciliação segura: fatura antiga legítima sem external_reference é reconciliada somente se o Asaas confirmar externalReference === invoice.id e valor exato', async () => {
    const { fakeSupabaseClient, invoices, restaurants } = createFakeServerEnvironment({
      invoices: [
        {
          id: 'inv-legacy-no-extref',
          restaurant_id: 'rest-1',
          plan_id: 'pro',
          billing_cycle: 'monthly',
          amount_cents: 14900,
          payment_method: 'pix',
          status: 'pending',
          pix_qr_code_payload: '000201...',
          pix_expires_at: new Date(Date.now() + 20 * 60_000).toISOString(),
          card_brand: null,
          card_last4: null,
          external_reference: null,
          paid_at: null,
          created_by: 'user-admin-1',
          created_at: new Date().toISOString(),
        },
      ],
    });

    // 6a: Se o Asaas não retornar cobrança vinculada a inv-legacy-no-extref, rejeita (422)
    const mockFetchNoMatch: typeof fetch = async () =>
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    const reqVerify1 = new Request('https://edge.local/asaas-checkout', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer valid-jwt',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action: 'verify_payment',
        invoiceId: 'inv-legacy-no-extref',
        restaurantId: 'rest-1',
      }),
    });

    const resNoMatch = await handleAsaasCheckoutRequest(reqVerify1, {
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-key',
      supabaseServiceRoleKey: 'service-role-key',
      asaasApiKey: 'test_asaas_key_not_real',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: mockFetchNoMatch,
    });

    assert.equal(resNoMatch.status, 422);
    assert.equal(invoices[0].status, 'pending');

    // 6b: Se o Asaas confirmar cobrança com externalReference === 'inv-legacy-no-extref', billingType === 'PIX' e value === 149.00, reconcilia e confirma
    const mockFetchValidMatch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/payments?externalReference=inv-legacy-no-extref')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'pay_reconciled_777',
                status: 'RECEIVED',
                value: 149.0,
                billingType: 'PIX',
                externalReference: 'inv-legacy-no-extref',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.endsWith('/payments/pay_reconciled_777')) {
        return new Response(
          JSON.stringify({
            id: 'pay_reconciled_777',
            status: 'RECEIVED',
            value: 149.0,
            billingType: 'PIX',
            externalReference: 'inv-legacy-no-extref',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const reqVerify2 = new Request('https://edge.local/asaas-checkout', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer valid-jwt',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action: 'verify_payment',
        invoiceId: 'inv-legacy-no-extref',
        restaurantId: 'rest-1',
      }),
    });

    const resReconciled = await handleAsaasCheckoutRequest(reqVerify2, {
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-key',
      supabaseServiceRoleKey: 'service-role-key',
      asaasApiKey: 'test_asaas_key_not_real',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: mockFetchValidMatch,
    });

    assert.equal(resReconciled.status, 200);
    const reconciledBody = await resReconciled.json();
    assert.equal(reconciledBody.status, 'paid');
    assert.equal(invoices[0].external_reference, 'pay_reconciled_777');
    assert.equal(invoices[0].status, 'paid');
    assert.equal(restaurants['rest-1'].subscription_plan, 'pro');
  });

  it('7. Webhook Asaas rejeita chamadas sem token válido e rejeita valor divergente, externalReference ausente/divergente ou fatura de outro restaurante', async () => {
    const { fakeSupabaseClient, rpcCalls, restaurants } = createFakeServerEnvironment({
      invoices: [
        {
          id: 'inv-rest1-premium',
          restaurant_id: 'rest-1',
          plan_id: 'premium',
          billing_cycle: 'monthly',
          amount_cents: 19900,
          payment_method: 'pix',
          status: 'pending',
          pix_qr_code_payload: '000201...',
          pix_expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
          card_brand: null,
          card_last4: null,
          external_reference: 'pay_real_199',
          paid_at: null,
          created_by: 'user-admin-1',
          created_at: new Date().toISOString(),
        },
      ],
    });

    // 7a: Segredo ausente no servidor -> 500
    const reqNoSecret = new Request('https://edge.local/asaas-webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'asaas-access-token': 'qualquer-token',
      },
      body: JSON.stringify({
        event: 'PAYMENT_CONFIRMED',
        payment: { id: 'pay_real_199', externalReference: 'inv-rest1-premium' },
      }),
    });

    const resNoSecret = await handleAsaasWebhookRequest(reqNoSecret, {
      supabaseUrl: 'https://test.supabase.co',
      supabaseServiceRoleKey: 'service-role-key',
      asaasWebhookToken: '',
      asaasApiKey: 'test_asaas_key_not_real',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
    });
    assert.equal(resNoSecret.status, 500);

    // 7b: Token inválido -> 401
    const reqWrongToken = new Request('https://edge.local/asaas-webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'asaas-access-token': 'token-invalido',
      },
      body: JSON.stringify({
        event: 'PAYMENT_CONFIRMED',
        payment: { id: 'pay_real_199', externalReference: 'inv-rest1-premium' },
      }),
    });

    const resWrongToken = await handleAsaasWebhookRequest(reqWrongToken, {
      supabaseUrl: 'https://test.supabase.co',
      supabaseServiceRoleKey: 'service-role-key',
      asaasWebhookToken: 'segredo-oficial-servidor',
      asaasApiKey: 'test_asaas_key_not_real',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
    });
    assert.equal(resWrongToken.status, 401);

    // 7c: Valor divergente na API do Asaas (99.00 vs 199.00) -> 422
    const mockFetchDivergentValue: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          id: 'pay_real_199',
          status: 'CONFIRMED',
          value: 99.0,
          billingType: 'PIX',
          externalReference: 'inv-rest1-premium',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );

    const webhookReqDivergent = new Request('https://edge.local/asaas-webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'asaas-access-token': 'segredo-oficial-servidor',
      },
      body: JSON.stringify({
        event: 'PAYMENT_CONFIRMED',
        payment: { id: 'pay_real_199', externalReference: 'inv-rest1-premium' },
      }),
    });

    const resDivergent = await handleAsaasWebhookRequest(webhookReqDivergent, {
      supabaseUrl: 'https://test.supabase.co',
      supabaseServiceRoleKey: 'service-role-key',
      asaasWebhookToken: 'segredo-oficial-servidor',
      asaasApiKey: 'test_asaas_key_not_real',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: mockFetchDivergentValue,
    });

    assert.equal(resDivergent.status, 422);
    assert.equal(rpcCalls.length, 0);
    assert.equal(restaurants['rest-1'].subscription_plan, 'basic');
  });

  it('8. Pagamento confirmado no Asaas ativa/renova a assinatura uma única vez e eventos repetidos são idempotentes', async () => {
    const { fakeSupabaseClient, restaurants, invoices, rpcCalls } = createFakeServerEnvironment({
      invoices: [
        {
          id: 'inv-valid-pro-1',
          restaurant_id: 'rest-1',
          plan_id: 'pro',
          billing_cycle: 'monthly',
          amount_cents: 14900,
          payment_method: 'pix',
          status: 'pending',
          pix_qr_code_payload: '000201...',
          pix_expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
          card_brand: null,
          card_last4: null,
          external_reference: 'pay_asaas_confirmed_149',
          paid_at: null,
          created_by: 'user-admin-1',
          created_at: new Date().toISOString(),
        },
      ],
    });

    const mockFetchConfirmed: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          id: 'pay_asaas_confirmed_149',
          status: 'RECEIVED',
          value: 149.0,
          billingType: 'PIX',
          externalReference: 'inv-valid-pro-1',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );

    const makeWebhookRequest = () =>
      new Request('https://edge.local/asaas-webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'asaas-access-token': 'segredo-oficial-servidor',
        },
        body: JSON.stringify({
          event: 'PAYMENT_RECEIVED',
          payment: { id: 'pay_asaas_confirmed_149', externalReference: 'inv-valid-pro-1' },
        }),
      });

    const res1 = await handleAsaasWebhookRequest(makeWebhookRequest(), {
      supabaseUrl: 'https://test.supabase.co',
      supabaseServiceRoleKey: 'service-role-key',
      asaasWebhookToken: 'segredo-oficial-servidor',
      asaasApiKey: 'test_asaas_key_not_real',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: mockFetchConfirmed,
    });

    assert.equal(res1.status, 200);
    const body1 = await res1.json();
    assert.equal(body1.confirmed, true);
    assert.equal(body1.already_paid, false);
    assert.equal(invoices[0].status, 'paid');
    assert.equal(restaurants['rest-1'].subscription_plan, 'pro');
    assert.equal(restaurants['rest-1'].max_tables, 25);

    const expiresAfterFirstConfirmation = restaurants['rest-1'].subscription_expires_at;

    const res2 = await handleAsaasWebhookRequest(makeWebhookRequest(), {
      supabaseUrl: 'https://test.supabase.co',
      supabaseServiceRoleKey: 'service-role-key',
      asaasWebhookToken: 'segredo-oficial-servidor',
      asaasApiKey: 'test_asaas_key_not_real',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: mockFetchConfirmed,
    });

    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    assert.equal(body2.confirmed, true);
    assert.equal(body2.already_paid, true);
    assert.equal(
      restaurants['rest-1'].subscription_expires_at,
      expiresAfterFirstConfirmation,
      'Não deve estender subscription_expires_at novamente em entrega duplicada do webhook',
    );
    assert.equal(rpcCalls.length, 2);
  });

  it('9. Concorrência real na emissão Pix: segura primeira chamada POST /payments e comprova que a segunda chamada paralela não faz novo POST', async () => {
    const { fakeSupabaseClient, invoices } = createFakeServerEnvironment();

    let postPaymentsCount = 0;
    let releaseFirstPostPayments!: () => void;
    const firstPostPaymentsStarted = new Promise<void>((resolve) => {
      releaseFirstPostPayments = resolve;
    });
    let allowFirstPostPaymentsToFinish!: () => void;
    const finishFirstPostPayments = new Promise<void>((resolve) => {
      allowFirstPostPaymentsToFinish = resolve;
    });

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (method === 'GET' && url.includes('/customers?cpfCnpj=')) {
        return new Response(JSON.stringify({ data: [{ id: 'cus_asaas_01' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (method === 'POST' && url.endsWith('/payments')) {
        postPaymentsCount += 1;
        const body = JSON.parse(String(init?.body || '{}'));

        if (postPaymentsCount === 1) {
          // Avisa que o primeiro POST /payments foi iniciado e segura até a 2ª chamada concorrente chegar
          releaseFirstPostPayments();
          await finishFirstPostPayments;
        }

        return new Response(
          JSON.stringify({
            id: 'pay_asaas_concurrency_01',
            status: 'PENDING',
            value: body.value,
            billingType: 'PIX',
            externalReference: body.externalReference,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (method === 'GET' && url.endsWith('/payments/pay_asaas_concurrency_01')) {
        return new Response(
          JSON.stringify({
            id: 'pay_asaas_concurrency_01',
            status: 'PENDING',
            value: 149.0,
            billingType: 'PIX',
            externalReference: invoices[0]?.id || 'inv-gen-1',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (method === 'GET' && url.endsWith('/payments/pay_asaas_concurrency_01/pixQrCode')) {
        return new Response(
          JSON.stringify({
            encodedImage: 'BASE64_QR',
            payload: '000201010212COPIAECOLA01',
            expirationDate: new Date(Date.now() + 30 * 60_000).toISOString(),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      throw new Error(`Unexpected call: ${method} ${url}`);
    };

    const makePixCheckoutReq = () =>
      new Request('https://edge.local/asaas-checkout', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-jwt',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          restaurantId: 'rest-1',
          targetPlan: 'pro',
          billingCycle: 'monthly',
          paymentMethod: 'pix',
          payerInfo: { cpfCnpj: '12345678909' },
        }),
      });

    // Dispara a requisição 1 que fica suspensa no primeiro POST /payments
    const p1 = handleAsaasCheckoutRequest(makePixCheckoutReq(), {
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-key',
      supabaseServiceRoleKey: 'service-role-key',
      asaasApiKey: 'test_asaas_key_not_real',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: mockFetch,
    });

    // Aguarda o primeiro POST ser iniciado
    await firstPostPaymentsStarted;

    // Dispara a requisição 2 enquanto o primeiro POST ainda está em andamento no Asaas
    const res2 = await handleAsaasCheckoutRequest(makePixCheckoutReq(), {
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-key',
      supabaseServiceRoleKey: 'service-role-key',
      asaasApiKey: 'test_asaas_key_not_real',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: mockFetch,
    });

    // A requisição 2 deve receber 409 com processing: true, SEM fazer novo POST /payments
    assert.equal(res2.status, 409);
    const body2 = await res2.json();
    assert.equal(body2.processing, true);
    assert.equal(postPaymentsCount, 1, 'Requisição concorrente NÃO pode disparar novo POST /payments!');

    // Libera a requisição 1 para concluir com sucesso
    allowFirstPostPaymentsToFinish();
    const res1 = await p1;
    assert.equal(res1.status, 200);
    const body1 = await res1.json();
    assert.equal(body1.asaas_payment_id || body1.payment_id, 'pay_asaas_concurrency_01');

    // Terceira requisição agora encontra o QR code emitido e reutiliza normalmente
    const res3 = await handleAsaasCheckoutRequest(makePixCheckoutReq(), {
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-key',
      supabaseServiceRoleKey: 'service-role-key',
      asaasApiKey: 'test_asaas_key_not_real',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: mockFetch,
    });
    assert.equal(res3.status, 200);
    const body3 = await res3.json();
    assert.equal(body3.reused_pending_invoice, true);
    assert.equal(postPaymentsCount, 1, 'Total de POST /payments deve continuar sendo exatamente 1');
  });

  it('10. Timeout/erro no POST /payments marca a emissão como incerta e recuperação segura reconcilia cobrança sem novo POST', async () => {
    const { fakeSupabaseClient, invoices } = createFakeServerEnvironment();

    let postAttempts = 0;
    let paymentCreatedInGateway = false;

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (method === 'GET' && url.includes('/customers?cpfCnpj=')) {
        return new Response(JSON.stringify({ data: [{ id: 'cus_asaas_01' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (method === 'POST' && url.endsWith('/payments')) {
        postAttempts += 1;
        paymentCreatedInGateway = true;
        // Simula timeout da requisição POST
        throw new Error('Asaas gateway timeout (ETIMEDOUT)');
      }

      if (method === 'GET' && url.includes('/payments?externalReference=')) {
        if (paymentCreatedInGateway) {
          const invId = invoices[0].id;
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: 'pay_recovered_after_timeout',
                  status: 'PENDING',
                  value: 149.0,
                  billingType: 'PIX',
                  externalReference: invId,
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }

      if (method === 'GET' && url.endsWith('/payments/pay_recovered_after_timeout')) {
        return new Response(
          JSON.stringify({
            id: 'pay_recovered_after_timeout',
            status: 'PENDING',
            value: 149.0,
            billingType: 'PIX',
            externalReference: invoices[0].id,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (method === 'GET' && url.endsWith('/payments/pay_recovered_after_timeout/pixQrCode')) {
        return new Response(
          JSON.stringify({
            encodedImage: 'BASE64_QR',
            payload: '000201RECOVERED',
            expirationDate: new Date(Date.now() + 30 * 60_000).toISOString(),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      throw new Error(`Unexpected call: ${method} ${url}`);
    };

    const makePixCheckoutReq = () =>
      new Request('https://edge.local/asaas-checkout', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-jwt',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          restaurantId: 'rest-1',
          targetPlan: 'pro',
          billingCycle: 'monthly',
          paymentMethod: 'pix',
          payerInfo: { cpfCnpj: '12345678909' },
        }),
      });

    // Primeira tentativa sofre timeout no POST
    const res1 = await handleAsaasCheckoutRequest(makePixCheckoutReq(), {
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-key',
      supabaseServiceRoleKey: 'service-role-key',
      asaasApiKey: 'test_asaas_key_not_real',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: mockFetch,
    });

    assert.equal(res1.status, 409);
    const body1 = await res1.json();
    assert.equal(body1.needs_reconciliation, true);
    assert.equal(invoices[0].gateway_emission_status, 'needs_reconciliation');
    assert.equal(postAttempts, 1);

    // Segunda tentativa realiza reconciliação com o Asaas e recupera a cobrança criada sem fazer novo POST
    const res2 = await handleAsaasCheckoutRequest(makePixCheckoutReq(), {
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-key',
      supabaseServiceRoleKey: 'service-role-key',
      asaasApiKey: 'test_asaas_key_not_real',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: mockFetch,
    });

    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    assert.equal(body2.asaas_payment_id || body2.payment_id, 'pay_recovered_after_timeout');
    assert.equal(body2.pix_qr_code_payload, '000201RECOVERED');
    assert.equal(postAttempts, 1, 'Não deve fazer novo POST /payments ao recuperar cobrança após timeout!');
  });

  it('11. Falha na busca de reconciliação (HTTP 500) ou resultados múltiplos retornam 409 sem novo POST', async () => {
    const { fakeSupabaseClient, invoices } = createFakeServerEnvironment({
      invoices: [
        {
          id: 'inv-uncertain-1',
          restaurant_id: 'rest-1',
          plan_id: 'pro',
          billing_cycle: 'monthly',
          amount_cents: 14900,
          payment_method: 'pix',
          status: 'pending',
          pix_qr_code_payload: null,
          pix_expires_at: null,
          card_brand: null,
          card_last4: null,
          external_reference: null,
          gateway_emission_status: 'needs_reconciliation',
          paid_at: null,
          created_by: 'user-admin-1',
          created_at: new Date().toISOString(),
        },
      ],
    });

    let postPaymentsCount = 0;

    // 11A: Busca no Asaas falha com HTTP 500
    const mockFetch500: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/payments?externalReference=')) {
        return new Response('Gateway error', { status: 500 });
      }
      if (url.endsWith('/payments')) {
        postPaymentsCount += 1;
      }
      return new Response('{}', { status: 200 });
    };

    const makeReq = () =>
      new Request('https://edge.local/asaas-checkout', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-jwt',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          restaurantId: 'rest-1',
          targetPlan: 'pro',
          billingCycle: 'monthly',
          paymentMethod: 'pix',
          payerInfo: { cpfCnpj: '12345678909' },
        }),
      });

    const res500 = await handleAsaasCheckoutRequest(makeReq(), {
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-key',
      supabaseServiceRoleKey: 'service-role-key',
      asaasApiKey: 'test_asaas_key_not_real',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: mockFetch500,
    });

    assert.equal(res500.status, 409);
    const body500 = await res500.json();
    assert.equal(body500.needs_reconciliation, true);
    assert.equal(postPaymentsCount, 0, 'Não deve fazer POST se busca de reconciliação falhar');

    // 11B: Busca no Asaas retorna múltiplos pagamentos (ambiguidade de segurança)
    const mockFetchMultiple: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/payments?externalReference=')) {
        return new Response(
          JSON.stringify({
            data: [
              { id: 'pay_ambiguous_1', status: 'PENDING', value: 149.0, externalReference: 'inv-uncertain-1' },
              { id: 'pay_ambiguous_2', status: 'PENDING', value: 149.0, externalReference: 'inv-uncertain-1' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.endsWith('/payments')) {
        postPaymentsCount += 1;
      }
      return new Response('{}', { status: 200 });
    };

    const resMultiple = await handleAsaasCheckoutRequest(makeReq(), {
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-key',
      supabaseServiceRoleKey: 'service-role-key',
      asaasApiKey: 'test_asaas_key_not_real',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: mockFetchMultiple,
    });

    assert.equal(resMultiple.status, 409);
    const bodyMultiple = await resMultiple.json();
    assert.equal(bodyMultiple.needs_reconciliation, true);
    assert.equal(postPaymentsCount, 0, 'Não deve fazer POST quando houver múltiplas cobranças');
  });

  it('12. Fatura com QR code vencido no banco consulta o Asaas antes de alterar estado: confirma pagamento se já foi pago, e só expira se Asaas confirmar OVERDUE', async () => {
    // 12A: QR code expirou localmente, mas cliente pagou no Asaas
    const { fakeSupabaseClient, invoices, restaurants } = createFakeServerEnvironment({
      invoices: [
        {
          id: 'inv-expired-local-qr',
          restaurant_id: 'rest-1',
          plan_id: 'pro',
          billing_cycle: 'monthly',
          amount_cents: 14900,
          payment_method: 'pix',
          status: 'pending',
          pix_qr_code_payload: '000201OLD',
          pix_expires_at: new Date(Date.now() - 10 * 60_000).toISOString(), // Venceu há 10 min
          card_brand: null,
          card_last4: null,
          external_reference: 'pay_asaas_paid_qr',
          paid_at: null,
          created_by: 'user-admin-1',
          created_at: new Date(Date.now() - 40 * 60_000).toISOString(),
        },
      ],
    });

    const mockFetchPaidInAsaas: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/payments/pay_asaas_paid_qr')) {
        return new Response(
          JSON.stringify({
            id: 'pay_asaas_paid_qr',
            status: 'RECEIVED',
            value: 149.0,
            externalReference: 'inv-expired-local-qr',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected: ${url}`);
    };

    const makeReq = () =>
      new Request('https://edge.local/asaas-checkout', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-jwt',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          restaurantId: 'rest-1',
          targetPlan: 'pro',
          billingCycle: 'monthly',
          paymentMethod: 'pix',
          payerInfo: { cpfCnpj: '12345678909' },
        }),
      });

    const resPaid = await handleAsaasCheckoutRequest(makeReq(), {
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-key',
      supabaseServiceRoleKey: 'service-role-key',
      asaasApiKey: 'test_asaas_key_not_real',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: mockFetchPaidInAsaas,
    });

    assert.equal(resPaid.status, 200);
    const bodyPaid = await resPaid.json();
    assert.equal(bodyPaid.status, 'paid');
    assert.equal(invoices[0].status, 'paid');
    assert.equal(restaurants['rest-1'].subscription_plan, 'pro');

    // 12B: Cobrança com status OVERDUE no Asaas continua pagável: preserva a cobrança e recarrega o QR Code sem emitir nova fatura
    const { fakeSupabaseClient: client2, invoices: invoices2 } = createFakeServerEnvironment({
      invoices: [
        {
          id: 'inv-overdue-qr',
          restaurant_id: 'rest-1',
          plan_id: 'pro',
          billing_cycle: 'monthly',
          amount_cents: 14900,
          payment_method: 'pix',
          status: 'pending',
          pix_qr_code_payload: '000201OLD',
          pix_expires_at: new Date(Date.now() - 10 * 60_000).toISOString(),
          card_brand: null,
          card_last4: null,
          external_reference: 'pay_asaas_overdue',
          paid_at: null,
          created_by: 'user-admin-1',
          created_at: new Date(Date.now() - 40 * 60_000).toISOString(),
        },
      ],
    });

    let newPostPaymentsCount = 0;
    const mockFetchOverdue: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (url.endsWith('/payments/pay_asaas_overdue')) {
        return new Response(
          JSON.stringify({
            id: 'pay_asaas_overdue',
            status: 'OVERDUE',
            value: 149.0,
            externalReference: 'inv-overdue-qr',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.endsWith('/payments/pay_asaas_overdue/pixQrCode')) {
        return new Response(
          JSON.stringify({
            encodedImage: 'BASE64_OVERDUE_RELOADED',
            payload: '000201OVERDUE_RELOADED',
            expirationDate: new Date(Date.now() + 30 * 60_000).toISOString(),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (method === 'POST' && url.endsWith('/payments')) {
        newPostPaymentsCount += 1;
        throw new Error('Não deveria emitir novo pagamento para cobrança OVERDUE ainda pagável!');
      }
      throw new Error(`Unexpected: ${url}`);
    };

    const resOverdue = await handleAsaasCheckoutRequest(makeReq(), {
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-key',
      supabaseServiceRoleKey: 'service-role-key',
      asaasApiKey: 'test_asaas_key_not_real',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => client2,
      fetchFn: mockFetchOverdue,
    });

    assert.equal(resOverdue.status, 200);
    const bodyOverdue = await resOverdue.json();
    assert.equal(invoices2[0].status, 'pending', 'Fatura deve ser preservada enquanto puder ser paga');
    assert.equal(bodyOverdue.pix_qr_code_payload, '000201OVERDUE_RELOADED');
    assert.equal(bodyOverdue.reused_pending_invoice, true);
    assert.equal(newPostPaymentsCount, 0, 'Zero novos POST /payments para cobrança OVERDUE preservada');
    assert.equal(invoices2.length, 1, 'Nenhuma fatura duplicada criada');

    // 12C: Somente após confirmação inequívoca de cobrança cancelada (deleted === true) expira fatura anterior e gera nova
    const { fakeSupabaseClient: client3, invoices: invoices3 } = createFakeServerEnvironment({
      invoices: [
        {
          id: 'inv-deleted-qr',
          restaurant_id: 'rest-1',
          plan_id: 'pro',
          billing_cycle: 'monthly',
          amount_cents: 14900,
          payment_method: 'pix',
          status: 'pending',
          pix_qr_code_payload: '000201OLD',
          pix_expires_at: new Date(Date.now() - 10 * 60_000).toISOString(),
          card_brand: null,
          card_last4: null,
          external_reference: 'pay_asaas_deleted',
          paid_at: null,
          created_by: 'user-admin-1',
          created_at: new Date(Date.now() - 40 * 60_000).toISOString(),
        },
      ],
    });

    const mockFetchDeleted: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (url.endsWith('/payments/pay_asaas_deleted')) {
        return new Response(
          JSON.stringify({
            id: 'pay_asaas_deleted',
            deleted: true,
            value: 149.0,
            externalReference: 'inv-deleted-qr',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (method === 'GET' && url.includes('/customers?cpfCnpj=')) {
        return new Response(JSON.stringify({ data: [{ id: 'cus_01' }] }), { status: 200 });
      }
      if (method === 'POST' && url.endsWith('/payments')) {
        const body = JSON.parse(String(init?.body || '{}'));
        return new Response(
          JSON.stringify({
            id: 'pay_new_fresh_03',
            status: 'PENDING',
            value: body.value,
            billingType: 'PIX',
            externalReference: body.externalReference,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.endsWith('/payments/pay_new_fresh_03/pixQrCode')) {
        return new Response(
          JSON.stringify({
            encodedImage: 'BASE64_NEW',
            payload: '000201NEW',
            expirationDate: new Date(Date.now() + 30 * 60_000).toISOString(),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected: ${url}`);
    };

    const resDeleted = await handleAsaasCheckoutRequest(makeReq(), {
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-key',
      supabaseServiceRoleKey: 'service-role-key',
      asaasApiKey: 'test_asaas_key_not_real',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => client3,
      fetchFn: mockFetchDeleted,
    });

    assert.equal(resDeleted.status, 200);
    const bodyDeleted = await resDeleted.json();
    assert.equal(invoices3[0].status, 'expired', 'Fatura anterior confirmadamente deletada é marcada como expired');
    assert.equal(bodyDeleted.asaas_payment_id || bodyDeleted.payment_id, 'pay_new_fresh_03');
    assert.equal(invoices3.length, 2, 'Nova fatura emitida com segurança');
  });

  it('13. Webhook com pagamento atrasado para fatura já expirada localmente confirma o plano e não descarta o pagamento', async () => {
    const { fakeSupabaseClient, restaurants, invoices } = createFakeServerEnvironment({
      invoices: [
        {
          id: 'inv-late-webhook-01',
          restaurant_id: 'rest-1',
          plan_id: 'pro',
          billing_cycle: 'monthly',
          amount_cents: 14900,
          payment_method: 'pix',
          status: 'expired', // Expirada previamente por rotina local
          pix_qr_code_payload: '000201...',
          pix_expires_at: new Date(Date.now() - 60 * 60_000).toISOString(),
          card_brand: null,
          card_last4: null,
          external_reference: 'pay_late_01',
          paid_at: null,
          created_by: 'user-admin-1',
          created_at: new Date(Date.now() - 120 * 60_000).toISOString(),
        },
      ],
    });

    const mockFetchLate: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          id: 'pay_late_01',
          status: 'CONFIRMED',
          value: 149.0,
          billingType: 'PIX',
          externalReference: 'inv-late-webhook-01',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );

    const webhookReq = new Request('https://edge.local/asaas-webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'asaas-access-token': 'segredo-oficial-servidor',
      },
      body: JSON.stringify({
        event: 'PAYMENT_CONFIRMED',
        payment: { id: 'pay_late_01', externalReference: 'inv-late-webhook-01' },
      }),
    });

    const res = await handleAsaasWebhookRequest(webhookReq, {
      supabaseUrl: 'https://test.supabase.co',
      supabaseServiceRoleKey: 'service-role-key',
      asaasWebhookToken: 'segredo-oficial-servidor',
      asaasApiKey: 'test_asaas_key_not_real',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: mockFetchLate,
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.confirmed, true);
    assert.equal(invoices[0].status, 'paid');
    assert.equal(restaurants['rest-1'].subscription_plan, 'pro');
  });

  it('14. Webhook rejeita concorrência e não sobrescreve external_reference existente nem aceita fallback silencioso se RPC falhar', async () => {
    const { fakeSupabaseClient, invoices } = createFakeServerEnvironment({
      invoices: [
        {
          id: 'inv-webhook-concurrency',
          restaurant_id: 'rest-1',
          plan_id: 'pro',
          billing_cycle: 'monthly',
          amount_cents: 14900,
          payment_method: 'pix',
          status: 'pending',
          pix_qr_code_payload: null,
          pix_expires_at: null,
          card_brand: null,
          card_last4: null,
          external_reference: null,
          paid_at: null,
          created_by: 'user-admin-1',
          created_at: new Date().toISOString(),
        },
      ],
    });

    const mockFetchWebhook: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          id: 'pay_asaas_unique_100',
          status: 'CONFIRMED',
          value: 149.0,
          billingType: 'PIX',
          externalReference: 'inv-webhook-concurrency',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );

    const makeWebhookReq = (payId: string) =>
      new Request('https://edge.local/asaas-webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'asaas-access-token': 'segredo-oficial-servidor',
        },
        body: JSON.stringify({
          event: 'PAYMENT_CONFIRMED',
          payment: { id: payId, externalReference: 'inv-webhook-concurrency' },
        }),
      });

    // 1ª chamada vincula e confirma com sucesso
    const res1 = await handleAsaasWebhookRequest(makeWebhookReq('pay_asaas_unique_100'), {
      supabaseUrl: 'https://test.supabase.co',
      supabaseServiceRoleKey: 'service-role-key',
      asaasWebhookToken: 'segredo-oficial-servidor',
      asaasApiKey: 'test_asaas_key_not_real',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: mockFetchWebhook,
    });
    assert.equal(res1.status, 200);
    assert.equal(invoices[0].external_reference, 'pay_asaas_unique_100');

    // 2ª chamada concorrente com outro payId para a mesma fatura é rejeitada com 422 sem sobrescrever o external_reference
    const mockFetchDifferentPay: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          id: 'pay_asaas_intruder_200',
          status: 'CONFIRMED',
          value: 149.0,
          billingType: 'PIX',
          externalReference: 'inv-webhook-concurrency',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );

    const res2 = await handleAsaasWebhookRequest(makeWebhookReq('pay_asaas_intruder_200'), {
      supabaseUrl: 'https://test.supabase.co',
      supabaseServiceRoleKey: 'service-role-key',
      asaasWebhookToken: 'segredo-oficial-servidor',
      asaasApiKey: 'test_asaas_key_not_real',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: mockFetchDifferentPay,
    });
    assert.equal(res2.status, 422);
    assert.equal(invoices[0].external_reference, 'pay_asaas_unique_100', 'Não sobrescreve referência externa!');
  });

  it('15. Proteção de checkout de Cartão de Crédito contra clique duplo e repetição após resposta incerta', async () => {
    const { fakeSupabaseClient, invoices, restaurants } = createFakeServerEnvironment();

    let cardPostPaymentsCount = 0;
    let releaseFirstCardPost!: () => void;
    const firstCardPostStarted = new Promise<void>((resolve) => {
      releaseFirstCardPost = resolve;
    });
    let allowFirstCardPostToFinish!: () => void;
    const finishFirstCardPost = new Promise<void>((resolve) => {
      allowFirstCardPostToFinish = resolve;
    });

    const mockFetchCard: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (method === 'GET' && url.includes('/customers?cpfCnpj=')) {
        return new Response(JSON.stringify({ data: [{ id: 'cus_card_01' }] }), { status: 200 });
      }

      if (method === 'POST' && url.endsWith('/payments')) {
        cardPostPaymentsCount += 1;
        if (cardPostPaymentsCount === 1) {
          releaseFirstCardPost();
          await finishFirstCardPost;
        }
        return new Response(
          JSON.stringify({
            id: 'pay_card_concurrent_01',
            status: 'CONFIRMED',
            value: 149.0,
            billingType: 'CREDIT_CARD',
            externalReference: invoices[0]?.id || 'inv-card-gen',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (method === 'GET' && url.endsWith('/payments/pay_card_concurrent_01')) {
        return new Response(
          JSON.stringify({
            id: 'pay_card_concurrent_01',
            status: 'CONFIRMED',
            value: 149.0,
            billingType: 'CREDIT_CARD',
            externalReference: invoices[0]?.id || 'inv-card-gen',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      throw new Error(`Unexpected call: ${method} ${url}`);
    };

    const makeCardCheckoutReq = () =>
      new Request('https://edge.local/asaas-checkout', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-jwt',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          restaurantId: 'rest-1',
          targetPlan: 'pro',
          billingCycle: 'monthly',
          paymentMethod: 'credit_card',
          cardData: {
            card_number: '5555444433332222',
            holder_name: 'JOAO SILVA',
            exp_month: '12',
            exp_year: '2028',
            cvv: '123',
            card_brand: 'mastercard',
            card_last4: '2222',
          },
          payerInfo: { cpfCnpj: '12345678909' },
        }),
      });

    // Requisição 1 de cartão inicia e pausa dentro do POST /payments
    const pCard1 = handleAsaasCheckoutRequest(makeCardCheckoutReq(), {
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-key',
      supabaseServiceRoleKey: 'service-role-key',
      asaasApiKey: 'test_asaas_key_not_real',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: mockFetchCard,
    });

    await firstCardPostStarted;

    // Requisição 2 concorrente (clique duplo do usuário com cartão) chega enquanto o 1º POST ainda está acontecendo
    const resCard2 = await handleAsaasCheckoutRequest(makeCardCheckoutReq(), {
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-key',
      supabaseServiceRoleKey: 'service-role-key',
      asaasApiKey: 'test_asaas_key_not_real',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: mockFetchCard,
    });

    // Deve receber 409 processing: true sem executar novo POST
    assert.equal(resCard2.status, 409);
    const bodyCard2 = await resCard2.json();
    assert.equal(bodyCard2.processing, true);
    assert.equal(cardPostPaymentsCount, 1, 'Clique duplo no cartão não pode emitir segundo POST /payments!');

    // Libera a requisição 1 para concluir com sucesso
    allowFirstCardPostToFinish();
    const resCard1 = await pCard1;
    assert.equal(resCard1.status, 200);
    const bodyCard1 = await resCard1.json();
    assert.equal(bodyCard1.status, 'paid');
    assert.equal(restaurants['rest-1'].subscription_plan, 'pro');
    assert.equal(cardPostPaymentsCount, 1, 'Total de POSTs de cartão deve ser estritamente 1');

    // Requisição subsequente após a conclusão recupera cobrança sem novo POST
    const resCard3 = await handleAsaasCheckoutRequest(makeCardCheckoutReq(), {
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-key',
      supabaseServiceRoleKey: 'service-role-key',
      asaasApiKey: 'test_asaas_key_not_real',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: mockFetchCard,
    });
    assert.equal(resCard3.status, 200);
    const bodyCard3 = await resCard3.json();
    assert.equal(bodyCard3.already_paid, true);
    assert.equal(cardPostPaymentsCount, 1);
  });

  it('16. Cartão em needs_reconciliation: falha ao vincular referência retorna reconciliação segura e preserva a fatura sem novo POST', async () => {
    let postPaymentsCount = 0;
    const { fakeSupabaseClient, invoices } = createFakeServerEnvironment({
      invoices: [
        {
          id: 'inv-card-reconcile-attach-fail',
          restaurant_id: 'rest-1',
          plan_id: 'pro',
          billing_cycle: 'monthly',
          amount_cents: 14900,
          payment_method: 'credit_card',
          status: 'pending',
          pix_qr_code_payload: null,
          pix_expires_at: null,
          card_brand: 'visa',
          card_last4: '1111',
          external_reference: null,
          gateway_emission_status: 'needs_reconciliation',
          paid_at: null,
          created_by: 'user-admin-1',
          created_at: new Date().toISOString(),
        },
      ],
    });

    // Sobrescrever RPC attach para simular falha de banco de dados
    const originalRpc = fakeSupabaseClient.rpc.bind(fakeSupabaseClient);
    fakeSupabaseClient.rpc = async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'attach_subscription_invoice_external_reference') {
        return { data: null, error: { message: 'DB connection error during attach' } };
      }
      return originalRpc(fn, args);
    };

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method || 'GET';
      if (method === 'GET' && url.includes('/payments?externalReference=')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'pay_card_reconcile_01',
                status: 'CONFIRMED',
                value: 149.0,
                billingType: 'CREDIT_CARD',
                externalReference: 'inv-card-reconcile-attach-fail',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (method === 'POST' && url.endsWith('/payments')) {
        postPaymentsCount += 1;
        throw new Error('Não deve fazer POST');
      }
      throw new Error(`Unexpected: ${url}`);
    };

    const req = new Request('https://edge.local/asaas-checkout', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-jwt', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        restaurantId: 'rest-1',
        targetPlan: 'pro',
        billingCycle: 'monthly',
        paymentMethod: 'credit_card',
        cardData: {
          card_number: '5555444433331111',
          holder_name: 'JOAO SILVA',
          exp_month: '12',
          exp_year: '2028',
          cvv: '123',
          card_brand: 'visa',
          card_last4: '1111',
        },
        payerInfo: { cpfCnpj: '12345678909' },
      }),
    });

    const res = await handleAsaasCheckoutRequest(req, {
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-key',
      supabaseServiceRoleKey: 'service-role-key',
      asaasApiKey: 'test_asaas_key_not_real',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: mockFetch,
    });

    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.needs_reconciliation, true);
    assert.equal(invoices[0].status, 'pending', 'Fatura deve ser preservada como pendente');
    assert.equal(invoices[0].external_reference, null, 'Referência externa não deve ser gravada');
    assert.equal(postPaymentsCount, 0, 'Zero novos POST /payments');
  });

  it('17. Cartão em needs_reconciliation: falha ao confirmar pagamento retorna reconciliação e não ativa plano', async () => {
    let postPaymentsCount = 0;
    const { fakeSupabaseClient, invoices, restaurants } = createFakeServerEnvironment({
      invoices: [
        {
          id: 'inv-card-reconcile-confirm-fail',
          restaurant_id: 'rest-1',
          plan_id: 'pro',
          billing_cycle: 'monthly',
          amount_cents: 14900,
          payment_method: 'credit_card',
          status: 'pending',
          pix_qr_code_payload: null,
          pix_expires_at: null,
          card_brand: 'visa',
          card_last4: '1111',
          external_reference: null,
          gateway_emission_status: 'needs_reconciliation',
          paid_at: null,
          created_by: 'user-admin-1',
          created_at: new Date().toISOString(),
        },
      ],
    });

    const originalRpc = fakeSupabaseClient.rpc.bind(fakeSupabaseClient);
    fakeSupabaseClient.rpc = async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'confirm_subscription_invoice_payment') {
        return { data: null, error: { message: 'Lock error or constraint failure during confirm' } };
      }
      return originalRpc(fn, args);
    };

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method || 'GET';
      if (method === 'GET' && url.includes('/payments?externalReference=')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'pay_card_reconcile_02',
                status: 'CONFIRMED',
                value: 149.0,
                billingType: 'CREDIT_CARD',
                externalReference: 'inv-card-reconcile-confirm-fail',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (method === 'POST' && url.endsWith('/payments')) {
        postPaymentsCount += 1;
        throw new Error('Não deve fazer POST');
      }
      throw new Error(`Unexpected: ${url}`);
    };

    const req = new Request('https://edge.local/asaas-checkout', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-jwt', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        restaurantId: 'rest-1',
        targetPlan: 'pro',
        billingCycle: 'monthly',
        paymentMethod: 'credit_card',
        cardData: {
          card_number: '5555444433331111',
          holder_name: 'JOAO SILVA',
          exp_month: '12',
          exp_year: '2028',
          cvv: '123',
          card_brand: 'visa',
          card_last4: '1111',
        },
        payerInfo: { cpfCnpj: '12345678909' },
      }),
    });

    const res = await handleAsaasCheckoutRequest(req, {
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-key',
      supabaseServiceRoleKey: 'service-role-key',
      asaasApiKey: 'test_asaas_key_not_real',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: mockFetch,
    });

    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.needs_reconciliation, true);
    assert.equal(invoices[0].status, 'pending', 'Fatura não deve ser marcada como paga');
    assert.equal(restaurants['rest-1'].subscription_plan, 'basic', 'Plano não deve ser alterado');
    assert.equal(postPaymentsCount, 0, 'Zero novos POST /payments');
  });

  it('18. Falha ao vincular após POST de cartão marca como incerto e retentativa não emite novo POST', async () => {
    let postPaymentsCount = 0;
    const { fakeSupabaseClient, invoices } = createFakeServerEnvironment();

    let simulateAttachFailure = true;
    const originalRpc = fakeSupabaseClient.rpc.bind(fakeSupabaseClient);
    fakeSupabaseClient.rpc = async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'attach_subscription_invoice_external_reference' && simulateAttachFailure) {
        return { data: null, error: { message: 'Database deadlock during post-payment attach' } };
      }
      return originalRpc(fn, args);
    };

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (method === 'GET' && url.includes('/customers?cpfCnpj=')) {
        return new Response(JSON.stringify({ data: [{ id: 'cus_attach_fail' }] }), { status: 200 });
      }

      if (method === 'POST' && url.endsWith('/payments')) {
        postPaymentsCount += 1;
        return new Response(
          JSON.stringify({
            id: 'pay_card_attach_fail_01',
            status: 'CONFIRMED',
            value: 149.0,
            billingType: 'CREDIT_CARD',
            externalReference: invoices[0]?.id || 'inv-gen-1',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (method === 'GET' && url.includes('/payments?externalReference=')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'pay_card_attach_fail_01',
                status: 'CONFIRMED',
                value: 149.0,
                billingType: 'CREDIT_CARD',
                externalReference: invoices[0]?.id || 'inv-gen-1',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      throw new Error(`Unexpected: ${url}`);
    };

    const makeReq = () =>
      new Request('https://edge.local/asaas-checkout', {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restaurantId: 'rest-1',
          targetPlan: 'pro',
          billingCycle: 'monthly',
          paymentMethod: 'credit_card',
          cardData: {
            card_number: '5555444433333333',
            holder_name: 'JOAO SILVA',
            exp_month: '12',
            exp_year: '2028',
            cvv: '123',
            card_brand: 'mastercard',
            card_last4: '3333',
          },
          payerInfo: { cpfCnpj: '12345678909' },
        }),
      });

    // 1ª chamada: POST tem sucesso no Asaas, mas attach falha no banco
    const res1 = await handleAsaasCheckoutRequest(makeReq(), {
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-key',
      supabaseServiceRoleKey: 'service-role-key',
      asaasApiKey: 'test_asaas_key_not_real',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: mockFetch,
    });

    assert.equal(res1.status, 409);
    const body1 = await res1.json();
    assert.equal(body1.needs_reconciliation, true);
    assert.equal(postPaymentsCount, 1);
    assert.equal(invoices[0].gateway_emission_status, 'needs_reconciliation');

    // 2ª chamada (retentativa): attach agora funciona; deve reconciliar e confirmar SEM novo POST
    simulateAttachFailure = false;
    const res2 = await handleAsaasCheckoutRequest(makeReq(), {
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-key',
      supabaseServiceRoleKey: 'service-role-key',
      asaasApiKey: 'test_asaas_key_not_real',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: mockFetch,
    });

    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    assert.equal(body2.status, 'paid');
    assert.equal(body2.asaas_payment_id, 'pay_card_attach_fail_01');
    assert.equal(postPaymentsCount, 1, 'Não deve fazer novo POST /payments ao tentar novamente!');
  });

  it('19. attach_subscription_invoice_external_reference com resposta nula ou inconsistente retorna 409 e retry não faz novo POST', async () => {
    let postPaymentsCount = 0;
    const { fakeSupabaseClient, invoices } = createFakeServerEnvironment();

    let rpcResponseMode: 'null' | 'inconsistent' | 'valid' = 'null';
    const originalRpc = fakeSupabaseClient.rpc.bind(fakeSupabaseClient);
    fakeSupabaseClient.rpc = async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'attach_subscription_invoice_external_reference') {
        if (rpcResponseMode === 'null') {
          return { data: null, error: null };
        }
        if (rpcResponseMode === 'inconsistent') {
          return { data: { attached: false }, error: null };
        }
      }
      return originalRpc(fn, args);
    };

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (method === 'GET' && url.includes('/customers?cpfCnpj=')) {
        return new Response(JSON.stringify({ data: [{ id: 'cus_attach_null' }] }), { status: 200 });
      }

      if (method === 'POST' && url.endsWith('/payments')) {
        postPaymentsCount += 1;
        return new Response(
          JSON.stringify({
            id: 'pay_card_attach_null_01',
            status: 'CONFIRMED',
            value: 149.0,
            billingType: 'CREDIT_CARD',
            externalReference: invoices[0]?.id || 'inv-gen-1',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (method === 'GET' && url.includes('/payments?externalReference=')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'pay_card_attach_null_01',
                status: 'CONFIRMED',
                value: 149.0,
                billingType: 'CREDIT_CARD',
                externalReference: invoices[0]?.id || 'inv-gen-1',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      throw new Error(`Unexpected: ${url}`);
    };

    const makeReq = () =>
      new Request('https://edge.local/asaas-checkout', {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restaurantId: 'rest-1',
          targetPlan: 'pro',
          billingCycle: 'monthly',
          paymentMethod: 'credit_card',
          cardData: {
            card_number: '5555444433334444',
            holder_name: 'JOAO SILVA',
            exp_month: '12',
            exp_year: '2028',
            cvv: '123',
            card_brand: 'mastercard',
            card_last4: '4444',
          },
          payerInfo: { cpfCnpj: '12345678909' },
        }),
      });

    // 1ª chamada: POST acontece, mas attach retorna data: null
    const res1 = await handleAsaasCheckoutRequest(makeReq(), {
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-key',
      supabaseServiceRoleKey: 'service-role-key',
      asaasApiKey: 'test_asaas_key_not_real',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: mockFetch,
    });

    assert.equal(res1.status, 409);
    const body1 = await res1.json();
    assert.equal(body1.needs_reconciliation, true);
    assert.equal(postPaymentsCount, 1);
    assert.equal(invoices[0].gateway_emission_status, 'needs_reconciliation');

    // 2ª chamada (retry durante reconciliação): attach retorna data: { attached: false } (inconsistente)
    rpcResponseMode = 'inconsistent';
    const res2 = await handleAsaasCheckoutRequest(makeReq(), {
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-key',
      supabaseServiceRoleKey: 'service-role-key',
      asaasApiKey: 'test_asaas_key_not_real',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: mockFetch,
    });

    assert.equal(res2.status, 409);
    const body2 = await res2.json();
    assert.equal(body2.needs_reconciliation, true);
    assert.equal(postPaymentsCount, 1, 'Não deve fazer novo POST ao retornar inconsistente na reconciliação');

    // 3ª chamada: attach retorna { attached: true } e conclui com sucesso
    rpcResponseMode = 'valid';
    const res3 = await handleAsaasCheckoutRequest(makeReq(), {
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-key',
      supabaseServiceRoleKey: 'service-role-key',
      asaasApiKey: 'test_asaas_key_not_real',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: mockFetch,
    });

    assert.equal(res3.status, 200);
    const body3 = await res3.json();
    assert.equal(body3.status, 'paid');
    assert.equal(body3.asaas_payment_id, 'pay_card_attach_null_01');
    assert.equal(postPaymentsCount, 1, 'Zero novo POST /payments');
  });

  it('20. Retomada de fatura com referência existente: confirm_subscription_invoice_payment com resposta nula ou inconsistente retorna reconciliação sem novo POST', async () => {
    let postPaymentsCount = 0;
    const { fakeSupabaseClient, invoices, restaurants } = createFakeServerEnvironment({
      invoices: [
        {
          id: 'inv-card-resume-confirm-inconsistent',
          restaurant_id: 'rest-1',
          plan_id: 'pro',
          billing_cycle: 'monthly',
          amount_cents: 14900,
          payment_method: 'credit_card',
          status: 'pending',
          pix_qr_code_payload: null,
          pix_expires_at: null,
          card_brand: 'visa',
          card_last4: '5555',
          external_reference: 'pay_card_resume_5555',
          gateway_emission_status: 'issued',
          paid_at: null,
          created_by: 'user-admin-1',
          created_at: new Date().toISOString(),
        },
      ],
    });

    let confirmMode: 'null' | 'inconsistent' | 'valid' = 'null';
    const originalRpc = fakeSupabaseClient.rpc.bind(fakeSupabaseClient);
    fakeSupabaseClient.rpc = async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'confirm_subscription_invoice_payment') {
        if (confirmMode === 'null') {
          return { data: null, error: null };
        }
        if (confirmMode === 'inconsistent') {
          return { data: { status: 'unexpected_state' }, error: null };
        }
      }
      return originalRpc(fn, args);
    };

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method || 'GET';
      if (method === 'GET' && url.endsWith('/payments/pay_card_resume_5555')) {
        return new Response(
          JSON.stringify({
            id: 'pay_card_resume_5555',
            status: 'RECEIVED',
            value: 149.0,
            billingType: 'CREDIT_CARD',
            externalReference: 'inv-card-resume-confirm-inconsistent',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (method === 'POST' && url.endsWith('/payments')) {
        postPaymentsCount += 1;
        throw new Error('Não deve fazer POST');
      }
      throw new Error(`Unexpected: ${url}`);
    };

    const reqMaker = () =>
      new Request('https://edge.local/asaas-checkout', {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-jwt', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restaurantId: 'rest-1',
          targetPlan: 'pro',
          billingCycle: 'monthly',
          paymentMethod: 'credit_card',
          cardData: {
            card_number: '5555444433335555',
            holder_name: 'JOAO SILVA',
            exp_month: '12',
            exp_year: '2028',
            cvv: '123',
            card_brand: 'visa',
            card_last4: '5555',
          },
          payerInfo: { cpfCnpj: '12345678909' },
        }),
      });

    // 1ª tentativa: confirm_subscription_invoice_payment retorna data: null
    const res1 = await handleAsaasCheckoutRequest(reqMaker(), {
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-key',
      supabaseServiceRoleKey: 'service-role-key',
      asaasApiKey: 'test_asaas_key_not_real',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: mockFetch,
    });

    assert.equal(res1.status, 409);
    const body1 = await res1.json();
    assert.equal(body1.needs_reconciliation, true);
    assert.equal(invoices[0].status, 'pending', 'Fatura permanece em pending');
    assert.equal(restaurants['rest-1'].subscription_plan, 'basic', 'Plano não alterado');
    assert.equal(postPaymentsCount, 0, 'Zero novos POST');

    // 2ª tentativa: confirm_subscription_invoice_payment retorna { status: 'unexpected_state' }
    confirmMode = 'inconsistent';
    const res2 = await handleAsaasCheckoutRequest(reqMaker(), {
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-key',
      supabaseServiceRoleKey: 'service-role-key',
      asaasApiKey: 'test_asaas_key_not_real',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: mockFetch,
    });

    assert.equal(res2.status, 409);
    const body2 = await res2.json();
    assert.equal(body2.needs_reconciliation, true);
    assert.equal(invoices[0].status, 'pending', 'Fatura permanece em pending');
    assert.equal(postPaymentsCount, 0, 'Zero novos POST');

    // 3ª tentativa: resposta normal confirmando status === "paid"
    confirmMode = 'valid';
    const res3 = await handleAsaasCheckoutRequest(reqMaker(), {
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-key',
      supabaseServiceRoleKey: 'service-role-key',
      asaasApiKey: 'test_asaas_key_not_real',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: mockFetch,
    });

    assert.equal(res3.status, 200);
    const body3 = await res3.json();
    assert.equal(body3.status, 'paid');
    assert.equal(body3.asaas_payment_id, 'pay_card_resume_5555');
    assert.equal(postPaymentsCount, 0, 'Zero novos POST');
  });

  it('21. Etapa 3: Checkout anual calcula 11 mensalidades (monthly * 11) e suporta Premium com unlimited_tables=true e max_tables=null', async () => {
    const { fakeSupabaseClient, invoices, restaurants } = createFakeServerEnvironment({
      platformSettings: [
        {
          id: 'default',
          basic_price_cents: 9990,
          pro_price_cents: 17990,
          premium_price_cents: 27990,
          basic_max_tables: 5,
          pro_max_tables: 20,
          premium_max_tables: null,
          basic_unlimited_tables: false,
          pro_unlimited_tables: false,
          premium_unlimited_tables: true,
        },
      ],
    });

    const postedValues: number[] = [];
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method || 'GET';

      if (method === 'GET' && url.includes('/customers?cpfCnpj=')) {
        return new Response(JSON.stringify({ data: [{ id: 'cus_etapa3' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (method === 'POST' && url.endsWith('/payments')) {
        const body = JSON.parse(String(init?.body || '{}'));
        postedValues.push(Number(body.value));
        return new Response(
          JSON.stringify({
            id: `pay_etapa3_${postedValues.length}`,
            status: 'CONFIRMED',
            value: body.value,
            billingType: 'CREDIT_CARD',
            externalReference: body.externalReference,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      throw new Error(`Unexpected call: ${method} ${url}`);
    };

    const reqPremiumYearly = new Request('https://edge.local/asaas-checkout', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-jwt', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        restaurantId: 'rest-1',
        targetPlan: 'premium',
        billingCycle: 'yearly',
        paymentMethod: 'credit_card',
        cardData: {
          card_number: '5555444433339999',
          holder_name: 'MARIA SILVA',
          exp_month: '10',
          exp_year: '2029',
          cvv: '999',
          card_brand: 'mastercard',
          card_last4: '9999',
        },
        payerInfo: { cpfCnpj: '12345678909' },
      }),
    });

    const res = await handleAsaasCheckoutRequest(reqPremiumYearly, {
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'anon-key',
      supabaseServiceRoleKey: 'service-role-key',
      asaasApiKey: 'test_asaas_key_not_real',
      asaasBaseUrl: 'https://sandbox.asaas.com/api/v3',
      createSupabaseClient: () => fakeSupabaseClient,
      fetchFn: mockFetch,
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    // 27990 * 11 = 307890 cents (R$ 3.078,90)
    assert.equal(body.amount_cents, 307890);
    assert.equal(postedValues[0], 3078.9);
    assert.equal(body.unlimited_tables, true);
    assert.equal(body.max_tables, null);
    assert.equal(invoices[0].amount_cents, 307890);
    assert.equal(restaurants['rest-1'].subscription_plan, 'premium');
  });
});

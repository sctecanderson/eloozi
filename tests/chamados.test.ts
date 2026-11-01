import test from 'node:test';
import assert from 'node:assert/strict';

import { supabase } from '../src/lib/supabase';
import { isQueryTimeoutError } from '../src/lib/queryErrors';
import { createRefreshCoalescer } from '../src/lib/refreshCoalescer';
import {
  calculateChamadosSummary,
  formatBadgeCount,
  formatElapsedTime,
  formatToastMessage,
  isKdsPlanLimitation,
  processIncomingChamados,
  purgeResolvedToasts,
  fetchPendingChamados,
  executeDeliverReadyOrder,
  executeAttendWaiterCall,
  executeAttendBillRequest,
  shouldRefreshReadyOrderQueue,
  type ChamadoItem,
  type ToastNotification,
} from '../src/features/service/staffChamados';

test('timeout de consulta é classificado como falha temporária, não como ausência de acesso', () => {
  assert.equal(isQueryTimeoutError({ code: '57014', message: 'canceling statement due to statement timeout' }), true);
  assert.equal(isQueryTimeoutError({ status: 504, message: 'gateway timeout' }), true);
  assert.equal(isQueryTimeoutError({ code: '42501', message: 'permission denied' }), false);
});

test('só mudanças que entram ou saem da fila pronta disparam nova leitura dos chamados', () => {
  assert.equal(shouldRefreshReadyOrderQueue({ new: { production_status: 'preparing' } }), false);
  assert.equal(shouldRefreshReadyOrderQueue({ new: { production_status: 'ready' } }), true);
  assert.equal(shouldRefreshReadyOrderQueue({ new: { production_status: 'delivered' } }), true);
  assert.equal(shouldRefreshReadyOrderQueue({ old: { production_status: 'ready' } }), true);
});

test('recargas simultâneas são serializadas e agrupadas em uma única atualização posterior', async () => {
  let calls = 0;
  let releaseFirst: (() => void) | undefined;
  const coalescer = createRefreshCoalescer(async () => {
    calls++;
    if (calls === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
  }, 5);

  const first = coalescer.request();
  await Promise.resolve();
  const second = coalescer.request();
  const third = coalescer.request();
  assert.equal(calls, 1, 'uma rajada não deve abrir consultas concorrentes');
  releaseFirst?.();
  await Promise.all([first, second, third]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  coalescer.dispose();
  assert.equal(calls, 2, 'múltiplos eventos durante a consulta geram uma única recarga posterior');
});

// ============================================================================
// HARNESS DE CONTROLE DO CLIENTE SUPABASE PARA TESTES DAS OPERAÇÕES REAIS
// ============================================================================

interface InterceptedRpcCall {
  fn: string;
  args: Record<string, unknown>;
}

let interceptedRpcCalls: InterceptedRpcCall[] = [];
let mockRpcHandler: ((fn: string, args: Record<string, unknown>) => { data: unknown; error: unknown }) | null = null;
let mockFromHandler: ((table: string) => any) | null = null;

function resetHarness() {
  interceptedRpcCalls = [];
  mockRpcHandler = null;
  mockFromHandler = null;
}

function makeRpcBuilder(res: { data: unknown; error: unknown }) {
  const promise = Promise.resolve(res);
  const builder: any = {
    single: () => builder,
    maybeSingle: () => builder,
    overrideTypes: () => builder,
    then: (onfulfilled: any, onrejected: any) => promise.then(onfulfilled, onrejected),
    catch: (onrejected: any) => promise.catch(onrejected),
  };
  return builder;
}

// Configura o interceptor de RPCs
supabase.rpc = function (fn: string, args: Record<string, unknown>) {
  interceptedRpcCalls.push({ fn, args });

  if (mockRpcHandler) {
    const res = mockRpcHandler(fn, args);
    return makeRpcBuilder(res);
  }

  return makeRpcBuilder({ data: null, error: null });
} as any;

// Interceptor de consultas from()
const originalFrom = supabase.from.bind(supabase);
supabase.from = function (table: string) {
  if (mockFromHandler) {
    return mockFromHandler(table);
  }
  return originalFrom(table);
} as any;

// ============================================================================
// 1. CONTAGEM, SUMÁRIO E AUSÊNCIA DE DUPLICIDADE
// ============================================================================

test('1.1 calculateChamadosSummary: soma categorias e total sem duplicidade mesmo com registros duplicados na entrada', () => {
  const itemsWithDuplicates: ChamadoItem[] = [
    {
      id: 'kds-1',
      category: 'ready_order',
      tableNumber: 1,
      tableName: 'Mesa 01',
      description: '1x Filé Mignon',
      createdAt: '2026-10-25T19:00:00Z',
      status: 'ready',
    },
    // DUPLICATA DO KDS-1
    {
      id: 'kds-1',
      category: 'ready_order',
      tableNumber: 1,
      tableName: 'Mesa 01',
      description: '1x Filé Mignon (duplicado)',
      createdAt: '2026-10-25T19:00:00Z',
      status: 'ready',
    },
    {
      id: 'kds-2',
      category: 'ready_order',
      tableNumber: 3,
      tableName: 'Mesa 03',
      description: '2x Suco Natural',
      createdAt: '2026-10-25T19:05:00Z',
      status: 'ready',
    },
    {
      id: 'waiter-1',
      category: 'waiter_call',
      tableNumber: 5,
      tableName: 'Mesa 05',
      description: 'Cliente solicitou atendimento',
      createdAt: '2026-10-25T19:10:00Z',
      status: 'pending',
    },
    // DUPLICATA DO WAITER-1
    {
      id: 'waiter-1',
      category: 'waiter_call',
      tableNumber: 5,
      tableName: 'Mesa 05',
      description: 'Chamado repetido',
      createdAt: '2026-10-25T19:10:00Z',
      status: 'pending',
    },
    {
      id: 'bill-1',
      category: 'bill_request',
      tableNumber: 2,
      tableName: 'Mesa 02',
      description: 'Cliente pediu a conta',
      createdAt: '2026-10-25T19:12:00Z',
      status: 'pending',
      includeServiceFee: true,
    },
  ];

  const summary = calculateChamadosSummary(itemsWithDuplicates);

  assert.equal(summary.readyOrdersCount, 2, 'Deve contar exatamente 2 pedidos prontos únicos');
  assert.equal(summary.waiterCallsCount, 1, 'Deve contar exatamente 1 chamado de garçom único');
  assert.equal(summary.billRequestsCount, 1, 'Deve contar exatamente 1 pedido de conta único');
  assert.equal(summary.totalPendingCount, 4, 'O total deve ser 4 ignorando qualquer duplicata');
});

test('1.2 calculateChamadosSummary: lista vazia retorna todos contadores zerados', () => {
  const summary = calculateChamadosSummary([]);

  assert.equal(summary.readyOrdersCount, 0);
  assert.equal(summary.waiterCallsCount, 0);
  assert.equal(summary.billRequestsCount, 0);
  assert.equal(summary.totalPendingCount, 0);
});

// ============================================================================
// 2. FORMATAÇÃO DO BADGE NO MENU INFERIOR
// ============================================================================

test('2.1 formatBadgeCount: esconde o badge quando total for zero ou negativo', () => {
  assert.equal(formatBadgeCount(0), null, 'Zero pendências não deve exibir badge');
  assert.equal(formatBadgeCount(-1), null, 'Valor negativo não deve exibir badge');
  assert.equal(formatBadgeCount(Number.NaN), null, 'NaN não deve exibir badge');
});

test('2.2 formatBadgeCount: formata valores inteiros corretamente (1, 2, 10, 99)', () => {
  assert.equal(formatBadgeCount(1), '1');
  assert.equal(formatBadgeCount(2), '2');
  assert.equal(formatBadgeCount(10), '10');
  assert.equal(formatBadgeCount(99), '99');
});

// ============================================================================
// 3. MENSAGENS COMPACTAS DO POPUP DESLIZANTE DO TOPO
// ============================================================================

test('3.1 formatToastMessage: gera avisos exatos conforme a especificação', () => {
  // Chamado do garçom
  const waiterMsg = formatToastMessage({
    category: 'waiter_call',
    tableNumber: 5,
  });
  assert.equal(waiterMsg, 'Mesa 05 chamou o garçom');

  // Pedido de conta
  const billMsg = formatToastMessage({
    category: 'bill_request',
    tableNumber: 2,
  });
  assert.equal(billMsg, 'Mesa 02 pediu a conta');

  // Pedido pronto na cozinha
  const kdsKitchenMsg = formatToastMessage({
    category: 'ready_order',
    tableNumber: 8,
    preparationStation: 'kitchen',
  });
  assert.equal(kdsKitchenMsg, 'Pedido da Mesa 08 pronto na cozinha');

  // Pedido pronto no bar
  const kdsBarMsg = formatToastMessage({
    category: 'ready_order',
    tableNumber: 4,
    preparationStation: 'bar',
  });
  assert.equal(kdsBarMsg, 'Pedido da Mesa 04 pronto na copa/bar');
});

// ============================================================================
// 4. TEMPO DECORRIDO REAL A PARTIR DO TIMESTAMP
// ============================================================================

test('4.1 formatElapsedTime: calcula minutos e horas a partir de timestamp real', () => {
  const baseTime = 1729880000000;

  // Menos de 1 minuto atrás
  const justNow = new Date(baseTime - 20000).toISOString();
  assert.equal(formatElapsedTime(justNow, baseTime), 'Agora');

  // 12 minutos atrás
  const twelveMinsAgo = new Date(baseTime - 12 * 60000).toISOString();
  assert.equal(formatElapsedTime(twelveMinsAgo, baseTime), '12min');

  // 1 hora e 24 minutos atrás
  const oneHour24MinsAgo = new Date(baseTime - (84 * 60000)).toISOString();
  assert.equal(formatElapsedTime(oneHour24MinsAgo, baseTime), '1h 24min');

  // Exatamente 2 horas atrás
  const twoHoursAgo = new Date(baseTime - (120 * 60000)).toISOString();
  assert.equal(formatElapsedTime(twoHoursAgo, baseTime), '2h');

  // Timestamp inválido cai em fallback seguro
  assert.equal(formatElapsedTime('data-invalida', baseTime), 'Agora');
});

// ============================================================================
// 5. DEDUPLICAÇÃO E FILA USANDO FUNÇÕES REAIS DE PRODUÇÃO
// ============================================================================

test('5.1 processIncomingChamados: carga inicial indexa IDs sem disparar popups', () => {
  const initialItems: ChamadoItem[] = [
    {
      id: 'req-1',
      category: 'waiter_call',
      tableNumber: 1,
      tableName: 'Mesa 01',
      description: 'Chamado',
      createdAt: '2026-10-25T19:00:00Z',
      status: 'pending',
    },
    {
      id: 'req-2',
      category: 'bill_request',
      tableNumber: 2,
      tableName: 'Mesa 02',
      description: 'Conta',
      createdAt: '2026-10-25T19:01:00Z',
      status: 'pending',
    },
  ];

  const result = processIncomingChamados(initialItems, new Set(), true);

  assert.equal(result.newToasts.length, 0, 'Carga inicial não deve enfileirar popups');
  assert.equal(result.shouldPlaySound, null, 'Carga inicial não deve tocar som');
  assert.equal(result.updatedKnownIds.has('req-1'), true);
  assert.equal(result.updatedKnownIds.has('req-2'), true);
});

test('5.2 processIncomingChamados: nova chegada durante uso enfileira toast e som, e deduplica chegadas repetidas', () => {
  const knownIds = new Set(['req-1', 'req-2']);

  const currentItems: ChamadoItem[] = [
    {
      id: 'req-1',
      category: 'waiter_call',
      tableNumber: 1,
      tableName: 'Mesa 01',
      description: 'Chamado existente',
      createdAt: '2026-10-25T19:00:00Z',
      status: 'pending',
    },
    {
      id: 'req-3',
      category: 'ready_order',
      tableNumber: 8,
      tableName: 'Mesa 08',
      description: 'Item novo',
      createdAt: '2026-10-25T19:05:00Z',
      status: 'ready',
    },
  ];

  // Primeira passagem com item novo
  const firstPass = processIncomingChamados(currentItems, knownIds, false);
  assert.equal(firstPass.newToasts.length, 1);
  assert.equal(firstPass.newToasts[0].chamadoId, 'req-3');
  assert.equal(firstPass.shouldPlaySound, 'ready');
  assert.equal(firstPass.updatedKnownIds.has('req-3'), true);

  // Segunda passagem imediata (ex: re-render) com o mesmo estado
  const secondPass = processIncomingChamados(currentItems, firstPass.updatedKnownIds, false);
  assert.equal(secondPass.newToasts.length, 0, 'Item repetido não deve gerar popup duplicado');
  assert.equal(secondPass.shouldPlaySound, null);
});

test('5.3 purgeResolvedToasts: remove da fila chamados atendidos antes do popup aparecer', () => {
  const toastQueue: ToastNotification[] = [
    {
      id: 't-1',
      chamadoId: 'item-1',
      category: 'waiter_call',
      message: 'Mesa 01 chamou o garçom',
      tableNumber: 1,
      createdAt: Date.now(),
    },
    {
      id: 't-2',
      chamadoId: 'item-2',
      category: 'bill_request',
      message: 'Mesa 02 pediu a conta',
      tableNumber: 2,
      createdAt: Date.now(),
    },
  ];

  // item-1 foi resolvido no banco; apenas item-2 continua pendente
  const currentlyPending: ChamadoItem[] = [
    {
      id: 'item-2',
      category: 'bill_request',
      tableNumber: 2,
      tableName: 'Mesa 02',
      description: 'Conta',
      createdAt: '2026-10-25T19:00:00Z',
      status: 'pending',
    },
  ];

  const updatedQueue = purgeResolvedToasts(toastQueue, currentlyPending);
  assert.equal(updatedQueue.length, 1);
  assert.equal(updatedQueue[0].chamadoId, 'item-2');
});

// ============================================================================
// 6. DIFERENCIAÇÃO DE PLANO VS FALHA PARCIAL E PRESERVAÇÃO DE DADOS ANTERIORES
// ============================================================================

test('6.1 isKdsPlanLimitation: identifica restrição por plano básico sem confundir com erro técnico', () => {
  const planError = new Error('O módulo KDS é exclusivo para planos Pro e Premium. Faça upgrade para acessar a esteira de produção.');
  assert.equal(isKdsPlanLimitation(planError), true, 'Deve reconhecer limitação de plano');

  const networkError = new Error('Failed to fetch: connection refused');
  assert.equal(isKdsPlanLimitation(networkError), false, 'Erro de rede não é limitação de plano');

  const permError = new Error('permission denied for table table_tab_items (code 42501)');
  assert.equal(isKdsPlanLimitation(permError), false, 'Erro de permissão não é limitação de plano');
});

test('6.2 fetchPendingChamados: preserva dados anteriores da categoria em caso de falha parcial', async () => {
  resetHarness();

  // Mock de restaurants (plano básico sem KDS) e service_requests retornando falha de rede
  mockFromHandler = (table: string) => {
    if (table === 'restaurants') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: { id: 'rest-id', subscription_plan: 'basic' }, error: null }),
            }),
          }),
        }),
      };
    }
    if (table === 'service_requests') {
      return {
        select: () => ({
          eq: () => ({
            in: () => ({
              in: () => ({
                order: () => Promise.resolve({
                  data: null,
                  error: { code: '57014', message: 'canceling statement due to statement timeout' },
                }),
              }),
            }),
          }),
        }),
      };
    }
    return originalFrom(table);
  };

  const previousData: ChamadoItem[] = [
    {
      id: 'waiter-antigo',
      category: 'waiter_call',
      tableNumber: 10,
      tableName: 'Mesa 10',
      description: 'Chamado preservado',
      createdAt: '2026-10-25T18:00:00Z',
      status: 'pending',
    },
  ];

  const result = await fetchPendingChamados('rest-slug', 'rest-id', previousData);

  assert.equal(result.isPartial, true, 'Deve sinalizar dados parciais');
  assert.equal(result.kdsAvailable, false, 'Plano básico desativa KDS sem gerar erro técnico');
  assert.match(result.partialWarning || '', /consulta de chamados excedeu o tempo limite/i);
  assert.match(result.partialWarning || '', /acesso foi negado/i);
  assert.equal(result.items.some((i) => i.id === 'waiter-antigo'), true, 'Deve preservar os dados anteriores da categoria');

  resetHarness();
});

// ============================================================================
// 7. OPERAÇÕES AUTORIZADAS NO BANCO REAL
// ============================================================================

test('7.1 executeDeliverReadyOrder: chama update_tab_item_production_status com delivered', async () => {
  resetHarness();

  mockRpcHandler = (fn, args) => {
    assert.equal(fn, 'update_tab_item_production_status');
    assert.equal(args.p_restaurant_slug, 'rest-demo');
    assert.equal(args.p_item_id, 'item-100');
    assert.equal(args.p_target_status, 'delivered');
    return { data: { id: 'item-100', production_status: 'delivered' }, error: null };
  };

  const res = await executeDeliverReadyOrder('rest-demo', 'item-100');
  assert.equal(res.success, true);
  assert.equal(interceptedRpcCalls.length, 1);
});

test('7.2 executeAttendWaiterCall: chama attend_waiter_request com parâmetros corretos', async () => {
  resetHarness();

  mockRpcHandler = (fn, args) => {
    assert.equal(fn, 'attend_waiter_request');
    assert.equal(args.p_restaurant_slug, 'rest-demo');
    assert.equal(args.p_service_request_id, 'req-200');
    return {
      data: {
        id: 'req-200',
        restaurant_id: 'rest-id',
        restaurant_table_id: 'tbl-id',
        table_visit_id: 'visit-id',
        request_type: 'waiter',
        status: 'attended',
        created_at: new Date().toISOString(),
        resolved_at: null,
        resolved_by_member_id: null,
      },
      error: null,
    };
  };

  const res = await executeAttendWaiterCall('rest-demo', 'req-200');
  assert.equal(res.success, true);
  assert.equal(interceptedRpcCalls.length, 1);
});

test('7.3 executeAttendBillRequest: chama attend_table_tab_bill sem fechar comanda ou mesa', async () => {
  resetHarness();

  mockRpcHandler = (fn, args) => {
    assert.equal(fn, 'attend_table_tab_bill');
    assert.equal(args.p_restaurant_slug, 'rest-demo');
    assert.equal(args.p_service_request_id, 'bill-300');
    return {
      data: {
        id: 'bill-300',
        restaurant_id: 'rest-id',
        restaurant_table_id: 'tbl-id',
        table_visit_id: 'visit-id',
        table_tab_id: 'tab-id',
        request_type: 'bill',
        status: 'attended',
        created_at: new Date().toISOString(),
        resolved_at: null,
        resolved_by_member_id: null,
        include_service_fee: true,
      },
      error: null,
    };
  };

  const res = await executeAttendBillRequest('rest-demo', 'bill-300');
  assert.equal(res.success, true);
  assert.equal(interceptedRpcCalls.length, 1);
});

test('7.4 executeAttendBillRequest: propaga erro caso a RPC falhe no servidor', async () => {
  resetHarness();

  mockRpcHandler = (fn) => {
    return {
      data: null,
      error: { code: '42501', message: 'Você não tem permissão para atender esta comanda.' },
    };
  };

  const res = await executeAttendBillRequest('rest-demo', 'bill-300');
  assert.equal(res.success, false);
  assert.match(res.error || '', /Você não tem permissão/);
});

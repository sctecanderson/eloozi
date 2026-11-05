import test from 'node:test';
import assert from 'node:assert/strict';

// Importa a instância real do cliente Supabase e os serviços de produção
import { supabase } from '../src/lib/supabase';
import {
  closeTableTab,
  calculateTabClosureFee,
  calculateTabClosurePreview,
  type TableTab,
} from '../src/features/service/tableTabs';
import { closeTableVisit } from '../src/features/service/tableVisits';
import {
  aggregateOpenTabs,
  collectOpenTabItems,
  createSplitBillBasis,
  getOpenTabIds,
} from '../src/features/service/tableTabsPayment';

test('seleção conjunta usa só comandas abertas e pré-seleciona cada uma uma vez', () => {
  const tabs = [
    { id: 'a', status: 'open' },
    { id: 'b', status: 'open' },
    { id: 'c', status: 'closed' },
    { id: 'a', status: 'open' },
  ];
  assert.deepEqual(getOpenTabIds(tabs), ['a', 'b']);
});

test('resumo agregado soma itens únicos e taxa arredondada uma vez por comanda aberta', () => {
  const tabs = [
    { id: 'a', status: 'open' },
    { id: 'b', status: 'open' },
    { id: 'closed', status: 'closed' },
  ];
  const totals = aggregateOpenTabs(tabs, {
    a: { status: 'loaded', totalInCents: 5 },
    b: { status: 'loaded', totalInCents: 5 },
    closed: { status: 'loaded', totalInCents: 1000 },
  }, 10);
  assert.deepEqual(totals, {
    subtotalInCents: 10,
    serviceFeeInCents: 2,
    totalInCents: 12,
    incomplete: false,
  });

  const items = collectOpenTabItems(tabs, {
    a: { items: [{ id: 'item-1', status: 'active' }, { id: 'cancelled', status: 'cancelled' }] },
    b: { items: [{ id: 'item-1', status: 'active' }, { id: 'item-2', status: 'active' }] },
    closed: { items: [{ id: 'closed-item', status: 'active' }] },
  });
  assert.deepEqual(items.map(item => item.id), ['item-1', 'item-2']);
});

test('Dividir conta captura o contexto conjunto ou a pessoa exata, sem herdar a última seleção', () => {
  assert.deepEqual(createSplitBillBasis(true, 'person-last-selected', 1234), {
    kind: 'joint', tabId: null, totalInCents: 1234,
  });
  assert.deepEqual(createSplitBillBasis(false, 'person-2', 456), {
    kind: 'individual', tabId: 'person-2', totalInCents: 456,
  });
});

// ============================================================================
// HARNESS DE CONTROLE DO CLIENTE SUPABASE PARA TESTE DE SERVIÇO DE PRODUÇÃO
// ============================================================================

interface InterceptedRpcCall {
  fn: string;
  args: Record<string, unknown>;
}

interface InterceptedFromCall {
  table: string;
  method: string;
}

let interceptedRpcCalls: InterceptedRpcCall[] = [];
let interceptedFromCalls: InterceptedFromCall[] = [];
let mockRpcHandler: ((fn: string, args: Record<string, unknown>) => { data: unknown; error: unknown }) | null = null;
let mockSelectHandler: ((table: string) => { data: unknown; error: unknown }) | null = null;

// Salva referências originais
const originalRpc = supabase.rpc.bind(supabase);
const originalFrom = supabase.from.bind(supabase);

function resetHarness() {
  interceptedRpcCalls = [];
  interceptedFromCalls = [];
  mockRpcHandler = null;
  mockSelectHandler = null;
}

// Configura o harness sobre a instância real
supabase.rpc = function (fn: string, args: Record<string, unknown>) {
  interceptedRpcCalls.push({ fn, args });

  if (mockRpcHandler) {
    const res = mockRpcHandler(fn, args);
    return {
      single: () => ({
        overrideTypes: () => Promise.resolve(res),
      }),
    } as any;
  }

  return originalRpc(fn, args);
} as any;

supabase.from = function (table: string) {
  return {
    select: (...selectArgs: any[]) => {
      interceptedFromCalls.push({ table, method: 'select' });
      return {
        eq: (_col: string, _val: any) => ({
          maybeSingle: () => {
            if (mockSelectHandler) {
              return Promise.resolve(mockSelectHandler(table));
            }
            return Promise.resolve({ data: null, error: null });
          },
        }),
      };
    },
    update: (..._updateArgs: any[]) => {
      interceptedFromCalls.push({ table, method: 'update' });
      throw new Error(`VIOLAÇÃO: Tentativa de UPDATE direto na tabela ${table} sem usar RPC autorizada`);
    },
    delete: (..._deleteArgs: any[]) => {
      interceptedFromCalls.push({ table, method: 'delete' });
      throw new Error(`VIOLAÇÃO: Tentativa de DELETE direto na tabela ${table} sem usar RPC autorizada`);
    },
  } as any;
} as any;

// ============================================================================
// 1. PRÉVIA FINANCEIRA CENTRALIZADA E ARITMÉTICA DECIMAL EXATA
// ============================================================================

test('1.1 Aritmética decimal exata: subtotal=50 centavos, percentual=29%, taxa esperada=15 centavos', () => {
  // Caso de especificação estrita: 50 * 0.29 em float dá 14.499999999999998, que em Math.round daria 14.
  // A aritmética decimal correspondente à RPC Postgres round(numeric) deve resultar em 15.
  const fee = calculateTabClosureFee(50, 29);
  assert.equal(fee, 15, 'Taxa de 50 centavos a 29% deve ser exatamente 15 centavos');

  const preview = calculateTabClosurePreview(50, 29, true);
  assert.equal(preview.subtotalInCents, 50);
  assert.equal(preview.serviceFeePercent, 29);
  assert.equal(preview.serviceFeeInCents, 15);
  assert.equal(preview.totalInCents, 65, 'Total deve ser 50 + 15 = 65 centavos');
  assert.equal(preview.serviceFeeAccepted, true);
});

test('1.2 Aritmética decimal exata: percentuais fracionários', () => {
  // 50 * 10.5% = 5.25 -> round = 5
  assert.equal(calculateTabClosureFee(50, 10.5), 5);

  // 50 * 11% = 5.5 -> round = 6
  assert.equal(calculateTabClosureFee(50, 11), 6);

  // 100 * 12.75% = 12.75 -> round = 13
  assert.equal(calculateTabClosureFee(100, 12.75), 13);

  // 10000 * 12.5% = 1250
  assert.equal(calculateTabClosureFee(10000, 12.5), 1250);
});

test('1.3 Restaurante com taxa zero (0%): não gera cobrança e retorna taxa zerada', () => {
  const preview = calculateTabClosurePreview(8550, 0, true);
  assert.equal(preview.subtotalInCents, 8550);
  assert.equal(preview.serviceFeePercent, 0);
  assert.equal(preview.serviceFeeInCents, 0);
  assert.equal(preview.totalInCents, 8550);
  assert.equal(preview.serviceFeeAccepted, false);
});

test('1.4 Taxa de serviço recusada (serviceFeeAccepted=false): zera a taxa na prévia', () => {
  const preview = calculateTabClosurePreview(10000, 10, false);
  assert.equal(preview.subtotalInCents, 10000);
  assert.equal(preview.serviceFeePercent, 0);
  assert.equal(preview.serviceFeeInCents, 0);
  assert.equal(preview.totalInCents, 10000);
  assert.equal(preview.serviceFeeAccepted, false);
});

test('1.5 Subtotal zero (comanda vazia ou itens cortesias): taxa e total resultam em zero', () => {
  const fee = calculateTabClosureFee(0, 10);
  assert.equal(fee, 0);

  const preview = calculateTabClosurePreview(0, 10, true);
  assert.equal(preview.subtotalInCents, 0);
  assert.equal(preview.serviceFeeInCents, 0);
  assert.equal(preview.totalInCents, 0);
});

test('1.6 Imutabilidade de snapshot histórico: configuração posterior do restaurante não altera valores persistidos', () => {
  const closedTabSnapshot: TableTab = {
    id: 'tab-hist-01',
    restaurant_id: 'rest-01',
    restaurant_table_id: 'tbl-01',
    table_visit_id: 'vis-01',
    label: 'Mesa 1 - Conta Histórica',
    status: 'closed',
    created_by_member_id: 'mem-01',
    created_at: '2026-10-25T10:00:00Z',
    closed_by_member_id: 'mem-01',
    closed_at: '2026-10-25T11:00:00Z',
    subtotal_in_cents: 20000,
    service_fee_percent: 10,
    service_fee_in_cents: 2000,
    total_in_cents: 22000,
    service_fee_accepted: true,
  };

  // Se o restaurante alterar sua taxa para 15%, novos cálculos usam 15%:
  const newPreview = calculateTabClosurePreview(closedTabSnapshot.subtotal_in_cents!, 15, true);
  assert.equal(newPreview.serviceFeeInCents, 3000);

  // Mas o snapshot retornado pela comanda fechada preserva os valores gravados:
  assert.equal(closedTabSnapshot.service_fee_percent, 10);
  assert.equal(closedTabSnapshot.service_fee_in_cents, 2000);
  assert.equal(closedTabSnapshot.total_in_cents, 22000);
});

// ============================================================================
// 2. TESTES DE closeTableTab DE PRODUÇÃO COM CLIENTE SUPABASE CONTROLADO
// ============================================================================

test('2.1 closeTableTab de produção: envia parâmetros corretos com taxa aceita e valida payload', async () => {
  resetHarness();

  const fakeClosedTab: TableTab = {
    id: 'tab-uuid-1',
    restaurant_id: 'rest-uuid-1',
    restaurant_table_id: 'tbl-uuid-1',
    table_visit_id: 'vis-uuid-1',
    label: 'Cliente João',
    status: 'closed',
    created_by_member_id: 'mem-1',
    created_at: '2026-10-25T12:00:00Z',
    closed_by_member_id: 'mem-1',
    closed_at: '2026-10-25T13:00:00Z',
    subtotal_in_cents: 10000,
    service_fee_percent: 10,
    service_fee_in_cents: 1000,
    total_in_cents: 11000,
    service_fee_accepted: true,
  };

  mockRpcHandler = (fn, args) => {
    assert.equal(fn, 'close_table_tab');
    assert.equal(args.p_restaurant_slug, 'noma-restaurante');
    assert.equal(args.p_table_tab_id, 'tab-uuid-1');
    assert.equal(args.p_final_service_fee_accepted, true);
    return { data: fakeClosedTab, error: null };
  };

  const result = await closeTableTab('noma-restaurante', 'tab-uuid-1', true);

  assert.equal(result.id, 'tab-uuid-1');
  assert.equal(result.status, 'closed');
  assert.equal(result.total_in_cents, 11000);
  assert.equal(result.service_fee_accepted, true);

  // Confirma que NÃO houve nenhum UPDATE ou DELETE direto
  const directMutations = interceptedFromCalls.filter((c) => c.method === 'update' || c.method === 'delete');
  assert.equal(directMutations.length, 0, 'Não deve efetuar mutações diretas nas tabelas');
});

test('2.2 closeTableTab de produção: envia taxa recusada (p_final_service_fee_accepted=false)', async () => {
  resetHarness();

  const fakeClosedTab: TableTab = {
    id: 'tab-uuid-2',
    restaurant_id: 'rest-uuid-1',
    restaurant_table_id: 'tbl-uuid-1',
    table_visit_id: 'vis-uuid-1',
    label: 'Cliente Maria',
    status: 'closed',
    created_by_member_id: 'mem-1',
    created_at: '2026-10-25T12:00:00Z',
    closed_by_member_id: 'mem-1',
    closed_at: '2026-10-25T13:00:00Z',
    subtotal_in_cents: 10000,
    service_fee_percent: 0,
    service_fee_in_cents: 0,
    total_in_cents: 10000,
    service_fee_accepted: false,
  };

  mockRpcHandler = (fn, args) => {
    assert.equal(fn, 'close_table_tab');
    assert.equal(args.p_final_service_fee_accepted, false);
    return { data: fakeClosedTab, error: null };
  };

  const result = await closeTableTab('noma-restaurante', 'tab-uuid-2', false);
  assert.equal(result.id, 'tab-uuid-2');
  assert.equal(result.status, 'closed');
  assert.equal(result.total_in_cents, 10000);
  assert.equal(result.service_fee_accepted, false);
});

test('2.3 closeTableTab de produção: comanda vazia não aciona DELETE table_tab_guests nem UPDATE table_tabs', async () => {
  resetHarness();

  const fakeEmptyClosedTab: TableTab = {
    id: 'tab-vazia-uuid',
    restaurant_id: 'rest-uuid-1',
    restaurant_table_id: 'tbl-uuid-1',
    table_visit_id: 'vis-uuid-1',
    label: 'Comanda Sem Consumo',
    status: 'closed',
    created_by_member_id: 'mem-1',
    created_at: '2026-10-25T12:00:00Z',
    closed_by_member_id: 'mem-1',
    closed_at: '2026-10-25T13:00:00Z',
    subtotal_in_cents: 0,
    service_fee_percent: 0,
    service_fee_in_cents: 0,
    total_in_cents: 0,
    service_fee_accepted: false,
  };

  mockRpcHandler = (fn, args) => {
    assert.equal(fn, 'close_table_tab');
    assert.equal(args.p_table_tab_id, 'tab-vazia-uuid');
    assert.equal(args.p_final_service_fee_accepted, false);
    return { data: fakeEmptyClosedTab, error: null };
  };

  const result = await closeTableTab('noma-restaurante', 'tab-vazia-uuid', false);

  assert.equal(result.status, 'closed');
  assert.equal(result.subtotal_in_cents, 0);
  assert.equal(result.total_in_cents, 0);

  // Validação estrita de ausência de bypass por UPDATE/DELETE direto
  assert.equal(interceptedFromCalls.length, 0, 'Comanda vazia deve fechar exclusivamente pela RPC autorizada');
});

test('2.4 closeTableTab de produção: propaga erro de autorização 42501 sem capturar nem mascarar', async () => {
  resetHarness();

  mockRpcHandler = () => {
    return {
      data: null,
      error: { code: '42501', message: 'Somente o responsável ou um administrador pode encerrar esta comanda.' },
    };
  };

  await assert.rejects(
    async () => {
      await closeTableTab('noma-restaurante', 'tab-bloqueada', true);
    },
    (err: Error) => {
      assert.equal(err.message, 'Somente o responsável ou um administrador pode encerrar esta comanda.');
      return true;
    },
  );

  assert.equal(interceptedFromCalls.length, 0, 'Erro de autorização não deve disparar fallback de mutação direta');
});

test('2.5 closeTableTab de produção: rejeita payload com ID ou status inconsistente', async () => {
  resetHarness();

  mockRpcHandler = () => {
    return {
      data: { id: 'outro-id', status: 'closed' },
      error: null,
    };
  };

  await assert.rejects(
    async () => {
      await closeTableTab('noma-restaurante', 'tab-esperada', true);
    },
    /O encerramento não foi confirmado pelo servidor/,
  );
});

test('2.6 closeTableTab de produção: fallback de leitura autorizada quando RPC retorna payload vazio', async () => {
  resetHarness();

  // Simula RPC que retorna data: null mas sem erro (ex: driver que não desempacota linha)
  mockRpcHandler = () => {
    return { data: null, error: null };
  };

  // Simula confirmação via select autorizado
  mockSelectHandler = (table) => {
    assert.equal(table, 'table_tabs');
    return {
      data: {
        id: 'tab-fallback',
        restaurant_id: 'rest-01',
        restaurant_table_id: 'tbl-01',
        table_visit_id: 'vis-01',
        label: 'Comanda Fallback',
        status: 'closed',
        created_by_member_id: 'mem-1',
        created_at: '2026-10-25T12:00:00Z',
        closed_by_member_id: 'mem-1',
        closed_at: '2026-10-25T13:00:00Z',
      },
      error: null,
    };
  };

  const result = await closeTableTab('noma-restaurante', 'tab-fallback', true);
  assert.equal(result.id, 'tab-fallback');
  assert.equal(result.status, 'closed');
  assert.ok(interceptedFromCalls.some((c) => c.table === 'table_tabs' && c.method === 'select'));
});

test('2.7 closeTableTab de produção: rejeita comanda com ID vazio antes de chamar a rede', async () => {
  resetHarness();

  await assert.rejects(
    async () => {
      await closeTableTab('noma-restaurante', '   ', true);
    },
    /Informe a comanda que deseja encerrar/,
  );

  assert.equal(interceptedRpcCalls.length, 0, 'Não deve emitir RPC com ID inválido');
});

test('2.8 closeTableTab de produção: encerramento individual preserva o isolamento de outras comandas da mesa', async () => {
  resetHarness();

  mockRpcHandler = (_fn, args) => {
    assert.equal(args.p_table_tab_id, 'tab-individual-1');
    return {
      data: {
        id: 'tab-individual-1',
        label: 'Lucas',
        status: 'closed',
        total_in_cents: 3500,
        service_fee_accepted: true,
      },
      error: null,
    };
  };

  const closed = await closeTableTab('noma-restaurante', 'tab-individual-1', true);
  assert.equal(closed.id, 'tab-individual-1');
  assert.equal(closed.status, 'closed');
  // Garante que apenas a comanda solicitada foi afetada na chamada de rede
  assert.equal(interceptedRpcCalls.length, 1);
  assert.equal(interceptedRpcCalls[0].args.p_table_tab_id, 'tab-individual-1');
});

test('2.9 closeTableTab de produção: encerramento de conta conjunta não dispara fechamento em lote', async () => {
  resetHarness();

  mockRpcHandler = (_fn, args) => {
    assert.equal(args.p_table_tab_id, 'tab-shared-joint');
    return {
      data: {
        id: 'tab-shared-joint',
        label: 'Conta conjunta',
        status: 'closed',
        total_in_cents: 12000,
        service_fee_accepted: false,
      },
      error: null,
    };
  };

  const closed = await closeTableTab('noma-restaurante', 'tab-shared-joint', false);
  assert.equal(closed.id, 'tab-shared-joint');
  assert.equal(closed.status, 'closed');
  assert.equal(interceptedRpcCalls.length, 1);
  assert.equal(interceptedRpcCalls[0].args.p_table_tab_id, 'tab-shared-joint');
  assert.equal(interceptedRpcCalls[0].args.p_final_service_fee_accepted, false);
});

test('2.10 closeTableTab: fechar uma comanda individual não encerra a mesa nem chama close_table_visit', async () => {
  resetHarness();

  mockRpcHandler = (fn, args) => {
    assert.equal(fn, 'close_table_tab');
    assert.equal(args.p_table_tab_id, 'tab-pessoa-1');
    return {
      data: {
        id: 'tab-pessoa-1',
        label: 'Comanda 1 - Lucas',
        status: 'closed',
        total_in_cents: 2500,
      },
      error: null,
    };
  };

  const closed = await closeTableTab('noma-restaurante', 'tab-pessoa-1', true);
  assert.equal(closed.id, 'tab-pessoa-1');
  assert.equal(closed.status, 'closed');

  // Garante que APENAS close_table_tab foi chamada, sem nenhuma chamada para close_table_visit
  assert.equal(interceptedRpcCalls.length, 1);
  assert.equal(interceptedRpcCalls[0].fn, 'close_table_tab');
  assert.ok(!interceptedRpcCalls.some((c) => c.fn === 'close_table_visit'), 'Não deve invocar close_table_visit ao fechar uma comanda');
});

test('2.11 closeTableVisit: encerramento da mesa é bloqueado com erro 22023 se houver comanda aberta', async () => {
  resetHarness();

  mockRpcHandler = (fn, args) => {
    assert.equal(fn, 'close_table_visit');
    assert.equal(args.p_restaurant_slug, 'noma-restaurante');
    assert.equal(args.p_table_visit_id, 'visit-mesa-1');
    return {
      data: null,
      error: {
        code: '22023',
        message: 'Encerre todas as comandas abertas antes de finalizar o atendimento da mesa.',
      },
    };
  };

  await assert.rejects(
    async () => {
      await closeTableVisit('noma-restaurante', 'visit-mesa-1');
    },
    (err: Error) => {
      assert.equal(err.message, 'Encerre todas as comandas abertas antes de finalizar o atendimento da mesa.');
      return true;
    },
  );

  assert.equal(interceptedRpcCalls.length, 1);
  assert.equal(interceptedRpcCalls[0].fn, 'close_table_visit');
});

test('2.12 closeTableVisit: encerra o atendimento da mesa quando todas as comandas estão fechadas', async () => {
  resetHarness();

  const fakeClosedVisit = {
    id: 'visit-mesa-1',
    restaurant_id: 'rest-1',
    restaurant_table_id: 'tbl-1',
    status: 'closed',
    opened_at: '2026-10-25T12:00:00Z',
    closed_at: '2026-10-25T13:30:00Z',
    ended_at: '2026-10-25T13:30:00Z',
  };

  mockRpcHandler = (fn, args) => {
    assert.equal(fn, 'close_table_visit');
    assert.equal(args.p_table_visit_id, 'visit-mesa-1');
    return { data: fakeClosedVisit, error: null };
  };

  const visit = await closeTableVisit('noma-restaurante', 'visit-mesa-1');
  assert.equal(visit.id, 'visit-mesa-1');
  assert.equal(visit.status, 'closed');
  assert.equal(interceptedRpcCalls.length, 1);
  assert.equal(interceptedRpcCalls[0].fn, 'close_table_visit');
});

// ============================================================================
// 3. TESTES DE COMPORTAMENTO DE INTERFACE E MULTI-SESSÃO (MARCADOS COMO PENDENTES)
// ============================================================================

test.skip('3.1 [PENDENTE - Infraestrutura DOM] Reabertura do modal para outra comanda sem herdar escolha anterior', () => {
  // Requer ambiente de testes de componentes React (jsdom / React Testing Library)
  // para renderizar TableTabsPanel e testar o ciclo de vida do estado local do componente.
});

test.skip('3.2 [PENDENTE - Infraestrutura DOM] Bloqueio de submissão duplicada durante operação em andamento', () => {
  // Requer ambiente de testes de componentes React (jsdom / React Testing Library)
  // para disparar múltiplos eventos concorrentes de clique no botão do modal de TableTabsPanel.
});

test.skip('3.3 [PENDENTE - Banco de Testes] Concorrência real de 2 sessões e bloqueio de encerramento da mesa com comanda aberta', () => {
  // Requer banco de dados isolado com psql / conexões concorrentes ativas para executar
  // a transação com FOR UPDATE e testar o erro 22023 em close_table_visit em runtime.
});

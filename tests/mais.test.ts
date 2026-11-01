import test from 'node:test';
import assert from 'node:assert/strict';

// Configura mocks de DOM mínimos para execução em Node.js
const storageMap = new Map<string, string>();
const eventTarget = new EventTarget();

if (typeof globalThis.window === 'undefined') {
  (globalThis as any).window = {
    addEventListener: eventTarget.addEventListener.bind(eventTarget),
    removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
    dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
  };
}

if (typeof globalThis.localStorage === 'undefined') {
  (globalThis as any).localStorage = {
    getItem: (key: string) => storageMap.get(key) ?? null,
    setItem: (key: string, val: string) => storageMap.set(key, String(val)),
    removeItem: (key: string) => storageMap.delete(key),
    clear: () => storageMap.clear(),
  };
}

if (typeof (globalThis as any).CustomEvent === 'undefined') {
  (globalThis as any).CustomEvent = class CustomEvent extends Event {
    detail: any;
    constructor(type: string, eventInitDict?: any) {
      super(type, eventInitDict);
      this.detail = eventInitDict?.detail;
    }
  };
}

import { supabase } from '../src/lib/supabase';
import { fetchStaffDailyMetrics, type StaffDailyMetrics } from '../src/features/service/staffStats';
import { isSoundEnabled, setSoundEnabled, toggleSoundEnabled } from '../src/lib/soundAlerts';
import { getTimezoneUtcRange, toTimezoneDateString } from '../src/features/service/staffDateUtils';

// ============================================================================
// HARNESS DE CONTROLE DO CLIENTE SUPABASE PARA OS TESTES DA TELA MAIS
// ============================================================================

let interceptedQueries: Array<{ table: string; method: string; args: any[] }> = [];
let mockFromHandler: ((table: string) => any) | null = null;

const originalFrom = supabase.from.bind(supabase);

function resetHarness() {
  interceptedQueries = [];
  mockFromHandler = null;
}

function createQueryBuilder(result: { data?: unknown; count?: number | null; error?: unknown }) {
  const promise = Promise.resolve({
    data: result.data ?? null,
    count: result.count ?? null,
    error: result.error ?? null,
  });

  const builder: any = {
    select: (...args: any[]) => {
      builder._lastMethod = 'select';
      builder._selectArgs = args;
      return builder;
    },
    eq: (...args: any[]) => {
      builder._eqArgs = builder._eqArgs || [];
      builder._eqArgs.push(args);
      return builder;
    },
    gte: (...args: any[]) => {
      builder._gteArgs = args;
      return builder;
    },
    lt: (...args: any[]) => {
      builder._ltArgs = args;
      return builder;
    },
    single: () => builder,
    maybeSingle: () => builder,
    then: (onfulfilled: any, onrejected: any) => promise.then(onfulfilled, onrejected),
    catch: (onrejected: any) => promise.catch(onrejected),
  };
  return builder;
}

supabase.from = function (table: string): any {
  if (mockFromHandler) {
    return mockFromHandler(table);
  }
  return originalFrom(table);
};

// ============================================================================
// TESTES DE INDICADORES DO TURNO / DIA (staffStats)
// ============================================================================

test('1.1 fetchStaffDailyMetrics: calcula chamados, contas e mesas atendidas com filtros reais de garçom', async () => {
  resetHarness();

  const fakeRestaurantId = 'rest-uuid-111';
  const fakeMemberId = 'member-uuid-222';

  mockFromHandler = (table: string) => {
    if (table === 'service_requests') {
      const b = createQueryBuilder({ count: 7 });
      const origEq = b.eq;
      b.eq = (col: string, val: any) => {
        interceptedQueries.push({ table, method: 'eq', args: [col, val] });
        return origEq(col, val);
      };
      return b;
    }

    if (table === 'table_tabs') {
      const b = createQueryBuilder({ count: 12 });
      const origEq = b.eq;
      b.eq = (col: string, val: any) => {
        interceptedQueries.push({ table, method: 'eq', args: [col, val] });
        return origEq(col, val);
      };
      return b;
    }

    if (table === 'table_visits') {
      const b = createQueryBuilder({
        data: [
          { restaurant_table_id: 'table-1' },
          { restaurant_table_id: 'table-2' },
          { restaurant_table_id: 'table-1' },
          { restaurant_table_id: 'table-3' },
          { restaurant_table_id: 'table-2' },
        ],
      });
      const origEq = b.eq;
      b.eq = (col: string, val: any) => {
        interceptedQueries.push({ table, method: 'eq', args: [col, val] });
        return origEq(col, val);
      };
      return b;
    }

    return originalFrom(table);
  };

  const metrics = await fetchStaffDailyMetrics(
    fakeRestaurantId,
    fakeMemberId,
    'waiter',
    'America/Sao_Paulo'
  );

  assert.equal(metrics.callsResolved, 7, 'Deve contabilizar 7 chamados resolvidos');
  assert.equal(metrics.tabsClosed, 12, 'Deve contabilizar 12 contas fechadas');
  assert.equal(metrics.tablesAttended, 3, 'Deve desduplicar mesas e contabilizar 3 mesas distintas');
  assert.equal(metrics.salesInCents, null, 'Vendas de turno deve ser null (indisponível) sem inventar valores');

  // Verifica se filtrou por assigned_member_id para garçom
  const waiterFilter = interceptedQueries.find(
    (q) => q.table === 'table_visits' && q.method === 'eq' && q.args[0] === 'assigned_member_id'
  );
  assert.ok(waiterFilter, 'Deve filtrar table_visits por assigned_member_id para perfil garçom');
  assert.equal(waiterFilter?.args[1], fakeMemberId);
});

test('1.2 fetchStaffDailyMetrics: perfil admin não restringe table_visits por assigned_member_id', async () => {
  resetHarness();

  const fakeRestaurantId = 'rest-uuid-111';
  const fakeAdminId = 'admin-uuid-999';

  mockFromHandler = (table: string) => {
    if (table === 'table_visits') {
      const b = createQueryBuilder({
        data: [
          { restaurant_table_id: 'table-A' },
          { restaurant_table_id: 'table-B' },
        ],
      });
      const origEq = b.eq;
      b.eq = (col: string, val: any) => {
        interceptedQueries.push({ table, method: 'eq', args: [col, val] });
        return origEq(col, val);
      };
      return b;
    }

    return createQueryBuilder({ count: 0 });
  };

  const metrics = await fetchStaffDailyMetrics(
    fakeRestaurantId,
    fakeAdminId,
    'admin',
    'America/Sao_Paulo'
  );

  assert.equal(metrics.tablesAttended, 2);
  const waiterFilter = interceptedQueries.find(
    (q) => q.table === 'table_visits' && q.method === 'eq' && q.args[0] === 'assigned_member_id'
  );
  assert.equal(waiterFilter, undefined, 'Admin não deve ser restrito por assigned_member_id');
});

test('1.3 fetchStaffDailyMetrics: em caso de falha de consulta, retorna null sem fabricar zero', async () => {
  resetHarness();

  mockFromHandler = (table: string) => {
    if (table === 'service_requests') {
      return createQueryBuilder({ error: { message: 'Network error' } });
    }
    if (table === 'table_tabs') {
      return createQueryBuilder({ error: { message: 'Permission denied' } });
    }
    if (table === 'table_visits') {
      return createQueryBuilder({ error: { message: 'Server down' } });
    }
    return originalFrom(table);
  };

  const metrics = await fetchStaffDailyMetrics('rest-id', 'member-id', 'waiter');

  assert.equal(metrics.callsResolved, null, 'Chamados deve ser null em caso de erro');
  assert.equal(metrics.tabsClosed, null, 'Contas fechadas deve ser null em caso de erro');
  assert.equal(metrics.tablesAttended, null, 'Mesas atendidas deve ser null em caso de erro');
  assert.equal(metrics.salesInCents, null, 'Vendas de turno deve ser null');
});

test('1.4 fetchStaffDailyMetrics: parâmetros vazios retornam todos indicadores como null', async () => {
  resetHarness();

  const metrics = await fetchStaffDailyMetrics('', '', 'waiter');
  assert.deepEqual(metrics, {
    tablesAttended: null,
    callsResolved: null,
    tabsClosed: null,
    salesInCents: null,
  });
});

// ============================================================================
// TESTES DE CONFIGURAÇÃO DE SOM E APARÊNCIA
// ============================================================================

test('2.1 Controle de Som: toggleSoundEnabled sincroniza estado e dispara evento de configuração', () => {
  setSoundEnabled(true);
  assert.equal(isSoundEnabled(), true);

  let eventFired = false;
  let receivedEnabled: boolean | null = null;

  const handler = (e: any) => {
    eventFired = true;
    receivedEnabled = e.detail?.enabled;
  };

  window.addEventListener('elozi:sound-setting-changed', handler);

  const next1 = toggleSoundEnabled();
  assert.equal(next1, false);
  assert.equal(isSoundEnabled(), false);
  assert.equal(eventFired, true);
  assert.equal(receivedEnabled, false);

  const next2 = toggleSoundEnabled();
  assert.equal(next2, true);
  assert.equal(isSoundEnabled(), true);
  assert.equal(receivedEnabled, true);

  window.removeEventListener('elozi:sound-setting-changed', handler);
});

test('2.2 DateUtils: fuso horário converte e delimita janela de 24 horas corretamente', () => {
  const fixedDate = new Date('2026-10-25T14:30:00Z');
  const dateStr = toTimezoneDateString(fixedDate, 'America/Sao_Paulo');
  assert.equal(dateStr, '2026-10-25');

  const { startUtc, nextDayStartUtc } = getTimezoneUtcRange(dateStr, 'America/Sao_Paulo');
  assert.ok(startUtc.includes('2026-10-25'));
  assert.ok(nextDayStartUtc.includes('2026-10-26'));

  const diffMs = new Date(nextDayStartUtc).getTime() - new Date(startUtc).getTime();
  assert.equal(diffMs, 24 * 60 * 60 * 1000, 'A janela deve ser exatamente de 24 horas');
});

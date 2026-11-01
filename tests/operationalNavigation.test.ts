import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  saveOperationalContext,
  getOperationalContext,
  clearOperationalContext,
  updateOperationalTab,
  updateOperationalSearch,
  updateOperationalScroll,
  validateOperationalContext,
  isTableLocallyAuthorized,
  setTableLocallyAuthorized,
  clearTableLocallyAuthorized,
  type StaffOperationalContext,
} from '../src/features/service/staffOperationalContext.ts';

// Mock storage para ambiente Node.js de teste
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

// Configurar mocks globais de storage
if (typeof globalThis.sessionStorage === 'undefined') {
  globalThis.sessionStorage = new MemoryStorage();
}
if (typeof globalThis.localStorage === 'undefined') {
  globalThis.localStorage = new MemoryStorage();
}

describe('1. Persistência e Recuperação do Contexto Operacional com UUIDs', () => {
  const restaurantId = 'rest-uuid-1111';
  const visitId = 'visit-uuid-2222';
  const tableId = 'table-uuid-3333';
  const tabId = 'tab-uuid-4444';

  test('1.1 Salva e recupera contexto operacional completo por UUID', () => {
    clearOperationalContext();

    const ctx: Omit<StaffOperationalContext, 'updatedAt'> = {
      restaurantId,
      restaurantSlug: 'rest-teste',
      tableId,
      tableNumber: 4,
      tableVisitId: visitId,
      tableTabId: tabId,
      searchQuery: 'pizza',
      scrollPosition: 120,
    };

    saveOperationalContext(ctx);

    const loaded = getOperationalContext(restaurantId);
    assert.ok(loaded, 'Contexto deve existir na sessão');
    assert.equal(loaded.restaurantId, restaurantId);
    assert.equal(loaded.tableVisitId, visitId);
    assert.equal(loaded.tableId, tableId);
    assert.equal(loaded.tableTabId, tabId);
    assert.equal(loaded.tableNumber, 4);
    assert.equal(loaded.searchQuery, 'pizza');
    assert.equal(loaded.scrollPosition, 120);
    assert.ok(loaded.updatedAt > 0, 'updatedAt deve ser gravado com timestamp');
  });

  test('1.2 updateOperationalTab atualiza apenas a comanda ativa', () => {
    updateOperationalTab(restaurantId, 'tab-nova-5555');
    const updated = getOperationalContext(restaurantId);
    assert.ok(updated);
    assert.equal(updated.tableTabId, 'tab-nova-5555');
    assert.equal(updated.tableVisitId, visitId);
  });

  test('1.3 updateOperationalSearch e updateOperationalScroll preservam dados', () => {
    updateOperationalSearch(restaurantId, 'suco de laranja');
    updateOperationalScroll(restaurantId, 450);

    const updated = getOperationalContext(restaurantId);
    assert.ok(updated);
    assert.equal(updated.searchQuery, 'suco de laranja');
    assert.equal(updated.scrollPosition, 450);
  });

  test('1.4 clearOperationalContext limpa contexto do restaurante ou de toda a sessão', () => {
    clearOperationalContext(restaurantId);
    assert.equal(getOperationalContext(restaurantId), null);

    saveOperationalContext({
      restaurantId: 'outro-rest',
      restaurantSlug: 'outro',
      tableId: 't-1',
      tableNumber: 1,
      tableVisitId: 'v-1',
      tableTabId: null,
    });
    assert.ok(getOperationalContext('outro-rest'));

    clearOperationalContext(); // limpa todos
    assert.equal(getOperationalContext('outro-rest'), null);
  });
});

describe('2. Validação Remota de Contexto Operacional com Supabase', () => {
  const restaurantId = 'rest-val-0001';
  const memberId = 'garcom-val-0001';
  const visitId = 'visit-val-0001';
  const tableId = 'table-val-0001';

  test('2.1 Validação bem-sucedida: visita aberta e comanda ativa retornam status valid', async () => {
    const mockSupabase = {
      from(table: string) {
        return {
          select() {
            return {
              eq(col1: string, val1: string) {
                return {
                  eq(col2: string, val2: string) {
                    return {
                      async maybeSingle() {
                        if (table === 'table_visits') {
                          return {
                            data: {
                              id: visitId,
                              status: 'open',
                              restaurant_id: restaurantId,
                              restaurant_table_id: tableId,
                              assigned_member_id: memberId,
                            },
                            error: null,
                          };
                        }
                        if (table === 'table_tabs') {
                          return {
                            data: { id: 'tab-val-1', status: 'open' },
                            error: null,
                          };
                        }
                        return { data: null, error: null };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
    } as any;

    const ctx: StaffOperationalContext = {
      restaurantId,
      restaurantSlug: 'teste',
      tableId,
      tableNumber: 2,
      tableVisitId: visitId,
      tableTabId: 'tab-val-1',
      updatedAt: Date.now(),
    };

    const res = await validateOperationalContext(ctx, memberId, 'waiter', mockSupabase);
    assert.equal(res.status, 'valid');
    if (res.status === 'valid') {
      assert.equal(res.tableVisitId, visitId);
      assert.equal(res.tableTabId, 'tab-val-1');
      assert.equal(res.tableNumber, 2);
    }
  });

  test('2.2 Visita encerrada enquanto fora: detecta status visit_closed com número da mesa', async () => {
    const mockSupabase = {
      from(table: string) {
        return {
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      async maybeSingle() {
                        return {
                          data: {
                            id: visitId,
                            status: 'closed', // ENCERRADA!
                            restaurant_id: restaurantId,
                            restaurant_table_id: tableId,
                            assigned_member_id: memberId,
                          },
                          error: null,
                        };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
    } as any;

    const ctx: StaffOperationalContext = {
      restaurantId,
      restaurantSlug: 'teste',
      tableId,
      tableNumber: 5,
      tableVisitId: visitId,
      tableTabId: null,
      updatedAt: Date.now(),
    };

    const res = await validateOperationalContext(ctx, memberId, 'waiter', mockSupabase);
    assert.equal(res.status, 'visit_closed');
    if (res.status === 'visit_closed') {
      assert.equal(res.tableNumber, 5);
      assert.equal(res.tableVisitId, visitId);
    }
  });

  test('2.3 Comanda específica fechada mas visita aberta: reseta comanda mantendo a mesa', async () => {
    const mockSupabase = {
      from(table: string) {
        return {
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      async maybeSingle() {
                        if (table === 'table_visits') {
                          return {
                            data: {
                              id: visitId,
                              status: 'open',
                              restaurant_id: restaurantId,
                              restaurant_table_id: tableId,
                              assigned_member_id: memberId,
                            },
                            error: null,
                          };
                        }
                        if (table === 'table_tabs') {
                          return {
                            data: { id: 'tab-fechada', status: 'closed' }, // Comanda fechada
                            error: null,
                          };
                        }
                        return { data: null, error: null };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
    } as any;

    const ctx: StaffOperationalContext = {
      restaurantId,
      restaurantSlug: 'teste',
      tableId,
      tableNumber: 7,
      tableVisitId: visitId,
      tableTabId: 'tab-fechada',
      updatedAt: Date.now(),
    };

    const res = await validateOperationalContext(ctx, memberId, 'waiter', mockSupabase);
    assert.equal(res.status, 'valid');
    if (res.status === 'valid') {
      assert.equal(res.tableTabId, null, 'Comanda fechada deve ser resetada para null');
      assert.equal(res.tableVisitId, visitId);
    }
  });

  test('2.4 Garçom não autorizado em mesa de outro membro: retorna unauthorized', async () => {
    const mockSupabase = {
      from() {
        return {
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      async maybeSingle() {
                        return {
                          data: {
                            id: visitId,
                            status: 'open',
                            restaurant_id: restaurantId,
                            restaurant_table_id: tableId,
                            assigned_member_id: 'outro-garcom-999', // Outro membro!
                          },
                          error: null,
                        };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
    } as any;

    clearTableLocallyAuthorized(restaurantId, 8, visitId);

    const ctx: StaffOperationalContext = {
      restaurantId,
      restaurantSlug: 'teste',
      tableId,
      tableNumber: 8,
      tableVisitId: visitId,
      tableTabId: null,
      updatedAt: Date.now(),
    };

    const res = await validateOperationalContext(ctx, memberId, 'waiter', mockSupabase);
    assert.equal(res.status, 'unauthorized');

    // Com permissão local explícita autoriza
    setTableLocallyAuthorized(restaurantId, 8, visitId);
    const resAuth = await validateOperationalContext(ctx, memberId, 'waiter', mockSupabase);
    assert.equal(resAuth.status, 'valid');
  });
});

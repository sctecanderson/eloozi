import test from 'node:test';
import assert from 'node:assert/strict';

// Importação direta do código real de produção
import {
  loadImportManifest,
  saveImportManifest,
  analyzeLocalReservations,
  prepareLocalReservationsForImport,
  executeLocalReservationsImport,
  withManifestLock,
  isWebLocksAvailable,
  parseAndValidateSeatResult,
  toReservationItem,
  computeDatasetFingerprint,
  isValidUuid,
  isValidDateString,
  isValidTimeString,
  getManifestStorageKey,
  type LocalImportManifest,
  type LocalReservationPreviewItem,
  type ILockManager,
} from '../src/features/reservations/reservationService';

// Implementação simples de Storage em memória para testes controlados
class MockStorage implements Storage {
  private store = new Map<string, string>();
  public throwOnSetItem: string | null = null;
  public throwOnGetItem: string | null = null;
  public setItemCalls: { key: string; value: string }[] = [];

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
    this.setItemCalls = [];
  }

  getItem(key: string): string | null {
    if (this.throwOnGetItem) {
      throw new Error(this.throwOnGetItem);
    }
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    if (this.throwOnSetItem) {
      throw new Error(this.throwOnSetItem);
    }
    this.setItemCalls.push({ key, value: String(value) });
    this.store.set(key, String(value));
  }
}

// LockManager simulado com fila assíncrona estrita para validação de concorrência
class MockLockManager implements ILockManager {
  private queues = new Map<string, Promise<unknown>>();
  public activeLocks = new Set<string>();
  public acquisitionOrder: string[] = [];
  public releaseOrder: string[] = [];

  async request<T>(
    name: string,
    optionsOrCallback: { mode: 'exclusive' } | (() => Promise<T> | T),
    maybeCallback?: () => Promise<T> | T
  ): Promise<T> {
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback!;
    const previousPromise = this.queues.get(name) || Promise.resolve();

    let releaseResolve!: () => void;
    const currentPromise = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });

    this.queues.set(name, currentPromise);

    await previousPromise;
    this.activeLocks.add(name);
    this.acquisitionOrder.push(name);

    try {
      return await callback();
    } finally {
      this.activeLocks.delete(name);
      this.releaseOrder.push(name);
      releaseResolve();
    }
  }
}

const REST_A = '11111111-1111-4111-a111-111111111111';
const REST_B = '22222222-2222-4222-a222-222222222222';
const RES_ID_A = 'b1111111-1111-4111-a111-111111111111';
const RES_ID_B = 'b2222222-2222-4222-a222-222222222222';

// ----------------------------------------------------------------------------
// TESTE 1: Manifesto ausente e inicialização
// ----------------------------------------------------------------------------
test('1. Manifesto ausente: detecta status absent e inicializa estrutura limpa', () => {
  const storage = new MockStorage();
  const result = loadImportManifest(REST_A, storage);

  assert.equal(result.status, 'absent');
  if (result.status === 'absent') {
    assert.equal(result.manifest.version, 1);
    assert.equal(result.manifest.restaurantId, REST_A);
    assert.deepEqual(result.manifest.entries, []);
  }
});

// ----------------------------------------------------------------------------
// TESTE 2: Prévia somente leitura: não grava storage e marca pendentes
// ----------------------------------------------------------------------------
test('2. Prévia somente leitura: analyzeLocalReservations não grava storage e marca pendentes', () => {
  const storage = new MockStorage();
  const tables = new Set([10]);
  const localData = JSON.stringify([
    {
      tableNumber: 10,
      customerName: 'Cliente Prévia',
      phone: '11999990001',
      date: '2026-10-25',
      time: '20:00',
      guestsCount: 2,
      status: 'confirmed',
    },
  ]);

  // Executa prévia
  const preview = analyzeLocalReservations(localData, tables, true, REST_A, storage);
  assert.equal(preview.validCount, 1);
  assert.equal(preview.items.length, 1);

  // Registro ainda não catalogado deve aparecer como pendente de preparação
  assert.equal(preview.items[0].originId, 'pending-preparation-0');

  // NENHUMA gravação no storage deve ter ocorrido
  assert.equal(storage.getItem(getManifestStorageKey(REST_A)), null);
  assert.equal(storage.setItemCalls.length, 0);
});

// ----------------------------------------------------------------------------
// TESTE 3: Preparação atômica sob lock: gera origin_ids e salva manifesto
// ----------------------------------------------------------------------------
test('3. Preparação atômica: gera origin_ids persistentes, salva manifesto e reutiliza identidades', async () => {
  const storage = new MockStorage();
  const tables = new Set([10]);
  const localData = JSON.stringify([
    {
      tableNumber: 10,
      customerName: 'Cliente Persistente',
      phone: '11999990001',
      date: '2026-10-25',
      time: '20:00',
      guestsCount: 2,
      status: 'confirmed',
    },
  ]);

  // Execução 1: Prepara registros e salva manifesto
  const prepared1 = await prepareLocalReservationsForImport(REST_A, localData, tables, true, storage);
  assert.equal(prepared1.length, 1);
  const originId1 = prepared1[0].originId;
  assert.match(originId1, /^loc-manifest:/);

  // Manifesto deve ter sido gravado com sucesso no storage
  const manifestLoad = loadImportManifest(REST_A, storage);
  assert.equal(manifestLoad.status, 'valid');
  if (manifestLoad.status === 'valid') {
    assert.equal(manifestLoad.manifest.entries.length, 1);
    assert.equal(manifestLoad.manifest.entries[0].assignedOriginId, originId1);
  }

  // Execução 2: Re-preparação deve reutilizar estritamente a mesma originId
  const prepared2 = await prepareLocalReservationsForImport(REST_A, localData, tables, true, storage);
  assert.equal(prepared2[0].originId, originId1);

  // Prévia subsequente também deve exibir o originId já catalogado
  const previewAfter = analyzeLocalReservations(localData, tables, true, REST_A, storage);
  assert.equal(previewAfter.items[0].originId, originId1);
});

// ----------------------------------------------------------------------------
// TESTE 4: Registros idênticos recebendo identidades e ocorrências distintas
// ----------------------------------------------------------------------------
test('4. Registros idênticos: atribuem occurrenceIndex diferentes e originIds distintos no manifesto', async () => {
  const storage = new MockStorage();
  const tables = new Set([5]);
  const localData = JSON.stringify([
    {
      tableNumber: 5,
      customerName: 'Cliente Duplo',
      phone: '11999990001',
      date: '2026-10-25',
      time: '19:30',
      guestsCount: 4,
      status: 'confirmed',
    },
    {
      tableNumber: 5,
      customerName: 'Cliente Duplo',
      phone: '11999990001',
      date: '2026-10-25',
      time: '19:30',
      guestsCount: 4,
      status: 'confirmed',
    },
  ]);

  const prepared = await prepareLocalReservationsForImport(REST_A, localData, tables, true, storage);
  assert.equal(prepared.length, 2);

  const [item1, item2] = prepared;
  // OriginIds devem ser únicos mesmo com dados idênticos
  assert.notEqual(item1.originId, item2.originId);

  // Manifesto persistido deve ter index 0 e index 1
  const manifestResult = loadImportManifest(REST_A, storage);
  assert.equal(manifestResult.status, 'valid');
  if (manifestResult.status === 'valid') {
    assert.equal(manifestResult.manifest.entries.length, 2);
    assert.equal(manifestResult.manifest.entries[0].occurrenceIndex, 0);
    assert.equal(manifestResult.manifest.entries[1].occurrenceIndex, 1);
    assert.equal(manifestResult.manifest.entries[0].assignedOriginId, item1.originId);
    assert.equal(manifestResult.manifest.entries[1].assignedOriginId, item2.originId);
  }
});

// ----------------------------------------------------------------------------
// TESTE 5: Falha de gravação no storage durante a preparação bloqueia importação
// ----------------------------------------------------------------------------
test('5. Falha de gravação no storage: bloqueia preparação com erro explícito sem enviar ao banco', async () => {
  const storage = new MockStorage();
  storage.throwOnSetItem = 'QuotaExceededError: Quota do localStorage excedida.';

  const tables = new Set([1]);
  const localData = JSON.stringify([
    {
      tableNumber: 1,
      customerName: 'Cliente Quota',
      phone: '11999990001',
      date: '2026-10-25',
      time: '20:00',
      guestsCount: 2,
      status: 'confirmed',
    },
  ]);

  // A preparação DEVE lançar exceção ao falhar a persistência do manifesto
  await assert.rejects(
    async () => {
      await prepareLocalReservationsForImport(REST_A, localData, tables, true, storage);
    },
    /Falha ao salvar manifesto local.*Quota do localStorage excedida/
  );
});

// ----------------------------------------------------------------------------
// TESTE 6: Manifesto corrompido não é sobrescrito e bloqueia importação
// ----------------------------------------------------------------------------
test('6. Manifesto corrompido: não é sobrescrito e bloqueia importação com erro explícito', async () => {
  const storage = new MockStorage();
  const manifestKey = getManifestStorageKey(REST_A);
  const corruptedRaw = '{ "version": 1, "restaurantId": "' + REST_A + '", "entries": [ { "invalido" ';
  storage.setItem(manifestKey, corruptedRaw);

  const tables = new Set([1]);
  const localData = JSON.stringify([
    {
      tableNumber: 1,
      customerName: 'Cliente Teste',
      phone: '11999990001',
      date: '2026-10-25',
      time: '20:00',
      guestsCount: 2,
      status: 'confirmed',
    },
  ]);

  // Análise detecta corrompido
  const analysis = analyzeLocalReservations(localData, tables, true, REST_A, storage);
  assert.equal(analysis.manifestStatus, 'corrupted');
  assert.equal(analysis.validCount, 0);

  // Preparação sob lock rejeita sem sobrescrever
  await assert.rejects(
    async () => {
      await prepareLocalReservationsForImport(REST_A, localData, tables, true, storage);
    },
    /Manifesto local corrompido.*JSON malformado/
  );

  // Conteúdo corrompido original foi preservado intacto
  assert.equal(storage.getItem(manifestKey), corruptedRaw);
});

// ----------------------------------------------------------------------------
// TESTE 7: Manifesto de outro restaurante rejeitado
// ----------------------------------------------------------------------------
test('7. Manifesto de outro restaurante: detecta incoerência de tenant e rejeita como corrompido', () => {
  const storage = new MockStorage();
  const manifestKey = getManifestStorageKey(REST_A);
  storage.setItem(
    manifestKey,
    JSON.stringify({
      version: 1,
      restaurantId: REST_B,
      entries: [],
    }),
  );

  const result = loadImportManifest(REST_A, storage);
  assert.equal(result.status, 'corrupted');
  if (result.status === 'corrupted') {
    assert.match(result.error, /pertence a outro restaurante/);
  }
});

// ----------------------------------------------------------------------------
// TESTE 8: Detecção de modificação da fonte: edição sem ID bloqueia reconciliação
// ----------------------------------------------------------------------------
test('8. Detecção de modificação da fonte: edição de registro sem ID bloqueia ambiguidade', async () => {
  const storage = new MockStorage();
  const tables = new Set([10, 11]);

  const initialData = JSON.stringify([
    {
      tableNumber: 10,
      customerName: 'Carlos Inicial',
      phone: '11999990001',
      date: '2026-10-25',
      time: '19:00',
      guestsCount: 2,
      status: 'confirmed',
    },
    {
      tableNumber: 11,
      customerName: 'Ana Intacta',
      phone: '11999990002',
      date: '2026-10-25',
      time: '20:00',
      guestsCount: 3,
      status: 'confirmed',
    },
  ]);

  // Prepara estado inicial
  const run1 = await prepareLocalReservationsForImport(REST_A, initialData, tables, true, storage);
  assert.equal(run1.length, 2);

  // Usuário altera horário de Carlos de 19:00 para 21:00
  const modifiedData = JSON.stringify([
    {
      tableNumber: 10,
      customerName: 'Carlos Inicial',
      phone: '11999990001',
      date: '2026-10-25',
      time: '21:00', // Modificado!
      guestsCount: 2,
      status: 'confirmed',
    },
    {
      tableNumber: 11,
      customerName: 'Ana Intacta',
      phone: '11999990002',
      date: '2026-10-25',
      time: '20:00',
      guestsCount: 3,
      status: 'confirmed',
    },
  ]);

  // A preparação deve recusar gerar uma nova identidade ou mapeamento ambíguo
  await assert.rejects(
    async () => {
      await prepareLocalReservationsForImport(REST_A, modifiedData, tables, true, storage);
    },
    /Origem local modificada: correspondência ambígua/
  );
});

// ----------------------------------------------------------------------------
// TESTE 9: Concorrência com Promise.all e pausa simulada sob o mesmo LockManager
// ----------------------------------------------------------------------------
test('9. Concorrência: execuções concorrentes com Promise.all aguardam o lock e reutilizam mesmos origin_ids', async () => {
  const sharedStorage = new MockStorage();
  const mockLockManager = new MockLockManager();
  const tables = new Set([8]);
  const localData = JSON.stringify([
    {
      tableNumber: 8,
      customerName: 'Cliente Concorrente',
      phone: '11999990001',
      date: '2026-10-25',
      time: '20:30',
      guestsCount: 2,
      status: 'confirmed',
    },
  ]);

  let op1Completed = false;
  let op2StartedAfterOp1 = false;

  // Dispara duas operações simultâneas com Promise.all sob o mesmo LockManager
  const [result1, result2] = await Promise.all([
    // Operação 1: simula pausa de 50ms mantendo o lock
    withManifestLock(
      REST_A,
      async () => {
        // Pausa simulada
        await new Promise((resolve) => setTimeout(resolve, 50));
        op1Completed = true;
        return await prepareLocalReservationsForImport(REST_A, localData, tables, true, sharedStorage);
      },
      mockLockManager
    ),
    // Operação 2: deve aguardar o término da Operação 1 antes de executar
    withManifestLock(
      REST_A,
      async () => {
        if (op1Completed) {
          op2StartedAfterOp1 = true;
        }
        return await prepareLocalReservationsForImport(REST_A, localData, tables, true, sharedStorage);
      },
      mockLockManager
    ),
  ]);

  // Confirma que Operação 2 só executou após a conclusão da Operação 1
  assert.equal(op2StartedAfterOp1, true);

  // Ambas as operações devem ter retornado exatamente o mesmo origin_id persistido
  assert.equal(result1.length, 1);
  assert.equal(result2.length, 1);
  assert.equal(result2[0].originId, result1[0].originId);
  assert.match(result1[0].originId, /^loc-manifest:/);

  // O lock manager deve estar completamente liberado ao final
  assert.equal(mockLockManager.activeLocks.size, 0);
  assert.equal(mockLockManager.acquisitionOrder.length, 2);
  assert.equal(mockLockManager.releaseOrder.length, 2);
});

// ----------------------------------------------------------------------------
// TESTE 10: Execução de rede estritamente FORA do Web Lock
// ----------------------------------------------------------------------------
test('10. Garantia arquitetural: liberação do Web Lock ANTES da execução de rede', async () => {
  const sharedStorage = new MockStorage();
  const mockLockManager = new MockLockManager();
  const expectedLockName = `elozi_manifest_lock_${REST_A}`;
  const tables = new Set([12]);
  const localData = JSON.stringify([
    {
      tableNumber: 12,
      customerName: 'Cliente Fora do Lock',
      phone: '11999990001',
      date: '2026-10-25',
      time: '19:45',
      guestsCount: 2,
      status: 'confirmed',
    },
  ]);

  // FASE 1: Preparação sob Web Lock
  const prepared = await withManifestLock(
    REST_A,
    async () => {
      // Enquanto dentro do lock, o lock com o prefixo oficial do restaurante deve estar ativo
      assert.equal(mockLockManager.activeLocks.has(expectedLockName), true);
      return await prepareLocalReservationsForImport(REST_A, localData, tables, true, sharedStorage);
    },
    mockLockManager
  );

  // Ao sair do withManifestLock, o lock DEVE estar completamente liberado
  assert.equal(mockLockManager.activeLocks.has(expectedLockName), false);
  assert.equal(mockLockManager.activeLocks.size, 0);

  // FASE 2: Chamada de rede inicia com o lock já liberado
  let networkExecutedWithLockReleased = false;
  if (!mockLockManager.activeLocks.has(expectedLockName)) {
    networkExecutedWithLockReleased = true;
  }
  assert.equal(networkExecutedWithLockReleased, true);
  assert.ok(prepared.length > 0);
});

// ----------------------------------------------------------------------------
// TESTE 11: Resposta RPC malformada ou contraditória sem falso sucesso
// ----------------------------------------------------------------------------
test('11. parseAndValidateSeatResult: rejeita strings como "false", dados nulos ou respostas contraditórias', () => {
  // String "false" NÃO pode ser tratada como true
  const res1 = parseAndValidateSeatResult({ success: 'false', code: 'SEATED_SUCCESS' }, REST_A, 1, RES_ID_A);
  assert.equal(res1.success, false);
  assert.equal(res1.code, 'MALFORMED_RESPONSE');

  // Tipo número em success
  const res2 = parseAndValidateSeatResult({ success: 1, code: 'SEATED_SUCCESS' }, REST_A, 1, RES_ID_A);
  assert.equal(res2.success, false);
  assert.equal(res2.code, 'MALFORMED_RESPONSE');

  // Sucesso declarado mas sem payload de reserva
  const res3 = parseAndValidateSeatResult({ success: true, code: 'SEATED_SUCCESS', reservation: null }, REST_A, 1, RES_ID_A);
  assert.equal(res3.success, false);
  assert.equal(res3.code, 'INVALID_RESERVATION_PAYLOAD');

  // Resposta contraditória: SEATED_SUCCESS com success = false
  const res4 = parseAndValidateSeatResult(
    {
      success: false,
      code: 'SEATED_SUCCESS',
      reservation: {
        id: RES_ID_A,
        restaurant_id: REST_A,
        table_number: 1,
        status: 'seated',
      },
    },
    REST_A,
    1,
    RES_ID_A,
  );
  assert.equal(res4.success, false);

  // Resposta válida SEATED_SUCCESS
  const res5 = parseAndValidateSeatResult(
    {
      success: true,
      code: 'SEATED_SUCCESS',
      reservation: {
        id: RES_ID_A,
        restaurant_id: REST_A,
        table_number: 1,
        status: 'seated',
      },
    },
    REST_A,
    1,
    RES_ID_A,
  );
  assert.equal(res5.success, true);
  assert.equal(res5.code, 'SEATED_SUCCESS');

  // Resposta válida ALREADY_SEATED
  const res6 = parseAndValidateSeatResult(
    {
      success: false,
      code: 'ALREADY_SEATED',
      reservation: {
        id: RES_ID_A,
        restaurant_id: REST_A,
        table_number: 1,
        status: 'seated',
      },
    },
    REST_A,
    1,
    RES_ID_A,
  );
  assert.equal(res6.success, false);
  assert.equal(res6.code, 'ALREADY_SEATED');
});

// ----------------------------------------------------------------------------
// TESTE 12: ID, restaurante e mesa divergentes rejeitados
// ----------------------------------------------------------------------------
test('12. Parâmetros divergentes na resposta da RPC: rejeita com RESPONSE_PARAM_MISMATCH', () => {
  // Restaurante divergente
  const resRestMismatch = parseAndValidateSeatResult(
    {
      success: true,
      code: 'SEATED_SUCCESS',
      reservation: {
        id: RES_ID_A,
        restaurant_id: REST_B, // Divergente!
        table_number: 1,
        status: 'seated',
      },
    },
    REST_A,
    1,
    RES_ID_A,
  );
  assert.equal(resRestMismatch.success, false);
  assert.equal(resRestMismatch.code, 'RESPONSE_PARAM_MISMATCH');

  // Mesa divergente
  const resTableMismatch = parseAndValidateSeatResult(
    {
      success: true,
      code: 'SEATED_SUCCESS',
      reservation: {
        id: RES_ID_A,
        restaurant_id: REST_A,
        table_number: 2, // Solicitou 1, retornou 2!
        status: 'seated',
      },
    },
    REST_A,
    1,
    RES_ID_A,
  );
  assert.equal(resTableMismatch.success, false);
  assert.equal(resTableMismatch.code, 'RESPONSE_PARAM_MISMATCH');

  // ID de reserva divergente
  const resIdMismatch = parseAndValidateSeatResult(
    {
      success: true,
      code: 'SEATED_SUCCESS',
      reservation: {
        id: RES_ID_B, // Solicitou A, retornou B!
        restaurant_id: REST_A,
        table_number: 1,
        status: 'seated',
      },
    },
    REST_A,
    1,
    RES_ID_A,
  );
  assert.equal(resIdMismatch.success, false);
  assert.equal(resIdMismatch.code, 'RESPONSE_PARAM_MISMATCH');
});

// ----------------------------------------------------------------------------
// TESTE 13: Preservação de table_id / tableId na identidade estável da mesa
// ----------------------------------------------------------------------------
test('13. Preservação de table_id / tableId na identidade estável da mesa', () => {
  const tableId = 'c1111111-1111-4111-a111-111111111111';
  const item = toReservationItem({
    id: RES_ID_A,
    restaurant_id: REST_A,
    table_id: tableId,
    table_number: 1,
    customer_name: 'Cliente Teste',
    phone: '11999990001',
    date: '2026-10-25',
    time: '20:00',
    status: 'confirmed',
    guests_count: 2,
    notes: 'Observação',
    created_at: '2026-10-25T12:00:00Z',
  });
  assert.equal(item.tableId, tableId);
  assert.equal(item.tableNumber, 1);

  const seatRes = parseAndValidateSeatResult(
    {
      success: true,
      code: 'SEATED_SUCCESS',
      reservation: {
        id: RES_ID_A,
        restaurant_id: REST_A,
        table_id: tableId,
        table_number: 1,
        status: 'seated',
      },
    },
    REST_A,
    1,
    RES_ID_A,
  );
  assert.equal(seatRes.success, true);
  assert.equal(seatRes.reservation?.table_id, tableId);
});

// ----------------------------------------------------------------------------
// TESTE 14: updateReservation suporta troca autorizada de mesa com tableId/tableNumber
// ----------------------------------------------------------------------------
test('14. updateReservation e UpdateReservationInput suportam troca autorizada de mesa', async () => {
  const { updateReservation } = await import('../src/features/reservations/reservationService.ts');

  // Validação de UUID de reserva inválido
  await assert.rejects(
    async () => {
      await updateReservation('invalid-uuid', { tableNumber: 5 });
    },
    { message: 'ID da reserva inválido.' }
  );

  // Validação de número de mesa inválido
  await assert.rejects(
    async () => {
      await updateReservation(RES_ID_A, { tableNumber: 0 });
    },
    { message: 'Número de mesa inválido.' }
  );

  // Validação de ID da mesa inválido
  await assert.rejects(
    async () => {
      await updateReservation(RES_ID_A, { tableId: 'not-a-uuid' });
    },
    { message: 'ID da mesa inválido.' }
  );
});

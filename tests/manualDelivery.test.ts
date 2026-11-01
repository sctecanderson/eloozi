import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { canConfirmDelivery, confirmDelivery } from '../src/features/service/manualDelivery.ts';

const context = { restaurantSlug: 'a', restaurantId: 'r', visitId: 'v', tabId: 't', itemIds: ['i'] };
const row = (id = 'i') => ({ id, restaurant_id: 'r', table_visit_id: 'v', table_tab_id: 't', status: 'active', production_status: 'delivered', prep_delivered_at: '2026-10-28T22:00:00Z' });
const client = (rpc: (...args: any[]) => any) => ({ rpc }) as any;
test('Basic oferece confirmacao nos tres estados; planos pagos somente ready', () => {
  for (const s of ['pending', 'preparing', 'in_preparation', 'ready']) assert.ok(canConfirmDelivery('basic', s));
  for (const p of ['pro', 'premium', undefined]) {
    assert.equal(canConfirmDelivery(p, 'pending'), false);
    assert.equal(canConfirmDelivery(p, 'preparing'), false);
    assert.equal(canConfirmDelivery(p, 'ready'), true);
  }
  assert.equal(canConfirmDelivery('basic', 'delivered'), false);
});
test('sucesso somente apos resposta confirmada do servidor', async () => {
  let resolve!: (r: any) => void; let completed = false;
  const operation = confirmDelivery(context, client(() => new Promise(r => { resolve = r; }))).then(() => { completed = true; });
  await Promise.resolve(); assert.equal(completed, false);
  resolve({ data: row(), error: null }); await operation; assert.equal(completed, true);
  await confirmDelivery(context, client(async () => ({ data: [row()], error: null })));
});
test('erro, resposta vazia/inconsistente e timestamp invalido nunca confirmam sucesso', async () => {
  for (const response of [
    { data: null, error: { message: '42501' } }, { data: null, error: null },
    { data: [], error: null }, { data: [row(), row()], error: null },
    ...[{ id: 'other' }, { restaurant_id: 'other' }, { table_visit_id: 'other' }, { table_tab_id: 'other' },
      { status: 'cancelled' }, { production_status: 'pending' }, { prep_delivered_at: 'bad' }].map(change => ({ data: { ...row(), ...change }, error: null })),
  ]) await assert.rejects(confirmDelivery(context, client(async () => response)));
});
test('grupo deduplica IDs e interrompe em falha parcial sem fallback', async () => {
  const calls: string[] = [];
  await assert.rejects(confirmDelivery({ ...context, itemIds: ['i', 'i', 'j', 'k'] }, client(async (_name, args) => {
    calls.push(args.p_item_id);
    return args.p_item_id === 'i' ? { data: row(), error: null } : { data: null, error: { message: 'fail' } };
  })));
  assert.deepEqual(calls, ['i', 'j']);
  await assert.rejects(confirmDelivery({ ...context, itemIds: [] }, client(() => { throw new Error('must not call'); })));
});
test('painel recarrega em finally e nao possui sucesso otimista nem UPDATE direto de entrega', () => {
  const source = fs.readFileSync(new URL('../src/features/service/TableTabsPanel.tsx', import.meta.url), 'utf8');
  const action = source.slice(source.indexOf('  async function handleMarkDelivered'), source.indexOf('  // Limpar itens da comanda atual'));
  assert.ok(action.includes('finally') && action.includes('reloadTabConsumption'));
  assert.ok(!action.includes('.update(') && !action.includes('setTabConsumptions('));
  assert.ok(action.includes('submitting.current') && action.includes('confirmDelivery'));
});

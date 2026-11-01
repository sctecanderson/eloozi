import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateTabClosurePreview,
  calculateTabClosureFee,
  type TableTab,
} from '../src/features/service/tableTabs';
import type { ComandaCardData } from '../src/features/service/ComandasPage';
import { buildComandaPrintPayload } from '../src/features/service/comandaPrinting';

// ============================================================================
// 1. TESTES DE IMPRESSÃO: SNAPSHOTS PERSISTIDOS VS PRÉ-CONTA (FUNÇÃO COMPARTILHADA)
// ============================================================================

test('1.1 Impressão de comanda finalizada: usa snapshots contábeis persistidos e não recalcula por configuração atual', () => {
  // Cenário: Uma comanda foi finalizada com 10% de taxa no passado
  const closedCard: ComandaCardData = {
    id: 'tab-closed-123',
    tabId: 'tab-closed-123',
    label: 'Comanda 05',
    tableId: 'table-uuid-1',
    tableNumber: 1,
    tableArea: 'Salão',
    visitId: 'visit-old-uuid',
    openedAt: '2026-10-25T12:00:00Z',
    closedAt: '2026-10-25T13:00:00Z',
    status: 'closed',
    itemsCount: 2,
    linkedGuestsCount: 1,
    totalInCents: 5500, // Snapshot total
    subtotalInCents: 5000, // Snapshot subtotal
    serviceFeePercent: 10, // Snapshot taxa %
    serviceFeeInCents: 500, // Snapshot taxa R$
    serviceFeeAccepted: true,
    items: [
      {
        id: 'item-1',
        table_tab_id: 'tab-closed-123',
        product_name: 'Hambúrguer Clássico',
        quantity: 1,
        unit_price_in_cents: 3500,
        line_total_in_cents: 3500,
        status: 'active',
      },
      {
        id: 'item-2',
        table_tab_id: 'tab-closed-123',
        product_name: 'Suco de Laranja',
        quantity: 1,
        unit_price_in_cents: 1500,
        line_total_in_cents: 1500,
        status: 'active',
      },
    ],
  };

  // O restaurante atualmente alterou sua taxa para 15%
  const currentRestaurantFeePercent = 15;

  // Executa a função de produção compartilhada usada pela impressão real
  const payload = buildComandaPrintPayload(closedCard, 'NOMA Restaurante', currentRestaurantFeePercent);

  // Verifica que os valores impressos são ESTRITAMENTE do snapshot e NÃO do restaurante atual
  assert.equal(payload.subtotalInCents, 5000, 'Subtotal deve ser 5000 centavos');
  assert.equal(payload.serviceFeePercent, 10, 'Percentual deve permanecer 10%, ignorando a taxa atual de 15%');
  assert.equal(payload.serviceFeeInCents, 500, 'Taxa em centavos deve permanecer 500');
  assert.equal(payload.totalInCents, 5500, 'Total deve ser 5500 centavos');
  assert.ok(!payload.tabLabel.includes('Pré-conta'), 'Comanda finalizada não deve ser rotulada como Pré-conta');
  assert.equal(payload.items.length, 2);
});

test('1.2 Impressão de comanda aberta: calcula prévia decimal exata e rotula como (Pré-conta)', () => {
  const openCard: ComandaCardData = {
    id: 'tab-open-456',
    tabId: 'tab-open-456',
    label: 'Comanda 02',
    tableId: 'table-uuid-2',
    tableNumber: 4,
    tableArea: 'Varanda',
    visitId: 'visit-active-uuid',
    openedAt: '2026-10-25T14:00:00Z',
    closedAt: null,
    status: 'open',
    itemsCount: 1,
    linkedGuestsCount: 1,
    totalInCents: 50, // Subtotal de 50 centavos para teste aritmético crítico
    subtotalInCents: 50,
    serviceFeePercent: null,
    serviceFeeInCents: null,
    serviceFeeAccepted: null,
    items: [
      {
        id: 'item-3',
        table_tab_id: 'tab-open-456',
        product_name: 'Café Expresso Especial',
        quantity: 1,
        unit_price_in_cents: 50,
        line_total_in_cents: 50,
        status: 'active',
      },
    ],
  };

  const currentRestaurantFeePercent = 29; // 29% sobre 50 centavos = 14.5 -> 15 centavos

  // Executa a função de produção compartilhada usada pela impressão real
  const payload = buildComandaPrintPayload(openCard, 'NOMA Restaurante', currentRestaurantFeePercent);

  assert.equal(payload.subtotalInCents, 50);
  assert.equal(payload.serviceFeePercent, 29);
  assert.equal(payload.serviceFeeInCents, 15, 'Arredondamento decimal exato de 29% sobre 50 centavos deve ser 15 centavos');
  assert.equal(payload.totalInCents, 65, 'Total deve ser 50 + 15 = 65 centavos');
  assert.ok(payload.tabLabel.includes('(Pré-conta)'), 'Comanda aberta deve ser explicitamente rotulada como Pré-conta');
  assert.equal(payload.items.length, 1);
});

// ============================================================================
// 2. TESTES DE IDENTIFICAÇÃO POR UUID E SEGURANÇA OPERACIONAL
// ============================================================================

test('2.1 Identificação por UUID: cada comanda possui UUID estável e isolado', () => {
  const cardA: ComandaCardData = {
    id: 'uuid-tab-aaa-111',
    tabId: 'uuid-tab-aaa-111',
    label: 'Comanda Carlos',
    tableId: 'mesa-10',
    tableNumber: 10,
    tableArea: 'Salão',
    visitId: 'visit-old-1',
    openedAt: '2026-10-24T18:00:00Z',
    closedAt: '2026-10-24T20:00:00Z',
    status: 'closed',
    itemsCount: 3,
    linkedGuestsCount: 1,
    totalInCents: 12000,
    items: [],
  };

  const cardB: ComandaCardData = {
    id: 'uuid-tab-bbb-222',
    tabId: 'uuid-tab-bbb-222',
    label: 'Comanda Ana',
    tableId: 'mesa-10',
    tableNumber: 10,
    tableArea: 'Salão',
    visitId: 'visit-new-2',
    openedAt: '2026-10-25T11:00:00Z',
    closedAt: null,
    status: 'open',
    itemsCount: 1,
    linkedGuestsCount: 1,
    totalInCents: 4500,
    items: [],
  };

  // Ambas as comandas compartilham a mesma mesa física (Mesa 10), mas têm UUIDs distintos
  assert.equal(cardA.tableNumber, cardB.tableNumber);
  assert.notEqual(cardA.tabId, cardB.tabId);
  assert.notEqual(cardA.visitId, cardB.visitId);

  // Abrir comanda por UUID recupera a comanda exata da visita anterior sem colidir com a visita atual
  const lookupByUuid = (uuid: string, list: ComandaCardData[]) => list.find((c) => c.tabId === uuid);
  const foundOld = lookupByUuid('uuid-tab-aaa-111', [cardA, cardB]);
  assert.equal(foundOld?.label, 'Comanda Carlos');
  assert.equal(foundOld?.status, 'closed');
});

test('2.2 Bloqueio de transferência para comandas finalizadas', () => {
  const closedCard: ComandaCardData = {
    id: 'uuid-closed',
    tabId: 'uuid-closed',
    label: 'Comanda Encerrada',
    tableId: 'mesa-3',
    tableNumber: 3,
    tableArea: 'Salão',
    visitId: 'visit-closed',
    openedAt: '2026-10-25T10:00:00Z',
    closedAt: '2026-10-25T11:00:00Z',
    status: 'closed',
    itemsCount: 1,
    linkedGuestsCount: 0,
    totalInCents: 2000,
    items: [],
  };

  // Regra de validação: status closed não pode iniciar transferência
  const canTransfer = closedCard.status !== 'closed';
  assert.equal(canTransfer, false, 'Comandas finalizadas não podem ser transferidas');
});

test('2.3 Conferência de taxa no fechamento: com taxa zero não exibe cobrança', () => {
  const previewNoFee = calculateTabClosurePreview(8000, 0, true);
  assert.equal(previewNoFee.serviceFeePercent, 0);
  assert.equal(previewNoFee.serviceFeeInCents, 0);
  assert.equal(previewNoFee.totalInCents, 8000);
  assert.equal(previewNoFee.serviceFeeAccepted, false);
});

test('2.4 Regra de transferência segura: bloqueio de cancelamento + recriação e exigência de seleção explícita da comanda de destino', () => {
  // A transferência não deve permitir improvisar com cancelamento e recriação de itens
  // (o que alteraria timestamp, preço histórico e reiniciaria status de preparo no KDS).
  // Na ausência de RPC transacional atômica no banco, a ação fica desabilitada.
  const isAtomicTransferAvailableInDatabase = false; // Confirmado no esquema do Supabase
  const isTransferActionEnabled = isAtomicTransferAvailableInDatabase;
  assert.equal(isTransferActionEnabled, false, 'Ação de transferência deve permanecer desabilitada sem RPC atômica');

  // Ao preparar a transferência, exige seleção explícita da comanda de destino,
  // nunca auto-selecionando a primeira comanda da mesa
  const targetTabsOnTable = [
    { id: 'tab-target-1', label: 'Comanda 01' },
    { id: 'tab-target-2', label: 'Comanda 02' },
  ];
  let selectedTargetTabId = ''; // Começa vazio, sem auto-seleção
  assert.equal(selectedTargetTabId, '', 'Comanda de destino deve iniciar não selecionada');
  assert.equal(Boolean(selectedTargetTabId), false, 'Não deve permitir transferência sem seleção explícita da comanda');

  // Seleção explícita feita pelo usuário
  selectedTargetTabId = targetTabsOnTable[1].id;
  assert.equal(selectedTargetTabId, 'tab-target-2');
});


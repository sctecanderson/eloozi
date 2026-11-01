import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterHistoryRecords,
  groupRecordsByTableVisit,
  calculateHistorySummary,
  exportHistoryToCsv,
  formatHistoryDuration,
  getHistoryPeriodUtcRange,
  type StaffHistoryRecord,
} from '../src/features/service/staffHistory.ts';
import { toTimezoneDateString } from '../src/features/service/staffDateUtils.ts';

const mockRecords: StaffHistoryRecord[] = [
  {
    id: 'tab-uuid-01',
    tableVisitId: 'visit-uuid-01',
    tableTabId: 'tab-uuid-01',
    tableNumber: 1,
    tableLabel: 'Salão principal',
    tabLabel: 'Comanda Ana Marcos',
    status: 'closed',
    openedAt: '2026-10-24T13:57:00.000Z',
    closedAt: '2026-10-24T15:21:00.000Z',
    durationMinutes: 84, // 1h 24min
    itemsCount: 4,
    confirmedGuestsCount: 1,
    subtotalInCents: 5845,
    serviceFeePercent: 10,
    serviceFeeInCents: 585,
    serviceFeeAccepted: true,
    totalInCents: 6430,
    items: [
      {
        id: 'item-1',
        table_tab_id: 'tab-uuid-01',
        product_name: 'Risoto de cogumelos',
        quantity: 1,
        unit_price_in_cents: 6200,
        line_total_in_cents: 6200,
        status: 'active',
      },
    ],
    closedByMemberId: 'member-01',
    assignedMemberId: 'member-01',
    recordType: 'tab',
  },
  {
    id: 'tab-uuid-05',
    tableVisitId: 'visit-uuid-05',
    tableTabId: 'tab-uuid-05',
    tableNumber: 5,
    tableLabel: 'Salão principal',
    tabLabel: 'Comanda Casal',
    status: 'closed',
    openedAt: '2026-10-24T14:12:00.000Z',
    closedAt: '2026-10-24T15:24:00.000Z',
    durationMinutes: 72, // 1h 12min
    itemsCount: 2,
    confirmedGuestsCount: 2,
    subtotalInCents: 4800,
    serviceFeePercent: 10,
    serviceFeeInCents: 480,
    serviceFeeAccepted: true,
    totalInCents: 5280,
    items: [],
    closedByMemberId: 'member-01',
    assignedMemberId: 'member-01',
    recordType: 'tab',
  },
  {
    id: 'tab-uuid-10',
    tableVisitId: 'visit-uuid-10',
    tableTabId: 'tab-uuid-10',
    tableNumber: 10,
    tableLabel: 'Varanda',
    tabLabel: 'Comanda Amigos',
    status: 'closed',
    openedAt: '2026-10-24T12:03:00.000Z',
    closedAt: '2026-10-24T14:13:00.000Z',
    durationMinutes: 130, // 2h 10min
    itemsCount: 5,
    confirmedGuestsCount: 4,
    subtotalInCents: 9850,
    serviceFeePercent: 10,
    serviceFeeInCents: 0,
    serviceFeeAccepted: false, // taxa recusada
    totalInCents: 9850,
    items: [],
    closedByMemberId: 'member-02',
    assignedMemberId: 'member-02',
    recordType: 'tab',
  },
];

// ============================================================================
// 1. TESTES DE INTERVALO UTC E DATAS CIVIS NO FUSO DO RESTAURANTE
// ============================================================================

test('1.1 getHistoryPeriodUtcRange: Hoje + 6 dias anteriores resulta em exatamente 7 datas civis em America/Sao_Paulo', () => {
  const tz = 'America/Sao_Paulo';
  // Data de referência fixada para evitar flutuação do relógio durante o teste
  const refDate = new Date('2026-10-25T18:00:00-03:00');

  const range7Dias = getHistoryPeriodUtcRange('7dias', null, tz, refDate);

  // Início e fim em UTC
  const startMs = new Date(range7Dias.startUtc).getTime();
  const endMs = new Date(range7Dias.endUtc).getTime();
  const diffHours = (endMs - startMs) / (1000 * 60 * 60);

  // 7 dias completos = exatamente 168 horas
  assert.equal(diffHours, 7 * 24, 'Período de 7 dias deve ter exatamente 168 horas (7 dias)');

  // Contagem exata de datas civis distintas em America/Sao_Paulo
  const civilDates = new Set<string>();
  for (let t = startMs; t < endMs; t += 12 * 60 * 60 * 1000) {
    civilDates.add(toTimezoneDateString(new Date(t), tz));
  }

  assert.equal(civilDates.size, 7, 'Hoje + 6 dias anteriores deve conter exatamente 7 datas civis');
  assert.ok(civilDates.has('2026-10-19'), 'Deve incluir a primeira data civil do período (2026-10-19)');
  assert.ok(civilDates.has('2026-10-25'), 'Deve incluir a data de hoje (2026-10-25)');
  assert.ok(!civilDates.has('2026-10-18'), 'Não pode retroceder indevidamente para 2026-10-18');
});

test('1.2 getHistoryPeriodUtcRange: Hoje + 29 dias anteriores resulta em exatamente 30 datas civis em America/Sao_Paulo', () => {
  const tz = 'America/Sao_Paulo';
  const refDate = new Date('2026-10-25T18:00:00-03:00');

  const range30Dias = getHistoryPeriodUtcRange('30dias', null, tz, refDate);

  const startMs = new Date(range30Dias.startUtc).getTime();
  const endMs = new Date(range30Dias.endUtc).getTime();
  const diffHours = (endMs - startMs) / (1000 * 60 * 60);

  assert.equal(diffHours, 30 * 24, 'Período de 30 dias deve ter exatamente 720 horas (30 dias)');

  const civilDates = new Set<string>();
  for (let t = startMs; t < endMs; t += 12 * 60 * 60 * 1000) {
    civilDates.add(toTimezoneDateString(new Date(t), tz));
  }

  assert.equal(civilDates.size, 30, 'Hoje + 29 dias anteriores deve conter exatamente 30 datas civis');
  assert.ok(civilDates.has('2026-09-26'), 'Deve iniciar em 2026-09-26');
  assert.ok(civilDates.has('2026-10-25'), 'Deve encerrar em 2026-10-25');
  assert.ok(!civilDates.has('2026-09-25'), 'Não pode retroceder para 2026-09-25');
});

// ============================================================================
// 2. TESTES DE AGRUPAMENTO DE MESAS E CATEGORIAS SEM DESCARTE DE DADOS
// ============================================================================

test('2.1 groupRecordsByTableVisit: consolida todas as comandas de uma visita sem descartar dados nem duplicar valores', () => {
  // Cenário: A mesa 4 teve 2 comandas separadas no mesmo atendimento
  const multiTabRecords: StaffHistoryRecord[] = [
    {
      id: 'tab-visit4-01',
      tableVisitId: 'visit-mesa-4',
      tableTabId: 'tab-visit4-01',
      tableNumber: 4,
      tableLabel: 'Deck externo',
      tabLabel: 'Comanda João',
      status: 'closed',
      openedAt: '2026-10-24T18:00:00.000Z',
      closedAt: '2026-10-24T19:30:00.000Z',
      durationMinutes: 90,
      itemsCount: 2,
      confirmedGuestsCount: 2,
      subtotalInCents: 6000,
      serviceFeePercent: 10,
      serviceFeeInCents: 600,
      serviceFeeAccepted: true,
      totalInCents: 6600,
      items: [
        {
          id: 'item-v4-1',
          table_tab_id: 'tab-visit4-01',
          product_name: 'Picanha',
          quantity: 1,
          unit_price_in_cents: 6000,
          line_total_in_cents: 6000,
          status: 'active',
        },
      ],
      closedByMemberId: 'waiter-1',
      assignedMemberId: 'waiter-1',
      recordType: 'tab',
    },
    {
      id: 'tab-visit4-02',
      tableVisitId: 'visit-mesa-4',
      tableTabId: 'tab-visit4-02',
      tableNumber: 4,
      tableLabel: 'Deck externo',
      tabLabel: 'Comanda Maria',
      status: 'closed',
      openedAt: '2026-10-24T18:15:00.000Z',
      closedAt: '2026-10-24T20:00:00.000Z',
      durationMinutes: 105,
      itemsCount: 3,
      confirmedGuestsCount: 1,
      subtotalInCents: 4000,
      serviceFeePercent: 10,
      serviceFeeInCents: 400,
      serviceFeeAccepted: true,
      totalInCents: 4400,
      items: [
        {
          id: 'item-v4-2',
          table_tab_id: 'tab-visit4-02',
          product_name: 'Sobremesa Petit Gateau',
          quantity: 2,
          unit_price_in_cents: 2000,
          line_total_in_cents: 4000,
          status: 'active',
        },
      ],
      closedByMemberId: 'waiter-1',
      assignedMemberId: 'waiter-1',
      recordType: 'tab',
    },
  ];

  const grouped = groupRecordsByTableVisit(multiTabRecords);

  // Deve haver exatamente 1 registro consolidado da mesa
  assert.equal(grouped.length, 1);
  const visitMesa4 = grouped[0];

  assert.equal(visitMesa4.tableVisitId, 'visit-mesa-4');
  assert.equal(visitMesa4.tableNumber, 4);
  assert.equal(visitMesa4.relatedTabsCount, 2);

  // Soma contábil das duas comandas
  assert.equal(visitMesa4.subtotalInCents, 10000, 'Subtotal da mesa deve ser 6000 + 4000 = 10000');
  assert.equal(visitMesa4.serviceFeeInCents, 1000, 'Taxa de serviço deve ser 600 + 400 = 1000');
  assert.equal(visitMesa4.totalInCents, 11000, 'Total da mesa deve ser 6600 + 4400 = 11000');

  // Total de itens e clientes
  assert.equal(visitMesa4.itemsCount, 3, 'Deve somar todos os itens ativos (1 picanha + 2 sobremesas = 3)');
  assert.equal(visitMesa4.confirmedGuestsCount, 3, 'Deve somar clientes (2 + 1 = 3)');

  // Duração abrange da primeira abertura (18:00) ao último fechamento (20:00) = 120min
  assert.equal(visitMesa4.durationMinutes, 120);
});

test('2.2 filterHistoryRecords: comanda fechada com visita ainda aberta NÃO aparece em Encerramentos', () => {
  // Cenário: Uma comanda foi fechada antecipadamente (ex: cliente pagou sua parte e saiu),
  // mas a visita da mesa continua aberta (visitStatus = 'open', visitClosedAt = null).
  const recordOpenVisit: StaffHistoryRecord = {
    ...mockRecords[0],
    id: 'tab-early-closure',
    tableVisitId: 'visit-still-open-1',
    tableTabId: 'tab-early-closure',
    visitStatus: 'open',
    visitOpenedAt: '2026-10-24T12:00:00.000Z',
    visitClosedAt: null, // Visita ainda em andamento
    status: 'closed', // Comanda fechada
    tabLabel: 'Comanda Individual Antecipada',
  };

  // Na categoria 'contas', a comanda fechada aparece normalmente
  const contas = filterHistoryRecords([recordOpenVisit], '', 'contas');
  assert.equal(contas.length, 1);
  assert.equal(contas[0].id, 'tab-early-closure');

  // Na categoria 'encerramentos', ela NÃO pode aparecer porque a mesa não foi encerrada
  const encerramentos = filterHistoryRecords([recordOpenVisit], '', 'encerramentos');
  assert.equal(encerramentos.length, 0, 'Comanda fechada com visita ainda aberta NÃO deve aparecer em Encerramentos');
});

test('2.3 filterHistoryRecords: visita fechada aparece uma única vez em Encerramentos, com seus horários reais', () => {
  // Cenário: A mesa 8 teve 2 comandas separadas. A visita foi aberta às 19:00 e fechada às 22:30.
  // As comandas tiveram horários de fechamento individuais (21:00 e 22:15).
  const realVisitOpenedAt = '2026-10-24T19:00:00.000Z';
  const realVisitClosedAt = '2026-10-24T22:30:00.000Z'; // 210 minutos (3h 30min)

  const multiTabClosedVisitRecords: StaffHistoryRecord[] = [
    {
      ...mockRecords[0],
      id: 'tab-v8-1',
      tableVisitId: 'visit-mesa-8-closed',
      tableTabId: 'tab-v8-1',
      tableNumber: 8,
      openedAt: '2026-10-24T19:15:00.000Z',
      closedAt: '2026-10-24T21:00:00.000Z',
      visitStatus: 'closed',
      visitOpenedAt: realVisitOpenedAt,
      visitClosedAt: realVisitClosedAt,
      subtotalInCents: 5000,
      totalInCents: 5500,
    },
    {
      ...mockRecords[1],
      id: 'tab-v8-2',
      tableVisitId: 'visit-mesa-8-closed',
      tableTabId: 'tab-v8-2',
      tableNumber: 8,
      openedAt: '2026-10-24T19:30:00.000Z',
      closedAt: '2026-10-24T22:15:00.000Z',
      visitStatus: 'closed',
      visitOpenedAt: realVisitOpenedAt,
      visitClosedAt: realVisitClosedAt,
      subtotalInCents: 7000,
      totalInCents: 7700,
    },
  ];

  const encerramentos = filterHistoryRecords(multiTabClosedVisitRecords, '', 'encerramentos');

  // 1. Aparece EXATAMENTE uma única vez
  assert.equal(encerramentos.length, 1, 'Visita fechada deve aparecer exatamente uma única vez');
  const closure = encerramentos[0];

  assert.equal(closure.tableVisitId, 'visit-mesa-8-closed');
  assert.equal(closure.tableNumber, 8);

  // 2. Horários reais da visita (não da comanda individual)
  assert.equal(closure.openedAt, realVisitOpenedAt, 'openedAt deve ser o horário real de abertura da visita');
  assert.equal(closure.closedAt, realVisitClosedAt, 'closedAt deve ser o horário real de encerramento da visita');
  assert.equal(closure.durationMinutes, 210, 'Duração deve ser calculada a partir dos horários reais da visita (3h 30min = 210min)');

  // 3. Valores consolidados de todas as comandas da visita sem duplicidade
  assert.equal(closure.subtotalInCents, 12000, 'Subtotal consolidado: 5000 + 7000 = 12000');
  assert.equal(closure.totalInCents, 13200, 'Total consolidado: 5500 + 7700 = 13200');
  assert.equal(closure.relatedTabsCount, 2);
});

// ============================================================================
// 3. TESTES DE INDICADORES: DIFERENCIAÇÃO DE VISITAS E CONTAS
// ============================================================================

test('3.1 calculateHistorySummary: diferencia quantidade de visitas e contas nos indicadores', () => {
  const multiTabRecords: StaffHistoryRecord[] = [
    {
      ...mockRecords[0],
      id: 'tab-1',
      tableVisitId: 'visit-mesa-1',
      tableTabId: 'tab-1',
      totalInCents: 5000,
    },
    {
      ...mockRecords[0],
      id: 'tab-2',
      tableVisitId: 'visit-mesa-1', // segunda comanda da mesma mesa
      tableTabId: 'tab-2',
      totalInCents: 3000,
    },
    {
      ...mockRecords[1],
      id: 'tab-3',
      tableVisitId: 'visit-mesa-2',
      tableTabId: 'tab-3',
      totalInCents: 4000,
    },
  ];

  const summary = calculateHistorySummary(multiTabRecords);

  // 3 contas individuais, mas apenas 2 visitas de mesa
  assert.equal(summary.totalTabs, 3, 'Deve identificar 3 contas individuais');
  assert.equal(summary.totalVisits, 2, 'Deve identificar 2 visitas de mesa distintas');
  assert.equal(summary.totalAttendances, 3);

  // Receita total: 5000 + 3000 + 4000 = 12000
  // Ticket médio por atendimento: 12000 / 3 = 4000
  assert.equal(summary.ticketMedioInCents, 4000);
});

// ============================================================================
// 4. TESTES DE REMOÇÃO DE FALLBACKS FICTÍCIOS E EXPORTAÇÃO CSV
// ============================================================================

test('4.1 Remoção de fallbacks fictícios: preserva null e zero, exibindo "Indisponível" quando não obtido', () => {
  const recordWithMissingData: StaffHistoryRecord[] = [
    {
      id: 'tab-no-data',
      tableVisitId: 'visit-no-data',
      tableTabId: 'tab-no-data',
      tableNumber: null, // Sem número de mesa conhecido
      tableLabel: null, // Sem ambiente configurado
      tabLabel: 'Comanda Balcão',
      status: 'closed',
      openedAt: '2026-10-24T10:00:00.000Z',
      closedAt: '2026-10-24T10:30:00.000Z',
      durationMinutes: 30,
      itemsCount: 1,
      confirmedGuestsCount: 0, // Zero confirmado de acessos (não deve virar 1)
      subtotalInCents: 1500,
      serviceFeePercent: 0,
      serviceFeeInCents: 0,
      serviceFeeAccepted: false,
      totalInCents: 1500,
      items: [],
      closedByMemberId: null,
      assignedMemberId: null,
    },
    {
      id: 'tab-null-guests',
      tableVisitId: 'visit-null-guests',
      tableTabId: 'tab-null-guests',
      tableNumber: 3,
      tableLabel: null,
      tabLabel: 'Comanda 3',
      status: 'closed',
      openedAt: '2026-10-24T11:00:00.000Z',
      closedAt: '2026-10-24T11:20:00.000Z',
      durationMinutes: 20,
      itemsCount: 1,
      confirmedGuestsCount: null, // Acessos não obtidos / falha
      subtotalInCents: 2000,
      serviceFeePercent: 0,
      serviceFeeInCents: 0,
      serviceFeeAccepted: false,
      totalInCents: 2000,
      items: [],
      closedByMemberId: null,
      assignedMemberId: null,
    },
  ];

  // Preservação no modelo de dados
  assert.equal(recordWithMissingData[0].tableNumber, null, 'tableNumber não pode ser forçado para 1');
  assert.equal(recordWithMissingData[0].tableLabel, null, 'tableLabel não pode ser forçado para "Salão principal"');
  assert.equal(recordWithMissingData[0].confirmedGuestsCount, 0, 'confirmedGuestsCount 0 deve ser preservado como 0');
  assert.equal(recordWithMissingData[1].confirmedGuestsCount, null, 'confirmedGuestsCount não obtido deve ser null');

  // Exportação CSV: deve conter "Indisponível" e preservar "0"
  const csv = exportHistoryToCsv(recordWithMissingData, 'America/Sao_Paulo');

  // Registro 0: Mesa Indisponível;Ambiente Indisponível;...;0 (zero clientes preservado)
  assert.ok(csv.includes('Indisponível;Indisponível;Comanda Balcão;tab-no-data'));
  assert.ok(csv.includes(';1;0;"15,00";'), 'Zero acessos confirmados deve ser exportado como 0');

  // Registro 1: Mesa 03;Indisponível;...;Indisponível (clientes indisponíveis)
  assert.ok(csv.includes('03;Indisponível;Comanda 3'));
  assert.ok(csv.includes(';1;Indisponível;"20,00";'), 'Acessos nulos devem ser exportados como Indisponível');
});

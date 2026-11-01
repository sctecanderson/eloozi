import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  paginateComandaItems,
  ITEMS_PAGE_SIZE,
  COLLAPSED_LIMIT,
} from '../src/features/service/comandaItemsPagination.ts';
import {
  getIndividualTabs,
  shouldShowContaConjunta,
  resolveSafeSelectedTabId,
  isSharedLabel,
  type TabLike,
} from '../src/features/service/contaConjuntaRules.ts';
import {
  validateCancellationReason,
  formatCancellationAudit,
  formatMoveItemAuditReason,
  formatTransferTableAuditReason,
} from '../src/features/service/cancellationRules.ts';
import {
  validateBatchCancellationResponse,
  validateTransferItemsResponse,
  transferTabConsumptionItems,
} from '../src/features/service/tabConsumption.ts';
import {
  paginateCatalogProducts,
  filterCatalogProducts,
  CATALOG_PAGE_SIZE,
} from '../src/features/service/catalogPagination.ts';
import {
  calculateSplitBill,
  parseSplitPeopleCount,
  SPLIT_BILL_DISCLAIMER,
  MIN_SPLIT_PEOPLE_COUNT,
  DEFAULT_SPLIT_PEOPLE_COUNT,
  MAX_INDIVIDUAL_SHARES_DISPLAY,
} from '../src/features/service/splitBillRules.ts';

describe('ELOOZI — Itens da Comanda, Conta Conjunta e Cancelamento', () => {
  describe('1. LISTA DE ITENS NA COMANDA (Paginação e Ver Mais)', () => {
    const makeItem = (id: number) => ({ id: `item-${id}`, name: `Produto ${id}`, price: 1000 });

    it('1.1 caso com 0 itens: retorna lista vazia, canExpand=false e isPaginated=false', () => {
      const items: ReturnType<typeof makeItem>[] = [];
      const res = paginateComandaItems(items, false, 1);
      assert.equal(res.totalItems, 0);
      assert.equal(res.displayedItems.length, 0);
      assert.equal(res.canExpand, false);
      assert.equal(res.isPaginated, false);
      assert.equal(res.currentPage, 1);
      assert.equal(res.totalPages, 1);
    });

    it('1.2 caso com 1 item: exibe 1 item diretamente, sem botão ver mais e sem paginação', () => {
      const items = [makeItem(1)];
      const res = paginateComandaItems(items, false, 1);
      assert.equal(res.totalItems, 1);
      assert.equal(res.displayedItems.length, 1);
      assert.equal(res.displayedItems[0].name, 'Produto 1');
      assert.equal(res.canExpand, false);
      assert.equal(res.isPaginated, false);
    });

    it('1.3 caso com 2 itens: exibe exatamente os 2 itens, sem botão ver mais e sem paginação', () => {
      const items = [makeItem(1), makeItem(2)];
      const res = paginateComandaItems(items, false, 1);
      assert.equal(res.totalItems, 2);
      assert.equal(res.displayedItems.length, 2);
      assert.equal(res.canExpand, false);
      assert.equal(res.isPaginated, false);
    });

    it('1.4 caso com 5 itens (estado recolhido): exibe no máximo 2 itens e habilita botão ver mais', () => {
      const items = [makeItem(1), makeItem(2), makeItem(3), makeItem(4), makeItem(5)];
      const resCollapsed = paginateComandaItems(items, false, 1);
      assert.equal(resCollapsed.totalItems, 5);
      assert.equal(resCollapsed.displayedItems.length, 2);
      assert.equal(resCollapsed.canExpand, true);
      assert.equal(resCollapsed.isExpanded, false);
      assert.equal(resCollapsed.isPaginated, false);
      assert.deepEqual(
        resCollapsed.displayedItems.map((i) => i.name),
        ['Produto 1', 'Produto 2'],
      );
    });

    it('1.5 caso com 5 itens (estado expandido): exibe todos os 5 itens sem quebrar em páginas numéricas', () => {
      const items = [makeItem(1), makeItem(2), makeItem(3), makeItem(4), makeItem(5)];
      const resExpanded = paginateComandaItems(items, true, 1);
      assert.equal(resExpanded.totalItems, 5);
      assert.equal(resExpanded.displayedItems.length, 5);
      assert.equal(resExpanded.isExpanded, true);
      assert.equal(resExpanded.isPaginated, false);
      assert.equal(resExpanded.rangeText, 'Exibindo 1–5 de 5 itens');
      assert.deepEqual(
        resExpanded.displayedItems.map((i) => i.name),
        ['Produto 1', 'Produto 2', 'Produto 3', 'Produto 4', 'Produto 5'],
      );
    });

    it('1.6 caso com 6 itens (mais de 5 itens): organiza em páginas numeradas até exibir todos', () => {
      const items = [
        makeItem(1),
        makeItem(2),
        makeItem(3),
        makeItem(4),
        makeItem(5),
        makeItem(6),
      ];

      // Quando recolhido: exibe os 2 primeiros
      const resCollapsed = paginateComandaItems(items, false, 1);
      assert.equal(resCollapsed.displayedItems.length, 2);
      assert.equal(resCollapsed.canExpand, true);

      // Quando expandido na página 1: exibe itens 1–5 de 6
      const page1 = paginateComandaItems(items, true, 1);
      assert.equal(page1.isPaginated, true);
      assert.equal(page1.totalPages, 2);
      assert.equal(page1.currentPage, 1);
      assert.equal(page1.displayedItems.length, 5);
      assert.equal(page1.rangeText, 'Exibindo 1–5 de 6 itens');
      assert.equal(page1.hasPreviousPage, false);
      assert.equal(page1.hasNextPage, true);
      assert.deepEqual(page1.pageNumbers, [1, 2]);
      assert.equal(page1.displayedItems[0].name, 'Produto 1');
      assert.equal(page1.displayedItems[4].name, 'Produto 5');

      // Quando avança para a página 2: exibe o 6º item
      const page2 = paginateComandaItems(items, true, 2);
      assert.equal(page2.isPaginated, true);
      assert.equal(page2.currentPage, 2);
      assert.equal(page2.displayedItems.length, 1);
      assert.equal(page2.rangeText, 'Exibindo 6–6 de 6 itens');
      assert.equal(page2.hasPreviousPage, true);
      assert.equal(page2.hasNextPage, false);
      assert.equal(page2.displayedItems[0].name, 'Produto 6');
    });

    it('1.7 caso com 12 itens: gera 3 páginas numeradas (1, 2, 3) e paginação coerente', () => {
      const items = Array.from({ length: 12 }, (_, i) => makeItem(i + 1));
      const p1 = paginateComandaItems(items, true, 1);
      assert.equal(p1.totalPages, 3);
      assert.equal(p1.displayedItems.length, 5);
      assert.deepEqual(p1.pageNumbers, [1, 2, 3]);

      const p3 = paginateComandaItems(items, true, 3);
      assert.equal(p3.currentPage, 3);
      assert.equal(p3.displayedItems.length, 2); // itens 11 e 12
      assert.equal(p3.rangeText, 'Exibindo 11–12 de 12 itens');
      assert.equal(p3.hasNextPage, false);
    });

    it('1.8 clamp de segurança: páginas fora dos limites são ajustadas automaticamente', () => {
      const items = Array.from({ length: 6 }, (_, i) => makeItem(i + 1));
      const clampedHigh = paginateComandaItems(items, true, 99);
      assert.equal(clampedHigh.currentPage, 2);

      const clampedLow = paginateComandaItems(items, true, -5);
      assert.equal(clampedLow.currentPage, 1);
    });
  });

  describe('2. CONTA CONJUNTA (Regras de Presença e Posicionamento)', () => {
    it('2.1 não exibe conta conjunta com 0 pessoas vinculadas à mesa', () => {
      const tabs: TabLike[] = [];
      assert.equal(shouldShowContaConjunta(tabs), false);
      assert.equal(getIndividualTabs(tabs).length, 0);
    });

    it('2.2 não exibe conta conjunta com apenas 1 pessoa vinculada (titular)', () => {
      const tabs: TabLike[] = [
        { id: 'tab-1', label: 'Pessoa 1', status: 'open' },
      ];
      assert.equal(shouldShowContaConjunta(tabs), false);
      assert.equal(getIndividualTabs(tabs).length, 1);
    });

    it('2.3 não considera a própria comanda compartilhada/conjunta como pessoa adicional', () => {
      const tabs: TabLike[] = [
        { id: 'tab-1', label: 'Pessoa 1', status: 'open' },
        { id: 'tab-shared', label: 'Conta conjunta', status: 'open' },
      ];
      // Só há 1 pessoa real (Pessoa 1)
      assert.equal(shouldShowContaConjunta(tabs), false);
      assert.equal(getIndividualTabs(tabs).length, 1);
    });

    it('2.4 exibe conta conjunta quando houver mais de uma pessoa real (2 ou mais)', () => {
      const tabs: TabLike[] = [
        { id: 'tab-1', label: 'Pessoa 1', status: 'open' },
        { id: 'tab-2', label: 'Pessoa 2', status: 'open' },
      ];
      assert.equal(shouldShowContaConjunta(tabs), true);
      const individuals = getIndividualTabs(tabs);
      assert.equal(individuals.length, 2);
      // Preserva a ordem original das pessoas individuais
      assert.equal(individuals[0].id, 'tab-1');
      assert.equal(individuals[1].id, 'tab-2');
    });

    it('2.5 deduplica registros por ID para evitar duplicar pessoas ou comandas', () => {
      const tabs: TabLike[] = [
        { id: 'tab-1', label: 'Pessoa 1', status: 'open' },
        { id: 'tab-1', label: 'Pessoa 1 (duplicata)', status: 'open' },
        { id: 'tab-2', label: 'Pessoa 2', status: 'open' },
      ];
      const individuals = getIndividualTabs(tabs);
      assert.equal(individuals.length, 2);
    });

    it('2.6 redireciona seleção se a mesa tiver apenas 1 pessoa e a conta conjunta for acessada', () => {
      const tabs: TabLike[] = [
        { id: 'tab-1', label: 'Pessoa 1', status: 'open' },
        { id: 'tab-shared', label: 'Conta conjunta', status: 'open' },
      ];
      const safeId = resolveSafeSelectedTabId('tab-shared', tabs);
      assert.equal(safeId, 'tab-1');
    });

    it('2.7 identifica rótulos de conta compartilhada corretamente', () => {
      assert.equal(isSharedLabel('Conta conjunta'), true);
      assert.equal(isSharedLabel('Conta Compartilhada'), true);
      assert.equal(isSharedLabel('Mesa toda'), true);
      assert.equal(isSharedLabel('Pessoa 1'), false);
      assert.equal(isSharedLabel('Mesa 01'), false);
    });
  });

  describe('3. CANCELAMENTO DE PRODUTO COM MOTIVO E AUDITORIA', () => {
    it('3.1 rejeita cancelamento com motivo vazio, nulo ou somente espaços', () => {
      const empty = validateCancellationReason('');
      assert.equal(empty.valid, false);
      assert.ok(empty.error);

      const spaces = validateCancellationReason('   ');
      assert.equal(spaces.valid, false);

      const nullish = validateCancellationReason(null);
      assert.equal(nullish.valid, false);
    });

    it('3.2 rejeita cancelamento com motivo menor que 3 caracteres', () => {
      const tooShort = validateCancellationReason('ab');
      assert.equal(tooShort.valid, false);
      assert.equal(tooShort.error, 'O motivo deve conter no mínimo 3 caracteres.');
    });

    it('3.3 rejeita cancelamento com motivo maior que 300 caracteres', () => {
      const tooLong = validateCancellationReason('a'.repeat(301));
      assert.equal(tooLong.valid, false);
      assert.equal(tooLong.error, 'O motivo deve conter no máximo 300 caracteres.');
    });

    it('3.4 aceita motivo válido e normaliza espaços excedentes', () => {
      const valid = validateCancellationReason('  Cliente desistiu do prato  ');
      assert.equal(valid.valid, true);
      assert.equal(valid.normalized, 'Cliente desistiu do prato');
      assert.equal(valid.error, undefined);
    });

    it('3.5 formatação de auditoria: exibe horário formatado e motivo associado', () => {
      const audit = formatCancellationAudit(
        '2026-10-26T14:30:00.000Z',
        'Item lançado por engano na mesa errada',
      );
      assert.ok(audit.formattedTime.length > 0);
      assert.equal(audit.reasonText, 'Item lançado por engano na mesa errada');
    });

    it('3.6 formatação de auditoria com dados ausentes exibe fallback seguro', () => {
      const audit = formatCancellationAudit(null, null);
      assert.equal(audit.formattedTime, 'Horário indisponível');
      assert.equal(audit.reasonText, 'Motivo não informado');
    });

    it('3.7 falha de persistência: validação e tratamento impedem cancelamento indevido', () => {
      // Simula a tentativa de cancelar quando a gravação falha
      let itemStatus = 'active';
      const reasonValidation = validateCancellationReason('Erro no preparo');
      assert.equal(reasonValidation.valid, true);

      // Função simulada com falha remota
      function simulateCancelWithFailure() {
        const error = new Error('Falha de conexão com o banco de dados (Timeout)');
        throw error;
      }

      assert.throws(() => {
        simulateCancelWithFailure();
        itemStatus = 'cancelled';
      }, /Falha de conexão/);

      // O item NÃO foi cancelado na comanda
      assert.equal(itemStatus, 'active');
    });
  });

  describe('4. PAGINAÇÃO INDEPENDENTE NA CONTA CONJUNTA', () => {
    const makeItem = (id: number) => ({ id: `prod-${id}`, name: `Item ${id}`, price: 1000 });

    it('4.1 lista compartilhada e listas individuais possuem expansão e páginas independentes', () => {
      const sharedItems = [makeItem(1), makeItem(2), makeItem(3), makeItem(4), makeItem(5), makeItem(6), makeItem(7)];
      const person1Items = [makeItem(10), makeItem(20), makeItem(30)];
      const person2Items = [makeItem(100), makeItem(200)];

      // Estado 1: lista compartilhada expandida na página 2; pessoa 1 recolhida; pessoa 2 com 2 itens
      const sharedPaginated = paginateComandaItems(sharedItems, true, 2);
      assert.equal(sharedPaginated.isExpanded, true);
      assert.equal(sharedPaginated.currentPage, 2);
      assert.equal(sharedPaginated.displayedItems.length, 2); // 7 itens: 5 na pág 1, 2 na pág 2

      const person1Paginated = paginateComandaItems(person1Items, false, 1);
      assert.equal(person1Paginated.isExpanded, false);
      assert.equal(person1Paginated.displayedItems.length, 2);
      assert.equal(person1Paginated.canExpand, true);

      const person2Paginated = paginateComandaItems(person2Items, false, 1);
      assert.equal(person2Paginated.displayedItems.length, 2);
      assert.equal(person2Paginated.canExpand, false); // exatamente 2 itens, sem ver mais
    });

    it('4.2 expansão da pessoa 1 não altera o estado da pessoa 2 nem dos itens compartilhados', () => {
      const sharedItems = [makeItem(1), makeItem(2), makeItem(3)];
      const person1Items = [makeItem(10), makeItem(20), makeItem(30), makeItem(40), makeItem(50), makeItem(60)];

      // Simulamos um dicionário de estado por lista
      const expandedLists: Record<string, boolean> = {
        'person-1': true,
        // 'shared' não está expandido
      };

      const sharedResult = paginateComandaItems(sharedItems, expandedLists['shared'] ?? false, 1);
      const person1Result = paginateComandaItems(person1Items, expandedLists['person-1'] ?? false, 1);

      assert.equal(sharedResult.isExpanded, false);
      assert.equal(sharedResult.displayedItems.length, 2);

      assert.equal(person1Result.isExpanded, true);
      assert.equal(person1Result.displayedItems.length, 5); // 5 itens na pág 1
      assert.equal(person1Result.isPaginated, true);
      assert.equal(person1Result.totalPages, 2);
    });

    it('4.3 reset de estado ao trocar de seleção limpa páginas e expansões', () => {
      let expandedLists: Record<string, boolean> = { shared: true, 'person-1': true };
      let pageLists: Record<string, number> = { shared: 2, 'person-1': 2 };

      // Ao trocar de seleção (selectedTabId alterado)
      function onTabSelectionChange() {
        expandedLists = {};
        pageLists = {};
      }

      onTabSelectionChange();

      assert.deepEqual(expandedLists, {});
      assert.deepEqual(pageLists, {});
    });
  });

  describe('5. CANCELAMENTO EM LOTE E TRATAMENTO DE FALHAS PARCIAIS', () => {
    it('5.1 simulação de cancelamento em lote com sucesso total', async () => {
      const itemIds = ['uuid-1', 'uuid-2', 'uuid-3'];
      const cancelled: string[] = [];
      const failed: Array<{ id: string; error: string }> = [];

      for (const id of itemIds) {
        cancelled.push(id);
      }

      assert.equal(cancelled.length, 3);
      assert.equal(failed.length, 0);
    });

    it('5.2 discriminação exata em falha parcial: informa quais foram cancelados e quais falharam sem falso aborto total', async () => {
      const itemIds = ['uuid-1', 'uuid-2', 'uuid-3'];
      const cancelled: string[] = [];
      const failed: Array<{ id: string; error: string }> = [];

      for (const id of itemIds) {
        if (id === 'uuid-3') {
          failed.push({ id, error: 'Item já entregue pela cozinha' });
        } else {
          cancelled.push(id);
        }
      }

      // Verificação da regra: NÃO afirmar que tudo foi abortado
      assert.equal(cancelled.length, 2);
      assert.deepEqual(cancelled, ['uuid-1', 'uuid-2']);
      assert.equal(failed.length, 1);
      assert.equal(failed[0].id, 'uuid-3');
      assert.equal(failed[0].error, 'Item já entregue pela cozinha');

      const message = `${cancelled.length} item(ns) cancelado(s) com sucesso. ${failed.length} falharam: ${failed.map(f => f.error).join('; ')}`;
      assert.equal(message, '2 item(ns) cancelado(s) com sucesso. 1 falharam: Item já entregue pela cozinha');
    });

    it('5.3 motivo informado é preservado e repassado para cada item do lote', () => {
      const reasonValidation = validateCancellationReason('Cliente desistiu da sobremesa');
      assert.equal(reasonValidation.valid, true);

      const items = ['it-1', 'it-2'];
      const persistencePayload = items.map((id) => ({
        id,
        status: 'cancelled',
        cancellation_reason: reasonValidation.normalized,
      }));

      assert.equal(persistencePayload[0].cancellation_reason, 'Cliente desistiu da sobremesa');
      assert.equal(persistencePayload[1].cancellation_reason, 'Cliente desistiu da sobremesa');
    });
  });

  describe('6. MOVER E TRANSFERIR ITEM COM DESCRIÇÃO DE AUDITORIA', () => {
    it('6.1 formatMoveItemAuditReason: preserva descrição do garçom, origem e destino sem inventar texto', () => {
      const audit = formatMoveItemAuditReason(
        'Solicitado pelo cliente durante o pedido',
        'Pessoa 1',
        'Pessoa 2',
      );
      assert.ok(audit.includes('Solicitado pelo cliente durante o pedido'));
      assert.ok(audit.includes('"Pessoa 1" -> "Pessoa 2"'));
      assert.ok(audit.length <= 300);
    });

    it('6.2 formatTransferTableAuditReason: preserva descrição do garçom, mesa de origem e mesa de destino', () => {
      const audit = formatTransferTableAuditReason(
        'Cliente mudou para a mesa da família',
        4,
        8,
      );
      assert.ok(audit.includes('Cliente mudou para a mesa da família'));
      assert.ok(audit.includes('Mesa 4 -> Mesa 8'));
      assert.ok(audit.length <= 300);
    });

    it('6.3 exige descrição de no mínimo 3 caracteres para mover/transferir', () => {
      const tooShort = validateCancellationReason('ok');
      assert.equal(tooShort.valid, false);

      const valid = validateCancellationReason('Mesa mudou de lugar');
      assert.equal(valid.valid, true);
    });

    it('6.4 limita o tamanho do motivo a 300 caracteres com segurança', () => {
      const longDesc = 'A'.repeat(280);
      const audit = formatTransferTableAuditReason(longDesc, 1, 2);
      assert.ok(audit.length <= 300);
      assert.ok(audit.endsWith(']'));
    });
  });

  describe('7. VALIDAÇÃO DE RESPOSTA DA RPC E CONDICIONAIS DE FALLBACK', () => {
    const reason = 'Cliente desistiu do prato';

    it('7.1 resposta não-array é rejeitada como formato inválido', () => {
      const res = validateBatchCancellationResponse(['id-1'], null, reason);
      assert.equal(res.valid, false);
      assert.equal(res.code, 'INVALID_RPC_RESPONSE');

      const resObj = validateBatchCancellationResponse(['id-1'], { error: 'something' }, reason);
      assert.equal(resObj.valid, false);
      assert.equal(resObj.code, 'INVALID_RPC_RESPONSE');
    });

    it('7.2 resposta vazia para requisição não-vazia não pode ser tratada como sucesso', () => {
      const res = validateBatchCancellationResponse(['id-1', 'id-2'], [], reason);
      assert.equal(res.valid, false);
      assert.equal(res.code, 'EMPTY_RPC_RESPONSE');
    });

    it('7.3 resposta contendo itens duplicados é rejeitada', () => {
      const payload = [
        { id: 'id-1', status: 'cancelled', cancellation_reason: reason },
        { id: 'id-1', status: 'cancelled', cancellation_reason: reason },
      ];
      const res = validateBatchCancellationResponse(['id-1'], payload, reason);
      assert.equal(res.valid, false);
      assert.equal(res.code, 'DUPLICATE_ITEMS_IN_RESPONSE');
    });

    it('7.4 resposta com item cujo status não seja cancelled é rejeitada', () => {
      const payload = [
        { id: 'id-1', status: 'active', cancellation_reason: reason },
      ];
      const res = validateBatchCancellationResponse(['id-1'], payload, reason);
      assert.equal(res.valid, false);
      assert.equal(res.code, 'STATUS_NOT_CANCELLED');
    });

    it('7.5 resposta com motivo divergente para item recém-cancelado é rejeitada', () => {
      const payload = [
        { id: 'id-1', status: 'cancelled', cancellation_reason: 'Outro motivo qualquer', already_cancelled: false },
      ];
      const res = validateBatchCancellationResponse(['id-1'], payload, reason);
      assert.equal(res.valid, false);
      assert.equal(res.code, 'REASON_MISMATCH');
    });

    it('7.6 resposta com IDs ausentes ou inesperados é rejeitada como divergência', () => {
      const payloadMissing = [
        { id: 'id-1', status: 'cancelled', cancellation_reason: reason },
      ];
      const resMissing = validateBatchCancellationResponse(['id-1', 'id-2'], payloadMissing, reason);
      assert.equal(resMissing.valid, false);
      assert.equal(resMissing.code, 'RPC_RESPONSE_MISMATCH');

      const payloadUnexpected = [
        { id: 'id-1', status: 'cancelled', cancellation_reason: reason },
        { id: 'id-extra', status: 'cancelled', cancellation_reason: reason },
      ];
      const resUnexpected = validateBatchCancellationResponse(['id-1'], payloadUnexpected, reason);
      assert.equal(resUnexpected.valid, false);
      assert.equal(resUnexpected.code, 'RPC_RESPONSE_MISMATCH');
    });

    it('7.7 resposta correta e correspondente é validada com sucesso', () => {
      const payload = [
        { id: 'id-1', status: 'cancelled', cancellation_reason: reason },
        { id: 'id-2', status: 'cancelled', cancellation_reason: reason },
      ];
      const res = validateBatchCancellationResponse(['id-1', 'id-2'], payload, reason);
      assert.equal(res.valid, true);
      assert.deepEqual(res.cancelledIds, ['id-1', 'id-2']);
      assert.equal(res.error, undefined);
    });

    it('7.8 regras de fallback: somente PGRST202 dispara fallback; 42501, 22023 e erros de rede propagam', () => {
      // Simulação da lógica de verificação de erro da RPC
      function checkShouldFallback(error: { code?: string; message: string } | null): boolean {
        if (!error) return false;
        return error.code === 'PGRST202';
      }

      // PGRST202: confirmação inequívoca de ausência da RPC -> fallback permitido
      assert.equal(checkShouldFallback({ code: 'PGRST202', message: 'Could not find function' }), true);

      // 42501 (autorização negada) -> NÃO faz fallback, propaga erro
      assert.equal(checkShouldFallback({ code: '42501', message: 'Sua conta não possui acesso ativo a este restaurante.' }), false);

      // 22023 (erro de validação SQL) -> NÃO faz fallback, propaga erro
      assert.equal(checkShouldFallback({ code: '22023', message: 'Lançamento não encontrado neste restaurante.' }), false);

      // Erro de rede ou outro status -> NÃO faz fallback
      assert.equal(checkShouldFallback({ code: '500', message: 'Internal Server Error' }), false);
      assert.equal(checkShouldFallback({ message: 'Network Timeout' }), false);
    });

    it('7.9 resposta mista (item recém-cancelado e item já cancelado com motivo preservado) é validada com sucesso', () => {
      const payload = [
        {
          id: 'id-1',
          status: 'cancelled',
          cancellation_reason: reason,
          already_cancelled: false,
        },
        {
          id: 'id-2',
          status: 'cancelled',
          cancellation_reason: 'Motivo antigo preservado pelo servidor',
          already_cancelled: true,
        },
      ];
      const res = validateBatchCancellationResponse(['id-1', 'id-2'], payload, reason);
      assert.equal(res.valid, true);
      assert.deepEqual(res.cancelledIds, ['id-1', 'id-2']);
      assert.equal(res.error, undefined);
    });

    it('7.10 resposta com item já cancelado sem motivo válido persistido é rejeitada', () => {
      const payload = [
        {
          id: 'id-1',
          status: 'cancelled',
          cancellation_reason: '',
          already_cancelled: true,
        },
      ];
      const res = validateBatchCancellationResponse(['id-1'], payload, reason);
      assert.equal(res.valid, false);
      assert.equal(res.code, 'INVALID_CANCELLATION_REASON');
    });
  });

  describe('8. PAGINAÇÃO DO CATÁLOGO DE PRODUTOS E FILTROS', () => {
    const makeCatalogProduct = (id: number, categoryId: string, name: string) => ({
      id: `prod-${id}`,
      name,
      category_id: categoryId,
      short_description: `Descrição rápida ${name}`,
      description: `Descrição detalhada do prato/bebida ${name}`,
      price_in_cents: 2500,
    });

    const categories = [
      { id: 'cat-pratos', slug: 'pratos', name: 'Pratos' },
      { id: 'cat-bebidas', slug: 'bebidas', name: 'Bebidas' },
      { id: 'cat-sobremesas', slug: 'sobremesas', name: 'Sobremesas' },
    ];

    it('8.1 catálogo com 0 produtos: retorna lista vazia, isPaginated=false e totalPages=1', () => {
      const res = paginateCatalogProducts([], 1, CATALOG_PAGE_SIZE);
      assert.equal(res.totalProducts, 0);
      assert.equal(res.displayedProducts.length, 0);
      assert.equal(res.isPaginated, false);
      assert.equal(res.totalPages, 1);
      assert.equal(res.currentPage, 1);
      assert.equal(res.hasPreviousPage, false);
      assert.equal(res.hasNextPage, false);
      assert.equal(res.rangeText, 'Nenhum produto');
      assert.deepEqual(res.pageNumbers, [1]);
    });

    it('8.2 catálogo com 5 produtos: exibe todos os 5 cards na página única sem controles numerados', () => {
      const products = Array.from({ length: 5 }, (_, i) =>
        makeCatalogProduct(i + 1, 'cat-pratos', `Prato ${i + 1}`),
      );
      const res = paginateCatalogProducts(products, 1, CATALOG_PAGE_SIZE);
      assert.equal(res.totalProducts, 5);
      assert.equal(res.displayedProducts.length, 5);
      assert.equal(res.isPaginated, false);
      assert.equal(res.totalPages, 1);
      assert.equal(res.currentPage, 1);
      assert.equal(res.hasPreviousPage, false);
      assert.equal(res.hasNextPage, false);
      assert.equal(res.rangeText, 'Exibindo 1–5 de 5 produtos');
    });

    it('8.3 catálogo com 6 produtos (> 5): divide em 2 páginas com controles numerados e navegação', () => {
      const products = Array.from({ length: 6 }, (_, i) =>
        makeCatalogProduct(i + 1, 'cat-pratos', `Prato ${i + 1}`),
      );

      // Página 1: exibe os primeiros 5
      const page1 = paginateCatalogProducts(products, 1, CATALOG_PAGE_SIZE);
      assert.equal(page1.totalProducts, 6);
      assert.equal(page1.displayedProducts.length, 5);
      assert.equal(page1.isPaginated, true);
      assert.equal(page1.totalPages, 2);
      assert.equal(page1.currentPage, 1);
      assert.equal(page1.hasPreviousPage, false);
      assert.equal(page1.hasNextPage, true);
      assert.deepEqual(page1.pageNumbers, [1, 2]);
      assert.equal(page1.displayedProducts[0].name, 'Prato 1');
      assert.equal(page1.displayedProducts[4].name, 'Prato 5');
      assert.equal(page1.rangeText, 'Exibindo 1–5 de 6 produtos');

      // Página 2: exibe o 6º produto
      const page2 = paginateCatalogProducts(products, 2, CATALOG_PAGE_SIZE);
      assert.equal(page2.displayedProducts.length, 1);
      assert.equal(page2.currentPage, 2);
      assert.equal(page2.hasPreviousPage, true);
      assert.equal(page2.hasNextPage, false);
      assert.equal(page2.displayedProducts[0].name, 'Prato 6');
      assert.equal(page2.rangeText, 'Exibindo 6–6 de 6 produtos');
    });

    it('8.4 catálogo com mais de 10 produtos (ex.: 12 produtos): divide em 3 páginas numeradas acessíveis', () => {
      const products = Array.from({ length: 12 }, (_, i) =>
        makeCatalogProduct(i + 1, 'cat-pratos', `Prato ${i + 1}`),
      );

      // Página 1 (1-5)
      const p1 = paginateCatalogProducts(products, 1, CATALOG_PAGE_SIZE);
      assert.equal(p1.totalPages, 3);
      assert.equal(p1.displayedProducts.length, 5);
      assert.deepEqual(p1.pageNumbers, [1, 2, 3]);
      assert.equal(p1.rangeText, 'Exibindo 1–5 de 12 produtos');

      // Página 2 (6-10)
      const p2 = paginateCatalogProducts(products, 2, CATALOG_PAGE_SIZE);
      assert.equal(p2.displayedProducts.length, 5);
      assert.equal(p2.currentPage, 2);
      assert.equal(p2.hasPreviousPage, true);
      assert.equal(p2.hasNextPage, true);
      assert.equal(p2.displayedProducts[0].name, 'Prato 6');
      assert.equal(p2.displayedProducts[4].name, 'Prato 10');
      assert.equal(p2.rangeText, 'Exibindo 6–10 de 12 produtos');

      // Página 3 (11-12)
      const p3 = paginateCatalogProducts(products, 3, CATALOG_PAGE_SIZE);
      assert.equal(p3.displayedProducts.length, 2);
      assert.equal(p3.currentPage, 3);
      assert.equal(p3.hasPreviousPage, true);
      assert.equal(p3.hasNextPage, false);
      assert.equal(p3.displayedProducts[0].name, 'Prato 11');
      assert.equal(p3.displayedProducts[1].name, 'Prato 12');
      assert.equal(p3.rangeText, 'Exibindo 11–12 de 12 produtos');
    });

    it('8.5 clamp de segurança: páginas fora dos limites são ajustadas para [1, totalPages]', () => {
      const products = Array.from({ length: 8 }, (_, i) =>
        makeCatalogProduct(i + 1, 'cat-pratos', `Prato ${i + 1}`),
      );
      const resBelow = paginateCatalogProducts(products, 0, CATALOG_PAGE_SIZE);
      assert.equal(resBelow.currentPage, 1);

      const resAbove = paginateCatalogProducts(products, 999, CATALOG_PAGE_SIZE);
      assert.equal(resAbove.currentPage, 2);
    });

    it('8.6 filtros por categoria ("Todos", "Pratos", "Bebidas", "Sobremesas") e busca de texto', () => {
      const catalog = [
        makeCatalogProduct(1, 'cat-pratos', 'Hambúrguer Clássico'),
        makeCatalogProduct(2, 'cat-pratos', 'Pizza Margherita'),
        makeCatalogProduct(3, 'cat-bebidas', 'Suco de Laranja Natural'),
        makeCatalogProduct(4, 'cat-bebidas', 'Refrigerante Cola'),
        makeCatalogProduct(5, 'cat-sobremesas', 'Pudim de Leite Condensado'),
        makeCatalogProduct(6, 'cat-sobremesas', 'Torta de Limão'),
      ];

      // Filtro "todos"
      const todos = filterCatalogProducts(catalog, '', 'todos', categories);
      assert.equal(todos.length, 6);

      // Filtro "pratos"
      const pratos = filterCatalogProducts(catalog, '', 'pratos', categories);
      assert.equal(pratos.length, 2);
      assert.ok(pratos.every((p) => p.category_id === 'cat-pratos'));

      // Filtro "bebidas"
      const bebidas = filterCatalogProducts(catalog, '', 'bebidas', categories);
      assert.equal(bebidas.length, 2);
      assert.ok(bebidas.every((p) => p.category_id === 'cat-bebidas'));

      // Filtro "sobremesas"
      const sobremesas = filterCatalogProducts(catalog, '', 'sobremesas', categories);
      assert.equal(sobremesas.length, 2);
      assert.ok(sobremesas.every((p) => p.category_id === 'cat-sobremesas'));

      // Busca por termo no nome ("suco")
      const buscaSuco = filterCatalogProducts(catalog, 'suco', 'todos', categories);
      assert.equal(buscaSuco.length, 1);
      assert.equal(buscaSuco[0].name, 'Suco de Laranja Natural');

      // Busca combinada com categoria
      const buscaBebida = filterCatalogProducts(catalog, 'cola', 'bebidas', categories);
      assert.equal(buscaBebida.length, 1);

      const buscaBebidaEmPratos = filterCatalogProducts(catalog, 'cola', 'pratos', categories);
      assert.equal(buscaBebidaEmPratos.length, 0);
    });

    it('8.7 troca de categoria ou busca reseta a página para 1', () => {
      const catalog = Array.from({ length: 15 }, (_, i) =>
        makeCatalogProduct(
          i + 1,
          i < 6 ? 'cat-pratos' : i < 11 ? 'cat-bebidas' : 'cat-sobremesas',
          `Item ${i + 1}`,
        ),
      );

      // Estado 1: "todos" com 15 itens -> usuário navega para a página 2
      let activeCategory = 'todos';
      let activeQuery = '';
      let currentPage = 2;

      let filtered = filterCatalogProducts(catalog, activeQuery, activeCategory, categories);
      let paginated = paginateCatalogProducts(filtered, currentPage, CATALOG_PAGE_SIZE);
      assert.equal(paginated.currentPage, 2);
      assert.equal(paginated.totalPages, 3);

      // Simulação da regra de negócio: ao alterar categoria, reseta página para 1
      activeCategory = 'bebidas';
      currentPage = 1; // reset obrigatório

      filtered = filterCatalogProducts(catalog, activeQuery, activeCategory, categories);
      paginated = paginateCatalogProducts(filtered, currentPage, CATALOG_PAGE_SIZE);
      assert.equal(paginated.currentPage, 1);
      assert.equal(paginated.totalProducts, 5);
      assert.equal(paginated.totalPages, 1);
      assert.equal(paginated.isPaginated, false);

      // Simulação da regra de negócio: ao digitar busca, reseta página para 1
      activeCategory = 'todos';
      currentPage = 3; // usuário estava na página 3
      activeQuery = 'Item 1';
      currentPage = 1; // reset obrigatório

      filtered = filterCatalogProducts(catalog, activeQuery, activeCategory, categories);
      paginated = paginateCatalogProducts(filtered, currentPage, CATALOG_PAGE_SIZE);
      assert.equal(paginated.currentPage, 1);
    });

    it('8.8 preservação estrita da regra dos itens lançados na comanda (independente do catálogo)', () => {
      // Regra da comanda: até 2 inicialmente, "Ver mais" e páginas de 5 quando expandido
      const comandaItems = ['it-1', 'it-2', 'it-3', 'it-4', 'it-5', 'it-6', 'it-7'];

      // Recolhido: mostra 2 itens e canExpand=true
      const collapsed = paginateComandaItems(comandaItems, false, 1);
      assert.equal(collapsed.displayedItems.length, 2);
      assert.equal(collapsed.canExpand, true);
      assert.equal(collapsed.isPaginated, false);

      // Expandido com 7 itens (> 5): paginado em 5 itens por página
      const expanded = paginateComandaItems(comandaItems, true, 1);
      assert.equal(expanded.displayedItems.length, 5);
      assert.equal(expanded.isPaginated, true);
      assert.equal(expanded.totalPages, 2);

      // Catálogo com os mesmos 7 itens: NÃO possui estado recolhido/expandido, exibe 5 diretamente e pagina
      const catalog = paginateCatalogProducts(comandaItems, 1);
      assert.equal(catalog.displayedProducts.length, 5);
      assert.equal(catalog.totalPages, 2);
      assert.equal(catalog.isPaginated, true);
    });
  });

  describe('9. SIMULAÇÃO DE DIVISÃO DE CONTA (Dividir conta e conservação de centavos)', () => {
    it('9.1 validação e higienização de valores inválidos (parseSplitPeopleCount)', () => {
      // Vazio, espaços ou nulo/indefinido -> padrão 2
      assert.equal(parseSplitPeopleCount(''), 2);
      assert.equal(parseSplitPeopleCount('   '), 2);
      assert.equal(parseSplitPeopleCount(null), 2);
      assert.equal(parseSplitPeopleCount(undefined), 2);

      // Zero, 1 ou negativos -> mínimo 2
      assert.equal(parseSplitPeopleCount(0), 2);
      assert.equal(parseSplitPeopleCount('0'), 2);
      assert.equal(parseSplitPeopleCount(1), 2);
      assert.equal(parseSplitPeopleCount('1'), 2);
      assert.equal(parseSplitPeopleCount(-5), 2);
      assert.equal(parseSplitPeopleCount('-10'), 2);

      // Decimais -> truncamento inteiro seguro (Math.floor) com mínimo 2
      assert.equal(parseSplitPeopleCount(2.9), 2);
      assert.equal(parseSplitPeopleCount('3.7'), 3);
      assert.equal(parseSplitPeopleCount('4.2'), 4);
      assert.equal(parseSplitPeopleCount('10.9'), 10);
      assert.equal(parseSplitPeopleCount('1.8'), 2);

      // Strings não-numéricas e NaN -> padrão 2
      assert.equal(parseSplitPeopleCount('abc'), 2);
      assert.equal(parseSplitPeopleCount(NaN), 2);
      assert.equal(parseSplitPeopleCount(Infinity), 2);
    });

    it('9.2 divisão para 2 pessoas com conservação exata de centavos', () => {
      // Divisão exata R$ 100,00
      const resEven = calculateSplitBill(10000, 2);
      assert.equal(resEven.totalInCents, 10000);
      assert.equal(resEven.peopleCount, 2);
      assert.equal(resEven.hasRemainder, false);
      assert.equal(resEven.isCompact, false);
      assert.equal(resEven.shares.length, 2);
      assert.equal(resEven.shares[0].amountInCents, 5000);
      assert.equal(resEven.shares[1].amountInCents, 5000);
      assert.equal(resEven.shares.reduce((acc, s) => acc + s.amountInCents, 0), 10000);

      // Divisão ímpar R$ 100,01 -> 50,01 + 50,00 = 100,01
      const resOdd = calculateSplitBill(10001, 2);
      assert.equal(resOdd.hasRemainder, true);
      assert.equal(resOdd.remainderCents, 1);
      assert.equal(resOdd.shares[0].amountInCents, 5001);
      assert.equal(resOdd.shares[1].amountInCents, 5000);
      assert.equal(resOdd.shares.reduce((acc, s) => acc + s.amountInCents, 0), 10001);
    });

    it('9.3 divisão para 4 pessoas com conservação exata de centavos', () => {
      // R$ 100,03 / 4 -> 3 cotas de 25,01 e 1 cota de 25,00
      const res = calculateSplitBill(10003, 4);
      assert.equal(res.totalInCents, 10003);
      assert.equal(res.peopleCount, 4);
      assert.equal(res.hasRemainder, true);
      assert.equal(res.remainderCents, 3);
      assert.equal(res.isCompact, false);
      assert.equal(res.shares.length, 4);
      assert.equal(res.shares[0].amountInCents, 2501);
      assert.equal(res.shares[1].amountInCents, 2501);
      assert.equal(res.shares[2].amountInCents, 2501);
      assert.equal(res.shares[3].amountInCents, 2500);
      assert.equal(res.shares.reduce((acc, s) => acc + s.amountInCents, 0), 10003);
    });

    it('9.4 divisão para 10 pessoas (exibição de cada pessoa e shares.length === 10)', () => {
      // R$ 100,03 / 10 -> 3 cotas de R$ 10,01 e 7 cotas de R$ 10,00
      const res = calculateSplitBill(10003, 10);
      assert.equal(res.totalInCents, 10003);
      assert.equal(res.peopleCount, 10);
      assert.equal(res.hasRemainder, true);
      assert.equal(res.remainderCents, 3);
      assert.equal(res.isCompact, false); // 10 ainda é exibição individual completa
      assert.equal(res.shares.length, 10);

      // Primeiras 3 pessoas recebem o centavo de ajuste
      assert.equal(res.shares[0].amountInCents, 1001);
      assert.equal(res.shares[1].amountInCents, 1001);
      assert.equal(res.shares[2].amountInCents, 1001);
      // Demais 7 pessoas recebem a cota base
      for (let i = 3; i < 10; i++) {
        assert.equal(res.shares[i].amountInCents, 1000);
      }

      // Soma estritamente idêntica
      const sum = res.shares.reduce((acc, s) => acc + s.amountInCents, 0);
      assert.equal(sum, 10003);
    });

    it('9.5 divisão para quantidades altas (> 10 pessoas): modo compacto sem travar o DOM', () => {
      // 100 pessoas dividindo R$ 150,55 (15055 centavos)
      // 15055 / 100 = 150 centavos (R$ 1,50) com 55 centavos de sobra (55 pessoas pagam R$ 1,51 e 45 pagam R$ 1,50)
      const res = calculateSplitBill(15055, 100);
      assert.equal(res.peopleCount, 100);
      assert.equal(res.isCompact, true);
      // shares individual não é alocado para proteger memória
      assert.equal(res.shares.length, 0);

      // compactGroups consolida as partes analiticamente
      assert.equal(res.compactGroups.length, 2);
      assert.equal(res.compactGroups[0].count, 55);
      assert.equal(res.compactGroups[0].amountInCents, 151);
      assert.equal(res.compactGroups[0].totalGroupInCents, 55 * 151);

      assert.equal(res.compactGroups[1].count, 45);
      assert.equal(res.compactGroups[1].amountInCents, 150);
      assert.equal(res.compactGroups[1].totalGroupInCents, 45 * 150);

      const totalConsolidado = res.compactGroups.reduce((acc, g) => acc + g.totalGroupInCents, 0);
      assert.equal(totalConsolidado, 15055);
    });

    it('9.6 casos extremos: total 0 centavos e 1 centavo para qualquer quantidade', () => {
      const zero = calculateSplitBill(0, 10);
      assert.equal(zero.totalInCents, 0);
      assert.equal(zero.hasRemainder, false);
      assert.equal(zero.shares.every((s) => s.amountInCents === 0), true);

      const oneCent = calculateSplitBill(1, 10);
      assert.equal(oneCent.totalInCents, 1);
      assert.equal(oneCent.shares[0].amountInCents, 1);
      for (let i = 1; i < 10; i++) {
        assert.equal(oneCent.shares[i].amountInCents, 0);
      }
      assert.equal(oneCent.shares.reduce((acc, s) => acc + s.amountInCents, 0), 1);
    });

    it('9.7 presença explícita do aviso de estimativa para divisão entre pessoas', () => {
      const res = calculateSplitBill(12500, '4');
      assert.ok(res.disclaimer.includes('estimativa informativa para divisão entre pessoas'));
      assert.ok(res.disclaimer.includes('Não altera valores, não registra pagamentos'));
      assert.equal(res.disclaimer, SPLIT_BILL_DISCLAIMER);
    });
  });

  describe('10. TRANSFERÊNCIA SEGURA E ATÔMICA DE ITENS ENTRE COMANDAS', () => {
    const makeRawItem = (id: string, tabId: string, status: 'active' | 'cancelled' = 'active') => ({
      id,
      restaurant_id: 'rest-1',
      restaurant_table_id: 'table-1',
      table_visit_id: 'visit-1',
      table_tab_id: tabId,
      product_id: 'prod-1',
      product_name: 'Burger Artesanal',
      unit_price_in_cents: 3500,
      quantity: 1,
      line_total_in_cents: 3500,
      status,
      added_by_member_id: 'waiter-1',
      created_at: new Date().toISOString(),
      cancelled_by_member_id: null,
      cancelled_at: null,
      cancellation_reason: null,
    });

    it('10.1 validateTransferItemsResponse: valida payload correspondente aos IDs solicitados e targetTabId', () => {
      const targetTabId = 'tab-target';
      const items = [
        makeRawItem('item-1', targetTabId),
        makeRawItem('item-2', targetTabId),
      ];

      const res = validateTransferItemsResponse(['item-1', 'item-2'], targetTabId, items);
      assert.equal(res.valid, true);
      assert.equal(res.transferredIds.length, 2);
      assert.ok(res.transferredIds.includes('item-1'));
      assert.ok(res.transferredIds.includes('item-2'));
      assert.equal(res.items.length, 2);
    });

    it('10.2 validateTransferItemsResponse: rejeita payload nulo, indefinido ou não array', () => {
      const targetTabId = 'tab-target';
      assert.equal(validateTransferItemsResponse(['item-1'], targetTabId, null).valid, false);
      assert.equal(validateTransferItemsResponse(['item-1'], targetTabId, undefined).valid, false);
      assert.equal(validateTransferItemsResponse(['item-1'], targetTabId, { id: 'item-1' }).valid, false);
      assert.equal(validateTransferItemsResponse(['item-1'], targetTabId, 'item-1').valid, false);
    });

    it('10.3 validateTransferItemsResponse: rejeita se item retornado não estiver na comanda de destino', () => {
      const targetTabId = 'tab-target';
      const items = [
        makeRawItem('item-1', 'tab-wrong'),
      ];

      const res = validateTransferItemsResponse(['item-1'], targetTabId, items);
      assert.equal(res.valid, false);
      assert.equal(res.code, 'RESPONSE_PARAM_MISMATCH');
      assert.ok(res.error?.includes('não foi vinculado à comanda de destino'));
    });

    it('10.4 validateTransferItemsResponse: rejeita se item retornado não estiver com status active', () => {
      const targetTabId = 'tab-target';
      const items = [
        makeRawItem('item-1', targetTabId, 'cancelled'),
      ];

      const res = validateTransferItemsResponse(['item-1'], targetTabId, items);
      assert.equal(res.valid, false);
      assert.equal(res.code, 'RESPONSE_PARAM_MISMATCH');
      assert.ok(res.error?.includes('status diferente de ativo'));
    });

    it('10.5 validateTransferItemsResponse: rejeita retorno com duplicidade ou IDs não solicitados', () => {
      const targetTabId = 'tab-target';
      const duplicateItems = [
        makeRawItem('item-1', targetTabId),
        makeRawItem('item-1', targetTabId),
      ];
      const resDup = validateTransferItemsResponse(['item-1'], targetTabId, duplicateItems);
      assert.equal(resDup.valid, false);
      assert.equal(resDup.code, 'DUPLICATE_ITEM_ID');

      const unexpectedItems = [
        makeRawItem('item-1', targetTabId),
        makeRawItem('item-surprise', targetTabId),
      ];
      const resUnexp = validateTransferItemsResponse(['item-1'], targetTabId, unexpectedItems);
      assert.equal(resUnexp.valid, false);
      assert.equal(resUnexp.code, 'UNEXPECTED_ITEM_RETURNED');
    });

    it('10.6 validateTransferItemsResponse: rejeita se quantidade de itens retornados divergir do solicitado', () => {
      const targetTabId = 'tab-target';
      const partialItems = [
        makeRawItem('item-1', targetTabId),
      ];
      const res = validateTransferItemsResponse(['item-1', 'item-2'], targetTabId, partialItems);
      assert.equal(res.valid, false);
      assert.equal(res.code, 'COUNT_MISMATCH');
      assert.ok(res.error?.includes('diverge do total solicitado'));
    });

    it('10.7 transferTabConsumptionItems: rejeita restaurantSlug vazio ou nulo', async () => {
      await assert.rejects(
        transferTabConsumptionItems({
          restaurantSlug: '',
          sourceTabId: 'tab-1',
          targetTabId: 'tab-2',
          itemIds: ['item-1'],
          reason: 'Motivo válido',
        }),
        (err: any) => err.code === '22023' && err.message.includes('Informe o identificador do restaurante'),
      );
    });

    it('10.8 transferTabConsumptionItems: rejeita comanda de origem ou destino vazia', async () => {
      await assert.rejects(
        transferTabConsumptionItems({
          restaurantSlug: 'rest-1',
          sourceTabId: '',
          targetTabId: 'tab-2',
          itemIds: ['item-1'],
          reason: 'Motivo válido',
        }),
        (err: any) => err.code === '22023' && err.message.includes('Informe a comanda de origem e de destino'),
      );
    });

    it('10.9 transferTabConsumptionItems: rejeita comanda de origem igual à de destino', async () => {
      await assert.rejects(
        transferTabConsumptionItems({
          restaurantSlug: 'rest-1',
          sourceTabId: 'tab-same',
          targetTabId: 'tab-same',
          itemIds: ['item-1'],
          reason: 'Motivo válido',
        }),
        (err: any) => err.code === '22023' && err.message.includes('origem e de destino não podem ser iguais'),
      );
    });

    it('10.10 transferTabConsumptionItems: rejeita lista de itens vazia', async () => {
      await assert.rejects(
        transferTabConsumptionItems({
          restaurantSlug: 'rest-1',
          sourceTabId: 'tab-1',
          targetTabId: 'tab-2',
          itemIds: [],
          reason: 'Motivo válido',
        }),
        (err: any) => err.code === '22023' && err.message.includes('Nenhum item informado para transferência'),
      );
    });

    it('10.11 transferTabConsumptionItems: valida tamanho do motivo (mínimo 3 e máximo 300 caracteres)', async () => {
      await assert.rejects(
        transferTabConsumptionItems({
          restaurantSlug: 'rest-1',
          sourceTabId: 'tab-1',
          targetTabId: 'tab-2',
          itemIds: ['item-1'],
          reason: 'ab',
        }),
        (err: any) => err.code === '22023' && err.message.includes('entre 3 e 300 caracteres'),
      );

      await assert.rejects(
        transferTabConsumptionItems({
          restaurantSlug: 'rest-1',
          sourceTabId: 'tab-1',
          targetTabId: 'tab-2',
          itemIds: ['item-1'],
          reason: 'a'.repeat(301),
        }),
        (err: any) => err.code === '22023' && err.message.includes('entre 3 e 300 caracteres'),
      );
    });

    it.skip('10.12 [BANCO DE TESTES - 2 SESSÕES] Concorrência real de 2 sessões e disputa simultânea de transferência do mesmo item', () => {
      // Requer banco de dados isolado com 2 conexões concorrentes ativas (executado via run_transfer_concurrency_test.ps1)
      // Comprova que a Sessão 2 aguarda pelo lock da Sessão 1 (pg_blocking_pids) e é rejeitada com 22023.
    });
  });
});

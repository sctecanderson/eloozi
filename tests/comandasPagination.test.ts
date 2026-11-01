import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMANDAS_PER_PAGE,
  computePaginationInfo,
  paginateList,
  getPaginationPageNumbers,
} from '../src/features/service/comandasPagination';

// ============================================================================
// TESTES DE PAGINAÇÃO DE COMANDAS (0, 5, 6, 10, 18 itens)
// ============================================================================

test('1.1 computePaginationInfo com 0 itens: calcula totais zerados e texto informativo', () => {
  const info = computePaginationInfo(0, 1, COMANDAS_PER_PAGE);

  assert.equal(info.totalItems, 0);
  assert.equal(info.totalPages, 1);
  assert.equal(info.currentPage, 1);
  assert.equal(info.startIndex, 0);
  assert.equal(info.endIndex, 0);
  assert.equal(info.displayText, 'Nenhuma comanda');

  const items = paginateList([], 1);
  assert.deepEqual(items, []);
});

test('1.2 computePaginationInfo com 5 itens (limite de 1 página): exibe 1–5 de 5 comandas', () => {
  const info = computePaginationInfo(5, 1, COMANDAS_PER_PAGE);

  assert.equal(info.totalItems, 5);
  assert.equal(info.totalPages, 1);
  assert.equal(info.currentPage, 1);
  assert.equal(info.startIndex, 1);
  assert.equal(info.endIndex, 5);
  assert.equal(info.displayText, 'Exibindo 1–5 de 5 comandas');

  const dummyList = [1, 2, 3, 4, 5];
  const page1 = paginateList(dummyList, 1);
  assert.deepEqual(page1, [1, 2, 3, 4, 5]);
});

test('1.3 computePaginationInfo com 6 itens (2 páginas): testa limites da página 1 e página 2', () => {
  // Página 1
  const infoP1 = computePaginationInfo(6, 1, COMANDAS_PER_PAGE);
  assert.equal(infoP1.totalItems, 6);
  assert.equal(infoP1.totalPages, 2);
  assert.equal(infoP1.currentPage, 1);
  assert.equal(infoP1.startIndex, 1);
  assert.equal(infoP1.endIndex, 5);
  assert.equal(infoP1.displayText, 'Exibindo 1–5 de 6 comandas');

  // Página 2
  const infoP2 = computePaginationInfo(6, 2, COMANDAS_PER_PAGE);
  assert.equal(infoP2.totalItems, 6);
  assert.equal(infoP2.totalPages, 2);
  assert.equal(infoP2.currentPage, 2);
  assert.equal(infoP2.startIndex, 6);
  assert.equal(infoP2.endIndex, 6);
  assert.equal(infoP2.displayText, 'Exibindo 6–6 de 6 comandas');

  const dummyList = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
  const p1Items = paginateList(dummyList, 1);
  assert.deepEqual(p1Items, ['c1', 'c2', 'c3', 'c4', 'c5']);

  const p2Items = paginateList(dummyList, 2);
  assert.deepEqual(p2Items, ['c6']);
});

test('1.4 computePaginationInfo com 10 itens (exatamente 2 páginas cheias)', () => {
  const infoP1 = computePaginationInfo(10, 1, COMANDAS_PER_PAGE);
  assert.equal(infoP1.displayText, 'Exibindo 1–5 de 10 comandas');

  const infoP2 = computePaginationInfo(10, 2, COMANDAS_PER_PAGE);
  assert.equal(infoP2.displayText, 'Exibindo 6–10 de 10 comandas');

  const dummyList = Array.from({ length: 10 }, (_, i) => `cmd-${i + 1}`);
  assert.equal(paginateList(dummyList, 1).length, 5);
  assert.equal(paginateList(dummyList, 2).length, 5);
});

test('1.5 computePaginationInfo com 18 itens (4 páginas): testa navegação e texto real', () => {
  const dummyList = Array.from({ length: 18 }, (_, i) => `item-${i + 1}`);

  // Página 1: 1 a 5
  const infoP1 = computePaginationInfo(18, 1, COMANDAS_PER_PAGE);
  assert.equal(infoP1.totalPages, 4);
  assert.equal(infoP1.displayText, 'Exibindo 1–5 de 18 comandas');
  assert.deepEqual(paginateList(dummyList, 1), ['item-1', 'item-2', 'item-3', 'item-4', 'item-5']);

  // Página 2: 6 a 10
  const infoP2 = computePaginationInfo(18, 2, COMANDAS_PER_PAGE);
  assert.equal(infoP2.displayText, 'Exibindo 6–10 de 18 comandas');
  assert.deepEqual(paginateList(dummyList, 2), ['item-6', 'item-7', 'item-8', 'item-9', 'item-10']);

  // Página 3: 11 a 15
  const infoP3 = computePaginationInfo(18, 3, COMANDAS_PER_PAGE);
  assert.equal(infoP3.displayText, 'Exibindo 11–15 de 18 comandas');
  assert.deepEqual(paginateList(dummyList, 3), ['item-11', 'item-12', 'item-13', 'item-14', 'item-15']);

  // Página 4: 16 a 18
  const infoP4 = computePaginationInfo(18, 4, COMANDAS_PER_PAGE);
  assert.equal(infoP4.displayText, 'Exibindo 16–18 de 18 comandas');
  assert.deepEqual(paginateList(dummyList, 4), ['item-16', 'item-17', 'item-18']);
});

test('1.6 Ajuste de página quando filtro/busca reduz o número de registros (clamp de segurança)', () => {
  // Usuário estava na página 4 com 18 itens
  // Filtro de busca reduz para 3 itens (1 página apenas)
  const info = computePaginationInfo(3, 4, COMANDAS_PER_PAGE);

  assert.equal(info.totalItems, 3);
  assert.equal(info.totalPages, 1);
  assert.equal(info.currentPage, 1, 'Página deve ser reajustada para 1 quando ultrapassar totalPages');
  assert.equal(info.displayText, 'Exibindo 1–3 de 3 comandas');

  const dummy3 = ['a', 'b', 'c'];
  assert.deepEqual(paginateList(dummy3, 4), ['a', 'b', 'c']);
});

test('1.7 Página com número negativo ou zero é ajustada para 1', () => {
  const info = computePaginationInfo(12, -2, COMANDAS_PER_PAGE);
  assert.equal(info.currentPage, 1);
  assert.equal(info.startIndex, 1);
  assert.equal(info.endIndex, 5);
});

// ============================================================================
// TESTES DE GERAÇÃO DE NÚMEROS DE PÁGINAS (Barra de Paginação)
// ============================================================================

test('2.1 getPaginationPageNumbers: gera sequência simples para poucas páginas', () => {
  assert.deepEqual(getPaginationPageNumbers(1, 1), [1]);
  assert.deepEqual(getPaginationPageNumbers(1, 2), [1, 2]);
  assert.deepEqual(getPaginationPageNumbers(2, 4), [1, 2, 3, 4]);
  assert.deepEqual(getPaginationPageNumbers(3, 5), [1, 2, 3, 4, 5]);
});

test('2.2 getPaginationPageNumbers: inclui reticências em paginação longa', () => {
  // Próximo do início
  assert.deepEqual(getPaginationPageNumbers(1, 10), [1, 2, 3, 4, '...', 10]);
  assert.deepEqual(getPaginationPageNumbers(2, 10), [1, 2, 3, 4, '...', 10]);

  // No meio
  assert.deepEqual(getPaginationPageNumbers(5, 10), [1, '...', 4, 5, 6, '...', 10]);

  // Próximo do final
  assert.deepEqual(getPaginationPageNumbers(9, 10), [1, '...', 7, 8, 9, 10]);
  assert.deepEqual(getPaginationPageNumbers(10, 10), [1, '...', 7, 8, 9, 10]);
});

// ============================================================================
// TESTES DE INTEGRIDADE: PRESERVAÇÃO DE ORDENAÇÃO E BUSCA
// ============================================================================

test('3.1 paginateList preserva a ordem exata dos elementos filtrados e ordenados', () => {
  const sortedCards = [
    { id: '1', label: 'Comanda A', totalInCents: 5000 },
    { id: '2', label: 'Comanda B', totalInCents: 4000 },
    { id: '3', label: 'Comanda C', totalInCents: 3000 },
    { id: '4', label: 'Comanda D', totalInCents: 2000 },
    { id: '5', label: 'Comanda E', totalInCents: 1000 },
    { id: '6', label: 'Comanda F', totalInCents: 500 },
  ];

  const p1 = paginateList(sortedCards, 1);
  assert.equal(p1[0].id, '1');
  assert.equal(p1[4].id, '5');

  const p2 = paginateList(sortedCards, 2);
  assert.equal(p2[0].id, '6');
});

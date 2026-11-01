import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    isValidUuid,
    getStoredTableCandidate,
    persistValidTable,
    purgeStoredTable,
    getTableStorageKey,
    getTableQueryString,
    type TableContext,
} from '../src/features/tables/tableContextCore.ts';

// Mock simples de sessionStorage para ambiente Node.js de testes
class MockSessionStorage {
    private store = new Map<string, string>();

    getItem(key: string): string | null {
        return this.store.get(key) ?? null;
    }

    setItem(key: string, value: string): void {
        this.store.set(key, String(value));
    }

    removeItem(key: string): void {
        this.store.delete(key);
    }

    clear(): void {
        this.store.clear();
    }
}

// Injeta sessionStorage mock global para os testes
(globalThis as unknown as { sessionStorage: MockSessionStorage }).sessionStorage = new MockSessionStorage();

describe('ELOOZI — Table Context & SessionStorage Integrity Tests', () => {
    beforeEach(() => {
        sessionStorage.clear();
    });

    describe('1. isValidUuid & Validação Estrita de Identificadores', () => {
        it('1.1 aceita UUID v4 padrão', () => {
            assert.equal(isValidUuid('b78bb988-cb94-4d83-9b62-1b1e938981f3'), true);
            assert.equal(isValidUuid('40c49bc2-3c58-450f-a393-27cf9efda832'), true);
        });

        it('1.2 rejeita terminantemente identificadores fictícios como "mesa-01"', () => {
            assert.equal(isValidUuid('mesa-01'), false);
            assert.equal(isValidUuid('mesa-1'), false);
            assert.equal(isValidUuid('01'), false);
        });

        it('1.3 rejeita valores vazios, nulos, indefinidos ou malformatados', () => {
            assert.equal(isValidUuid(''), false);
            assert.equal(isValidUuid(null), false);
            assert.equal(isValidUuid(undefined), false);
            assert.equal(isValidUuid('b78bb988-cb94-4d83-9b62'), false);
        });
    });

    describe('2. getStoredTableCandidate & Higienização Ativa do Armazenamento Local', () => {
        it('2.1 purga e descarta contextos antigos contendo "mesa-01"', () => {
            const key = getTableStorageKey('noma');
            sessionStorage.setItem(key, JSON.stringify({
                restaurantSlug: 'noma',
                tableId: 'mesa-01',
                tableNumber: '01',
                tableName: 'Mesa 01',
            }));

            const candidate = getStoredTableCandidate('noma');
            assert.equal(candidate, null);
            // Verifica se a chave foi expurgada do sessionStorage
            assert.equal(sessionStorage.getItem(key), null);
        });

        it('2.2 purga e descarta contextos com UUID vazio ou malformatado', () => {
            const key = getTableStorageKey('noma');
            sessionStorage.setItem(key, JSON.stringify({
                restaurantSlug: 'noma',
                tableId: '',
                tableNumber: '02',
                tableName: 'Mesa 02',
            }));

            const candidate = getStoredTableCandidate('noma');
            assert.equal(candidate, null);
            assert.equal(sessionStorage.getItem(key), null);
        });

        it('2.3 descarta se o restaurantSlug armazenado for de outro restaurante (multi-tenant isolation)', () => {
            const key = getTableStorageKey('noma');
            sessionStorage.setItem(key, JSON.stringify({
                restaurantSlug: 'outro-restaurante',
                tableId: 'b78bb988-cb94-4d83-9b62-1b1e938981f3',
                tableNumber: '03',
                tableName: 'Mesa 03',
            }));

            const candidate = getStoredTableCandidate('noma');
            assert.equal(candidate, null);
            assert.equal(sessionStorage.getItem(key), null);
        });

        it('2.4 recupera candidato quando contém UUID válido e dados íntegros', () => {
            const validUuid = 'b78bb988-cb94-4d83-9b62-1b1e938981f3';
            const key = getTableStorageKey('noma');
            sessionStorage.setItem(key, JSON.stringify({
                restaurantSlug: 'noma',
                restaurantId: 'rest-uuid-123',
                tableId: validUuid,
                tableNumber: '04',
                tableName: 'Mesa 04',
            }));

            const candidate = getStoredTableCandidate('noma');
            assert.notEqual(candidate, null);
            assert.equal(candidate?.tableId, validUuid);
            assert.equal(candidate?.tableNumber, '04');
        });
    });

    describe('3. persistValidTable', () => {
        it('3.1 bloqueia gravação de "mesa-01" ou identificador fictício no sessionStorage', () => {
            const key = getTableStorageKey('noma');
            persistValidTable('noma', 'rest-1', '01', 'mesa-01', 'Mesa 01');
            assert.equal(sessionStorage.getItem(key), null);
        });

        it('3.2 bloqueia gravação com UUID vazio', () => {
            const key = getTableStorageKey('noma');
            persistValidTable('noma', 'rest-1', '01', '', 'Mesa 01');
            assert.equal(sessionStorage.getItem(key), null);
        });

        it('3.3 grava com sucesso quando o UUID é real e válido', () => {
            const validUuid = 'b78bb988-cb94-4d83-9b62-1b1e938981f3';
            const key = getTableStorageKey('noma');
            persistValidTable('noma', 'rest-1', '05', validUuid, 'Mesa 05');
            const stored = sessionStorage.getItem(key);
            assert.notEqual(stored, null);
            assert.equal(JSON.parse(stored!).tableId, validUuid);
            assert.equal(JSON.parse(stored!).tableNumber, '05');
        });
    });

    describe('4. getTableQueryString & Navegação Segura', () => {
        it('4.1 retorna query string com UUID ?t=... para mesa unverified válida', () => {
            const validUuid = 'b78bb988-cb94-4d83-9b62-1b1e938981f3';
            const ctx: TableContext = {
                status: 'unverified',
                restaurantSlug: 'noma',
                tableId: validUuid,
                tableNumber: '02',
                tableName: 'Mesa 02',
            };
            assert.equal(getTableQueryString(ctx), `?t=${validUuid}`);
        });

        it('4.2 nunca gera ?t=mesa-01 com identificador fictício', () => {
            const ctx: TableContext = {
                status: 'unverified',
                restaurantSlug: 'noma',
                tableId: 'mesa-01',
                tableNumber: '01',
                tableName: 'Mesa 01',
            };
            // Deve ignorar o tableId fictício e recorrer ao número de mesa ou vazio
            assert.equal(getTableQueryString(ctx), '?mesa=01');
        });

        it('4.3 retorna query vazia quando status for absent, invalid ou expired', () => {
            const absentCtx: TableContext = { status: 'absent', restaurantSlug: 'noma' };
            const invalidCtx: TableContext = { status: 'invalid', restaurantSlug: 'noma', reason: 'Erro' };
            const expiredCtx: TableContext = { status: 'expired', restaurantSlug: 'noma' };

            assert.equal(getTableQueryString(absentCtx), '');
            assert.equal(getTableQueryString(invalidCtx), '');
            assert.equal(getTableQueryString(expiredCtx), '');
        });
    });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    formatCountdown,
    formatConfirmationDigits,
    getActiveTabStep,
    isWaiterCallActive,
    secondsUntil,
} from '../src/features/service/customerTabVisual.ts';

describe('ELOOZI — Customer Tab Visual & Logic Unit Tests', () => {
    describe('1. formatCountdown', () => {
        it('1.1 formata corretamente 578 segundos como 09:38 (valor da referência visual)', () => {
            assert.equal(formatCountdown(578), '09:38');
        });

        it('1.2 formata 0 e valores negativos como 00:00 sem quebrar', () => {
            assert.equal(formatCountdown(0), '00:00');
            assert.equal(formatCountdown(-15), '00:00');
        });

        it('1.3 formata minutos e segundos exatos com zero à esquerda', () => {
            assert.equal(formatCountdown(60), '01:00');
            assert.equal(formatCountdown(9), '00:09');
            assert.equal(formatCountdown(605), '10:05');
        });
    });

    describe('2. formatConfirmationDigits & Cópia Numérica', () => {
        it('2.1 separa o código de 6 dígitos em dois blocos de 3 dígitos (ex: 498 507)', () => {
            const res = formatConfirmationDigits('498507');
            assert.equal(res.group1, '498');
            assert.equal(res.group2, '507');
            assert.equal(res.formatted, '498 507');
            assert.equal(res.raw, '498507');
        });

        it('2.2 preserva zeros à esquerda no código de 6 dígitos (ex: 001234 -> 001 234 e raw: 001234)', () => {
            const res = formatConfirmationDigits('001234');
            assert.equal(res.group1, '001');
            assert.equal(res.group2, '234');
            assert.equal(res.formatted, '001 234');
            assert.equal(res.raw, '001234');
        });

        it('2.3 garante que o valor de cópia (raw) contém estritamente os 6 dígitos numéricos sem espaço', () => {
            const res = formatConfirmationDigits(789012);
            assert.equal(res.raw, '789012');
            assert.equal(res.raw.includes(' '), false);
            assert.equal(res.raw.length, 6);
        });

        it('2.4 código nulo ou indefinido retorna traços e raw vazio sem lançar erro', () => {
            const resNull = formatConfirmationDigits(null);
            assert.equal(resNull.formatted, '--- ---');
            assert.equal(resNull.raw, '');

            const resUndef = formatConfirmationDigits(undefined);
            assert.equal(resUndef.formatted, '--- ---');
            assert.equal(resUndef.raw, '');
        });
    });

    describe('3. getActiveTabStep (Indicador horizontal de 3 passos)', () => {
        it('3.1 passo 1 ativo em initial, pending_with_code e pending_no_code', () => {
            assert.equal(getActiveTabStep('initial'), 1);
            assert.equal(getActiveTabStep('pending_with_code'), 1);
            assert.equal(getActiveTabStep('pending_no_code'), 1);
        });

        it('3.2 passo 2 ativo quando mesa for confirmada pelo garçom (active_waiting_tab)', () => {
            assert.equal(getActiveTabStep('active_waiting_tab'), 2);
        });

        it('3.3 passo 3 ativo quando a comanda estiver vinculada (active_linked_tab) ou pronta com consumo (ready)', () => {
            assert.equal(getActiveTabStep('active_linked_tab'), 3);
            assert.equal(getActiveTabStep('ready'), 3);
        });

        it('3.4 passo 0 quando atendimento estiver encerrado (closed)', () => {
            assert.equal(getActiveTabStep('closed'), 0);
        });
    });

    describe('4. isWaiterCallActive (Badge de notificação do garçom)', () => {
        it('4.1 exibe notificação apenas quando houver chamado ativo com status pending ou attended', () => {
            assert.equal(isWaiterCallActive({ status: 'pending' }), true);
            assert.equal(isWaiterCallActive({ status: 'attended' }), true);
        });

        it('4.2 não exibe notificação para chamados concluídos ou cancelados', () => {
            assert.equal(isWaiterCallActive({ status: 'completed' }), false);
            assert.equal(isWaiterCallActive({ status: 'cancelled' }), false);
        });

        it('4.3 não exibe notificação (bolinhas decorativas falsas) quando request for null ou indefinido', () => {
            assert.equal(isWaiterCallActive(null), false);
            assert.equal(isWaiterCallActive(undefined), false);
        });
    });

    describe('5. secondsUntil', () => {
        it('5.1 calcula segundos restantes até data de expiração futura', () => {
            const now = 1700000000000;
            const expires = new Date(now + 30000).toISOString();
            assert.equal(secondsUntil(expires, now), 30);
        });

        it('5.2 retorna 0 quando data já expirou no passado', () => {
            const now = 1700000000000;
            const expired = new Date(now - 10000).toISOString();
            assert.equal(secondsUntil(expired, now), 0);
        });
    });
});

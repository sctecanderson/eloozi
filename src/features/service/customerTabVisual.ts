/**
 * Utilitários compartilhados para renderização e regras da tela de Comanda do Cliente.
 */

export function secondsUntil(expiresAt: string, nowMs = Date.now()): number {
    return Math.max(0, Math.ceil((Date.parse(expiresAt) - nowMs) / 1000));
}

export function formatCountdown(seconds: number): string {
    const mins = Math.floor(Math.max(0, seconds) / 60);
    const secs = Math.max(0, seconds) % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export interface FormattedConfirmationCode {
    group1: string;
    group2: string;
    formatted: string;
    raw: string;
}

export function formatConfirmationDigits(code: string | number | null | undefined): FormattedConfirmationCode {
    if (!code) {
        return {
            group1: '---',
            group2: '---',
            formatted: '--- ---',
            raw: '',
        };
    }

    const digitsOnly = String(code).replace(/\D/g, '');
    const padded = digitsOnly.padStart(6, '0').slice(-6);
    const group1 = padded.slice(0, 3);
    const group2 = padded.slice(3, 6);

    return {
        group1,
        group2,
        formatted: `${group1} ${group2}`,
        raw: padded,
    };
}

export function getActiveTabStep(mode: 'initial' | 'pending_with_code' | 'pending_no_code' | 'active_waiting_tab' | 'active_linked_tab' | 'ready' | 'closed'): number {
    switch (mode) {
        case 'initial':
        case 'pending_with_code':
        case 'pending_no_code':
            return 1;
        case 'active_waiting_tab':
            return 2;
        case 'active_linked_tab':
        case 'ready':
            return 3;
        case 'closed':
        default:
            return 0;
    }
}

export function isWaiterCallActive(request: { status: string } | null | undefined): boolean {
    if (!request || !request.status) return false;
    return request.status === 'pending' || request.status === 'attended';
}

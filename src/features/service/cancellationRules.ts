export interface CancellationValidation {
  valid: boolean;
  error?: string;
  normalized: string;
}

/**
 * Validação rigorosa do motivo de cancelamento conforme especificação e constraint do banco:
 * Exige descrição do motivo antes de confirmar, com tamanho entre 3 e 300 caracteres.
 */
export function validateCancellationReason(reason: string | null | undefined): CancellationValidation {
  if (!reason) {
    return {
      valid: false,
      error: 'Informe a descrição do motivo do cancelamento.',
      normalized: '',
    };
  }

  const normalized = reason.trim();
  if (normalized.length < 3) {
    return {
      valid: false,
      error: 'O motivo deve conter no mínimo 3 caracteres.',
      normalized,
    };
  }

  if (normalized.length > 300) {
    return {
      valid: false,
      error: 'O motivo deve conter no máximo 300 caracteres.',
      normalized,
    };
  }

  return {
    valid: true,
    normalized,
  };
}

/**
 * Formata os dados de auditoria para exibição administrativa.
 */
export function formatCancellationAudit(
  cancelledAt: string | null | undefined,
  reason: string | null | undefined,
): { formattedTime: string; reasonText: string } {
  let formattedTime = 'Horário indisponível';
  if (cancelledAt) {
    try {
      const d = new Date(cancelledAt);
      if (!Number.isNaN(d.getTime())) {
        formattedTime = d.toLocaleTimeString('pt-BR', {
          hour: '2-digit',
          minute: '2-digit',
        });
      }
    } catch {
      // ignore
    }
  }

  const reasonText = (reason || '').trim() || 'Motivo não informado';
  return { formattedTime, reasonText };
}

/**
 * Formata o motivo de auditoria para movimentação de item entre pessoas, preservando
 * a descrição informada pelo garçom junto com a indicação explícita de origem e destino.
 */
export function formatMoveItemAuditReason(
  waiterDescription: string,
  originLabel: string,
  destinationLabel: string,
): string {
  const desc = waiterDescription.trim();
  const suffix = `[Movimentação: "${originLabel}" -> "${destinationLabel}"]`;
  const combined = `${desc} ${suffix}`.trim();
  if (combined.length <= 300) {
    return combined;
  }
  const maxDescLen = 300 - suffix.length - 1;
  return `${desc.slice(0, maxDescLen)} ${suffix}`;
}

/**
 * Formata o motivo de auditoria para transferência de item entre mesas, preservando
 * a descrição informada pelo garçom junto com a indicação explícita de origem e destino.
 */
export function formatTransferTableAuditReason(
  waiterDescription: string,
  originTable: string | number,
  destinationTable: string | number,
): string {
  const desc = waiterDescription.trim();
  const suffix = `[Transferência: Mesa ${originTable} -> Mesa ${destinationTable}]`;
  const combined = `${desc} ${suffix}`.trim();
  if (combined.length <= 300) {
    return combined;
  }
  const maxDescLen = 300 - suffix.length - 1;
  return `${desc.slice(0, maxDescLen)} ${suffix}`;
}

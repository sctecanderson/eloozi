/**
 * splitBillRules.ts
 *
 * Regras puras para simulação de divisão de conta a partir de 2 pessoas (sem limite artificial).
 * Controle com botões “−” / “+” e campo numérico editável.
 * Distribuição exata de centavos para garantir que a soma das partes seja
 * rigorosamente idêntica ao total exibido na tela.
 *
 * Exibição individual para quantidades comuns (ex: 2, 3, 4, 10 pessoas)
 * e exibição compacta consolidada para grupos grandes, prevenindo sobrecarga de DOM.
 *
 * Simulação meramente informativa: não altera banco, não fecha comandas nem registra pagamentos.
 */

export const MIN_SPLIT_PEOPLE_COUNT = 2;
export const DEFAULT_SPLIT_PEOPLE_COUNT = 2;
export const MAX_INDIVIDUAL_SHARES_DISPLAY = 10;

/** Opções clássicas mantidas para compatibilidade retroativa */
export const SPLIT_BILL_PEOPLE_OPTIONS = [2, 3, 4] as const;
export type SplitBillPeopleCount = number;

export const SPLIT_BILL_DISCLAIMER =
  'Simulação visual e estimativa informativa para divisão entre pessoas. Não altera valores, não registra pagamentos, não cria comandas e não fecha o atendimento no sistema. O acerto é feito diretamente entre as pessoas.';

export type SplitShare = {
  personIndex: number;
  label: string;
  amountInCents: number;
};

export type CompactSplitGroup = {
  count: number;
  amountInCents: number;
  totalGroupInCents: number;
  label: string;
};

export type SplitBillResult = {
  totalInCents: number;
  peopleCount: number;
  baseAmountInCents: number;
  remainderCents: number;
  hasRemainder: boolean;
  isCompact: boolean;
  shares: SplitShare[];
  compactGroups: CompactSplitGroup[];
  summaryMessage: string;
  disclaimer: string;
};

/**
 * Valida e higieniza a quantidade de pessoas:
 * - Trata valores vazios, nulos, indefinidos ou malformatados -> 2
 * - Converte números decimais para inteiros (Math.floor)
 * - Valores menores que 2 (zero, negativos, 1) -> mínimo 2
 */
export function parseSplitPeopleCount(input: unknown): number {
  if (input === null || input === undefined) return DEFAULT_SPLIT_PEOPLE_COUNT;

  if (typeof input === 'number') {
    if (!Number.isFinite(input) || isNaN(input)) return DEFAULT_SPLIT_PEOPLE_COUNT;
    const intVal = Math.floor(input);
    return Math.max(MIN_SPLIT_PEOPLE_COUNT, intVal);
  }

  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return DEFAULT_SPLIT_PEOPLE_COUNT;
    const num = Number(trimmed.replace(',', '.'));
    if (!Number.isFinite(num) || isNaN(num)) return DEFAULT_SPLIT_PEOPLE_COUNT;
    const intVal = Math.floor(num);
    return Math.max(MIN_SPLIT_PEOPLE_COUNT, intVal);
  }

  return DEFAULT_SPLIT_PEOPLE_COUNT;
}

/**
 * Calcula a divisão do total da comanda entre N pessoas (a partir de 2, sem limite artificial).
 * Eventual resto da divisão inteira em centavos é distribuído nas primeiras cotas
 * para que sum(shares.amountInCents) ou sum(compactGroups.totalGroupInCents) === totalInCents.
 */
export function calculateSplitBill(
  totalInCents: number,
  peopleCountInput: unknown,
): SplitBillResult {
  const safeTotal = Math.max(0, Math.round(Number.isFinite(totalInCents) ? totalInCents : 0));
  const safeCount = parseSplitPeopleCount(peopleCountInput);

  const baseAmountInCents = Math.floor(safeTotal / safeCount);
  const remainderCents = safeTotal % safeCount;
  const hasRemainder = remainderCents > 0;
  const isCompact = safeCount > MAX_INDIVIDUAL_SHARES_DISPLAY;

  // Geração da lista individual para quantidades comuns (até 10 pessoas)
  const shares: SplitShare[] = [];
  if (!isCompact) {
    for (let i = 0; i < safeCount; i++) {
      const amountInCents = i < remainderCents ? baseAmountInCents + 1 : baseAmountInCents;
      shares.push({
        personIndex: i + 1,
        label: `Pessoa ${i + 1}`,
        amountInCents,
      });
    }
  }

  // Grupos consolidados compactos sempre calculados analiticamente em O(1)
  const compactGroups: CompactSplitGroup[] = [];
  if (hasRemainder) {
    compactGroups.push({
      count: remainderCents,
      amountInCents: baseAmountInCents + 1,
      totalGroupInCents: remainderCents * (baseAmountInCents + 1),
      label: `${remainderCents} ${remainderCents === 1 ? 'pessoa' : 'pessoas'}`,
    });
    compactGroups.push({
      count: safeCount - remainderCents,
      amountInCents: baseAmountInCents,
      totalGroupInCents: (safeCount - remainderCents) * baseAmountInCents,
      label: `${safeCount - remainderCents} ${safeCount - remainderCents === 1 ? 'pessoa' : 'pessoas'}`,
    });
  } else {
    compactGroups.push({
      count: safeCount,
      amountInCents: baseAmountInCents,
      totalGroupInCents: safeTotal,
      label: `${safeCount} pessoas`,
    });
  }

  const summaryMessage = hasRemainder
    ? `Diferença de ${remainderCents} ${remainderCents === 1 ? 'centavo ajustada' : 'centavos ajustada'} nas primeiras cotas para fechar o total exato.`
    : 'Divisão exata sem sobra de centavos.';

  return {
    totalInCents: safeTotal,
    peopleCount: safeCount,
    baseAmountInCents,
    remainderCents,
    hasRemainder,
    isCompact,
    shares,
    compactGroups,
    summaryMessage,
    disclaimer: SPLIT_BILL_DISCLAIMER,
  };
}

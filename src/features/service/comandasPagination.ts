export const COMANDAS_PER_PAGE = 5;

export interface PaginationInfo {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  startIndex: number;
  endIndex: number;
  displayText: string;
}

/**
 * Calcula metadados de paginação com limites e textos reais.
 */
export function computePaginationInfo(
  totalItems: number,
  currentPage: number,
  pageSize = COMANDAS_PER_PAGE
): PaginationInfo {
  const safeTotal = Math.max(0, totalItems);
  const totalPages = Math.max(1, Math.ceil(safeTotal / pageSize));
  const safePage = Math.min(Math.max(1, currentPage), totalPages);

  const startIndex = safeTotal === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const endIndex = Math.min(safePage * pageSize, safeTotal);

  const displayText =
    safeTotal === 0
      ? 'Nenhuma comanda'
      : `Exibindo ${startIndex}–${endIndex} de ${safeTotal} ${safeTotal === 1 ? 'comanda' : 'comandas'}`;

  return {
    currentPage: safePage,
    totalPages,
    totalItems: safeTotal,
    startIndex,
    endIndex,
    displayText,
  };
}

/**
 * Fatura a lista mantendo a página solicitada dentro dos limites válidos.
 */
export function paginateList<T>(
  items: T[],
  currentPage: number,
  pageSize = COMANDAS_PER_PAGE
): T[] {
  if (!items || items.length === 0) return [];
  const { currentPage: validPage } = computePaginationInfo(items.length, currentPage, pageSize);
  const start = (validPage - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

/**
 * Gera lista de números de páginas para barra de paginação com indicador de reticências quando aplicável.
 */
export function getPaginationPageNumbers(current: number, total: number): (number | '...')[] {
  if (total <= 5) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }

  if (current <= 3) {
    return [1, 2, 3, 4, '...', total];
  }

  if (current >= total - 2) {
    return [1, '...', total - 3, total - 2, total - 1, total];
  }

  return [1, '...', current - 1, current, current + 1, '...', total];
}

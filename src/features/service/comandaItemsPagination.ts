export interface PaginationResult<T> {
  displayedItems: T[];
  totalItems: number;
  isExpanded: boolean;
  canExpand: boolean;
  isPaginated: boolean;
  currentPage: number;
  totalPages: number;
  startIndex: number;
  endIndex: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
  rangeText: string;
  pageNumbers: number[];
}

export const ITEMS_PAGE_SIZE = 5;
export const COLLAPSED_LIMIT = 2;

/**
 * Organiza os itens da comanda conforme as regras da especificação:
 * - Exibe no máximo 2 itens inicialmente.
 * - Se houver mais itens (> 2), disponibiliza o botão "Ver mais".
 * - Se o total for de 3 a 5 itens e estiver expandido, exibe todos os itens diretamente.
 * - Se o total passar de 5 itens (> 5) e estiver expandido, organiza a lista em páginas numeradas (1, 2, 3...) com controles anterior/próxima.
 */
export function paginateComandaItems<T>(
  items: T[],
  isExpanded: boolean,
  page: number,
  pageSize: number = ITEMS_PAGE_SIZE,
): PaginationResult<T> {
  const totalItems = items.length;
  const canExpand = totalItems > COLLAPSED_LIMIT;

  // Estado recolhido (máximo 2 itens) ou quando há 2 ou menos itens no total
  if (!isExpanded || !canExpand) {
    const displayedItems = canExpand ? items.slice(0, COLLAPSED_LIMIT) : items;
    return {
      displayedItems,
      totalItems,
      isExpanded: false,
      canExpand,
      isPaginated: false,
      currentPage: 1,
      totalPages: 1,
      startIndex: 0,
      endIndex: displayedItems.length,
      hasPreviousPage: false,
      hasNextPage: false,
      rangeText: totalItems > 0 ? `Exibindo 1–${displayedItems.length} de ${totalItems} itens` : 'Nenhum item',
      pageNumbers: [1],
    };
  }

  // Estado expandido com até 5 itens (sem necessidade de paginação numérica)
  if (totalItems <= pageSize) {
    return {
      displayedItems: items,
      totalItems,
      isExpanded: true,
      canExpand: true,
      isPaginated: false,
      currentPage: 1,
      totalPages: 1,
      startIndex: 0,
      endIndex: totalItems,
      hasPreviousPage: false,
      hasNextPage: false,
      rangeText: `Exibindo 1–${totalItems} de ${totalItems} itens`,
      pageNumbers: [1],
    };
  }

  // Estado expandido com mais de 5 itens: paginação ativa
  const totalPages = Math.ceil(totalItems / pageSize);
  const safePage = Math.max(1, Math.min(page, totalPages));
  const startIndex = (safePage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalItems);
  const displayedItems = items.slice(startIndex, endIndex);

  const pageNumbers = Array.from({ length: totalPages }, (_, i) => i + 1);

  return {
    displayedItems,
    totalItems,
    isExpanded: true,
    canExpand: true,
    isPaginated: true,
    currentPage: safePage,
    totalPages,
    startIndex,
    endIndex,
    hasPreviousPage: safePage > 1,
    hasNextPage: safePage < totalPages,
    rangeText: `Exibindo ${startIndex + 1}–${endIndex} de ${totalItems} itens`,
    pageNumbers,
  };
}

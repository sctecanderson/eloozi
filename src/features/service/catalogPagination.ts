export interface CatalogPaginationResult<T> {
  displayedProducts: T[];
  totalProducts: number;
  currentPage: number;
  totalPages: number;
  isPaginated: boolean;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
  startIndex: number;
  endIndex: number;
  rangeText: string;
  pageNumbers: number[];
}

export const CATALOG_PAGE_SIZE = 5;

/**
 * Organiza a paginação do catálogo de produtos:
 * - Exibe no máximo 5 cards por página.
 * - Se houver mais de 5 produtos (> 5), organiza em páginas numeradas e anterior/próxima.
 * - Se houver 5 ou menos produtos (<= 5), exibe todos diretamente sem controles de paginação (isPaginated = false).
 * - Proteção por clamp de limites seguros para página atual [1, totalPages].
 */
export function paginateCatalogProducts<T>(
  products: T[],
  page: number,
  pageSize: number = CATALOG_PAGE_SIZE,
): CatalogPaginationResult<T> {
  const totalProducts = products.length;

  if (totalProducts <= pageSize) {
    return {
      displayedProducts: products,
      totalProducts,
      currentPage: 1,
      totalPages: 1,
      isPaginated: false,
      hasPreviousPage: false,
      hasNextPage: false,
      startIndex: 0,
      endIndex: totalProducts,
      rangeText:
        totalProducts > 0
          ? `Exibindo 1–${totalProducts} de ${totalProducts} produtos`
          : 'Nenhum produto',
      pageNumbers: [1],
    };
  }

  const totalPages = Math.ceil(totalProducts / pageSize);
  const safePage = Math.max(1, Math.min(page, totalPages));
  const startIndex = (safePage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalProducts);
  const displayedProducts = products.slice(startIndex, endIndex);
  const pageNumbers = Array.from({ length: totalPages }, (_, i) => i + 1);

  return {
    displayedProducts,
    totalProducts,
    currentPage: safePage,
    totalPages,
    isPaginated: true,
    hasPreviousPage: safePage > 1,
    hasNextPage: safePage < totalPages,
    startIndex,
    endIndex,
    rangeText: `Exibindo ${startIndex + 1}–${endIndex} de ${totalProducts} produtos`,
    pageNumbers,
  };
}

export interface CatalogFilterCategory {
  id: string;
  slug?: string;
  name: string;
}

export interface CatalogFilterProduct {
  id: string;
  category_id?: string;
  name: string;
  short_description?: string;
  description?: string;
}

/**
 * Aplica os filtros atuais do catálogo ("Todos", "Pratos", "Bebidas", "Sobremesas" e busca textual):
 * - Busca compara título, descrição curta e descrição completa (case-insensitive).
 * - Categoria "todos" retorna todas as opções aprovadas na busca.
 * - Categoria específica compara por slug ou id.
 */
export function filterCatalogProducts<
  P extends CatalogFilterProduct,
  C extends CatalogFilterCategory
>(
  products: P[],
  searchQuery: string,
  selectedCategory: string,
  categories: C[],
): P[] {
  const query = searchQuery.trim().toLowerCase();

  return products.filter((prod) => {
    const matchesSearch =
      query === '' ||
      prod.name.toLowerCase().includes(query) ||
      (Boolean(prod.short_description) && prod.short_description!.toLowerCase().includes(query)) ||
      (Boolean(prod.description) && prod.description!.toLowerCase().includes(query));

    if (!matchesSearch) return false;
    if (selectedCategory === 'todos') return true;

    const cat = categories.find(
      (c) => c.slug === selectedCategory || c.id === selectedCategory,
    );
    if (!cat) return true;

    return prod.category_id === cat.id;
  });
}

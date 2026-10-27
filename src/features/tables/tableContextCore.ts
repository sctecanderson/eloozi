export interface StoredTableData {
  restaurantSlug: string;
  restaurantId?: string;
  tableId: string;
  tableNumber: string;
  tableName: string;
}

export type TableContext =
  | {
      status: 'loading';
      restaurantSlug: string;
      tableId?: null;
      tableNumber?: null;
      tableName?: null;
      retry?: () => void;
    }
  | {
      status: 'absent';
      restaurantSlug: string;
      tableId?: null;
      tableNumber?: null;
      tableName?: null;
      retry?: () => void;
    }
  | {
      status: 'invalid';
      restaurantSlug: string;
      reason?: string;
      tableId?: null;
      tableNumber?: null;
      tableName?: null;
      retry?: () => void;
    }
  | {
      status: 'expired';
      restaurantSlug: string;
      reason?: string;
      tableId?: null;
      tableNumber?: null;
      tableName?: null;
      retry?: () => void;
    }
  | {
      status: 'unverified';
      restaurantSlug: string;
      tableNumber: string;
      tableId: string;
      tableName: string;
      retry?: () => void;
    };

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validador estrito de formato UUID.
 * Garante que parâmetros malformados (ex.: ?t=123 ou ?t=mesa-01) não quebrem a aplicação
 * nem disparem erros de tipo no PostgreSQL.
 */
export function isValidUuid(val: string | null | undefined): val is string {
  if (!val) return false;
  return UUID_REGEX.test(val.trim());
}

export function getTableStorageKey(slug: string): string {
  return `eloozi_table_${slug}`;
}

export function purgeStoredTable(slug: string): void {
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(getTableStorageKey(slug));
    }
  } catch {
    // ignore
  }
}

/**
 * Recupera e faz a higienização imediata de dados legados no sessionStorage.
 * Descarta identificadores fictícios como "mesa-01", UUIDs inválidos ou dados corrompidos.
 */
export function getStoredTableCandidate(slug: string): StoredTableData | null {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    const raw = sessionStorage.getItem(getTableStorageKey(slug));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !parsed.tableId ||
      !isValidUuid(parsed.tableId) ||
      parsed.tableId === 'mesa-01' ||
      !parsed.tableNumber ||
      parsed.restaurantSlug !== slug
    ) {
      purgeStoredTable(slug);
      return null;
    }
    return parsed as StoredTableData;
  } catch {
    purgeStoredTable(slug);
    return null;
  }
}

/**
 * Salva apenas mesas comprovadamente válidas (com UUID real do banco e sem dados fictícios).
 */
export function persistValidTable(
  slug: string,
  restaurantId: string | undefined,
  tableNumber: string,
  tableId: string,
  tableName: string
): void {
  if (!isValidUuid(tableId) || tableId === 'mesa-01' || !tableNumber) return;
  try {
    if (typeof sessionStorage !== 'undefined') {
      const data: StoredTableData = {
        restaurantSlug: slug,
        restaurantId,
        tableId,
        tableNumber,
        tableName,
      };
      sessionStorage.setItem(getTableStorageKey(slug), JSON.stringify(data));
    }
  } catch {
    // ignore
  }
}

/**
 * Retorna a query string canônica para preservação da mesa na navegação interna.
 * Prioriza o UUID seguro (?t=...) emitido pelo QR Code.
 * Mantém ?mesa=XX caso seja o formato de fallback legado.
 */
export function getTableQueryString(table: TableContext | null | undefined): string {
  if (table && table.status === 'unverified') {
    if (table.tableId && isValidUuid(table.tableId) && table.tableId !== 'mesa-01') {
      return `?t=${table.tableId}`;
    }
    if (table.tableNumber && /^\d{1,3}$/.test(table.tableNumber)) {
      return `?mesa=${table.tableNumber}`;
    }
  }
  return '';
}

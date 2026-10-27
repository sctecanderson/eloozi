import { supabase } from '../../lib/supabase';

export interface StaffOperationalContext {
  restaurantId: string;
  restaurantSlug: string;
  tableId: string;
  tableNumber: number;
  tableVisitId: string;
  tableTabId: string | null;
  searchQuery?: string;
  scrollPosition?: number;
  updatedAt: number;
}

export type OperationalValidationResult =
  | {
      status: 'valid';
      tableVisitId: string;
      tableTabId: string | null;
      tableNumber: number;
      tableId: string;
    }
  | {
      status: 'visit_closed';
      tableNumber: number;
      tableVisitId: string;
    }
  | {
      status: 'unauthorized';
      tableNumber: number;
    }
  | {
      status: 'invalid';
      reason?: string;
    };

const STORAGE_KEY_PREFIX = 'eloozi:staff:op_ctx:';

function getTableAuthorizedKey(restaurantId: string, tableNumber: number, visitId?: string): string {
  return `noma_mesa_autorizada_${restaurantId}_${tableNumber}${visitId ? `_${visitId}` : ''}`;
}

export function isTableLocallyAuthorized(restaurantId: string, tableNumber: number, visitId?: string): boolean {
  try {
    if (visitId && localStorage.getItem(getTableAuthorizedKey(restaurantId, tableNumber, visitId)) === 'true') {
      return true;
    }
    return localStorage.getItem(getTableAuthorizedKey(restaurantId, tableNumber)) === 'true';
  } catch {
    return false;
  }
}

export function setTableLocallyAuthorized(restaurantId: string, tableNumber: number, visitId?: string): void {
  try {
    localStorage.setItem(getTableAuthorizedKey(restaurantId, tableNumber), 'true');
    if (visitId) {
      localStorage.setItem(getTableAuthorizedKey(restaurantId, tableNumber, visitId), 'true');
    }
  } catch {
    // ignore
  }
}

export function clearTableLocallyAuthorized(restaurantId: string, tableNumber: number, visitId?: string): void {
  try {
    localStorage.removeItem(getTableAuthorizedKey(restaurantId, tableNumber));
    if (visitId) {
      localStorage.removeItem(getTableAuthorizedKey(restaurantId, tableNumber, visitId));
    }
  } catch {
    // ignore
  }
}

export function getOperationalContext(restaurantId: string): StaffOperationalContext | null {
  if (!restaurantId) return null;
  try {
    const raw = sessionStorage.getItem(`${STORAGE_KEY_PREFIX}${restaurantId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StaffOperationalContext;
    if (!parsed.restaurantId || !parsed.tableVisitId || !parsed.tableNumber) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveOperationalContext(
  context: Omit<StaffOperationalContext, 'updatedAt'>
): void {
  if (!context.restaurantId) return;
  try {
    const full: StaffOperationalContext = {
      ...context,
      updatedAt: Date.now(),
    };
    sessionStorage.setItem(`${STORAGE_KEY_PREFIX}${context.restaurantId}`, JSON.stringify(full));
  } catch {
    // ignore
  }
}

export function clearOperationalContext(restaurantId?: string): void {
  try {
    if (restaurantId) {
      sessionStorage.removeItem(`${STORAGE_KEY_PREFIX}${restaurantId}`);
    } else {
      const keysToRemove: string[] = [];
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (key && key.startsWith(STORAGE_KEY_PREFIX)) {
          keysToRemove.push(key);
        }
      }
      for (const k of keysToRemove) {
        sessionStorage.removeItem(k);
      }
    }
  } catch {
    // ignore
  }
}

export function updateOperationalTab(restaurantId: string, tableTabId: string | null): void {
  const ctx = getOperationalContext(restaurantId);
  if (ctx) {
    saveOperationalContext({
      ...ctx,
      tableTabId,
    });
  }
}

export function updateOperationalSearch(restaurantId: string, searchQuery: string): void {
  const ctx = getOperationalContext(restaurantId);
  if (ctx) {
    saveOperationalContext({
      ...ctx,
      searchQuery,
    });
  }
}

export function updateOperationalScroll(restaurantId: string, scrollPosition: number): void {
  const ctx = getOperationalContext(restaurantId);
  if (ctx) {
    saveOperationalContext({
      ...ctx,
      scrollPosition,
    });
  }
}

export async function validateOperationalContext(
  context: StaffOperationalContext,
  memberId: string,
  role: 'admin' | 'waiter',
  supabaseClient = supabase
): Promise<OperationalValidationResult> {
  if (!context.restaurantId || !context.tableVisitId) {
    return { status: 'invalid', reason: 'missing_ids' };
  }

  try {
    const { data: visit, error: visitErr } = await supabaseClient
      .from('table_visits')
      .select('id, status, restaurant_id, restaurant_table_id, assigned_member_id')
      .eq('id', context.tableVisitId)
      .eq('restaurant_id', context.restaurantId)
      .maybeSingle();

    if (visitErr || !visit) {
      return { status: 'invalid', reason: 'visit_not_found' };
    }

    if (visit.status !== 'open') {
      return {
        status: 'visit_closed',
        tableNumber: context.tableNumber,
        tableVisitId: context.tableVisitId,
      };
    }

    const isAssigned = !visit.assigned_member_id || visit.assigned_member_id === memberId;
    if (role !== 'admin' && !isAssigned) {
      const locallyAuth = isTableLocallyAuthorized(context.restaurantId, context.tableNumber, visit.id);
      if (!locallyAuth) {
        return { status: 'unauthorized', tableNumber: context.tableNumber };
      }
    }

    let validTabId: string | null = null;
    if (context.tableTabId) {
      const { data: tab } = await supabaseClient
        .from('table_tabs')
        .select('id, status')
        .eq('id', context.tableTabId)
        .eq('table_visit_id', visit.id)
        .maybeSingle();

      if (tab && tab.status === 'open') {
        validTabId = tab.id;
      }
    }

    return {
      status: 'valid',
      tableVisitId: visit.id,
      tableTabId: validTabId,
      tableNumber: context.tableNumber,
      tableId: (visit as { restaurant_table_id?: string }).restaurant_table_id || context.tableId,
    };
  } catch (err) {
    return { status: 'invalid', reason: err instanceof Error ? err.message : 'unknown' };
  }
}

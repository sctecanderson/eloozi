import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from 'react';
import { useParams, useSearchParams } from 'react-router';
import { supabase } from '../../lib/supabase';
import { useRestaurant } from '../restaurants/RestaurantProvider';
import {
  type TableContext,
  isValidUuid,
  getTableStorageKey,
  purgeStoredTable,
  getStoredTableCandidate,
  persistValidTable,
  getTableQueryString,
} from './tableContextCore';

export type { TableContext, StoredTableData } from './tableContextCore';
export {
  isValidUuid,
  getTableStorageKey,
  purgeStoredTable,
  getStoredTableCandidate,
  persistValidTable,
  getTableQueryString,
};

const TableReactContext = createContext<TableContext | null>(null);

export function TableProvider({ children }: { children: ReactNode }) {
  const { restaurantSlug = '' } = useParams();
  const [searchParams] = useSearchParams();
  const { restaurant } = useRestaurant();

  const [retryVersion, setRetryVersion] = useState(0);
  const retry = useCallback(() => setRetryVersion((v) => v + 1), []);

  const tParam = searchParams.get('t');
  const legacyMesaParam = searchParams.get('mesa') || searchParams.get('table');

  const [tableState, setTableState] = useState<TableContext>(() => {
    if (tParam || legacyMesaParam) {
      return { status: 'loading', restaurantSlug, retry };
    }
    const candidate = getStoredTableCandidate(restaurantSlug);
    if (candidate) {
      return { status: 'loading', restaurantSlug, retry };
    }
    return { status: 'absent', restaurantSlug, retry };
  });

  useEffect(() => {
    let cancelled = false;

    async function resolveTable() {
      // 1. Sem parâmetros na URL
      if (!tParam && !legacyMesaParam) {
        const stored = getStoredTableCandidate(restaurantSlug);
        if (!stored) {
          if (!cancelled) setTableState({ status: 'absent', restaurantSlug, retry });
          return;
        }

        if (!restaurant) {
          if (!cancelled) setTableState({ status: 'loading', restaurantSlug, retry });
          return;
        }

        if (stored.restaurantId && stored.restaurantId !== restaurant.id) {
          purgeStoredTable(restaurantSlug);
          if (!cancelled) setTableState({ status: 'absent', restaurantSlug, retry });
          return;
        }

        try {
          const { data, error } = await supabase
            .from('restaurant_tables')
            .select('id, restaurant_id, table_number, label, active, is_active, deleted_at')
            .eq('id', stored.tableId)
            .eq('restaurant_id', restaurant.id)
            .is('deleted_at', null)
            .maybeSingle();

          if (cancelled) return;

          if (error || !data) {
            purgeStoredTable(restaurantSlug);
            setTableState({
              status: 'invalid',
              restaurantSlug,
              reason: 'Mesa anteriormente vinculada não foi encontrada ou foi desativada.',
              retry,
            });
            return;
          }

          const isActive =
            data.is_active !== false && data.active !== false && !data.deleted_at;

          if (!isActive) {
            purgeStoredTable(restaurantSlug);
            setTableState({
              status: 'invalid',
              restaurantSlug,
              reason: 'Mesa desativada para atendimento.',
              retry,
            });
            return;
          }

          const tNum = String(data.table_number).padStart(2, '0');
          const tId = data.id;
          const tName = data.label || `Mesa ${tNum}`;
          persistValidTable(restaurantSlug, restaurant.id, tNum, tId, tName);

          setTableState({
            status: 'unverified',
            restaurantSlug,
            tableNumber: tNum,
            tableId: tId,
            tableName: tName,
            retry,
          });
          return;
        } catch {
          if (!cancelled) {
            setTableState({
              status: 'invalid',
              restaurantSlug,
              reason: 'Não foi possível validar a mesa salva no servidor. Verifique a conexão e tente novamente.',
              retry,
            });
          }
          return;
        }
      }

      if (!restaurant) {
        if (!cancelled) setTableState({ status: 'loading', restaurantSlug, retry });
        return;
      }

      // 2. Trava de inadimplência SaaS
      if (restaurant.billingStatus === 'expired') {
        if (!cancelled) {
          purgeStoredTable(restaurantSlug);
          setTableState({
            status: 'expired',
            restaurantSlug,
            reason: 'Atendimento temporariamente indisponível.',
            retry,
          });
        }
        return;
      }

      // 3. Foco primário: Parâmetro 't' (UUID seguro da mesa)
      if (tParam) {
        const trimmedT = tParam.trim();

        if (!isValidUuid(trimmedT)) {
          purgeStoredTable(restaurantSlug);
          if (!cancelled) {
            setTableState({
              status: 'invalid',
              restaurantSlug,
              reason: 'Identificador de mesa no QR Code é inválido.',
              retry,
            });
          }
          return;
        }

        try {
          const { data, error } = await supabase
            .from('restaurant_tables')
            .select('id, restaurant_id, table_number, label, active, is_active, deleted_at')
            .eq('id', trimmedT)
            .eq('restaurant_id', restaurant.id)
            .is('deleted_at', null)
            .maybeSingle();

          if (cancelled) return;

          if (error || !data) {
            purgeStoredTable(restaurantSlug);
            setTableState({
              status: 'invalid',
              restaurantSlug,
              reason: 'Mesa não encontrada ou inativa neste restaurante.',
              retry,
            });
            return;
          }

          const isActive =
            data.is_active !== false && data.active !== false && !data.deleted_at;

          if (!isActive) {
            purgeStoredTable(restaurantSlug);
            setTableState({
              status: 'invalid',
              restaurantSlug,
              reason: 'Mesa desativada para atendimento.',
              retry,
            });
            return;
          }

          const tNum = String(data.table_number).padStart(2, '0');
          const tId = data.id;
          const tName = data.label || `Mesa ${tNum}`;
          persistValidTable(restaurantSlug, restaurant.id, tNum, tId, tName);

          setTableState({
            status: 'unverified',
            restaurantSlug,
            tableNumber: tNum,
            tableId: tId,
            tableName: tName,
            retry,
          });
          return;
        } catch {
          if (!cancelled) {
            setTableState({
              status: 'invalid',
              restaurantSlug,
              reason: 'Não foi possível validar a mesa no servidor. Verifique a conexão e tente novamente.',
              retry,
            });
          }
          return;
        }
      }

      // 4. Fallback legado: Parâmetro 'mesa' / 'table' (número)
      if (legacyMesaParam) {
        const trimmedMesa = legacyMesaParam.trim();
        if (!/^\d{1,3}$/.test(trimmedMesa)) {
          purgeStoredTable(restaurantSlug);
          if (!cancelled) {
            setTableState({
              status: 'invalid',
              restaurantSlug,
              reason: 'Número de mesa malformatado.',
              retry,
            });
          }
          return;
        }

        const num = Number(trimmedMesa);
        if (num < 1 || num > 999) {
          purgeStoredTable(restaurantSlug);
          if (!cancelled) {
            setTableState({
              status: 'invalid',
              restaurantSlug,
              reason: 'Número de mesa fora do intervalo permitido.',
              retry,
            });
          }
          return;
        }

        try {
          const { data, error } = await supabase
            .from('restaurant_tables')
            .select('id, restaurant_id, table_number, label, active, is_active, deleted_at')
            .eq('table_number', num)
            .eq('restaurant_id', restaurant.id)
            .is('deleted_at', null)
            .maybeSingle();

          if (cancelled) return;

          if (error || !data) {
            purgeStoredTable(restaurantSlug);
            setTableState({
              status: 'invalid',
              restaurantSlug,
              reason: `Mesa ${String(num).padStart(2, '0')} não encontrada no sistema.`,
              retry,
            });
            return;
          }

          const isActive =
            data.is_active !== false && data.active !== false && !data.deleted_at;

          if (!isActive) {
            purgeStoredTable(restaurantSlug);
            setTableState({
              status: 'invalid',
              restaurantSlug,
              reason: `Mesa ${String(num).padStart(2, '0')} desativada para atendimento.`,
              retry,
            });
            return;
          }

          const tNum = String(data.table_number).padStart(2, '0');
          const tId = data.id;
          const tName = data.label || `Mesa ${tNum}`;
          persistValidTable(restaurantSlug, restaurant.id, tNum, tId, tName);

          setTableState({
            status: 'unverified',
            restaurantSlug,
            tableNumber: tNum,
            tableId: tId,
            tableName: tName,
            retry,
          });
        } catch {
          if (!cancelled) {
            setTableState({
              status: 'invalid',
              restaurantSlug,
              reason: 'Não foi possível validar a mesa no servidor. Tente novamente.',
              retry,
            });
          }
        }
      }
    }

    void resolveTable();

    return () => {
      cancelled = true;
    };
  }, [
    tParam,
    legacyMesaParam,
    restaurant?.id,
    restaurant?.billingStatus,
    restaurantSlug,
    retryVersion,
    retry,
  ]);

  return (
    <TableReactContext.Provider value={tableState}>
      {children}
    </TableReactContext.Provider>
  );
}

/**
 * Hook para acessar os dados da mesa sincronizada com o QR Code.
 */
export function useTableContext(): TableContext {
  const context = useContext(TableReactContext);
  if (context) return context;

  // Fallback síncrono para componentes usados fora do TableProvider
  const { restaurantSlug = '' } = useParams();
  const [searchParams] = useSearchParams();

  const t = searchParams.get('t');
  const mesa = searchParams.get('mesa') || searchParams.get('table');

  if (t && isValidUuid(t) && t !== 'mesa-01') {
    return {
      status: 'unverified',
      restaurantSlug,
      tableNumber: '??',
      tableId: t,
      tableName: 'Mesa',
    };
  }

  if (mesa && /^\d{1,3}$/.test(mesa)) {
    return {
      status: 'unverified',
      restaurantSlug,
      tableNumber: String(Number(mesa)).padStart(2, '0'),
      tableId: '',
      tableName: `Mesa ${String(Number(mesa)).padStart(2, '0')}`,
    };
  }

  return {
    status: 'absent',
    restaurantSlug,
  };
}

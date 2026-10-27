import { supabase } from '../../lib/supabase';
import { getTimezoneUtcRange, toTimezoneDateString } from './staffDateUtils';

export interface StaffDailyMetrics {
  tablesAttended: number | null;
  callsResolved: number | null;
  tabsClosed: number | null;
  salesInCents: number | null;
}

/**
 * Busca os indicadores do dia do membro logado da equipe.
 * Quando um indicador não possuir rastreamento confiável ou sofrer erro na consulta,
 * retorna null para exibição clara de "Indisponível" (sem inventar zero ou turnos fictícios).
 */
export async function fetchStaffDailyMetrics(
  restaurantId: string,
  memberId: string,
  role: 'admin' | 'waiter',
  timezone = 'America/Sao_Paulo'
): Promise<StaffDailyMetrics> {
  if (!restaurantId || !memberId) {
    return {
      tablesAttended: null,
      callsResolved: null,
      tabsClosed: null,
      salesInCents: null,
    };
  }

  const todayStr = toTimezoneDateString(new Date(), timezone);
  const { startUtc, nextDayStartUtc } = getTimezoneUtcRange(todayStr, timezone);

  // 1. Chamados resolvidos pelo membro hoje
  let callsResolved: number | null = null;
  try {
    const { count, error } = await supabase
      .from('service_requests')
      .select('id', { count: 'exact', head: true })
      .eq('restaurant_id', restaurantId)
      .eq('status', 'attended')
      .eq('resolved_by_member_id', memberId)
      .gte('resolved_at', startUtc)
      .lt('resolved_at', nextDayStartUtc);

    if (!error && count !== null && count !== undefined) {
      callsResolved = count;
    }
  } catch {
    callsResolved = null;
  }

  // 2. Contas fechadas pelo membro hoje
  let tabsClosed: number | null = null;
  try {
    const { count, error } = await supabase
      .from('table_tabs')
      .select('id', { count: 'exact', head: true })
      .eq('restaurant_id', restaurantId)
      .eq('status', 'closed')
      .eq('closed_by_member_id', memberId)
      .gte('closed_at', startUtc)
      .lt('closed_at', nextDayStartUtc);

    if (!error && count !== null && count !== undefined) {
      tabsClosed = count;
    }
  } catch {
    tabsClosed = null;
  }

  // 3. Mesas atendidas pelo membro hoje (contagem de mesas distintas)
  let tablesAttended: number | null = null;
  try {
    let query = supabase
      .from('table_visits')
      .select('restaurant_table_id')
      .eq('restaurant_id', restaurantId);

    if (role === 'waiter') {
      query = query.eq('assigned_member_id', memberId);
    }

    query = query
      .gte('opened_at', startUtc)
      .lt('opened_at', nextDayStartUtc);

    const { data, error } = await query;
    if (!error && data) {
      const uniqueTables = new Set(data.map((row: { restaurant_table_id: string }) => row.restaurant_table_id));
      tablesAttended = uniqueTables.size;
    }
  } catch {
    tablesAttended = null;
  }

  // 4. Vendas do turno: sem suporte a controle formal de turno de garçom no banco
  // Retorna explicitamente null para exibição de "Indisponível" conforme a diretriz
  const salesInCents: number | null = null;

  return {
    tablesAttended,
    callsResolved,
    tabsClosed,
    salesInCents,
  };
}

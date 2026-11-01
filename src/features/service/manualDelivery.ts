import { supabase } from '../../lib/supabase';

export function canConfirmDelivery(plan: string | undefined, status: string): boolean {
  return status === 'ready' || (plan === 'basic' && ['pending', 'in_preparation', 'preparing'].includes(status));
}

interface DeliveryContext {
  restaurantSlug: string;
  restaurantId: string;
  visitId: string;
  tabId: string;
  itemIds: string[];
}

// A group may partially persist. No local optimistic success and no table UPDATE fallback.
export async function confirmDelivery(
  context: DeliveryContext,
  client: Pick<typeof supabase, 'rpc'> = supabase,
): Promise<void> {
  if (context.itemIds.length === 0) throw new Error('Nenhum item selecionado para entrega.');
  for (const id of [...new Set(context.itemIds)]) {
    const { data, error } = await client.rpc('update_tab_item_production_status', {
      p_restaurant_slug: context.restaurantSlug, p_item_id: id, p_target_status: 'delivered',
    });
    if (error) throw new Error(error.message || 'Não foi possível confirmar a entrega.');
    const confirmed = Array.isArray(data) && data.length === 1 ? data[0] : data;
    if (!confirmed || confirmed.id !== id || confirmed.restaurant_id !== context.restaurantId
      || confirmed.table_visit_id !== context.visitId || confirmed.table_tab_id !== context.tabId
      || confirmed.status !== 'active' || confirmed.production_status !== 'delivered'
      || typeof confirmed.prep_delivered_at !== 'string' || !Number.isFinite(Date.parse(confirmed.prep_delivered_at))) {
      throw new Error('O servidor não confirmou a entrega deste item. Atualize o consumo antes de tentar novamente.');
    }
  }
}

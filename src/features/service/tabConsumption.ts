import { supabase } from '../../lib/supabase';

export interface ConsumptionProduct {
  id: string;
  name: string;
  price_in_cents: number;
  preparation_station?: 'kitchen' | 'bar' | 'none';
}

export interface TabConsumptionItem {
  id: string;
  restaurant_id: string;
  restaurant_table_id: string;
  table_visit_id: string;
  table_tab_id: string;
  product_id: string;
  product_name: string;
  unit_price_in_cents: number;
  quantity: number;
  line_total_in_cents: number;
  status: 'active' | 'cancelled';
  added_by_member_id: string;
  created_at: string;
  cancelled_by_member_id: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  already_cancelled?: boolean;
  production_status?: 'pending' | 'preparing' | 'ready' | 'delivered';
  preparation_station?: 'kitchen' | 'bar' | 'none';
  prep_started_at?: string | null;
  prep_ready_at?: string | null;
  prep_delivered_at?: string | null;
}

function operationError(error: { code?: string; message: string }, fallback: string) {
  return new Error(
    error.code === '42501' || error.code === '22023' ? error.message : fallback,
  );
}

interface TabConsumptionState {
  products: ConsumptionProduct[];
  items: TabConsumptionItem[];
  totalInCents: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMoney(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isConsumptionProduct(value: unknown): value is ConsumptionProduct {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && isMoney(value.price_in_cents);
}

function isConsumptionItem(value: unknown): value is TabConsumptionItem {
  if (!isRecord(value)) return false;

  return typeof value.id === 'string'
    && typeof value.restaurant_id === 'string'
    && typeof value.restaurant_table_id === 'string'
    && typeof value.table_visit_id === 'string'
    && typeof value.table_tab_id === 'string'
    && typeof value.product_id === 'string'
    && typeof value.product_name === 'string'
    && isMoney(value.unit_price_in_cents)
    && typeof value.quantity === 'number'
    && Number.isInteger(value.quantity)
    && value.quantity >= 1 && value.quantity <= 99
    && isMoney(value.line_total_in_cents)
    && value.line_total_in_cents === value.unit_price_in_cents * value.quantity
    && (value.status === 'active' || value.status === 'cancelled')
    && typeof value.added_by_member_id === 'string'
    && typeof value.created_at === 'string'
    && isNullableString(value.cancelled_by_member_id)
    && isNullableString(value.cancelled_at)
    && isNullableString(value.cancellation_reason)
    && (value.already_cancelled === undefined || typeof value.already_cancelled === 'boolean')
    && (value.production_status === undefined || typeof value.production_status === 'string')
    && (value.preparation_station === undefined || typeof value.preparation_station === 'string')
    && (value.prep_started_at === undefined || isNullableString(value.prep_started_at))
    && (value.prep_ready_at === undefined || isNullableString(value.prep_ready_at))
    && (value.prep_delivered_at === undefined || isNullableString(value.prep_delivered_at));
}

function parseTabConsumption(
  value: unknown,
  restaurantId: string,
  tableTabId: string,
): TabConsumptionState {
  if (!isRecord(value)) {
    throw new Error('O consumo não foi retornado corretamente ou não está acessível.');
  }

  const { products, items, totalInCents } = value;

  if (!Array.isArray(products) || !products.every(isConsumptionProduct)
    || !Array.isArray(items) || !items.every(isConsumptionItem)
    || !isMoney(totalInCents)) {
    throw new Error('O servidor retornou dados de consumo em formato inválido.');
  }

  let checkedTotal = 0;
  for (const item of items) {
    if (item.restaurant_id !== restaurantId || item.table_tab_id !== tableTabId) {
      throw new Error('O consumo recebido não corresponde à comanda selecionada.');
    }
    if (item.status !== 'active') continue;
    checkedTotal += item.line_total_in_cents;
    if (!Number.isSafeInteger(checkedTotal)) {
      throw new Error('O total ultrapassou o limite de cálculo desta interface.');
    }
  }

  if (checkedTotal !== totalInCents) {
    throw new Error('A lista de consumo não corresponde ao total informado pelo servidor.');
  }

  return { products, items, totalInCents };
}

export async function getTabConsumption(
  restaurantId: string,
  tableTabId: string,
): Promise<TabConsumptionState> {
  const { data, error } = await supabase.rpc('get_table_tab_consumption', {
    p_restaurant_id: restaurantId,
    p_table_tab_id: tableTabId,
  });

  if (error) {
    throw new Error('Não foi possível carregar o consumo. Tente novamente.');
  }

  // A RPC retorna JSON. Validamos o conteúdo antes de atribuir o tipo.
  return parseTabConsumption(data, restaurantId, tableTabId);
}

export async function addTabConsumption(
  restaurantSlug: string, tableTabId: string, productId: string,
  quantity: number, itemId: string,
) {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
    throw new Error('Informe uma quantidade entre 1 e 99.');
  }
  const { data, error } = await supabase
    .rpc('add_table_tab_item', {
      p_restaurant_slug: restaurantSlug,
      p_table_tab_id: tableTabId,
      p_product_id: productId,
      p_quantity: quantity,
      p_item_id: itemId,
    })
    .single()
    .overrideTypes<TabConsumptionItem, { merge: false }>();

  if (error) throw operationError(error, 'Não foi possível registrar o consumo.');
  if (!data || data.id !== itemId || data.table_tab_id !== tableTabId ||
      data.product_id !== productId || data.quantity !== quantity) {
    throw new Error('O lançamento não foi confirmado. Atualize a comanda antes de tentar novamente.');
  }
  if (data.status === 'cancelled') {
    throw new Error('Este lançamento já foi cancelado. Atualize a comanda.');
  }
  return data;
}

export async function cancelTabConsumption(
  restaurantSlug: string,
  itemId: string,
  reason: string = 'Cancelado pelo garçom',
) {
  const normalizedReason = reason.trim() || 'Cancelado pelo garçom';
  if (normalizedReason.length < 3 || normalizedReason.length > 300) {
    throw new Error('Informe um motivo entre 3 e 300 caracteres.');
  }

  const { data, error } = await supabase
    .rpc('cancel_table_tab_item', {
      p_restaurant_slug: restaurantSlug,
      p_item_id: itemId,
      p_reason: normalizedReason,
    })
    .single()
    .overrideTypes<TabConsumptionItem, { merge: false }>();

  if (error) {
    throw operationError(error, 'Não foi possível cancelar o item.');
  }
  return data;
}

export interface BatchCancellationResult {
  success: boolean;
  cancelledIds: string[];
  failed: Array<{ id: string; error: string; code?: string }>;
  transactional: boolean;
}

export interface ValidatedBatchResponse {
  valid: boolean;
  error?: string;
  code?: string;
  cancelledIds: string[];
}

/**
 * Valida a resposta da RPC de cancelamento em lote:
 * - Formato de array obrigatório;
 * - IDs retornados precisam corresponder estritamente a todos os IDs solicitados;
 * - Sem duplicatas na resposta do servidor;
 * - Todos os itens devem possuir status 'cancelled';
 * - Itens recém-cancelados (already_cancelled !== true) devem conter o motivo esperado informado;
 * - Itens que já estavam cancelados (already_cancelled === true) preservam seus motivos originais
 *   (devem possuir motivo preexistente válido, sem sobrescrita);
 * - Resposta vazia ou divergente é terminantemente rejeitada.
 */
export function validateBatchCancellationResponse(
  requestedIds: string[],
  data: unknown,
  expectedReason: string,
): ValidatedBatchResponse {
  if (!Array.isArray(data)) {
    return {
      valid: false,
      error: 'Resposta inválida do servidor: formato não reconhecido.',
      code: 'INVALID_RPC_RESPONSE',
      cancelledIds: [],
    };
  }

  const requestedSet = new Set(requestedIds);
  if (requestedSet.size === 0) {
    return { valid: true, cancelledIds: [] };
  }

  if (data.length === 0) {
    return {
      valid: false,
      error: 'Resposta vazia do servidor ao cancelar itens.',
      code: 'EMPTY_RPC_RESPONSE',
      cancelledIds: [],
    };
  }

  const returnedIds = new Set<string>();
  const duplicates = new Set<string>();

  for (const item of data) {
    if (!item || typeof item !== 'object') {
      return {
        valid: false,
        error: 'Item retornado em formato inválido.',
        code: 'INVALID_ITEM_FORMAT',
        cancelledIds: [],
      };
    }

    const { id, status, cancellation_reason, already_cancelled } = item as Record<string, unknown>;
    if (typeof id !== 'string') {
      return {
        valid: false,
        error: 'Item retornado sem identificador válido.',
        code: 'MISSING_ITEM_ID',
        cancelledIds: [],
      };
    }

    if (returnedIds.has(id)) {
      duplicates.add(id);
    }
    returnedIds.add(id);

    if (status !== 'cancelled') {
      return {
        valid: false,
        error: `Item ${id} retornou com status inconsistente: ${status}.`,
        code: 'STATUS_NOT_CANCELLED',
        cancelledIds: Array.from(returnedIds),
      };
    }

    // Se o item já estava previamente cancelado (idempotência):
    // Preserva o motivo original sem sobrescrita, exigindo que possua motivo válido não-vazio.
    if (already_cancelled === true) {
      if (typeof cancellation_reason !== 'string' || cancellation_reason.trim().length === 0) {
        return {
          valid: false,
          error: `Item ${id} já cancelado não possui motivo válido persistido.`,
          code: 'INVALID_CANCELLATION_REASON',
          cancelledIds: Array.from(returnedIds),
        };
      }
    } else {
      // Item recém-cancelado por esta requisição: deve conter exatamente o motivo solicitado.
      if (cancellation_reason !== expectedReason) {
        return {
          valid: false,
          error: `Item ${id} não possui o motivo esperado de cancelamento.`,
          code: 'REASON_MISMATCH',
          cancelledIds: Array.from(returnedIds),
        };
      }
    }
  }

  if (duplicates.size > 0) {
    return {
      valid: false,
      error: 'A resposta do servidor contém itens duplicados.',
      code: 'DUPLICATE_ITEMS_IN_RESPONSE',
      cancelledIds: Array.from(returnedIds),
    };
  }

  const missingIds = requestedIds.filter((id) => !returnedIds.has(id));
  const unexpectedIds = Array.from(returnedIds).filter((id) => !requestedSet.has(id));

  if (missingIds.length > 0 || unexpectedIds.length > 0) {
    return {
      valid: false,
      error: `Divergência nos itens cancelados (ausentes: ${missingIds.length}, inesperados: ${unexpectedIds.length}).`,
      code: 'RPC_RESPONSE_MISMATCH',
      cancelledIds: Array.from(returnedIds),
    };
  }

  return {
    valid: true,
    cancelledIds: Array.from(returnedIds),
  };
}

/**
 * Cancela múltiplos itens de consumo.
 * 1. Tenta a operação transacional em lote via RPC 'cancel_table_tab_items_batch'.
 * 2. Faz fallback para cancelamento item a item SOMENTE quando houver confirmação inequívoca
 *    de que a RPC em lote não existe (PGRST202).
 * 3. Preserva códigos SQLSTATE: erros de autorização (42501), validação (22023), rede ou execução
 *    são propagados imediatamente, sem cair silenciosamente no fallback.
 * 4. Valida rigorosamente a resposta da RPC: IDs correspondentes, sem duplicatas, status cancelled
 *    e motivo esperado. Resposta vazia ou divergente dispara erro com indicação de sincronização.
 */
export async function cancelTabConsumptionBatch(
  restaurantSlug: string,
  itemIds: string[],
  reason: string = 'Cancelado pelo garçom',
): Promise<BatchCancellationResult> {
  const normalizedReason = reason.trim() || 'Cancelado pelo garçom';
  if (normalizedReason.length < 3 || normalizedReason.length > 300) {
    const err = new Error('Informe um motivo entre 3 e 300 caracteres.');
    (err as any).code = '22023';
    throw err;
  }

  const distinctItemIds = Array.from(new Set(itemIds)).filter(Boolean);
  if (distinctItemIds.length === 0) {
    return { success: true, cancelledIds: [], failed: [], transactional: true };
  }

  // 1. Tenta a RPC em lote transacional
  const { data, error } = await supabase.rpc('cancel_table_tab_items_batch', {
    p_restaurant_slug: restaurantSlug,
    p_item_ids: distinctItemIds,
    p_reason: normalizedReason,
  });

  if (error) {
    // Confirmação inequívoca de que a RPC em lote não existe: código PGRST202 (not in schema cache)
    const isMissingRpc = error.code === 'PGRST202';

    if (!isMissingRpc) {
      // Erros de autorização (42501), validação (22023), restrições ou falha de execução
      // são propagados diretamente preservando a mensagem e o SQLSTATE. NÃO caem em fallback!
      const err = new Error(
        error.code === '42501' || error.code === '22023'
          ? error.message
          : (error.message || 'Não foi possível cancelar os itens selecionados.'),
      );
      (err as any).code = error.code;
      throw err;
    }

    // 2. Fallback item a item estrito e rastreado (acionado exclusivamente em PGRST202)
    const cancelledIds: string[] = [];
    const failed: Array<{ id: string; error: string; code?: string }> = [];

    for (const id of distinctItemIds) {
      try {
        await cancelTabConsumption(restaurantSlug, id, normalizedReason);
        cancelledIds.push(id);
      } catch (cause: any) {
        failed.push({
          id,
          error: cause instanceof Error ? cause.message : 'Falha ao cancelar item.',
          code: cause?.code,
        });
      }
    }

    return {
      success: failed.length === 0,
      cancelledIds,
      failed,
      transactional: false,
    };
  }

  // 3. Validação rigorosa da resposta da RPC em lote
  const validation = validateBatchCancellationResponse(
    distinctItemIds,
    data,
    normalizedReason,
  );

  if (!validation.valid) {
    const err = new Error(
      `${validation.error} Atualize a comanda para sincronizar o consumo com o servidor.`,
    );
    (err as any).code = validation.code || 'UNCERTAIN_RESULT';
    throw err;
  }

  return {
    success: true,
    cancelledIds: validation.cancelledIds,
    failed: [],
    transactional: true,
  };
}

export interface TransferTabConsumptionParams {
  restaurantSlug: string;
  sourceTabId: string;
  targetTabId: string;
  itemIds: string[];
  reason: string;
}

export interface TransferTabConsumptionResult {
  success: boolean;
  transferredIds: string[];
  items: TabConsumptionItem[];
}

export function validateTransferItemsResponse(
  requestedIds: string[],
  targetTabId: string,
  data: unknown,
): { valid: boolean; transferredIds: string[]; items: TabConsumptionItem[]; error?: string; code?: string } {
  if (!Array.isArray(data)) {
    return {
      valid: false,
      transferredIds: [],
      items: [],
      error: 'A resposta da transferência não é uma lista de itens.',
      code: 'INVALID_PAYLOAD',
    };
  }

  const requestedSet = new Set(requestedIds);
  const returnedIds = new Set<string>();
  const items: TabConsumptionItem[] = [];

  for (const raw of data) {
    if (!isConsumptionItem(raw)) {
      return {
        valid: false,
        transferredIds: [],
        items: [],
        error: 'Item retornado pela transferência possui estrutura inválida.',
        code: 'INVALID_PAYLOAD',
      };
    }

    if (raw.table_tab_id !== targetTabId) {
      return {
        valid: false,
        transferredIds: [],
        items: [],
        error: `Item "${raw.product_name}" não foi vinculado à comanda de destino.`,
        code: 'RESPONSE_PARAM_MISMATCH',
      };
    }

    if (raw.status !== 'active') {
      return {
        valid: false,
        transferredIds: [],
        items: [],
        error: `Item "${raw.product_name}" retornado com status diferente de ativo.`,
        code: 'RESPONSE_PARAM_MISMATCH',
      };
    }

    if (returnedIds.has(raw.id)) {
      return {
        valid: false,
        transferredIds: [],
        items: [],
        error: `Item "${raw.product_name}" retornado em duplicidade.`,
        code: 'DUPLICATE_ITEM_ID',
      };
    }

    if (!requestedSet.has(raw.id)) {
      return {
        valid: false,
        transferredIds: [],
        items: [],
        error: `Item "${raw.product_name}" retornado não estava na lista solicitada.`,
        code: 'UNEXPECTED_ITEM_RETURNED',
      };
    }

    returnedIds.add(raw.id);
    items.push(raw);
  }

  if (returnedIds.size !== requestedSet.size) {
    return {
      valid: false,
      transferredIds: Array.from(returnedIds),
      items,
      error: `Quantidade de itens transferidos (${returnedIds.size}) diverge do total solicitado (${requestedSet.size}).`,
      code: 'COUNT_MISMATCH',
    };
  }

  return {
    valid: true,
    transferredIds: Array.from(returnedIds),
    items,
  };
}

/**
 * Executa a transferência transacional e atômica de itens entre comandas (mesma mesa ou entre mesas)
 * utilizando a RPC public.transfer_table_tab_items.
 * Preserva o ID do item, preços históricos, timestamps e status de produção (KDS).
 */
export async function transferTabConsumptionItems(
  params: TransferTabConsumptionParams,
): Promise<TransferTabConsumptionResult> {
  const { restaurantSlug, sourceTabId, targetTabId, itemIds, reason } = params;

  if (!restaurantSlug?.trim()) {
    const err = new Error('Informe o identificador do restaurante.');
    (err as any).code = '22023';
    throw err;
  }

  const cleanSourceTabId = sourceTabId?.trim();
  const cleanTargetTabId = targetTabId?.trim();

  if (!cleanSourceTabId || !cleanTargetTabId) {
    const err = new Error('Informe a comanda de origem e de destino.');
    (err as any).code = '22023';
    throw err;
  }

  if (cleanSourceTabId === cleanTargetTabId) {
    const err = new Error('A comanda de origem e de destino não podem ser iguais.');
    (err as any).code = '22023';
    throw err;
  }

  const distinctItemIds = Array.from(new Set(itemIds || [])).filter(Boolean);
  if (distinctItemIds.length === 0) {
    const err = new Error('Nenhum item informado para transferência.');
    (err as any).code = '22023';
    throw err;
  }

  const normalizedReason = reason?.trim();
  if (!normalizedReason || normalizedReason.length < 3 || normalizedReason.length > 300) {
    const err = new Error('Informe um motivo entre 3 e 300 caracteres.');
    (err as any).code = '22023';
    throw err;
  }

  const { data, error } = await supabase.rpc('transfer_table_tab_items', {
    p_restaurant_slug: restaurantSlug.trim(),
    p_source_tab_id: cleanSourceTabId,
    p_target_tab_id: cleanTargetTabId,
    p_item_ids: distinctItemIds,
    p_reason: normalizedReason,
  });

  if (error) {
    const err = new Error(
      error.code === '42501' || error.code === '22023'
        ? error.message
        : (error.message || 'Não foi possível transferir os itens da comanda.'),
    );
    (err as any).code = error.code;
    throw err;
  }

  const validation = validateTransferItemsResponse(distinctItemIds, cleanTargetTabId, data);
  if (!validation.valid) {
    const err = new Error(
      `${validation.error} Atualize a página para sincronizar o consumo com o servidor.`,
    );
    (err as any).code = validation.code || 'UNCERTAIN_RESULT';
    throw err;
  }

  return {
    success: true,
    transferredIds: validation.transferredIds,
    items: validation.items,
  };
}

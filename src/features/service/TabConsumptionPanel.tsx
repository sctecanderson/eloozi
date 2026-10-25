import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { TableTab } from './tableTabs';
import { addTabConsumption, cancelTabConsumption, getTabConsumption } from './tabConsumption';
import type { ConsumptionProduct, TabConsumptionItem } from './tabConsumption';
import { advanceKdsItemStatus } from '../kds/kdsService';
import { groupTabConsumptionItems } from './tabGrouping';
import { useRestaurant } from '../restaurants/RestaurantProvider';
import { printTableBillThermal, ThermalPrinterIcon } from '../../components/ThermalReceiptPrint';

interface Props {
  restaurantSlug: string;
  restaurantId: string;
  tab: TableTab;
  tableNumber?: number | string;
}

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const timeFormat = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });

export function TabConsumptionPanel(props: Props) {
  return <ConsumptionContent key={`${props.restaurantId}:${props.tab.id}`} {...props} />;
}

function ConsumptionContent({ restaurantSlug, restaurantId, tab, tableNumber }: Props) {
  const submitting = useRef(false);
  const pendingItemId = useRef<string | null>(null);
  const mounted = useRef(false);
  const initialLoaded = useRef(false);
  const [products, setProducts] = useState<ConsumptionProduct[]>([]);
  const [items, setItems] = useState<TabConsumptionItem[]>([]);
  const [total, setTotal] = useState(0);
  const [productId, setProductId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [expandedBatches, setExpandedBatches] = useState<Record<string, boolean>>({});
  const { restaurant } = useRestaurant();
  const [splitCount, setSplitCount] = useState<number>(1);
  const [includeServiceFee, setIncludeServiceFee] = useState<boolean>(true);

  function toggleExpandBatch(key: string) {
    setExpandedBatches((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  useEffect(() => {
    mounted.current = true;

  const feePercent = restaurant?.serviceFeePercent ?? 10;
  const feeInCents = includeServiceFee && feePercent > 0 ? Math.round((total * feePercent) / 100) : 0;
  const grandTotalInCents = total + feeInCents;
  const splitValueInCents = Math.round(grandTotalInCents / splitCount);

  function handlePrintReceipt() {
    const activeItems = items.filter((it) => it.status === 'active');
    printTableBillThermal({
      restaurantName: restaurant?.name || 'Restaurante',
      tableNumber: tableNumber ?? 'Balcão',
      tabLabel: tab.label,
      items: activeItems.map((it) => ({
        name: it.product_name,
        quantity: it.quantity,
        unitPriceInCents: it.unit_price_in_cents,
        totalInCents: it.line_total_in_cents,
      })),
      subtotalInCents: total,
      serviceFeePercent: feePercent,
      serviceFeeInCents: feeInCents,
      totalInCents: grandTotalInCents,
      splitCount: splitCount,
      splitValueInCents: splitValueInCents,
      paperWidth: '80mm',
    });
  }

  return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let disposed = false;
    async function load() {
      if (!initialLoaded.current) {
        setLoading(true);
      }
      setLoadError('');
      try {
        const result = await getTabConsumption(restaurantId, tab.id);
        if (!disposed) {
          setProducts(result.products);
          setItems(result.items);
          setTotal(result.totalInCents);
          initialLoaded.current = true;
        }
      } catch (cause) {
        if (!disposed) setLoadError(cause instanceof Error ? cause.message : 'Não foi possível carregar o consumo.');
      } finally {
        if (!disposed) setLoading(false);
      }
    }
    void load();
    return () => { disposed = true; };
  }, [restaurantId, tab.id, tab.status, refresh]);

  const closed = tab.status === 'closed';
  const disabled = closed || busy || loading || !!loadError;

  async function perform(operation: () => Promise<unknown>, message: string, onSuccess: () => void) {
    if (submitting.current || disabled) return;
    submitting.current = true;
    setBusy(true);
    setActionError('');
    setNotice('');
    try {
      await operation();
      if (mounted.current) {
        onSuccess();
        setNotice(message);
        setRefresh((value) => value + 1);
      }
    } catch (cause) {
      if (mounted.current) setActionError(cause instanceof Error ? cause.message : 'Não foi possível concluir a operação.');
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function handleAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || disabled) return;
    const value = quantity.trim();
    if (!products.some((product) => product.id === productId) || !/^\d{1,2}$/.test(value) || Number(value) < 1) {
      setActionError('Selecione o produto e uma quantidade entre 1 e 99.');
      return;
    }
    const id = pendingItemId.current ?? crypto.randomUUID();
    pendingItemId.current = id;
    await perform(
      () => addTabConsumption(restaurantSlug, tab.id, productId, Number(value), id),
      'Consumo registrado.',
      () => { pendingItemId.current = null; setProductId(''); setQuantity('1'); },
    );
  }

  async function handleCancel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!cancellingId) return;
    await perform(
      () => cancelTabConsumption(restaurantSlug, cancellingId, reason),
      'Lançamento cancelado. O total foi atualizado.',
      () => { setCancellingId(null); setReason(''); },
    );
  }

  async function handleConfirmDeliveryItems(targetItems: TabConsumptionItem[]) {
    if (submitting.current || disabled || targetItems.length === 0) return;
    await perform(
      async () => {
        for (const item of targetItems) {
          const res = await advanceKdsItemStatus(restaurantSlug, item.id, 'delivered');
          if (!res.success) {
            throw new Error(res.error || 'Não foi possível confirmar a entrega de todos os itens.');
          }
        }
      },
      'Entrega na mesa confirmada.',
      () => {},
    );
  }

  const feePercent = restaurant?.serviceFeePercent ?? 10;
  const feeInCents = includeServiceFee && feePercent > 0 ? Math.round((total * feePercent) / 100) : 0;
  const grandTotalInCents = total + feeInCents;
  const splitValueInCents = Math.round(grandTotalInCents / splitCount);

  function handlePrintReceipt() {
    const activeItems = items.filter((it) => it.status === 'active');
    printTableBillThermal({
      restaurantName: restaurant?.name || 'Restaurante',
      tableNumber: tableNumber ?? 'Balcão',
      tabLabel: tab.label,
      items: activeItems.map((it) => ({
        name: it.product_name,
        quantity: it.quantity,
        unitPriceInCents: it.unit_price_in_cents,
        totalInCents: it.line_total_in_cents,
      })),
      subtotalInCents: total,
      serviceFeePercent: feePercent,
      serviceFeeInCents: feeInCents,
      totalInCents: grandTotalInCents,
      splitCount: splitCount,
      splitValueInCents: splitValueInCents,
      paperWidth: '80mm',
    });
  }

  return (
    <section aria-labelledby={`consumption-title-${tab.id}`} className="mt-3 border-t border-[#ebdccb] pt-3">
      <div className="staff-tab-consume-box">
        <div className="flex items-center justify-between mb-2">
          <h5 id={`consumption-title-${tab.id}`} className="staff-tab-consume-title m-0">Registrar Consumo</h5>
          <button
            type="button"
            disabled={busy || loading}
            onClick={() => setRefresh((value) => value + 1)}
            className="text-xs text-[var(--brand)] underline disabled:opacity-50"
          >
            Atualizar
          </button>
        </div>

        {!closed && (
          <form onSubmit={handleAdd} className="space-y-2">
            <select
              id={`consumption-product-${tab.id}`}
              required
              value={productId}
              onChange={(event) => { setProductId(event.target.value); pendingItemId.current = null; setNotice(''); }}
              className="staff-product-select"
            >
              <option value="">Selecione um prato ou bebida</option>
              {products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name} — {currency.format(product.price_in_cents / 100)}
                </option>
              ))}
            </select>

            <div className="staff-qty-action-row">
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <label
                  htmlFor={`consumption-quantity-${tab.id}`}
                  style={{ fontSize: '11px', color: '#8c7867', marginBottom: '2px', fontWeight: 600 }}
                >
                  Quantidade
                </label>
                <input
                  id={`consumption-quantity-${tab.id}`}
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]{1,2}"
                  required
                  maxLength={2}
                  value={quantity}
                  onChange={(event) => { setQuantity(event.target.value); pendingItemId.current = null; setNotice(''); }}
                  className="staff-qty-input"
                />
              </div>

              <button
                type="submit"
                disabled={products.length === 0 || busy}
                className="staff-primary-action-btn flex-1 self-end"
                style={{ height: '42px', minHeight: '42px' }}
              >
                {busy ? 'Registrando…' : 'Registrar consumo'}
              </button>
            </div>
          </form>
        )}
      </div>

      {actionError && <p role="alert" className="mt-2 text-xs text-red-700">{actionError}</p>}
      {notice && <p role="status" className="mt-2 text-xs text-green-800">{notice}</p>}

      {loading ? (
        <p role="status" className="mt-3 text-xs opacity-75">Carregando consumo…</p>
      ) : loadError ? (
        <p role="alert" className="mt-3 text-xs text-red-700">{loadError}</p>
      ) : (
        <>
          {items.length === 0 ? (
            <p className="mt-3 text-xs text-[#8c7867] italic">Nenhum consumo registrado.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {groupTabConsumptionItems(items).map((group) => {
                const isCancelled = group.isCancelled;
                const isExpanded = !!expandedBatches[group.key];
                const activeCancellingItem = group.originalItems.find((i) => i.id === cancellingId);

                return (
                  <li
                    key={group.key}
                    className={`rounded-xl border border-[#ded5c8] dark:border-white/10 p-2.5 text-xs transition-opacity ${
                      isCancelled ? 'opacity-60 bg-[#faf8f5] dark:bg-stone-900/60' : 'bg-white dark:bg-stone-800'
                    }`}
                  >
                    <div className="flex justify-between items-start">
                      <p
                        className={`font-semibold text-[13px] ${
                          isCancelled ? 'line-through text-gray-500 dark:text-stone-400' : 'text-[#2b1d17] dark:text-stone-100'
                        }`}
                      >
                        {group.quantity} × {group.productName}
                      </p>
                      <span
                        className={`${
                          isCancelled
                            ? 'line-through text-gray-400 font-normal'
                            : 'font-bold text-[var(--brand)]'
                        }`}
                      >
                        {currency.format(group.lineTotalInCents / 100)}
                      </span>
                    </div>
                    <p
                      className={`mt-0.5 text-xs ${
                        isCancelled ? 'line-through text-gray-400' : 'text-[#7a6655]'
                      }`}
                    >
                      {currency.format(group.unitPriceInCents / 100)} por unidade
                      {!isCancelled && group.originalItems.length > 1 && (
                        <span className="ml-2 font-normal text-stone-500">
                          ({group.originalItems.length} lançamentos somados)
                        </span>
                      )}
                    </p>
                    {!isCancelled && (
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <span className={`inline-block px-2 py-0.5 text-[11px] font-medium rounded border ${
                          group.preparationStation === 'bar'
                            ? 'bg-orange-50 text-orange-900 border-orange-200'
                            : group.preparationStation === 'none'
                              ? 'bg-stone-100 text-stone-700 border-stone-200'
                              : 'bg-blue-50 text-blue-900 border-blue-200'
                        }`}>
                          {group.preparationStation === 'bar'
                            ? 'Bar'
                            : group.preparationStation === 'none'
                              ? 'Sem preparo'
                              : 'Cozinha'}
                        </span>

                        <span className={`inline-block px-2 py-0.5 text-[11px] font-medium rounded-full border ${
                          group.productionStatus === 'pending'
                            ? 'bg-amber-50 text-amber-700 border border-amber-200/60'
                            : group.productionStatus === 'preparing'
                              ? 'bg-sky-50 text-sky-700 border border-sky-200/60'
                              : group.productionStatus === 'ready'
                                ? 'bg-emerald-50 text-emerald-700 border border-emerald-300 font-bold animate-pulse'
                                : 'bg-zinc-100 text-zinc-600 border border-zinc-200'
                        }`}>
                          {group.productionStatus === 'pending'
                            ? '● Aguardando início de preparo'
                            : group.productionStatus === 'preparing'
                              ? '● Em preparo na cozinha'
                              : group.productionStatus === 'ready'
                                ? '● Pronto para servir'
                                : '✓ Entregue'}
                        </span>

                        {!closed && group.productionStatus === 'ready' && (
                          <button
                            type="button"
                            disabled={disabled}
                            onClick={() => void handleConfirmDeliveryItems(group.originalItems)}
                            className="ml-auto inline-flex items-center gap-1 rounded-xl bg-emerald-600 hover:bg-emerald-700 px-2.5 py-1 text-[11px] font-bold text-white transition-colors disabled:opacity-50 shadow-xs cursor-pointer"
                          >
                            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg><span>Marcar como entregue</span>
                          </button>
                        )}
                      </div>
                    )}
                    {isCancelled ? (
                      <div className="mt-1.5">
                        <span className="inline-block px-2 py-0.5 text-[11px] font-medium rounded bg-gray-100 text-gray-600 border border-gray-200">
                          Cancelado{group.latestItem.cancellation_reason ? ` — ${group.latestItem.cancellation_reason}` : ''}
                        </span>
                      </div>
                    ) : !closed && (
                      activeCancellingItem ? (
                        <form onSubmit={handleCancel} className="mt-2 space-y-2 rounded-lg bg-red-50/70 p-2.5 border border-red-200">
                          <label htmlFor={`cancel-reason-${activeCancellingItem.id}`} className="block text-xs font-semibold text-red-900">
                            Motivo do cancelamento (estornando lote de {activeCancellingItem.quantity}x)
                          </label>
                          <input
                            id={`cancel-reason-${activeCancellingItem.id}`}
                            required
                            minLength={3}
                            maxLength={300}
                            value={reason}
                            disabled={disabled}
                            placeholder="Ex: Cliente desistiu antes do preparo"
                            onChange={(event) => setReason(event.target.value)}
                            className="min-h-9 w-full rounded-lg border border-black/20 bg-white text-stone-900 placeholder:text-stone-400 dark:border-white/20 dark:bg-stone-800 dark:text-stone-100 dark:placeholder:text-stone-500 px-2 text-xs focus:outline-none focus:ring-1 focus:ring-orange-500"
                          />
                          <div className="flex gap-2">
                            <button
                              type="submit"
                              disabled={disabled}
                              className="min-h-8 rounded-lg bg-red-700 hover:bg-red-800 px-3 text-xs font-semibold text-white disabled:opacity-50"
                            >
                              Confirmar estorno
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => { setCancellingId(null); setReason(''); }}
                              className="min-h-8 rounded-lg border border-black/15 bg-white text-stone-800 hover:bg-stone-50 dark:border-white/15 dark:bg-stone-800 dark:text-stone-200 dark:hover:bg-stone-700 px-3 text-xs transition-colors"
                            >
                              Voltar
                            </button>
                          </div>
                        </form>
                      ) : (
                        <div className="mt-2 flex flex-col gap-1.5">
                          {group.originalItems.length === 1 ? (
                            <button
                              type="button"
                              disabled={disabled}
                              onClick={() => { setCancellingId(group.originalItems[0].id); setReason(''); setActionError(''); }}
                              className="text-left text-xs text-[var(--brand)] underline hover:text-red-700 disabled:opacity-50"
                            >
                              Cancelar lançamento
                            </button>
                          ) : (
                            <div className="space-y-1.5">
                              <div className="flex flex-wrap items-center gap-3">
                                <button
                                  type="button"
                                  disabled={disabled}
                                  onClick={() => { setCancellingId(group.latestItem.id); setReason(''); setActionError(''); }}
                                  className="text-xs text-[var(--brand)] underline hover:text-red-700 font-medium disabled:opacity-50"
                                >
                                  Cancelar último lançamento ({group.latestItem.quantity}x)
                                </button>
                                <button
                                  type="button"
                                  onClick={() => toggleExpandBatch(group.key)}
                                  className="text-xs text-stone-600 hover:text-stone-900 underline"
                                >
                                  {isExpanded ? 'Ocultar lotes' : `Ver todos os ${group.originalItems.length} lotes`}
                                </button>
                              </div>

                              {isExpanded && (
                                <div className="mt-2 space-y-1 rounded-lg bg-[#f8f5f0] p-2 border border-[#ded5c8]">
                                  <span className="text-[11px] font-semibold text-stone-700 block">
                                    Lançamentos individuais deste item:
                                  </span>
                                  {group.originalItems.map((batch, idx) => (
                                    <div
                                      key={batch.id}
                                      className="flex items-center justify-between text-[11px] py-1 border-b border-[#ebdccb] last:border-0"
                                    >
                                      <span className="text-stone-700">
                                        Lote #{idx + 1}: <strong>{batch.quantity}x</strong> às {timeFormat.format(new Date(batch.created_at))} ({currency.format(batch.line_total_in_cents / 100)})
                                      </span>
                                      <button
                                        type="button"
                                        disabled={disabled}
                                        onClick={() => { setCancellingId(batch.id); setReason(''); setActionError(''); }}
                                        className="text-[var(--brand)] underline hover:text-red-700 font-semibold"
                                      >
                                        Cancelar este
                                      </button>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <div className="mt-4 pt-3 border-t border-[#ded5c8] dark:border-white/10 space-y-3">
            {/* Linha de Subtotal */}
            <div className="flex items-center justify-between text-xs text-stone-600 dark:text-stone-300">
              <span>Subtotal dos itens:</span>
              <span className="font-semibold">{currency.format(total / 100)}</span>
            </div>

            {/* Seletor de Taxa de Serviço (10% Ativo/Inativo) */}
            <div className="flex items-center justify-between text-xs bg-stone-50 dark:bg-stone-900/60 p-2.5 rounded-xl border border-stone-200 dark:border-stone-800">
              <label className="flex items-center gap-2 cursor-pointer font-medium text-stone-700 dark:text-stone-300">
                <input
                  type="checkbox"
                  checked={includeServiceFee}
                  onChange={(e) => setIncludeServiceFee(e.target.checked)}
                  className="rounded accent-[var(--brand)]"
                />
                <span>Taxa de serviço ({feePercent}%)</span>
              </label>
              <span className="font-semibold text-stone-800 dark:text-stone-200">
                {includeServiceFee ? currency.format(feeInCents / 100) : 'R$ 0,00'}
              </span>
            </div>

            {/* Total Geral da Comanda */}
            <div className="staff-tab-total-row flex items-center justify-between py-1">
              <span className="staff-tab-total-label font-bold text-sm">Total a pagar</span>
              <strong className="staff-tab-total-value text-xl font-black text-[var(--brand)]">
                {currency.format(grandTotalInCents / 100)}
              </strong>
            </div>

            {/* Controle de Divisão por Pessoas (1 a 20) */}
            <div className="bg-amber-50/60 dark:bg-amber-950/20 p-3 rounded-xl border border-amber-200/70 dark:border-amber-900/40">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-stone-800 dark:text-stone-200">
                  Dividir conta entre:
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={splitCount <= 1}
                    onClick={() => setSplitCount((c) => Math.max(1, c - 1))}
                    aria-label="Diminuir número de pessoas"
                    className="w-8 h-8 flex items-center justify-center rounded-lg bg-white dark:bg-stone-800 border border-stone-300 dark:border-stone-700 text-stone-800 dark:text-stone-100 font-bold disabled:opacity-40 hover:bg-stone-100 transition-colors"
                  >
                    -
                  </button>
                  <span className="font-mono font-bold text-sm min-w-8 text-center text-stone-900 dark:text-stone-100">
                    {splitCount} {splitCount === 1 ? 'pessoa' : 'pessoas'}
                  </span>
                  <button
                    type="button"
                    disabled={splitCount >= 20}
                    onClick={() => setSplitCount((c) => Math.min(20, c + 1))}
                    aria-label="Aumentar número de pessoas"
                    className="w-8 h-8 flex items-center justify-center rounded-lg bg-white dark:bg-stone-800 border border-stone-300 dark:border-stone-700 text-stone-800 dark:text-stone-100 font-bold disabled:opacity-40 hover:bg-stone-100 transition-colors"
                  >
                    +
                  </button>
                </div>
              </div>

              {splitCount > 1 && (
                <div className="mt-2.5 pt-2 border-t border-amber-200/60 dark:border-amber-900/30 flex items-center justify-between text-xs font-bold text-amber-950 dark:text-amber-200">
                  <span>Valor por pessoa:</span>
                  <span className="text-sm font-black text-[var(--brand)]">
                    {currency.format(splitValueInCents / 100)}
                  </span>
                </div>
              )}
            </div>

            {/* Botão Imprimir Conferência (80mm) */}
            <button
              type="button"
              onClick={handlePrintReceipt}
              className="w-full min-h-11 flex items-center justify-center gap-2 rounded-xl border border-stone-300 bg-white hover:bg-stone-50 dark:bg-stone-800 dark:border-stone-700 dark:hover:bg-stone-700 text-stone-900 dark:text-stone-100 font-semibold text-xs shadow-xs transition-colors"
              title="Imprimir extrato de conferência de conta na impressora térmica (80mm)"
            >
              <ThermalPrinterIcon className="w-4 h-4 text-stone-700 dark:text-stone-300" />
              <span>Imprimir Conferência (80mm)</span>
            </button>
          </div>
        </>
      )}
    </section>
  );
}

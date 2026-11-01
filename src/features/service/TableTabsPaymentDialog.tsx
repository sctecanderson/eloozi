import { useEffect, useRef, useState } from 'react';
import type { TableTab } from './tableTabs';
import { confirmTabsPayment, previewTabsPayment } from './tableTabsPayment';
import type { TabsPaymentPreview, TabsPaymentResult } from './tableTabsPayment';

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export function TableTabsPaymentDialog({ slug, visitId, tabs, feePercent, disabled, request, onPaid }: {
  slug: string; visitId: string; tabs: TableTab[]; feePercent: number; disabled: boolean;
  request: { id: number; tabIds: string[] } | null;
  onPaid: (result: TabsPaymentResult) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [ids, setIds] = useState<string[]>([]);
  const [fee, setFee] = useState(false);
  const [preview, setPreview] = useState<TabsPaymentPreview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const action = useRef(false);
  const paymentId = useRef('');
  const selection = [...ids].sort().join(',');

  useEffect(() => {
    if (!request) return;
    const eligible = new Set(tabs.filter(tab => tab.status === 'open').map(tab => tab.id));
    setIds([...new Set(request.tabIds.filter(id => eligible.has(id)))]);
    setFee(false);
    setError('');
    setOpen(true);
  }, [request?.id]);

  useEffect(() => {
    const eligible = new Set(tabs.filter(tab => tab.status === 'open').map(tab => tab.id));
    setIds(current => current.filter(id => eligible.has(id)));
  }, [tabs]);

  useEffect(() => {
    if (!open || !dialog.current) return;
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement;
    document.body.style.overflow = 'hidden';
    dialog.current.showModal();
    return () => {
      dialog.current?.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    setPreview(null);
    setError('');
    paymentId.current = crypto.randomUUID();
    if (ids.length) {
      void previewTabsPayment(slug, selection.split(','), fee).then(result => {
        if (!disposed) {
          if (result.visitId !== visitId) { setError('Atendimento diferente. Atualize a mesa.'); return; }
          setPreview(result);
        }
      }).catch(cause => { if (!disposed) setError(cause instanceof Error ? cause.message : 'Falha ao conferir.'); });
    }
    return () => { disposed = true; };
  }, [open, slug, visitId, selection, fee, refresh]);

  async function confirm() {
    if (action.current || !preview || disabled) return;
    action.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await confirmTabsPayment(slug, [...ids], fee, paymentId.current, preview);
      onPaid(result);
      setOpen(false);
    } catch (cause) {
      // Preserve the same key/token on retry: a lost response may already be committed.
      setError(cause instanceof Error ? cause.message : 'Não foi possível confirmar.');
    } finally { action.current = false; setBusy(false); }
  }

  return <>
    {open && <dialog ref={dialog} aria-labelledby="tabs-payment-title"
      onCancel={event => { if (action.current) event.preventDefault(); else setOpen(false); }}
      onClose={() => { if (!action.current) setOpen(false); }}
      className="m-auto max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-lg overflow-y-auto overscroll-contain rounded-2xl border border-zinc-200 bg-white p-5 text-zinc-900 shadow-2xl backdrop:bg-black/60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-white">
      <div className="flex items-start justify-between gap-3">
        <h2 id="tabs-payment-title" className="text-lg font-bold">Pagamento de comandas</h2>
        <button type="button" aria-label="Fechar pagamento de comandas" disabled={busy} onClick={() => setOpen(false)} className="rounded-lg px-3 py-1 text-xl focus-visible:outline-2">×</button>
      </div>
      <p className="my-3 text-sm text-zinc-600 dark:text-zinc-300">Selecione uma ou mais comandas desta mesa. Cada comanda manterá seus itens e histórico.</p>
      <fieldset disabled={busy || disabled} className="space-y-2">
        <legend className="mb-2 font-semibold">Comandas abertas</legend>
        {tabs.map(tab => <label key={tab.id} className="flex items-center gap-3 rounded-xl border border-zinc-200 p-3 dark:border-zinc-700">
          <input type="checkbox" checked={ids.includes(tab.id)} onChange={e => setIds(previous => e.target.checked ? [...previous, tab.id] : previous.filter(id => id !== tab.id))} />
          <span className="min-w-0 break-words">{tab.label}</span>
        </label>)}
        {feePercent > 0 && <label className="flex items-center gap-3 py-3">
          <input type="checkbox" checked={fee} onChange={e => setFee(e.target.checked)} />
          Incluir taxa de serviço ({feePercent}%) nas comandas selecionadas
        </label>}
      </fieldset>
      <div aria-live="polite" className="my-4 space-y-2">
        {!preview && ids.length > 0 && !error && <p>Conferindo valores no servidor…</p>}
        {preview && <>
          {preview.tabs.map(tab => <div key={tab.id} className="flex flex-wrap justify-between gap-2 text-sm">
            <span>{tab.label}{tab.serviceFeeInCents > 0 ? ` (inclui ${currency.format(tab.serviceFeeInCents / 100)} de taxa)` : ''}</span>
            <strong>{currency.format(tab.totalInCents / 100)}</strong>
          </div>)}
          <div className="flex justify-between gap-3 border-t border-zinc-200 pt-3 text-lg dark:border-zinc-700"><strong>Total conjunto</strong><strong>{currency.format(preview.totalInCents / 100)}</strong></div>
        </>}
      </div>
      {error && <div role="alert" className="my-3 text-sm text-red-700 dark:text-red-300">
        <p>{error}</p>
        <button type="button" disabled={busy} onClick={() => setRefresh(n => n + 1)} className="mt-2 underline">Conferir novamente</button>
      </div>}
      <p className="mb-4 text-xs text-zinc-600 dark:text-zinc-300">Somente as selecionadas serão quitadas. O encerramento da mesa continua disponível após concluir todas as comandas e demais pendências.</p>
      <button type="button" disabled={!preview || busy || disabled} onClick={() => void confirm()}
        className="w-full rounded-xl bg-[#4A1505] px-4 py-3 font-bold text-white disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2">
        {busy ? 'Confirmando…' : 'Confirmar pagamento das selecionadas'}
      </button>
    </dialog>}
  </>;
}

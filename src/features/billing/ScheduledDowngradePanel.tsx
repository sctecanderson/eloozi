import type {SubscriptionPlanId} from './billingService';
import type {ScheduledChangeState} from './scheduledDowngrade';
import './scheduled-downgrade.css';
const names={basic:'Básico',pro:'Profissional',premium:'Premium'};
export function ScheduledDowngradePanel({state,draft,busy,error,onSave,onDismiss,onCancel,onRenew}:{state:ScheduledChangeState|null;draft:SubscriptionPlanId|null;busy:boolean;error:string|null;onSave:()=>void;onDismiss:()=>void;onCancel:()=>void;onRenew:()=>void}){
 const change=state?.scheduled_change;
 if(!draft&&!change&&!error)return null;
 const target=draft??change?.target_plan;const current=state?.current_plan??change?.from_plan;
 const date=change?.not_before??state?.not_before;
 return <section id="scheduled-downgrade" className="scheduled-downgrade" aria-labelledby="scheduled-change-title" aria-busy={busy}>
  <h2 id="scheduled-change-title">{draft?'Agendar plano inferior':'Próxima renovação'}</h2>
  {current&&target&&<p><strong>Plano contratado: {names[current]}</strong><span aria-hidden="true"> · </span>Plano futuro: <strong>{names[target]}</strong></p>}
  {date&&<p>A mudança poderá valer a partir de <strong>{new Date(date).toLocaleString('pt-BR')}</strong>, somente após a confirmação da renovação correspondente.</p>}
  <p>O plano atual continua até o fim dos períodos já pagos. O teste Premium e seus dias gratuitos permanecem preservados. Agendar não gera cobrança, crédito ou reembolso.</p>
  {state?.billing_cycle&&<p className="scheduled-secondary">Periodicidade mantida: {state.billing_cycle==='yearly'?'anual (365 dias)':'mensal (30 dias)'}. A renovação no plano inferior fica disponível a partir da data indicada, pelo preço integral do catálogo.</p>}
  {error&&<p role="alert">{error}</p>}
  {!state?.available&&state?.reason&&<p role="alert">{state.reason}</p>}
  {change?.state==='reserved'&&<p>Há uma cobrança de renovação pendente. O plano inferior só será aplicado após a confirmação. Para cancelar ou substituir, essa cobrança precisa ser concluída ou reconciliada.</p>}
  {change?.state==='review_required'&&<p role="alert">Pagamento recebido em análise. Nenhum novo plano ou período foi aplicado. É necessária reconciliação administrativa.</p>}
  <div className="scheduled-actions">
   {draft?<><button type="button" disabled={busy||!state?.available||change?.state==='reserved'||change?.state==='review_required'} onClick={onSave}>{busy?'Salvando…':'Confirmar agendamento sem cobrança'}</button><button type="button" disabled={busy} onClick={onDismiss}>Voltar</button></>:change&&<><button type="button" disabled={busy||change.state!=='scheduled'} onClick={onCancel}>Cancelar agendamento</button><button type="button" disabled={busy||!state?.can_renew||change.state==='review_required'} onClick={onRenew}>Renovar com {names[change.target_plan]}</button></>}
  </div>
 </section>;
}

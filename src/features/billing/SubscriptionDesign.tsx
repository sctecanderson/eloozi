import {useEffect,useId,useRef,type ReactNode} from 'react';
import type {BillingCycle,SubscriptionPlanId} from './billingService';
import {resolveSubscriptionCatalogView} from './billingService';
import type {BillingSummaryResponse} from './billingService';
import './subscription-design.css';
import './subscription-layout.css';
import './checkout-shell.css';
import {planAsset,dialogBoundary,contractFeatureIcon,contractTitleAsset} from './subscriptionPresentation';

const names={basic:'Básico',pro:'Profissional',premium:'Premium'};
export function BillingIcon({kind}:{kind:'date'|'tables'|'products'|'payment'|'lock'}){
 const paths={date:'M4 5h16v16H4ZM4 10h16M8 2v6m8-6v6M8 14h3v3H8Z',tables:'M3 9h18v4H3ZM5 13l-2 8m16-8 2 8M6 9V4h12v5',products:'M4 3h16v18H4ZM8 7h8M8 11h8M8 15h5',payment:'M3 5h18v15H3ZM3 10h18M7 15h4',lock:'M6 10h12v12H6ZM8 10V6a4 4 0 0 1 8 0v4m-4 5v3'};
 return <span className="billing-symbol" aria-hidden="true"><svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={paths[kind]}/></svg></span>;
}
export function PlanBanner({plan}:{plan?:SubscriptionPlanId}){
 const asset=planAsset(plan);
 if(!plan)return <div className="plan-art plan-art-top"><img src={asset} width="1900" height="429" alt="Planos Eloozi para seu restaurante"/></div>;
 return (
  <div className="plan-art-checkout">
   <img
    className="plan-art-checkout-img"
    src={asset}
    alt={`Plano ${names[plan]} Eloozi`}
    width={plan==='basic'?1897:2170}
    height={plan==='basic'?829:725}
   />
  </div>
 );
}

const benefits={basic:['Cardápio Digital com QR Code','Pedidos e comandas em tempo real'],pro:['Tudo do plano Básico','KDS Cozinha e Bar'],premium:['Tudo do plano Profissional','Gestão de Estoque e Insumos','Financeiro e Fechamento de Caixa']};
export function SubscriptionPlanCards({catalog,cycle,current,onSelect,onCycle}:{catalog:BillingSummaryResponse['catalog'];cycle:BillingCycle;current:SubscriptionPlanId|null;onSelect:(plan:SubscriptionPlanId,cycle:BillingCycle)=>void;onCycle:(cycle:BillingCycle)=>void}){
 const view=resolveSubscriptionCatalogView(catalog,cycle);
 return <section className="plans-choice" id="escolha-de-planos" aria-labelledby="choose-plan-title"><div className="plans-choice-layout">
  <header className="plans-choice-heading"><div><h2 id="choose-plan-title">Escolha o plano ideal para o seu restaurante</h2><p>Compare os recursos incluídos em cada plano.</p></div><div className="plans-cycle" aria-label="Periodicidade"><button type="button" aria-pressed={cycle==='monthly'} onClick={()=>onCycle('monthly')}>Mensal</button><button type="button" aria-pressed={cycle==='yearly'} onClick={()=>onCycle('yearly')}>Anual {view.yearlyToggleBadgeLabel&&<small>{view.yearlyToggleBadgeLabel}</small>}</button></div></header>
  <div className="plan-cards">{(['basic','pro','premium'] as const).map(id=>{const item=view.plans[id];const selected=current===id;return <article className={`subscription-plan subscription-plan-${id}`} key={id}>
   {id==='premium'&&<span className="plan-ribbon">GESTÃO COMPLETA</span>}
   <header><span className="plan-symbol" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><path d={id==='basic'?'M3 10 12 3l9 7v11h-6v-7H9v7H3Z':id==='pro'?'M8 3h8v8a4 4 0 0 1-8 0V3ZM8 5H4v3a4 4 0 0 0 4 4m8-7h4v3a4 4 0 0 1-4 4m-4 3v6m-4 0h8':'M3 8l4-5h10l4 5-9 13L3 8Zm0 0h18M7 3l5 18 5-18'}/></svg></span><div><h3>Plano {names[id]}</h3><p>{id==='basic'?'Organize o atendimento em mesas.':id==='pro'?'Mais mesas, cozinha e bar conectados.':'Mesas sem limite, estoque e financeiro.'}</p></div></header>
   <div className="plan-price"><strong>{item.primaryPriceLabel}</strong><span>{item.primaryPeriodSuffix}</span></div><p className="plan-billing">{item.secondaryBillingLabel}</p>
   {!item.valid&&<p role="alert">{item.validationMessage}</p>}
   <button type="button" disabled={selected||!item.canCheckout} className="plan-select" onClick={()=>onSelect(id,cycle)}>{selected?'Plano contratado':item.canCheckout?'Selecionar plano':'Indisponível'}</button>
   <ul>{[item.tablesBenefitLabel,...benefits[id]].map(text=><li key={text}><span aria-hidden="true">✓</span>{text}</li>)}</ul>
  </article>})}</div><aside className="plan-facts" aria-label="Sobre a contratação">
 <div><BillingIcon kind="lock"/><div><b>Confirmação do pagamento</b><p>Aplicação após confirmação.</p></div></div>
 <div><BillingIcon kind="payment"/><div><b>PIX e cartão</b><p>Meios disponíveis no checkout.</p></div></div>
 <div><BillingIcon kind="date"/><div><b>Faturas e recibos</b><p>Histórico disponível nesta página.</p></div></div>
 <div><BillingIcon kind="date"/><div><b>Trial preservado</b><p>Dias gratuitos preservados.</p></div></div>
 <div><BillingIcon kind="products"/><div><b>Comparativo de recursos</b><p>Confira o que cada plano inclui.</p></div></div>
 </aside></div>
 </section>;
}

export function CheckoutShell({plan,cycle,onClose,children}:{plan:SubscriptionPlanId;cycle?:BillingCycle;onClose:()=>void;children:ReactNode}){
 const frame=useRef<HTMLDivElement>(null);const close=useRef<HTMLButtonElement>(null);const callback=useRef(onClose);callback.current=onClose;const title=useId();
 useEffect(()=>{
  const previous=document.activeElement as HTMLElement|null;const overflow=document.body.style.overflow;const rootOverflow=document.documentElement.style.overflow;const overscroll=document.documentElement.style.overscrollBehavior;document.body.style.overflow='hidden';document.documentElement.style.overflow='hidden';document.documentElement.style.overscrollBehavior='none';close.current?.focus({preventScroll:true});
  const candidates=()=>Array.from(frame.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')??[]).filter(el=>el.getClientRects().length&&!el.closest('[hidden]'));
  const keys=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();callback.current();}if(event.key==='Tab'){const items=candidates();const target=dialogBoundary(items.indexOf(document.activeElement as HTMLElement),items.length,event.shiftKey);if(target!==null){event.preventDefault();items[target]?.focus();}}};
  const contain=(event:FocusEvent)=>{if(frame.current&&!frame.current.contains(event.target as Node))close.current?.focus();};
  const updates=new MutationObserver(()=>{if(frame.current&&!frame.current.contains(document.activeElement))close.current?.focus({preventScroll:true});});
  if(frame.current)updates.observe(frame.current,{childList:true,subtree:true});
  document.addEventListener('keydown',keys,true);document.addEventListener('focusin',contain);
  return()=>{updates.disconnect();document.removeEventListener('keydown',keys,true);document.removeEventListener('focusin',contain);document.body.style.overflow=overflow;document.documentElement.style.overflow=rootOverflow;document.documentElement.style.overscrollBehavior=overscroll;if(previous?.isConnected&&!previous.matches(':disabled'))previous.focus();else document.querySelector<HTMLButtonElement>('.overview-details')?.focus();};
 },[]);
 return (
  <div className="subscription-checkout-overlay">
   <div ref={frame} className="subscription-checkout" role="dialog" aria-modal="true" aria-labelledby={title}>
    <div className="checkout-banner-stage">
     <button ref={close} type="button" className="checkout-close" aria-label="Fechar checkout" onClick={onClose}>×</button>
     <PlanBanner plan={plan}/>
    </div>
    <div className="subscription-checkout-card">
     <div className="subscription-checkout-body">
      <div className="checkout-title">
       <div className="checkout-title-left">
        <div className="checkout-title-icon" aria-hidden="true">
         <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
         </svg>
        </div>
        <div className="checkout-title-text">
         <h2 id={title}>Checkout Seguro de Assinatura</h2>
         <p className="checkout-subtitle">{`Plano ${names[plan]}`}{cycle?` · Ciclo ${cycle==='yearly'?'Anual':'Mensal'}`:''}</p>
        </div>
       </div>
       <div className="checkout-security-badge" aria-label="Pagamento via Asaas">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
         <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
         <path d="m9 12 2 2 4-4"/>
        </svg>
        <span>Pagamento via Asaas</span>
       </div>
      </div>
      {children}
     </div>
    </div>
   </div>
  </div>
 );
}

// Contract details only. The same resolved contract id drives title art and accessible name.
export function ContractTitle({plan,name}:{plan:SubscriptionPlanId|null;name:string}){
 const asset=contractTitleAsset(plan);
 return <h2 className={asset?'contract-title-art':undefined}>{asset?<><span className="sr-only">{name.replace(/^(?:Plano\s+)+/i,'Plano ')}</span><img src={asset} alt="" aria-hidden="true" width="394" height={plan==='basic'?119:plan==='pro'?84:92}/></>:name}</h2>;
}
export function ContractResourceIcon({label}:{label:string}){if(label==='Financeiro')return <svg className="contract-resource-icon" aria-hidden="true" width="28" height="28" viewBox="0 0 28 28" fill="currentColor"><rect x="3" y="16" width="5" height="9" rx="1"/><rect x="11" y="10" width="5" height="15" rx="1"/><rect x="19" y="4" width="5" height="21" rx="1"/></svg>;return <img className="contract-resource-icon" src={'/landing/planos/icons/'+contractFeatureIcon(label)+'.svg'} alt="" aria-hidden="true" width="28" height="28"/>;}

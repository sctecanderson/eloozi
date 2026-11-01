import type {EffectiveSubscription} from './TrialBanner';
import type {SubscriptionPlanId} from './billingService';
export function planAsset(plan?:SubscriptionPlanId){return `/landing/planos/${plan?{basic:'banner-basico.png',pro:'banner-profissional.png',premium:'banner-premium.png'}[plan]:'banner-top.png'}`;}
// A free Premium experience is not an already-purchased Premium contract.
export function visibleContractPlan(raw:SubscriptionPlanId,e?:EffectiveSubscription){return e?.known_trial&&e.trial_active?e.contracted_plan??null:raw;}
export function checkoutPeriodLabel(e?:EffectiveSubscription){return e?.known_trial&&e.trial_active?'Período pago após o teste (mantido)':'Período deste pagamento (mantido)';}
export function dialogBoundary(index:number,count:number,backwards:boolean){if(count<1)return null;if(backwards&&index===0)return count-1;if(!backwards&&index===count-1)return 0;return null;}
// Presentation deduplication only: capacity and all feature values still come from the catalog.
export function contractResources(capacity:string,features:readonly string[]){
 const seen=new Set<string>();
 return [capacity,...features].map(text=>text.trim().replace(/\s+/g,' ')).filter(text=>{
  let key=text.normalize('NFKC').toLocaleLowerCase('pt-BR');
  if(/^(?:até \d+ mesas|mesas (?:simultâneas )?ilimitadas$)/.test(key))key=key.replace(/\s+simultâneas\b/g,'');
  if(!key||seen.has(key))return false;seen.add(key);return true;
 });
}

// Icon selection affects presentation only; unknown catalog labels keep a neutral resource icon.
export function contractFeatureIcon(label:string){
 const text=label.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
 if(/\bmesas?\b/.test(text))return 'person-icon';
 if(/cardapio|comanda|pedido/.test(text))return 'menu-icon';
 if(/kds|cozinha|\bbar\b/.test(text))return 'cheff-icon';
 if(/estoque|insumo/.test(text))return 'box-icon';
 if(/financeiro|caixa|relatorio/.test(text))return 'up-icon';
 return 'card-icon';
}
export function contractTitleAsset(plan:SubscriptionPlanId|null){return plan?'/landing/planos/icons/'+{basic:'basico.png',pro:'profissional.png',premium:'premium.png'}[plan]:null;}

// Expand only inheritance explicitly declared by the received catalog. Capacity belongs to the target.
export function contractDetailResources(capacity:string,plan:SubscriptionPlanId,catalog:Partial<Record<SubscriptionPlanId,{features:readonly string[]}>>){
 const key=(s:string)=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
 const visit=(id:SubscriptionPlanId,seen=new Set<SubscriptionPlanId>()):string[]=>{
  if(seen.has(id))return [];seen.add(id);
  return (catalog[id]?.features??[]).flatMap(label=>{
   const text=key(label);const parent=/^tudo do (?:plano )?basico$/.test(text.trim())?'basic':/^tudo do (?:plano )?profissional$/.test(text.trim())?'pro':null;
   if(parent&&(['basic','pro','premium'].indexOf(parent)<['basic','pro','premium'].indexOf(id)))return visit(parent,seen);
   return [label];
  });
 };
 const features=visit(plan).filter(s=>!/(?:\bmesas?\b)/.test(key(s)));
 const has=(pattern:RegExp)=>features.some(s=>pattern.test(key(s)));
 const result=[capacity];
 if(has(/cardapio/))result.push(has(/comanda|pedido/)?'Cardápio digital e comandas':'Cardápio digital');
 if(has(/kds|cozinha/))result.push('KDS Cozinha e Bar');
 if(has(/estoque|insumo/))result.push('Estoque e Insumos');
 if(has(/financeiro|fechamento de caixa/))result.push('Financeiro');
 result.push(...features.filter(s=>!(/cardapio|comanda|pedido|kds|cozinha|estoque|insumo|financeiro|fechamento de caixa/.test(key(s)))));
 // Keep standalone ordering/comanda labels if no menu entry was supplied.
 if(!has(/cardapio/))result.push(...features.filter(s=>/comanda|pedido/.test(key(s))));
 return contractResources(capacity,result);
}

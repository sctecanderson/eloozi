import type {EffectiveSubscription} from './TrialBanner';
const names = {basic:'Básico',pro:'Profissional',premium:'Premium'};
const dateLabel = (v?:string|null) => v && Number.isFinite(Date.parse(v)) ? new Date(v).toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}) : null;
// Presentation only: eligibility, plan and dates are confirmed server fields.
export function subscriptionNotices(e?:EffectiveSubscription, now=Date.now()) {
 const end=dateLabel(e?.original_trial_end);
 if(!e?.known_trial || !e.trial_active || !end || e.contracted_plan==='premium')return [];
 if(!e.contracted_plan){const hours=Math.max(0,Math.ceil((Date.parse(e.original_trial_end!)-now)/3600000));return ['Experiência Premium: todos os módulos e mesas sem limite.',`Seu teste termina em ${end} · ${hours} ${hours===1?'hora restante':'horas restantes'}.`,'Escolha seu plano para continuar depois do teste.'];}
 const start=dateLabel(e.paid_start);
 return [`Sua experiência Premium continua até ${end}.`,start?`${names[e.contracted_plan]} contratado · começa em ${start}.`:`${names[e.contracted_plan]} contratado para depois do teste.`,e.contracted_plan==='basic'?'Depois do teste: sem KDS, Estoque e Financeiro.':'Depois do teste: KDS incluído; sem Estoque e Financeiro.'];
}
export function premiumTrialNote(e?:EffectiveSubscription){const start=dateLabel(e?.paid_start);return e?.known_trial && e.trial_active && e.contracted_plan==='premium' && start ? `Seu período pago começa em ${start}. Seus dias gratuitos foram preservados.`:null;}
export const NOTICE_TIMING={travel:600,hold:4000,total:5200} as const;
export function noticePaused(user:boolean,hover:boolean,focus:boolean,reduced:boolean){return user||hover||focus||reduced;}
export function nextNotice(index:number,delta:number,count:number){return count>0?((index+delta)%count+count)%count:0;}

import {supabase} from '../../lib/supabase';
import type {SubscriptionPlanId,BillingCycle} from './billingService';
export interface ScheduledChange {
 id:string;from_plan:SubscriptionPlanId;target_plan:SubscriptionPlanId;billing_cycle:BillingCycle;not_before:string;
 state:'scheduled'|'reserved'|'review_required';
}
export interface ScheduledChangeState {
 available:boolean;reason:string|null;current_plan:SubscriptionPlanId|null;billing_cycle:BillingCycle|null;not_before:string|null;
 scheduled_change:ScheduledChange|null;can_renew:boolean;
}
interface RpcClient {rpc:(name:string,args:Record<string,unknown>)=>PromiseLike<{data:unknown;error:{message?:string}|null}>}
function confirmedState(data:unknown):ScheduledChangeState{
 if(!data||typeof data!=='object'||typeof (data as ScheduledChangeState).available!=='boolean'||!('scheduled_change' in data))throw new Error('Resposta da próxima renovação indisponível. Atualize a página antes de continuar.');
 return data as ScheduledChangeState;
}
export function isLowerPlan(target:SubscriptionPlanId,current:SubscriptionPlanId|null|undefined){
 return !!current&&['basic','pro','premium'].indexOf(target)<['basic','pro','premium'].indexOf(current);
}
export async function readScheduledChange(restaurantId:string,client:RpcClient=supabase):Promise<ScheduledChangeState>{
 const {data,error}=await client.rpc('get_scheduled_subscription_change',{p_restaurant_id:restaurantId});
 if(error)throw new Error(error.message||'Não foi possível consultar a próxima renovação.');
 return confirmedState(data);
}
export async function changeScheduledDowngrade(restaurantId:string,target:SubscriptionPlanId|null,client:RpcClient=supabase):Promise<ScheduledChangeState>{
 const {data,error}=await client.rpc(target?'schedule_subscription_downgrade':'cancel_subscription_downgrade',target?{p_restaurant_id:restaurantId,p_target_plan:target}:{p_restaurant_id:restaurantId});
 if(error)throw new Error(error.message||'Não foi possível salvar o agendamento.');
 return confirmedState(data);
}

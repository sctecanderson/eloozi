import {test} from 'node:test';import assert from 'node:assert/strict';
import {isLowerPlan,readScheduledChange,changeScheduledDowngrade} from '../src/features/billing/scheduledDowngrade.ts';
import {createSubscriptionCheckout} from '../src/features/billing/billingService.ts';
const state={available:true,reason:null,current_plan:'premium',billing_cycle:'monthly',not_before:'2030-01-01T00:00:00Z',scheduled_change:null,can_renew:false};
test('schedule sends only restaurant and destination; no amount, dates, credit or invoice payload',async()=>{
 const calls:unknown[]=[];const client={rpc:async(name:string,args:Record<string,unknown>)=>{calls.push({name,args});return{data:state,error:null};}};
 assert.deepEqual(await changeScheduledDowngrade('tenant-a','basic',client),state);
 await changeScheduledDowngrade('tenant-a',null,client);await readScheduledChange('tenant-a',client);
 assert.deepEqual(calls,[{name:'schedule_subscription_downgrade',args:{p_restaurant_id:'tenant-a',p_target_plan:'basic'}},{name:'cancel_subscription_downgrade',args:{p_restaurant_id:'tenant-a'}},{name:'get_scheduled_subscription_change',args:{p_restaurant_id:'tenant-a'}}]);
});
test('RPC errors and missing server decisions never report scheduling success',async()=>{
 await assert.rejects(changeScheduledDowngrade('tenant-a','basic',{rpc:async()=>({data:null,error:{message:'Acesso negado'}})}),/Acesso negado/);
 for(const data of [null,true,{}])await assert.rejects(readScheduledChange('tenant-a',{rpc:async()=>({data,error:null})}));
});
test('lower target uses contracted tier, not the effective free Premium trial',()=>{
 assert.equal(isLowerPlan('basic',null),false);assert.equal(isLowerPlan('premium','premium'),false);
 assert.equal(isLowerPlan('basic','premium'),true);assert.equal(isLowerPlan('pro','premium'),true);
 assert.equal(isLowerPlan('pro','basic'),false);assert.equal(isLowerPlan('basic','basic'),false);
});
test('existing checkout carries the stable schedule token for PIX and card retries',async()=>{
 for(const paymentMethod of ['pix','credit_card'] as const){
  const calls:Record<string,unknown>[]=[];
  const client={functions:{invoke:async(name:string,{body}:{body:Record<string,unknown>})=>{assert.equal(name,'asaas-checkout');calls.push(body);return {data:{invoice_id:'same-invoice',plan_id:'basic',billing_cycle:'monthly',payment_method:paymentMethod,status:'pending',amount_cents:9990},error:null};}}};
  for(let n=0;n<2;n++)await createSubscriptionCheckout({restaurantId:'tenant-a',targetPlan:'basic',billingCycle:'monthly',paymentMethod,quoteToken:'scheduled-downgrade:stable-id',supabaseClient:client});
  assert.deepEqual(calls[0],calls[1]);assert.equal(calls[0].quoteToken,'scheduled-downgrade:stable-id');assert.equal('amount_cents' in calls[0],false);
 }
});

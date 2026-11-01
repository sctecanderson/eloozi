// Local full-stack fixture. Never reads .env, never connects to Supabase/Asaas remotely.
// node --experimental-strip-types scripts/validate-downgrade-integrated.mjs [--serve]
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {createLocalRuntime} from './fixtures/downgrade-local-runtime.mjs';
const root=path.resolve(import.meta.dirname,'..'),rt=createLocalRuntime();let vite;let browserCalls=[];
const serve=process.argv.includes('--serve');
let stopBrowser;const browserStopped=new Promise(resolve=>{stopBrowser=resolve;});
function stable(s){return {restaurant:s.restaurant,tables:s.tables,cycles:s.cycles,allocations:s.allocations,receipts:s.receipts};}
async function prepare(cycle='monthly'){
 const fixture=await rt.seed(cycle),{rid}=fixture;const initial=rt.snapshot(rid);
 rt.ok(initial.effective.trial_active&&initial.effective.plan==='premium'&&initial.cycles.length===1,'real onboarding and first confirmation preserve Premium trial '+cycle);
 const target=cycle==='monthly'?'basic':'pro';
 const q=await rt.must('schedule_subscription_downgrade',{p_restaurant_id:rid,p_target_plan:target});
 rt.ok(JSON.stringify(stable(initial))===JSON.stringify(stable(rt.snapshot(rid))),'schedule changes no current plan, dates, tables, cycles or credits '+cycle);
 const id=q.scheduled_change.id,token='scheduled-downgrade:'+id;
 rt.setClock(`(select not_before-interval '1 microsecond' from subscription_quote_private.plan_changes where id=${rt.literal(id)})`);
 const before=rt.snapshot(rid);rt.ok(before.effective.plan==='premium'&&before.effective.unlimited_tables,'before boundary paid Premium remains unlimited '+cycle);
 rt.ok(!((await rt.must('get_scheduled_subscription_change',{p_restaurant_id:rid})).can_renew),'server refuses renewal before boundary '+cycle);
 return {...fixture,target,token,id,before};
}
const body=f=>({action:'checkout',restaurantId:f.rid,targetPlan:f.target,billingCycle:f.cycle,paymentMethod:'pix',quoteToken:f.token,payerInfo:{cpfCnpj:'00000000000'}});
async function advance(f){rt.setClock(`(select not_before from subscription_quote_private.plan_changes where id=${rt.literal(f.id)})`);return rt.must('get_scheduled_subscription_change',{p_restaurant_id:f.rid});}
async function runCase(cycle){
 const f=await prepare(cycle);const postCount=()=>rt.gatewayCalls.filter(c=>c.method==='POST'&&c.path.endsWith('/payments')).length;
 let count=postCount(),denied=await rt.checkout(body(f));
 rt.ok(denied.http>=400&&postCount()===count,'early checkout blocked before a gateway POST '+cycle);
 const due=await advance(f);rt.ok(due.can_renew,'exact boundary releases server renewal decision '+cycle);
 const atBoundary=rt.snapshot(f.rid);
 const q=await rt.checkout(body(f));rt.ok(q.http===200&&q.body.status==='pending','lower renewal emits pending PIX through existing handler '+cycle+' '+JSON.stringify(q));
 const iid=q.body.invoice_id,expected=rt.json(`select to_jsonb(${f.target==='basic'?'basic_price_cents':'pro_price_cents'}*${cycle==='yearly'?11:1}) from public.platform_settings where id='default'`);
 rt.ok(q.body.amount_cents===expected,'renewal uses official server catalog price '+cycle);
 const pending=rt.snapshot(f.rid);rt.ok(JSON.stringify(stable(pending))===JSON.stringify(stable(atBoundary)),'pending invoice changes no plan, table, contract date, cycle or allocation '+cycle);
 const unpaid=await rt.checkout({action:'verify_payment',restaurantId:f.rid,invoiceId:iid});rt.ok(unpaid.http===200&&unpaid.body.status==='pending','manual verification cannot confirm unpaid gateway status '+cycle);
 rt.ok(JSON.stringify(stable(pending))===JSON.stringify(stable(rt.snapshot(f.rid))),'unpaid verification leaves persisted state unchanged '+cycle);
 const payment=rt.receive(iid);
 const paid=cycle==='monthly'?await rt.checkout({action:'verify_payment',restaurantId:f.rid,invoiceId:iid}):await rt.webhook(payment);
 rt.ok(paid.http===200&&(paid.body.status==='paid'||paid.body.confirmed===true),'existing '+(cycle==='monthly'?'manual':'webhook')+' confirms lower renewal '+cycle+' '+JSON.stringify(paid));
 const after=rt.snapshot(f.rid);
 rt.ok(after.restaurant.subscription_plan===f.target&&after.effective.plan===f.target,'raw and effective plans change only after confirmed payment '+cycle);
 rt.ok(after.cycles.length===pending.cycles.length+1&&after.allocations===pending.allocations+1&&after.receipts===1,'one independent cycle, allocation and receipt '+cycle);
 const latest=after.cycles.at(-1);rt.ok((Date.parse(latest.ends_at)-Date.parse(latest.starts_at))/3600000===(cycle==='monthly'?720:8760),'paid cycle duration exact '+cycle);
 rt.ok(after.effective.max_tables===(f.target==='basic'?5:20)&&after.effective.unlimited_tables===false,'new server capacity matches lower tier '+cycle);
 const modules=await rt.must('get_restaurant_module_access',{p_restaurant_id:f.rid});rt.ok(modules.inventory===false&&modules.finance===false,'inventory/finance blocked by real server decision '+cycle);
 const kds=await rt.rpc('get_kds_active_items',{p_restaurant_slug:f.slug},'authenticated');
 rt.ok(f.target==='basic'?!!kds.error:!kds.error,'real KDS RPC '+(f.target==='basic'?'denied on Basic':'available on Pro')+' '+cycle);
 const active=after.tables.filter(t=>t.deleted_at===null&&(t.is_active??t.active));rt.ok(active.length===Math.min(8,f.target==='basic'?5:20)&&after.tables.length===8,'table sync respects new quantity, keeps all table records '+cycle);
 count=postCount();
 for(let n=0;n<2;n++){
  const replay=await rt.checkout({action:'verify_payment',restaurantId:f.rid,invoiceId:iid});rt.ok(replay.http===200&&replay.body.status==='paid','manual confirmation replay '+cycle+'/'+n);
  const hook=await rt.webhook(payment);rt.ok(hook.http===200&&hook.body.confirmed===true,'webhook replay '+cycle+'/'+n);
 }
 const retry=await rt.checkout(body(f));rt.ok(retry.http===200&&retry.body.invoice_id===iid,'checkout retry returns same paid invoice '+cycle);
 rt.ok(postCount()===count,'no new gateway POST on paid checkout retry '+cycle);
 rt.ok(JSON.stringify(stable(after))===JSON.stringify(stable(rt.snapshot(f.rid))),'all replays preserve exact dates, cycle count, table state and credits '+cycle);
 rt.save(cycle,{fixture:f,before:atBoundary,pending,after,modules,gateway:'in-process mock only',confirmationPath:cycle==='monthly'?'manual':'webhook'});
}
async function startBrowser(f){
 const {createServer}=await import('vite'),{default:react}=await import('@vitejs/plugin-react'),{default:tailwind}=await import('@tailwindcss/vite');
 const dir=path.join(root,'.tools/downgrade-integrated');fs.mkdirSync(dir,{recursive:true});
 fs.copyFileSync(path.join(root,'scripts/fixtures/downgrade-integrated-browser.tsx'),path.join(dir,'mock.tsx'));
 fs.writeFileSync(path.join(dir,'index.html'),'<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Eloozi — PostgreSQL local, gateway simulado</title><div id="root"></div><script type="module" src="/.tools/downgrade-integrated/main.tsx"></script></html>');
 fs.writeFileSync(path.join(dir,'main.tsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter,Routes,Route,Outlet} from 'react-router';import {AdminLayout} from '../../src/features/admin/AdminLayout';import {SubscriptionBillingPage} from '../../src/features/admin/SubscriptionBillingPage';import {ThemeProvider} from '../../src/features/theme/ThemeContext';import {LocalFixture,useRestaurant,Controls} from './mock';import '../../src/styles.css';localStorage.setItem('theme',new URLSearchParams(location.search).get('theme')==='dark'?'dark':'light');function App(){const {restaurant:r}=useRestaurant();return <><Controls/><MemoryRouter initialEntries={['/'+r.slug+'/admin/assinatura']}><Routes><Route element={<Outlet context={{role:'admin',active:true,restaurantId:r.id}}/>}><Route path={'/'+r.slug+'/admin'} element={<AdminLayout/>}><Route path="assinatura" element={<SubscriptionBillingPage/>}/></Route></Route></Routes></MemoryRouter></>;}createRoot(document.getElementById('root')).render(<ThemeProvider><LocalFixture><App/></LocalFixture></ThemeProvider>);`);
 const calls=[];const allowed=new Set(['get_scheduled_subscription_change','schedule_subscription_downgrade','cancel_subscription_downgrade','get_restaurant_billing_summary','get_effective_subscription','get_restaurant_module_access','get_platform_access']);
 const middleware={name:'exclusive-local-validation',configureServer(server){server.middlewares.use('/__validation',async(req,res)=>{try{
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))throw Error('Loopback only');
  let raw='';for await(const b of req)raw+=b;const args=raw?JSON.parse(raw):{};let result;
  if(req.url==='/state'){
   const s=rt.snapshot(f.rid);result={...s.restaurant,__fixture_clock:rt.json('select to_jsonb(local_validation.clock_now())'),subscriptionExpiresAt:s.restaurant.subscription_expires_at,subscriptionIsTrial:s.restaurant.subscription_is_trial,billingStatus:s.effective.billing_status,effectiveSubscription:s.effective,maxTables:s.effective.max_tables,unlimitedTables:s.effective.unlimited_tables};
  }else if(req.url==='/rpc'){
   if(!allowed.has(args.name))throw Error('RPC not allowed by local fixture');if(args.args?.p_restaurant_id&&args.args.p_restaurant_id!==f.rid)throw Error('Exclusive fixture restaurant only');
   result=await rt.rpc(args.name,args.args??{},'authenticated');
  }else if(req.url==='/function'){
   if(args.name!=='asaas-checkout')throw Error('Only existing checkout handler');if(args.body.restaurantId&&args.body.restaurantId!==f.rid)throw Error('Exclusive fixture restaurant only');
   const response=await rt.checkout(args.body);result=response.http>=400?{data:null,error:{message:response.body.error}}:{data:response.body,error:null};
  }else if(req.url==='/control'){
   if(args.action==='advance'){await advance(f);result={ok:true};}
   else if(args.action==='receive'){const pending=rt.snapshot(f.rid).invoices.findLast(i=>i.status==='pending');if(!pending)throw Error('No pending fixture invoice');rt.receive(pending.id);result={ok:true,notice:'Gateway SIMULADO recebeu, banco ainda não confirmou'};}
   else if(args.action==='save'){rt.save('browser-final',rt.snapshot(f.rid));rt.writeEvidence({mode:'browser',browserCalls:calls});result={ok:true};}
   else if(args.action==='stop'){result={ok:true};stopBrowser();}
   else throw Error('Unknown local control');
  }else throw Error('Unknown local path');
  calls.push({path:req.url,operation:args.name??args.action??'state'});res.setHeader('content-type','application/json');res.end(JSON.stringify(result));
 }catch(e){res.statusCode=400;res.end(JSON.stringify({error:{message:e.message}}));}});}};
 const mock=path.join(dir,'mock.tsx');vite=await createServer({root,configFile:false,envFile:false,plugins:[middleware,react(),tailwind()],resolve:{alias:[{find:/^.*\/RestaurantProvider$/,replacement:mock},{find:/^.*\/lib\/supabase$/,replacement:mock},{find:/^.*\/alerts\/alertService$/,replacement:mock}]},optimizeDeps:{entries:[path.join(dir,'index.html')]},server:{host:'127.0.0.1',port:5197,strictPort:true,watch:{ignored:['**/docs/**','**/artifacts/**']}}});
 await vite.listen();rt.save('browser-start',{fixture:f,snapshot:rt.snapshot(f.rid)});rt.log('LOCAL INTEGRATED UI: http://127.0.0.1:5197/.tools/downgrade-integrated/index.html');
 return calls;
}
let failed=false;
try{
 await rt.start();
 if(serve){const f=await prepare();browserCalls=await startBrowser(f);await Promise.race([browserStopped,new Promise(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);})]);}
 else{await runCase('monthly');await runCase('yearly');rt.log('FINAL PASS: existing handlers integrated with real local PostgreSQL; gateway mocked, no direct paid UPDATE or contract-date edits.');}
}catch(e){failed=true;rt.log('FINAL FAIL: '+e.stack);process.exitCode=1;}
finally{if(vite)await vite.close();try{rt.close();}catch(e){failed=true;rt.log('STOP FAIL '+e.message);process.exitCode=1;}rt.writeEvidence({mode:serve?'browser':'automated',passed:!failed,...(serve?{browserCalls}:{})});}

// Disposable PostgreSQL + real Edge handlers + in-process gateway double. NO remote clients.
// Run with node --experimental-strip-types. All payment IDs/keys here are explicitly fictional.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {handleAsaasCheckoutRequest} from '../../supabase/functions/asaas-checkout/handler.ts';
import {handleAsaasWebhookRequest} from '../../supabase/functions/asaas-webhook/handler.ts';

const root=path.resolve(import.meta.dirname,'../..');
const bin='D:/pgSQL/bin',port=55492;
const uid='a3100000-0000-4000-8000-000000000001';
const user={id:uid,email:'local-downgrade@example.invalid'};
const literal=v=>v===null||v===undefined?'null':typeof v==='boolean'?String(v):typeof v==='number'?(assert.ok(Number.isFinite(v)),String(v)):"'"+String(typeof v==='object'?JSON.stringify(v):v).replaceAll("'","''")+"'";
const ident=s=>{assert.match(s,/^[a-z_][a-z_0-9]*$/);return '"'+s+'"';};
export function createLocalRuntime(){
 const work=fs.mkdtempSync(path.join(os.tmpdir(),'eloozi-integrated-downgrade-')),data=path.join(work,'data');
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.toUpperCase().startsWith('PG')));
 env.PGOPTIONS='-c client_min_messages=warning -c timezone=UTC';
 const evidence=[],checks=[],gatewayCalls=[],payments=new Map();let started=false;
 const log=s=>{evidence.push(s);console.log(s);};
 function run(exe,args,input){const r=spawnSync(path.join(bin,exe+'.exe'),args,{input,encoding:'utf8',windowsHide:true,env,maxBuffer:24*1024*1024,...(exe==='pg_ctl'?{stdio:'ignore'}:{})});if(r.error||r.status!==0)throw Error(`${exe} ${r.status}: ${r.error??''}\n${r.stdout??''}\n${r.stderr??''}`);return(r.stdout??'').trim();}
 const sql=q=>run('psql',['-X','-h','127.0.0.1','-p',String(port),'-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-At'],q);
 const json=q=>{const result=sql(q).split(/\r?\n/).findLast(s=>/^(?:\{|\[|"|null$|true$|false$|-?\d)/.test(s));return JSON.parse(result??'null');};
 const role=(r,q)=>json(`begin;set local role ${ident(r)};do $claims$begin perform set_config('request.jwt.claim.sub',${literal(r==='authenticated'?uid:'')},true);perform set_config('request.jwt.claims',${literal({role:r,sub:r==='authenticated'?uid:''})},true);end$claims$;${q};commit;`);
 async function rpc(name,args={},r='service_role'){
  try{return {data:role(r,`select to_jsonb(public.${ident(name)}(${Object.entries(args).map(([k,v])=>ident(k)+'=>'+literal(v)).join(',')}))`),error:null};}
  catch(e){return {data:null,error:{message:String(e.message)}};}
 }
 class Query{
  constructor(table){assert.ok(['restaurants','restaurant_members','platform_admins','platform_settings','subscription_invoices','restaurant_payment_methods'].includes(table));this.table=table;this.filters=[];this.columns='*';this.sort='';this.n=null;this.values=null;}
  select(cols='*'){this.columns=cols;return this;}
  eq(k,v){this.filters.push(ident(k)+'='+literal(v));return this;}
  order(k,{ascending=true}={}){this.sort=' order by '+ident(k)+(ascending?' asc':' desc');return this;}
  limit(n){assert.ok(Number.isInteger(n)&&n>0);this.n=n;return this;}
  update(v){this.values=v;return this;}
  async execute(single=false){try{
   const cols=this.columns==='*'?'*':this.columns.split(',').map(s=>ident(s.trim())).join(',');
   const where=this.filters.length?' where '+this.filters.join(' and '):'';
   const body=this.values?`update public.${ident(this.table)} set ${Object.entries(this.values).map(([k,v])=>ident(k)+'='+literal(v)).join(',')}${where} returning *`:`select ${cols} from public.${ident(this.table)}${where}${this.sort}${this.n?' limit '+this.n:''}`;
   // A fixture adapter is explicitly forbidden from marking an invoice paid.
   if(this.table==='subscription_invoices'&&this.values?.status==='paid')throw Error('Direct paid UPDATE forbidden, use real confirmation RPC');
   if(this.table==='restaurants'&&this.values&&Object.keys(this.values).some(k=>/^(subscription_|billing_cycle|max_tables|unlimited_tables)/.test(k)))throw Error('Direct contract UPDATE forbidden');
   const rows=role('service_role',`with rows as(${body})select coalesce(jsonb_agg(to_jsonb(rows)),'[]'::jsonb) from rows`);
   if(single&&rows.length>1)throw Error('multiple rows');return{data:single?(rows[0]??null):rows,error:null};
  }catch(e){return{data:null,error:{message:String(e.message)}};}}
  maybeSingle(){return this.execute(true);}single(){return this.execute(true);}then(resolve,reject){return this.execute().then(resolve,reject);}
 }
 const client={auth:{getUser:async()=>({data:{user},error:null})},from:t=>new Query(t),rpc};
 const now=()=>new Date(json('select to_jsonb(local_validation.clock_now())')).getTime();
 function ok(value,label){assert.ok(value,label);checks.push(label);log('PASS: '+label);}
 async function gatewayFetch(input,init={}){
  const u=new URL(String(input));assert.equal(u.origin,'https://sandbox.asaas.com');
  const method=init.method??'GET';gatewayCalls.push({method,path:u.pathname});
  const response=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json'}});
  if(u.pathname.endsWith('/customers')&&method==='GET')return response({data:[{id:'LOCAL_CUSTOMER_NOT_REAL'}]});
  if(u.pathname.endsWith('/payments')&&method==='POST'){
   const body=JSON.parse(init.body);const id='LOCAL_PAYMENT_'+(payments.size+1);
   const p={...body,id,status:'PENDING',deleted:false};payments.set(id,p);return response(p);
  }
  if(u.pathname.endsWith('/payments')&&method==='GET')return response({data:[...payments.values()].filter(p=>p.externalReference===u.searchParams.get('externalReference'))});
  const match=u.pathname.match(/\/payments\/([^/]+)(\/pixQrCode)?$/);
  if(match){const p=payments.get(match[1]);if(!p)return response({error:'unknown fictional payment'},404);return response(match[2]?{payload:'ELOOZI-LOCAL-NOT-PAYABLE',expirationDate:new Date(now()+1800000).toISOString()}:p);}
  throw Error('Unexpected mock gateway request: '+method+' '+u.pathname);
 }
 const checkoutEnv={supabaseUrl:'http://127.0.0.1:5197/LOCAL-ONLY',supabaseAnonKey:'LOCAL_DUMMY_PUBLIC',supabaseServiceRoleKey:'LOCAL_DUMMY_SERVICE',asaasApiKey:'LOCAL_DUMMY_GATEWAY',asaasBaseUrl:'https://sandbox.asaas.com/api/v3',createSupabaseClient:()=>client,fetchFn:gatewayFetch,nowFn:now};
 async function checkout(body){const res=await handleAsaasCheckoutRequest(new Request('http://127.0.0.1:5197/local-checkout',{method:'POST',headers:{'authorization':'Bearer LOCAL_FIXTURE_IDENTITY','content-type':'application/json'},body:JSON.stringify(body)}),checkoutEnv);return {http:res.status,body:await res.json()};}
 async function webhook(paymentId){const res=await handleAsaasWebhookRequest(new Request('http://127.0.0.1:5197/local-webhook',{method:'POST',headers:{'asaas-access-token':'LOCAL_WEBHOOK_DUMMY','content-type':'application/json'},body:JSON.stringify({event:'PAYMENT_RECEIVED',payment:{id:paymentId}})}),{...checkoutEnv,asaasWebhookToken:'LOCAL_WEBHOOK_DUMMY'});return{http:res.status,body:await res.json()};}
 const receive=iid=>{const p=[...payments.values()].find(p=>p.externalReference===iid);assert.ok(p);p.status='RECEIVED';return p.id;};
 const must=async(name,args,roleName='authenticated')=>{const res=await rpc(name,args,roleName);if(res.error)throw Error(res.error.message);return res.data;};
 function snapshot(rid){return json(`select jsonb_build_object('restaurant',to_jsonb(r),'tables',(select jsonb_agg(to_jsonb(t) order by id) from public.restaurant_tables t where t.restaurant_id=r.id),'effective',subscription_quote_private.effective_subscription(r.id),'cycles',(select coalesce(jsonb_agg(to_jsonb(c) order by starts_at),'[]'::jsonb) from subscription_quote_private.cycles c where c.restaurant_id=r.id),'invoices',(select jsonb_agg(to_jsonb(i) order by created_at,id) from public.subscription_invoices i where i.restaurant_id=r.id),'allocations',(select count(*) from subscription_quote_private.cycle_payments cp join subscription_quote_private.cycles c on c.id=cp.cycle_id where c.restaurant_id=r.id),'receipts',(select count(*) from subscription_quote_private.plan_change_receipts rec join subscription_quote_private.plan_change_invoices link using(invoice_id) join subscription_quote_private.plan_changes pc on pc.id=link.change_id where pc.restaurant_id=r.id)) from public.restaurants r where r.id=${literal(rid)}`);}
 function setClock(expression){assert.match(expression,/^(?:\(select|local_validation\.clock_now\(\))/);sql(`update local_validation.clock set moment=${expression};`);}
 async function start(){
  log(run('postgres',['--version'])+'; disposable '+work);
  run('initdb',['-D',data,'-U','postgres','-A','trust','--encoding=UTF8','--no-locale']);
  fs.appendFileSync(path.join(data,'postgresql.conf'),`\nlisten_addresses='127.0.0.1'\nport=${port}\nmax_connections=12\n`);
  run('pg_ctl',['-D',data,'-l',path.join(work,'server.log'),'-w','start']);started=true;
  sql(fs.readFileSync(path.join(root,'supabase/tests/etapa3_bootstrap.sql'),'utf8'));
  for(const f of fs.readdirSync(path.join(root,'supabase/migrations')).filter(f=>f.endsWith('.sql')&&f<='20261030130000_scheduled_subscription_downgrades.sql').sort()){
   if(f==='20261008141500_create_table_tab_consumption.sql')sql(fs.readFileSync(path.join(root,'supabase/seeds/demo_restaurants.sql'),'utf8'));
   sql(fs.readFileSync(path.join(root,'supabase/migrations',f),'utf8'));
  }
  sql(fs.readFileSync(path.join(root,'scripts/fixtures/downgrade-local-clock.sql'),'utf8'));
  sql(`insert into auth.users(id,email)values(${literal(uid)},${literal(user.email)});`);
 }
 async function seed(cycle='monthly'){
  const slug='local-integrated-'+cycle;
  await must('register_trial_restaurant_onboarding',{p_restaurant_name:'Validação LOCAL '+cycle,p_slug:slug,p_phone:'5511000000000'});
  const rid=json(`select to_jsonb(id) from public.restaurants where slug=${literal(slug)}`);
  const first=await checkout({action:'checkout',restaurantId:rid,targetPlan:'premium',billingCycle:cycle,paymentMethod:'pix',payerInfo:{cpfCnpj:'00000000000'}});
  ok(first.http===200&&first.body.status==='pending','first Premium '+cycle+' invoice emitted via existing handler');
  receive(first.body.invoice_id);
  const paid=await checkout({action:'verify_payment',invoiceId:first.body.invoice_id,restaurantId:rid});
  ok(paid.http===200&&paid.body.status==='paid','first Premium '+cycle+' payment confirmed via existing handler and SQL');
  for(let number=4;number<=8;number++)await must('save_restaurant_table',{p_slug:slug,p_id:randomUUID(),p_revision:0,p_number:number,p_label:'Mesa '+number,p_active:true});
  return {rid,cycle,slug};
 }
 function save(name,extra={}){fs.writeFileSync(path.join(root,'docs/downgrade-integrated-'+name+'.json'),JSON.stringify(extra,null,2));}
 function close(){if(started){run('pg_ctl',['-D',data,'-w','stop','-m','fast']);started=false;log('Disposable cluster stopped.');}}
 function writeEvidence(extra={}){const browser=extra.mode==='browser';save(browser?'browser-results':'results',{checks,gatewayCalls,allGatewayRequestsMocked:true,directContractDateUpdates:0,...extra});fs.writeFileSync(path.join(root,browser?'docs/downgrade-integrated-browser-runtime.log':'docs/downgrade-integrated-local.log'),evidence.join('\n')+'\n');}
 return {start,close,sql,json,rpc,must,checkout,webhook,receive,seed,snapshot,setClock,ok,save,writeEvidence,log,checks,gatewayCalls,payments,uid,literal};
}

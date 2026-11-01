// Real AdminLayout, sidebar, topbar and subscription page; simulated identity/transports only.
// No .env, network client or backend connection is loaded. QR fixture is not payable.
import fs from 'node:fs';
import path from 'node:path';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
const root=path.resolve(import.meta.dirname,'..'),dir=path.join(root,'.tools/scheduled-downgrade');
fs.mkdirSync(dir,{recursive:true});
fs.copyFileSync(path.join(root,'scripts/fixtures/subscription-layout-mock.tsx'),path.join(dir,'mock.tsx'));
fs.appendFileSync(path.join(dir,'mock.tsx'),"\nif(new URLSearchParams(location.search).get('restaurant')==='second'){db.r.id='fixture-second';db.r.name='Restaurante de demonstração com nome longo';}\n");
fs.appendFileSync(path.join(dir,'mock.tsx'),`
// In-memory simulated SERVER response for UI only. SQL persistence is verified separately.
const scheduleParams=new URLSearchParams(location.search);
const due=scheduleParams.get('due')==='yes';const boundary=due?new Date(Date.now()-3600000).toISOString():ends.monthly;
let scheduleState={available:true,reason:null,current_plan:db.r.effectiveSubscription.contracted_plan??null,billing_cycle:'monthly',not_before:boundary,scheduled_change:scheduleParams.get('change')?{id:'SIMULATED-SCHEDULE',from_plan:'premium',target_plan:'basic',billing_cycle:'monthly',not_before:boundary,state:scheduleParams.get('change')}:null,can_renew:due};
const beforeScheduledRpc=supabase.rpc;supabase.rpc=async(fn,args)=>{
 if(fn==='get_scheduled_subscription_change')return {data:structuredClone(scheduleState),error:null};
 if(fn==='schedule_subscription_downgrade'){if(scheduleParams.get('failure')==='yes')return {data:null,error:{message:'Falha simulada ao salvar. Nenhum agendamento foi confirmado.'}};scheduleState.scheduled_change={id:'SIMULATED-SCHEDULE',from_plan:scheduleState.current_plan,target_plan:args.p_target_plan,billing_cycle:'monthly',not_before:boundary,state:'scheduled'};return {data:structuredClone(scheduleState),error:null};}
 if(fn==='cancel_subscription_downgrade'){scheduleState.scheduled_change=null;return {data:structuredClone(scheduleState),error:null};}
 return beforeScheduledRpc(fn,args);
};
`);
fs.writeFileSync(path.join(dir,'index.html'),'<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Eloozi — bancada local de layout (simulada)</title><div id="root"></div><script type="module" src="/.tools/scheduled-downgrade/main.tsx"></script></html>');
fs.writeFileSync(path.join(dir,'main.tsx'),`
import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter,Routes,Route,Outlet} from 'react-router';
import {AdminLayout} from '../../src/features/admin/AdminLayout';import {SubscriptionBillingPage} from '../../src/features/admin/SubscriptionBillingPage';
import {ThemeProvider} from '../../src/features/theme/ThemeContext';import {Fixture,db} from './mock';import '../../src/styles.css';
import {installLayoutMetrics} from '../../scripts/fixtures/subscription-layout-metrics';
const params=new URLSearchParams(location.search);localStorage.setItem('theme',params.get('theme')==='dark'?'dark':'light');
// CSS zoom is an explicit additional layout stress test, NOT native browser zoom.
document.documentElement.style.zoom=params.get('zoom')==='125'?'1.25':'1';
createRoot(document.getElementById('root')).render(<ThemeProvider><Fixture.Provider value={db.r}><MemoryRouter initialEntries={['/fixture/admin/assinatura']}><Routes><Route element={<Outlet context={{role:'admin',active:true,restaurantId:db.r.id}}/>}><Route path="/fixture/admin" element={<AdminLayout/>}><Route path="assinatura" element={<SubscriptionBillingPage/>}/></Route></Route></Routes></MemoryRouter></Fixture.Provider></ThemeProvider>);
installLayoutMetrics();
`);
const mock=path.join(dir,'mock.tsx');
const server=await createServer({root,configFile:false,envFile:false,plugins:[react(),tailwind()],resolve:{alias:[{find:/^.*\/RestaurantProvider$/,replacement:mock},{find:/^.*\/lib\/supabase$/,replacement:mock},{find:/^.*\/alerts\/alertService$/,replacement:mock}]},optimizeDeps:{entries:[path.join(dir,'index.html')]},server:{host:'127.0.0.1',port:5196,strictPort:true,watch:{ignored:['**/docs/**','**/artifacts/**']}}});
await server.listen();console.log('ISOLATED REAL ADMIN SHELL: http://127.0.0.1:5196/.tools/scheduled-downgrade/index.html');

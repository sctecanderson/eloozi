// Real AdminLayout, sidebar, topbar and subscription page; simulated identity/transports only.
// No .env, network client or backend connection is loaded. QR fixture is not payable.
import fs from 'node:fs';
import path from 'node:path';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
const root=path.resolve(import.meta.dirname,'..'),dir=path.join(root,'.tools/banner-position');
fs.mkdirSync(dir,{recursive:true});
fs.copyFileSync(path.join(root,'scripts/fixtures/subscription-layout-mock.tsx'),path.join(dir,'mock.tsx'));
fs.appendFileSync(path.join(dir,'mock.tsx'),"\nif(new URLSearchParams(location.search).get('restaurant')==='second'){db.r.id='fixture-second';db.r.name='Restaurante de demonstração com nome longo';}\n");
fs.writeFileSync(path.join(dir,'index.html'),'<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Eloozi — bancada local de layout (simulada)</title><div id="root"></div><script type="module" src="/.tools/banner-position/main.tsx"></script></html>');
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
const server=await createServer({root,configFile:false,envFile:false,plugins:[react(),tailwind()],resolve:{alias:[{find:/^.*\/RestaurantProvider$/,replacement:mock},{find:/^.*\/lib\/supabase$/,replacement:mock},{find:/^.*\/alerts\/alertService$/,replacement:mock}]},optimizeDeps:{entries:[path.join(dir,'index.html')]},server:{host:'127.0.0.1',port:5194,strictPort:true,watch:{ignored:['**/docs/**','**/artifacts/**']}}});
await server.listen();console.log('ISOLATED REAL ADMIN SHELL: http://127.0.0.1:5194/.tools/banner-position/index.html');

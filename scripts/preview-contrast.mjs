// Isolated UI bench: real Mais page + navigation extracted verbatim from App.
// No app entry, env files, authentication bypass or Supabase/network connection.
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
const root = path.resolve(import.meta.dirname, '..');
const fixture = path.join(root, '.tools/contrast-preview');
fs.mkdirSync(fixture, { recursive: true });
const app = fs.readFileSync(path.join(root, 'src/app/App.tsx'), 'utf8');
const start = app.indexOf('function StaffBottomNav(');
const end = app.indexOf('\n  if (isEquipe)', start);
if (start < 0 || end < 0) throw new Error('Navigation source not found');
fs.writeFileSync(path.join(fixture, 'Nav.tsx'), `import { Link, useLocation } from 'react-router';
import type {CSSProperties} from 'react';
import {brandForeground} from '../../src/features/theme/brandContrast';
function useRestaurant(){return {restaurant:{theme:{primary:'#610000'}}};}
function useStaffChamados(){return {totalPendingCount:2};}
export ${app.slice(start, end)}`);
fs.writeFileSync(path.join(fixture, 'mock.ts'), `
const member={display_name:'Equipe de demonstração',active:true};
const query={select(){return this},eq(){return this},maybeSingle:async()=>({data:member,error:null})};
export const supabase={auth:{getUser:async()=>({data:{user:{email:'demo@example.test',user_metadata:{full_name:'Equipe de demonstração'},identities:[{provider:'email'}]}}})},from:()=>query};
export const inspectUserPasswordCapabilities=()=>({hasEmailIdentity:true,hasGoogleIdentity:false});
export const signOutStaff=async()=>{throw new Error('Bancada visual: sem autenticação real')};
export const updateAuthenticatedUserPassword=signOutStaff;
export const updateStaffDisplayName=signOutStaff;
`);
fs.writeFileSync(path.join(fixture, 'index.html'), `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ELOOZI — bancada local de contraste</title><div id="root"></div><script type="module" src="/ .tools/contrast-preview/main.tsx"></script></html>`.replace('/ .tools','/.tools'));
fs.writeFileSync(path.join(fixture, 'main.tsx'), `
import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
import {MemoryRouter,Routes,Route,Outlet,Link} from 'react-router';
import {StaffMaisPage} from '../../src/features/service/StaffMaisPage';
import {ThemeProvider,useTheme} from '../../src/features/theme/ThemeContext';
import {StaffBottomNav} from './Nav';
import '../../${process.argv.includes('--before') ? 'docs/contrast-before.css' : 'src/styles.css'}';
function Bench(){ const {theme,toggleTheme}=useTheme(); const [menu,setMenu]=useState(false);
 return <div data-theme={theme} className="staff-workspace min-h-screen bg-[#FAF6F2] dark:bg-zinc-950" style={{'--brand':'#610000','--page':theme==='dark'?'#14110f':'#FAF6F2','--ink':theme==='dark'?'#f7f3ee':'#2B1D17'}}>
 <div className="mx-auto max-w-lg p-4 pb-28">
 <header><h1 className="text-xl font-bold text-zinc-900 dark:text-white">ELOOZI — equipe</h1><p className="text-xs text-zinc-600 dark:text-zinc-300">Bancada local com dados fictícios</p>
 <button className="btn btn-secondary rounded-xl p-2" onClick={toggleTheme}>Trocar tema</button>
 <button className="btn btn-ghost rounded-xl p-2" aria-expanded={menu} onClick={()=>setMenu(!menu)}>Menu de revisão</button>
 {menu&&<div role="menu" className="rounded-xl border p-3 bg-white dark:bg-zinc-900 dark:text-zinc-100"><Link role="menuitem" to="/demo/equipe?mesa=01">Comanda de uma mesa</Link><a role="menuitem" href="#controles" className="text-zinc-700 dark:text-zinc-200">Filtros e controles</a><p>Selecionado: <strong>Equipe ✓</strong></p></div>}
 </header><Outlet context={{memberId:'demo',displayName:'Equipe',role:'waiter'}}/>
 <section id="controles" className="mt-6 rounded-xl border p-4 bg-white dark:bg-zinc-900"><h2 className="text-zinc-900 dark:text-white">Controles compartilhados</h2>
 <label>Filtro<select aria-label="Filtro de mesas"><option>Todas as mesas</option><option>Ocupadas</option></select></label>
 <p role="alert" className="text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950 rounded-lg p-2">Erro: selecione uma mesa.</p>
 <button className="btn btn-secondary" disabled>Indisponível</button></section>
 </div><StaffBottomNav restaurantSlug="demo"/></div>}
createRoot(document.getElementById('root')!).render(<ThemeProvider><MemoryRouter initialEntries={['/demo/equipe/mais']}><Routes><Route path="/demo/equipe" element={<Bench/>}><Route index element={<StaffMaisPage/>}/><Route path="*" element={<StaffMaisPage/>}/></Route></Routes></MemoryRouter></ThemeProvider>);
`);
const server = await createServer({ root, configFile: false, envFile: false,
 optimizeDeps:{entries:[path.join(fixture,'index.html')]},
 plugins:[react(),tailwind()], resolve:{alias:[
 {find:/^.*\/supabase$/,replacement:path.join(fixture,'mock.ts')},
 {find:/^.*\/staffAuth$/,replacement:path.join(fixture,'mock.ts')},
 ]}, server:{host:'127.0.0.1',port:5188,strictPort:true},
});
await server.listen();
console.log('LOCAL UI BENCH: http://127.0.0.1:5188/.tools/contrast-preview/index.html');
console.log('Mode:',process.argv.includes('--before')?'before CSS':'current CSS');

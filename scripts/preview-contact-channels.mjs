// Isolated browser bench. Real IdentityPage/HomePage, fictitious local HTTP transport.
// Persistence here is only a UI test double. The real RPC is tested separately in PostgreSQL.
import fs from 'node:fs';
import path from 'node:path';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
const root=path.resolve(import.meta.dirname,'..'), dir=path.join(root,'.tools/contact-preview');
fs.mkdirSync(dir,{recursive:true});
let saved={id:'b6000000-0000-4000-8000-000000000001',slug:'demo',name:'Restaurante de demonstração',subtitle:'Dados fictícios',description:'',address:'',phone:'5511999999999',openingHours:'',revision:1,logo:null,cover:null,theme:{primary:'#610000',background:'#FFFFFF',text:'#181818'},brandPrimaryColor:'#610000',googleReviewUrl:null,menuTheme:'classic',contactChannels:{instagram:{value:'@elozi',enabled:true},whatsapp:{value:'5511999999999',enabled:true},facebook:{value:'https://example.test',enabled:true}}};
fs.writeFileSync(path.join(dir,'mock.tsx'),`
import {useState} from 'react';
let restaurant=await (await fetch('/__contacts')).json();
export function useRestaurant(){const [,render]=useState(0);return{restaurant,reload:async()=>{restaurant=await (await fetch('/__contacts')).json();render(n=>n+1)}};}
export async function saveIdentity(r,logo,cover){const response=await fetch('/__contacts',{method:'POST',body:JSON.stringify({...r,logo,cover})});if(!response.ok)throw Error('Falha simulada');return response.json();}
export const uploadIdentity=async x=>x;
export const contrast=()=>21;
export const getAdminCatalog=async()=>({products:[],categories:[]});
export const usePublicMenu=()=>({menu:{restaurantId:restaurant.id,products:[],categories:[]},getProductLikesCount:()=>0});
export const PublicMenuStatus=()=>null;
export const ServiceActionPopup=()=>null;
export const supabase={auth:{getUser:async()=>({data:{user:null}})}};
`);
fs.writeFileSync(path.join(dir,'index.html'),'<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ELOOZI — bancada de canais</title><div id="root"></div><script type="module" src="/.tools/contact-preview/main.tsx"></script></html>');
fs.writeFileSync(path.join(dir,'main.tsx'),`
import React from 'react';import {createRoot} from 'react-dom/client';
import {HashRouter,Routes,Route,Link} from 'react-router';
import {IdentityPage} from '../../src/features/admin/IdentityPage';
import {HomePage} from '../../src/features/menu/HomePage';
import {ThemeProvider,useTheme} from '../../src/features/theme/ThemeContext';
import '../../src/styles.css';
function Bench(){const {toggleTheme}=useTheme();return <div className="admin-layout min-h-screen bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100" style={{'--brand':'#610000','--page':'#FAF6F2','--ink':'#181818'}}><header className="p-4">Bancada isolada · transporte simulado · dados fictícios <button onClick={toggleTheme}>Trocar tema</button> · <Link to="/demo/admin">Admin</Link> · <Link to="/demo">Cardápio</Link></header><Routes><Route path="/:restaurantSlug/admin" element={<div className="admin-app" style={{display:'block','--brand':'#610000'}}><IdentityPage/></div>}/><Route path="/:restaurantSlug" element={<HomePage/>}/></Routes></div>}
createRoot(document.getElementById('root')!).render(<ThemeProvider><HashRouter><Bench/></HashRouter></ThemeProvider>);
`);
const mock=path.join(dir,'mock.tsx');
const server=await createServer({root,configFile:false,envFile:false,plugins:[react(),tailwind(),{
 name:'local-fictitious-contact-transport',configureServer(s){s.middlewares.use('/__contacts',(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.method==='GET')return res.end(JSON.stringify(saved));
  if(req.method!=='POST'){res.statusCode=405;return res.end('{}');}
  let body='';req.on('data',chunk=>{body+=chunk;});req.on('end',()=>{try{saved={...JSON.parse(body),revision:saved.revision+1};res.end(JSON.stringify(saved));}catch{res.statusCode=400;res.end('{}');}});
 });}
}],resolve:{alias:[...['RestaurantProvider','restaurantAdmin','adminCatalog','PublicMenuProvider','ServiceActionPopup','supabase'].map(name=>({find:new RegExp('^.*\\/'+name+'$'),replacement:mock}))]},optimizeDeps:{entries:[path.join(dir,'index.html')]},server:{host:'127.0.0.1',port:5189,strictPort:true}});
await server.listen();console.log('LOCAL CONTACT UI BENCH: http://127.0.0.1:5189/.tools/contact-preview/index.html');

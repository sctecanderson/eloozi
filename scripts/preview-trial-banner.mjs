// Isolated visual bench: real banner, fictitious server snapshot, no env/auth/network backend.
import fs from 'node:fs';import path from 'node:path';import {createServer} from 'vite';
import react from '@vitejs/plugin-react';import tailwind from '@tailwindcss/vite';
const root=path.resolve(import.meta.dirname,'..'),dir=path.join(root,'.tools/trial-banner-preview');fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(dir,'mock.tsx'),`import {createContext,useContext} from 'react';export const Fixture=createContext(null);export const useRestaurant=()=>({restaurant:useContext(Fixture)});`);
fs.writeFileSync(path.join(dir,'index.html'),'<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ELOOZI — tarja de trial local</title><div id="root"></div><script type="module" src="/.tools/trial-banner-preview/main.tsx"></script></html>');
fs.writeFileSync(path.join(dir,'main.tsx'),`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter} from 'react-router';
import {TrialBanner} from '../../src/features/billing/TrialBanner';import {ThemeProvider,useTheme} from '../../src/features/theme/ThemeContext';import {Fixture} from './mock';import '../../src/styles.css';
const end=new Date(Date.now()+120*3600000).toISOString();
function Bench(){const [plan,setPlan]=useState('basic');const {toggleTheme}=useTheme();return <main className="min-h-screen bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 p-4"><h1>Bancada visual · snapshot fictício de trial · sem backend</h1><button onClick={toggleTheme}>Trocar tema</button><div>{[['basic','Básico'],['pro','Profissional'],['premium','Premium']].map(([id,label])=><button className="m-2 border rounded-lg p-2" key={id} onClick={()=>setPlan(id)}>Contratado: {label}</button>)}</div><Fixture.Provider value={{slug:'demo',effectiveSubscription:{known_trial:true,trial_active:true,original_trial_end:end,contracted_plan:plan,paid_start:end,plan:'premium',billing_status:'active'}}}><TrialBanner/></Fixture.Provider></main>}
createRoot(document.getElementById('root')!).render(<ThemeProvider><MemoryRouter><Bench/></MemoryRouter></ThemeProvider>);
`);
const server=await createServer({root,configFile:false,envFile:false,plugins:[react(),tailwind()],resolve:{alias:[{find:/^.*\/RestaurantProvider$/,replacement:path.join(dir,'mock.tsx')}]},optimizeDeps:{entries:[path.join(dir,'index.html')]},server:{host:'127.0.0.1',port:5190,strictPort:true}});await server.listen();console.log('LOCAL TRIAL BANNER: http://127.0.0.1:5190/.tools/trial-banner-preview/index.html');

// PostgreSQL nativo descartável, loopback only. Nunca lê env local nem endereço de projeto Supabase.
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import {spawnSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..'),bin='D:/pgSQL/bin',port=55493;
const work=fs.mkdtempSync(path.join(os.tmpdir(),'eloozi-callpay-')),data=path.join(work,'data');
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.toUpperCase().startsWith('PG'))); env.PGOPTIONS='-c client_min_messages=warning -c timezone=UTC';
const conn=['-X','-h','127.0.0.1','-p',String(port),'-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1']; let started=false;
function run(exe,args,input){const r=spawnSync(path.join(bin,exe+'.exe'),args,{input,encoding:'utf8',windowsHide:true,env,maxBuffer:30*1024*1024,...(exe==='pg_ctl'?{stdio:'ignore'}:{})});if(r.error||r.status!==0)throw Error(`${exe} ${r.status}: ${r.error??''}\n${r.stdout??''}\n${r.stderr??''}`);return(r.stdout??'').trim();}
function sql(s){return run('psql',[...conn,'-At'],s)} function file(p){return sql(fs.readFileSync(path.join(root,p),'utf8'));}
try{
 console.log(run('postgres',['--version'])+'; disposable 127.0.0.1:'+port+'; '+work);
 run('initdb',['-D',data,'-U','postgres','-A','trust','--encoding=UTF8','--no-locale']);
 fs.appendFileSync(path.join(data,'postgresql.conf'),`\nlisten_addresses='127.0.0.1'\nport=${port}\nmax_connections=20\n`);
 run('pg_ctl',['-D',data,'-l',path.join(work,'postgres.log'),'-w','start']);started=true;
 file('supabase/tests/etapa3_bootstrap.sql');
 const migrations=fs.readdirSync(path.join(root,'supabase/migrations')).filter(f=>f.endsWith('.sql')).sort();
 for(const m of migrations){if(m==='20261008141500_create_table_tab_consumption.sql')file('supabase/seeds/demo_restaurants.sql');file('supabase/migrations/'+m);if(m==='20261030223205_service_call_cycles_and_group_payment.sql')console.log('PASS migration 20261030223205');}
 console.log(file('supabase/tests/service_calls_and_group_payment_test.sql'));
 console.log('PASS SQL regression suite');
}catch(e){console.error(e);process.exitCode=1;}finally{if(started){try{run('pg_ctl',['-D',data,'-m','fast','-w','stop']);console.log('PASS cluster stopped');}catch(e){console.error('STOP FAILED',e);process.exitCode=1;}}}

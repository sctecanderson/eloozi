// Restore only an exported archive into the already-contained, private local bench.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const [stateFile,metadataFile]=process.argv.slice(2);
assert.ok(stateFile && metadataFile,'state.json and backup-metadata.json required');
const state=JSON.parse(fs.readFileSync(stateFile,'utf8').replace(/^\uFEFF/,''));
const metadata=JSON.parse(fs.readFileSync(metadataFile,'utf8').replace(/^\uFEFF/,''));
const work=path.resolve(state.work),bin=path.join(work,'pgsql/bin'),data=path.join(work,'data');
assert.equal(path.resolve(stateFile),path.join(work,'state.json'));
assert.ok(work.toLowerCase().startsWith(path.join(process.env.LOCALAPPDATA,'Eloozi/PrivateRestoreBench').toLowerCase()+path.sep));
assert.equal(path.resolve(state.program),path.join(bin,'postgres.exe'));
assert.equal(metadata.project_ref,'llhujxzefujdsthpezag');
assert.equal(path.basename(metadata.backup_file_name),metadata.backup_file_name);
const dump=path.join(path.dirname(metadataFile),metadata.backup_file_name);
const digest=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
assert.equal(digest(path.join(bin,'postgres.exe')),digest('D:/pgSQL/bin/postgres.exe'),'private postgres binary integrity');
const expectedHash=process.argv.find(s=>s.startsWith('--expected-sha256='))?.split('=')[1]??'9176bd202f2ca47cde5fc90f0d04814bc37d669c7e371465a7cc47aef815c26d';
assert.match(expectedHash,/^[a-f0-9]{64}$/,'explicit expected archive SHA-256');
assert.equal(digest(dump),expectedHash);
assert.equal(digest(dump),metadata.archive_sha256);
const logs=path.join(work,'restore-review');fs.mkdirSync(logs,{recursive:true});
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.toUpperCase().startsWith('PG')));
env.PGCONNECT_TIMEOUT='5';env.PGOPTIONS='-c statement_timeout=60000 -c timezone=UTC -c lc_messages=C';
let counter=0,started=false;
const finalizeOnly=process.argv.includes('--finalize');
const evidence=finalizeOnly?JSON.parse(fs.readFileSync(path.join(logs,'result.json'),'utf8')):{started_utc:new Date().toISOString(),archive_sha256:metadata.archive_sha256,adaptations:[],stages:[]};
const logPrefix=finalizeOnly?'finalize-':'';
function save(){fs.writeFileSync(path.join(logs,'result.json'),JSON.stringify(evidence,null,2));}
function say(s){evidence.stages.push(s);save();console.log(s);}
function run(exe,args,input,allow=false){
 const tag=logPrefix+String(++counter).padStart(3,'0')+'-'+exe;
 const r=spawnSync(path.join(bin,exe+'.exe'),args,{input,encoding:'utf8',env,windowsHide:true,timeout:180000,maxBuffer:64*1024*1024,...(exe==='pg_ctl'&&args.includes('start')?{stdio:'ignore'}:{})});
 fs.writeFileSync(path.join(logs,tag+'.out'),r.stdout??'');fs.writeFileSync(path.join(logs,tag+'.err'),r.stderr??'');
 if(r.error||r.status!==0){if(!allow)throw new Error(`${tag} failed exit=${r.status}; details retained privately`);}
 return {out:(r.stdout??'').replace(/\r/g,''),err:r.stderr??'',code:r.status};
}
const conn=db=>['-X','-q','-w','-h','127.0.0.1','-p','55992','-U','postgres','-d',db,'-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-At'];
const sql=(text,db='eloozi_restore')=>run('psql',conn(db),text).out.trim();
const qi=s=>'"'+s.replaceAll('"','""')+'"';
const ps=s=>"'"+s.replaceAll("'","''")+"'";
try{
 // No firewall mutation: validate the existing rule through its complete COM signature.
 const script=`$ErrorActionPreference='Stop';$fw=New-Object -ComObject HNetCfg.FwPolicy2;$r=@($fw.Rules|Where-Object Name -eq ${ps(state.rule)});if($r.Count -ne 1 -or $r[0].ApplicationName -ne ${ps(state.program)} -or $r[0].Grouping -ne ${ps(state.group)} -or -not $r[0].Enabled -or $r[0].Direction -ne 2 -or $r[0].Action -ne 0 -or $r[0].Protocol -ne 256 -or $r[0].RemoteAddresses -ne '*'){throw 'rule mismatch'};foreach($p in @(1,2,4)){if(-not $fw.FirewallEnabled($p)){throw 'firewall disabled'}};'RULE_MATCH'`;
 const r=spawnSync('powershell.exe',['-NoProfile','-Command',script],{encoding:'utf8',windowsHide:true,timeout:20000});assert.equal(r.status,0,'existing containment rule must match');
 const previous=JSON.parse(fs.readFileSync(path.join(work,'state.json'),'utf8').replace(/^\uFEFF/,''));
 const p=previous.failure_process??previous.last_process;
 assert.ok(p && p.exit_code===1,'reviewed psql failure required');
 const denied=fs.readFileSync(p.stderr,'utf8'),loop=fs.readFileSync(p.stdout,'utf8');
 assert.match(loop,/^1\r?$/m);assert.match(denied,/connection to server at "1\.1\.1\.1", port 443 failed:[^\r\n]*\(0x0000271D\/10013\)/);
 evidence.containment='loopback passed; backend socket denied WSAEACCES 10013; individual blocking filter not identified';say('PASS archive hash and existing private containment evidence');
 if(finalizeOnly){
  assert.equal(evidence.rehearsal?.length,19,'complete local rehearsal required before finalize');
  run('pg_ctl',['-D',data,'-l',path.join(work,'server.log'),'-w','-t','25','start']);started=true;
  assert.equal(sql("select host(inet_server_addr())||':'||inet_server_port()||':'||current_database()"),'127.0.0.1:55992:eloozi_restore');
  assert.equal(sql("select count(*) from pg_extension where extname in ('dblink','pg_net','pg_cron','http','postgres_fdw')"),'0');
  assert.equal(sql('select count(*) from pg_event_trigger'),'0');
  const repo=path.resolve(import.meta.dirname,'..');
  let prepared=fs.readFileSync(path.join(repo,'supabase/tests/financial_cutover_prepare.sql'),'utf8');
  const guard="current_database() <> 'postgres'";assert.equal(prepared.split(guard).length,2);
  prepared=prepared.replace(guard,"current_database() <> 'eloozi_restore'");
  evidence.adaptations.push('synthetic cutover fixture safety guard changed only in private input: exact database eloozi_restore instead of postgres; repository fixture unchanged');
  const quarantine=fs.readFileSync(path.join(repo,'supabase/migrations/20261031120000_billing_cutover_pending_invoice_quarantine.sql'),'utf8').replace(/^begin;\s*$/m,'').replace(/^commit;\s*$/m,'');
  const assertions=fs.readFileSync(path.join(repo,'supabase/tests/financial_cutover_assert.sql'),'utf8');
  const fixture='begin;\n'+prepared+'\n'+quarantine+'\n'+assertions+'\nrollback;';
  assert.ok(!/\bdblink\b|\bnet\.http|\bhttp_post\b/.test(fixture));
  fs.writeFileSync(path.join(logs,'synthetic-fixture-private-input.sql'),fixture);
  const r=run('psql',conn('eloozi_restore'),fixture);
  assert.match(r.out,/RESULTADO_FINAL: PASS/);evidence.synthetic_cutover_fixture_pass=true;
  const after=JSON.parse(fs.readFileSync(path.join(logs,'after-update.json'),'utf8'));
  for(const [table,expected]of Object.entries(after)){
   const actual=JSON.parse(sql(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) from ${table} t`));
   assert.deepEqual(actual,expected,'fixture rollback must preserve original data: '+table);
  }
  evidence.synthetic_fixture_rolled_back=true;
  say('PASS synthetic financial cutover fixture on restored/upgraded clone; original data unchanged after rollback');
  evidence.final_success=true;save();
 }else{
 const toc=run('pg_restore',['--list',dump]).out;fs.writeFileSync(path.join(logs,'archive.toc'),toc);
 run('pg_restore',['--schema-only','--file',path.join(logs,'archive-schema.sql'),dump]);
 const schema=fs.readFileSync(path.join(logs,'archive-schema.sql'),'utf8');
 assert.ok(!/^CREATE (SERVER|FOREIGN DATA WRAPPER|LANGUAGE)/m.test(schema),'unreviewed external execution capability');
 assert.ok(!/LANGUAGE (plpython|plperl|plsh)\b/i.test(schema));
 assert.ok(!/AS '\$libdir\//.test(schema),'unreviewed explicit dynamic library');
 assert.ok(!/COPY\b[^;]*\bPROGRAM\b/i.test(schema),'unreviewed external program execution');
 const owners=[...schema.matchAll(/^ALTER .+ OWNER TO ([^;]+);/gm)].map(m=>m[1].replaceAll('"',''));
 const recipients=[...schema.matchAll(/^(?:GRANT|REVOKE|ALTER DEFAULT PRIVILEGES)[^\r\n]+ (?:TO|FROM) ([^;]+);/gm)].flatMap(m=>m[1].replace(/ WITH GRANT OPTION$/,'').split(',').map(s=>s.trim().replaceAll('"','')));
 const roles=[...new Set([...owners,...recipients,'anon','authenticated','service_role','authenticator'])].filter(s=>s!=='PUBLIC'&&s!=='postgres'&&!s.startsWith('pg_'));
 assert.ok(roles.every(s=>/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)),'unexpected role syntax');
 evidence.role_placeholders=roles;evidence.adaptations.push('global managed role definitions/passwords unavailable: NOLOGIN nonsuperuser placeholders; no service-role credentials loaded');
 const lines=toc.split('\n');const omitted=[];
 const filtered=lines.map(line=>{
  if(!/^\d+;/.test(line))return line;
  if(/\bEVENT TRIGGER\b/.test(line)||/\bEXTENSION\b.*\bsupabase_vault\b/.test(line)||/\b(?:TABLE DATA|SEQUENCE SET|ACL|COMMENT|FUNCTION|VIEW|TABLE) vault\b/.test(line)){
   omitted.push(line);return ';'+line;
  }return line;
 }).join('\n');
 evidence.omitted_toc=omitted;fs.writeFileSync(path.join(logs,'restore.toc'),filtered);
 evidence.adaptations.push('supabase_vault unavailable locally: omit extension and dependent vault entries; all event triggers omitted to avoid DDL side effects; original archive retained');
 say(`PASS preflight: ${roles.length} managed role placeholders planned; ${omitted.length} TOC entries explicitly excluded`);
 run('pg_ctl',['-D',data,'-l',path.join(work,'server.log'),'-w','-t','25','start']);started=true;
 assert.equal(sql("select host(inet_server_addr())||':'||inet_server_port()||':'||current_database()",'postgres'),'127.0.0.1:55992:postgres');
 assert.equal(sql("select count(*) from pg_extension where extname in ('pg_net','pg_cron','http','postgres_fdw')",'postgres'),'0');
 assert.equal(sql('select count(*) from pg_event_trigger','postgres'),'0');
 // This database name is owned exclusively by this runner in the guarded disposable cluster.
 if(sql("select count(*) from pg_database where datname='eloozi_restore'",'postgres')!=='0'){
  assert.ok(fs.existsSync(path.join(logs,'database-owned-by-runner')),'refuse to replace an unknown database');
  sql('drop database eloozi_restore with (force)','postgres');
 }
 for(const role of roles)if(sql(`select count(*) from pg_roles where rolname='${role}'`,'postgres')==='0')sql(`create role ${qi(role)} nologin nosuperuser nocreatedb nocreaterole noreplication`,'postgres');
 sql('create database eloozi_restore','postgres');fs.writeFileSync(path.join(logs,'database-owned-by-runner'),'eloozi_restore');
 say('START restore into guarded local database; no workers/preload/scheduler installed');
 run('pg_restore',['--host','127.0.0.1','--port','55992','--username','postgres','--dbname','eloozi_restore','--no-password','--exit-on-error','--use-list',path.join(logs,'restore.toc'),dump]);
 say('PASS pg_restore exited zero');
 evidence.table_counts=JSON.parse(sql("select json_agg(x) from (select schemaname,tablename from pg_tables where schemaname not in ('pg_catalog','information_schema') order by 1,2)x"));
 for(const t of evidence.table_counts)t.rows=Number(sql(`select count(*) from ${qi(t.schemaname)}.${qi(t.tablename)}`));
 save();
 say('PASS table inventory and row counts collected privately');
 // Compare archive COPY payloads with restored COPY output, never publishing either.
 run('pg_restore',['--data-only','--file',path.join(logs,'archive-data.sql'),dump]);
 const dataLines=fs.readFileSync(path.join(logs,'archive-data.sql'),'utf8').replace(/\r/g,'').split('\n');
 const copyTables=[];let copy=null;
 for(const line of dataLines){
  if(!copy){const m=line.match(/^COPY (.+) \((.+)\) FROM stdin;$/);if(m)copy={table:m[1],columns:m[2],rows:[]};}
  else if(line==='\\.'){copyTables.push(copy);copy=null;}else copy.rows.push(line);
 }
 const rowHash=rows=>crypto.createHash('sha256').update([...rows].sort().join('\n')).digest('hex');
 evidence.data_comparison=[];
 for(const table of copyTables){
  if(table.table.startsWith('vault.')){evidence.data_comparison.push({table:table.table,archive_rows:table.rows.length,status:'not-restored-vault'});continue;}
  const text=run('psql',conn('eloozi_restore'),`COPY ${table.table} (${table.columns}) TO STDOUT;`).out;
  const rows=text===''?[]:text.replace(/\n$/,'').split('\n');
  const match=table.rows.length===rows.length && rowHash(table.rows)===rowHash(rows);
  evidence.data_comparison.push({table:table.table,rows:rows.length,match});save();
  assert.ok(match,'archive/restored COPY mismatch: '+table.table);
 }
 say(`PASS archive/restored COPY row counts and sorted hashes: ${evidence.data_comparison.filter(t=>t.match).length} tables`);
 // Same pg_dump version permits strict object-definition comparison by named dump block.
 run('pg_dump',['--host','127.0.0.1','--port','55992','--username','postgres','--dbname','eloozi_restore','--no-password','--schema-only','--file',path.join(logs,'restored-schema.sql')]);
 function blocks(source){
  source=source.replace(/\r/g,'').replace(/^\\(?:un)?restrict .*$/gm,'');
  const matches=[...source.matchAll(/^-- Name: (.*); Type: (.*); Schema: (.*); Owner: (.*)$/gm)];const result=new Map();
  for(let i=0;i<matches.length;i++){
   const m=matches[i],body=source.slice(m.index+m[0].length,matches[i+1]?.index??source.length).replace(/^--.*$/gm,'').trim();
   result.set(`${m[2]}|${m[3]}|${m[1]}`,body);
  }return result;
 }
 const originalBlocks=blocks(schema),restoredBlocks=blocks(fs.readFileSync(path.join(logs,'restored-schema.sql'),'utf8'));
 evidence.definition_comparison=[];
 for(const [key,body]of originalBlocks){
  if(key.startsWith('EVENT TRIGGER|')||key.includes('|vault|')||key.includes('EXTENSION supabase_vault')||key==='EXTENSION|-|supabase_vault')continue;
  const actual=restoredBlocks.get(key);const equal=actual===body;
  evidence.definition_comparison.push({object:key,match:equal,present:actual!==undefined});
 }
 const diffs=evidence.definition_comparison.filter(t=>!t.match);save();
 say(`DEFINITION_COMPARE ${evidence.definition_comparison.length-diffs.length} equal; ${diffs.length} require classification`);
 const checkTables=['platform_comment_restricted_terms','product_comments','restaurant_comment_restricted_terms','restaurants'];
 for(const table of checkTables){
  const key='TABLE|public|'+table;if(!diffs.some(d=>d.object===key))continue;
  const body=originalBlocks.get(key);const ddl=body.match(/^CREATE TABLE public\.\w+ \([\s\S]*?\n\);/)[0].replace('CREATE TABLE public.'+table,'CREATE TABLE restore_ddl_compare.'+table);
  const proof=sql(`begin;create schema restore_ddl_compare;${ddl}
select (select jsonb_object_agg(conname,conbin::text) from pg_constraint where conrelid='public.${table}'::regclass and contype='c') is not distinct from (select jsonb_object_agg(conname,conbin::text) from pg_constraint where conrelid='restore_ddl_compare.${table}'::regclass and contype='c');rollback;`);
  assert.equal(proof,'t','CHECK parse trees must agree: '+table);
  const a=body.split('\n'),b=restoredBlocks.get(key).split('\n');
  assert.equal(a.length,b.length);
  for(let i=0;i<a.length;i++)if(a[i]!==b[i])assert.ok(a[i].includes(' CHECK (')&&b[i].includes(' CHECK ('),'only CHECK formatting may differ');
  diffs.find(d=>d.object===key).classification='equal CHECK parse trees; server flattened associative AND parentheses';
 }
 const orderedPolicies=['POLICY|public|platform_settings platform_settings_read','POLICY|public|restaurant_tables restaurant_tables_read_public','POLICY|public|restaurants restaurants_read_active','POLICY|storage|objects elozi_backups_no_direct_client_access'];
 for(const key of orderedPolicies){const d=diffs.find(d=>d.object===key);if(!d)continue;
  const norm=s=>s.replace('TO authenticated, anon','TO anon, authenticated');
  assert.equal(norm(originalBlocks.get(key)),norm(restoredBlocks.get(key)));d.classification='equivalent role set; OID-dependent role ordering';
 }
 const builtIn=diffs.find(d=>d.object==='ACL|pg_catalog|FUNCTION pg_reload_conf()');
 if(builtIn){assert.equal(restoredBlocks.get(builtIn.object).replace('REVOKE ALL ON FUNCTION pg_catalog.pg_reload_conf() FROM postgres;\n',''),originalBlocks.get(builtIn.object));builtIn.classification='local built-in owner postgres differs from managed server; extra explicit REVOKE in regenerated dump; not global-role equivalence';evidence.adaptations.push(builtIn.classification);}
 assert.ok(diffs.every(d=>d.classification),'unclassified restored object differences');save();
 const sequenceProof=[];
 for(const m of fs.readFileSync(path.join(logs,'archive-data.sql'),'utf8').matchAll(/SELECT pg_catalog\.setval\('([^']+)', (\d+), (true|false)\);/g)){
  assert.equal(sql(`select last_value::text||':'||is_called::text from ${m[1]}`),m[2]+':'+m[3]);sequenceProof.push(m[1]);
 }evidence.sequences_compared=sequenceProof;save();
 say('PASS restored definitions classified; CHECK parse trees, policy role sets, ACL differences and sequences verified');
 if(process.argv.includes('--restore-only')){
  evidence.final_success=true;save();say('PASS fresh archive restore-only verification; prior migration tests not repeated');
 }else{
 const snapshot=()=>Object.fromEntries(evidence.table_counts.filter(t=>t.schemaname==='public'||t.schemaname==='supabase_migrations').map(t=>[t.schemaname+'.'+t.tablename,JSON.parse(sql(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) from ${qi(t.schemaname)}.${qi(t.tablename)} t`))]));
 const before=snapshot();fs.writeFileSync(path.join(logs,'before-update.json'),JSON.stringify(before));
 const versions=JSON.parse(sql("select json_agg(version order by version) from supabase_migrations.schema_migrations"));evidence.restored_history_versions=versions;
 const migrations=[
 '20261017000000_product_badge_text.sql','20261024140000_restaurant_dashboard_media.sql',
 '20261026160000_batch_cancel_table_tab_items.sql','20261026190000_atomic_transfer_table_tab_items.sql',
 '20261026233815_checkout_and_subscription_security_hardening.sql','20261027000000_enforce_strict_trial_rules.sql',
 '20261027210000_create_staff_profiles.sql','20261028183120_fix_get_restaurant_billing_summary_invoices_columns.sql',
 '20261028223000_commercial_catalog_modules_and_active_tables_quota.sql','20261029000754_subscription_transition_quotes.sql',
 '20261029002852_basic_manual_delivery.sql','20261029010637_restaurant_contact_channels.sql',
 '20261029024000_contract_module_access.sql','20261029143000_premium_trial_and_prepaid_cycle.sql',
 '20261029180000_trial_prepaid_upgrades.sql','20261030130000_scheduled_subscription_downgrades.sql',
 '20261030223205_service_call_cycles_and_group_payment.sql','20261031015051_get_visit_tab_consumptions.sql',
 '20261031120000_billing_cutover_pending_invoice_quarantine.sql'];
 const repo=path.resolve(import.meta.dirname,'..');evidence.rehearsal=[];
 const allowedSettings=['basic_price_cents','basic_max_tables','pro_price_cents','pro_max_tables','premium_price_cents','premium_max_tables','updated_at'];
 function assertOriginalRows(after){
  const summary=[];
  for(const [table,rows]of Object.entries(before)){
   const current=after[table];assert.equal(current.length,rows.length,'original row count changed: '+table);
   const byId=new Map(current.map(r=>[JSON.stringify(r.id??r.version??r),r]));let changed=[];
   for(const old of rows){const r=byId.get(JSON.stringify(old.id??old.version??old));assert.ok(r,'original row missing: '+table);
    for(const key of Object.keys(old))if(JSON.stringify(r[key])!==JSON.stringify(old[key])){
     if(table==='public.platform_settings'&&allowedSettings.includes(key))changed.push(key);else throw new Error('Existing field changed: '+table+'.'+key);
    }
   }summary.push({table,rows:rows.length,original_fields_preserved:!changed.length,allowed_changed_fields:[...new Set(changed)]});
  }return summary;
 }
 assert.equal(sql("select count(*) from pg_policies where schemaname='public' and tablename='reservations' and (qual='true' or with_check='true')"),'0');
 for(const migration of migrations){
  assert.ok(!versions.includes(migration.slice(0,14)),'refuse to reapply recorded migration');
  const file=path.join(repo,'supabase/migrations',migration);const source=fs.readFileSync(file,'utf8');
  assert.ok(!/^\s*create\s+extension/im.test(source),'migration extension requires review');
  say('REHEARSE_LOCAL '+migration);
  sql(source);
  const current=snapshot();const rowChecks=assertOriginalRows(current);
  evidence.rehearsal.push({migration,sha256:digest(file),row_checks:rowChecks});save();
 }
 const after=snapshot();fs.writeFileSync(path.join(logs,'after-update.json'),JSON.stringify(after));
 assert.equal(sql("select count(*) from public.restaurants where contract_rights_model<>'legacy'"),'0');
 assert.equal(sql('select count(*) from subscription_quote_private.trial_terms'),'0');
 assert.equal(sql('select count(*) from subscription_quote_private.cycles'),'0');
 assert.equal(sql("select count(*) from pg_event_trigger"),'0');
 assert.equal(sql("select count(*) from pg_extension where extname in ('pg_net','pg_cron','http','postgres_fdw')"),'0');
 evidence.existing_contracts_preserved=true;evidence.no_historical_trial_cycle_reconstruction=true;save();
 say('PASS individual migration rehearsal and preservation of all original fields except approved catalog settings');
evidence.final_success=true;save();
 }
 }
}catch(error){evidence.error=error.message;save();console.log('FAIL verification; command diagnostics and assertion details retained only in private result.json');process.exitCode=1;}
finally{
 if(started && evidence.final_success && !process.exitCode){
  try{sql('drop database eloozi_restore with (force)','postgres');evidence.restored_database_removed=true;save();say('PASS restored database removed after completed verification');}
  catch(error){evidence.cleanup_error=error.message;save();console.log('FAIL restored database cleanup; see private logs');process.exitCode=1;}
 }
 if(started||fs.existsSync(path.join(data,'postmaster.pid'))){
  const stop=run('pg_ctl',['-D',data,'-w','-t','25','stop','-m','fast'],undefined,true);
  evidence.cluster_stopped=stop.code===0;save();console.log('Cluster stop exit='+stop.code);if(stop.code!==0)process.exitCode=1;
 }
 evidence.finished_utc=new Date().toISOString();save();assert.equal(digest(dump),metadata.archive_sha256,'original archive must remain unchanged');
}

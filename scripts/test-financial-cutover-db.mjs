// Local-only billing cutover rehearsal. It never reads .env or connects to a hosted database.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const bin = 'D:/pgSQL/bin';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'eloozi-financial-cutover-'));
const data = path.join(work, 'data');
const port = 55517;
const conn = ['-X','-h','127.0.0.1','-p',String(port),'-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'];
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith('PG')));
env.PGOPTIONS = '-c client_min_messages=warning -c timezone=UTC';
const evidence = [];
const log = (line) => { evidence.push(line); console.log(line); };
const run = (exe,args,input) => {
  const result = spawnSync(path.join(bin,exe+'.exe'),args,{input,encoding:'utf8',windowsHide:true,env,maxBuffer:32*1024*1024,timeout:120000,...(exe === 'pg_ctl' ? {stdio:'ignore'} : {})});
  if (result.error || result.status !== 0) throw new Error(`${exe} exit=${result.status}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  return (result.stdout ?? '').trim();
};
const sql = (source) => run('psql',[...conn,'-At'],source).replace(/\r/g,'');
const apply = (file) => {
  log(`APPLY_LOCAL_ONLY ${file}`);
  log(sql(fs.readFileSync(path.join(root,file),'utf8')));
};
let started = false;
let passed = false;
try {
  assert.ok(path.resolve(work).startsWith(path.resolve(os.tmpdir()) + path.sep), 'temporary cluster must be inside OS temp directory');
  assert.match(run('postgres',['--version']),/PostgreSQL\) 17\./,'expected installed PostgreSQL 17');
  log(`PostgreSQL 17 disposable cluster loopback 127.0.0.1:${port}; no .env, remote URL or credentials loaded.`);
  run('initdb',['-D',data,'-U','postgres','-A','trust','--encoding=UTF8','--no-locale']);
  fs.appendFileSync(path.join(data,'postgresql.conf'),`\nlisten_addresses = '127.0.0.1'\nport = ${port}\nmax_connections = 16\n`);
  run('pg_ctl',['-D',data,'-l',path.join(work,'postgres.log'),'-w','start']);
  started = true;
  assert.equal(sql("select (inet_server_addr() <<= '127.0.0.0/8'::inet)::text || ':' || inet_server_port()::text || ':' || current_database()"),'true:55517:postgres','connection guard confirms loopback disposable cluster');

  apply('supabase/tests/etapa3_bootstrap.sql');
  const migrationDir = path.join(root,'supabase/migrations');
  const migrations = fs.readdirSync(migrationDir).filter(f => f.endsWith('.sql')).sort();
  let sawMainBaseline = false;
  let sawSecureReservations = false;
  let skippedPermissiveReservations = false;
  for (const name of migrations) {
    if (name === '20261024164500_create_reservations_table.sql') {
      skippedPermissiveReservations = true;
      log('SKIP_LOCAL_ONLY historical permissive reservations migration; secure migration is applied to a clean fixture instead.');
      continue;
    }
    if (name === '20261031120000_billing_cutover_pending_invoice_quarantine.sql') continue;
    if (name === '20261008141500_create_table_tab_consumption.sql') {
      apply('supabase/seeds/demo_restaurants.sql');
    }
    if (name === '20261029024000_contract_module_access.sql') {
      sql("insert into public.restaurants(id,name,slug,subscription_plan,subscription_is_trial,subscription_expires_at) values('b8000000-0000-4000-8000-000000000099','Unknown old trial','old-trial-no-proof','pro',true,now()+interval '5 days'); insert into public.restaurants(id,name,slug,subscription_plan,max_tables,monthly_price_cents) values('b8000000-0000-4000-8000-000000000098','Legacy custom','legacy-custom','basic',17,7777); insert into public.subscription_invoices(id,restaurant_id,plan_id,billing_cycle,payment_method,amount_cents,external_reference,status,paid_at) values('e8000000-0000-4000-8000-000000000098','b8000000-0000-4000-8000-000000000098','basic','monthly','pix',7777,'legacy-paid','paid',now()-interval '1 day');");
    }
    if (name === '20261029143000_premium_trial_and_prepaid_cycle.sql') {
      sql('create schema trial_before; create table trial_before.restaurants as select id,to_jsonb(r) snapshot from public.restaurants r; create table trial_before.invoices as select to_jsonb(i) snapshot from public.subscription_invoices i;');
    }
    apply('supabase/migrations/' + name);

    if (name === '20261025090000_secure_reservations_rls.sql') {
      const unsafe = sql("select count(*) from pg_policies where schemaname='public' and tablename='reservations' and (qual='true' or with_check='true')");
      const safe = sql("select count(*) from pg_policies where schemaname='public' and tablename='reservations' and policyname in ('reservations_select_member','reservations_insert_admin','reservations_update_admin','reservations_delete_admin')");
      assert.equal(unsafe,'0');
      assert.equal(safe,'4');
      assert.equal(sql("select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname='reservations'"),'t');
      sawSecureReservations = true;
      log('PASS reservations fixture created directly by secure migration; RLS on, four tenant-scoped policies, no permissive true policy.');
    }
    if (name === '20261016061000_update_banco_inter_pix_rpc.sql') {
      const hashes = sql("select p.proname||'='||md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('create_subscription_checkout','confirm_subscription_invoice_payment') order by p.proname");
      assert.equal(hashes,'confirm_subscription_invoice_payment=db0470c9ebb4d1d789d2984ec8c103d7\ncreate_subscription_checkout=0b7252aec501386cc70d1864ce31789a','current principal financial RPC bodies match the verified local baseline before hardening');
      sawMainBaseline = true;
      log('PASS baseline RPC body hashes match the main project read-only hashes; historical invoice and contract data were not queried.');
    }
  }
  assert.ok(skippedPermissiveReservations && sawSecureReservations && sawMainBaseline);

  apply('supabase/tests/premium_trial_test.sql');
  apply('supabase/tests/financial_cutover_prepare.sql');
  apply('supabase/migrations/20261031120000_billing_cutover_pending_invoice_quarantine.sql');
  apply('supabase/tests/financial_cutover_assert.sql');

  const finalPolicies = sql("select count(*) from pg_policies where schemaname='public' and tablename='reservations' and (qual='true' or with_check='true')");
  assert.equal(finalPolicies,'0','no insecure reservation policy after complete local sequence');
  assert.equal(sql("select count(*) from subscription_quote_private.cycles where restaurant_id='c1000000-0000-4000-8000-000000000005'"),'1','one cycle after late confirmation/replay');
  assert.equal(sql("select count(*) from subscription_quote_private.cycle_payments where invoice_id='c2000000-0000-4000-8000-000000000003'"),'1','one confirmed allocation after replay');
  assert.equal(sql("select count(*) from public.subscription_invoices where id='c2000000-0000-4000-8000-000000000005' and status='pending' and gateway_emission_status='needs_reconciliation'"),'1','in-flight synthetic invoice retained for verified webhook/reconciliation');
  log('RESULTADO_FINAL: PASS; no real gateway calls; all fixtures synthetic and disposable.');
  passed = true;
} catch (error) {
  log(`RESULTADO_FINAL: FAIL\n${error.stack ?? error}`);
  process.exitCode = 1;
} finally {
  if (started) {
    try { run('pg_ctl',['-D',data,'-w','stop','-m','fast']); log('Disposable PostgreSQL stopped in finally.'); }
    catch (error) { log(`ERROR stopping cluster: ${error}`); process.exitCode=1; }
  }
  const resolvedTemp = path.resolve(os.tmpdir());
  const resolvedWork = path.resolve(work);
  if (resolvedWork.startsWith(resolvedTemp + path.sep) && path.basename(resolvedWork).startsWith('eloozi-financial-cutover-')) {
    try { fs.rmSync(resolvedWork,{recursive:true,force:true}); log('Temporary cluster files removed in finally.'); }
    catch (error) { log(`ERROR removing temp cluster: ${error}`); process.exitCode=1; }
  } else {
    log('ERROR safety guard refused temp cleanup outside generated directory.');
    process.exitCode=1;
  }
  fs.mkdirSync(path.join(root,'docs'),{recursive:true});
  fs.writeFileSync(path.join(root,'docs/financial-cutover-local.log'),evidence.join('\n')+'\n');
}
if (!passed) process.exitCode=1;


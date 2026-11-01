// Disposable native PostgreSQL only. No connection strings, env credentials or remote hosts.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const bin = 'D:/pgSQL/bin';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'eloozi-trial-upgrades-'));
const data = path.join(work, 'data');
const port = 55490;
const connection = ['-X', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'];
const evidence = [];
const log = (s) => { evidence.push(s); console.log(s); };
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('PG')));
env.PGOPTIONS = '-c client_min_messages=warning -c timezone=UTC';
function run(exe, args, input) {
  const r = spawnSync(path.join(bin, exe + '.exe'), args, { input, encoding: 'utf8', windowsHide: true, env, maxBuffer: 20 * 1024 * 1024, ...(exe === 'pg_ctl' ? { stdio: 'ignore' } : {}) });
  if (r.error || r.status !== 0) throw new Error(`${exe} failed (${r.status}): ${r.error ?? ''}\n${r.stdout}\n${r.stderr}`);
  return (r.stdout ?? '').trim();
}
const sql = (s) => run('psql', [...connection, '-At'], s);
const file = (f) => sql(fs.readFileSync(path.join(root, f), 'utf8'));
function session(s, name) {
  const child = spawn(path.join(bin, 'psql.exe'), [...connection, '-At', '-c', s], { windowsHide: true, env });
  let out = '', err = '';
  child.stdout.on('data', (v) => { out += v; });
  child.stderr.on('data', (v) => { err += v; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(out.trim()) : reject(new Error(`${name}: ${code}\n${out}\n${err}`)));
  });
  return { done };
}
let started = false;
try {
  log(`PostgreSQL: ${run('postgres', ['--version'])}; cluster descartavel: ${work}`);
  run('initdb', ['-D', data, '-U', 'postgres', '-A', 'trust', '--encoding=UTF8', '--no-locale']);
  fs.appendFileSync(path.join(data, 'postgresql.conf'), `\nlisten_addresses = '127.0.0.1'\nport = ${port}\nmax_connections = 12\n`);
  run('pg_ctl', ['-D', data, '-l', path.join(work, 'server.log'), '-w', 'start']);
  started = true;
  log(file('supabase/tests/etapa3_bootstrap.sql'));
  const target = '20261029180000_trial_prepaid_upgrades.sql';
  const migrations = fs.readdirSync(path.join(root, 'supabase/migrations')).filter(f => f.endsWith('.sql') && f <= target).sort();
  for (const f of migrations) {

    if (f === '20261008141500_create_table_tab_consumption.sql') file('supabase/seeds/demo_restaurants.sql');
    if(f==='20261029024000_contract_module_access.sql')sql(`insert into public.restaurants(id,name,slug,subscription_plan,subscription_is_trial,subscription_expires_at)values('b8000000-0000-4000-8000-000000000099','Unknown old trial','old-trial-no-proof','pro',true,now()+interval '5 days');insert into public.restaurants(id,name,slug,subscription_plan,max_tables,monthly_price_cents)values('b8000000-0000-4000-8000-000000000098','Legacy custom','legacy-custom','basic',17,7777);insert into public.subscription_invoices(id,restaurant_id,plan_id,billing_cycle,payment_method,amount_cents,external_reference,status,paid_at)values('e8000000-0000-4000-8000-000000000098','b8000000-0000-4000-8000-000000000098','basic','monthly','pix',7777,'legacy-paid','paid',now()-interval '1 day');`);
    if(f==='20261029143000_premium_trial_and_prepaid_cycle.sql')sql(`create schema trial_before; create table trial_before.restaurants as select id,to_jsonb(r) snapshot from public.restaurants r; create table trial_before.invoices as select to_jsonb(i) snapshot from public.subscription_invoices i;`);
    if(f===target)log(file('supabase/tests/premium_trial_test.sql'));
    file('supabase/migrations/' + f);
  }
  log(file('supabase/tests/trial_upgrades_test.sql'));
  log(file('supabase/tests/basic_manual_delivery_test.sql'));
  log(file('supabase/tests/contract_modules_sale_regression.sql'));
  const delivery = `insert into nk.race_results select nk.call('a5000000-0000-4000-8000-000000000001',format('select to_jsonb(public.update_tab_item_production_status(''nk-a'',%L,''delivered''))',(select item_id from nk.race)))`;
  const first = session(`set application_name='delivery_race_1'; begin; ${delivery}; select pg_sleep(3); commit;`, 'delivery/1');
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (sql("select count(*) from pg_stat_activity where application_name='delivery_race_1' and wait_event='PgSleep'") === '1') { ready = true; break; }
    await new Promise(r => setTimeout(r, 30));
  }
  assert.ok(ready, 'Primeira transacao deve manter lock aberto');
  const second = session(`set application_name='delivery_race_2'; ${delivery}`, 'delivery/2');
  let blocked = false;
  for (let i = 0; i < 60; i++) {
    if (sql("select count(*) from pg_stat_activity where application_name='delivery_race_2' and wait_event_type='Lock' and cardinality(pg_blocking_pids(pid))>0") === '1') { blocked = true; break; }
    await new Promise(r => setTimeout(r, 30));
  }
  await Promise.all([first.done, second.done]);
  assert.ok(blocked, 'Segunda sessao deve bloquear na primeira');
  log(sql(`select nk.ok((select count(*)=2 and count(distinct result)=1 from nk.race_results),'duas respostas identicas, incluindo timestamp de entrega');
    select nk.ok((select count(*)=1 from nk.delivery_events where item_id=(select item_id from nk.race)),'apenas um efeito de entrega observado por trigger de teste');
    select nk.ok((select prep_started_at is null and prep_ready_at is null and production_status='delivered' from public.table_tab_items where id=(select item_id from nk.race)),'concorrencia nao inventa preparo');`));
  log('PASS: concorrencia real, dois processos psql, bloqueio observado por pg_blocking_pids.');
  sql(`insert into public.restaurants(id,name,slug,subscription_plan,max_tables,unlimited_tables,subscription_is_trial,subscription_expires_at)values('b8000000-0000-4000-8000-000000000999','Race','trial-payment-race','premium',null,true,true,now()+interval '120 hours');
    insert into subscription_quote_private.trial_terms values('b8000000-0000-4000-8000-000000000999',now()-interval '48 hours',now()+interval '120 hours','onboarding_premium_168h');
    insert into public.subscription_invoices(id,restaurant_id,plan_id,billing_cycle,payment_method,amount_cents,external_reference)select 'e8000000-0000-4000-8000-000000000999','b8000000-0000-4000-8000-000000000999','basic','monthly','pix',basic_price_cents,'trial-payment-race' from public.platform_settings where id='default';`);
  const confirm=`select set_config('request.jwt.claim.role','service_role',false);set role service_role;select public.confirm_subscription_invoice_payment('e8000000-0000-4000-8000-000000000999','trial-payment-race',(select amount_cents from public.subscription_invoices where id='e8000000-0000-4000-8000-000000000999'),'b8000000-0000-4000-8000-000000000999');`;
  const pay1=session(`set application_name='trial_payment_1';begin;${confirm}select pg_sleep(3);commit;`,'payment/1');
  let paymentReady=false;
  for(let i=0;i<80;i++){if(sql("select count(*) from pg_stat_activity where application_name='trial_payment_1' and wait_event='PgSleep'")==='1'){paymentReady=true;break;}await new Promise(r=>setTimeout(r,30));}
  assert.ok(paymentReady,'first payment must hold invoice lock');
  const pay2=session(`set application_name='trial_payment_2';${confirm}`,'payment/2');
  let paymentBlocked=false;
  for(let i=0;i<80;i++){if(sql("select count(*) from pg_stat_activity where application_name='trial_payment_2' and wait_event_type='Lock' and cardinality(pg_blocking_pids(pid))>0")==='1'){paymentBlocked=true;break;}await new Promise(r=>setTimeout(r,30));}
  await Promise.all([pay1.done,pay2.done]);assert.ok(paymentBlocked,'independent confirmation must block on first');
  assert.equal(sql("select count(*) from subscription_quote_private.cycles where restaurant_id='b8000000-0000-4000-8000-000000000999'"),'1');
  assert.equal(sql("select count(*) from subscription_quote_private.cycle_payments where invoice_id='e8000000-0000-4000-8000-000000000999'"),'1');
  assert.equal(sql("select count(*) from public.platform_audit_logs where details->>'invoice_id'='e8000000-0000-4000-8000-000000000999'"),'1');
  assert.equal(sql("select count(*) from subscription_quote_private.cycles c join subscription_quote_private.trial_terms t using(restaurant_id)where c.restaurant_id='b8000000-0000-4000-8000-000000000999' and c.starts_at=t.original_end and c.ends_at=t.original_end+interval '720 hours'"),'1');
  assert.equal(sql(`select count(*) from public.restaurants r join subscription_quote_private.cycles c on c.restaurant_id=r.id where r.id='b8000000-0000-4000-8000-000000000999' and r.subscription_expires_at=c.ends_at`),'1');
  log('PASS: payment concurrency: independent sessions blocked on invoice; exactly one cycle, allocation and audit; no appended days.');
  sql('create table tu.race_results(kind text,result jsonb)');
  const reservation = (plan) => `insert into tu.race_results select 'reserve',tu.reserve((select rid from tu.fixtures where label='upgrade-race'),'${plan}')`;
  const reserve1=session(`set application_name='upgrade_reserve_1';begin;${reservation('pro')};select pg_sleep(3);commit;`,'upgrade reserve/1');
  async function observe(query,label){for(let i=0;i<100;i++){if(sql(query)==='1')return;await new Promise(r=>setTimeout(r,40));}assert.fail(label);}
  await observe("select count(*) from pg_stat_activity where application_name='upgrade_reserve_1' and wait_event='PgSleep'",'reserve lock readiness');
  const reserve2=session(`set application_name='upgrade_reserve_2';${reservation('premium')}`,'upgrade reserve/2');
  await observe("select count(*) from pg_stat_activity where application_name='upgrade_reserve_2' and cardinality(pg_blocking_pids(pid))>0",'independent reservation must block');
  await Promise.all([reserve1.done,reserve2.done]);
  assert.equal(sql("select count(*) from tu.race_results where result->>'state'='00000'"),'1');
  assert.equal(sql("select count(*) from tu.race_results where result->>'state'='22023'"),'1');
  assert.equal(sql("select count(*) from subscription_quote_private.trial_upgrades u join tu.fixtures f on f.cycle_id=u.cycle_id where f.label='upgrade-race'"),'1');
  const payUpgrade=`insert into tu.race_results select 'pay',tu.pay((select (result->'result'->'invoice'->>'id')::uuid from tu.race_results where kind='reserve' and result->>'state'='00000'))`;
  const upgradePay1=session(`set application_name='upgrade_pay_1';begin;${payUpgrade};select pg_sleep(3);commit;`,'upgrade payment/1');
  await observe("select count(*) from pg_stat_activity where application_name='upgrade_pay_1' and wait_event='PgSleep'",'upgrade payment readiness');
  const upgradePay2=session(`set application_name='upgrade_pay_2';${payUpgrade}`,'upgrade payment/2');
  await observe("select count(*) from pg_stat_activity where application_name='upgrade_pay_2' and cardinality(pg_blocking_pids(pid))>0",'independent upgrade confirmation must block');
  await Promise.all([upgradePay1.done,upgradePay2.done]);
  assert.equal(sql("select count(*) from tu.race_results where kind='pay' and result->>'state'='00000' and (result->'result'->>'success')::boolean"),'2');
  assert.equal(sql("select count(*) from subscription_quote_private.trial_upgrade_receipts r join subscription_quote_private.trial_upgrades u using(invoice_id) join tu.fixtures f on f.cycle_id=u.cycle_id where f.label='upgrade-race'"),'1');
  assert.equal(sql("select count(*) from subscription_quote_private.cycle_payments cp join tu.fixtures f on f.cycle_id=cp.cycle_id where f.label='upgrade-race'"),'2');
  assert.equal(sql("select count(*) from public.platform_audit_logs a join tu.fixtures f on f.rid=a.target_restaurant_id where f.label='upgrade-race' and a.details->>'operation'='trial_prepaid_upgrade'"),'1');
  assert.equal(sql("select count(*) from subscription_quote_private.cycles c join tu.fixtures f on f.rid=c.restaurant_id where f.label='upgrade-race' and c.starts_at=f.start_at and c.ends_at=f.end_at"),'1');
  log('PASS: upgrade reservation and confirmation races: independent psql sessions, blocking observed; one intent, receipt, audit and upgrade allocation; unchanged single cycle.');
  log('RESULTADO FINAL: PASS - upgrades de ciclo futuro no trial, regressoes e concorrencia.');
} catch (err) {
  log(`RESULTADO FINAL: FAIL\n${err.stack}`);
  process.exitCode = 1;
} finally {
  if (started) {
    try { run('pg_ctl', ['-D', data, '-w', 'stop', '-m', 'fast']); log('Cluster descartavel encerrado.'); }
    catch (err) { log(String(err)); process.exitCode = 1; }
  }
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/trial-upgrades-sql.log'), evidence.join('\n') + '\n');
}

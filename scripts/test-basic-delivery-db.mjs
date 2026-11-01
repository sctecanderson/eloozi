// Disposable native PostgreSQL only. No connection strings, env credentials or remote hosts.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const bin = 'D:/pgSQL/bin';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'eloozi-manual-delivery-'));
const data = path.join(work, 'data');
const port = 55486;
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
  const target = '20261029002852_basic_manual_delivery.sql';
  const migrations = fs.readdirSync(path.join(root, 'supabase/migrations')).filter(f => f.endsWith('.sql') && f <= target).sort();
  for (const f of migrations) {

    if (f === '20261008141500_create_table_tab_consumption.sql') file('supabase/seeds/demo_restaurants.sql');
    file('supabase/migrations/' + f);
  }
  log(file('supabase/tests/basic_manual_delivery_test.sql'));
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
  log('RESULTADO FINAL: PASS - entrega manual Basic e regressoes SQL.');
} catch (err) {
  log(`RESULTADO FINAL: FAIL\n${err.stack}`);
  process.exitCode = 1;
} finally {
  if (started) {
    try { run('pg_ctl', ['-D', data, '-w', 'stop', '-m', 'fast']); log('Cluster descartavel encerrado.'); }
    catch (err) { log(String(err)); process.exitCode = 1; }
  }
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/basic-delivery-sql-resultados.log'), evidence.join('\n') + '\n');
}

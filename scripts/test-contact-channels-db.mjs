// Disposable native PostgreSQL only. No connection strings, env credentials or remote hosts.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const bin = 'D:/pgSQL/bin';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'eloozi-contacts-'));
const data = path.join(work, 'data');
const port = 55487;
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
let started = false;
try {
  log(`PostgreSQL: ${run('postgres', ['--version'])}; cluster descartavel: ${work}`);
  run('initdb', ['-D', data, '-U', 'postgres', '-A', 'trust', '--encoding=UTF8', '--no-locale']);
  fs.appendFileSync(path.join(data, 'postgresql.conf'), `\nlisten_addresses = '127.0.0.1'\nport = ${port}\nmax_connections = 12\n`);
  run('pg_ctl', ['-D', data, '-l', path.join(work, 'server.log'), '-w', 'start']);
  started = true;
  log(file('supabase/tests/etapa3_bootstrap.sql'));
  const target = '20261029010637_restaurant_contact_channels.sql';
  const migrations = fs.readdirSync(path.join(root, 'supabase/migrations')).filter(f => f.endsWith('.sql') && f <= target).sort();
  for (const f of migrations) {

    if (f === '20261008141500_create_table_tab_consumption.sql') file('supabase/seeds/demo_restaurants.sql');
    file('supabase/migrations/' + f);
  }
  log(file('supabase/tests/contact_channels_test.sql'));
  log('RESULTADO FINAL: PASS - canais de contato persistidos e isolamento.');
} catch (err) {
  log(`RESULTADO FINAL: FAIL\n${err.stack}`);
  process.exitCode = 1;
} finally {
  if (started) {
    try { run('pg_ctl', ['-D', data, '-w', 'stop', '-m', 'fast']); log('Cluster descartavel encerrado.'); }
    catch (err) { log(String(err)); process.exitCode = 1; }
  }
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/contacts-sql-resultados.log'), evidence.join('\n') + '\n');
}

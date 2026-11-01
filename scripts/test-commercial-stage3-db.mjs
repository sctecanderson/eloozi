// Disposable native PostgreSQL only. No connection strings, env credentials or remote hosts.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const bin = 'D:/pgSQL/bin';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'eloozi-stage3-'));
const data = path.join(work, 'data');
const port = 55483;
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
  const target = '20261028223000_commercial_catalog_modules_and_active_tables_quota.sql';
  const migrations = fs.readdirSync(path.join(root, 'supabase/migrations')).filter(f => f.endsWith('.sql') && f <= target).sort();
  for (const f of migrations) {
    if (f === target) log(file('supabase/tests/etapa3_before_migration.sql'));
    if (f === '20261008141500_create_table_tab_consumption.sql') file('supabase/seeds/demo_restaurants.sql');
    file('supabase/migrations/' + f);
  }
  log(`PASS: ${migrations.length} migrations aplicadas; fixtures anteriores a migration comercial preservadas para comparacao.`);
  log(file('supabase/tests/20261028223000_commercial_catalog_test.sql'));
  // Independent OS processes / PostgreSQL backends. Wait for an observed lock, not a guessed delay.
  async function race(name, firstSql, secondSql, finalSql) {
    const first = session(`set application_name='stage3_${name}_1'; begin; ${firstSql}; select pg_sleep(3); commit;`, name + '/1');
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (sql(`select count(*) from pg_stat_activity where application_name='stage3_${name}_1' and wait_event='PgSleep'`) === '1') { ready = true; break; }
      await new Promise(r => setTimeout(r, 30));
    }
    assert.ok(ready, 'Primeira sessao deve manter transacao aberta');
    const second = session(`set application_name='stage3_${name}_2'; ${secondSql}`, name + '/2');
    let blocked = false;
    for (let i = 0; i < 50; i++) {
      if (sql(`select count(*) from pg_stat_activity where application_name='stage3_${name}_2' and wait_event_type='Lock' and cardinality(pg_blocking_pids(pid)) > 0`) === '1') { blocked = true; break; }
      await new Promise(r => setTimeout(r, 30));
    }
    const results = await Promise.all([first.done, second.done]);
    assert.ok(blocked, 'Segunda sessao deve bloquear em lock da primeira');
    log(`PASS concorrencia ${name}: backends independentes, bloqueio observado; ${results.join(' | ')}`);
    log(sql(finalSql));
  }
  await race('quota',
    `insert into public.restaurant_tables(restaurant_id,table_number,active,is_active) values('e3000000-0000-4000-8000-000000000003',901,true,true)`,
    `do $$ begin
      begin insert into public.restaurant_tables(restaurant_id,table_number,active,is_active) values('e3000000-0000-4000-8000-000000000003',902,true,true);
        raise exception 'quota concorrente permitiu excesso';
      exception when sqlstate 'P0001' then if sqlerrm not like 'Limite de 1 mesas%' then raise; end if; end;
    end $$;`,
    `select stage3.check_true((select count(*)=1 from public.restaurant_tables where restaurant_id='e3000000-0000-4000-8000-000000000003' and active and is_active),'quota concorrente: uma mesa ativa');`);
  const pay = `select public.confirm_subscription_invoice_payment('e3000000-0000-4000-8000-000000000099','stage3-concurrent',9990,'e3000000-0000-4000-8000-000000000003')`;
  await race('payment', pay, pay,
    `select stage3.check_true((select subscription_expires_at = '2031-01-31 00:00:00+00' from public.restaurants where id='e3000000-0000-4000-8000-000000000003'),'pagamento concorrente renova uma vez');
     select stage3.check_true((select count(*)=1 from public.platform_audit_logs where details->>'invoice_id'='e3000000-0000-4000-8000-000000000099'),'pagamento concorrente gera um evento');`);
  log(file('supabase/tests/etapa3_sync_isolation_test.sql'));
  const securityFailures = Number(sql('select count(*) from stage3.security_findings where expected<>actual or changed_other_tenant'));
  assert.equal(securityFailures, 0, 'Ha regressao de autorizacao na sincronizacao de mesas; consulte security_findings no log.');
  log('RESULTADO FINAL: PASS — suite SQL comercial e 2 cenarios concorrentes concluidos.');
} catch (err) {
  log(`RESULTADO FINAL: FAIL\n${err.stack}`);
  process.exitCode = 1;
} finally {
  if (started) {
    try { run('pg_ctl', ['-D', data, '-w', 'stop', '-m', 'fast']); log('Cluster descartavel encerrado.'); }
    catch (err) { log(String(err)); process.exitCode = 1; }
  }
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/etapa3-sql-resultados.log'), evidence.join('\n') + '\n');
}

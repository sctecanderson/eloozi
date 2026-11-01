// PostgreSQL descartável local: aplica a cadeia e testa a RPC com RLS real.
// Não lê .env, não acessa projetos Supabase, encerra e remove o cluster no finally.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const bin = 'D:/pgSQL/bin';
const port = 55496;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'eloozi-visit-consumption-'));
const data = path.join(work, 'data');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('PG')));
env.PGOPTIONS = '-c client_min_messages=warning -c timezone=UTC';
const conn = ['-X', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'];
let started = false;
function run(exe, args, input) {
  const r = spawnSync(path.join(bin, `${exe}.exe`), args, { input, encoding: 'utf8', windowsHide: true, env, maxBuffer: 40 * 1024 * 1024, ...(exe === 'pg_ctl' ? { stdio: 'ignore' } : {}) });
  if (r.error || r.status !== 0) throw new Error(`${exe} exit=${r.status}: ${r.error ?? ''}\n${r.stdout ?? ''}\n${r.stderr ?? ''}`);
  return (r.stdout ?? '').trim();
}
const sql = (s) => run('psql', [...conn, '-At'], s);
const file = (p) => sql(fs.readFileSync(path.join(root, p), 'utf8'));
const benchUser = 'a7200000-0000-4000-8000-000000000001';
const benchRestaurant = 'b7200000-0000-4000-8000-000000000001';
function explain(statement) {
  const raw = sql(`set role authenticated; set request.jwt.claim.sub='${benchUser}'; set request.jwt.claims='{"sub":"${benchUser}","role":"authenticated"}'; ${statement}`);
  const start = raw.indexOf('[');
  if (start < 0) throw new Error(`EXPLAIN JSON ausente: ${raw}`);
  return JSON.parse(raw.slice(start));
}
function summarizePlan(result) {
  const itemNodes = [];
  function visit(node) {
    if (node['Relation Name'] === 'table_tab_items') itemNodes.push({
      node: node['Node Type'], index: node['Index Name'] ?? null,
      loops: node['Actual Loops'], rows: node['Actual Rows'],
      sharedHit: node['Shared Hit Blocks'] ?? 0, sharedRead: node['Shared Read Blocks'] ?? 0,
    });
    for (const child of node.Plans ?? []) visit(child);
  }
  visit(result[0].Plan);
  return {
    executionMs: result[0]['Execution Time'], planningMs: result[0]['Planning Time'],
    sharedHitBlocks: result[0].Plan['Shared Hit Blocks'] ?? 0,
    sharedReadBlocks: result[0].Plan['Shared Read Blocks'] ?? 0, itemNodes,
  };
}
try {
  if (!fs.existsSync(path.join(bin, 'initdb.exe'))) throw new Error('PostgreSQL local não encontrado em D:/pgSQL/bin.');
  console.log(`${run('postgres', ['--version'])}; cluster descartável 127.0.0.1:${port}`);
  run('initdb', ['-D', data, '-U', 'postgres', '-A', 'trust', '--encoding=UTF8', '--no-locale']);
  fs.appendFileSync(path.join(data, 'postgresql.conf'), `\nlisten_addresses='127.0.0.1'\nport=${port}\nmax_connections=20\n`);
  run('pg_ctl', ['-D', data, '-l', path.join(work, 'postgres.log'), '-w', 'start']); started = true;
  file('supabase/tests/etapa3_bootstrap.sql');
  for (const name of fs.readdirSync(path.join(root, 'supabase/migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    if (name === '20261008141500_create_table_tab_consumption.sql') file('supabase/seeds/demo_restaurants.sql');
    file(`supabase/migrations/${name}`);
  }
  console.log('PASS cluster limpo e todas as migrations locais aplicadas');
  console.log(file('supabase/tests/get_visit_tab_consumptions_test.sql'));
  console.log('PASS teste SQL da RPC em lote, paridade com RPC individual e isolamento RLS');
  file('supabase/tests/get_visit_tab_consumptions_benchmark_setup.sql');
  const benchVisit = sql(`select id from public.table_visits where restaurant_id='${benchRestaurant}' and status='open'`);
  const volume = Number(sql(`select count(*) from public.table_tab_items where restaurant_id='${benchRestaurant}' and table_visit_id='${benchVisit}'`));
  if (!/^[0-9a-f-]{36}$/i.test(benchVisit) || volume !== 10000) throw new Error(`Fixture do benchmark inválida: visit=${benchVisit}, rows=${volume}`);
  console.log(`PASS volume sintético local: 20 comandas abertas e ${volume} itens`);

  const beforeCalls = explain(`explain (analyze,buffers,format json) select jsonb_agg(public.get_table_tab_consumption('${benchRestaurant}'::uuid,tab.id)) from public.table_tabs tab where tab.restaurant_id='${benchRestaurant}' and tab.table_visit_id='${benchVisit}' and tab.status='open';`);
  const afterCall = explain(`explain (analyze,buffers,format json) select public.get_visit_tab_consumptions('${benchRestaurant}'::uuid,'${benchVisit}'::uuid);`);
  const oldBody = explain(`explain (analyze,buffers,format json) select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(item) order by item.created_at,item.id) from public.table_tab_items item where item.table_tab_id=tab.id and item.restaurant_id=tab.restaurant_id),'[]'::jsonb),'totalInCents',coalesce((select sum(item.line_total_in_cents) from public.table_tab_items item where item.table_tab_id=tab.id and item.restaurant_id=tab.restaurant_id and item.status='active'),0)) from public.table_tabs tab where tab.restaurant_id='${benchRestaurant}' and tab.table_visit_id='${benchVisit}' and tab.id='f7200000-0000-4000-8000-000000000001';`);
  const newBody = explain(`explain (analyze,buffers,format json) select jsonb_build_object('items',coalesce(consumption.items,'[]'::jsonb),'totalInCents',coalesce(consumption.total_in_cents,0)) from public.table_tabs tab cross join lateral (select jsonb_agg(to_jsonb(item) order by item.created_at,item.id) items,coalesce(sum(item.line_total_in_cents) filter(where item.status='active'),0) total_in_cents from public.table_tab_items item where item.table_tab_id=tab.id and item.table_visit_id=tab.table_visit_id and item.restaurant_id=tab.restaurant_id and item.restaurant_table_id=tab.restaurant_table_id) consumption where tab.restaurant_id='${benchRestaurant}' and tab.table_visit_id='${benchVisit}' and tab.id='f7200000-0000-4000-8000-000000000001';`);
  const oldBodySummary = summarizePlan(oldBody);
  const newBodySummary = summarizePlan(newBody);
  if (oldBodySummary.itemNodes.length !== 2 || newBodySummary.itemNodes.length !== 1) throw new Error(`Esperados dois scans antigos e um novo; observados ${oldBodySummary.itemNodes.length} e ${newBodySummary.itemNodes.length}.`);
  const evidence = {
    fixture: { openTabs: 20, itemRows: volume, synthetic: true },
    before: { rpcCountPerRefresh: 20, plan: summarizePlan(beforeCalls) },
    after: { rpcCountPerRefresh: 1, plan: summarizePlan(afterCall) },
    oneTabQueryBefore: oldBodySummary, oneTabQueryAfter: newBodySummary,
  };
  fs.writeFileSync(path.join(root, 'docs/consumption-performance-local.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`PLAN ${JSON.stringify(evidence)}`);
  console.log('PASS plano: duas leituras de itens por RPC individual -> uma agregação; RPCs por visita: 20 -> 1');
} catch (error) {
  console.error(error); process.exitCode = 1;
} finally {
  if (started) {
    try { run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']); console.log('PASS cluster encerrado'); }
    catch (error) { console.error('FALHA AO ENCERRAR CLUSTER', error); process.exitCode = 1; }
  }
  try { fs.rmSync(work, { recursive: true, force: true }); }
  catch (error) { console.error('FALHA AO REMOVER TEMP', error); process.exitCode = 1; }
}

// Checks final source hashes and recorded results; does NOT rerun SQL/browser.
import fs from 'node:fs';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const scope=JSON.parse(fs.readFileSync('docs/scheduled-downgrades-scope.json','utf8'));
for(const [p,h] of Object.entries({...scope.hashes,...scope.edgeHandlers}))assert.equal(createHash('sha256').update(fs.readFileSync(p)).digest('hex'),h,p);
const sql=fs.readFileSync('docs/scheduled-downgrades-sql.log','utf8');assert.match(sql,/RESULTADO FINAL: PASS/);assert.match(sql,/79 scheduled downgrade SQL assertions/);assert.match(sql,/one reused reserved invoice/);assert.match(sql,/Cluster descartavel encerrado/);assert.match(sql,/migration preserved every existing restaurant, invoice and cycle/);
const rows=JSON.parse(fs.readFileSync('docs/scheduled-downgrades-browser.json','utf8'));assert.equal(rows.length,14);for(const r of rows){assert.ok(r.scroll<=r.client);assert.equal(r.dialogs,0);assert.ok(fs.statSync(r.file).size>1000);}
for(const w of [1440,390])for(const theme of ['light','dark']){const r=rows.find(r=>r.w===w&&r.theme===theme&&r.stage==='scheduled');assert.ok(r);assert.ok(r.buttons.find(b=>b.text==='Renovar com Básico').disabled);assert.match(r.panel,/somente após a confirmação/);}
assert.ok(rows.find(r=>r.stage==='renewal-due').buttons.find(b=>b.text==='Renovar com Básico'&&!b.disabled));assert.ok(rows.find(r=>r.stage==='error').panel.includes('Falha simulada'));
const actions=JSON.parse(fs.readFileSync('docs/scheduled-downgrades-browser-actions.json','utf8'));assert.ok(actions.firstPurchaseStillOpensExistingCheckout&&actions.renewalDueOpensExistingCheckout&&actions.cancelRemovedPanel);
console.log('PASS: final hashes, recorded SQL success/cleanup/concurrency, 14 UI observations, simulated actions and no horizontal overflow. Records only; not a SQL or browser replay.');

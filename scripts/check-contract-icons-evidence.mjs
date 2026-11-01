// Checks saved browser observations and final source hashes; does NOT replay browser.
import fs from 'node:fs';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const rows=JSON.parse(fs.readFileSync('docs/contract-icons-browser.json','utf8'));
const scope=JSON.parse(fs.readFileSync('docs/contract-icons-scope.json','utf8'));
assert.equal(rows.length,24);
const names={basic:'Plano Básico',pro:'Plano Profissional',premium:'Plano Premium',first:'Experiência Premium de teste'};
for(const w of [1920,900,390])for(const theme of ['light','dark'])for(const scenario of Object.keys(names)){
 const r=rows.find(r=>r.w===w&&r.theme===theme&&r.scenario===scenario);assert.ok(r);
 assert.equal(r.title,names[scenario]);assert.equal(r.titleImages.length,scenario==='first'?0:1);
 assert.ok(r.scroll<=r.client);assert.ok(r.images.every(i=>i.ok));assert.ok(fs.statSync(r.file).size>1000);
 assert.equal(new Set(r.features).size,r.features.length);
 for(const c of r.content){const overlap=Math.min(c.right,r.art.right)-Math.max(c.left,r.art.left)>1&&Math.min(c.bottom,r.art.bottom)-Math.max(c.top,r.art.top)>1;assert.equal(overlap,false,'Decorative art overlaps content');assert.ok(c.left>=r.card.left&&c.right<=r.card.right+1);}
 assert.deepEqual(r.buttons.map(b=>b.text.trim()),['Renovar Ciclo Agora','Fazer Upgrade de Plano']);
 if(scenario==='first'){assert.equal(r.period,null);assert.equal(r.note,'');}
}
for(const [p,h] of Object.entries(scope.hashes))assert.equal(createHash('sha256').update(fs.readFileSync(p)).digest('hex'),h,p);
const a=JSON.parse(fs.readFileSync('docs/contract-icons-actions.json','utf8'));assert.equal(a.renewalOutsideTrialOpenedMockCheckout,true);assert.equal(a.escapeClosedDialog,true);assert.match(a.trialRenewalBlocked,/plano superior/);assert.ok(a.upgrade.selection.top<1000);
console.log('PASS: 24 saved visual observations, title/asset selection, content/art separation, no horizontal overflow, existing mock actions and source hashes. Browser not replayed.');

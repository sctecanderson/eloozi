// Offline verification of recorded browser evidence and source integrity; no backend access.
import fs from 'node:fs';import crypto from 'node:crypto';import assert from 'node:assert/strict';
const read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
try{
 const e=read('docs/contract-card-browser.json'),s=read('docs/contract-card-scope.json');
 assert.equal(e.isolated,true);assert.equal(e.authenticated,false);assert.equal(e.cases.length,15);
 for(const width of [1920,1440,1280,1024,900,390])for(const theme of ['light','dark'])assert.equal(e.cases.filter(c=>c.scenario==='premium'&&c.requestedWidth===width&&c.theme===theme).length,1);
 for(const c of e.cases){assert.ok([c.requestedWidth,c.requestedWidth-15].includes(c.width));assert.equal(c.scroll,c.width);assert.deepEqual(c.overflows,[]);assert.ok(fs.statSync(c.capture).size>1000);assert.equal(new Set(c.resources).size,c.resources.length);assert.equal(c.buttons.length,2);assert.ok(!['Próximo vencimento','Mesas em uso','Produtos no cardápio'].some(text=>c.text.includes(text)));}
 assert.equal(e.cases.find(c=>c.scenario==='first').dates.length,0);
 assert.ok(e.cases.find(c=>c.scenario==='basic').resources.includes('Até 5 mesas simultâneas'));
 assert.ok(e.cases.find(c=>c.scenario==='pro').resources.includes('Até 20 mesas simultâneas'));
 assert.ok(e.negative.filter(c=>c.name!=='catalog-invalid').every(c=>c.note===''));
 assert.equal(e.negative.find(c=>c.name==='catalog-invalid').renewEnabled,false);
 assert.equal(e.actions.renewOpensMockCheckout,true);assert.equal(e.actions.upgradeTargetExists,1);
 assert.match(e.additional.find(c=>c.name==='yearly-contract').text,/Ciclo anual/);
 assert.equal(e.additional.find(c=>c.name==='partial-dates').dates.length,1);
 assert.equal(e.artSeparation.length,6);assert.ok(e.artSeparation.every(c=>c.separated));
 assert.ok(s.assetExact);assert.ok(s.handlers.every(h=>h.unchanged));
 for(const f of s.sources)assert.equal(hash(f.path),f.sha256,`changed since evidence: ${f.path}`);
 for(const n of ['typecheck','build','tests'])assert.match(fs.readFileSync(`docs/contract-card-${n}.log`,'utf8'),/EXIT_CODE=0/);
 console.log('PASS: 15 visual cases, 3 negative states, 2 date/cycle states, existing actions, 15 tests, typecheck/build.');
 console.log('PASS: original decorative image, unchanged financial handlers and source hashes. Fixture evidence only.');
}catch(error){console.error('FAIL:',error.message);process.exitCode=1;}

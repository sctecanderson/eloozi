// Offline verification of real browser observations. Does not replay browser/payment operations.
import fs from 'node:fs';import assert from 'node:assert/strict';import crypto from 'node:crypto';
const read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
try{
 const e=read('docs/pix-modal-browser.json'),s=read('docs/pix-modal-scope.json');
 assert.equal(e.isolated,true);assert.equal(e.authenticated,false);assert.equal(e.nativeZoom,false);assert.equal(e.cases.length,12);
 for(const [width,height]of [[390,1000],[1440,900],[390,500]])for(const theme of ['light','dark'])for(const zoom of [100,125])assert.equal(e.cases.filter(c=>c.width===width&&c.height===height&&c.theme===theme&&c.zoom===zoom).length,1);
 for(const c of e.cases){
  const visible=r=>r&&r.left>=0&&r.top>=0&&r.right<=c.width+1&&r.bottom<=c.height+1;
  for(const phase of ['initial','wrapLast','wrapFirst','form','outsideWheel','qr','insideWheel']){
   const p=c[phase];assert.ok(visible(p.close),`${phase}: close outside viewport`);assert.ok(visible(p.frame));assert.ok(p.close.bottom<=p.scroll.top+1);
   assert.equal(p.focusInside,true);assert.equal(p.bodyLock,'hidden');assert.equal(p.rootLock,'hidden');assert.equal(Number(p.zoom),c.zoom/100);
   assert.equal(p.backgroundTop,c.initial.backgroundTop);assert.equal(p.bodyTop,c.initial.bodyTop);
  }
  for(const phase of ['form','qr']){const p=c[phase];assert.ok(visible(p.main));assert.ok(p.mainInScroll);assert.ok(p.main.top>=p.scroll.top-1&&p.main.bottom<=p.scroll.bottom+1);}
  assert.match(c.wrapLast.focusText,/Gerar PIX/);assert.ok(c.wrapFirst.focusClose);assert.equal(c.qr.qrPayload,'ELOOZI-VISUAL-ONLY-NOT-A-PAYMENT');
  assert.equal(c.after.dialogCount,0);assert.ok(c.after.focusReturned);assert.equal(c.after.body,c.before.body);assert.equal(c.after.root,c.before.root);
  for(const p of Object.values(c.captures))assert.ok(fs.statSync(p).size>1000);
 }
 assert.ok(e.cases.some(c=>c.closeMethod==='escape')&&e.cases.some(c=>c.closeMethod==='x'));
 assert.ok(s.pageUnchanged&&s.originalStylesUnchanged&&s.otherComponents.every(c=>c.unchanged));
 for(const source of s.sources)assert.equal(hash(source.path),source.sha256);
 for(const source of read('docs/pix-modal-preserved.json')){assert.ok(source.unchanged||s.workspaceDifferences.includes(source.path));assert.equal(hash(source.path),source.sha256);}
 for(const name of ['typecheck','build','tests'])assert.match(fs.readFileSync(`docs/pix-modal-${name}.log`,'utf8'),/EXIT_CODE=0/);
 console.log('PASS: 12 PIX viewport/theme/CSS-zoom cases; close visible, CTA reachable, internal scroll, background lock, focus, Escape/X and restoration.');
 console.log('PASS: source preservation, 41 tests and typecheck/build. No native zoom or authenticated integration claimed.');
}catch(error){console.error('FAIL:',error.message);process.exitCode=1;}

// Verifies recorded browser geometry and source hashes; does not rerun the browser.
import fs from 'node:fs';import crypto from 'node:crypto';import assert from 'node:assert/strict';
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
try{
 const e=read('docs/banner-position-browser.json'),s=read('docs/banner-position-scope.json');
 assert.ok(e.isolated&&!e.authenticated);assert.equal(e.cases.length,24);
 const before=e.cases.filter(c=>c.phase==='before'),after=e.cases.filter(c=>c.phase==='after');assert.equal(before.length,4);assert.equal(after.length,20);
 for(const c of after){assert.equal(c.scrollWidth,c.clientWidth);assert.ok(c.draw.top>=c.header.bottom);assert.ok(c.summary.top>=c.banner.bottom);assert.ok(c.draw.right<=c.clientWidth+1);if(c.notice)assert.ok(c.draw.top>=c.notice.bottom);else assert.ok(Math.abs(c.draw.top-c.header.bottom)<.1);assert.equal(c.source,'/landing/planos/banner-top.png');assert.ok(fs.statSync(c.capture).size>1000);}
 for(const b of before){const a=after.find(c=>c.width===b.width&&c.theme===b.theme&&c.scenario===b.scenario&&c.restaurant===b.restaurant);assert.ok(a);assert.ok(Math.abs(a.draw.width-b.draw.width)<.1);assert.ok(Math.abs(a.draw.height-b.draw.height)<.1);assert.ok(b.draw.top-b.header.bottom>10);assert.ok(fs.statSync(b.capture).size>1000);}
 assert.ok(s.assetUnchanged&&s.paidBannersUnchanged&&s.onlyCssPaddingChanged&&s.checks.every(c=>c.unchanged));assert.equal(hash('public/landing/planos/banner-top.png'),s.assetSHA256);
 for(const f of s.sources)assert.equal(hash(f.path),f.sha256);
 for(const n of ['typecheck','build'])assert.match(fs.readFileSync(`docs/banner-position-${n}.log`,'utf8'),/EXIT_CODE=0/);
 console.log('PASS: 4 before + 20 after observations; zero blank header gap without notices; unchanged image size/hash, no overlap/overflow, trial notices preserved.');
 console.log('PASS: CheckoutShell/paid banners/cards/icons unchanged; typecheck/build exit 0. Isolated bench, not authenticated production.');
}catch(error){console.error('FAIL:',error.message);process.exitCode=1;}

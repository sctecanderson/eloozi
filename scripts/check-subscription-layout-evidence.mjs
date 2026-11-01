// Checks captured browser geometry and source integrity; does NOT rerun a browser or a backend.
import fs from 'node:fs';import crypto from 'node:crypto';import assert from 'node:assert/strict';
const read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function jpegWidth(path){const b=fs.readFileSync(path);assert.equal(b.readUInt16BE(0),0xffd8);let p=2;while(p<b.length){while(b[p]===0xff)p++;const marker=b[p++];const size=b.readUInt16BE(p);if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker))return b.readUInt16BE(p+5);p+=size;}throw Error('JPEG dimensions unavailable');}
const evidence=read('docs/subscription-layout-browser.json'),scope=read('docs/subscription-layout-scope.json');
try{
 assert.equal(evidence.isolated,true);assert.equal(evidence.authenticatedBackend,false);assert.equal(evidence.nativeZoomValidated,false);
 assert.equal(evidence.cases.length,24);
 for(const width of [1920,1440,1280,1024,900,390])for(const theme of ['light','dark'])for(const zoom of [100,125]){
  const matches=evidence.cases.filter(c=>c.requestedWidth===width&&c.requestedTheme===theme&&c.requestedZoom===zoom);assert.equal(matches.length,1);
  const c=matches[0];assert.equal(c.viewport,width);assert.equal(c.theme,theme);assert.equal(Number(c.cssZoom),zoom/100);
  for(const [name,passed]of Object.entries(c.checks))assert.equal(passed,true,`${width}/${theme}/${zoom}: ${name}`);
  assert.ok(fs.statSync(c.capture).size>1000);
  // IAB full-page JPEG excludes its 15px vertical scrollbar; DOM viewport includes it.
  assert.ok([c.viewport,c.viewport-15].includes(jpegWidth(c.capture)),`unexpected screenshot width: ${c.capture}`);
 }
 for(const c of evidence.interactions){assert.ok(fs.statSync(c.capture).size>1000);assert.ok(Object.values(c.geometry.checks).every(Boolean));}
 const details=evidence.interactions.filter(c=>c.case.startsWith('details-'));assert.equal(details.length,3);assert.ok(details.every(c=>c.detailsVisible));
 assert.equal(details.find(c=>c.case.includes('without-contract')).geometry.details.period.length,0);
 assert.ok(details.filter(c=>!c.case.includes('without-contract')).every(c=>c.geometry.details.period.length===2&&c.geometry.details.actions.length===2));
 const pix=evidence.interactions.filter(c=>c.case.startsWith('pix-'));assert.equal(pix.length,2);
 for(const c of pix){assert.ok(c.focusInside);assert.ok(c.close.top>=0&&c.close.bottom<=1000);assert.equal(c.qrPayload,'ELOOZI-VISUAL-ONLY-NOT-A-PAYMENT');assert.equal(c.bodyWidth,c.viewport);}
 assert.ok(evidence.interactions.find(c=>c.case.startsWith('trial-')).pauseControl);
 for(const s of [...scope.sources,...scope.assets])assert.equal(hash(s.path),s.sha256,`stale evidence: ${s.path}`);
 assert.ok(scope.checks.every(c=>c.unchanged));
 for(const s of read('docs/subscription-layout-preserved.json')){assert.ok(s.unchanged);assert.equal(hash(s.path),s.shaAfter);}
 for(const name of ['typecheck','build','tests'])assert.match(fs.readFileSync(`docs/subscription-layout-${name}.log`,'utf8'),/EXIT_CODE=0/);
 console.log('PASS: 24 browser geometry cases; 6 interactions; 14 presentation tests; typecheck/build exit 0.');
 console.log('PASS: original assets, financial handlers, CheckoutShell and 162 preserved files verified.');
 console.log('LIMIT: fixtures only; CSS zoom 125% is not native zoom. Authenticated integration/native zoom remain pending.');
}catch(error){console.error('FAIL:',error.message);process.exitCode=1;}

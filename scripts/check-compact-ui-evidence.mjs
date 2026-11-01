// Checks recorded real-browser observations, not CSS class names or simulated timers.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'..');const lines=[];
const read=name=>JSON.parse(fs.readFileSync(path.join(root,'docs',name),'utf8'));
function ok(condition,label){assert.ok(condition,label);lines.push('PASS: '+label);}
const x=s=>s.transform==='none'?0:Number(s.transform.match(/matrix\((.*)\)/)?.[1].split(',')[4]);
function pauseResume(file,kind){
 const samples=read(file),paused=samples.filter(s=>s.state==='paused');ok(paused.length>1,kind+' freezes across multiple samples');
 ok(paused.every(s=>s.time===paused[0].time&&s.transform===paused[0].transform),kind+' keeps time and transform unchanged');
 const resumed=samples.find(s=>s.ms>paused.at(-1).ms&&s.state==='running');
 ok(resumed&&Math.abs(resumed.time-paused.at(-1).time)<1,kind+' resumes from same point');
 return paused;
}
try{
 const scope=read('compact-ui-scope.json');ok(scope.checks.every(c=>c.unchanged),'protected backend/migrations/billing handlers and critical alert layout unchanged');
 const full=read('compact-ui-full-cycle-trace.json');const first=full.find(s=>s.keyframes&&s.timing);
 ok(first,'actual browser keyframes recorded');ok(Math.abs((first.keyframes[2].offset-first.keyframes[1].offset)*first.timing.duration-4000)<0.01,'actual centered keyframes hold for 4000 ms');
 const sequence=full.filter((s,i)=>!i||s.text!==full[i-1].text).map(s=>s.text);
 ok(new Set(sequence.slice(0,3)).size===3&&sequence[3]===sequence[0],'all three messages rotate and wrap to first');
 ok(full.filter(s=>s.time>650&&s.time<4550).every(s=>x(s)===0),'messages remain centered during hold');
 const center=pauseResume('compact-ui-motion-pause-resume-trace.json','hover at center');ok(center.some(s=>s.hover)&&center.every(s=>x(s)===0),'hover freezes center');
 const moving=pauseResume('compact-ui-exit-pause-trace.json','hover while moving');ok(moving.some(s=>x(s)<0),'hover also freezes a translated outgoing message');
 const focus=pauseResume('compact-ui-focus-trace.json','keyboard focus');ok(focus.some(s=>s.focus&&!s.hover),'focus pauses independently of pointer');
 const reduced=read('compact-ui-reduced-trace.json');ok(reduced.length>1&&reduced.every(s=>s.state==='none'&&s.transform==='none')&&new Set(reduced.map(s=>s.text)).size===1,'reduced-motion fixture has no animation or automatic change');
 const manual=read('compact-ui-manual-pause-trace.json').filter(s=>s.ms>2500);ok(manual.length>1&&manual.every(s=>s.state==='paused'&&!s.hover&&!s.focus),'explicit pause persists outside the band');
 const evidence=read('compact-ui-browser.json'),cases=evidence.cases;
 ok(cases.filter(c=>'overflow'in c).every(c=>!c.overflow),'desktop/mobile observations have no page horizontal overflow');
 ok(cases.find(c=>c.scenario==='reduced-light-mobile')?.manualChange,'manual navigation changes reduced-motion message');
 ok(cases.find(c=>c.scenario==='premium-light-mobile')?.bandCount===0,'confirmed Premium hides global band');
 ok(cases.find(c=>c.scenario==='premium-light-mobile')?.note.includes('dias gratuitos'),'Premium paid-period note remains in card');
 ok(cases.find(c=>c.scenario==='finite-light-mobile')?.progress===1&&cases.find(c=>c.scenario==='finite-light-mobile')?.percent==='60','finite capacity keeps accessible percentage');
 ok(cases.filter(c=>c.scenario.startsWith('basic-')).every(c=>c.progress===0),'unlimited capacity has no percentage bar');
 ok(cases.filter(c=>c.financial).every(c=>c.financial.includes('R$ 179,90')&&c.financial.includes('R$ 99,90')&&c.financial.includes('R$ 80,00')),'all financial snapshots preserve displayed amounts');
 ok(cases.find(c=>c.scenario==='basic-light-desktop')?.live===0,'no live announcement region in rotating band');
 ok(cases.find(c=>c.scenario==='manual-resume')?.released===true&&cases.find(c=>c.scenario==='manual-resume')?.autoChanged===true,'explicit resume releases pause and restarts automatic rotation');
 lines.push('RESULTADO FINAL: PASS — isolated browser, fictitious server snapshots; no authenticated integration.');
}catch(err){lines.push('FAIL: '+err.message);process.exitCode=1;}
fs.writeFileSync(path.join(root,'docs/compact-ui-evidence.log'),lines.join('\n')+'\n');console.log(lines.join('\n'));

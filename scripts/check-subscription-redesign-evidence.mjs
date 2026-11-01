// Verifies recorded browser evidence. Does not contact a backend or issue a payment.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'..'),lines=[];
const read=p=>JSON.parse(fs.readFileSync(path.join(root,'docs',p),'utf8'));
const compact=s=>s.replace(/\s/g,'');
function ok(b,label){assert.ok(b,label);lines.push('PASS: '+label);}
try{
 const scope=read('subscription-redesign-scope.json');ok(scope.checks.every(c=>c.unchanged),'recorded comparison preserves protected code, trial strip and migrations');
 for(const s of scope.ui_sources)ok(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,s.path))).digest('hex').toUpperCase()===s.sha256,'recorded evidence matches current UI source: '+s.path);
 ok(scope.assets.length===4,'all four supplied banners included');
 for(const a of scope.assets)ok(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,a.path))).digest('hex').toUpperCase()===a.sha256,'banner checksum: '+a.path);
 const evidence=read('subscription-redesign-browser.json'),cases=evidence.cases,final=cases.filter(c=>c.case==='final-pix');
 ok(evidence.isolated&&!evidence.authenticatedBackend&&!evidence.qrPayable,'evidence explicitly identifies isolated mocked transport');
 ok(final.length===12&&new Set(final.map(c=>[c.plan,c.theme,c.viewport].join('/'))).size===12,'three plans × two themes × desktop/mobile captured in final UI');
 ok(final.every(c=>c.width===(c.viewport==='desktop'?1280:390)),'viewport widths match capture labels');
 ok(final.every(c=>!c.overflow),'no page horizontal overflow in final checkout matrix');
 ok(final.every(c=>c.focusInside&&c.closeCount===1),'focus stays inside and exactly one real close control is present');
 ok(final.every(c=>c.close.top>=0&&c.close.bottom<=c.height),'close control remains within viewport after internal scrolling');
 ok(final.every(c=>!c.financial.includes('Crédito')&&c.financial.includes('Valor a pagar agora')),'first purchases do not masquerade as upgrades');
 ok(final.every(c=>c.payload==='ELOOZI-VISUAL-ONLY-NOT-A-PAYMENT'),'QR payload is simulated and not payable');
 const monthly=cases.find(c=>c.case==='upgrade-monthly'),yearly=cases.find(c=>c.case==='upgrade-yearly'),firstYear=cases.find(c=>c.case==='first-yearly');
 ok(['R$279,90','R$99,90','R$180,00'].every(v=>compact(monthly.financial).includes(v)),'monthly upgrade displays quoted price, confirmed credit and difference');
 ok(['R$3.078,90','R$1.098,90','R$1.980,00'].every(v=>compact(yearly.financial).includes(v)),'annual upgrade displays annual amounts, not a 30-day amount');
 ok(monthly.financial.includes('após o teste')&&yearly.financial.includes('mantido'),'future preserved period is labeled correctly');
 ok(compact(firstYear.financial).includes('R$1.098,90')&&!firstYear.financial.includes('Crédito'),'first annual purchase has full annual price and no invented credit');
 ok(cases.find(c=>c.case==='copy')?.copied===true,'copy action writes the simulated payload to clipboard');
 ok(cases.filter(c=>c.case==='escape-restore').every(c=>c.dialogs===0&&c.article?.startsWith('Plano ')),'Escape closes and returns focus to opening plan');
 ok(cases.find(c=>c.case==='focus-back')?.inside&&cases.find(c=>c.case==='focus-forward')?.active==='Fechar checkout','Tab and Shift+Tab wrap inside checkout');
 ok(cases.find(c=>c.case==='success-focus-fallback')?.valid===true,'success returns focus to details when opening plan is now disabled');
 ok(cases.find(c=>c.case==='pending')?.success===false,'pending payment does not announce success');
 ok(cases.find(c=>c.case==='period-switch-blocked')?.dialogs===0,'unsupported periodicity remains blocked before checkout');
 ok(cases.find(c=>c.case==='error')?.alert?.includes('Falha simulada'),'error remains visible in checkout');
 ok(cases.find(c=>c.case==='reconcile')?.alert?.includes('reconciliação'),'reconciliation remains visible without false success');
 ok(cases.find(c=>c.case==='success')?.body?.includes('Pagamento confirmado'),'mock server confirmation drives success state');
 ok(cases.find(c=>c.case==='card-form')?.selects>0,'saved/new card selector preserved');
 ok(cases.find(c=>c.case==='details')?.open&&cases.find(c=>c.case==='details')?.renew,'current plan details and renewal action preserved');
 ok(cases.find(c=>c.case==='receipt')?.text?.includes('99,90'),'existing receipt remains available');
 ok(cases.find(c=>c.case==='premium-confirmed-note')?.globalTrial===0&&cases.find(c=>c.case==='premium-confirmed-note')?.note?.includes('dias gratuitos'),'Premium confirmation keeps note visible without global trial strip');
 ok(cases.filter(c=>c.case==='final-page').length===4&&cases.filter(c=>c.case==='final-page').every(c=>!c.overflow&&c.topAsset==='/landing/planos/banner-top.png'),'final page verified in both themes and widths');
 lines.push('RESULTADO FINAL: PASS — visual bench only; no authenticated integration or real payments.');
}catch(err){lines.push('FAIL: '+err.message);process.exitCode=1;}
fs.writeFileSync(path.join(root,'docs/subscription-redesign-evidence.log'),lines.join('\n')+'\n');console.log(lines.join('\n'));

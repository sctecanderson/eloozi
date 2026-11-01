import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {NOTICE_TIMING,nextNotice,noticePaused,premiumTrialNote,subscriptionNotices} from '../src/features/billing/subscriptionNotices.ts';
const now=Date.parse('2031-02-01T10:00:00Z');
const trial={known_trial:true,trial_active:true,original_trial_end:new Date(now+120*3600000).toISOString(),paid_start:new Date(now+120*3600000).toISOString(),plan:'premium',billing_status:'active'};
describe('Apresentação de avisos de assinatura',()=>{
 it('sem prova/fora do trial não inventa benefício nem regularização rotativa',()=>{assert.deepEqual(subscriptionNotices(),[]);assert.deepEqual(subscriptionNotices({...trial,known_trial:false}),[]);assert.deepEqual(subscriptionNotices({...trial,trial_active:false,billing_status:'expired'}),[]);});
 it('trial sem compra usa prazo fornecido, experiência Premium e convite',()=>{const messages=subscriptionNotices(trial,now);assert.equal(messages.length,3);assert.match(messages[1],/120 horas restantes/);assert.match(messages[2],/Escolha seu plano/);assert.match(subscriptionNotices({...trial,original_trial_end:new Date(now+3600000).toISOString()},now)[1],/1 hora restante/);});
 it('Básico confirmado informa início real e perdas; Pro conserva KDS',()=>{const basic=subscriptionNotices({...trial,contracted_plan:'basic'},now);assert.match(basic[1],/Básico contratado/);assert.match(basic[2],/sem KDS, Estoque e Financeiro/);const pro=subscriptionNotices({...trial,contracted_plan:'pro'},now);assert.match(pro[1],/Profissional contratado/);assert.match(pro[2],/KDS incluído/);});
 it('Premium confirmado não gera faixa e ganha nota de dias preservados',()=>{const e={...trial,contracted_plan:'premium' as const};assert.deepEqual(subscriptionNotices(e),[]);assert.match(premiumTrialNote(e)!,/dias gratuitos foram preservados/);assert.equal(premiumTrialNote({...e,trial_active:false}),null);});
 it('datas ausentes/inválidas não são reconstruídas',()=>{assert.deepEqual(subscriptionNotices({...trial,original_trial_end:'inválido'}),[]);assert.equal(premiumTrialNote({...trial,contracted_plan:'premium',paid_start:null}),null);});
 it('qualquer motivo de pausa domina a retomada, sem perder pausa explícita',()=>{for(let mask=0;mask<16;mask++){const flags=[0,1,2,3].map(i=>Boolean(mask&(1<<i)));assert.equal(noticePaused(flags[0],flags[1],flags[2],flags[3]),mask!==0);}});
 it('ciclo avança e retrocede sem índice inválido; parada central de quatro segundos',()=>{assert.equal(nextNotice(2,1,3),0);assert.equal(nextNotice(0,-1,3),2);assert.equal(nextNotice(7,0,3),1);assert.equal(nextNotice(0,1,0),0);assert.equal(NOTICE_TIMING.hold,4000);assert.equal(NOTICE_TIMING.total,NOTICE_TIMING.travel*2+NOTICE_TIMING.hold);});
 it('gerar mensagens não modifica o snapshot financeiro',()=>{const e={...trial,contracted_plan:'pro' as const};const before=JSON.stringify(e);subscriptionNotices(e,now);premiumTrialNote(e);assert.equal(JSON.stringify(e),before);});
});

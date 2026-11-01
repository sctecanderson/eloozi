import {describe,it} from 'node:test';import assert from 'node:assert/strict';
import {planAsset,visibleContractPlan,checkoutPeriodLabel,dialogBoundary,contractResources,contractTitleAsset,contractFeatureIcon,contractDetailResources} from '../src/features/billing/subscriptionPresentation.ts';
const e={known_trial:true,trial_active:true,contracted_plan:null,plan:'premium',billing_status:'active'};
describe('Redesign de apresentação da assinatura',()=>{
 it('deduplica recursos e capacidade sem inventar ou fundir limites diferentes',()=>{assert.deepEqual(contractResources('Mesas simultâneas ilimitadas',['Mesas ilimitadas',' KDS Cozinha e Bar ','KDS  Cozinha e Bar','','Financeiro']),['Mesas simultâneas ilimitadas','KDS Cozinha e Bar','Financeiro']);assert.deepEqual(contractResources('Até 5 mesas simultâneas',['Até 5 mesas','Até 20 mesas']),['Até 5 mesas simultâneas','Até 20 mesas']);});
 it('usa os quatro assets fornecidos para cada destino',()=>{assert.equal(planAsset(),'/landing/planos/banner-top.png');assert.equal(planAsset('basic'),'/landing/planos/banner-basico.png');assert.equal(planAsset('pro'),'/landing/planos/banner-profissional.png');assert.equal(planAsset('premium'),'/landing/planos/banner-premium.png');});
 it('Premium gratuito não impede primeira contratação de Premium',()=>assert.equal(visibleContractPlan('premium',e),null));
 it('separa contrato confirmado de experiência efetiva',()=>{assert.equal(visibleContractPlan('premium',{...e,contracted_plan:'basic'}),'basic');assert.equal(visibleContractPlan('premium',{...e,contracted_plan:'pro'}),'pro');});
 it('preserva plano atual fora do trial comprovado',()=>{assert.equal(visibleContractPlan('basic'), 'basic');assert.equal(visibleContractPlan('pro',{...e,known_trial:false}),'pro');assert.equal(visibleContractPlan('premium',{...e,trial_active:false}),'premium');});
 it('rótulo de período futuro só aparece em trial comprovado vigente',()=>{assert.match(checkoutPeriodLabel(e),/após o teste/);assert.doesNotMatch(checkoutPeriodLabel({...e,trial_active:false}),/após o teste/);assert.doesNotMatch(checkoutPeriodLabel(),/após o teste/);});
 it('contém foco nos limites, preservando navegação interior e ausência de candidatos',()=>{assert.equal(dialogBoundary(0,4,true),3);assert.equal(dialogBoundary(3,4,false),0);assert.equal(dialogBoundary(1,4,false),null);assert.equal(dialogBoundary(0,0,true),null);});
});

describe('Assets do contrato atual',()=>{
 it('seleciona um único título pelo contrato e nenhum no trial sem compra',()=>{
  assert.equal(contractTitleAsset(visibleContractPlan('premium',e)),null);
  for(const [id,file] of [['basic','basico'],['pro','profissional'],['premium','premium']] as const){assert.equal(contractTitleAsset(visibleContractPlan('premium',{...e,contracted_plan:id})), '/landing/planos/icons/'+file+'.png');}
 });
 it('associa desenhos aos rótulos sem alterar recursos do catálogo',()=>{
  for(const [label,icon] of [['Até 5 mesas simultâneas','person-icon'],['Cardápio digital e comandas','menu-icon'],['KDS Cozinha e Bar','cheff-icon'],['Gestão de Estoque e Insumos','box-icon'],['Financeiro e Fechamento de Caixa','up-icon'],['Benefício adicional do catálogo','card-icon']])assert.equal(contractFeatureIcon(label),icon);
 });
});

describe('Recursos compactos do contrato',()=>{
 const catalog={basic:{features:['Até 5 mesas simultâneas','Cardápio Digital com QR Code','Pedidos e comandas em tempo real']},pro:{features:['Até 20 mesas simultâneas','Tudo do plano Básico','KDS Cozinha e Bar']},premium:{features:['Mesas simultâneas ilimitadas','Tudo do plano Profissional','Gestão de Estoque e Insumos','Financeiro e Fechamento de Caixa']}};
 it('expande apenas herança explícita e mostra os cinco recursos Premium',()=>assert.deepEqual(contractDetailResources('Mesas simultâneas ilimitadas','premium',catalog),['Mesas simultâneas ilimitadas','Cardápio digital e comandas','KDS Cozinha e Bar','Estoque e Insumos','Financeiro']));
 it('Basic e Pro não recebem recursos dos planos superiores nem limites herdados',()=>{assert.deepEqual(contractDetailResources('Até 5 mesas simultâneas','basic',catalog),['Até 5 mesas simultâneas','Cardápio digital e comandas']);assert.deepEqual(contractDetailResources('Até 20 mesas simultâneas','pro',catalog),['Até 20 mesas simultâneas','Cardápio digital e comandas','KDS Cozinha e Bar']);});
 it('não adivinha herança por id do plano e preserva recurso desconhecido',()=>assert.deepEqual(contractDetailResources('Sem limite','premium',{premium:{features:['Benefício específico']}}),['Sem limite','Benefício específico']));
 it('recusa herança para cima e não inventa recursos ausentes do catálogo',()=>{assert.deepEqual(contractDetailResources('5 mesas','basic',{basic:{features:['Tudo do plano Profissional']},pro:catalog.pro}),['5 mesas','Tudo do plano Profissional']);assert.deepEqual(contractDetailResources('Sem limite','premium',{}),['Sem limite']);});
});

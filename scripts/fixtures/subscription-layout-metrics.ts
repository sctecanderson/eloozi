// Browser-only diagnostics for the disposable local bench. Never imported by production.
export function installLayoutMetrics(){
 const output=document.createElement('output');output.id='subscription-layout-observation';output.hidden=true;document.body.append(output);
 setInterval(()=>{
  const one=(selector:string)=>document.querySelector<HTMLElement>(selector);
  const rect=(element:Element|null)=>element?element.getBoundingClientRect().toJSON():null;
  const all=(selector:string)=>Array.from(document.querySelectorAll<HTMLElement>(selector));
  const banner=one('.plan-art-top'),overview=one('.subscription-overview'),cards=one('.plan-cards'),facts=one('.plan-facts'),details=one('.current-contract');
  if(!banner||!overview||!cards||!facts)return;
  const boxes=all('.subscription-plan').map(rect),side=rect(facts),grid=rect(cards);
  const visible=(n:HTMLElement)=>n.getBoundingClientRect().width>0;
  const textOverflow=all('.overview-copy,.subscription-plan h3,.plan-price,.plan-billing,.plan-select,.plan-facts p,.plans-choice-heading h2,.plans-cycle').filter(visible).filter(n=>n.scrollWidth>n.clientWidth+1).map(n=>({text:n.textContent,client:n.clientWidth,scroll:n.scrollWidth}));
  const sideAtRight=side.left>=grid.right-1;
  output.textContent=JSON.stringify({viewport:innerWidth,clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,dpr:devicePixelRatio,cssZoom:getComputedStyle(document.documentElement).zoom,theme:document.documentElement.classList.contains('dark')?'dark':'light',scenario:new URLSearchParams(location.search).get('scenario')??'premium',
   header:rect(one('.admin-topbar')),sidebar:rect(one('.admin-sidebar')),banner:rect(banner),overview:rect(overview),cells:all('.overview-cell').map(rect),planHeading:rect(one('.plans-choice-heading')),toggle:rect(one('.plans-cycle')),cards:grid,planBoxes:boxes,facts:side,factRows:all('.plan-facts>div').map(rect),
   checks:{noPageOverflow:document.documentElement.scrollWidth<=document.documentElement.clientWidth+1,noTextOverflow:textOverflow.length===0,noBannerOverlap:rect(banner).bottom<=rect(overview).top+1,
    onlyOriginalBanner:banner.querySelectorAll('image').length===1&&banner.querySelectorAll('p,div,span').length===0,
    sidePlacement:sideAtRight?Math.abs(side.top-grid.top)<1&&Math.abs(side.bottom-grid.bottom)<1:side.top>=grid.bottom,
    fiveFacts:facts.children.length===5,headingAligned:Math.abs(rect(one('.plans-choice-heading')).left-grid.left)<1&&rect(one('.plans-cycle')).right<=grid.right+1,
    accessibleTitle:one('h1')?.textContent==='Assinatura & Planos'&&one('h1').clientHeight<=1&&one('h1').clientWidth<=1,
    noRepeatedIndicators:!details||!['Próximo vencimento','Mesas em uso','Produtos no cardápio','Pagamento por contratação'].some(text=>details.textContent?.includes(text)),
    summaryHasNoPaidNote:!overview.textContent?.includes('dias gratuitos'),unlimitedHasNoProgress:!overview.querySelector('[role="progressbar"],progress'),
    planBoxesDoNotOverlap:boxes.every((a,i)=>boxes.every((b,j)=>i===j||a.right<=b.left+1||a.left>=b.right-1||a.bottom<=b.top+1||a.top>=b.bottom-1))},
   textOverflow,details:details?{text:details.textContent,period:all('.contract-period dd').map(n=>n.textContent),actions:all('.contract-actions button').map(n=>n.textContent?.trim())}:null,
   typography:{factFont:getComputedStyle(facts).fontSize,factTitleDisplay:getComputedStyle(facts.querySelector('b')).display,factCopyLineHeight:getComputedStyle(facts.querySelector('div>div')).lineHeight,factParagraphMargin:getComputedStyle(facts.querySelector('p')).margin,cardHeight:grid.height}});
 },200);
}

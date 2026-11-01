import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {Link} from 'react-router';
import {useRestaurant} from '../restaurants/RestaurantProvider';
import {NOTICE_TIMING,nextNotice,noticePaused,premiumTrialNote,subscriptionNotices} from './subscriptionNotices';
export interface EffectiveSubscription {
 known_trial:boolean;trial_active:boolean;original_trial_start?:string;original_trial_end?:string;
 contracted_plan?:'basic'|'pro'|'premium'|null;paid_start?:string|null;paid_end?:string|null;
 plan:string;billing_status:string;
}
function useReducedMotion(){
 const [reduced,setReduced]=useState(()=>typeof window!=='undefined'&&window.matchMedia('(prefers-reduced-motion: reduce)').matches);
 useEffect(()=>{const media=window.matchMedia('(prefers-reduced-motion: reduce)');const change=()=>setReduced(media.matches);media.addEventListener('change',change);return ()=>media.removeEventListener('change',change);},[]);
 return reduced;
}
export function TrialBanner(){
 const {restaurant:r}=useRestaurant();const messages=subscriptionNotices(r.effectiveSubscription);const signature=messages.join('\n');
 const [index,setIndex]=useState(0);const [userPaused,setUserPaused]=useState(false);const [hover,setHover]=useState(false);const [focus,setFocus]=useState(false);
 const reduced=useReducedMotion();const paused=noticePaused(userPaused,hover,focus,reduced);const pausedRef=useRef(paused);pausedRef.current=paused;
 const text=useRef<HTMLDivElement>(null);const animation=useRef<Animation|null>(null);const manualCenter=useRef(false);const description=useId();const current=nextNotice(index,0,messages.length);
 useLayoutEffect(()=>{
  if(!text.current||reduced||messages.length<2)return;
  const {travel,hold,total}=NOTICE_TIMING;
  const motion=text.current.animate([{transform:'translateX(100%)',opacity:0,offset:0},{transform:'translateX(0)',opacity:1,offset:travel/total},{transform:'translateX(0)',opacity:1,offset:(travel+hold)/total},{transform:'translateX(-100%)',opacity:0,offset:1}],{duration:total,easing:'linear',fill:'both'});
  animation.current=motion;if(manualCenter.current){motion.currentTime=travel;manualCenter.current=false;}if(pausedRef.current)motion.pause();
  motion.onfinish=()=>setIndex(i=>nextNotice(i,1,messages.length));
  return ()=>{motion.onfinish=null;motion.cancel();animation.current=null;};
 },[current,signature,reduced]);
 useLayoutEffect(()=>{if(paused)animation.current?.pause();else animation.current?.play();},[paused]);
 if(!messages.length)return null;
 const move=(delta:number)=>{manualCenter.current=true;setIndex(i=>nextNotice(i,delta,messages.length));};
 const buttonStyle='inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600';
 return <aside aria-label="Informações do teste Premium" aria-describedby={description} className="mx-4 mt-3 flex min-w-0 items-center gap-1 rounded-xl border border-zinc-200 bg-zinc-50 px-2 py-2 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-200"
  onMouseEnter={()=>{animation.current?.pause();setHover(true);}} onMouseLeave={()=>setHover(false)}
  onFocusCapture={()=>{animation.current?.pause();setFocus(true);}} onBlurCapture={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setFocus(false);}}>
  {/* Static accessible description; rotating text never becomes a live announcement. */}
  <ul id={description} className="sr-only">{messages.map(m=><li key={m}>{m}</li>)}</ul>
  <div className="relative min-w-0 flex-1 overflow-hidden" aria-hidden="true" data-notice-viewport>
   <div className="grid invisible text-center text-xs leading-5 sm:text-sm">{messages.map(m=><p className="col-start-1 row-start-1 px-1" key={m}>{m}</p>)}</div>
   <div ref={text} data-notice-message className="absolute inset-0 flex items-center justify-center px-1 text-center text-xs leading-5 sm:text-sm">{messages[current]}</div>
  </div>
  <div className="flex shrink-0 items-center">
   <button type="button" className={buttonStyle} aria-label="Mensagem anterior" onClick={()=>move(-1)}>‹</button>
   {!reduced&&<button type="button" className={buttonStyle} aria-label={userPaused?'Retomar mensagens':'Pausar mensagens'} aria-pressed={userPaused} onClick={()=>setUserPaused(p=>!p)}><span aria-hidden="true">{userPaused?'▶':'Ⅱ'}</span></button>}
   <button type="button" className={buttonStyle} aria-label="Próxima mensagem" onClick={()=>move(1)}>›</button>
   <Link to={`/${r.slug}/admin/assinatura`} className={`${buttonStyle} sm:w-auto sm:px-2 font-semibold text-red-800 dark:text-red-300`} aria-label={r.effectiveSubscription?.contracted_plan?'Ver Assinatura & Planos':'Escolher plano'}><span className="hidden sm:inline">Ver planos</span><span className="sm:hidden" aria-hidden="true">↗</span></Link>
  </div>
 </aside>;
}
export function PremiumTrialNote(){const {restaurant:r}=useRestaurant();const note=premiumTrialNote(r.effectiveSubscription);return note?<p className="mt-2 text-xs leading-5 text-zinc-600 dark:text-zinc-300">{note}</p>:null;}
import {useEffect,useState,type ReactNode} from 'react';
import {Link} from 'react-router';
import {fetchModuleAccess,type ModuleAccess} from './moduleAccessService';
import {useRestaurant} from './RestaurantProvider';
export function useModuleAccess(restaurantId:string){
 const {restaurant}=useRestaurant();
 const key = `${restaurantId}:${restaurant.revision}:${restaurant.subscriptionPlan}`;
 const [state,setState]=useState<{id:string;data:ModuleAccess|null;error:string}>({id:key,data:null,error:''});
 useEffect(()=>{
  let live=true;
  setState({id:key,data:null,error:''});
  void (async()=>{
   try {
    const data=await fetchModuleAccess(restaurantId);
    if(live)setState({id:key,data,error:''});
   }catch{if(live)setState({id:key,data:null,error:'Não foi possível verificar o contrato. Tente recarregar.'});}
  })();
  return()=>{live=false;};
 },[restaurantId,key]);
 return state.id===key?state:{id:key,data:null,error:''};
}
export function ModuleGate({module,children}:{module:'inventory'|'finance';children:ReactNode}){
 const {restaurant}=useRestaurant();const {data,error}=useModuleAccess(restaurant.id);
 if(!data)return <section role="status" className="p-6">{error||'Verificando acesso ao recurso…'}</section>;
 if(!data[module])return <section className="p-6 space-y-3"><h1 className="text-xl font-bold">Recurso não incluído</h1><p>Este módulo não está disponível no seu contrato ou para seu cargo.</p><Link className="underline" to={`/${restaurant.slug}/admin/assinatura`}>Assinatura &amp; Planos</Link></section>;
 return children;
}

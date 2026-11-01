import {supabase} from '../../lib/supabase';
export type ModuleAccess={model:string;inventory:boolean;finance:boolean};
type AccessClient={rpc:(name:string,args:{p_restaurant_id:string})=>PromiseLike<{data:unknown;error:unknown}>};
export async function fetchModuleAccess(restaurantId:string,client:AccessClient=supabase):Promise<ModuleAccess>{
 const {data,error}=await client.rpc('get_restaurant_module_access',{p_restaurant_id:restaurantId});
 const access=data as ModuleAccess|null;
 if(error || !access || !['legacy','commercial_v1'].includes(access.model) || typeof access.inventory!=='boolean' || typeof access.finance!=='boolean')throw new Error('Não foi possível verificar o contrato. Tente recarregar.');
 return access;
}

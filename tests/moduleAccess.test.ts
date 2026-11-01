import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fetchModuleAccess} from '../src/features/restaurants/moduleAccessService.ts';
test('access wire sends only target UUID, preserving the server decision',async()=>{
 const id='b7000000-0000-4000-8000-000000000003';
 const actual=await fetchModuleAccess(id,{rpc:async(name,args)=>{assert.equal(name,'get_restaurant_module_access');assert.deepEqual(args,{p_restaurant_id:id});return{data:{model:'commercial_v1',inventory:false,finance:false},error:null};}});
 assert.equal(actual.inventory,false);assert.equal(actual.finance,false);
});
test('unknown model and incomplete decisions fail closed',async()=>{
 for(const data of [null,{model:'unknown',inventory:true,finance:true},{model:'legacy',inventory:true}])await assert.rejects(fetchModuleAccess('target',{rpc:async()=>({data,error:null})}));
});
test('RPC and transport failures never authorize a module',async()=>{
 await assert.rejects(fetchModuleAccess('target',{rpc:async()=>({data:{model:'legacy',inventory:true,finance:true},error:{message:'denied'}})}));
 await assert.rejects(fetchModuleAccess('target',{rpc:async()=>{throw Error('offline');}}));
});

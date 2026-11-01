export function TableCapacity({used,unlimited,limit,percent}:{used:number;unlimited:boolean;limit:number|null;percent:number}){
 return <div>
  <p className="mt-2 text-base font-extrabold leading-tight text-zinc-900 dark:text-white">{unlimited?`${used} em uso`:`${used} / ${limit}`}</p>
  {unlimited?<p className="mt-2 text-xs font-medium text-zinc-600 dark:text-zinc-300">Sem limite de mesas</p>:<>
   <div className="mb-1 mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700" role="progressbar" aria-label="Mesas em uso" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
    <div className="h-full rounded-full bg-[#610000]" style={{width:`${percent}%`}}/>
   </div>
   <p className="text-[11px] font-medium text-zinc-600 dark:text-zinc-300">{percent}% do limite contratado utilizado</p>
  </>}
 </div>;
}

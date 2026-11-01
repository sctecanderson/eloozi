// Server quote values, already formatted: no credit/payment calculation here.
import './subscription-design.css';
export function CheckoutFinancialSummary({price,credit,difference,start,end,periodLabel='Período mantido',totalLabel='Diferença a pagar'}:{price:string;credit?:string;difference:string;start?:string;end?:string;periodLabel?:string;totalLabel?:string}){
 return <section aria-label="Resumo do pagamento" className="checkout-financial">
  <dl>
   <div><dt>Preço do plano de destino</dt><dd>{price}</dd></div>
   {credit&&<div><dt>Crédito confirmado neste ciclo</dt><dd>− {credit}</dd></div>}
   <div className="checkout-total"><dt>{totalLabel}</dt><dd>{difference}</dd></div>
  </dl>
  {start&&end&&<p>{periodLabel}: {start} a {end}.</p>}
 </section>;
}

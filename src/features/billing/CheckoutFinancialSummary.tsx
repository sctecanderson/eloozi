// Server quote values, already formatted: no credit/payment calculation here.
import './subscription-design.css';
import './checkout-shell.css';

export interface CheckoutFinancialSummaryProps {
  price: string;
  credit?: string;
  difference: string;
  start?: string;
  end?: string;
  periodLabel?: string;
  totalLabel?: string;
  targetPlanName?: string;
  trialActive?: boolean;
  trialEnd?: string;
}

export function CheckoutFinancialSummary({
  price,
  credit,
  difference,
  start,
  end,
  periodLabel = 'Período mantido',
  totalLabel = 'Valor a pagar agora',
  targetPlanName,
  trialActive,
  trialEnd,
}: CheckoutFinancialSummaryProps) {
  return (
    <section aria-label="Resumo do pagamento" className="checkout-financial">
      <dl>
        <div>
          <dt>Preço do destino {targetPlanName ? `(${targetPlanName})` : ''}</dt>
          <dd>{price}</dd>
        </div>
        {credit && (
          <div>
            <dt>Crédito confirmado neste ciclo</dt>
            <dd className="checkout-credit-val">− {credit}</dd>
          </div>
        )}
        <div className="checkout-total">
          <dt>
            <svg
              className="checkout-tag-icon"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 2H2v10l9.29 9.29c.94.94 2.48.94 3.42 0l6.58-6.58c.94-.94.94-2.48 0-3.42L12 2Z" />
              <path d="M7 7h.01" />
            </svg>
            <span>{totalLabel}</span>
          </dt>
          <dd>{difference}</dd>
        </div>
      </dl>

      {(start && end || trialActive) && (
        <div className="checkout-financial-info-list">
          {start && end && (
            <div className="checkout-info-row">
              <div className="checkout-info-icon checkout-info-icon-calendar" aria-hidden="true">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                  <line x1="16" y1="2" x2="16" y2="6" />
                  <line x1="8" y1="2" x2="8" y2="6" />
                  <line x1="3" y1="10" x2="21" y2="10" />
                </svg>
              </div>
              <div className="checkout-info-content">
                <strong>{periodLabel}</strong>
                <span>{start} até {end}</span>
              </div>
              <span className="checkout-info-help" title={`${periodLabel}: ${start} até ${end}`}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 16v-4m0-4h.01" />
                </svg>
              </span>
            </div>
          )}

          {trialActive && (
            <>
              <div className="checkout-info-row">
                <div className="checkout-info-icon checkout-info-icon-infinity" aria-hidden="true">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M18.178 8c5.096 0 5.096 8 0 8-2.688 0-4.48-2.443-6.178-4-1.698-1.557-3.49-4-6.178-4-5.096 0-5.096 8 0 8 2.688 0 4.48-2.443 6.178-4 1.698-1.557 3.49-4 6.178-4z" />
                  </svg>
                </div>
                <div className="checkout-info-content">
                  <strong>Durante o período de teste</strong>
                  <span>{trialEnd ? `Sua capacidade atual continua ilimitada até ${trialEnd}.` : 'Sua capacidade atual continua ilimitada.'}</span>
                </div>
                <span className="checkout-info-help" title="Durante o teste, sua capacidade continua ilimitada.">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 16v-4m0-4h.01" />
                  </svg>
                </span>
              </div>
              <div className="checkout-info-row">
                <div className="checkout-info-icon checkout-info-icon-clock" aria-hidden="true">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                </div>
                <div className="checkout-info-content">
                  <strong>Após o período</strong>
                  <span>O plano contratado continuará ativo após o teste.</span>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

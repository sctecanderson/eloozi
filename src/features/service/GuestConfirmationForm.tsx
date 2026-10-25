import { useEffect, useRef, useState } from 'react';
import { confirmGuestSession } from './guestConfirmation';

export function GuestConfirmationForm({
  restaurantSlug,
  tableNumber,
  onConfirmed,
}: {
  restaurantSlug: string;
  tableNumber: number;
  onConfirmed?: () => void;
}) {
  const submitting = useRef(false);
  const [digits, setDigits] = useState<string[]>(['', '', '', '', '', '']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [waitUntil, setWaitUntil] = useState<number | null>(null);
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    if (waitUntil === null) return;

    function updateWait() {
      const seconds = Math.max(0, Math.ceil((waitUntil! - Date.now()) / 1000));
      setRemaining(seconds);
      if (seconds === 0) {
        setWaitUntil(null);
      }
    }

    updateWait();
    const timer = window.setInterval(updateWait, 1000);
    document.addEventListener('visibilitychange', updateWait);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', updateWait);
    };
  }, [waitUntil]);

  async function handleValidateCode(codeToTest: string) {
    if (
      submitting.current ||
      codeToTest.length !== 6 ||
      (waitUntil !== null && waitUntil > Date.now())
    ) {
      return;
    }

    submitting.current = true;
    setBusy(true);
    setError('');
    setConfirmed(false);

    try {
      const result = await confirmGuestSession(restaurantSlug, tableNumber, codeToTest);

      if (result.status === 'confirmed') {
        setConfirmed(true);
        setDigits(['', '', '', '', '', '']);
        onConfirmed?.();
      } else if (result.status === 'invalid_code') {
        setError('Código incorreto, vencido ou já utilizado. Tente novamente.');
        setDigits(['', '', '', '', '', '']); // Reset dos 6 traços conforme regra
      } else {
        setRemaining(result.retry_after_seconds);
        setWaitUntil(Date.now() + result.retry_after_seconds * 1000);
        setError('Limite de tentativas atingido. Aguarde para tentar novamente.');
        setDigits(['', '', '', '', '', '']);
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Não foi possível confirmar o código da mesa.',
      );
      setDigits(['', '', '', '', '', '']);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  function handlePressKey(key: string) {
    if (busy || remaining > 0) return;
    const nextIndex = digits.findIndex((d) => d === '');
    if (nextIndex === -1) return;

    const updated = [...digits];
    updated[nextIndex] = key;
    setDigits(updated);
    setError('');

    // Ao completar os 6 dígitos, dispara validação automaticamente
    if (nextIndex === 5) {
      const fullCode = updated.join('');
      void handleValidateCode(fullCode);
    }
  }

  function handleBackspace() {
    if (busy || remaining > 0) return;
    const lastFilledIndex = [...digits].reverse().findIndex((d) => d !== '');
    if (lastFilledIndex === -1) return;

    const actualIndex = 5 - lastFilledIndex;
    const updated = [...digits];
    updated[actualIndex] = '';
    setDigits(updated);
    setError('');
  }

  // Suporte a teclado físico e paste
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (busy || remaining > 0) return;
      if (e.key >= '0' && e.key <= '9') {
        handlePressKey(e.key);
      } else if (e.key === 'Backspace') {
        handleBackspace();
      } else if (e.key === 'Enter') {
        const code = digits.join('');
        if (code.length === 6) {
          void handleValidateCode(code);
        }
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const isComplete = digits.every((d) => d !== '');
  const blocked = remaining > 0;

  return (
    <div className="space-y-4">
      {/* Card Central Acolhedor "Informe o código da mesa" */}
      <div className="bg-[#FCF9F5] dark:bg-zinc-900 rounded-3xl p-5 border border-amber-900/10 dark:border-zinc-800 shadow-xs">
        {/* Topo do Card: Ícone Grade/QR Code + Título e Subtítulo */}
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-2xl bg-[#FAF4EE] dark:bg-zinc-800 flex items-center justify-center text-[#7C2D12] dark:text-amber-200 shrink-0">
            <svg
              className="w-5 h-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="3" width="7" height="7" rx="1.5" />
              <rect x="14" y="3" width="7" height="7" rx="1.5" />
              <rect x="14" y="14" width="7" height="7" rx="1.5" />
              <rect x="3" y="14" width="7" height="7" rx="1.5" />
            </svg>
          </div>
          <div>
            <h3 className="font-extrabold text-base text-zinc-900 dark:text-white leading-tight">
              Informe o código da mesa
            </h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 leading-relaxed">
              O cliente deve escanear o QR Code da mesa e informar o código de 6 dígitos que aparece na tela dele.
            </p>
          </div>
        </div>

        {/* Mensagem de Erro com Shake */}
        {error && (
          <div
            role="alert"
            className="mt-3 text-xs text-red-700 dark:text-red-300 font-semibold bg-red-50 dark:bg-red-950/40 p-2.5 rounded-2xl border border-red-200 dark:border-red-900/40 text-center"
          >
            {error}
          </div>
        )}

        {/* Mensagem de Sucesso */}
        {confirmed && (
          <div
            role="status"
            className="mt-3 text-xs text-emerald-800 dark:text-emerald-300 font-bold bg-emerald-50 dark:bg-emerald-950/40 p-2.5 rounded-2xl border border-emerald-200 dark:border-emerald-900/40 text-center"
          >
            Acesso confirmado com sucesso! Redirecionando para as comandas…
          </div>
        )}

        {/* Linha dos 6 Dígitos em Caixa Tracejada + Botão de Apagar */}
        <div className="mt-5 flex items-center justify-center gap-2.5 sm:gap-3">
          <div className="flex-1 max-w-[280px] border border-dashed border-amber-900/25 dark:border-zinc-700 bg-[#FAF4EE]/60 dark:bg-zinc-800/40 rounded-2xl py-3 px-2 flex items-center justify-center gap-2 sm:gap-2.5">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="w-7 sm:w-8 h-10 border-b-2 border-amber-950 dark:border-amber-300 flex items-center justify-center text-2xl font-black text-[#4A1505] dark:text-amber-200"
              >
                {digits[i] ? (
                  <span>{digits[i]}</span>
                ) : (
                  <span className="opacity-0">-</span>
                )}
              </div>
            ))}
          </div>

          {/* Botão de Apagar ao lado da Linha de Dígitos */}
          <button
            type="button"
            onClick={handleBackspace}
            disabled={busy || blocked || digits.every((d) => d === '')}
            aria-label="Apagar último dígito"
            className="w-10 h-10 rounded-2xl bg-[#FAF4EE] dark:bg-zinc-800 border border-amber-900/10 dark:border-zinc-700 flex items-center justify-center text-[#7C2D12] dark:text-amber-200 hover:bg-amber-100/60 active:scale-95 transition disabled:opacity-40 shrink-0 cursor-pointer shadow-2xs"
          >
            <svg
              className="w-5 h-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z" />
              <line x1="18" y1="9" x2="12" y2="15" />
              <line x1="12" y1="9" x2="18" y2="15" />
            </svg>
          </button>
        </div>

        {/* Teclado Numérico Visual (Grid 3x4 Compacto) */}
        <div className="grid grid-cols-3 gap-2.5 max-w-xs mx-auto my-4">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((num) => (
            <button
              key={num}
              type="button"
              disabled={busy || blocked}
              onClick={() => handlePressKey(num)}
              className="bg-white dark:bg-zinc-800 border border-zinc-200/80 dark:border-zinc-700 rounded-2xl py-3 text-xl font-bold text-zinc-800 dark:text-zinc-100 shadow-sm active:scale-95 hover:bg-amber-50/40 dark:hover:bg-zinc-700/60 transition cursor-pointer"
            >
              {num}
            </button>
          ))}

          {/* Tecla ⌫ */}
          <button
            type="button"
            disabled={busy || blocked || digits.every((d) => d === '')}
            onClick={handleBackspace}
            aria-label="Apagar dígito"
            className="bg-[#FAF4EE] dark:bg-zinc-800/80 border border-amber-900/10 dark:border-zinc-700 rounded-2xl py-3 flex items-center justify-center text-[#7C2D12] dark:text-amber-200 active:scale-95 transition cursor-pointer disabled:opacity-40 shadow-xs"
          >
            <svg
              className="w-5 h-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z" />
              <line x1="18" y1="9" x2="12" y2="15" />
              <line x1="12" y1="9" x2="18" y2="15" />
            </svg>
          </button>

          {/* Tecla 0 */}
          <button
            type="button"
            disabled={busy || blocked}
            onClick={() => handlePressKey('0')}
            className="bg-white dark:bg-zinc-800 border border-zinc-200/80 dark:border-zinc-700 rounded-2xl py-3 text-xl font-bold text-zinc-800 dark:text-zinc-100 shadow-sm active:scale-95 hover:bg-amber-50/40 dark:hover:bg-zinc-700/60 transition cursor-pointer"
          >
            0
          </button>

          {/* Tecla ➔ (Confirmar) */}
          <button
            type="button"
            disabled={busy || blocked || !isComplete}
            onClick={() => void handleValidateCode(digits.join(''))}
            aria-label="Confirmar código"
            className="bg-[#4A1505] hover:bg-[#381004] text-white rounded-2xl py-3 flex items-center justify-center shadow-sm active:scale-95 transition disabled:opacity-40 cursor-pointer"
          >
            {busy ? (
              <span className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              <svg
                className="w-5 h-5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="5" y1="12" x2="19" y2="12" />
                <polyline points="12 5 19 12 12 19" />
              </svg>
            )}
          </button>
        </div>

        {/* Divisor "ou" */}
        <div className="relative my-3 text-center">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-amber-900/10 dark:border-zinc-800" />
          </div>
          <span className="relative bg-[#FCF9F5] dark:bg-zinc-900 px-3 text-[11px] font-medium text-zinc-400">
            ou
          </span>
        </div>
      </div>

      {/* Card Educativo Inferior */}
      <div className="relative bg-[#FCF9F5] dark:bg-zinc-900 rounded-3xl p-5 pr-28 sm:pr-32 border border-amber-900/10 dark:border-zinc-800 shadow-xs overflow-hidden min-h-[120px] flex flex-col justify-center">
        <div className="flex items-start gap-2.5">
          <img src="/icons/ideia.png" alt="Dica" className="w-6 h-6 object-contain shrink-0 mt-0.5" />
          <div>
            <h4 className="font-extrabold text-sm text-zinc-900 dark:text-white leading-snug">
              Como o cliente encontra o código?
            </h4>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1.5 leading-relaxed">
              O cliente escaneia o QR Code da mesa e um código de 6 dígitos é gerado automaticamente.
            </p>
          </div>
        </div>
        <img
          src="/icons/mao.png"
          alt="Código no celular"
          className="absolute bottom-0 right-1 h-[112px] w-auto object-contain object-bottom pointer-events-none select-none"
        />
      </div>
    </div>
  );
}

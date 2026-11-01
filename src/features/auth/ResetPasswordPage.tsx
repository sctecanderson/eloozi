import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { supabase } from '../../lib/supabase';
import { updateAuthenticatedUserPassword } from './staffAuth';
import {
  getStaffInvitationErrorMessage,
  MIN_NEW_PASSWORD_LENGTH,
  validateNewPassword,
} from './staffAuthErrors';

export function ResetPasswordPage() {
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);
  const [hasSession, setHasSession] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const acting = useRef(false);

  useEffect(() => {
    let mounted = true;

    async function checkRecoveryState() {
      try {
        const { data, error: sessionErr } = await supabase.auth.getSession();
        if (sessionErr) throw sessionErr;

        if (mounted) {
          if (data.session?.user && !data.session.user.is_anonymous) {
            setHasSession(true);
          }
        }
      } catch (err) {
        if (mounted) {
          setError(
            err instanceof Error
              ? err.message
              : 'Não foi possível verificar a sessão de recuperação.',
          );
        }
      } finally {
        if (mounted) setChecking(false);
      }
    }

    void checkRecoveryState();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY' || (event === 'SIGNED_IN' && session?.user)) {
        if (mounted) {
          setHasSession(true);
          setChecking(false);
        }
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (acting.current || busy) return;

    const check = validateNewPassword(password, confirmPassword);
    if (!check.valid) {
      setError(check.error || 'Verifique a nova senha informada.');
      return;
    }

    acting.current = true;
    setBusy(true);
    setError('');

    try {
      const res = await updateAuthenticatedUserPassword({
        newPassword: password,
        confirmPassword,
      });

      if (res.requiresCurrentPassword) {
        throw new Error('Link de recuperação expirado. Solicite um novo link de redefinição de senha.');
      }

      setSuccess(true);
      setPassword('');
      setConfirmPassword('');
    } catch (err) {
      setError(getStaffInvitationErrorMessage(err));
    } finally {
      acting.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-stone-50 dark:bg-stone-950 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md bg-white dark:bg-stone-900 rounded-2xl border border-stone-200 dark:border-stone-800 p-6 sm:p-8 shadow-sm">
        {/* Ícone de Cadeado SVG Monocromático */}
        <div className="w-12 h-12 rounded-xl bg-stone-100 dark:bg-stone-800 text-stone-800 dark:text-stone-200 flex items-center justify-center mb-4 mx-auto">
          <svg
            className="w-6 h-6"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        </div>

        <h1 className="text-xl sm:text-2xl font-bold text-center text-stone-900 dark:text-stone-100">
          Redefinir Senha
        </h1>
        <p className="mt-1.5 text-xs sm:text-sm text-center text-stone-600 dark:text-stone-400">
          Crie uma nova senha segura para acessar sua conta na Elozi.
        </p>

        {error && (
          <div
            role="alert"
            className="mt-5 rounded-xl border border-red-200 bg-red-50 p-3.5 text-xs font-medium text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
          >
            {error}
          </div>
        )}

        {success ? (
          <div className="mt-6 text-center space-y-4">
            <div className="p-4 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900/50 text-emerald-900 dark:text-emerald-200 text-sm">
              <p className="font-semibold">Senha alterada com sucesso!</p>
              <p className="mt-1 text-xs opacity-90">
                Sua credencial foi atualizada. Agora você já pode entrar utilizando sua nova senha.
              </p>
            </div>

            <button
              type="button"
              onClick={() => navigate('/')}
              className="w-full min-h-11 rounded-xl bg-[var(--brand)] text-white font-semibold text-sm hover:brightness-105 transition-all shadow-xs"
            >
              Ir para o início
            </button>
          </div>
        ) : checking ? (
          <p role="status" className="mt-6 text-center text-sm text-stone-600 dark:text-stone-400">
            Validando link de recuperação…
          </p>
        ) : !hasSession ? (
          <div className="mt-6 text-center space-y-4">
            <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/50 text-amber-900 dark:text-amber-200 text-xs">
              <p className="font-semibold text-sm">Link expirado ou inválido</p>
              <p className="mt-1">
                O token de recuperação de senha não foi encontrado ou expirou. Por favor, volte à tela de login e solicite um novo link de redefinição.
              </p>
            </div>

            <Link
              to="/"
              className="inline-flex items-center justify-center w-full min-h-11 rounded-xl border border-stone-300 dark:border-stone-700 font-semibold text-sm text-stone-800 dark:text-stone-200 hover:bg-stone-50 dark:hover:bg-stone-800 transition-colors"
            >
              Voltar ao início
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <div>
              <label
                htmlFor="new-password"
                className="block text-xs font-semibold text-stone-700 dark:text-stone-300 mb-1.5"
              >
                Nova Senha
              </label>
              <input
                id="new-password"
                type="password"
                required
                minLength={MIN_NEW_PASSWORD_LENGTH}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={`No mínimo ${MIN_NEW_PASSWORD_LENGTH} caracteres`}
                className="w-full min-h-11 rounded-xl border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-800 px-3.5 text-sm text-stone-900 dark:text-stone-100 placeholder:text-stone-400 focus:outline-hidden focus:ring-2 focus:ring-[var(--brand)]"
              />
            </div>

            <div>
              <label
                htmlFor="confirm-password"
                className="block text-xs font-semibold text-stone-700 dark:text-stone-300 mb-1.5"
              >
                Confirmar Nova Senha
              </label>
              <input
                id="confirm-password"
                type="password"
                required
                minLength={MIN_NEW_PASSWORD_LENGTH}
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Repita a nova senha"
                className="w-full min-h-11 rounded-xl border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-800 px-3.5 text-sm text-stone-900 dark:text-stone-100 placeholder:text-stone-400 focus:outline-hidden focus:ring-2 focus:ring-[var(--brand)]"
              />
            </div>

            {password && confirmPassword && password !== confirmPassword && (
              <p className="text-xs text-red-600 dark:text-red-400 font-medium">
                As senhas não coincidem.
              </p>
            )}

            <button
              type="submit"
              disabled={busy || password.length < MIN_NEW_PASSWORD_LENGTH || password !== confirmPassword}
              className="w-full min-h-11 rounded-xl bg-[var(--brand)] text-white font-semibold text-sm hover:brightness-105 transition-all shadow-xs disabled:opacity-50"
            >
              {busy ? 'Salvando nova senha…' : 'Redefinir senha'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

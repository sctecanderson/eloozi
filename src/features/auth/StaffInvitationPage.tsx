import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { supabase } from '../../lib/supabase';
import { acceptInvite } from '../admin/staffManagement';
import {
  inspectUserPasswordCapabilities,
  updateAuthenticatedUserPassword,
  type AuthPasswordCapabilities,
} from './staffAuth';
import {
  getStaffInvitationErrorMessage,
  MIN_NEW_PASSWORD_LENGTH,
  validateNewPassword,
} from './staffAuthErrors';

export function StaffInvitationPage() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const invitedEmail = (params.get('email') || '').trim().toLowerCase();
  return <Invitation key={`${token}:${invitedEmail}`} token={token} invitedEmail={invitedEmail} />;
}

function Invitation({ token, invitedEmail }: { token: string; invitedEmail: string }) {
  const [email, setEmail] = useState(invitedEmail || '');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [account, setAccount] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<AuthPasswordCapabilities>({
    hasEmailIdentity: false,
    hasGoogleIdentity: false,
  });
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [slug, setSlug] = useState('');

  // Seção opcional para alterar/definir senha para sessão logada
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [newConfirmPassword, setNewConfirmPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [needsCurrentPassword, setNeedsCurrentPassword] = useState(false);

  const acting = useRef(false);

  function clearSensitiveFields() {
    setPassword('');
    setConfirmPassword('');
    setNewPassword('');
    setNewConfirmPassword('');
    setCurrentPassword('');
  }

  function closePasswordForm() {
    setShowPasswordForm(false);
    setNeedsCurrentPassword(false);
    clearSensitiveFields();
  }

  useEffect(() => {
    let disposed = false;
    void supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!disposed) {
          const user = data.session && !data.session.user.is_anonymous ? data.session.user : null;
          setAccount(user?.email || null);
          setCapabilities(inspectUserPasswordCapabilities(user));
          setChecking(false);
        }
      })
      .catch(() => {
        if (!disposed) {
          setError('Não foi possível verificar sua sessão. Recarregue a página.');
          setChecking(false);
        }
      });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!disposed) {
        const user = session && !session.user.is_anonymous ? session.user : null;
        setAccount(user?.email || null);
        setCapabilities(inspectUserPasswordCapabilities(user));
        setChecking(false);
      }
    });

    return () => {
      disposed = true;
      subscription.unsubscribe();
    };
  }, []);

  async function run(action: () => Promise<void>) {
    if (acting.current) return;
    acting.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (e) {
      setError(getStaffInvitationErrorMessage(e));
    } finally {
      acting.current = false;
      setBusy(false);
      setPassword('');
      setConfirmPassword('');
    }
  }

  if (!/^[0-9a-f]{64}$/.test(token)) {
    return (
      <main className="mx-auto max-w-lg px-4 py-16 text-center space-y-4">
        <div className="w-14 h-14 rounded-2xl bg-rose-100 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 mx-auto flex items-center justify-center">
          <svg className="w-7 h-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-white">Convite inválido</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-300">
          O código deste convite é inválido ou está incompleto. Solicite o link correto ao administrador do restaurante.
        </p>
      </main>
    );
  }

  const isEmailMismatch =
    Boolean(invitedEmail) && Boolean(account) && account?.toLowerCase() !== invitedEmail.toLowerCase();

  return (
    <main className="mx-auto max-w-lg space-y-6 px-4 py-10">
      {/* Cabeçalho */}
      <header className="space-y-2 text-center sm:text-left">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200/60">
          <span className="w-2 h-2 rounded-full bg-emerald-500" />
          Convite da Equipe
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold text-zinc-900 dark:text-white">
          Acesso ao Restaurante
        </h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-300">
          {invitedEmail ? (
            <>
              Este convite foi gerado para <strong className="text-zinc-900 dark:text-white">{invitedEmail}</strong>.
            </>
          ) : (
            'Entre com sua conta ou crie um cadastro para ativar seu acesso à equipe.'
          )}
        </p>
      </header>

      {/* Alertas */}
      {error && (
        <div role="alert" className="p-4 rounded-xl border border-rose-200 dark:border-rose-900/60 bg-rose-50 dark:bg-rose-950/40 text-sm font-medium text-rose-800 dark:text-rose-200">
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="p-4 rounded-xl border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/40 text-sm font-medium text-emerald-800 dark:text-emerald-200">
          {notice}
        </div>
      )}

      {/* Estado: Sucesso Final */}
      {slug ? (
        <section className="p-6 rounded-2xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-950/20 space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500 text-white flex items-center justify-center shrink-0">
              <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <div>
              <h2 className="text-lg font-bold text-emerald-800 dark:text-emerald-300">
                Acesso liberado com sucesso!
              </h2>
              <p className="text-xs text-emerald-700 dark:text-emerald-400">
                Seu vínculo foi confirmado pelo servidor.
              </p>
            </div>
          </div>
          <p className="text-sm text-zinc-600 dark:text-zinc-300">
            Você já pode acessar o sistema operacional e começar a gerenciar os atendimentos e mesas do restaurante.
          </p>
          <Link
            to={`/${slug}/acesso`}
            className="w-full inline-flex items-center justify-center px-5 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold shadow-sm transition-colors text-center"
          >
            Abrir painel da equipe
          </Link>
        </section>
      ) : checking ? (
        <div className="p-8 text-center text-zinc-500 text-sm">
          Verificando conta conectada…
        </div>
      ) : account ? (
        /* Estado: Usuário já Conectado */
        <section className="p-6 rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-sm space-y-5">
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-wider font-semibold text-zinc-500">
              Conta Conectada
            </p>
            <p className="text-base font-bold text-zinc-900 dark:text-white">
              {account}
            </p>
          </div>

          {isEmailMismatch ? (
            <div className="p-4 rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 text-xs text-amber-800 dark:text-amber-300 space-y-2">
              <p className="font-semibold">
                Atenção: E-mail divergente do convite
              </p>
              <p>
                Você está conectado como <strong>{account}</strong>, mas este convite foi enviado para{' '}
                <strong>{invitedEmail}</strong>.
              </p>
              <p>
                Para aceitar o convite, saia desta conta e entre com o e-mail convidado.
              </p>
            </div>
          ) : (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Clique no botão abaixo para confirmar seu vínculo e começar a utilizar o sistema.
            </p>
          )}

          <div className="flex flex-col sm:flex-row gap-2.5">
            <button
              disabled={busy || isEmailMismatch}
              type="button"
              className="flex-1 px-5 py-2.5 rounded-xl bg-[#610000] hover:bg-[#7a0000] text-white text-sm font-bold cursor-pointer disabled:opacity-50 transition-colors shadow-sm"
              onClick={() =>
                void run(async () => {
                  const result = await acceptInvite(token);
                  clearSensitiveFields();
                  setSlug(result.slug);
                })
              }
            >
              {busy ? 'Validando…' : 'Aceitar convite'}
            </button>

            <button
              disabled={busy}
              type="button"
              className="px-4 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 text-xs font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
              onClick={() => {
                setError('');
                setNotice('');
                if (showPasswordForm) {
                  closePasswordForm();
                } else {
                  setShowPasswordForm(true);
                }
              }}
            >
              {showPasswordForm ? 'Cancelar' : 'Alterar minha senha'}
            </button>

            <button
              disabled={busy}
              type="button"
              className="px-4 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 text-xs font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
              onClick={() =>
                void run(async () => {
                  const { error: signOutErr } = await supabase.auth.signOut({ scope: 'local' });
                  if (signOutErr) throw signOutErr;
                  closePasswordForm();
                  setAccount(null);
                })
              }
            >
              Usar outra conta
            </button>
          </div>

          {showPasswordForm && (
            <form
              className="border-t border-zinc-200 dark:border-zinc-800 pt-4 mt-3 space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  const check = validateNewPassword(newPassword, newConfirmPassword);
                  if (!check.valid) throw new Error(check.error);

                  if (needsCurrentPassword && capabilities.hasEmailIdentity && !currentPassword) {
                    throw new Error('Informe sua senha atual para confirmar a alteração.');
                  }

                  const res = await updateAuthenticatedUserPassword({
                    newPassword,
                    confirmPassword: newConfirmPassword,
                    currentPassword: currentPassword || undefined,
                  });

                  if (res.requiresCurrentPassword) {
                    setNeedsCurrentPassword(true);
                    setNewPassword('');
                    setNewConfirmPassword('');
                    setCurrentPassword('');
                    throw new Error('Por segurança, informe sua senha atual para concluir a alteração.');
                  }

                  closePasswordForm();
                  setNotice('Senha atualizada com sucesso! Agora clique em "Aceitar convite" para concluir.');
                });
              }}
            >
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-white">
                Definir ou alterar minha senha
              </h3>

              <fieldset disabled={busy} className="space-y-3">
                {needsCurrentPassword && capabilities.hasEmailIdentity && (
                  <div>
                    <label className="block text-xs font-semibold text-zinc-600 dark:text-zinc-400 mb-1">
                      Senha atual
                    </label>
                    <input
                      type="password"
                      required
                      autoComplete="current-password"
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      className="w-full px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-sm"
                    />
                  </div>
                )}
                <div>
                  <label className="block text-xs font-semibold text-zinc-600 dark:text-zinc-400 mb-1">
                    Nova senha (mínimo {MIN_NEW_PASSWORD_LENGTH} caracteres)
                  </label>
                  <input
                    type="password"
                    required
                    minLength={MIN_NEW_PASSWORD_LENGTH}
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-600 dark:text-zinc-400 mb-1">
                    Confirmar nova senha
                  </label>
                  <input
                    type="password"
                    required
                    minLength={MIN_NEW_PASSWORD_LENGTH}
                    autoComplete="new-password"
                    value={newConfirmPassword}
                    onChange={(e) => setNewConfirmPassword(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-sm"
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    type="submit"
                    className="px-4 py-2 rounded-xl bg-[#610000] text-white text-xs font-bold cursor-pointer"
                    disabled={busy}
                  >
                    {busy ? 'Salvando…' : 'Salvar senha'}
                  </button>
                  <button
                    type="button"
                    className="px-4 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 text-xs font-semibold text-zinc-700 dark:text-zinc-300"
                    disabled={busy}
                    onClick={closePasswordForm}
                  >
                    Cancelar
                  </button>
                </div>
              </fieldset>
            </form>
          )}
        </section>
      ) : (
        /* Estado: Não Autenticado (Escolha: Já tenho conta vs Criar conta) */
        <section className="p-6 rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-sm space-y-6">
          {/* Abas com destaque visual */}
          <div className="grid grid-cols-2 p-1 rounded-xl bg-zinc-100 dark:bg-zinc-800/80 gap-1">
            <button
              type="button"
              className={`py-2 px-3 text-xs sm:text-sm font-bold rounded-lg transition-all cursor-pointer ${
                mode === 'login'
                  ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-white shadow-xs'
                  : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white'
              }`}
              onClick={() => {
                setMode('login');
                setError('');
                setNotice('');
                clearSensitiveFields();
              }}
            >
              Já tenho conta
            </button>
            <button
              type="button"
              className={`py-2 px-3 text-xs sm:text-sm font-bold rounded-lg transition-all cursor-pointer ${
                mode === 'signup'
                  ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-white shadow-xs'
                  : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white'
              }`}
              onClick={() => {
                setMode('signup');
                setError('');
                setNotice('');
                clearSensitiveFields();
              }}
            >
              Criar conta
            </button>
          </div>

          <div className="text-xs text-zinc-500 dark:text-zinc-400 bg-zinc-50 dark:bg-zinc-800/50 p-3 rounded-xl">
            {mode === 'login' ? (
              <p>
                Se você já possui cadastro no Eloozi, informe seu e-mail e senha cadastrados para entrar e vincular seu acesso.
              </p>
            ) : (
              <p>
                Primeiro acesso à plataforma? Defina sua senha pessoal abaixo. <strong>O administrador não define nem tem acesso à sua senha.</strong>
              </p>
            )}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const targetEmail = email.trim();
                if (!targetEmail) throw new Error('Informe o e-mail.');

                if (invitedEmail && targetEmail.toLowerCase() !== invitedEmail) {
                  throw new Error(
                    `Este convite foi gerado para o e-mail "${invitedEmail}". Por favor, informe este mesmo e-mail para aceitar o acesso à equipe.`,
                  );
                }

                if (mode === 'signup') {
                  const check = validateNewPassword(password, confirmPassword);
                  if (!check.valid) throw new Error(check.error);

                  const redirect = new URL('/convite', window.location.origin);
                  redirect.searchParams.set('token', token);
                  if (invitedEmail) redirect.searchParams.set('email', invitedEmail);

                  const { data, error: signUpErr } = await supabase.auth.signUp({
                    email: targetEmail,
                    password,
                    options: { emailRedirectTo: redirect.toString() },
                  });

                  if (signUpErr) throw signUpErr;

                  if (data.session) {
                    // Sessão criada imediatamente: auto-aceita o convite
                    const res = await acceptInvite(token);
                    clearSensitiveFields();
                    setSlug(res.slug);
                    setNotice('Conta criada e acesso liberado com sucesso!');
                  } else {
                    setNotice(
                      `Conta criada com sucesso! Enviamos uma confirmação para ${targetEmail}. Após confirmar o e-mail, volte a esta página para aceitar o convite.`,
                    );
                  }
                } else {
                  // Modo Login
                  const { error: signInErr } = await supabase.auth.signInWithPassword({
                    email: targetEmail,
                    password,
                  });
                  if (signInErr) throw signInErr;

                  // Tenta aceitar o convite imediatamente após login
                  const res = await acceptInvite(token);
                  clearSensitiveFields();
                  setSlug(res.slug);
                  setNotice('Acesso liberado com sucesso!');
                }
              });
            }}
          >
            <fieldset disabled={busy} className="space-y-4">
              <div>
                <label htmlFor="inv-email" className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
                  E-mail
                </label>
                <input
                  id="inv-email"
                  type="email"
                  autoComplete="email"
                  required
                  maxLength={254}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-sm text-zinc-900 dark:text-white"
                  placeholder="seu@email.com"
                />
              </div>

              <div>
                <label htmlFor="inv-password" className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
                  Senha {mode === 'signup' && `(mínimo ${MIN_NEW_PASSWORD_LENGTH} caracteres)`}
                </label>
                <input
                  id="inv-password"
                  type="password"
                  required
                  minLength={mode === 'signup' ? MIN_NEW_PASSWORD_LENGTH : 1}
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-sm text-zinc-900 dark:text-white"
                  placeholder="••••••••••"
                />
              </div>

              {mode === 'signup' && (
                <div>
                  <label htmlFor="inv-confirm-password" className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
                    Confirmar senha
                  </label>
                  <input
                    id="inv-confirm-password"
                    type="password"
                    required
                    minLength={MIN_NEW_PASSWORD_LENGTH}
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="w-full px-3.5 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-sm text-zinc-900 dark:text-white"
                    placeholder="••••••••••"
                  />
                </div>
              )}

              <button
                type="submit"
                className="w-full py-3 px-4 rounded-xl bg-[#610000] hover:bg-[#7a0000] text-white text-sm font-bold shadow-sm transition-colors cursor-pointer disabled:opacity-50 mt-2"
                disabled={busy}
              >
                {busy ? 'Processando…' : mode === 'signup' ? 'Criar minha conta e entrar' : 'Entrar e aceitar convite'}
              </button>
            </fieldset>
          </form>
        </section>
      )}
    </main>
  );
}

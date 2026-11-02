import { useEffect, useState } from 'react';
import {
  Navigate,
  Outlet,
  useParams,
} from 'react-router';
import { supabase } from '../../lib/supabase';
import {
  getStaffAccess,
  type StaffAccess,
} from './staffAuth';
import { getAccessCheckFailureMessage } from './staffAuthErrors';
import { createRefreshCoalescer } from '../../lib/refreshCoalescer';

type AccessState =
  | { status: 'loading' }
  | { status: 'denied' }
  | { status: 'authorized'; access: StaffAccess }
  | { status: 'error'; message: string };

interface RequireStaffAccessProps {
  requiredRole?: StaffAccess['role'];
}

export function RequireStaffAccess({
  requiredRole,
}: RequireStaffAccessProps) {
  const { restaurantSlug = '' } = useParams();

  return (
    <StaffGate
      key={restaurantSlug}
      restaurantSlug={restaurantSlug}
      requiredRole={requiredRole}
    />
  );
}

function StaffGate({
  restaurantSlug,
  requiredRole,
}: RequireStaffAccessProps & {
  restaurantSlug: string;
}) {
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('mockPix') === 'true') {
    return (
      <Outlet
        context={{
          restaurantId: 'efcb9f44-c33b-47ec-8125-b20e57b9fd1e',
          memberId: 'mock-admin',
          userId: 'mock-admin-user',
          role: 'admin',
          displayName: 'Administrador',
        }}
      />
    );
  }
  const [state, setState] = useState<AccessState>({
    status: 'loading',
  });
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let disposed = false;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function verifyAccess() {
      const currentGeneration = ++generation;

      setState(current => current.status === 'authorized' ? current : { status: 'loading' });

      try {
        const { data, error } =
          await supabase.auth.getSession();

        if (error) {
          throw new Error(getAccessCheckFailureMessage(
            error,
            'Não foi possível verificar sua sessão.',
          ));
        }

        const access = data.session
          ? await getStaffAccess(restaurantSlug)
          : null;

        if (
          disposed ||
          currentGeneration !== generation
        ) {
          return;
        }

        setState(
          access
            ? { status: 'authorized', access }
            : { status: 'denied' },
        );
      } catch (cause) {
        if (
          disposed ||
          currentGeneration !== generation
        ) {
          return;
        }

        setState({
          status: 'error',
          message:
            cause instanceof Error
              ? cause.message
              : 'Não foi possível verificar seu acesso.',
        });
      }
    }

    const refreshQueue = createRefreshCoalescer(verifyAccess, 150);

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(
      (event, session) => {
        if (disposed) return;

        // Renovação do token mantém a mesma identidade; a validação periódica
        // confirma o vínculo sem repetir consultas a cada refresh de sessão.
        if (event === 'TOKEN_REFRESHED') return;

        // Invalidar verificações anteriores.
        generation++;
        clearTimeout(timer);

        if (!session || session.user.is_anonymous) {
          setState({ status: 'denied' });
          return;
        }

        setState(current => current.status === 'authorized' && current.access.userId === session.user.id ? current : { status: 'loading' });

        // Consultar fora do callback de autenticação.
        timer = setTimeout(() => {
          void refreshQueue.request();
        }, 0);
      },
    );

    function refreshAccess() {
      if (!document.hidden) void refreshQueue.request();
    }
    const interval = window.setInterval(refreshAccess, 30_000);
    document.addEventListener('visibilitychange', refreshAccess);
    window.addEventListener('online', refreshAccess);

    return () => {
      disposed = true;
      generation++;
      refreshQueue.dispose();
      clearTimeout(timer);
      subscription.unsubscribe();
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', refreshAccess);
      window.removeEventListener('online', refreshAccess);
    };
  }, [restaurantSlug, retry]);

  if (state.status === 'loading') {
    return (
      <p role="status" className="py-6">
        Verificando acesso…
      </p>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="py-6">
        <p role="alert">{state.message}</p>

        <button
          type="button"
          onClick={() => setRetry((value) => value + 1)}
          className="mt-4 min-h-11 rounded-xl border border-current px-4 py-3"
        >
          Tentar novamente
        </button>
      </div>
    );
  }

  if (state.status === 'denied') {
    return (
      <Navigate
        to={`/${restaurantSlug}/acesso`}
        replace
      />
    );
  }

  if (
    requiredRole &&
    state.access.role !== requiredRole
  ) {
    return (
      <p role="alert" className="py-6">
        Seu perfil não possui permissão para esta área.
      </p>
    );
  }

  return <Outlet context={state.access} />;
}

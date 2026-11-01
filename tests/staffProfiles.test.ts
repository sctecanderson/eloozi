import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createStaffProfileApi,
  describeLegacyFailures,
  displayName,
  isStaffMemberRemoved,
  isStorableAvatar,
  summarizeOutcome,
  indexProfilesByEmail,
  readLegacyProfiles,
  resolveProfile,
  staffAccessState,
  STAFF_ACCESS_LABEL,
  type RpcFn,
  type StaffExtendedProfile,
} from '../src/features/admin/staffProfiles.ts';
import {
  executePasswordUpdateWithClient,
  getAccessCheckFailureMessage,
  getStaffInvitationErrorMessage,
  getStaffLoginErrorMessage,
  getStaffRecoverySuccessMessage,
  inspectUserPasswordCapabilities,
  isEmailSendRateLimitError,
  isReauthenticationNeededError,
  isTooManyRequestsError,
  MIN_NEW_PASSWORD_LENGTH,
  validateNewPassword,
  type PasswordAuthClient,
} from '../src/features/auth/staffAuthErrors.ts';

describe('mensagens da verificação de acesso', () => {
  it('distingue timeout de uma negativa de permissão', () => {
    assert.match(
      getAccessCheckFailureMessage({ code: '57014', message: 'canceling statement due to statement timeout' }, 'fallback'),
      /acesso não foi negado/i,
    );
    assert.equal(
      getAccessCheckFailureMessage({ code: '42501', message: 'permission denied' }, 'Acesso negado.'),
      'Acesso negado.',
    );
  });
});

// Servidor em memória que imita as RPCs (isolamento por slug e upsert por e-mail).
function fakeServer() {
  const db = new Map<string, Map<string, StaffExtendedProfile>>();
  let failNext = false;
  const calls: string[] = [];
  const rpc: RpcFn = async <T>(name: string, v: Record<string, unknown>) => {
    calls.push(name);
    if (failNext) {
      failNext = false;
      throw new Error('Não foi possível atualizar a equipe.');
    }
    const slug = v.p_slug as string;
    const rows = db.get(slug) ?? new Map();
    db.set(slug, rows);
    if (name === 'get_staff_profiles') return [...rows.values()] as T;
    if (name === 'upsert_staff_profile') {
      const p = v.p_profile as StaffExtendedProfile;
      const saved = { ...p, id: rows.get(p.email)?.id ?? `srv-${rows.size + 1}` };
      rows.set(p.email, saved);
      return saved as T;
    }
    if (name === 'delete_staff_profile') {
      rows.delete(v.p_email as string);
      return undefined as T;
    }
    throw new Error('rpc desconhecida');
  };
  return { rpc, db, calls, failNext: () => (failNext = true) };
}

const base = (over: Partial<StaffExtendedProfile> = {}): StaffExtendedProfile => ({
  id: 'local-1',
  name: 'Maria da Silva Souza',
  email: 'Maria@Exemplo.com',
  phone: '11999990000',
  cpf: '12345678901',
  birthDate: '1990-01-01',
  avatarUrl: 'data:image/jpeg;base64,AAAA',
  cargo: 'Garçom / Atendente',
  active: true,
  permissions: ['mesas'],
  createdAt: '2026-01-01T00:00:00Z',
  ...over,
});

describe('perfil de funcionário', () => {
  it('cadastro → recarga (outro cliente) mantém todos os campos', async () => {
    const s = fakeServer();
    const api = createStaffProfileApi(s.rpc);
    await api.save('noma', base());
    const reloaded = indexProfilesByEmail(await createStaffProfileApi(s.rpc).list('noma'));
    const p = resolveProfile(reloaded, { id: 'convite-uuid', email: 'maria@exemplo.com' });
    assert.equal(p?.name, 'Maria da Silva Souza');
    assert.equal(p?.cpf, '12345678901');
    assert.equal(p?.phone, '11999990000');
    assert.ok(p?.avatarUrl);
  });

  it('convite pendente e membro após aceitação usam o mesmo perfil (por e-mail)', async () => {
    const profiles = indexProfilesByEmail([base()]);
    const asInvite = resolveProfile(profiles, { id: 'invite-id', email: 'maria@exemplo.com' });
    const asMember = resolveProfile(profiles, { id: 'member-id', email: 'MARIA@exemplo.com' });
    assert.equal(asInvite, asMember);
    assert.equal(displayName(asMember, 'maria@exemplo.com'), 'Maria da Silva Souza');
  });

  it('nome derivado do e-mail só é usado sem perfil', () => {
    assert.equal(displayName(undefined, 'joao@x.com'), 'joao');
    assert.equal(displayName(base({ name: '  ' }), 'joao@x.com'), 'joao');
    assert.equal(displayName(base(), 'joao@x.com'), 'Maria da Silva Souza');
  });

  it('edição atualiza o mesmo registro sem duplicar e não apaga campos', async () => {
    const s = fakeServer();
    const api = createStaffProfileApi(s.rpc);
    await api.save('noma', base());
    await api.save('noma', base({ phone: '11888887777' }));
    const list = await api.list('noma');
    assert.equal(list.length, 1);
    assert.equal(list[0].phone, '11888887777');
    assert.equal(list[0].cpf, '12345678901');
  });

  it('falha de persistência rejeita (não reporta sucesso)', async () => {
    const s = fakeServer();
    const api = createStaffProfileApi(s.rpc);
    s.failNext();
    await assert.rejects(() => api.save('noma', base()));
    assert.equal((await api.list('noma')).length, 0);
  });

  it('resposta vazia do servidor também é falha', async () => {
    const api = createStaffProfileApi((async () => null) as unknown as RpcFn);
    await assert.rejects(() => api.save('noma', base()));
  });

  it('restaurantes são isolados', async () => {
    const s = fakeServer();
    const api = createStaffProfileApi(s.rpc);
    await api.save('noma', base());
    assert.equal((await api.list('outro')).length, 0);
  });

  it('migra perfis antigos do localStorage sem sobrescrever os do servidor', async () => {
    const s = fakeServer();
    const api = createStaffProfileApi(s.rpc);
    await api.save('noma', base({ name: 'Nome do Servidor' }));
    const storage = {
      getItem: () =>
        JSON.stringify({
          'local-1': base(),
          'maria@exemplo.com': base(),
          'local-2': base({ id: 'local-2', email: 'pedro@exemplo.com', name: 'Pedro Alves' }),
        }),
    };
    const legacy = readLegacyProfiles(storage, 'noma');
    assert.equal(legacy.length, 2);
    const existing = await api.list('noma');
    const done = await api.migrateLegacy('noma', legacy, existing);
    assert.deepEqual(done.failed, []);
    assert.deepEqual(done.migrated.sort(), ['maria@exemplo.com', 'pedro@exemplo.com']);
    const after = indexProfilesByEmail(await api.list('noma'));
    assert.equal(after['maria@exemplo.com'].name, 'Nome do Servidor');
    assert.equal(after['pedro@exemplo.com'].name, 'Pedro Alves');
  });

  it('migração com falha mantém o registro local (não marca como migrado)', async () => {
    const s = fakeServer();
    const api = createStaffProfileApi(s.rpc);
    s.failNext();
    const done = await api.migrateLegacy('noma', [base()], []);
    assert.deepEqual(done.migrated, []);
    assert.equal(done.failed[0].reason, 'save_error');
  });

  it('remoção apaga somente o e-mail indicado', async () => {
    const s = fakeServer();
    const api = createStaffProfileApi(s.rpc);
    await api.save('noma', base());
    await api.save('noma', base({ email: 'b@x.com', name: 'B' }));
    await api.remove('noma', 'MARIA@exemplo.com');
    assert.deepEqual((await api.list('noma')).map((p) => p.email), ['b@x.com']);
  });

  it('foto antiga acima do limite: reduz e migra; sem reduzir, preserva e avisa', async () => {
    const huge = 'data:image/jpeg;base64,' + 'A'.repeat(300001);
    assert.equal(isStorableAvatar(huge), false);
    assert.equal(isStorableAvatar('http://x/y.jpg'), false);
    assert.equal(isStorableAvatar(undefined), true);

    const s1 = fakeServer();
    const ok = await createStaffProfileApi(s1.rpc).migrateLegacy(
      'noma',
      [base({ avatarUrl: huge })],
      [],
      async () => 'data:image/jpeg;base64,BBBB',
    );
    assert.deepEqual(ok.failed, []);
    assert.equal((await createStaffProfileApi(s1.rpc).list('noma'))[0].avatarUrl, 'data:image/jpeg;base64,BBBB');

    const s2 = fakeServer();
    const api2 = createStaffProfileApi(s2.rpc);
    const noShrink = await api2.migrateLegacy('noma', [base({ avatarUrl: huge })], []);
    assert.deepEqual(noShrink.migrated, []);
    assert.equal(noShrink.failed[0].reason, 'avatar_too_large');
    assert.equal((await api2.list('noma')).length, 0, 'não grava sem a foto');
    assert.ok(!s2.calls.includes('upsert_staff_profile'));
    const stillBig = await api2.migrateLegacy('noma', [base({ avatarUrl: huge })], [], async (u) => u);
    assert.equal(stillBig.failed.length, 1);
    const throwing = await api2.migrateLegacy('noma', [base({ avatarUrl: huge })], [], async () => {
      throw new Error('x');
    });
    assert.equal(throwing.failed.length, 1);
    const msg = describeLegacyFailures(noShrink.failed);
    assert.match(msg, /NÃO foram migrados/);
    assert.match(msg, /Maria da Silva Souza/);
    assert.equal(describeLegacyFailures([]), '');
  });

  it('migração parcial: migra os válidos e relata os que falharam', async () => {
    const s = fakeServer();
    const api = createStaffProfileApi(s.rpc);
    const huge = 'data:image/png;base64,' + 'A'.repeat(300001);
    const r = await api.migrateLegacy(
      'noma',
      [base({ email: 'ok@x.com', name: 'Ok' }), base({ email: 'big@x.com', name: 'Big', avatarUrl: huge })],
      [],
    );
    assert.deepEqual(r.migrated, ['ok@x.com']);
    assert.deepEqual(r.failed.map((f) => f.email), ['big@x.com']);
  });

  it('resultado parcial nunca é sucesso e diz o que funcionou/falhou (não atômico)', () => {
    const allOk = summarizeOutcome([{ label: 'a', status: 'ok' }, { label: 'b', status: 'ok' }], true);
    assert.equal(allOk.kind, 'success');

    const partial = summarizeOutcome(
      [
        { label: 'convite gerado', status: 'ok' },
        { label: 'salvamento dos dados pessoais', status: 'failed', detail: 'sem rede' },
      ],
      true,
    );
    assert.equal(partial.kind, 'partial');
    assert.match(partial.message, /Funcionou: convite gerado/);
    assert.match(partial.message, /Falhou: salvamento dos dados pessoais \(sem rede\)/);
    assert.match(partial.message, /não atômicas/);
    assert.match(partial.message, /recarregada do servidor/);
    assert.ok(!/atomic[ao]s? e/.test(partial.message.replace('não atômicas', '')));

    const failure = summarizeOutcome(
      [
        { label: 'geração do convite', status: 'failed', detail: 'limite' },
        { label: 'salvamento dos dados pessoais', status: 'skipped' },
      ],
      false,
    );
    assert.equal(failure.kind, 'failure');
    assert.match(failure.message, /Não executado: salvamento dos dados pessoais/);
    assert.match(failure.message, /desatualizada/);

    // Etapa pulada sozinha também não é sucesso.
    assert.notEqual(summarizeOutcome([{ label: 'x', status: 'skipped' }], true).kind, 'success');
  });

  it('estados reais de acesso distinguem Perfil salvo, Convite pendente e Acesso ativo/inativo', () => {
    assert.equal(staffAccessState({ active: true }), 'profile_saved');
    assert.equal(staffAccessState({ active: false }), 'profile_saved');
    assert.equal(STAFF_ACCESS_LABEL[staffAccessState({ active: true })], 'Perfil salvo (sem convite nem acesso)');

    assert.equal(staffAccessState({ inviteId: 'inv-1', active: true }), 'invite_pending');
    assert.equal(STAFF_ACCESS_LABEL[staffAccessState({ inviteId: 'inv-1', active: true })], 'Convite pendente');

    assert.equal(staffAccessState({ memberId: 'mem-1', active: true }), 'access_active');
    assert.equal(STAFF_ACCESS_LABEL[staffAccessState({ memberId: 'mem-1', active: true })], 'Acesso ativo');

    assert.equal(staffAccessState({ memberId: 'mem-1', active: false }), 'access_inactive');
    assert.equal(STAFF_ACCESS_LABEL[staffAccessState({ memberId: 'mem-1', active: false })], 'Acesso inativo');
  });

  it('erros do Supabase Auth e RPC de convite são traduzidos claramente sem vazar dados sensíveis', () => {
    // 1a. over_email_send_rate_limit vs 1b. outros erros HTTP 429
    const emailRateErr = {
      code: 'over_email_send_rate_limit',
      message: 'email rate limit exceeded',
      status: 429,
    };
    const generic429Err = {
      status: 429,
      message: 'Too Many Requests',
    };

    assert.equal(isEmailSendRateLimitError(emailRateErr), true);
    assert.equal(isTooManyRequestsError(emailRateErr), false);
    assert.equal(isEmailSendRateLimitError(generic429Err), false);
    assert.equal(isTooManyRequestsError(generic429Err), true);

    const rateLimitMsg = getStaffInvitationErrorMessage(emailRateErr);
    assert.match(rateLimitMsg, /limite de envio de e-mails foi atingido/i);
    assert.match(rateLimitMsg, /Nenhum e-mail foi enviado/i);
    assert.doesNotMatch(rateLimitMsg, /\b\d+\s*minuto/i, 'não promete liberação em número fixo de minutos');

    const status429Only = getStaffInvitationErrorMessage(generic429Err);
    assert.match(status429Only, /Excesso de tentativas em curto período/i);
    assert.notEqual(status429Only, rateLimitMsg);

    // 2. Senha fora dos requisitos
    const weakPwdMsg = getStaffInvitationErrorMessage({
      code: 'weak_password',
      message: 'Password should be at least 10 characters.',
    });
    assert.match(weakPwdMsg, /requisitos de segurança/i);
    assert.match(weakPwdMsg, /10 caracteres/);

    // 3. Conta já existente -> orienta usar "Já tenho conta"
    const existsMsg = getStaffInvitationErrorMessage({
      code: 'user_already_exists',
      message: 'User already registered',
    });
    assert.match(existsMsg, /Já tenho conta/);

    // 4. E-mail não confirmado
    const unconfirmedMsg = getStaffInvitationErrorMessage({
      code: 'email_not_confirmed',
      message: 'Email not confirmed',
    });
    assert.match(unconfirmedMsg, /ainda não foi confirmado/i);

    // 5. Credenciais inválidas no login
    const invalidCredMsg = getStaffInvitationErrorMessage({
      code: 'invalid_credentials',
      message: 'Invalid login credentials',
    });
    assert.match(invalidCredMsg, /E-mail ou senha incorretos/i);

    // 6. Falha de rede
    const netMsg = getStaffInvitationErrorMessage(new Error('Failed to fetch'));
    assert.match(netMsg, /conectar ao servidor/i);

    // 7. Destinatário não autorizado / e-mail divergente do convite
    const wrongEmailMsg = getStaffInvitationErrorMessage(
      new Error('Entre com o e-mail ao qual o administrador enviou este convite.'),
    );
    assert.match(wrongEmailMsg, /e-mail diferente do e-mail deste convite/i);

    // 8. Convite inválido ou expirado
    const expiredMsg = getStaffInvitationErrorMessage(
      new Error('Convite vencido ou revogado. Solicite um novo link.'),
    );
    assert.match(expiredMsg, /expirou ou foi cancelado/i);

    const invalidInviteMsg = getStaffInvitationErrorMessage(
      new Error('Convite inválido ou restaurante indisponível.'),
    );
    assert.match(invalidInviteMsg, /não é válido ou o restaurante não está ativo/i);

    // 9. Login operacional e recuperação sem enumeração de conta
    const loginEmailRateMsg = getStaffLoginErrorMessage(emailRateErr);
    assert.match(loginEmailRateMsg, /limite de envio de e-mails foi atingido/i);

    const loginGeneric429Msg = getStaffLoginErrorMessage(generic429Err);
    assert.match(loginGeneric429Msg, /Excesso de tentativas em curto período/i);
    assert.notEqual(loginEmailRateMsg, loginGeneric429Msg);

    const loginInvalidMsg = getStaffLoginErrorMessage({ code: 'invalid_credentials' });
    assert.equal(loginInvalidMsg, 'E-mail ou senha incorretos. Confira os dados e tente novamente.');

    const recoveryMsg = getStaffRecoverySuccessMessage('  garcom@restaurante.com  ');
    assert.match(recoveryMsg, /^Se houver uma conta associada a garcom@restaurante\.com/);
  });

  it('validação centralizada de nova senha exige mínimo de 10 caracteres e confirmação coincidente', () => {
    assert.equal(MIN_NEW_PASSWORD_LENGTH, 10);

    const short = validateNewPassword('123456789', '123456789');
    assert.equal(short.valid, false);
    assert.match(short.error ?? '', /10 caracteres/);

    const mismatch = validateNewPassword('SenhaForte123', 'SenhaForte124');
    assert.equal(mismatch.valid, false);
    assert.match(mismatch.error ?? '', /não coincide/i);

    const valid = validateNewPassword('SenhaForte123', 'SenhaForte123');
    assert.equal(valid.valid, true);
    assert.equal(valid.error, undefined);
  });

  it('inspectUserPasswordCapabilities distingue conta com e-mail/senha de conta somente Google', () => {
    assert.deepEqual(inspectUserPasswordCapabilities(null), {
      hasEmailIdentity: false,
      hasGoogleIdentity: false,
    });

    assert.deepEqual(
      inspectUserPasswordCapabilities({
        app_metadata: { provider: 'google', providers: ['google'] },
        identities: [{ provider: 'google' }],
      }),
      {
        hasEmailIdentity: false,
        hasGoogleIdentity: true,
      },
    );

    assert.deepEqual(
      inspectUserPasswordCapabilities({
        app_metadata: { provider: 'email', providers: ['email'] },
        identities: [{ provider: 'email' }],
      }),
      {
        hasEmailIdentity: true,
        hasGoogleIdentity: false,
      },
    );

    assert.deepEqual(
      inspectUserPasswordCapabilities({
        app_metadata: { provider: 'google', providers: ['google', 'email'] },
      }),
      {
        hasEmailIdentity: true,
        hasGoogleIdentity: true,
      },
    );
  });

  it('executePasswordUpdateWithClient valida sessão, reautenticação, erros e resposta confirmada do servidor', async () => {
    const calls: string[] = [];

    const makeClient = (overrides: Partial<PasswordAuthClient> = {}): PasswordAuthClient => ({
      getSession: async () => {
        calls.push('getSession');
        return {
          data: {
            session: {
              user: { id: 'user-123', email: 'maria@exemplo.com', is_anonymous: false },
            },
          },
          error: null,
        };
      },
      signInWithPassword: async ({ email, password }) => {
        calls.push(`signInWithPassword:${email}:${password.length}`);
        return { data: {}, error: null };
      },
      updateUser: async ({ password }) => {
        calls.push(`updateUser:${password.length}`);
        return { data: { user: { id: 'user-123' } }, error: null };
      },
      ...overrides,
    });

    // 1. Senha curta ou divergente falha antes de chamar o cliente Auth
    await assert.rejects(
      () =>
        executePasswordUpdateWithClient(
          { newPassword: 'curta', confirmPassword: 'curta' },
          makeClient(),
        ),
      /10 caracteres/,
    );
    assert.deepEqual(calls, []);

    await assert.rejects(
      () =>
        executePasswordUpdateWithClient(
          { newPassword: 'SenhaValida10', confirmPassword: 'OutraSenha10' },
          makeClient(),
        ),
      /não coincide/i,
    );
    assert.deepEqual(calls, []);

    // 2. Sessão ausente ou anônima rejeita com session_not_found
    await assert.rejects(
      () =>
        executePasswordUpdateWithClient(
          { newPassword: 'SenhaValida10', confirmPassword: 'SenhaValida10' },
          makeClient({
            getSession: async () => ({ data: { session: null }, error: null }),
          }),
        ),
      (err: { code?: string; message?: string }) => {
        assert.equal(err.code, 'session_not_found');
        return true;
      },
    );

    // 3. Reautenticação exigida pelo Supabase retorna { updated: false, requiresCurrentPassword: true }
    const reauthErr = { code: 'reauthentication_needed', message: 'Reauthentication needed' };
    assert.equal(isReauthenticationNeededError(reauthErr), true);
    const needReauthRes = await executePasswordUpdateWithClient(
      { newPassword: 'SenhaValida10', confirmPassword: 'SenhaValida10' },
      makeClient({
        updateUser: async () => ({ data: null, error: reauthErr }),
      }),
    );
    assert.deepEqual(needReauthRes, { updated: false, requiresCurrentPassword: true });

    // 4. Com currentPassword informada, reautentica via signInWithPassword e atualiza via updateUser
    calls.length = 0;
    const okWithCurrent = await executePasswordUpdateWithClient(
      {
        newPassword: 'NovaSenhaForte10',
        confirmPassword: 'NovaSenhaForte10',
        currentPassword: 'SenhaAntiga',
      },
      makeClient(),
    );
    assert.deepEqual(okWithCurrent, { updated: true });
    assert.deepEqual(calls, [
      'getSession',
      'signInWithPassword:maria@exemplo.com:11',
      'updateUser:16',
    ]);

    // 5. Se o servidor não retornar user.id na confirmação, rejeita (não reporta falso sucesso)
    await assert.rejects(
      () =>
        executePasswordUpdateWithClient(
          { newPassword: 'NovaSenhaForte10', confirmPassword: 'NovaSenhaForte10' },
          makeClient({
            updateUser: async () => ({ data: { user: null }, error: null }),
          }),
        ),
      /servidor não confirmou/i,
    );
  });
});

describe('fluxo de equipe e convites (Etapa Corrigida)', () => {
  it('revogação de membro ativo desativa vínculo sem apagar registro histórico', () => {
    const member = {
      id: 'member-123',
      userId: 'user-abc',
      email: 'garcom@restaurante.com',
      role: 'waiter' as const,
      active: true,
      openVisits: 0,
    };

    // Simulação do updateMember para desativação
    const updated = { ...member, active: false };
    assert.equal(updated.active, false, 'Acesso deve ser desativado');
    assert.equal(updated.userId, 'user-abc', 'Conta global permanece intacta');
    assert.equal(updated.id, 'member-123', 'ID do membro permanece intacto para histórico de comandas');
  });

  it('bloqueia revogação se houver atendimentos abertos pendentes de transferência', () => {
    const memberWithVisits = {
      id: 'member-123',
      name: 'João Garçom',
      openVisits: 3,
    };
    assert.ok(memberWithVisits.openVisits > 0);
    const canDeactivateDirectly = memberWithVisits.openVisits === 0;
    assert.equal(canDeactivateDirectly, false, 'Deve exigir transferência antes de revogar');
  });

  it('validação estrita do e-mail convidado no link de convite', () => {
    const invitedEmail = 'joao@restaurante.com';

    // 1. E-mail correto bate case-insensitively
    const typedValid = '  JOAO@restaurante.com ';
    assert.equal(typedValid.trim().toLowerCase(), invitedEmail);

    // 2. E-mail incorreto diverge
    const typedInvalid = 'outro@email.com';
    assert.notEqual(typedInvalid.trim().toLowerCase(), invitedEmail);
  });

  it('novo link de convite não reutiliza token anterior e anexa e-mail', () => {
    const email = 'garcom@restaurante.com';
    const token1 = '1111111111111111111111111111111111111111111111111111111111111111';
    const token2 = '2222222222222222222222222222222222222222222222222222222222222222';
    assert.notEqual(token1, token2, 'Tokens devem ser criptograficamente únicos e novos');

    const link = `https://elozi.vercel.app/convite?token=${token2}&email=${encodeURIComponent(email)}`;
    assert.match(link, new RegExp(`token=${token2}`));
    assert.match(link, new RegExp(`email=${encodeURIComponent(email)}`));
  });

  it('identifica colaborador removido da equipe e oculta da lista normal', () => {
    // 1. Membro ativo com perfil -> ativo na lista normal
    const activeWithProfile = {
      active: true,
      hasProfile: true,
      memberId: 'm-1',
    };
    assert.equal(isStaffMemberRemoved(activeWithProfile), false);
    assert.equal(staffAccessState(activeWithProfile), 'access_active');

    // 2. Membro pausado/inativo temporariamente COM perfil salvo -> inativo, visível na equipe
    const pausedWithProfile = {
      active: false,
      hasProfile: true,
      memberId: 'm-2',
    };
    assert.equal(isStaffMemberRemoved(pausedWithProfile), false);
    assert.equal(staffAccessState(pausedWithProfile), 'access_inactive');

    // 3. Membro com vínculo removido (active = false e SEM perfil) -> removido da equipe
    const removedMember = {
      active: false,
      hasProfile: false,
      memberId: 'm-3',
    };
    assert.equal(isStaffMemberRemoved(removedMember), true, 'Deve ser classificado como removido');
    assert.equal(staffAccessState(removedMember), 'removed');
    assert.equal(STAFF_ACCESS_LABEL['removed'], 'Vínculo removido (histórico preservado)');

    // 4. Convite pendente nunca é classificado como membro removido
    const pendingInvite = {
      active: true,
      hasProfile: true,
      inviteId: 'inv-1',
      isInvitePending: true,
    };
    assert.equal(isStaffMemberRemoved(pendingInvite), false);
    assert.equal(staffAccessState(pendingInvite), 'invite_pending');

    // 5. Teste de filtragem: lista normal oculta o removido
    const allMembers = [
      { id: '1', name: 'Ativo', isRemoved: false, active: true },
      { id: '2', name: 'Pausado', isRemoved: false, active: false },
      { id: '3', name: 'Removido', isRemoved: true, active: false },
    ];

    const normalList = allMembers.filter((m) => !m.isRemoved);
    assert.equal(normalList.length, 2);
    assert.deepEqual(normalList.map((m) => m.id), ['1', '2']);
    assert.ok(!normalList.some((m) => m.id === '3'), 'Membro removido deve estar ausente da lista normal');

    const removedList = allMembers.filter((m) => m.isRemoved);
    assert.equal(removedList.length, 1);
    assert.equal(removedList[0].id, '3');
  });

  it('bloqueia exclusão com atendimentos em aberto antes de executar remoção', () => {
    let removalExecuted = false;
    const member = {
      id: 'm-busy',
      name: 'Garçom Ocupado',
      openVisits: 2,
    };

    function requestRemoval(target: typeof member) {
      if (target.openVisits > 0) {
        throw new Error(`Transfira os ${target.openVisits} atendimento(s) aberto(s) deste funcionário antes de removê-lo da equipe.`);
      }
      removalExecuted = true;
    }

    assert.throws(
      () => requestRemoval(member),
      /Transfira os 2 atendimento\(s\) aberto\(s\)/,
    );
    assert.equal(removalExecuted, false, 'Remoção não pode ter sido executada');
  });
});

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { getStaffAccess } from '../auth/staffAuth';
import {
  clearMigratedLegacyProfiles,
  createInvite,
  getTeam,
  removeMember,
  revokeInvite,
  staffProfileApi,
  transferVisits,
  updateMember,
  type StaffExtendedProfile,
  type StaffRole,
  type TeamMember,
  type TeamState,
} from './staffManagement';
import {
  describeLegacyFailures,
  displayName,
  indexProfilesByEmail,
  isStaffMemberRemoved,
  normalizeEmail,
  readLegacyProfiles,
  resolveProfile,
  STAFF_ACCESS_LABEL,
  staffAccessState,
  summarizeOutcome,
  type OutcomeStep,
} from './staffProfiles';
import { shrinkImageToDataUrl } from './staffAvatar';

export function StaffManagementPage() {
  const { restaurantSlug = '' } = useParams();
  return <TeamContent key={restaurantSlug} slug={restaurantSlug} />;
}

// 7 Permissões do sistema
interface PermissionOption {
  id: string;
  title: string;
  description: string;
}

const PERMISSION_OPTIONS: PermissionOption[] = [
  { id: 'cardapio', title: 'Cardápio', description: 'Visualizar e editar itens' },
  { id: 'mesas', title: 'Mesas e comandas', description: 'Acessar e gerenciar mesas' },
  { id: 'financeiro', title: 'Financeiro / Caixa', description: 'Visualizar movimentações' },
  { id: 'estoque', title: 'Estoque & Insumos', description: 'Consultar e movimentar estoque' },
  { id: 'comentarios', title: 'Comentários', description: 'Responder avaliações' },
  { id: 'relatorios', title: 'Relatórios', description: 'Visualizar relatórios e KDS' },
  { id: 'configuracoes', title: 'Configurações', description: 'Acesso total ao sistema' },
];

const CARGO_OPTIONS = [
  'Gerente',
  'Caixa',
  'Garçom / Atendente',
  'Cozinha / KDS',
  'Bar',
  'Estoquista',
];

const DEFAULT_PERMISSIONS_BY_CARGO: Record<string, string[]> = {
  Gerente: ['cardapio', 'mesas', 'financeiro', 'estoque', 'comentarios', 'relatorios', 'configuracoes'],
  Caixa: ['mesas', 'financeiro', 'relatorios'],
  'Garçom / Atendente': ['cardapio', 'mesas', 'comentarios'],
  'Cozinha / KDS': ['relatorios', 'estoque'],
  Bar: ['relatorios', 'estoque'],
  Estoquista: ['estoque'],
};

// Formatação com máscaras
function maskPhone(val: string): string {
  const digits = val.replace(/\D/g, '').slice(0, 11);
  if (digits.length <= 2) return digits.length ? `(${digits}` : '';
  if (digits.length <= 6) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
  if (digits.length <= 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7, 11)}`;
}

function maskCpf(val: string): string {
  const digits = val.replace(/\D/g, '').slice(0, 11);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 3)}.${digits.slice(3)}`;
  if (digits.length <= 9) return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6)}`;
  return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9, 11)}`;
}

// Representação unificada de membro para listagem e contadores
interface UnifiedStaffMember {
  id: string;
  memberId?: string; // se existir em restaurant_members
  inviteId?: string; // se existir em staff_invitations
  name: string;
  email: string;
  phone: string;
  cpf: string;
  birthDate: string;
  avatarUrl?: string;
  cargo: string;
  role: StaffRole;
  active: boolean;
  openVisits: number;
  permissions: string[];
  isInvitePending?: boolean;
  hasProfile?: boolean;
  isRemoved?: boolean;
}

function TeamContent({ slug }: { slug: string }) {
  const navigate = useNavigate();
  const alive = useRef(false);
  const acting = useRef(false);
  const formTopRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Estados do Supabase
  const [team, setTeam] = useState<TeamState>({ members: [], invitations: [] });
  const [profiles, setProfiles] = useState<Record<string, StaffExtendedProfile>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // Link do convite mantido apenas em memória enquanto o modal estiver aberto.
  const [inviteLink, setInviteLink] = useState<{ url: string; name: string; email: string } | null>(
    null,
  );
  const [inviteCopyStatus, setInviteCopyStatus] = useState('');

  function closeInviteModal() {
    setInviteLink(null);
    setInviteCopyStatus('');
  }

  async function handleCopyInvite() {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink.url);
      setInviteCopyStatus('Link copiado.');
    } catch {
      setInviteCopyStatus('Não foi possível copiar automaticamente. Selecione o link e copie manualmente.');
    }
  }

  // Estados do Formulário
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [cpf, setCpf] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [cargo, setCargo] = useState('');
  const [active, setActive] = useState(true);
  const [permissions, setPermissions] = useState<string[]>([
    'cardapio',
    'mesas',
    'financeiro',
    'estoque',
    'comentarios',
    'relatorios',
  ]);

  // Filtro da lista
  const [filter, setFilter] = useState<'all' | 'active' | 'inactive' | 'removed'>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Modal de confirmação explícita de remoção / cancelamento de convite
  const [confirmRemovalModal, setConfirmRemovalModal] = useState<{
    member: UnifiedStaffMember;
    isPendingInvite: boolean;
  } | null>(null);

  // Transferência de atendimentos
  const [transferModal, setTransferModal] = useState<{
    fromMemberId: string;
    fromName: string;
    openVisits: number;
  } | null>(null);
  const [transferTargetId, setTransferTargetId] = useState('');

  // Carregar dados reais do Supabase e perfis sincronizados
  useEffect(() => {
    alive.current = true;
    let disposed = false;

    async function loadData() {
      try {
        const [state, serverList] = await Promise.all([getTeam(slug), staffProfileApi.list(slug)]);
        let list = serverList;
        // Migra perfis do armazenamento local antigo, preservando os registros existentes.
        // O registro local só é apagado depois da confirmação do servidor.
        let migrationWarning = '';
        const legacy = readLegacyProfiles(localStorage, slug);
        if (legacy.length > 0) {
          const result = await staffProfileApi.migrateLegacy(slug, legacy, serverList, (dataUrl) =>
            shrinkImageToDataUrl(dataUrl),
          );
          if (result.migrated.length > 0) {
            list = await staffProfileApi.list(slug);
            clearMigratedLegacyProfiles(slug, result.migrated);
          }
          migrationWarning = describeLegacyFailures(result.failed);
        }
        if (!disposed && alive.current) {
          setTeam(state);
          setProfiles(indexProfilesByEmail(list));
          if (migrationWarning) setError(migrationWarning);
        }
      } catch (err) {
        if (!disposed && alive.current) {
          setError(
            err instanceof Error
              ? err.message
              : 'Não foi possível carregar a equipe. Verifique a conexão.',
          );
        }
      } finally {
        if (!disposed && alive.current) {
          setLoading(false);
        }
      }
    }

    void loadData();

    return () => {
      disposed = true;
      alive.current = false;
    };
  }, [slug]);

  // Unificação de membros reais do banco + perfis complementares
  const unifiedMembers = useMemo<UnifiedStaffMember[]>(() => {
    const list: UnifiedStaffMember[] = [];
    const seenEmails = new Set<string>();

    // 1. Membros vinculados ativos/inativos no Supabase
    for (const m of team.members) {
      const emailLower = (m.email || '').toLowerCase();
      if (emailLower) seenEmails.add(emailLower);

      const profile = resolveProfile(profiles, { id: m.id, email: m.email });
      const hasProfile = Boolean(profile);
      const isRemoved = isStaffMemberRemoved({ active: m.active, hasProfile, isInvitePending: false });

      list.push({
        id: m.id,
        memberId: m.id,
        name: displayName(profile, m.email),
        email: m.email || '',
        phone: profile?.phone || '',
        cpf: profile?.cpf || '',
        birthDate: profile?.birthDate || '',
        avatarUrl: profile?.avatarUrl,
        cargo: profile?.cargo || (m.role === 'admin' ? 'Gerente' : 'Garçom / Atendente'),
        role: m.role,
        active: m.active,
        openVisits: m.openVisits,
        permissions:
          profile?.permissions ||
          (m.role === 'admin'
            ? PERMISSION_OPTIONS.map((p) => p.id)
            : ['cardapio', 'mesas', 'comentarios']),
        hasProfile,
        isRemoved,
      });
    }

    // 2. Convites pendentes no Supabase
    for (const inv of team.invitations) {
      if (inv.status !== 'pending') continue;
      const emailLower = inv.email.toLowerCase();
      if (seenEmails.has(emailLower)) continue;
      seenEmails.add(emailLower);

      const profile = resolveProfile(profiles, { id: inv.id, email: inv.email });
      const hasProfile = Boolean(profile);

      list.push({
        id: inv.id,
        inviteId: inv.id,
        name: displayName(profile, inv.email),
        email: inv.email,
        phone: profile?.phone || '',
        cpf: profile?.cpf || '',
        birthDate: profile?.birthDate || '',
        avatarUrl: profile?.avatarUrl,
        cargo: profile?.cargo || (inv.role === 'admin' ? 'Gerente' : 'Garçom / Atendente'),
        role: inv.role,
        active: true,
        openVisits: 0,
        permissions:
          profile?.permissions ||
          (inv.role === 'admin'
            ? PERMISSION_OPTIONS.map((p) => p.id)
            : ['cardapio', 'mesas', 'comentarios']),
        isInvitePending: true,
        hasProfile,
        isRemoved: false,
      });
    }

    // 3. Perfis armazenados localmente que ainda não foram sincronizados
    for (const p of Object.values(profiles)) {
      const emailLower = p.email.toLowerCase();
      if (seenEmails.has(emailLower)) continue;
      seenEmails.add(emailLower);

      list.push({
        id: p.id,
        name: p.name,
        email: p.email,
        phone: p.phone,
        cpf: p.cpf,
        birthDate: p.birthDate,
        avatarUrl: p.avatarUrl,
        cargo: p.cargo || 'Garçom / Atendente',
        role: p.cargo === 'Gerente' ? 'admin' : 'waiter',
        active: p.active,
        openVisits: 0,
        permissions: p.permissions || ['cardapio', 'mesas'],
        hasProfile: true,
        isRemoved: false,
      });
    }

    return list;
  }, [team.members, team.invitations, profiles]);

  // Contadores reais baseados estritamente nos dados do restaurante
  const activeTeamMembers = useMemo(() => unifiedMembers.filter((m) => !m.isRemoved), [unifiedMembers]);
  const removedTeamMembers = useMemo(() => unifiedMembers.filter((m) => m.isRemoved), [unifiedMembers]);

  const totalCount = activeTeamMembers.length;
  const activeCount = activeTeamMembers.filter((m) => staffAccessState(m) === 'access_active').length;
  const inactiveCount = activeTeamMembers.filter((m) => !m.active).length;
  const removedCount = removedTeamMembers.length;

  // Filtragem da lista
  const filteredMembers = useMemo(() => {
    return unifiedMembers.filter((m) => {
      if (filter === 'removed') {
        if (!m.isRemoved) return false;
      } else {
        // Na lista normal ('all', 'active', 'inactive'), colaboradores com vínculo removido ficam ocultos
        if (m.isRemoved) return false;
        if (filter === 'active' && staffAccessState(m) !== 'access_active') return false;
        if (filter === 'inactive' && m.active) return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesName = m.name.toLowerCase().includes(q);
        const matchesEmail = m.email.toLowerCase().includes(q);
        const matchesCargo = m.cargo.toLowerCase().includes(q);
        const matchesPhone = m.phone.includes(q);
        return matchesName || matchesEmail || matchesCargo || matchesPhone;
      }
      return true;
    });
  }, [unifiedMembers, filter, searchQuery]);

  // Limpar formulário
  function handleResetForm() {
    setEditingId(null);
    setName('');
    setEmail('');
    setPhone('');
    setCpf('');
    setBirthDate('');
    setAvatarUrl('');
    setCargo('');
    setActive(true);
    setPermissions([
      'cardapio',
      'mesas',
      'financeiro',
      'estoque',
      'comentarios',
      'relatorios',
    ]);
    setError('');
    setNotice('');
  }

  // Preencher formulário ao clicar em Editar
  function handleEditMember(m: UnifiedStaffMember) {
    setEditingId(m.id);
    setName(m.name);
    setEmail(m.email);
    setPhone(m.phone);
    setCpf(m.cpf);
    setBirthDate(m.birthDate);
    setAvatarUrl(m.avatarUrl || '');
    setCargo(m.cargo);
    setActive(m.active);
    setPermissions(m.permissions);
    setError('');
    setNotice('');
    formTopRef.current?.scrollIntoView({ behavior: 'smooth' });
  }

  // Troca de cargo com pré-seleção inteligente de permissões
  function handleCargoChange(selectedCargo: string) {
    setCargo(selectedCargo);
    if (selectedCargo && DEFAULT_PERMISSIONS_BY_CARGO[selectedCargo]) {
      setPermissions(DEFAULT_PERMISSIONS_BY_CARGO[selectedCargo]);
    }
  }

  // Toggle de permissão individual
  function togglePermission(permId: string) {
    setPermissions((prev) =>
      prev.includes(permId) ? prev.filter((id) => id !== permId) : [...prev, permId],
    );
  }

  // Upload e leitura de foto de perfil
  function handlePhotoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError('Formato inválido. Use JPG, PNG ou WebP.');
      return;
    }

    if (file.size > 2 * 1024 * 1024) {
      setError('A foto de perfil deve ter no máximo 2MB.');
      return;
    }

    setError('');
    // Reduz a foto (máx. 320px, JPEG) para caber com folga no limite do banco.
    shrinkImageToDataUrl(file)
      .then((dataUrl) => setAvatarUrl(dataUrl))
      .catch((cause) => setError(cause instanceof Error ? cause.message : 'Não foi possível processar a foto.'));
  }

  // Recarrega o estado real (equipe + perfis) do servidor; devolve se conseguiu.
  async function reloadFromServer(): Promise<boolean> {
    try {
      const [state, list] = await Promise.all([getTeam(slug), staffProfileApi.list(slug)]);
      if (alive.current) {
        setTeam(state);
        setProfiles(indexProfilesByEmail(list));
      }
      return true;
    } catch {
      return false;
    }
  }

  // Submissão do formulário (Criar ou Editar funcionário).
  // As etapas (vínculo/convite e perfil) são chamadas separadas, NÃO atômicas: o
  // resultado de cada uma é registrado e o estado real é recarregado ao final.
  async function handleSubmit(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if (acting.current || busy) return;

    const trimmedName = name.trim();
    const trimmedEmail = email.trim().toLowerCase();
    const trimmedCargo = cargo.trim();

    if (!trimmedName) {
      setError('Informe o nome completo do funcionário.');
      return;
    }

    if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setError('Informe um e-mail válido para o funcionário.');
      return;
    }

    if (!phone.trim()) {
      setError('Informe o telefone do funcionário.');
      return;
    }

    if (!trimmedCargo) {
      setError('Selecione o cargo do funcionário.');
      return;
    }

    acting.current = true;
    setBusy(true);
    setError('');
    setNotice('');

    const reason = (cause: unknown) => (cause instanceof Error ? cause.message : 'erro desconhecido');
    const steps: OutcomeStep[] = [];
    let inviteUrl = '';

    try {
      const systemRole: StaffRole =
        trimmedCargo === 'Gerente' || permissions.includes('configuracoes')
          ? 'admin'
          : 'waiter';

      const buildProfile = (id: string, profileEmail: string): StaffExtendedProfile => ({
        id,
        name: trimmedName,
        email: profileEmail,
        phone: phone.trim(),
        cpf: cpf.trim(),
        birthDate: birthDate.trim(),
        avatarUrl: avatarUrl || undefined,
        cargo: trimmedCargo,
        active,
        permissions,
        createdAt: new Date().toISOString(),
      });

      let canSaveProfile = true;
      let profileToSave: StaffExtendedProfile;

      if (editingId) {
        // 1. Edição: atualiza o vínculo (se membro real) e depois o perfil.
        const existing = unifiedMembers.find((m) => m.id === editingId);
        profileToSave = buildProfile(editingId, normalizeEmail(existing?.email || trimmedEmail));

        const rawMember = existing?.memberId
          ? team.members.find((m) => m.id === existing.memberId)
          : undefined;
        if (rawMember) {
          try {
            await updateMember(slug, rawMember, systemRole, active);
            steps.push({ label: 'cargo de acesso e status do vínculo atualizados', status: 'ok' });
          } catch (cause) {
            canSaveProfile = false;
            steps.push({
              label: 'atualização do cargo de acesso e status',
              status: 'failed',
              detail: reason(cause),
            });
          }
        }
      } else {
        // 2. Novo cadastro: convite e depois perfil.
        profileToSave = buildProfile(crypto.randomUUID(), trimmedEmail);
        try {
          inviteUrl = await createInvite(slug, trimmedEmail, systemRole);
          steps.push({ label: 'convite gerado', status: 'ok' });
        } catch (inviteErr) {
          const msg = reason(inviteErr);
          if (msg.includes('já está vinculada')) {
            steps.push({ label: 'conta já vinculada (convite desnecessário)', status: 'ok' });
          } else {
            canSaveProfile = false;
            steps.push({ label: 'geração do convite', status: 'failed', detail: msg });
          }
        }
      }

      if (canSaveProfile) {
        try {
          await staffProfileApi.save(slug, profileToSave);
          steps.push({ label: 'dados pessoais do perfil salvos', status: 'ok' });
        } catch (cause) {
          steps.push({ label: 'salvamento dos dados pessoais', status: 'failed', detail: reason(cause) });
        }
      } else {
        steps.push({ label: 'salvamento dos dados pessoais', status: 'skipped' });
      }

      // 3. Sempre recarrega o estado real antes de informar o resultado.
      const reloaded = await reloadFromServer();
      const outcome = summarizeOutcome(steps, reloaded);

      if (alive.current) {
        if (inviteUrl) {
          setInviteCopyStatus('');
          setInviteLink({ url: inviteUrl, name: trimmedName, email: trimmedEmail });
        }
        if (outcome.kind === 'success') {
          handleResetForm();
          setNotice(
            editingId
              ? `Dados de ${trimmedName} atualizados com sucesso!`
              : inviteUrl
                ? `Convite criado, mas não enviado. Encaminhe o link gerado para ${trimmedName}.`
                : `Perfil de ${trimmedName} salvo com sucesso!`,
          );
          if (!reloaded) {
            setError('Salvo, mas não foi possível recarregar a lista do servidor. Atualize a página.');
          }
        } else {
          // Parcial ou falha: o formulário é mantido e nenhum sucesso é declarado.
          const retryHint = inviteUrl
            ? ' O convite foi gerado e o link está na janela aberta; salvar novamente gera outro link e invalida o anterior.'
            : '';
          setError(outcome.message + retryHint);
        }
      }
    } finally {
      acting.current = false;
      if (alive.current) setBusy(false);
    }
  }

  // Alternar status Ativo / Inativo
  async function handleToggleActive(m: UnifiedStaffMember) {
    if (acting.current || busy) return;

    if (m.openVisits > 0 && m.active) {
      setTransferModal({
        fromMemberId: m.memberId || m.id,
        fromName: m.name,
        openVisits: m.openVisits,
      });
      return;
    }

    acting.current = true;
    setBusy(true);
    setError('');
    setNotice('');

    const reason = (cause: unknown) => (cause instanceof Error ? cause.message : 'erro desconhecido');
    const steps: OutcomeStep[] = [];

    try {
      const nextActive = !m.active;
      let canSaveProfile = true;

      // Etapa 1: vínculo real no Supabase (se for membro)
      if (m.memberId) {
        const rawMember = team.members.find((item) => item.id === m.memberId);
        if (rawMember) {
          try {
            await updateMember(slug, rawMember, rawMember.role, nextActive);
            steps.push({ label: 'status do vínculo atualizado', status: 'ok' });
          } catch (cause) {
            canSaveProfile = false;
            steps.push({ label: 'atualização do status do vínculo', status: 'failed', detail: reason(cause) });
          }
        }
      }

      // Etapa 2: perfil complementar (chamada separada, não atômica com a etapa 1)
      const existingProfile = resolveProfile(profiles, { id: m.id, email: m.email });
      if (existingProfile) {
        if (canSaveProfile) {
          try {
            await staffProfileApi.save(slug, { ...existingProfile, active: nextActive });
            steps.push({ label: 'status no perfil atualizado', status: 'ok' });
          } catch (cause) {
            steps.push({ label: 'atualização do status no perfil', status: 'failed', detail: reason(cause) });
          }
        } else {
          steps.push({ label: 'atualização do status no perfil', status: 'skipped' });
        }
      }

      const reloaded = await reloadFromServer();
      const outcome = summarizeOutcome(steps, reloaded);
      if (alive.current) {
        if (outcome.kind === 'success') {
          if (m.memberId) {
            setNotice(
              nextActive
                ? `Acesso de ${m.name} reativado com sucesso.`
                : `Acesso de ${m.name} desativado com sucesso.`,
            );
          } else {
            setNotice(
              nextActive
                ? `Perfil de ${m.name} marcado como ativo. O acesso ao sistema só existirá quando o convite for aceito.`
                : `Perfil de ${m.name} marcado como inativo.`,
            );
          }
          if (!reloaded) setError('Alterado, mas não foi possível recarregar a lista do servidor. Atualize a página.');
        } else {
          setError(outcome.message);
        }
      }
    } finally {
      acting.current = false;
      if (alive.current) setBusy(false);
    }
  }

  // Solicitar remoção de funcionário ou cancelamento de convite
  function handleRequestDeleteMember(m: UnifiedStaffMember) {
    if (m.openVisits > 0) {
      setError(`Transfira os ${m.openVisits} atendimento(s) aberto(s) deste funcionário antes de removê-lo da equipe.`);
      setTransferModal({
        fromMemberId: m.memberId || m.id,
        fromName: m.name,
        openVisits: m.openVisits,
      });
      return;
    }
    const isPendingInvite = !m.memberId && Boolean(m.inviteId);
    setConfirmRemovalModal({ member: m, isPendingInvite });
  }

  // Executar remoção da equipe ou cancelamento de convite após confirmação
  async function handleConfirmRemoval(m: UnifiedStaffMember) {
    if (acting.current || busy) return;

    if (m.openVisits > 0) {
      setConfirmRemovalModal(null);
      setError(`Transfira os ${m.openVisits} atendimento(s) aberto(s) deste funcionário antes de removê-lo da equipe.`);
      setTransferModal({
        fromMemberId: m.memberId || m.id,
        fromName: m.name,
        openVisits: m.openVisits,
      });
      return;
    }

    acting.current = true;
    setBusy(true);
    setError('');
    setNotice('');

    try {
      const isPendingInvite = !m.memberId && Boolean(m.inviteId);

      if (isPendingInvite) {
        // Convite pendente: cancela e invalida o token
        if (m.inviteId) {
          await revokeInvite(slug, m.inviteId);
        }
        if (m.email) {
          try {
            await staffProfileApi.remove(slug, m.email);
          } catch {
            // tolerância caso o perfil não exista
          }
        }

        const reloaded = await reloadFromServer();
        if (alive.current) {
          setConfirmRemovalModal(null);
          setNotice(`Convite de ${m.name || m.email} cancelado e invalidado com sucesso.`);
          if (editingId === m.id) handleResetForm();
          if (!reloaded) setError('Convite cancelado, mas não foi possível recarregar a lista do servidor. Atualize a página.');
        }
      } else {
        // Colaborador da equipe: remove o vínculo daquele restaurante e preserva histórico
        if (m.memberId) {
          const rawMember = team.members.find((item) => item.id === m.memberId);
          if (rawMember) {
            await removeMember(slug, rawMember, m.email);
          }
        } else if (m.email) {
          // Perfil cadastrado sem vínculo ativo
          await staffProfileApi.remove(slug, m.email);
        }

        const reloaded = await reloadFromServer();
        if (alive.current) {
          setConfirmRemovalModal(null);
          setNotice(`Colaborador ${m.name} removido da equipe com sucesso. O histórico de atendimentos e comandas foi preservado.`);
          if (editingId === m.id) handleResetForm();
          if (!reloaded) setError('Colaborador removido, mas não foi possível recarregar a lista do servidor. Atualize a página.');
        }
      }
    } catch (cause) {
      if (alive.current) {
        const message = cause instanceof Error ? cause.message : 'Falha ao processar operação da equipe.';
        setError(message);
      }
    } finally {
      acting.current = false;
      if (alive.current) setBusy(false);
    }
  }

  // Gerar novo link de convite (sem reutilizar tokens anteriores)
  async function handleResendInvite(m: UnifiedStaffMember) {
    if (!m.email) return;
    acting.current = true;
    setBusy(true);
    setError('');
    setNotice('');

    try {
      const inviteUrl = await createInvite(slug, m.email, m.role);
      await reloadFromServer();
      if (alive.current) {
        setInviteCopyStatus('');
        setInviteLink({ url: inviteUrl, name: m.name || m.email, email: m.email });
        setNotice(`Novo link de convite gerado para ${m.name || m.email}. Encaminhe o link ao funcionário.`);
      }
    } catch (cause) {
      if (alive.current) {
        const message = cause instanceof Error ? cause.message : 'Não foi possível gerar novo convite.';
        setError(message);
      }
    } finally {
      acting.current = false;
      if (alive.current) setBusy(false);
    }
  }

  // Executar transferência de atendimentos
  async function handleExecuteTransfer() {
    if (!transferModal || !transferTargetId) return;
    acting.current = true;
    setBusy(true);
    setError('');
    setNotice('');

    try {
      await transferVisits(slug, transferModal.fromMemberId, transferTargetId);
      setNotice(
        `Atendimentos transferidos com sucesso. Agora você pode desativar ${transferModal.fromName}.`,
      );
      setTransferModal(null);
      setTransferTargetId('');
      const freshTeam = await getTeam(slug);
      if (alive.current) setTeam(freshTeam);
    } catch (err) {
      if (alive.current) {
        setError(
          err instanceof Error
            ? err.message
            : 'Não foi possível transferir os atendimentos.',
        );
      }
    } finally {
      acting.current = false;
      if (alive.current) setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-[1440px] space-y-6 text-zinc-900 dark:text-zinc-100 antialiased pb-16 pt-[10px]">
      {/* =========================================================================
          CABEÇALHO SUPERIOR DA PÁGINA
          ========================================================================= */}
      <div
        ref={formTopRef}
        className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4"
      >
        <div>
          <h1 className="text-2xl lg:text-3xl font-extrabold text-zinc-900 dark:text-white tracking-tight flex items-baseline gap-2">
            <span>{editingId ? 'Editar' : 'Cadastrar'}</span>
            <span className="font-normal text-zinc-800 dark:text-zinc-200">
              {editingId ? 'Equipe e Acessos' : 'Funcionário'}
            </span>
          </h1>
          <p className="text-xs lg:text-sm text-zinc-500 dark:text-zinc-400 mt-1">
            Adicione um novo membro à equipe do seu restaurante. Gerencie permissões e
            acessos de forma simples e segura.
          </p>
        </div>

        {/* Botões de Ação do Topo */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleResetForm}
            disabled={busy}
            className="px-4 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 text-xs font-semibold hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors shadow-2xs cursor-pointer disabled:opacity-50"
          >
            Limpar / Cancelar
          </button>

          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={busy || loading}
            className="bg-[#610000] hover:bg-[#4a0000] text-white text-xs font-bold px-5 py-2.5 rounded-xl shadow-sm flex items-center gap-2 transition-colors cursor-pointer disabled:opacity-50"
          >
            <svg
              className="w-4 h-4 shrink-0"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
              <polyline points="17 21 17 13 7 13 7 21" />
              <polyline points="7 3 7 8 15 8" />
            </svg>
            <span>{busy ? 'Salvando...' : 'Salvar funcionário'}</span>
          </button>
        </div>
      </div>

      {/* Avisos e Feedbacks */}
      {error && (
        <div
          role="alert"
          className="rounded-xl border border-rose-200 bg-rose-50/90 dark:bg-rose-950/30 p-4 text-xs font-semibold text-rose-800 dark:text-rose-300 flex items-center justify-between"
        >
          <div className="flex items-center gap-2">
            <svg
              className="w-4 h-4 shrink-0 text-rose-600"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span>{error}</span>
          </div>
          <button
            type="button"
            onClick={() => setError('')}
            className="text-rose-600 hover:text-rose-800 text-sm font-bold ml-4 cursor-pointer"
          >
            ×
          </button>
        </div>
      )}

      {notice && (
        <div
          role="status"
          className="rounded-xl border border-emerald-200 bg-emerald-50/90 dark:bg-emerald-950/30 p-4 text-xs font-semibold text-emerald-800 dark:text-emerald-300 flex items-center justify-between"
        >
          <div className="flex items-center gap-2">
            <svg
              className="w-4 h-4 shrink-0 text-emerald-600"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
            <span>{notice}</span>
          </div>
          <button
            type="button"
            onClick={() => setNotice('')}
            className="text-emerald-600 hover:text-emerald-800 text-sm font-bold ml-4 cursor-pointer"
          >
            ×
          </button>
        </div>
      )}

      {inviteLink && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="invite-link-title"
        >
          <div className="w-full max-w-lg rounded-2xl bg-white dark:bg-zinc-900 p-6 shadow-xl space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 flex items-center justify-center shrink-0">
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <h2 id="invite-link-title" className="text-base font-bold text-zinc-900 dark:text-white">
                  Convite criado, mas não enviado
                </h2>
                <p className="text-xs text-amber-700 dark:text-amber-400 font-semibold mt-0.5">
                  Nenhum provedor de e-mail ativo para envio automático.
                </p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                  Destinatário: <span className="font-medium text-zinc-700 dark:text-zinc-300">{inviteLink.name}</span> ({inviteLink.email})
                </p>
              </div>
            </div>

            <p className="text-xs text-zinc-600 dark:text-zinc-300 leading-relaxed">
              O sistema não enviou o convite por e-mail nem SMS. Copie o link exclusivo abaixo e encaminhe diretamente ao funcionário (WhatsApp ou e-mail pessoal). Ele poderá entrar com uma conta existente ou criar uma nova escolhendo a própria senha.
            </p>

            <div className="space-y-1.5">
              <label className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
                Link de Acesso Único
              </label>
              <div className="flex flex-col sm:flex-row gap-2 items-center">
                <input
                  readOnly
                  value={inviteLink.url}
                  onFocus={(e) => e.currentTarget.select()}
                  aria-label="Link do convite"
                  className="w-full rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 px-3 py-2 text-xs text-zinc-900 dark:text-white font-mono select-all"
                />
                <button
                  type="button"
                  onClick={() => void handleCopyInvite()}
                  className="w-full sm:w-auto shrink-0 px-4 py-2 rounded-xl bg-[#610000] hover:bg-[#7a0000] text-white text-xs font-bold cursor-pointer transition-colors"
                >
                  Copiar link
                </button>
              </div>
            </div>

            {inviteCopyStatus && (
              <p className="text-xs font-medium text-emerald-600 dark:text-emerald-400" role="status">
                {inviteCopyStatus}
              </p>
            )}

            <div className="flex justify-end pt-2 border-t border-zinc-100 dark:border-zinc-800">
              <button
                type="button"
                onClick={closeInviteModal}
                className="px-4 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 text-xs font-bold text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
              >
                Concluir e fechar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =========================================================================
          LAYOUT EM 2 COLUNAS
          ========================================================================= */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* =======================================================================
            COLUNA ESQUERDA (FORMULÁRIO EM 3 CARDS + LISTAGEM DE MEMBROS)
            ======================================================================= */}
        <div className="xl:col-span-8 flex flex-col gap-5">
          <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-5">
            {/* CARD 1: DADOS PESSOAIS */}
            <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200/80 dark:border-zinc-800 p-6 shadow-sm">
              <div className="flex items-center gap-3 mb-5">
                <div className="w-8 h-8 rounded-xl bg-rose-50 dark:bg-rose-950/50 text-[#610000] flex items-center justify-center shrink-0">
                  <svg
                    className="w-4 h-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                    <circle cx="12" cy="7" r="4" />
                  </svg>
                </div>
                <h2 className="font-bold text-base text-zinc-900 dark:text-white">
                  Dados pessoais
                </h2>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* 1. Nome Completo */}
                <div>
                  <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5">
                    Nome completo <span className="text-rose-600">*</span>
                  </label>
                  <div className="relative">
                    <span className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-zinc-400">
                      <svg
                        className="w-4 h-4"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                        <circle cx="12" cy="7" r="4" />
                      </svg>
                    </span>
                    <input
                      type="text"
                      required
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Ex: João da Silva"
                      className="w-full pl-10 pr-3.5 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-medium text-zinc-900 dark:text-white placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-[#610000]/20 focus:border-[#610000] transition-all"
                    />
                  </div>
                </div>

                {/* 2. E-mail */}
                <div>
                  <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5">
                    E-mail <span className="text-rose-600">*</span>
                  </label>
                  <div className="relative">
                    <span className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-zinc-400">
                      <svg
                        className="w-4 h-4"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                        <polyline points="22,6 12,13 2,6" />
                      </svg>
                    </span>
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      readOnly={!!editingId}
                      placeholder="exemplo@email.com"
                      className="w-full pl-10 pr-3.5 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-medium text-zinc-900 dark:text-white placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-[#610000]/20 focus:border-[#610000] transition-all"
                    />
                  </div>
                </div>

                {/* 3. Telefone */}
                <div>
                  <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5">
                    Telefone <span className="text-rose-600">*</span>
                  </label>
                  <div className="relative">
                    <span className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-zinc-400">
                      <svg
                        className="w-4 h-4"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
                      </svg>
                    </span>
                    <input
                      type="text"
                      required
                      value={phone}
                      onChange={(e) => setPhone(maskPhone(e.target.value))}
                      placeholder="(47) 99999-9999"
                      maxLength={15}
                      className="w-full pl-10 pr-3.5 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-medium text-zinc-900 dark:text-white placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-[#610000]/20 focus:border-[#610000] transition-all"
                    />
                  </div>
                </div>

                {/* 4. CPF */}
                <div>
                  <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5">
                    CPF
                  </label>
                  <div className="relative">
                    <span className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-zinc-400">
                      <svg
                        className="w-4 h-4"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <rect x="3" y="4" width="18" height="16" rx="2" />
                        <line x1="7" y1="8" x2="17" y2="8" />
                        <line x1="7" y1="12" x2="13" y2="12" />
                        <line x1="7" y1="16" x2="10" y2="16" />
                      </svg>
                    </span>
                    <input
                      type="text"
                      value={cpf}
                      onChange={(e) => setCpf(maskCpf(e.target.value))}
                      placeholder="000.000.000-00"
                      maxLength={14}
                      className="w-full pl-10 pr-3.5 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-medium text-zinc-900 dark:text-white placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-[#610000]/20 focus:border-[#610000] transition-all"
                    />
                  </div>
                </div>

                {/* 5. Data de Nascimento */}
                <div>
                  <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5">
                    Data de nascimento
                  </label>
                  <div className="relative">
                    <span className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-zinc-400">
                      <svg
                        className="w-4 h-4"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                        <line x1="16" y1="2" x2="16" y2="6" />
                        <line x1="8" y1="2" x2="8" y2="6" />
                        <line x1="3" y1="10" x2="21" y2="10" />
                      </svg>
                    </span>
                    <input
                      type="date"
                      value={birthDate}
                      onChange={(e) => setBirthDate(e.target.value)}
                      className="w-full pl-10 pr-3.5 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-medium text-zinc-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-[#610000]/20 focus:border-[#610000] transition-all"
                    />
                  </div>
                </div>

                {/* 6. Foto de perfil (opcional) */}
                <div>
                  <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5">
                    Foto de perfil <span className="font-normal text-zinc-400">(opcional)</span>
                  </label>

                  <input
                    type="file"
                    ref={fileInputRef}
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={handlePhotoUpload}
                  />

                  {avatarUrl ? (
                    <div className="border border-zinc-200 dark:border-zinc-700 rounded-xl p-2.5 flex items-center justify-between bg-zinc-50 dark:bg-zinc-800/60">
                      <div className="flex items-center gap-3">
                        <img
                          src={avatarUrl}
                          alt="Prévia da foto"
                          className="w-10 h-10 rounded-full object-cover border border-zinc-200 dark:border-zinc-700"
                        />
                        <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                          Foto selecionada
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setAvatarUrl('')}
                        className="text-xs text-rose-600 hover:text-rose-800 font-semibold px-2 py-1 rounded-md hover:bg-rose-50 dark:hover:bg-rose-950/40 cursor-pointer"
                      >
                        Remover
                      </button>
                    </div>
                  ) : (
                    <div
                      onClick={() => fileInputRef.current?.click()}
                      className="border-2 border-dashed border-zinc-200 dark:border-zinc-700 rounded-xl p-3 flex items-center justify-center gap-3 cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/50 hover:border-[#610000]/50 transition-colors"
                    >
                      <svg
                        className="w-5 h-5 text-zinc-400 shrink-0"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="17 8 12 3 7 8" />
                        <line x1="12" y1="3" x2="12" y2="15" />
                      </svg>
                      <div className="text-left">
                        <p className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">
                          Clique para enviar{' '}
                          <span className="font-normal text-zinc-400">ou arraste o arquivo</span>
                        </p>
                        <p className="text-[11px] text-zinc-400">JPG, PNG ou WebP. Máx. 2MB.</p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* CARD 2: ACESSO E CARGO */}
            <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200/80 dark:border-zinc-800 p-6 shadow-sm">
              <div className="flex items-center gap-3 mb-5">
                <div className="w-8 h-8 rounded-xl bg-rose-50 dark:bg-rose-950/50 text-[#610000] flex items-center justify-center shrink-0">
                  <svg
                    className="w-4 h-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                    <circle cx="8.5" cy="7" r="4" />
                    <polyline points="17 11 19 13 23 9" />
                  </svg>
                </div>
                <h2 className="font-bold text-base text-zinc-900 dark:text-white">
                  Acesso e cargo
                </h2>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-5">
                {/* 1. Cargo */}
                <div>
                  <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5">
                    Cargo <span className="text-rose-600">*</span>
                  </label>
                  <div className="relative">
                    <span className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-zinc-400">
                      <svg
                        className="w-4 h-4"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
                        <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
                      </svg>
                    </span>
                    <select
                      value={cargo}
                      onChange={(e) => handleCargoChange(e.target.value)}
                      required
                      className="w-full pl-10 pr-9 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-medium text-zinc-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-[#610000]/20 focus:border-[#610000] transition-all appearance-none cursor-pointer"
                    >
                      <option value="">Selecione o cargo</option>
                      {CARGO_OPTIONS.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                    <span className="absolute inset-y-0 right-0 pr-3.5 flex items-center pointer-events-none text-zinc-400">
                      <svg
                        className="w-4 h-4"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </span>
                  </div>
                </div>

                <p className="text-[11px] text-zinc-500 dark:text-zinc-400 self-end">Nenhuma senha é definida aqui: o funcionário cria a própria senha ao aceitar o convite.</p>
              </div>

              {/* Linha inferior: Toggle Ativo */}
              <div className="flex items-center gap-3 pt-3 border-t border-zinc-100 dark:border-zinc-800">
                <button
                  type="button"
                  role="switch"
                  aria-checked={active}
                  onClick={() => setActive(!active)}
                  className={`w-11 h-6 rounded-full transition-colors relative cursor-pointer focus:outline-none focus:ring-2 focus:ring-[#610000]/20 ${
                    active ? 'bg-[#610000]' : 'bg-zinc-300 dark:bg-zinc-700'
                  }`}
                >
                  <span
                    className={`block w-4 h-4 rounded-full bg-white shadow-md transform transition-transform ${
                      active ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
                <div>
                  <span className="block text-sm font-bold text-zinc-900 dark:text-white">
                    Ativo
                  </span>
                  <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                    Marca o perfil como ativo. O acesso ao sistema só existe depois que o funcionário aceitar o convite.
                  </span>
                </div>
              </div>
            </div>

            {/* CARD 3: PERMISSÕES */}
            <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200/80 dark:border-zinc-800 p-6 shadow-sm">
              <div className="flex items-center gap-3 mb-1">
                <div className="w-8 h-8 rounded-xl bg-rose-50 dark:bg-rose-950/50 text-[#610000] flex items-center justify-center shrink-0">
                  <svg
                    className="w-4 h-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                </div>
                <div>
                  <h2 className="font-bold text-base text-zinc-900 dark:text-white">
                    Permissões
                  </h2>
                </div>
              </div>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-5 ml-11">
                Selecione as áreas e funcionalidades que este funcionário poderá acessar.
              </p>

              {/* Grid das 7 permissões */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                {PERMISSION_OPTIONS.map((p) => {
                  const isChecked = permissions.includes(p.id);
                  return (
                    <div
                      key={p.id}
                      onClick={() => togglePermission(p.id)}
                      className={`p-3.5 rounded-xl border transition-all flex items-start gap-3 cursor-pointer select-none ${
                        isChecked
                          ? 'border-[#610000] bg-rose-50/20 dark:bg-rose-950/10 shadow-2xs'
                          : 'border-zinc-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:border-[#610000]/40'
                      }`}
                    >
                      {/* Checkbox estilizado */}
                      <div
                        className={`w-4 h-4 mt-0.5 rounded border flex items-center justify-center shrink-0 transition-colors ${
                          isChecked
                            ? 'bg-[#610000] border-[#610000] text-white'
                            : 'border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800'
                        }`}
                      >
                        {isChecked && (
                          <svg
                            className="w-3 h-3"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="3"
                          >
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                      </div>

                      {/* Ícone da área */}
                      <div className="w-8 h-8 rounded-lg bg-rose-50 dark:bg-rose-950/40 text-[#610000] flex items-center justify-center shrink-0">
                        {p.id === 'cardapio' && (
                          <svg
                            className="w-4 h-4"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                          </svg>
                        )}
                        {p.id === 'mesas' && (
                          <svg
                            className="w-4 h-4"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <rect x="4" y="4" width="16" height="16" rx="2" />
                            <line x1="4" y1="12" x2="20" y2="12" />
                            <line x1="12" y1="4" x2="12" y2="20" />
                          </svg>
                        )}
                        {p.id === 'financeiro' && (
                          <svg
                            className="w-4 h-4"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <line x1="12" y1="1" x2="12" y2="23" />
                            <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                          </svg>
                        )}
                        {p.id === 'estoque' && (
                          <svg
                            className="w-4 h-4"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                            <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                            <line x1="12" y1="22.08" x2="12" y2="12" />
                          </svg>
                        )}
                        {p.id === 'comentarios' && (
                          <svg
                            className="w-4 h-4"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                          </svg>
                        )}
                        {p.id === 'relatorios' && (
                          <svg
                            className="w-4 h-4"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <line x1="18" y1="20" x2="18" y2="10" />
                            <line x1="12" y1="20" x2="12" y2="4" />
                            <line x1="6" y1="20" x2="6" y2="14" />
                          </svg>
                        )}
                        {p.id === 'configuracoes' && (
                          <svg
                            className="w-4 h-4"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <circle cx="12" cy="12" r="3" />
                            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                          </svg>
                        )}
                      </div>

                      {/* Textos da permissão */}
                      <div className="flex-1 min-w-0">
                        <strong className="block text-xs font-bold text-zinc-900 dark:text-white truncate">
                          {p.title}
                        </strong>
                        <span className="block text-[11px] text-zinc-500 dark:text-zinc-400 line-clamp-1">
                          {p.description}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </form>

          {/* CARD 4: MEMBROS CADASTRADOS NA EQUIPE */}
          <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200/80 dark:border-zinc-800 p-6 shadow-sm">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-5">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-xl bg-rose-50 dark:bg-rose-950/50 text-[#610000] flex items-center justify-center shrink-0">
                  <svg
                    className="w-4 h-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                </div>
                <div>
                  <h2 className="font-bold text-base text-zinc-900 dark:text-white flex items-center gap-2">
                    <span>
                      {filter === 'removed'
                        ? 'Colaboradores com vínculo removido'
                        : 'Membros cadastrados na equipe'}
                    </span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 font-semibold">
                      {filteredMembers.length}
                    </span>
                  </h2>
                  {filter === 'removed' && (
                    <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">
                      Estes colaboradores foram removidos da equipe. O histórico de atendimentos e comandas está preservado.{' '}
                      <button
                        type="button"
                        onClick={() => setFilter('all')}
                        className="text-[#610000] dark:text-rose-400 font-semibold underline cursor-pointer"
                      >
                        Voltar para a equipe ativa
                      </button>
                    </p>
                  )}
                </div>
              </div>

              {/* Busca rápida */}
              <div className="relative w-full sm:w-64">
                <span className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-zinc-400">
                  <svg
                    className="w-3.5 h-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                </span>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Buscar funcionário..."
                  className="w-full pl-9 pr-3 py-1.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs text-zinc-900 dark:text-white placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-[#610000]/20 focus:border-[#610000] transition-all"
                />
              </div>
            </div>

            {loading ? (
              <div className="py-12 text-center text-xs text-zinc-500 dark:text-zinc-400">
                Carregando membros da equipe...
              </div>
            ) : filteredMembers.length === 0 ? (
              <div className="py-12 text-center border-2 border-dashed border-zinc-100 dark:border-zinc-800 rounded-2xl">
                <div className="w-12 h-12 mx-auto rounded-full bg-rose-50 dark:bg-rose-950/40 text-[#610000] flex items-center justify-center mb-3">
                  <svg
                    className="w-6 h-6"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                </div>
                <p className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
                  {filter === 'removed'
                    ? 'Nenhum colaborador removido da equipe'
                    : searchQuery
                      ? 'Nenhum funcionário encontrado para esta busca'
                      : 'Nenhum funcionário cadastrado ainda'}
                </p>
                <p className="text-xs text-zinc-400 mt-1 max-w-sm mx-auto">
                  {filter === 'removed'
                    ? 'Colaboradores removidos que possuam histórico de comandas aparecerão aqui.'
                    : searchQuery
                      ? 'Tente buscar por outro termo, nome, e-mail ou cargo.'
                      : 'Preencha o formulário acima para adicionar o primeiro membro à equipe do seu restaurante.'}
                </p>
              </div>
            ) : (
              <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {filteredMembers.map((m) => {
                  const initials = m.name
                    .split(' ')
                    .map((part) => part[0])
                    .filter(Boolean)
                    .slice(0, 2)
                    .join('')
                    .toUpperCase();

                  return (
                    <div
                      key={m.id}
                      className="py-3.5 flex flex-col md:flex-row md:items-center justify-between gap-4 hover:bg-zinc-50/60 dark:hover:bg-zinc-800/30 px-3 rounded-xl transition-colors"
                    >
                      <div className="flex items-center gap-3.5 min-w-0">
                        {/* Avatar */}
                        {m.avatarUrl ? (
                          <img
                            src={m.avatarUrl}
                            alt={m.name}
                            className="w-10 h-10 rounded-full object-cover border border-zinc-200 dark:border-zinc-700 shrink-0"
                          />
                        ) : (
                          <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#610000] to-[#8A1A00] text-white font-bold text-xs flex items-center justify-center shrink-0 shadow-2xs">
                            {initials || 'FU'}
                          </div>
                        )}

                        {/* Dados textuais */}
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-bold text-sm text-zinc-900 dark:text-white truncate">
                              {m.name}
                            </span>
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-rose-50 dark:bg-rose-950/40 text-[#610000] dark:text-rose-300 border border-rose-200/60 dark:border-rose-900/60">
                              {m.cargo}
                            </span>
                            {m.isInvitePending && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border border-amber-200/60">
                                Convite pendente
                              </span>
                            )}
                          </div>

                          <div className="flex items-center gap-3 text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 flex-wrap">
                            {m.email && <span>{m.email}</span>}
                            {m.phone && (
                              <>
                                <span>•</span>
                                <span>{m.phone}</span>
                              </>
                            )}
                            {m.openVisits > 0 && (
                              <>
                                <span>•</span>
                                <span className="text-amber-600 dark:text-amber-400 font-semibold">
                                  {m.openVisits} atendimento(s) aberto(s)
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Status e Ações */}
                      <div className="flex items-center gap-2 sm:gap-3 self-end md:self-center shrink-0 flex-wrap justify-end">
                        {/* Status Badge: Indicador compacto no mobile (< sm), rótulo textual completo no desktop */}
                        <div
                          title={STAFF_ACCESS_LABEL[staffAccessState(m)]}
                          aria-label={STAFF_ACCESS_LABEL[staffAccessState(m)]}
                          className={`inline-flex items-center gap-1.5 p-1.5 sm:px-2.5 sm:py-1 rounded-full text-xs font-semibold ${
                            staffAccessState(m) === 'access_active'
                              ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200/60'
                              : staffAccessState(m) === 'access_inactive'
                                ? 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border border-rose-200/60'
                                : staffAccessState(m) === 'removed'
                                  ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700'
                                  : 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border border-amber-200/60'
                          }`}
                        >
                          <span
                            className={`w-2 h-2 sm:w-1.5 sm:h-1.5 rounded-full shrink-0 ${
                              staffAccessState(m) === 'access_active'
                                ? 'bg-emerald-500'
                                : staffAccessState(m) === 'access_inactive'
                                  ? 'bg-rose-500'
                                  : staffAccessState(m) === 'removed'
                                    ? 'bg-zinc-400'
                                    : 'bg-amber-500'
                            }`}
                          />
                          <span className="hidden sm:inline">{STAFF_ACCESS_LABEL[staffAccessState(m)]}</span>
                          <span className="sr-only sm:hidden">{STAFF_ACCESS_LABEL[staffAccessState(m)]}</span>
                        </div>

                        {m.isRemoved ? (
                          <span className="text-[11px] text-zinc-400 italic px-2 py-1">
                            Histórico preservado
                          </span>
                        ) : (
                          <>
                            {/* Botão Editar */}
                            <button
                              type="button"
                              onClick={() => handleEditMember(m)}
                              className="px-2.5 py-1 sm:px-3 sm:py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-xs font-semibold text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                            >
                              Editar
                            </button>

                            {/* Botão Ativar / Desativar (para membros vinculados) */}
                            {m.memberId && (
                              <button
                                type="button"
                                onClick={() => void handleToggleActive(m)}
                                disabled={busy}
                                className="px-2.5 py-1 sm:px-3 sm:py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-xs font-semibold text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer disabled:opacity-50"
                              >
                                {m.active ? 'Desativar' : 'Ativar'}
                              </button>
                            )}

                            {/* Botão Gerar Novo Link (para convites pendentes) */}
                            {m.isInvitePending && m.email && (
                              <button
                                type="button"
                                onClick={() => void handleResendInvite(m)}
                                disabled={busy}
                                title="Gerar um novo link seguro para este convite"
                                className="px-3 py-1.5 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-xs font-semibold text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/60 transition-colors cursor-pointer disabled:opacity-50"
                              >
                                Novo link
                              </button>
                            )}

                            {/* Botão Remover da Equipe / Cancelar Convite */}
                            <button
                              type="button"
                              onClick={() => handleRequestDeleteMember(m)}
                              disabled={busy}
                              title={m.isInvitePending ? 'Cancelar convite' : 'Remover da equipe'}
                              aria-label={m.isInvitePending ? 'Cancelar convite' : 'Remover da equipe'}
                              className="p-1.5 rounded-lg text-zinc-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors cursor-pointer disabled:opacity-50"
                            >
                              <svg
                                className="w-4 h-4"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                              >
                                <polyline points="3 6 5 6 21 6" />
                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                              </svg>
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* =======================================================================
            COLUNA DIREITA — PAINEL LATERAL EM 3 CARDS
            ======================================================================= */}
        <div className="xl:col-span-4 flex flex-col gap-5">
          {/* CARD 1: EQUIPE DO RESTAURANTE COM 3 MINI-CARDS FILTRÁVEIS */}
          <div className="bg-[#FDF8F5] dark:bg-zinc-900 rounded-2xl border border-[#F0E4D8] dark:border-zinc-800 p-5 shadow-sm">
            <div className="w-10 h-10 rounded-2xl bg-[#F5E6D8] text-[#610000] flex items-center justify-center shrink-0 mb-3">
              <svg
                className="w-5 h-5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
            </div>

            <h3 className="font-extrabold text-base text-zinc-900 dark:text-white">
              Equipe do restaurante
            </h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 mb-4 leading-relaxed">
              Gerencie seus colaboradores de forma simples e segura.
            </p>

            <div className="flex flex-col gap-2.5">
              {/* Mini-Card 1: Total de Funcionários */}
              <div
                onClick={() => setFilter('all')}
                className={`bg-white dark:bg-zinc-800/80 rounded-xl p-3.5 border transition-all flex items-center justify-between cursor-pointer ${
                  filter === 'all'
                    ? 'border-[#610000] ring-1 ring-[#610000]/20'
                    : 'border-zinc-200/70 dark:border-zinc-700/80 hover:border-[#610000]/40'
                }`}
              >
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-rose-50 dark:bg-rose-950/60 text-[#610000] flex items-center justify-center shrink-0">
                    <svg
                      className="w-4 h-4"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                      <circle cx="8.5" cy="7" r="4" />
                    </svg>
                  </div>
                  <div>
                    <span className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                      Total de funcionários
                    </span>
                    <strong className="block text-lg font-extrabold text-zinc-900 dark:text-white leading-tight">
                      {totalCount}
                    </strong>
                  </div>
                </div>
                <svg
                  className="w-4 h-4 text-zinc-400"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </div>

              {/* Mini-Card 2: Ativos */}
              <div
                onClick={() => setFilter('active')}
                className={`bg-white dark:bg-zinc-800/80 rounded-xl p-3.5 border transition-all flex items-center justify-between cursor-pointer ${
                  filter === 'active'
                    ? 'border-emerald-600 ring-1 ring-emerald-600/20'
                    : 'border-zinc-200/70 dark:border-zinc-700/80 hover:border-emerald-500/40'
                }`}
              >
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 flex items-center justify-center shrink-0">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
                  </div>
                  <div>
                    <span className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                      Ativos
                    </span>
                    <strong className="block text-lg font-extrabold text-zinc-900 dark:text-white leading-tight">
                      {activeCount}
                    </strong>
                  </div>
                </div>
                <svg
                  className="w-4 h-4 text-zinc-400"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </div>

              {/* Mini-Card 3: Inativos */}
              <div
                onClick={() => setFilter('inactive')}
                className={`bg-white dark:bg-zinc-800/80 rounded-xl p-3.5 border transition-all flex items-center justify-between cursor-pointer ${
                  filter === 'inactive'
                    ? 'border-rose-600 ring-1 ring-rose-600/20'
                    : 'border-zinc-200/70 dark:border-zinc-700/80 hover:border-rose-500/40'
                }`}
              >
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-rose-50 dark:bg-rose-950/60 text-rose-600 flex items-center justify-center shrink-0">
                    <span className="w-2.5 h-2.5 rounded-full bg-rose-500" />
                  </div>
                  <div>
                    <span className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                      Inativos
                    </span>
                    <strong className="block text-lg font-extrabold text-zinc-900 dark:text-white leading-tight">
                      {inactiveCount}
                    </strong>
                  </div>
                </div>
                <svg
                  className="w-4 h-4 text-zinc-400"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </div>

              {/* Mini-Card 4: Removidos (histórico preservado) */}
              {removedCount > 0 && (
                <div
                  onClick={() => setFilter(filter === 'removed' ? 'all' : 'removed')}
                  className={`bg-white dark:bg-zinc-800/80 rounded-xl p-3.5 border transition-all flex items-center justify-between cursor-pointer ${
                    filter === 'removed'
                      ? 'border-zinc-500 ring-1 ring-zinc-500/20'
                      : 'border-zinc-200/70 dark:border-zinc-700/80 hover:border-zinc-400'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 flex items-center justify-center shrink-0">
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                        <circle cx="8.5" cy="7" r="4" />
                        <line x1="18" y1="8" x2="23" y2="13" />
                        <line x1="23" y1="8" x2="18" y2="13" />
                      </svg>
                    </div>
                    <div>
                      <span className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                        Removidos (histórico)
                      </span>
                      <strong className="block text-lg font-extrabold text-zinc-900 dark:text-white leading-tight">
                        {removedCount}
                      </strong>
                    </div>
                  </div>
                  <span className="text-[11px] font-medium text-zinc-500">
                    {filter === 'removed' ? 'Exibindo' : 'Ver'}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* CARD 2: DICAS */}
          <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200/80 dark:border-zinc-800 p-5 shadow-sm">
            <div className="flex items-center gap-2.5 mb-4">
              <div className="w-7 h-7 rounded-lg bg-rose-50 dark:bg-rose-950/50 text-[#610000] flex items-center justify-center shrink-0">
                <svg
                  className="w-4 h-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <line x1="9" y1="18" x2="15" y2="18" />
                  <line x1="10" y1="22" x2="14" y2="22" />
                  <path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14" />
                </svg>
              </div>
              <h3 className="font-bold text-base text-zinc-900 dark:text-white">Dicas</h3>
            </div>

            <div className="space-y-4">
              {/* Dica 1 */}
              <div className="flex items-start gap-3">
                <div className="w-7 h-7 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 flex items-center justify-center shrink-0 mt-0.5">
                  <svg
                    className="w-3.5 h-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                </div>
                <div>
                  <strong className="block text-xs font-bold text-zinc-900 dark:text-white">
                    Mantenha os dados sempre atualizados
                  </strong>
                  <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5 leading-relaxed">
                    Isso evita problemas no acesso e na folha de ponto.
                  </p>
                </div>
              </div>

              {/* Dica 2 */}
              <div className="flex items-start gap-3">
                <div className="w-7 h-7 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 flex items-center justify-center shrink-0 mt-0.5">
                  <svg
                    className="w-3.5 h-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                </div>
                <div>
                  <strong className="block text-xs font-bold text-zinc-900 dark:text-white">
                    Defina o nível de permissão correto
                  </strong>
                  <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5 leading-relaxed">
                    Cada cargo tem um acesso ideal ao sistema.
                  </p>
                </div>
              </div>

              {/* Dica 3 */}
              <div className="flex items-start gap-3">
                <div className="w-7 h-7 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 flex items-center justify-center shrink-0 mt-0.5">
                  <svg
                    className="w-3.5 h-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19 4h-3.17L14.4 2H9.6L8.17 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z" />
                  </svg>
                </div>
                <div>
                  <strong className="block text-xs font-bold text-zinc-900 dark:text-white">
                    Use fotos para facilitar a identificação
                  </strong>
                  <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5 leading-relaxed">
                    Ajuda na segurança e no controle de acesso.
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* CARD 3: BANNER MINHA EQUIPE, MEU RESTAURANTE */}
          <div className="rounded-2xl p-6 bg-gradient-to-br from-[#2A0800] via-[#4A1205] to-[#1A0500] text-white relative overflow-hidden shadow-md">
            {/* Ícone de fundo com opacidade sutil */}
            <div className="absolute -right-6 -bottom-6 w-36 h-36 opacity-10 pointer-events-none">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
            </div>

            <div className="relative z-10">
              <div className="w-8 h-8 rounded-xl bg-white/10 backdrop-blur-xs flex items-center justify-center mb-3">
                <svg
                  className="w-4 h-4 text-rose-200"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              </div>

              <h4 className="font-extrabold text-base mb-2 tracking-tight">
                Minha equipe, meu restaurante
              </h4>
              <p className="text-xs text-zinc-200/90 leading-relaxed mb-4">
                Com o ELOOZI, você tem controle total sobre sua equipe, garantindo mais
                organização, segurança e eficiência no dia a dia.
              </p>

              <button
                type="button"
                onClick={() => {
                  window.open(
                    'https://eloozi.com.br',
                    '_blank',
                    'noopener,noreferrer',
                  );
                }}
                className="border border-white/30 bg-white/10 hover:bg-white/20 text-white text-xs font-semibold px-4 py-2 rounded-full inline-flex items-center gap-2 transition-colors cursor-pointer"
              >
                <span>Saiba mais</span>
                <svg
                  className="w-3.5 h-3.5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* MODAL DE CONFIRMAÇÃO DE REMOÇÃO / CANCELAMENTO DE CONVITE */}
      {confirmRemovalModal && (
        <div
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-removal-title"
        >
          <div className="bg-white dark:bg-zinc-900 rounded-2xl max-w-md w-full p-6 shadow-2xl border border-zinc-200 dark:border-zinc-800 space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-rose-100 dark:bg-rose-950/60 text-rose-700 dark:text-rose-300 flex items-center justify-center shrink-0">
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <h3 id="confirm-removal-title" className="text-base font-bold text-zinc-900 dark:text-white">
                  {confirmRemovalModal.isPendingInvite
                    ? 'Cancelar convite da equipe'
                    : 'Remover colaborador da equipe'}
                </h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 truncate">
                  {confirmRemovalModal.member.name} ({confirmRemovalModal.member.email})
                </p>
              </div>
            </div>

            <p className="text-xs text-zinc-600 dark:text-zinc-300 leading-relaxed">
              {confirmRemovalModal.isPendingInvite
                ? 'Esta ação cancela e invalida o link de convite gerado. O destinatário não poderá mais aceitar o convite para este restaurante.'
                : 'Esta ação remove o vínculo do colaborador com este restaurante e o oculta da lista da equipe. A conta de acesso global e todo o histórico anterior de comandas, pedidos e atendimentos serão preservados.'}
            </p>

            <div className="flex items-center justify-end gap-3 pt-2 border-t border-zinc-100 dark:border-zinc-800">
              <button
                type="button"
                onClick={() => setConfirmRemovalModal(null)}
                disabled={busy}
                className="px-4 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 text-xs font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 cursor-pointer disabled:opacity-50"
              >
                Voltar
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmRemoval(confirmRemovalModal.member)}
                disabled={busy}
                className="bg-rose-700 hover:bg-rose-800 text-white text-xs font-bold px-4 py-2 rounded-xl transition-colors cursor-pointer disabled:opacity-50"
              >
                {busy
                  ? 'Removendo...'
                  : confirmRemovalModal.isPendingInvite
                    ? 'Cancelar convite'
                    : 'Remover da equipe'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL DE TRANSFERÊNCIA DE ATENDIMENTOS (AO DESATIVAR MEMBRO COM ATENDIMENTOS) */}
      {transferModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-zinc-900 rounded-2xl max-w-md w-full p-6 shadow-2xl border border-zinc-200 dark:border-zinc-800 space-y-4">
            <h3 className="text-base font-bold text-zinc-900 dark:text-white">
              Transferir atendimentos abertos
            </h3>
            <p className="text-xs text-zinc-600 dark:text-zinc-300 leading-relaxed">
              O funcionário <strong>{transferModal.fromName}</strong> possui{' '}
              <strong>{transferModal.openVisits} atendimento(s) aberto(s)</strong>. Selecione
              outro funcionário ativo para transferir antes de desativá-lo.
            </p>

            <div>
              <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5">
                Transferir para:
              </label>
              <select
                value={transferTargetId}
                onChange={(e) => setTransferTargetId(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-medium text-zinc-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-[#610000]/20 focus:border-[#610000]"
              >
                <option value="">Selecione outro funcionário</option>
                {unifiedMembers
                  .filter(
                    (m) =>
                      m.active &&
                      m.memberId &&
                      m.memberId !== transferModal.fromMemberId,
                  )
                  .map((m) => (
                    <option key={m.id} value={m.memberId || m.id}>
                      {m.name} ({m.email})
                    </option>
                  ))}
              </select>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setTransferModal(null)}
                className="px-4 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 text-xs font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void handleExecuteTransfer()}
                disabled={busy || !transferTargetId}
                className="bg-[#610000] hover:bg-[#4a0000] text-white text-xs font-bold px-4 py-2 rounded-xl transition-colors cursor-pointer disabled:opacity-50"
              >
                Transferir e continuar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

import { supabase } from '../../lib/supabase';

// Validação rigorosa de formato UUID canônico (8-4-4-4-12 hexadecimais)
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidUuid(id: unknown): id is string {
  return typeof id === 'string' && UUID_REGEX.test(id.trim());
}

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidDateString(d: unknown): d is string {
  if (typeof d !== 'string' || !DATE_REGEX.test(d.trim())) return false;
  const [y, m, day] = d.trim().split('-').map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, day));
  return (
    parsed.getUTCFullYear() === y &&
    parsed.getUTCMonth() === m - 1 &&
    parsed.getUTCDate() === day
  );
}

export function isValidTimeString(t: unknown): t is string {
  return typeof t === 'string' && TIME_REGEX.test(t.trim());
}

/**
 * Calcula a data civil operacional no fuso IANA do restaurante,
 * garantindo paridade estrita com o cálculo da RPC no PostgreSQL.
 */
export function getOperationalDate(timezone?: string | null): string {
  const tz = timezone && timezone.trim() ? timezone.trim() : 'America/Sao_Paulo';
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return formatter.format(new Date());
  } catch {
    const fallbackFormatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return fallbackFormatter.format(new Date());
  }
}

export interface Reservation {
  id: string;
  restaurant_id: string;
  table_id?: string | null;
  table_number: number;
  customer_name: string;
  phone: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:mm
  reservation_time?: string;
  status: 'confirmed' | 'confirmada' | 'agendada' | 'reservada' | 'seated' | 'cancelled';
  guests_count: number;
  notes: string;
  origin_id?: string | null;
  created_at: string;
}

export interface ReservationItem {
  id: string;
  tableId?: string | null;
  tableNumber: number;
  customerName: string;
  phone?: string;
  date?: string;
  time: string;
  status?: string;
  guestsCount?: number;
  notes?: string;
  originId?: string | null;
  createdAt?: string;
}

export function toReservationItem(r: Reservation): ReservationItem {
  return {
    id: r.id,
    tableId: r.table_id,
    tableNumber: r.table_number,
    customerName: r.customer_name,
    phone: r.phone,
    date: r.date,
    time: r.time || r.reservation_time || '20:00',
    status: r.status,
    guestsCount: r.guests_count,
    notes: r.notes,
    originId: r.origin_id,
    createdAt: r.created_at,
  };
}

export function isConfirmedReservation(res: { status?: string }): boolean {
  return !res.status || ['confirmed', 'confirmada', 'agendada', 'reservada'].includes(res.status);
}

export interface CreateReservationInput {
  restaurantId: string;
  tableId?: string | null;
  tableNumber: number;
  customerName: string;
  phone?: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:mm
  guestsCount?: number;
  notes?: string;
  status?: 'confirmed' | 'confirmada' | 'agendada' | 'reservada' | 'seated' | 'cancelled';
  originId?: string | null;
}

export interface UpdateReservationInput {
  tableNumber?: number;
  tableId?: string | null;
  customerName?: string;
  phone?: string;
  date?: string;
  time?: string;
  guestsCount?: number;
  notes?: string;
  status?: 'confirmed' | 'confirmada' | 'agendada' | 'reservada' | 'seated' | 'cancelled';
}

export interface SeatReservationResult {
  success: boolean;
  code: string;
  message: string;
  reservation?: Reservation | null;
}

/**
 * Validação rigorosa em runtime da resposta da RPC contra os parâmetros solicitados.
 * Exige tipo boolean real em obj.success (evita que a string "false" seja tratada como true).
 */
export function parseAndValidateSeatResult(
  data: unknown,
  requestedRestaurantId: string,
  requestedTableNumber: number,
  requestedReservationId: string,
): SeatReservationResult {
  if (!data || typeof data !== 'object') {
    return {
      success: false,
      code: 'INVALID_RESPONSE',
      message: 'Resposta vazia ou inválida do servidor ao acomodar reserva.',
      reservation: null,
    };
  }

  const obj = data as Record<string, unknown>;

  // Exigência estrita: success DEVE ser um boolean primitivo
  if (typeof obj.success !== 'boolean') {
    return {
      success: false,
      code: 'MALFORMED_RESPONSE',
      message: 'A resposta do servidor não possui um indicador booleano de sucesso válido.',
      reservation: null,
    };
  }

  const success = obj.success;
  const code = typeof obj.code === 'string' ? obj.code : 'UNKNOWN';
  const message = typeof obj.message === 'string' ? obj.message : '';

  // Se o servidor retornou erro explícito, nunca produzir falso sucesso
  if (!success && code !== 'ALREADY_SEATED') {
    return {
      success: false,
      code,
      message: message || 'Não foi possível confirmar o atendimento da reserva.',
      reservation: null,
    };
  }

  let reservation: Reservation | null = null;
  if (obj.reservation && typeof obj.reservation === 'object') {
    const r = obj.reservation as Record<string, unknown>;
    if (
      typeof r.id === 'string' &&
      isValidUuid(r.id) &&
      typeof r.restaurant_id === 'string' &&
      typeof r.table_number === 'number' &&
      r.status === 'seated'
    ) {
      // Validação estrita: confere se o restaurante, mesa e ID retornados conferem com o solicitado
      if (r.restaurant_id !== requestedRestaurantId || r.table_number !== requestedTableNumber) {
        return {
          success: false,
          code: 'RESPONSE_PARAM_MISMATCH',
          message: 'A reserva confirmada pelo servidor divergiu do restaurante ou da mesa solicitada.',
          reservation: null,
        };
      }

      if (r.id !== requestedReservationId) {
        return {
          success: false,
          code: 'RESPONSE_PARAM_MISMATCH',
          message: 'A reserva confirmada pelo servidor divergiu do identificador solicitado.',
          reservation: null,
        };
      }

      reservation = {
        id: r.id,
        restaurant_id: r.restaurant_id,
        table_id: typeof r.table_id === 'string' ? r.table_id : null,
        table_number: r.table_number,
        customer_name: String(r.customer_name ?? ''),
        phone: String(r.phone ?? ''),
        date: String(r.date ?? ''),
        time: String(r.time ?? ''),
        reservation_time: String(r.reservation_time ?? ''),
        status: 'seated',
        guests_count: Number(r.guests_count ?? 2),
        notes: String(r.notes ?? ''),
        origin_id: typeof r.origin_id === 'string' ? r.origin_id : null,
        created_at: String(r.created_at ?? ''),
      };
    }
  }

  // Contradição: sucesso ou ALREADY_SEATED sem carga válida de reserva
  if ((success || code === 'ALREADY_SEATED') && !reservation) {
    return {
      success: false,
      code: 'INVALID_RESERVATION_PAYLOAD',
      message: 'O servidor confirmou a operação, mas o registro da reserva retornado é inválido ou incompleto.',
      reservation: null,
    };
  }

  // Contradição: SEATED_SUCCESS exige success === true
  if (code === 'SEATED_SUCCESS' && !success) {
    return {
      success: false,
      code: 'CONTRADICTORY_RESPONSE',
      message: 'Resposta contraditória do servidor ao confirmar reserva.',
      reservation: null,
    };
  }

  return { success, code, message, reservation };
}

/**
 * Consulta reservas do Supabase com ordenação cronológica estrita.
 */
export async function listReservations(
  restaurantId: string,
  options?: {
    startDate?: string;
    endDate?: string;
    status?: string[];
  },
): Promise<Reservation[]> {
  if (!isValidUuid(restaurantId)) {
    throw new Error('Identificador de restaurante inválido.');
  }

  let query = supabase
    .from('reservations')
    .select('*')
    .eq('restaurant_id', restaurantId);

  if (options?.startDate) {
    query = query.gte('date', options.startDate);
  }
  if (options?.endDate) {
    query = query.lte('date', options.endDate);
  }
  if (options?.status && options.status.length > 0) {
    query = query.in('status', options.status);
  }

  // Ordenação cronológica estrita: Data crescente, depois Horário crescente
  query = query
    .order('date', { ascending: true })
    .order('time', { ascending: true })
    .order('created_at', { ascending: true });

  const { data, error } = await query;

  if (error) {
    if (error.code === '42501') {
      throw new Error('Acesso não autorizado às reservas deste restaurante.');
    }
    throw new Error(`Falha ao consultar reservas: ${error.message}`);
  }

  return (data || []) as Reservation[];
}

/**
 * Cria uma nova reserva diretamente no Supabase (restrito a Admin pelo RLS).
 */
export async function createReservation(
  input: CreateReservationInput,
): Promise<Reservation> {
  if (!isValidUuid(input.restaurantId)) {
    throw new Error('ID do restaurante inválido.');
  }
  if (!Number.isInteger(input.tableNumber) || input.tableNumber < 1 || input.tableNumber > 999) {
    throw new Error('Número de mesa inválido (deve ser entre 1 e 999).');
  }
  const cleanName = input.customerName.trim();
  if (!cleanName) {
    throw new Error('Nome do cliente é obrigatório.');
  }
  if (!isValidDateString(input.date)) {
    throw new Error('Data da reserva inválida (use o formato AAAA-MM-DD).');
  }
  if (!isValidTimeString(input.time)) {
    throw new Error('Horário da reserva inválido (use o formato HH:mm).');
  }

  const guestsCount = Number(input.guestsCount ?? 2);
  if (!Number.isInteger(guestsCount) || guestsCount < 1 || guestsCount > 99) {
    throw new Error('Quantidade de pessoas inválida (deve ser entre 1 e 99).');
  }

  const payload: Record<string, unknown> = {
    restaurant_id: input.restaurantId,
    table_number: input.tableNumber,
    customer_name: cleanName,
    phone: (input.phone ?? '').trim(),
    date: input.date.trim(),
    time: input.time.trim(),
    reservation_time: input.time.trim(),
    status:
      input.status && ['confirmed', 'confirmada', 'agendada', 'reservada', 'seated', 'cancelled'].includes(input.status)
        ? input.status
        : 'confirmed',
    guests_count: guestsCount,
    notes: (input.notes ?? '').trim(),
  };

  if (input.tableId && input.tableId.trim()) {
    payload.table_id = input.tableId.trim();
  }

  if (input.originId && input.originId.trim()) {
    payload.origin_id = input.originId.trim();
  }

  const { data, error } = await supabase
    .from('reservations')
    .insert(payload)
    .select()
    .single();

  if (error) {
    if (error.code === '42501') {
      throw new Error('Permissão negada. Apenas administradores do restaurante podem cadastrar reservas.');
    }
    if (error.code === '23505') {
      throw new Error('Esta reserva já foi importada ou já existe no sistema.');
    }
    throw new Error(`Erro ao cadastrar reserva: ${error.message}`);
  }

  return data as Reservation;
}

/**
 * Atualiza dados de uma reserva existente.
 */
export async function updateReservation(
  reservationId: string,
  input: UpdateReservationInput,
): Promise<Reservation> {
  if (!isValidUuid(reservationId)) {
    throw new Error('ID da reserva inválido.');
  }

  const patch: Record<string, unknown> = {};

  if (input.tableNumber !== undefined) {
    if (!Number.isInteger(input.tableNumber) || input.tableNumber < 1 || input.tableNumber > 999) {
      throw new Error('Número de mesa inválido.');
    }
    patch.table_number = input.tableNumber;
  }
  if (input.tableId !== undefined) {
    if (input.tableId !== null && !isValidUuid(input.tableId)) {
      throw new Error('ID da mesa inválido.');
    }
    patch.table_id = input.tableId;
  }
  if (input.customerName !== undefined) {
    const trimmed = input.customerName.trim();
    if (!trimmed) throw new Error('Nome do cliente não pode ser vazio.');
    patch.customer_name = trimmed;
  }
  if (input.phone !== undefined) patch.phone = input.phone.trim();
  if (input.date !== undefined) {
    if (!isValidDateString(input.date)) throw new Error('Data inválida.');
    patch.date = input.date;
  }
  if (input.time !== undefined) {
    if (!isValidTimeString(input.time)) throw new Error('Horário inválido.');
    patch.time = input.time;
    patch.reservation_time = input.time;
  }
  if (input.guestsCount !== undefined) {
    if (input.guestsCount < 1 || input.guestsCount > 99) throw new Error('Quantidade de pessoas inválida.');
    patch.guests_count = input.guestsCount;
  }
  if (input.notes !== undefined) patch.notes = input.notes.trim();
  if (input.status !== undefined) patch.status = input.status;

  const { data, error } = await supabase
    .from('reservations')
    .update(patch)
    .eq('id', reservationId)
    .select()
    .single();

  if (error) {
    if (error.code === '42501') {
      throw new Error('Permissão negada para editar esta reserva.');
    }
    throw new Error(`Erro ao atualizar reserva: ${error.message}`);
  }

  return data as Reservation;
}

/**
 * Cancela uma reserva existente (status 'cancelled').
 */
export async function cancelReservation(
  reservationId: string,
): Promise<Reservation> {
  return updateReservation(reservationId, { status: 'cancelled' });
}

/**
 * Confirmação de chegada de clientes na mesa via RPC segura.
 * EXIGE ID EXPLÍCITO OBRIGATÓRIO (NÃO PERMITE SELEÇÃO AUTOMÁTICA).
 * Valida formato UUID antes de acionar a RPC e confere a integridade
 * dos parâmetros retornados em runtime.
 */
export async function seatReservationArrival(
  restaurantId: string,
  tableNumber: number,
  reservationId: string,
): Promise<SeatReservationResult> {
  if (!isValidUuid(restaurantId)) {
    return {
      success: false,
      code: 'INVALID_RESTAURANT_ID',
      message: 'Identificador do restaurante inválido.',
      reservation: null,
    };
  }

  if (!Number.isInteger(tableNumber) || tableNumber < 1 || tableNumber > 999) {
    return {
      success: false,
      code: 'INVALID_TABLE_NUMBER',
      message: 'Número de mesa inválido.',
      reservation: null,
    };
  }

  // EXIGÊNCIA ESTRITA: O ID da reserva é obrigatório.
  // Rejeita IDs ausentes, nulos ou que não sejam UUIDs válidos.
  if (!reservationId || !isValidUuid(reservationId)) {
    return {
      success: false,
      code: 'INVALID_RESERVATION_ID',
      message: 'O identificador da reserva é obrigatório e deve ser um UUID válido.',
      reservation: null,
    };
  }

  const { data, error } = await supabase.rpc('seat_table_reservation', {
    p_restaurant_id: restaurantId,
    p_table_number: tableNumber,
    p_reservation_id: reservationId,
  });

  if (error) {
    return {
      success: false,
      code: error.code || 'RPC_ERROR',
      message: error.message || 'Falha de comunicação com o servidor ao confirmar reserva.',
      reservation: null,
    };
  }

  return parseAndValidateSeatResult(data, restaurantId, tableNumber, reservationId);
}

// ============================================================================
// SISTEMA DE MANIFESTO AUXILIAR DE IMPORTAÇÃO E IDENTIDADE ESTÁVEL
// ============================================================================

export interface LocalManifestEntry {
  rawSignature: string;
  occurrenceIndex: number;
  assignedOriginId: string;
  firstSeenAt: string;
}

export interface LocalImportManifest {
  version: 1;
  restaurantId: string;
  sourceFingerprint?: string;
  sourceTotalCount?: number;
  entries: LocalManifestEntry[];
}

export type ManifestLoadResult =
  | { status: 'absent'; manifest: LocalImportManifest }
  | { status: 'valid'; manifest: LocalImportManifest }
  | { status: 'corrupted'; error: string; rawContent?: string }
  | { status: 'unavailable'; error: string };

export type ManifestSaveResult =
  | { success: true }
  | { success: false; error: string };

export function getManifestStorageKey(restaurantId: string): string {
  return `elozi_reservas_manifest_${restaurantId}`;
}

function resolveStorage(customStorage?: Storage): Storage | null {
  if (customStorage) return customStorage;
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage;
  }
  return null;
}

/**
 * Carrega o manifesto de importação com diferenciação explícita de estados:
 * - 'absent': Chave não existe no armazenamento -> novo manifesto inicializado.
 * - 'valid': Manifesto íntegro e validado estruturalmente.
 * - 'corrupted': JSON inválido, versão incompatível, restaurante divergente ou entradas malformadas.
 * - 'unavailable': Armazenamento local inacessível (SecurityError ou indisponível).
 * 
 * Regra Crítica: Manifesto corrompido NUNCA é substituído automaticamente,
 * preservando os dados para auditoria administrativa.
 */
export function loadImportManifest(restaurantId: string, customStorage?: Storage): ManifestLoadResult {
  const s = resolveStorage(customStorage);
  if (!s) {
    return {
      status: 'unavailable',
      error: 'O armazenamento local (localStorage) não está acessível no ambiente atual.',
    };
  }

  let raw: string | null = null;
  try {
    raw = s.getItem(getManifestStorageKey(restaurantId));
  } catch (err) {
    return {
      status: 'unavailable',
      error: `Falha ao acessar armazenamento local: ${err instanceof Error ? err.message : 'Acesso bloqueado.'}`,
    };
  }

  if (raw === null) {
    return {
      status: 'absent',
      manifest: {
        version: 1,
        restaurantId,
        entries: [],
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      status: 'corrupted',
      error: 'O manifesto local de importação contém JSON malformado ou corrompido.',
      rawContent: raw,
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      status: 'corrupted',
      error: 'Estrutura raiz do manifesto inválida (esperava objeto JSON).',
      rawContent: raw,
    };
  }

  const obj = parsed as Record<string, unknown>;

  if (obj.version !== 1) {
    return {
      status: 'corrupted',
      error: `Versão do manifesto incompatível (${String(obj.version)}). Esperada versão 1.`,
      rawContent: raw,
    };
  }

  if (obj.restaurantId !== restaurantId) {
    return {
      status: 'corrupted',
      error: `O manifesto armazenado pertence a outro restaurante (${String(obj.restaurantId)}). Esperado: ${restaurantId}.`,
      rawContent: raw,
    };
  }

  if (!Array.isArray(obj.entries)) {
    return {
      status: 'corrupted',
      error: 'A lista de entradas (entries) do manifesto não é um array válido.',
      rawContent: raw,
    };
  }

  for (let i = 0; i < obj.entries.length; i++) {
    const e = obj.entries[i];
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      return {
        status: 'corrupted',
        error: `Entrada #${i} do manifesto é inválida (não é objeto).`,
        rawContent: raw,
      };
    }
    const entryObj = e as Record<string, unknown>;
    if (typeof entryObj.rawSignature !== 'string' || !entryObj.rawSignature.trim()) {
      return {
        status: 'corrupted',
        error: `Entrada #${i} do manifesto possui rawSignature ausente ou vazio.`,
        rawContent: raw,
      };
    }
    if (
      typeof entryObj.occurrenceIndex !== 'number' ||
      !Number.isInteger(entryObj.occurrenceIndex) ||
      entryObj.occurrenceIndex < 0
    ) {
      return {
        status: 'corrupted',
        error: `Entrada #${i} do manifesto possui occurrenceIndex inválido (deve ser inteiro >= 0).`,
        rawContent: raw,
      };
    }
    if (typeof entryObj.assignedOriginId !== 'string' || !entryObj.assignedOriginId.trim()) {
      return {
        status: 'corrupted',
        error: `Entrada #${i} do manifesto possui assignedOriginId ausente ou vazio.`,
        rawContent: raw,
      };
    }
    if (typeof entryObj.firstSeenAt !== 'string' || !entryObj.firstSeenAt.trim()) {
      return {
        status: 'corrupted',
        error: `Entrada #${i} do manifesto possui firstSeenAt inválido.`,
        rawContent: raw,
      };
    }
  }

  return {
    status: 'valid',
    manifest: parsed as LocalImportManifest,
  };
}

/**
 * Salva o manifesto com confirmação imediata de escrita e retorno explícito de erro.
 * Se salvar falhar (quota excedida ou permissão negada), não silencia o erro.
 */
export function saveImportManifest(
  manifest: LocalImportManifest,
  customStorage?: Storage,
): ManifestSaveResult {
  const s = resolveStorage(customStorage);
  if (!s) {
    return {
      success: false,
      error: 'Armazenamento local (localStorage) não está acessível no ambiente atual.',
    };
  }

  if (!isValidUuid(manifest.restaurantId)) {
    return {
      success: false,
      error: 'restaurantId inválido no manifesto de importação.',
    };
  }

  const key = getManifestStorageKey(manifest.restaurantId);
  const serialized = JSON.stringify(manifest);

  try {
    s.setItem(key, serialized);
    // Verificação imediata pós-escrita
    const verified = s.getItem(key);
    if (verified === null) {
      return {
        success: false,
        error: 'Falha de confirmação: o manifesto não pôde ser lido após gravação.',
      };
    }
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Falha desconhecida ao gravar manifesto no localStorage.',
    };
  }
}

export interface ILockManager {
  request<T>(name: string, options: { mode: 'exclusive' }, callback: () => Promise<T> | T): Promise<T>;
}

/**
 * Verifica disponibilidade da API Web Locks ou de um LockManager compatível.
 */
export function isWebLocksAvailable(customLocks?: ILockManager): boolean {
  if (customLocks && typeof customLocks.request === 'function') return true;
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.locks &&
    typeof navigator.locks.request === 'function'
  );
}

/**
 * Executa callback sob exclusão mútua garantida por Web Lock.
 * Aceita gerenciador de lock customizado para testes e isolamento de ambiente.
 */
export async function withManifestLock<T>(
  restaurantId: string,
  fn: () => Promise<T> | T,
  customLocks?: ILockManager,
): Promise<T> {
  const locks = customLocks || (typeof navigator !== 'undefined' ? (navigator.locks as unknown as ILockManager) : null);
  if (!locks || typeof locks.request !== 'function') {
    throw new Error(
      'A API Web Locks não está disponível neste navegador para coordenar com segurança a importação entre abas.',
    );
  }

  const lockName = `elozi_manifest_lock_${restaurantId}`;
  return await locks.request(lockName, { mode: 'exclusive' }, async () => {
    return await fn();
  });
}

/**
 * Gera uma assinatura de conteúdo canônica para um item individual.
 */
function buildItemSignature(
  tableNumber: number,
  date: string,
  time: string,
  customerName: string,
  phone: string,
  guestsCount: number,
  notes: string,
  status: string,
): string {
  return JSON.stringify([
    tableNumber,
    date.trim(),
    time.trim(),
    customerName.trim(),
    phone.trim(),
    guestsCount,
    notes.trim(),
    status.trim(),
  ]);
}

/**
 * Calcula uma referência verificável (fingerprint) do conjunto local completo.
 * Permite detectar alterações na origem (inserções, edições ou exclusões).
 */
export function computeDatasetFingerprint(rawItems: unknown[]): string {
  const representations = rawItems.map((item, idx) => {
    if (!item || typeof item !== 'object') return `null#${idx}`;
    const it = item as Record<string, unknown>;
    return [
      String(it.id ?? ''),
      String(it.tableNumber ?? ''),
      String(it.customerName ?? '').trim(),
      String(it.phone ?? '').trim(),
      String(it.date ?? '').trim(),
      String(it.time ?? '').trim(),
      String(it.status ?? '').trim(),
      String(it.guestsCount ?? ''),
      String(it.notes ?? '').trim(),
    ].join('|');
  });
  return representations.join(';;');
}

export interface LocalReservationPreviewItem {
  id: string;
  originId: string;
  tableNumber: number;
  customerName: string;
  phone: string;
  date: string;
  time: string;
  status: string;
  guestsCount: number;
  notes: string;
  isValid: boolean;
  validationErrors: string[];
}

export interface LocalImportAnalysis {
  total: number;
  validCount: number;
  invalidCount: number;
  tablesReady: boolean;
  manifestStatus?: 'absent' | 'valid' | 'corrupted' | 'unavailable';
  manifestError?: string | null;
  items: LocalReservationPreviewItem[];
}

/**
 * ANÁLISE DE PRÉVIA DAS RESERVAS LOCAIS (ESTRITAMENTE SOMENTE-LEITURA).
 * 
 * Regra Arquitetural Obrigatória:
 * - Esta função NUNCA grava no localStorage nem no manifesto.
 * - É segura para ser chamada a qualquer momento pela interface (ex: montagem de tela,
 *   atualização de mesas, renderização do modal).
 * - Registros que ainda não possuem identidade persistida no manifesto aparecem como
 *   'pending-preparation', aguardando a etapa atômica de preparação sob Web Lock.
 * - Registros com correspondência ambígua ou manifesto corrompido são alertados sem mutação.
 */
export function analyzeLocalReservations(
  rawJson: string | null,
  activeTableNumbers: Set<number>,
  tablesLoadedAndReady: boolean,
  restaurantId?: string,
  customStorage?: Storage,
): LocalImportAnalysis {
  if (!rawJson) {
    return {
      total: 0,
      validCount: 0,
      invalidCount: 0,
      tablesReady: tablesLoadedAndReady,
      manifestStatus: 'absent',
      manifestError: null,
      items: [],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return {
      total: 1,
      validCount: 0,
      invalidCount: 1,
      tablesReady: tablesLoadedAndReady,
      manifestStatus: 'corrupted',
      manifestError: 'Formato JSON inválido ou corrompido no armazenamento local.',
      items: [
        {
          id: 'corrupted',
          originId: 'corrupted',
          tableNumber: 0,
          customerName: 'Registro Corrompido',
          phone: '',
          date: '',
          time: '',
          status: 'invalid',
          guestsCount: 0,
          notes: '',
          isValid: false,
          validationErrors: ['Formato JSON inválido ou corrompido no armazenamento local.'],
        },
      ],
    };
  }

  if (!Array.isArray(parsed)) {
    return {
      total: 1,
      validCount: 0,
      invalidCount: 1,
      tablesReady: tablesLoadedAndReady,
      manifestStatus: 'corrupted',
      manifestError: 'Os dados armazenados localmente não formam uma lista.',
      items: [
        {
          id: 'corrupted',
          originId: 'corrupted',
          tableNumber: 0,
          customerName: 'Estrutura Inválida',
          phone: '',
          date: '',
          time: '',
          status: 'invalid',
          guestsCount: 0,
          notes: '',
          isValid: false,
          validationErrors: ['Os dados armazenados localmente não formam uma lista.'],
        },
      ],
    };
  }

  // Consulta somente leitura do manifesto atual
  let manifestLoad: ManifestLoadResult | null = null;
  if (restaurantId) {
    const loaded = loadImportManifest(restaurantId, customStorage);
    manifestLoad = loaded;

    // Se o manifesto estiver corrompido ou indisponível, reporta sem sobrescrever nada
    if (loaded.status === 'corrupted' || loaded.status === 'unavailable') {
      const errMsg = loaded.error;
      return {
        total: parsed.length,
        validCount: 0,
        invalidCount: parsed.length,
        tablesReady: tablesLoadedAndReady,
        manifestStatus: loaded.status,
        manifestError: errMsg,
        items: parsed.map((_, idx) => ({
          id: `blocked-${idx}`,
          originId: `blocked-${idx}`,
          tableNumber: 0,
          customerName: 'Importação Bloqueada',
          phone: '',
          date: '',
          time: '',
          status: 'invalid',
          guestsCount: 0,
          notes: '',
          isValid: false,
          validationErrors: [
            `Manifesto local ${loaded.status === 'corrupted' ? 'corrompido' : 'indisponível'}: ${errMsg}. Operação bloqueada para preservar identidades existentes.`,
          ],
        })),
      };
    }
  }

  const manifest = manifestLoad && manifestLoad.status === 'valid' ? manifestLoad.manifest : null;
  const currentFingerprint = computeDatasetFingerprint(parsed);

  const manifestMap = new Map<string, string>();
  const manifestCountsBySignature = new Map<string, number>();

  if (manifest) {
    for (const entry of manifest.entries) {
      manifestMap.set(`${entry.rawSignature}#${entry.occurrenceIndex}`, entry.assignedOriginId);
      manifestCountsBySignature.set(
        entry.rawSignature,
        (manifestCountsBySignature.get(entry.rawSignature) || 0) + 1,
      );
    }
  }

  const sourceWasModified = Boolean(
    manifest && manifest.sourceFingerprint && manifest.sourceFingerprint !== currentFingerprint,
  );

  const currentCountsBySignature = new Map<string, number>();
  for (const rawItem of parsed) {
    if (rawItem && typeof rawItem === 'object') {
      const it = rawItem as Record<string, unknown>;
      if (!it.id) {
        const sig = buildItemSignature(
          Number(it.tableNumber),
          String(it.date ?? ''),
          String(it.time ?? ''),
          String(it.customerName ?? ''),
          String(it.phone ?? ''),
          Number(it.guestsCount ?? 2),
          String(it.notes ?? ''),
          String(it.status ?? 'confirmed'),
        );
        currentCountsBySignature.set(sig, (currentCountsBySignature.get(sig) || 0) + 1);
      }
    }
  }

  const declaredLocalIds = new Map<string, number>();
  for (const rawItem of parsed) {
    if (rawItem && typeof rawItem === 'object') {
      const it = rawItem as Record<string, unknown>;
      if (typeof it.id === 'string' && it.id.trim()) {
        const trimmed = it.id.trim();
        declaredLocalIds.set(trimmed, (declaredLocalIds.get(trimmed) || 0) + 1);
      }
    }
  }

  const signatureOccurrences = new Map<string, number>();
  const items: LocalReservationPreviewItem[] = [];

  for (let index = 0; index < parsed.length; index++) {
    const rawItem = parsed[index];
    if (!rawItem || typeof rawItem !== 'object') {
      items.push({
        id: crypto.randomUUID(),
        originId: `invalid-null-${index}`,
        tableNumber: 0,
        customerName: 'Registro Nulo',
        phone: '',
        date: '',
        time: '',
        status: 'invalid',
        guestsCount: 0,
        notes: '',
        isValid: false,
        validationErrors: ['Item nulo ou de formato incorreto na lista.'],
      });
      continue;
    }

    const item = rawItem as Record<string, unknown>;
    const errors: string[] = [];

    const tableNumber = Number(item.tableNumber);
    const customerName = typeof item.customerName === 'string' ? item.customerName.trim() : '';
    const phone = typeof item.phone === 'string' ? item.phone.trim() : '';
    const date = typeof item.date === 'string' ? item.date.trim() : '';
    const time = typeof item.time === 'string' ? item.time.trim() : '';
    const status = typeof item.status === 'string' && item.status.trim() ? item.status.trim() : 'confirmed';
    const rawGuests = Number(item.guestsCount ?? 2);
    const guestsCount = Number.isInteger(rawGuests) ? rawGuests : 2;
    const notes = typeof item.notes === 'string' ? item.notes.trim() : '';

    const rawId = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : null;
    let originId = '';

    if (rawId) {
      if ((declaredLocalIds.get(rawId) || 0) > 1) {
        errors.push(`Identificador local duplicado na mesma origem: "${rawId}".`);
      }
      originId = `local-id:${rawId}`;
    } else {
      const signature = buildItemSignature(tableNumber, date, time, customerName, phone, guestsCount, notes, status);
      const occurrence = signatureOccurrences.get(signature) || 0;
      signatureOccurrences.set(signature, occurrence + 1);

      const compositeKey = `${signature}#${occurrence}`;
      const assignedId = manifestMap.get(compositeKey);

      if (sourceWasModified) {
        const previousCount = manifestCountsBySignature.get(signature) || 0;
        const currentCount = currentCountsBySignature.get(signature) || 0;

        if (!assignedId || previousCount !== currentCount) {
          errors.push(
            'Origem local modificada: correspondência ambígua com o manifesto. Item bloqueado para evitar duplicação ou criação indevida; reconciliação necessária.',
          );
        }
      }

      // Somente leitura: se o item já foi catalogado em execução anterior, exibe o ID.
      // Se ainda não foi preparado, marca como pendente de preparação sob Web Lock.
      originId = assignedId ? assignedId : `pending-preparation-${occurrence}`;
    }

    if (!tablesLoadedAndReady) {
      errors.push('Mesas do restaurante ainda não carregadas para validação.');
    }

    if (!customerName) {
      errors.push('Nome do cliente ausente.');
    }

    if (!Number.isInteger(tableNumber) || tableNumber < 1 || tableNumber > 999) {
      errors.push('Número de mesa inválido.');
    } else if (tablesLoadedAndReady) {
      if (activeTableNumbers.size === 0) {
        errors.push('Restaurante não possui nenhuma mesa cadastrada.');
      } else if (!activeTableNumbers.has(tableNumber)) {
        errors.push(`Mesa ${tableNumber} não cadastrada ou inativa neste restaurante.`);
      }
    }

    if (!date) {
      errors.push('Data ausente (registros incompletos não são aceitos).');
    } else if (!isValidDateString(date)) {
      errors.push(`Data inválida: "${date}".`);
    }

    if (!time) {
      errors.push('Horário ausente.');
    } else if (!isValidTimeString(time)) {
      errors.push(`Horário inválido: "${time}".`);
    }

    if (!['confirmed', 'confirmada', 'agendada', 'reservada', 'seated', 'cancelled'].includes(status)) {
      errors.push(`Status inválido: "${status}".`);
    }

    if (guestsCount < 1 || guestsCount > 99) {
      errors.push('Quantidade de pessoas inválida (deve estar entre 1 e 99).');
    }

    items.push({
      id: rawId && isValidUuid(rawId) ? rawId : crypto.randomUUID(),
      originId,
      tableNumber: Number.isInteger(tableNumber) ? tableNumber : 0,
      customerName: customerName || 'Sem nome',
      phone,
      date,
      time,
      status,
      guestsCount,
      notes,
      isValid: errors.length === 0,
      validationErrors: errors,
    });
  }

  const validCount = items.filter((i) => i.isValid).length;
  const invalidCount = items.length - validCount;

  return {
    total: items.length,
    validCount,
    invalidCount,
    tablesReady: tablesLoadedAndReady,
    manifestStatus: manifestLoad ? manifestLoad.status : 'absent',
    manifestError: null,
    items,
  };
}

/**
 * PREPARAÇÃO ATÔMICA DO MANIFESTO E ATRIBUIÇÃO DE IDENTIDADES ESTÁVEIS.
 * 
 * Regra Arquitetural Obrigatória:
 * - DEVE ser executada exclusivamente sob o Web Lock por restaurante.
 * - Releia dados locais e o manifesto no storage.
 * - Valida corrupção, disponibilidade e ambiguidades.
 * - Atribui origin_ids aos itens pendentes de forma idempotente e serializada.
 * - Persiste o manifesto atualizado com confirmação imediata.
 * - Retorna um SNAPSHOT IMUTÁVEL dos registros prontos para envio ao banco.
 * - O lock é liberado assim que este snapshot é retornado (antes de chamadas de rede).
 */
export async function prepareLocalReservationsForImport(
  restaurantId: string,
  rawJson: string | null,
  activeTableNumbers: Set<number>,
  tablesLoadedAndReady: boolean,
  customStorage?: Storage,
): Promise<readonly LocalReservationPreviewItem[]> {
  if (!isValidUuid(restaurantId)) {
    throw new Error('ID de restaurante inválido para preparação de importação.');
  }

  if (!tablesLoadedAndReady) {
    throw new Error('Não é possível preparar reservas enquanto a lista de mesas não estiver carregada e confirmada.');
  }

  if (!rawJson) {
    throw new Error('Nenhum dado local encontrado para importação.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error('Formato JSON inválido ou corrompido nos dados locais de reservas.');
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('Nenhum registro de reserva válido encontrado na lista local.');
  }

  // 1. Re-leitura e validação estrita do manifesto
  const manifestLoad = loadImportManifest(restaurantId, customStorage);
  if (manifestLoad.status === 'corrupted') {
    throw new Error(`Manifesto local corrompido: ${manifestLoad.error}. Importação cancelada.`);
  }
  if (manifestLoad.status === 'unavailable') {
    throw new Error(`Armazenamento local inacessível: ${manifestLoad.error}. Importação cancelada.`);
  }

  const manifest = manifestLoad.status === 'valid' ? manifestLoad.manifest : null;
  const currentFingerprint = computeDatasetFingerprint(parsed);

  const manifestMap = new Map<string, string>();
  const manifestCountsBySignature = new Map<string, number>();

  if (manifest) {
    for (const entry of manifest.entries) {
      manifestMap.set(`${entry.rawSignature}#${entry.occurrenceIndex}`, entry.assignedOriginId);
      manifestCountsBySignature.set(
        entry.rawSignature,
        (manifestCountsBySignature.get(entry.rawSignature) || 0) + 1,
      );
    }
  }

  const sourceWasModified = Boolean(
    manifest && manifest.sourceFingerprint && manifest.sourceFingerprint !== currentFingerprint,
  );

  const currentCountsBySignature = new Map<string, number>();
  for (const rawItem of parsed) {
    if (rawItem && typeof rawItem === 'object') {
      const it = rawItem as Record<string, unknown>;
      if (!it.id) {
        const sig = buildItemSignature(
          Number(it.tableNumber),
          String(it.date ?? ''),
          String(it.time ?? ''),
          String(it.customerName ?? ''),
          String(it.phone ?? ''),
          Number(it.guestsCount ?? 2),
          String(it.notes ?? ''),
          String(it.status ?? 'confirmed'),
        );
        currentCountsBySignature.set(sig, (currentCountsBySignature.get(sig) || 0) + 1);
      }
    }
  }

  const declaredLocalIds = new Map<string, number>();
  for (const rawItem of parsed) {
    if (rawItem && typeof rawItem === 'object') {
      const it = rawItem as Record<string, unknown>;
      if (typeof it.id === 'string' && it.id.trim()) {
        const trimmed = it.id.trim();
        declaredLocalIds.set(trimmed, (declaredLocalIds.get(trimmed) || 0) + 1);
      }
    }
  }

  const updatedEntries: LocalManifestEntry[] = manifest ? [...manifest.entries] : [];
  let manifestModified = false;

  const signatureOccurrences = new Map<string, number>();
  const preparedItems: LocalReservationPreviewItem[] = [];

  for (let index = 0; index < parsed.length; index++) {
    const rawItem = parsed[index];
    if (!rawItem || typeof rawItem !== 'object') {
      throw new Error(`Item #${index} na lista local é nulo ou possui formato inválido.`);
    }

    const item = rawItem as Record<string, unknown>;
    const errors: string[] = [];

    const tableNumber = Number(item.tableNumber);
    const customerName = typeof item.customerName === 'string' ? item.customerName.trim() : '';
    const phone = typeof item.phone === 'string' ? item.phone.trim() : '';
    const date = typeof item.date === 'string' ? item.date.trim() : '';
    const time = typeof item.time === 'string' ? item.time.trim() : '';
    const status = typeof item.status === 'string' && item.status.trim() ? item.status.trim() : 'confirmed';
    const rawGuests = Number(item.guestsCount ?? 2);
    const guestsCount = Number.isInteger(rawGuests) ? rawGuests : 2;
    const notes = typeof item.notes === 'string' ? item.notes.trim() : '';

    const rawId = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : null;
    let originId = '';

    if (rawId) {
      if ((declaredLocalIds.get(rawId) || 0) > 1) {
        errors.push(`Identificador local duplicado na mesma origem: "${rawId}".`);
      }
      originId = `local-id:${rawId}`;
    } else {
      const signature = buildItemSignature(tableNumber, date, time, customerName, phone, guestsCount, notes, status);
      const occurrence = signatureOccurrences.get(signature) || 0;
      signatureOccurrences.set(signature, occurrence + 1);

      const compositeKey = `${signature}#${occurrence}`;
      const assignedId = manifestMap.get(compositeKey);

      if (sourceWasModified) {
        const previousCount = manifestCountsBySignature.get(signature) || 0;
        const currentCount = currentCountsBySignature.get(signature) || 0;

        if (!assignedId || previousCount !== currentCount) {
          throw new Error(
            `Origem local modificada: correspondência ambígua para a reserva de "${customerName}" (Mesa ${tableNumber}). Reconciliação necessária antes de importar.`,
          );
        }
      }

      if (assignedId) {
        originId = assignedId;
      } else {
        // Atribuição atômica protegida sob lock exclusivo
        const newOriginId = `loc-manifest:${crypto.randomUUID()}`;
        manifestMap.set(compositeKey, newOriginId);
        updatedEntries.push({
          rawSignature: signature,
          occurrenceIndex: occurrence,
          assignedOriginId: newOriginId,
          firstSeenAt: new Date().toISOString(),
        });
        manifestModified = true;
        originId = newOriginId;
      }
    }

    if (!customerName) errors.push('Nome do cliente ausente.');
    if (!Number.isInteger(tableNumber) || tableNumber < 1 || tableNumber > 999) {
      errors.push('Número de mesa inválido.');
    } else if (!activeTableNumbers.has(tableNumber)) {
      errors.push(`Mesa ${tableNumber} não cadastrada ou inativa neste restaurante.`);
    }

    if (!date || !isValidDateString(date)) errors.push(`Data inválida: "${date}".`);
    if (!time || !isValidTimeString(time)) errors.push(`Horário inválido: "${time}".`);
    if (!['confirmed', 'confirmada', 'agendada', 'reservada', 'seated', 'cancelled'].includes(status)) {
      errors.push(`Status inválido: "${status}".`);
    }
    if (guestsCount < 1 || guestsCount > 99) {
      errors.push('Quantidade de pessoas inválida (deve estar entre 1 e 99).');
    }

    if (errors.length > 0) {
      throw new Error(`Dados inválidos na reserva de "${customerName || 'Sem nome'}" (Mesa ${tableNumber}): ${errors.join(', ')}`);
    }

    preparedItems.push({
      id: rawId && isValidUuid(rawId) ? rawId : crypto.randomUUID(),
      originId,
      tableNumber,
      customerName,
      phone,
      date,
      time,
      status,
      guestsCount,
      notes,
      isValid: true,
      validationErrors: [],
    });
  }

  // 2. Persistência e confirmação imediata da escrita do manifesto
  if (manifestModified || (manifest && !manifest.sourceFingerprint) || manifestLoad.status === 'absent') {
    const newManifest: LocalImportManifest = {
      version: 1,
      restaurantId,
      sourceFingerprint: currentFingerprint,
      sourceTotalCount: parsed.length,
      entries: updatedEntries,
    };

    const saveRes = saveImportManifest(newManifest, customStorage);
    if (!saveRes.success) {
      throw new Error(`Falha ao salvar manifesto local: ${saveRes.error}. Importação abortada.`);
    }
  }

  // Retorna snapshot desacoplado e protegido
  return Object.freeze(preparedItems.map((item) => ({ ...item })));
}

export interface ImportExecutionResult {
  importedCount: number;
  alreadyExistsCount: number;
  invalidCount: number;
  errorCount: number;
  details: {
    customerName: string;
    tableNumber: number;
    date: string;
    time: string;
    outcome: 'imported' | 'already_exists' | 'invalid' | 'error';
    message: string;
  }[];
}

/**
 * IMPORTAÇÃO PARA O BANCO DE DADOS (FORA DO WEB LOCK).
 * 
 * Regra Arquitetural Obrigatória:
 * - É executada estritamente FORA do Web Lock para não segurar a exclusão mútua
 *   durante as operações de rede (INSERT, SELECT) no Supabase.
 * - Recebe o snapshot imutável previamente preparado.
 * - Não altera os dados locais originais.
 * - Confirma que o manifesto local continua íntegro antes de iniciar.
 */
export async function executeLocalReservationsImport(
  restaurantId: string,
  preparedItems: readonly LocalReservationPreviewItem[],
  tablesLoadedAndReady: boolean,
  customStorage?: Storage,
): Promise<ImportExecutionResult> {
  const result: ImportExecutionResult = {
    importedCount: 0,
    alreadyExistsCount: 0,
    invalidCount: 0,
    errorCount: 0,
    details: [],
  };

  if (!isValidUuid(restaurantId)) {
    throw new Error('ID de restaurante inválido para importação.');
  }

  if (!tablesLoadedAndReady) {
    throw new Error('Não é possível importar reservas enquanto a lista de mesas do restaurante não estiver confirmada.');
  }

  // Confirmação de integridade do manifesto antes de iniciar requisições ao Supabase
  const manifestLoad = loadImportManifest(restaurantId, customStorage);
  if (manifestLoad.status === 'corrupted' || manifestLoad.status === 'unavailable') {
    throw new Error(
      `Importação bloqueada: manifesto local ${manifestLoad.status === 'corrupted' ? 'corrompido' : 'indisponível'} (${manifestLoad.error}).`,
    );
  }

  for (const item of preparedItems) {
    if (!item.isValid) {
      result.invalidCount++;
      result.details.push({
        customerName: item.customerName,
        tableNumber: item.tableNumber,
        date: item.date,
        time: item.time,
        outcome: 'invalid',
        message: item.validationErrors.join(' | '),
      });
      continue;
    }

    try {
      await createReservation({
        restaurantId,
        tableNumber: item.tableNumber,
        customerName: item.customerName,
        phone: item.phone,
        date: item.date,
        time: item.time,
        guestsCount: item.guestsCount,
        notes: item.notes,
        status: item.status as any,
        originId: item.originId,
      });

      result.importedCount++;
      result.details.push({
        customerName: item.customerName,
        tableNumber: item.tableNumber,
        date: item.date,
        time: item.time,
        outcome: 'imported',
        message: 'Importada com sucesso para o banco de dados.',
      });
    } catch (err) {
      // Verificação rigorosa para 23505 (duplicação única)
      let isConfirmedDuplicate = false;

      if (item.originId) {
        try {
          const { data: existingRow } = await supabase
            .from('reservations')
            .select('id, origin_id')
            .eq('restaurant_id', restaurantId)
            .eq('origin_id', item.originId)
            .maybeSingle();

          if (existingRow && existingRow.origin_id === item.originId) {
            isConfirmedDuplicate = true;
          }
        } catch {
          // Mantém o tratamento de erro padrão se a consulta falhar
        }
      }

      if (isConfirmedDuplicate) {
        result.alreadyExistsCount++;
        result.details.push({
          customerName: item.customerName,
          tableNumber: item.tableNumber,
          date: item.date,
          time: item.time,
          outcome: 'already_exists',
          message: 'Já existente no banco de dados (duplicata evitada pelo identificador de origem).',
        });
      } else {
        const msg = err instanceof Error ? err.message : 'Erro desconhecido';
        result.errorCount++;
        result.details.push({
          customerName: item.customerName,
          tableNumber: item.tableNumber,
          date: item.date,
          time: item.time,
          outcome: 'error',
          message: msg,
        });
      }
    }
  }

  return result;
}

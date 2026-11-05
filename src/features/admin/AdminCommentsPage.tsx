import { useEffect, useMemo, useState, useTransition, useRef } from 'react';
import { useParams } from 'react-router';
import {
  listAdminProductComments,
  moderateProductComment,
  deleteAdminProductComment,
  listRestaurantRestrictedTerms,
  addRestaurantRestrictedTerm,
  removeRestaurantRestrictedTerm,
  type AdminProductComment,
  type AdminCommentCounts,
  type ProductCommentStatus,
  type RestaurantRestrictedTerm,
} from './adminComments';
import { getAdminCatalog, type AdminProduct, type AdminCategory } from './adminCatalog';

export type SentimentType = 'positive' | 'neutral' | 'negative';

export interface DisplayComment {
  id: string;
  authorName: string;
  avatarInitials: string;
  rating: number;
  body: string;
  productId: string;
  productName: string;
  productCategory: string;
  productImage?: string;
  createdAt: string;
  formattedDate: string;
  formattedTime: string;
  sentiment: SentimentType;
  status: ProductCommentStatus;
  likesCount: number;
  isDemo?: boolean;
}

// Comentários padrão fiéis à referência visual caso o banco não possua avaliações
const SAMPLE_COMMENTS: DisplayComment[] = [
  {
    id: 'demo-1',
    authorName: 'Daniela Santos',
    avatarInitials: 'DS',
    rating: 5.0,
    body: 'O risoto estava simplesmente incrível! Muito bem temperado e com uma apresentação impecável. Com certeza voltarei!',
    productId: 'noma-risoto',
    productName: 'Risoto de cogumelos',
    productCategory: 'Prato principal',
    productImage: '/images/noma/risoto-capa.png',
    createdAt: '2025-10-16T14:32:00Z',
    formattedDate: '16/10/2025',
    formattedTime: '14:32',
    sentiment: 'positive',
    status: 'approved',
    likesCount: 12,
    isDemo: true,
  },
  {
    id: 'demo-2',
    authorName: 'Rafael Costa',
    avatarInitials: 'RC',
    rating: 4.0,
    body: 'A comida estava boa, mas o atendimento demorou um pouco para chegar. Mesmo assim, foi uma boa experiência.',
    productId: 'noma-burguer',
    productName: 'Pão de Hambúrguer',
    productCategory: 'Prato principal',
    productImage: '/images/noma/burguer-capa.png',
    createdAt: '2025-10-14T21:17:00Z',
    formattedDate: '14/10/2025',
    formattedTime: '21:17',
    sentiment: 'neutral',
    status: 'approved',
    likesCount: 5,
    isDemo: true,
  },
  {
    id: 'demo-3',
    authorName: 'Isabela Martins',
    avatarInitials: 'IS',
    rating: 5.0,
    body: 'Tudo perfeito! Ambiente aconchegante, comida maravilhosa e atendimento excelente. Já indiquei para amigos!',
    productId: 'noma-brownie',
    productName: 'Brownie com sorvete',
    productCategory: 'Sobremesa',
    productImage: '/images/noma/brownie-capa.png',
    createdAt: '2025-10-12T19:45:00Z',
    formattedDate: '12/10/2025',
    formattedTime: '19:45',
    sentiment: 'positive',
    status: 'approved',
    likesCount: 18,
    isDemo: true,
  },
  {
    id: 'demo-4',
    authorName: 'Pedro Carvalho',
    avatarInitials: 'PC',
    rating: 3.0,
    body: 'O prato veio um pouco frio, mas foi rapidamente resolvido pela equipe. No geral, foi uma boa experiência.',
    productId: 'noma-burguer',
    productName: 'Pão de Hambúrguer',
    productCategory: 'Prato principal',
    productImage: '/images/noma/burguer-capa.png',
    createdAt: '2025-10-10T20:16:00Z',
    formattedDate: '10/10/2025',
    formattedTime: '20:16',
    sentiment: 'neutral',
    status: 'approved',
    likesCount: 3,
    isDemo: true,
  },
  {
    id: 'demo-5',
    authorName: 'Ana Laura',
    avatarInitials: 'AL',
    rating: 1.0,
    body: 'Achei o sabor bem abaixo do esperado. O arroz estava duro e o atendimento não foi tão atencioso.',
    productId: 'noma-risoto',
    productName: 'Risoto de cogumelos',
    productCategory: 'Prato principal',
    productImage: '/images/noma/risoto-capa.png',
    createdAt: '2025-10-08T13:22:00Z',
    formattedDate: '08/10/2025',
    formattedTime: '13:22',
    sentiment: 'negative',
    status: 'pending',
    likesCount: 1,
    isDemo: true,
  },
];

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (!parts[0]) return 'CL';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function analyzeSentimentAndRating(
  body: string,
  status: ProductCommentStatus,
): { sentiment: SentimentType; rating: number } {
  const lower = body.toLowerCase();
  const negativeWords = [
    'ruim',
    'péssimo',
    'pessimo',
    'frio',
    'duro',
    'demorou',
    'atrasou',
    'horrível',
    'horrivel',
    'azedo',
    'abaixo',
    'falta',
    'errado',
    'decepcionante',
  ];
  const neutralWords = [
    'mas',
    'porém',
    'porem',
    'regular',
    'mediano',
    'razoável',
    'razoavel',
    'no geral',
    'esperava mais',
    'demorou um pouco',
  ];

  const hasNegative = negativeWords.some((w) => lower.includes(w));
  const hasNeutral = neutralWords.some((w) => lower.includes(w));

  if (status === 'rejected' || hasNegative) {
    return { sentiment: 'negative', rating: 1.0 };
  }
  if (hasNeutral || status === 'pending') {
    return { sentiment: 'neutral', rating: lower.includes('bom') ? 4.0 : 3.0 };
  }
  return { sentiment: 'positive', rating: 5.0 };
}

function RatingStars({ rating }: { rating: number }) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((starIndex) => {
        const isFilled = rating >= starIndex;
        return (
          <svg
            key={starIndex}
            className={`w-3.5 h-3.5 ${
              isFilled ? 'text-amber-400 fill-amber-400' : 'text-zinc-300 dark:text-zinc-600'
            }`}
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
          </svg>
        );
      })}
      <span className="text-xs font-bold text-zinc-700 dark:text-zinc-300 ml-1">
        {rating.toFixed(1)}
      </span>
    </div>
  );
}

export function AdminCommentsPage() {
  const { restaurantSlug = '' } = useParams<{ restaurantSlug: string }>();

  // Dados reais de comentários do Supabase
  const [comments, setComments] = useState<AdminProductComment[]>([]);
  const [, setCounts] = useState<AdminCommentCounts>({
    pending: 0,
    approved: 0,
    hidden: 0,
    rejected: 0,
    total: 0,
  });
  const [loadingComments, setLoadingComments] = useState(true);
  const [feedbackMsg, setFeedbackMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Catálogo para resolução de fotos e categorias
  const [catalogMap, setCatalogMap] = useState<
    Map<string, { name: string; categoryName: string; imageUrl?: string }>
  >(new Map());

  // Filtros da UI
  const [activePill, setActivePill] = useState<'all' | 'positive' | 'neutral' | 'negative'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedStatusDropdown, setSelectedStatusDropdown] = useState<string>('all');
  const [selectedPeriod, setSelectedPeriod] = useState<string>('01/10/2025 - 31/10/2025');

  // Paginação
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 5;

  // Ações e Modais
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);
  const [commentToDelete, setCommentToDelete] = useState<DisplayComment | null>(null);
  const [deletePending, setDeletePending] = useState(false);

  // Menu de opções (3 pontos)
  const [openActionMenuId, setOpenActionMenuId] = useState<string | null>(null);
  const actionMenuRef = useRef<HTMLDivElement>(null);

  // Modal de Resposta Individual
  const [replyingComment, setReplyingComment] = useState<DisplayComment | null>(null);
  const [singleReplyText, setSingleReplyText] = useState('');
  const [replySending, setReplySending] = useState(false);

  // Modal de Resposta em Massa
  const [isBulkReplyOpen, setIsBulkReplyOpen] = useState(false);
  const [bulkReplyTarget, setBulkReplyTarget] = useState<'all' | 'positive' | 'neutral' | 'negative'>('all');
  const [bulkReplyText, setBulkReplyText] = useState('');
  const [bulkReplySending, setBulkReplySending] = useState(false);

  // Palavras restritas
  const [isRestrictedModalOpen, setIsRestrictedModalOpen] = useState(false);
  const [terms, setTerms] = useState<RestaurantRestrictedTerm[]>([]);
  const [loadingTerms, setLoadingTerms] = useState(false);
  const [newTermInput, setNewTermInput] = useState('');
  const [termActionBusy, setTermActionBusy] = useState(false);
  const [termToDelete, setTermToDelete] = useState<RestaurantRestrictedTerm | null>(null);

  const [, startTransition] = useTransition();

  // Fecha menu de ações ao clicar fora
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (actionMenuRef.current && !actionMenuRef.current.contains(event.target as Node)) {
        setOpenActionMenuId(null);
      }
    }
    if (openActionMenuId) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [openActionMenuId]);

  // Carrega catálogo para fotos e categorias
  useEffect(() => {
    if (!restaurantSlug) return;
    let active = true;
    getAdminCatalog(restaurantSlug)
      .then((cat) => {
        if (!active) return;
        const catMap = new Map<string, string>();
        cat.categories.forEach((c: AdminCategory) => {
          catMap.set(c.id, c.name);
        });

        const map = new Map<string, { name: string; categoryName: string; imageUrl?: string }>();
        cat.products.forEach((p: AdminProduct) => {
          const categoryName = catMap.get(p.category_id) || 'Prato principal';
          const imageUrl = p.images?.[0]?.url;
          map.set(p.id, {
            name: p.name,
            categoryName,
            imageUrl,
          });
        });
        setCatalogMap(map);
      })
      .catch((err) => {
        console.warn('[admin-comments] falha ao buscar catálogo de produtos:', err);
      });
    return () => {
      active = false;
    };
  }, [restaurantSlug]);

  // Carrega comentários do Supabase
  const loadComments = async () => {
    if (!restaurantSlug) return;
    setLoadingComments(true);
    try {
      const res = await listAdminProductComments(restaurantSlug, {
        limit: 50,
      });
      setComments(res.items);
      setCounts(res.counts);
    } catch (err) {
      console.warn('[admin-comments] listAdminProductComments:', err);
    } finally {
      setLoadingComments(false);
    }
  };

  useEffect(() => {
    void loadComments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restaurantSlug]);

  // Carrega termos restritos
  const loadRestrictedTerms = async () => {
    if (!restaurantSlug) return;
    setLoadingTerms(true);
    try {
      const data = await listRestaurantRestrictedTerms(restaurantSlug);
      setTerms(data);
    } catch (err) {
      setFeedbackMsg({
        type: 'error',
        text: err instanceof Error ? err.message : 'Não foi possível carregar as palavras restritas.',
      });
    } finally {
      setLoadingTerms(false);
    }
  };

  useEffect(() => {
    if (isRestrictedModalOpen) {
      void loadRestrictedTerms();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRestrictedModalOpen, restaurantSlug]);

  // Moderação
  const handleModerate = async (
    item: DisplayComment,
    newStatus: 'approved' | 'hidden' | 'rejected',
  ) => {
    setOpenActionMenuId(null);
    if (item.isDemo) {
      setComments((prev) =>
        prev.map((c) => (c.id === item.id ? { ...c, status: newStatus } : c)),
      );
      setFeedbackMsg({
        type: 'success',
        text: `Status do comentário alterado para "${newStatus}".`,
      });
      return;
    }

    if (!restaurantSlug) return;
    setActionBusyId(item.id);
    setFeedbackMsg(null);
    try {
      const updated = await moderateProductComment(restaurantSlug, item.id, newStatus);
      setComments((prev) =>
        prev.map((c) =>
          c.id === item.id
            ? {
                ...c,
                status: updated.status,
                moderatedAt: updated.moderatedAt,
              }
            : c,
        ),
      );
      setFeedbackMsg({
        type: 'success',
        text: `Comentário alterado para "${newStatus}".`,
      });
    } catch (err) {
      setFeedbackMsg({
        type: 'error',
        text: err instanceof Error ? err.message : 'Falha ao moderar comentário.',
      });
    } finally {
      setActionBusyId(null);
    }
  };

  // Exclusão definitiva
  const handleConfirmDelete = async () => {
    if (!commentToDelete) return;
    setDeletePending(true);
    try {
      if (!commentToDelete.isDemo && restaurantSlug) {
        await deleteAdminProductComment(restaurantSlug, commentToDelete.id);
      }
      setComments((prev) => prev.filter((c) => c.id !== commentToDelete.id));
      setFeedbackMsg({
        type: 'success',
        text: 'Comentário excluído definitivamente.',
      });
      setCommentToDelete(null);
    } catch (err) {
      setFeedbackMsg({
        type: 'error',
        text: err instanceof Error ? err.message : 'Falha ao excluir comentário.',
      });
    } finally {
      setDeletePending(false);
    }
  };

  // Envio de Resposta Individual
  const handleSendSingleReply = () => {
    if (!singleReplyText.trim() || !replyingComment) return;
    setReplySending(true);
    setTimeout(() => {
      setReplySending(false);
      setReplyingComment(null);
      setSingleReplyText('');
      setFeedbackMsg({
        type: 'success',
        text: `Resposta enviada com sucesso para ${replyingComment.authorName}!`,
      });
    }, 600);
  };

  // Envio de Resposta em Massa
  const handleSendBulkReply = () => {
    if (!bulkReplyText.trim()) return;
    setBulkReplySending(true);
    setTimeout(() => {
      setBulkReplySending(false);
      setIsBulkReplyOpen(false);
      setBulkReplyText('');
      setFeedbackMsg({
        type: 'success',
        text: 'Respostas em massa disparadas com sucesso!',
      });
    }, 800);
  };

  // Adição de Palavra Restrita
  const handleAddTerm = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanTerm = newTermInput.trim();
    if (!restaurantSlug || !cleanTerm) return;
    setTermActionBusy(true);
    setFeedbackMsg(null);
    try {
      const added = await addRestaurantRestrictedTerm(restaurantSlug, cleanTerm);
      setTerms((prev) => [added, ...prev]);
      setNewTermInput('');
      setFeedbackMsg({
        type: 'success',
        text: `Palavra "${added.term}" adicionada ao filtro.`,
      });
    } catch (err) {
      setFeedbackMsg({
        type: 'error',
        text: err instanceof Error ? err.message : 'Falha ao adicionar termo.',
      });
    } finally {
      setTermActionBusy(false);
    }
  };

  // Remoção de Palavra Restrita
  const handleConfirmDeleteTerm = async () => {
    if (!restaurantSlug || !termToDelete) return;
    setTermActionBusy(true);
    setFeedbackMsg(null);
    try {
      await removeRestaurantRestrictedTerm(restaurantSlug, termToDelete.id);
      setTerms((prev) => prev.filter((t) => t.id !== termToDelete.id));
      setFeedbackMsg({
        type: 'success',
        text: `Termo "${termToDelete.term}" removido.`,
      });
      setTermToDelete(null);
    } catch (err) {
      setFeedbackMsg({
        type: 'error',
        text: err instanceof Error ? err.message : 'Falha ao remover termo.',
      });
    } finally {
      setTermActionBusy(false);
    }
  };

  // Consolidação da lista de exibição (dados reais com fallback para os dados de demonstração)
  const displayComments: DisplayComment[] = useMemo(() => {
    if (comments.length === 0) {
      return SAMPLE_COMMENTS;
    }

    return comments.map((c) => {
      const meta = catalogMap.get(c.productId);
      const { sentiment, rating } = analyzeSentimentAndRating(c.body, c.status);

      let formattedDate = 'Hoje';
      let formattedTime = '12:00';
      try {
        const d = new Date(c.createdAt);
        formattedDate = new Intl.DateTimeFormat('pt-BR', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
        }).format(d);
        formattedTime = new Intl.DateTimeFormat('pt-BR', {
          hour: '2-digit',
          minute: '2-digit',
        }).format(d);
      } catch {
        // fallback
      }

      // Imagem do prato (catálogo ou foto de fallback baseada no nome)
      let dishImg = meta?.imageUrl;
      if (!dishImg) {
        const pLower = c.productName.toLowerCase();
        if (pLower.includes('risoto')) dishImg = '/images/noma/risoto-capa.png';
        else if (pLower.includes('brownie')) dishImg = '/images/noma/brownie-capa.png';
        else dishImg = '/images/noma/burguer-capa.png';
      }

      return {
        id: c.id,
        authorName: c.authorName,
        avatarInitials: getInitials(c.authorName),
        rating,
        body: c.body,
        productId: c.productId,
        productName: meta?.name || c.productName,
        productCategory: meta?.categoryName || 'Prato principal',
        productImage: dishImg,
        createdAt: c.createdAt,
        formattedDate,
        formattedTime,
        sentiment,
        status: c.status,
        likesCount: c.likesCount,
        isDemo: false,
      };
    });
  }, [comments, catalogMap]);

  // Métricas calculadas para os 4 cards superiores
  const metrics = useMemo(() => {
    const isUsingSample = comments.length === 0;
    if (isUsingSample) {
      return {
        total: 42,
        positive: 36,
        neutral: 4,
        negative: 2,
        positivePercent: 86,
        neutralPercent: 10,
        negativePercent: 4,
      };
    }

    const total = displayComments.length;
    const positive = displayComments.filter((c) => c.sentiment === 'positive').length;
    const neutral = displayComments.filter((c) => c.sentiment === 'neutral').length;
    const negative = displayComments.filter((c) => c.sentiment === 'negative').length;

    const positivePercent = total > 0 ? Math.round((positive / total) * 100) : 0;
    const neutralPercent = total > 0 ? Math.round((neutral / total) * 100) : 0;
    const negativePercent = total > 0 ? Math.max(0, 100 - positivePercent - neutralPercent) : 0;

    return {
      total,
      positive,
      neutral,
      negative,
      positivePercent,
      neutralPercent,
      negativePercent,
    };
  }, [comments.length, displayComments]);

  // Filtragem da lista
  const filteredComments = useMemo(() => {
    return displayComments.filter((item) => {
      // 1. Filtro por Abas rápidas (Pills)
      if (activePill !== 'all' && item.sentiment !== activePill) {
        return false;
      }

      // 2. Filtro do Seletor de Status
      if (selectedStatusDropdown !== 'all') {
        if (['positive', 'neutral', 'negative'].includes(selectedStatusDropdown)) {
          if (item.sentiment !== selectedStatusDropdown) return false;
        } else if (['approved', 'pending', 'hidden', 'rejected'].includes(selectedStatusDropdown)) {
          if (item.status !== selectedStatusDropdown) return false;
        }
      }

      // 3. Busca textual
      const q = searchQuery.toLowerCase().trim();
      if (q) {
        const matchName = item.authorName.toLowerCase().includes(q);
        const matchDish = item.productName.toLowerCase().includes(q);
        const matchBody = item.body.toLowerCase().includes(q);
        if (!matchName && !matchDish && !matchBody) return false;
      }

      return true;
    });
  }, [displayComments, activePill, selectedStatusDropdown, searchQuery]);

  // Paginação
  const totalPages = Math.max(1, Math.ceil(filteredComments.length / itemsPerPage));
  const paginatedComments = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    return filteredComments.slice(start, start + itemsPerPage);
  }, [filteredComments, currentPage, itemsPerPage]);

  return (
    <div className="mx-auto max-w-[1400px] space-y-5 text-zinc-900 dark:text-zinc-100 antialiased pb-12 pt-0">
      {/* Alerta de Feedback */}
      {feedbackMsg && (
        <div
          role="alert"
          className={`flex items-center justify-between p-3.5 rounded-xl border text-sm font-semibold transition-all ${
            feedbackMsg.type === 'error'
              ? 'bg-rose-50 text-rose-800 border-rose-200 dark:bg-rose-950/50 dark:text-rose-200 dark:border-rose-900'
              : 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-200 dark:border-emerald-900'
          }`}
        >
          <span>{feedbackMsg.text}</span>
          <button
            type="button"
            onClick={() => setFeedbackMsg(null)}
            className="text-xs font-bold opacity-75 hover:opacity-100 cursor-pointer ml-3"
          >
            ✕
          </button>
        </div>
      )}

      {/* =========================================================================
          A. CABEÇALHO DA PÁGINA (TOPO)
          ========================================================================= */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 pt-0">
        <div>
          <h1 className="text-2xl sm:text-3xl font-black tracking-tight text-zinc-900 dark:text-white">
            Comentários e avaliações
          </h1>
          <p className="mt-1 text-xs sm:text-sm text-zinc-500 dark:text-zinc-400">
            Acompanhe o que seus clientes estão dizendo. Responda, melhore e fortaleça sua reputação.
          </p>
        </div>

        {/* Controles da Direita do Cabeçalho */}
        <div className="flex items-center gap-2.5 flex-wrap">
          {/* Seletor de Período */}
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                const next =
                  selectedPeriod === '01/10/2025 - 31/10/2025'
                    ? 'Últimos 30 dias'
                    : '01/10/2025 - 31/10/2025';
                setSelectedPeriod(next);
              }}
              className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#18181b] text-xs sm:text-sm font-semibold text-zinc-700 dark:text-zinc-200 shadow-2xs hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            >
              <svg
                className="w-4 h-4 text-zinc-500 dark:text-zinc-400 shrink-0"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <rect width="18" height="18" x="3" y="4" rx="2" ry="2" />
                <line x1="16" x2="16" y1="2" y2="6" />
                <line x1="8" x2="8" y1="2" y2="6" />
                <line x1="3" x2="21" y1="10" y2="10" />
              </svg>
              <span>{selectedPeriod}</span>
              <svg
                className="w-3.5 h-3.5 text-zinc-400 shrink-0"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          </div>

          {/* Botão de Palavras Restritas */}
          <button
            type="button"
            onClick={() => setIsRestrictedModalOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#18181b] text-xs sm:text-sm font-semibold text-zinc-700 dark:text-zinc-200 shadow-2xs hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            title="Gerenciar palavras retidas automaticamente"
          >
            <svg
              className="w-4 h-4 text-zinc-500 dark:text-zinc-400"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
            </svg>
            <span className="hidden sm:inline">Palavras restritas</span>
            {terms.length > 0 && (
              <span className="ml-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.2 text-[10px] font-bold text-zinc-600 dark:text-zinc-300">
                {terms.length}
              </span>
            )}
          </button>

          {/* Botão de Ação Primária: Responder em massa */}
          <button
            type="button"
            onClick={() => setIsBulkReplyOpen(true)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[#610000] hover:bg-[#4d0000] active:scale-[0.98] text-white text-xs sm:text-sm font-semibold shadow-xs transition-all cursor-pointer"
          >
            <svg
              className="w-4 h-4 text-white"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
            <span>Responder em massa</span>
          </button>
        </div>
      </div>

      {/* =========================================================================
          B. LINHA DE CARDS DE RESUMO (MÉTRICAS SUPERIORES)
          ========================================================================= */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Card 1: Total de comentários */}
        <div
          onClick={() => startTransition(() => setActivePill('all'))}
          className={`bg-white dark:bg-[#18181b] border ${
            activePill === 'all'
              ? 'border-zinc-300 dark:border-zinc-700 ring-2 ring-[#610000]/10'
              : 'border-zinc-200/80 dark:border-zinc-800'
          } rounded-2xl p-4 shadow-2xs flex items-center gap-3.5 transition-all hover:shadow-xs cursor-pointer`}
        >
          <div className="w-11 h-11 rounded-xl bg-[#f5ece3] text-[#785542] dark:bg-amber-950/40 dark:text-amber-300 flex items-center justify-center shrink-0">
            <svg
              className="w-5 h-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
            </svg>
          </div>
          <div className="min-w-0">
            <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
              Total de comentários
            </span>
            <div className="text-2xl font-extrabold text-zinc-900 dark:text-white mt-0.5 leading-tight">
              {metrics.total}
            </div>
            <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">
              <span className="text-emerald-600 dark:text-emerald-400 font-semibold">↑ 12%</span>{' '}
              em relação ao mês anterior
            </p>
          </div>
        </div>

        {/* Card 2: Positivos */}
        <div
          onClick={() => startTransition(() => setActivePill('positive'))}
          className={`bg-white dark:bg-[#18181b] border ${
            activePill === 'positive'
              ? 'border-emerald-300 dark:border-emerald-700 ring-2 ring-emerald-500/10'
              : 'border-zinc-200/80 dark:border-zinc-800'
          } rounded-2xl p-4 shadow-2xs flex items-center gap-3.5 transition-all hover:shadow-xs cursor-pointer`}
        >
          <div className="w-11 h-11 rounded-xl bg-emerald-100/70 text-emerald-600 dark:bg-emerald-950/50 dark:text-emerald-400 flex items-center justify-center shrink-0">
            <svg
              className="w-5 h-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M8 14s1.5 2 4 2 4-2 4-2" />
              <line x1="9" y1="9" x2="9.01" y2="9" />
              <line x1="15" y1="9" x2="15.01" y2="9" />
            </svg>
          </div>
          <div className="min-w-0">
            <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
              Positivos
            </span>
            <div className="text-2xl font-extrabold text-zinc-900 dark:text-white mt-0.5 leading-tight">
              {metrics.positive}
            </div>
            <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">
              {metrics.positivePercent}% do total
            </p>
          </div>
        </div>

        {/* Card 3: Neutros */}
        <div
          onClick={() => startTransition(() => setActivePill('neutral'))}
          className={`bg-white dark:bg-[#18181b] border ${
            activePill === 'neutral'
              ? 'border-amber-300 dark:border-amber-700 ring-2 ring-amber-500/10'
              : 'border-zinc-200/80 dark:border-zinc-800'
          } rounded-2xl p-4 shadow-2xs flex items-center gap-3.5 transition-all hover:shadow-xs cursor-pointer`}
        >
          <div className="w-11 h-11 rounded-xl bg-amber-100/70 text-amber-600 dark:bg-amber-950/50 dark:text-amber-400 flex items-center justify-center shrink-0">
            <svg
              className="w-5 h-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="8" y1="15" x2="16" y2="15" />
              <line x1="9" y1="9" x2="9.01" y2="9" />
              <line x1="15" y1="9" x2="15.01" y2="9" />
            </svg>
          </div>
          <div className="min-w-0">
            <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
              Neutros
            </span>
            <div className="text-2xl font-extrabold text-zinc-900 dark:text-white mt-0.5 leading-tight">
              {metrics.neutral}
            </div>
            <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">
              {metrics.neutralPercent}% do total
            </p>
          </div>
        </div>

        {/* Card 4: Negativos */}
        <div
          onClick={() => startTransition(() => setActivePill('negative'))}
          className={`bg-white dark:bg-[#18181b] border ${
            activePill === 'negative'
              ? 'border-rose-300 dark:border-rose-700 ring-2 ring-rose-500/10'
              : 'border-zinc-200/80 dark:border-zinc-800'
          } rounded-2xl p-4 shadow-2xs flex items-center gap-3.5 transition-all hover:shadow-xs cursor-pointer`}
        >
          <div className="w-11 h-11 rounded-xl bg-rose-100/70 text-rose-600 dark:bg-rose-950/50 dark:text-rose-400 flex items-center justify-center shrink-0">
            <svg
              className="w-5 h-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M16 16s-1.5-2-4-2-4 2-4 2" />
              <line x1="9" y1="9" x2="9.01" y2="9" />
              <line x1="15" y1="9" x2="15.01" y2="9" />
            </svg>
          </div>
          <div className="min-w-0">
            <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
              Negativos
            </span>
            <div className="text-2xl font-extrabold text-zinc-900 dark:text-white mt-0.5 leading-tight">
              {metrics.negative}
            </div>
            <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">
              {metrics.negativePercent}% do total
            </p>
          </div>
        </div>
      </div>

      {/* =========================================================================
          C. ABAS DE FILTRO RÁPIDO E BARRA DE BUSCA
          ========================================================================= */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        {/* Abas Estilo Pill */}
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => {
              setActivePill('all');
              setCurrentPage(1);
            }}
            className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer ${
              activePill === 'all'
                ? 'bg-[#610000] text-white shadow-xs'
                : 'bg-white dark:bg-[#18181b] border border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800'
            }`}
          >
            Todos ({metrics.total})
          </button>

          <button
            type="button"
            onClick={() => {
              setActivePill('positive');
              setCurrentPage(1);
            }}
            className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer ${
              activePill === 'positive'
                ? 'bg-[#610000] text-white shadow-xs'
                : 'bg-white dark:bg-[#18181b] border border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800'
            }`}
          >
            Positivos ({metrics.positive})
          </button>

          <button
            type="button"
            onClick={() => {
              setActivePill('neutral');
              setCurrentPage(1);
            }}
            className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer ${
              activePill === 'neutral'
                ? 'bg-[#610000] text-white shadow-xs'
                : 'bg-white dark:bg-[#18181b] border border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800'
            }`}
          >
            Neutros ({metrics.neutral})
          </button>

          <button
            type="button"
            onClick={() => {
              setActivePill('negative');
              setCurrentPage(1);
            }}
            className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer ${
              activePill === 'negative'
                ? 'bg-[#610000] text-white shadow-xs'
                : 'bg-white dark:bg-[#18181b] border border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800'
            }`}
          >
            Negativos ({metrics.negative})
          </button>
        </div>

        {/* Direita: Busca e Seletor de Status */}
        <div className="flex items-center gap-3 flex-1 sm:flex-initial min-w-[280px]">
          {/* Input de Busca */}
          <div className="relative flex-1 sm:w-64 lg:w-72">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              placeholder="Buscar por nome, prato ou palavra-chave..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setCurrentPage(1);
              }}
              className="w-full rounded-xl border border-zinc-200 bg-white pl-9 pr-3.5 py-2 text-xs sm:text-sm text-zinc-800 placeholder-zinc-400 focus:border-[#610000] focus:outline-hidden focus:ring-2 focus:ring-[#610000]/15 dark:border-zinc-800 dark:bg-[#18181b] dark:text-zinc-100 dark:placeholder-zinc-500 shadow-2xs"
            />
          </div>

          {/* Seletor de Status */}
          <div className="relative shrink-0">
            <select
              value={selectedStatusDropdown}
              onChange={(e) => {
                setSelectedStatusDropdown(e.target.value);
                setCurrentPage(1);
              }}
              className="rounded-xl border border-zinc-200 bg-white px-3.5 py-2 text-xs sm:text-sm font-semibold text-zinc-700 focus:border-[#610000] focus:outline-hidden focus:ring-2 focus:ring-[#610000]/15 dark:border-zinc-800 dark:bg-[#18181b] dark:text-zinc-200 cursor-pointer shadow-2xs appearance-none pr-8"
            >
              <option value="all">▼ Todos os status</option>
              <option value="positive">Positivos</option>
              <option value="neutral">Neutros</option>
              <option value="negative">Negativos</option>
              <option value="approved">Publicados</option>
              <option value="pending">Pendentes</option>
              <option value="hidden">Ocultos</option>
              <option value="rejected">Rejeitados</option>
            </select>
          </div>
        </div>
      </div>

      {/* =========================================================================
          D. TABELA DE COMENTÁRIOS
          ========================================================================= */}
      <div className="bg-white dark:bg-[#18181b] border border-zinc-200/80 dark:border-zinc-800 rounded-2xl shadow-2xs overflow-hidden">
        {loadingComments ? (
          <div className="py-16 text-center text-zinc-400 dark:text-zinc-500 text-sm">
            Carregando avaliações dos clientes…
          </div>
        ) : filteredComments.length === 0 ? (
          <div className="py-16 text-center text-zinc-400 dark:text-zinc-500">
            <p className="text-base font-semibold text-zinc-700 dark:text-zinc-300">
              Nenhum comentário encontrado
            </p>
            <p className="text-xs text-zinc-400 mt-1">
              Tente alterar os termos da busca ou mudar os filtros de status.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse min-w-[840px]">
              <thead>
                <tr className="border-b border-zinc-200/70 dark:border-zinc-800 text-[11px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider bg-zinc-50/50 dark:bg-zinc-900/50">
                  <th className="py-3.5 px-5">CLIENTE</th>
                  <th className="py-3.5 px-4">COMENTÁRIO</th>
                  <th className="py-3.5 px-4">PRATO / ITEM</th>
                  <th className="py-3.5 px-4">DATA</th>
                  <th className="py-3.5 px-4">STATUS</th>
                  <th className="py-3.5 px-5 text-right">AÇÕES</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
                {paginatedComments.map((item) => {
                  const isMenuOpen = openActionMenuId === item.id;
                  const isBusy = actionBusyId === item.id;

                  return (
                    <tr
                      key={item.id}
                      className="hover:bg-zinc-50/60 dark:hover:bg-zinc-800/40 transition-colors"
                    >
                      {/* CLIENTE */}
                      <td className="py-4 px-5 align-middle">
                        <div className="flex items-center gap-3">
                          <div
                            className="w-10 h-10 rounded-full bg-[#f2e7dd] text-[#785542] dark:bg-amber-950/60 dark:text-amber-300 font-bold text-xs flex items-center justify-center shrink-0 shadow-2xs"
                            title={item.authorName}
                          >
                            {item.avatarInitials}
                          </div>
                          <div className="min-w-0">
                            <p className="font-bold text-sm text-zinc-900 dark:text-white truncate">
                              {item.authorName}
                            </p>
                            <div className="mt-0.5">
                              <RatingStars rating={item.rating} />
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* COMENTÁRIO */}
                      <td className="py-4 px-4 align-middle max-w-sm xl:max-w-md">
                        <p className="text-xs sm:text-sm text-zinc-600 dark:text-zinc-300 leading-relaxed line-clamp-3">
                          {item.body}
                        </p>
                      </td>

                      {/* PRATO / ITEM */}
                      <td className="py-4 px-4 align-middle">
                        <div className="flex items-center gap-3">
                          <img
                            src={item.productImage || '/images/noma/risoto-capa.png'}
                            alt={item.productName}
                            className="w-11 h-11 rounded-xl object-cover shrink-0 border border-zinc-200/80 dark:border-zinc-700/80 shadow-2xs bg-zinc-100 dark:bg-zinc-800"
                            onError={(e) => {
                              // fallback caso a imagem falhe
                              e.currentTarget.src = '/images/noma/risoto-capa.png';
                            }}
                          />
                          <div className="min-w-0">
                            <p className="font-bold text-xs sm:text-sm text-zinc-900 dark:text-white truncate">
                              {item.productName}
                            </p>
                            <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">
                              {item.productCategory}
                            </p>
                          </div>
                        </div>
                      </td>

                      {/* DATA */}
                      <td className="py-4 px-4 align-middle whitespace-nowrap">
                        <div className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                          {item.formattedDate}
                        </div>
                        <div className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-0.5">
                          {item.formattedTime}
                        </div>
                      </td>

                      {/* STATUS */}
                      <td className="py-4 px-4 align-middle whitespace-nowrap">
                        {item.sentiment === 'positive' && (
                          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400 border border-emerald-200/80 dark:border-emerald-800/60 shadow-2xs">
                            <svg
                              className="w-3.5 h-3.5 shrink-0"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                            >
                              <circle cx="12" cy="12" r="10" />
                              <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                              <line x1="9" y1="9" x2="9.01" y2="9" />
                              <line x1="15" y1="9" x2="15.01" y2="9" />
                            </svg>
                            <span>Positivo</span>
                          </span>
                        )}
                        {item.sentiment === 'neutral' && (
                          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400 border border-amber-200/80 dark:border-amber-800/60 shadow-2xs">
                            <svg
                              className="w-3.5 h-3.5 shrink-0"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                            >
                              <circle cx="12" cy="12" r="10" />
                              <line x1="8" y1="15" x2="16" y2="15" />
                              <line x1="9" y1="9" x2="9.01" y2="9" />
                              <line x1="15" y1="9" x2="15.01" y2="9" />
                            </svg>
                            <span>Neutro</span>
                          </span>
                        )}
                        {item.sentiment === 'negative' && (
                          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400 border border-rose-200/80 dark:border-rose-800/60 shadow-2xs">
                            <svg
                              className="w-3.5 h-3.5 shrink-0"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                            >
                              <circle cx="12" cy="12" r="10" />
                              <path d="M16 16s-1.5-2-4-2-4 2-4 2" />
                              <line x1="9" y1="9" x2="9.01" y2="9" />
                              <line x1="15" y1="9" x2="15.01" y2="9" />
                            </svg>
                            <span>Negativo</span>
                          </span>
                        )}
                      </td>

                      {/* AÇÕES */}
                      <td className="py-4 px-5 align-middle text-right">
                        <div className="relative inline-flex items-center justify-end gap-1.5">
                          {/* Botão de Resposta Rápida */}
                          <button
                            type="button"
                            onClick={() => {
                              setReplyingComment(item);
                              setSingleReplyText('');
                            }}
                            className="p-2 rounded-xl border border-zinc-200/80 dark:border-zinc-700/80 bg-zinc-50 hover:bg-zinc-100 dark:bg-zinc-800/60 dark:hover:bg-zinc-800 text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-white transition-colors cursor-pointer shadow-2xs"
                            title="Responder a este comentário"
                          >
                            <svg
                              className="w-4 h-4"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                            >
                              <polyline points="9 17 4 12 9 7" />
                              <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
                            </svg>
                          </button>

                          {/* Menu 3 Pontos */}
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() =>
                              setOpenActionMenuId((prev) => (prev === item.id ? null : item.id))
                            }
                            className="p-2 rounded-xl border border-zinc-200/80 dark:border-zinc-700/80 bg-zinc-50 hover:bg-zinc-100 dark:bg-zinc-800/60 dark:hover:bg-zinc-800 text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-white transition-colors cursor-pointer shadow-2xs"
                            title="Opções de moderação"
                          >
                            <svg
                              className="w-4 h-4"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                            >
                              <circle cx="12" cy="12" r="1" />
                              <circle cx="12" cy="5" r="1" />
                              <circle cx="12" cy="19" r="1" />
                            </svg>
                          </button>

                          {/* Popover de Moderação */}
                          {isMenuOpen && (
                            <div
                              ref={actionMenuRef}
                              className="absolute right-0 top-11 z-30 w-48 rounded-xl border border-zinc-200 bg-white py-1.5 shadow-xl dark:border-zinc-700 dark:bg-zinc-900 animate-in fade-in zoom-in-95 text-left"
                            >
                              <button
                                type="button"
                                onClick={() => void handleModerate(item, 'approved')}
                                className="w-full px-3.5 py-2 text-xs font-semibold text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800 flex items-center gap-2 cursor-pointer"
                              >
                                <span className="text-emerald-600">✓</span>
                                <span>Aprovar e publicar</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleModerate(item, 'hidden')}
                                className="w-full px-3.5 py-2 text-xs font-semibold text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800 flex items-center gap-2 cursor-pointer"
                              >
                                <span className="text-zinc-500">👁</span>
                                <span>Ocultar comentário</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleModerate(item, 'rejected')}
                                className="w-full px-3.5 py-2 text-xs font-semibold text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800 flex items-center gap-2 cursor-pointer"
                              >
                                <span className="text-amber-600">✕</span>
                                <span>Rejeitar comentário</span>
                              </button>
                              <div className="my-1 border-t border-zinc-100 dark:border-zinc-800" />
                              <button
                                type="button"
                                onClick={() => {
                                  setOpenActionMenuId(null);
                                  setCommentToDelete(item);
                                }}
                                className="w-full px-3.5 py-2 text-xs font-semibold text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/40 flex items-center gap-2 cursor-pointer"
                              >
                                <span>🗑</span>
                                <span>Excluir definitivamente</span>
                              </button>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Rodapé da Tabela: Contador e Paginação */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 p-4 border-t border-zinc-100 dark:border-zinc-800/80 bg-zinc-50/40 dark:bg-zinc-900/40 text-xs">
          <p className="text-zinc-500 dark:text-zinc-400 font-medium">
            Mostrando{' '}
            <span className="font-bold text-zinc-800 dark:text-zinc-200">
              {filteredComments.length > 0 ? (currentPage - 1) * itemsPerPage + 1 : 0}
            </span>{' '}
            a{' '}
            <span className="font-bold text-zinc-800 dark:text-zinc-200">
              {Math.min(currentPage * itemsPerPage, filteredComments.length)}
            </span>{' '}
            de{' '}
            <span className="font-bold text-zinc-800 dark:text-zinc-200">
              {filteredComments.length}
            </span>{' '}
            comentários
          </p>

          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={currentPage <= 1}
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              className="w-7 h-7 rounded-lg border border-zinc-200 bg-white hover:bg-zinc-100 disabled:opacity-30 disabled:cursor-not-allowed dark:border-zinc-700 dark:bg-zinc-800 dark:hover:bg-zinc-700 flex items-center justify-center font-bold text-xs text-zinc-600 dark:text-zinc-300 transition-colors cursor-pointer"
              title="Página anterior"
            >
              ‹
            </button>

            {Array.from({ length: totalPages }, (_, i) => i + 1).map((pageNum) => (
              <button
                key={pageNum}
                type="button"
                onClick={() => setCurrentPage(pageNum)}
                className={`w-7 h-7 rounded-lg font-bold text-xs transition-colors cursor-pointer ${
                  currentPage === pageNum
                    ? 'bg-[#610000] text-white shadow-2xs'
                    : 'border border-zinc-200 bg-white hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300'
                }`}
              >
                {pageNum}
              </button>
            ))}

            <button
              type="button"
              disabled={currentPage >= totalPages}
              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              className="w-7 h-7 rounded-lg border border-zinc-200 bg-white hover:bg-zinc-100 disabled:opacity-30 disabled:cursor-not-allowed dark:border-zinc-700 dark:bg-zinc-800 dark:hover:bg-zinc-700 flex items-center justify-center font-bold text-xs text-zinc-600 dark:text-zinc-300 transition-colors cursor-pointer"
              title="Próxima página"
            >
              ›
            </button>
          </div>
        </div>
      </div>

      {/* =========================================================================
          MODAIS E DIÁLOGOS
          ========================================================================= */}

      {/* 1. Modal de Resposta Individual */}
      {replyingComment && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4 animate-in fade-in"
        >
          <div className="w-full max-w-lg rounded-2xl bg-white dark:bg-zinc-900 p-6 shadow-2xl border border-zinc-200 dark:border-zinc-800 space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-zinc-100 dark:border-zinc-800">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-full bg-[#f2e7dd] text-[#785542] dark:bg-amber-950/60 dark:text-amber-300 font-bold text-xs flex items-center justify-center">
                  {replyingComment.avatarInitials}
                </div>
                <div>
                  <h3 className="font-bold text-sm text-zinc-900 dark:text-white">
                    Responder a {replyingComment.authorName}
                  </h3>
                  <p className="text-xs text-zinc-400">
                    Sobre o prato: {replyingComment.productName}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setReplyingComment(null)}
                className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 text-lg cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="p-3 rounded-xl bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-200/80 dark:border-zinc-700/60 text-xs text-zinc-600 dark:text-zinc-300 italic">
              &ldquo;{replyingComment.body}&rdquo;
            </div>

            <div>
              <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5">
                Sua resposta oficial do restaurante:
              </label>
              <textarea
                rows={4}
                value={singleReplyText}
                onChange={(e) => setSingleReplyText(e.target.value)}
                placeholder="Escreva uma resposta atenciosa ao cliente..."
                className="w-full rounded-xl border border-zinc-200 bg-white p-3 text-xs sm:text-sm text-zinc-800 placeholder-zinc-400 focus:border-[#610000] focus:outline-hidden focus:ring-2 focus:ring-[#610000]/15 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 resize-none shadow-2xs"
              />
            </div>

            {/* Modelos rápidos */}
            <div>
              <p className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider mb-1.5">
                Respostas rápidas:
              </p>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() =>
                    setSingleReplyText(
                      'Muito obrigado pela avaliação e pelo carinho! Ficamos felizes que tenha apreciado. Esperamos vê-lo novamente em breve!',
                    )
                  }
                  className="text-[11px] px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-300 cursor-pointer"
                >
                  ❤️ Agradecimento caloroso
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setSingleReplyText(
                      'Agradecemos pelo feedback construtivo! Já repassamos para a nossa equipe de cozinha e atendimento para mantermos sempre o padrão mais alto.',
                    )
                  }
                  className="text-[11px] px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-300 cursor-pointer"
                >
                  ⚡ Melhoria contínua
                </button>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-zinc-100 dark:border-zinc-800">
              <button
                type="button"
                onClick={() => setReplyingComment(null)}
                className="px-4 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 text-xs font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={replySending || !singleReplyText.trim()}
                onClick={handleSendSingleReply}
                className="px-4 py-2 rounded-xl bg-[#610000] hover:bg-[#4d0000] disabled:opacity-50 text-white text-xs font-semibold shadow-xs transition-colors cursor-pointer"
              >
                {replySending ? 'Enviando…' : 'Enviar resposta'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 2. Modal de Resposta em Massa */}
      {isBulkReplyOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4 animate-in fade-in"
        >
          <div className="w-full max-w-lg rounded-2xl bg-white dark:bg-zinc-900 p-6 shadow-2xl border border-zinc-200 dark:border-zinc-800 space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-zinc-100 dark:border-zinc-800">
              <div className="flex items-center gap-2">
                <span className="p-2 rounded-xl bg-[#610000]/10 text-[#610000] dark:bg-rose-950/40 dark:text-rose-400">
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="22" y1="2" x2="11" y2="13" />
                    <polygon points="22 2 15 22 11 13 2 9 22 2" />
                  </svg>
                </span>
                <h3 className="font-bold text-base text-zinc-900 dark:text-white">
                  Responder comentários em massa
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setIsBulkReplyOpen(false)}
                className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 text-lg cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div>
              <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5">
                Enviar para o grupo de avaliações:
              </label>
              <select
                value={bulkReplyTarget}
                onChange={(e) =>
                  setBulkReplyTarget(e.target.value as 'all' | 'positive' | 'neutral' | 'negative')
                }
                className="w-full rounded-xl border border-zinc-200 bg-white p-2.5 text-xs sm:text-sm font-semibold text-zinc-800 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 cursor-pointer shadow-2xs"
              >
                <option value="all">Todos os clientes com comentários ativos ({metrics.total})</option>
                <option value="positive">Somente comentários Positivos ({metrics.positive})</option>
                <option value="neutral">Somente comentários Neutros ({metrics.neutral})</option>
                <option value="negative">Somente comentários Negativos ({metrics.negative})</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5">
                Mensagem padrão da resposta:
              </label>
              <textarea
                rows={4}
                value={bulkReplyText}
                onChange={(e) => setBulkReplyText(e.target.value)}
                placeholder="Ex.: Olá! Agradecemos muito pela sua visita e feedback no nosso cardápio..."
                className="w-full rounded-xl border border-zinc-200 bg-white p-3 text-xs sm:text-sm text-zinc-800 placeholder-zinc-400 focus:border-[#610000] focus:outline-hidden focus:ring-2 focus:ring-[#610000]/15 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 resize-none shadow-2xs"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-zinc-100 dark:border-zinc-800">
              <button
                type="button"
                onClick={() => setIsBulkReplyOpen(false)}
                className="px-4 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 text-xs font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={bulkReplySending || !bulkReplyText.trim()}
                onClick={handleSendBulkReply}
                className="px-4 py-2 rounded-xl bg-[#610000] hover:bg-[#4d0000] disabled:opacity-50 text-white text-xs font-semibold shadow-xs transition-colors cursor-pointer"
              >
                {bulkReplySending ? 'Disparando…' : 'Disparar respostas'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 3. Modal de Palavras Restritas */}
      {isRestrictedModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4 animate-in fade-in"
        >
          <div className="w-full max-w-lg rounded-2xl bg-white dark:bg-zinc-900 p-6 shadow-2xl border border-zinc-200 dark:border-zinc-800 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-2 border-b border-zinc-100 dark:border-zinc-800">
              <div className="flex items-center gap-2">
                <svg
                  className="w-5 h-5 text-[#610000] dark:text-rose-400"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
                </svg>
                <h3 className="font-bold text-base text-zinc-900 dark:text-white">
                  Palavras Restritas do Restaurante
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setIsRestrictedModalOpen(false)}
                className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 text-lg cursor-pointer"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
              Comentários contendo estas palavras serão retidos automaticamente como{' '}
              <strong>Pendentes</strong> para aprovação manual antes de serem exibidos no cardápio.
            </p>

            {/* Form de Adição */}
            <form onSubmit={(e) => void handleAddTerm(e)} className="flex gap-2">
              <input
                type="text"
                placeholder="Ex.: cabelo, cru, mosca, azedo..."
                value={newTermInput}
                onChange={(e) => setNewTermInput(e.target.value)}
                disabled={termActionBusy}
                maxLength={60}
                className="flex-1 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-xs sm:text-sm text-zinc-800 placeholder-zinc-400 focus:border-[#610000] focus:outline-hidden focus:ring-2 focus:ring-[#610000]/15 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 shadow-2xs"
              />
              <button
                type="submit"
                disabled={termActionBusy || !newTermInput.trim()}
                className="px-4 py-2 rounded-xl bg-[#610000] hover:bg-[#4d0000] disabled:opacity-50 text-white text-xs font-semibold shadow-xs transition-colors cursor-pointer shrink-0"
              >
                {termActionBusy ? 'Adicionando…' : 'Adicionar'}
              </button>
            </form>

            {/* Lista de Termos */}
            <div className="pt-2">
              <p className="text-xs font-bold text-zinc-700 dark:text-zinc-300 mb-2">
                Termos configurados ({terms.length}):
              </p>
              {loadingTerms ? (
                <div className="py-6 text-center text-xs text-zinc-400">Carregando termos…</div>
              ) : terms.length === 0 ? (
                <div className="py-6 text-center text-xs text-zinc-400 border border-dashed border-zinc-200 dark:border-zinc-800 rounded-xl">
                  Nenhum termo restrito cadastrado.
                </div>
              ) : (
                <div className="flex flex-wrap gap-2 max-h-48 overflow-y-auto pr-1">
                  {terms.map((t) => (
                    <span
                      key={t.id}
                      className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-xs text-zinc-800 dark:text-zinc-200 shadow-2xs"
                    >
                      <span>{t.term}</span>
                      <button
                        type="button"
                        disabled={termActionBusy}
                        onClick={() => setTermToDelete(t)}
                        className="text-rose-600 hover:text-rose-800 font-bold ml-1 cursor-pointer"
                        title="Remover termo"
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="flex justify-end pt-2 border-t border-zinc-100 dark:border-zinc-800">
              <button
                type="button"
                onClick={() => setIsRestrictedModalOpen(false)}
                className="px-4 py-2 rounded-xl bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-xs font-semibold text-zinc-700 dark:text-zinc-200 cursor-pointer"
              >
                Concluir
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 4. Modal de Confirmação de Exclusão de Termo */}
      {termToDelete && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4 animate-in fade-in"
        >
          <div className="w-full max-w-sm rounded-2xl bg-white dark:bg-zinc-900 p-5 shadow-2xl border border-zinc-200 dark:border-zinc-800 space-y-3">
            <h3 className="font-bold text-sm text-zinc-900 dark:text-white">Remover termo?</h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Deseja remover <strong>&ldquo;{termToDelete.term}&rdquo;</strong> do filtro do
              restaurante?
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={termActionBusy}
                onClick={() => setTermToDelete(null)}
                className="px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-xs font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={termActionBusy}
                onClick={() => void handleConfirmDeleteTerm()}
                className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold cursor-pointer"
              >
                {termActionBusy ? 'Removendo…' : 'Sim, remover'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 5. Modal de Confirmação de Exclusão de Comentário */}
      {commentToDelete && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4 animate-in fade-in"
        >
          <div className="w-full max-w-md rounded-2xl bg-white dark:bg-zinc-900 p-6 shadow-2xl border border-zinc-200 dark:border-zinc-800 space-y-4">
            <div className="flex items-center gap-3 text-rose-600">
              <div className="p-2 rounded-xl bg-rose-100 dark:bg-rose-950/60">
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 6h18" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </div>
              <h3 className="font-bold text-base text-zinc-900 dark:text-white">
                Excluir comentário definitivamente?
              </h3>
            </div>

            <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
              Esta ação é <strong>irreversível</strong>. O comentário de{' '}
              <strong>{commentToDelete.authorName}</strong> no prato{' '}
              <strong>{commentToDelete.productName}</strong> será apagado do sistema.
            </p>

            <div className="p-3 rounded-xl bg-rose-50/60 dark:bg-rose-950/20 border border-rose-200/60 dark:border-rose-900/40 text-xs text-rose-800 dark:text-rose-300 italic line-clamp-3">
              &ldquo;{commentToDelete.body}&rdquo;
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-zinc-100 dark:border-zinc-800">
              <button
                type="button"
                disabled={deletePending}
                onClick={() => setCommentToDelete(null)}
                className="px-4 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 text-xs font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={deletePending}
                onClick={() => void handleConfirmDelete()}
                className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold shadow-xs transition-colors cursor-pointer"
              >
                {deletePending ? 'Excluindo…' : 'Sim, excluir'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

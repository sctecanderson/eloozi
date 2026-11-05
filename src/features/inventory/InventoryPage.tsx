import { useState, useEffect, useMemo, useRef } from 'react';
import { useRestaurant } from '../restaurants/RestaurantProvider';
import { supabase } from '../../lib/supabase';
import {
  fetchInventory,
  createInventoryItem,
  updateInventoryItem,
  updateStockQuantity,
  deleteInventoryItem,
  subscribeToInventory,
  type InventoryItem,
  type InventoryItemInput,
  type UnitMeasure,
} from './inventoryService';

type FilterType = 'all' | 'alert' | 'out_of_stock';
type SortType = 'recent' | 'name_asc' | 'stock_asc' | 'stock_desc';

interface CategoryBadgeStyle {
  bg: string;
  text: string;
  border: string;
  dot: string;
}

const PRESET_CATEGORY_COLORS: Record<string, CategoryBadgeStyle> = {
  padaria: { bg: 'bg-amber-50 dark:bg-amber-950/40', text: 'text-amber-800 dark:text-amber-300', border: 'border-amber-300/80 dark:border-amber-800/60', dot: 'bg-amber-500' },
  pao: { bg: 'bg-amber-50 dark:bg-amber-950/40', text: 'text-amber-800 dark:text-amber-300', border: 'border-amber-300/80 dark:border-amber-800/60', dot: 'bg-amber-500' },
  paes: { bg: 'bg-amber-50 dark:bg-amber-950/40', text: 'text-amber-800 dark:text-amber-300', border: 'border-amber-300/80 dark:border-amber-800/60', dot: 'bg-amber-500' },
  hortifruti: { bg: 'bg-emerald-50 dark:bg-emerald-950/40', text: 'text-emerald-800 dark:text-emerald-300', border: 'border-emerald-300/80 dark:border-emerald-800/60', dot: 'bg-emerald-500' },
  legumes: { bg: 'bg-emerald-50 dark:bg-emerald-950/40', text: 'text-emerald-800 dark:text-emerald-300', border: 'border-emerald-300/80 dark:border-emerald-800/60', dot: 'bg-emerald-500' },
  verduras: { bg: 'bg-green-50 dark:bg-green-950/40', text: 'text-green-800 dark:text-green-300', border: 'border-green-300/80 dark:border-green-800/60', dot: 'bg-green-500' },
  salada: { bg: 'bg-green-50 dark:bg-green-950/40', text: 'text-green-800 dark:text-green-300', border: 'border-green-300/80 dark:border-green-800/60', dot: 'bg-green-500' },
  bebidas: { bg: 'bg-sky-50 dark:bg-sky-950/40', text: 'text-sky-800 dark:text-sky-300', border: 'border-sky-300/80 dark:border-sky-800/60', dot: 'bg-sky-500' },
  bar: { bg: 'bg-cyan-50 dark:bg-cyan-950/40', text: 'text-cyan-800 dark:text-cyan-300', border: 'border-cyan-300/80 dark:border-cyan-800/60', dot: 'bg-cyan-500' },
  carnes: { bg: 'bg-red-50 dark:bg-red-950/40', text: 'text-red-800 dark:text-red-300', border: 'border-red-300/80 dark:border-red-800/60', dot: 'bg-red-500' },
  acougue: { bg: 'bg-red-50 dark:bg-red-950/40', text: 'text-red-800 dark:text-red-300', border: 'border-red-300/80 dark:border-red-800/60', dot: 'bg-red-500' },
  frios: { bg: 'bg-yellow-50 dark:bg-yellow-950/40', text: 'text-yellow-800 dark:text-yellow-300', border: 'border-yellow-300/80 dark:border-yellow-800/60', dot: 'bg-yellow-500' },
  laticinios: { bg: 'bg-indigo-50 dark:bg-indigo-950/40', text: 'text-indigo-800 dark:text-indigo-300', border: 'border-indigo-300/80 dark:border-indigo-800/60', dot: 'bg-indigo-500' },
  mercearia: { bg: 'bg-orange-50 dark:bg-orange-950/40', text: 'text-orange-800 dark:text-orange-300', border: 'border-orange-300/80 dark:border-orange-800/60', dot: 'bg-orange-500' },
  sobremesas: { bg: 'bg-pink-50 dark:bg-pink-950/40', text: 'text-pink-800 dark:text-pink-300', border: 'border-pink-300/80 dark:border-pink-800/60', dot: 'bg-pink-500' },
  doces: { bg: 'bg-fuchsia-50 dark:bg-fuchsia-950/40', text: 'text-fuchsia-800 dark:text-fuchsia-300', border: 'border-fuchsia-300/80 dark:border-fuchsia-800/60', dot: 'bg-fuchsia-500' },
  embalagens: { bg: 'bg-purple-50 dark:bg-purple-950/40', text: 'text-purple-800 dark:text-purple-300', border: 'border-purple-300/80 dark:border-purple-800/60', dot: 'bg-purple-500' },
  limpeza: { bg: 'bg-teal-50 dark:bg-teal-950/40', text: 'text-teal-800 dark:text-teal-300', border: 'border-teal-300/80 dark:border-teal-800/60', dot: 'bg-teal-500' },
  temperos: { bg: 'bg-lime-50 dark:bg-lime-950/40', text: 'text-lime-800 dark:text-lime-300', border: 'border-lime-300/80 dark:border-lime-800/60', dot: 'bg-lime-500' },
  molhos: { bg: 'bg-rose-50 dark:bg-rose-950/40', text: 'text-rose-800 dark:text-rose-300', border: 'border-rose-300/80 dark:border-rose-800/60', dot: 'bg-rose-500' },
  insumos: { bg: 'bg-violet-50 dark:bg-violet-950/40', text: 'text-violet-800 dark:text-violet-300', border: 'border-violet-300/80 dark:border-violet-800/60', dot: 'bg-violet-500' },
};

const DYNAMIC_PALETTES: CategoryBadgeStyle[] = [
  { bg: 'bg-blue-50 dark:bg-blue-950/40', text: 'text-blue-800 dark:text-blue-300', border: 'border-blue-300/80 dark:border-blue-800/60', dot: 'bg-blue-500' },
  { bg: 'bg-purple-50 dark:bg-purple-950/40', text: 'text-purple-800 dark:text-purple-300', border: 'border-purple-300/80 dark:border-purple-800/60', dot: 'bg-purple-500' },
  { bg: 'bg-amber-50 dark:bg-amber-950/40', text: 'text-amber-800 dark:text-amber-300', border: 'border-amber-300/80 dark:border-amber-800/60', dot: 'bg-amber-500' },
  { bg: 'bg-emerald-50 dark:bg-emerald-950/40', text: 'text-emerald-800 dark:text-emerald-300', border: 'border-emerald-300/80 dark:border-emerald-800/60', dot: 'bg-emerald-500' },
  { bg: 'bg-rose-50 dark:bg-rose-950/40', text: 'text-rose-800 dark:text-rose-300', border: 'border-rose-300/80 dark:border-rose-800/60', dot: 'bg-rose-500' },
  { bg: 'bg-teal-50 dark:bg-teal-950/40', text: 'text-teal-800 dark:text-teal-300', border: 'border-teal-300/80 dark:border-teal-800/60', dot: 'bg-teal-500' },
  { bg: 'bg-indigo-50 dark:bg-indigo-950/40', text: 'text-indigo-800 dark:text-indigo-300', border: 'border-indigo-300/80 dark:border-indigo-800/60', dot: 'bg-indigo-500' },
  { bg: 'bg-orange-50 dark:bg-orange-950/40', text: 'text-orange-800 dark:text-orange-300', border: 'border-orange-300/80 dark:border-orange-800/60', dot: 'bg-orange-500' },
];

function getCategoryBadgeStyle(category: string): CategoryBadgeStyle {
  const norm = (category || 'geral').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  if (PRESET_CATEGORY_COLORS[norm]) {
    return PRESET_CATEGORY_COLORS[norm];
  }
  let hash = 0;
  for (let i = 0; i < norm.length; i++) {
    hash = norm.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % DYNAMIC_PALETTES.length;
  return DYNAMIC_PALETTES[index];
}

const INGREDIENT_IMAGES: Record<string, string> = {
  alface: 'https://images.unsplash.com/photo-1540420773420-3366772f4999?w=100&auto=format&fit=crop&q=80',
  salada: 'https://images.unsplash.com/photo-1540420773420-3366772f4999?w=100&auto=format&fit=crop&q=80',
  tomate: 'https://images.unsplash.com/photo-1546094096-0df4bcaaa337?w=100&auto=format&fit=crop&q=80',
  cebola: 'https://images.unsplash.com/photo-1618512496248-a07fe83aa8cb?w=100&auto=format&fit=crop&q=80',
  pao: 'https://images.unsplash.com/photo-1509440159596-0249088772ff?w=100&auto=format&fit=crop&q=80',
  pão: 'https://images.unsplash.com/photo-1509440159596-0249088772ff?w=100&auto=format&fit=crop&q=80',
  queijo: 'https://images.unsplash.com/photo-1486297678162-eb2a19b0a32d?w=100&auto=format&fit=crop&q=80',
  carne: 'https://images.unsplash.com/photo-1603048588665-791ca8aea617?w=100&auto=format&fit=crop&q=80',
  bife: 'https://images.unsplash.com/photo-1603048588665-791ca8aea617?w=100&auto=format&fit=crop&q=80',
  hamburguer: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=100&auto=format&fit=crop&q=80',
  hambúrguer: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=100&auto=format&fit=crop&q=80',
  frango: 'https://images.unsplash.com/photo-1587593810167-a84920ea0781?w=100&auto=format&fit=crop&q=80',
  bacon: 'https://images.unsplash.com/photo-1528607929212-2636ec44253e?w=100&auto=format&fit=crop&q=80',
  batata: 'https://images.unsplash.com/photo-1518977676601-b53f82aba655?w=100&auto=format&fit=crop&q=80',
  arroz: 'https://images.unsplash.com/photo-1586201375761-83865001e31c?w=100&auto=format&fit=crop&q=80',
  feijao: 'https://images.unsplash.com/photo-1551462147-ff29053bfc14?w=100&auto=format&fit=crop&q=80',
  feijão: 'https://images.unsplash.com/photo-1551462147-ff29053bfc14?w=100&auto=format&fit=crop&q=80',
  ovo: 'https://images.unsplash.com/photo-1582722872445-44dc5f7e3c8f?w=100&auto=format&fit=crop&q=80',
  ovos: 'https://images.unsplash.com/photo-1582722872445-44dc5f7e3c8f?w=100&auto=format&fit=crop&q=80',
  leite: 'https://images.unsplash.com/photo-1550583724-b2692b85b150?w=100&auto=format&fit=crop&q=80',
  cafe: 'https://images.unsplash.com/photo-1514432324607-a09d9b4aefdd?w=100&auto=format&fit=crop&q=80',
  café: 'https://images.unsplash.com/photo-1514432324607-a09d9b4aefdd?w=100&auto=format&fit=crop&q=80',
  cerveja: 'https://images.unsplash.com/photo-1608270586620-248524c67de9?w=100&auto=format&fit=crop&q=80',
  refrigerante: 'https://images.unsplash.com/photo-1551024709-8f23befc6f87?w=100&auto=format&fit=crop&q=80',
  coca: 'https://images.unsplash.com/photo-1554866585-cd94860890b7?w=100&auto=format&fit=crop&q=80',
  suco: 'https://images.unsplash.com/photo-1613478223719-2ab802602423?w=100&auto=format&fit=crop&q=80',
  vinho: 'https://images.unsplash.com/photo-1510812431401-41d2bd2722f3?w=100&auto=format&fit=crop&q=80',
  peixe: 'https://images.unsplash.com/photo-1519708227418-c8fd9a32b7a2?w=100&auto=format&fit=crop&q=80',
  salmao: 'https://images.unsplash.com/photo-1519708227418-c8fd9a32b7a2?w=100&auto=format&fit=crop&q=80',
  salmão: 'https://images.unsplash.com/photo-1519708227418-c8fd9a32b7a2?w=100&auto=format&fit=crop&q=80',
  molho: 'https://images.unsplash.com/photo-1472476443507-c7a5948772fc?w=100&auto=format&fit=crop&q=80',
  maionese: 'https://images.unsplash.com/photo-1472476443507-c7a5948772fc?w=100&auto=format&fit=crop&q=80',
  ketchup: 'https://images.unsplash.com/photo-1472476443507-c7a5948772fc?w=100&auto=format&fit=crop&q=80',
  oleo: 'https://images.unsplash.com/photo-1474979266404-7eaacbcd87c5?w=100&auto=format&fit=crop&q=80',
  óleo: 'https://images.unsplash.com/photo-1474979266404-7eaacbcd87c5?w=100&auto=format&fit=crop&q=80',
  azeite: 'https://images.unsplash.com/photo-1474979266404-7eaacbcd87c5?w=100&auto=format&fit=crop&q=80',
  manteiga: 'https://images.unsplash.com/photo-1589985270826-4b7bb135bc9d?w=100&auto=format&fit=crop&q=80',
  acucar: 'https://images.unsplash.com/photo-1581441363689-1f3c3c414635?w=100&auto=format&fit=crop&q=80',
  açúcar: 'https://images.unsplash.com/photo-1581441363689-1f3c3c414635?w=100&auto=format&fit=crop&q=80',
  sal: 'https://images.unsplash.com/photo-1518110925495-5fe2fda0442c?w=100&auto=format&fit=crop&q=80',
  chocolate: 'https://images.unsplash.com/photo-1511381939415-e44015466834?w=100&auto=format&fit=crop&q=80',
  farinha: 'https://images.unsplash.com/photo-1509440159596-0249088772ff?w=100&auto=format&fit=crop&q=80',
  massa: 'https://images.unsplash.com/photo-1551183053-bf91a1d81141?w=100&auto=format&fit=crop&q=80',
  macarrao: 'https://images.unsplash.com/photo-1551183053-bf91a1d81141?w=100&auto=format&fit=crop&q=80',
  macarrão: 'https://images.unsplash.com/photo-1551183053-bf91a1d81141?w=100&auto=format&fit=crop&q=80',
};

const PRESET_GALLERY_PHOTOS = [
  { label: 'Tomate', url: INGREDIENT_IMAGES.tomate },
  { label: 'Alface', url: INGREDIENT_IMAGES.alface },
  { label: 'Pão', url: INGREDIENT_IMAGES.pao },
  { label: 'Queijo', url: INGREDIENT_IMAGES.queijo },
  { label: 'Carne', url: INGREDIENT_IMAGES.carne },
  { label: 'Hambúrguer', url: INGREDIENT_IMAGES.hamburguer },
  { label: 'Frango', url: INGREDIENT_IMAGES.frango },
  { label: 'Bacon', url: INGREDIENT_IMAGES.bacon },
  { label: 'Batata', url: INGREDIENT_IMAGES.batata },
  { label: 'Cebola', url: INGREDIENT_IMAGES.cebola },
  { label: 'Ovos', url: INGREDIENT_IMAGES.ovo },
  { label: 'Leite', url: INGREDIENT_IMAGES.leite },
  { label: 'Café', url: INGREDIENT_IMAGES.cafe },
  { label: 'Cerveja', url: INGREDIENT_IMAGES.cerveja },
  { label: 'Refrigerante', url: INGREDIENT_IMAGES.refrigerante },
  { label: 'Molho', url: INGREDIENT_IMAGES.molho },
  { label: 'Azeite', url: INGREDIENT_IMAGES.azeite },
  { label: 'Chocolate', url: INGREDIENT_IMAGES.chocolate },
];

function getItemPhoto(item: InventoryItem, customMap: Record<string, string>): string | null {
  if (customMap[item.id]) {
    return customMap[item.id];
  }
  const normalized = (item.name + ' ' + item.category)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  for (const [key, url] of Object.entries(INGREDIENT_IMAGES)) {
    const keyNorm = key.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (normalized.includes(keyNorm)) {
      return url;
    }
  }
  return null;
}

export function InventoryPage() {
  const { restaurant } = useRestaurant();
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Mapeamento de imagens customizadas (salvo em localStorage por restaurante)
  const [customImages, setCustomImages] = useState<Record<string, string>>(() => {
    try {
      const raw = localStorage.getItem(`elozi_inventory_images_${restaurant.id}`);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });

  // Filtros, Busca e Ordenação
  const [activeFilter, setActiveFilter] = useState<FilterType>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [selectedStatus, setSelectedStatus] = useState<string>('all');
  const [sortBy, setSortBy] = useState<SortType>('recent');

  // Paginação
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;

  // Modais de Insumo
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<InventoryItem | null>(null);
  const [itemForm, setItemForm] = useState<InventoryItemInput>({
    name: '',
    category: 'Geral',
    unit_measure: 'un',
    current_quantity: 0,
    alert_threshold: 5,
  });
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Modal de Alteração Rápida de Imagem (ao clicar na foto do insumo)
  const [isImageModalOpen, setIsImageModalOpen] = useState(false);
  const [selectedImageItem, setSelectedImageItem] = useState<InventoryItem | null>(null);
  const [tempImageUrl, setTempImageUrl] = useState('');
  const [imageUploadBusy, setImageUploadBusy] = useState(false);
  const [imageUploadError, setImageUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Modal Baixar Estoque
  const [isQuickConsumeOpen, setIsQuickConsumeOpen] = useState(false);
  const [consumeItemId, setConsumeItemId] = useState<string>('');
  const [consumeQty, setConsumeQty] = useState<number>(1);
  const [consumeError, setConsumeError] = useState<string | null>(null);
  const [consumeBusy, setConsumeBusy] = useState(false);

  // Modal Histórico
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);

  // Confirmação de exclusão
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadData = async () => {
    try {
      setError(null);
      const data = await fetchInventory(restaurant.id);
      setItems(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao carregar estoque.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
    const unsubscribe = subscribeToInventory(restaurant.id, () => {
      void loadData();
    });
    return () => {
      unsubscribe();
    };
  }, [restaurant.id]);

  // Contagens para os cards de métricas
  const metrics = useMemo(() => {
    const total = items.length;
    const outOfStock = items.filter((i) => i.current_quantity === 0).length;
    const inAlert = items.filter((i) => i.current_quantity > 0 && i.current_quantity <= i.alert_threshold).length;
    const healthy = items.filter((i) => i.current_quantity > i.alert_threshold).length;
    return { total, outOfStock, inAlert, healthy };
  }, [items]);

  // Lista única de categorias para o seletor
  const uniqueCategories = useMemo(() => {
    const set = new Set<string>();
    items.forEach((item) => {
      if (item.category && item.category.trim()) {
        set.add(item.category.trim());
      }
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [items]);

  // Itens em alerta ou esgotados para o painel lateral
  const alertItems = useMemo(() => {
    return items.filter((i) => i.current_quantity <= i.alert_threshold);
  }, [items]);

  // Filtragem dos itens
  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      // 1. Busca textual
      const q = searchQuery.toLowerCase().trim();
      if (q) {
        const matchesName = item.name.toLowerCase().includes(q);
        const matchesCategory = item.category.toLowerCase().includes(q);
        if (!matchesName && !matchesCategory) return false;
      }

      // 2. Categoria
      if (selectedCategory !== 'all') {
        if (item.category.toLowerCase() !== selectedCategory.toLowerCase()) return false;
      }

      // 3. Status select dropdown
      if (selectedStatus === 'alert') {
        if (!(item.current_quantity > 0 && item.current_quantity <= item.alert_threshold)) return false;
      } else if (selectedStatus === 'out_of_stock') {
        if (item.current_quantity !== 0) return false;
      } else if (selectedStatus === 'healthy') {
        if (!(item.current_quantity > item.alert_threshold)) return false;
      }

      // 4. Abas de filtro rápido
      if (activeFilter === 'alert') {
        return item.current_quantity > 0 && item.current_quantity <= item.alert_threshold;
      }
      if (activeFilter === 'out_of_stock') {
        return item.current_quantity === 0;
      }

      return true;
    });
  }, [items, searchQuery, selectedCategory, selectedStatus, activeFilter]);

  // Ordenação
  const sortedItems = useMemo(() => {
    const list = [...filteredItems];
    if (sortBy === 'name_asc') {
      return list.sort((a, b) => a.name.localeCompare(b.name));
    }
    if (sortBy === 'stock_asc') {
      return list.sort((a, b) => a.current_quantity - b.current_quantity);
    }
    if (sortBy === 'stock_desc') {
      return list.sort((a, b) => b.current_quantity - a.current_quantity);
    }
    return list.sort((a, b) => {
      const dateA = a.created_at ? new Date(a.created_at).getTime() : 0;
      const dateB = b.created_at ? new Date(b.created_at).getTime() : 0;
      return dateB - dateA;
    });
  }, [filteredItems, sortBy]);

  // Resetar página quando filtros mudarem
  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, selectedCategory, selectedStatus, activeFilter, sortBy]);

  // Paginação
  const totalPages = Math.max(1, Math.ceil(sortedItems.length / itemsPerPage));
  const paginatedItems = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    return sortedItems.slice(start, start + itemsPerPage);
  }, [sortedItems, currentPage, itemsPerPage]);

  const handleOpenCreateModal = () => {
    setEditingItem(null);
    setItemForm({
      name: '',
      category: 'Geral',
      unit_measure: 'un',
      current_quantity: 0,
      alert_threshold: 5,
    });
    setFormError(null);
    setIsModalOpen(true);
  };

  const handleOpenEditModal = (item: InventoryItem) => {
    setEditingItem(item);
    setItemForm({
      name: item.name,
      category: item.category,
      unit_measure: item.unit_measure,
      current_quantity: item.current_quantity,
      alert_threshold: item.alert_threshold,
    });
    setFormError(null);
    setIsModalOpen(true);
  };

  const handleSaveItem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!itemForm.name.trim()) {
      setFormError('Informe o nome do item.');
      return;
    }
    setFormBusy(true);
    setFormError(null);
    try {
      if (editingItem) {
        await updateInventoryItem(editingItem.id, itemForm);
      } else {
        await createInventoryItem(restaurant.id, itemForm);
      }
      setIsModalOpen(false);
      await loadData();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Falha ao salvar item.');
    } finally {
      setFormBusy(false);
    }
  };

  const handleQuickAdjust = async (item: InventoryItem, delta: number) => {
    const nextVal = Math.max(0, item.current_quantity + delta);
    try {
      setItems((prev) =>
        prev.map((i) => (i.id === item.id ? { ...i, current_quantity: nextVal } : i))
      );
      await updateStockQuantity(item.id, nextVal);
    } catch (err) {
      console.error('Falha ao ajustar estoque:', err);
      void loadData();
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Tem certeza de que deseja remover este item do estoque?')) return;
    setDeletingId(id);
    try {
      await deleteInventoryItem(id);
      setItems((prev) => prev.filter((i) => i.id !== id));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Erro ao excluir item.');
    } finally {
      setDeletingId(null);
    }
  };

  // Upload e seleção de foto do insumo
  const handleOpenImageModal = (item: InventoryItem) => {
    setSelectedImageItem(item);
    setTempImageUrl(customImages[item.id] || getItemPhoto(item, customImages) || '');
    setImageUploadError(null);
    setIsImageModalOpen(true);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedImageItem) return;

    if (!file.type.startsWith('image/')) {
      setImageUploadError('Selecione um arquivo de imagem válido (PNG, JPG, WEBP).');
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      setImageUploadError('A imagem deve ter no máximo 5MB.');
      return;
    }

    setImageUploadBusy(true);
    setImageUploadError(null);

    try {
      const ext = file.name.split('.').pop() || 'webp';
      const storagePath = `${restaurant.id}/inventory/${selectedImageItem.id}_${Date.now()}.${ext}`;
      const { error: uploadErr } = await supabase.storage
        .from('menu-images')
        .upload(storagePath, file, { contentType: file.type, upsert: true });

      if (!uploadErr) {
        const { data } = supabase.storage.from('menu-images').getPublicUrl(storagePath);
        setTempImageUrl(data.publicUrl);
      } else {
        const reader = new FileReader();
        reader.onload = (event) => {
          if (event.target?.result) {
            setTempImageUrl(event.target.result as string);
          }
        };
        reader.readAsDataURL(file);
      }
    } catch {
      const reader = new FileReader();
      reader.onload = (event) => {
        if (event.target?.result) {
          setTempImageUrl(event.target.result as string);
        }
      };
      reader.readAsDataURL(file);
    } finally {
      setImageUploadBusy(false);
    }
  };

  const handleSaveCustomImage = () => {
    if (!selectedImageItem) return;
    const nextMap = { ...customImages };
    if (tempImageUrl.trim()) {
      nextMap[selectedImageItem.id] = tempImageUrl.trim();
    } else {
      delete nextMap[selectedImageItem.id];
    }
    setCustomImages(nextMap);
    try {
      localStorage.setItem(`elozi_inventory_images_${restaurant.id}`, JSON.stringify(nextMap));
    } catch (e) {
      console.warn('Falha ao persistir foto localmente:', e);
    }
    setIsImageModalOpen(false);
  };

  const handleRemoveCustomImage = () => {
    if (!selectedImageItem) return;
    const nextMap = { ...customImages };
    delete nextMap[selectedImageItem.id];
    setCustomImages(nextMap);
    try {
      localStorage.setItem(`elozi_inventory_images_${restaurant.id}`, JSON.stringify(nextMap));
    } catch (e) {
      console.warn('Falha ao persistir foto localmente:', e);
    }
    setIsImageModalOpen(false);
  };

  // Baixa rápida de estoque
  const handleConfirmQuickConsume = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!consumeItemId) {
      setConsumeError('Selecione um insumo.');
      return;
    }
    const target = items.find((i) => i.id === consumeItemId);
    if (!target) return;

    if (consumeQty <= 0) {
      setConsumeError('A quantidade para baixar deve ser maior que zero.');
      return;
    }

    setConsumeBusy(true);
    setConsumeError(null);

    const nextVal = Math.max(0, target.current_quantity - consumeQty);

    try {
      setItems((prev) =>
        prev.map((i) => (i.id === target.id ? { ...i, current_quantity: nextVal } : i))
      );
      await updateStockQuantity(target.id, nextVal);
      setIsQuickConsumeOpen(false);
      setConsumeQty(1);
    } catch (err) {
      setConsumeError(err instanceof Error ? err.message : 'Falha ao registrar baixa.');
      void loadData();
    } finally {
      setConsumeBusy(false);
    }
  };

  const unitLabels: Record<UnitMeasure, string> = {
    un: 'Unidade (un)',
    kg: 'Quilograma (kg)',
    g: 'Grama (g)',
    l: 'Litro (L)',
    ml: 'Mililitro (ml)',
    cx: 'Caixa (cx)',
    pct: 'Pacote (pct)',
  };

  return (
    <div className="mx-auto max-w-[1400px] space-y-5 text-zinc-900 dark:text-zinc-100 antialiased pb-12 pt-0">
      {/* =========================================================================
          A. CABEÇALHO DA PÁGINA (TOPO REPOSICIONADO, LIMPO E SEM DUPLICAÇÕES)
          ========================================================================= */}
      <div className="pt-0">
        <h1 className="text-2xl sm:text-3xl font-black tracking-tight text-zinc-900 dark:text-white">
          Estoque &amp; Insumos
        </h1>
        <p className="mt-1 text-xs sm:text-sm text-zinc-500 dark:text-zinc-400">
          Controle seus insumos, acompanhe o estoque em tempo real e evite faltas no seu restaurante.
        </p>
      </div>

      {/* =========================================================================
          B. LINHA DE CARDS DE RESUMO (4 CARDS SUPERIORES)
          ========================================================================= */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {/* Card 1: Total */}
        <div className="bg-white dark:bg-[#18181b] border border-zinc-200/80 dark:border-zinc-800 rounded-2xl p-5 shadow-2xs flex items-center justify-between transition-all hover:shadow-xs">
          <div>
            <span className="text-xs font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">
              Total de itens
            </span>
            <div className="text-2xl sm:text-3xl font-black text-zinc-900 dark:text-white mt-1">
              {metrics.total}
            </div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
              {metrics.total} insumos cadastrados
            </p>
          </div>
          <div className="w-12 h-12 rounded-xl bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 flex items-center justify-center shrink-0">
            <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
            </svg>
          </div>
        </div>

        {/* Card 2: Em Alerta */}
        <div className="bg-white dark:bg-[#18181b] border border-zinc-200/80 dark:border-zinc-800 rounded-2xl p-5 shadow-2xs flex items-center justify-between transition-all hover:shadow-xs">
          <div>
            <span className="text-xs font-bold text-amber-700 dark:text-amber-400 uppercase tracking-wider">
              Em alerta (ruptura)
            </span>
            <div className="text-2xl sm:text-3xl font-black text-amber-600 dark:text-amber-400 mt-1">
              {metrics.inAlert}
            </div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
              {metrics.inAlert} itens precisam de atenção
            </p>
          </div>
          <div className="w-12 h-12 rounded-xl bg-amber-50 text-amber-600 dark:bg-amber-950/60 dark:text-amber-400 border border-amber-200/50 dark:border-amber-900/40 flex items-center justify-center shrink-0">
            <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
              <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
        </div>

        {/* Card 3: Esgotados */}
        <div className="bg-white dark:bg-[#18181b] border border-zinc-200/80 dark:border-zinc-800 rounded-2xl p-5 shadow-2xs flex items-center justify-between transition-all hover:shadow-xs">
          <div>
            <span className="text-xs font-bold text-rose-700 dark:text-rose-400 uppercase tracking-wider">
              Esgotados
            </span>
            <div className="text-2xl sm:text-3xl font-black text-rose-600 dark:text-rose-400 mt-1">
              {metrics.outOfStock}
            </div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
              {metrics.outOfStock} sem estoque
            </p>
          </div>
          <div className="w-12 h-12 rounded-xl bg-rose-50 text-rose-600 dark:bg-rose-950/60 dark:text-rose-400 border border-rose-200/50 dark:border-rose-900/40 flex items-center justify-center shrink-0">
            <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
              <circle cx="12" cy="12" r="10" />
              <line x1="15" y1="9" x2="9" y2="15" />
              <line x1="9" y1="9" x2="15" y2="15" />
            </svg>
          </div>
        </div>

        {/* Card 4: Regular */}
        <div className="bg-white dark:bg-[#18181b] border border-zinc-200/80 dark:border-zinc-800 rounded-2xl p-5 shadow-2xs flex items-center justify-between transition-all hover:shadow-xs">
          <div>
            <span className="text-xs font-bold text-emerald-700 dark:text-emerald-400 uppercase tracking-wider">
              Estoque regular
            </span>
            <div className="text-2xl sm:text-3xl font-black text-emerald-600 dark:text-emerald-400 mt-1">
              {metrics.healthy}
            </div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
              {metrics.healthy} dentro do ideal
            </p>
          </div>
          <div className="w-12 h-12 rounded-xl bg-emerald-50 text-emerald-600 dark:bg-emerald-950/60 dark:text-emerald-400 border border-emerald-200/50 dark:border-emerald-900/40 flex items-center justify-center shrink-0">
            <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
          </div>
        </div>
      </div>

      {/* =========================================================================
          LAYOUT EM 2 COLUNAS (ÁREA PRINCIPAL + PAINEL LATERAL DIREITO)
          ========================================================================= */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* =====================================================================
            COLUNA ESQUERDA / CENTRAL (TABELA E CONTROLES)
            ===================================================================== */}
        <div className="xl:col-span-8 2xl:col-span-9 space-y-4">
          {/* C. BARRA DE FILTROS E BUSCA */}
          <div className="bg-white dark:bg-[#18181b] border border-zinc-200/80 dark:border-zinc-800 rounded-2xl p-4 shadow-2xs flex flex-wrap items-center justify-between gap-3">
            {/* Input de Busca */}
            <div className="relative flex-1 min-w-[240px]">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Buscar por nome do insumo, categoria ou fornecedor..."
                className="w-full rounded-xl border border-zinc-200 bg-zinc-50/80 pl-10 pr-4 py-2.5 text-xs sm:text-sm text-zinc-900 placeholder-zinc-400 focus:border-[#610000] focus:bg-white focus:outline-hidden focus:ring-2 focus:ring-[#610000]/15 dark:border-zinc-700 dark:bg-zinc-900 dark:text-white dark:placeholder-zinc-500"
              />
              <svg
                className="w-4 h-4 text-zinc-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </div>

            {/* Seletor de Categoria */}
            <div className="w-full sm:w-auto min-w-[150px]">
              <select
                value={selectedCategory}
                onChange={(e) => setSelectedCategory(e.target.value)}
                className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-xs sm:text-sm font-semibold text-zinc-700 focus:border-[#610000] focus:outline-hidden focus:ring-2 focus:ring-[#610000]/15 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 cursor-pointer"
              >
                <option value="all">Categoria: Todas</option>
                {uniqueCategories.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
            </div>

            {/* Seletor de Status */}
            <div className="w-full sm:w-auto min-w-[140px]">
              <select
                value={selectedStatus}
                onChange={(e) => setSelectedStatus(e.target.value)}
                className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-xs sm:text-sm font-semibold text-zinc-700 focus:border-[#610000] focus:outline-hidden focus:ring-2 focus:ring-[#610000]/15 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 cursor-pointer"
              >
                <option value="all">Status: Todos</option>
                <option value="alert">▲ Em alerta</option>
                <option value="out_of_stock">✕ Esgotados</option>
                <option value="healthy">● Regular</option>
              </select>
            </div>

            {/* Botão Primário: + Novo Insumo */}
            <button
              type="button"
              onClick={handleOpenCreateModal}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl bg-[#610000] px-4 py-2.5 text-xs sm:text-sm font-bold text-white shadow-xs transition-all hover:bg-[#7a0000] active:scale-[0.98] cursor-pointer shrink-0"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              <span>+ Novo insumo</span>
            </button>
          </div>

          {/* D. ABAS DE VISUALIZAÇÃO E ORDENAÇÃO */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 dark:border-zinc-800 pb-2">
            {/* Abas de Filtro Rápido */}
            <div className="flex items-center gap-2 overflow-x-auto">
              <button
                type="button"
                onClick={() => setActiveFilter('all')}
                className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                  activeFilter === 'all'
                    ? 'bg-[#610000] text-white shadow-xs'
                    : 'text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-white dark:hover:bg-zinc-800'
                }`}
              >
                <span>Lista</span>
                <span className={`rounded-full px-1.5 py-0.2 text-[10px] font-black ${
                  activeFilter === 'all' ? 'bg-white/20 text-white' : 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
                }`}>
                  {metrics.total}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setActiveFilter('alert')}
                className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                  activeFilter === 'alert'
                    ? 'bg-amber-600 text-white shadow-xs'
                    : 'text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-white dark:hover:bg-zinc-800'
                }`}
              >
                <span>Estoque baixo</span>
                <span className={`rounded-full px-1.5 py-0.2 text-[10px] font-black ${
                  activeFilter === 'alert' ? 'bg-white/20 text-white' : 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300'
                }`}>
                  {metrics.inAlert}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setActiveFilter('out_of_stock')}
                className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                  activeFilter === 'out_of_stock'
                    ? 'bg-rose-600 text-white shadow-xs'
                    : 'text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-white dark:hover:bg-zinc-800'
                }`}
              >
                <span>Esgotados</span>
                <span className={`rounded-full px-1.5 py-0.2 text-[10px] font-black ${
                  activeFilter === 'out_of_stock' ? 'bg-white/20 text-white' : 'bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300'
                }`}>
                  {metrics.outOfStock}
                </span>
              </button>
            </div>

            {/* Seletor de Ordenação à Direita */}
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-zinc-400 dark:text-zinc-500">Ordenar por:</span>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortType)}
                className="rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-bold text-zinc-700 focus:border-[#610000] focus:outline-hidden dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 cursor-pointer"
              >
                <option value="recent">Mais recentes</option>
                <option value="name_asc">Nome (A-Z)</option>
                <option value="stock_asc">Menor estoque</option>
                <option value="stock_desc">Maior estoque</option>
              </select>
            </div>
          </div>

          {/* E. ESTRUTURA DA TABELA PRINCIPAL */}
          {loading ? (
            <div className="flex h-64 flex-col items-center justify-center gap-3 text-center bg-white dark:bg-[#18181b] border border-zinc-200/80 dark:border-zinc-800 rounded-2xl">
              <svg className="h-8 w-8 animate-spin text-[#610000]" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                Carregando estoque &amp; insumos…
              </p>
            </div>
          ) : error ? (
            <div role="alert" className="p-4 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-semibold">
              {error}
            </div>
          ) : sortedItems.length === 0 ? (
            <div className="p-12 text-center bg-white dark:bg-[#18181b] border border-zinc-200/80 dark:border-zinc-800 rounded-2xl">
              <div className="w-12 h-12 mx-auto mb-3 rounded-2xl bg-zinc-100 text-zinc-400 dark:bg-zinc-800 flex items-center justify-center">
                <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                </svg>
              </div>
              <h3 className="text-base font-bold text-zinc-900 dark:text-white">Nenhum insumo encontrado</h3>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 max-w-sm mx-auto">
                {items.length === 0
                  ? 'Nenhum insumo cadastrado no estoque ainda. Clique em "+ Novo insumo" para começar.'
                  : 'Nenhum insumo corresponde aos filtros ou busca informada.'}
              </p>
            </div>
          ) : (
            <div className="bg-white dark:bg-[#18181b] border border-zinc-200/80 dark:border-zinc-800 rounded-2xl shadow-2xs overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs sm:text-sm border-collapse">
                  <thead>
                    <tr className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-900/50 text-[11px] font-black uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                      <th className="py-3 px-4">INSUMO</th>
                      <th className="py-3 px-4">CATEGORIA</th>
                      <th className="py-3 px-4 text-center">ESTOQUE ATUAL</th>
                      <th className="py-3 px-4">LIMITE DE RUPTURA</th>
                      <th className="py-3 px-4">STATUS</th>
                      <th className="py-3 px-4 text-right">AÇÕES</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/80">
                    {paginatedItems.map((item) => {
                      const isOutOfStock = item.current_quantity === 0;
                      const isLowStock = !isOutOfStock && item.current_quantity <= item.alert_threshold;
                      const photoUrl = getItemPhoto(item, customImages);
                      const badgeStyle = getCategoryBadgeStyle(item.category);

                      return (
                        <tr
                          key={item.id}
                          className="hover:bg-zinc-50/60 dark:hover:bg-zinc-800/40 transition-colors"
                        >
                          {/* INSUMO (com Foto/Avatar interativo para alterar imagem) */}
                          <td className="py-3.5 px-4">
                            <div className="flex items-center gap-3">
                              <div
                                onClick={() => handleOpenImageModal(item)}
                                className="group relative w-11 h-11 rounded-xl overflow-hidden border border-zinc-200 dark:border-zinc-700 shadow-2xs shrink-0 cursor-pointer"
                                title="Clique para alterar a foto do insumo"
                                role="button"
                                tabIndex={0}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    handleOpenImageModal(item);
                                  }
                                }}
                              >
                                {photoUrl ? (
                                  <img
                                    src={photoUrl}
                                    alt={item.name}
                                    className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-110"
                                    loading="lazy"
                                  />
                                ) : (
                                  <div className="w-full h-full bg-[#610000]/10 text-[#610000] dark:bg-rose-950/40 dark:text-rose-400 flex items-center justify-center font-black text-sm">
                                    {item.name.charAt(0).toUpperCase()}
                                  </div>
                                )}
                                {/* Overlay com lápis ao passar o mouse */}
                                <div className="absolute inset-0 bg-black/55 text-white flex flex-col items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity backdrop-blur-[0.5px]">
                                  <svg className="w-4 h-4 drop-shadow-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                    <path d="M12 20h9" />
                                    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                                  </svg>
                                </div>
                              </div>
                              <div className="min-w-0">
                                <div className="font-bold text-sm text-zinc-900 dark:text-white leading-tight">
                                  {item.name}
                                </div>
                                <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
                                  Medida: {item.unit_measure}
                                </span>
                              </div>
                            </div>
                          </td>

                          {/* CATEGORIA (Badges com cores distintas por categoria) */}
                          <td className="py-3.5 px-4">
                            <span
                              className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-bold rounded-lg border ${badgeStyle.bg} ${badgeStyle.text} ${badgeStyle.border} shadow-2xs`}
                            >
                              <span className={`w-1.5 h-1.5 rounded-full ${badgeStyle.dot}`} />
                              <span>{item.category || 'Geral'}</span>
                            </span>
                          </td>

                          {/* ESTOQUE ATUAL */}
                          <td className="py-3.5 px-4">
                            <div className="flex items-center justify-center gap-2">
                              <button
                                type="button"
                                onClick={() => void handleQuickAdjust(item, -1)}
                                disabled={item.current_quantity <= 0}
                                title="Reduzir 1 unidade"
                                className="w-7 h-7 rounded-lg border border-zinc-200 bg-white hover:bg-zinc-100 disabled:opacity-40 disabled:cursor-not-allowed dark:border-zinc-700 dark:bg-zinc-800 dark:hover:bg-zinc-700 flex items-center justify-center text-xs font-bold text-zinc-700 dark:text-zinc-200 shadow-2xs cursor-pointer transition-colors"
                              >
                                -
                              </button>
                              <span
                                className={`min-w-[65px] text-center font-mono font-black text-sm ${
                                  isOutOfStock
                                    ? 'text-rose-600 dark:text-rose-400'
                                    : isLowStock
                                    ? 'text-amber-600 dark:text-amber-400'
                                    : 'text-zinc-900 dark:text-white'
                                }`}
                              >
                                {item.current_quantity} <span className="text-xs font-normal opacity-70">{item.unit_measure}</span>
                              </span>
                              <button
                                type="button"
                                onClick={() => void handleQuickAdjust(item, 1)}
                                title="Adicionar 1 unidade"
                                className="w-7 h-7 rounded-lg border border-zinc-200 bg-white hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800 dark:hover:bg-zinc-700 flex items-center justify-center text-xs font-bold text-zinc-700 dark:text-zinc-200 shadow-2xs cursor-pointer transition-colors"
                              >
                                +
                              </button>
                            </div>
                          </td>

                          {/* LIMITE DE RUPTURA */}
                          <td className="py-3.5 px-4 text-xs font-medium text-zinc-600 dark:text-zinc-300">
                            &le; <strong className="font-bold text-zinc-900 dark:text-white">{item.alert_threshold}</strong> {item.unit_measure}
                          </td>

                          {/* STATUS */}
                          <td className="py-3.5 px-4">
                            {isOutOfStock ? (
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-rose-50 text-rose-700 border border-rose-200/80 dark:bg-rose-950/50 dark:text-rose-300 dark:border-rose-900/50">
                                <span>✕</span>
                                <span>Esgotado</span>
                              </span>
                            ) : isLowStock ? (
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-amber-50 text-amber-700 border border-amber-200/80 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-900/50">
                                <span>▲</span>
                                <span>Em alerta</span>
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200/80 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-900/50">
                                <span>●</span>
                                <span>Normal</span>
                              </span>
                            )}
                          </td>

                          {/* AÇÕES */}
                          <td className="py-3.5 px-4 text-right">
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => handleOpenEditModal(item)}
                                title="Editar insumo"
                                aria-label={`Editar ${item.name}`}
                                className="p-2 rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-white dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                              >
                                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <path d="M12 20h9" />
                                  <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                                </svg>
                              </button>

                              <button
                                type="button"
                                onClick={() => void handleDelete(item.id)}
                                disabled={deletingId === item.id}
                                title="Excluir insumo"
                                aria-label={`Excluir ${item.name}`}
                                className="p-2 rounded-lg text-rose-500 hover:text-rose-700 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/40 transition-colors cursor-pointer disabled:opacity-40"
                              >
                                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <polyline points="3 6 5 6 21 6" />
                                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                </svg>
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Paginação Limpa */}
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-200 dark:border-zinc-800 px-4 py-3 bg-zinc-50/50 dark:bg-zinc-900/30 text-xs">
                <span className="text-zinc-500 dark:text-zinc-400 font-medium">
                  Mostrando{' '}
                  <strong className="text-zinc-900 dark:text-white font-bold">
                    {sortedItems.length > 0 ? (currentPage - 1) * itemsPerPage + 1 : 0}
                  </strong>{' '}
                  a{' '}
                  <strong className="text-zinc-900 dark:text-white font-bold">
                    {Math.min(currentPage * itemsPerPage, sortedItems.length)}
                  </strong>{' '}
                  de{' '}
                  <strong className="text-zinc-900 dark:text-white font-bold">{sortedItems.length}</strong> insumos
                </span>

                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                    className="p-1.5 rounded-lg border border-zinc-200 bg-white hover:bg-zinc-100 disabled:opacity-30 disabled:cursor-not-allowed dark:border-zinc-700 dark:bg-zinc-800 dark:hover:bg-zinc-700 transition-colors cursor-pointer"
                    title="Página anterior"
                  >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="15 18 9 12 15 6" />
                    </svg>
                  </button>

                  {Array.from({ length: totalPages }, (_, idx) => idx + 1).map((pageNum) => (
                    <button
                      key={pageNum}
                      type="button"
                      onClick={() => setCurrentPage(pageNum)}
                      className={`min-w-[28px] h-7 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                        currentPage === pageNum
                          ? 'bg-[#610000] text-white shadow-2xs'
                          : 'border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700'
                      }`}
                    >
                      {pageNum}
                    </button>
                  ))}

                  <button
                    type="button"
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                    className="p-1.5 rounded-lg border border-zinc-200 bg-white hover:bg-zinc-100 disabled:opacity-30 disabled:cursor-not-allowed dark:border-zinc-700 dark:bg-zinc-800 dark:hover:bg-zinc-700 transition-colors cursor-pointer"
                    title="Próxima página"
                  >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* =====================================================================
            F. PAINEL LATERAL DIREITO (ALERTAS E AÇÕES RÁPIDAS)
            ===================================================================== */}
        <div className="xl:col-span-4 2xl:col-span-3 space-y-5">
          {/* 1. Card: Alertas do Estoque */}
          <div className="bg-white dark:bg-[#18181b] border border-zinc-200/80 dark:border-zinc-800 rounded-2xl p-5 shadow-2xs">
            {/* Cabeçalho do Widget */}
            <div className="flex items-center justify-between pb-2 mb-2">
              <div className="flex items-center gap-2">
                <svg
                  className="w-4 h-4 text-zinc-700 dark:text-zinc-300"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
                  <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
                </svg>
                <h3 className="text-sm sm:text-base font-bold text-zinc-900 dark:text-white">
                  Alertas do estoque
                </h3>
              </div>
              <button
                type="button"
                onClick={() => {
                  setSelectedStatus('all');
                  setActiveFilter('alert');
                }}
                className="text-xs font-semibold text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white transition-colors flex items-center gap-1 cursor-pointer"
              >
                <span>Ver todos</span>
                <span aria-hidden="true">→</span>
              </button>
            </div>

            {/* Lista contínua de itens em alerta */}
            {alertItems.length === 0 ? (
              <div className="py-8 text-center">
                <div className="w-10 h-10 mx-auto mb-2 rounded-full bg-emerald-50 text-emerald-600 dark:bg-emerald-950/50 dark:text-emerald-400 flex items-center justify-center">
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
                <p className="text-xs font-bold text-zinc-800 dark:text-zinc-200">Tudo em ordem!</p>
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">
                  Nenhum insumo abaixo do limite.
                </p>
              </div>
            ) : (
              <div className="max-h-[460px] overflow-y-auto pr-1 divide-y divide-transparent">
                {alertItems.map((item, index) => {
                  const isOutOfStock = item.current_quantity === 0;
                  const qtyFormatted = item.current_quantity.toString().replace('.', ',');
                  const thresholdFormatted = item.alert_threshold.toString().replace('.', ',');

                  return (
                    <div
                      key={item.id}
                      onClick={() => handleOpenEditModal(item)}
                      className="group relative flex items-center justify-between gap-3 py-2 px-1 hover:bg-zinc-50/80 dark:hover:bg-zinc-800/40 rounded-xl transition-colors cursor-pointer"
                      title="Clique para editar insumo"
                    >
                      {/* Lado Esquerdo: Indicador vertical de linha contínua com ponto */}
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="relative flex items-center justify-center w-6 shrink-0 self-stretch min-h-[38px]">
                          {/* Linha vertical contínua */}
                          <div
                            className={`absolute top-0 bottom-0 w-[1.5px] ${
                              isOutOfStock
                                ? 'bg-zinc-200 dark:bg-zinc-700'
                                : 'bg-red-200 dark:bg-red-900/40'
                            } ${index === 0 ? 'top-2' : ''} ${
                              index === alertItems.length - 1 ? 'bottom-2' : ''
                            }`}
                          />
                          {/* Pílula / Brilho suave */}
                          <div
                            className={`relative z-10 w-5 h-7 rounded-full flex items-center justify-center ${
                              isOutOfStock
                                ? 'bg-zinc-100/80 dark:bg-zinc-800/60'
                                : 'bg-red-50/90 dark:bg-red-950/40'
                            }`}
                          >
                            <div
                              className={`w-2 h-2 rounded-full ${
                                isOutOfStock
                                  ? 'bg-zinc-500 dark:bg-zinc-400'
                                  : 'bg-red-600 dark:bg-red-500'
                              }`}
                            />
                          </div>
                        </div>

                        {/* Nome do insumo e quantidade atual com limite */}
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-zinc-900 dark:text-white truncate group-hover:text-[#610000] dark:group-hover:text-rose-400 transition-colors">
                            {item.name}
                          </p>
                          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                            {isOutOfStock
                              ? `0 ${item.unit_measure}`
                              : `${qtyFormatted} ${item.unit_measure} (≤ ${thresholdFormatted} ${item.unit_measure})`}
                          </p>
                        </div>
                      </div>

                      {/* Lado Direito: Status com ícone circular */}
                      <div className="shrink-0 flex items-center">
                        {isOutOfStock ? (
                          <span className="flex items-center gap-1.5 text-xs font-semibold text-[#8a3c3c] dark:text-[#f87171]">
                            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <circle cx="12" cy="12" r="10" />
                              <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
                            </svg>
                            <span>Esgotado</span>
                          </span>
                        ) : (
                          <span className="flex items-center gap-1.5 text-xs font-semibold text-red-600 dark:text-red-400">
                            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <circle cx="12" cy="12" r="10" />
                              <line x1="12" y1="8" x2="12" y2="12" />
                              <line x1="12" y1="16" x2="12.01" y2="16" />
                            </svg>
                            <span>Em alerta</span>
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* 2. Card: Ações Rápidas */}
          <div className="bg-white dark:bg-[#18181b] border border-zinc-200/80 dark:border-zinc-800 rounded-2xl p-5 shadow-2xs">
            <h3 className="text-sm font-bold text-zinc-900 dark:text-white mb-3 flex items-center gap-2">
              <svg className="w-4 h-4 text-[#610000] dark:text-rose-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
              </svg>
              <span>Ações rápidas</span>
            </h3>

            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={handleOpenCreateModal}
                className="flex flex-col items-center justify-center gap-1.5 p-3 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 hover:bg-[#610000]/5 hover:border-[#610000]/40 dark:bg-zinc-800/60 dark:hover:bg-zinc-800 transition-all text-center cursor-pointer group"
              >
                <div className="w-8 h-8 rounded-lg bg-[#610000]/10 text-[#610000] dark:bg-rose-950/50 dark:text-rose-400 flex items-center justify-center group-hover:scale-105 transition-transform">
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </div>
                <span className="text-xs font-bold text-zinc-700 dark:text-zinc-200">
                  + Adicionar
                </span>
              </button>

              <button
                type="button"
                onClick={() => {
                  if (items.length > 0 && !consumeItemId) {
                    setConsumeItemId(items[0].id);
                  }
                  setConsumeError(null);
                  setIsQuickConsumeOpen(true);
                }}
                className="flex flex-col items-center justify-center gap-1.5 p-3 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 hover:bg-amber-500/10 hover:border-amber-500/40 dark:bg-zinc-800/60 dark:hover:bg-zinc-800 transition-all text-center cursor-pointer group"
              >
                <div className="w-8 h-8 rounded-lg bg-amber-500/10 text-amber-600 dark:bg-amber-950/50 dark:text-amber-400 flex items-center justify-center group-hover:scale-105 transition-transform">
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <polyline points="19 12 12 19 5 12" />
                  </svg>
                </div>
                <span className="text-xs font-bold text-zinc-700 dark:text-zinc-200">
                  ↓ Baixar estoque
                </span>
              </button>

              <button
                type="button"
                onClick={() => window.print()}
                className="flex flex-col items-center justify-center gap-1.5 p-3 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 hover:bg-blue-500/10 hover:border-blue-500/40 dark:bg-zinc-800/60 dark:hover:bg-zinc-800 transition-all text-center cursor-pointer group"
              >
                <div className="w-8 h-8 rounded-lg bg-blue-500/10 text-blue-600 dark:bg-blue-950/50 dark:text-blue-400 flex items-center justify-center group-hover:scale-105 transition-transform">
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="16" y1="13" x2="8" y2="13" />
                    <line x1="16" y1="17" x2="8" y2="17" />
                  </svg>
                </div>
                <span className="text-xs font-bold text-zinc-700 dark:text-zinc-200">
                  📄 Relatório
                </span>
              </button>

              <button
                type="button"
                onClick={() => setIsHistoryOpen(true)}
                className="flex flex-col items-center justify-center gap-1.5 p-3 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 hover:bg-emerald-500/10 hover:border-emerald-500/40 dark:bg-zinc-800/60 dark:hover:bg-zinc-800 transition-all text-center cursor-pointer group"
              >
                <div className="w-8 h-8 rounded-lg bg-emerald-500/10 text-emerald-600 dark:bg-emerald-950/50 dark:text-emerald-400 flex items-center justify-center group-hover:scale-105 transition-transform">
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                </div>
                <span className="text-xs font-bold text-zinc-700 dark:text-zinc-200">
                  ⏱ Histórico
                </span>
              </button>
            </div>
          </div>

          {/* 3. Card Inferior de Dica / Banner */}
          <div className="rounded-2xl border border-[#610000]/20 bg-gradient-to-br from-[#610000]/5 via-amber-500/5 to-transparent p-5 dark:border-[#610000]/30 dark:from-[#610000]/15 dark:via-zinc-900 dark:to-zinc-900 shadow-2xs">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#610000] text-white shadow-xs">
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                </svg>
              </div>
              <div>
                <h4 className="text-[11px] font-black uppercase tracking-wider text-[#610000] dark:text-rose-300">
                  Dica de Gestão
                </h4>
                <h5 className="text-sm font-bold text-zinc-900 dark:text-white mt-0.5 leading-snug">
                  Mantenha seu estoque em dia!
                </h5>
                <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-300 mt-1.5">
                  Evite desperdícios, reduza custos e garanta a melhor experiência para seus clientes.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* =========================================================================
          MODAIS DO SISTEMA DE ESTOQUE
          ========================================================================= */}

      {/* Modal 1: Cadastro / Edição de Insumo */}
      {isModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in duration-150"
        >
          <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-6 shadow-2xl dark:border-zinc-800 dark:bg-[#18181b]">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-black text-zinc-900 dark:text-white">
                {editingItem ? 'Editar Insumo de Estoque' : 'Novo Insumo de Estoque'}
              </h2>
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="p-1 rounded-lg text-zinc-400 hover:text-zinc-700 dark:hover:text-white"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {formError && (
              <div role="alert" className="p-3 mb-4 rounded-xl bg-rose-50 text-rose-700 text-xs font-semibold">
                {formError}
              </div>
            )}

            <form onSubmit={(e) => void handleSaveItem(e)} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-zinc-700 dark:text-zinc-300 mb-1">
                  Nome do Insumo *
                </label>
                <input
                  type="text"
                  required
                  value={itemForm.name}
                  onChange={(e) => setItemForm((prev) => ({ ...prev, name: e.target.value }))}
                  placeholder="Ex.: Alface Americana, Pão Australiano, Tomate, etc."
                  className="w-full rounded-xl border border-zinc-300 bg-white px-3.5 py-2.5 text-sm text-zinc-900 placeholder-zinc-400 focus:border-[#610000] focus:outline-hidden focus:ring-2 focus:ring-[#610000]/15 dark:border-zinc-700 dark:bg-zinc-900 dark:text-white dark:placeholder-zinc-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-zinc-700 dark:text-zinc-300 mb-1">
                    Categoria
                  </label>
                  <input
                    type="text"
                    value={itemForm.category}
                    onChange={(e) => setItemForm((prev) => ({ ...prev, category: e.target.value }))}
                    placeholder="Ex.: Hortifrúti, Carnes, Bebidas"
                    className="w-full rounded-xl border border-zinc-300 bg-white px-3.5 py-2.5 text-sm text-zinc-900 placeholder-zinc-400 focus:border-[#610000] focus:outline-hidden focus:ring-2 focus:ring-[#610000]/15 dark:border-zinc-700 dark:bg-zinc-900 dark:text-white dark:placeholder-zinc-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-zinc-700 dark:text-zinc-300 mb-1">
                    Unidade de Medida
                  </label>
                  <select
                    value={itemForm.unit_measure}
                    onChange={(e) => setItemForm((prev) => ({ ...prev, unit_measure: e.target.value as UnitMeasure }))}
                    className="w-full rounded-xl border border-zinc-300 bg-white px-3 py-2.5 text-sm font-semibold text-zinc-700 focus:border-[#610000] focus:outline-hidden dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 cursor-pointer"
                  >
                    {Object.entries(unitLabels).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-zinc-700 dark:text-zinc-300 mb-1">
                    Estoque Atual
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={itemForm.current_quantity}
                    onChange={(e) =>
                      setItemForm((prev) => ({ ...prev, current_quantity: parseFloat(e.target.value) || 0 }))
                    }
                    className="w-full rounded-xl border border-zinc-300 bg-white px-3.5 py-2.5 text-sm text-zinc-900 focus:border-[#610000] focus:outline-hidden dark:border-zinc-700 dark:bg-zinc-900 dark:text-white"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-zinc-700 dark:text-zinc-300 mb-1">
                    Limite de Ruptura (Alerta)
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={itemForm.alert_threshold}
                    onChange={(e) =>
                      setItemForm((prev) => ({ ...prev, alert_threshold: parseFloat(e.target.value) || 0 }))
                    }
                    className="w-full rounded-xl border border-zinc-300 bg-white px-3.5 py-2.5 text-sm text-zinc-900 focus:border-[#610000] focus:outline-hidden dark:border-zinc-700 dark:bg-zinc-900 dark:text-white"
                  />
                </div>
              </div>

              <div className="flex items-center justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  disabled={formBusy}
                  className="rounded-xl border border-zinc-300 dark:border-zinc-700 px-4 py-2.5 text-xs font-bold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={formBusy}
                  className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-[#610000] px-5 py-2.5 text-xs font-bold text-white shadow-xs hover:bg-[#7a0000] disabled:opacity-50 transition-colors cursor-pointer"
                >
                  {formBusy ? 'Salvando…' : editingItem ? 'Salvar Alterações' : 'Cadastrar Insumo'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal 2: Alteração Rápida de Foto do Insumo */}
      {isImageModalOpen && selectedImageItem && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in duration-150"
        >
          <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-6 shadow-2xl dark:border-zinc-800 dark:bg-[#18181b]">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-base font-black text-zinc-900 dark:text-white">
                  Alterar Foto do Insumo
                </h2>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                  {selectedImageItem.name}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsImageModalOpen(false)}
                className="p-1 rounded-lg text-zinc-400 hover:text-zinc-700 dark:hover:text-white"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {/* Prévia da Foto */}
            <div className="flex flex-col items-center justify-center my-3">
              <div className="relative w-24 h-24 rounded-2xl overflow-hidden border-2 border-zinc-200 dark:border-zinc-700 shadow-md bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center">
                {tempImageUrl ? (
                  <img
                    src={tempImageUrl}
                    alt={selectedImageItem.name}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="font-black text-2xl text-[#610000]">
                    {selectedImageItem.name.charAt(0).toUpperCase()}
                  </div>
                )}
                {imageUploadBusy && (
                  <div className="absolute inset-0 bg-black/60 flex items-center justify-center text-white">
                    <svg className="w-6 h-6 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                  </div>
                )}
              </div>
              <span className="text-[11px] font-semibold text-zinc-400 dark:text-zinc-500 mt-1">
                Prévia da miniatura na tabela
              </span>
            </div>

            {imageUploadError && (
              <div role="alert" className="p-2.5 mb-3 rounded-xl bg-rose-50 text-rose-700 text-xs font-semibold text-center">
                {imageUploadError}
              </div>
            )}

            {/* Opção 1: Upload do dispositivo */}
            <input
              type="file"
              ref={fileInputRef}
              accept="image/*"
              onChange={(e) => void handleFileChange(e)}
              className="hidden"
            />

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={imageUploadBusy}
              className="w-full mb-3 flex items-center justify-center gap-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 hover:bg-zinc-100 dark:bg-zinc-800/80 dark:hover:bg-zinc-800 py-2.5 px-4 text-xs font-bold text-zinc-700 dark:text-zinc-200 transition-colors cursor-pointer"
            >
              <svg className="w-4 h-4 text-[#610000] dark:text-rose-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              <span>{imageUploadBusy ? 'Enviando foto…' : 'Enviar foto do computador ou celular'}</span>
            </button>

            {/* Opção 2: Galeria rápida de fotos recomendadas */}
            <div className="mb-3">
              <span className="block text-[11px] font-bold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-2">
                Ou selecione uma foto da galeria rápida:
              </span>
              <div className="grid grid-cols-6 gap-2 max-h-[140px] overflow-y-auto p-1 bg-zinc-50 dark:bg-zinc-900/60 rounded-xl border border-zinc-200/80 dark:border-zinc-800">
                {PRESET_GALLERY_PHOTOS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => {
                      setTempImageUrl(preset.url);
                      setImageUploadError(null);
                    }}
                    title={preset.label}
                    className={`relative w-full aspect-square rounded-lg overflow-hidden border-2 transition-all cursor-pointer ${
                      tempImageUrl === preset.url
                        ? 'border-[#610000] ring-2 ring-[#610000]/20 scale-105'
                        : 'border-transparent hover:border-zinc-300 dark:hover:border-zinc-600'
                    }`}
                  >
                    <img src={preset.url} alt={preset.label} className="w-full h-full object-cover" />
                  </button>
                ))}
              </div>
            </div>

            {/* Opção 3: Link direto / URL */}
            <div className="mb-4">
              <label className="block text-[11px] font-bold text-zinc-600 dark:text-zinc-400 mb-1">
                Ou cole o link direto da foto (URL):
              </label>
              <input
                type="url"
                value={tempImageUrl}
                onChange={(e) => setTempImageUrl(e.target.value)}
                placeholder="https://exemplo.com/foto.jpg"
                className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-900 placeholder-zinc-400 focus:border-[#610000] focus:outline-hidden dark:border-zinc-700 dark:bg-zinc-900 dark:text-white"
              />
            </div>

            {/* Ações do Modal de Imagem */}
            <div className="flex items-center justify-between gap-2 pt-2 border-t border-zinc-100 dark:border-zinc-800">
              {customImages[selectedImageItem.id] ? (
                <button
                  type="button"
                  onClick={handleRemoveCustomImage}
                  className="text-xs font-semibold text-rose-600 dark:text-rose-400 hover:underline cursor-pointer"
                >
                  Restaurar padrão
                </button>
              ) : (
                <div />
              )}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsImageModalOpen(false)}
                  className="rounded-xl border border-zinc-300 dark:border-zinc-700 px-3.5 py-2 text-xs font-bold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={handleSaveCustomImage}
                  disabled={imageUploadBusy}
                  className="rounded-xl bg-[#610000] px-4 py-2 text-xs font-bold text-white shadow-xs hover:bg-[#7a0000] transition-colors cursor-pointer"
                >
                  Salvar Foto
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal 3: Baixar Estoque */}
      {isQuickConsumeOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in duration-150"
        >
          <div className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-6 shadow-2xl dark:border-zinc-800 dark:bg-[#18181b]">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base font-black text-zinc-900 dark:text-white flex items-center gap-2">
                <span>↓</span>
                <span>Baixa de Estoque</span>
              </h2>
              <button
                type="button"
                onClick={() => setIsQuickConsumeOpen(false)}
                className="p-1 rounded-lg text-zinc-400 hover:text-zinc-700 dark:hover:text-white"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4">
              Informe a quantidade utilizada para atualizar o estoque do insumo imediatamente.
            </p>

            {consumeError && (
              <div role="alert" className="p-3 mb-4 rounded-xl bg-rose-50 text-rose-700 text-xs font-semibold">
                {consumeError}
              </div>
            )}

            <form onSubmit={(e) => void handleConfirmQuickConsume(e)} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-zinc-700 dark:text-zinc-300 mb-1">
                  Selecione o Insumo
                </label>
                <select
                  value={consumeItemId}
                  onChange={(e) => setConsumeItemId(e.target.value)}
                  className="w-full rounded-xl border border-zinc-300 bg-white px-3 py-2.5 text-sm font-semibold text-zinc-700 focus:border-[#610000] focus:outline-hidden dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 cursor-pointer"
                >
                  {items.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name} (Atual: {i.current_quantity} {i.unit_measure})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-zinc-700 dark:text-zinc-300 mb-1">
                  Quantidade a Baixar
                </label>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={consumeQty}
                  onChange={(e) => setConsumeQty(parseFloat(e.target.value) || 0)}
                  className="w-full rounded-xl border border-zinc-300 bg-white px-3.5 py-2.5 text-sm text-zinc-900 focus:border-[#610000] focus:outline-hidden dark:border-zinc-700 dark:bg-zinc-900 dark:text-white"
                />
              </div>

              <div className="flex items-center justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setIsQuickConsumeOpen(false)}
                  disabled={consumeBusy}
                  className="rounded-xl border border-zinc-300 dark:border-zinc-700 px-4 py-2 text-xs font-bold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={consumeBusy}
                  className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-[#610000] px-4 py-2 text-xs font-bold text-white shadow-xs hover:bg-[#7a0000] disabled:opacity-50 transition-colors cursor-pointer"
                >
                  {consumeBusy ? 'Atualizando…' : 'Confirmar Baixa'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal 4: Histórico de Movimentações */}
      {isHistoryOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in duration-150"
        >
          <div className="w-full max-w-lg rounded-2xl border border-zinc-200 bg-white p-6 shadow-2xl dark:border-zinc-800 dark:bg-[#18181b]">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-black text-zinc-900 dark:text-white flex items-center gap-2">
                <svg className="w-4 h-4 text-emerald-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
                <span>Últimas Atualizações de Estoque</span>
              </h2>
              <button
                type="button"
                onClick={() => setIsHistoryOpen(false)}
                className="p-1 rounded-lg text-zinc-400 hover:text-zinc-700 dark:hover:text-white"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            <div className="space-y-2.5 max-h-[360px] overflow-y-auto pr-1">
              {items
                .slice()
                .sort((a, b) => new Date(b.updated_at || b.created_at).getTime() - new Date(a.updated_at || a.created_at).getTime())
                .slice(0, 15)
                .map((it) => {
                  const bStyle = getCategoryBadgeStyle(it.category);
                  return (
                    <div
                      key={it.id}
                      className="flex items-center justify-between p-3 rounded-xl bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-200/60 dark:border-zinc-700/60 text-xs"
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-bold text-zinc-900 dark:text-white">{it.name}</p>
                          <span className={`text-[10px] font-bold px-1.5 py-0.2 rounded border ${bStyle.bg} ${bStyle.text} ${bStyle.border}`}>
                            {it.category || 'Geral'}
                          </span>
                        </div>
                        <p className="text-[11px] text-zinc-400 mt-0.5">
                          Atualizado em:{' '}
                          {new Date(it.updated_at || it.created_at).toLocaleString('pt-BR', {
                            day: '2-digit',
                            month: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </p>
                      </div>
                      <span className="font-mono font-bold text-xs bg-white dark:bg-zinc-800 px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700">
                        {it.current_quantity} {it.unit_measure}
                      </span>
                    </div>
                  );
                })}
            </div>

            <div className="flex justify-end pt-4">
              <button
                type="button"
                onClick={() => setIsHistoryOpen(false)}
                className="rounded-xl border border-zinc-300 dark:border-zinc-700 px-4 py-2 text-xs font-bold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

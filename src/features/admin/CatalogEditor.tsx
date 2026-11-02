import { useModuleAccess } from "../restaurants/ModuleAccess";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { supabase } from "../../lib/supabase";
import { priceToCents, saveCatalogEntry, slugify } from "./adminCatalog";
import type { AdminCategory, AdminProduct } from "./adminCatalog";
import { MAX_PHOTOS, preparePhoto, prepareVideo, uploadMenuMedia } from "./menuMedia";
import type { DraftPhoto, DraftVideo } from "./menuMedia";
import { fetchInventory } from "../inventory/inventoryService";
import type { InventoryItem } from "../inventory/inventoryService";

export type CatalogSelection =
  | { kind: "category"; entry: AdminCategory | null }
  | { kind: "product"; entry: AdminProduct | null };

function Switch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-[#610000] focus:ring-offset-2 ${
        checked ? "bg-emerald-600" : "bg-zinc-300 dark:bg-zinc-700"
      } ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
    >
      <span
        aria-hidden="true"
        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
          checked ? "translate-x-5" : "translate-x-0"
        }`}
      />
    </button>
  );
}

function CategoryImageCropModal({
  imageSrc,
  onApply,
  onClose,
}: {
  imageSrc: string;
  onApply: (blob: Blob, dataUrl: string) => void;
  onClose: () => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const offsetStart = useRef({ x: 0, y: 0 });
  const imgRef = useRef<HTMLImageElement>(null);
  const [imgNatural, setImgNatural] = useState<{ w: number; h: number } | null>(null);

  const viewportSize = 220;

  const handlePointerDown = (clientX: number, clientY: number) => {
    setDragging(true);
    dragStart.current = { x: clientX, y: clientY };
    offsetStart.current = { ...offset };
  };

  const handlePointerMove = (clientX: number, clientY: number) => {
    if (!dragging) return;
    const dx = clientX - dragStart.current.x;
    const dy = clientY - dragStart.current.y;
    setOffset({
      x: offsetStart.current.x + dx,
      y: offsetStart.current.y + dy,
    });
  };

  const handlePointerUp = () => {
    setDragging(false);
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.08 : -0.08;
    setZoom((curr) => {
      const next = parseFloat((curr + delta).toFixed(2));
      return Math.min(3, Math.max(0.6, next));
    });
  };

  const nw = imgNatural?.w ?? viewportSize;
  const nh = imgNatural?.h ?? viewportSize;
  const baseScale = Math.max(viewportSize / nw, viewportSize / nh);
  const currentW = nw * baseScale * zoom;
  const currentH = nh * baseScale * zoom;
  const leftInViewport = (viewportSize - currentW) / 2 + offset.x;
  const topInViewport = (viewportSize - currentH) / 2 + offset.y;

  const applyCrop = () => {
    const img = imgRef.current;
    if (!img) return;

    const size = 400; // Resolução de alta definição 400x400
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    const multiplier = size / viewportSize;

    try {
      ctx.drawImage(
        img,
        leftInViewport * multiplier,
        topInViewport * multiplier,
        currentW * multiplier,
        currentH * multiplier
      );

      const dataUrl = canvas.toDataURL("image/webp", 0.92);
      canvas.toBlob((blob) => {
        if (blob) {
          onApply(blob, dataUrl);
        } else {
          fetch(dataUrl)
            .then((res) => res.blob())
            .then((b) => onApply(b, dataUrl))
            .catch(() => onApply(new Blob(), dataUrl));
        }
      }, "image/webp", 0.92);
    } catch (err) {
      console.error("Erro ao aplicar corte:", err);
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-200 select-none"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white dark:bg-zinc-900 rounded-3xl max-w-sm w-full p-6 shadow-2xl border border-zinc-200 dark:border-zinc-800 flex flex-col items-center text-center">
        <div className="w-full flex items-center justify-between mb-1">
          <h3 className="font-bold text-base text-zinc-900 dark:text-white">
            Enquadrar imagem
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 p-1 text-base cursor-pointer"
          >
            ✕
          </button>
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4">
          Arraste para posicionar e use os controles para diminuir ou aumentar.
        </p>

        {/* Viewport Circular com Máscara e visualização 1:1 */}
        <div
          className="w-[220px] h-[220px] rounded-full overflow-hidden border-4 border-[#610000] relative bg-zinc-950 shadow-inner cursor-grab active:cursor-grabbing"
          onWheel={handleWheel}
          onMouseDown={(e) => handlePointerDown(e.clientX, e.clientY)}
          onMouseMove={(e) => handlePointerMove(e.clientX, e.clientY)}
          onMouseUp={handlePointerUp}
          onMouseLeave={handlePointerUp}
          onTouchStart={(e) => {
            const touch = e.touches[0];
            if (touch) handlePointerDown(touch.clientX, touch.clientY);
          }}
          onTouchMove={(e) => {
            const touch = e.touches[0];
            if (touch) handlePointerMove(touch.clientX, touch.clientY);
          }}
          onTouchEnd={handlePointerUp}
        >
          {!imgNatural && (
            <div className="absolute inset-0 flex items-center justify-center text-zinc-400 text-xs">
              Carregando…
            </div>
          )}
          <img
            ref={imgRef}
            src={imageSrc}
            crossOrigin="anonymous"
            alt="Enquadramento"
            draggable={false}
            onLoad={(e) => {
              const target = e.currentTarget;
              if (target.naturalWidth && target.naturalHeight) {
                setImgNatural({ w: target.naturalWidth, h: target.naturalHeight });
              }
            }}
            style={{
              position: "absolute",
              left: `${leftInViewport}px`,
              top: `${topInViewport}px`,
              width: `${currentW}px`,
              height: `${currentH}px`,
              maxWidth: "none",
              maxHeight: "none",
              userSelect: "none",
              pointerEvents: "none",
              opacity: imgNatural ? 1 : 0,
            }}
          />

          <div className="absolute inset-0 pointer-events-none border border-white/10 rounded-full" />
        </div>

        {/* Controles de Zoom */}
        <div className="w-full mt-4 px-2">
          <div className="flex items-center justify-between text-xs font-semibold text-zinc-600 dark:text-zinc-300 mb-1.5">
            <span className="flex items-center gap-1">
              <span>Zoom</span>
              <span className="text-[10px] text-zinc-400 font-normal">(ou role a roda do mouse)</span>
            </span>
            <span className="font-mono text-[11px] bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded text-[#610000] dark:text-red-400 font-bold">
              {Math.round(zoom * 100)}%
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              title="Diminuir zoom"
              onClick={() => setZoom((z) => Math.max(0.6, parseFloat((z - 0.1).toFixed(2))))}
              className="w-8 h-8 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-xs font-bold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700 cursor-pointer active:scale-95 transition-transform"
            >
              -
            </button>
            <input
              type="range"
              min="0.6"
              max="3.0"
              step="0.02"
              value={zoom}
              onChange={(e) => setZoom(parseFloat(e.target.value))}
              className="flex-1 accent-[#610000] cursor-pointer"
            />
            <button
              type="button"
              title="Aumentar zoom"
              onClick={() => setZoom((z) => Math.min(3.0, parseFloat((z + 0.1).toFixed(2))))}
              className="w-8 h-8 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-xs font-bold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700 cursor-pointer active:scale-95 transition-transform"
            >
              +
            </button>
          </div>

          <div className="flex justify-center mt-2">
            <button
              type="button"
              onClick={() => {
                setOffset({ x: 0, y: 0 });
                setZoom(1.0);
              }}
              className="text-[11px] text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 underline cursor-pointer"
            >
              Recentralizar foto
            </button>
          </div>
        </div>

        {/* Ações */}
        <div className="w-full grid grid-cols-2 gap-3 mt-5">
          <button
            type="button"
            onClick={onClose}
            className="w-full py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-semibold text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-750 cursor-pointer transition-colors"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={applyCrop}
            disabled={!imgNatural}
            className="w-full py-2.5 rounded-xl bg-[#610000] hover:bg-[#4a0000] text-xs font-bold text-white shadow-sm cursor-pointer transition-all disabled:opacity-50"
          >
            Aplicar corte
          </button>
        </div>
      </div>
    </div>
  );
}

export function CatalogEditor({
  selection,
  categories,
  restaurantSlug,
  restaurantId,
  onSaved,
  onCancel,
}: {
  selection: CatalogSelection;
  categories: AdminCategory[];
  restaurantSlug: string;
  restaurantId: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const entry = selection.entry;
  const product = selection.kind === "product" ? selection.entry : null;
  const category = selection.kind === "category" ? selection.entry : null;
  const isProduct = selection.kind === "product";

  const [id] = useState(() => entry?.id ?? crypto.randomUUID());
  const [draft, setDraft] = useState({
    name: entry?.name ?? "",
    slug: entry?.slug ?? "",
    order: String(entry?.sort_order ?? 0),
    active: category?.active ?? true,
    categoryId:
      product?.category_id ??
      categories.find((item) => item.active)?.id ??
      categories[0]?.id ??
      "",
    shortDescription: product?.short_description ?? "",
    description: product?.description ?? "",
    price: product
      ? (product.price_in_cents / 100).toFixed(2).replace(".", ",")
      : "",
    promoPrice: "",
    serviceType: "À la carte",
    available: product?.available ?? true,
    featured: product?.featured ?? false,
    dietaryInformation: product?.dietary_information ?? "",
    prepTimeMin:
      product?.prep_time_min_minutes != null
        ? String(product.prep_time_min_minutes)
        : "",
    prepTimeMax:
      product?.prep_time_max_minutes != null
        ? String(product.prep_time_max_minutes)
        : "",
    preparationStation:
      (product?.preparation_station as "kitchen" | "bar" | "none") ?? "kitchen",
    inventoryItemId: product?.inventory_item_id ?? "",
    badgeText: (() => {
      try {
        if (product?.id) {
          const stored = localStorage.getItem(`elozi_product_badge_${product.id}`);
          if (stored !== null) return stored;
        }
      } catch {}
      return product?.badge_text ?? product?.badgeText ?? "";
    })(),
    badgeColor: (() => {
      try {
        if (product?.id) {
          const stored = localStorage.getItem(`elozi_product_badge_color_${product.id}`);
          if (stored !== null && stored !== "") return stored;
        }
      } catch {}
      const meta = product as unknown as Record<string, unknown>;
      return (meta?.badge_color as string) || (meta?.badgeColor as string) || "#D97706";
    })(),
  });

  const {data: moduleAccess} = useModuleAccess(restaurantId);
  const [inventoryItems, setInventoryItems] = useState<InventoryItem[]>([]);
  const [activeSection, setActiveSection] = useState<
    "basic" | "media" | "price" | "availability" | "details"
  >("basic");

  useEffect(() => {
    let live = true;
    setInventoryItems([]);
    if (isProduct && restaurantId && moduleAccess?.inventory) {
      fetchInventory(restaurantId)
        .then(items => { if (live) setInventoryItems(items); })
        .catch((err) =>
          console.error("Erro ao carregar estoque para vinculo:", err),
        );
    }
    return () => { live = false; };
  }, [isProduct, restaurantId, moduleAccess?.inventory]);

  const [photos, setPhotos] = useState<DraftPhoto[]>(() =>
    [...(product?.images ?? [])].sort((a, b) => a.sortOrder - b.sortOrder),
  );
  const [video, setVideo] = useState<DraftVideo | null>(
    product?.video ?? null,
  );
  const [coverId, setCoverId] = useState(
    product?.cover_image_id ?? product?.images[0]?.id ?? "",
  );

  const [preparing, setPreparing] = useState(false);
  const [progress, setProgress] = useState("");
  const uploadCache = useRef(new Map<string, string>());
  const previews = useRef({ photos, video });
  previews.current = { photos, video };

  const [dirty, setDirty] = useState(false);
  const [slugEdited, setSlugEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const mounted = useRef(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const categoryFileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Imagem personalizada da categoria
  const [categoryImageUrl, setCategoryImageUrl] = useState<string>(() => {
    if (typeof window !== "undefined" && entry?.id) {
      const stored =
        localStorage.getItem(`elozi_cat_img_${restaurantId}_${entry.id}`) ||
        localStorage.getItem(`elozi_cat_img_${entry.id}`) ||
        (category as any)?.image_url ||
        "";
      if (stored && stored.startsWith("blob:")) return "";
      return stored;
    }
    return "";
  });
  const [categoryImageFile, setCategoryImageFile] = useState<Blob | null>(null);
  const [categoryImagePreview, setCategoryImagePreview] = useState<string>("");
  const [rawCategoryFileSrc, setRawCategoryFileSrc] = useState<string>("");
  const [isCropModalOpen, setIsCropModalOpen] = useState(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      previews.current.photos.forEach(
        (photo) => photo.previewUrl && URL.revokeObjectURL(photo.previewUrl),
      );
      if (previews.current.video?.previewUrl)
        URL.revokeObjectURL(previews.current.video.previewUrl);
    };
  }, []);

  useEffect(() => {
    if (!dirty) return;
    function beforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  function cancel() {
    if (busy || preparing) return;
    if (!dirty || window.confirm("Descartar as alterações deste formulário?")) {
      onCancel();
    }
  }

  async function handlePhotoFiles(files: FileList | File[]) {
    const fileArray = Array.from(files);
    if (!fileArray.length || busy || preparing) return;
    setError("");
    if (photos.length + fileArray.length > MAX_PHOTOS) {
      setError(`Use no máximo ${MAX_PHOTOS} fotos por produto.`);
      return;
    }
    setPreparing(true);
    try {
      const prepared: DraftPhoto[] = [];
      for (const file of fileArray) {
        prepared.push(
          await preparePhoto(
            file,
            `Foto de ${draft.name.trim() || "produto"}`,
          ),
        );
      }
      const newPhotos = [...photos, ...prepared];
      setPhotos(newPhotos);
      if (!coverId && newPhotos.length > 0) {
        setCoverId(newPhotos[0].id);
      }
      setDirty(true);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Não foi possível preparar as fotos.",
      );
    } finally {
      setPreparing(false);
    }
  }

  function removePhoto(photoId: string) {
    const photo = photos.find((p) => p.id === photoId);
    if (photo?.previewUrl) URL.revokeObjectURL(photo.previewUrl);
    const remaining = photos.filter((p) => p.id !== photoId);
    setPhotos(remaining);
    if (coverId === photoId) {
      setCoverId(remaining[0]?.id || "");
    }
    setDirty(true);
  }

  function makeCoverPhoto(photoId: string) {
    setCoverId(photoId);
    setPhotos((prev) => {
      const target = prev.find((p) => p.id === photoId);
      if (!target) return prev;
      const others = prev.filter((p) => p.id !== photoId);
      return [target, ...others];
    });
    setDirty(true);
  }

  async function handleVideoFile(file: File) {
    if (busy || preparing) return;
    setPreparing(true);
    setError("");
    try {
      const prepared = await prepareVideo(file);
      if (video?.previewUrl) URL.revokeObjectURL(video.previewUrl);
      setVideo(prepared);
      setDirty(true);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Não foi possível preparar o vídeo.",
      );
    } finally {
      setPreparing(false);
    }
  }

  function removeVideo() {
    if (video?.previewUrl) URL.revokeObjectURL(video.previewUrl);
    setVideo(null);
    setDirty(true);
  }

  function handleCategoryFileSelected(file: File) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setError("Use uma foto JPG, PNG ou WebP.");
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      setError("A foto deve ter no máximo 15 MB.");
      return;
    }
    setError("");
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      setRawCategoryFileSrc(result);
      setIsCropModalOpen(true);
    };
    reader.readAsDataURL(file);
  }

  function handleCategoryCropApplied(blob: Blob, dataUrl: string) {
    setCategoryImageFile(blob);
    setCategoryImagePreview(dataUrl);
    setCategoryImageUrl(dataUrl);
    setIsCropModalOpen(false);
    setDirty(true);
  }

  function removeCategoryImage() {
    setCategoryImageFile(null);
    setCategoryImagePreview("");
    setCategoryImageUrl("");
    setRawCategoryFileSrc("");
    setDirty(true);
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      void handlePhotoFiles(e.dataTransfer.files);
    }
  };

  const handleSelectTab = (
    sec: "basic" | "media" | "price" | "availability" | "details",
  ) => {
    setActiveSection(sec);
  };

  const scrollTo = (
    _id: string,
    sec: "basic" | "media" | "price" | "availability" | "details",
  ) => {
    setActiveSection(sec);
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || preparing) return;
    setError("");
    if (!draft.name.trim()) {
      setError("Informe o nome do produto.");
      setActiveSection("basic");
      return;
    }
    if (!/^\d{1,4}$/.test(draft.order)) {
      setError("Informe uma ordem entre 0 e 9999.");
      setActiveSection("basic");
      return;
    }
    if (isProduct && !draft.price.trim()) {
      setError("Informe o preço do produto.");
      setActiveSection("price");
      return;
    }
    if (isProduct && video && photos.length === 0) {
      setError("Adicione uma foto de capa para o vídeo do Explorar.");
      setActiveSection("media");
      return;
    }
    if (photos.some((photo) => !photo.alt.trim())) {
      setError("Descreva cada foto do produto.");
      setActiveSection("media");
      return;
    }

    let prepMin: number | null = null;
    let prepMax: number | null = null;
    if (isProduct) {
      const minTrim = draft.prepTimeMin.trim();
      const maxTrim = draft.prepTimeMax.trim();
      if ((minTrim && !maxTrim) || (!minTrim && maxTrim)) {
        setError(
          "Informe tanto o tempo mínimo quanto o máximo ou deixe ambos em branco.",
        );
        setActiveSection("details");
        return;
      }
      if (minTrim && maxTrim) {
        const parsedMin = parseInt(minTrim, 10);
        const parsedMax = parseInt(maxTrim, 10);
        if (
          isNaN(parsedMin) ||
          isNaN(parsedMax) ||
          parsedMin < 1 ||
          parsedMax < 1 ||
          parsedMin > 1440 ||
          parsedMax > 1440
        ) {
          setError(
            "O tempo estimado de preparo deve estar entre 1 e 1440 minutos.",
          );
          setActiveSection("details");
          return;
        }
        if (parsedMin > parsedMax) {
          setError(
            "O tempo mínimo de preparo não pode ser maior que o tempo máximo.",
          );
          setActiveSection("details");
          return;
        }
        prepMin = parsedMin;
        prepMax = parsedMax;
      }
    }

    submitting.current = true;
    setBusy(true);
    try {
      const values: Record<string, unknown> = {
        name: draft.name.trim(),
        slug: draft.slug,
        sort_order: Number(draft.order),
        ...(isProduct
          ? {
              category_id: draft.categoryId,
              short_description:
                draft.shortDescription.trim() ||
                draft.description.trim().slice(0, 240),
              description: draft.description.trim(),
              price_in_cents: priceToCents(draft.price),
              available: draft.available,
              featured: draft.featured,
              dietary_information: draft.dietaryInformation.trim(),
              prep_time_min_minutes: prepMin,
              prep_time_max_minutes: prepMax,
              preparation_station: draft.preparationStation,
              ...(moduleAccess?.inventory ? {inventory_item_id: draft.inventoryItemId.trim() || null} : {}),
              badge_text: draft.badgeText.trim() ? draft.badgeText.trim() : null,
              badge_color: draft.badgeText.trim() ? (draft.badgeColor || "#D97706") : null,
            }
          : { active: draft.active }),
      };

      if (isProduct) {
        try {
          if (draft.badgeText.trim()) {
            localStorage.setItem(`elozi_product_badge_${id}`, draft.badgeText.trim());
            localStorage.setItem(`elozi_product_badge_color_${id}`, draft.badgeColor || "#D97706");
          } else {
            localStorage.removeItem(`elozi_product_badge_${id}`);
            localStorage.removeItem(`elozi_product_badge_color_${id}`);
          }
        } catch (lsErr) {
          console.warn("Erro ao salvar badge no localStorage:", lsErr);
        }

        const media = await uploadMenuMedia(
          photos,
          video,
          restaurantId,
          id,
          uploadCache.current,
          (message) => {
            if (mounted.current) setProgress(message);
          },
        );
        Object.assign(values, media, { cover_image_id: coverId || null });
      } else {
        // Upload / salvamento da foto personalizada da categoria
        if (categoryImagePreview) {
          try {
            localStorage.setItem(`elozi_cat_img_${restaurantId}_${id}`, categoryImagePreview);
            localStorage.setItem(`elozi_cat_img_${id}`, categoryImagePreview);
          } catch (lsErr) {
            console.warn("Erro ao salvar foto no localStorage:", lsErr);
          }
        }

        if (categoryImageFile) {
          if (mounted.current) setProgress("Enviando foto da categoria…");
          try {
            const photoId = crypto.randomUUID();
            // Caminho compatível com a política de storage RLS: UUID/products/UUID/UUID.webp
            const path = `${restaurantId}/products/${id}/${photoId}.webp`;
            const bucket = supabase.storage.from("menu-images");
            const { error: upErr } = await bucket.upload(path, categoryImageFile, {
              contentType: "image/webp",
              cacheControl: "31536000",
              upsert: true,
            });
            if (!upErr) {
              const publicUrl = bucket.getPublicUrl(path).data.publicUrl;
              localStorage.setItem(`elozi_cat_img_${restaurantId}_${id}`, publicUrl);
              localStorage.setItem(`elozi_cat_img_${id}`, publicUrl);
            }
          } catch (imgErr) {
            console.error("Erro ao salvar foto da categoria no storage:", imgErr);
          }
        } else if (!categoryImageUrl && !categoryImagePreview) {
          localStorage.removeItem(`elozi_cat_img_${restaurantId}_${id}`);
          localStorage.removeItem(`elozi_cat_img_${id}`);
        }
      }

      if (mounted.current) setProgress("Salvando no catálogo…");
      await saveCatalogEntry(
        restaurantSlug,
        selection.kind,
        id,
        entry?.revision ?? 0,
        values,
      );
      if (mounted.current) {
        setDirty(false);
        onSaved();
      }
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error ? cause.message : "Não foi possível salvar.",
        );
    } finally {
      submitting.current = false;
      if (mounted.current) {
        setBusy(false);
        setProgress("");
      }
    }
  }

  const [copiedSlug, setCopiedSlug] = useState(false);

  function copySlugToClipboard() {
    if (draft.slug) {
      void navigator.clipboard.writeText(draft.slug);
      setCopiedSlug(true);
      setTimeout(() => setCopiedSlug(false), 2000);
    }
  }

  // Cover photo preview
  const currentCover =
    photos.find((p) => p.id === coverId) || photos[0];
  const selectedCategoryName =
    categories.find((c) => c.id === draft.categoryId)?.name || "Prato principal";

  // SE FOR EDIÇÃO DE CATEGORIA: RENDERIZA FORMULÁRIO LIMPO DE CATEGORIA
  if (!isProduct) {
    const activePhoto = categoryImagePreview || categoryImageUrl;

    return (
      <section className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200/80 dark:border-zinc-800 p-6 sm:p-8 max-w-xl mx-auto shadow-sm">
        {/* Hidden input para upload da foto da categoria */}
        <input
          ref={categoryFileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/avif"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleCategoryFileSelected(file);
            e.target.value = "";
          }}
        />

        <div className="flex flex-col items-center text-center mb-6">
          {/* Círculo Avatar Interativo da Categoria */}
          <div className="relative mb-3 group">
            <button
              type="button"
              onClick={() => {
                if (activePhoto) {
                  setRawCategoryFileSrc(activePhoto);
                  setIsCropModalOpen(true);
                } else {
                  categoryFileInputRef.current?.click();
                }
              }}
              title={activePhoto ? "Clique para ajustar o enquadramento e zoom" : "Clique para escolher a imagem da categoria"}
              aria-label="Escolher foto da categoria"
              className="w-28 h-28 rounded-full overflow-hidden border-2 border-[#610000]/25 hover:border-[#610000] shadow-md bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center cursor-pointer transition-all relative focus:outline-none focus:ring-2 focus:ring-[#610000]/30"
            >
              {activePhoto ? (
                <>
                  <img
                    src={activePhoto}
                    alt={draft.name || "Categoria"}
                    onError={(e) => {
                      e.currentTarget.style.display = "none";
                      const fallback = e.currentTarget.parentElement?.querySelector(".cat-editor-fallback") as HTMLElement | null;
                      if (fallback) fallback.style.display = "flex";
                    }}
                    className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                  />
                  <div
                    style={{ display: "none" }}
                    className="cat-editor-fallback flex-col items-center justify-center text-[#610000]/60 dark:text-red-400/60"
                  >
                    <svg
                      className="w-9 h-9"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.75"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2" />
                      <path d="M7 2v20" />
                      <path d="M21 15V2v0a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7" />
                    </svg>
                  </div>
                </>
              ) : (
                <div className="flex flex-col items-center justify-center text-[#610000]/60 dark:text-red-400/60">
                  <svg
                    className="w-9 h-9"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2" />
                    <path d="M7 2v20" />
                    <path d="M21 15V2v0a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7" />
                  </svg>
                </div>
              )}

              {/* Overlay suave ao passar o mouse */}
              <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center text-white text-[10px] font-semibold">
                <svg
                  className="w-5 h-5 mb-0.5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
                  <circle cx="12" cy="13" r="3" />
                </svg>
                <span>{activePhoto ? "Enquadrar / Trocar" : "Adicionar foto"}</span>
              </div>
            </button>

            {/* Botão de Lápis (Editar) Ativo */}
            <button
              type="button"
              onClick={() => {
                if (activePhoto) {
                  setRawCategoryFileSrc(activePhoto);
                  setIsCropModalOpen(true);
                } else {
                  categoryFileInputRef.current?.click();
                }
              }}
              title={activePhoto ? "Ajustar enquadramento e zoom" : "Escolher foto"}
              aria-label="Ajustar foto da categoria"
              className="absolute bottom-0 right-0 w-8 h-8 rounded-full bg-[#610000] hover:bg-[#4a0000] text-white flex items-center justify-center shadow-md border-2 border-white dark:border-zinc-900 transition-transform hover:scale-110 cursor-pointer"
            >
              <svg
                className="w-3.5 h-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
              </svg>
            </button>
          </div>

          <h2 className="text-xl font-bold text-zinc-900 dark:text-white">
            {entry ? "Editar categoria" : "Nova categoria"}
          </h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 max-w-sm">
            Personalize a imagem, nome e ordem de exibição da categoria no cardápio.
          </p>

          {/* Botões de Ação para a Foto da Categoria */}
          <div className="flex flex-wrap items-center justify-center gap-2 mt-3">
            {activePhoto ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setRawCategoryFileSrc(activePhoto);
                    setIsCropModalOpen(true);
                  }}
                  className="px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-750 transition-colors cursor-pointer flex items-center gap-1.5 shadow-2xs"
                >
                  <svg className="w-3.5 h-3.5 text-[#610000] dark:text-red-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="22" y1="12" x2="18" y2="12" />
                    <line x1="6" y1="12" x2="2" y2="12" />
                    <line x1="12" y1="6" x2="12" y2="2" />
                    <line x1="12" y1="22" x2="12" y2="18" />
                  </svg>
                  <span>Ajustar enquadramento e zoom</span>
                </button>
                <button
                  type="button"
                  onClick={() => categoryFileInputRef.current?.click()}
                  className="px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-750 transition-colors cursor-pointer shadow-2xs"
                >
                  Trocar foto
                </button>
                <button
                  type="button"
                  onClick={removeCategoryImage}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors cursor-pointer"
                >
                  Remover foto
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => categoryFileInputRef.current?.click()}
                className="px-3.5 py-1.5 rounded-lg bg-[#610000]/10 hover:bg-[#610000]/15 text-[#610000] dark:bg-red-950/40 dark:text-red-400 text-xs font-bold transition-colors cursor-pointer flex items-center gap-1.5"
              >
                <span>+ Adicionar foto da categoria</span>
              </button>
            )}
          </div>
        </div>

        <form onSubmit={(e) => void submit(e)} className="space-y-4">
          <div>
            <label className="block text-xs font-bold text-zinc-800 dark:text-zinc-200 mb-1">
              Nome da categoria *
            </label>
            <input
              required
              maxLength={100}
              value={draft.name}
              onChange={(e) => {
                const name = e.target.value;
                setDraft((curr) => ({
                  ...curr,
                  name,
                  slug: !entry && !slugEdited ? slugify(name) : curr.slug,
                }));
              }}
              className="w-full min-h-11 px-3.5 rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm text-zinc-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-[#610000]/20 focus:border-[#610000]"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-zinc-800 dark:text-zinc-200 mb-1">
              Identificador (URL) *
            </label>
            <input
              required
              maxLength={120}
              readOnly={!!entry}
              value={draft.slug}
              onChange={(e) => {
                setSlugEdited(true);
                setDraft({ ...draft, slug: e.target.value });
              }}
              className="w-full min-h-11 px-3.5 rounded-xl border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/60 text-sm text-zinc-900 dark:text-white"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-zinc-800 dark:text-zinc-200 mb-1">
              Ordem de exibição *
            </label>
            <input
              type="number"
              min={0}
              max={9999}
              value={draft.order}
              onChange={(e) => setDraft({ ...draft, order: e.target.value })}
              className="w-full min-h-11 px-3.5 rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm text-zinc-900 dark:text-white"
            />
          </div>

          <div className="flex items-center gap-3 pt-2">
            <Switch
              checked={draft.active}
              onChange={(checked) => setDraft({ ...draft, active: checked })}
            />
            <span className="text-xs font-semibold text-zinc-800 dark:text-zinc-200">
              Categoria visível no cardápio
            </span>
          </div>

          {error && (
            <p className="rounded-xl bg-red-50 p-3 text-xs text-red-800 font-semibold">
              {error}
            </p>
          )}

          <div className="flex items-center gap-3 pt-4 border-t border-zinc-100 dark:border-zinc-800">
            <button
              type="submit"
              disabled={busy}
              className="px-5 py-2.5 rounded-xl bg-[#610000] hover:bg-[#4a0000] text-white text-xs font-bold transition-all shadow-sm cursor-pointer"
            >
              {busy ? "Salvando…" : "Salvar alterações"}
            </button>
            <button
              type="button"
              onClick={cancel}
              className="px-4 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-xs font-semibold text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 transition-colors cursor-pointer"
            >
              Cancelar
            </button>
          </div>
        </form>

        {/* Modal de corte e enquadramento da categoria */}
        {isCropModalOpen && (
          <CategoryImageCropModal
            imageSrc={rawCategoryFileSrc || activePhoto}
            onApply={handleCategoryCropApplied}
            onClose={() => setIsCropModalOpen(false)}
          />
        )}
      </section>
    );
  }

  // SE FOR EDIÇÃO / CRIAÇÃO DE PRODUTO: NOVA VIEW REESTRUTURADA FIEL À IMAGEM
  return (
    <div className="space-y-6">
      {/* Hidden file inputs for photo and video */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) void handlePhotoFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <input
        ref={videoInputRef}
        type="file"
        accept="video/mp4,video/webm"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleVideoFile(file);
          e.target.value = "";
        }}
      />

      {/* A. CABEÇALHO DA VIEW DE EDIÇÃO */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <button
            type="button"
            onClick={cancel}
            className="text-xs font-medium text-[#8C3A27] dark:text-red-400 hover:underline inline-flex items-center gap-1 mb-1 cursor-pointer"
          >
            <span>&lt; Voltar para o cardápio</span>
          </button>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-white tracking-tight">
            {entry ? "Editar produto" : "Novo produto"}
          </h1>
          <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">
            Atualize as informações do seu produto, imagens, preço e demais detalhes.
          </p>
        </div>

        {/* Botões de Ação Fixos no Topo */}
        <div className="flex items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={cancel}
            disabled={busy || preparing}
            className="px-4 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 text-xs font-medium hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors cursor-pointer disabled:opacity-50 shadow-2xs"
          >
            Cancelar
          </button>
          <button
            type="submit"
            form="product-editor-form"
            disabled={busy || preparing}
            className="px-4 py-2 rounded-lg bg-[#610000] hover:bg-[#4a0000] text-white text-xs font-medium shadow-sm flex items-center gap-2 transition-all cursor-pointer disabled:opacity-50"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
              <polyline points="17 21 17 13 7 13 7 21" />
              <polyline points="7 3 7 8 15 8" />
            </svg>
            <span>{busy ? "Salvando…" : preparing ? "Preparando…" : "Salvar alterações"}</span>
          </button>
        </div>
      </div>

      {/* B. BARRA DE NAVEGAÇÃO DE SEÇÕES (TABS HORIZONTAIS FUNCIONAIS) */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none border-b border-zinc-200/80 dark:border-zinc-800">
        {[
          {
            key: "basic",
            label: "Informações básicas",
            icon: (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect width="18" height="18" x="3" y="3" rx="2" />
                <path d="M3 9h18" />
                <path d="M9 21V9" />
              </svg>
            ),
          },
          {
            key: "media",
            label: `Fotos e vídeo (${photos.length})`,
            icon: (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
                <circle cx="9" cy="9" r="2" />
                <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
              </svg>
            ),
          },
          {
            key: "price",
            label: "Preço",
            icon: (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
                <line x1="7" y1="7" x2="7.01" y2="7" />
              </svg>
            ),
          },
          {
            key: "availability",
            label: "Disponibilidade",
            icon: (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 14 14" />
              </svg>
            ),
          },
          {
            key: "details",
            label: "Detalhes adicionais",
            icon: (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            ),
          },
        ].map((item) => {
          const isActive = activeSection === item.key;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => handleSelectTab(item.key as any)}
              className={`px-4 py-2 text-xs whitespace-nowrap transition-all rounded-xl flex items-center gap-2 cursor-pointer font-bold ${
                isActive
                  ? "bg-[#610000] text-white shadow-sm"
                  : "bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-700 hover:text-zinc-900 dark:hover:text-white"
              }`}
            >
              <span className={isActive ? "text-white" : "text-zinc-400"}>
                {item.icon}
              </span>
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>

      {/* Status Messages */}
      {busy && progress && (
        <div role="status" className="p-3 bg-blue-50 text-blue-800 rounded-xl text-xs font-semibold">
          {progress}
        </div>
      )}
      {error && (
        <div role="alert" className="p-3 bg-red-50 text-red-800 rounded-xl text-xs font-semibold">
          {error}
        </div>
      )}

      {/* FORMULÁRIO PRINCIPAL COM ABAS FUNCIONAIS */}
      <form
        id="product-editor-form"
        noValidate
        onSubmit={(e) => void submit(e)}
        onChange={() => setDirty(true)}
      >
        {/* C. GRID PRINCIPAL EM 2 COLUNAS ASSIMÉTRICAS (8 + 4) */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* ==================== COLUNA DA ESQUERDA (8 Colunas) — PAINÉIS DAS ABAS ==================== */}
          <div className="lg:col-span-8 flex flex-col gap-6">

            {/* ABA 1: Informações básicas */}
            {activeSection === "basic" && (
              <>
                {/* Card 1: Informações básicas */}
                <div
                  id="sec-basic"
                  className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200/80 dark:border-zinc-800 p-6 shadow-2xs space-y-4"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="text-[#8C3A27] dark:text-red-400">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect width="18" height="18" x="3" y="3" rx="2" />
                        <path d="M3 9h18" />
                        <path d="M9 21V9" />
                      </svg>
                    </span>
                    <div>
                      <h2 className="text-sm font-bold text-zinc-900 dark:text-white">
                        Informações básicas
                      </h2>
                      <p className="text-xs text-zinc-400 dark:text-zinc-500 font-normal">
                        Essas informações são essenciais para o seu produto.
                      </p>
                    </div>
                  </div>

                  {/* Nome do produto */}
                  <div>
                    <label className="block text-xs font-semibold text-zinc-800 dark:text-zinc-200 mb-1.5">
                      Nome do produto *
                    </label>
                    <input
                      required
                      maxLength={100}
                      value={draft.name}
                      placeholder="Ex: Risoto de cogumelos"
                      onChange={(e) => {
                        const name = e.target.value;
                        setDraft((curr) => ({
                          ...curr,
                          name,
                          slug: !entry && !slugEdited ? slugify(name) : curr.slug,
                        }));
                      }}
                      className="w-full rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3.5 py-2.5 text-sm text-zinc-900 dark:text-white placeholder-zinc-400 focus:outline-none focus:border-zinc-400 transition-all"
                    />
                    <div className="text-right text-[11px] text-zinc-400 mt-1">
                      {draft.name.length}/100
                    </div>
                  </div>

                  {/* Linha com 2 Colunas: Identificador e Categoria */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-semibold text-zinc-800 dark:text-zinc-200 mb-1.5">
                        Identificador no endereço *
                      </label>
                      <div className="relative">
                        <input
                          required
                          pattern="[a-z0-9]+(-[a-z0-9]+)*"
                          maxLength={100}
                          value={draft.slug}
                          onChange={(e) => {
                            setSlugEdited(true);
                            setDraft({ ...draft, slug: e.target.value });
                          }}
                          className="w-full rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3.5 py-2.5 pr-10 text-sm text-zinc-900 dark:text-white placeholder-zinc-400 focus:outline-none focus:border-zinc-400 transition-all"
                        />
                        <button
                          type="button"
                          title={copiedSlug ? "Copiado!" : "Copiar identificador"}
                          onClick={copySlugToClipboard}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 transition-colors p-1 cursor-pointer"
                        >
                          {copiedSlug ? (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          ) : (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                              <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                            </svg>
                          )}
                        </button>
                      </div>
                      <div className="text-right text-[11px] text-zinc-400 mt-1">
                        {draft.slug.length}/100
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-zinc-800 dark:text-zinc-200 mb-1.5">
                        Categoria *
                      </label>
                      <select
                        required
                        value={draft.categoryId}
                        onChange={(e) => setDraft({ ...draft, categoryId: e.target.value })}
                        className="w-full rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3.5 py-2.5 text-sm text-zinc-900 dark:text-white focus:outline-none focus:border-zinc-400 transition-all cursor-pointer"
                      >
                        <option value="" disabled>Selecione uma categoria</option>
                        {categories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name} {c.active ? "" : " (oculta)"}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* Alerta de Endereço Preservado */}
                  <div className="flex items-center gap-2.5 p-3 rounded-xl bg-[#FAF7F2] dark:bg-zinc-800/50 border border-[#EFEAE2] dark:border-zinc-700 text-xs text-zinc-600 dark:text-zinc-400">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[#8C3A27] shrink-0">
                      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                    </svg>
                    <span>O endereço é preservado para manter os links existentes.</span>
                  </div>
                </div>

                {/* Card 2: Descrição do produto */}
                <div
                  id="sec-description"
                  className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200/80 dark:border-zinc-800 p-6 shadow-2xs space-y-4"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="text-[#8C3A27] dark:text-red-400">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                        <line x1="16" y1="13" x2="8" y2="13" />
                        <line x1="16" y1="17" x2="8" y2="17" />
                        <polyline points="10 9 9 9 8 9" />
                      </svg>
                    </span>
                    <div>
                      <h2 className="text-sm font-bold text-zinc-900 dark:text-white">
                        Descrição do produto
                      </h2>
                      <p className="text-xs text-zinc-400 dark:text-zinc-500 font-normal">
                        Conte um pouco mais sobre o seu produto. Isso ajuda seus clientes a escolherem.
                      </p>
                    </div>
                  </div>

                  <div>
                    <textarea
                      rows={4}
                      maxLength={500}
                      value={draft.description}
                      placeholder="Risoto cremoso de cogumelos frescos, finalizado com parmesão e ervas."
                      onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                      className="w-full p-3.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm text-zinc-900 dark:text-white placeholder-zinc-400 focus:outline-none focus:border-zinc-400 transition-all resize-y"
                    />
                    <div className="text-right text-[11px] text-zinc-400 mt-1">
                      {draft.description.length}/500
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-zinc-800 dark:text-zinc-200 mb-1.5">
                      Adicionar observações (opcional)
                    </label>
                    <input
                      maxLength={200}
                      value={draft.dietaryInformation}
                      placeholder="Ex: alérgicos, ingredientes especiais, etc."
                      onChange={(e) => setDraft({ ...draft, dietaryInformation: e.target.value })}
                      className="w-full rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3.5 py-2.5 text-sm text-zinc-900 dark:text-white placeholder-zinc-400 focus:outline-none focus:border-zinc-400 transition-all"
                    />
                    <div className="text-right text-[11px] text-zinc-400 mt-1">
                      {draft.dietaryInformation.length}/200
                    </div>
                  </div>
                </div>

                {/* Navegação da etapa */}
                <div className="flex justify-end pt-1">
                  <button
                    type="button"
                    onClick={() => handleSelectTab("media")}
                    className="px-5 py-2.5 rounded-xl bg-[#610000] hover:bg-[#4a0000] text-white text-xs font-bold transition-all shadow-sm cursor-pointer flex items-center gap-2"
                  >
                    <span>Próximo: Fotos e vídeo</span>
                    <span>→</span>
                  </button>
                </div>
              </>
            )}

            {/* ABA 2: Fotos e vídeo */}
            {activeSection === "media" && (
              <>
                <div
                  id="sec-media"
                  className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200/80 dark:border-zinc-800 p-6 shadow-2xs space-y-5"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <span className="text-[#8C3A27] dark:text-red-400">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
                          <circle cx="9" cy="9" r="2" />
                          <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
                        </svg>
                      </span>
                      <div>
                        <h3 className="text-sm font-bold text-zinc-900 dark:text-white">
                          Fotos e vídeo do produto
                        </h3>
                        <p className="text-xs text-zinc-400 dark:text-zinc-500 font-normal">
                          Adicione fotos e vídeos para destacar seu produto.
                        </p>
                      </div>
                    </div>

                    <span className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">
                      {photos.length}/{MAX_PHOTOS} fotos
                    </span>
                  </div>

                  {/* Grade com Todas as Fotos do Produto + Gestão de Foto Principal */}
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {photos.map((photo, index) => {
                      const isCover = coverId ? photo.id === coverId : index === 0;
                      return (
                        <div
                          key={photo.id}
                          className={`relative aspect-square rounded-2xl overflow-hidden border transition-all group ${
                            isCover
                              ? "ring-3 ring-[#610000] border-transparent shadow-md"
                              : "border-zinc-200 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800 hover:border-zinc-400"
                          }`}
                        >
                          <img
                            src={photo.previewUrl || photo.url}
                            alt={photo.alt}
                            className="w-full h-full object-cover"
                          />

                          {/* Badge ou Botão de Foto Principal (Capa) */}
                          {isCover ? (
                            <div className="absolute top-2 left-2 px-2.5 py-1 rounded-full bg-[#610000] text-white text-[10px] font-bold shadow-md flex items-center gap-1.5 z-10 select-none">
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                              </svg>
                              <span>Principal</span>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => makeCoverPhoto(photo.id)}
                              title="Definir como foto principal (capa)"
                              className="absolute top-2 left-2 px-2.5 py-1 rounded-full bg-black/60 hover:bg-[#610000] text-white text-[10px] font-medium shadow-md flex items-center gap-1.5 opacity-90 group-hover:opacity-100 transition-all cursor-pointer z-10 select-none"
                            >
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                              </svg>
                              <span>Tornar principal</span>
                            </button>
                          )}

                          {/* Botão Remover Foto */}
                          <button
                            type="button"
                            onClick={() => removePhoto(photo.id)}
                            title="Remover foto"
                            aria-label="Remover foto"
                            className="absolute top-2 right-2 w-6 h-6 rounded-full bg-black/60 hover:bg-red-600 text-white flex items-center justify-center text-xs transition-colors cursor-pointer z-10 shadow-sm"
                          >
                            ✕
                          </button>
                        </div>
                      );
                    })}

                    {/* Botão Adicionar mais (quando já tem fotos e há espaço) */}
                    {photos.length > 0 && photos.length < MAX_PHOTOS && (
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="aspect-square rounded-2xl border-2 border-dashed border-zinc-200 dark:border-zinc-700 bg-zinc-50/50 dark:bg-zinc-800/30 hover:border-[#610000] hover:bg-zinc-100/60 dark:hover:bg-zinc-800/60 flex flex-col items-center justify-center p-3 text-zinc-600 dark:text-zinc-300 transition-all cursor-pointer group"
                      >
                        <div className="w-10 h-10 rounded-full bg-[#610000]/10 text-[#610000] dark:bg-red-950/40 dark:text-red-400 flex items-center justify-center mb-1.5 group-hover:scale-110 transition-transform">
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="12" y1="5" x2="12" y2="19" />
                            <line x1="5" y1="12" x2="19" y2="12" />
                          </svg>
                        </div>
                        <span className="text-xs font-semibold">Adicionar mais</span>
                        <span className="text-[10px] text-zinc-400">({photos.length}/{MAX_PHOTOS})</span>
                      </button>
                    )}
                  </div>

                  {/* Estado Vazio de Fotos */}
                  {photos.length === 0 && (
                    <div
                      onClick={() => fileInputRef.current?.click()}
                      className="py-10 px-4 rounded-2xl border-2 border-dashed border-zinc-200 dark:border-zinc-700 hover:border-[#610000] bg-zinc-50/50 dark:bg-zinc-800/30 flex flex-col items-center justify-center text-center cursor-pointer transition-colors"
                    >
                      <div className="w-12 h-12 rounded-full bg-[#610000]/10 text-[#610000] dark:bg-red-950/40 dark:text-red-400 flex items-center justify-center mb-2">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
                          <circle cx="9" cy="9" r="2" />
                          <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
                        </svg>
                      </div>
                      <span className="text-xs font-bold text-zinc-800 dark:text-zinc-200">
                        Nenhuma foto adicionada ainda
                      </span>
                      <span className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">
                        Clique aqui ou use a área abaixo para enviar as fotos do seu produto.
                      </span>
                    </div>
                  )}

                  {/* Área de Dropzone */}
                  <div
                    onDragOver={(e) => {
                      e.preventDefault();
                      setIsDragging(true);
                    }}
                    onDragLeave={() => setIsDragging(false)}
                    onDrop={handleDrop}
                    onClick={() => fileInputRef.current?.click()}
                    className={`border-2 border-dashed rounded-2xl p-6 text-center cursor-pointer transition-all ${
                      isDragging
                        ? "border-[#610000] bg-[#610000]/5"
                        : "border-zinc-200 dark:border-zinc-700 hover:border-[#610000] bg-zinc-50/50 dark:bg-zinc-800/20"
                    }`}
                  >
                    <span className="text-[#610000] dark:text-red-400 inline-block mb-1.5">
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
                        <path d="M12 12v9" />
                        <path d="m16 16-4-4-4 4" />
                      </svg>
                    </span>
                    <p className="text-xs font-bold text-zinc-800 dark:text-zinc-200">
                      Arraste e solte fotos aqui
                    </p>
                    <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">
                      ou clique para selecionar do seu dispositivo
                    </p>
                  </div>

                  {/* Seção Vídeo do produto */}
                  <div className="space-y-2 pt-2 border-t border-zinc-100 dark:border-zinc-800">
                    <span className="text-xs font-bold text-zinc-800 dark:text-zinc-200 block">
                      Vídeo do produto (opcional)
                    </span>

                    <div className="flex items-center gap-3">
                      {video ? (
                        <div className="relative w-40 aspect-[16/10] rounded-xl overflow-hidden bg-black/90 flex items-center justify-center border border-zinc-200 dark:border-zinc-700">
                          <video
                            src={video.previewUrl || video.url}
                            className="w-full h-full object-cover"
                          />
                          <button
                            type="button"
                            onClick={removeVideo}
                            title="Excluir vídeo"
                            className="absolute bottom-1.5 right-2 text-white/80 hover:text-white p-0.5 cursor-pointer"
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M3 6h18" />
                              <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                              <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                            </svg>
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => videoInputRef.current?.click()}
                          className="px-4 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 text-xs font-semibold hover:bg-zinc-50 dark:hover:bg-zinc-750 transition-colors cursor-pointer shadow-2xs"
                        >
                          + Adicionar vídeo (até 60s)
                        </button>
                      )}

                      {video && (
                        <button
                          type="button"
                          onClick={() => videoInputRef.current?.click()}
                          className="px-3.5 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 text-xs font-medium hover:bg-zinc-50 dark:hover:bg-zinc-750 transition-colors cursor-pointer shadow-2xs whitespace-nowrap"
                        >
                          Substituir vídeo
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Rodapé informativo */}
                  <div className="p-3 rounded-xl bg-[#FAF7F2] dark:bg-zinc-800/50 border border-[#EFEAE2] dark:border-zinc-700 flex items-start gap-2.5 text-[11px] text-zinc-500 dark:text-zinc-400 leading-relaxed">
                    <span className="text-[#8C3A27] shrink-0 mt-0.5">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="16" x2="12" y2="12" />
                        <line x1="12" y1="8" x2="12.01" y2="8" />
                      </svg>
                    </span>
                    <div>
                      Formatos aceitos: JPG, PNG ou WebP. Até 10 MB por foto.
                      <br />
                      Vídeos: até 10 segundos e 20 MB (MP4 ou WebM). Envie o arquivo já editado na duração final.
                    </div>
                  </div>
                </div>

                {/* Navegação da etapa */}
                <div className="flex items-center justify-between pt-1">
                  <button
                    type="button"
                    onClick={() => handleSelectTab("basic")}
                    className="px-4 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 text-xs font-semibold hover:bg-zinc-50 dark:hover:bg-zinc-750 cursor-pointer"
                  >
                    ← Informações básicas
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSelectTab("price")}
                    className="px-5 py-2.5 rounded-xl bg-[#610000] hover:bg-[#4a0000] text-white text-xs font-bold transition-all shadow-sm cursor-pointer flex items-center gap-2"
                  >
                    <span>Próximo: Preço</span>
                    <span>→</span>
                  </button>
                </div>
              </>
            )}

            {/* ABA 3: Preço */}
            {activeSection === "price" && (
              <>
                <div
                  id="sec-price"
                  className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200/80 dark:border-zinc-800 p-6 shadow-2xs space-y-4"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="text-[#8C3A27] dark:text-red-400">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
                        <line x1="7" y1="7" x2="7.01" y2="7" />
                      </svg>
                    </span>
                    <div>
                      <h2 className="text-sm font-bold text-zinc-900 dark:text-white">
                        Preço do produto
                      </h2>
                      <p className="text-xs text-zinc-400 dark:text-zinc-500 font-normal">
                        Defina o valor cobrado pelo seu produto no cardápio.
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
                    <div>
                      <label className="block text-xs font-semibold text-zinc-800 dark:text-zinc-200 mb-1.5">
                        Preço de venda *
                      </label>
                      <div className="relative">
                        <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-xs font-bold text-zinc-400">
                          R$
                        </span>
                        <input
                          required
                          type="text"
                          inputMode="decimal"
                          value={draft.price}
                          placeholder="48,00"
                          onChange={(e) => setDraft({ ...draft, price: e.target.value })}
                          className="w-full rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 pl-10 pr-3.5 py-2.5 text-sm font-medium text-zinc-900 dark:text-white focus:outline-none focus:border-zinc-400"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-zinc-800 dark:text-zinc-200 mb-1.5">
                        Preço promocional (opcional)
                      </label>
                      <div className="relative">
                        <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-xs font-bold text-zinc-400">
                          R$
                        </span>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={draft.promoPrice}
                          placeholder="0,00"
                          onChange={(e) => setDraft({ ...draft, promoPrice: e.target.value })}
                          className="w-full rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 pl-10 pr-9 py-2.5 text-sm text-zinc-900 dark:text-white placeholder-zinc-400 focus:outline-none focus:border-zinc-400"
                        />
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none">
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect width="18" height="18" x="3" y="4" rx="2" ry="2" />
                            <line x1="16" y1="2" x2="16" y2="6" />
                            <line x1="8" y1="2" x2="8" y2="6" />
                            <line x1="3" y1="10" x2="21" y2="10" />
                          </svg>
                        </span>
                      </div>
                    </div>
                  </div>

                  <p className="text-[11px] text-zinc-400 dark:text-zinc-500 leading-tight pt-1">
                    Quando preenchido, o preço promocional aparecerá em destaque e o valor original riscado.
                  </p>
                </div>

                {/* Navegação da etapa */}
                <div className="flex items-center justify-between pt-1">
                  <button
                    type="button"
                    onClick={() => handleSelectTab("media")}
                    className="px-4 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 text-xs font-semibold hover:bg-zinc-50 dark:hover:bg-zinc-750 cursor-pointer"
                  >
                    ← Fotos e vídeo
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSelectTab("availability")}
                    className="px-5 py-2.5 rounded-xl bg-[#610000] hover:bg-[#4a0000] text-white text-xs font-bold transition-all shadow-sm cursor-pointer flex items-center gap-2"
                  >
                    <span>Próximo: Disponibilidade</span>
                    <span>→</span>
                  </button>
                </div>
              </>
            )}

            {/* ABA 4: Disponibilidade */}
            {activeSection === "availability" && (
              <>
                <div
                  id="sec-availability"
                  className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200/80 dark:border-zinc-800 p-6 shadow-2xs space-y-4"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="text-[#8C3A27] dark:text-red-400">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" />
                        <polyline points="12 6 12 12 14 14" />
                      </svg>
                    </span>
                    <div>
                      <h2 className="text-sm font-bold text-zinc-900 dark:text-white">
                        Disponibilidade do produto
                      </h2>
                      <p className="text-xs text-zinc-400 dark:text-zinc-500 font-normal">
                        Controle se o item está visível e disponível para pedidos.
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-4 p-4 rounded-xl bg-zinc-50 dark:bg-zinc-800/40 border border-zinc-200/80 dark:border-zinc-700 mt-2">
                    <Switch
                      checked={draft.available}
                      onChange={(checked) => setDraft({ ...draft, available: checked })}
                    />
                    <div>
                      <span className="text-sm font-bold text-zinc-900 dark:text-white block">
                        {draft.available ? "Produto disponível no cardápio" : "Produto indisponível"}
                      </span>
                      <span className="text-xs text-zinc-500 dark:text-zinc-400 block mt-0.5">
                        {draft.available
                          ? "Os clientes conseguem visualizar e pedir este item normalmente."
                          : "O item não poderá ser pedido pelos clientes enquanto estiver desativado."}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Card 2: Selo promocional em destaque */}
                <div
                  id="sec-badge"
                  className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200/80 dark:border-zinc-800 p-6 shadow-2xs space-y-4"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="text-[#8C3A27] dark:text-red-400">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                      </svg>
                    </span>
                    <div>
                      <h2 className="text-sm font-bold text-zinc-900 dark:text-white">
                        Selo promocional em destaque (opcional)
                      </h2>
                      <p className="text-xs text-zinc-400 dark:text-zinc-500 font-normal">
                        Exibe uma etiqueta sobre a foto do produto no cardápio.
                      </p>
                    </div>
                  </div>

                  {/* Pills com opções rápidas */}
                  <div className="space-y-2">
                    <label className="block text-xs font-semibold text-zinc-800 dark:text-zinc-200">
                      Sugestões rápidas
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {[
                        { label: "Sem selo", value: "" },
                        { label: "Mais Pedido", value: "Mais Pedido" },
                        { label: "Destaque da Casa", value: "Destaque da Casa" },
                        { label: "Novidade", value: "Novidade" },
                        { label: "Sugestão do Chef", value: "Sugestão do Chef" },
                      ].map((item) => {
                        const isSelected = item.value === "" ? !draft.badgeText : draft.badgeText === item.value;
                        return (
                          <button
                            key={item.label}
                            type="button"
                            onClick={() => {
                              setDraft((curr) => ({ ...curr, badgeText: item.value }));
                              setDirty(true);
                            }}
                            className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-all cursor-pointer border ${
                              isSelected
                                ? "bg-[#610000] text-white border-[#610000] shadow-xs"
                                : "bg-zinc-50 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-700"
                            }`}
                          >
                            {item.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Input de texto livre */}
                  <div>
                    <label className="block text-xs font-semibold text-zinc-800 dark:text-zinc-200 mb-1.5">
                      Texto do selo personalizado
                    </label>
                    <input
                      maxLength={20}
                      value={draft.badgeText}
                      placeholder="Ou digite um texto personalizado (ex: Mais Vendido)"
                      onChange={(e) => {
                        setDraft((curr) => ({ ...curr, badgeText: e.target.value }));
                        setDirty(true);
                      }}
                      className="w-full rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3.5 py-2.5 text-sm text-zinc-900 dark:text-white placeholder-zinc-400 focus:outline-none focus:border-zinc-400 transition-all"
                    />
                    <div className="flex justify-between items-center text-[11px] text-zinc-400 mt-1">
                      <span>Limite de 20 caracteres para encaixe perfeito sobre a foto.</span>
                      <span>{draft.badgeText.length}/20</span>
                    </div>
                  </div>

                  {/* Seleção de cor do selo */}
                  <div className="space-y-2 pt-2 border-t border-zinc-100 dark:border-zinc-800">
                    <div className="flex items-center justify-between">
                      <label className="block text-xs font-semibold text-zinc-800 dark:text-zinc-200">
                        Cor de fundo do selo
                      </label>
                      <span className="text-[11px] font-mono font-medium text-zinc-400">
                        {draft.badgeColor || "#D97706"}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {[
                        { label: "Âmbar", value: "#D97706" },
                        { label: "Vinho", value: "#610000" },
                        { label: "Esmeralda", value: "#059669" },
                        { label: "Azul", value: "#2563EB" },
                        { label: "Rubi", value: "#E11D48" },
                        { label: "Roxo", value: "#7C3AED" },
                        { label: "Preto", value: "#18181B" },
                      ].map((c) => {
                        const isSelected = (draft.badgeColor || "#D97706").toLowerCase() === c.value.toLowerCase();
                        return (
                          <button
                            key={c.value}
                            type="button"
                            title={c.label}
                            onClick={() => {
                              setDraft((curr) => ({ ...curr, badgeColor: c.value }));
                              setDirty(true);
                            }}
                            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-all cursor-pointer ${
                              isSelected
                                ? "border-zinc-900 dark:border-white ring-2 ring-zinc-900/10 dark:ring-white/20 font-bold bg-zinc-100 dark:bg-zinc-800"
                                : "border-zinc-200 dark:border-zinc-700 hover:border-zinc-400 bg-white dark:bg-zinc-850"
                            }`}
                          >
                            <span
                              className="w-3.5 h-3.5 rounded-full shrink-0 shadow-2xs border border-white/20"
                              style={{ backgroundColor: c.value }}
                            />
                            <span className="text-zinc-700 dark:text-zinc-300">{c.label}</span>
                          </button>
                        );
                      })}

                      {/* Seletor de cor personalizada */}
                      <label
                        className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border border-zinc-200 dark:border-zinc-700 hover:border-zinc-400 cursor-pointer bg-zinc-50 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 transition-all"
                        title="Escolher qualquer cor personalizada"
                      >
                        <input
                          type="color"
                          value={draft.badgeColor || "#D97706"}
                          onChange={(e) => {
                            setDraft((curr) => ({ ...curr, badgeColor: e.target.value }));
                            setDirty(true);
                          }}
                          className="w-4 h-4 p-0 border-0 rounded cursor-pointer bg-transparent"
                        />
                        <span>Personalizada</span>
                      </label>
                    </div>
                  </div>
                </div>

                {/* Navegação da etapa */}
                <div className="flex items-center justify-between pt-1">
                  <button
                    type="button"
                    onClick={() => handleSelectTab("price")}
                    className="px-4 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 text-xs font-semibold hover:bg-zinc-50 dark:hover:bg-zinc-750 cursor-pointer"
                  >
                    ← Preço
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSelectTab("details")}
                    className="px-5 py-2.5 rounded-xl bg-[#610000] hover:bg-[#4a0000] text-white text-xs font-bold transition-all shadow-sm cursor-pointer flex items-center gap-2"
                  >
                    <span>Próximo: Detalhes adicionais</span>
                    <span>→</span>
                  </button>
                </div>
              </>
            )}

            {/* ABA 5: Detalhes adicionais */}
            {activeSection === "details" && (
              <>
                <div
                  id="sec-details"
                  className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200/80 dark:border-zinc-800 p-6 shadow-2xs space-y-5"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="text-[#8C3A27] dark:text-red-400">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="3" />
                        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                      </svg>
                    </span>
                    <div>
                      <h2 className="text-sm font-bold text-zinc-900 dark:text-white">
                        Detalhes adicionais
                      </h2>
                      <p className="text-xs text-zinc-400 dark:text-zinc-500 font-normal">
                        Configure informações operacionais e de destaque.
                      </p>
                    </div>
                  </div>

                  {/* Grid em 3 Colunas: Tipo de serviço, tempo de preparo e destaque */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-center pt-1">
                    <div>
                      <label className="block text-xs font-semibold text-zinc-800 dark:text-zinc-200 mb-1.5">
                        Tipo de serviço
                      </label>
                      <select
                        value={draft.serviceType}
                        onChange={(e) => setDraft({ ...draft, serviceType: e.target.value })}
                        className="w-full rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3.5 py-2.5 text-sm text-zinc-900 dark:text-white cursor-pointer focus:outline-none focus:border-zinc-400"
                      >
                        <option value="A la carte">A la carte</option>
                        <option value="Rodízio">Rodízio</option>
                        <option value="Buffet">Buffet</option>
                        <option value="Self-service">Self-service</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-zinc-800 dark:text-zinc-200 mb-1.5">
                        Tempo de preparo (opcional)
                      </label>
                      <div className="relative">
                        <input
                          type="text"
                          value={draft.prepTimeMin ? `${draft.prepTimeMin} min` : ""}
                          placeholder="15 min"
                          onChange={(e) => {
                            const val = e.target.value.replace(/\D/g, "");
                            setDraft({
                              ...draft,
                              prepTimeMin: val,
                              prepTimeMax: val,
                            });
                          }}
                          className="w-full rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3.5 py-2.5 pr-10 text-sm text-zinc-900 dark:text-white placeholder-zinc-400 focus:outline-none focus:border-zinc-400"
                        />
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none">
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="10" />
                            <polyline points="12 6 12 12 16 14" />
                          </svg>
                        </span>
                      </div>
                    </div>

                    <div className="pt-4 sm:pt-3">
                      <label className="flex items-start gap-2.5 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={draft.featured}
                          onChange={(e) => setDraft({ ...draft, featured: e.target.checked })}
                          className="mt-0.5 w-4 h-4 rounded border-zinc-300 text-[#610000] accent-[#610000] focus:ring-[#610000]"
                        />
                        <div>
                          <span className="text-xs font-semibold text-zinc-800 dark:text-zinc-200 block">
                            Produto em destaque
                          </span>
                          <span className="text-[11px] text-zinc-400 dark:text-zinc-500 block">
                            Aparece em primeiro lugar no cardápio.
                          </span>
                        </div>
                      </label>
                    </div>
                  </div>

                  {/* Opções operacionais KDS e Estoque */}
                  <div className="pt-3 border-t border-zinc-100 dark:border-zinc-800">
                    <span className="text-xs font-bold text-zinc-800 dark:text-zinc-200 block mb-3">
                      Opções operacionais (KDS e Estoque)
                    </span>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5">
                          Estação de preparo (KDS)
                        </label>
                        <select
                          value={draft.preparationStation}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              preparationStation: e.target.value as "kitchen" | "bar" | "none",
                            })
                          }
                          className="w-full rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3.5 py-2.5 text-sm text-zinc-900 dark:text-white cursor-pointer"
                        >
                          <option value="kitchen">Cozinha (Padrão)</option>
                          <option value="bar">Bar (Bebidas e Drinks)</option>
                          <option value="none">Sem preparo / Pronta entrega</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5">
                          Vincular ao estoque
                        </label>
                        <select
                          disabled={!moduleAccess?.inventory}
                          value={draft.inventoryItemId}
                          onChange={(e) => setDraft({ ...draft, inventoryItemId: e.target.value })}
                          className="w-full rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3.5 py-2.5 text-sm text-zinc-900 dark:text-white cursor-pointer"
                        >
                          <option value="">Sem vínculo (Estoque ilimitado)</option>
                          {inventoryItems.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.name} ({item.unit_measure}) — Saldo: {item.current_quantity}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Navegação da etapa */}
                <div className="flex items-center justify-between pt-1">
                  <button
                    type="button"
                    onClick={() => handleSelectTab("availability")}
                    className="px-4 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 text-xs font-semibold hover:bg-zinc-50 dark:hover:bg-zinc-750 cursor-pointer"
                  >
                    ← Disponibilidade
                  </button>
                  <button
                    type="submit"
                    disabled={busy || preparing}
                    className="px-6 py-2.5 rounded-xl bg-[#610000] hover:bg-[#4a0000] text-white text-xs font-bold shadow-sm transition-all cursor-pointer disabled:opacity-50 flex items-center gap-2"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                      <polyline points="17 21 17 13 7 13 7 21" />
                      <polyline points="7 3 7 8 15 8" />
                    </svg>
                    <span>{busy ? "Salvando…" : "Salvar alterações"}</span>
                  </button>
                </div>
              </>
            )}

          </div>

          {/* ==================== COLUNA DA DIREITA (4 Colunas) — PRÉVIA DO CARDÁPIO ==================== */}
          <div className="lg:col-span-4 flex flex-col gap-6 sticky top-6">
            <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200/80 dark:border-zinc-800 p-6 shadow-2xs space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <span className="text-[#8C3A27] dark:text-red-400">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
                      <circle cx="9" cy="9" r="2" />
                      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
                    </svg>
                  </span>
                  <h3 className="text-sm font-bold text-zinc-900 dark:text-white">
                    Prévia no cardápio
                  </h3>
                </div>
                {draft.featured && (
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20">
                    ★ Destaque
                  </span>
                )}
              </div>

              {/* Simulação do card no cardápio */}
              <div className="space-y-3">
                <div className="relative aspect-[16/10] w-full rounded-2xl overflow-hidden bg-zinc-100 dark:bg-zinc-800 border border-zinc-200/60 dark:border-zinc-700/60">
                  {currentCover ? (
                    <img
                      src={currentCover.previewUrl || currentCover.url}
                      alt={currentCover.alt || draft.name}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex flex-col items-center justify-center text-zinc-400 text-xs">
                      <span>Sem foto de capa</span>
                    </div>
                  )}

                  {/* Badge de Disponibilidade na Prévia */}
                  <div className="absolute top-2.5 left-2.5 z-10">
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold shadow-xs ${
                      draft.available
                        ? "bg-emerald-600 text-white"
                        : "bg-zinc-800/80 backdrop-blur-xs text-white"
                    }`}>
                      {draft.available ? "Disponível" : "Indisponível"}
                    </span>
                  </div>

                  {/* Selo Promocional em Destaque na Prévia */}
                  {draft.badgeText.trim() && (
                    <div className="absolute top-2.5 right-2.5 z-10 pointer-events-none">
                      <span
                        className="px-2.5 py-1 rounded-full text-[11px] font-bold tracking-wide shadow-md text-white backdrop-blur-sm"
                        style={{ backgroundColor: draft.badgeColor || "#D97706" }}
                      >
                        {draft.badgeText.trim()}
                      </span>
                    </div>
                  )}
                </div>

                <div>
                  <h4 className="font-bold text-base text-zinc-900 dark:text-white">
                    {draft.name || "Nome do produto"}
                  </h4>
                  <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">
                    {selectedCategoryName || "Categoria"}
                  </p>
                  <div className="mt-2 flex items-baseline gap-2">
                    <span className="font-bold text-base text-zinc-900 dark:text-white">
                      R$ {draft.price || "0,00"}
                    </span>
                    {draft.promoPrice && (
                      <span className="text-xs text-zinc-400 line-through">
                        R$ {draft.promoPrice}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 leading-relaxed">
                    {draft.description || "Descrição do produto..."}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}

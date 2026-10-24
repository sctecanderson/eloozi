import { useEffect, useRef, useState } from "react";

export interface ImageCropModalProps {
  isOpen: boolean;
  imageSrc: string;
  title?: string;
  subtitle?: string;
  aspectRatio: number; // e.g. 1 para quadrada (Logo), 16/6 (~2.67) para Fachada/Banner
  outputWidth: number; // e.g. 500 para logo, 1200 para fachada
  outputHeight: number; // e.g. 500 para logo, 450 para fachada
  onConfirm: (croppedFile: File) => void;
  onCancel: () => void;
}

export function ImageCropModal({
  isOpen,
  imageSrc,
  title = "Ajustar imagem",
  subtitle = "Arraste a imagem para posicionar e use o controle de zoom para enquadrar.",
  aspectRatio,
  outputWidth,
  outputHeight,
  onConfirm,
  onCancel,
}: ImageCropModalProps) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [imageLoaded, setImageLoaded] = useState(false);

  const viewportRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // Resetar zoom e pan sempre que abrir com nova imagem
  useEffect(() => {
    if (isOpen) {
      setZoom(1);
      setPan({ x: 0, y: 0 });
      setImageLoaded(false);
    }
  }, [isOpen, imageSrc]);

  // Suporte a imagem já em cache do navegador
  useEffect(() => {
    if (!isOpen) return;
    if (imgRef.current && imgRef.current.complete && imgRef.current.naturalWidth > 0) {
      setImageLoaded(true);
    }
  }, [isOpen, imageSrc]);

  // Suporte nativo não-passivo a scroll do mouse (wheel) para zoom suave
  useEffect(() => {
    const el = viewportRef.current;
    if (!isOpen || !el) return;
    const handleNativeWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = -e.deltaY * 0.0015;
      setZoom((curr) =>
        Math.min(3.0, Math.max(0.3, Number((curr + delta).toFixed(2))))
      );
    };
    el.addEventListener("wheel", handleNativeWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleNativeWheel);
  }, [isOpen]);

  if (!isOpen) return null;

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    setDragStart({ x: e.clientX, y: e.clientY });
    setPanStart({ x: pan.x, y: pan.y });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    setPan({ x: panStart.x + dx, y: panStart.y + dy });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      setIsDragging(true);
      setDragStart({ x: e.touches[0].clientX, y: e.touches[0].clientY });
      setPanStart({ x: pan.x, y: pan.y });
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!isDragging || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - dragStart.x;
    const dy = e.touches[0].clientY - dragStart.y;
    setPan({ x: panStart.x + dx, y: panStart.y + dy });
  };

  const handleTouchEnd = () => {
    setIsDragging(false);
  };

  const handleReset = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const handleSaveAndApply = () => {
    const img = imgRef.current;
    const viewport = viewportRef.current;
    if (!img || !viewport) return;

    const viewportRect = viewport.getBoundingClientRect();
    const vWidth = viewportRect.width;
    const vHeight = viewportRect.height;
    if (vWidth <= 0 || vHeight <= 0) return;

    const nWidth = img.naturalWidth;
    const nHeight = img.naturalHeight;
    if (nWidth <= 0 || nHeight <= 0) return;

    // Escala base calculada para o auto-fit (object-contain) exato no container
    const baseScale = Math.min(vWidth / nWidth, vHeight / nHeight);
    const scaleFactor = outputWidth / vWidth;

    const canvas = document.createElement("canvas");
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Suavização máxima no recorte
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    // Preenchimento de fundo:
    // Se for logo quadrada (aspectRatio 1), mantém transparente caso o usuário afaste (zoom out)
    // Se for banner retangular, preenche com preto elegante de fundo
    ctx.clearRect(0, 0, outputWidth, outputHeight);
    if (aspectRatio !== 1) {
      ctx.fillStyle = "#09090b";
      ctx.fillRect(0, 0, outputWidth, outputHeight);
    }

    // Largura e altura da imagem na escala relativa exata da prévia
    const drawW = nWidth * baseScale * zoom * scaleFactor;
    const drawH = nHeight * baseScale * zoom * scaleFactor;

    // Centro do canvas + deslocamento proporcional - metade do tamanho
    const drawX = outputWidth / 2 + pan.x * scaleFactor - drawW / 2;
    const drawY = outputHeight / 2 + pan.y * scaleFactor - drawH / 2;

    ctx.drawImage(img, drawX, drawY, drawW, drawH);

    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const croppedFile = new File([blob], `crop-${Date.now()}.webp`, {
          type: "image/webp",
        });
        onConfirm(croppedFile);
      },
      "image/webp",
      0.92
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-xs animate-in fade-in duration-200">
      <div className="bg-white dark:bg-zinc-900 rounded-3xl max-w-lg w-full p-6 border border-zinc-200 dark:border-zinc-800 shadow-2xl space-y-5 text-zinc-900 dark:text-zinc-100">
        {/* Cabeçalho */}
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-extrabold text-zinc-900 dark:text-white">
              {title}
            </h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
              {subtitle}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="w-8 h-8 rounded-full flex items-center justify-center text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            ✕
          </button>
        </div>

        {/* Área de Visualização Interativa com Máscara de Proporção */}
        <div className="flex items-center justify-center p-2 bg-zinc-950/90 rounded-2xl overflow-hidden select-none border border-zinc-800">
          <div
            ref={viewportRef}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            style={{
              aspectRatio: `${aspectRatio}`,
              maxHeight: "min(340px, 60vh)",
              maxWidth: aspectRatio === 1 ? "min(340px, 60vh)" : "100%",
              width: "100%",
            }}
            className="relative overflow-hidden rounded-xl bg-zinc-900 flex items-center justify-center cursor-grab active:cursor-grabbing border-2 border-white/40 shadow-inner"
          >
            {/* Grade de enquadramento suave (Regra dos terços) */}
            <div className="absolute inset-0 pointer-events-none grid grid-cols-3 grid-rows-3 z-10 opacity-30">
              <div className="border-r border-b border-white" />
              <div className="border-r border-b border-white" />
              <div className="border-b border-white" />
              <div className="border-r border-b border-white" />
              <div className="border-r border-b border-white" />
              <div className="border-b border-white" />
              <div className="border-r border-b border-white" />
              <div className="border-r border-b border-white" />
              <div />
            </div>

            {/* Imagem arrastável com object-contain (Auto-fit nativo imediato) e transform */}
            <img
              ref={imgRef}
              src={imageSrc}
              alt="Enquadramento"
              draggable={false}
              onLoad={(e) => {
                const target = e.currentTarget;
                if (target.naturalWidth > 0) {
                  setImageLoaded(true);
                }
              }}
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                transformOrigin: "center center",
                willChange: "transform",
              }}
              className={`w-full h-full max-w-full max-h-full object-contain absolute inset-0 pointer-events-none select-none ${
                isDragging ? "transition-none" : "transition-transform duration-100"
              }`}
            />

            {!imageLoaded && (
              <span className="text-xs text-zinc-400">Carregando imagem...</span>
            )}
          </div>
        </div>

        {/* Controle de Zoom Slider com suporte a Zoom Out (0.3x a 3.0x) e Redefinir */}
        <div className="space-y-2 px-1">
          <div className="flex items-center justify-between text-xs font-semibold text-zinc-600 dark:text-zinc-400">
            <span className="flex items-center gap-1.5">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
                <line x1="11" y1="8" x2="11" y2="14" />
                <line x1="8" y1="11" x2="14" y2="11" />
              </svg>
              <span>Nível de Zoom</span>
              <span className="font-mono text-zinc-900 dark:text-white font-bold ml-1">
                {zoom.toFixed(2)}x
              </span>
            </span>

            <button
              type="button"
              onClick={handleReset}
              className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400 hover:text-[#610000] dark:hover:text-amber-400 transition-colors flex items-center gap-1 cursor-pointer"
              title="Redefinir enquadramento (Zoom 1.0x e centralizado)"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
              <span>Redefinir enquadramento</span>
            </button>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setZoom((z) => Math.max(0.3, Number((z - 0.1).toFixed(2))))}
              className="w-7 h-7 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 font-bold text-sm flex items-center justify-center hover:bg-zinc-200 dark:hover:bg-zinc-700 cursor-pointer"
              title="Afastar (Zoom Out)"
            >
              -
            </button>
            <input
              type="range"
              min="0.3"
              max="3.0"
              step="0.05"
              value={zoom}
              onChange={(e) => setZoom(parseFloat(e.target.value))}
              className="flex-1 accent-[#610000] cursor-pointer"
            />
            <button
              type="button"
              onClick={() => setZoom((z) => Math.min(3.0, Number((z + 0.1).toFixed(2))))}
              className="w-7 h-7 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 font-bold text-sm flex items-center justify-center hover:bg-zinc-200 dark:hover:bg-zinc-700 cursor-pointer"
              title="Aproximar (Zoom In)"
            >
              +
            </button>
          </div>
        </div>

        {/* Botões de Ação */}
        <div className="flex items-center justify-end gap-3 pt-2 border-t border-zinc-100 dark:border-zinc-800">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 text-xs font-bold text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleSaveAndApply}
            className="px-5 py-2 rounded-xl bg-[#610000] hover:bg-[#4a0000] text-white text-xs font-bold transition-all shadow-md cursor-pointer flex items-center gap-2"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <span>Salvar e aplicar</span>
          </button>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { MAX_PHOTOS, preparePhoto, prepareVideo } from './menuMedia';
import type { DraftPhoto, DraftVideo } from './menuMedia';
import { formatFileSize } from './imageOptimization';

export function ProductMediaFields({
  photos,
  video,
  coverId,
  productName,
  disabled,
  onChange,
  onPreparing,
}: {
  photos: DraftPhoto[];
  video: DraftVideo | null;
  coverId: string;
  productName: string;
  disabled: boolean;
  onChange: (photos: DraftPhoto[], video: DraftVideo | null, coverId: string) => void;
  onPreparing: (preparing: boolean) => void;
}) {
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(false);
  const processing = useRef(false);
  const latest = useRef({ photos, video, coverId });
  latest.current = { photos, video, coverId };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function addPhotos(files: File[]) {
    if (processing.current || disabled || !files.length) return;
    setError('');

    if (photos.length + files.length > MAX_PHOTOS) {
      setError(`Use no máximo ${MAX_PHOTOS} fotos por produto.`);
      return;
    }

    processing.current = true;
    setPreparing(true);
    onPreparing(true);

    const prepared: DraftPhoto[] = [];
    try {
      for (const file of files) {
        prepared.push(await preparePhoto(file, `Foto de ${productName.trim() || 'produto'}`));
      }
      if (!mounted.current) {
        prepared.forEach((photo) => photo.previewUrl && URL.revokeObjectURL(photo.previewUrl));
        return;
      }
      const state = latest.current;
      onChange([...state.photos, ...prepared], state.video, state.coverId || prepared[0].id);
    } catch (cause) {
      prepared.forEach((photo) => photo.previewUrl && URL.revokeObjectURL(photo.previewUrl));
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : 'Não foi possível preparar as fotos.');
      }
    } finally {
      processing.current = false;
      if (mounted.current) {
        setPreparing(false);
        onPreparing(false);
      }
    }
  }

  async function addVideo(file: File) {
    if (processing.current || disabled) return;
    processing.current = true;
    setPreparing(true);
    onPreparing(true);
    setError('');

    try {
      const prepared = await prepareVideo(file);
      if (!mounted.current) {
        if (prepared.previewUrl) URL.revokeObjectURL(prepared.previewUrl);
        return;
      }
      const state = latest.current;
      if (state.video?.previewUrl) URL.revokeObjectURL(state.video.previewUrl);
      onChange(state.photos, prepared, state.coverId);
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : 'Não foi possível preparar o vídeo.');
      }
    } finally {
      processing.current = false;
      if (mounted.current) {
        setPreparing(false);
        onPreparing(false);
      }
    }
  }

  const locked = disabled || preparing;
  const buttonClass =
    'min-h-11 rounded-lg border border-black/20 dark:border-white/20 px-3 text-sm font-semibold hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-40 cursor-pointer';

  return (
    <div className="space-y-4 rounded-2xl border border-black/10 dark:border-white/10 bg-stone-50 dark:bg-zinc-900/60 p-4">
      <h3 className="font-semibold text-zinc-900 dark:text-white">Fotos e vídeo do produto</h3>
      <p className="text-sm opacity-75 text-zinc-600 dark:text-zinc-300">
        Escolha os arquivos agora. Eles são otimizados automaticamente no seu navegador antes do envio.
      </p>

      {/* Upload de Fotos */}
      <label className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">
        Adicionar fotos
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp,image/svg+xml"
          multiple
          disabled={locked || photos.length >= MAX_PHOTOS}
          className="mt-2 block min-h-11 w-full text-sm file:mr-3 file:rounded-lg file:border file:border-black/20 dark:file:border-white/20 file:bg-white dark:file:bg-zinc-800 file:px-3 file:py-2 cursor-pointer disabled:cursor-not-allowed"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            void addPhotos(files);
          }}
        />
      </label>
      <p className="text-xs opacity-75 text-zinc-500 dark:text-zinc-400">
        Até {MAX_PHOTOS} fotos JPG, PNG ou WebP de até 10 MB cada. Redimensionamento automático para até 1600 px (sem distorcer ou ampliar) e compressão otimizada.
      </p>

      {/* Grid de Fotos */}
      {photos.length > 0 && (
        <ul className="grid gap-3 sm:grid-cols-2">
          {photos.map((photo, index) => (
            <li
              key={photo.id}
              className="space-y-2 rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-zinc-800/80 p-3"
            >
              <div className="relative aspect-[4/3] w-full rounded-lg overflow-hidden bg-zinc-100 dark:bg-zinc-900">
                <img
                  src={photo.previewUrl || photo.url}
                  alt={photo.alt}
                  className="w-full h-full object-cover"
                />
                {photo.optimizedSize && photo.originalSize && photo.savingsPercent !== undefined && photo.savingsPercent > 0 && (
                  <span className="absolute bottom-2 left-2 px-2 py-0.5 rounded-md bg-black/75 backdrop-blur-xs text-[10px] font-bold text-emerald-300">
                    {formatFileSize(photo.originalSize)} → {formatFileSize(photo.optimizedSize)} (-{photo.savingsPercent}%)
                  </span>
                )}
              </div>

              <label className="flex min-h-11 items-center gap-2 text-sm text-zinc-800 dark:text-zinc-200 cursor-pointer">
                <input
                  type="radio"
                  name="product-cover"
                  checked={coverId === photo.id}
                  disabled={locked}
                  onChange={() => onChange(photos, video, photo.id)}
                  className="cursor-pointer text-[#610000] focus:ring-[#610000]"
                />
                {coverId === photo.id ? (
                  <strong className="text-emerald-700 dark:text-emerald-400">Foto de capa principal</strong>
                ) : (
                  'Usar como capa'
                )}
              </label>

              <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300">
                Descrição da foto {index + 1}
                <input
                  required
                  maxLength={240}
                  value={photo.alt}
                  disabled={locked}
                  className="mt-1 min-h-11 w-full rounded-lg border border-black/20 dark:border-white/20 bg-transparent px-2.5 text-sm"
                  onChange={(event) =>
                    onChange(
                      photos.map((item) =>
                        item.id === photo.id ? { ...item, alt: event.target.value } : item
                      ),
                      video,
                      coverId
                    )
                  }
                />
              </label>

              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  type="button"
                  className={buttonClass}
                  disabled={locked || index === 0}
                  aria-label={`Mover foto ${index + 1} para antes`}
                  onClick={() => {
                    const reordered = [...photos];
                    [reordered[index - 1], reordered[index]] = [reordered[index], reordered[index - 1]];
                    onChange(reordered, video, coverId);
                  }}
                >
                  ←
                </button>
                <button
                  type="button"
                  className={buttonClass}
                  disabled={locked || index === photos.length - 1}
                  aria-label={`Mover foto ${index + 1} para depois`}
                  onClick={() => {
                    const reordered = [...photos];
                    [reordered[index + 1], reordered[index]] = [reordered[index], reordered[index + 1]];
                    onChange(reordered, video, coverId);
                  }}
                >
                  →
                </button>
                <button
                  type="button"
                  className={`${buttonClass} text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40`}
                  disabled={locked}
                  aria-label={`Remover foto ${index + 1}`}
                  onClick={() => {
                    const next = photos.filter((item) => item.id !== photo.id);
                    if (photo.previewUrl) URL.revokeObjectURL(photo.previewUrl);
                    onChange(next, video, coverId === photo.id ? next[0]?.id ?? '' : coverId);
                  }}
                >
                  Remover
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Upload de Vídeo */}
      <div className="border-t border-black/10 dark:border-white/10 pt-4">
        <label className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">
          Vídeo para o Explorar
          <input
            type="file"
            accept="video/mp4,video/webm"
            disabled={locked}
            className="mt-2 block min-h-11 w-full text-sm file:mr-3 file:rounded-lg file:border file:border-black/20 dark:file:border-white/20 file:bg-white dark:file:bg-zinc-800 file:px-3 file:py-2 cursor-pointer disabled:cursor-not-allowed"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void addVideo(file);
            }}
          />
        </label>
        <p className="text-xs opacity-75 text-zinc-500 dark:text-zinc-400 mt-1">
          Vídeo de até <strong>10 segundos</strong> e <strong>20 MB</strong>. Prefira formato MP4 (H.264) em 720p ou WebM. A transcodificação pesada no cliente não é suportada — envie o vídeo já editado na duração adequada.
        </p>

        {video && (
          <div className="mt-3 space-y-2">
            <video
              key={video.previewUrl || video.url}
              src={video.previewUrl || video.url}
              poster={
                photos.find((photo) => photo.id === coverId)?.previewUrl ||
                photos.find((photo) => photo.id === coverId)?.url
              }
              controls
              playsInline
              muted
              preload="metadata"
              aria-label="Prévia do vídeo do produto"
              className="max-h-80 w-full rounded-xl bg-black"
            />
            {video.durationSeconds && (
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Duração validada: <strong>{video.durationSeconds.toFixed(1)}s</strong>
              </p>
            )}
            <button
              type="button"
              className={`${buttonClass} text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40`}
              disabled={locked}
              onClick={() => {
                if (video.previewUrl) URL.revokeObjectURL(video.previewUrl);
                onChange(photos, null, coverId);
              }}
            >
              Remover vídeo
            </button>
          </div>
        )}
      </div>

      {preparing && (
        <div className="flex items-center gap-2 p-3 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-700 text-xs font-semibold text-amber-800 dark:text-amber-200 animate-pulse">
          <svg className="w-4 h-4 animate-spin shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="12" />
          </svg>
          <span>Otimizando e preparando mídia… Aguarde para salvar.</span>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-300 dark:border-rose-700 text-xs font-semibold text-rose-800 dark:text-rose-200" role="alert">
          <svg className="w-4 h-4 shrink-0 text-rose-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}

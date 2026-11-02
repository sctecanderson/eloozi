import { supabase } from '../../lib/supabase';
import type { ProductImage, ProductVideo } from '../../types/menu';
import { optimizeImage, type OptimizeImageOptions } from './imageOptimization';

export interface AdminImage extends ProductImage {
  storagePath?: string;
}

export interface AdminVideo extends ProductVideo {
  storagePath?: string;
  durationSeconds?: number;
}

export interface DraftPhoto extends AdminImage {
  file?: Blob | File;
  previewUrl?: string;
  originalSize?: number;
  optimizedSize?: number;
  savingsPercent?: number;
  mimeType?: string;
}

export interface DraftVideo extends AdminVideo {
  file?: File;
  previewUrl?: string;
  uploadId?: string;
}

export const MAX_PHOTOS = 6;
export const MAX_IMAGE_INPUT = 10 * 1024 * 1024;
export const MAX_VIDEO_SIZE = 20 * 1024 * 1024; // Limite de 20 MB para vídeos

export const MAX_VIDEO_DURATION_SECONDS = 10.5;

export interface VideoDurationValidation {
  valid: boolean;
  error?: string;
}

export function validateVideoDuration(duration: unknown): VideoDurationValidation {
  if (typeof duration !== 'number' || Number.isNaN(duration) || !Number.isFinite(duration) || duration <= 0) {
    return {
      valid: false,
      error: 'Não foi possível identificar a duração do vídeo. Verifique se o arquivo não está corrompido.',
    };
  }
  if (duration > MAX_VIDEO_DURATION_SECONDS) {
    return {
      valid: false,
      error: `O vídeo deve ter no máximo 10 segundos (duração atual: ${duration.toFixed(1).replace('.', ',')}s). Encurte o vídeo antes de enviar.`,
    };
  }
  return { valid: true };
}

export async function preparePhoto(
  file: File,
  alt: string,
  kind: OptimizeImageOptions['kind'] = 'product'
): Promise<DraftPhoto> {
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'];
  if (!allowedTypes.includes(file.type)) {
    throw new Error('Use uma foto JPG, PNG ou WebP.');
  }
  if (!file.size || file.size > MAX_IMAGE_INPUT) {
    throw new Error('Cada foto deve ter no máximo 10 MB.');
  }

  const result = await optimizeImage(file, {
    kind,
    maxInputBytes: MAX_IMAGE_INPUT,
    allowedMimes: allowedTypes,
  });

  return {
    id: crypto.randomUUID(),
    url: '',
    alt: alt.trim().slice(0, 240) || 'Foto do produto',
    sortOrder: 0,
    file: result.file,
    previewUrl: result.previewUrl,
    originalSize: result.originalSize,
    optimizedSize: result.optimizedSize,
    savingsPercent: result.savingsPercent,
    mimeType: result.mimeType,
  };
}

export async function prepareVideo(file: File): Promise<DraftVideo> {
  const allowedMime = ['video/mp4', 'video/webm'];
  if (!allowedMime.includes(file.type)) {
    throw new Error('Formato inválido. Use vídeo MP4 (H.264) ou WebM.');
  }
  if (!file.size || file.size > MAX_VIDEO_SIZE) {
    throw new Error('O vídeo deve ter no máximo 20 MB.');
  }

  const previewUrl = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  video.playsInline = true;

  try {
    const duration = await new Promise<number>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        clear();
        reject(new Error('Tempo esgotado ao validar o vídeo. Certifique-se de usar MP4 H.264 válido.'));
      }, 15_000);

      function clear() {
        window.clearTimeout(timer);
        video.onloadedmetadata = null;
        video.onerror = null;
      }

      video.onloadedmetadata = () => {
        clear();
        resolve(video.duration);
      };

      video.onerror = () => {
        clear();
        reject(new Error('Este vídeo não pôde ser reproduzido ou o formato é incompatível. Tente MP4 H.264.'));
      };

      video.src = previewUrl;
    });

    const check = validateVideoDuration(duration);
    if (!check.valid) {
      throw new Error(check.error);
    }

    return {
      url: '',
      mimeType: file.type as AdminVideo['mimeType'],
      file,
      previewUrl,
      uploadId: crypto.randomUUID(),
      durationSeconds: duration,
    };
  } catch (cause) {
    URL.revokeObjectURL(previewUrl);
    throw cause;
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

export async function uploadMenuMedia(
  photos: DraftPhoto[],
  video: DraftVideo | null,
  restaurantId: string,
  productId: string,
  cache: Map<string, string>,
  onProgress: (message: string) => void,
) {
  async function upload(bucket: string, path: string, file: Blob, contentType: string) {
    const key = `${bucket}:${path}`;
    const cached = cache.get(key);
    if (cached) return cached;

    const store = supabase.storage.from(bucket);
    const { error } = await store.upload(path, file, { contentType, cacheControl: '31536000', upsert: false });
    if (error) {
      // O upload pode ter terminado, mas sua resposta ter sido perdida. Arquivos têm nomes imutáveis.
      const slash = path.lastIndexOf('/');
      const { data, error: listError } = await store.list(path.slice(0, slash), {
        search: path.slice(slash + 1),
        limit: 10,
      });
      if (listError || !data?.some((object) => object.name === path.slice(slash + 1))) {
        throw new Error('Não foi possível enviar a mídia. Confira a conexão, a migração de Storage e o perfil de administrador.');
      }
    }
    const { data } = store.getPublicUrl(path);
    cache.set(key, data.publicUrl);
    return data.publicUrl;
  }

  const images: AdminImage[] = [];
  for (let index = 0; index < photos.length; index++) {
    const photo = photos[index];
    let url = photo.url;
    let storagePath = photo.storagePath;

    if (photo.file) {
      onProgress(`Enviando foto ${index + 1} de ${photos.length}…`);
      const ext = photo.mimeType === 'image/svg+xml' ? 'svg' : photo.mimeType === 'image/png' ? 'png' : 'webp';
      const cType = photo.mimeType || 'image/webp';
      storagePath = `${restaurantId}/products/${productId}/${photo.id}.${ext}`;
      url = await upload('menu-images', storagePath, photo.file, cType);
    }

    images.push({
      id: photo.id,
      url,
      alt: photo.alt.trim(),
      sortOrder: index + 1,
      ...(storagePath ? { storagePath } : {}),
    });
  }

  let savedVideo: AdminVideo | null = null;
  if (video) {
    let url = video.url;
    let storagePath = video.storagePath;

    if (video.file) {
      onProgress('Enviando vídeo…');
      const extension = video.mimeType === 'video/mp4' ? 'mp4' : 'webm';
      storagePath = `${restaurantId}/products/${productId}/${video.uploadId}.${extension}`;
      url = await upload('menu-videos', storagePath, video.file, video.mimeType);
    }

    savedVideo = {
      url,
      mimeType: video.mimeType,
      ...(storagePath ? { storagePath } : {}),
      ...(video.durationSeconds != null ? { durationSeconds: video.durationSeconds } : {}),
    };
  }

  return { images, video: savedVideo };
}

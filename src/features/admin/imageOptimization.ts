/**
 * Rotina compartilhada de otimização de imagens no cliente (Eloozi).
 * 
 * Regras:
 * - Não amplia imagens menores que a dimensão máxima recomendada.
 * - Limite máx. 1600px no maior lado para fotos de produtos, 400px para logos/avatares, 1400px para banners.
 * - Converte para WebP quando suportado, com alvo de 150–350 KB mantendo alta fidelidade visual.
 * - Para destinos exclusivos de WebP (`forceWebP: true`):
 *   - Não aceita formatos vetoriais (SVG) ou animações (GIF), pois os buckets remotos possuem suporte estrito a WebP.
 *   - Nunca envia originais PNG/JPEG incompatíveis, mesmo quando a conversão WebP ficar maior que o arquivo original comprimido.
 *   - Garante que a saída WebP respeite o teto de 2 MB do bucket remoto (`maxOutputBytes`).
 * - Para outros destinos:
 *   - Nunca gera arquivo maior que o original (se o comprimido for maior, preserva o original se compatível).
 * - Preserva transparência (canal alfa) na codificação WebP/PNG.
 * - Rejeita arquivos corrompidos, vazios, que excedam os limites de tamanho ou formatos incompatíveis com erro claro em português.
 */

export interface OptimizeImageOptions {
  kind?: 'product' | 'logo' | 'cover' | 'avatar';
  maxSide?: number;
  targetMinBytes?: number;
  targetMaxBytes?: number;
  initialQuality?: number;
  preserveTransparency?: boolean;
  maxInputBytes?: number;
  maxOutputBytes?: number;
  allowedMimes?: string[];
  forceWebP?: boolean;
}

export interface OptimizedImageResult {
  file: Blob | File;
  previewUrl: string;
  width: number;
  height: number;
  originalSize: number;
  optimizedSize: number;
  mimeType: string;
  extension: string;
  isOptimized: boolean;
  savingsPercent: number;
}

export const DEFAULT_MAX_SIDE: Record<NonNullable<OptimizeImageOptions['kind']>, number> = {
  product: 1600,
  logo: 400,
  avatar: 400,
  cover: 1400,
};

export const DEFAULT_MAX_INPUT_BYTES = 10 * 1024 * 1024; // 10 MB
export const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024; // 2 MB (teto do bucket menu-images e restaurant-images)
export const TARGET_MIN_BYTES = 150 * 1024; // ~150 KB
export const TARGET_MAX_BYTES = 350 * 1024; // ~350 KB

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Detecta se o arquivo é um SVG vetorial
 */
export function isSvgFile(file: File): boolean {
  return file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg');
}

/**
 * Detecta se o arquivo é um GIF (pode conter animação)
 */
export function isGifFile(file: File): boolean {
  return file.type === 'image/gif' || file.name.toLowerCase().endsWith('.gif');
}

/**
 * Otimiza uma foto no cliente antes do envio ao Supabase Storage.
 */
export async function optimizeImage(
  file: File,
  options: OptimizeImageOptions = {}
): Promise<OptimizedImageResult> {
  // 1. Validação estrita de presença e arquivo não-vazio
  if (!file || typeof file.size !== 'number') {
    throw new Error('Arquivo de imagem inválido ou vazio.');
  }

  if (file.size <= 0) {
    throw new Error('O arquivo de imagem selecionado está vazio (0 bytes).');
  }

  // 2. Validação estrita de teto de entrada (NENHUM arquivo pode contornar)
  const maxInput = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
  if (file.size > maxInput) {
    throw new Error(
      `A imagem excede o limite permitido de ${formatFileSize(maxInput)} (tamanho atual: ${formatFileSize(file.size)}).`
    );
  }

  const kind = options.kind || 'product';
  const forceWebP = options.forceWebP ?? false;
  const isSvg = isSvgFile(file);
  const isGif = isGifFile(file);

  // 3. Validação de destinos exclusivos de WebP (menu-images e restaurant-images)
  if (forceWebP) {
    if (isSvg) {
      throw new Error(
        'Formato vetorial SVG não é aceito neste campo. O armazenamento remoto requer imagens raster (JPG, PNG ou WebP).'
      );
    }
    if (isGif) {
      throw new Error(
        'Formato animado GIF não é aceito neste campo. O armazenamento remoto requer imagens raster (JPG, PNG ou WebP).'
      );
    }
  }

  const defaultAllowedMimes = forceWebP
    ? ['image/jpeg', 'image/png', 'image/webp', 'image/avif']
    : ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/svg+xml', 'image/gif'];
  const allowedMimes = options.allowedMimes ?? defaultAllowedMimes;

  // 4. Validação de formato permitido
  if (isSvg && !allowedMimes.includes('image/svg+xml')) {
    throw new Error('Imagens em formato vetorial SVG não são permitidas para este campo.');
  }
  if (isGif && !allowedMimes.includes('image/gif')) {
    throw new Error('Imagens animadas em GIF não são permitidas para este campo.');
  }
  if (!isSvg && !isGif) {
    const fileMime = file.type || '';
    if (!fileMime || !allowedMimes.includes(fileMime)) {
      throw new Error('Formato de imagem não suportado. Use JPG, PNG ou WebP.');
    }
  }

  // 5. Preservar SVGs sem conversão gráfica se o destino expressamente permitir
  if (isSvg && !forceWebP) {
    return {
      file,
      previewUrl: URL.createObjectURL(file),
      width: 0,
      height: 0,
      originalSize: file.size,
      optimizedSize: file.size,
      mimeType: 'image/svg+xml',
      extension: 'svg',
      isOptimized: false,
      savingsPercent: 0,
    };
  }

  // 6. Preservar GIFs animados sem alteração por Canvas se o destino expressamente permitir
  if (isGif && !forceWebP) {
    return {
      file,
      previewUrl: URL.createObjectURL(file),
      width: 0,
      height: 0,
      originalSize: file.size,
      optimizedSize: file.size,
      mimeType: 'image/gif',
      extension: 'gif',
      isOptimized: false,
      savingsPercent: 0,
    };
  }

  const maxSide = options.maxSide || DEFAULT_MAX_SIDE[kind];
  const targetMax = options.targetMaxBytes || TARGET_MAX_BYTES;
  const maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const baseQuality = options.initialQuality ?? (kind === 'logo' || kind === 'avatar' ? 0.90 : 0.82);

  // 7. Decodificar a imagem de forma segura no navegador
  let bitmap: ImageBitmap | HTMLImageElement;
  let objectUrl: string | null = null;

  try {
    if (typeof createImageBitmap === 'function') {
      bitmap = await createImageBitmap(file);
    } else {
      objectUrl = URL.createObjectURL(file);
      bitmap = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Imagem inválida ou corrompida.'));
        img.src = objectUrl!;
      });
    }
  } catch (err) {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    throw new Error(
      err instanceof Error && err.message.includes('inválida')
        ? err.message
        : 'Não foi possível decodificar esta imagem. Tente outro arquivo.'
    );
  }

  try {
    const origWidth = bitmap.width;
    const origHeight = bitmap.height;

    if (!origWidth || !origHeight) {
      throw new Error('Dimensões da imagem inválidas.');
    }

    if (origWidth * origHeight > 40_000_000) {
      throw new Error('A resolução da imagem é excessiva. Use uma imagem com menos de 40 megapixels.');
    }

    // 8. Calcular redimensionamento: NÃO ampliar imagens menores!
    const longestSide = Math.max(origWidth, origHeight);
    const scale = longestSide > maxSide ? maxSide / longestSide : 1; // Nunca amplia se scale >= 1

    const finalWidth = Math.max(1, Math.round(origWidth * scale));
    const finalHeight = Math.max(1, Math.round(origHeight * scale));

    // 9. Renderizar no Canvas com preservação de alfa
    const canvas = document.createElement('canvas');
    canvas.width = finalWidth;
    canvas.height = finalHeight;

    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) {
      throw new Error('Seu navegador não suporta renderização em Canvas.');
    }

    ctx.clearRect(0, 0, finalWidth, finalHeight);
    ctx.drawImage(bitmap, 0, 0, finalWidth, finalHeight);

    // 10. Exportação para WebP
    const exportToBlob = (type: string, q: number): Promise<Blob | null> => {
      return new Promise((resolve) => {
        canvas.toBlob((b) => resolve(b), type, q);
      });
    };

    let selectedQuality = baseQuality;
    let blob = await exportToBlob('image/webp', selectedQuality);
    let outputMime = 'image/webp';
    let outputExt = 'webp';

    // Se o ambiente não exportar WebP:
    if (!blob || blob.type !== 'image/webp') {
      if (forceWebP) {
        throw new Error(
          'Seu navegador não suporta exportação direta para WebP, exigida pelo armazenamento do cardápio. Atualize seu navegador ou tente outro dispositivo.'
        );
      }
      const isPng = file.type === 'image/png';
      outputMime = isPng ? 'image/png' : 'image/jpeg';
      outputExt = isPng ? 'png' : 'jpg';
      blob = await exportToBlob(outputMime, selectedQuality);
    }

    if (!blob) {
      throw new Error('Não foi possível gerar a versão otimizada da imagem.');
    }

    // Ajuste fino para atingir a faixa alvo se tiver ficado acima de 350 KB
    if (blob.size > targetMax) {
      const candidateQuality = Math.max(0.68, selectedQuality - 0.12);
      const smallerBlob = await exportToBlob(outputMime, candidateQuality);
      if (smallerBlob && smallerBlob.size < blob.size) {
        blob = smallerBlob;
        selectedQuality = candidateQuality;
      }
    }

    // Se ainda exceder o limite final do bucket remoto (2 MB), tentar compressão adicional
    if (blob.size > maxOutput) {
      const aggressiveQuality = 0.50;
      const minimalBlob = await exportToBlob(outputMime, aggressiveQuality);
      if (minimalBlob && minimalBlob.size <= maxOutput) {
        blob = minimalBlob;
      } else {
        throw new Error(
          `A imagem otimizada (${formatFileSize(blob.size)}) excede o limite máximo de ${formatFileSize(maxOutput)} aceito pelo servidor. Reduza a resolução da foto antes de enviar.`
        );
      }
    }

    // 11. REGRA CRÍTICA DE RETENÇÃO DO ORIGINAL
    let finalFile: Blob | File;
    let finalSize: number;
    let isOptimized = true;

    if (forceWebP) {
      // Para buckets exclusivos de WebP:
      // Se a imagem original JÁ for WebP e for menor que o reprocessado, podemos manter o original
      if (file.type === 'image/webp' && file.size <= blob.size && file.size <= maxOutput) {
        finalFile = file;
        finalSize = file.size;
        isOptimized = false;
      } else {
        // Se a imagem original for PNG ou JPEG, NUNCA podemos enviar o original incompatível!
        // Devemos SEMPRE enviar o WebP gerado.
        finalFile = blob;
        finalSize = blob.size;
        outputMime = 'image/webp';
        outputExt = 'webp';
      }
    } else {
      // Para destinos não-exclusivos:
      if (blob.size < file.size) {
        finalFile = blob;
        finalSize = blob.size;
      } else {
        finalFile = file;
        finalSize = file.size;
        outputMime = file.type;
        outputExt = file.name.split('.').pop() || outputExt;
        isOptimized = false;
      }
    }

    const savings = file.size > finalSize ? Math.round(((file.size - finalSize) / file.size) * 100) : 0;
    const previewUrl = URL.createObjectURL(finalFile);

    return {
      file: finalFile,
      previewUrl,
      width: finalWidth,
      height: finalHeight,
      originalSize: file.size,
      optimizedSize: finalSize,
      mimeType: outputMime,
      extension: outputExt,
      isOptimized,
      savingsPercent: savings,
    };
  } finally {
    if ('close' in bitmap) {
      bitmap.close();
    }
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
    }
  }
}

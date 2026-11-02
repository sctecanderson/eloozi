/**
 * Rotina compartilhada de otimização de imagens no cliente (Eloozi).
 * 
 * Regras:
 * - Não amplia imagens menores que a dimensão máxima recomendada.
 * - Limite máx. 1600px no maior lado para fotos de produtos, 400px para logos/avatares, 1400px para banners.
 * - Converte para WebP quando suportado, com alvo de 150–350 KB mantendo alta fidelidade visual.
 * - Nunca gera arquivo maior que o original (se o comprimido for maior, preserva o original).
 * - Preserva transparência (PNG/WebP).
 * - Arquivos SVG e GIFs animados respeitam estritamente limites de entrada e formatos permitidos,
 *   sendo preservados sem conversão destrutiva quando aprovados.
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
  allowedMimes?: string[];
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

  // 2. Validação estrita de teto de entrada (NENHUM arquivo, inclusive SVG, GIF ou original mantido, pode contornar)
  const maxInput = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
  if (file.size > maxInput) {
    throw new Error(
      `A imagem excede o limite permitido de ${formatFileSize(maxInput)} (tamanho atual: ${formatFileSize(file.size)}).`
    );
  }

  const kind = options.kind || 'product';
  const defaultAllowedMimes = [
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/avif',
    'image/svg+xml',
    'image/gif',
  ];
  const allowedMimes = options.allowedMimes ?? defaultAllowedMimes;
  const isSvg = isSvgFile(file);
  const isGif = isGifFile(file);

  // 3. Validação de formato permitido
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

  // 4. Preservar SVGs sem conversão gráfica, validando segurança do conteúdo
  if (isSvg) {
    try {
      if (typeof file.text === 'function') {
        const text = await file.text();
        if (/<script[\s>]/i.test(text) || /javascript:/i.test(text)) {
          throw new Error('Arquivo SVG rejeitado: contém scripts potencialmente inseguros.');
        }
      }
    } catch (cause) {
      if (cause instanceof Error && cause.message.includes('rejeitado')) throw cause;
    }

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

  // 5. Preservar GIFs animados sem alteração por Canvas para evitar perda de quadros
  if (isGif) {
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
  const baseQuality = options.initialQuality ?? (kind === 'logo' || kind === 'avatar' ? 0.90 : 0.82);

  // 6. Decodificar a imagem de forma segura
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

    // 7. Calcular redimensionamento: NÃO ampliar imagens menores!
    const longestSide = Math.max(origWidth, origHeight);
    const scale = longestSide > maxSide ? maxSide / longestSide : 1; // Nunca amplia se scale >= 1

    const finalWidth = Math.max(1, Math.round(origWidth * scale));
    const finalHeight = Math.max(1, Math.round(origHeight * scale));

    // 8. Renderizar no Canvas
    const canvas = document.createElement('canvas');
    canvas.width = finalWidth;
    canvas.height = finalHeight;

    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) {
      throw new Error('Seu navegador não suporta renderização em Canvas.');
    }

    // Limpar fundo para preservar canal alfa / transparência
    ctx.clearRect(0, 0, finalWidth, finalHeight);
    ctx.drawImage(bitmap, 0, 0, finalWidth, finalHeight);

    // 9. Testar suporte ao WebP e tentar atingir a faixa alvo (150–350 KB)
    let bestBlob: Blob | null = null;
    let selectedQuality = baseQuality;

    const exportToBlob = (type: string, q: number): Promise<Blob | null> => {
      return new Promise((resolve) => {
        canvas.toBlob((blob) => resolve(blob), type, q);
      });
    };

    // Tentar primeiro com WebP
    let blob = await exportToBlob('image/webp', selectedQuality);
    let outputMime = 'image/webp';
    let outputExt = 'webp';

    // Se o navegador não suportar exportação para WebP, faz fallback para PNG (se transparente) ou JPEG
    if (!blob || blob.type !== 'image/webp') {
      const isPng = file.type === 'image/png';
      outputMime = isPng ? 'image/png' : 'image/jpeg';
      outputExt = isPng ? 'png' : 'jpg';
      blob = await exportToBlob(outputMime, selectedQuality);
    }

    if (blob) {
      bestBlob = blob;

      // Se o tamanho ficou acima do teto de 350 KB e a imagem foi comprimida em WebP/JPEG,
      // fazer um ajuste fino de qualidade sem sacrificar a estética
      if (blob.size > targetMax && (outputMime === 'image/webp' || outputMime === 'image/jpeg')) {
        const candidateQuality = Math.max(0.68, selectedQuality - 0.12);
        const smallerBlob = await exportToBlob(outputMime, candidateQuality);
        if (smallerBlob && smallerBlob.size < blob.size) {
          bestBlob = smallerBlob;
          selectedQuality = candidateQuality;
        }
      }
    }

    // 10. REGRA CRÍTICA: Nunca gerar arquivo maior que o original!
    let finalFile: Blob | File;
    let finalSize: number;
    let isOptimized = true;

    if (bestBlob && bestBlob.size < file.size) {
      finalFile = bestBlob;
      finalSize = bestBlob.size;
    } else {
      // O original já é mais leve ou a conversão aumentou o tamanho.
      // O original já foi validado contra limites de tamanho, formato e dimensões.
      finalFile = file;
      finalSize = file.size;
      outputMime = file.type;
      outputExt = file.name.split('.').pop() || outputExt;
      isOptimized = false;
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

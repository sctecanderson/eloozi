import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_VIDEO_SIZE,
  MAX_IMAGE_INPUT,
  MAX_PHOTOS,
  MAX_VIDEO_DURATION_SECONDS,
  validateVideoDuration,
  preparePhoto,
} from '../src/features/admin/menuMedia.ts';
import {
  isSvgFile,
  isGifFile,
  formatFileSize,
  optimizeImage,
  DEFAULT_MAX_INPUT_BYTES,
  DEFAULT_MAX_OUTPUT_BYTES,
} from '../src/features/admin/imageOptimization.ts';

describe('Validação e Otimização de Mídias (Menu e Identidade)', () => {
  it('limite de vídeo é alinhado temporariamente com o teto remoto confirmado de 12 MB', () => {
    assert.equal(MAX_VIDEO_SIZE, 12 * 1024 * 1024);
  });

  it('limite de imagem de entrada é 10 MB', () => {
    assert.equal(MAX_IMAGE_INPUT, 10 * 1024 * 1024);
    assert.equal(DEFAULT_MAX_INPUT_BYTES, 10 * 1024 * 1024);
  });

  it('limite máximo de saída para buckets remotos exclusivos é 2 MB', () => {
    assert.equal(DEFAULT_MAX_OUTPUT_BYTES, 2 * 1024 * 1024);
  });

  it('máximo de fotos por produto é 6', () => {
    assert.equal(MAX_PHOTOS, 6);
  });

  it('detecta arquivos SVG corretamente', () => {
    const svgFileByName = { name: 'logo.svg', type: 'image/svg+xml' } as File;
    const svgFileAltType = { name: 'vector.svg', type: '' } as File;
    const pngFile = { name: 'photo.png', type: 'image/png' } as File;

    assert.equal(isSvgFile(svgFileByName), true);
    assert.equal(isSvgFile(svgFileAltType), true);
    assert.equal(isSvgFile(pngFile), false);
  });

  it('detecta arquivos GIF corretamente', () => {
    const gifFile = { name: 'animated.gif', type: 'image/gif' } as File;
    const jpgFile = { name: 'dish.jpg', type: 'image/jpeg' } as File;

    assert.equal(isGifFile(gifFile), true);
    assert.equal(isGifFile(jpgFile), false);
  });

  it('formatação amigável de tamanho de arquivo', () => {
    assert.equal(formatFileSize(500), '500 B');
    assert.equal(formatFileSize(250 * 1024), '250.0 KB');
    assert.equal(formatFileSize(2.5 * 1024 * 1024), '2.5 MB');
    assert.equal(formatFileSize(12 * 1024 * 1024), '12.0 MB');
  });

  describe('Validação de Duração de Vídeos (tolerância máxima 10,5s)', () => {
    it('tolerância máxima de duração é 10.5 segundos', () => {
      assert.equal(MAX_VIDEO_DURATION_SECONDS, 10.5);
    });

    it('aceita vídeos dentro do limite (ex: 5s, 9.9s, 10.0s)', () => {
      assert.equal(validateVideoDuration(5.0).valid, true);
      assert.equal(validateVideoDuration(9.9).valid, true);
      assert.equal(validateVideoDuration(10.0).valid, true);
    });

    it('aceita vídeos na margem de tolerância de até 10.5s', () => {
      assert.equal(validateVideoDuration(10.2).valid, true);
      assert.equal(validateVideoDuration(10.5).valid, true);
      assert.equal(validateVideoDuration(10.5000).valid, true);
    });

    it('rejeita vídeos acima de 10.5s', () => {
      const res10_51 = validateVideoDuration(10.51);
      assert.equal(res10_51.valid, false);
      assert.match(res10_51.error || '', /no máximo 10 segundos/);

      const res11 = validateVideoDuration(11.0);
      assert.equal(res11.valid, false);
      assert.match(res11.error || '', /no máximo 10 segundos/);

      const res60 = validateVideoDuration(60.0);
      assert.equal(res60.valid, false);
    });

    it('rejeita duração zero ou negativa', () => {
      assert.equal(validateVideoDuration(0).valid, false);
      assert.equal(validateVideoDuration(-0.1).valid, false);
      assert.equal(validateVideoDuration(-10).valid, false);
    });

    it('rejeita valores não numéricos, NaN ou infinitos', () => {
      assert.equal(validateVideoDuration(Number.NaN).valid, false);
      assert.equal(validateVideoDuration(Number.POSITIVE_INFINITY).valid, false);
      assert.equal(validateVideoDuration(Number.NEGATIVE_INFINITY).valid, false);
      assert.equal(validateVideoDuration(undefined).valid, false);
      assert.equal(validateVideoDuration(null).valid, false);
      assert.equal(validateVideoDuration('10' as any).valid, false);
    });
  });

  describe('Compatibilidade Estrita com Buckets Exclusivos de WebP', () => {
    it('preparePhoto rejeita SVG em campos de cardápio e identidade', async () => {
      const svg = { name: 'logo.svg', size: 1024, type: 'image/svg+xml' } as File;
      await assert.rejects(
        () => preparePhoto(svg, 'Logo'),
        /Formatos vetoriais \(SVG\) e animações \(GIF\) não são suportados/
      );
    });

    it('preparePhoto rejeita GIF em campos de cardápio e identidade', async () => {
      const gif = { name: 'dish.gif', size: 1024, type: 'image/gif' } as File;
      await assert.rejects(
        () => preparePhoto(gif, 'Prato'),
        /Formatos vetoriais \(SVG\) e animações \(GIF\) não são suportados/
      );
    });

    it('optimizeImage com forceWebP rejeita explicitamente SVG', async () => {
      const svg = { name: 'icon.svg', size: 2048, type: 'image/svg+xml' } as File;
      await assert.rejects(
        () => optimizeImage(svg, { forceWebP: true }),
        /Formato vetorial SVG não é aceito neste campo/
      );
    });

    it('optimizeImage com forceWebP rejeita explicitamente GIF', async () => {
      const gif = { name: 'anim.gif', size: 2048, type: 'image/gif' } as File;
      await assert.rejects(
        () => optimizeImage(gif, { forceWebP: true }),
        /Formato animado GIF não é aceito neste campo/
      );
    });

    it('rejeita arquivo vazio (0 bytes)', async () => {
      const emptyFile = { name: 'empty.jpg', size: 0, type: 'image/jpeg' } as File;
      await assert.rejects(
        () => optimizeImage(emptyFile),
        /vazio/
      );
    });

    it('rejeita arquivo que exceda o limite de entrada (não permite contornar)', async () => {
      const hugeFile = {
        name: 'huge.jpg',
        size: 15 * 1024 * 1024, // 15 MB
        type: 'image/jpeg',
      } as File;

      await assert.rejects(
        () => optimizeImage(hugeFile, { maxInputBytes: 10 * 1024 * 1024 }),
        /excede o limite permitido/
      );
    });
  });
});

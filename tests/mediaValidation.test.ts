import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_VIDEO_SIZE, MAX_IMAGE_INPUT, MAX_PHOTOS } from '../src/features/admin/menuMedia.ts';
import { isSvgFile, isGifFile, formatFileSize } from '../src/features/admin/imageOptimization.ts';

describe('Validação e Otimização de Mídias (Menu e Identidade)', () => {
  it('limite de vídeo é exatamente 20 MB', () => {
    assert.equal(MAX_VIDEO_SIZE, 20 * 1024 * 1024);
  });

  it('limite de imagem de entrada é 10 MB', () => {
    assert.equal(MAX_IMAGE_INPUT, 10 * 1024 * 1024);
  });

  it('máximo de fotos por produto é 6', () => {
    assert.equal(MAX_PHOTOS, 6);
  });

  it('detecta arquivos SVG corretamente sem conversão raster', () => {
    const svgFileByName = { name: 'logo.svg', type: 'image/svg+xml' } as File;
    const svgFileAltType = { name: 'vector.svg', type: '' } as File;
    const pngFile = { name: 'photo.png', type: 'image/png' } as File;

    assert.equal(isSvgFile(svgFileByName), true);
    assert.equal(isSvgFile(svgFileAltType), true);
    assert.equal(isSvgFile(pngFile), false);
  });

  it('detecta arquivos GIF para preservar possíveis animações', () => {
    const gifFile = { name: 'animated.gif', type: 'image/gif' } as File;
    const jpgFile = { name: 'dish.jpg', type: 'image/jpeg' } as File;

    assert.equal(isGifFile(gifFile), true);
    assert.equal(isGifFile(jpgFile), false);
  });

  it('formatação amigável de tamanho de arquivo', () => {
    assert.equal(formatFileSize(500), '500 B');
    assert.equal(formatFileSize(250 * 1024), '250.0 KB');
    assert.equal(formatFileSize(2.5 * 1024 * 1024), '2.5 MB');
  });
});

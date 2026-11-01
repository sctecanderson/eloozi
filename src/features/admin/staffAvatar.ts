/** Reduz uma imagem (File ou data URL) para no máximo `maxSide` px em JPEG. Somente navegador. */
export function shrinkImageToDataUrl(source: Blob | string, maxSide = 320, quality = 0.85): Promise<string> {
    return new Promise((resolve, reject) => {
        const objectUrl = typeof source === 'string' ? null : URL.createObjectURL(source);
        const img = new Image();
        const cleanup = () => {
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
        img.onload = () => {
            const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(img.width * scale));
            canvas.height = Math.max(1, Math.round(img.height * scale));
            const ctx = canvas.getContext('2d');
            cleanup();
            if (!ctx) {
                reject(new Error('Não foi possível processar a foto.'));
                return;
            }
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = () => {
            cleanup();
            reject(new Error('Não foi possível ler a foto selecionada.'));
        };
        img.src = typeof source === 'string' ? source : (objectUrl as string);
    });
}

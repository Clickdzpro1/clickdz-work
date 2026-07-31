// CDZIM Studio — ImageMagick integration for advanced image processing
//
// Rebranded ImageMagick as CDZIM Studio's processing engine.
// Installed server-side (Dockerfile), exposed via API endpoints.
//
// Operations powered by ImageMagick (rebranded as CDZIM Process):
//   - Format conversion (PNG, JPEG, WebP, AVIF, TIFF, PDF)
//   - Resize, crop, rotate, flip
//   - Composite/overlay
//   - Special effects (blur, sharpen, threshold, tint)
//   - Color management (profiles, gamma, colorspace)
//   - Animation (GIF frames)
//   - Text/watermark overlay
//   - Histogram equalization
//   - Perceptual hashing
//
// ENV VARS:
//   CDZIM_IMAGEMAGICK_ENABLED=true
//   CDZIM_IMAGEMAGICK_POLICY=websafe  (open|limited|secure|websafe)

export type CDZIMOperation =
  | 'resize' | 'crop' | 'rotate' | 'flip' | 'flop'
  | 'convert' | 'composite' | 'watermark'
  | 'blur' | 'sharpen' | 'threshold' | 'tint'
  | 'grayscale' | 'sepia' | 'invert'
  | 'optimize' | 'thumbnail' | 'montage';

export interface CDZIMProcessRequest {
  /** Input image URL or base64. */
  input: string;
  /** Operation to perform. */
  operation: CDZIMOperation;
  /** Output format (png, jpeg, webp, avif). */
  outputFormat?: string;
  /** Resize params. */
  width?: number;
  height?: number;
  /** Quality (1-100) for lossy formats. */
  quality?: number;
  /** Crop params. */
  x?: number;
  y?: number;
  /** Rotation degrees. */
  degrees?: number;
  /** Watermark text. */
  watermarkText?: string;
  /** Watermark opacity (0-100). */
  watermarkOpacity?: number;
  /** Additional ImageMagick flags. */
  extraFlags?: string[];
}

export interface CDZIMProcessResponse {
  status: 'ok' | 'error';
  /** Output image URL or base64. */
  output?: string;
  /** Output format. */
  format?: string;
  /** Output width. */
  width?: number;
  /** Output height. */
  height?: number;
  /** File size in bytes. */
  size?: number;
  /** Error message. */
  message?: string;
}

/** API endpoint for image processing. */
export const CDZIM_PROCESS_ENDPOINT = '/api/v1/cdzim/process';

/** Available CDZIM Studio operations with descriptions. */
export const CDZIM_OPERATIONS: Array<{
  id: CDZIMOperation;
  labelFr: string;
  labelEn: string;
  icon: string;
  descFr: string;
  descEn: string;
}> = [
  { id: 'resize', labelFr: 'Redimensionner', labelEn: 'Resize', icon: '📐', descFr: 'Changer la taille de l\'image', descEn: 'Change image dimensions' },
  { id: 'crop', labelFr: 'Rogner', labelEn: 'Crop', icon: '✂️', descFr: 'Couper une partie de l\'image', descEn: 'Cut a portion of the image' },
  { id: 'convert', labelFr: 'Convertir', labelEn: 'Convert', icon: '🔄', descFr: 'Changer le format (PNG, JPEG, WebP, AVIF)', descEn: 'Change format (PNG, JPEG, WebP, AVIF)' },
  { id: 'optimize', labelFr: 'Optimiser', labelEn: 'Optimize', icon: '⚡', descFr: 'Réduire la taille du fichier', descEn: 'Reduce file size' },
  { id: 'watermark', labelFr: 'Filigrane', labelEn: 'Watermark', icon: '💧', descFr: 'Ajouter un texte en filigrane', descEn: 'Add watermark text' },
  { id: 'blur', labelFr: 'Flou', labelEn: 'Blur', icon: '🌫️', descFr: 'Effet de flou', descEn: 'Blur effect' },
  { id: 'sharpen', labelFr: 'Netteté', labelEn: 'Sharpen', icon: '🔪', descFr: 'Améliorer la netteté', descEn: 'Enhance sharpness' },
  { id: 'grayscale', labelFr: 'Noir et blanc', labelEn: 'Grayscale', icon: '⚫', descFr: 'Convertir en niveaux de gris', descEn: 'Convert to grayscale' },
  { id: 'sepia', labelFr: 'Sépia', labelEn: 'Sepia', icon: '🟤', descFr: 'Effet sépia vintage', descEn: 'Vintage sepia effect' },
  { id: 'rotate', labelFr: 'Pivoter', labelEn: 'Rotate', icon: '🔃', descFr: 'Rotation de l\'image', descEn: 'Rotate image' },
  { id: 'thumbnail', labelFr: 'Vignette', labelEn: 'Thumbnail', icon: '🖼️', descFr: 'Générer une vignette', descEn: 'Generate thumbnail' },
  { id: 'montage', labelFr: 'Montage', labelEn: 'Montage', icon: '🎞️', descFr: 'Assembler plusieurs images', descEn: 'Combine multiple images' },
  { id: 'composite', labelFr: 'Compositer', labelEn: 'Composite', icon: '🧩', descFr: 'Superposer des images', descEn: 'Overlay images' },
  { id: 'invert', labelFr: 'Inverser', labelEn: 'Invert', icon: '🔃', descFr: 'Inverser les couleurs', descEn: 'Invert colors' },
  { id: 'tint', labelFr: 'Teinter', labelEn: 'Tint', icon: '🎨', descFr: 'Appliquer une teinte', descEn: 'Apply color tint' },
  { id: 'flip', labelFr: 'Retourner V', labelEn: 'Flip', icon: '🪞', descFr: 'Retourner verticalement', descEn: 'Flip vertically' },
];

/** Client-side helper to call the CDZIM Process API. */
export async function cdzimProcess(req: CDZIMProcessRequest): Promise<CDZIMProcessResponse> {
  try {
    const resp = await fetch(CDZIM_PROCESS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    const data = await resp.json();
    if (!resp.ok) {
      return { status: 'error', message: data.message || 'CDZIM Process failed' };
    }
    return data as CDZIMProcessResponse;
  } catch (err: any) {
    return { status: 'error', message: err.message || 'Network error' };
  }
}

/** Quick helpers for common operations. */
export const cdzim = {
  resize: (input: string, width: number, height?: number, format?: string) =>
    cdzimProcess({ input, operation: 'resize', width, height, outputFormat: format }),

  convert: (input: string, format: string, quality?: number) =>
    cdzimProcess({ input, operation: 'convert', outputFormat: format, quality }),

  optimize: (input: string, quality: number = 80) =>
    cdzimProcess({ input, operation: 'optimize', quality }),

  watermark: (input: string, text: string, opacity: number = 30) =>
    cdzimProcess({ input, operation: 'watermark', watermarkText: text, watermarkOpacity: opacity }),

  thumbnail: (input: string, size: number = 200) =>
    cdzimProcess({ input, operation: 'thumbnail', width: size, height: size }),

  grayscale: (input: string) =>
    cdzimProcess({ input, operation: 'grayscale' }),

  sepia: (input: string) =>
    cdzimProcess({ input, operation: 'sepia' }),

  blur: (input: string, radius: number = 5) =>
    cdzimProcess({ input, operation: 'blur', extraFlags: ['-blur', String(radius)] }),

  sharpen: (input: string, radius: number = 1) =>
    cdzimProcess({ input, operation: 'sharpen', extraFlags: ['-sharpen', `${radius}x${radius}`] }),

  rotate: (input: string, degrees: number) =>
    cdzimProcess({ input, operation: 'rotate', degrees }),

  crop: (input: string, width: number, height: number, x: number = 0, y: number = 0) =>
    cdzimProcess({ input, operation: 'crop', width, height, x, y }),
};

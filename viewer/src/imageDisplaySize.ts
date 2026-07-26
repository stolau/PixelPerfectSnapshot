export type ImageSize = "small" | "medium" | "large";

const SIZE_PX: Record<ImageSize, number> = { small: 240, medium: 400, large: 640 };
const STORAGE_KEY = "pps_image_size";
const DEFAULT_SIZE: ImageSize = "medium";

function isImageSize(value: string | null): value is ImageSize {
  return value === "small" || value === "medium" || value === "large";
}

/**
 * Deliberately localStorage-backed, unlike authToken.ts's sessionStorage: a display-size
 * preference should persist across sessions, unlike a security-sensitive credential.
 */
export function getImageSize(): ImageSize {
  const stored = localStorage.getItem(STORAGE_KEY);
  return isImageSize(stored) ? stored : DEFAULT_SIZE;
}

export function setImageSize(size: ImageSize): void {
  localStorage.setItem(STORAGE_KEY, size);
}

export function imageSizePx(size: ImageSize): number {
  return SIZE_PX[size];
}

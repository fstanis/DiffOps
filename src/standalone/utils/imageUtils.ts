import { getFileExtension } from '../../utils/fileUtils';

const IMAGE_EXTENSIONS = [
  'jpg',
  'jpeg',
  'png',
  'gif',
  'bmp',
  'svg',
  'webp',
  'ico',
  'tiff',
  'tif',
  'avif',
  'heic',
  'heif',
];

export function isImageFile(filename: string): boolean {
  if (!filename) return false;

  const extension = getFileExtension(filename);
  return extension ? IMAGE_EXTENSIONS.includes(extension) : false;
}

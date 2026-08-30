export function getFileExtension(filename: string): string | null {
  if (!filename) return null;
  const extension = filename.split('.').pop()?.toLowerCase();
  return extension || null;
}

export function getFileName(filepath: string): string {
  if (!filepath) return '';
  return filepath.split('/').pop() || '';
}

const fileIdMap = new Map<string, string>();
let fileIdCounter = 0;

/** Uses an internal counter to keep IDs unique without exposing file paths in the DOM. */
export function getFileElementId(filePath: string): string {
  if (!fileIdMap.has(filePath)) {
    fileIdMap.set(filePath, `file-${++fileIdCounter}`);
  }
  return fileIdMap.get(filePath) ?? '';
}

// Suggestion block parsed from comment body (GitHub-style ```suggestion blocks)
interface SuggestionBlock {
  suggestedCode: string;
  startIndex: number;
  endIndex: number;
}

export function hasSuggestionBlock(body: string): boolean {
  return /```suggestion\n([\s\S]*?)```/.test(body);
}

export function parseSuggestionBlocks(body: string): SuggestionBlock[] {
  const blocks: SuggestionBlock[] = [];
  const regex = /```suggestion\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(body)) !== null) {
    blocks.push({
      suggestedCode: (match[1] ?? '').replace(/\n$/, ''),
      startIndex: match.index,
      endIndex: match.index + match[0].length,
    });
  }

  return blocks;
}

export function createSuggestionTemplate(code: string): string {
  const normalizedCode = code.endsWith('\n') ? code : code + '\n';
  return `\`\`\`suggestion\n${normalizedCode}\`\`\``;
}

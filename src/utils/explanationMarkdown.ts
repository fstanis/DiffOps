import type { FileExplanation } from '../types/diff';

/** Formats a whole-file explanation as panel markdown: the file summary as a bare paragraph, then the symbols as one bulleted outline in model order (private symbols flagged inline), with In/Out contracts as nested sub-bullets. */
export function formatFileExplanation(explanation: FileExplanation): string {
  const lines = [explanation.fileSummary];
  if (explanation.symbols.length > 0) {
    lines.push('');
  }
  for (const symbol of explanation.symbols) {
    const visibility = symbol.isPublic ? '' : ' *(private)*';
    lines.push(`- **\`${symbol.name}\`**${visibility} — ${symbol.summary}`);
    if (symbol.contract) {
      lines.push(`  - In: ${symbol.contract.input}`);
      lines.push(`  - Out: ${symbol.contract.output}`);
    }
  }
  return lines.join('\n');
}

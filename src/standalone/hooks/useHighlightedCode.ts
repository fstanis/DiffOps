import { useEffect, useState } from 'react';

import { loadPrismLanguage } from '../utils/languageLoader';
import Prism from '../utils/prism';

// Languages that are included by default in prism-react-renderer v2
const DEFAULT_LANGUAGES = [
  'markup',
  'html',
  'xml',
  'svg',
  'javascript',
  'js',
  'typescript',
  'ts',
  'jsx',
  'tsx',
  'css',
  'c',
  'cpp',
  'swift',
  'kotlin',
  'objectivec',
  'reason',
  'rust',
  'go',
  'graphql',
  'yaml',
  'yml',
  'json',
  'markdown',
  'md',
  'python',
  'py',
];

export function useHighlightedCode(_code: string, lang: string) {
  const [ready, setReady] = useState(() => {
    return DEFAULT_LANGUAGES.includes(lang) || !!Prism.languages[lang];
  });

  useEffect(() => {
    if (ready) return;

    if (DEFAULT_LANGUAGES.includes(lang)) {
      setReady(true);
      return;
    }

    loadPrismLanguage(lang)
      .then(() => {
        setReady(true);
      })
      .catch(() => {
        setReady(false);
      });
  }, [lang, ready]);

  const actualLang = ready ? lang : 'text';

  return { ready, actualLang };
}

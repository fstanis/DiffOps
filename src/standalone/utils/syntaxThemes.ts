import { type PrismTheme, themes } from 'prism-react-renderer';

function removeBackgrounds(theme: PrismTheme) {
  return {
    ...theme,
    styles: theme.styles.map((style: PrismTheme['styles'][number]) => ({
      ...style,
      style: {
        ...style.style,
        background: undefined,
        backgroundColor: undefined,
      },
    })),
  };
}

export function getSyntaxTheme(syntaxTheme: string) {
  let baseTheme;

  switch (syntaxTheme) {
    case 'github':
      baseTheme = themes.github;
      break;
    case 'vsLight':
      baseTheme = themes.vsLight;
      break;
    case 'oneLight':
      baseTheme = themes.oneLight;
      break;
    case 'gruvboxMaterialLight':
      baseTheme = themes.gruvboxMaterialLight;
      break;
    case 'nightOwlLight':
      baseTheme = themes.nightOwlLight;
      break;
    case 'vsDark':
      baseTheme = themes.vsDark;
      break;
    case 'oneDark':
      baseTheme = themes.oneDark;
      break;
    case 'gruvboxMaterialDark':
      baseTheme = themes.gruvboxMaterialDark;
      break;
    case 'nightOwl':
      baseTheme = themes.nightOwl;
      break;
    case 'dracula':
      baseTheme = themes.dracula;
      break;
    case 'okaidia':
      baseTheme = themes.okaidia;
      break;
    default:
      baseTheme = themes.vsDark;
  }

  return removeBackgrounds(baseTheme);
}

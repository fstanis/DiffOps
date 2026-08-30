import { type Token } from 'prism-react-renderer';
import React, { useCallback } from 'react';

import { useWordHighlight } from '../contexts/WordHighlightContext';
import { isWordToken } from '../utils/wordDetection';

import { PrismSyntaxHighlighter, type PrismSyntaxHighlighterProps } from './PrismSyntaxHighlighter';

type EnhancedPrismSyntaxHighlighterProps = Omit<
  PrismSyntaxHighlighterProps,
  'renderToken' | 'onMouseOver' | 'onMouseOut'
>;

/**
 * Syntax highlighter that highlights every occurrence of a hovered word across the
 * visible diff, via WordHighlightContext.
 */
export const EnhancedPrismSyntaxHighlighter = React.memo(function EnhancedPrismSyntaxHighlighter(
  props: EnhancedPrismSyntaxHighlighterProps,
) {
  const { handleMouseOver, handleMouseOut, isWordHighlighted } = useWordHighlight();

  const renderToken = useCallback(
    (
      token: Token,
      key: number,
      getTokenProps: (options: { token: Token }) => Record<string, unknown>,
    ) => {
      const tokenProps = getTokenProps({ token });

      // Split token content by spaces to handle XML/HTML tags that contain multiple words
      const parts = token.content.split(/( +)/);

      if (parts.length === 1 && parts[0] && !isWordToken(parts[0])) {
        return <span key={key} {...tokenProps} />;
      }

      const renderedParts = parts.map((part, index) => {
        if (!part) return null;

        if (isWordToken(part)) {
          const trimmedPart = part.trim();
          const isHighlighted = isWordHighlighted(trimmedPart);
          return (
            <span
              key={`${key}-${index}`}
              className={`word-token ${isHighlighted ? 'word-highlight' : ''}`}
              data-word={trimmedPart}
            >
              {part}
            </span>
          );
        }

        return <span key={`${key}-${index}`}>{part}</span>;
      });

      return (
        <span key={key} {...tokenProps}>
          {renderedParts}
        </span>
      );
    },
    [isWordHighlighted],
  );

  return (
    <PrismSyntaxHighlighter
      {...props}
      renderToken={renderToken}
      onMouseOver={handleMouseOver}
      onMouseOut={handleMouseOut}
    />
  );
});

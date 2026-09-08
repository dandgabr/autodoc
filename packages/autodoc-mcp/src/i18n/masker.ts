/**
 * Syntax and Code Shielding Engine.
 * Masks code symbols, keywords, and code blocks before translation,
 * and accurately restores them afterwards to protect AST fidelity.
 */

export interface ShieldResult {
  maskedText: string;
  tokens: Map<string, string>;
}

export class CodeMasker {
  private static CODE_PATTERNS = [
    /`[^`]+`/g,                         // Inline code
    /\b(?:class|interface|struct|enum|fn|function|def|public|private|protected)\s+[A-Za-z0-9_]+/g,
    /\b[A-Z][a-zA-Z0-9_]*(?:Repository|Service|Controller|Handler|Entity|DTO|Gateway|Client|Broker)\b/g,
  ];

  static mask(text: string): ShieldResult {
    const tokens = new Map<string, string>();
    let counter = 0;
    let maskedText = text;

    for (const pattern of this.CODE_PATTERNS) {
      maskedText = maskedText.replace(pattern, (match) => {
        const placeholder = `__AUTODOC_LITERAL_${counter++}__`;
        tokens.set(placeholder, match);
        return placeholder;
      });
    }

    return { maskedText, tokens };
  }

  static unmask(maskedText: string, tokens: Map<string, string>): string {
    let unmasked = maskedText;
    for (const [placeholder, original] of tokens.entries()) {
      unmasked = unmasked.replaceAll(placeholder, original);
    }
    return unmasked;
  }
}

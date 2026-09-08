import { describe, it, expect } from "vitest";
import { I18nManager } from "../src/i18n/index.js";
import { CodeMasker } from "../src/i18n/masker.js";

describe("CodeMasker (Syntax Shielding)", () => {
  it("should shield inline code snippets and code symbols and unmask them", () => {
    const raw = "Use the `autodoc_scan_repository` tool with class UserService.";
    const { maskedText, tokens } = CodeMasker.mask(raw);

    expect(tokens.size).toBeGreaterThanOrEqual(2);
    expect(maskedText).toContain("__AUTODOC_LITERAL_");
    expect(maskedText).not.toContain("`autodoc_scan_repository`");

    const unmasked = CodeMasker.unmask(maskedText, tokens);
    expect(unmasked).toBe(raw);
  });

  it("should restore multiple masked symbols deterministically", () => {
    const raw = "fn handle_request(auth: AuthService) -> Result";
    const { maskedText, tokens } = CodeMasker.mask(raw);

    expect(tokens.size).toBeGreaterThan(0);
    const unmasked = CodeMasker.unmask(maskedText, tokens);
    expect(unmasked).toBe(raw);
  });
});

describe("I18nManager (Extensible Internationalization)", () => {
  it("should support en-US by default and translate keys", () => {
    const i18n = new I18nManager("en-US");
    expect(i18n.getCurrentLocale()).toBe("en-US");

    const msg = i18n.t("c4.system_context");
    expect(msg).toBe("System Context");

    const containerMsg = i18n.t("c4.containers");
    expect(containerMsg).toBe("Container Diagram");
  });

  it("should support pt-BR translation accurately", () => {
    const i18n = new I18nManager("pt-BR");
    expect(i18n.getCurrentLocale()).toBe("pt-BR");

    const msg = i18n.t("c4.system_context");
    expect(msg).toBe("Contexto do Sistema");

    const scanMsg = i18n.t("c4.auxiliary", { count: 42 });
    expect(scanMsg).toBe("+ 42 Componentes Auxiliares");
  });

  it("should support es-ES translation accurately", () => {
    const i18n = new I18nManager("es-ES");
    expect(i18n.getCurrentLocale()).toBe("es-ES");

    const msg = i18n.t("c4.system_context");
    expect(msg).toBe("Contexto del Sistema");
  });

  it("should fallback gracefully to en-US when key is missing or locale is unknown", () => {
    const i18n = new I18nManager("fr-FR"); // unknown locale initially
    const msg = i18n.t("c4.system_context");
    expect(msg).toBe("System Context");
  });

  it("should allow dynamic runtime registration of new languages (e.g. fr-FR, de-DE, ja-JP)", () => {
    const i18n = new I18nManager("en-US");
    i18n.registerBundle("fr-FR", {
      c4: {
        system_context: "Contexte du Système",
      },
    });

    i18n.setLocale("fr-FR");
    expect(i18n.getCurrentLocale()).toBe("fr-FR");
    const msg = i18n.t("c4.system_context");
    expect(msg).toBe("Contexte du Système");
  });
});

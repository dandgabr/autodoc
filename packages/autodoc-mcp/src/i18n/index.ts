import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type Catalog = Record<string, any>;

export class I18nManager {
  private static catalogs: Map<string, Catalog> = new Map();
  private currentLocale: string = "en-US";

  constructor(initialLocale: string = "en-US") {
    this.currentLocale = initialLocale;
  }

  getCurrentLocale(): string {
    return this.currentLocale;
  }

  setLocale(locale: string): void {
    this.currentLocale = locale;
  }

  registerBundle(locale: string, bundle: Catalog): void {
    const existing = I18nManager.getCatalog(locale);
    I18nManager.catalogs.set(locale, { ...existing, ...bundle });
  }

  t(keyPath: string, params?: Record<string, string | number>): string {
    return I18nManager.t(keyPath, this.currentLocale, params);
  }

  static getCatalog(locale: string = "en-US"): Catalog {
    const normalized = locale.trim();
    if (this.catalogs.has(normalized)) {
      return this.catalogs.get(normalized)!;
    }

    // Try loading from package locales
    const catalog = this.loadCatalogFile(normalized);
    this.catalogs.set(normalized, catalog);
    return catalog;
  }

  private static loadCatalogFile(locale: string): Catalog {
    const candidates = [
      join(__dirname, "locales", `${locale}.json`),
      join(__dirname, "..", "..", "src", "i18n", "locales", `${locale}.json`),
      join(process.cwd(), ".autodoc", "locales", `${locale}.json`),
    ];

    for (const p of candidates) {
      if (existsSync(p)) {
        try {
          const raw = readFileSync(p, "utf-8");
          return JSON.parse(raw);
        } catch {
          // continue fallback
        }
      }
    }

    // Fallback to en-US
    const fallbackCandidates = [
      join(__dirname, "locales", "en-US.json"),
      join(__dirname, "..", "..", "src", "i18n", "locales", "en-US.json"),
    ];
    for (const fallbackPath of fallbackCandidates) {
      if (existsSync(fallbackPath)) {
        try {
          const raw = readFileSync(fallbackPath, "utf-8");
          return JSON.parse(raw);
        } catch {
          // continue
        }
      }
    }

    return {};
  }

  static t(keyPath: string, locale: string = "en-US", params?: Record<string, string | number>): string {
    const catalog = this.getCatalog(locale);
    const keys = keyPath.split(".");
    let current: any = catalog;

    for (const k of keys) {
      if (current && typeof current === "object" && k in current) {
        current = current[k];
      } else {
        // Try fallback to en-US if different locale
        if (locale !== "en-US") {
          const fallbackCatalog = this.getCatalog("en-US");
          let fallbackCurrent: any = fallbackCatalog;
          for (const fk of keys) {
            if (fallbackCurrent && typeof fallbackCurrent === "object" && fk in fallbackCurrent) {
              fallbackCurrent = fallbackCurrent[fk];
            } else {
              return keyPath;
            }
          }
          current = fallbackCurrent;
          break;
        }
        return keyPath;
      }
    }

    if (typeof current === "string" && params) {
      let result = current;
      for (const [pk, pv] of Object.entries(params)) {
        result = result.replace(new RegExp(`\\{${pk}\\}`, "g"), String(pv));
      }
      return result;
    }

    return typeof current === "string" ? current : keyPath;
  }
}

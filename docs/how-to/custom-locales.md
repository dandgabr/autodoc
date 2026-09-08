# How to Add Custom Locales to AutoDoc

AutoDoc supports extensible localization (`@autodoc/i18n`) conforming to BCP 47 language tags.

---

## Built-in Locales

The server ships with full translations for:
- `en-US`: American English (default)
- `pt-BR`: Brazilian Portuguese
- `es-ES`: European / Latin American Spanish

---

## Method 1: Project-Level Locale Overrides (`.autodoc/locales/`)

To override translations or supply a new language without rebuilding the package:

1. Create the directory `.autodoc/locales/` inside your target repository:

```bash
mkdir -p .autodoc/locales
```

2. Create a JSON file matching your BCP 47 code (for example: `.autodoc/locales/fr-FR.json` or `.autodoc/locales/de-DE.json`):

```json
{
  "c4": {
    "system_context": "Contexte du Système",
    "containers": "Diagramme de Conteneurs",
    "components": "Diagramme de Composants",
    "code": "Diagramme de Code",
    "auxiliary": "+ {count} composants secondaires",
    "legend": "Légende : Frontières et Contrats"
  },
  "tools": {
    "scan_completed": "Dépôt analysé avec succès",
    "c4_generated": "Diagramme C4 généré",
    "cache_purged": "Cache local purgé et compacté"
  },
  "adr": {
    "title": "Registre de Décision d'Architecture",
    "status": "Statut",
    "context": "Contexte",
    "decision": "Décision",
    "consequences": "Conséquences"
  }
}
```

3. Launch your MCP client with the environment variable set:

```bash
AUTODOC_LOCALE=fr-FR
```

---

## Method 2: Dynamic Runtime Registration via Code

When embedding `@autodoc/mcp` as an internal TypeScript library, register bundles programmatically:

```typescript
import { I18nManager } from "@autodoc/mcp";

const i18n = new I18nManager("ja-JP");
i18n.registerBundle("ja-JP", {
  c4: {
    system_context: "システムコンテキスト",
    containers: "コンテナ図"
  }
});

const label = i18n.t("c4.system_context");
// Returns: "システムコンテキスト"
```

If a translation key is missing in your custom bundle, the manager falls back to `en-US`.

# How to Configure and Extend PII Scrubbing

AutoDoc protects sensitive information by scrubbing secrets and Personally Identifiable Information (PII) before any code or diagram reaches the AI client context.

---

## Default Protection Matrix

By default, the native Rust scanner (`crates/autodoc-core/src/sanitizer/`) inspects all text against:
- **30+ Secret Patterns**: AWS access keys, GitHub tokens, Slack Webhooks, RSA/ED25519 private keys, Google API keys, database connection strings.
- **Shannon Entropy**: Flags any token exceeding $H \ge 4.5$ with length $\ge 20$ characters.
- **Base PII Patterns**:
  - Email addresses (`[REDACTED_EMAIL:<hash>]`)
  - IPv4 addresses (`[REDACTED_IPV4:<hash>]`)
  - Brazilian CPF and CNPJ with mod-11 check (`[REDACTED_CPF]`, `[REDACTED_CNPJ]`)
  - US Social Security Numbers (`[REDACTED_SSN]`)
  - European VAT / NIF / NIE numbers (`[REDACTED_EU_VAT]`)
  - Payment Cards with Luhn check (`[REDACTED_PAN]`)
  - Industrial MAC addresses (`[REDACTED_MAC]`)
  - Healthcare NPI & Brazilian CNS (`[REDACTED_HEALTH_ID]`)

---

## Disabling Scrubbing for Air-Gapped / Offline Environments

When running in an isolated network without external LLM exposure, disable scrubbing in the tool parameters:

```json
{
  "repoPath": "/workspace/internal-repo",
  "deepScan": true,
  "enablePiiScrubbing": false
}
```

---

## Adding Custom PII Patterns to the Registry

The PII catalog is modular and defined in `crates/autodoc-core/src/sanitizer/pii_registry.rs`.

To add a new PII category (for example, German Tax Identification Numbers or Custom Employee IDs):

1. Open `crates/autodoc-core/src/sanitizer/pii_registry.rs`.
2. Add an entry to the `PiiRegistry::default()` constructor:

```rust
registry.register(
    PiiCategory::Custom("GERMAN_STEUER_ID"),
    r"\b\d{2}\s?\d{3}\s?\d{3}\s?\d{3}\b",
    "[REDACTED_TAX_ID]"
);
```

3. Rebuild the core engine:

```bash
npm run build -w @autodoc/core
```

4. Run the sanitizer test suite:

```bash
cargo test -p autodoc-core test_pii_registry
```

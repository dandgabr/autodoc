# ADR-002: Phase 2 — Rust Core Engine Decision Tree

> Mirrored from ai-memory `decisions/ADR-002-phase2-rust-core-decision-tree.md`. Translated to English from the original Portuguese record.

## Status
Accepted - Consolidated with the User on 2026-09-08 (Updated with the Pluggable and Adaptable PII Catalog)

## Context
After completing, compiling, testing, and pushing Phase 1 (Hybrid Monorepo, NAPI-RS Bridge, and Licensing Gates), a deliberative round was held to align in detail the technical decisions for the 4 core subsystems of the Rust Core Engine (Phase 2) of AutoDoc Code Explorer MCP.

---

## 1. Point 1: Architecture of the Adaptable, Extensible, Multi-Domain PII Catalog

### Accepted Decisions:
1. **Extensible Trait Design (`PiiRule` / `PiiRegistry`)**:
   - Instead of static or hard-coded rules, the Rust PII engine is designed around a dynamic, modular registration pattern (`PiiRegistry` and the `PiiRule` / `ChecksumValidator` traits).
   - Each validator implements two-step verification:
     1. *Fast-Path Regex*: A linear expression immune to ReDoS, compiled into the `RegexSet` for preliminary detection of candidate patterns.
     2. *Checksum / Algorithmic Verification*: Deep, deterministic logical validation (avoiding false positives on software identifiers, commit hashes, and hexadecimal keys).

2. **Native Catalogs and Extensibility by Vertical Domains**:
   - **General and Digital**: E-mails (simplified RFC 5322), international E.164 phones, public IPv4/IPv6 addresses (excluding loopback and RFC 1918), user path normalization, and `@author` headers.
   - **Latin America (LATAM)**: Brazil CPF/CNPJ (Modulus 11), Argentina DNI/CUIT/CUIL, Chile RUT/RUN, Colombia NIT, Mexico RFC/CURP.
   - **Europe and International**: US SSN (rejection of unallocated groups), Portugal NIF, Spain DNI/NIE (Modulus 23), ICAO Doc 9303 passports.
   - **Healthcare (HealthTech / HIPAA / LGPD)**: CNS (Brazil), NHS Number (UK), NPI (US, Luhn), MRN, DICOM PatientID.
   - **Industrial/IoT (ICS / SCADA / ISA-95)**: MAC EUI-48/64, Modbus/OPC-UA/Profibus tags, telemetry coordinates.
   - **Financial (FinTech / PCI-DSS / Open Finance)**: PAN (Luhn), PIX accounts and keys, SWIFT/BIC, IBAN (ISO 13616 Modulus 97).

3. **Injection of Custom Rules via `.autodoc/config.json`**:
   - The PII engine accepts dynamic validators without recompilation via the `pii` section (`enabled_categories`, `custom_rules`, `disabled_rules`).

4. **Correlatable Redaction Format**:
   - Deterministic placeholders with a short one-way hash: `[REDACTED_CPF:a1b2]`, preserving traceability in graphs and Taint Analysis.

5. **Secure Auditing**:
   - Findings emit `AUTODOC_W101_PII_DETECTED` / `AUTODOC_W102_SECRET_DETECTED` to `stderr` and `audit.log` (POSIX 0600), without exposing the actual data.

---

## 2. Point 2: SQLite WAL Persistence Strategy, Local Cache, and Read-Only Resilience

### Accepted Decisions:
1. **Location and permissions**: `<repo_root>/.autodoc/cache.db`; folder `0700`, files `0600`.
2. **XDG fallback in read-only**: `$XDG_CACHE_HOME/autodoc/<repo_hash>/cache.db` (Linux/macOS), `%LOCALAPPDATA%\autodoc\...` (Windows).
3. **Dual-Pool concurrency**: serialized `DedicatedWriter` (`BEGIN IMMEDIATE`) + `ReaderPool` via `r2d2_sqlite` (`num_cpus * 2`).
4. **WAL Checkpoints**: `PRAGMA wal_checkpoint(PASSIVE)` at runtime; `TRUNCATE` + `optimize` + `VACUUM` on purge.
5. **DDL**: `edges` table `WITHOUT ROWID` (35–50% less disk), covering indexes for *Index-Only Scan*.
6. **Incremental detection**: tuple (`mtime_ns`, `size_bytes`, `git_oid`).

---

## 3. Point 3: Semantic Graph Pruning and Token Budgeting

### Accepted Decisions:
1. **Cap of 35 visible nodes** per diagram (OWASP LLM10 mitigation).
2. **Prioritization** by Degree Centrality + PageRank in Petgraph.
3. **Synthetic clustering**: `[+ N auxiliary components in package X]`.
4. **`max_nodes`** configurable (10–100, default 35).
5. **AST Skeletonization**: `include_body: false` by default.
6. **Strict pagination** (50 items, cursor `next_cursor`).

---

## 4. Point 4: Phase 2 Test Matrix

Four suites in `crates/autodoc-core/tests/`:
1. **`sanitizer_tests.rs`**: 30+ credential vectors, multiregional PII catalog, custom rules, 100% redaction.
2. **`injection_tests.rs`**: indirect prompt injection (OWASP LLM01), delimiter escaping, neutralization of special model tokens.
3. **`storage_tests.rs`**: WAL stress with 10 readers + 10k insertions, zero `SQLITE_BUSY`, `integrity_check`, Index-Only Scan.
4. **`graph_tests.rs`**: PageRank, deterministic pruning, satellite clustering.
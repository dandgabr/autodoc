# Jeito Dasa de Brincar Review and AutoDoc Corrections Plan

> **SUPERADO em 22/10/2026:** o objetivo esclarecido é revisar o AutoDoc como documentador genérico. Use [a revisão e o plano atualizados](../reviews/2026-10-22-autodoc-product-review.md). As tarefas abaixo de modificar o jogo não fazem parte do escopo atual e não devem ser executadas a partir deste plano.

> **For agentic workers:** Execute the tasks in order and keep each generated artifact reviewable. Preserve the target project's human-authored `docs/agent-flow/` and `docs/reviews/` material; update it with verified outcomes instead of replacing it with generated output.

**Goal:** Correct AutoDoc's unsupported assumptions for static websites, then update and validate the Jeito Dasa de Brincar project against the verified review findings.

**Architecture:** Make documentation and C4 output depend on evidence discovered in the target repository. Treat the game improvements as a separate workstream from generator fixes, and keep human-authored project documentation as the source of product context. Regenerate AutoDoc output only after the generator behavior is corrected.

**Tech Stack:** TypeScript, Vitest, Node.js filesystem fixtures, static HTML/CSS/JavaScript, Markdown, Mermaid C4.

**Spec:** `/home/daniel/Downloads/jeito-dasa-de-brincar/relatorio.md`, with detailed evidence in `docs/reviews/{development,frontend,security}.md` and product context in `docs/agent-flow/`.

## Global Constraints

- Target application is a static HTML/CSS/JavaScript game; its README states that it has no build, application server, database, or `npm install` requirement.
- Keep the target game free of a runtime or build dependency unless an approved product requirement needs one.
- Preserve existing human-authored files under `/home/daniel/Downloads/jeito-dasa-de-brincar/docs/agent-flow/` and `docs/reviews/`.
- Never present an undetected capability as a confirmed absence when the analyzer did not inspect the relevant file type or evidence source.
- Do not claim browser, device, hosting-header, or scanner validation unless that validation was actually run and recorded.

## Review Focus

- **Static-only repository with no package manifest:** generated onboarding must not invent Node.js, `.env`, database, container, build, or test requirements.
- **No backend or API evidence:** C4 output must not invent an API server, REST, WebSockets, auth, database, or real-time services.
- **JavaScript event callbacks:** `onDocMove` and `onDocEnd` are registered with `document.addEventListener`; report them as reachable callbacks or uncertain references, not dead code.
- **Pointer-only game and touch behavior:** offer an accessible way to place pieces and preserve page scrolling on touch devices.
- **Image and viewport failures:** a missing game image or viewport change must leave the player with a usable, recoverable game state.

---

## Evidence and Root-Cause Findings

- The generated files in `docs/autodoc/` contain unsupported instructions: `tutorials/getting-started.md` tells users to use Node.js 22, copy `.env.example`, start database/cache daemons, install dependencies, build, and run tests. `how-to/add-new-module.md` assumes a TypeScript/Express modular backend, Socket.io, persistence, and wallet transactions.
- `docs/autodoc/architecture/system-overview.md` invents a Node/Express API server and REST/WebSocket traffic even though the app's README and `docs/agent-flow/architecture.md` describe a static client-only game.
- The execution cache at `/home/daniel/Downloads/jeito-dasa-de-brincar/.autodoc/cache.db` records one indexed file (`js/game.js`), 29 symbols, and 35 call edges. The target also has `index.html` and `css/style.css`, which were not represented in that indexed file set.
- The cause is not only an incomplete scan: `packages/autodoc-mcp/src/diataxis/generator.ts` contains fixed backend onboarding/module copy, and `packages/autodoc-mcp/src/analyzers/architecture.ts` supplies a default server description and creates an API-server container whenever no client package is detected.
- The orphan-symbol report marks `onDocMove` and `onDocEnd` despite their event-listener registrations in `js/game.js`; `packages/autodoc-mcp/src/analyzers/honesty/index.ts` currently uses call-graph in-degree as the dead-code criterion, which misses callback registration edges.
- No execution trace or invocation options were present in the target artifacts. Whether LLM enrichment or a specific scan mode was used remains unverified; the defects above are independently reproducible from the source templates and persisted cache contents.

## Files and Ownership

- Modify `packages/autodoc-mcp/src/diataxis/generator.ts` to generate onboarding and how-to guidance from repository evidence.
- Modify `packages/autodoc-mcp/src/analyzers/architecture.ts` to represent static sites and avoid fabricated server topology.
- Modify `packages/autodoc-mcp/src/analyzers/honesty/index.ts` and, if required by evidence, the call-graph extraction in `crates/autodoc-core/src/` to account for callback registration.
- Add focused regression tests under `packages/autodoc-mcp/tests/` using temporary repository fixtures; leave the existing benchmark-based tests intact.
- Update the game files under `/home/daniel/Downloads/jeito-dasa-de-brincar/`: `js/game.js`, `css/style.css`, `index.html`, `README.md`, and the human-authored `docs/agent-flow/` documents when behavior or decisions change.
- Regenerate corrected files under `/home/daniel/Downloads/jeito-dasa-de-brincar/docs/autodoc/` only after the generator changes pass their regression tests. Treat these as generated artifacts, not hand-edited source.

## Phase 1 — Stop AutoDoc From Inventing Project Structure

### Task 1: Add a static-site fixture and pin current bad output

**Files:** Add `packages/autodoc-mcp/tests/fixtures/static-site/` with `index.html`, `css/style.css`, `js/game.js`, and a truthful README; add regression coverage in `packages/autodoc-mcp/tests/static_site_docs.test.ts`.

- [ ] Create a minimal static-site fixture with no package manifest, backend, env file, container files, API routes, sockets, or database models.
- [ ] Assert the current generated tutorial does not claim Node, npm, `.env`, databases, containers, builds, or test commands unless the fixture contains evidence for them.
- [ ] Assert generated architecture identifies a browser-hosted static site and contains no API-server, REST, WebSocket, auth, or database nodes.
- [ ] Assert a module how-to is omitted or replaced with a static-site-specific guide when no module architecture is detected.

### Task 2: Make onboarding and module guidance evidence-based

**Files:** Modify `packages/autodoc-mcp/src/diataxis/generator.ts`; extend `packages/autodoc-mcp/tests/static_site_docs.test.ts`.

- [ ] Detect a static web project from entry HTML and referenced local assets/scripts/styles when there is no application manifest or backend evidence.
- [ ] Generate a static-site tutorial with supported serving instructions drawn from the README or safe generic static-file guidance; do not add dependency installation, environment setup, build, or test steps without matching evidence.
- [ ] Generate `how-to/add-new-module.md` only when a module registry or equivalent module structure is discovered. Otherwise write a relevant static-site task guide or omit the file.
- [ ] Keep existing backend/monorepo fixture behavior intact with assertions for real package scripts, containers, and module registries.

### Task 3: Correct C4 fallback topology

**Files:** Modify `packages/autodoc-mcp/src/analyzers/architecture.ts`; extend `packages/autodoc-mcp/tests/static_site_docs.test.ts` and existing architecture tests.

- [ ] Represent a static site as a browser/user interacting with static files or a static hosting boundary, using only details supported by the repository.
- [ ] Remove generic backend language from fallback descriptions and edges. Add API, identity, storage, and realtime components only when concrete evidence supports each component.
- [ ] Cover three fixtures: static site, client-only packaged application, and actual server project; assert each topology reflects its fixture without changing valid existing server detections.

### Task 4: Stop treating registered callbacks as dead code

**Files:** Modify `packages/autodoc-mcp/src/analyzers/honesty/index.ts` and call-graph extraction only if necessary; add `packages/autodoc-mcp/tests/honesty_callbacks.test.ts`.

- [ ] Add a fixture where named functions are passed to `addEventListener`, assigned to DOM event properties, and invoked directly.
- [ ] Ensure `onDocMove` and `onDocEnd` in the fixture are not labeled orphan/dead solely because the graph has no ordinary call edge.
- [ ] Preserve detection for a genuinely unreferenced function and report uncertainty where callback/reference resolution cannot be established.

## Phase 2 — Fix Game Accessibility and Interaction

### Task 5: Define an accessible piece-placement interaction

**Files:** Modify `/home/daniel/Downloads/jeito-dasa-de-brincar/js/game.js`, `index.html`, `css/style.css`; update `docs/agent-flow/architecture.md` and `open-questions.md` after behavior is settled.

- [ ] Provide keyboard-operable selection and placement for every puzzle piece, including a clear selected state and cancel path.
- [ ] Give pieces accessible names and expose whether each piece is placed; expose progress and completion with appropriate live status or progress semantics.
- [ ] Move focus to a meaningful heading or status when the game completes or enters an error state.
- [ ] Keep pointer/touch drag available and ensure focus indicators and selected states remain visible at narrow viewports.

### Task 6: Preserve touch scrolling and isolate pointer gestures

**Files:** Modify `css/style.css` and `js/game.js`; add or update interaction tests if the project adopts a test harness.

- [ ] Replace wrapper-wide `touch-action: none` with a rule that permits vertical page scrolling when the gesture starts on empty play area while retaining piece drag behavior.
- [ ] Store the active `pointerId` when dragging starts and ignore movement/end/cancel events from other pointer IDs.
- [ ] Release pointer capture and clear document listeners when leaving or completing the game, including interrupted/cancelled drags.
- [ ] Verify mouse, single-touch, second-touch interference, pointer cancellation, and scrolling behavior on a real browser/device matrix before claiming support.

## Phase 3 — Recoverability and Responsive Game State

### Task 7: Handle game-image load failure

**Files:** Modify `js/game.js` and, if needed, `index.html`/`css/style.css`; update the project README only if run requirements change.

- [ ] Add explicit image loading/error states so a failed `assets/kv.webp` request never leaves a blank, stuck game screen.
- [ ] Offer a clear retry action and a route back to level selection or the cover screen.
- [ ] Prevent duplicate game construction and timer/listener leaks when a retry succeeds after failure.
- [ ] Verify success, initial failure, and retry failure/recovery behavior with a controlled local asset response.

### Task 8: Preserve a playable board across viewport changes and motion preferences

**Files:** Modify `js/game.js` and `css/style.css`.

- [ ] Recalculate board and piece geometry on resize/orientation changes while preserving solved state and relative positions of unsolved pieces.
- [ ] Avoid rebuilding the puzzle or resetting the timer when the viewport changes.
- [ ] Use instant programmatic scrolling when `prefers-reduced-motion: reduce` is active.
- [ ] Verify small viewport, rotation, resize during drag, solved-piece preservation, and reduced-motion behavior.

## Phase 4 — Reconcile Documentation and Verify the Review

### Task 9: Resolve project decisions and update human-authored docs

**Files:** Update `/home/daniel/Downloads/jeito-dasa-de-brincar/README.md` and the relevant files under `docs/agent-flow/` and `docs/reviews/`.

- [ ] Decide whether the Google Fonts requests are acceptable for the intended child audience and deployment; document the choice or host approved font files locally.
- [ ] Correct README claims about privacy, supported browsers, and mobile behavior to distinguish code facts from tested compatibility.
- [ ] Document the actual static hosting requirements and the accessible interaction model.
- [ ] Keep deployment header recommendations labeled as unverified until the selected host is inspected; set CSP and related headers only with the inline-style requirements accounted for.

### Task 10: Regenerate artifacts and run final validation

**Files:** Regenerate `/home/daniel/Downloads/jeito-dasa-de-brincar/docs/autodoc/`; update `docs/reviews/README.md` and `relatorio.md` with verified results.

- [ ] Run focused AutoDoc regression tests and the relevant package test/build commands; record exact results.
- [ ] Re-scan the target repository and verify indexed paths include the intended source file types or clearly report scanner coverage limits.
- [ ] Regenerate documentation into the existing AutoDoc output directory and inspect every file for unsupported claims, stale content, and broken links.
- [ ] Perform browser checks for keyboard play, touch scrolling, pointer isolation, image failure/retry, resize/orientation, completion announcements, and reduced motion; record browser/device and observed outcomes.
- [ ] Re-run OpenGrep and TruffleHog only if code, dependencies, or asset handling changed in ways that affect their earlier findings; record scanner versions and scope.
- [ ] Update the review report to separate confirmed findings, resolved items, deferred product decisions, and unverified hosting/device behavior.

## Completion Criteria

- Static-site regression fixture produces no invented backend, package manager, infrastructure, environment, API, socket, or module guidance.
- Callback registrations no longer create dead-code findings for active event handlers.
- The game has a documented and verified non-pointer interaction, touch scrolling remains usable, and image/viewport failures recover without losing game state.
- Human-authored documentation matches the implemented game; generated docs are regenerated from corrected AutoDoc behavior and contain no unsupported claims.
- Review records the commands, browser/device coverage, and explicit remaining limits.

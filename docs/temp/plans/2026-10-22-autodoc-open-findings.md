# AutoDoc Open Findings Implementation Plan

> **For agentic workers:** Use `superpowers-executing-plans` and implement one task at a time. Each task has an independent test gate. Preserve the existing worktree and do not commit unless the user explicitly authorizes commits.

**Goal:** Fechar as pendências arquiteturais restantes para que scans, inventário, relações, mapas, catálogos e exportações usem uma geração consistente, com cobertura e proveniência verificáveis.

**Architecture:** Persistir gerações de scan imutáveis e qualificadas por `scanId`; fazer parsers e analisadores consumirem inventário e bytes verificados dessa geração; publicar fatos, evidências e relações em projeções comuns para tools, resources e documentos. Aplicar limites explícitos de scan/paginação e usar o lock SQLite do core nativo para serializar exportações em todos os runtimes e liberar automaticamente locks quando o processo morrer.

**Tech Stack:** Rust, SQLite/rusqlite, Tree-sitter, Node-API, TypeScript, Zod, MCP e Vitest já usados no repositório. Não adicionar dependência de runtime ao servidor. Mermaid continua como dependência de desenvolvimento para validação dos diagramas.

**Spec:** [Revisão do produto](../reviews/2026-10-22-autodoc-product-review.md) e [plano original](2026-10-22-autodoc-corrections.md). Este plano complementar substitui somente os critérios ainda abertos das tarefas 5–12; não reabre itens aceitos na revisão anterior. O [ledger](../../../.superpowers/sdd/2026-10-22-autodoc-corrections/progress.md) registra o estado medido e os limites atuais.

## Global Constraints

- Não alterar o jogo usado como fixture nem arquivos em Downloads.
- Preservar alterações locais preexistentes, inclusive `src/llm/factory.ts` e arquivos em `.agents/`; não editar artefatos gerados em `.agents/`.
- Manter removido `packages/autodoc-mcp/tests/agnostic_analyzers.test.ts`; não criar dependência de repositório externo ou caminho específico da máquina.
- Ausência de evidência nunca se transforma em presença confirmada, ausência comprovada ou segurança confirmada.
- Não adicionar dependência de runtime ao servidor MCP.
- Usar os limites já definidos no plano original: fonte até 4 MiB, até 4 workers, fila de 16 arquivos, lotes de até 256 fatos, páginas de no máximo 500 registros ou 1 MiB. Atingir limite gera diagnóstico e cobertura parcial; não substitui snapshot completo por parcial.
- Manter as mudanças observáveis alinhadas entre Rust/N-API, declarações regeneradas, binding TypeScript, Zod, tools/resources MCP e documentação.
- Cada tarefa começa por uma regressão reproduzível, termina com teste focado e revisão de diff; executar o gate completo na tarefa 10.

## Review Focus

1. Uma página consultada após outro scan e após retenção: manter a mesma geração ou responder explicitamente `SNAPSHOT_UNAVAILABLE`, nunca misturar dados.
2. Arquivo alterado, removido, ilegível ou substituído por symlink entre scan e análise: rejeitar fato stale e preservar a geração ativa anterior.
3. Chamada sombreada por parâmetro, variável, destructuring, loop, callback ou receiver: só confirmar destino com binding/receiver provado; representar o restante como unresolved/unsupported.
4. Duas exportações simultâneas e morte do processo no meio da escrita: uma única operação ativa; lock de processo morto é liberado sem apagar lock ativo; alterações manuais são preservadas.
5. Projeto vazio, estático, misto, parcial ou com linguagem não suportada: tools, resources, catálogos e exportação usam o mesmo `scanId` e declaram cobertura, sem concluir ausência a partir de uma lista vazia.

## Decomposição

| Tarefa | Conteúdo | Critérios originais fechados |
| --- | --- | --- |
| 1 | Contrato de geração e migração | T5, T7 |
| 2 | Publicação e retenção imutável | T5 |
| 3 | Leitura nativa e paginação de snapshot | T5, T7, T11 |
| 4 | Inventário e leitura de fonte verificada | T7, T9 |
| 5 | Identidade e resolução de relações | T6, T9 |
| 6 | Projeções de mapa, tools e resources | T8 |
| 7 | Catálogos completos e cursores vinculados | T11 |
| 8 | Lock de exportação recuperável | T10 |
| 9 | Backpressure e limites testáveis | T5, T7 |
| 10 | Avaliação cruzada, documentação e gate | T12 |

---

### Task 1: Fixar o contrato de snapshots e a migração do cache

**Files:** modificar `crates/autodoc-core/src/cache/schema.rs`, `crates/autodoc-core/src/cache/mod.rs`, `crates/autodoc-core/src/lib.rs`, `packages/autodoc-mcp/src/analysis/contracts.ts` e `packages/autodoc-mcp/tests/snapshot_contracts.test.ts`; criar/expandir testes de migração em `crates/autodoc-core/tests/scan_snapshot_tests.rs`.

**Interfaces:**
- `SnapshotMetadata`: `{ contractVersion: 2, schemaVersion, scanId, repositoryRoot, createdAt, extractorVersions, coverage, latestAttempt, freshness, totals }`.
- `latestAttempt.state` admite `running | complete | partial | failed | superseded`; enquanto a tentativa executa, `activeScanId` continua apontando para a última geração completa.
- `SnapshotPage<T>`: `{ contractVersion: 2, schemaVersion, scanId, repositoryRoot, collection, items, total, nextCursor, coverage }`.
- `Evidence`: `{ id, path, contentSha256?, lineStart?, lineEnd?, extractor, method }`.
- `Relation`: `{ id, fromId, toId?, kind, resolution, candidateIds, evidenceIds }`, com `resolution` `resolved | ambiguous | unresolved`.
- Dados publicados devem carregar `scan_id`; IDs internos SQLite não são IDs públicos.

- [ ] Adicionar testes vermelhos para schema 3 legado, versão futura sem qualquer mudança de `user_version`/journal/sidecars, metadata com tentativa `running`, página com `scanId` divergente e `SnapshotPageSchema` rejeitando item malformado em vez de aceitar `unknown`.
- [ ] Definir projeções geracionais substitutas às tabelas mutáveis atuais: `generation_files(scan_id,file_id,path,...)` com `UNIQUE(scan_id,path)`; `generation_symbols(scan_id,symbol_id,file_id,fqsn,...)` com chaves/FKs compostas `(scan_id,file_id)` e `(scan_id,fqsn)`; `generation_edges(scan_id,caller_id,callee_id,...)` com ambas as FKs qualificadas por geração; `generation_fts(scan_id,fqsn,name,...)` indexado por geração; e `repository_state(repository_key,active_scan_id,latest_attempt_id)`. `inventory_files`, `facts`, `evidence` e `relations` também usam PK/FK compostas com `scan_id`. FTS não suporta FK: gravar/remover FTS na mesma transação e testar reconciliação por geração.
- [ ] Migrar schema existente em transação; preservar tabelas legadas apenas para diagnóstico e marcar seu conteúdo não verificado, sem publicá-lo como uma geração nova. Ler `PRAGMA user_version` e rejeitar versão futura antes de executar `journal_mode`, `synchronous`, `auto_vacuum` ou qualquer pragma/escrita que altere banco/sidecars.
- [ ] Validar contratos Rust e Zod com fixtures válidas/inválidas, inclusive campos anuláveis, `coverage: partial` e relação `unresolved` sem `toId`.
- [ ] Rodar `cargo test -p autodoc-core --test scan_snapshot_tests` e `npm test -w @autodoc/mcp -- tests/snapshot_contracts.test.ts`.

**Aceite:** respostas e linhas persistidas carregam geração explícita; migração é reversível por transação e não fabrica facts/evidence para caches legados.

### Task 2: Publicar gerações completas de forma imutável

**Files:** modificar `crates/autodoc-core/src/cache/{mod.rs,schema.rs}`, `crates/autodoc-core/src/scanner.rs`, `crates/autodoc-core/src/lib.rs` e `crates/autodoc-core/tests/{scan_publication_tests.rs,scan_snapshot_tests.rs}`.

**Interfaces:** `publish_scan(scan_id, staged_snapshot) -> Result<PublishResult, AutoDocError>` grava uma geração uma única vez e move `active_scan_id` em transação curta. `PublishResult` identifica `published | partial | failed | superseded` e mantém `scanId`, `activeScanId` e diagnósticos. Todos os dados `files`, `symbols`, `edges`, FTS, inventário, facts, relações e evidências usam as tabelas geracionais da Task 1; tabelas mutáveis antigas não são consultadas como projeção ativa.

- [ ] Adicionar regressões para duas gerações completas, scan parcial, falha no meio do lote, scans concorrentes e tentativa antiga terminando depois da nova.
- [ ] Escrever arquivos, símbolos, facts, relações, evidências e FTS em staging qualificado por `scan_id`; não atualizar tabelas ativas durante parsing.
- [ ] Publicar o ponteiro ativo somente depois que inventário e persistência terminarem sem erro impeditivo; falha preserva geração ativa anterior integral.
- [ ] Tornar gerações publicadas imutáveis via API de escrita e triggers/restrições adequadas; consultas compostas abrem uma transação de leitura e fixam o mesmo `scan_id`.
- [ ] Aplicar retenção por repositório configurável, default 5 gerações completas além da ativa. Remoção só ocorre fora de leitura; uma consulta posterior a geração removida retorna `SNAPSHOT_UNAVAILABLE`.
- [ ] Rodar `cargo test -p autodoc-core --test scan_publication_tests` e `cargo test -p autodoc-core --test scan_snapshot_tests`.

**Aceite:** falhas e concorrência não misturam nem substituem gerações; dados da geração publicada não são atualizados em lugar.

### Task 3: Expor metadados, páginas e cursores vinculados à geração

**Files:** criar `packages/autodoc-mcp/src/analysis/snapshot.ts`; modificar `crates/autodoc-core/src/lib.rs`, `packages/autodoc-mcp/src/binding.ts`, `packages/autodoc-mcp/src/analysis/contracts.ts`, `packages/autodoc-mcp/src/tools/handlers.ts` e testes nativos/MCP de snapshot.

**Interfaces:**
- `readRepositorySnapshotNative(repoPath): string` retorna metadata validada sem iniciar scan nem criar cache.
- `readSnapshotPageNative(repoPath, scanId, collection, cursor, limit): string` aceita somente collections conhecidas e respeita limites de 500 registros/1 MiB.
- `loadSnapshot(repoPath, scanId?) -> Promise<SnapshotContext>` retorna raiz canônica, metadata e leitor de páginas ligado a um único `scanId`.

- [ ] Adicionar testes vermelhos para projeto sem cache, cursor inválido, cursor de outra raiz/coleção/filtro, geração expirada, limite de bytes e tentativa de leitura que criaria banco.
- [ ] Implementar paginação ordenada por ID semântico; cursor opaco carrega versão, raiz, `scanId`, collection, filtro e posição e rejeita qualquer divergência.
- [ ] Validar envelope e cada item por Zod antes de retornar ao chamador; erros usam estado explícito (`NOT_SCANNED`, `SNAPSHOT_UNAVAILABLE`, `FAILED`).
- [ ] Definir e testar item individual acima de 1 MiB: retornar erro estável `ITEM_TOO_LARGE` com collection/ID/tamanho, sem avançar cursor nem omitir silenciosamente o registro.
- [ ] Persistir uma resolução determinística do cache por raiz canônica e XDG; provar com dois processos: processo A faz scan usando o mesmo `XDG_CACHE_HOME`/`XDG_STATE_HOME`, processo B inicia sem registry em memória e lê o mesmo `scanId` sem criar novo banco nem depender do caminho do cwd.
- [ ] Testar leitura concorrente: publicar G2 entre metadata e páginas de G1 deve retornar G1 integral ou falhar explicitamente, nunca páginas de G2.
- [ ] Rodar `cargo test -p autodoc-core --test scan_snapshot_tests` e `npm test -w @autodoc/mcp -- tests/snapshot_contracts.test.ts tests/scan_status.test.ts`.

**Aceite:** uma sequência de páginas não pode trocar de geração; cursores inválidos/expirados falham sem reiniciar silenciosamente no snapshot atual.

### Task 4: Construir inventário único e verificar bytes de origem

**Files:** criar `crates/autodoc-core/src/inventory.rs`, `crates/autodoc-core/tests/inventory_tests.rs`, `packages/autodoc-mcp/src/analysis/source-reader.ts`, `packages/autodoc-mcp/tests/inventory_scope.test.ts`; modificar scanner, bindings e `packages/autodoc-mcp/src/analyzers/{workspace.ts,containers.ts,rest/index.ts,realtime/index.ts,schema/index.ts}`. `HonestyAnalyzer` migra para snapshot na Task 6.

**Interfaces:** `InventoryFile` registra `path`, `category`, `support`, `contentSha256?`, `excludedReason?`, `readError?`; `readVerifiedSource(context, path)` usa `readVerifiedSourceNative(repoRoot, path, expectedHash)` e devolve bytes do scan apenas quando hash atual coincide, senão lança `StaleSourceError(path, expectedHash, actualHash)`. A leitura nativa abre cada componente root-relative sem seguir symlink (`openat`/`O_NOFOLLOW`), exige arquivo regular e valida hash dos bytes lidos; não reabre o path absoluto por `readFileSync` depois da verificação.

- [ ] Criar fixtures para HTML/CSS, fonte na raiz, `js/`, manifestos aninhados, binário, ignorados por Git, subárvore ilegível e symlink externo. Injetar I/O para simular leitura negada sem depender de permissões/root.
- [ ] Inventariar assets por metadados sem ler bytes; calcular SHA-256 dos bytes originais de fonte antes de sanitização e persistir categoria, suporte e cobertura na geração.
- [ ] Aplicar uma única política de escopo, respeitar exclusões e não seguir symlink fora da raiz; testar dois caminhos equivalentes para a mesma raiz canônica.
- [ ] Migrar analyzers para selecionar arquivos pelo inventário e consumir `readVerifiedSource`; remover leituras independentes do filesystem durante análise de conteúdo.
- [ ] Migrar `ContainerInfraAnalyzer` para inventariar e ler Dockerfile/Compose via `readVerifiedSource`; teste muda compose entre scan e mapa e exige `STALE`, nunca incorpora o conteúdo alterado no `scanId` antigo.
- [ ] Testar troca por symlink externo entre enumeração e open: a abertura root-relative com `O_NOFOLLOW` recusa o path e não lê bytes fora da raiz.
- [ ] Alterar arquivo/remover arquivo entre scan e consulta e entre passagens REST: não certificar fato ou ausência sobre bytes divergentes; retornar `STALE`/`PARTIAL` com path e diagnóstico.
- [ ] Rodar `cargo test -p autodoc-core --test inventory_tests` e `npm test -w @autodoc/mcp -- tests/inventory_scope.test.ts tests/documentation_evidence.test.ts`.

**Aceite:** analisadores usam os mesmos paths/bytes do inventário; mudança de fonte invalida a proveniência antiga; assets não são apresentados como conteúdo analisado.

### Task 5: Resolver relações com identidade, escopo e evidências

**Files:** modificar `crates/autodoc-core/src/parser/{mod.rs,ast.rs,heuristics.rs}`, `crates/autodoc-core/src/cache/{mod.rs,schema.rs}`, `crates/autodoc-core/tests/symbol_resolution_tests.rs` e documentação de capacidades.

**Interfaces:** `ExtractedEdge` guarda `callerFqsn` (resolvido para ID semântico pelo cache), expressão completa do destino, intervalo da ocorrência, `occurrenceKind` e método de extração. A relação persistida guarda estado e candidatos; só relação `resolved` e executável vira aresta confirmada. Relações heurísticas ou sem binding permanecem candidates.

- [ ] Expandir testes para overloads Java, receivers Rust/Go, método `obj.save()`, import/sombra local, parâmetro, closure, destructuring, `for`, `catch`, callback registrado, comentário/string e autorrecursão verdadeira.
- [ ] Implementar resolução lexical por escopos AST para as construções suportadas; chamadas sem prova mantêm expressão e `unresolved`/`ambiguous`, sem `LIMIT 1` ou seleção por nome único fora do escopo.
- [ ] Guardar IDs semânticos estáveis e callsite evidence com hash/faixa de linhas da fonte original; validar FKs `fromId`, `toId`, `candidateIds` e `evidenceIds` na publicação.
- [ ] Declarar por linguagem as construções de binding/callback não cobertas e retornar cobertura parcial; não usar contagem de grau para concluir que callback/export/entrypoint é código morto.
- [ ] Rodar `cargo test -p autodoc-core --test symbol_resolution_tests`, `cargo test -p autodoc-core --test parser_identity_tests` e `npm test -w @autodoc/mcp -- tests/honesty_callbacks.test.ts`.

**Aceite:** toda relação confirmada aponta ao destino correto nas fixtures suportadas; cenários sem resolução permanecem visíveis sem aresta arbitrária ou classificação categórica.

### Task 6: Projetar mapas, tools e resources do mesmo snapshot

**Files:** criar `packages/autodoc-mcp/src/analysis/{profile.ts,map.ts}`, `packages/autodoc-mcp/tests/project_maps.test.ts`; modificar `packages/autodoc-mcp/src/analyzers/{architecture.ts,workspace.ts,honesty.ts}`, `packages/autodoc-mcp/src/diagrams/renderer.ts`, `packages/autodoc-mcp/src/diataxis/generator.ts`, `packages/autodoc-mcp/src/index.ts` e contratos MCP.

**Interfaces:** `buildArchitectureMap(context, level) -> MapProjection` retorna `{ scanId, repositoryRoot, coverage, nodes, relations }`; cada node/relation tem ID semântico, estado e `evidenceIds`. Resource URI e tool equivalente chamam a mesma projeção.

- [ ] Criar fixtures anotadas para site estático, CLI, biblioteca, serviço e workspace misto com main.py na raiz, `js/game.js`, manifests aninhados e diretório sem package.json.
- [ ] Testar que cada nó/aresta confirmada aponta a evidência da mesma geração; biblioteca não ganha ator usuário obrigatório, site misto não desaparece por faltar `src/` e projeto sem servidor não ganha server.
- [ ] Exercitar trace pelo handler MCP com geração carregada: `A→B` devolve somente caminho `[A,B]`; grafo ramificado `A→B` e `A→C` com destino C devolve `[A,C]`; ciclo termina sem repetir nós; caminho sem evidência retorna `path: []`, `sink: null`, `taintStatus: UNKNOWN` e status explícito.
- [x] Separar mapa de estrutura, imports, entrypoints e infraestrutura; níveis C4 2–4 usam fatos/relações do snapshot; fatos ausentes retornam parcial/não suportado.
- [x] Migrar `HonestyAnalyzer` para consultar o `SnapshotContext` fixado, removendo acesso direto ao `.autodoc/cache.db`; geração de documentos usa uma instância por execução.
- [x] Projetar recursos C4/mapa e tools equivalentes pela mesma função de projeção; igualdade local validada nos testes focados. Recursos ainda não aceitam `scanId` para pinagem entre requisições distintas.
- [x] Resource sem scan retorna `NOT_SCANNED`; hipótese arquitetural fica marcada separadamente e não entra em relações confirmadas.
- [ ] Rodar `npm test -w @autodoc/mcp -- tests/project_maps.test.ts tests/snapshot_contracts.test.ts`.

**Aceite:** tools, resources, mapas e documentos apontam para a mesma raiz e geração; fatos confirmados têm evidência válida.

### Task 7: Completar catálogos e exportação paginada sem perdas

**Files:** modificar `packages/autodoc-mcp/src/analyzers/{rest/index.ts,realtime/index.ts,schema/index.ts}`, `packages/autodoc-mcp/src/tools/handlers.ts`, `packages/autodoc-mcp/src/index.ts`, `packages/autodoc-mcp/src/diataxis/generator.ts`; criar/expandir `catalog_completeness.test.ts`.

**Interfaces:** todos catálogos retornam `{ items, total, nextCursor, truncated, coverage, scanId }`; `total` aplica filtros antes da paginação, `nextCursor` é vinculado a raiz/scan/collection/filtro/posição. `truncated` significa perda por limite de análise/orçamento, não haver próxima página.

- [ ] Criar fixtures de 201 endpoints, 251 eventos, 201 modelos e schema com 21 campos; comparar conjuntos ordenados de IDs e todos os campos com `expected-facts.json`.
- [ ] Remover limites fixos/slices de coleções e schemas; preservar aliases legados apenas como cópia exata da página atual durante a transição documentada.
- [ ] Usar aqui os limites de página já definidos no plano original; a Task 9 torna esses limites também aplicáveis à leitura de fonte, filas e staging do scan.
- [ ] Testar página vazia/exata/final, cursor inválido, outra raiz/scan/collection/filtro, geração retida e geração expirada; falha de cobertura não declara ausência comprovada.
- [ ] Fazer o exportador percorrer páginas da mesma geração e falhar se metadata, cursor ou evidência não validar; nunca misturar páginas nem limitar saída sem informar perda.
- [ ] Exercitar LLM pelo handler real: tenta inserir/remover rota ou relação, resposta inválida, provider indisponível e aceitação/rejeição abaixo/acima do limiar; LLM só anota hipótese/descrição vinculada a IDs existentes.
- [ ] Rodar `npm test -w @autodoc/mcp -- tests/catalog_completeness.test.ts tests/llm_operations.test.ts tests/documentation_export.test.ts`.

**Aceite:** todos os fatos confirmados e campos dos catálogos entram na referência exportada; paginação não perde/duplica registros e conteúdo LLM não altera entidades/relações.

### Task 8: Liberar locks órfãos sem roubar exportação ativa

**Files:** modificar `crates/autodoc-core/src/lib.rs`, bindings N-API gerados por build, `packages/autodoc-mcp/src/binding.ts`, `packages/autodoc-mcp/src/diataxis/exporter.ts`, `packages/autodoc-mcp/tests/documentation_export.test.ts` e contratos de exportação.

**Interfaces:** N-API fornece `acquireExportLockNative(path) -> Result<lockToken>` e `releaseExportLockNative(lockToken) -> Result<void>`. O core mantém uma conexão SQLite com `BEGIN IMMEDIATE` por token até release; o exporter usa esse mecanismo em todos os runtimes. Encerramento do processo deixa SQLite liberar o lock; não há guard file que precise ser apagado manualmente.

- [x] Criar regressões para lock ativo, lock mantido por subprocesso, morte do detentor após staging/journal, segundo processo recuperando o journal e lock ativo que recusa em timeout finito.
- [x] Implementar registry de conexões nativas tokenizadas; `acquire` usa timeout finito e conflito explícito; `release` remove apenas token conhecido, fecha conexão e retorna sucesso sem efeito para token já liberado; token desconhecido retorna erro.
- [x] Canonicalizar o destino existente com `realpathSync` após criar o diretório e guardar o banco de lock em `<canonical-destination>/.autodoc-export-lock.db`. Assim destinos distintos têm locks independentes e caminhos equivalentes competem no mesmo banco; symlinked destinations continuam rejeitados pela política de destino.
- [x] Remover lock por runtime `.autodoc-export.guard` e paths antigos; só chamar `recoverInterruptedExports` após obter lock nativo.
- [x] Testar em subprocessos: lock ativo, caminho canônico equivalente, destino independente e morte do owner no meio do commit; próxima execução recupera journal e preserva edição manual.
- [x] Integrar falha real de processo: subprocesso grava journal, interrompe exportação depois da primeira mutação e morre; a próxima execução adquire o lock, recupera a transação e preserva edição manual feita após a interrupção.
- [x] Fechar TOCTOU de symlink no Linux: root creation, staging/journal writes, commit/rollback e limpeza percorrem descritores `O_DIRECTORY|O_NOFOLLOW`; lock SQLite usa a identidade `dev+ino` da raiz aberta e `SQLITE_OPEN_NOFOLLOW`. Regressões cobrem troca durante checagem, após `realpathSync`, após abertura dos descritores e durante aquisição do lock. Recuperação move o candidato para quarantine antes de comparar hash e preserva edição concorrente/journal. Export falha fechado fora do Linux porque o fallback não oferece proteção equivalente.
- [x] Testar que chamar `releaseExportLockNative(token)` duas vezes retorna sucesso nas duas chamadas e fecha a conexão apenas uma vez; token desconhecido retorna erro sem afetar locks existentes.
- [x] Simular lock/database corrompido, token inválido, journal com MAC inválida e arquivo editado durante interrupção; preservar bytes desconhecidos e retornar conflito. `PRAGMA quick_check(1)` faz o acquire falhar fechado em DB corrompido; teste confirma que os bytes ficam intactos. Os casos de token/MAC/edição também têm regressões.
- [x] Rodar build MCP e testes focados do exportador; gate completo do core e pacote MCP fica na Task 10.

**Aceite:** todos os runtimes usam o mesmo lock por destino; processo encerrado libera lock pelo SQLite; lock ativo nunca é removido/roubado e journal só altera estado autenticado conhecido.

### Task 9: Aplicar limites e backpressure à leitura e staging

**Files:** modificar `crates/autodoc-core/src/{inventory.rs,scanner.rs,cache/mod.rs,lib.rs}`, `packages/autodoc-mcp/src/analysis/{contracts.ts,source-reader.ts}`, `packages/autodoc-mcp/src/tools/handlers.ts`; criar testes de limite no core e MCP.

**Interfaces:** `ScanOptions { maxSourceBytes: 4 MiB, workers: 4, queueCapacity: 16, batchSize: 256 }`; `PageOptions { maxItems: 500, maxBytes: 1 MiB }`. Valores menores podem ser injetados para testes; valores acima dos defaults são rejeitados até existirem budgets explícitos.

- [x] Adicionar testes com arquivos sintéticos e orçamento pequeno para max bytes, fila, workers, lote e payload; verificar motivo/path no diagnóstico. Payload cobre limite por item/página nativa.
- [x] Fazer walker enumerar incrementalmente; usar fila limitada e lotes gravados no staging sem criar segunda cópia integral do projeto em memória.
- [x] Ao atingir limite, marcar scan/cobertura parcial, manter ativa a última geração completa e não reconciliar arquivos ausentes daquela tentativa.
- [x] Na paginação nativa, encerrar página ao atingir 500 items ou 1 MiB; devolver cursor quando só há próxima página, e `truncated: true` apenas se o orçamento impede processar fatos ainda não armazenados.
- [x] Se o próximo registro individual exceder 1 MiB, devolver `ITEM_TOO_LARGE` com identificador e tamanho, sem avançar cursor nem declarar catálogo completo/truncado como se o registro tivesse sido omitido com segurança.
- [x] Rodar gates focados Rust de inventário/snapshot/publicação e MCP de contrato/paginação; gate completo fica na Task 10.

**Aceite:** limites são observáveis e testáveis; atingir orçamento nunca publica inventário parcial como completo nem apaga fatos da geração ativa.

### Task 10: Medir precisão, atualizar contratos e fechar o gate

**Files:** atualizar fixtures em `packages/autodoc-mcp/tests/fixtures/{cli,library,api,mixed,unsupported}`, `product_accuracy.test.ts`, `generated_diagrams.test.ts`, `packages/autodoc-mcp/package.json`, `README.md`, `docs/reference/{mcp-contracts.md,tools.md,architecture.md}`, `docs/tutorials/getting-started.md` e o ledger.

**Interfaces:** evaluator produz métricas por perfil/capacidade para facts, relações, evidência, cobertura e estabilidade entre scans. Esperados são anotados independentemente; relatório diferencia `unsupported`, `partial`, `not_scanned` e ausência comprovada.

- [x] Completar `expected-facts.json` para os perfis portáveis; comparar IDs, relações, schemas avaliados como unsupported, e evidências. O perfil library contém uma relação e evidência anotadas independentemente; hashes/ranges e estado/diagnóstico de cobertura são validados. O oracle fica fora da raiz escaneada.
- [x] Remover arquivo e adicionar arquivo entre G1/G2; comparar símbolos, hashes de inventário, facts, evidências e relações. G1 permanece imutável; IDs/evidência de chamadas preservadas são estáveis; G2 exige `new.ts` no inventário e `removed.ts` ausente após publicação completa.
- [x] Testar saída/diagrama com aspas, newline e caracteres especiais; validar Mermaid real e número esperado por perfil. O renderer normaliza quebras de linha em labels para espaço. O parse valida sintaxe, não contraste nem ausência de clipping.
- [x] Atualizar docs de geração/retention/cursor, stale source, cobertura parcial (incluindo rota REST heurística), lock nativo, conflitos de exportação, cache XDG, limites, contratos paginados e capacidades medidas de trace/LLM/exportação.
- [x] Executar gate final, ler todos os outputs e salvar resumo com comandos/contagens em `docs/temp/reviews/2026-10-22-autodoc-open-findings-verification.md`:

```bash
cargo test -p autodoc-core
npm run build -w @autodoc/core
npm run build -w @autodoc/mcp
npm test -w @autodoc/mcp
npm run validate:generated-diagrams -w @autodoc/mcp
npm run validate:diagrams
git diff --check
```

- [x] Fazer revisão final por agente contra Review Focus e cada aceite, corrigir findings Critical/Important e reexecutar gates invalidados. Não marcar tarefas concluídas só por testes de integração sem comparação com seus critérios.

**Aceite:** todos os perfis declarados têm expectativas independentes e evidências verificadas; contratos e documentação correspondem ao comportamento medido; gaps remanescentes estão explicitamente classificados como fora de capacidade.

## Execução e encerramento

O método anterior foi execução nativa no worktree, sem commits. Este documento é planejamento; executar cada tarefa com TDD e verificação conforme autorizado anteriormente, preservando alterações locais. Não declarar o plano fechado enquanto Tasks 1–10 e o Review Focus não forem aceitos.

# AutoDoc: correção da análise e da documentação — Implementation Plan

> **For agentic workers:** Use `superpowers-executing-plans` para executar uma tarefa por vez. Passos usam checkboxes. Este documento planeja a implementação; não autoriza publicação, merge ou alterações em projetos usados como exemplo.

**Goal:** Fazer o AutoDoc mapear projetos variados com evidências rastreáveis, cache consistente e resultados que expressem erros, ambiguidade e limites de cobertura.

**Architecture:** Separar inventário de arquivos, extração de fatos, resolução de relações e publicação de um snapshot. Analisadores, mapas e documentos consomem o mesmo snapshot e preservam a origem das informações. Aplicar primeiro contenções aos resultados inventados e depois substituir a descoberta fragmentada pelo modelo comum.

**Tech Stack:** Rust, SQLite, Tree-sitter, Node-API, TypeScript, MCP e Vitest já usados pelo repositório. Usar `tempfile` e temporários Node nos testes. Não adicionar dependência de runtime ao servidor; o gate de sintaxe Mermaid poderá usar dependência de desenvolvimento, se não houver parser reutilizável nas dependências instaladas. Resolver a API e fixar sua versão na execução, a partir da documentação/registro oficiais.

**Spec:** [Revisão do produto](../reviews/2026-10-22-autodoc-product-review.md). Este plano detalha e substitui a lista de fases daquela revisão e o plano anterior sobre o jogo.

## Global Constraints

- O produto é o AutoDoc. O jogo estático serve de cenário de regressão; não alterar sua aplicação nem os arquivos em Downloads.
- Preservar as alterações locais preexistentes, inclusive `src/llm/factory.ts` e os arquivos em `.agents/`. Não editar artefatos de skills ou agentes como parte das correções.
- Manter a remoção de `agnostic_analyzers.test.ts`. Não recriar dependência de repositório externo nem testes condicionais à máquina do desenvolvedor.
- Não transformar ausência de evidência em presença, ausência comprovada ou segurança confirmada.
- Não ampliar modelos LLM, linguagens ou frameworks para compensar defeitos de integridade.
- Atualizar contrato MCP, binding, documentação e consumidores no mesmo incremento quando houver mudança observável. Documentar migrações do cache antes de aplicá-las.
- Cada tarefa termina com testes focados e revisão do diff. Fazer commits apenas se a execução vier acompanhada dessa autorização; não incluir alterações locais de outra origem.

## Review Focus

1. Projeto vazio, inválido ou ilegível: distinguir vazio válido de análise ausente/falha. Tarefas 2 e 7.
2. Segundo scan com remoção, rename ou interrupção: consultas enxergam uma geração consistente, sem exclusões baseadas em leitura incompleta. Tarefa 5.
3. Homônimos, callbacks e overloads: preservar identidades e incerteza, sem ligações arbitrárias ou diagnóstico de código morto confirmado. Tarefas 6 e 9.
4. Site estático e workspace misto: arquivos fora de `src/` e componentes sem package manifest entram no inventário; não presumir servidor. Tarefas 3, 7 e 8.
5. Exportação repetida, truncamento e arquivos manuais: referências completas e limpeza restrita aos artefatos pertencentes ao gerador. Tarefas 10 e 11.

## Estado inicial e ordem

Já executados nesta sessão: 20 testes Rust passaram; após remover o benchmark externo, 61 testes MCP passaram sem skips. Os builds Rust/Node-API e TypeScript passaram. Esses resultados são baseline, não prova dos cenários novos.

Ordem: `1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12`. A ordem sequencial evita desenvolver dois contratos diferentes para o mesmo grafo. Cada fase deve deixar o produto utilizável com suas limitações explicitadas.

## Contratos e decisões compartilhadas

- **Superfície pública:** alterações percorrem structs e funções NAPI Rust, declarações geradas pelo build (`crates/autodoc-core/index.d.ts`), `binding.ts`, schemas Zod, normalização de aliases, wrappers, dispatcher/`tools/list`, resources/read e documentação. Não editar declarações geradas como fonte independente.
- **Aliases:** normalizar nomes antes de aplicar defaults. Valores equivalentes são aceitos; aliases com valores diferentes geram erro de validação. Isso vale para `maxDepth`/`max_depth`, caminhos de repositório e demais pares anunciados. Os campos novos, incluindo destino opcional e cursor, devem estar no schema de entrada público.
- **Versão:** respostas cujo contrato muda carregam `contractVersion: 2`; registrar na documentação os campos anuláveis e novos estados. Remover resultados fictícios é mudança deliberada: não oferecer fallback legado que volte a inventar fatos.
- **Envelope do snapshot:** definir em Rust/TypeScript, antes da tarefa 5, `schemaVersion`, `scanId`, `repositoryRoot`, `createdAt`, `extractorVersions`, `coverage`, `latestAttempt`, `freshness`, totais por coleção e os tipos de `facts`, `evidence` e `relations`. Fato: `{ id, kind, evidenceIds, attributes }`; relação: `{ id, fromId, toId?, kind, resolution, candidateIds, evidenceIds }`; evidência usa o contrato da tarefa 7 e o hash dos bytes originais quando houve extração de conteúdo. Observações de inventário sobre assets referenciam metadados, sem alegar leitura de conteúdo. Validar o envelope e páginas em runtime; campos obrigatórios ausentes ou versão incompatível são erro explícito.
- **Leitura consistente:** armazenar gerações publicadas imutáveis e fixar `scanId` por consulta composta. Metadados e cada página são lidos sob transação de leitura; todas as consultas filtram a mesma geração. Retenção deve conservar gerações em uso durante a transação; uma página posterior cuja geração já não esteja disponível falha explicitamente, sem trocar para a geração atual.
- **Identidade:** IDs públicos de fatos/relações são determinísticos a partir da raiz canônica e identidade semântica; IDs de linhas SQLite são internos. Registros e FKs publicados são qualificados por geração. Comparações entre scans usam IDs semânticos, não sequência de inserts.
- **Origem dos fatos:** analisar bytes originais somente em memória e calcular seu SHA-256 antes de sanitizar textos para persistência, logs, prompts ou exportação. Guardar localização original e campos textuais sanitizados; nunca armazenar o arquivo bruto para resolver consistência. Uma relação de heurística sem contexto executável comprovado permanece candidata, mesmo que seu destino tenha nome único.
- **Limites:** staging em lotes persistidos, sem manter outra cópia integral do projeto em RAM. Adotar opções testáveis com defaults de 4 MiB por fonte, até 4 workers, fila de 16 arquivos e lotes de até 256 fatos; paginação por até 500 registros ou 1 MiB de payload, o que atingir primeiro. Limite atingido tem diagnóstico e estado parcial, sem substituir geração completa. Assets são inventariados por metadados. Não prometer teto global de RSS com esses limites sem medição.

## Fase 1 — Conter respostas sem evidência

### Tarefa 1 — Corrigir trace, contratos de símbolos e resources fictícios

**Arquivos:** modificar `packages/autodoc-mcp/src/tools/handlers.ts`, `src/index.ts`, `tests/{tools.test.ts,protocol.test.ts}`, `docs/reference/mcp-contracts.md` e `docs/reference/tools.md`; criar `packages/autodoc-mcp/tests/{trace_evidence.test.ts,symbol_evidence.test.ts,resource_evidence.test.ts}` e `tests/helpers/repository.ts`.

**Interface:** o helper `createRepository(files: Record<string, string>): { root: string; cleanup(): void }` cria uma árvore em `mkdtempSync`, escreve os arquivos e remove apenas seu temporário. O trace conserva `source`, `maxDepth` e `path`, acrescenta `analysisKind: "call_graph"`, `nodes`, `edges` e `status: "SUCCESS" | "PARTIAL" | "NOT_FOUND" | "NOT_SCANNED" | "AMBIGUOUS" | "FAILED" | "STALE" | "UNSUPPORTED"`. `sink` pode ser `null`; `taintStatus` é `"UNKNOWN"`. `path` só contém uma cadeia de chamadas comprovadas, nunca uma concatenação de ramos. `get_symbol_contract` utiliza os mesmos estados aplicáveis: não encontrado não recebe assinatura, complexidade ou linhas fabricadas.

- [ ] Criar regressão com cache ausente, símbolo inexistente e rota inexistente. Exemplo de asserção para o símbolo:

```ts
const res = await tools.handleTraceDataFlow({
  repository_path: repo.root, entrypoint_symbol: "missing", maxDepth: 5,
});
expect(res.path).toEqual([]);
expect(res.taintStatus).toBe("UNKNOWN");
expect(res.status).toBe("NOT_SCANNED"); // fixture sem cache
expect(res.sink).toBeNull();
```

- [ ] Executar `npm test -w @autodoc/mcp -- tests/trace_evidence.test.ts` e confirmar que a regressão acusa os fallbacks atuais.
- [ ] Remover caminhos fixos de Express/Mongoose/SQLite/sanitizador e a classificação por nomes como `save` ou `validate`. Separar profundidade de travessia de limite de nós; usar limite com diagnóstico de truncamento.
- [ ] Criar fixtures distintas: sem cache → `NOT_SCANNED`; geração completa sem símbolo → `NOT_FOUND`; homônimos → `AMBIGUOUS` com candidatos exatos; cache corrompido → `FAILED`. Cobrir um caminho real presente e destino não alcançável. Não aceitar múltiplos estados numa mesma asserção de diagnóstico.
- [ ] Remover o fallback de assinatura Rust em `handleGetSymbolContract`; usar arquivo/FQSN como filtros efetivos e não escolher o primeiro homônimo. Testar assinatura existente, desconhecida, ambígua e erro de leitura.
- [ ] Remover `App → Database` e `{ graph: "empty" }` fixos de `ReadResourceRequestSchema`. Nesta fase, um resource sem implementação real responde indisponível; na tarefa 8, tools e resources usam o mesmo gerador. URI desconhecida é erro, sem fallback genérico. A seleção de raiz segue a política do último scan bem-sucedido; a resposta identifica raiz e geração, sem trocar de alvo silenciosamente.
- [ ] Testar via schema e dispatcher MCP `max_depth: 2`, aliases equivalentes e aliases conflitantes; anunciar `target_sink`/alias legado no input schema. O default 5 só é aplicado depois da normalização.
- [ ] Para entrada ambígua por nome simples, devolver candidatos; para `targetSink` informado, procurar caminhos reais até o destino. Cobrir `A→B`, `A→C` para impedir a invenção de `B→C`, além de ciclo e limite de profundidade.
- [ ] Atualizar o teste existente que hoje exige middleware e persistência fictícios. Documentar que a ferramenta oferece alcance de chamadas, sem provar fluxo de dados ou sanitização. Rodar os testes focados novamente.

**Aceite:** todo passo retornado corresponde a uma chamada comprovada; não há assinatura, topologia ou sanitização inventada em tools ou resources. Em cache legado sem proveniência suficiente, o trace informa limitação e não promove a relação a prova.

### Tarefa 2 — Tornar falhas e análise parcial observáveis

**Arquivos:** modificar `crates/autodoc-core/src/scanner.rs`, `src/lib.rs`, `src/errors.rs`, `crates/autodoc-core/index.d.ts`, `packages/autodoc-mcp/src/binding.ts`, `src/tools/handlers.ts` e `tests/tools.test.ts`; criar `packages/autodoc-mcp/tests/scan_status.test.ts`.

**Interface:** preservar contadores existentes, acrescentando `analysisState: "complete" | "partial" | "failed"` e `diagnostics: Array<{ stage: string; code: string; path?: string; message: string }>` ao resultado nativo e MCP. `status` do scan passa a `SUCCESS`, `PARTIAL` ou `FAILED`, respectivamente. `scannedFiles` conta arquivos efetivamente processados; candidatos e arquivos com erro têm contadores separados. Mensagens não incluem conteúdo dos arquivos.

- [ ] Testar binding ausente, binding que lança erro, raiz inexistente e diretório vazio válido. O teste do binding deve exigir `status === "FAILED"`, não apenas contagem zero.
- [ ] Executar `npm test -w @autodoc/mcp -- tests/scan_status.test.ts`; observar falha antes da correção.
- [ ] Validar raiz antes de abrir/criar cache; propagar falhas de persistência e resolução, substituindo `let _ = ...` e `unwrap_or(0)` nos caminhos críticos do scan. Capturar erro do walker e de leitura com etapa e caminho.
- [ ] Estender `ParseOutput` com status por capacidade/extrator e diagnósticos localizados. Separar AST válido sem símbolos, linguagem não suportada, recuperação parcial e falha de inicialização. Sintaxe com `ERROR`/`MISSING` não pode produzir análise completa silenciosa. Testar função válida seguida de trecho malformado e falha de parser injetada.
- [ ] Atualizar o último repositório ativo somente segundo política documentada: falha não troca o snapshot ativo anterior; consultas com caminho explícito sempre usam o caminho solicitado.
- [ ] Cobrir falha de escrita por injeção controlada, sem depender de permissões Unix ou da execução como root. Recompilar o binding antes dos testes MCP e executar também `cargo test -p autodoc-core`.

**Aceite:** erro não vira sucesso vazio; contador de símbolos persistidos não inclui lote cuja gravação falhou.

### Tarefa 3 — Retirar pressupostos de domínio dos documentos

**Arquivos:** modificar `packages/autodoc-mcp/src/analyzers/workspace.ts`, `src/analyzers/architecture.ts`, `src/diataxis/generator.ts`; criar `tests/documentation_evidence.test.ts` e `tests/fixtures/static-site/{index.html,js/game.js,css/style.css}`; atualizar `tests/llm_operations.test.ts` ou outros consumidores das interfaces alteradas.

**Interface:** campos de comando de `WorkspaceInfo.commands` passam a `string | null`. Para npm/yarn/pnpm/bun, comandos de build/test/dev exigem scripts existentes; sugestões de execução ficam separadas dos comandos detectados. Requisitos de runtime vêm de configuração do projeto e carregam sua origem.

- [ ] Criar fixture estática mínima e fixture com `package.json` contendo apenas script `start`. Não copiar assets ou conteúdo da campanha; usar HTML e eventos sintéticos.
- [ ] Acrescentar testes com estas invariantes:

```ts
const docs = new DiataxisGenerator(repo.root).synthesizeFullDocumentation();
const text = docs.map(d => d.content).join("\n");
expect(text).not.toMatch(/Express|Socket\.io|Better Auth|WalletService/);
expect(text).not.toMatch(/npm install|npm run build|cp \.env\.example/);
expect(docs.some(d => d.relativePath === "how-to/add-new-module.md")).toBe(false);
```

- [ ] Rodar `npm test -w @autodoc/mcp -- tests/documentation_evidence.test.ts` e observar a falha atual.
- [ ] Remover defaults de servidor, realtime, infraestrutura, autenticação, carteira e versão fixa de runtime. Só emitir seções de ambiente, instalação e módulos quando os respectivos arquivos/contratos existirem.
- [ ] Preservar a detecção legítima: fixture Node com script `build` deve mostrar seu comando; Maven sem Spring não recebe `spring-boot:run`; ausência de `.env.example` não gera instrução de cópia. Rodar os testes focados e `npm run build -w @autodoc/mcp`.

**Aceite:** os documentos passam a ser conservadores mesmo antes do inventário comum da fase 3.

## Fase 2 — Garantir integridade do snapshot e das relações

### Tarefa 4 — Corrigir IDs e integridade referencial

**Arquivos:** modificar `crates/autodoc-core/src/cache/mod.rs`, `src/cache/schema.rs`, `tests/storage_tests.rs`; criar `tests/cache_identity_tests.rs`.

**Interface:** conservar os métodos públicos de escrita e seus retornos; o ID devolvido deve ser o ID da chave escrita, tanto em insert quanto em update. Evoluir schema com migração explícita e FK de arestas para símbolos.

- [ ] Adicionar regressão que intercala inserção de dois arquivos e vários símbolos, depois atualiza o primeiro:

```rust
let first = storage.insert_file("a.rs", 1, 10, "a", "rs").unwrap();
storage.insert_file("b.rs", 1, 10, "b", "rs").unwrap();
let again = storage.insert_file("a.rs", 2, 11, "c", "rs").unwrap();
assert_eq!(first, again);
```

- [ ] Repetir a regressão para `insert_symbol` e `insert_batch_analysis`; consultar a associação arquivo/símbolo, sem assumir IDs consecutivos. Rodar `cargo test -p autodoc-core --test cache_identity_tests`.
- [ ] Substituir `last_insert_rowid()` nos upserts por `RETURNING file_id`/`symbol_id`; habilitar `foreign_keys` em todas as conexões relevantes, incluindo writer.
- [ ] Na migração, eliminar arestas órfãs e reconstruir FTS em transação; para cache legado cuja associação de arquivos não possa ser recuperada, invalidar a análise e exigir novo scan, sem reapresentar dados como válidos.
- [ ] Invalidar também o marcador de publicação do cache legado quando a análise for invalidada. Recusar `user_version > CURRENT_SCHEMA_VERSION` sem escrita; cobrir banco de versão futura e rollback da migração interrompida.
- [ ] Ajustar `test_without_rowid_and_covering_indexes`, que atualmente insere arestas com IDs inexistentes: criar símbolos reais. Exigir `PRAGMA foreign_key_check` vazio e rollback em erro de migração.

**Aceite:** regravar a mesma chave preserva sua identidade; aresta inválida é rejeitada.

### Tarefa 5 — Publicar scans de forma consistente e reconciliar exclusões

**Arquivos:** modificar `crates/autodoc-core/src/cache/{mod.rs,schema.rs}`, `src/scanner.rs`, `src/lib.rs`, `packages/autodoc-mcp/src/binding.ts`, `src/tools/handlers.ts`, schemas/anúncios em `src/index.ts` e declarações NAPI regeneradas; criar `crates/autodoc-core/tests/scan_snapshot_tests.rs`.

**Interface:** adicionar `scan_runs` com identificador, raiz canônica, estado e timestamps. Preparar arquivos/símbolos/relações de uma geração antes de uma transação curta que troca o ponteiro ativo. Expor `scanId` no resultado nativo e no MCP. Manter registros qualificados por geração e sua retenção segundo os contratos compartilhados. Um scan completo substitui o snapshot ativo; scan parcial não substitui o snapshot completo e devolve diagnósticos da tentativa. Se nenhum completo existir, ferramentas informam análise parcial/indisponível. Linguagem não suportada explicitamente inventariada não é, sozinha, falha do inventário; a cobertura semântica dessa linguagem permanece `unsupported`.

- [ ] Criar um projeto temporário com dois arquivos e uma chamada; escanear duas vezes e comparar caminhos, FQSNs e relações ordenadas, excluindo apenas metadados temporais.
- [ ] Adicionar casos separados para remoção de chamada, função e arquivo, rename e função que passa a ter zero símbolos. Exigir ausência dos registros antigos e uma entrada FTS por símbolo atual.
- [ ] Rodar `cargo test -p autodoc-core --test scan_snapshot_tests` antes da implementação.
- [ ] Implementar staging e publicação no writer; reconciliar arquivos ausentes somente após enumeração completa. Publicar arquivos, símbolos, arestas e FTS no mesmo commit de banco.
- [ ] Injetar falha no meio do scan e consultar por conexão leitora: deve permanecer a geração anterior integral. Cobrir dois scans concorrentes da mesma raiz: serializar publicação e impedir resultado misto ou tentativa antiga sobrescrevendo geração mais recente.
- [ ] Usar barreira determinística entre duas consultas que montam um snapshot e publicar G2 enquanto G1 é lida: a leitura devolve integralmente G1 ou G2, sem mistura. Testar também paginação com geração removida: erro explícito, nunca retorno de outra geração.
- [ ] Aplicar fila/lotes/limites dos contratos compartilhados antes de ler fontes grandes; testar com limites reduzidos por opção, sem benchmark de memória nem arquivos enormes. Alcançar limite preserva a geração completa anterior e registra motivo/caminho.

**Aceite:** idempotência semântica entre scans, nenhuma entidade removida no snapshot novo e nenhuma visão híbrida durante atualização.

### Tarefa 6 — Preservar identidades e resolver chamadas conservadoramente

**Arquivos:** modificar `crates/autodoc-core/src/parser/{mod.rs,ast.rs,heuristics.rs}`, `src/cache/{mod.rs,schema.rs}`; criar `tests/symbol_resolution_tests.rs` e ampliar `tests/parser_tests.rs`.

**Interface:** símbolo registra módulo, escopo, receiver quando conhecido e identidade de assinatura para overloads. Relação bruta preserva expressão do destino, localização, método de extração e tipo de ocorrência: declaração, referência, registro de callback ou chamada. Resolução devolve `resolved`, `ambiguous` ou `unresolved`, com IDs candidatos. Somente uma ocorrência comprovadamente executável com destino `resolved` integra as arestas de chamada confirmadas. Relação heurística sem prova contextual permanece candidata, mesmo com nome único. Não descartar autorrecursão real.

- [ ] Criar regressões para duas funções `save` em arquivos diferentes, função local sombreando import, método `obj.save()`, dois `impl` Rust com `new`, overloads Java e métodos Go de receivers distintos.
- [ ] Verificar unicidade de identidade, não apenas quantidade. Exemplo obrigatório:

```rust
let parsed = parse_file(
    "struct A; struct B; impl A { fn new() {} } impl B { fn new() {} }",
    "types.rs", "rs",
);
let names: std::collections::HashSet<_> = parsed.symbols.iter()
    .filter(|s| s.name == "new").map(|s| &s.fqsn).collect();
assert_eq!(names.len(), 2);
```

- [ ] Rodar `cargo test -p autodoc-core --test symbol_resolution_tests` e os testes de parser para demonstrar as limitações atuais.
- [ ] Remover seleção global por nome com `LIMIT 1`; resolver por escopo/import/receiver somente quando comprovado. Chamadas externas ou dinamismo não resolvido preservam a expressão e o motivo, sem escolher o primeiro candidato.
- [ ] Verificar chamadas qualificadas e callbacks sem perder receiver/import no parser; preservar ciclos. Rodar também testes de snapshot para garantir identidade estável em rescans.
- [ ] Acrescentar fixtures Ruby com declaração sem recursão, recursão real, chamada em comentário/string e ocorrência fora do corpo. Impedir que `def unused()` gere `unused → unused`; deduplicar relações, além de símbolos. Testar que uma ocorrência sintática não executável nunca vira aresta confirmada por apenas resolver seu nome.

**Aceite:** nenhuma colisão nas fixtures suportadas; cada aresta confirmada aponta ao símbolo esperado; casos desconhecidos continuam visíveis.

## Fase 3 — Unificar inventário, evidências e mapas

### Tarefa 7 — Introduzir inventário e snapshot compartilhados

**Arquivos:** criar `crates/autodoc-core/src/inventory.rs`, `tests/inventory_tests.rs`, `packages/autodoc-mcp/src/analysis/{contracts.ts,snapshot.ts,source-reader.ts}` e `tests/inventory_scope.test.ts`; modificar scanner, cache/schema, `src/lib.rs`, binding, declarações NAPI regeneradas, schemas/wrappers/handlers e `src/index.ts`; adaptar `src/analyzers/{workspace.ts,containers.ts,rest/index.ts,realtime/index.ts,schema/index.ts}`.

**Interface:** o inventário Rust registra caminho relativo, categoria, linguagem, suporte, hash SHA-256 dos bytes lidos, motivo de exclusão e erro. Inventariar metadados de assets sem ler binários. Expor `readRepositorySnapshotNative(repoPath): string` para metadados/totais e `readSnapshotPageNative(repoPath, scanId, collection, cursor, limit): string` para coleções de fatos/evidências/relações/arquivos. Cada resposta é JSON versionado e limitado; não serializar todo o repositório numa string sem orçamento. Leitura não inicia scan nem cria banco. A resolução do cache deve ser a mesma da escrita, incluindo XDG, com raiz canônica validada.

Contrato TypeScript mínimo, definido em `analysis/contracts.ts`:

```ts
export type Resolution = "resolved" | "ambiguous" | "unresolved";
export interface Evidence {
  id: string;
  path: string;
  contentSha256?: string; // obrigatório para evidência extraída de conteúdo
  lineStart?: number;
  lineEnd?: number;
  extractor: string;
  method: "inventory" | "ast" | "config" | "heuristic" | "llm";
}
export interface Coverage {
  state: "complete" | "partial" | "not_scanned" | "unsupported";
  examined: number;
  excluded: number;
  diagnostics: Array<{ code: string; path?: string }>;
}
export interface InventoryFile {
  path: string;
  contentSha256?: string; // ausente para asset inventariado sem leitura
  category: "source" | "markup" | "style" | "manifest" | "infra" | "docs" | "asset" | "other";
  support: "ast" | "heuristic" | "metadata" | "unsupported";
}
```

`loadSnapshot(repoPath)` em `analysis/snapshot.ts` valida envelope e raiz, devolvendo contexto ligado a `scanId` com páginas das coleções. Em `source-reader.ts`, `readVerifiedSource(context, path)` captura os bytes uma vez, verifica o SHA-256 contra o inventário e devolve somente aquele buffer ao extrator. Divergência gera `STALE`; não incorporar os fatos desse arquivo ao catálogo confirmado. Cada passagem REST/workspace/schema deve usar o mesmo buffer verificado, sem novas chamadas a `readFileSync` do extrator. Nunca atribuir conteúdo novo ao `scanId` anterior.

- [ ] Testar HTML/CSS, fonte na raiz, `js/`, configuração, binário, arquivo ignorado, subárvore ilegível e symlink externo. A decisão de escopo usa um único conjunto de regras, respeita Git e evita seguir links externos.
- [ ] Definir adapter de I/O injetável para erro de leitura e metadados de links; casos obrigatórios de ilegibilidade/symlink não dependem de permissões, root ou suporte local a links. Testes reais de filesystem complementam, sem substituir essas asserções por skips.
- [ ] Rodar `cargo test -p autodoc-core --test inventory_tests` e `npm test -w @autodoc/mcp -- tests/inventory_scope.test.ts`.
- [ ] Persistir inventário e cobertura no snapshot; substituir caminhadas TypeScript por seleção do inventário. Registrar limites de profundidade/tamanho e capacidades não suportadas em vez de silêncio.
- [ ] Alterar arquivo entre scan e consulta e entre passagens REST: nenhuma rota extraída de bytes divergentes recebe o `scanId` antigo. Testar página com schema incompatível, origem de outra raiz e hash divergente; rejeitar em runtime. O catálogo que depende desses bytes fica indisponível/parcial com diagnóstico, sem certificar ausência.
- [ ] Mover acesso direto a `.autodoc/cache.db` para o carregador comum em arquitetura, honesty, contratos de símbolos e trace. Testar cache no XDG e projeto aberto por dois caminhos equivalentes.
- [ ] Atualizar testes das classes públicas para fornecer contexto ou efetuar scan explícito de temporário. Ausência de scan gera estado explícito, sem acesso oculto a outro repositório.
- [ ] Retornar `scanId`, data da geração e `freshness: "verified" | "unchecked" | "stale"`. Sem comparar o conteúdo atual com os hashes inventariados, marcar `unchecked`; detectar diferença implica `stale` e recomendação de novo scan. Se a tentativa mais recente falhou, informar que os fatos consultados pertencem à geração completa anterior.

**Aceite:** ferramentas distintas identificam a mesma geração/raiz e analisam os bytes dessa geração; HTML/CSS entram no inventário sem alegar suporte AST que não existe. Consulta composta e páginas nunca misturam gerações.

### Tarefa 8 — Derivar mapas e workflows a partir das evidências

**Arquivos:** criar `packages/autodoc-mcp/src/analysis/{profile.ts,map.ts}` e `tests/project_maps.test.ts`; modificar `src/analyzers/{architecture.ts,workspace.ts}`, `src/diagrams/renderer.ts`, `src/diataxis/generator.ts`, tools/resources em `src/index.ts` e documentação MCP.

**Interface:** `profile.ts` retorna capacidades por pacote/diretório, cada uma ligada a `evidenceIds`. `map.ts` produz nós e relações com `id`, `kind`, `evidenceIds` e estado de resolução. Diagramas e Markdown referenciam esses IDs. Estrutura, imports, entrypoints e infraestrutura são mapas distintos, com filtros de visualização que não removem fatos da base.

- [ ] Criar fixtures estática, CLI, biblioteca, serviço e workspace misto com expectativa de fatos anotada em JSON. Uma biblioteca sem entrypoint não recebe ator usuário obrigatório; workspace misto conserva site e serviço.
- [ ] Testar o caminho `js/game.js`, `main.py` na raiz, manifestos aninhados e pacote sem servidor. Exigir que cada nó e relação confirmados tenham pelo menos uma evidência válida.
- [ ] Rodar `npm test -w @autodoc/mcp -- tests/project_maps.test.ts` antes e depois da implementação.
- [ ] Remover filtros SQL por convenção de pasta e tecnologias fixas. Agrupar componentes por responsabilidade/módulo comprovado; nível 4 usa símbolos e relações de código, sem retornar nível 3 com outro rótulo. Se a base for insuficiente, retornar `unsupported` ou mapa parcial com explicação.
- [ ] Derivar comandos e seções do tutorial do perfil e das evidências; fonte local da instrução deve ser navegável. Validar que os outputs conservadores da tarefa 3 permanecem corretos.
- [ ] Substituir os estados transitórios dos resources da tarefa 1 por projeções do mesmo mapa das tools. Comparar entidades, relações, raiz e `scanId` de `code://c4/2` e `code://graph/callgraph` com as respectivas tools; raiz não selecionada é `NOT_SCANNED`, não topologia genérica.

**Aceite:** mapas funcionam fora de estruturas convencionais e os quatro níveis não se confundem; hipótese arquitetural aparece como hipótese.

### Tarefa 9 — Declarar cobertura do parser e corrigir candidatos a código morto

**Arquivos:** modificar `crates/autodoc-core/src/parser/{mod.rs,ast.rs,heuristics.rs}`, `packages/autodoc-mcp/src/analyzers/honesty/index.ts`, `src/diataxis/generator.ts`; criar `tests/parser_coverage_tests.rs` no core e `packages/autodoc-mcp/tests/honesty_callbacks.test.ts`.

**Interface:** a matriz de capacidade por linguagem diferencia inventário, AST, heurística, imports e callbacks. Candidatos de honesty carregam motivo, evidências e cobertura; usar `candidateCount` em vez de apresentar a soma como total confirmado de código morto.

- [ ] Testar `export const handler = () => service()`, function expression atribuída, docstring, comentário de documentação, método em classe e callback nomeado registrado por `addEventListener`.
- [ ] Extrair estrutura dos bytes originais somente em memória; sanitizar signature/docstring e outros textos antes de persistir ou enviar a ferramentas/LLM. Cobrir `function f() { return +1; }` e texto sintético com formato sensível: preservar identidade/faixas/relações originais e provar que o texto sensível não aparece em cache, resposta ou logs. O hash de origem é dos bytes que efetivamente geraram a estrutura.
- [ ] Testar que misturar arrow function e declaração tradicional não desativa extração complementar; impedir duplicação de símbolo entre extratores.
- [ ] Testar callbacks por argumento, propriedades como `onload`, exports e entrypoints: não classificá-los como mortos apenas por grau de entrada zero. Manter função realmente sem referências como candidata, com limite da análise explícito.
- [ ] Revisar heurísticas de declarações tipadas C#/C++ para não emitir tipos como nomes de função; quando não for possível determinar assinatura/intervalo, marcar suporte parcial sem fabricar faixa de linhas.
- [ ] Usar os estados de parser introduzidos na tarefa 2: árvore válida sem símbolos não é falha nem autorização para heurística inventar símbolos; árvore com erro tem cobertura parcial localizada. Validar spans/linhas contra a fonte original e não contra texto redigido.
- [ ] Executar `cargo test -p autodoc-core --test parser_coverage_tests` e `npm test -w @autodoc/mcp -- tests/honesty_callbacks.test.ts`. Atualizar documentação das capacidades ao resultado observado.

**Aceite:** o relatório deixa de equiparar ausência de chamada direta a código morto; documentação extraída preserva origem e não omite silenciosamente construções comuns do suporte declarado.

## Fase 4 — Exportar com segurança e medir precisão

### Tarefa 10 — Tornar a exportação transacional e reconciliável

**Arquivos:** criar `packages/autodoc-mcp/src/diataxis/exporter.ts` e `tests/documentation_export.test.ts`; modificar `src/diataxis/generator.ts`, `src/tools/handlers.ts` e referência de exportação.

**Interface:** manifesto `.autodoc-manifest.json` no diretório de saída com `schemaVersion`, `scanId` e `files: Array<{ path: string; sha256: string }>`. Journal registra `operationId`, fase e, por caminho, hashes anteriores e publicados e backup controlado pela operação. O exporter recebe documentos sintetizados e grava somente caminhos relativos contidos no destino. Manifesto/journal inválido, de versão futura ou com caminho externo gera conflito preservando bytes.

- [ ] Testar arquivo manual no caminho de destino, exportação repetida, módulo removido, arquivo gerado editado pelo usuário, falha no meio da escrita e execução simultânea.
- [ ] Criar teste mínimo para proteção de autoria:

```ts
writeFileSync(join(outputDir, "tutorials/getting-started.md"), "guia manual");
expect(() => generator.exportToDirectory(outputDir)).toThrow(/conflict/i);
expect(readFileSync(join(outputDir, "tutorials/getting-started.md"), "utf8"))
  .toBe("guia manual");
```

- [ ] Rodar `npm test -w @autodoc/mcp -- tests/documentation_export.test.ts` antes da correção.
- [ ] Gerar em staging no mesmo filesystem, validar caminhos e preparar journal/backups de publicação. Usar lock por destino para escritores concorrentes e rollback de falhas; não alegar que múltiplos renames dão atomicidade global para leitores.
- [ ] Simular interrupção depois de substituir parte dos arquivos e antes de publicar o manifesto. Na próxima exportação, recuperar o journal ou retornar conflito recuperável sem limpar arquivos do usuário.
- [ ] A recuperação só modifica arquivo cujo hash atual corresponda a um estado conhecido da operação. Se o usuário o editou após a interrupção, preservar integralmente o conteúdo e retornar conflito; não restaurar backup por apenas existir journal. Cobrir corrupção de manifesto/journal, hash desconhecido e lock remanescente de processo encerrado. Remover lock somente após verificar a identidade e estado da operação, sem roubar lock ativo.
- [ ] Remover arquivo obsoleto somente se estiver no manifesto anterior e seu hash continuar idêntico. Arquivo manual/modificado produz conflito preservando bytes. Atualizar manifesto por último e limpar apenas temporários pertencentes à operação.
- [ ] Tratar saídas legadas sem manifesto como não possuídas: exportar para destino novo ou registrar adoção explicitamente após comparar conteúdo; nunca presumir posse por nome. Cobrir tentativa de path traversal e symlink de saída.

**Aceite:** reexportação não sobrescreve conteúdo manual e não mantém documentos obsoletos não modificados; erro devolve diagnóstico e destino recuperável.

### Tarefa 11 — Eliminar truncamento silencioso e validar a proveniência

**Arquivos:** modificar `packages/autodoc-mcp/src/analyzers/{rest/index.ts,realtime/index.ts,schema/index.ts,llm-candidate-filter.ts}`, `src/tools/handlers.ts`, schemas/anúncios/wrappers em `src/index.ts`, `src/diataxis/generator.ts` e contratos de referência MCP; criar `tests/catalog_completeness.test.ts` e `src/analysis/validate.ts`.

**Interface:** resultados paginados MCP informam `items`, `total`, `nextCursor`, `truncated` e `coverage`, mantendo aliases legados de listas durante a transição documentada. Gerador recebe o catálogo completo; limite visual de diagrama nunca altera o inventário. `validate.ts` rejeita relação sem entidade, origem inexistente e afirmação confirmada sem evidência.

`total` é a quantidade após filtro e antes de paginação; ordenação usa ID semântico com desempate determinístico. `nextCursor` é `null` na última página. `truncated` indica perda por orçamento/limite da análise, não a existência normal de outra página. Cursor se vincula à raiz canônica, `scanId`, coleção, filtro e posição na ordenação; corrupção ou troca desses parâmetros produz erro, nunca reinício silencioso. Aliases legados de listas contêm exatamente os mesmos `items` da página. Todos os catálogos paginados anunciam `cursor` e filtros nos schemas MCP.

- [ ] Gerar fixtures sintéticas de 201 endpoints, 251 eventos e 201 modelos; comparar conjuntos exatos de IDs exportados com os esperados. Testar paginação sem perdas/duplicatas, aceitar cursor de geração anterior ainda disponível e rejeitar cursor de geração indisponível.
- [ ] Acrescentar um modelo com pelo menos 21 campos e comparar nomes/tipos/obrigatoriedade completos; retirar `fields.slice(0, 20)` dos caminhos de schema. Conferir parâmetros e campos internos relevantes dos contratos, não apenas IDs de entidades.
- [ ] Cobrir coleção vazia, página exata, última página, cursor inválido, de outra raiz/coleção/filtro e geração indisponível. Sem perda por orçamento, a primeira página com continuação tem `truncated: false`; o gerador percorre todas as páginas de um único `scanId`.
- [ ] Exigir que falha de análise parcial apareça em cada catálogo e no relatório de exportação; lista vazia não pode declarar ausência comprovada para linguagem não suportada.
- [ ] Testar provider LLM simulado que tenta acrescentar nó/rota ou apagar evidência: a estrutura permanece a do snapshot. LLM pode alterar descrição ligada aos IDs; hipótese adicional fica separada e não entra em fatos confirmados.
- [ ] Exercitar `RestAnalyzer.applyLlmValidation()` pelo caminho real: provider rejeita um endpoint entre dez; repetir abaixo/acima do limiar atual de 30%, resposta inválida e provider indisponível. Identidades, relações e evidências originais não desaparecem nos handlers nem na exportação; verdicts do LLM são observações e não removem candidatos ou fatos do inventário. Validar também entradas heurísticas: uma recomendação do LLM não as promove a chamadas comprovadas.
- [ ] Rodar `npm test -w @autodoc/mcp -- tests/catalog_completeness.test.ts tests/llm_operations.test.ts`.
- [ ] Corrigir documentação e ferramentas para totais reais e limites explícitos; validar a proveniência antes da exportação e devolver falha com diagnóstico se houver inconsistência.

**Aceite:** todos os fatos do catálogo aparecem na referência exportada; uma descrição enriquecida não altera entidades ou relações confirmadas.

### Tarefa 12 — Consolidar avaliação portátil e atualizar a documentação do produto

**Arquivos:** criar `packages/autodoc-mcp/tests/fixtures/{cli,library,api,mixed,unsupported}/` e `tests/{product_accuracy.test.ts,generated_diagrams.test.ts}`; reaproveitar a fixture estática da tarefa 3; atualizar `tests/{tools.test.ts,autodoc_e2e_advanced.test.ts,e2e.test.ts}`, `packages/autodoc-mcp/package.json`, lockfile se precisar de parser Mermaid de desenvolvimento, `README.md`, `docs/reference/{mcp-contracts.md,tools.md,architecture.md}`, `docs/tutorials/getting-started.md` e os relatórios desta revisão.

**Interface:** cada fixture inclui `expected-facts.json` com entidades/relações/capacidades e evidências esperadas, escrito independentemente da saída do AutoDoc. O resultado de avaliação informa precisão, recall, cobertura de proveniência e estabilidade entre scans por capacidade declarada.

- [ ] Criar fixtures mínimas com fatos anotados para os perfis já implementados, incluindo nomes de projetos sintéticos; nenhum caminho absoluto externo. Falha de I/O e interrupção vêm de injeção, não de condição da máquina.
- [ ] Exigir igualdade dos conjuntos de fatos determinísticos nas fixtures suportadas: precisão e recall de 100% nesse conjunto controlado, proveniência válida em 100% das afirmações confirmadas e zero afirmações categóricas sem suporte. Isso não é uma meta prometida para qualquer projeto real.
- [ ] Exigir suporte desconhecido/parcial explicitado nas fixtures unsupported e de falha; repetir scan depois de alteração e comparar com expectativas novas, sem normalizar diferenças semânticas.
- [ ] Remover dos testes antigos as asserções que legitimavam dados fictícios. Manter testes relevantes de sanitização, proteção FFI, i18n e protocolo. Cada teste usa temporários próprios quando escreve cache ou documentação.
- [ ] Criar gate `validate:generated-diagrams` no pacote MCP, executando `vitest run tests/generated_diagrams.test.ts`. Esse teste exporta as fixtures para temporários, exige quantidade positiva/exata de diagramas conforme o perfil e valida sintaxe com parser Mermaid real para cada nível suportado. Uma fixture de sintaxe inválida deve falhar; arquivo esperado ausente ou zero diagramas também falha. Não editar o script gerado em `.agents/`.
- [ ] Cobrir rótulos com aspas, quebras de linha e caracteres especiais no output do renderer. Não interpretar aprovação de sintaxe como prova de contraste, ausência de clipping ou renderização visual; tais requisitos precisam de medições próprias quando forem prometidos.
- [ ] Atualizar capacidades e exemplos no README para o que foi medido. Documentar mudanças de contrato, política de geração, cache legado e migração, estados de análise, exportação em conflito e limites reais do trace.
- [ ] Executar o gate completo abaixo; registrar resultados e revisar diffs de código, documentação e artefatos antes de considerar a implementação concluída.

## Gate final e entrega

Executar na raiz do AutoDoc, após concluir as correções:

```bash
cargo test -p autodoc-core
npm run build -w @autodoc/core
npm run build -w @autodoc/mcp
npm test -w @autodoc/mcp
npm run validate:generated-diagrams -w @autodoc/mcp
npm run validate:diagrams
git diff --check
git status --short
```

Os builds são dependências dos testes MCP que carregam código nativo ou `dist/`; não usar artefatos antigos. Fixtures de capacidade declarada são obrigatórias: um skip por dependência externa não satisfaz o gate. `validate:generated-diagrams` é obrigatório para os novos outputs; o `validate:diagrams` existente inspeciona apenas documentos fixos e não o substitui. Aprovação deste último não comprova sintaxe dos artefatos exportados nem qualidade visual.

Entregar: resultados dos comandos, matriz de cobertura atualizada, exemplos estático/CLI/API/misto com evidência navegável, notas de migração e lista de limitações ainda declaradas. A avaliação estática anterior permanece como registro histórico; anexar os resultados dinâmicos sem reescrever o que foi efetivamente verificado naquela data.

## Matriz de regressões obrigatórias

| Critério | Caso e asserção | Teste/comando focal |
| --- | --- | --- |
| Estados sem fallback | Sem scan, símbolo ausente e homônimo têm estados diferentes e candidatos exatos | `npm test -w @autodoc/mcp -- tests/trace_evidence.test.ts tests/symbol_evidence.test.ts` |
| MCP completo | Tool/resource sem banco fictício; `max_depth: 2` atravessa schema/dispatcher sem virar 5 | `npm test -w @autodoc/mcp -- tests/resource_evidence.test.ts tests/protocol.test.ts` |
| Erro e parser parcial | Binding/IO/sintaxe falham com diagnóstico; projeto vazio válido é distinguido | `npm test -w @autodoc/mcp -- tests/scan_status.test.ts` e `cargo test -p autodoc-core --test parser_coverage_tests` |
| Migração e identidade | ID correto no upsert, FK válida, schema futuro recusado sem escrita | `cargo test -p autodoc-core --test cache_identity_tests` |
| Geração única | Publicação entre SELECTs não mistura dados; limites/interrupção preservam G1 | `cargo test -p autodoc-core --test scan_snapshot_tests` |
| Aresta comprovada | Homônimos não recebem destino arbitrário; comentário/declaracão não vira chamada | `cargo test -p autodoc-core --test symbol_resolution_tests` |
| Bytes da geração | Alteração entre passagens REST gera `STALE`, sem fatos de conteúdo novo no scan antigo | `npm test -w @autodoc/mcp -- tests/inventory_scope.test.ts` |
| Cobertura e sanitização | `return +1` preserva estrutura; cache/logs não contêm texto sensível sintético | `cargo test -p autodoc-core --test parser_coverage_tests` |
| Autoria preservada | Editar após crash impede restauração cega; journal inválido não autoriza escrita | `npm test -w @autodoc/mcp -- tests/documentation_export.test.ts` |
| Completude | Mais de 20 campos e catálogos acima dos limites exportam conjuntos integrais | `npm test -w @autodoc/mcp -- tests/catalog_completeness.test.ts` |
| LLM consultivo | Rejeitar 1/10 não remove endpoint ou evidência pelo caminho real | `npm test -w @autodoc/mcp -- tests/catalog_completeness.test.ts tests/llm_operations.test.ts` |
| Diagrama exportado | Parser real recusa sintaxe inválida; ausência de arquivo/zero diagramas não passa | `npm run validate:generated-diagrams -w @autodoc/mcp` |

## Auto-revisão do plano

- Os nove grupos de achados da revisão têm tarefas correspondentes: trace (1), templates (3/8), estados de scan (2/7), cache (4/5), resolução (6), cobertura/mapas (7/8/9), honesty (9), exportação/limites (10/11), avaliação (12).
- As correções de baixo risco para resultados inventados antecedem a expansão do modelo compartilhado; o modelo comum substitui a solução transitória das tarefas iniciais, sem duplicar fontes de verdade.
- As alterações no binding e no schema exigem migração/rebuild, definidos nas próprias tarefas. Não há plano de alterar o jogo nem de reintroduzir o benchmark removido.
- Este checkout não contém `scripts/coacus_route.py` nem o catálogo de roteamento Coacus; a seleção automatizada de agentes daquele workflow não se aplica à execução local descrita aqui.
- Revisado por agentes de arquitetura, núcleo e QA a pedido do usuário. As emendas e limites da revisão estão em [registro de revisão do plano](../reviews/2026-10-22-autodoc-plan-review.md). Revisão documental não comprova os critérios dinâmicos: os testes listados ainda precisam ser implementados/executados nas tarefas correspondentes.

# Verificação das pendências AutoDoc

Data: 22/10/2026. Worktree: `autodoc-corrections`.

## Correções concluídas nesta rodada

- Rotas API descobertas por regex são sinalizadas como `coverage.state: partial` com `API_ROUTE_HEURISTIC_NO_EVIDENCE`. A regressão chama o handler real para as fixtures `api` e `mixed` e verifica rotas, estado e diagnóstico.
- O oráculo `expected-facts.json` não é copiado para o repositório avaliado. As fixtures comparam símbolos, inventário, facts, evidências, relações e diagnósticos; a biblioteca mede uma relação resolvida e sua evidência/hash.
- G1/G2 verifica imutabilidade da geração anterior, inclusão de `new.ts`, remoção de `removed.ts` do inventário e estabilidade das projeções/evidência preservadas.
- O banco SQLite do lock de exportação passa por `PRAGMA quick_check(1)` antes do acquire. Em corrupção, a aquisição falha fechada e o teste prova que os bytes existentes são preservados. Regressões também cobrem token desconhecido, MAC de owner inválida e edição manual após interrupção.
- Documentação foi alinhada aos contratos paginados API/socket, aos estados e limites do trace, ao LLM consultivo, à resposta snapshot-backed da exportação, aos arquivos que o gerador realmente produz, à cobertura medida do parser e ao orçamento máximo de ~5,5 GB. README, ADRs e referências de arquitetura/funções/internals também não prometem taint, pruning de rotas ou How-To gerado.

## Gates executados

- `cargo test -p autodoc-core --quiet`: passou; 78 testes executados em grupos unitários/de integração. O log contém diagnósticos Node-API ausentes nos binários Rust isolados, sem falha de teste.
- `npm run build -w @autodoc/core`: passou. O build emite avisos de configuração deprecated (`napi.name` e `napi.triples`).
- `npm run build -w @autodoc/mcp`: passou.
- `npm test -w @autodoc/mcp`: passou, 23 arquivos e 171 testes.
- `npm run validate:generated-diagrams -w @autodoc/mcp`: passou, 9 testes com parser Mermaid.
- `npm run validate:diagrams`: passou; 6 diagramas da documentação examinados.
- `git diff --check`: passou.
- `rg -n -i butecogames packages/autodoc-mcp/tests`: nenhuma ocorrência.
- Testes focados após as últimas alterações de produto: `product_accuracy`, `documentation_export` e `catalog_completeness`, 48 testes aprovados.

A última revisão documental também removeu as promessas de cobertura Top 20/C++ AST e atualizou as assinaturas documentadas de `parse_file`/`parse_ast` para corresponder ao código. README e OpenAPI não descrevem a busca no call graph como prova de taint ou fluxo de dados.

`docs/reference/api/openapi.yaml` foi carregado com PyYAML (`safe_load`) após a atualização do schema do trace: sintaxe YAML válida.

## Revisão por agentes

QA confirmou a avaliação de cobertura no handler real, exclusão do oráculo, comparação das projeções e regressão G1/G2; o achado de inventário (arquivo novo/removido) foi corrigido. A revisão documental confirmou os contratos e exemplos atualizados; o último ajuste removeu a promessa de How-To gerado.

## Limite documental ainda não reconciliado

`.agents/skills/autodoc-mcp-operations/SKILL.md` ainda contém descrições antigas de taint tracing e limite de 5 GB. O arquivo está sob `.agents/`, é artefato gerado/rastreado e não há fonte canônica correspondente no catálogo Coacus encontrada pela busca. Ele foi preservado, sem edição manual; atualizar esse conteúdo exige localizar ou reconciliar a fonte de geração. Os documentos canônicos do projeto foram corrigidos.

Não foram criados commits. Alterações preexistentes em `.agents/`, `src/llm/factory.ts` e a remoção de `agnostic_analyzers.test.ts` foram preservadas.

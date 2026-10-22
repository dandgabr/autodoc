# Execução de testes do AutoDoc

Data: 22/10/2026. Checkout `54a8fc927277ef7c1d50bfe3f11ed38fc09e6caa` com as alterações locais preexistentes. Não foram aplicadas correções de implementação durante esta execução.

| Comando | Resultado | Evidência |
| --- | --- | --- |
| `cargo test -p autodoc-core` | Exit 0; 20 testes passaram, nenhum falhou | `/tmp/autodoc-core-tests-20261022.log` |
| `npm run build -w @autodoc/core` | Exit 0; módulo nativo recompilado antes dos testes MCP | `/tmp/autodoc-native-build-20261022.log` |
| `npm run build -w @autodoc/mcp` | Exit 0; TypeScript compilado | `/tmp/autodoc-mcp-build-20261022.log` |
| `npm test -w @autodoc/mcp` | Exit 0; 61 testes passaram, 8 pulados, nenhum falhou | `/tmp/autodoc-mcp-tests-20261022.log` |

Os oito testes pulados são de `packages/autodoc-mcp/tests/agnostic_analyzers.test.ts`. Esse arquivo condiciona a execução à presença de `AUTODOC_BENCHMARK_REPO` ou `/home/daniel/Code/butecogames`. Nesta execução, o caminho efetivo foi `/home/daniel/Code/butecogames`; a checagem confirmou que ele não existe.

O Cargo emitiu mensagens de símbolos Node-API indisponíveis no executável de testes, mas terminou com exit 0. O build nativo emitiu avisos de configuração NAPI obsoleta; o Node emitiu aviso experimental de SQLite. A mensagem de panic no teste de bridge é o panic controlado usado pelo teste de proteção da fronteira FFI; o teste passou.

Esses resultados validam as asserções existentes. Eles não resolvem os achados de precisão, cache e geração documentados na revisão, nem demonstram cobertura dos cenários de regressão propostos. Os logs em `/tmp` são temporários. O estado dos arquivos rastreados permaneceu igual ao registrado antes da execução.

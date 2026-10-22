# Revisão do plano de correções por agentes

Data: 22/10/2026. Objeto: `docs/temp/plans/2026-10-22-autodoc-corrections.md`. Revisão documental e estática; nenhuma correção de implementação, execução de testes, exportação ou mutação ocorreu nesta etapa.

## Participantes e cobertura

- `plan_architecture`, papel `software-architect`: contratos MCP/binding/resources, inventário, leitura de conteúdo e dependências. Leu plano e revisão do produto, scanner/schema, trechos de storage/bridge/REST e dispatcher. Não inspecionou integralmente parser, renderer, gerador e todos os analisadores.
- `plan_core`, papel `cpp-systems-engineer`: scanner, armazenamento/schema, parser, sanitização e consumidor honesty. Não fez auditoria completa dos extratores TypeScript nem benchmark.
- `plan_qa`, papel `qa-testing-specialist`: asserções, critérios de aceite, exportação/journal, paginação, LLM e gate de diagramas. Comparou trechos de código e testes; não executou os cenários.
- O agente principal consolidou os relatórios e verificou também os fallbacks de contrato de símbolos, resources e escopo do validador existente.

Os três pareceres iniciais recomendaram ajustes antes de executar. A direção geral foi considerada adequada: corrigir resultados fictícios antes de ampliar a arquitetura, estabilizar snapshot/cache e avaliar com fixtures próprias. Os pareceres não constituem prova de implementação.

## Decisões incorporadas

| Problema apontado | Decisão no plano revisado | Tarefas |
| --- | --- | --- |
| Mesmo inventário com bytes diferentes produz mapa híbrido | Buffer capturado/verificado por SHA-256, reutilizado pelo extrator; divergência é `STALE` | 7 |
| Publicação atômica não basta para leitura composta | Gerações imutáveis, transação de leitura e teste de barreira entre SELECTs; páginas fixadas ao scan | 5/7 |
| Resources MCP ainda inventam banco/grafo | Remover fallback imediatamente e integrar tools/resources ao mesmo mapa | 1/8 |
| Contratos novos não percorrem toda a superfície pública | Envelope definido antes das migrações; atualizar NAPI, binding, Zod, anúncio, wrappers e docs no incremento | 2/5/7/11 |
| Defaults de aliases podem ignorar `max_depth` | Normalizar antes de default; conflito é erro; testar dispatcher real | 1 |
| Resolver nome não comprova existência da chamada | Distinguir declaração, referência, callback e chamada; heurística incerta permanece candidata | 6/9 |
| Sanitização altera a sintaxe antes da extração | Estrutura dos bytes originais em memória; sanitizar textos antes de saída/persistência; testar `return +1` | 9 |
| Parser sem diagnóstico aceita cobertura incompleta | `ParseOutput` com estados e erro localizado; testar AST vazio, malformado e falha injetada | 2/9 |
| Staging/JSON sem orçamento aumenta risco de memória | Lotes, fila/workers limitados, limite por fonte, metadados e coleções paginadas | 5/7 |
| Schema futuro ou legado inválido pode parecer utilizável | Recusar versão futura sem escrita e invalidar publicação legado não recuperável | 4 |
| Journal pode apagar edição feita após crash | Hashes dos estados conhecidos; desconhecido é conflito e preserva conteúdo | 10 |
| Validador só examina documentos fixos | Novo gate sobre exportações das fixtures, parser real e quantidade esperada; não editar `.agents/` | 12 |
| Truncamento interno de campos não é coberto por total de modelos | Modelo com 21+ campos e comparação exata de nomes/tipos/obrigatoriedade | 11 |
| Cursor sem escopo permite páginas incoerentes | Vincular raiz/geração/coleção/filtro/ordenação; definir totais e truncamento | 11 |
| Regressão LLM não exercita exclusão atual de endpoints | Rejeição 1/10 pelo caminho real, limiares e falhas; verdict consultivo não remove fatos/candidatos | 11 |
| Teste de trace aceita estados que deveriam ser distintos | Fixtures separadas com estado exato e candidatos exatos | 1 |
| Testes de IO/links dependem do host | Adapter injetável para cenários obrigatórios e testes reais apenas complementares | 7 |

Além dos achados dos revisores, a consolidação incluiu o fallback de assinatura Rust em `handleGetSymbolContract`, confirmado pela leitura do handler: ele passa a fazer parte da contenção da tarefa 1. A matriz de regressões ao final do plano liga cada critério a casos, asserções e comandos.

## Limites e pendências

Os números de baseline continuam sendo os medidos na execução anterior, não repetidos nesta revisão. O parser Mermaid de desenvolvimento, se necessário, deve ser resolvido e fixado na implementação; nenhum pacote foi instalado para revisar o plano. Sintaxe de diagrama não será apresentada como validação de contraste ou de renderização visual.

Os testes e contratos propostos são entregáveis futuros. Aprovação do plano não implica migração aplicada, integridade do cache demonstrada ou exportação recuperável já disponível.

## Confirmação após as emendas

Os três revisores releram as emendas de seus respectivos escopos e confirmaram que seus achados foram endereçados, sem bloqueios residuais concretos nessa confirmação focal. QA recomendou ajustar a redação de cursor antigo para cursor de geração indisponível; o plano foi corrigido para aceitar uma geração anterior ainda retida. A consolidação também distinguiu evidência de conteúdo de observação de metadados de assets, sem exigir leitura de binários.

Essas confirmações se limitam ao plano e às decisões propostas. Não houve execução de testes ou validação dinâmica adicional nesta revisão.

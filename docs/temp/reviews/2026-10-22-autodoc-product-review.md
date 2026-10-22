# Revisão do AutoDoc como documentador e mapeador de projetos

Data: 22/10/2026. Revisão estática do checkout em `54a8fc927277ef7c1d50bfe3f11ed38fc09e6caa`, incluindo os arquivos presentes no working tree. Nenhuma implementação ou suíte de testes foi executada nesta revisão. As mudanças locais preexistentes foram preservadas.

## Objetivo e correção de escopo

O produto é o AutoDoc: analisar repositórios variados, mapear sua estrutura e produzir documentação sustentada por evidências. `jeito-dasa-de-brincar` é um caso de avaliação. Corrigir acessibilidade, interação ou regras desse jogo está fora deste plano.

Este documento substitui o plano anterior `../plans/2026-10-22-autodoc-review-jeito-dasa-de-brincar.md`. As tarefas de alteração do jogo daquele plano deixam de se aplicar.

## Avaliação

Existe uma base aproveitável: separação entre scanner nativo, persistência, analisadores especializados, renderização, MCP e enriquecimento opcional. Os tipos de contratos e os analisadores de workspace/infraestrutura oferecem pontos de extensão. Entretanto, o produto ainda não fornece um mapa geral confiável: mistura evidências com pressupostos de uma aplicação específica e não comunica adequadamente erros, ambiguidade ou cobertura incompleta.

O problema central é a confiabilidade do modelo intermediário. Aprimorar o texto ou adicionar LLM antes de resolver esse problema pode apenas tornar mais convincente uma informação incorreta.

## Achados prioritários

### P1 — Fluxos inventados apresentados como análise de dados

`packages/autodoc-mcp/src/tools/handlers.ts:405` inicia a resposta de trace com um caminho fixo contendo o sanitizador do próprio AutoDoc e SQLite. Quando encontra nomes semelhantes a rotas, pode produzir Express, transação e Mongoose sem evidência. Mesmo uma árvore de chamadas encontrada recebe um sink inventado quando nenhum foi detectado. O retorno em `:535` declara `taintStatus: "SANITIZED"` incondicionalmente.

Entrada reveladora: consultar um símbolo inexistente ou um projeto sem persistência. A resposta deve ser `not_found`, `unsupported` ou uma travessia parcial identificada como grafo de chamadas; não pode certificar sanitização. Uma lista de funções alcançáveis também não constitui um caminho único de fluxo de dados.

### P1 — Templates e arquitetura impõem um backend de jogos

`packages/autodoc-mcp/src/diataxis/generator.ts:306` gera requisitos de Node, `.env`, banco/cache e comandos sem comprovar sua existência; `:369` sempre gera um guia com módulos, sockets e carteira. `packages/autodoc-mcp/src/analyzers/workspace.ts:329` escolhe comandos por gerenciador, com fallback npm mesmo quando o gerenciador é desconhecido. Detectar Maven também não comprova Spring Boot, por exemplo.

`packages/autodoc-mcp/src/analyzers/architecture.ts:136` usa descrição de plataforma realtime como padrão; `:295` cria servidor na ausência de pacote cliente. A saída observada no jogo estático demonstra o problema. O perfil precisa ser inferido por evidências positivas, preservando o estado desconhecido.

### P1 — Scan pode reportar sucesso sem análise válida

`packages/autodoc-mcp/src/tools/handlers.ts:171` captura falha nativa e retorna `SUCCESS` com valores zerados. O comentário menciona fallback, mas não há descoberta alternativa executada nesse ramo. `crates/autodoc-core/src/scanner.rs:94` descarta o resultado da persistência e a resolução de arestas pode virar zero via `unwrap_or(0)`.

Entrada reveladora: binding que lança erro ou armazenamento que falha. Diferenciar `failed`, `partial` e `complete`, com diagnósticos por etapa, evita interpretar uma falha como projeto vazio.

### P1 — Cache pode representar um estado antigo ou associar símbolos ao arquivo errado

`crates/autodoc-core/src/cache/mod.rs:316` usa `last_insert_rowid()` após um upsert de arquivo. No ramo de atualização, esse valor não identifica necessariamente o arquivo atualizado; depois é usado nos símbolos. Os caminhos de scan/upsert não reconciliam arquivos removidos, símbolos removidos e arestas removidas; a FTS recebe novas inserções a cada passagem.

Cenários a reproduzir na implementação: escanear o mesmo projeto duas vezes, remover uma função, renomear um arquivo e alterar uma chamada. O snapshot publicado deve refletir apenas a geração atual. Usar identidade retornada pela operação ou consulta por chave, reconciliar exclusões e publicar a geração de forma transacional.

### P1 — Resolução de chamadas escolhe homônimos arbitrariamente

`crates/autodoc-core/src/cache/mod.rs:360` resolve o destino com `WHERE name = ? LIMIT 1`, sem escopo ou imports. Duas funções `save` em módulos diferentes podem produzir uma relação incorreta. Resolver primeiro escopo/import/receiver; preservar candidatos ambíguos quando não houver prova suficiente. Não transformar ambiguidade em aresta confirmada.

A revisão independente também identificou colisões na identidade extraída em `parser/ast.rs:40`: métodos `new` de dois blocos `impl` Rust no mesmo arquivo podem receber a mesma FQSN, pois o tipo do `impl` não integra o contexto reconhecido. A correção deve incluir identidade de tipo/receiver e assinatura quando houver sobrecarga, além da resolução das relações.

### P2 — Cobertura fragmentada e mapas dependentes de nomes de pastas

`crates/autodoc-core/src/scanner.rs:48` usa uma lista de extensões de código que não inclui HTML/CSS. Isso explica o cache do caso estático; não demonstra por si só falha do scanner. O produto precisa de um inventário de arquivos independente da capacidade de extrair AST.

`packages/autodoc-mcp/src/analyzers/architecture.ts:421` limita componentes a caminhos como `src/`, `lib/` e `packages/`, excluindo `js/game.js` e entradas na raiz. `:55` encaminha tanto nível 3 quanto 4 para o construtor de componentes. Os analisadores TypeScript ainda percorrem o disco com regras próprias; no REST (`:562`) há limite de profundidade, `statSync` e erros silenciados. O conjunto de arquivos analisados pode divergir entre ferramentas.

### P2 — Diagnóstico de código morto excede a evidência

`packages/autodoc-mcp/src/analyzers/honesty/index.ts:93` trata ausência de aresta de entrada como órfão e a soma como código morto. `onDocMove` e `onDocEnd` do caso estático são registrados em `addEventListener`, embora apareçam no relatório. Entrypoints, exports e callbacks exigem tratamento próprio; sem cobertura suficiente, reportar candidato com limitações.

### P2 — Exportação omite resultados e pode deixar documentos antigos

`packages/autodoc-mcp/src/diataxis/generator.ts:138` limita endpoints a 200, sockets a 250 e modelos a 150/200 sem indicar truncamento nas referências. `:423` escreve diretamente os documentos, sem manifesto de propriedade ou reconciliação dos arquivos que deixaram de ser gerados. Um módulo removido pode continuar documentado numa exportação posterior; um caminho coincidente pode sobrescrever conteúdo manual.

### P2 — Avaliação privilegia presença de conteúdo, não precisão

`packages/autodoc-mcp/tests/agnostic_analyzers.test.ts` usa um benchmark externo opcional, com expectativas ligadas a um monorepo específico. `autodoc_e2e_advanced.test.ts` verifica principalmente contagens e existência de arquivos. Isso não prova que as afirmações geradas são verdadeiras nem que projetos fora desse perfil funcionam. Não executei essas suítes; esta conclusão descreve as asserções lidas.

## Arquitetura proposta

Fluxo: **inventário → perfil e cobertura → extração → modelo de evidências → mapas e documentação → validação de saída**.

- **Inventário:** arquivos e categorias, exclusões, erros de leitura, symlinks e limites. HTML, CSS, manifests, infraestrutura e assets entram no inventário mesmo sem AST.
- **Perfil:** combinação de capacidades observadas, como site estático, CLI, biblioteca, serviço e workspace misto. Não usar uma classificação exclusiva que apague partes do repositório.
- **Extração:** adaptadores por linguagem/framework consomem o mesmo inventário e retornam fatos com origem e capacidade suportada.
- **Modelo comum:** cada fato contém identificador, tipo, origem com arquivo/faixa de linhas, extrator, método (`ast`, configuração, heurística ou LLM), estado de resolução e geração do scan. Relações apontam para identificadores existentes; ambiguidades conservam seus candidatos.
- **Cobertura:** distinguir comprovado, inferido, desconhecido, não suportado e análise com falha. Lista vazia deve vir acompanhada do que foi efetivamente examinado.
- **Mapas:** estrutura de arquivos, dependências entre módulos, entrypoints, contratos e infraestrutura antes de abstrações C4. Componentes C4 agrupam responsabilidades; funções individuais pertencem ao mapa de código.
- **Documentação:** referências derivadas dos fatos; guias somente para workflows demonstrados. Uma proposta de comando deve ser marcada como proposta, sem ser confundida com configuração existente.
- **LLM:** explicar e resumir fatos rastreáveis; sugestões novas ficam identificadas como hipóteses. Não criar topologia, confirmar segurança ou resolver ambiguidade sem evidência verificável.

## Plano revisado

A execução deve seguir o [plano detalhado de correções](../plans/2026-10-22-autodoc-corrections.md), escrito após a execução dos testes existentes e a remoção da dependência externa. As fases abaixo registram a direção da revisão original; o plano detalhado define ordem, contratos, arquivos e aceite atuais.

### Fase 1 — Remover afirmações sem fundamento

- [ ] Em `handlers.ts`, retirar caminhos e sinks fictícios, retornar diagnósticos de scan e eliminar `SANITIZED` incondicional. Critério: erro de binding e símbolo ausente nunca retornam análise confirmada.
- [ ] Em `architecture.ts`, `workspace.ts` e `generator.ts`, eliminar os defaults de domínio e condicionar instruções à evidência. Critério: fixture estática não contém backend, npm, env ou infraestrutura inventados; fixture sem script de build não recebe esse comando como existente.
- [ ] Em `honesty/index.ts`, apresentar candidatos e cobertura, reconhecendo usos por callbacks/exports. Critério: os handlers de evento do caso de avaliação não são classificados como código morto confirmado.

### Fase 2 — Tornar o snapshot e o grafo confiáveis

- [ ] Em `cache/mod.rs` e `scanner.rs`, corrigir identidade, reconciliação de exclusões, FTS e publicação transacional. Critério: scans repetidos são estáveis; renomear/remover não deixa entidades ou relações antigas; scan parcial não apaga silenciosamente fatos de áreas ilegíveis.
- [ ] Em `parser/` e `cache/mod.rs`, resolver chamadas por contexto e preservar ambiguidades. Critério: funções homônimas e chamadas externas não recebem destino arbitrário.
- [ ] Em `parser/ast.rs`, preservar identidade de métodos por tipo/receiver e sobrecarga. Critério: dois métodos com o mesmo nome em tipos distintos coexistem no índice sem sobrescrita.
- [ ] Introduzir inventário compartilhado e relatório de cobertura consumidos pelo MCP/analisadores. Critério: arquivos excluídos e linguagens não suportadas aparecem com motivo; todas as ferramentas usam o mesmo escopo de scan.

### Fase 3 — Mapear projetos variados com evidência

- [ ] Criar perfis composicionais para site estático, biblioteca, CLI, serviço e monorepo misto. Critério: manifestos, HTML e configurações fundamentam as capacidades; falta de manifesto não implica servidor.
- [ ] Produzir mapas de estrutura, imports, entrypoints e infraestrutura com referências navegáveis. Critério: caminhos na raiz e `js/` são representados sem filtros arbitrários; relações ambíguas são visíveis.
- [ ] Derivar C4 e documentação do modelo compartilhado, com contratos distintos para componentes e código. Critério: cada nó e relação tem origem; nível não suportado é explicitamente informado.

### Fase 4 — Exportar e avaliar a qualidade

- [ ] Em `generator.ts`, implementar exportação em staging, manifesto de arquivos gerados e reconciliação limitada a esses arquivos. Critério: conteúdo manual é preservado e documentos de entidades removidas deixam de aparecer.
- [ ] Eliminar cortes silenciosos usando paginação ou exportação completa, mantendo limites explícitos na visualização. Critério: repositório acima dos limites atuais tem totais e cobertura corretos.
- [ ] Criar fixtures autocontidas de site estático, CLI, biblioteca, API, monorepo, linguagem não suportada e análise parcial. Medir precisão/recall contra fatos anotados, cobertura de proveniência, estabilidade entre scans e afirmações sem suporte. Critério inicial: nenhuma afirmação categórica sem evidência nas fixtures; metas de recall definidas por capacidade declarada.

Prioridade recomendada: completar a fase 1 antes de ampliar modelos LLM ou linguagens, depois estabilizar cache/grafo antes de expandir mapas. O caso `jeito-dasa-de-brincar` deve permanecer como regressão do AutoDoc, sem exigir alterações na aplicação avaliada.

## Limites desta revisão

Foram inspecionados scanner, persistência, contratos de parser, handlers MCP, arquitetura, workspace, REST, geração Diátaxis, diagnóstico de órfãos, fachada de enriquecimento e parte dos testes. A revisão independente cobriu o núcleo Rust. Não houve benchmark, teste dinâmico, mutação, browser nem auditoria completa de segurança. Os cenários de cache e resolução são conclusões da leitura do código e devem receber reproduções automatizadas durante a correção.

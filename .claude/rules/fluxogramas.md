# Regra de fluxogramas — Mermaid no CLI

Aplicada somente quando .claude/skills/documentar-entrega é usado.

## Quando gerar

Gere um fluxograma Mermaid quando a explicação depender de sequência, ramificação ou interação entre partes, por exemplo:

- fluxo de tela, login, onboarding ou verificação (CNPJ, CPF, identidade);
- chamada entre camadas (Flutter → Functions → .NET → Firestore/Postgres);
- ciclo de entrega (fases A a F, gates, `mark done`);
- decisão com mais de duas saídas, ou plano e arquitetura com 3+ componentes.

Não gere para explicações lineares ou respostas curtas.

## Como mostrar

- **Sempre inclua o bloco ```` ```mermaid ```` no texto da resposta**, visível no CLI do Claude Code. Não basta salvar em arquivo nem publicar como artefato.
- Se o diagrama também for documentação (`docs/`, `entrega.md`, `plano.md`), grave o mesmo bloco lá e mostre-o na resposta.
- Use `flowchart TD` para fluxos, `sequenceDiagram` para chamadas entre camadas e `stateDiagram-v2` para estados. Rótulos em pt-BR, curtos, e sem dado sensível (CPF/CNPJ real, tokens).
- Ao lado do bloco, escreva 1 a 2 linhas dizendo o que ele mostra. O terminal exibe o código, não a imagem.

## Imagem PNG (preferida pelo usuário)

Além do bloco no texto, **gere um PNG** e entregue o caminho como link clicável, porque o CLI não exibe imagem e o PNG abre na IDE:

```bash
echo '{"executablePath":"/usr/bin/google-chrome","args":["--no-sandbox"]}' > "$SCRATCH/pptr.json"
npx -y @mermaid-js/mermaid-cli -p "$SCRATCH/pptr.json" -i <fonte>.mmd -o <saida>.png -b white -s 2
```

- Com entrega em `docs/entregas/<slug>/`, grave em `docs/entregas/<slug>/diagramas/<nome>.png` (e o `.mmd` ao lado). Sem entrega, use o scratchpad da sessão e avise que o arquivo é temporário.
- Confira a imagem (Read) antes de entregar: nós, setas e rótulos legíveis.
- Se o Chrome ou o `npx` não estiverem disponíveis, diga isso e entregue só o bloco Mermaid. Não invente a imagem.

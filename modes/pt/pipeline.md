# Modo: pipeline -- Inbox de URLs (Second Brain)

Processa URLs de vagas acumuladas em `data/pipeline.md`. O candidato adiciona URLs quando quiser e depois executa `/career-ops pipeline` para processar todas de uma vez.

## Varredura de liveness

**Execute antes de processar qualquer URL.** As entradas que o scanner gravou em modo headless/batch carregam `**Verification:** unconfirmed (batch mode)` porque o Playwright não estava disponível no momento da varredura — a liveness delas nunca foi verificada. Sem a varredura, vagas mortas chegam à avaliação uma a uma e queimam tempo e tokens em papéis fantasma.

1. Execute `node check-liveness.mjs --file data/pipeline.md` (adicione `--throttle` em lotes grandes para ficar abaixo dos limites de taxa do WAF; é Playwright puro, zero tokens do Claude). O checker lê o inbox diretamente — pega as linhas `- [ ]`, ignora as linhas `- [x]`/`- [!]` e as entradas `local:`, e informa quantas linhas pulou. **Não** copie os URLs à mão para um arquivo temporário antes; esse passo custa tokens e é justamente o que acaba sendo pulado.
2. O checker imprime um veredicto por URL e sai com código diferente de zero assim que algum URL estiver expired/uncertain.
3. Todo URL reportado como **expired/closed** é resolvido em vez de processado: mova-o para a seção de processados como `- [x] ~~URL | Empresa | Cargo~~ — vaga expirada (varredura de liveness)` e, se já existir linha no tracker, defina-a como `Discarded`. **Nenhuma** extração, avaliação ou geração de report/PDF para ele.
4. Resultados `uncertain` permanecem no lugar e são confirmados durante a extração normal (um timeout passageiro não deve descartar uma vaga possivelmente viva).
5. Apenas os URLs vivos sobreviventes seguem para o laço de processamento abaixo.

## Workflow

1. **Ler** `data/pipeline.md` → buscar itens `- [ ]` na seção "Pendentes"
2. **Para cada URL pendente**:
   a. Reservar o próximo `REPORT_NUM` sequencial de forma atômica executando `node reserve-report-num.mjs` (e liberar o sentinel executando `node reserve-report-num.mjs --release <num>` após a gravação do relatório)
   b. **Extrair JD** usando Playwright (browser_navigate + browser_snapshot) → WebFetch → WebSearch
   c. Se a URL não for acessível → marcar como `- [!]` com nota e continuar
   d. **Executar auto-pipeline completa**: Avaliação A-F → Report .md → PDF (se score >= 3.0) → Tracker
   e. **Mover de "Pendentes" para "Processadas"**: `- [x] #NNN | URL | Empresa | Vaga | Score/5 | PDF ✅/❌`
3. **Se houver 3+ URLs pendentes**, lançar agentes em paralelo apenas para etapas sem Playwright (ex.: organização, WebSearch/WebFetch).
   Se a extração exigir Playwright, processar serialmente (1 vaga por vez) para evitar conflito de sessão.
4. **Ao terminar**, mostrar tabela resumo:

```
| # | Empresa | Vaga | Score | PDF | Ação recomendada |
```

## Formato de pipeline.md

```markdown
## Pendentes
- [ ] https://jobs.example.com/posting/123
- [ ] https://boards.greenhouse.io/company/jobs/456 | Company Inc | Senior PM
- [!] https://private.url/job — Erro: login necessário

## Processadas
- [x] #143 | https://jobs.example.com/posting/789 | Acme Corp | AI PM | 4.2/5 | PDF ✅
- [x] #144 | https://boards.greenhouse.io/xyz/jobs/012 | BigCo | SA | 2.1/5 | PDF ❌
```

> Nota: Os títulos das seções podem estar em EN ("Pending"/"Processed"), ES ("Pendientes"/"Procesadas"), DE ("Offen"/"Verarbeitet") ou PT-BR ("Pendentes"/"Processadas"). Ao ler, ser flexível; ao escrever, manter o estilo do arquivo existente.

## Detecção inteligente de JD a partir da URL

1. **Playwright (preferido):** `browser_navigate` + `browser_snapshot`. Funciona com todas as SPAs.
   - **Opcional — extrator CLI (`scan.extractor: cli` em `config/profile.yml`):** execute `node browser-extract.mjs <url>` (`--mode jd`) em vez disso — `{ "url", "title", "text" }` compacto, menos tokens (depende do portal). **Recorre em silêncio** a `browser_navigate` + `browser_snapshot` em caso de erro ou ausência.
2. **WebFetch (fallback):** Para páginas estáticas ou quando Playwright não está disponível.
3. **WebSearch (último recurso):** Buscar em portais secundários que indexam o JD.

**Casos especiais:**
- **LinkedIn**: Pode exigir login → marcar com `[!]` e pedir ao candidato para colar o texto
- **PDF**: Se a URL aponta para um PDF, ler diretamente com o Read tool
- **`local:` prefix**: Ler arquivo local. Exemplo: `local:jds/linkedin-pm-ai.md` → ler `jds/linkedin-pm-ai.md`
- **Gupy / Greenhouse / Lever**: Plataformas comuns no Brasil. Playwright funciona bem com todas
- **Vagas.com.br / InfoJobs / Catho**: Portais brasileiros, geralmente acessíveis via WebFetch
- **LinkedIn BR**: Mesmas restrições do LinkedIn global — pode exigir login

## Numeração automática

1. Executar `node reserve-report-num.mjs` para reservar o próximo número sequencial de forma atômica (a saída retornará `{###}`).
2. Gravar o arquivo de relatório usando esse número.
3. Liberar o sentinel executando `node reserve-report-num.mjs --release {###}` após a gravação do relatório.

## Sincronização de fontes

Antes de processar qualquer URL, verificar sincronização:

```bash
node cv-sync-check.mjs
```

Se houver dessincronização, avisar o candidato antes de continuar.

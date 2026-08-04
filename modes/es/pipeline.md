# Modo: pipeline -- Bandeja de URLs (Second Brain)

Procesa las URLs de ofertas acumuladas en `data/pipeline.md`. El candidato añade URLs cuando quiere y luego lanza `/career-ops pipeline` para procesarlas todas de una vez.

## Barrido de liveness

**Ejecutarlo antes de procesar cualquier URL.** Las entradas que el escáner escribió en modo headless/batch llevan `**Verification:** unconfirmed (batch mode)` porque Playwright no estaba disponible al escanear — nunca se comprobó su liveness. Sin barrido, las ofertas muertas llegan a la evaluación de una en una y queman tiempo y tokens en roles fantasma.

1. Ejecutar `node check-liveness.mjs --file data/pipeline.md` (añadir `--throttle` en lotes grandes para no superar los límites de tasa del WAF; es Playwright puro, cero tokens de Claude). El checker lee el inbox directamente — toma las filas `- [ ]`, ignora las filas `- [x]`/`- [!]` y las entradas `local:`, e informa cuántas líneas omitió. **No** copiar las URLs a mano a un archivo temporal antes; ese paso cuesta tokens y es justo el que se acaba saltando.
2. El checker imprime un veredicto por URL y termina con código distinto de cero en cuanto alguna URL está expired/uncertain.
3. Cada URL que el checker reporte como **expired/closed** se resuelve en lugar de procesarse: moverla a la sección de procesadas como `- [x] ~~URL | Empresa | Rol~~ — oferta expirada (barrido de liveness)` y, si ya existe una fila en el tracker, ponerla en `Discarded`. **Nada** de extracción, evaluación ni generación de report/PDF para ella.
4. Los resultados `uncertain` se dejan en su sitio y se confirman durante la extracción normal (un timeout transitorio no debe descartar una oferta posiblemente viva).
5. Solo las URLs vivas supervivientes pasan al bucle de procesamiento de abajo.

## Workflow

1. **Leer** `data/pipeline.md` -> encontrar los ítems `- [ ]` en la sección "Pendientes" / "Pending" / "En attente"
2. **Para cada URL pendiente**:
   a. Reservar el siguiente `REPORT_NUM` secuencial de forma atómica ejecutando `node reserve-report-num.mjs` (y liberar el sentinel ejecutando `node reserve-report-num.mjs --release <num>` una vez escrito el report)
   b. **Extraer la oferta** con Playwright (`browser_navigate` + `browser_snapshot`) -> WebFetch -> WebSearch
   c. Si la URL no es accesible -> marcar como `- [!]` con una nota y continuar
   d. **Ejecutar el auto-pipeline completo**: Evaluación A-F -> Report .md -> PDF (si score >= 3.0) -> Tracker
   e. **Mover de "Pendientes" a "Procesadas"**: `- [x] #NNN | URL | Empresa | Rol | Score/5 | PDF sí/no`
3. **Si hay 3+ URLs pendientes**, lanzar agentes en paralelo (Agent tool con `run_in_background`) para maximizar la velocidad.
4. **Al final**, mostrar una tabla resumen:

```
| # | Empresa | Rol | Score | PDF | Acción recomendada |
```

## Formato de pipeline.md

```markdown
## Pendientes
- [ ] https://jobs.example.com/posting/123
- [ ] https://boards.greenhouse.io/company/jobs/456 | Company S.L. | Senior PM
- [!] https://private.url/job -- Error: requiere inicio de sesión

## Procesadas
- [x] #143 | https://jobs.example.com/posting/789 | Acme S.L. | AI PM | 4.2/5 | PDF sí
- [x] #144 | https://boards.greenhouse.io/xyz/jobs/012 | BigCo | SA | 2.1/5 | PDF no
```

> Nota: Las cabeceras de sección pueden estar en EN ("Pending"/"Processed"), ES ("Pendientes"/"Procesadas"), DE ("Offen"/"Verarbeitet") o FR ("En attente"/"Traitées"). Ser flexible al leer, fiel al estilo existente al escribir.

## Detección inteligente de la oferta desde la URL

1. **Playwright (preferido):** `browser_navigate` + `browser_snapshot`. Funciona con todas las SPAs.
   - **Opcional — extractor CLI (`scan.extractor: cli` en `config/profile.yml`):** ejecuta `node browser-extract.mjs <url>` (`--mode jd`) en su lugar — `{ "url", "title", "text" }` compacto, menos tokens (según el portal). **Recurre en silencio** a `browser_navigate` + `browser_snapshot` si falla o no está disponible.
2. **WebFetch (fallback):** Para páginas estáticas o cuando Playwright no está disponible.
3. **WebSearch (último recurso):** Buscar en portales secundarios que indexen la oferta.

**Casos especiales:**
- **LinkedIn**: Puede requerir inicio de sesión -> marcar `[!]` y pedir al candidato que pegue el texto
- **PDF**: Si la URL apunta a un PDF, leerlo directamente con la herramienta Read
- **Prefijo `local:`**: Leer el archivo local. Ejemplo: `local:jds/linkedin-pm-ai.md` -> leer `jds/linkedin-pm-ai.md`
- **InfoJobs / Indeed ES / LinkedIn ES**: Portales hispanohablantes habituales. Playwright gestiona bien los banners de cookies
- **Infojobs.es / Tecnoempleo / Computrabajo**: Bien estructurados, generalmente legibles por máquina. WebFetch suele ser suficiente

## Numeración automática

1. Ejecutar `node reserve-report-num.mjs` para reservar el siguiente número secuencial de forma atómica (stdout devuelve `{###}`).
2. Escribir el report con ese número.
3. Liberar el sentinel ejecutando `node reserve-report-num.mjs --release {###}` una vez escrito el report.

## Sincronización de fuentes

Antes de procesar una URL, verificar la sincronización:

```bash
node cv-sync-check.mjs
```

Si hay desincronización, avisar al candidato antes de continuar.

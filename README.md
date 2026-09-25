# teramot-status

Página de estado de los servicios de Teramot: **https://status.teramot.com**

HTML y JS plano, sin build. [`.github/workflows/status.yml`](./.github/workflows/status.yml)
corre cada 5 minutos: `scripts/check.mjs` consulta cada servicio de
`site/services.json`, guarda 90 días de historial en la rama `status-data` y
despliega `site/` a GitHub Pages.

```
site/
  index.html         la página
  services.json      servicios monitoreados
  sla.json           parámetros del SLA (objetivo, qué cuenta como caída)
  maintenance.json   ventanas de mantenimiento (excluidas del SLA)
  incidents.json     incidentes (a mano)
  data/              generado por scripts/check.mjs (gitignored; vive en la rama status-data)
    checks/AAAA-MM.ndjson   cada chequeo, una línea: {t, id, s, ms, code, err?}
    sla.json                uptime mensual por servicio
    detected-incidents.json caídas detectadas de los chequeos
scripts/
  check.mjs          chequeo de servicios + escritura de datos
  sla.mjs            cálculo del SLA (funciones puras)
  sla.test.mjs       tests: node --test scripts/sla.test.mjs
```

## Cómo se mide el SLA

- Cada chequeo representa el estado del servicio desde su hora hasta el
  siguiente chequeo, con un tope de 15 minutos. Pasado ese tope el tiempo
  queda **sin cobertura** (no se sabe qué pasó) y no cuenta ni como arriba ni
  como caído.
- **Downtime** = del primer chequeo fallido al primero sano.
- **Uptime del mes** = `1 − downtime / tiempo cubierto`, por mes calendario UTC.
- **Cobertura** = tiempo cubierto / tiempo transcurrido del mes. Hay que
  leerla junto al uptime: 100% con 40% de cobertura no dice mucho.
- Los mantenimientos de `maintenance.json` se restan de todo.
- *Degradado* cuenta como disponible salvo `degraded_counts_as_down: true`.
- El mes actual y el anterior se recalculan en cada corrida; los anteriores
  quedan fijos en `data/sla.json`. Los chequeos crudos no se borran nunca.
- Si el workflow no puede leer `status-data`, falla en vez de empezar de
  cero: un historial vacío pisaría el registro del SLA.

## Tareas comunes

- **Agregar/quitar un servicio:** editar `site/services.json`. Por defecto se
  exige HTTP 2xx; con `"expect": { "json": { "data.status": "ok" } }` además se
  valida el body (ruta con puntos). Si responde 2xx pero el body no coincide,
  queda *degradado*; más de 3s de latencia también cuenta como degradado.
- **Programar un mantenimiento:** agregar a `site/maintenance.json`
  `{ "services": ["docs"] | "all", "start": ISO, "end": ISO, "title", "body" }`.
  Se muestra en la página mientras no termine y se excluye del SLA.
- **Publicar un incidente:** agregar a `site/incidents.json`:
  ```json
  { "title": "Demoras en consultas", "date": "2026-09-25T14:00:00-03:00",
    "body": "Estamos investigando…", "resolved": false }
  ```
  El push a `main` despliega enseguida.

## Local

```sh
node scripts/check.mjs            # escribe site/data/
cd site && python3 -m http.server 8000
```

## Notas

- El cron de GitHub no es exacto; puede atrasarse 5–15 minutos.
- En repos públicos GitHub desactiva los workflows programados tras 60 días
  sin actividad en el repo. Si pasa, reactivar desde la pestaña Actions.

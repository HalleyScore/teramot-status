# teramot-status

Página de estado de los servicios de Teramot: **https://status.teramot.com**

HTML y JS plano, sin build. [`.github/workflows/status.yml`](./.github/workflows/status.yml)
corre cada 5 minutos: `scripts/check.mjs` consulta cada servicio de
`site/services.json`, guarda 90 días de historial en la rama `status-data` y
despliega `site/` a GitHub Pages.

```
site/
  index.html       la página
  services.json    servicios monitoreados
  incidents.json   incidentes (a mano)
  data/            generado por scripts/check.mjs (gitignored)
scripts/check.mjs  chequeo de servicios
```

## Tareas comunes

- **Agregar/quitar un servicio:** editar `site/services.json`. Por defecto se
  exige HTTP 2xx; con `"expect": { "json": { "data.status": "ok" } }` además se
  valida el body (ruta con puntos). Si responde 2xx pero el body no coincide,
  queda *degradado*; más de 3s de latencia también cuenta como degradado.
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

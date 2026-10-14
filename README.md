# paseo-agentes

Plugin de Paseo: en la cabecera de la barra lateral, los agentes de todos los workspaces del host que piden algo, los que
trabajan y los que acabaron sin que nadie los mirase. La barra de Paseo lista workspaces, y su vista por estado agrupa
workspaces, no agentes: con un workspace por área no se ve qué agente espera.

## Qué enseña

Los grupos son los mismos cubos y nombres de la vista de estado de Paseo (`STATUS_BUCKET_ORDER` y su i18n), en su orden:

| Grupo | Cuándo |
|---|---|
| Necesita datos | permiso o pregunta (`AskUserQuestion`) pendiente |
| Con error | el turno acabó en error |
| Para revisar | acabó y no se ha abierto desde entonces (`requiresAttention` de Paseo, que lo borra al verlo) |
| En ejecución | turno en curso |
| Terminado | visto y sin nada pendiente; sale plegado por defecto para no inundar |

La precedencia es la de Paseo (`deriveAgentStateBucket`): los datos que pide ganan al error, el error al turno en curso y este al final sin ver.
Los grupos vacíos no salen; sin nada pendiente el elemento no ocupa sitio. Dentro de un grupo, el más reciente arriba,
por una hora que no cambia mientras el agente emite (las filas no saltan bajo el puntero).

Cada fila lleva el icono de su proyecto como lo pinta la lista de workspaces de Paseo: la inicial sobre su color, con la
misma paleta y la misma clave (`projectKey` si ningún otro proyecto del host la comparte; si no, host y `projectId`).
Una imagen propia del proyecto no se copia: sale la inicial. El estado de cada agente lo dice su grupo.

La cabecera «Agentes» pliega y despliega el bloque y, plegado, deja una línea con el número de cada grupo; el título de
cada grupo pliega el suyo. Bajo la cabecera, el icono de cada proyecto con agentes: pulsarlo lo oculta (queda atenuado)
y vuelve a pulsarlo lo muestra, para ver solo las sesiones de unos workspaces o sin ellos. Lo plegado y lo oculto se
guardan en `localStorage` (`paseo-agentes:plegado`) en la web y el escritorio; en el móvil dura hasta cerrar la app. Desplegado, el bloque ocupa como mucho el 60 % del alto de la ventana y se desplaza.

Pulsar una fila abre el agente en su workspace. Paseo 0.11 solo da `navigation.openAgent` a pantallas y paneles, no a
los elementos de la barra lateral: la fila abre la pantalla `abrir` del plugin, que abre el agente al montarse, y la
navegación de workspaces de Paseo vuelve al host sin dejarla en el historial.

## Dónde se ve

Lo elige el ajuste del plugin «Dónde se ve» (Ajustes de Paseo → plugin «Agentes por estado»), uno por host para todos sus
clientes:

- **Izquierda** (por defecto): en la cabecera de la barra lateral.
- **Derecha**: como panel «Agentes» del Explorer, la columna de la derecha junto a Archivos y Cambios, con el mismo
  contenido; ahí la fila abre el agente directamente. El Explorer solo existe con un workspace abierto.

El panel se pone o se quita al cambiar el ajuste, sin recargar: lo lee la parte de servidor al cargar (`lado.get`) y lo
sigue cualquier parte del plugin que esté montada.

## Las mismas reglas que la vista de estado

El estado de cada fila sigue las reglas con que el daemon calcula la vista de estado de los workspaces
(`workspace-directory.ts`), para que el bloque y esa vista digan lo mismo:

- Solo son filas los agentes raíz de su workspace. Un agente hijo (`paseo.parent-agent-id`) del mismo workspace no sale:
  mientras corre, su raíz sale «En ejecución». Un hijo en otro workspace es raíz allí; uno cuyo padre ya no está, no sale.
- Un agente con un subagente de Claude vivo (la herramienta Task en segundo plano o un workflow) sale «En ejecución»
  aunque su turno haya acabado. Se sabe por el evento `agent.provider_subagents.update`, que no trae foto inicial: un
  subagente que ya corría al cargar el plugin se ve en su siguiente acción o al acabar.
- Un `Bash` en segundo plano (un watcher) no cuenta en ninguna de las dos vistas: Paseo no lo trata como subagente.

La vista de abajo agrupa workspaces y este bloque agentes: un workspace sale «En ejecución» si cualquiera de sus agentes
corre, aunque otro de ellos esté «Para revisar».

## Subagentes y watchers de cada agente

A la derecha de cada fila, lo que el agente tiene en marcha en segundo plano, con su número: un robot por subagentes de
Claude y un ojo por watchers (tareas de Claude Code: un `Bash` en segundo plano, un `Monitor`). Cuenta también lo de los
hijos que se pliegan en esa fila. No cambia el grupo: un watcher no hace «En ejecución», igual que en la vista de Paseo.

- Subagentes: el evento `agent.provider_subagents.update` de Paseo.
- Watchers: Paseo no los guarda. Claude Code escribe la salida de cada tarea en
  `<tmp>/claude-<uid>/<cwd>/<sessionId>/tasks/<id>.output` y el proceso que la ejecuta tiene ese fichero abierto hasta que
  acaba. La parte de servidor del plugin (RPC `vigilantes.list`) recorre `/proc` en el host del daemon y cuenta esos
  ficheros abiertos por sesión (~150 ms); el `sessionId` del agente es la carpeta. El cliente lo pide cuando cambian los
  agentes (un watcher nace dentro de un turno y su final despierta al agente), como mucho una vez cada 3 s.
- Límite: mientras el agente está en turno, el comando que ejecuta en primer plano cuenta también (usa el mismo fichero).
  Solo se ven procesos del usuario del daemon.

## Qué lee y envía

El directorio de agentes del daemon, con la suscripción del SDK (`paseo.agents.list({ subscribe: {} })`): una foto
al empezar y un `agent_update` por cambio, sin sondeo. Y la lista de proyectos (`paseo.projects.list()`), que relee entera
con cada `project.update` para el icono de las filas. Y el evento de subagentes de Claude
(`observeEvents(["agent.provider_subagents.update"])`), del que solo usa altas, cambios de estado y bajas. Su parte de servidor solo lee `/proc` del host del daemon (los ficheros que tiene abiertos cada proceso, para los
watchers). No escribe en el daemon más que su documento de ajustes (`paseo-agentes`, el lado); lo plegado se guarda en el cliente y no llama a nadie fuera del daemon.

## Instalación

Desde el clon, en el tronco:

```sh
scripts/deploy.sh
```

Copia lo que declara `files` de `package.json` a `~/.local/share/paseo-agentes/paseo-plugin/<versión>-<git sha>`, mueve
el enlace `current` y hace `paseo plugin install <current>` la primera vez y `paseo plugin reload paseo-agentes` después.
Comprueba antes `paseo --version` contra `requirements.paseo` del manifiesto: fuera de rango no despliega y lo dice.

## Pruebas

`npm ci --ignore-scripts && npm run typecheck && npm test`. Los tests cubren la clasificación, el orden, lo que corre en segundo plano por fila (y un proceso real que
abre un fichero de tareas falso), el
icono de cada proyecto y la lectura de lo plegado (`shared/agentes.ts`); la suscripción y la navegación se comprueban en el vivo.

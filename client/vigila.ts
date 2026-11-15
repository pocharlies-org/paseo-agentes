import type { PluginClientContext } from "@getpaseo/plugin/client";
import { panelWatch, type Espera, type Panel, type Tarea } from "../shared/contract.ts";

/** The panel's file-backed data as the view reads it: by session id, only the sessions that have some. */
export interface DatosPanel {
  readonly tareas: Readonly<Record<string, Tarea[]>>;
  readonly contexto: Readonly<Record<string, number>>;
  readonly espera: Readonly<Record<string, Espera>>;
  readonly vigilantes: Readonly<Record<string, number>>;
}

/** What an answer leaves: a complete one replaces everything, a partial one only the sessions it brings. */
export function aplica(antes: DatosPanel, panel: Panel): DatosPanel {
  const tareas = panel.completo ? {} : { ...antes.tareas };
  const contexto = panel.completo ? {} : { ...antes.contexto };
  const espera = panel.completo ? {} : { ...antes.espera };
  for (const [id, sesion] of Object.entries(panel.sesiones)) {
    delete tareas[id];
    delete contexto[id];
    delete espera[id];
    if (sesion.tareas.length > 0) tareas[id] = sesion.tareas;
    if (sesion.tokens !== null) contexto[id] = sesion.tokens;
    if (sesion.espera) espera[id] = sesion.espera;
  }
  return { tareas, contexto, espera, vigilantes: panel.vigilantes ?? (panel.completo ? {} : antes.vigilantes) };
}

/**
 * What Paseo has no event for (task lists, transcripts, watchers) comes from one call the server holds until something of
 * this client's moves (SC-5601), and it brings only what moved: the next call goes out when the last one answers, never on a
 * clock. `pide(sesiones)` is called on every agent change; the same set leaves the held call alone, a new set (an agent added
 * or removed) restarts it asking for everything once. A failure (daemon gone, plugin reloading) sends nothing until the next
 * agent change, which asks for everything again; the subscription is restored on reconnect. The last good data stays.
 */
export function vigilaPanel(rpc: PluginClientContext["rpc"], publica: (datos: DatosPanel) => void, vivo: AbortSignal) {
  let datos: DatosPanel = { tareas: {}, contexto: {}, espera: {}, vigilantes: {} };
  let version = 0;
  let pidiendo: AbortController | null = null;
  let pedidas = "";
  let ultimas: string[] = [];
  const pide = (sesiones: readonly string[]) => {
    ultimas = [...new Set(sesiones.filter((id) => id !== ""))].sort();
    const clave = ultimas.join(" ");
    if (vivo.aborted || (pidiendo && clave === pedidas)) return;
    pidiendo?.abort();
    if (clave !== pedidas) version = 0; // a partial answer only covers the sessions already held
    const esta = new AbortController();
    pidiendo = esta;
    pedidas = clave;
    void rpc(panelWatch, { sesiones: ultimas, since: version }).then(
      (panel) => {
        if (esta.signal.aborted) return;
        pidiendo = null;
        version = panel.version;
        if (panel.completo || panel.vigilantes || Object.keys(panel.sesiones).length > 0) publica((datos = aplica(datos, panel)));
        pide(ultimas);
      },
      () => {
        if (esta.signal.aborted) return;
        pidiendo = null;
        version = 0;
      },
    );
  };
  vivo.addEventListener("abort", () => pidiendo?.abort());
  return pide;
}

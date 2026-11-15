import type { PluginClientContext } from "@getpaseo/plugin/client";
import { panelWatch, type Panel } from "../shared/contract.ts";

/**
 * What Paseo has no event for (task lists, transcripts, watchers) comes from one call the server holds until it changes
 * (SC-5601): the next call goes out when the last one answers, never on a clock. `pide(sesiones)` is called on every agent
 * change; a new set of sessions restarts the call so a new agent joins at once, the same set leaves the held call alone.
 * A failure (daemon gone, plugin reloading) sends nothing until the next agent change: the subscription is restored on
 * reconnect, and that change is the next ask. The last good data stays: the sections are auxiliary.
 */
export function vigilaPanel(rpc: PluginClientContext["rpc"], publica: (panel: Panel) => void, vivo: AbortSignal) {
  let version = 0;
  let pidiendo: AbortController | null = null;
  let pedidas = "";
  let ultimas: string[] = [];
  const pide = (sesiones: readonly string[]) => {
    ultimas = [...new Set(sesiones.filter((id) => id !== ""))].sort();
    const clave = ultimas.join(" ");
    if (vivo.aborted || (pidiendo && clave === pedidas)) return;
    pidiendo?.abort();
    const esta = new AbortController();
    pidiendo = esta;
    pedidas = clave;
    void rpc(panelWatch, { sesiones: ultimas, since: version }).then(
      (panel) => {
        if (esta.signal.aborted) return;
        pidiendo = null;
        version = panel.version;
        if (panel.changed) publica(panel);
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

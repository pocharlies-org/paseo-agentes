import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ajustesAgentes } from "./shared/ajustes.ts";
import { panelWatch } from "./shared/contract.ts";
import { vigilia } from "./server/vigilia.ts";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(ajustesAgentes);
  // What Paseo has no event for is kept by file watches on the daemon host; clients hold one call each until it changes (SC-5601).
  const panel = vigilia();
  server.handle(panelWatch, ({ sesiones, since }) => panel.espera(sesiones, since));
  // A background task's end only closes its output file (no event), but it wakes its agent: count them again on every turn.
  server.on("agent.turn_started", () => panel.turno());
  server.on("agent.turn_ended", () => panel.turno());
  return () => panel.cierra();
}

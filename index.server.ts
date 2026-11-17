import type { PluginServerContext } from "@getpaseo/plugin/server";
import { sesionDe } from "./shared/agentes.ts";
import { ajustesAgentes } from "./shared/ajustes.ts";
import { panelWatch } from "./shared/contract.ts";
import { vigilia } from "./server/vigilia.ts";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(ajustesAgentes);
  // What Paseo has no event for is kept by file watches on the daemon host; clients hold one call each until it changes (SC-5601).
  const panel = vigilia();
  server.handle(panelWatch, ({ sesiones, since }) => panel.espera(sesiones, since));
  // A turn's end leaves only its background tasks holding files (SC-5923); the hook names the agent, Paseo its Claude session.
  server.on("agent.turn_ended", async ({ agent }, { paseo }) => {
    const sesion = sesionDe((await paseo.agents.ref(agent.id).refresh().catch(() => null))?.agent ?? {});
    if (sesion) panel.turno(sesion);
  });
  return () => panel.cierra();
}

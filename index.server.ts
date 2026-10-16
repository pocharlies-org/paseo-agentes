import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ajustesAgentes } from "./shared/ajustes.ts";
import { vigilantesList } from "./shared/contract.ts";
import { vigilantes } from "./server/vigilantes.ts";

// Paseo refuses a contribution that returns no cleanup; this one keeps nothing to release.
export default function contribute(server: PluginServerContext) {
  server.registerSettings(ajustesAgentes);
  server.handle(vigilantesList, async () => ({ sesiones: await vigilantes() }));
  return () => {};
}

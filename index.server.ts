import type { PluginServerContext } from "@getpaseo/plugin/server";
import { vigilantesList } from "./shared/contract.ts";
import { vigilantes } from "./server/vigilantes.ts";

// Paseo refuses a contribution that returns no cleanup; this one keeps nothing to release.
export default function contribute(server: PluginServerContext) {
  server.handle(vigilantesList, () => ({ sesiones: vigilantes() }));
  return () => {};
}

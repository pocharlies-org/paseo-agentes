import type { PluginServerContext } from "@getpaseo/plugin/server";
import { vigilantesList } from "./shared/contract.ts";
import { vigilantes } from "./server/vigilantes.ts";

export default function contribute(server: PluginServerContext) {
  server.handle(vigilantesList, () => ({ sesiones: vigilantes() }));
}

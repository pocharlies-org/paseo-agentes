import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ajustesAgentes } from "./shared/ajustes.ts";
import { ladoGet, vigilantesList } from "./shared/contract.ts";
import { vigilantes } from "./server/vigilantes.ts";

// Paseo refuses a contribution that returns no cleanup; this one keeps nothing to release.
export default function contribute(server: PluginServerContext) {
  const ajustes = server.registerSettings(ajustesAgentes);
  server.handle(vigilantesList, () => ({ sesiones: vigilantes() }));
  server.handle(ladoGet, async () => {
    const actual = await ajustes.read();
    return { lado: actual.status === "ready" ? actual.values.lado : "izquierda" };
  });
  return () => {};
}

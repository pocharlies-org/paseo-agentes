import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ajustesAgentes } from "./shared/ajustes.ts";
import { cambiosList, contextoList, type Tarea, vigilantesList } from "./shared/contract.ts";
import { cambios } from "./server/cambios.ts";
import { contexto, tareas } from "./server/contexto.ts";
import { vigilantes } from "./server/vigilantes.ts";

// Paseo refuses a contribution that returns no cleanup; this one keeps nothing to release.
export default function contribute(server: PluginServerContext) {
  server.registerSettings(ajustesAgentes);
  server.handle(vigilantesList, async () => ({ sesiones: await vigilantes() }));
  server.handle(cambiosList, async ({ rutas }) => ({
    cambios: Object.fromEntries(await Promise.all(rutas.map(async (ruta) => [ruta, await cambios(ruta)]))),
  }));
  server.handle(contextoList, async ({ sesiones }) => {
    const leidas = await Promise.all(
      sesiones.map(async (s) => [s.id, await tareas(s.id), await contexto(s.id, s.cwd)] as const),
    );
    const tareasPorSesion: Record<string, Tarea[]> = {};
    const contextoPorSesion: Record<string, number> = {};
    for (const [id, lista, tokens] of leidas) {
      if (lista.length > 0) tareasPorSesion[id] = lista;
      if (tokens !== null) contextoPorSesion[id] = tokens;
    }
    return { tareas: tareasPorSesion, contexto: contextoPorSesion };
  });
  return () => {};
}

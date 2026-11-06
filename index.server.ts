import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ajustesAgentes } from "./shared/ajustes.ts";
import { cambiosList, contextoList, type Espera, type Tarea, vigilantesList } from "./shared/contract.ts";
import { cambios } from "./server/cambios.ts";
import { esperaDe, lectura, tareas, tokensDeContexto } from "./server/contexto.ts";
import { vigilantes } from "./server/vigilantes.ts";

// Paseo refuses a contribution that returns no cleanup; this one keeps nothing to release.
export default function contribute(server: PluginServerContext) {
  server.registerSettings(ajustesAgentes);
  server.handle(vigilantesList, async () => ({ sesiones: await vigilantes() }));
  server.handle(cambiosList, async ({ rutas }) => ({ cambios: await cambios(rutas) }));
  server.handle(contextoList, async ({ sesiones }) => {
    // One tail read per session feeds the tokens and what its closing line waits on (SC-4703, SC-4800).
    const leidas = await Promise.all(
      sesiones.map(async (s) => {
        const lista = await tareas(s.id);
        const suelta = await lectura(s.id, s.cwd);
        return [s.id, lista, suelta === null ? null : tokensDeContexto(suelta), suelta === null ? null : esperaDe(suelta)] as const;
      }),
    );
    const tareasPorSesion: Record<string, Tarea[]> = {};
    const contextoPorSesion: Record<string, number> = {};
    const esperaPorSesion: Record<string, Espera> = {};
    for (const [id, lista, tokens, espera] of leidas) {
      if (lista.length > 0) tareasPorSesion[id] = lista;
      if (tokens !== null) contextoPorSesion[id] = tokens;
      if (espera) esperaPorSesion[id] = espera;
    }
    return { tareas: tareasPorSesion, contexto: contextoPorSesion, espera: esperaPorSesion };
  });
  return () => {};
}

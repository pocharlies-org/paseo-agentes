import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Claude Code background tasks running now, counted per Claude session id (the agent's `persistence.sessionId`). */
export const vigilantesList = defineRpc({
  name: "vigilantes.list",
  input: z.object({}).strict(),
  output: z.object({ sesiones: z.record(z.string(), z.number().int().nonnegative()) }),
});

export const EstadoCambios = z.enum(["verde", "roja", "marcha", "sinChecks", "sinPr"]);
export type EstadoCambios = z.infer<typeof EstadoCambios>;

/** One line of the «Cambios» list: `repo #num · título · ok/total` (or `repo · rama` without a PR), with the workspace directories that produced it (the panel shows only its own). */
export const CambiosLineaSchema = z.object({
  texto: z.string(),
  estado: EstadoCambios,
  rutas: z.array(z.string()),
});
export type CambiosLinea = z.infer<typeof CambiosLineaSchema>;

/** The open PR of each workspace's branch with its GitHub Actions rollup, or the branch when it has no PR (SC-2838, like Claude Desktop). */
export const cambiosList = defineRpc({
  name: "cambios.list",
  input: z.object({ rutas: z.array(z.string()) }).strict(),
  output: z.object({ cambios: z.array(CambiosLineaSchema) }),
});

export const TareaSchema = z.object({
  subject: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
});
export type Tarea = z.infer<typeof TareaSchema>;

/** The Claude Code task list and the context used (tokens of the last turn) per session, read on the daemon host (SC-2838). */
export const contextoList = defineRpc({
  name: "contexto.list",
  input: z.object({ sesiones: z.array(z.object({ id: z.string(), cwd: z.string() }).strict()) }).strict(),
  output: z.object({
    tareas: z.record(z.string(), z.array(TareaSchema)),
    contexto: z.record(z.string(), z.number().int().nonnegative()),
  }),
});

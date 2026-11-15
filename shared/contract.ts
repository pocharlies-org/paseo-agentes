import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** How a «Cambios» line reads (SC-2838): its checks green, red or running, a PR without checks, or a branch without a PR. */
export type EstadoCambios = "verde" | "roja" | "marcha" | "sinChecks" | "sinPr";

/** One line of the «Cambios» list: `repo #num · título · ok/total` (or `repo · rama` without a PR), with the workspace directories that produced it (the panel shows only its own). */
export interface CambiosLinea {
  readonly texto: string;
  readonly estado: EstadoCambios;
  readonly rutas: readonly string[];
}

export const TareaSchema = z.object({
  subject: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
});
export type Tarea = z.infer<typeof TareaSchema>;

/** What the last turn's closing line waits on (SC-4800): Dani (PARA DANI), another session or ticket (ESPERA: jira, PARA IT/SECURITY/QA), CI (ci, merge, review, run, argocd), a date, or done (ESTADO: ENTREGA). */
export const Espera = z.enum(["dani", "sesion", "ci", "fecha", "entrega"]);
export type Espera = z.infer<typeof Espera>;

/**
 * What the panel needs and Paseo has no event for, read on the daemon host (SC-2838, SC-4703, SC-4800): each session's Claude
 * Code task list, the context its last turn used (tokens) and what its last closing line waits on, and the running Claude Code
 * tasks (watchers) per session. A long poll (SC-5601): with `since` equal to the server's version the call is held until
 * something changes or the hold expires (`changed: false`, nothing else filled); otherwise it answers at once.
 */
export const panelWatch = defineRpc({
  name: "panel.watch",
  input: z.object({ sesiones: z.array(z.string()), since: z.number().int() }).strict(),
  output: z.object({
    tareas: z.record(z.string(), z.array(TareaSchema)),
    contexto: z.record(z.string(), z.number().int().nonnegative()),
    espera: z.record(z.string(), Espera),
    vigilantes: z.record(z.string(), z.number().int().nonnegative()),
    version: z.number().int(),
    changed: z.boolean(),
  }),
});
export type Panel = z.infer<typeof panelWatch.output>;

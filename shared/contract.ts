import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** How a «Cambios» line reads (SC-2838): its checks green, red or running, a PR without checks, or a branch without a PR. */
export type EstadoCambios = "verde" | "roja" | "marcha" | "sinChecks" | "sinPr";

export const TareaSchema = z.object({
  subject: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
});
export type Tarea = z.infer<typeof TareaSchema>;

/** What the last turn's closing line waits on (SC-4800): Dani (PARA DANI), another session or ticket (ESPERA: jira, PARA IT/SECURITY/QA), CI (ci, merge, review, run, argocd), a date, or done (ESTADO: ENTREGA). */
export const Espera = z.enum(["dani", "sesion", "ci", "fecha", "entrega"]);
export type Espera = z.infer<typeof Espera>;

/** One session's part of the panel: its task list, the context its last turn used (tokens) and what its closing line waits on. */
export const SesionSchema = z.object({
  tareas: z.array(TareaSchema),
  tokens: z.number().int().nonnegative().nullable(),
  espera: Espera.nullable(),
});
export type Sesion = z.infer<typeof SesionSchema>;

/**
 * What the panel needs and Paseo has no event for, read on the daemon host (SC-2838, SC-4703, SC-4800): each session's Claude
 * Code task list, tokens and closing line, and the running Claude Code tasks (watchers) per session. A long poll that answers
 * only what moved (SC-5601): `sesiones` holds the asked sessions whose tasks or closing line changed after `since` (their
 * tokens alone wake no one but ride along, SC-5849), and `vigilantes` comes only when it changed; `completo` means every asked session is there and replaces what the client had (a first call, `since: 0`,
 * or a `since` from before the plugin was reloaded). When nothing of the caller's moved, the call is held until something does
 * or the hold expires (empty answer at the same version).
 */
export const panelWatch = defineRpc({
  name: "panel.watch",
  input: z.object({ sesiones: z.array(z.string()), since: z.number().int() }).strict(),
  output: z.object({
    sesiones: z.record(z.string(), SesionSchema),
    vigilantes: z.record(z.string(), z.number().int().nonnegative()).optional(),
    version: z.number().int(),
    completo: z.boolean(),
  }),
});
export type Panel = z.infer<typeof panelWatch.output>;

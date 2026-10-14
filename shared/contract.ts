import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Claude Code background tasks running now, counted per Claude session id (the agent's `persistence.sessionId`). */
export const vigilantesList = defineRpc({
  name: "vigilantes.list",
  input: z.object({}).strict(),
  output: z.object({ sesiones: z.record(z.string(), z.number().int().nonnegative()) }),
});

/** The side the block shows on, read on the server: a client needs it before any of its components mounts. */
export const ladoGet = defineRpc({
  name: "lado.get",
  input: z.object({}).strict(),
  output: z.object({ lado: z.enum(["izquierda", "derecha"]) }),
});

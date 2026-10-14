import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export type Lado = "izquierda" | "derecha";

// Where the block shows: the sidebar's header (left) or a panel in the Explorer (right). One document for every client of the host.
export const ajustesAgentes = defineSettings({
  id: "paseo-agentes",
  scope: "host",
  version: 1,
  schema: z.object({ lado: z.enum(["izquierda", "derecha"]).default("izquierda") }),
});

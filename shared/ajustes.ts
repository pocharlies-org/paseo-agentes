import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export type Lado = "izquierda" | "derecha";
export type Agrupar = "estado" | "workspace";
export type Letra = "compacta" | "normal" | "grande" | "muyGrande";

// Where the block shows: the sidebar's header (left) or a panel in the Explorer (right). One document for every client of the host.
// `agrupar` arrived with a default, so the stored version stays 1: an old save parses to «estado» without a migration.
export const ajustesAgentes = defineSettings({
  id: "paseo-agentes",
  scope: "host",
  version: 1,
  schema: z.object({
    lado: z.enum(["izquierda", "derecha"]).default("izquierda"),
    agrupar: z.enum(["estado", "workspace"]).default("estado"),
    letra: z.enum(["compacta", "normal", "grande", "muyGrande"]).default("normal"),
  }),
});

import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributeAgentes } from "./client/agentes.tsx";

export default function contribute(client: PluginClientContext) {
  return contributeAgentes(client);
}

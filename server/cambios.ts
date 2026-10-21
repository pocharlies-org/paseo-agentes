import { execFile } from "node:child_process";
import type { CambiosLinea, EstadoCambios } from "../shared/contract.ts";

// Claude Desktop's «Cambios» for the workspace's own checkout: the open PR of its branch with the GitHub Actions rollup,
// or the branch itself when it has no PR. One `gh pr view` per workspace (workspaces are the house's worktrees), never a
// scan of the clone: a root like ~/k8s holds hundreds of worktrees and each line would cost a gh call.

function sale(cmd: string, args: string[], cwd: string, timeout = 15_000): Promise<string | null> {
  return new Promise((ok) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => ok(error && !stdout ? null : String(stdout)));
  });
}

/** The check rollup of `gh pr view --json statusCheckRollup` as the block's states, with the same rules as cambios.sh. */
export function estadoRollup(checks: unknown): { estado: EstadoCambios; ok: number; total: number } {
  const lista = Array.isArray(checks) ? checks : [];
  const nombres = lista.map((c) => String((c as { conclusion?: unknown; state?: unknown }).conclusion ?? (c as { state?: unknown }).state ?? "PENDING").toUpperCase());
  const ok = nombres.filter((n) => n === "SUCCESS" || n === "SKIPPED" || n === "NEUTRAL").length;
  const fail = nombres.filter((n) => n === "FAILURE" || n === "TIMED_OUT" || n === "CANCELLED" || n === "STALE").length;
  const total = lista.length;
  const estado: EstadoCambios = fail > 0 ? "roja" : total - ok - fail > 0 ? "marcha" : total === 0 ? "sinChecks" : "verde";
  return { estado, ok, total };
}

async function lineaDe(dir: string): Promise<(CambiosLinea & { clave: string }) | null> {
  const branch = (await sale("git", ["branch", "--show-current"], dir))?.trim();
  if (!branch) return null;
  const url = (await sale("git", ["config", "--get", "remote.origin.url"], dir))?.trim();
  const repo = url?.replace(/^.*[/:]/, "").replace(/\.git$/, "");
  if (!repo) return null;
  const salida = await sale("gh", ["pr", "view", "--json", "number,title,statusCheckRollup"], dir);
  if (!salida) return { texto: `${repo} · ${branch}`, estado: "sinPr", rutas: [dir], clave: `sinPr:${repo}:${branch}` };
  let pr: { number: number; title: string; statusCheckRollup?: unknown };
  try {
    pr = JSON.parse(salida);
  } catch {
    return { texto: `${repo} · ${branch}`, estado: "sinPr", rutas: [dir], clave: `sinPr:${repo}:${branch}` };
  }
  const { estado, ok, total } = estadoRollup(pr.statusCheckRollup);
  return { texto: `${repo} #${pr.number} · ${pr.title.slice(0, 60)} · ${ok}/${total}`, estado, rutas: [dir], clave: `pr:${repo}#${pr.number}` };
}

/** One line per workspace directory (deduped: two workspaces on the same branch are the same PR, with both rutas); unreadable ones give nothing. */
export async function cambios(rutas: readonly string[]): Promise<CambiosLinea[]> {
  const lineas = (await Promise.all(rutas.map(lineaDe))).filter((l): l is CambiosLinea & { clave: string } => l !== null);
  const porClave = new Map<string, CambiosLinea>();
  for (const { clave, rutas: rutasDeLinea, ...linea } of lineas) {
    const previa = porClave.get(clave);
    porClave.set(clave, previa ? { ...linea, rutas: [...new Set([...previa.rutas, ...rutasDeLinea])] } : { ...linea, rutas: rutasDeLinea });
  }
  return [...porClave.values()];
}

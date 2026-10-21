import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CambiosLinea, EstadoCambios } from "../shared/contract.ts";

// Port of local-router's cambios.sh (SC-2805): the open PR of each worktree's branch with its GitHub Actions rollup,
// plus the worktrees with no PR — Claude Desktop's «Cambios» panel, resolved with `gh pr view`.

function sale(cmd: string, args: string[], cwd: string, timeout = 15_000): Promise<string | null> {
  return new Promise((ok) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => ok(error && !stdout ? null : String(stdout)));
  });
}

/** The check rollup of `gh pr view --json statusCheckRollup` as the block's state, with the same rules as cambios.sh. */
export function estadoRollup(checks: unknown): { estado: EstadoCambios; ok: number; total: number } {
  const lista = Array.isArray(checks) ? checks : [];
  const nombres = lista.map((c) => String((c as { conclusion?: unknown; state?: unknown }).conclusion ?? (c as { state?: unknown }).state ?? "PENDING").toUpperCase());
  const ok = nombres.filter((n) => n === "SUCCESS" || n === "SKIPPED" || n === "NEUTRAL").length;
  const fail = nombres.filter((n) => n === "FAILURE" || n === "TIMED_OUT" || n === "CANCELLED" || n === "STALE").length;
  const total = lista.length;
  const estado: EstadoCambios = fail > 0 ? "roja" : total - ok - fail > 0 ? "marcha" : total === 0 ? "sinChecks" : "verde";
  return { estado, ok, total };
}

async function esGit(dir: string): Promise<boolean> {
  try {
    return (await stat(join(dir, ".git"))).isFile() || (await stat(join(dir, ".git"))).isDirectory();
  } catch {
    return false;
  }
}

/** The clone and its worktrees by the house convention (`<clone>/.claude/worktrees/<KEY>-<topic>` and `<clone>/.wt-<KEY>`). */
export async function worktreesDe(raiz: string): Promise<string[]> {
  const wts: string[] = [];
  if (await esGit(raiz)) return [raiz];
  let clones;
  try {
    clones = await readdir(raiz, { withFileTypes: true });
  } catch {
    return wts;
  }
  for (const cl of clones) {
    if (!cl.isDirectory()) continue;
    const clone = join(raiz, cl.name);
    if (!(await esGit(clone))) continue;
    wts.push(clone);
    const dentro = [join(clone, ".claude", "worktrees"), clone] as const;
    for (const base of dentro) {
      let hijos;
      try {
        hijos = await readdir(base, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const h of hijos) {
        if (!h.isDirectory()) continue;
        const wt = join(base, h.name);
        if ((base.endsWith("worktrees") || h.name.startsWith(".wt-")) && (await esGit(wt))) wts.push(wt);
      }
    }
  }
  return wts;
}

async function lineaDe(wt: string): Promise<{ texto: string; estado: EstadoCambios; clave: string } | null> {
  const branch = (await sale("git", ["branch", "--show-current"], wt))?.trim();
  if (!branch) return null;
  const url = (await sale("git", ["config", "--get", "remote.origin.url"], wt))?.trim();
  const repo = url?.replace(/^.*[/:]/, "").replace(/\.git$/, "");
  if (!repo) return null;
  const salida = await sale("gh", ["pr", "view", "--json", "number,title,statusCheckRollup"], wt);
  if (!salida) return null;
  let pr: { number: number; title: string; statusCheckRollup?: unknown };
  try {
    pr = JSON.parse(salida);
  } catch {
    return null;
  }
  const { estado, ok, total } = estadoRollup(pr.statusCheckRollup);
  return { texto: `${repo} #${pr.number} · ${pr.title.slice(0, 60)} · ${ok}/${total}`, estado, clave: `${repo}#${pr.number}` };
}

/** The Cambios of one clone root: one line per open PR (deduped by repo and number) and one per worktree without a PR. */
export async function cambios(raiz: string): Promise<CambiosLinea[]> {
  const wts = await worktreesDe(raiz);
  const lineas = await Promise.all(wts.map(lineaDe));
  const porClave = new Map<string, CambiosLinea>();
  const sinPr = new Map<string, string>();
  lineas.forEach((linea, i) => {
    if (linea) porClave.set(linea.clave, { texto: linea.texto, estado: linea.estado });
    else if (wts[i]) sinPr.set(wts[i]!, wts[i]!);
  });
  // A worktree whose gh failed is not "sin PR" unless it has a branch: the same rule as cambios.sh (the file stays empty).
  const sinPrLineas: CambiosLinea[] = [];
  for (const wt of sinPr.values()) {
    const branch = (await sale("git", ["branch", "--show-current"], wt))?.trim();
    const url = (await sale("git", ["config", "--get", "remote.origin.url"], wt))?.trim();
    const repo = url?.replace(/^.*[/:]/, "").replace(/\.git$/, "");
    if (branch && repo) sinPrLineas.push({ texto: `${repo} · ${branch}`, estado: "sinPr" });
  }
  return [...porClave.values(), ...sinPrLineas];
}

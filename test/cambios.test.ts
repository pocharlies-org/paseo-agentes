import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { estadoRollup, worktreesDe } from "../server/cambios.ts";

test("the check rollup reads as the block's states, with the same rules as cambios.sh", () => {
  assert.deepEqual(estadoRollup([{ conclusion: "SUCCESS" }, { conclusion: "SKIPPED" }]), { estado: "verde", ok: 2, total: 2 });
  assert.deepEqual(estadoRollup([{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }]), { estado: "roja", ok: 1, total: 2 });
  assert.deepEqual(estadoRollup([{ state: "PENDING" }, { conclusion: "SUCCESS" }]), { estado: "marcha", ok: 1, total: 2 });
  assert.deepEqual(estadoRollup([]), { estado: "sinChecks", ok: 0, total: 0 });
  assert.deepEqual(estadoRollup(undefined), { estado: "sinChecks", ok: 0, total: 0 });
});

test("worktrees are found by the house convention, and a non-clone root gives nothing", async () => {
  const raiz = mkdtempSync(join(tmpdir(), "cambios-"));
  try {
    // root/clone (git), its .claude/worktrees/<key> and .wt-<KEY>; plus a non-git directory that must be skipped.
    for (const wt of ["clone", "clone/.claude/worktrees/SC-1-tema", "clone/.wt-SC-2", "sin-git"]) {
      mkdirSync(join(raiz, wt, ".claude", "worktrees"), { recursive: true });
    }
    mkdirSync(join(raiz, "clone", ".git"), { recursive: true });
    mkdirSync(join(raiz, "clone", ".claude", "worktrees", "SC-1-tema", ".git"), { recursive: true });
    mkdirSync(join(raiz, "clone", ".wt-SC-2", ".git"), { recursive: true });
    mkdirSync(join(raiz, "clone", ".claude", "worktrees", "sin-git"), { recursive: true });
    const wts = (await worktreesDe(raiz)).map((w) => w.slice(raiz.length + 1)).sort();
    assert.deepEqual(wts, ["clone", "clone/.claude/worktrees/SC-1-tema", "clone/.wt-SC-2"]);
  } finally {
    rmSync(raiz, { recursive: true, force: true });
  }
});

test("a root that is itself a clone is just itself; a missing root gives nothing", async () => {
  const raiz = await mkdtemp(join(tmpdir(), "cambios-"));
  try {
    mkdirSync(join(raiz, ".git"));
    assert.deepEqual(await worktreesDe(raiz), [raiz]);
  } finally {
    rmSync(raiz, { recursive: true, force: true });
  }
  assert.deepEqual(await worktreesDe(join(tmpdir(), "no-existe-paseo-agentes")), []);
});

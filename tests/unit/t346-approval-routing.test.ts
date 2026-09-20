// covers: file:tools/aidlc-state.ts (set-approval-routing)
//
// t346 - the per-intent Approval Routing field: where this intent's approval
// gates are ANSWERED. `in-session` (the default) keeps the interactive gate;
// `external` hands the gate to a tracker, so the stage protocol records the
// handoff and parks instead of reporting approved, and the approval arrives
// later as an attested relay (t345).
//
// WHY PER-INTENT. The Approve branch lives in stage-protocol.md, which every
// stage of every workflow shares, so the behaviour cannot simply be changed —
// it has to be selected. A per-intent state field was chosen over a scope flag
// or an environment variable because a team runs some work interactively and
// some through the tracker under the SAME scope, the choice must survive a
// resume, and every other routing decision in this engine is legible in the
// record rather than in a shell.
//
// THE ADDITIVE PROPERTY is what most of these assert: an absent field reads as
// in-session, and an in-session intent emits no directive key at all, so every
// record and directive predating this field behaves exactly as before.
//
// Mechanism: spawned CLI (aidlc-state.ts) against a seeded temp project.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  seedAidlcMemory,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";
import {
  readApprovalRouting,
  isExternalApprovalRouting,
} from "../../core/tools/aidlc-lib.ts";

const BUN = process.execPath;
const STATE_TOOL = join(
  import.meta.dir, "..", "..", "dist", "claude", ".claude", "tools", "aidlc-state.ts",
);
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) cleanupTestProject(d);
});

function proj(fixture = "state-mid-ideation.md"): string {
  const p = createTestProject();
  dirs.push(p);
  seedAidlcMemory(p);
  seedStateFile(p, join(FIXTURES_DIR, fixture));
  return p;
}

function state(p: string, args: string[]): { status: number; out: string } {
  const res = spawnSync(BUN, [STATE_TOOL, ...args, "--project-dir", p], {
    encoding: "utf-8",
    env: { ...process.env, AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" } as Record<string, string>,
  });
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

const stateText = (p: string): string => readFileSync(seededStateFile(p), "utf-8");

describe("the default is in-session, recorded as an absent field", () => {
  test("a seeded record with no field reads as in-session", () => {
    const p = proj();
    expect(stateText(p)).not.toContain("Approval Routing");
    expect(readApprovalRouting(stateText(p))).toBe("in-session");
    expect(isExternalApprovalRouting(stateText(p))).toBe(false);
  });

  test("null state (no workflow) reads as in-session rather than throwing", () => {
    expect(readApprovalRouting(null)).toBe("in-session");
  });

  test("an unrecognised value is not treated as external", () => {
    // Only the exact token routes gates away from the session; anything else
    // must fall back to the safe interactive behaviour.
    expect(readApprovalRouting("- **Approval Routing**: linear\n")).toBe("in-session");
  });
});

describe("set-approval-routing", () => {
  test("external is written into Runtime State and audited", () => {
    const p = proj();
    const r = state(p, ["set-approval-routing", "external"]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('"approval_routing":"external"');
    expect(stateText(p)).toContain("**Approval Routing**: external");
    expect(isExternalApprovalRouting(stateText(p))).toBe(true);
  }, 30000);

  test("it round-trips back to in-session", () => {
    const p = proj();
    expect(state(p, ["set-approval-routing", "external"]).status).toBe(0);
    expect(state(p, ["set-approval-routing", "in-session"]).status).toBe(0);
    expect(isExternalApprovalRouting(stateText(p))).toBe(false);
  }, 30000);

  test("an invalid value is refused and names the valid ones", () => {
    const p = proj();
    const r = state(p, ["set-approval-routing", "linear"]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("in-session");
    expect(r.out).toContain("external");
    expect(stateText(p)).not.toContain("Approval Routing");
  }, 30000);

  test("a missing value prints usage", () => {
    const r = state(proj(), ["set-approval-routing"]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("Usage: aidlc-state.ts set-approval-routing");
  }, 30000);
});

describe("the autonomous-Construction interlock", () => {
  test("routing cannot be set on an autonomous run", () => {
    // An unattended autonomous run has no human at the gate at all, so routing
    // one to a tracker would describe a handoff that never happens. Refusing
    // here is what lets the stage protocol state, without hedging, that the
    // park-on-handoff branch can never meet park's own autonomy refusal.
    const p = proj();
    // Written directly, the way the suite's other autonomy tests do it: the
    // generic `set` refuses workflow-status fields by design, and the real
    // setter (aidlc-bolt set-autonomy) carries Construction preconditions this
    // test has no interest in.
    writeFileSync(
      seededStateFile(p),
      `${stateText(p)}\n- **Construction Autonomy Mode**: autonomous\n`,
    );
    const r = state(p, ["set-approval-routing", "external"]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("no gate to hand off");
    expect(stateText(p)).not.toContain("**Approval Routing**: external");
  }, 30000);
});

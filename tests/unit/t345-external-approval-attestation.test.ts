// covers: file:tools/aidlc-lib.ts (attested external approval)
//
// t345 - the attested external-approval seam (resolveExternalApproval in
// core/tools/aidlc-lib.ts): the verification a relayed approval must pass
// before it may stand in for the HUMAN_TURN ledger event that the
// human-presence gate normally requires.
//
// WHY THIS EXISTS. The presence gate proves a person acted this turn by
// requiring a HUMAN_TURN, which only a harness UserPromptSubmit hook mints.
// A workflow whose approvals are answered in a tracker has a real human
// acting, just not where the ledger can see it. The pre-existing escape hatch
// (AIDLC_SKIP_HUMAN_PRESENCE_GUARD) is global and records nothing about who
// approved, so relaying through it would delete the anti-fabrication property
// for every gate in the workflow. This seam keeps the property and relocates
// the evidence.
//
// THE PROPERTY UNDER TEST is the separation the environment key creates: an
// interactive session does not hold AIDLC_EXTERNAL_APPROVAL_KEY, so a model in
// one cannot mint an approval no matter what it passes; a relay runner holds
// it, and that is the environment where the operator has chosen to trust the
// relay. The negative cases below are therefore the load-bearing ones - each
// asserts a way the seam REFUSES, because a seam that only proves its happy
// path would not be evidence of anything.
//
// Mechanism: cli. The first block is a pure function over an argv array plus
// one environment variable; the block at the end spawns the shipped
// aidlc-state.ts to prove the seam is reached by the real tool. No LLM, zero
// tokens. (This header said `none` until the spawning block was appended to
// the same file — gen-coverage-registry derives mechanism from the drivers a
// body actually calls, and caught the contradiction.)

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveExternalApproval, externalApprovalOffered } from "../../core/tools/aidlc-lib.ts";

const KEY = "relay-secret-for-tests";
const ENV_NAME = "AIDLC_EXTERNAL_APPROVAL_KEY";

function attestation(overrides: Record<string, string | null> = {}): string[] {
  const base: Record<string, string> = {
    "--approval-source": "linear",
    "--approval-actor": "mike@example.test",
    "--approval-ref": "https://linear.app/acme/issue/ENG-42",
    "--approval-key": KEY,
  };
  const args: string[] = [];
  for (const [flag, fallback] of Object.entries(base)) {
    const override = Object.hasOwn(overrides, flag) ? overrides[flag] : fallback;
    if (override === null) continue; // omit the flag entirely
    args.push(flag, override);
  }
  return args;
}

let previousKey: string | undefined;
beforeEach(() => {
  previousKey = process.env[ENV_NAME];
  process.env[ENV_NAME] = KEY;
});
afterEach(() => {
  if (previousKey === undefined) delete process.env[ENV_NAME];
  else process.env[ENV_NAME] = previousKey;
});

describe("no attestation offered", () => {
  test("plain approve argv resolves to no approval and no error", () => {
    const { approval, error } = resolveExternalApproval(["--user-input", "Approve"]);
    expect(approval).toBeNull();
    expect(error).toBeNull();
  });

  test("externalApprovalOffered distinguishes offered from absent", () => {
    expect(externalApprovalOffered(["--user-input", "Approve"])).toBe(false);
    expect(externalApprovalOffered(["--approval-source", "linear"])).toBe(true);
  });
});

describe("a complete, correctly keyed attestation", () => {
  test("resolves to the three provenance fields", () => {
    const { approval, error } = resolveExternalApproval(attestation());
    expect(error).toBeNull();
    expect(approval).toEqual({
      source: "linear",
      actor: "mike@example.test",
      ref: "https://linear.app/acme/issue/ENG-42",
    });
  });

  test("the key itself is not carried into the resolved approval", () => {
    // The secret must not ride along into something the caller writes to an
    // audit field. Only source/actor/ref are provenance.
    const { approval } = resolveExternalApproval(attestation());
    expect(JSON.stringify(approval)).not.toContain(KEY);
  });
});

describe("refusals - the load-bearing half", () => {
  test("a wrong key is refused even with perfect provenance", () => {
    const { approval, error } = resolveExternalApproval(
      attestation({ "--approval-key": "not-the-key" }),
    );
    expect(approval).toBeNull();
    expect(error).toContain("does not match");
  });

  test("an unset environment key refuses every attestation", () => {
    // This is the interactive-session case: a model that types all four flags
    // still cannot mint an approval, because the session holds no key.
    delete process.env[ENV_NAME];
    const { approval, error } = resolveExternalApproval(attestation());
    expect(approval).toBeNull();
    expect(error).toContain("AIDLC_EXTERNAL_APPROVAL_KEY is not set");
  });

  test("an empty environment key does not authorize an empty --approval-key", () => {
    // Guards the degenerate "" === "" match that a naive equality check allows.
    process.env[ENV_NAME] = "   ";
    const { approval, error } = resolveExternalApproval(
      attestation({ "--approval-key": "" }),
    );
    expect(approval).toBeNull();
    expect(error).not.toBeNull();
  });

  for (const flag of [
    "--approval-source",
    "--approval-actor",
    "--approval-ref",
    "--approval-key",
  ]) {
    test(`a partial attestation missing ${flag} is refused, never ignored`, () => {
      // Refusing rather than ignoring is the point: a typo must not downgrade
      // into "no attestation offered" and silently fall back to a guard the
      // caller believed it had already satisfied.
      const { approval, error } = resolveExternalApproval(attestation({ [flag]: null }));
      expect(approval).toBeNull();
      expect(error).toContain(flag);
    });

    test(`${flag} present with a following flag as its value is refused`, () => {
      const args = attestation({ [flag]: null });
      args.push(flag, "--user-input", "Approve");
      const { approval, error } = resolveExternalApproval(args);
      expect(approval).toBeNull();
      expect(error).toContain(flag);
    });
  }

  test("a newline in a provenance field is refused", () => {
    // These values are written to single-line audit fields; a newline would
    // forge additional fields in the audit record.
    const { approval, error } = resolveExternalApproval(
      attestation({ "--approval-actor": "mike\nApproval Source: forged" }),
    );
    expect(approval).toBeNull();
    expect(error).toContain("line break");
  });

  test("a non-token --approval-source is refused", () => {
    const { approval, error } = resolveExternalApproval(
      attestation({ "--approval-source": "Linear Issues" }),
    );
    expect(approval).toBeNull();
    expect(error).toContain("--approval-source");
  });
});

// --- Wiring: the refusals surface through the shipped CLI -------------------
//
// The cases above prove resolveExternalApproval in isolation. They cannot prove
// the seam is REACHED by the real tool. These spawn `aidlc-state.ts approve`
// and assert the attestation refusals come back through the actual binary.
//
// They work without a fully-produced stage on purpose: the attestation is
// resolved at the TOP of parseApproveFlags, before any state file is read, so a
// malformed relay is refused ahead of the artifact, summary-confirmation, and
// reviewer guards. Seeing THIS error rather than one of those is itself the
// evidence that the seam runs, and runs early.
//
// SCOPE LIMIT, stated plainly: these cover the refusal paths only. A valid
// attestation committing a GATE_APPROVED with its provenance fields is proven
// at unit level and by typecheck, NOT here — reaching a live open gate needs a
// stage whose artifacts, questions file, and summary-confirmation evidence all
// exist, which is a stage run rather than a fixture. The first real relayed
// approval is what exercises that path.

import { spawnSync } from "node:child_process";
import {
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  seedAidlcMemory,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const STATE_TOOL = join(
  import.meta.dir, "..", "..", "dist", "claude", ".claude", "tools", "aidlc-state.ts",
);
const e2eDirs: string[] = [];
afterAll(() => {
  for (const d of e2eDirs) cleanupTestProject(d);
});

function seededProject(): string {
  const p = createTestProject();
  e2eDirs.push(p);
  seedAidlcMemory(p);
  seedStateFile(p, join(FIXTURES_DIR, "state-mid-ideation.md"));
  return p;
}

function runApprove(
  p: string,
  approvalArgs: string[],
  extraEnv: Record<string, string | undefined> = {},
): { status: number; out: string } {
  const res = spawnSync(
    BUN,
    [STATE_TOOL, "approve", "feasibility", "--user-input", "Approve", ...approvalArgs,
      "--project-dir", p],
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
        AIDLC_EXTERNAL_APPROVAL_KEY: KEY,
        ...extraEnv,
      } as Record<string, string>,
    },
  );
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

const FULL = [
  "--approval-source", "linear",
  "--approval-actor", "mike@example.test",
  "--approval-ref", "https://linear.app/acme/issue/ENG-42",
];

describe("wiring - refusals through the shipped aidlc-state.ts", () => {
  test("a partial attestation is refused by the seam, ahead of every stage guard", () => {
    const r = runApprove(seededProject(), ["--approval-source", "linear"]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("must carry every provenance field");
    expect(r.out).toContain("--approval-actor");
    // Proof of ordering: the stage guards never got a say.
    expect(r.out).not.toContain("declared artifacts");
  }, 30000);

  test("a wrong key is refused through the real tool", () => {
    const r = runApprove(seededProject(), [...FULL, "--approval-key", "wrong-key"]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("does not match");
  }, 30000);

  test("without the environment key the real tool refuses the same argv", () => {
    // The interactive-session case: identical flags, no key in the environment.
    const r = runApprove(
      seededProject(),
      [...FULL, "--approval-key", KEY],
      { AIDLC_EXTERNAL_APPROVAL_KEY: undefined },
    );
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("AIDLC_EXTERNAL_APPROVAL_KEY is not set");
  }, 30000);
});

// covers: harness-instrument:sdk-drive-model-resolution
//
// Pins the SDK harness' model-source rule without driving a live Claude turn.
// Model precedence is explicit option > shipped settings > project settings >
// test-only harness default. Shipped settings still own the environment.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDriveSdkSettings } from "../harness/sdk-drive.ts";

const HARNESS_DEFAULT_MODEL = "opus[1m]";
// The env precedence assertions ride on a key the template actually ships.
// They used to ride on ANTHROPIC_DEFAULT_OPUS_MODEL, but the shipped template
// is provider-neutral now (Bedrock is opt-in, written by writeClaudeProvider on
// an amazon-bedrock answer), so no model id ships to contest. The scope default
// is the remaining shipped env key and demonstrates the same ordering.
const SHIPPED_SCOPE_KEY = "AWS_AIDLC_DEFAULT_SCOPE";
const SHIPPED_SCOPE = "classic";

function withTempProject(assertions: (projectDir: string) => void): void {
  const projectDir = mkdtempSync(join(tmpdir(), "aidlc-sdk-model-"));
  try {
    assertions(projectDir);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

function writeProjectSettings(
  projectDir: string,
  settings: Record<string, unknown>,
): void {
  const claudeDir = join(projectDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
}

describe("sdk-drive model resolution", () => {
  test("bare project uses the harness default model and shipped env", () => {
    withTempProject((projectDir) => {
      const resolved = resolveDriveSdkSettings(projectDir);

      expect(resolved.model).toBe(HARNESS_DEFAULT_MODEL);
      expect(resolved.modelSource).toBe("harness-default");
      expect(resolved.env[SHIPPED_SCOPE_KEY]).toBe(SHIPPED_SCOPE);
      // NOTE: provider neutrality is asserted against the shipped FILE in
      // t03-settings-json, not here. `env` merges processEnv() underneath the
      // shipped layer, so a developer shell that exports CLAUDE_CODE_USE_BEDROCK
      // shows up in this merged result and says nothing about what ships.
    });
  });

  test("project settings model beats the harness default while shipped env still wins", () => {
    withTempProject((projectDir) => {
      writeProjectSettings(projectDir, {
        model: "sonnet",
        env: {
          [SHIPPED_SCOPE_KEY]: "project-scope-should-not-win",
        },
      });

      const resolved = resolveDriveSdkSettings(projectDir);

      expect(resolved.model).toBe("sonnet");
      expect(resolved.modelSource).toBe(join(projectDir, ".claude", "settings.json"));
      expect(resolved.env[SHIPPED_SCOPE_KEY]).toBe(SHIPPED_SCOPE);
    });
  });

  test("explicit per-call model/env overrides remain available", () => {
    withTempProject((projectDir) => {
      const resolved = resolveDriveSdkSettings(projectDir, {
        model: "sonnet",
        env: {
          [SHIPPED_SCOPE_KEY]: "explicit-scope",
        },
      });

      expect(resolved.model).toBe("sonnet");
      expect(resolved.modelSource).toBe("option");
      expect(resolved.env[SHIPPED_SCOPE_KEY]).toBe("explicit-scope");
    });
  });
});

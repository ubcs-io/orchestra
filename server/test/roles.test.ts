import { afterEach, describe, expect, it } from "vitest";
import { closeDb, countGlobalRoles, getMeta, getRole, setMeta } from "../src/db";
import {
  buildRoleSystemPrompt,
  DEFAULT_ROLES,
  EXIT_KIND_BY_INTAKE,
  OUTPUT_CONTRACT,
  ROUTING_TEMPLATES,
  seedGlobalRoles,
  TERMINAL_ROLE,
} from "../src/roles";
import { freshDb } from "./helpers";

afterEach(() => closeDb());

const roleKeys = new Set(DEFAULT_ROLES.map((r) => r.key));

describe("role catalog invariants", () => {
  it("every routing-template role exists in the catalog", () => {
    for (const [kind, roles] of Object.entries(ROUTING_TEMPLATES)) {
      for (const role of roles) {
        expect(roleKeys.has(role), `${kind} references unknown role ${role}`).toBe(true);
      }
    }
  });

  it("every intake kind has both a routing template and an exit kind", () => {
    expect(Object.keys(ROUTING_TEMPLATES).sort()).toEqual(Object.keys(EXIT_KIND_BY_INTAKE).sort());
  });

  it("each template ends in the terminal role for its exit kind", () => {
    for (const [kind, roles] of Object.entries(ROUTING_TEMPLATES)) {
      const exitKind = EXIT_KIND_BY_INTAKE[kind as keyof typeof EXIT_KIND_BY_INTAKE];
      const terminal = TERMINAL_ROLE[exitKind];
      expect(roles[roles.length - 1], `${kind} should end in ${terminal}`).toBe(terminal);
    }
  });

  it("role keys are unique", () => {
    expect(roleKeys.size).toBe(DEFAULT_ROLES.length);
  });
});

describe("system prompt", () => {
  it("embeds the shared output contract and the persona", () => {
    const prompt = buildRoleSystemPrompt("You are the tester.");
    expect(prompt).toContain("You are the tester.");
    expect(prompt).toContain(OUTPUT_CONTRACT);
    expect(prompt).toContain("verdict");
  });

  // OUTPUT_CONTRACT is persisted in the DB, so it must stay mechanism-agnostic —
  // whether findings are submitted via a record_findings tool call or a JSON text
  // block is decided at runtime (agent.ts) from live textMode/twoPhase settings,
  // not baked into stored role text. See agent.test.ts's
  // "record_findings availability claim" suite for the runtime-composition coverage.
  it("does not mention record_findings (mechanism-agnostic, decided at runtime)", () => {
    expect(OUTPUT_CONTRACT).not.toMatch(/record_findings/);
  });
});

describe("seedGlobalRoles", () => {
  it("seeds the catalog once and is idempotent", () => {
    freshDb();
    seedGlobalRoles();
    expect(countGlobalRoles()).toBe(DEFAULT_ROLES.length);
    seedGlobalRoles(); // no-op
    expect(countGlobalRoles()).toBe(DEFAULT_ROLES.length);
  });

  // Regression test for the incident that motivated replacing ROLES_SEED_VERSION
  // (a hand-maintained integer) with a content hash: a manually-bumped version
  // number can be "used up" by one reseed and then silently skip a later content
  // change. A hash has no such failure mode — it's recomputed from the actual
  // seed data every boot, so any drift between what's stored and what the code
  // would now produce is detected automatically.
  it("re-seeds automatically when the stored hash doesn't match the current content (no manual bump needed)", () => {
    freshDb();
    seedGlobalRoles();
    const freshHash = getMeta("roles_seed_hash");
    expect(freshHash).toBeTruthy();

    // Simulate "role content changed since last seed" without touching source —
    // corrupt the stored hash the way a stale/mismatched one would look.
    setMeta("roles_seed_hash", "stale-hash-from-before-a-content-change");
    seedGlobalRoles();

    // The mismatch must have triggered a re-seed, restoring the hash that
    // matches current DEFAULT_ROLES/OUTPUT_CONTRACT content.
    expect(getMeta("roles_seed_hash")).toBe(freshHash);
    const role = getRole(null, DEFAULT_ROLES[0].key);
    expect(role?.system_prompt).toBe(buildRoleSystemPrompt(DEFAULT_ROLES[0].persona, DEFAULT_ROLES[0].tools));
  });
});

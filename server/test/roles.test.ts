import { afterEach, describe, expect, it } from "vitest";
import { closeDb, countGlobalRoles } from "../src/db";
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
    expect(prompt).toContain("record_findings");
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
});

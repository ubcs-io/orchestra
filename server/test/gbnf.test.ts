import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import { schemaToGbnf } from "../src/gbnf";
import { RecordFindingsSchema } from "../src/agent";

/** Rule names defined on the left-hand side of a `name ::= …` line. */
function definedRules(grammar: string): Set<string> {
  const defs = new Set<string>();
  for (const line of grammar.split("\n")) {
    const idx = line.indexOf("::=");
    if (idx < 0) continue;
    defs.add(line.slice(0, idx).trim());
  }
  return defs;
}

/**
 * Non-terminal identifiers referenced on the right-hand sides. Strips char
 * classes first (our grammars never put `[`/`]` inside a string literal) then
 * string literals, so the leftover identifiers are exactly rule references.
 */
function referencedRules(grammar: string): Set<string> {
  const refs = new Set<string>();
  for (const line of grammar.split("\n")) {
    const idx = line.indexOf("::=");
    const rhs = idx >= 0 ? line.slice(idx + 3) : line;
    const noClasses = rhs.replace(/\[(?:\\.|[^\]\\])*\]/g, " ");
    const noStrings = noClasses.replace(/"(?:\\.|[^"\\])*"/g, " ");
    for (const m of noStrings.matchAll(/[A-Za-z][A-Za-z0-9-]*/g)) refs.add(m[0]);
  }
  return refs;
}

/** Every referenced rule must be defined — the core internal-consistency check. */
function expectNoDanglingRefs(grammar: string): void {
  const defs = definedRules(grammar);
  const refs = referencedRules(grammar);
  const missing = [...refs].filter((r) => !defs.has(r));
  expect(missing, `undefined rules referenced: ${missing.join(", ")}\n\n${grammar}`).toEqual([]);
}

describe("schemaToGbnf", () => {
  it("produces a self-consistent grammar for RecordFindingsSchema (no dangling refs)", () => {
    const g = schemaToGbnf(RecordFindingsSchema);
    expect(g).toContain("root ::=");
    expect(definedRules(g).has("root")).toBe(true);
    expectNoDanglingRefs(g);
    // The verdict enum literals must appear as quoted GBNF terminals.
    expect(g).toContain('"\\"pass\\""');
    expect(g).toContain('"\\"needs_more\\""');
    // Property keys appear as quoted terminals too.
    expect(g).toContain('"\\"verdict\\""');
    expect(g).toContain('"\\"summary\\""');
    // The shared string primitive is pulled in.
    expect(g).toContain("string ::=");
    expect(g).toContain("ws ::=");
  });

  it("renders a union of string literals as an alternation of quoted terminals", () => {
    const g = schemaToGbnf(Type.Union([Type.Literal("a"), Type.Literal("b"), Type.Literal("c")]));
    expect(g).toContain('"\\"a\\"" | "\\"b\\"" | "\\"c\\""');
    expectNoDanglingRefs(g);
  });

  it("renders a nullable field (X | null) with a `null` alternative", () => {
    const g = schemaToGbnf(Type.Object({ x: Type.Union([Type.String(), Type.Null()]) }));
    expect(g).toContain("null");
    expect(definedRules(g).has("null")).toBe(true);
    expectNoDanglingRefs(g);
  });

  it("handles an object whose properties are ALL optional without dangling refs", () => {
    const g = schemaToGbnf(
      Type.Object({
        a: Type.Optional(Type.String()),
        b: Type.Optional(Type.Number()),
        c: Type.Optional(Type.Boolean()),
      }),
    );
    expect(g).toContain('"\\"a\\""');
    expect(g).toContain('"\\"b\\""');
    expect(g).toContain('"\\"c\\""');
    // An all-optional object must still be able to close immediately: the empty
    // continuation ("") is reachable.
    expect(g).toContain('""');
    expectNoDanglingRefs(g);
  });

  it("handles arrays of objects (the subtasks-style nested shape) without dangling refs", () => {
    const g = schemaToGbnf(
      Type.Object({
        items: Type.Array(
          Type.Object({ id: Type.String(), depends_on: Type.Optional(Type.Array(Type.String())) }),
        ),
      }),
    );
    expect(g).toContain('"\\"items\\""');
    expect(g).toContain('"\\"depends_on\\""');
    expectNoDanglingRefs(g);
  });

  it("distinguishes integer from number primitives", () => {
    const gi = schemaToGbnf(Type.Object({ n: Type.Integer() }));
    expect(gi).toContain("integer ::=");
    const gn = schemaToGbnf(Type.Object({ n: Type.Number() }));
    expect(gn).toContain("number ::=");
  });
});

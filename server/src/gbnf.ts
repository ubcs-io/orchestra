/**
 * JSON-Schema → GBNF converter for the grammar rung of the constrained-decoding
 * ladder (PLANNING/overhaul/02). llama.cpp / llama-server accept a `grammar`
 * (GBNF) param but historically NOT `response_format: json_schema` on every
 * build, so for grammar-only endpoints we convert the same TypeBox schema the
 * other rungs use (RecordFindingsSchema, the router mini-call schemas) into a
 * GBNF grammar the sampler enforces directly.
 *
 * Scope is deliberately the subset Orchestra's schemas actually use — objects
 * (required + optional properties), arrays, strings, integers, numbers,
 * booleans, null, string/number literals, and unions of the above (including
 * `X | null` nullables and enums-as-unions-of-literals). That covers every
 * schema in agent.ts and router.ts. Constructs outside that subset degrade to a
 * permissive JSON-value rule rather than throwing, so an unexpected schema
 * produces a looser-but-valid grammar instead of a hard failure (the caller
 * still validates the result against the TypeBox schema afterward).
 *
 * Optional properties are the one genuinely tricky part of object grammars
 * (comma placement depends on which members are present); this uses a
 * continuation-rule construction (`cont(i, needComma)`) that emits members in a
 * fixed order, allows any subset of the optional ones, and keeps commas correct
 * even when every property is optional — with O(members) shared rules rather
 * than the 2^members blow-up of an inlined alternation.
 */

import type { TSchema } from "@sinclair/typebox";

/** A loosely-typed view of a JSON-Schema node — TypeBox `TSchema` values carry
 *  these standard keywords as ordinary enumerable properties. */
interface SchemaNode {
  type?: string | string[];
  properties?: Record<string, SchemaNode>;
  required?: string[];
  items?: SchemaNode;
  anyOf?: SchemaNode[];
  allOf?: SchemaNode[];
  oneOf?: SchemaNode[];
  enum?: unknown[];
  const?: unknown;
}

/** Escape a raw JSON fragment into a GBNF double-quoted string literal. */
function gbnfLiteral(jsonFragment: string): string {
  const escaped = jsonFragment
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

/** The GBNF literal a JSON value serializes to, e.g. "pass" → `"\"pass\""`,
 *  42 → `"42"`, true → `"true"`. */
function literalTerm(value: unknown): string {
  return gbnfLiteral(JSON.stringify(value));
}

class GbnfBuilder {
  /** name → right-hand side, insertion-ordered so output is stable. */
  private rules = new Map<string, string>();
  /** Which shared primitive rules have been pulled in. */
  private primitives = new Set<string>();
  private counter = 0;
  /** Memoize object continuation rules by `${objId}:${i}:${needComma}`. */
  private contMemo = new Map<string, string>();

  private fresh(prefix: string): string {
    return `${prefix}-${this.counter++}`;
  }

  private usePrimitive(name: string): string {
    this.primitives.add(name);
    return name;
  }

  /** Return a GBNF term (rule name or inline group) matching `schema`'s JSON. */
  term(schema: SchemaNode | undefined): string {
    if (!schema || typeof schema !== "object") return this.usePrimitive("json-value");

    // Literal / const.
    if ("const" in schema && schema.const !== undefined) return literalTerm(schema.const);

    // Enum (a JSON Schema `enum` list of allowed values).
    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
      return `(${schema.enum.map((v) => literalTerm(v)).join(" | ")})`;
    }

    // Union — anyOf / oneOf (TypeBox emits anyOf for Type.Union). A nullable
    // `X | null` and an enum-of-literals both arrive here and fall out naturally.
    const union = schema.anyOf ?? schema.oneOf;
    if (Array.isArray(union) && union.length > 0) {
      if (union.length === 1) return this.term(union[0]);
      return `(${union.map((s) => this.term(s)).join(" | ")})`;
    }

    // `type` may be a single string or an array (e.g. ["string","null"]).
    const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
    if (types.length > 1) {
      return `(${types.map((t) => this.term({ type: t } as SchemaNode)).join(" | ")})`;
    }
    const type = types[0];

    switch (type) {
      case "object":
        return this.objectRule(schema);
      case "array":
        return `("[" ws (${this.term(schema.items)} ("," ws ${this.term(schema.items)})*)? ws "]")`;
      case "string":
        return this.usePrimitive("string");
      case "integer":
        return this.usePrimitive("integer");
      case "number":
        return this.usePrimitive("number");
      case "boolean":
        return this.usePrimitive("boolean");
      case "null":
        return this.usePrimitive("null");
      default:
        return this.usePrimitive("json-value");
    }
  }

  /** Emit a rule for an object schema and return its name. */
  private objectRule(schema: SchemaNode): string {
    const name = this.fresh("obj");
    // Reserve the name up front so a self-referential schema can't loop forever.
    this.rules.set(name, "");
    const props = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    // Required members first, then optionals — order within a JSON object is
    // insignificant, and leading required members make comma handling simplest.
    const keys = Object.keys(props);
    const members = [...keys.filter((k) => required.has(k)), ...keys.filter((k) => !required.has(k))].map(
      (key) => ({
        key,
        required: required.has(key),
        member: `${gbnfLiteral(JSON.stringify(key))} ws ":" ws ${this.term(props[key])}`,
      }),
    );
    const body = this.cont(name, members, 0, false);
    this.rules.set(name, `"{" ws ${body} ws "}"`);
    return name;
  }

  /**
   * Continuation rule for object members[i..]. `needComma` is true once an
   * earlier member has been emitted (so any member here needs a leading comma).
   * Optional members branch into "emit it" vs "skip it"; required members must
   * be emitted. Returns a rule name (or the empty-string literal at the end).
   */
  private cont(
    objId: string,
    members: { required: boolean; member: string }[],
    i: number,
    needComma: boolean,
  ): string {
    if (i >= members.length) return '""';
    const memo = `${objId}:${i}:${needComma}`;
    const existing = this.contMemo.get(memo);
    if (existing) return existing;

    const name = this.fresh("cont");
    this.contMemo.set(memo, name);
    this.rules.set(name, ""); // reserve

    const m = members[i]!;
    const sep = needComma ? '"," ws ' : "";
    const emit = `${sep}${m.member} ws ${this.cont(objId, members, i + 1, true)}`;
    if (m.required) {
      this.rules.set(name, emit);
    } else {
      const skip = this.cont(objId, members, i + 1, needComma);
      this.rules.set(name, `(${emit}) | ${skip}`);
    }
    return name;
  }

  /** Primitive rule definitions, emitted only for those actually referenced. */
  private primitiveDefs(): string[] {
    const defs: Record<string, string> = {
      ws: "ws ::= [ \\t\\n]*",
      string:
        'string ::= "\\"" ( [^"\\\\] | "\\\\" ["\\\\/bfnrt] | "\\\\u" [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] )* "\\""',
      integer: 'integer ::= "-"? ("0" | [1-9] [0-9]*)',
      number: 'number ::= "-"? ("0" | [1-9] [0-9]*) ("." [0-9]+)? ([eE] [-+]? [0-9]+)?',
      boolean: 'boolean ::= "true" | "false"',
      null: 'null ::= "null"',
      "json-value": "json-value ::= string | number | boolean | null",
    };
    // `ws` is referenced by every object/array term, so always include it.
    this.primitives.add("ws");
    // json-value pulls in the others transitively.
    if (this.primitives.has("json-value")) {
      for (const p of ["string", "number", "boolean", "null"]) this.primitives.add(p);
    }
    return [...this.primitives].filter((p) => defs[p]).map((p) => defs[p]!);
  }

  build(schema: SchemaNode): string {
    const rootTerm = this.term(schema);
    const lines = [`root ::= ${rootTerm}`];
    for (const [name, rhs] of this.rules) lines.push(`${name} ::= ${rhs}`);
    lines.push(...this.primitiveDefs());
    return lines.join("\n") + "\n";
  }
}

/**
 * Convert a TypeBox/JSON schema into a GBNF grammar string whose only valid
 * outputs are JSON documents conforming to the schema's structure. Total
 * function — any schema produces a grammar (unsupported nodes fall back to a
 * permissive JSON value), so callers never have to guard the call.
 */
export function schemaToGbnf(schema: TSchema): string {
  return new GbnfBuilder().build(schema as unknown as SchemaNode);
}

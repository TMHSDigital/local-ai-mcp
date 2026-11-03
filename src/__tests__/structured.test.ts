import { describe, expect, it } from "vitest";
import type { CompletionResult } from "../providers/types.js";
import { validateStructured } from "../tools/delegation.js";

const result = (parsed: unknown) => ({ text: JSON.stringify(parsed), parsed }) as unknown as CompletionResult;

describe("validateStructured", () => {
  it("validates repeatedly against a schema with an $id", () => {
    const format = {
      type: "json_schema" as const,
      schema: { $id: "https://example.com/s", type: "object", required: ["a"] },
    };
    for (let i = 0; i < 3; i++) {
      expect(validateStructured(result({ a: 1 }), format)).toMatchObject({ schemaValid: true });
    }
    const bad = validateStructured(result({}), format) as CompletionResult & { schemaErrors?: string[] };
    expect(bad).toMatchObject({ schemaValid: false });
    expect(bad.schemaErrors?.[0]).toMatch(/required/);
  });

  it("reports an invalid schema instead of throwing", () => {
    const r = validateStructured(result({}), { type: "json_schema", schema: { type: 42 } as never });
    expect(r).toMatchObject({ schemaValid: false });
    expect((r as { schemaErrors?: string[] }).schemaErrors?.[0]).toMatch(/invalid schema/);
  });
});

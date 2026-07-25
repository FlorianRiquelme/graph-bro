import { describe, expect, it } from "vitest";
import {
  extractTokenPaths,
  renderPromptTemplate,
  UnresolvedPromptTokenError,
} from "../../src/engine/prompt-template.js";

describe("engine: prompt-template (R1/R3/R4/R5)", () => {
  it("resolves a single token against the input snapshot", () => {
    expect(renderPromptTemplate("read {{ item }}", { item: "one" }, "reader")).toBe("read one");
  });

  it("Covers AE5: a template with no tokens returns byte-identical to the input string", () => {
    const template = "read the batch and report back";
    expect(renderPromptTemplate(template, { item: "one" }, "reader")).toBe(template);
  });

  it("resolves a dotted path (R3)", () => {
    expect(renderPromptTemplate("{{ item.id }}", { item: { id: 42 } }, "reader")).toBe("42");
  });

  it("serializes a number scalar verbatim, no quotes (R4)", () => {
    expect(renderPromptTemplate("{{ n }}", { n: 5 }, "reader")).toBe("5");
  });

  it("serializes a boolean scalar verbatim, no quotes (R4)", () => {
    expect(renderPromptTemplate("{{ b }}", { b: true }, "reader")).toBe("true");
  });

  it("serializes null verbatim, no quotes (R4)", () => {
    expect(renderPromptTemplate("{{ v }}", { v: null }, "reader")).toBe("null");
  });

  it("serializes an object value as pretty-printed 2-space JSON (R4)", () => {
    const result = renderPromptTemplate("{{ obj }}", { obj: { a: 1, b: 2 } }, "reader");
    expect(result).toBe(JSON.stringify({ a: 1, b: 2 }, null, 2));
  });

  it("serializes an array value as pretty-printed 2-space JSON (R4)", () => {
    const result = renderPromptTemplate("{{ arr }}", { arr: [1, 2, 3] }, "reader");
    expect(result).toBe(JSON.stringify([1, 2, 3], null, 2));
  });

  it("present falsy values are values, not absence: empty string", () => {
    expect(renderPromptTemplate("[{{ s }}]", { s: "" }, "reader")).toBe("[]");
  });

  it("present falsy values are values, not absence: zero", () => {
    expect(renderPromptTemplate("{{ n }}", { n: 0 }, "reader")).toBe("0");
  });

  it("present falsy values are values, not absence: false", () => {
    expect(renderPromptTemplate("{{ b }}", { b: false }, "reader")).toBe("false");
  });

  it("present falsy values are values, not absence: empty array", () => {
    expect(renderPromptTemplate("{{ arr }}", { arr: [] }, "reader")).toBe("[]");
  });

  it("Covers AE3 (resolver side): a missing key throws naming node + token", () => {
    expect(() => renderPromptTemplate("{{ missing }}", {}, "reader")).toThrow(UnresolvedPromptTokenError);
    try {
      renderPromptTemplate("{{ missing }}", {}, "reader");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnresolvedPromptTokenError);
      expect((err as Error).message).toContain("reader");
      expect((err as Error).message).toContain("{{ missing }}");
    }
  });

  it("Covers AE3 (resolver side): descent into a non-object throws", () => {
    expect(() => renderPromptTemplate("{{ a.b }}", { a: "x" }, "reader")).toThrow(UnresolvedPromptTokenError);
  });

  it("Covers AE3 (resolver side): a literally-undefined value throws", () => {
    expect(() => renderPromptTemplate("{{ v }}", { v: undefined }, "reader")).toThrow(UnresolvedPromptTokenError);
  });

  it("resolves multiple tokens in one template in a single pass", () => {
    const result = renderPromptTemplate("{{ a }} and {{ b }}", { a: "one", b: "two" }, "reader");
    expect(result).toBe("one and two");
  });

  it("(KTD-6) single-pass: a substituted value containing a token is not re-interpreted", () => {
    const result = renderPromptTemplate("{{ item }}", { item: "{{ other }}" }, "reader");
    expect(result).toBe("{{ other }}");
  });

  it("trims whitespace inside braces before path resolution", () => {
    expect(renderPromptTemplate("{{  item.id  }}", { item: { id: 42 } }, "reader")).toBe("42");
  });

  describe("escape grammar (graph-bro#8)", () => {
    it("a backslash-escaped token emits the literal delimiters instead of substituting", () => {
      expect(renderPromptTemplate("\\{{ item }}", { item: "one" }, "reader")).toBe("{{ item }}");
    });

    it("an escaped token whose path is absent does not throw — it is text, not a token", () => {
      expect(renderPromptTemplate("\\{{ missing }}", {}, "reader")).toBe("{{ missing }}");
    });

    it("preserves inner spacing verbatim when unescaping", () => {
      expect(renderPromptTemplate("\\{{  spaced.path  }}", {}, "reader")).toBe("{{  spaced.path  }}");
    });

    it("resolves a real token and unescapes a literal one in the same single pass", () => {
      const result = renderPromptTemplate("\\{{ item }} is literal, {{ item }} is not", { item: "one" }, "reader");
      expect(result).toBe("{{ item }} is literal, one is not");
    });

    it("a bare closing delimiter needs no escape — only the opening one is significant", () => {
      expect(renderPromptTemplate("closes }} alone", {}, "reader")).toBe("closes }} alone");
    });

    it("(KTD-6) single-pass: unescaped output is not re-scanned, so it stays literal", () => {
      expect(renderPromptTemplate("\\{{ a }}", { a: "x" }, "reader")).toBe("{{ a }}");
    });

    it("pins the escape's one limitation: a literal backslash cannot precede a live token", () => {
      // `\\{{ a }}` unescapes rather than emitting a backslash then substituting.
      // Documented in renderPromptTemplate's docstring; no consumer needs it today.
      expect(renderPromptTemplate("\\\\{{ a }}", { a: "x" }, "reader")).toBe("\\{{ a }}");
    });
  });

  describe("extractTokenPaths (graph-bro#7's grammar seam)", () => {
    it("returns the dotted paths of every live token, in order", () => {
      expect(extractTokenPaths("{{ a }} then {{ b.c }}")).toEqual(["a", "b.c"]);
    });

    it("trims whitespace, matching what the renderer resolves", () => {
      expect(extractTokenPaths("{{  a.b  }}")).toEqual(["a.b"]);
    });

    it("skips escaped tokens — the lint must not flag literal text", () => {
      expect(extractTokenPaths("\\{{ literal }} {{ live }}")).toEqual(["live"]);
    });

    it("returns empty for a template with no tokens", () => {
      expect(extractTokenPaths("no tokens here")).toEqual([]);
    });

    it("is repeatable — the shared global pattern carries no lastIndex between calls", () => {
      expect(extractTokenPaths("{{ a }}")).toEqual(["a"]);
      expect(extractTokenPaths("{{ a }}")).toEqual(["a"]);
    });
  });
});

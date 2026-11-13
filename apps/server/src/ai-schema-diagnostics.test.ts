import { describe, expect, it, vi } from "vitest";
import { createSchemaDiagnosticFetch, type AiSchemaDiagnostic } from "./ai-schema-diagnostics";

describe("operator-only safe schema hints", () => {
  it("classifies provider schema errors without exposing any response or request text", async () => {
    const privateText = "private-key-and-card-1-hearts-10";
    const body = JSON.stringify({ error: { code: 400, message: `Invalid response_format ${privateText}`, metadata: { raw: JSON.stringify({
      error: { code: 400, status: "INVALID_ARGUMENT", message: `response_schema.properties[groups].items.max_items: unsupported; ${privateText}` }
    }) } } });
    const emit = vi.fn();
    const fetcher = vi.fn<typeof fetch>(async () => new Response(body, { status: 400 }));
    const wrapper = createSchemaDiagnosticFetch(fetcher, emit);
    const init = { method: "POST", body: privateText, headers: { Authorization: `Bearer ${privateText}` } };
    const response = await wrapper("https://openrouter.ai/api/v1/chat/completions", init);
    expect(fetcher).toHaveBeenCalledWith("https://openrouter.ai/api/v1/chat/completions", init);
    expect(await response.text()).toBe(body);
    expect(emit).toHaveBeenCalledExactlyOnceWith({
      type: "ai-schema-diagnostic", status: 400, errorCode: 400,
      keywords: ["maxItems", "response_schema", "response_format"],
      paths: ["response_schema.properties.groups.items.maxItems"]
    });
    expect(JSON.stringify(emit.mock.calls)).not.toContain(privateText);
  });

  it("never emits arbitrary error codes or paths containing unknown property names", async () => {
    const secret = "secret_provider_token";
    const emit = vi.fn();
    const body = { error: { code: secret, message: `response_schema.properties[${secret}].type invalid nullable enum` } };
    const wrapper = createSchemaDiagnosticFetch(async () => new Response(JSON.stringify(body), { status: 400 }), emit);
    await wrapper("https://openrouter.ai/api/v1/chat/completions");
    expect(emit.mock.calls[0]![0]).toMatchObject({ status: 400, paths: [], keywords: ["enum", "type", "nullable", "response_schema"] });
    expect(emit.mock.calls[0]![0]).not.toHaveProperty("errorCode");
    expect(JSON.stringify(emit.mock.calls)).not.toContain(secret);
  });

  it("allows known provider enum codes without copying a message", async () => {
    const emit = vi.fn();
    const wrapper = createSchemaDiagnosticFetch(async () => new Response(JSON.stringify({
      error: { code: "INVALID_ARGUMENT", message: "thinking reasoning max_tokens rejected" }
    }), { status: 400 }), emit);
    await wrapper("https://openrouter.ai/api/v1/chat/completions");
    expect(emit).toHaveBeenCalledExactlyOnceWith({
      type: "ai-schema-diagnostic", status: 400, errorCode: "INVALID_ARGUMENT",
      keywords: ["reasoning", "thinking", "max_tokens"], paths: []
    });
  });

  it("does not inspect or emit successful provider output", async () => {
    const emit = vi.fn();
    const original = new Response("private successful model output");
    const wrapper = createSchemaDiagnosticFetch(async () => original, emit);
    const response = await wrapper("https://openrouter.ai/api/v1/chat/completions");
    expect(response).toBe(original);
    expect(emit).not.toHaveBeenCalled();
    expect(await response.text()).toBe("private successful model output");
  });

  it("does not classify or reveal an unparseable provider body", async () => {
    const emit = vi.fn();
    const wrapper = createSchemaDiagnosticFetch(async () => new Response("private non-JSON text", { status: 500 }), emit);
    await wrapper("https://openrouter.ai/api/v1/chat/completions");
    expect(emit).toHaveBeenCalledExactlyOnceWith({ type: "ai-schema-diagnostic", status: 500, keywords: [], paths: [], unreadable: true });
  });

  it("bounds the error body and leaves the original provider response readable", async () => {
    const emit = vi.fn();
    const raw = JSON.stringify({ error: { message: "private".repeat(5_000) } });
    const wrapper = createSchemaDiagnosticFetch(async () => new Response(raw, { status: 500 }), emit);
    const response = await wrapper("https://openrouter.ai/api/v1/chat/completions");
    expect(emit).toHaveBeenCalledExactlyOnceWith({ type: "ai-schema-diagnostic", status: 500, keywords: [], paths: [], truncated: true });
    expect(await response.text()).toBe(raw);
  });

  it("does not change provider control flow if diagnostic output itself fails", async () => {
    const original = new Response(JSON.stringify({ error: { code: 400, message: "enum" } }), { status: 400 });
    const wrapper = createSchemaDiagnosticFetch(async () => original, () => { throw new Error("output failed"); });
    expect(await wrapper("https://openrouter.ai/api/v1/chat/completions")).toBe(original);
  });

  it("bounds diagnostic reading to one second even if an error body stalls", async () => {
    vi.useFakeTimers();
    try {
      const emitted: AiSchemaDiagnostic[] = [];
      const stream = new ReadableStream<Uint8Array>({ start() {} });
      const wrapper = createSchemaDiagnosticFetch(async () => new Response(stream, { status: 503 }), (value) => emitted.push(value));
      const pending = wrapper("https://openrouter.ai/api/v1/chat/completions");
      await vi.advanceTimersByTimeAsync(1_000);
      const response = await pending;
      expect(response.status).toBe(503);
      expect(emitted).toEqual([{ type: "ai-schema-diagnostic", status: 503, keywords: [], paths: [], unreadable: true }]);
      await response.body?.cancel();
    } finally { vi.useRealTimers(); }
  });
});

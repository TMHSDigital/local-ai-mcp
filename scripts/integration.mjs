// Integration suite against REAL runtimes (see .github/workflows/integration.yml).
// Exercises the built server through an MCP client, exactly as an agent would.
// Expects Ollama on :11434 and llama-server (with --embeddings) on :8080.
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../dist/config.js";
import { createServer } from "../dist/server.js";

const CHAT = process.env.CHAT_MODEL ?? "smollm2:135m";
const EMBED = process.env.EMBED_MODEL ?? "all-minilm:22m";

const { server } = createServer(loadConfig({ ...process.env, LOCAL_AI_CACHE_TTL_MS: "0" }));
const client = new Client({ name: "integration", version: "0" });
const [ct, st] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(st), client.connect(ct)]);

async function call(name, args = {}, opts) {
  const res = await client.callTool({ name, arguments: args }, undefined, opts);
  if (res.isError) throw new Error(`${name}: ${res.content[0].text}`);
  return res.structuredContent;
}

const steps = [];
async function step(label, fn) {
  const t = Date.now();
  try {
    await fn();
    steps.push(`ok   ${label} (${Date.now() - t} ms)`);
  } catch (err) {
    steps.push(`FAIL ${label}: ${err.message}`);
    throw err;
  }
}

try {
  await step("both runtimes detected", async () => {
    const { providers } = await call("list_providers");
    const live = providers.filter((p) => p.live).map((p) => p.provider);
    assert.ok(live.includes("ollama"), `live: ${live}`);
    assert.ok(live.includes("llamacpp"), `live: ${live}`);
  });

  await step("ollama pull with progress", async () => {
    for (const model of [CHAT, EMBED]) {
      let ticks = 0;
      await call("pull_model", { model, provider: "ollama" }, { onprogress: () => ticks++, timeout: 600000 });
      assert.ok(ticks > 0, "expected progress notifications");
    }
  });

  await step("list_models / model_info architecture", async () => {
    const { models } = await call("list_models", { provider: "ollama" });
    assert.ok(models.ollama.some((m) => m.id.startsWith(CHAT.split(":")[0])));
    const { info } = await call("model_info", { model: CHAT, provider: "ollama" });
    assert.ok(info.ollama.architecture?.layers > 0, "architecture parsed");
  });

  await step("ensure_model loads", async () => {
    const r = await call("ensure_model", { model: CHAT, provider: "ollama", contextLength: 2048 });
    assert.equal(r.ready, true);
    const { loaded } = await call("list_loaded", { provider: "ollama" });
    assert.ok(loaded.ollama.some((m) => m.id === CHAT));
  });

  await step("ollama complete (non-stream, JSON schema)", async () => {
    const r = await call("complete", {
      model: CHAT,
      prompt: "Reply with a JSON object with key ok set to true.",
      responseFormat: { type: "json_schema", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } },
      maxTokens: 32,
      stream: false,
    });
    assert.equal(r.provider, "ollama");
    assert.equal(r.local, true);
    assert.ok(r.completionTokens > 0);
    assert.ok(r.parsed !== undefined, `parsed missing; text=${r.text}`);
  });

  await step("ollama complete (streamed, routed implicitly)", async () => {
    let chunks = 0;
    const r = await call("complete", { model: CHAT, prompt: "Count to five.", maxTokens: 24 }, { onprogress: () => chunks++ });
    assert.equal(r.streamed, true);
    assert.ok(chunks > 0);
    assert.ok(r.timings?.ttftMs >= 0);
  });

  await step("ollama embed batch", async () => {
    const r = await call("embed", { model: EMBED, input: ["a", "b", "c"], provider: "ollama" });
    assert.equal(r.embeddings.length, 3);
    assert.ok(r.dimensions > 0);
  });

  await step("llama.cpp list / loaded / complete / embed", async () => {
    const { models } = await call("list_models", { provider: "llamacpp" });
    const id = models.llamacpp[0].id;
    const { loaded } = await call("list_loaded", { provider: "llamacpp" });
    assert.ok(loaded.llamacpp.length > 0);
    const r = await call("complete", { model: id, prompt: "Hi", maxTokens: 8, provider: "llamacpp" });
    assert.ok(r.text.length > 0);
    assert.ok(r.completionTokens > 0, "streamed usage reported");
    const e = await call("embed", { model: id, input: ["x", "y"], provider: "llamacpp" });
    assert.equal(e.embeddings.length, 2);
  });

  await step("benchmark", async () => {
    const { results } = await call("benchmark", { model: CHAT, provider: "ollama", runs: 1, maxTokens: 16 });
    assert.ok(results[0].genTokensPerSec.median > 0);
  });

  await step("fit_check uses provider size", async () => {
    const r = await call("fit_check", { model: CHAT, provider: "ollama" });
    assert.equal(r.sizeSource, "provider:ollama");
    assert.equal(r.kvEstimate, "architecture");
  });

  await step("unload + remove", async () => {
    await call("unload_model", { model: CHAT, provider: "ollama" });
    const r = await call("remove_model", { model: EMBED, provider: "ollama", confirm: true });
    assert.equal(r.remove.removed, true);
  });
} finally {
  console.log(steps.join("\n"));
  await client.close();
}

// Optional real CLI acceptance against local model fixtures and temporary homes.
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const project = fileURLToPath(new URL("..", import.meta.url));
async function main() {
  const root = await mkdtemp(join(tmpdir(), "studio-real-plugin-turns-"));
  const managedModule = join(root, "managed.cjs");
  await build({
    stdin: { contents: "export { ManagedProcessScope } from './packages/server/src/modules/studio/services/processes/managed'", resolveDir: project, loader: "ts" },
    bundle: true,
    platform: "node",
    target: "node24.22.1",
    format: "cjs",
    outfile: managedModule,
    logLevel: "silent"
  });
  const { ManagedProcessScope } = createRequire(import.meta.url)(managedModule);
  let calls = 0;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    if (!req.url?.includes("responses") && !req.url?.includes("messages")) {
      res.writeHead(404);
      res.end("{}");
      return;
    }
    calls++;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const send = (type, data) => res.write(`event: ${type}
data: ${JSON.stringify({ type, ...data })}

`);
    const id = `response-${calls}`, messageId = `message-${calls}`, text = `Native fixture answer ${calls}`;
    if (req.url.includes("responses")) {
      const item = { id: messageId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
      send("response.created", { response: { id, object: "response", status: "in_progress", output: [] } });
      send("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
      send("response.content_part.added", { item_id: messageId, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      send("response.output_text.delta", { item_id: messageId, output_index: 0, content_index: 0, delta: text });
      send("response.output_text.done", { item_id: messageId, output_index: 0, content_index: 0, text });
      send("response.output_item.done", { output_index: 0, item });
      send("response.completed", { response: { id, object: "response", status: "completed", output: [item], usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
    } else {
      send("message_start", { message: { id: messageId, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0 } } });
      send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      send("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
      send("content_block_stop", { index: 0 });
      send("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
      send("message_stop", {});
    }
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const vendor of ["codex", "qwen-code"]) {
      const home = join(root, vendor);
      await mkdir(home);
      const controller = new AbortController(), scope = new ManagedProcessScope(controller.signal, () => {
      });
      let runtime;
      try {
        const config = { cwd: home, env: { HOME: home, USERPROFILE: home } };
        if (vendor === "codex") {
          await writeFile(join(home, "config.toml"), `model = "fixture-model"
model_provider = "fixture"
[model_providers.fixture]
name = "Local fixture"
base_url = "${base}/v1"
wire_api = "responses"
requires_openai_auth = false
`, { mode: 384 });
          config.command = process.env.STUDIO_CODEX_COMMAND || "codex";
          config.env.CODEX_HOME = home;
          config.approvalPolicy = "never";
          config.sandbox = "read-only";
        } else {
          config.command = process.env.STUDIO_QWEN_COMMAND || "qwen";
          config.args = ["--auth-type", "anthropic", "--model", "fixture-model"];
          Object.assign(config.env, { QWEN_HOME: home, QWEN_RUNTIME_DIR: join(home, "runtime"), ANTHROPIC_API_KEY: "fixture-only", ANTHROPIC_BASE_URL: base, ANTHROPIC_MODEL: "fixture-model" });
          await writeFile(join(home, "settings.json"), JSON.stringify({ security: { auth: { selectedType: "anthropic" } }, model: { name: "fixture-model" }, modelProviders: { anthropic: [{ id: "fixture-model", envKey: "ANTHROPIC_API_KEY", baseUrl: base, generationConfig: { maxOutputTokens: 256 } }] } }), { mode: 384 });
        }
        const plugin = createRequire(import.meta.url)(join(project, "dist/plugins", vendor, "dist/index.cjs"));
        let definition;
        plugin.apply({ agents: { register(value) {
          definition = value;
        } } });
        runtime = await definition.create({ instanceId: "acceptance", mode: "global", configRevision: 1, config }, { signal: controller.signal, processes: scope.api });
        let checkpoint;
        for (let turn = 0; turn < 2; turn++) {
          const run = new AbortController(), timer = setTimeout(() => run.abort(), 2e4);
          try {
            const handle = await runtime.run({ content: [{ type: "text", text: `Respond with a brief greeting. Turn ${turn}.` }] }, { signal: run.signal });
            const output = [];
            const [result] = await Promise.all([handle.result, (async () => {
              for await (const event of handle.events) output.push(event);
            })()]);
            if (turn && JSON.stringify(result.checkpoint) !== JSON.stringify(checkpoint)) throw new Error(vendor + " changed native session between turns");
            checkpoint = result.checkpoint;
            console.log(JSON.stringify({ vendor, turn: turn + 1, status: result.status, events: output.length, sameNativeSession: turn ? true : void 0 }));
            if (result.status !== "completed" || !output.some((event) => ["message.delta", "message.snapshot"].includes(event.type) && event.text.includes("Native fixture answer"))) throw new Error(`${vendor} real turn did not complete`);
          } finally {
            clearTimeout(timer);
          }
        }
      } finally {
        await runtime?.dispose("Acceptance finished");
        controller.abort();
        await scope.close();
      }
    }
    console.log(JSON.stringify({ passed: true, localModelRequests: calls, remoteProvider: false, accountLogin: false }));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

// Optional real CLI acceptance against local model fixtures and temporary homes.
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import sharp from "sharp";
const project = fileURLToPath(new URL("..", import.meta.url));
async function main() {
  const root = await mkdtemp(join(tmpdir(), "studio-real-plugin-turns-"));
  const mcpFixture = join(root, "mcp-fixture.cjs");
  await writeFile(mcpFixture, String.raw`const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  require('node:fs').appendFileSync(process.env.MCP_TRACE_FILE, JSON.stringify({ method: message.method, tool: process.env.MCP_TOOL }) + '\n');
  if (message.id === undefined) return;
  const result = message.method === 'initialize' ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'continuity-fixture', version: '1.0.0' } }
    : message.method === 'tools/list' ? { tools: [{ name: process.env.MCP_TOOL, description: 'Local continuity acceptance fixture', inputSchema: { type: 'object', properties: {} } }] }
    : message.method === 'prompts/list' ? { prompts: [] }
    : message.method === 'resources/list' ? { resources: [] }
    : message.method === 'resources/templates/list' ? { resourceTemplates: [] }
    : message.method === 'tools/call' ? { content: [{ type: 'text', text: 'fixture' }] } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
});`);
  const mcpServers = revision => ({ continuity: { command: process.execPath, args: [mcpFixture], env: { ELECTRON_RUN_AS_NODE: '1', MCP_TRACE_FILE: join(root, 'mcp-trace.jsonl'), MCP_TOOL: `continuity_v${revision}` } } });
  const managedModule = join(root, "managed.cjs");
  await build({
    stdin: { contents: `export { AgentCoordinator } from './packages/server/src/modules/studio/services/agents/coordinator';
export { AgentRegistry } from './packages/server/src/modules/studio/services/agents/registry';
export { PluginEventBus } from './packages/server/src/modules/studio/services/events/plugin-events';
export { AgentExecutionStore } from './packages/server/src/modules/studio/repositories/agent-execution-store';
export { ManagedProcessScope } from './packages/server/src/modules/studio/services/processes/managed';
export { PluginModelGateways } from './packages/server/src/modules/studio/services/models/gateway';
export { PluginModelCallStore } from './packages/server/src/modules/studio/repositories/plugin-model-call-store';
export { OpenAIResponsesModelClient } from './packages/ekko-agent/src/model/providers/openai-responses';
export { OpenAICompatibleModelClient } from './packages/ekko-agent/src/model/providers/openai-compatible';
export { translatedNativeRequest } from './packages/server/src/modules/studio/services/models/native-adapter';
export { AnthropicMessagesModelClient } from './packages/ekko-agent/src/model/providers/anthropic';`, resolveDir: project, loader: "ts" },
    bundle: true,
    platform: "node",
    target: "node24.22.1",
    format: "cjs",
    outfile: managedModule,
    logLevel: "silent"
  });
  const { AgentCoordinator, AgentRegistry, PluginEventBus, AgentExecutionStore, ManagedProcessScope, PluginModelGateways, PluginModelCallStore, OpenAIResponsesModelClient, AnthropicMessagesModelClient, OpenAICompatibleModelClient, translatedNativeRequest } = createRequire(import.meta.url)(managedModule);
  let calls = 0;
  let activeTarget = 'native', activeVendor, searchIssued = false;
  const requests = [];
  const imageData = (await sharp({ create: { width: 32, height: 32, channels: 3, background: 'red' } }).png().toBuffer()).toString('base64');
  const hasImage = value => value && typeof value === 'object' && (['input_image', 'image', 'image_url'].includes(value.type) || Object.values(value).some(hasImage));
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    if (!req.url?.includes("responses") && !req.url?.includes("messages") && !req.url?.includes('chat/completions')) {
      res.writeHead(404);
      res.end("{}");
      return;
    }
    calls++; requests.push(body);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const send = (type, data) => res.write(`event: ${type}
data: ${JSON.stringify({ type, ...data })}

`);
    const id = `response-${calls}`, messageId = `message-${calls}`, text = `Native fixture answer ${calls}`;
    const searchTool = body.tools?.find(tool => (tool.name || tool.function?.name) === 'tool_search');
    if (activeVendor === 'qwen-code' && searchTool && !searchIssued) {
      searchIssued = true;
      const toolId = `search-${calls}`, args = JSON.stringify({ query: 'continuity', max_results: 5 });
      if (req.url.includes('responses')) {
        const item = { type: 'function_call', id: toolId, call_id: toolId, name: 'tool_search', arguments: args };
        send('response.created', { response: { id, object: 'response', status: 'in_progress', output: [] } });
        send('response.output_item.added', { output_index: 0, item: { ...item, arguments: '' } });
        send('response.function_call_arguments.delta', { item_id: toolId, output_index: 0, delta: args });
        send('response.function_call_arguments.done', { item_id: toolId, output_index: 0, arguments: args });
        send('response.output_item.done', { output_index: 0, item });
        send('response.completed', { response: { id, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 } } });
      } else if (req.url.includes('chat/completions')) {
        res.write(`data: ${JSON.stringify({ id, choices: [{ delta: { tool_calls: [{ index: 0, id: toolId, type: 'function', function: { name: 'tool_search', arguments: args } }] } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id, choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 5 } })}\n\n`);
        res.write('data: [DONE]\n\n');
      } else {
        send('message_start', { message: { id: messageId, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0 } } });
        send('content_block_start', { index: 0, content_block: { type: 'tool_use', id: toolId, name: 'tool_search', input: {} } });
        send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: args } });
        send('content_block_stop', { index: 0 });
        send('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } });
        send('message_stop', {});
      }
      res.end(); return;
    }
    if (req.url.includes("responses")) {
      const item = { id: messageId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
      send("response.created", { response: { id, object: "response", status: "in_progress", output: [] } });
      send("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
      send("response.content_part.added", { item_id: messageId, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      send("response.output_text.delta", { item_id: messageId, output_index: 0, content_index: 0, delta: text });
      send("response.output_text.done", { item_id: messageId, output_index: 0, content_index: 0, text });
      send("response.output_item.done", { output_index: 0, item });
      send("response.completed", { response: { id, object: "response", status: "completed", output: [item], usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
    } else if (req.url.includes('chat/completions')) {
      res.write(`data: ${JSON.stringify({ id, choices: [{ delta: { content: text } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id, choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 5 } })}\n\n`);
      res.write('data: [DONE]\n\n');
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
  const db = new DatabaseSync(':memory:'), modelStore = new PluginModelCallStore(db), executionStore = new AgentExecutionStore(db), state = executionStore.state;
  const gateways = new PluginModelGateways({ store: modelStore, state, authorize() {}, resolve: async (_profile, publicModel, protocol) => {
    const Client = activeTarget === 'chat' ? OpenAICompatibleModelClient
      : (activeTarget === 'other' ? protocol !== 'responses' : protocol === 'responses') ? OpenAIResponsesModelClient : AnthropicMessagesModelClient;
    const client = new Client({ id: 'fixture', type: 'custom', defaultModel: 'fixture-model', baseUrl: `${base}/v1`, apiKey: 'host-only-fixture-key' });
    return { images: true, transport: activeTarget === 'native' ? 'native' : 'translated',
      request: (body, signal, sessionId) => activeTarget === 'native' ? client.nativeRequest(body, { model: 'fixture-model', messages: [], signal })
        : translatedNativeRequest({ client, protocol, model: 'fixture-model', publicModel, body, signal, sessionId, authorize() {} }),
      record: input => input.onRecorded?.({ ...input.usage, isEstimated: input.isEstimated }) };
  } });
  try {
    for (const [mode, target] of [['global', 'native'], ['scoped', 'native'], ['scoped', 'chat'], ['scoped', 'other'], ['scoped', 'switch']]) for (const vendor of ["codex", "qwen-code"]) {
      activeTarget = target === 'switch' ? 'native' : target;
      activeVendor = vendor;
      const home = join(root, `${vendor}-${mode}-${target}`);
      await mkdir(home);
      const controller = new AbortController(), scope = new ManagedProcessScope(controller.signal, () => {
      });
      let coordinator, events;
      try {
        const config = { cwd: home, mcpServers: mcpServers(1), env: { HOME: home, USERPROFILE: home } };
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
          await writeFile(join(home, "settings.json"), JSON.stringify({ security: { auth: { selectedType: "anthropic" } }, model: { name: "fixture-model" }, modelProviders: { anthropic: [{ id: "fixture-model", envKey: "ANTHROPIC_API_KEY", baseUrl: base, generationConfig: { maxOutputTokens: 256, modalities: { image: true } } }] } }), { mode: 384 });
        }
        const plugin = createRequire(import.meta.url)(join(project, "dist/plugins", vendor, "dist/index.cjs"));
        let definition;
        plugin.apply({ agents: { register(value) {
          definition = value;
        } } });
        if (mode === 'scoped') { config.args = []; config.model = 'fixture/model'; }
        if (mode === 'global') {
          const inspectionTimer = setTimeout(() => controller.abort(), 25000);
          try {
            const inspection = await definition.management.inspect({ instanceId: "acceptance", mode: "global", configRevision: 1, config }, { signal: controller.signal, processes: scope.api });
            if (vendor === "codex" && (inspection.authentication.state !== "not_required" || inspection.models.status !== "available")) throw new Error("Unexpected Codex inspection");
            if (vendor === "qwen-code" && (inspection.authentication.state !== "unknown" || inspection.models.status !== "unsupported" || !inspection.authentication.methods.length)) throw new Error("Unexpected Qwen inspection");
            console.log(JSON.stringify({ vendor, inspection: true, authentication: inspection.authentication.state, modelCatalog: inspection.models.status, models: inspection.models.items.length }));
          } finally { clearTimeout(inspectionTimer); }
        }
        const caller = { scopeId: 'acceptance', principal: { kind: 'user', id: 'fixture-owner' }, profileId: 'fixture-profile', surface: 'api', traceId: 'fixture' };
        const registry = new AgentRegistry(), provider = { kind: 'plugin', pluginId: `studio.agent-${definition.id}`, version: '1.0.0', generation: 'first' };
        const register = generation => { const registration = registry.stage(caller.profileId, { ...provider, generation }, [definition.id]); registration.register(definition); registration.commit(); };
        register('first');
        events = new PluginEventBus();
        const options = { store: executionStore, registry, events, stateRoot: join(home, 'state'), logger: { info() {}, warn() {}, error() {} }, authorize() {}, validateInput() {},
          settleRun: id => gateways.settleRun(id), context: (scope, signal) => ({ scope, signal,
            artifacts: { read: async (id, offset) => {
              if (id !== '00000000-0000-0000-0000-000000000001' || offset !== 0) throw new Error('Invalid native image read');
              const length = Buffer.from(imageData, 'base64').length;
              return { id, mediaType: 'image/png', byteLength: length, data: imageData, offset: 0, nextOffset: length, done: true };
            } }, models: { gateway: input => gateways.open(scope, input, signal) } }) };
        coordinator = new AgentCoordinator(options);
        let instance = coordinator.createInstance(caller, { agentTypeId: definition.id, mode, config });
        const setup = await coordinator.setupInstance(caller, instance.id, instance.revision);
        if (setup.cli.state !== 'available' || !setup.cli.version || setup.authentication.kind !== (mode === 'scoped' ? 'studio' : 'native')) throw new Error('Unexpected native setup probe');
        console.log(JSON.stringify({ vendor, mode, setup: true, version: setup.cli.version, authentication: setup.authentication.kind }));
        const marker = `STUDIO_RESOURCE_${vendor}_${mode}`;
        const catalog = await coordinator.resourceFiles(caller, instance.id, instance.revision, { action: 'list' });
        await coordinator.resourceFiles(caller, instance.id, instance.revision, { action: 'write', kind: 'configs', locationId: 'native-instructions', path: '', content: `Follow the fixture instruction ${marker}_INSTRUCTION.`, etag: 'missing' }, catalog.snapshot);
        await coordinator.resourceFiles(caller, instance.id, instance.revision, { action: 'write', kind: 'skills', locationId: 'native-skills', path: 'studio-resource-check/SKILL.md', content: `---
name: studio-resource-check
description: Skill marker ${marker}_SKILL.
---
Follow fixture instructions.`, etag: 'missing' }, catalog.snapshot);
        let checkpoint;
        for (let turn = 0; turn < (target === 'switch' ? 3 : 2); turn++) {
          searchIssued = false;
          if (target === 'switch') activeTarget = turn === 1 ? 'chat' : 'native';
          if (turn) {
            instance = await coordinator.updateInstance(caller, instance.id, { revision: instance.revision, mode,
              config: { ...instance.config, mcpServers: mcpServers(instance.revision + 1), model: mode === 'scoped' ? 'fixture/next-model' : 'fixture-model', systemPrompt: 'Preserve the prior conversation and reply briefly.' } });
            const next = await coordinator.resourceLocations(caller, instance.id, instance.revision);
            if (JSON.stringify(next.configs) !== JSON.stringify(catalog.configs)) throw new Error('Compatible configuration changed resource locations');
            await coordinator.close();
            register('first');
            coordinator = new AgentCoordinator(options);
          }
          {
            const requestOffset = requests.length;
            const mcpTraceOffset = (await readFile(join(root, 'mcp-trace.jsonl'), 'utf8').catch(() => '')).length;
            const content = [{ type: "text", text: `Respond with a brief greeting. Turn ${turn}.` },
              ...(turn ? [{ type: 'image', artifactId: '00000000-0000-0000-0000-000000000001', mediaType: 'image/png' }] : [])];
            const accepted = coordinator.start(caller, instance.id, { content, timeoutMs: 20000 }, `${vendor}-${mode}-${target}-${turn}`);
            await coordinator.wait(accepted.id);
            const result = coordinator.get(caller, accepted.id), output = coordinator.output(caller, accepted.id, -1);
            const nextCheckpoint = state.checkpoint(instance.id, result.provider, instance.revision);
            if (result.status !== 'completed') throw new Error(`${vendor} ${mode} native turn failed: ${result.errorCode}`);
            const nativeInput = JSON.stringify(requests.slice(requestOffset));
            const nativeTools = JSON.stringify(requests.slice(requestOffset).map(body => body.tools));
            // Qwen exposes deferred MCP declarations through tool_search results.
            const mcpCalls = (await readFile(join(root, 'mcp-trace.jsonl'), 'utf8')).slice(mcpTraceOffset).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
            if (!mcpCalls.some(call => call.method === 'tools/list' && call.tool === `continuity_v${instance.revision}`)
              || !nativeInput.includes(`continuity_v${instance.revision}`) || (turn && nativeTools.includes(`continuity_v${instance.revision - 1}`))) {
              throw new Error(`${vendor} did not replace the configured MCP tools after revision ${instance.revision}`);
            }

            console.log(JSON.stringify({ vendor, mode, turn: turn + 1, nativeInstructionsLoaded: nativeInput.includes(marker + '_INSTRUCTION'), nativeSkillDiscovered: nativeInput.includes(marker + '_SKILL') }));
            if (!nativeInput.includes(marker + '_INSTRUCTION') || !nativeInput.includes(marker + '_SKILL')) throw new Error(`${vendor} ${mode} did not consume the declared native resources`);
            if (nextCheckpoint === undefined) throw new Error('Successful native Run did not commit a checkpoint');
            if (turn && JSON.stringify(nextCheckpoint) !== JSON.stringify(checkpoint)) throw new Error(vendor + " changed native session between turns");
            checkpoint = nextCheckpoint;
            if (turn && !requests.slice(requestOffset).some(hasImage)) throw new Error(`${vendor} did not forward the image to its model`);
            if (mode === 'scoped') {
              const usage = state.usage(result.id);
              if (!usage.length || usage.some(call => !call.final || call.source !== 'host' || call.inputTokens !== 12 || call.outputTokens !== 5)) throw new Error('Native host accounting failed');
              const records = db.prepare('SELECT record_json FROM studio_plugin_model_calls').all().map(row => JSON.parse(row.record_json));
              if (records.filter(call => call.runId === result.id).some(call => call.status !== 'completed')) throw new Error('Native model call did not complete');
            }
            console.log(JSON.stringify({ vendor, mode, target, turn: turn + 1, status: result.status, events: output.length, sameNativeSession: turn ? true : void 0, configurationRevision: instance.revision, mcpConfigurationApplied: true, coordinatorRestart: !!turn, providerReactivation: !!turn, imageForwarded: turn ? true : void 0 }));
            if (result.status !== "completed" || !output.some((event) => ["message.delta", "message.snapshot"].includes(event.type) && event.text.includes("Native fixture answer"))) throw new Error(`${vendor} real turn did not complete`);
          }
        }
      } finally {
        await coordinator?.close(); events?.close();
        controller.abort();
        await scope.close();
      }
    }
  } finally {
    await gateways.close(); db.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ passed: true, localModelRequests: calls, remoteProvider: false, accountLogin: false }));
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

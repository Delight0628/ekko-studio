# Model API

Studio exposes a stateless OpenAI Responses-compatible model endpoint:

- `GET /api/studio/models/v1/models`
- `POST /api/studio/models/v1/responses`

Use `http://localhost:8648/api/studio/models/v1` as the OpenAI SDK `base_url`
(replace the host and port for your instance). Authentication uses an existing
Studio **user JWT**, obtained through Studio login, as `Authorization: Bearer …`.
Provider API keys stay on the server. This endpoint does not create a separate
API-key system. User tokens retain their configured expiry and existing account
permissions; clients must refresh them through login when expired.

Select a Profile with `x-hermes-profile`. A regular user with exactly one assigned
Profile may omit it. Users with several Profiles must select one; super admins
default to the active Profile. A caller cannot access another user's unassigned
Profile by putting its name in the request.

## Models and routing

The list contains all configured models visible in the selected Profile, with IDs
such as `glm/glm-5.3`, `deepseek/deepseek-reasoner`, and
`openrouter/vendor/model`. Native IDs containing slashes remain intact. The list
includes `api_mode` and `responses_supported`; it contains no keys or upstream URLs.
Slashes and percent signs in custom provider names are escaped in the provider
segment (`%2F`, `%25`) to avoid collisions; use the exact ID returned by the list.

The server matches the complete ID against the Profile's catalog, resolves its
credentials and API mode, and calls the existing Ekko ModelClient adapter. This
supports Chat Completions, Responses, Anthropic Messages and Gemini Contents,
including configured custom providers using these protocols. Disabled models are
not callable. Bedrock Converse, Codex app-server and MoA need separate runtimes;
they remain listed with `responses_supported: false` and requests return an
explicit error. OpenAI Codex OAuth using the Responses HTTP transport is supported.

Coding Agent already performs protocol conversion in its own proxy. It remains
separate: this endpoint reuses Ekko model adapters without starting an agent,
executing tools, or modifying Hermes provider configuration.

## Requests

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8648/api/studio/models/v1",
    api_key="YOUR_STUDIO_USER_JWT",
    default_headers={"x-hermes-profile": "default"},
)
models = client.models.list()
response = client.responses.create(
    model="glm/glm-5.3",
    input="Hello",
    store=False,
)
print(response.output_text)

for event in client.responses.create(
    model="glm/glm-5.3", input="Hello", store=False, stream=True,
):
    if event.type == "response.output_text.delta":
        print(event.delta, end="")
```

Supported input includes text messages, `instructions`, `developer` messages,
function tool declarations, function calls/results, reasoning effort/summary,
temperature and maximum output tokens. User/tool images must use base64 data
URLs and a vision-capable model. Provider-specific capabilities still apply.
The endpoint returns JSON or named Responses SSE events, including terminal
`response.completed`, `response.incomplete` and `response.failed` states.
Disconnecting cancels the upstream request.

The API is stateless: send the full history for every continuation. Append the
returned `output` items unchanged, then append a `function_call_output` for every
outstanding `call_id`. Tools are executed by the caller. Send the tool declarations
again on subsequent requests. For example:

```python
history = [{"role": "user", "content": "Look up the status"}]
response = client.responses.create(model="deepseek/deepseek-reasoner",
    input=history, tools=tools, store=False)
history.extend(item.model_dump(exclude_none=True) for item in response.output)
for item in response.output:
    if item.type == "function_call":
        history.append({"type": "function_call_output", "call_id": item.call_id,
                        "output": run_allowed_tool(item.name, item.arguments)})
response = client.responses.create(model="deepseek/deepseek-reasoner",
    input=history, tools=tools, store=False)
```

Reasoning output carries an opaque `encrypted_content` envelope. Preserve it:
it retains DeepSeek reasoning content, Anthropic thinking signatures and Gemini
thought signatures needed for valid tool continuation. Native replay is scoped to
the Profile, provider, model, endpoint and protocol. Switching targets discards
incompatible native data instead of forwarding another provider's encrypted data.
The encryption key lives in Studio state as `model-api-reasoning.key`; retain this
file across restarts/backups. Replicas serving one history must share it.

This is a model-inference subset of Responses. It explicitly rejects stored
conversations, `previous_response_id`, background requests, hosted tools, strict
tool schemas, structured text output, remote image URLs/file IDs, forced named
tool choice and disabling parallel tool calls. These features are not silently
emulated. There are no response retrieval/delete routes or `/chat/completions`
endpoint in this API.

## Usage

Every attempted upstream request through this endpoint records **external** usage,
including calls from Studio configured with its own endpoint. Authentication and
validation failures before an upstream request do not create model usage. Existing
chat, workflow and Coding Agent accounting stays **internal**. A Studio call to its
own endpoint can therefore appear once in each category; these are two accounting
views and must not be summed as a deduplicated provider bill.

The usage page switches between Internal and External. The stats endpoint accepts
`origin=internal|external` and defaults to internal for existing clients. API usage
belongs to the authenticated Studio user and selected Profile, with one API call
per request and no synthetic chat session. Repeated usage snapshots within one
stream produce one external record. Failure/cancellation retains usage already
reported; missing usage remains unknown instead of claiming a measured zero cost.
Responses `input_tokens` includes cached input; Studio's ledger keeps ordinary
input and cache counters separate.

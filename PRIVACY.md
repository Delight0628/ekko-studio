# Ekko Studio Privacy Notice

Effective date: 2026-10-20

Ekko Studio is a self-hosted, local-first AI workspace maintained by EKKOLearnAI.
Local-first does not mean offline-only. This notice describes the application;
your NAS administrator and the external services you select may have additional
policies. Do not send data you are not authorized to disclose.

## Data and storage

Studio can store account/authentication settings, API credentials, provider
configuration, conversations, prompts, generated responses, attachments, uploaded
files, tool results, workspaces, agent configuration and operational logs on the
host. Tools and agents may read files, run commands and access networks with the
permissions you grant. Review prompts, attachments and tool access before use.

In the TOS package the dedicated account stores application-managed data under
`/usr/local/com.hermeswebui.studio/data/` and file logs under `logs/`. TOS maps
this application path onto its installation volume. Other installations use the
configured Studio/agent home directories. External workspaces and backups are
separate from application-managed storage.

## External services and sharing

When you run a model request, the configured provider may receive the prompt,
selected conversation history, system instructions, attached content and tool
results included in that request. The request uses your configured credentials;
the recipient can also observe network metadata such as your source IP address.
Provider presets are configuration shortcuts, not a guarantee that a request is
sent to the original model developer.

Examples of built-in model endpoint bases (the actual configuration controls the
recipient) include:

| Service | Endpoint base | Destination / processing region |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | OpenAI; region depends on account/service terms, not selected by Studio |
| Anthropic | `https://api.anthropic.com` | Anthropic; region depends on account/service terms |
| Google | `https://generativelanguage.googleapis.com/v1beta/openai` | Google; region depends on account/service terms |
| DeepSeek | `https://api.deepseek.com` | DeepSeek; verify region with provider |
| xAI | `https://api.x.ai/v1` | xAI; verify region with provider |
| Alibaba Cloud | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | International DashScope; verify account deployment/region |
| MiniMax | `https://api.minimax.io/anthropic/v1` | MiniMax; verify region with provider |
| Nous Research | `https://inference-api.nousresearch.com/v1` | Nous Research; verify region with provider |
| ChatGPT OAuth | `https://chatgpt.com/backend-api/codex` | OpenAI/ChatGPT; account terms apply |
| Qwen OAuth | `https://portal.qwen.ai/v1` | Qwen; account terms apply |
| Custom, imported or agent-managed provider, including apikey.fan presets | Exact URL displayed in the active provider/agent configuration | The configured operator and possibly downstream providers; region is not verified by Studio |

This table is not an exhaustive network allowlist. Third-party agents, MCP
servers, browser tools, plugins, speech services and integrations can contact
additional services when enabled. Their data flows and retention are governed
by their configuration and policies. Review each integration before enabling it.
A domain name alone does not establish processing location. If a recipient or
region cannot be confirmed, do not send sensitive data to that service.

## Retention and deletion

There is no universal automatic expiration period for self-hosted conversations,
files, credentials and logs. They remain until deleted by the user/administrator
or the relevant tool's retention mechanism. Delete conversations/files and remove
credentials through the corresponding application settings where available.
For complete local deletion, stop Studio and ask the host administrator to remove
its configured Studio and agent data, uploads, logs, caches and unwanted backups.
External workspaces require separate deletion by their owner.

**The TOS package removes its managed data and logs on uninstall, including
workspaces inside its data directory. Export or back up anything you need first.**
Upgrades retain managed data. Uninstall does not delete external workspaces,
administrator backups or data already sent to third parties. Request deletion
from those providers directly under their policies; local deletion cannot recall
previously transmitted data.

## Security and your rights

The TOS service runs under a dedicated non-root account with restrictive data
directory permissions and systemd hardening. These measures do not guarantee
security or encryption at rest. The TOS backend listens on loopback behind the portal proxy. Portal transport
security depends on the NAS HTTPS configuration; enable HTTPS and restrict
access with administrator network controls. Protect the host, backups, API keys and administrator accounts.

You or your host administrator can inspect, export/copy, correct and delete local
data and disable integrations. Availability of export/edit actions varies by
feature; filesystem-level administration may be required. Rights over externally
processed data depend on applicable law and the recipient's policies.

For privacy questions or a private contact channel, use the maintainer contact
options on the EKKOLearnAI GitHub organization. General requests may be filed at
https://github.com/EKKOLearnAI/ekko-studio/issues; **never post prompts, keys,
personal data or other sensitive material in a public issue**. Maintainers cannot
delete data on a self-hosted NAS they do not control; contact its administrator.

## Third-party relay presets and referral links

`apikey.fan` is an optional third-party relay, not the original model developer
and not required to use Studio. Previous versions included registration links
with `aff=LIBAPI`, a referral identifier that can attribute registrations and may
provide a referral/commission benefit. This version removes that built-in
parameter. Existing external links or user configuration are not rewritten.
Studio does not require registration with that service: choose a different
provider or your own endpoint and do not configure relay credentials to opt out.

Relay-specific calls include `https://api.apikey.fan/v1` (OpenAI-compatible model
requests), `https://api.apikey.fan` (Anthropic-compatible requests) and `/v1/usage`
under configured apikey.fan API bases (account usage lookup). Model requests send
the configured API credential and the input/history/attachments/tool outputs
included in a turn. Usage lookups send the relay credential and network metadata,
not the conversation body. Visiting `https://apikey.fan/register` exposes normal
browser network metadata to that website. These are separate operations.

The relay operator and any downstream model operators may receive and process
requests. Their legal operating entity, processing country/region, retention,
subprocessor list and deletion commitments have **not been independently verified**
by Studio. Do not infer a region from the domain, and obtain those details from
the operator before sending sensitive data. This disclosure is not a claim that
those unknowns satisfy a platform's transfer requirements.

Agent runtimes and MCP servers are separately selected/configured integrations;
their actual URLs, credentials and accessible tools determine the recipients.
A complete inventory of those user-managed endpoints cannot be established from
a provider preset alone. Administrators must review their enabled definitions;
this notice does not authorize arbitrary additional transfers.

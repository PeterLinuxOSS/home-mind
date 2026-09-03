# Home Mind

AI assistant with cognitive memory for Home Assistant. This add-on runs the two
back-end services — the Home Mind API server and the Shodh Memory store — in a
single container, so you do not need a separate Docker host.

The conversation agent itself is a custom integration installed through HACS.
The add-on replaces only the `docker compose` half of the standard install.

## Installation

1. Add this repository to Home Assistant:
   **Settings → Add-ons → Add-on store → ⋮ → Repositories**, then paste
   `https://github.com/hoornet/home-mind`.
2. Install the **Home Mind** add-on. The first build takes several minutes —
   the server is compiled from source on your machine.
3. Open the **Configuration** tab, pick your LLM provider and paste its API key.
4. Start the add-on and watch the **Log** tab until you see
   `Home Mind Server Started`.
5. Install the Home Mind integration through HACS and point it at this add-on
   (see below).

### Connecting the integration

In HACS, add `https://github.com/hoornet/home-mind-hacs` as a custom repository
of type *Integration*, install **Home Mind**, restart Home Assistant, then add
the integration under **Settings → Devices & services**.

It asks for an **API URL**. The default `http://localhost:3100` does **not**
work, because Home Assistant and the add-on are separate containers. Use the
add-on's hostname instead, which is shown on the add-on page under *Hostname*:

```
http://<hostname>:3100
```

The IP address of your Home Assistant machine works too, for example
`http://192.168.1.100:3100`.

Finally set Home Mind as the conversation agent under
**Settings → Voice assistants**.

## Configuration

### LLM provider

| Option | Description |
|---|---|
| `llm_provider` | `anthropic` (Claude), `openai`, or `ollama` for local inference. |
| `llm_model` | Model name. Leave empty for the default, `claude-haiku-4-5-20251001`. Ollama needs an explicit model. |
| `anthropic_api_key` | Required for `anthropic`. From [console.anthropic.com](https://console.anthropic.com/). |
| `openai_api_key` | Required for `openai`. |
| `openai_base_url` | Override for OpenAI-compatible endpoints. |
| `openai_max_tokens` | Response cap for OpenAI. |
| `ollama_base_url` | Required for `ollama`, e.g. `http://192.168.1.10:11434/v1`. |

### Behaviour

| Option | Default | Description |
|---|---|---|
| `custom_prompt` | — | Extra system prompt. Gives the assistant a name and personality. |
| `device_overrides` | — | JSON of per-entity light capability overrides, e.g. `{"light.kitchen": {"whiteMethod": "rgb_white"}}`. Use when a light reports the wrong colour modes. |
| `layout_domains` | — | Entity domains listed in the home layout that is sent with **every** request. Empty uses a default that keeps controllable domains plus `sensor`/`binary_sensor`; `all` includes everything; a comma-separated list overrides it. On a large home this is the single biggest cost lever — see below. |
| `memory_token_limit` | `3000` | Maximum tokens of recalled memory injected into a prompt. |
| `memory_cleanup_interval_hours` | `6` | How often faded memories are pruned. `0` disables it. |
| `conversation_storage` | `sqlite` | `sqlite` keeps conversation history across restarts in `/data`, `memory` forgets it. |
| `log_level` | `info` | `debug` also raises the Shodh Memory log level. |

### Speech

Only used by the optional HomeMind PWA. Voice through Home Assistant Assist
uses your existing Assist pipeline and needs none of this.

| Option | Description |
|---|---|
| `stt_provider` / `tts_provider` | `none` or `openai`. |
| `stt_api_key` / `tts_api_key` | Falls back to `openai_api_key` when empty. |
| `stt_base_url` / `tts_base_url` | For OpenAI-compatible endpoints. |
| `stt_model` / `tts_model` / `tts_voice` | Model and voice selection. |

### API access

| Option | Description |
|---|---|
| `api_token` | Bearer token required on `/api` requests. Leave empty and the API is unauthenticated — only do that on a trusted network. |
| `cors_origins` | Comma-separated origins, needed when the PWA is served from another origin. |

### Advanced: a different Home Assistant

By default the add-on talks to the Home Assistant it runs on, through the
Supervisor proxy. It authenticates with the add-on's own token, so **no
long-lived access token is needed**.

Set `ha_url` and `ha_token` only to control a *different* Home Assistant.
`ha_skip_tls_verify` allows self-signed certificates on that instance.

### Why `layout_domains` matters

The assistant is told the layout of your home — floor, room, and the entities in
each room — on **every** request, so the model knows where a device is without
asking. Home Assistant's `area_entities()` returns *everything* in a room,
though, and on a large install most of that is `button`, `update`, `number`,
and `select` entities no one ever asks a voice assistant about.

Measured on a 1,631-entity home: the unfiltered layout is **23,301 tokens**,
about two thirds of the entire request. The default filter brings it to
**14,570**; restricting it to controllable domains only
(`light,switch,cover,climate,media_player,fan,lock,script,scene`) brings it to
**4,114** and roughly halves the cost of every command.

Nothing is lost by filtering — entities left out are still reachable through the
assistant's search tools. It just costs a tool call on the requests that need
one instead of prompt tokens on all of them. Start with the default; narrow it
if cost matters more than answering sensor questions without a lookup.

## Data and ports

Everything persistent lives in the add-on's `/data` volume and is covered by
Home Assistant backups:

- `/data/shodh` — the memory store
- `/data/conversations.db` — conversation history when `conversation_storage` is `sqlite`
- `/data/shodh_api_key` — generated on first start, never leaves the container

Port `3100` is published so the integration and the PWA can reach the API.
Shodh Memory listens on loopback inside the container only and is not exposed.

## Migrating from Docker Compose

The add-on does not import an existing `shodh_data` volume. To keep your
memories, copy the contents of the old volume into `/data/shodh` (for example
over SSH with the *Advanced SSH & Web Terminal* add-on) while the add-on is
stopped, then start it.

Settings map to options one-to-one: every `.env` variable has an option with
the same name in lower case, except `HA_URL`/`HA_TOKEN`, which are no longer
needed, and `SHODH_URL`/`SHODH_API_KEY`, which the add-on manages itself.

## Troubleshooting

**The add-on stops right after starting.** Check the log. A missing API key for
the selected provider, or an unreachable Ollama URL, halts the add-on on
purpose rather than restarting in a loop.

**`Shodh Memory did not start within 120 seconds`.** Shodh loads ONNX models at
startup; on a slow disk the first start can be long. The lines above this
message are Shodh's own output and say what actually failed.

**The integration cannot connect.** `localhost` is the usual cause — Home
Assistant and the add-on are different containers. Use the add-on's hostname or
your machine's IP.

**Generic answers with no Home Assistant data.** Look for
`Topology scanner: home layout loaded` in the log. If it says `unavailable`,
the Supervisor proxy call failed; the lines above it carry the error.

## Support

Issues and questions: <https://github.com/hoornet/home-mind/issues>

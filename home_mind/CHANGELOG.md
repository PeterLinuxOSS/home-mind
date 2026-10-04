# Changelog

## 0.18.0

- Model dropdowns for every provider: `anthropic_model` and `openai_model`
  join `gemini_model`. A model typed in `llm_model` still wins.
- The API key fields of all three providers now show in the configuration
  form without "Show unused optional configuration options".

## 0.17.5

Server built from `gemini-6`.

- A silent action is now answered with `action_done_reply` (default
  `Done.`) instead of asking the model again — about a second faster.

## 0.17.4

Server built from `gemini-5`.

- After a successful action Gemini sometimes answered with nothing, so
  Assist said "I received your request but got no response" although the
  light had switched. The model is now asked once, with tools off, to
  confirm what it did.

## 0.17.3

Server built from `gemini-4`.

- Gemini failed with "400 status code (no body)" whenever it called two
  tools at once: it streams each call with its own id but no index, and
  the calls were glued into one. They are now kept apart.

## 0.17.2

Server built from `gemini-3`.

- `log_level: debug` logs the raw tool-call chunks, to diagnose providers
  that reject the follow-up turn.

## 0.17.1

Server built from `gemini-2`.

- Gemini answered every question that needed a tool with an empty reply:
  its API ends a tool-calling turn with `finish_reason: stop`, and the
  server only ran tools on `tool_calls`. Tools now run whenever the model
  asks for them.

## 0.17.0

Server built from `gemini-1`.

- New `gemini` provider: Google's Gemini models through their
  OpenAI-compatible API. Set `llm_provider: gemini` and `gemini_api_key`;
  pick the model in the new `gemini_model` dropdown (default
  `gemini-3.5-flash-lite`, the fastest). A model typed in `llm_model` wins.
- Tool calls keep the provider's `extra_content` for the follow-up turn.
  Gemini 3 attaches its thought signature there and rejects the next
  request without it.
- New `reasoning_effort` option, passed to OpenAI-compatible providers.

## 0.16.9

Server built from `voice-fixes-2`.

- The assistant now sees and controls only the entities you exposed under
  Settings, Voice assistants — the tools, not just the prompt it is sent.
  The layout has honoured that list since 0.16.7, but `search_entities`,
  `get_state`, `get_entities`, `get_history` and `call_service` went
  straight to the states API and returned every entity in the house, so
  asking what it could see in a room listed hidden lights and sensors you
  had deliberately kept out of Assist. This is how Home Assistant's own
  conversation agent has always worked.
- Anything you want the assistant to know about must now be exposed. If it
  says something is "not available", expose it and ask again.
- `TOOLS_FROM_EXPOSED=false` restores the old reach.

## 0.16.8

Server built from `voice-fixes-1`.

- The home layout now names every entity — `switch.flush_1d_relay (Garaz
  Dvere)` instead of the bare id, which said nothing about a garage door.
- `search_entities` folds accents on both sides, so a query in the user's own
  language matches an entity id slugged to ASCII.

## 0.16.5

First release of the Home Assistant add-on. Packages Home Mind server 0.16.5
and Shodh Memory 0.2.0 in one container.

- Home Assistant is reached through the Supervisor proxy, so `HA_URL` and
  `HA_TOKEN` are gone. Set them only to control a different instance.
- The Shodh API key is generated on first start and kept in `/data`.
- `conversation_storage` defaults to `sqlite`, so history survives restarts.
- Shodh Memory listens on loopback only; just the API port 3100 is published.

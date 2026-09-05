# Changelog

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

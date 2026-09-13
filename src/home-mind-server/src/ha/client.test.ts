import { describe, it, expect, beforeEach, vi } from "vitest";
import { HomeAssistantClient } from "./client.js";
import { AssistExposure } from "./exposure.js";
import type { Config } from "../config.js";

const baseConfig: Config = {
  haUrl: "http://supervisor/core",
  haToken: "test-token",
  haSkipTlsVerify: false,
} as Config;

describe("HomeAssistantClient.getHistory URL encoding", () => {
  let captured: string | undefined;

  beforeEach(() => {
    captured = undefined;
    global.fetch = vi.fn(async (input: unknown) => {
      captured = typeof input === "string" ? input : String(input);
      return new Response(JSON.stringify([[]]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
  });

  it("URL-encodes the `+` in `+HH:MM` tz offsets on start_time, end_time, and entity_id", async () => {
    const ha = new HomeAssistantClient(baseConfig);
    await ha.getHistory(
      "sensor.solaredge_current_power",
      "2026-05-11T00:00:00+02:00",
      "2026-05-11T09:46:47+02:00"
    );

    expect(captured).toBeDefined();
    // Raw `+` would be decoded as space by aiohttp on the HA side.
    expect(captured).not.toContain("+02:00");
    // Properly encoded forms.
    expect(captured).toContain("%2B02%3A00");
    expect(captured).toContain("end_time=2026-05-11T09%3A46%3A47%2B02%3A00");
  });

  it("still works for plain `Z` (UTC) timestamps", async () => {
    const ha = new HomeAssistantClient(baseConfig);
    await ha.getHistory(
      "sensor.foo",
      "2026-05-11T00:00:00Z",
      "2026-05-11T09:00:00Z"
    );

    expect(captured).toContain("end_time=2026-05-11T09%3A00%3A00Z");
  });
});

describe("HomeAssistantClient.searchEntities accent folding", () => {
  const states = [
    { entity_id: "switch.flush_1d_relay", state: "off", attributes: { friendly_name: "Garaz Dvere" } },
    { entity_id: "light.spalna_svetlo", state: "on", attributes: { friendly_name: "Spálňa svetlo" } },
    { entity_id: "light.kuchyna_svetlo", state: "on", attributes: { friendly_name: "Kuchyňa svetlo" } },
  ];

  beforeEach(() => {
    global.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(states), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    ) as unknown as typeof fetch;
  });

  const ids = async (query: string) =>
    (await new HomeAssistantClient(baseConfig).searchEntities(query)).map((s) => s.entity_id);

  it("finds an unaccented name from an accented query", async () => {
    // The model asks in Slovak; the installer typed the name without accents.
    expect(await ids("garáž")).toEqual(["switch.flush_1d_relay"]);
  });

  it("finds an accented name from an unaccented query", async () => {
    // The other direction: speech-to-text drops the accents.
    expect(await ids("spalna")).toEqual(["light.spalna_svetlo"]);
  });

  it("still matches when both sides carry the same accents", async () => {
    expect(await ids("Kuchyňa")).toEqual(["light.kuchyna_svetlo"]);
  });

  it("does not turn folding into a match-everything", async () => {
    expect(await ids("terasa")).toEqual([]);
  });
});

describe("HomeAssistantClient and the Assist exposure list", () => {
  // Home Assistant's own agent filters states.async_all() through
  // async_should_expose before anything sees it, so an unexposed entity does
  // not exist for the assistant — not in the prompt, and not through a tool.
  // Before this the layout honoured the user's choices while the tools went
  // straight to /api/states and returned the whole house.
  const house = [
    { entity_id: "light.kitchen_table", state: "on", attributes: { friendly_name: "Kitchen table" } },
    { entity_id: "light.kitchen_table_1", state: "off", attributes: { friendly_name: "Kitchen table 1" } },
    { entity_id: "light.kitchen_table_2", state: "off", attributes: { friendly_name: "Kitchen table 2" } },
    { entity_id: "sensor.kitchen_presence", state: "on", attributes: { friendly_name: "Kitchen presence" } },
  ];

  let calls: string[];

  beforeEach(() => {
    calls = [];
    global.fetch = vi.fn(async (input: unknown) => {
      const url = typeof input === "string" ? input : String(input);
      calls.push(url);
      if (url.includes("/api/services")) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/history/period")) {
        return new Response(JSON.stringify([[]]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/states")) {
        return new Response(JSON.stringify(house), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      const id = url.split("/api/states/")[1];
      const state = house.find((s) => s.entity_id === id);
      return new Response(JSON.stringify(state ?? { message: "Entity not found." }), {
        status: state ? 200 : 404,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
  });

  const exposing = (...ids: string[]) => new AssistExposure(async () => new Set(ids));

  it("search_entities returns only what the user exposed", async () => {
    const client = new HomeAssistantClient(baseConfig, exposing("light.kitchen_table"));
    const found = await client.searchEntities("kitchen");
    expect(found.map((s) => s.entity_id)).toEqual(["light.kitchen_table"]);
  });

  it("get_entities returns only what the user exposed", async () => {
    const client = new HomeAssistantClient(baseConfig, exposing("light.kitchen_table"));
    expect((await client.getEntities()).map((s) => s.entity_id)).toEqual(["light.kitchen_table"]);
    expect((await client.getEntities("sensor")).map((s) => s.entity_id)).toEqual([]);
  });

  it("get_state refuses an entity that exists but is not exposed", async () => {
    const client = new HomeAssistantClient(baseConfig, exposing("light.kitchen_table"));
    await expect(client.getState("light.kitchen_table_1")).rejects.toThrow(/not available to you/);
    // and never asks HA for it
    expect(calls.some((u) => u.includes("/api/states/light.kitchen_table_1"))).toBe(false);
  });

  it("get_history refuses an unexposed entity", async () => {
    const client = new HomeAssistantClient(baseConfig, exposing("light.kitchen_table"));
    await expect(client.getHistory("sensor.kitchen_presence")).rejects.toThrow(/not available to you/);
    expect(calls.some((u) => u.includes("/api/history"))).toBe(false);
  });

  it("call_service refuses to drive an unexposed entity", async () => {
    const client = new HomeAssistantClient(baseConfig, exposing("light.kitchen_table"));
    await expect(
      client.callService("light", "turn_on", "light.kitchen_table_1")
    ).rejects.toThrow(/not available to you/);
    expect(calls.some((u) => u.includes("/api/services/light/turn_on"))).toBe(false);
  });

  it("call_service checks entity_id smuggled in data, and every id in a list", async () => {
    const client = new HomeAssistantClient(baseConfig, exposing("light.kitchen_table"));
    await expect(
      client.callService("light", "turn_on", undefined, { entity_id: "light.kitchen_table_2" })
    ).rejects.toThrow(/not available to you/);
    await expect(
      client.callService("light", "turn_on", undefined, {
        entity_id: ["light.kitchen_table", "light.kitchen_table_2"],
      })
    ).rejects.toThrow(/kitchen_table_2/);
  });

  it("lets an exposed entity through untouched", async () => {
    const client = new HomeAssistantClient(baseConfig, exposing("light.kitchen_table"));
    expect((await client.getState("light.kitchen_table")).state).toBe("on");
    await client.callService("light", "turn_on", "light.kitchen_table");
    expect(calls.some((u) => u.includes("/api/services/light/turn_on"))).toBe(true);
  });

  it("without an exposure list the client behaves exactly as before", async () => {
    const client = new HomeAssistantClient(baseConfig);
    expect((await client.searchEntities("kitchen")).map((s) => s.entity_id)).toEqual(
      house.map((s) => s.entity_id)
    );
    await client.callService("light", "turn_on", "light.kitchen_table_1");
    expect(calls.some((u) => u.includes("/api/services/light/turn_on"))).toBe(true);
  });

  it("a list that cannot be read means no opinion, not a house with no devices", async () => {
    const client = new HomeAssistantClient(baseConfig, new AssistExposure(async () => null));
    expect((await client.searchEntities("kitchen"))).toHaveLength(house.length);
    expect((await client.getState("sensor.kitchen_presence")).state).toBe("on");
  });
});

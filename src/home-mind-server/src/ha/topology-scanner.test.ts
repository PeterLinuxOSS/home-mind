import { describe, it, expect } from "vitest";
import { TopologyScanner } from "./topology-scanner.js";
import type { HomeAssistantClient } from "./client.js";

/** A client that answers the layout template with a canned JSON payload. */
function makeHa(payload: unknown): HomeAssistantClient {
  return {
    renderTemplate: async () => JSON.stringify(payload),
  } as unknown as HomeAssistantClient;
}

const HOUSE = {
  floors: [
    {
      id: "ground",
      name: "Ground floor",
      areas: [
        {
          id: "garage",
          name: "Garáž",
          entities: [
            { id: "switch.flush_1d_relay", name: "Garaz Dvere" },
            { id: "light.garaz_svetlo", name: "Svetlo Garaž" },
          ],
        },
      ],
    },
  ],
  unassigned: [
    {
      id: "attic",
      name: "Attic",
      entities: [{ id: "sensor.attic_temp", name: null }],
    },
  ],
};

describe("TopologyScanner layout naming", () => {
  it("names every entity, so the model can map a spoken device to an id", async () => {
    const scanner = new TopologyScanner(makeHa(HOUSE));
    await scanner.scan();

    // Without the name, "switch.flush_1d_relay" says nothing about a garage door.
    expect(scanner.formatSection()).toContain(
      "switch.flush_1d_relay (Garaz Dvere)"
    );
    expect(scanner.formatSection()).toContain("light.garaz_svetlo (Svetlo Garaž)");
  });

  it("falls back to the bare id when Home Assistant has no friendly name", async () => {
    const scanner = new TopologyScanner(makeHa(HOUSE));
    await scanner.scan();

    expect(scanner.formatSection()).toContain("- Attic: sensor.attic_temp");
    expect(scanner.formatSection()).not.toContain("sensor.attic_temp (");
  });

  it("keeps rooms grouped under their floor", async () => {
    const scanner = new TopologyScanner(makeHa(HOUSE));
    await scanner.scan();

    const text = scanner.formatSection();
    expect(text).toContain("**Ground floor**");
    expect(text.indexOf("**Ground floor**")).toBeLessThan(text.indexOf("Garáž"));
  });
});

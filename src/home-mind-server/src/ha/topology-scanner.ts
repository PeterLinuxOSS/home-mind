import type { HomeAssistantClient } from "./client.js";

/**
 * Single Jinja2 template that returns the full home layout as JSON in one call.
 * Uses HA template functions: floors(), floor_name(), floor_areas(),
 * area_name(), area_entities(), areas(), area_floor_id().
 * All available since HA 2024.4.
 */
const LAYOUT_TEMPLATE = `
{%- set ns = namespace(floors=[], assigned=[]) -%}
{%- for fid in floors() -%}
  {%- set ans = namespace(areas=[]) -%}
  {%- for aid in floor_areas(fid) -%}
    {%- set ans.areas = ans.areas + [{"id": aid, "name": area_name(aid), "entities": area_entities(aid) | list}] -%}
    {%- set ns.assigned = ns.assigned + [aid] -%}
  {%- endfor -%}
  {%- set ns.floors = ns.floors + [{"id": fid, "name": floor_name(fid), "areas": ans.areas}] -%}
{%- endfor -%}
{%- set orphans = namespace(areas=[]) -%}
{%- for aid in areas() -%}
  {%- if aid not in ns.assigned -%}
    {%- set orphans.areas = orphans.areas + [{"id": aid, "name": area_name(aid), "entities": area_entities(aid) | list}] -%}
  {%- endif -%}
{%- endfor -%}
{{ {"floors": ns.floors, "unassigned": orphans.areas} | tojson }}
`.trim();

/**
 * Domains worth putting in front of the model by default: everything it can
 * act on, plus the ones it is routinely asked to read. Deliberately excluded
 * are the config and diagnostic domains an integration creates by the dozen —
 * `button`, `update`, `number`, `select`, `event`, `text`, `automation` — which
 * on a large install are most of the entity count and none of the questions.
 */
export const DEFAULT_LAYOUT_DOMAINS = [
  // controllable
  "alarm_control_panel", "climate", "cover", "fan", "humidifier", "input_boolean",
  "lawn_mower", "light", "lock", "media_player", "remote", "scene", "script",
  "siren", "switch", "vacuum", "valve", "water_heater",
  // routinely asked about
  "binary_sensor", "camera", "device_tracker", "person", "sensor", "timer", "weather",
] as const;

interface AreaData {
  id: string;
  name: string;
  entities: string[];
}

interface FloorData {
  id: string;
  name: string;
  areas: AreaData[];
}

interface LayoutData {
  floors: FloorData[];
  unassigned: AreaData[];
}

/**
 * Scans the Home Assistant home layout (floors → rooms → entities) via the
 * template API and injects it into every system prompt. This gives the LLM
 * spatial awareness without tool calls — it knows which floor/room a device
 * belongs to before reasoning begins.
 *
 * Uses POST /api/template with a single Jinja2 query (no registry REST
 * endpoints needed, works on all HA versions with template support).
 *
 * Runs at startup and refreshes every scanIntervalMs.
 */
export class TopologyScanner {
  private ha: HomeAssistantClient;
  private lastScanTime: number = 0;
  private readonly scanIntervalMs: number;
  private readonly domains: Set<string> | null;
  private layoutText: string = "";

  /**
   * @param domains Entity domains to keep in the layout. `null` keeps every
   *   domain — the pre-0.16.6 behaviour, and what a home with few entities
   *   wants. On a large install `area_entities()` returns everything, so the
   *   default filter drops the config and diagnostic domains nobody asks a
   *   voice assistant about (`button`, `update`, `number`, `select`, `event`).
   */
  constructor(
    ha: HomeAssistantClient,
    scanIntervalMs = 30 * 60 * 1000,
    domains: readonly string[] | null = DEFAULT_LAYOUT_DOMAINS
  ) {
    this.ha = ha;
    this.scanIntervalMs = scanIntervalMs;
    this.domains = domains === null ? null : new Set(domains);
  }

  private keep(entityId: string): boolean {
    if (this.domains === null) return true;
    return this.domains.has(entityId.slice(0, entityId.indexOf(".")));
  }

  async scan(): Promise<void> {
    try {
      const raw = await this.ha.renderTemplate(LAYOUT_TEMPLATE);
      const data = JSON.parse(raw.trim()) as LayoutData;
      this.layoutText = this.buildLayout(data);
      this.lastScanTime = Date.now();

      const floorCount = data.floors.length;
      const areas = [...data.floors.flatMap((f) => f.areas), ...data.unassigned];
      const total = areas.reduce((n, a) => n + a.entities.length, 0);
      const kept = areas.reduce((n, a) => n + a.entities.filter((e) => this.keep(e)).length, 0);
      // The layout ships in every system prompt, so its size is a running cost.
      const filtered = kept === total ? "" : ` (${total - kept} filtered out by domain)`;
      console.log(
        `[topology] Scanned home layout: ${floorCount} floors, ${areas.length} areas, ` +
          `${kept} entities${filtered}`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[topology] Scan failed — home layout unavailable: ${msg}`);
      // Keep previous layout if scan fails
    }
  }

  async refreshIfStale(): Promise<void> {
    if (Date.now() - this.lastScanTime > this.scanIntervalMs) {
      await this.scan();
    }
  }

  hasLayout(): boolean {
    return this.layoutText.length > 0;
  }

  formatSection(): string {
    return this.layoutText;
  }

  private buildLayout(data: LayoutData): string {
    // Check if there's anything useful to show
    const hasFloors = data.floors.some((f) => f.areas.length > 0);
    const hasOrphans = data.unassigned.length > 0;
    if (!hasFloors && !hasOrphans) return "";

    const lines: string[] = [
      "## Home Layout (auto-detected from Home Assistant)",
      "",
      "Use this to know which floor/room a device belongs to — never assume locations.",
      "",
    ];

    for (const floor of data.floors) {
      if (floor.areas.length === 0) continue;
      lines.push(`**${floor.name}**`);
      for (const area of floor.areas.sort((a, b) => a.name.localeCompare(b.name))) {
        const entities = area.entities.filter((e) => this.keep(e));
        if (entities.length === 0) continue;
        lines.push(`- ${area.name}: ${entities.sort().join(", ")}`);
      }
      lines.push("");
    }

    if (data.unassigned.length > 0) {
      lines.push("**Other rooms (no floor assigned)**");
      for (const area of data.unassigned.sort((a, b) => a.name.localeCompare(b.name))) {
        const entities = area.entities.filter((e) => this.keep(e));
        if (entities.length === 0) continue;
        lines.push(`- ${area.name}: ${entities.sort().join(", ")}`);
      }
      lines.push("");
    }

    return lines.join("\n").trimEnd();
  }
}

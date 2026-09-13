import type { Config } from "../config.js";
import { AssistExposure, notExposedMessage } from "./exposure.js";

export interface EntityState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
}

export interface HistoryEntry {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
}

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

/**
 * Lower-case and strip diacritics, so "Spálňa" and "spalna" compare equal.
 * NFD splits an accented letter into base + combining mark; the range
 * U+0300–U+036F is exactly those marks.
 */
export function foldAccents(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** The entity IDs a service call targets; HA accepts one or a list. */
function targetedEntities(target: unknown): string[] {
  if (typeof target === "string") return [target];
  if (Array.isArray(target)) return target.filter((t): t is string => typeof t === "string");
  return [];
}

export class HomeAssistantClient {
  private baseUrl: string;
  private token: string;
  private skipTlsVerify: boolean;

  // Cache settings
  private cacheTTL: number = 10000; // 10 seconds default
  private allStatesCache: CacheEntry<EntityState[]> | null = null;
  private entityCache: Map<string, CacheEntry<EntityState>> = new Map();

  /**
   * @param exposure The entities the user exposed to Assist. When given, it
   *   bounds everything the tools can read and drive — the same bound Home
   *   Assistant's own agent puts on its tools. Omitted (or reporting "no
   *   opinion") leaves the client unfiltered.
   */
  constructor(
    config: Config,
    private readonly exposure?: AssistExposure
  ) {
    this.baseUrl = config.haUrl.replace(/\/$/, "");
    this.token = config.haToken;
    this.skipTlsVerify = config.haSkipTlsVerify;
  }

  /**
   * Refuses an entity the user has not exposed, before any request is made.
   *
   * Throwing beats returning an empty result: the tool handler turns it into a
   * message the model reads, so "not exposed" is said out loud instead of
   * looking like a device that is missing or broken.
   */
  private async requireExposed(...entityIds: string[]): Promise<void> {
    if (!this.exposure) return;
    for (const id of entityIds) {
      if (!(await this.exposure.allows(id))) throw new Error(notExposedMessage(id));
    }
  }

  /**
   * Check if cache entry is still valid
   */
  private isCacheValid<T>(entry: CacheEntry<T> | null | undefined): entry is CacheEntry<T> {
    if (!entry) return false;
    return Date.now() - entry.timestamp < this.cacheTTL;
  }

  /**
   * Invalidate all caches (call after service calls)
   */
  private invalidateCache(): void {
    this.allStatesCache = null;
    this.entityCache.clear();
  }

  private async fetch<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;

    const fetchOptions: RequestInit = {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    };

    // Handle self-signed certificates
    if (this.skipTlsVerify && url.startsWith("https://")) {
      const { Agent } = await import("undici");
      (fetchOptions as any).dispatcher = new Agent({
        connect: { rejectUnauthorized: false },
      });
    }

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HA API error ${response.status}: ${text}`);
    }

    return response.json() as Promise<T>;
  }

  private async fetchText(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<string> {
    const url = `${this.baseUrl}${endpoint}`;

    const fetchOptions: RequestInit = {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    };

    if (this.skipTlsVerify && url.startsWith("https://")) {
      const { Agent } = await import("undici");
      (fetchOptions as any).dispatcher = new Agent({
        connect: { rejectUnauthorized: false },
      });
    }

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HA API error ${response.status}: ${text}`);
    }

    return response.text();
  }

  /**
   * Get all states (cached)
   */
  private async getAllStatesCached(): Promise<EntityState[]> {
    if (this.isCacheValid(this.allStatesCache)) {
      return this.allStatesCache.data;
    }

    const states = await this.fetch<EntityState[]>("/api/states");
    this.allStatesCache = { data: states, timestamp: Date.now() };

    // Also populate individual entity cache
    for (const state of states) {
      this.entityCache.set(state.entity_id, { data: state, timestamp: Date.now() });
    }

    return states;
  }

  /**
   * Get state of a single entity (cached)
   */
  async getState(entityId: string): Promise<EntityState> {
    await this.requireExposed(entityId);

    // Check individual cache first
    const cached = this.entityCache.get(entityId);
    if (this.isCacheValid(cached)) {
      return cached.data;
    }

    // Check if we have a recent all-states cache
    if (this.isCacheValid(this.allStatesCache)) {
      const state = this.allStatesCache.data.find(s => s.entity_id === entityId);
      if (state) return state;
    }

    // Fetch individual entity
    const state = await this.fetch<EntityState>(`/api/states/${entityId}`);
    this.entityCache.set(entityId, { data: state, timestamp: Date.now() });
    return state;
  }

  /**
   * Get all entities, optionally filtered by domain (cached)
   */
  async getEntities(domain?: string): Promise<EntityState[]> {
    const states = await this.visibleStates();

    if (domain) {
      return states.filter((s) => s.entity_id.startsWith(`${domain}.`));
    }

    return states;
  }

  /** Every state the assistant may see — all of them when nothing is exposed. */
  private async visibleStates(): Promise<EntityState[]> {
    const states = await this.getAllStatesCached();
    return this.exposure ? this.exposure.filter(states) : states;
  }

  /**
   * Search entities by name or ID substring (cached)
   *
   * Both sides are accent-folded before comparing. An `entity_id` is ASCII by
   * construction, so a query in the user's own language ("garáž") could never
   * match the entity slugged from it ("garaz_dvere"), and a friendly name is
   * whatever the installer typed — sometimes accented, sometimes not, for the
   * same device. Folding makes the two spellings one.
   */
  async searchEntities(query: string): Promise<EntityState[]> {
    const needle = foldAccents(query);

    const states = await this.visibleStates();
    return states.filter((s) => {
      const name = (s.attributes.friendly_name as string) || "";
      return (
        foldAccents(s.entity_id).includes(needle) ||
        foldAccents(name).includes(needle)
      );
    });
  }

  /**
   * Call a Home Assistant service (invalidates cache)
   */
  async callService(
    domain: string,
    service: string,
    entityId?: string,
    data?: Record<string, unknown>
  ): Promise<EntityState[]> {
    const payload: Record<string, unknown> = { ...data };
    if (entityId) {
      payload.entity_id = entityId;
    }

    // Every entity this call would touch, whether named in `entityId` or
    // handed in through `data` — a model that has been told an entity is out of
    // scope will otherwise try the other door. Area and label targets are not
    // resolved here, so they are still as wide as the token allows.
    await this.requireExposed(...targetedEntities(payload.entity_id));

    const result = await this.fetch<EntityState[]>(`/api/services/${domain}/${service}`, {
      method: "POST",
      body: JSON.stringify(payload),
    });

    // Invalidate cache after service call since states may have changed
    this.invalidateCache();

    return result;
  }

  /**
   * Render a Jinja2 template via the HA template API.
   * Returns the rendered plain-text result (HA returns text/plain, not JSON).
   */
  async renderTemplate(template: string): Promise<string> {
    return this.fetchText("/api/template", {
      method: "POST",
      body: JSON.stringify({ template }),
    });
  }

  /**
   * Get historical states for an entity (not cached - historical data)
   */
  async getHistory(
    entityId: string,
    startTime?: string,
    endTime?: string
  ): Promise<HistoryEntry[]> {
    await this.requireExposed(entityId);

    const start = startTime || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    // URL-encode every interpolated value. The `+` in `+HH:MM` tz offsets is
    // otherwise decoded as a space in query strings by aiohttp (HA's HTTP
    // layer), producing "Invalid end_time" 400s for any LLM that includes
    // an explicit timezone offset in its history args.
    let endpoint = `/api/history/period/${encodeURIComponent(start)}?filter_entity_id=${encodeURIComponent(entityId)}`;

    if (endTime) {
      endpoint += `&end_time=${encodeURIComponent(endTime)}`;
    }

    const result = await this.fetch<HistoryEntry[][]>(endpoint);
    return result[0] || [];
  }
}

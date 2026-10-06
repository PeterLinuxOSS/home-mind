/**
 * `reasoning_effort`, sent only to models that accept it.
 *
 * One add-on setting serves every model, but non-reasoning models (GPT-4.1,
 * most local models) reject the parameter with a 400. Like the token cap, we
 * learn this from the endpoint on first use instead of keeping a name list.
 */

const rejectsReasoningEffort = new Set<string>();

export type ReasoningParam = { reasoning_effort?: "none" | "minimal" | "low" | "medium" | "high" };

/** True when a 400 names `reasoning_effort` as unsupported. */
export function isReasoningEffortUnsupported(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const err = error as { status?: number; param?: string; message?: string };
  if (err.status !== 400) return false;
  if (err.param === "reasoning_effort") return true;
  return typeof err.message === "string" && /reasoning[_. ]?effort/i.test(err.message);
}

export async function withReasoningEffort<T>(
  model: string,
  effort: ReasoningParam["reasoning_effort"],
  send: (param: ReasoningParam) => Promise<T>
): Promise<T> {
  if (!effort || rejectsReasoningEffort.has(model)) return send({});
  try {
    return await send({ reasoning_effort: effort });
  } catch (error) {
    if (!isReasoningEffortUnsupported(error)) throw error;
    rejectsReasoningEffort.add(model);
    console.info(`[llm] ${model} rejects reasoning_effort; sending without it from now on.`);
    return send({});
  }
}

/** Test seam — the learned set is process-global by design. */
export function resetReasoningEffortCache(): void {
  rejectsReasoningEffort.clear();
}

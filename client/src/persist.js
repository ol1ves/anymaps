// Persist command + deep merge (Task 3). Contract: CONTRACTS.md section 10
// (persistence keys + merge semantics), SPEC.md section 7.9.
//
// Exports:
//   deepMerge(target, partial)  — pure recursive merge; plain objects merge,
//                               everything else (arrays, primitives, null)
//                               replaces. Mutates and returns target; never
//                               mutates partial.
//   installPersist(ctx)         — returns the persistState(widgetId, partial)
//                               function the manager binds onto ctx. Also
//                               registers the "persist" command.
//   register(ctx)               — kept for the manager's feature-module list;
//                               calls installPersist and binds the result
//                               onto ctx.persistState, overriding the
//                               Task 2 baseline (do not edit manager.js).

const STATE_KEY = (widgetId) => "anymaps.state." + widgetId;

// Deep-merge `partial` into `target`. Plain objects recurse; arrays,
// primitives, and null replace. Returns target. Does not mutate partial.
export function deepMerge(target, partial) {
  for (const key of Object.keys(partial)) {
    const tv = target[key];
    const pv = partial[key];
    const bothPlain =
      pv && typeof pv === "object" && !Array.isArray(pv) &&
      tv && typeof tv === "object" && !Array.isArray(tv);
    if (bothPlain) {
      deepMerge(tv, pv);
    } else {
      target[key] = pv;
    }
  }
  return target;
}

// Returns the persistState function. The manager binds this onto ctx,
// overriding its baseline implementation.
export function installPersist(ctx) {
  function persistState(widgetId, partial) {
    if (!partial || typeof partial !== "object" || Array.isArray(partial)) {
      return ctx.getState(widgetId);
    }
    const cur = ctx.getState(widgetId) ?? {};
    deepMerge(cur, partial);
    // The manager holds the state object reference; reflect the merged value.
    try {
      localStorage.setItem(STATE_KEY(widgetId), JSON.stringify(cur));
    } catch (e) {
      console.error(e);
    }
    return cur;
  }

  // Register the "persist" command. The worker sends a partial state object;
  // the main thread deep-merges and writes localStorage. Never throws for a
  // JSON-safe partial.
  ctx.registerCommand("persist", (payload, widgetId) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("persist needs a state object");
    }
    persistState(widgetId, payload);
  });

  return persistState;
}

export function register(ctx) {
  // Override the Task 2 baseline ctx.persistState (do not edit manager.js).
  ctx.persistState = installPersist(ctx);
}

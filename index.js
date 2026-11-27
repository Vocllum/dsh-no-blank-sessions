export const name = 'no-blank-sessions';
export const inject = ['sessionController', 'sessionQuery', 'workspaceRegistry'];

const setupEvents = new Set([
  'agent-preset/selected', 'approval/policy', 'model/selection',
  'permission/preset', 'sandbox/mode', 'session/end-seed',
]);
const cordisOriginal = Symbol.for('cordis.original');

function hasUnusedHistory({ header, inheritedEventCount }, events) {
  return header.isSeeded === false && inheritedEventCount === 0
    && (header.delegationDepth ?? 0) === 0 && header.parentSession === undefined
    && header.origin === undefined && events.every(event => setupEvents.has(event.type));
}

export function apply(ctx) {
  const service = ctx.sessionController;
  const controller = service[cordisOriginal] ?? service;
  const agents = controller.commands?.agents;
  if (typeof controller.create !== 'function' || typeof agents?.isBlank !== 'function') {
    ctx.logger.warn(`${name}: unsupported Session Controller`);
    return;
  }

  const registry = ctx.workspaceRegistry;
  const nativeCreate = controller.create;
  const ownCreate = Object.getOwnPropertyDescriptor(controller, 'create');
  const nativeIsBlank = agents.isBlank;
  const pending = new Map();

  // rc.5 checks this predicate just before reusing a live session and again
  // under the writer lock after resuming a session from disk.
  function isBlank(session) {
    return nativeIsBlank.call(this, session) && !registry.pinnedSessionIds.includes(session.id)
      && hasUnusedHistory(session, session.snapshotEvents());
  }

  async function findDraft(workspace, { sessionId, agentPreset }) {
    const ids = workspace.sessionIds;
    const candidates = sessionId === undefined ? ids : [sessionId, ...ids.filter(id => id !== sessionId)];
    for (const id of candidates) {
      if (registry.archivedSessionIds.includes(id) || registry.pinnedSessionIds.includes(id)) continue;
      let observed;
      try {
        observed = await ctx.sessionQuery.observeSession(id, { projectionMode: 'none' });
        if (observed.header.cwd !== workspace.path || !hasUnusedHistory(observed, observed.events)) continue;
        const selection = observed.events.findLast(event => event.type === 'agent-preset/selected');
        const preset = selection?.data?.agentPreset ?? observed.header.agentPreset;
        if (agentPreset === undefined || preset === undefined || preset === agentPreset) return id;
      } catch {
        // A missing or unreadable history is ineligible for reuse.
      } finally {
        observed?.[Symbol.dispose]();
      }
    }
  }

  function create(request) {
    const { workspaceId, sessionId, cwd, agentPreset } = request;
    const call = this.ctx?.invocation;
    // Only the owner RPC can choose a different session from the one the
    // gateway authorized. Service calls and delegated RPCs choose their own IDs.
    if (!workspaceId || cwd !== undefined || call?.request?.namespace !== 'session'
      || call.request.method !== 'create' || call.peer?.principal?.kind !== 'owner') {
      return nativeCreate.call(this, request);
    }
    const workspace = registry.get(workspaceId);
    if (!workspace || (sessionId !== undefined && !workspace.sessionIds.includes(sessionId))) {
      return nativeCreate.call(this, request);
    }

    const key = JSON.stringify([workspaceId, agentPreset ?? null]);
    if (!pending.has(key)) {
      pending.set(key, findDraft(workspace, request)
        .then(draft => nativeCreate.call(this, { ...request, sessionId: draft }))
        .finally(() => pending.delete(key)));
    }
    return pending.get(key);
  }

  ctx.effect(() => {
    controller.create = create;
    agents.isBlank = isBlank;
    return () => {
      if (controller.create === create) {
        if (ownCreate) Object.defineProperty(controller, 'create', ownCreate);
        else delete controller.create;
      }
      if (agents.isBlank === isBlank) agents.isBlank = nativeIsBlank;
    };
  }, `${name}: workspace session reuse`);

  ctx.inject(['openvikingMemory'], memoryCtx => {
    const memory = memoryCtx.openvikingMemory;
    const runtime = memory[cordisOriginal] ?? memory;
    const initialize = runtime.initialize;
    if (typeof initialize !== 'function' || typeof runtime.stateFor !== 'function') return;

    function initializeOnUse(agent) {
      const session = agent?.session;
      if (agent?.status === 'idle' && typeof session?.snapshotEvents === 'function'
        && session.snapshotEvents().every(event => setupEvents.has(event.type) || event.type === 'session/title')) {
        const state = this.stateFor(session);
        // Capture-enabled runtimes may initialize during their shutdown commit.
        // In recall-only mode the first pre-step can initialize normally.
        if (state.config?.autoCapture === false || state.config?.syncTurns === false) {
          return Promise.resolve(state);
        }
      }
      return initialize.call(this, agent);
    }

    memoryCtx.effect(() => {
      runtime.initialize = initializeOnUse;
      return () => {
        if (runtime.initialize === initializeOnUse) runtime.initialize = initialize;
      };
    }, `${name}: defer OpenViking on unused sessions`);
  });
}

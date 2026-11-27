import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../index.js'

const owner = { ctx: { invocation: { request: { namespace: 'session', method: 'create' }, peer: { principal: { kind: 'owner' } } } } }

const setup = type => ({ type, data: {} })
const queued = (start, source, target = 'next-step') => ({
  type: 'agent/inbox/spliced',
  data: { target, start, inserted: [{ id: `m${start}`, role: 'user', content: [], source }] },
})
const cancelled = (start, removedCount, target = 'next-step') => ({
  type: 'agent/inbox/spliced',
  data: { target, start, removedCount, inserted: [], outcome: 'canceled' },
})

const base = ['permission/preset', 'sandbox/mode', 'approval/policy'].map(setup)

function session(id, events, header = {}) {
  return {
    id,
    header: { cwd: '/work', isSeeded: false, delegationDepth: 0, agentPreset: 'standard', ...header },
    events,
  }
}

// Runs the plugin's create() in front of a recording stand-in for the host's create().
async function pressNewSession(sessions, { named, pinned = [], archived = [], agentPreset, invocation = owner, requests = 1 } = {}) {
  const workspace = { id: 'w', path: '/work', sessionIds: sessions.map(({ id }) => id) }
  const byId = new Map(sessions.map(item => [item.id, item]))
  const hostCalls = []
  const controller = {
    commands: { agents: { isBlank: () => true } },
    create: request => { hostCalls.push(request); return request.sessionId ?? 'MINTED' },
  }
  const ctx = {
    sessionController: controller,
    workspaceRegistry: { get: id => (id === 'w' ? workspace : undefined), pinnedSessionIds: pinned, archivedSessionIds: archived },
    sessionQuery: {
      observeSession: async id => {
        const found = byId.get(id)
        if (found === undefined) throw new Error('missing')
        return { header: found.header, events: found.events, inheritedEventCount: 0, [Symbol.dispose]() {} }
      },
    },
    logger: { warn: () => {} },
    effect: install => install(),
    inject: () => {},
  }
  apply(ctx)
  const request = { workspaceId: 'w', sessionId: named, agentPreset }
  const results = await Promise.all(Array.from({ length: requests }, () => controller.create.call(invocation, request)))
  return { results, hostCalls, controller, registry: ctx.workspaceRegistry }
}

test('a session that only holds setup choices is reused', async () => {
  const { results } = await pressNewSession([session('s1', base)], { named: 's1' })
  assert.deepEqual(results, ['s1'])
})

test('queue entries that were queued and then cancelled do not make a session used', async () => {
  // The shape the OpenViking memory plugin leaves behind: its instructions are queued, then cancelled, twice.
  const memory = { kind: 'plugin-message', plugin: 'openviking-memory', form: 'instructions' }
  const events = [...base, queued(0, memory), cancelled(0, 1), setup('session/end-seed'), queued(0, memory), cancelled(0, 1)]
  const { results } = await pressNewSession([session('s1', events)], { named: 's1' })
  assert.deepEqual(results, ['s1'])
})

test('slash command records and the approval notices they queue do not make a session used', async () => {
  const events = [
    ...base,
    { type: 'command/run', data: { name: 'permission' } }, setup('permission/preset'), setup('sandbox/mode'),
    queued(0, { kind: 'user-approval' }), { type: 'command/done', data: { kind: 'ok' } },
    { type: 'command/run', data: { name: 'permission' } }, setup('permission/preset'),
    queued(1, { kind: 'user-approval' }), { type: 'command/done', data: { kind: 'ok' } },
    cancelled(0, 2),
  ]
  const { results } = await pressNewSession([session('s1', events)], { named: 's1' })
  assert.deepEqual(results, ['s1'])
})

test('a message that is still waiting in a queue means the session is about to be used', async () => {
  for (const target of ['next-step', 'next-turn']) {
    const events = [...base, queued(0, { kind: 'user-approval' }, target)]
    const { results } = await pressNewSession([session('s1', events)], { named: 's1' })
    assert.deepEqual(results, ['MINTED'], target)
  }
})

test('a queue shape the plugin does not understand is never treated as blank', async () => {
  const events = [...base, { type: 'agent/inbox/spliced', data: { target: 'somewhere-new', start: 0, inserted: [] } }]
  const { results } = await pressNewSession([session('s1', events)], { named: 's1' })
  assert.deepEqual(results, ['MINTED'])
})

test('a session with any real conversation is not reused', async () => {
  for (const type of ['turn/start', 'user/message', 'assistant/message', 'compaction/start']) {
    const { results } = await pressNewSession([session('s1', [...base, setup(type)])], { named: 's1' })
    assert.deepEqual(results, ['MINTED'], type)
  }
})

test('seeded, delegated and forked sessions are not reused', async () => {
  for (const header of [{ isSeeded: true }, { delegationDepth: 1 }, { parentSession: 'p' }, { origin: 'x' }]) {
    const { results } = await pressNewSession([session('s1', base, header)], { named: 's1' })
    assert.deepEqual(results, ['MINTED'], JSON.stringify(header))
  }
})

test('pinned, archived, other-folder and other-preset sessions are skipped, and the next blank one is used', async () => {
  const sessions = [session('pinned', base), session('archived', base), session('elsewhere', base, { cwd: '/other' }), session('other-preset', base, { agentPreset: 'creator' }), session('ok', base)]
  const { results } = await pressNewSession(sessions, { named: 'pinned', pinned: ['pinned'], archived: ['archived'], agentPreset: 'standard' })
  assert.deepEqual(results, ['ok'])
})

test('the client-named session is checked first, then the rest of the workspace', async () => {
  const used = session('used', [...base, setup('turn/start')])
  const { results } = await pressNewSession([used, session('blank', base)], { named: 'used' })
  assert.deepEqual(results, ['blank'])
})

test('simultaneous New Session requests share one lookup', async () => {
  const { results, hostCalls } = await pressNewSession([session('s1', base)], { named: 's1', requests: 3 })
  assert.deepEqual(results, ['s1', 's1', 's1'])
  assert.equal(hostCalls.length, 1)
})

test('requests that do not come from the owner are passed through untouched', async () => {
  const service = { ctx: { invocation: { request: { namespace: 'session', method: 'create' }, peer: { principal: { kind: 'service' } } } } }
  const { hostCalls } = await pressNewSession([session('s1', base)], { named: 'other-id', invocation: service })
  assert.deepEqual(hostCalls, [{ workspaceId: 'w', sessionId: 'other-id', agentPreset: undefined }])
})

test("DSH's own blank check is tightened the same way", async () => {
  const memory = { kind: 'plugin-message', plugin: 'openviking-memory', form: 'instructions' }
  const cleanQueue = [...base, queued(0, memory), cancelled(0, 1)]
  const { controller, registry } = await pressNewSession([session('s1', base)], { named: 's1' })
  const check = events => controller.commands.agents.isBlank.call({}, { ...session('x', events), inheritedEventCount: 0, snapshotEvents: () => events })
  assert.equal(check(cleanQueue), true)
  assert.equal(check([...base, queued(0, memory)]), false)
  assert.equal(check([...base, setup('turn/start')]), false)
  registry.pinnedSessionIds.push('x')
  assert.equal(check(cleanQueue), false)
})

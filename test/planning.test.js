// What planning a cycle's preset renders is allowed to cost.
//
// The defect behind these: at ~20,000 tasks planning built the whole list
// before handing any of it over, took a `_.cloneDeep` of the source entity
// per preset BEFORE deciding whether that preset had anything to do, and
// never yielded. On a live site with 273 reports of 57KB and 27 marks presets
// that was two minutes after a restart with the main thread at 100% of one
// core, nothing rendering, and HTTP and MCP unanswered — `mikser_ping` timed
// out for the whole of it. Nothing in the log measured it; the only evidence
// was the gap between two journal lines.
//
// So these pin the properties that keep a restart honest at that size: the
// plan streams into the dispatcher rather than accumulating, and no stretch
// of a cycle's pre-render work holds the event loop long enough for a request
// to notice.
//
// The work the budgets are measured against is made slow by the CLOCK, not by
// the machine — each `name()` call spins for a fixed millisecond — so a slow
// machine runs the same wall-clock work and the bounds mean the same thing
// there as here.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { assets } from '../lib/assets.js'
import { createHarness } from 'mikser-io/testing/harness.js'

// Roughly the weight of one skin-analysis report: a few hundred findings with
// coordinates and a verdict. Deep-copying this is what the old planner did
// once per preset per entity.
function heavyMeta(index) {
    return {
        findings: Array.from({ length: 120 }, (_, k) => ({
            id: `finding-${index}-${k}`,
            category: ['pigment', 'texture', 'redness'][k % 3],
            x: (index * 31 + k * 17) % 1024,
            y: (index * 13 + k * 29) % 1024,
            score: ((index + k) % 100) / 100,
            note: 'Observed at this frame and consistent with the preceding capture; '
                + 'no repeat reading is required for the report to stand.',
        })),
    }
}

// Spin, rather than sleep. A real preset's `name` reads config and builds a
// path; what matters here is that planning has CPU work per task that the
// event loop cannot interleave, which is the thing a yield has to break up.
function burn(ms) {
    const until = performance.now() + ms
    while (performance.now() < until) { /* hold the turn */ }
}

// The longest single stretch in which the loop got no turn at all. Measured
// as the overshoot of a repeating timer, which is what everything else
// waiting on this process — the HTTP server's accept, an MCP request, a
// watcher callback — is also waiting for.
function eventLoopLag(intervalMs = 10) {
    let worst = 0
    let last = performance.now()
    const timer = setInterval(() => {
        const now = performance.now()
        worst = Math.max(worst, now - last - intervalMs)
        last = now
    }, intervalMs)
    return {
        // The last stretch counts too. A block that is still running when the
        // measurement ends would otherwise go unseen — `clearInterval` drops
        // the delayed callback that was about to report it — and that is
        // precisely the shape of an unpaced walk, which is one block ending
        // exactly when the step does. Measured once against a planner with
        // its yield removed: the probe read 0ms for a 320ms block.
        stop() {
            clearInterval(timer)
            return Math.max(worst, performance.now() - last - intervalMs)
        },
    }
}

// A working folder with `presetCount` presets, all matching every one of
// `entityCount` file entities, driven as far as onBeforeRender.
//
// `renderEntities` is wrapped BEFORE the plugin is constructed, because the
// factory destructures it — a wrapper installed afterwards would never run.
//
// `fanOut: false` drops the preset entities from the journal once matching
// has used them, so the only thing left for onBeforeRender to do is plan.
// With them in, a changed preset fans out over the whole catalog first, and
// that walk would be what any measurement here actually measured.
async function withPlanningProject({ entityCount, presetCount, nameCostMs = 0, fanOut = false }, fn) {
    const workingFolder = await mkdtemp(path.join(tmpdir(), 'mikser-planning-'))
    try {
        await mkdir(path.join(workingFolder, 'presets'), { recursive: true })
        const presets = {}
        // `name` is the planner's own hook into each entity, called once per
        // entity per preset while planning — which is how a test can see how
        // far planning had got when a batch went out, and where the per-task
        // cost is injected.
        const namedWhilePlanning = []
        for (let p = 0; p < presetCount; p++) {
            const preset = `preset-${p}`
            await writeFile(path.join(workingFolder, 'presets', `${preset}.js`),
                'export const revision = 1\n'
                + "export const format = 'webp'\n"
                + 'export const options = {}\n'
                + 'export default () => {}\n')
            presets[preset] = {
                match: '/files/**',
                name: (entity) => {
                    namedWhilePlanning.push(entity.id)
                    if (nameCostMs) burn(nameCostMs)
                    return entity.name
                },
            }
        }

        const entities = Array.from({ length: entityCount }, (_, i) => ({
            id: `/files/frame-${i}.jpg`,
            name: `frame-${i}.jpg`,
            collection: 'files',
            type: 'file',
            checksum: `sum-${i}`,
            meta: heavyMeta(i),
        }))

        const h = createHarness({
            options: { workingFolder, outputFolder: path.join(workingFolder, 'out') },
            entities,
        })

        const dispatches = []
        const realRenderEntities = h.core.renderEntities
        h.core.renderEntities = async (tasks) => {
            dispatches.push({ size: tasks.length, namedSoFar: namedWhilePlanning.length })
            return realRenderEntities(tasks)
        }

        assets({ presets })(h.core)
        await h.runHook('loaded')
        await h.runHook('import')
        for (const entity of entities) {
            await h.addJournalEntry({ operation: h.constants.OPERATION.CREATE, entity })
        }
        await h.runHook('processed')
        if (!fanOut) {
            for (let i = h.journal.length - 1; i >= 0; i--) {
                if (h.journal[i].entity?.collection === 'presets') h.journal.splice(i, 1)
            }
        }
        // Only planning's own naming counts from here; matching did its own
        // round over the catalog above.
        namedWhilePlanning.length = 0

        return await fn({ h, entities, presets, dispatches, namedWhilePlanning })
    } finally {
        await rm(workingFolder, { recursive: true, force: true })
    }
}

describe('planning a cycle of preset renders', () => {
    it('leaves the event loop a turn often enough to stay answerable', async () => {
        // 300 tasks costing a millisecond each: a third of a second of
        // planning, which is nothing like the real thing but is long enough
        // that holding it in one piece would be felt. The budget is on the
        // longest BLOCK, not on the total — the whole step may legitimately
        // take minutes on a big site, but no single stretch of it may hold
        // the loop for longer than a request can wait.
        await withPlanningProject({ entityCount: 20, presetCount: 15, nameCostMs: 1 }, async ({ h }) => {
            const probe = eventLoopLag()
            // One turn before the measurement, so the probe's own first tick
            // is not counted as a block.
            await new Promise(resolve => setImmediate(resolve))
            await h.runHook('beforeRender')
            const worst = probe.stop()

            assert.equal(h.renderTasks.length, 300, 'every entity should have been planned for every preset')
            assert.ok(worst < 200,
                `planning blocked the event loop for ${worst.toFixed(0)}ms; nothing else in the `
                + 'process gets a turn while it does, so HTTP and MCP go unanswered for that long')
        })
    })

    it('keeps answering while a changed preset fans out over the catalog', async () => {
        // The other half of a restart's pre-render work, and the half that
        // took 32 seconds on a cold cache: every preset counts as changed, so
        // each one walks the whole catalog asking which presets take each
        // entity. Same budget, for the same reason.
        await withPlanningProject({ entityCount: 60, presetCount: 8, nameCostMs: 1, fanOut: true },
            async ({ h }) => {
                const probe = eventLoopLag()
                await new Promise(resolve => setImmediate(resolve))
                await h.runHook('beforeRender')
                const worst = probe.stop()

                assert.ok(h.renderTasks.length > 0, 'the fan-out should have scheduled the catalog')
                assert.ok(worst < 200,
                    `the changed-preset fan-out blocked the event loop for ${worst.toFixed(0)}ms`)
            })
    })

    it('hands the first tasks over before it has finished planning', async () => {
        await withPlanningProject({ entityCount: 400, presetCount: 15 }, async ({ h, dispatches }) => {
            await h.runHook('beforeRender')

            assert.ok(dispatches.length > 1,
                `planning dispatched ${dispatches.length} time(s) — the whole plan was built before `
                + 'anything was handed over, which is the single synchronous journal write this is here '
                + 'to prevent')
            assert.ok(dispatches[0].size < h.renderTasks.length,
                'the first dispatch carried the entire plan')
            // Planning kept naming entities after the first batch went out,
            // which is the streaming property stated as a fact about order
            // rather than about time.
            const last = dispatches[dispatches.length - 1]
            assert.ok(last.namedSoFar > dispatches[0].namedSoFar,
                'planning had already named every task before the first dispatch, so it did not stream')
        })
    })

    it('gives each preset its own task entity without copying the source', async () => {
        await withPlanningProject({ entityCount: 2, presetCount: 3 }, async ({ h, entities }) => {
            await h.runHook('beforeRender')

            const forFirst = h.renderTasks.filter(t => t.entity.id === entities[0].id)
            assert.equal(forFirst.length, 3)
            // Each task carries its own preset and destination...
            assert.equal(new Set(forFirst.map(t => t.entity.preset.name)).size, 3)
            assert.equal(new Set(forFirst.map(t => t.entity.destination)).size, 3)
            // ...on an object of its own, so one task's fields are not another's.
            assert.notEqual(forFirst[0].entity, forFirst[1].entity)
            // ...and the catalog entity it was planned from is untouched.
            assert.equal(entities[0].preset, undefined)
            assert.equal(entities[0].destination, undefined)
            // The meta is SHARED rather than deep-copied. That is the point:
            // `renderEntities` snapshots the task into the journal and the
            // render works on what comes back out, so there is no reference
            // left to alias through — and copying 57KB per preset to decide
            // nothing needs doing is what made a restart take minutes.
            assert.equal(forFirst[0].entity.meta, entities[0].meta)
        })
    })
})

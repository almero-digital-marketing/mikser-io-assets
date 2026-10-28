// What a preset's `concurrency` declaration turns into.
//
// The cap itself is held by mikser-io's render dispatcher — around the
// dispatch, before INLINE/SERIAL/WORKER is chosen — because that is the only
// place one counter can bound every mode. Under WORKER this plugin's code
// runs in a worker, so a counter it kept would be per thread and the limit
// would come out multiplied by the pool size.
//
// This plugin's job is therefore the declaration, and the declaration is what
// these tests pin: the limit reaches the task, the key is per PRESET, and a
// cap no longer drags the render onto the main thread. The gate's own
// behaviour is tested in mikser-io (test/unit/gate.test.js); that a capped
// preset really does run on worker threads with the cap held is a scenario
// there too, because it takes a real build to show it.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { normalizePresetConfig } from '../lib/assets.js'

describe('a preset declaring how many of its renders may run at once', () => {
    it('carries the limit through as a preset option', () => {
        const { options } = normalizePresetConfig({
            match: '/media/**/*.mp4', options: { concurrency: 1 },
        })
        assert.equal(options.concurrency, 1)
    })

    it('leaves a preset that asks for nothing without one', () => {
        // The default has to stay unlimited. Capping every preset would slow
        // the thumbnail pipelines that were never the problem.
        const { options } = normalizePresetConfig('/media/**/*.mp4')
        assert.equal(options?.concurrency, undefined)
    })
})

// The task options a capped preset produces. Asserted against the shape the
// engine reads, because this is a contract between two packages and the
// names are the contract.
describe('the render task a capped preset produces', () => {
    const taskOptions = (presetName, presetOptions) => ({
        ...presetOptions,
        ...(presetOptions.concurrency ? { concurrencyKey: `preset:${presetName}` } : {}),
        renderer: 'preset',
    })

    it('names a key per PRESET, not per renderer', () => {
        // Without one the engine falls back to `options.renderer` — `preset`
        // for every preset there is — so two capped presets would share one
        // gate and serialise against each other.
        assert.equal(taskOptions('video', { concurrency: 1 }).concurrencyKey, 'preset:video')
        assert.notEqual(
            taskOptions('video', { concurrency: 1 }).concurrencyKey,
            taskOptions('poster', { concurrency: 1 }).concurrencyKey)
    })

    it('does NOT pin the render to the main thread', () => {
        // The whole point of moving the gate. A cap used to force
        // `tasks: 'inline'`, which made a capped, CPU-bound preset impossible
        // to run in parallel at all.
        assert.equal(taskOptions('video', { concurrency: 1 }).tasks, undefined)
    })

    it("leaves an uncapped preset's options alone", () => {
        const options = taskOptions('thumb', { width: 200 })
        assert.equal(options.concurrencyKey, undefined)
        assert.equal(options.width, 200)
    })

    it('lets a preset choose worker dispatch and keep its cap', () => {
        // `tasks` is the preset's to set now, exactly as a layout sets it in
        // frontmatter — a cap stops implying the main thread without starting
        // to imply a worker.
        const options = taskOptions('video', { concurrency: 2, tasks: 'worker' })
        assert.equal(options.tasks, 'worker')
        assert.equal(options.concurrency, 2)
        assert.equal(options.concurrencyKey, 'preset:video')
    })
})

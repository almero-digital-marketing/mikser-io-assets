// How many of one preset's renders run at once.
//
// Preset renders are dispatched INLINE, and the engine runs those at
// `runtime.options.threads` — four by default. For a sharp resize that is
// right: the work is in-process and its memory is counted. For a preset that
// shells out to ffmpeg it is four external processes the engine never hears
// about. Reported: two of them at 476MB and 329MB RSS beside mikser's own
// 580MB, killing a 2GB container six times in twenty minutes.
//
// PEAK concurrency is the assertion, never the completed count — a gate that
// let everything through at once and then finished would satisfy any test
// that only counted completions.
//
// Each render HOLDS inside the preset until the test releases it, rather than
// awaiting a few turns and hoping. render() does its own mkdir and stat
// before calling the preset, so renders started in one tick arrive spread
// over several, and a peak measured without a barrier is a race: it read 3
// of 4 on the first run of this file.

import { describe, it, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { render, resetPresetGates, withGate } from '../lib/preset.js'

describe('a preset declaring how many of its renders may run at once', () => {
    let root
    beforeEach(async () => {
        resetPresetGates()
        root = await mkdtemp(path.join(tmpdir(), 'mikser-preset-gate-'))
    })
    after(async () => { await rm(root, { recursive: true, force: true }) })

    // Enough turns for every pending mkdir/stat to land, so "active" has
    // stopped growing by the time it is read.
    const settle = async (turns = 100) => {
        for (let i = 0; i < turns; i++) await new Promise(resolve => setImmediate(resolve))
    }

    // A preset that parks inside the gate until it is let go.
    function holdingPreset() {
        const seen = { active: 0, peak: 0, completed: 0 }
        let release
        const held = new Promise(resolve => { release = resolve })
        const preset = async () => {
            seen.active++
            seen.peak = Math.max(seen.peak, seen.active)
            await held
            seen.active--
            seen.completed++
        }
        return { seen, preset, release }
    }

    const start = (count, { name, concurrency, preset }) =>
        Array.from({ length: count }, (unused, index) => render({
            entity: {
                preset: { name },
                destination: path.join(root, name, `out-${index}.mp4`),
            },
            options: concurrency === undefined ? {} : { concurrency },
            runtime: { preset },
        }))

    it('runs one at a time when it asks for one', async () => {
        const { seen, preset, release } = holdingPreset()
        const all = start(6, { name: 'video', concurrency: 1, preset })
        await settle()
        assert.equal(seen.peak, 1, `${seen.peak} ran at once`)
        release()
        await Promise.all(all)
        assert.equal(seen.completed, 6, 'every render still ran')
        assert.equal(seen.peak, 1, 'and the cap held as the queue drained')
    })

    it('runs two at a time when it asks for two', async () => {
        const { seen, preset, release } = holdingPreset()
        const all = start(6, { name: 'video', concurrency: 2, preset })
        await settle()
        assert.equal(seen.peak, 2, `${seen.peak} ran at once`)
        release()
        await Promise.all(all)
        assert.equal(seen.completed, 6)
        assert.equal(seen.peak, 2)
    })

    it('leaves a preset that asks for nothing exactly as it was', async () => {
        // The default has to stay unlimited. Capping every preset would slow
        // the thumbnail pipelines that were never the problem.
        const { seen, preset, release } = holdingPreset()
        const all = start(6, { name: 'thumb', preset })
        await settle()
        assert.equal(seen.peak, 6, 'an undeclared preset must not be throttled')
        release()
        await Promise.all(all)
    })

    it("does not let one preset's cap slow another", async () => {
        const video = holdingPreset()
        const thumb = holdingPreset()
        const all = [
            ...start(4, { name: 'video', concurrency: 1, preset: video.preset }),
            ...start(4, { name: 'thumb', preset: thumb.preset }),
        ]
        await settle()
        assert.equal(video.seen.peak, 1)
        assert.equal(thumb.seen.peak, 4, 'an uncapped preset waited behind a capped one')
        video.release()
        thumb.release()
        await Promise.all(all)
    })

    it('keeps a separate cap per preset, not one shared between them', async () => {
        // Two heavy presets in one build is the ordinary case — a video
        // preset and a poster-frame preset over the same files. A single
        // shared gate would serialise them against each other and, because
        // the gate is rebuilt whenever the limit differs, lose track of who
        // is running.
        const video = holdingPreset()
        const audio = holdingPreset()
        const all = [
            ...start(4, { name: 'video', concurrency: 1, preset: video.preset }),
            ...start(4, { name: 'audio', concurrency: 2, preset: audio.preset }),
        ]
        await settle()
        assert.equal(video.seen.peak, 1, `video ran ${video.seen.peak} at once under a cap of 1`)
        assert.equal(audio.seen.peak, 2, `audio ran ${audio.seen.peak} at once under a cap of 2`)
        video.release()
        audio.release()
        await Promise.all(all)
        assert.equal(video.seen.completed, 4)
        assert.equal(audio.seen.completed, 4)
    })

    it('releases the slot when a render throws', async () => {
        // The failure that turns a cap into a deadlock: a preset that throws
        // while holding the slot and never gives it back. The engine would
        // then stop rendering that preset for the rest of the build.
        let started = 0
        const preset = async () => {
            started++
            await new Promise(resolve => setImmediate(resolve))
            throw new Error('ffmpeg exited 1')
        }
        const results = await Promise.allSettled(start(3, { name: 'video', concurrency: 1, preset }))
        assert.equal(started, 3, 'a throw held the slot and blocked the ones behind it')
        assert.ok(results.every(r => r.status === 'rejected'), 'the failures must still surface')
    })

    it('ignores a cap that is not a positive whole number', async () => {
        for (const concurrency of [0, -1, 1.5, 'two', null]) {
            resetPresetGates()
            const { seen, preset, release } = holdingPreset()
            const all = start(4, { name: 'video', concurrency, preset })
            await settle()
            assert.equal(seen.peak, 4, `concurrency ${JSON.stringify(concurrency)} must not gate`)
            release()
            await Promise.all(all)
        }
    })

    it('drains a queue much longer than the cap', async () => {
        const { seen, preset, release } = holdingPreset()
        const all = start(25, { name: 'video', concurrency: 3, preset })
        await settle()
        assert.equal(seen.peak, 3)
        release()
        await Promise.all(all)
        assert.equal(seen.completed, 25, 'the gate stopped handing out slots')
        assert.equal(seen.peak, 3, 'and never exceeded the cap while draining')
    })
})

// The gate itself, with the mkdir and stat that render() performs first taken
// out of the way. They put a macrotask between each caller and the gate, which
// is long enough to hide the one ordering that matters here.
describe('the gate, when a slot is freed and taken before the waiter resumes', () => {
    beforeEach(() => resetPresetGates())

    it('re-checks instead of assuming the freed slot is still free', async () => {
        // Waking a waiter means a slot WAS free, not that it still is. A
        // caller arriving in the microtask window between the release and the
        // waiter resuming takes it first, and a waiter that does not look
        // again puts the gate one over its limit — which on a 2GB container
        // is one ffmpeg more than fits.
        const seen = { active: 0, peak: 0 }
        const hold = (until) => async () => {
            seen.active++
            seen.peak = Math.max(seen.peak, seen.active)
            await until
            seen.active--
        }
        let releaseFirst, releaseRest
        const first = new Promise(resolve => { releaseFirst = resolve })
        const rest = new Promise(resolve => { releaseRest = resolve })

        const running = [withGate('video', 1, hold(first))]
        await Promise.resolve()
        // Parked: the gate is full.
        running.push(withGate('video', 1, hold(rest)))

        // Free the slot, then walk the microtask queue forward one turn at a
        // time, starting a fresh caller at each step. One of those steps is
        // the window between the waiter being woken and the waiter resuming.
        releaseFirst()
        for (let turn = 0; turn < 6; turn++) {
            await Promise.resolve()
            running.push(withGate('video', 1, hold(rest)))
        }
        await Promise.resolve()

        assert.equal(seen.peak, 1, `${seen.peak} ran at once under a cap of 1`)
        releaseRest()
        await Promise.all(running)
    })
})

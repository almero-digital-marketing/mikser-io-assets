// A moved preset re-renders its own derivatives and nobody else's.
//
// Forcing was decided per ENTITY: `rendererChanged` held entity ids, so a
// single bumped preset meant "everything about this source moved" and every
// preset it matched was redrawn. On gpoint-premium that turned
// `--render-presets marks-pigmentation-left` — 12 sources — into 322 renders,
// all 27 marks presets of each report rewritten within the same minute; and
// bumping twelve side presets' revisions queued ~13,000 tasks instead of
// ~3,200, which is hours of drawing.
//
// Both paths that force are covered here, because they fill the same
// structure from opposite directions: a preset whose `revision` moved fans
// out over the catalog, and `--render-presets` walks it for the names asked
// for.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { assets } from '../lib/assets.js'
import { createHarness } from 'mikser-io/testing/harness.js'

const SOURCE = {
    id: '/files/media/hero.jpg',
    name: 'media/hero.jpg',
    collection: 'files',
    type: 'file',
    checksum: 'source-checksum-1',
    meta: {},
}

const presetModule = (revision) =>
    `export const revision = ${revision}\n`
    + "export const format = 'webp'\n"
    + 'export const options = {}\n'
    + 'export default () => {}\n'

// A project with presets `a` and `b`, both covering one source, both already
// derived: the derivative and its completed-render marker are on disk at
// revision 1, which is what makes a reuse decision possible at all.
//
// `onDisk` is what the MODULES export now; `inCatalog` is the revision the
// catalog remembers. A preset has moved when the two disagree — that is what
// `notePresetChange` compares, and it is the only way to have one preset move
// while its neighbour stays put.
async function withDerivedProject({ onDisk, inCatalog, unmarked = [], manifested = [], remembered = true, runOptions = {} }, fn) {
    const workingFolder = await mkdtemp(path.join(tmpdir(), 'mikser-forced-'))
    try {
        await mkdir(path.join(workingFolder, 'presets'), { recursive: true })
        for (const [name, revision] of Object.entries(onDisk)) {
            await writeFile(path.join(workingFolder, 'presets', `${name}.js`), presetModule(revision))
        }

        const match = '/files/media/**'
        const assetsFolder = path.join(workingFolder, 'assets')
        const derivative = (preset) => path.join(assetsFolder, preset, 'media', 'hero.webp')
        for (const [name, revision] of Object.entries(inCatalog)) {
            await mkdir(path.dirname(derivative(name)), { recursive: true })
            await writeFile(derivative(name), 'already derived')
            // `unmarked`: the derivative is there and its marker is not —
            // a render killed between writing the file and claiming it.
            if (unmarked.includes(name)) continue
            // `<destination>.<revision>.md5`, holding the SOURCE checksum —
            // the shape onComplete writes and isPresetRendered reads.
            await writeFile(`${derivative(name)}.${revision}.md5`, SOURCE.checksum, 'utf8')
        }

        const h = createHarness({
            options: { workingFolder, outputFolder: path.join(workingFolder, 'out'), ...runOptions },
            entities: [
                SOURCE,
                // The catalog's record of each preset. `notePresetChange`
                // compares against these; without them every preset reads as
                // new and all of them would be forced, which is the state
                // this test has to be able to tell apart from the bug.
                // `remembered: false` is what the catalog looks like after a
                // WIPE: the derivatives and their markers are on disk, and
                // nothing in the catalog has heard of the presets that made
                // them.
                ...(remembered ? Object.entries(inCatalog).map(([name, checksum]) => ({
                    id: `/presets/${name}`, name, collection: 'presets', type: 'preset',
                    checksum, matches: [match],
                })) : []),
            ],
        })

        // The snapshots the unfinished sweep reads. Only the destinations a
        // test asks for, because the sweep's question is "did the manifest
        // record this output and is its marker gone".
        if (manifested.length) {
            h.runtime.manifest = {
                all: () => manifested.map(name => ({ id: SOURCE.id, destination: derivative(name) })),
            }
        }

        assets({ presets: Object.fromEntries(Object.keys(onDisk).map(name => [name, { match }])) })(h.core)
        await h.runHook('loaded')
        await h.runHook('import')
        await h.runHook('beforeRender')

        const taskFor = (preset) => h.renderTasks.find(t => t.entity.preset?.name === preset)
        return await fn({ h, taskFor, derivative })
    } finally {
        await rm(workingFolder, { recursive: true, force: true })
    }
}

describe('a preset whose revision moved', () => {
    it('re-renders its own derivative and reuses every other preset of the same source', async () => {
        await withDerivedProject({
            onDisk:    { a: 2, b: 1 },   // a's module was bumped
            inCatalog: { a: 1, b: 1 },
        }, ({ h, taskFor }) => {
            assert.equal(h.renderTasks.length, 2, 'both presets should still be journalled')

            const a = taskFor('a')
            assert.equal(a.options.rendererChanged, true, "the moved preset's derivative must be re-rendered")
            assert.equal(a.options.ignore, false)

            const b = taskFor('b')
            assert.equal(b.options.rendererChanged, false,
                'b did not move — forcing it is the defect: one bumped preset redrawing all 27')
            assert.equal(b.options.ignore, true, "b's marker is current, so its derivative is reused")
        })
    })

    it('names the markers its render invalidates and deletes none of them yet', async () => {
        // Planning decides; it does not render. A marker removed on the
        // decision is lost even when the task is then dropped — and the shape
        // that leaves behind is the worst available: derivatives intact,
        // nothing claiming them, every later build re-deriving all of them.
        await withDerivedProject({
            onDisk:    { a: 2, b: 1 },
            inCatalog: { a: 1, b: 1 },
        }, async ({ h, taskFor, derivative }) => {
            const { existsSync } = await import('node:fs')
            assert.equal(existsSync(`${derivative('a')}.1.md5`), true,
                'planning deleted a marker; only a render may do that')
            assert.equal(existsSync(`${derivative('b')}.1.md5`), true,
                "b's marker was removed for a render b did not need")

            assert.deepEqual(taskFor('a').options.presetMarkers, [`${derivative('a')}.1.md5`],
                "a is being re-derived, so its render must clear a's stale marker")
            assert.equal(taskFor('b').options.presetMarkers, undefined,
                'b is reused — there is nothing for it to invalidate')
        })
    })

    it('clears them when the render actually runs', async () => {
        await withDerivedProject({
            onDisk:    { a: 2, b: 1 },
            inCatalog: { a: 1, b: 1 },
        }, async ({ taskFor, derivative }) => {
            const { existsSync } = await import('node:fs')
            const { render } = await import('../lib/preset.js')
            const task = taskFor('a')
            await render({
                entity: task.entity,
                options: task.options,
                runtime: { preset: async () => {} },
            })
            assert.equal(existsSync(`${derivative('a')}.1.md5`), false,
                'the render ran, so the claim it invalidated must be gone')
            assert.equal(existsSync(`${derivative('b')}.1.md5`), true,
                "and only that one — b's render never ran")
        })
    })
})

describe('--render-presets <name>', () => {
    it('forces only the presets it names', async () => {
        await withDerivedProject({
            onDisk:    { a: 1, b: 1 },   // nothing moved on its own
            inCatalog: { a: 1, b: 1 },
            runOptions: { renderPresets: 'a' },
        }, ({ h, taskFor }) => {
            assert.equal(h.renderTasks.length, 2)
            assert.equal(taskFor('a').options.rendererChanged, true)
            assert.equal(taskFor('a').options.ignore, false)
            assert.equal(taskFor('b').options.rendererChanged, false,
                '--render-presets a asked for a; b was redrawn because forcing was per source')
            assert.equal(taskFor('b').options.ignore, true)
        })
    })

    it('counts derivatives, not just sources, when it says what it will do', async () => {
        // "12 source(s)" was true and useless: it was followed by 322 renders
        // and the line gave a reader no way to see that.
        await withDerivedProject({
            onDisk:    { a: 1, b: 1 },
            inCatalog: { a: 1, b: 1 },
            runOptions: { renderPresets: 'a' },
        }, ({ h }) => {
            const line = h.logs.find(l => String(l.args[0]).includes('Presets re-rendering'))
            assert.ok(line, 'expected a line naming what will be re-rendered')
            const rendered = line.args.slice(1)
            assert.deepEqual(rendered, ['a', 1, 1], 'one derivative across one source')
        })
    })

    it('forces every preset when asked for all of them', async () => {
        // `--render-presets` with no name still means all of them.
        await withDerivedProject({
            onDisk:    { a: 1, b: 1 },
            inCatalog: { a: 1, b: 1 },
            runOptions: { renderPresets: true },
        }, ({ taskFor }) => {
            assert.equal(taskFor('a').options.rendererChanged, true)
            assert.equal(taskFor('b').options.rendererChanged, true)
        })
    })
})

describe('a derivative left without a completed-render marker', () => {
    it('re-derives every damaged preset of the source, and only those', async () => {
        // An interrupted cycle can leave more than one of an entity's
        // derivatives unclaimed, and the sweep used to key them by entity —
        // so the later ones overwrote the earlier. That cost nothing while
        // one entry forced the whole entity; it would drop them now that each
        // entry speaks only for its own preset.
        await withDerivedProject({
            onDisk:     { a: 1, b: 1, c: 1 },
            inCatalog:  { a: 1, b: 1, c: 1 },
            unmarked:   ['a', 'b'],
            manifested: ['a', 'b', 'c'],
        }, ({ h, taskFor }) => {
            assert.equal(h.renderTasks.length, 3)
            assert.equal(taskFor('a').options.rendererChanged, true, 'a is damaged')
            assert.equal(taskFor('b').options.rendererChanged, true,
                'b is damaged too, and was dropped when the sweep kept one entry per entity')
            assert.equal(taskFor('c').options.rendererChanged, false,
                'c is claimed by a current marker; a half-written a says nothing about it')
            assert.equal(taskFor('c').options.ignore, true)
        })
    })

    it('names every damaged derivative in the warning', async () => {
        await withDerivedProject({
            onDisk:     { a: 1, b: 1, c: 1 },
            inCatalog:  { a: 1, b: 1, c: 1 },
            unmarked:   ['a', 'b'],
            manifested: ['a', 'b', 'c'],
        }, ({ h }) => {
            const warned = h.logs.find(l => l.args[0]?.code === 'preset-unfinished')
            assert.ok(warned, 'expected a preset-unfinished warning')
            assert.equal(warned.args[0].derivatives.length, 2)
            assert.equal(warned.args[1 + 1], 2, 'the count must match the list')
        })
    })
})

describe('a preset the catalog does not remember', () => {
    it('is still scheduled, so its sources are reached at all', async () => {
        // The fan-out is the only thing that reaches these entities: their
        // sources did not change, so nothing journalled them. Drop the
        // scheduling and a preset dropped into presets/ while watching
        // produces nothing until something else happens to touch its sources.
        await withDerivedProject({
            onDisk:    { a: 1, b: 1 },
            inCatalog: { a: 1, b: 1 },
            remembered: false,
        }, ({ h }) => {
            assert.equal(h.renderTasks.length, 2,
                'nothing reached the sources, so the presets covering them were never considered')
        })
    })

    it('is not treated as having moved', async () => {
        // The live incident. An absent prior is what a wiped catalog looks
        // like, not evidence that a preset changed — and reading it as the
        // latter re-rendered every derivative on the site past a marker
        // nobody consulted.
        await withDerivedProject({
            onDisk:    { a: 1, b: 1 },
            inCatalog: { a: 1, b: 1 },
            remembered: false,
        }, ({ taskFor }) => {
            for (const name of ['a', 'b']) {
                assert.equal(taskFor(name).options.rendererChanged, false,
                    `${name} was forced because the catalog had forgotten it`)
                assert.equal(taskFor(name).options.ignore, true,
                    `${name}'s marker is current and its derivative is on disk`)
            }
        })
    })
})

import {
    reportEvaluated, countEntities, cliOption, isFullCycle, outputMissing,
    registerSourceChecksum, formatDuration,
} from 'mikser-io'
import path from 'node:path'
import { mkdir, writeFile, unlink, rm, readFile, symlink, } from 'fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { globby } from 'globby'
import map from 'p-map'


// Normalize a `options.presets[name]` value to a consistent
// { matches, options } shape so callers don't have to inspect which form
// the config used.
//
// Two formats supported, detected from the value shape:
//
//   // 1. Existing — string or array of match patterns:
//   presets: {
//       'thumbnail': '@/images/*',
//       'small-image': ['/files/images/*.jpg', '/resources/**/*.jpg'],
//   }
//
//   // 2. New — object with `match` and per-preset `options`:
//   presets: {
//       'medium-image': {
//           match: '/files/images/*.jpg',
//           options: { width: 800, height: 600, quality: 80 },
//       },
//   }
//
// Options merge over the preset module's own `options` export at render
// time — module-side defaults, config-side overrides.
//
// Caveat: changing config-side options does NOT automatically invalidate
// already-rendered assets on disk. Bump the preset's `revision` export
// to force a re-render, or run `mikser --clear` to start fresh.
//
// The object form also takes `name`: a function from a source entity to the
// path its derivative is filed under, in place of the source's own name.
// `null` when the form has none.
export function normalizePresetConfig(value) {
    if (value == null) return { matches: [], options: {}, name: null }
    if (typeof value === 'string') return { matches: [value], options: {}, name: null }
    if (Array.isArray(value))      return { matches: value, options: {}, name: null }
    if (typeof value === 'object' && ('match' in value || 'options' in value || 'name' in value)) {
        const m = value.match
        return {
            matches: Array.isArray(m) ? m : (m == null ? [] : [m]),
            options: value.options ?? {},
            name: typeof value.name === 'function' ? value.name : null,
        }
    }
    // Fallback — treat the value itself as a single match pattern
    // (object literal with a custom matcher, or a function).
    return { matches: [value], options: {}, name: null }
}

// Deployed URL for a preset derivative of a source entity (ADR-0011).
// Mirrors renderPresets' destination: <assetsFolder>/<preset>/<name>, with
// the extension swapped to the preset's `format` (absent → keep the source
// extension). `assetsFolder` is the served root for derivatives ('assets',
// or '<outputFolder>/assets'). `changeExtension` is passed in so this stays
// a pure, engine-free helper. Base-relative — a render target prefixes the
// origin; a same-origin consumer uses it as-is.
export function presetUrl({ assetsFolder, preset, name, format, changeExtension }) {
    const destination = format ? changeExtension(name, format) : name
    return '/' + path.posix.join(assetsFolder, preset, destination)
}

// A step slower than this says so at info; anything quicker is debug.
//
// Every step below can exceed a second on a catalog of any size, and until
// now none of them was timed: the only evidence that a restart spent two
// minutes planning was the gap between two journal lines, which no log level
// would have explained.
const SLOW_STEP_MS = 1000

// How many planned tasks go to the dispatcher at a time.
//
// Planning used to build the WHOLE task list and hand it over in one call.
// At 20,000 tasks that made `renderEntities` a single synchronous sqlite
// transaction — tens of seconds in which nothing rendered, nothing answered
// HTTP and `mikser_ping` timed out — and the list itself was held in memory
// until the last entity had been planned.
//
// Batched, each transaction is small enough to sit between two turns of the
// event loop, and the first tasks are journalled while the rest are still
// being planned.
const DISPATCH_BATCH = 250

// setImmediate, not a resolved promise.
//
// Awaiting a microtask drains the microtask queue and comes back in the SAME
// turn: timers, I/O callbacks and the HTTP server's accept never run, so the
// process stays exactly as unresponsive as it was. Only a macrotask gives
// them a turn, which is the whole difference between a build that is busy
// and a build that looks hung.
const yieldToEventLoop = () => new Promise(resolve => setImmediate(resolve))

// The most this plugin will hold the event loop between turns, end to end.
//
// Time, not a step count. The per-step cost of the walks below differs by
// orders of magnitude between a catalog of small files and one of large
// documents, and between a preset that matches one pattern and one that
// matches twelve — so a count that paces one of them correctly starves
// another. What a waiting request feels is the milliseconds, so that is what
// is counted.
const LAG_BUDGET_MS = 150

// How many of this plugin's journal callbacks run at once.
//
// It divides the budget, and that is not a detail. Every one of those
// callbacks can start a catalog-wide fan-out, and when they all come back
// from a yield they resume in the SAME turn of the loop — node drains the
// whole immediate queue in one check phase — so each one's quantum adds to
// the same block. Ten walks each holding 50ms is half a second in which the
// loop never ran, which is exactly what was measured before this was divided
// rather than assumed.
const PROVISION_CONCURRENCY = 10

// What one walk may hold before giving the loop a turn.
const YIELD_AFTER_MS = Math.max(5, Math.floor(LAG_BUDGET_MS / PROVISION_CONCURRENCY))

// Every walk here is O(catalog) or O(catalog x presets), and a long one that
// never yields is indistinguishable from a hang: the HTTP server does not
// accept, MCP does not answer, and the only outward sign of life is a core at
// 100%.
//
// ONE clock for the process, not one per walk. These walks run concurrently
// — the provision journal is mapped at PROVISION_CONCURRENCY, so that many
// changed-preset fan-outs share the event loop — and a per-walk clock lets
// each of them hold a full quantum before yielding. Measured at ten walks of
// 50ms: a 440ms block in which the loop still never ran, which is the thing
// being prevented. What has to be bounded is the time since the LOOP last had
// a turn, and that is one number.
//
// Yielding more often than necessary is free; a `setImmediate` costs
// microseconds and the walk resumes on the next turn either way.
let lastYield = Date.now()
async function pace() {
    if (Date.now() - lastYield < YIELD_AFTER_MS) return
    await yieldToEventLoop()
    lastYield = Date.now()
}

export function assets(options = {}) {
    return ({
        runtime,
        onLoaded,
        useLogger,
        onImport,
        watch,
        onProcessed,
        onBeforeRender,
        useJournal,
        createEntity,
        updateEntity,
        deleteEntity,
        renderEntities,
        onComplete,
        onSync,
        onFinalize,
        findEntity,
        iterateEntities,
        matchEntity,
        changeExtension,
        constants: { ACTION, OPERATION },
    }) => {
    // Declared HERE, not in core.
    //
    // Everything this flag does happens in this plugin, and core carried it
    // only because a plugin could not declare an option until 9.100.0. The
    // cost of that was a flag a build could accept with nothing loaded to act
    // on it: passed, ignored, and reported afterwards by a `render-presets-
    // unhandled` guard in the engine. Declared here, a config without assets()
    // simply does not have the option, so the mistake is refused by name
    // before anything is built rather than explained after.
    // The folders this plugin owns, on the command line.
    //
    // They were config-only, because a plugin could not declare an option
    // before 9.100.0 — so overriding one for a single run meant editing the
    // config, which is the file whose checksum decides whether the whole
    // catalog is still valid. A flag is the difference between "try this
    // once" and "invalidate everything".
    //
    // CLI beats config beats default, which is the order every other option
    // here already follows.
    cliOption('--assets <folder>',
        'folder for derived assets, relative to the working folder (default: assets)')
    cliOption('--presets <folder>',
        'folder holding the preset modules, relative to the working folder (default: presets)')
    cliOption('--render-presets [name]',
        're-render preset derivatives whose sources and revisions are unchanged; '
        + 'with a name, only that preset')

    const collection = 'presets'
    const type = 'preset'
    const checksumMap = new Set()
    // Every marker on disk, indexed by the derivative it claims. Built beside
    // checksumMap so forgetting a derivative's markers costs a lookup rather
    // than a scan — this runs once per entity that renders, and a directory
    // walk per entity is quadratic on an assets tree of any size.
    const markersByDestination = new Map()

    // A preset that matches nothing builds green and says nothing, which is
    // how a mistyped pattern ships. `files({ outputFolder })` prefixes `name`
    // and `meta.url` but NOT `id`, and `match` runs against `id` — so
    // '/files/media/devices/**' looks right and matches zero. Tallied here,
    // reported once per process at onFinalize.
    const matchTally = { evaluated: 0, matched: new Set(), reported: false }

    // Which presets select this entity. No counters, no side effects.
    //
    // Split out because the same question gets asked twice for different
    // reasons: once as files enter the catalog, where the answer drives the
    // render and feeds the unmatched-preset tally, and once after the cycle to
    // explain a derivative that is not there. The second must not move the
    // counters the first reports on.
    //
    // `some`, not a push per matching pattern. Two patterns that both cover a
    // file used to name their preset twice in the list; the second render was
    // gated by the checksum, so nothing rendered twice — but "which presets
    // cover this file" is a question with one answer, and the explainer below
    // puts that answer in front of a reader.
    function presetsSelecting(entity) {
        return Object.keys(options.presets || {}).filter(preset => presetTakes(entity, preset))
    }

    // `match` selects; a preset that names its derivatives may still decline
    // an entity by naming it nothing — the source a newer one has replaced,
    // a frame the site does not show.
    function presetTakes(entity, preset) {
        const { matches, name } = normalizePresetConfig(options.presets[preset])
        if (!matches.some(match => matchEntity(entity, match))) return false
        return !name || derivativeName(entity, preset) !== null
    }

    // The path a derivative is filed under in its preset's folder, before the
    // preset's format is applied.
    //
    // The source's own name unless the preset's config supplies `name`, for a
    // derivative whose address must not be its source's: a file named by
    // something private, served under a name that is not. Every place that
    // turns a source into a derivative path asks here — the URL stamped on
    // the source, the render destination, and the reverse walk from a
    // derivative to its source — because one of them reading `entity.name`
    // on its own is a derivative the orphan sweep cannot find a source for,
    // and deletes.
    function derivativeName(entity, preset) {
        const { name } = normalizePresetConfig(options.presets?.[preset])
        if (!name) return entity.name
        const named = name(entity)
        return typeof named === 'string' && named ? named.replace(/^\/+/, '') : null
    }

    async function getEntityPresets(entity) {
        matchTally.evaluated++
        const selected = presetsSelecting(entity)
        for (const preset of selected) matchTally.matched.add(preset)
        return selected
    }

    // Why a linked derivative is not in the output.
    //
    // The engine detects the CONSEQUENCE — it knows what the output points at
    // and what exists on disk — but it cannot name the cause, because whether
    // a preset covers a file is decided by `match` against the entity id and
    // none of that is visible from a url. So one sentence covered a mistyped
    // preset name, a preset that did not run, and a file no preset was ever
    // asked to cover. The last is the common one, the only one whose fix is in
    // the config rather than in the template, and the one the reader is least
    // likely to guess.
    //
    // Answered here rather than in the helper: `asset()` takes a path, not an
    // entity, and it is the hottest call in a render. Nothing is looked up
    // when the url is built. This runs at most a handful of times, after
    // everything has settled, and only when something is already wrong.
    // A derivative wears the PRESET's extension, so a source is found by stem:
    // `media/hero.webp` came from `media/hero.jpg`.
    const stemOf = (value) => value.slice(0, value.length - path.extname(value).length)

    // Derivative stem -> the sources that produce it, built once per cycle.
    //
    // Two callers ask the same question from opposite directions — "why is
    // this derivative missing" and "does this derivative still have a source"
    // — so they share one index rather than each walking the catalog.
    //
    // A preset that does not name its derivatives files them under the
    // source's own name, so one index keyed by that answers for all of them.
    // Each preset that does gets its own, keyed by what its `name` returned.
    let sourceIndex = null
    let sourceIndexCycle
    async function sourcesByDerivative() {
        const cycle = runtime.state?.cycle?.id ?? null
        if (sourceIndexCycle !== cycle) { sourceIndex = null; sourceIndexCycle = cycle }
        if (!sourceIndex) {
            const naming = Object.keys(options.presets || {})
                .filter(preset => normalizePresetConfig(options.presets[preset]).name)
            sourceIndex = { byName: new Map(), byPreset: new Map(naming.map(preset => [preset, new Map()])) }
            const add = (index, key, candidate) => {
                if (!index.has(key)) index.set(key, [])
                index.get(key).push(candidate)
            }
            for await (const candidate of iterateEntities({ collection: { $ne: collection } })) {
                if (typeof candidate.name === 'string') add(sourceIndex.byName, stemOf(candidate.name), candidate)
                for (const preset of naming) {
                    if (!presetTakes(candidate, preset)) continue
                    add(sourceIndex.byPreset.get(preset), stemOf(derivativeName(candidate, preset)), candidate)
                }
            }
        }
        return sourceIndex
    }

    // The sources a derivative of `preset` filed as `name` can have come from.
    async function sourcesOf(preset, name) {
        const index = await sourcesByDerivative()
        return (index.byPreset.get(preset) ?? index.byName).get(stemOf(name)) ?? []
    }

    const namesItsOwn = (preset) => Boolean(normalizePresetConfig(options.presets?.[preset]).name)

    async function explainMissing(destination) {
        const assetsName = runtime.options.assets
        const parts = String(destination).replace(/^\/+/, '').split('/')
        if (!assetsName || parts[0] !== assetsName || parts.length < 3) return null
        const preset = parts[1]
        const name = parts.slice(2).join('/')

        const configured = Object.keys(options.presets || {}).sort()
        if (!options.presets?.[preset]) {
            return `no preset named '${preset}' is configured (configured: ${configured.join(', ') || 'none'})`
        }

        // Built only on this path: a build with nothing broken never walks
        // the catalog for it.
        // All of them: stems collide, which is exactly how presets are split
        // by extension over one photo — see the orphan sweep for what taking
        // [0] here cost. A diagnostic that reads the wrong candidate sends
        // the reader to the wrong file, which is the one thing it must not do.
        const candidates = await sourcesOf(preset, name)
        if (!candidates.length) {
            if (namesItsOwn(preset)) {
                return `preset '${preset}' names no source '${stemOf(name)}' — its \`name\` returned that `
                    + 'for nothing in the catalog'
            }
            return `no source file is named '${stemOf(name)}' — nothing would produce this derivative `
                + 'under any preset'
        }

        const covered = candidates.find(source => presetsSelecting(source).includes(preset))
        if (covered) {
            return `preset '${preset}' does cover ${covered.id}, so the derivative should be there — it was `
                + 'not produced this cycle (the preset render failed, or the preset changed and only '
                + '--render-presets re-derives what is already in the catalog)'
        }
        const { matches } = normalizePresetConfig(options.presets[preset])
        // Named individually, because with a shared stem "does not cover it"
        // is ambiguous about WHICH it, and the answer is usually that the
        // reader is looking at the wrong extension.
        const owns = [...new Set(candidates.flatMap(source => presetsSelecting(source)))].sort()
        return `preset '${preset}' does not cover `
            + candidates.map(source => source.id).join(' or ')
            + ` — its match is ${matches.join(', ') || '(none)'}`
            + (owns.length
                ? `. Presets that do cover ${candidates.length > 1 ? 'them' : 'it'}: ${owns.join(', ')}`
                : '. No configured preset covers it')
    }

    // Report presets that matched none of the entities this run evaluated.
    //
    // Deliberately phrased as what was OBSERVED rather than "this preset is
    // broken": an incremental cycle only re-evaluates changed entities, so a
    // preset can legitimately match nothing in a run of three. The count and
    // the --force hint let the reader tell the two apart, which a bare
    // "matched nothing" would not. Once per process, so watch mode is quiet.
    function reportUnmatchedPresets(logger) {
        if (matchTally.reported) return
        const configured = Object.keys(options.presets || {})
        if (!configured.length || !matchTally.evaluated) return
        // Only when the cycle evaluated everything. On an incremental run the
        // evaluated set is whatever changed, so a healthy preset matches
        // nothing in a run of two and the warning fires on every build —
        // which trains the reader to filter it, and the filtered-out line is
        // the real one. The message already told the reader to use --force to
        // check the whole catalog; that condition gates it now instead of
        // annotating it.
        if (!isFullCycle(runtime)) return
        matchTally.reported = true

        for (const preset of configured) {
            if (matchTally.matched.has(preset)) continue
            const { matches } = normalizePresetConfig(options.presets[preset])
            logger.warn(
                { code: 'preset-no-match', preset, evaluated: matchTally.evaluated, patterns: matches },
                'Assets preset %j matched none of the %d entities evaluated (patterns: %s). ' +
                'Patterns run against entity.id, which files({ outputFolder }) does NOT prefix — ' +
                'the prefix appears on name and meta.url only.',
                preset, matchTally.evaluated, matches.join(', '))
        }
    }

    // Resolve a preset name to an importable module location. Local
    // files in presetsFolder win; names with no local file fall back to
    // an npm package named `mikser-io-preset-<name>`, resolved from the
    // project's node_modules. Mirrors how postprocess.js resolves
    // post-* plugins — local override first, then the npm convention.
    // Returns { uri, watchable } or null when neither exists.
    //
    // `watchable` distinguishes the two lifetimes: local presets are
    // re-imported (cache-busted) on every load so watch-mode edits take
    // effect; npm presets are versioned by their package, imported once.
    function resolvePreset(name) {
        const local = path.join(runtime.options.presetsFolder, `${name}.js`)
        if (existsSync(local)) {
            return { uri: local, watchable: true }
        }
        try {
            const require = createRequire(path.join(runtime.options.workingFolder, 'package.json'))
            const uri = require.resolve(`mikser-io-preset-${name}`)
            return { uri, watchable: false }
        } catch {
            return null
        }
    }

    // Import a preset module and build its catalog entity. One place for
    // the (revision, format, options) export contract so onImport and
    // onSync stay in sync. Cache-busts local presets so watch-mode edits
    // reload; npm presets import once (their version is the cache key).
    // Presets whose effective definition moved this cycle: a bumped revision,
    // an edited module, or widened patterns.
    //
    // The fan-out this gates is a full catalog scan, and onImport writes every
    // preset entity on every build — so gating on "a preset is in the journal"
    // ran that scan every cycle, including a no-op watch rebuild, where
    // responsiveness matters most.
    const changedPresets = new Set()

    // Presets whose definition is KNOWN to have moved, which is a smaller set
    // and a different question. `changedPresets` decides what gets scheduled;
    // this decides what gets rendered past its marker.
    const movedPresets = new Set()

    async function notePresetChange(preset) {
        const prior = await findEntity({ id: preset.id })
        // An absent prior is not evidence that the preset moved.
        //
        // It is also what the catalog looks like after a WIPE, which mikser
        // does on any config change — and then every preset reads as new,
        // every one of them fans out over the catalog, and every derivative
        // on the site is re-rendered past a marker nobody consulted.
        // Measured on a live site: one edit to a config module queued 12,944
        // renders, about two hours of drawing, over derivatives whose sources
        // had not changed and whose markers were sitting beside them.
        //
        // The marker is the durable record and it survives the wipe: the
        // preset's revision is in its name and the source checksum is in its
        // body, so isPresetRendered can answer "is this derivative current"
        // with no help from the catalog. A preset that really is new has no
        // markers at all and renders; one whose revision really moved has
        // markers at the OLD revision, which the revision comparison rejects.
        //
        // So an unknown preset is still SCHEDULED — its entities may be in no
        // journal, and nothing else would reach them — and then left to that
        // check, which is better evidence than the catalog's silence.
        const moved = Boolean(prior) && (
            prior.checksum !== preset.checksum
            || JSON.stringify(prior.matches ?? null) !== JSON.stringify(preset.matches ?? null))
        if (moved || !prior) changedPresets.add(preset.name)
        if (moved) movedPresets.add(preset.name)
        return moved
    }

    // A preset's catalog checksum is its module's `revision`, not a hash of
    // the file — deliberately, so an author can edit a preset freely and
    // bump `revision` only when derivatives must be produced again.
    //
    // Anything comparing that against a file hash finds them different every
    // time. mikser_explain did, so every preset on every site reported as
    // diverged, with a verdict telling the reader a build would re-import it.
    // Compared against the same thing the catalog holds, it agrees.
    registerSourceChecksum(collection, async (entity) => {
        if (!entity?.uri) return null
        const { revision = 1 } = await import(`${entity.uri}?explain=${Date.now()}`)
        return revision
    })

    async function buildPreset({ name, uri, watchable }) {
        const cacheBust = watchable ? `?stamp=${Date.now()}` : ''
        // `options` here would SHADOW the plugin's own config, which the
        // patterns below need. The module's export and the factory argument
        // are two different things that were both called options.
        const { revision = 1, format, options: moduleOptions } = await import(`${uri}${cacheBust}`)
        return {
            id: `/presets/${name}`,
            collection,
            type,
            uri,
            name,
            source: uri,
            format,
            checksum: revision,
            // The patterns this preset selects by, carried on the entity.
            //
            // They are half of what decides which files a preset owns, and
            // they live in CONFIG rather than in the module — so `revision`
            // alone cannot say the preset's effective definition moved.
            // Widening a pattern was a silent no-op: match is evaluated as a
            // file ENTERS the catalog, so a wider one left everything already
            // in it alone, the build stayed green and the derivative never
            // appeared.
            matches: normalizePresetConfig(options.presets?.[name]).matches,
            options: moduleOptions,
        }
    }

    // Report what a step cost, so a slow one is a log line rather than a gap
    // between two other log lines.
    //
    // Each of the steps wrapped below walks the whole assets tree, the whole
    // manifest or the whole catalog, so each of them grows with the site, and
    // none of them was timed. On a 6,800-entity site the planning step alone
    // ran for two minutes with nothing said about it — the only evidence was
    // that the next journal line arrived late.
    async function timed(name, work) {
        const started = Date.now()
        try {
            return await work()
        } finally {
            const ms = Date.now() - started
            const logger = useLogger()
            logger[ms >= SLOW_STEP_MS ? 'info' : 'debug']('Assets %s: %s', name, formatDuration(ms))
        }
    }

    // Every marker beside a derivative, whatever revision it claims.
    //
    // Read from the index built at the top of this cycle, not from the disk.
    // The glob this replaces had the preset's own folder as its cwd, so each
    // call read that whole directory to pick out the handful of names that
    // start with one destination — once per entity per preset. On a preset
    // with 6,458 derivatives that is 6,458 directory reads of 6,458 entries
    // each, and it fires on exactly the builds that can least afford it: the
    // ones where the marker at the current revision is NOT there, which is
    // every entity of a preset whose revision moved.
    //
    // The same answer, because the index is built by globbing every `*.md5`
    // under the assets folder and keying it by the derivative it claims —
    // a superset of what this asked for. It stays true for the whole pass,
    // because planning no longer deletes anything: a task carries the markers
    // its render invalidates and the renderer removes them when it runs.
    function getRevisions({ destination }) {
        return markersByDestination.get(path.resolve(destination)) ?? []
    }

    // Asked with the three things the answer depends on — where the
    // derivative goes, the SOURCE checksum the marker is keyed on, and the
    // preset — rather than with an entity.
    //
    // So that planning can decide a reuse before it builds anything to render
    // with. The reuse is the common answer on a restart, by a wide margin,
    // and it was previously paid for with a full copy of the source entity
    // per preset: 27 deep copies of a 57KB report to conclude 27 times that
    // nothing needed doing.
    async function isPresetRendered({ destination, checksum, preset }) {
        // The marker says a render HAPPENED. It does not say the file it
        // produced is still there, and the two come apart the moment anyone
        // deletes a derivative — which is the obvious thing to do when you
        // want one rebuilt. The marker survives, this returned true, and the
        // image never came back on any number of ordinary builds; only
        // --force or a config change brought it round, and --audit-output was
        // the only thing that ever said a file was missing.
        //
        // Checked first and cheaply: one stat, and if the derivative is gone
        // no amount of marker archaeology changes the answer. Asked of
        // invalidation.js so a derivative and a rendered page agree on what
        // "the output is gone" means.
        if (outputMissing(destination)) return false
        let result = false
        let revisions = []
        const assetChecksum = `${destination}.${preset.checksum}.md5`
        if (checksumMap.has(assetChecksum)) {
            revisions.push(assetChecksum)
        } else {
            revisions = getRevisions({ destination })
        }

        for (let revision of revisions) {
            const [assetsRevision] = revision.split('.').slice(-2, -1)
            if (preset.checksum <= Number.parseInt(assetsRevision)) {
                if (preset.options?.checksum === false) {
                    result = true
                    break
                }

                let marked = await readFile(revision, 'utf8')
                result ||= marked == checksum
                if (result) break
            }
        }
        return result
    }

    // A marker outliving the render it describes is the whole defect.
    //
    // `isPresetRendered` is keyed on the SOURCE checksum, and an interrupted
    // render does not change the source — so a derivative that was being
    // rewritten when the process died keeps a marker that still matches, and
    // every later build reports nothing to do over a half-written file.
    // Measured on a 20KB fixture: delete a derivative, interrupt the
    // re-render, and the site serves 10KB of it indefinitely.
    //
    // The marker means "a completed render produced this file", so it is
    // removed before the render starts and written again by onComplete. An
    // interrupted render then leaves no claim behind and the next ordinary
    // build re-derives. The FILE is deliberately left alone: a preset that
    // fails before writing anything still has a good derivative on disk, and
    // removing it would take a working asset off the site until the next
    // build.
    // Where a preset puts a given entity. One implementation, because the
    // reuse check, the render dispatch and the unmarked-derivative scan all
    // need it and a second copy would drift from `presetUrl` the moment a
    // preset grew an option.
    // `null` when a naming preset names this entity nothing any more.
    function presetDestination(entity, preset) {
        const named = derivativeName(entity, preset.name)
        if (named === null) return null
        const name = preset.format ? changeExtension(named, preset.format) : named
        return path.join(runtime.options.assetsFolder, preset.name, name)
    }

    // Plan the cycle's preset renders, streaming them into the dispatcher.
    //
    // Three things used to make this the longest unmeasured step of a
    // restart, and all three were paid once per entity PER PRESET:
    //
    //   - a `_.cloneDeep` of the whole source entity, meta included, taken
    //     BEFORE anything had decided whether that entity needed rendering at
    //     all. A site with 273 reports of 57KB and 27 marks presets deep-
    //     copied 400MB to conclude, almost every time, that the derivative on
    //     disk was already current;
    //   - the whole task list built before `renderEntities` was called once,
    //     which made the journal insert a single synchronous transaction;
    //   - no yield anywhere in between, so HTTP and MCP went unanswered for
    //     as long as it ran. `mikser_ping` timing out is what a 100%-busy
    //     main thread looks like from outside.
    //
    // Now: destination and reuse are decided from the source, the preset and
    // the marker alone; the entity is copied only once a task is really going
    // to be journalled, and shallowly, because the two fields a preset task
    // adds are its own and the journal snapshots the rest immediately; and
    // the plan goes out in batches with a turn of the event loop between them.
    async function renderPresets(entities, { rendererChanged = new Map() } = {}) {
        const { presets, assetsMap } = runtime.state.assets
        const logger = useLogger()
        const started = Date.now()

        let planned = 0
        let reused = 0
        let firstDispatch = null
        let batch = []

        const dispatch = async () => {
            if (!batch.length) return
            const sending = batch
            batch = []
            firstDispatch ??= Date.now() - started
            await renderEntities(sending)
        }

        for (let entityToRender of entities) {
            for (let entityPreset of assetsMap[entityToRender.id] || []) {
                await pace()
                const preset = presets[entityPreset]
                // Named in config but with no module in presets/ and no
                // mikser-io-preset-* package: there is nothing to render with.
                // Loading already reported this preset ('Preset not found'),
                // and the finalize check names the links left dangling. A line
                // per entity here would just be that fact a third time, once
                // per matched file.
                if (!preset) continue
                const destination = presetDestination(entityToRender, preset)
                // Selected when it was journalled, named nothing now: a newer
                // source took the name, and rendering this one would put the
                // old bytes back under it.
                if (!destination) continue
                // Two gates sit between a scheduled entity and a render: the
                // manifest's "its source did not change", and this plugin's
                // marker. A forced render clears both — a marker at the
                // current revision is exactly what --render-presets exists to
                // disregard.
                //
                // Asked per PRESET, not per entity. `rendererChanged` was a
                // set of entity ids, so one moved preset forced every preset
                // that entity matched: `--render-presets
                // marks-pigmentation-left` named 12 sources and redrew all 27
                // marks presets of each, 322 renders for the 12 that were
                // asked for, and bumping twelve side presets' revisions
                // queued ~13,000 tasks instead of ~3,200. Every other preset
                // of a scheduled entity takes the ordinary reuse decision,
                // which is what the markers are for.
                const forced = rendererChanged.get(entityToRender.id)?.has(entityPreset) ?? false
                const ignore = forced ? false : await isPresetRendered({
                    destination, checksum: entityToRender.checksum, preset,
                })
                if (ignore) reused++
                // Per-preset config options override the preset module's
                // defaults. Looked up at render time so config edits are
                // picked up on the next cycle without rebuilding the
                // preset entity from its module.
                const { options: configOptions } = normalizePresetConfig(
                    options.presets?.[entityPreset]
                )
                // A SHALLOW copy, which is all a preset task ever needed.
                //
                // It adds two fields of its own — `preset` and `destination` —
                // and reads the rest. Everything else it shares with the
                // catalog entity it came from, and nothing mutates that:
                // `renderEntities` serializes the task into the journal, and
                // the render later works on what comes back out, so no
                // reference survives to alias through.
                const entity = { ...entityToRender, preset, destination }
                const presetOptions = { ...preset.options, ...configOptions }
                batch.push({
                    entity,
                    options: {
                        ...presetOptions,             // module defaults + config overrides
                        // The cap is held by the DISPATCHER now, around the
                        // dispatch and before INLINE/SERIAL/WORKER is chosen,
                        // so one counter on the main thread bounds every mode.
                        // This used to pin a capped preset to INLINE — the
                        // only way its own in-process counter could be the
                        // only one — which made a capped, CPU-bound preset
                        // impossible to run in parallel at all.
                        //
                        // Keyed by the PRESET, so two capped presets still run
                        // beside each other. Without a key they would share
                        // the `preset` renderer's gate and serialise.
                        ...(presetOptions.concurrency ? { concurrencyKey: `preset:${entityPreset}` } : {}),
                        renderer: 'preset',
                        // The source is often a page too, under the same id,
                        // and its layout render is gated on evidence these
                        // tasks never see. Named, the manifest keeps the two
                        // sets of outputs apart: a cycle that re-derives only
                        // the derivatives says nothing about the page.
                        dispatcher: 'assets',
                        // The preset itself moved this cycle, so the manifest's
                        // "its source is unchanged" is true and beside the
                        // point. See the skip decision in engine.js.
                        // The markers this derivative's render invalidates,
                        // removed by the renderer when the render is really
                        // about to happen — see lib/preset.js.
                        //
                        // Planning used to remove them here, on deciding not
                        // to reuse. That is one step too early: a decision is
                        // not a render, and a task can still be dropped
                        // between the two — by the manifest's own skip, or by
                        // a cancelled cycle. A planner that misjudges then
                        // costs the whole site its markers, which is the
                        // worst shape available: the derivatives are intact,
                        // nothing claims them, and every later build
                        // re-derives all of them.
                        ...(ignore ? {} : { presetMarkers: getRevisions({ destination }) }),
                        rendererChanged: forced,
                        ignore
                    }
                })
                planned++
                if (batch.length >= DISPATCH_BATCH) await dispatch()
            }
        }
        await dispatch()

        const ms = Date.now() - started
        logger[ms >= SLOW_STEP_MS ? 'info' : 'debug'](
            'Assets planning: %d render task(s), %d reused, in %s%s',
            planned, reused, formatDuration(ms),
            firstDispatch === null ? ''
                : `, first dispatched after ${formatDuration(firstDispatch)}`)
    }

    onLoaded(async () => {
        const logger = useLogger()

        const assetsName = options.assetsFolder || 'assets'
        runtime.state.assets = {
            presets: {},
            assetsMap: {},
            assetsFolder: options.outputFolder
                ? path.join(options.outputFolder, assetsName)
                : assetsName,
        }

        // The engine asks this when a linked derivative is not on disk.
        //
        // On runtime.engine, NOT on runtime.state. State is structured-cloned
        // into render and postprocess workers, and a function cannot be
        // cloned: putting it there made every worker-dispatched render fail
        // with DataCloneError on any build that loads this plugin, reported as
        // a render error whose message was this function's own source. Options
        // already had workerSafeOptions for exactly this hazard; state had no
        // equivalent, so state is the wrong place to publish anything callable.
        //
        // Still published rather than imported, so the engine keeps knowing
        // nothing about presets and says nothing when this plugin is absent.
        runtime.engine ??= {}
        runtime.engine.assets = { explainMissing }


        // `??`, not `||`: an option commander did not see is undefined, and
        // falling through to the config is the point. `||` would also fall
        // through for an intentional empty string, which is a different
        // answer than "not given".
        runtime.options.presets = runtime.options.presets ?? options.presetsFolder ?? collection
        runtime.options.presetsFolder = path.join(runtime.options.workingFolder, runtime.options.presets)
        logger.debug('Presets folder: %s', runtime.options.presetsFolder)
        await mkdir(runtime.options.presetsFolder, { recursive: true })

        runtime.options.assets = runtime.options.assets ?? options.assetsFolder ?? 'assets'
        runtime.options.assetsFolder = path.join(runtime.options.workingFolder, runtime.options.assets)
        // This tree holds outputs too, and --audit-output could not see it:
        // it walks the output folder, and derivatives reach the site through
        // a symlink the walk does not follow. Declared rather than hardcoded
        // in the manifest, with the ignore that only this plugin can state —
        // a `.md5` beside a derivative is bookkeeping, and without excluding
        // them every derivative on the site would report one orphan.
        //
        // `auditIgnore` is the escape hatch for a preset that writes MORE
        // than one file. The engine records the one destination it handed
        // over, so a poster frame written beside a video is genuinely
        // unclaimed and genuinely reported — correct, and a permanent
        // non-zero exit for a legitimate preset if there were no way to say
        // "these are expected". Stated in config, next to the preset that
        // produces them, rather than inferred.
        const auditRoot = {
            path: runtime.options.assetsFolder,
            ignore: ['**/*.md5', ...(options.auditIgnore ?? [])],
        }
        runtime.options.auditRoots = [
            ...(runtime.options.auditRoots ?? []).filter(root => root.path !== auditRoot.path),
            auditRoot,
        ]
        logger.debug('Assets folder: %s', runtime.options.assetsFolder)

        // --clear means "throw away what was derived and build it again", and
        // derivatives are derived — but this folder sits at the working-folder
        // root, outside both outputFolder and runtimeFolder, so the engine's
        // clear never reached it. Anything here whose source had gone stayed
        // forever: still on disk, still SERVED through the symlink below, and
        // invisible to `find out -type f` because that tree is reached through
        // a link. The only way out was deleting the folder by hand.
        //
        // Cleared here rather than in the engine because the path is not known
        // until this plugin resolves it — the engine's clear runs before any
        // plugin's onLoaded.
        //
        // Whole folder, not a sweep of orphans: identifying an orphan means
        // mapping a derivative back to a source, which is the id/name mapping
        // that has bitten this plugin twice. --clear already accepts a full
        // rebuild, so re-deriving is the honest cost of asking for one.
        if (runtime.options.clear) {
            await rm(runtime.options.assetsFolder, { recursive: true, force: true })
            logger.info('Assets cleared: %s', runtime.options.assetsFolder)
        }

        await mkdir(runtime.options.assetsFolder, { recursive: true })

        let link = path.join(runtime.options.outputFolder, runtime.options.assets)
        if (options.outputFolder) link = path.join(runtime.options.outputFolder, options.outputFolder, runtime.options.assets)
        try {
            await mkdir(path.dirname(link), { recursive: true })
            await symlink(path.resolve(runtime.options.assetsFolder), link, 'dir')
        } catch (err) {
            if (err.code != 'EEXIST')
                throw err
        }

        watch(collection, runtime.options.presetsFolder)
    })

    onSync(collection, async ({ action, context }) => {
        if (!context.relativePath) return false
        const { relativePath } = context

        const logger = useLogger()
        const { presets } = runtime.state.assets

        // Watch only fires for files in presetsFolder, so these are
        // always local presets — watchable: true.
        const name = relativePath.replace(path.extname(relativePath), '')
        const uri = path.join(runtime.options.presetsFolder, relativePath)

        let synced = true
        switch (action) {
            case ACTION.CREATE:
                try {
                    const preset = await buildPreset({ name, uri, watchable: true })
                    presets[name] = preset
                    await createEntity(preset)
                } catch (err) {
                    synced = false
                    logger.error('Preset loading error: %s %s', uri, err.message)
                }
                break
            case ACTION.UPDATE:
                try {
                    const preset = await buildPreset({ name, uri, watchable: true })
                    // Was `!preset[name]` — a typo for `!presets[name]`
                    // that made every UPDATE take the create branch
                    // (preset[name] is always undefined). Fixed: only
                    // re-emit when the revision actually changed.
                    if (!presets[name]) {
                        presets[name] = preset
                        await createEntity(preset)
                    } else if (presets[name].checksum != preset.checksum) {
                        presets[name] = preset
                        await updateEntity(preset)
                    } else {
                        synced = false
                    }
                } catch (err) {
                    synced = false
                    logger.error('Preset loading error: %s %s', uri, err.message)
                }
                break
            case ACTION.DELETE:
                delete presets[name]
                await deleteEntity({
                    id: path.join('/presets', relativePath),
                    collection,
                    type,
                })
                break
        }
        return synced
    })

    onImport(async () => {
        const logger = useLogger()
        const { presets } = runtime.state.assets

        // Local presets: scan the presets folder. Loads every *.js
        // there, keyed by filename. Local always wins.
        const paths = await globby('*.js', { cwd: runtime.options.presetsFolder })
        for (let relativePath of paths) {
            const name = relativePath.replace(path.extname(relativePath), '')
            const uri = path.join(runtime.options.presetsFolder, relativePath)
            try {
                const preset = await buildPreset({ name, uri, watchable: true })
                await notePresetChange(preset)
                await createEntity(preset)
                presets[name] = preset
            } catch (err) {
                logger.error(err, 'Preset loading error: %s', uri)
            }
        }

        // npm presets: any preset name referenced in config that no
        // local file already provided resolves to an npm package
        // `mikser-io-preset-<name>`. Config is the source of truth for
        // which presets a project uses; this fills the names a folder
        // scan can't (the code lives in node_modules, not presets/).
        for (const name of Object.keys(options.presets || {})) {
            if (presets[name]) continue   // a local file already loaded it
            const resolved = resolvePreset(name)
            if (!resolved) {
                logger.error(
                    'Preset not found: %s (no presets/%s.js, no npm package mikser-io-preset-%s)',
                    name, name, name,
                )
                continue
            }
            try {
                const preset = await buildPreset({ name, uri: resolved.uri, watchable: resolved.watchable })
                await notePresetChange(preset)
                await createEntity(preset)
                presets[name] = preset
                logger.debug('Preset loaded from npm: mikser-io-preset-%s', name)
            } catch (err) {
                logger.error(err, 'Preset loading error (npm): mikser-io-preset-%s', name)
            }
        }
    })

    onProcessed(async (signal) => {
        const logger = useLogger()
        const { assetsMap } = runtime.state.assets

        for await (let { entity, operation } of useJournal('Assets processing', [OPERATION.CREATE, OPERATION.UPDATE, OPERATION.DELETE], signal)) {
            await pace()
            if (entity.collection != collection) {
                switch (operation) {
                    case OPERATION.CREATE:
                    case OPERATION.UPDATE:
                        const entityPresets = await getEntityPresets(entity)
                        if (entityPresets.length) {
                            logger.debug('Presets matched for: %s %s', entity.collection, entity.id, entityPresets.length)
                            assetsMap[entity.id] = entityPresets
                            // ADR-0011: stamp deployed preset URLs onto the
                            // source entity so a $-ref to it expands to its
                            // derivatives. Same destination as renderPresets;
                            // recorded here where the matched presets are known.
                            // Auto-persisted via useJournal (mutate-and-move-on).
                            const { presets } = runtime.state.assets
                            const urls = {}
                            for (const presetName of entityPresets) {
                                urls[presetName] = presetUrl({
                                    assetsFolder: runtime.state.assets.assetsFolder,
                                    preset: presetName,
                                    name: derivativeName(entity, presetName),
                                    format: presets[presetName]?.format,
                                    changeExtension,
                                })
                            }
                            entity.meta = { ...entity.meta, presets: urls }
                        }
                        break
                    case OPERATION.DELETE:
                        delete assetsMap[entity.id]
                        break
                }
            }
        }
    })

    onBeforeRender(async signal => {
        const { assetsMap, presets } = runtime.state.assets

        checksumMap.clear()
        markersByDestination.clear()
        const checksumFiles = await timed('marker scan',
            () => globby('**/*.md5', { cwd: runtime.options.assetsFolder }))
        for (let checksumFile of checksumFiles) {
            const marker = path.join(runtime.options.assetsFolder, checksumFile)
            checksumMap.add(marker)
            // `<destination>.<revision>.md5` — the same shape the orphan
            // sweep strips to get back to the derivative.
            //
            // Resolved on both sides of the comparison, because the other
            // side is a manifest destination and these two are built by
            // different subsystems. It is a no-op while assetsFolder is
            // derived from workingFolder (see onLoaded), which is why no test
            // can tell it apart — normalization at the boundary, not a
            // transform anything depends on.
            const destination = path.resolve(marker.replace(/\.[^.]+\.md5$/, ''))
            if (!markersByDestination.has(destination)) markersByDestination.set(destination, [])
            markersByDestination.get(destination).push(marker)
        }

        const entitiesToRender = new Map()
        // Which of an entity's presets must render regardless of markers or
        // manifest: entity id -> the names of the presets that moved for it.
        //
        // Per preset. As a set of entity ids this said "something about this
        // entity moved" and renderPresets could only read it as "everything
        // about it moved", so one bumped preset redrew every derivative of
        // every source it covered.
        const presetMoved = new Map()
        const forcePreset = (entityId, preset) => {
            if (!presetMoved.has(entityId)) presetMoved.set(entityId, new Set())
            presetMoved.get(entityId).add(preset)
        }

        // A derivative with no marker beside it is a render that was killed
        // before it could write one.
        //
        // Nothing else notices. The file is present, so the engine's
        // missing-output path does not fire; the source did not change, so
        // the journal never mentions it; and the marker check that WOULD
        // catch it is only consulted for entities something else already
        // scheduled. So the derivative sits there half-written and every
        // build reports nothing to do — which is the whole reason the marker
        // is now removed before a render rather than merely written after
        // one. Removing it only helps if its absence is read.
        //
        // Empty on any healthy build, and the catalog walk is behind that
        // emptiness: this costs one Set lookup per cycle until something has
        // actually gone wrong.
        // Asked of the MANIFEST, not of the folder.
        //
        // The first version walked every file under each preset folder and
        // called anything without a marker an interrupted render. But only
        // the destination the engine hands the preset gets a marker, so a
        // preset that legitimately writes MORE than one file — a poster frame
        // beside a video — left permanent evidence of a failure that never
        // happened. It warned on every build for ever, said the derivative
        // was "being re-derived", and re-derived nothing, because no entity's
        // destination ever matched the extra file. A warning that cries wolf
        // on every build is worse than the silence it replaced, and it
        // teaches people to ignore the one that matters.
        //
        // A file nothing claims is an ORPHAN, which is a different fault with
        // its own report. This asks only about outputs the manifest recorded,
        // which is also what makes the recovery possible: a snapshot carries
        // the entity id, so there is nothing to reverse-map and no catalog to
        // walk.
        // The folder each preset files its derivatives under, so a damaged
        // one can name the preset that owns it rather than only the entity.
        const presetRoots = Object.keys(presets)
            .map(name => ({ name, root: path.resolve(runtime.options.assetsFolder, name) + path.sep }))
        // Entity id -> the unfinished derivatives it owns, one entry per
        // preset.
        //
        // A LIST, because an entity has a derivative per preset and an
        // interrupted cycle can leave several of them unmarked. Keyed by
        // entity alone, each one overwrote the last — which cost nothing
        // while a single entry forced the whole entity, and would silently
        // drop the rest now that each one speaks only for its own preset.
        const unfinished = new Map()
        await timed('unfinished sweep', async () => {
            for (const snapshot of runtime.manifest?.all?.() ?? []) {
                await pace()
                if (!snapshot.destination) continue
                const destination = path.resolve(snapshot.destination)
                const owner = presetRoots.find(({ root }) => destination.startsWith(root))
                if (!owner) continue
                if (markersByDestination.has(destination)) continue
                // Gone entirely is a different fault, and the engine's
                // missing-output path already has it. Reporting it here as
                // well would name the wrong cause.
                if (outputMissing(snapshot.destination)) continue
                if (!unfinished.has(snapshot.id)) unfinished.set(snapshot.id, [])
                unfinished.get(snapshot.id).push({ destination, preset: owner.name })
            }
        })
        if (unfinished.size) {
            const damaged = []
            for (const [id, derivatives] of unfinished) {
                const entity = await findEntity({ id })
                // Source gone: the orphan sweep removes the derivative at
                // finalize. Nothing to re-derive and nothing to say.
                if (!entity) continue
                assetsMap[entity.id] ??= await getEntityPresets(entity)
                // Forced past the reuse check as well as scheduled: the file
                // on disk is exactly what must not be trusted, and
                // isPresetRendered cannot tell half-written bytes from
                // finished ones.
                //
                // The preset that owns the damaged file, and no other. Each
                // preset writes its own derivative, so a half-written mark
                // says nothing about the other twenty-six — and redrawing
                // them is the cost this whole change is about.
                for (const { destination, preset } of derivatives) {
                    forcePreset(entity.id, preset)
                    damaged.push(destination)
                }
                entitiesToRender.set(entity.id, entity)
            }
            // Only when something is actually being re-derived. The warning
            // claimed the action rather than reporting it, so a build that
            // scheduled nothing still announced a recovery.
            if (damaged.length) {
                useLogger().warn({ code: 'preset-unfinished', derivatives: damaged },
                    'Assets: %d derivative(s) have no completed-render marker and are being re-derived. '
                    + 'A preset render did not finish — the file left behind is not trustworthy.',
                    damaged.length)
            }
        }

        // --render-presets [name]: re-derive though nothing moved.
        //
        // The escape hatch for what the incremental machinery cannot see — a
        // preset edited without bumping `revision`, a marker deleted by hand,
        // an image library upgraded underneath the build. --clear reaches the
        // same end only by rebuilding the whole site, and only at startup, so
        // it cannot be asked of a running watcher at all.
        const wanted = runtime.options.renderPresets
        if (wanted) {
            // Consumed here and nowhere else. The engine checks this at the
            // end of the cycle: a flag that reaches no plugin has to say so,
            // rather than building normally and leaving the operator to
            // notice nothing was re-derived.

            const known = Object.keys(runtime.state.assets.presets)
            const names = wanted === true ? known : [wanted]
            for (const name of names.filter(n => !known.includes(n))) {
                useLogger().warn({ code: 'preset-unknown', preset: name },
                    '--render-presets asked for %j, which is not configured. Known: %s',
                    name, known.join(', ') || '(none)')
            }
            const selected = names.filter(n => known.includes(n))
            if (selected.length) {
                let sources = 0
                let derivatives = 0
                for await (const candidate of iterateEntities({ collection: { $ne: collection } })) {
                    await pace()
                    const candidatePresets = await getEntityPresets(candidate)
                    const asked = candidatePresets.filter(n => selected.includes(n))
                    if (!asked.length) continue
                    assetsMap[candidate.id] ??= candidatePresets
                    // The presets that were named, and no others. `--render-
                    // presets web` means the web derivatives; it used to mean
                    // every derivative of every source that has one.
                    for (const name of asked) forcePreset(candidate.id, name)
                    entitiesToRender.set(candidate.id, candidate)
                    sources++
                    derivatives += asked.length
                }
                // Derivatives as well as sources, because the sources alone
                // are what made the old behaviour invisible: this said "12
                // source(s)" and then redrew 322 files, and the line gave a
                // reader no way to tell. It also counted
                // `entitiesToRender.size`, which by then held whatever the
                // unfinished sweep had scheduled too.
                useLogger().info('Presets re-rendering: %s (%d derivative(s) across %d source(s))',
                    selected.join(', '), derivatives, sources)
            }
        }
        await map(useJournal('Assets provision', [OPERATION.CREATE, OPERATION.UPDATE], signal), async ({ entity }) => {
            if (entity.collection == collection) {
                // Only when this preset's definition actually moved.
                if (!changedPresets.has(entity.name)) return
                // A preset moved — its `revision` was bumped, or its module
                // changed. Everything that uses it has to re-render.
                //
                // Asked of the CATALOG, not of assetsMap. That map is built
                // from this cycle's journal, so on a build where only the
                // preset moved it is empty and this fan-out reached nothing:
                // no asset was scheduled, the reuse check that would have
                // said "the marker is too old" was never consulted, and the
                // startup sweep deleted the old markers anyway because it
                // walks the folder rather than the entities.
                //
                // The result was the worst available shape. Bumping `revision`
                // — the documented way to force a rebuild — removed the marker
                // and left the derivative at its old bytes. It looked like it
                // had worked, nothing in the report said otherwise, and where
                // the derived folder is gitignored the deployment served stale
                // images until someone deleted the folder by hand.
                //
                // getEntityPresets is the same matcher the per-entity path
                // uses, so there is one implementation of "does this entity
                // use this preset" rather than a second one here that can
                // drift.
                for await (const candidate of iterateEntities({ collection: { $ne: collection } })) {
                    await pace()
                    const candidatePresets = await getEntityPresets(candidate)
                    if (!candidatePresets.includes(entity.name)) continue
                    // renderPresets reads the presets to render off this map,
                    // and on a preset-only build nothing else populated it.
                    assetsMap[candidate.id] ??= candidatePresets
                    // `entity` here IS the preset this walk is for, and it is
                    // the only one of this candidate's presets that could
                    // need re-deriving.
                    //
                    // Forced only when its definition is known to have moved.
                    // A preset the catalog simply does not remember — every
                    // preset, on the build after a cache wipe — is scheduled
                    // and left to its marker.
                    if (movedPresets.has(entity.name)) forcePreset(candidate.id, entity.name)
                    if (!entitiesToRender.has(candidate.id)) {
                        entitiesToRender.set(candidate.id, candidate)
                    }
                }
            } else {
                if (assetsMap[entity.id] && !entitiesToRender.has(entity.id)) {
                    entitiesToRender.set(entity.id, entity)
                }
            }
        }, { concurrency: PROVISION_CONCURRENCY, signal })

        await renderPresets(entitiesToRender.values(), { rendererChanged: presetMoved })
    })

    onComplete(async ({ entity, options }) => {
        const logger = useLogger()
        if (entity.preset && !options?.ignore) {
            await mkdir(path.dirname(entity.destination), { recursive: true })
            const assetChecksum = `${entity.destination}.${entity.preset.checksum}.md5`
            await writeFile(assetChecksum, entity.checksum, 'utf8')
            logger.debug('Asset render finished: [%s] %s', assetChecksum, entity.destination.replace(runtime.options.workingFolder, ''))
        }
    })

    onFinalize(async () => {
        const logger = useLogger()
        const { presets } = runtime.state.assets

        reportUnmatchedPresets(logger)

        // How much of the catalog this run actually looked at.
        //
        // The warning above only fires on a full cycle, because on an
        // incremental one a healthy preset legitimately matches nothing. That
        // is correct and it leaves the reverse question unanswered: a NEW
        // pattern that never had the chance to match anything looks exactly
        // like a run with nothing to do. `evaluated 4 of 397` answers it
        // without needing a warning to decide whether to fire.
        try {
            // COUNT(*), not a fetch: the denominator is a number, and paying a
            // full scan and a JSON.parse per row to produce it would make the
            // diagnostic cost more than the thing it diagnoses.
            reportEvaluated('assets', {
                evaluated: matchTally.evaluated,
                of: countEntities({ collection: { $ne: collection } }),
            })
        } catch { /* a count is not worth failing a build over */ }

        let revisions = await globby('**/*.md5', { cwd: runtime.options.assetsFolder })

        // Is the catalog answerable at all?
        //
        // Every check below concludes "no source, therefore orphan", and an
        // EMPTY catalog answers that for every derivative on the site. A
        // failed import or a scan that has not run yet would then delete the
        // whole assets folder — a rebuild of every derivative at best, and at
        // worst it happens on the machine that serves them. So the sweep only
        // runs when there is something to be absent from.
        const catalogSize = countEntities({ collection: { $ne: collection } })
        const orphaned = []

        for (let revision of revisions) {
            const [preset] = revision.split(path.sep)
            const [assetsRevision] = revision.split('.').slice(-2, -1)

            if (!presets[preset]) {
                const assetsPresetFolder = path.join(runtime.options.assetsFolder, preset)
                // `let`. This was `const` with an assignment inside the try,
                // so removing a preset folder threw TypeError into the empty
                // catch on every pass and the log line was unreachable — the
                // rm had already happened, so nothing looked wrong.
                let assetsPresetRemoved = false
                try {
                    await rm(assetsPresetFolder, { recursive: true, force: true })
                    assetsPresetRemoved = true
                } catch { /* already gone, or not ours to remove */ }
                if (assetsPresetRemoved) {
                    logger.debug('Assets preset removed: %s', assetsPresetFolder)
                }
                continue
            }

            if (Number.parseInt(assetsRevision) < presets[preset].checksum) {
                await unlink(path.join(runtime.options.assetsFolder, revision))
            }

            // A derivative whose source is gone, or which this preset no
            // longer covers.
            //
            // Deleting the source removed its catalog row and its published
            // file, and left the derivative — the delete handler dropped the
            // in-memory mapping and nothing on disk, so the only cleanup was
            // --clear or doing it by hand. Narrowing a preset's `match` left
            // one the same way, with nothing said.
            //
            // Answered from the catalog rather than from the delete event: a
            // delete entry is sparse ({ id, type, collection }) by convention
            // in every source plugin, so it cannot say where the derivative
            // went. What still HAS a source is a question the catalog answers
            // whatever route the orphan arrived by.
            if (!catalogSize) continue
            const derivative = revision.replace(/\.[^.]+\.md5$/, '')
            const name = derivative.split(path.sep).slice(1).join('/')
            // EVERY source sharing the stem, not the first one.
            //
            // sourcesOf returns an array because stems collide, and taking
            // [0] threw away the collision it exists to record — so a
            // derivative was judged against a file that had nothing to do with
            // it, and then unlinked. Presets split by EXTENSION over a shared
            // stem are the ordinary way to ask for two derivatives of one
            // product photo:
            //
            //   'product-poster': '/files/img/products/*.jpg'
            //   'product-image':  '/files/img/products/*.png'
            //
            // gpoint-cms has four stems carrying both files. [0] handed back
            // the .jpg, `product-image` does not cover a .jpg, and a perfectly
            // good .webp was deleted — silently, because from here it looked
            // exactly like an orphan. Which of the two won was down to catalog
            // iteration order, so the same config could behave differently
            // between machines.
            //
            // A naming preset is answered from what its `name` returns NOW: a
            // derivative nothing is named to any more — its source replaced by
            // a newer one filed elsewhere — is an orphan like any other.
            const candidates = await sourcesOf(preset, name)
            if (candidates.some(source => presetsSelecting(source).includes(preset))) continue
            orphaned.push({
                derivative,
                marker: revision,
                reason: candidates.length
                    ? `preset '${preset}' no longer covers `
                        + candidates.map(source => source.id).join(', ')
                    : namesItsOwn(preset) ? `preset '${preset}' names nothing to it` : 'its source is gone',
            })
        }

        for (const { derivative, marker } of orphaned) {
            await unlink(path.join(runtime.options.assetsFolder, derivative)).catch(() => { /* already gone */ })
            await unlink(path.join(runtime.options.assetsFolder, marker)).catch(() => { /* already gone */ })
        }
        if (orphaned.length) {
            logger.info('Assets removed: %d derivative(s) with no source — %s',
                orphaned.length,
                orphaned.slice(0, 3).map(o => `${o.derivative} (${o.reason})`).join(', ')
                + (orphaned.length > 3 ? ` and ${orphaned.length - 3} more` : ''))
        }
    })

        return {
            collection,
            type, module: import.meta.url,
        }
    }
}

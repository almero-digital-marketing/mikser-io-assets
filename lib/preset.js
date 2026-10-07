import { mkdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'

// A renderer's `load` runs for EVERY entity in the cycle, not only the ones
// this renderer will render — that is deliberate and is how assetUrlHelper
// installs runtime.asset() for all templates. So this has to tolerate an
// entity that has no preset, rather than assume it is looking at one.
//
// Without the guard, adding renderPreset() to a project's plugin list made
// every page render throw on `entity.preset.uri` — and a crash reads as
// "you have found something real", which is a much more expensive wrong
// signal than a no-op. The names invite exactly that mistake:
//
//   assetUrlHelper() provides runtime.asset() to templates  (a URL helper)
//   assets()        runs presets and produces derivatives   (the work)
//   renderPreset()  renders a preset-authored layout        (this file)
//
// The URL helpers carry `Helper` in their names for exactly this reason;
// renderPreset keeps its bare name because it really is a renderer.
export async function load({ entity, runtime }) {
    if (!entity?.preset?.uri) return
    const preset = await import(`${entity.preset.uri}?stamp=${Date.now()}`)
    runtime.preset = preset.default
}

async function describe(file) {
    try {
        const { mtimeMs, size } = await stat(file)
        return { mtimeMs, size }
    } catch { return null }
}

// How many of ONE preset's renders may run at once.
//
// Preset renders are dispatched INLINE, which the engine runs at
// `runtime.options.threads` — four by default. That is the right width for
// work the engine can see: a sharp resize is in-process and its memory is
// counted. A preset that shells out to ffmpeg is not. Four of those is four
// external processes the engine never hears about, and the report that
// prompted this measured two of them at 476MB and 329MB RSS beside mikser's
// own 580MB, which killed a 2GB container six times in twenty minutes.
//
// An OOM kill is the worst shape a limit can be discovered in: the process is
// gone, there is no error, no partial output and nothing in the log — just a
// build that stopped. So the preset declares what it can afford, because it
// is the only thing that knows it spawns a process at all:
//
//     export const options = { concurrency: 1 }
//
// Per preset rather than global, so one heavy video preset does not slow the
// thumbnails. Unset means unchanged — a preset that does not say is dispatched
// exactly as it was before.
//
// Per PROCESS, which is why assets pins a capped preset to inline dispatch: in
// a worker pool each thread would hold its own gate and the cap would multiply
// by the pool size, which is the bug wearing a limit.
const gates = new Map()

function gateFor(name, limit) {
    const existing = gates.get(name)
    // A changed limit — the preset was edited mid-watch — replaces the gate.
    // Renders already through the old one finish against it; the counter they
    // decrement is their own.
    if (existing && existing.limit === limit) return existing
    const gate = { limit, active: 0, waiting: [] }
    gates.set(name, gate)
    return gate
}

// Exported for the tests, which need a clean slate between cases.
export function resetPresetGates() {
    gates.clear()
}

// How many of this preset's renders are running and how many are queued.
//
// Exported so a test can wait for every render to have REACHED the gate
// before it reads the peak. render() does its own mkdir and stat first, so
// renders started in one tick arrive spread over many, and a test that waits
// a fixed number of turns instead is a race that passes on a quiet laptop and
// fails on a busy CI runner — which is exactly how it failed.
export function gateState(name) {
    const gate = gates.get(name)
    return { active: gate?.active ?? 0, waiting: gate?.waiting.length ?? 0 }
}

// Exported for the tests. The wake-then-steal race below is a matter of
// microtask ordering, and render()'s own mkdir and stat put macrotasks
// between a caller and the gate — which is enough to hide it.
export async function withGate(name, limit, run) {
    if (!Number.isInteger(limit) || limit < 1 || !name) return await run()
    const gate = gateFor(name, limit)
    // A LOOP, not a single await. Waking a waiter only means a slot was freed,
    // not that it is still free: a caller arriving in between takes it first,
    // and a waiter that assumed otherwise would push the gate over its limit —
    // which is the whole thing this exists to prevent.
    while (gate.active >= gate.limit) {
        await new Promise(resolve => gate.waiting.push(resolve))
    }
    gate.active++
    try {
        return await run()
    } finally {
        gate.active--
        gate.waiting.shift()?.()
    }
}

// A render that failed leaves nothing half-written behind.
//
// This is the one place user code is handed a final output path and left to
// fill it, and a half-written derivative there is not self-correcting. The
// marker `isPresetRendered` consults is keyed on the SOURCE checksum, and an
// interruption does not change the source; the file exists, so the engine's
// missing-output path does not fire either. Both gates therefore say "nothing
// to do" over a truncated file, for as long as nobody looks. Measured on a
// 20KB fixture: interrupt one re-render and every later build serves 10KB of
// it. Worse where the preset wraps a tool whose non-zero exit it does not
// check — it RESOLVES, the manifest snapshots the truncated bytes, and
// --audit-output then reads green, because it compares each output against
// the hash its own render recorded.
//
// Removed only when THIS render is what changed it. A preset that fails
// before writing anything still has a good derivative on disk, and deleting
// that would take a working asset off the site until the next build — so the
// file is measured before and after, and left alone if it did not move.
export async function render({ entity, options, config, context, plugins, runtime, state, logger }) {
    await mkdir(path.dirname(entity.destination), { recursive: true })
    const before = await describe(entity.destination)
    try {
        // The gate is around the PRESET's own code and nothing else. The
        // mkdir and the describe above are cheap and want no slot; taking one
        // for them would just hold the cap for longer than the work does.
        await withGate(entity.preset?.name, options?.concurrency, () =>
            runtime.preset({ entity, options, config, context, plugins, runtime, state, logger }))
    } catch (error) {
        const after = await describe(entity.destination)
        const touched = after && (!before || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
        if (touched) await rm(entity.destination, { force: true })
        throw error
    }
    return entity.destination
}

// `module` says where this renderer's code is, for the worker that cannot ask
// the registry.
//
// A worker resolves a renderer by name — package `mikser-io-render-<name>` —
// and this one lives in a package named for what it produces, not for the
// renderer it ships. Without this the main thread renders presets from the
// registry and every worker-dispatched one renders nothing at all.
//
// `import.meta.url` rather than the package name: it points at THIS file,
// which exports `load` and `render` at module level, so nothing has to be
// re-exported from the index to make it reachable.
export function renderPreset(options = {}) {
    return { name: options.name ?? 'preset', options, load, render, module: import.meta.url }
}
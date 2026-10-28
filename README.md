# mikser-io-assets

Derived files for [mikser-io](https://github.com/almero-digital-marketing/mikser-io).

A **preset** is a module that turns one source file into one derived output —
an image at a size, a video at a bitrate, a poster frame, anything a renderer
can write. This package owns the part that is the same whatever the preset
produces: which files it covers, where its output goes, whether it needs
producing again, and what to do when a derive did not finish.

```bash
npm install mikser-io-assets
```

```js
import { documents, files, frontMatter, renderHbs } from 'mikser-io'
import { assets, renderPreset, assetUrlHelper } from 'mikser-io-assets'

export default {
    plugins: [
        documents(), files(), frontMatter(),
        assets({ presets: { web: { match: ['/files/media/**'] } } }),
        renderPreset(),          // the renderer presets dispatch through
        assetUrlHelper(),        // runtime.asset() for templates
        renderHbs(),
    ],
}
```

`renderPreset()` is not optional. It was resolved implicitly while this code
lived in the engine — mikser-io's renderer lookup falls back to a path inside
its own `src/plugins/render/`, which no longer holds it. Declared in the
plugins array it is an ordinary renderer, the way `renderHbs()` is.

## A preset

`presets/web.js`, or an npm package named `mikser-io-preset-web`:

```js
export const revision = 1        // bump to re-derive everything this preset owns
export const format = 'webp'     // optional: changes the output extension

export default async function web({ entity, options, logger }) {
    // entity.destination is where the engine expects the file.
    await sharp(entity.source ?? entity.uri).webp().toFile(entity.destination)
}
```

The engine hands you a path and you write to it. Nothing else is required.

## What it guarantees

**A derivative is produced once and reused.** A `.md5` marker beside each
output records the source checksum that produced it. Unchanged source, no
work.

**A derive that did not finish is not trusted.** The marker is removed before
a render and written again when it completes, so it can never outlive the
render it describes. If the preset throws, the destination is removed — but
only when that render is what changed it, so a preset failing on a missing
binary keeps the good derivative it already had. If the process is killed
outright, the missing marker beside a present file is detected on the next
ordinary build and the derivative is re-derived (`preset-unfinished`).

This matters more than it sounds. Both gates that could otherwise catch a
half-written file look away: the marker is keyed on the *source* checksum,
which an interruption does not change, and the file is present, so the
engine's missing-output path does not fire either. Without this, a truncated
video stays on the site until someone notices.

**A preset that reports success is believed.** If your preset wraps a tool and
does not check its exit code, it resolves, the manifest records the truncated
bytes, and `--audit-output` reads green. Check your exit codes.

## Where a preset comes from

A preset name resolves in two places, local first:

1. **`presets/<name>.js`** in your project — the common case.
2. **An npm package `mikser-io-preset-<name>`** — when no local file exists, the plugin resolves the name from your project's `node_modules`. Install a shared preset (`npm install mikser-io-preset-thumbnail`) and reference it by name in the `presets` option with no local file. Same resolution convention as `post-*` plugins.

A local file always wins over an npm package of the same name — drop `presets/thumbnail.js` to override one preset from a package while leaving the rest. The two have different update lifetimes: local presets reload on file change in watch mode; npm presets are versioned by their package (bump the dependency to update). `node_modules` is never watched.

If a configured preset name resolves to neither a local file nor an npm package, the plugin logs `Preset not found: <name> ...` and skips it — the rest of the build proceeds.

## Preset module shape

A preset is a default-exported async function. It receives the entity being processed (with `source`, `destination`, `preset`, `name`, etc.), runs whatever code it needs, and resolves (or rejects) when done.

```js
export const revision = 1     // bump to force re-render (cache-bust)
export const format = 'webp'  // output format hint (used in the destination filename)
export const options = {      // defaults for this preset (config can override)
    concurrency: 1,           // how many of ITS renders may run at once
}

export default async ({ entity, runtime, logger }) => {
    // entity.source       — input file on disk
    // entity.destination  — where to write the result
    // entity.preset       — config of the matching preset (name, source, options)
    // entity.name         — original entity name (e.g. '/files/images/hero.jpg')
    // runtime / logger    — mikser context, including runtime.options for paths
}
```

That is the whole contract.

### `concurrency` — a preset that spawns processes

Preset renders are dispatched inline, which the engine runs at
`runtime.options.threads` — **four by default**. That is the right width for
work the engine can see: a sharp resize happens in-process and its memory is
counted. A preset that shells out to `ffmpeg` is not. Four of those are four
external processes the engine never hears about, and two of them measured at
476MB and 329MB RSS beside mikser's own 580MB is enough to get a 2GB container
OOM-killed — which leaves no error, no partial output and nothing in the log,
just a build that stopped.

So a preset says what it can afford, because it is the only thing that knows
it spawns anything at all:

```js
export const options = { concurrency: 1 }
```

Or from config, which wins over the module's default:

```js
assets({ presets: { 'video-web': { match: '@/videos/*', options: { concurrency: 1 } } } })
```

- The cap is **per preset**, so one heavy video preset does not slow the
  thumbnails.
- Leaving it unset means unlimited, exactly as before. Nothing is throttled
  that did not ask to be.
- **A cap no longer means "on the main thread."** The engine's render
  dispatcher holds it, around the dispatch and before inline/worker is
  chosen, so one counter bounds every mode. Add `tasks: 'worker'` beside it
  and a capped, CPU-bound preset runs on the worker pool with its cap intact:

  ```js
  export const options = { concurrency: 2, tasks: 'worker' }
  ```

  That needs mikser-io 11.19.0 or later. Dispatch stays inline by default,
  as it does for every render — the cap stops implying the main thread
  without starting to imply a worker.

## Example: Video transcoding via ffmpeg

A 720×1080 portrait MP4 at 600kbps for the web. fluent-ffmpeg streams progress events back into mikser's logger so the build progress bar reflects encoder progress in real time.

```js
// presets/video-web.js
import ffmpeg from 'fluent-ffmpeg'

export const revision = 7
export const format = 'mp4'

export default ({ entity: { name, source, destination, preset }, logger }) => {
    return new Promise((resolve, reject) => {
        ffmpeg(source)
            .videoCodec('libx264')
            .size('810x1080')
            .videoBitrate(600)
            .outputOptions('-strict -2')
            .on('progress', ({ percent }) =>
                logger.trace(`Progress: [${preset.name}] ${name} ${Math.round(percent)}%`))
            .on('error', reject)
            .on('end', resolve)
            .save(destination)
    })
}
```

10 lines of glue around ffmpeg. Every published video in the catalog gets transcoded; rebuilds skip unchanged inputs because the journal tracks file mtimes; bumping `revision` re-encodes everything (useful when you change the bitrate).

Add `export const options = { concurrency: 1 }` to it. Without one, four
encodes run at once — see [`concurrency`](#concurrency--a-preset-that-spawns-processes).

## Example: Image variants via sharp

Resize + format negotiation. Most projects want srcset variants in WebP and AVIF; this preset emits both with a single sharp pipeline.

```js
// presets/image-2x.js
import sharp from 'sharp'
import { dirname, basename, extname, join } from 'node:path'
import { mkdir } from 'node:fs/promises'

export const revision = 3

export default async ({ entity: { source, destination }, logger }) => {
    const dir   = dirname(destination)
    const stem  = basename(destination, extname(destination))
    await mkdir(dir, { recursive: true })

    const pipeline = sharp(source).rotate()       // honor EXIF orientation
    // 2× variants for each format
    await Promise.all([
        pipeline.clone().resize({ width: 1600 }).webp({ quality: 85 }).toFile(join(dir, `${stem}@2x.webp`)),
        pipeline.clone().resize({ width: 1600 }).avif({ quality: 60 }).toFile(join(dir, `${stem}@2x.avif`)),
        pipeline.clone().resize({ width: 800  }).webp({ quality: 85 }).toFile(join(dir, `${stem}.webp`)),
        pipeline.clone().resize({ width: 800  }).avif({ quality: 60 }).toFile(join(dir, `${stem}.avif`)),
    ])
    logger.trace('image-2x emitted 4 variants for %s', source)
}
```

One preset, four output files per input image. The render-href plugin can then rewrite `<img src="hero.jpg">` to the `@2x.webp` URL with a fallback `<source>` chain — but that's a render-time concern, not the asset plugin's.

## Composition with `resources`

The assets plugin processes whatever's on disk. Source files don't have to start in your repo — the **resources plugin** in mikser-io pulls them from external systems (company content servers, S3, vendor APIs) into the working folder so assets can then process them. That composition is where the "advanced pipeline" idea pays off: resources fetches, assets derives, and the render helpers link to the result.

## Watch support

Yes — the plugin watches both the source files and the preset modules. Editing a preset re-processes every input that matches it; editing a source re-processes just that input.


**Derivatives with no source are removed.** A derivative outlived its source:
deleting a file removed its catalog row and its published copy and left the
derived file, because the delete handler dropped the in-memory mapping and
nothing on disk. Narrowing a preset's `match` left one the same way. A stale
derivative passes every check — the url resolves and the bytes are there —
so the only cleanup was `--clear`, or deleting it by hand.

The post-cycle pass that already walks the revision markers now also asks, per
derivative, whether it still has a source that this preset still covers. It is
answered from the **catalog**, not from the delete event: a delete entry is
sparse (`{ id, type, collection }`) in every source plugin, so it cannot say
where the derivative went, while the catalog answers whatever route the orphan
arrived by — including ones that predate the fix. Reported as
`Assets removed: N derivative(s) with no source`.

It does nothing when the catalog is empty. Every check concludes "no source,
therefore orphan", and an empty catalog answers that for every derivative on
the site, so a failed import would otherwise delete the whole assets folder.

---

## Naming a derivative

A derivative is filed under its source's own name — `files/media/hero.jpg`
becomes `assets/web/media/hero.webp`. When that name must not reach a URL, the
preset's config names it instead:

```js
assets({
    presets: {
        face: {
            match: '/frames/**/*.jpg',
            // '<phone>_<date>__F_WH.jpg' → '<hash>/<date>/F_WH.jpg'; null declines it
            name: (entity) => facePath(entity),
        },
    },
})
```

`match` selects and `name` files: it returns the path inside the preset's
folder (the preset's `format` still sets the extension), or `null` to decline
an entity `match` selected — a source a newer one has replaced, a frame the
site does not show. It is asked again whenever the answer matters, so it can
depend on state outside the entity:

- the URL stamped on the source (`meta.presets`) and the render destination
  both use it;
- an entity it names nothing by the time it renders is not rendered, so a
  replaced source never writes its old bytes under the name its successor
  owns;
- the orphan sweep asks it which source a derivative belongs to, so a
  derivative it no longer names anything to is removed.

Give each source its own name. Two sources named to one path at different
times share a destination, and the older one's bookkeeping can claim the
newer one's file.

## Derivatives with no source are removed

A derivative can outlive its source: deleting a file removes its catalog row
and its published copy, and a stale derivative passes every check — the URL
resolves and the bytes are there — so the only cleanup used to be `--clear`
or deleting it by hand. Narrowing a preset's `match` left one the same way.

The post-cycle pass that walks the revision markers also asks, per derivative,
whether it still has a source that this preset still covers, and removes the
ones that do not. It stands down entirely when the catalog is empty: every
check there concludes "no source, therefore orphan", and a failed import would
otherwise delete the whole derived tree.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `presets` | `{}` | `{ name: pattern }` or `{ name: { match, options, name } }`. Patterns match entity ids; `name` files a derivative under a path of its own (see [Naming a derivative](#naming-a-derivative)). |
| `assetsFolder` | `'assets'` | Where derivatives are written, relative to the working folder. Served through a symlink into the output. |
| `presetsFolder` | `'presets'` | Where local preset modules live. |
| `auditIgnore` | `[]` | Globs `--audit-output` should not report as orphans. For a preset that writes **more than one file**: the engine records the one destination it handed over, so extras are genuinely unclaimed and genuinely reported. |

On the command line: `--assets <folder>`, `--presets <folder>`, and
`--render-presets [name]` to re-derive though nothing moved — the escape hatch
for what the incremental machinery cannot see (a preset edited without bumping
`revision`, an image library upgraded underneath the build).

## Codes

| Code | Meaning |
| --- | --- |
| `preset-unfinished` | A derivative has no completed-render marker; it is being re-derived. |
| `preset-no-match` | A configured preset matched none of the entities evaluated. |
| `preset-unknown` | `--render-presets` named a preset that is not configured. |

`asset-missing` is not one of these. It comes from mikser-io itself: the
engine records which asset URLs a template asked for and checks them against
the output folder at finalize, which it does whether or not this package is
installed. The render track and that check are substrate; producing the files
is this package's job.

## What a cycle reports

Planning is the step between "the journal says these entities moved" and "the
dispatcher has tasks". It runs once per entity per preset, so it grows with
the product of the two, and it used to be invisible: on a site with 6,800
entities and 29 presets there were two minutes between one journal line and
the next, with the process at 100% of a core and answering nothing.

```
Assets marker scan: 1.4s
Assets unfinished sweep: 0.3s
Assets planning: 20287 render task(s), 20287 reused, in 6.3s, first dispatched after 68ms
```

Each line is `info` when the step took a second or more and `debug` otherwise,
so an ordinary incremental cycle stays quiet. `first dispatched after` is the
streaming property: tasks go to the dispatcher in batches as they are planned,
not in one write at the end.

The engine's own `First render after` line sits next to these — see
[Where a cycle spends its time](https://github.com/almero-digital-marketing/mikser-io/blob/main/docs/diagnostics.md).

Planning gives the event loop a turn regularly, so HTTP and MCP keep answering
while it runs. It is still one thread: a cycle at this size takes as long as
it takes, and what changed is that it says so and stays reachable.

## Limits

A derivative's reuse is decided from the completed-render marker, which is
keyed on the SOURCE checksum. A preset that writes more than one file gets a
marker for the destination the engine handed it and no claim on the rest; name
those in `auditIgnore`.

## Licence

MIT

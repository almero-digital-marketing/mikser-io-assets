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

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `presets` | `{}` | `{ name: pattern }` or `{ name: { match, options } }`. Patterns match entity ids. |
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

## Limits

Preset renders are dispatched INLINE. A worker sees an empty renderer registry
and resolves by package name (`mikser-io-render-<name>`), which this package
does not provide — so `task: worker` is not available for presets.

## Licence

MIT

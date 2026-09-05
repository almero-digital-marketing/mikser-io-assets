// mikser-io-assets — derived files for mikser-io.
//
// A preset is a module that turns one source file into one derived output:
// an image at a size, a video at a bitrate, anything a renderer can write.
// The engine has no opinion on what a preset produces; this package owns the
// part that is the same whatever it is — which files a preset covers, where
// its output goes, whether it needs producing again, and what to do when a
// derive did not finish.
//
// Three exports, and they are three different jobs. The names say which:
//
//   assets()          runs presets and produces derivatives  (the work)
//   renderPreset()    the renderer the engine dispatches to  (a renderer)
//   assetUrlHelper()  provides runtime.asset() to templates  (a URL helper)
//
// The helper carries `Helper` in its name for exactly this reason. Adding
// renderPreset() to a plugin list expecting a URL helper makes every page
// render throw, and a crash reads as "you have found something real" — a much
// more expensive wrong signal than a no-op.
//
// Split out of mikser-io in 10.12.0. It was never substrate: it encodes one
// recipe for producing files from files, the way mikser-io-layouts encodes
// one recipe for producing render tasks. The engine keeps what IS substrate —
// the render track that records which asset URLs a template asked for, and
// the finalize check that reports the ones nothing produced — because those
// work the same whether or not this package is installed.

export { assets, presetUrl, normalizePresetConfig } from './lib/assets.js'
export { renderPreset } from './lib/preset.js'
export { assetUrlHelper } from './lib/asset.js'

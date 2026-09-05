// The renderer/helper distinction, asserted on this package's own exports.
//
// The `render` prefix was doing two jobs in mikser-io, and naming factories
// after the object they concern rather than the job they do led someone to
// add renderPreset() expecting a template helper and watch every page render
// throw: the inference was wrong and entirely reasonable.
//
// This package ships one of each, which is exactly the pair that caused it:
//
//   renderPreset()    a RENDERER — has render(), turns an entity into a file
//   assetUrlHelper()  a HELPER   — installs runtime.asset(), renders nothing
//
// mikser-io asserts the same rule over the factories it kept. A convention
// that spans two packages has to hold in both, or it holds in neither.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { assetUrlHelper, renderPreset, assets } from '../index.js'

describe('factories are named for their role', () => {
    it('assetUrlHelper installs helpers and renders nothing', () => {
        const descriptor = assetUrlHelper({})
        assert.equal(typeof descriptor.load, 'function')
        assert.equal(descriptor.render, undefined,
            'a helper factory must not have render() — that is the whole distinction')
    })

    it('renderPreset is a real renderer and DOES have render()', () => {
        assert.equal(typeof renderPreset({}).render, 'function')
    })

    it('assets() is a lifecycle plugin — neither of the above', () => {
        // The third shape, and the one people reach for first. It returns the
        // (core) => void closure the engine calls at onLoad.
        assert.equal(typeof assets({}), 'function')
    })
})

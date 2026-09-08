import { afterEach, describe, expect, it } from 'vitest'
import { defaultProfileFor, detectRuntimeForm } from '../src/form.ts'

const savedForm = process.env.DSH_FORM

afterEach(() => {
  if (savedForm === undefined) delete process.env.DSH_FORM
  else process.env.DSH_FORM = savedForm
})

describe('detectRuntimeForm', () => {
  it('explicit DSH_FORM wins in both directions', () => {
    process.env.DSH_FORM = 'desktop'
    expect(detectRuntimeForm()).toBe('desktop')
    process.env.DSH_FORM = 'web'
    expect(detectRuntimeForm()).toBe('web')
  })

  it('an unknown DSH_FORM value falls through to detection', () => {
    process.env.DSH_FORM = 'wearable'
    // Node test process has no Electron marker → web.
    expect(detectRuntimeForm()).toBe('web')
  })

  it('a plain node process is the web form (regression: old default)', () => {
    delete process.env.DSH_FORM
    expect(detectRuntimeForm()).toBe('web')
  })

  it('an Electron runtime marker means the desktop host', () => {
    delete process.env.DSH_FORM
    const versions = process.versions as NodeJS.ProcessVersions & Record<string, string | undefined>
    const saved = versions.electron
    versions.electron = '33.0.0'
    try {
      expect(detectRuntimeForm()).toBe('desktop')
    } finally {
      if (saved === undefined) delete versions.electron
      else versions.electron = saved
    }
  })
})

describe('defaultProfileFor', () => {
  it('desktop form defaults to the desktop profile', () => {
    expect(defaultProfileFor('desktop')).toBe('desktop')
    expect(defaultProfileFor('web')).toBe('web')
  })
})

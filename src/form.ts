/**
 * Runtime form detection: which surface this plugin instance serves.
 * @module dsh-lark-bridge/form
 */

/**
 * Resolve this instance's form. `DSH_FORM` keeps its explicit override role
 * (the WSL systemd unit sets it), but the Desktop 2.0.0 app hosts the harness
 * inside its Electron main process and sets no DSH_* environment at all — the
 * Electron runtime marker is the one signal that is always present there. A
 * bare `dsh web` process stays the web form it always was.
 *
 * The profile default follows the form: the Desktop app manages a profile
 * literally named `desktop`, so an instance that does not name one inherits
 * the right profile instead of pretending to be `web`.
 */
export function detectRuntimeForm(): 'web' | 'desktop' {
  const explicit = process.env.DSH_FORM
  if (explicit === 'desktop' || explicit === 'web') return explicit
  const versions = process.versions as NodeJS.ProcessVersions & Record<string, string | undefined>
  if (versions.electron !== undefined) return 'desktop'
  return 'web'
}

/** The profile an instance runs under when nothing names one explicitly. */
export function defaultProfileFor(form: 'web' | 'desktop'): string {
  return form === 'desktop' ? 'desktop' : 'web'
}

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
export declare function detectRuntimeForm(): 'web' | 'desktop';
/** The profile an instance runs under when nothing names one explicitly. */
export declare function defaultProfileFor(form: 'web' | 'desktop'): string;
//# sourceMappingURL=form.d.ts.map
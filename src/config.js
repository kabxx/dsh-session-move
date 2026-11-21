import manifest from '../package.json' with { type: 'json' }

export function storagePaths(ctx) {
  const home = (...segments) => ctx.dshHomePath('plugins', '@kabxx', 'dsh-session-move', ...segments)
  return {
    root: ctx.dshHomePath('sessions'),
    base: home(`v${manifest.version}`, 'transactions'),
    previous: ['v0.1.1', 'v0.1.2'].map((version) => home(version)),
    legacy: home('v0.1.0'),
  }
}

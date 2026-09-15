// esbuild `--define` values. Both are constants at build time, which is what
// lets dead-code elimination drop the dev account switcher and the whole mock
// backend from a production bundle (client-port spec §12.8).
declare const __AUTH_MODE__: 'workos' | 'fake';
declare const __MOCK__: boolean;

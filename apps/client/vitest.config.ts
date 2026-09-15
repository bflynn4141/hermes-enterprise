import { defineConfig } from 'vitest/config';

// The client's unit tests are pure: the reducer is a function, and the adapter
// is driven through a fake socket and a fetch mock. Nothing here needs a DOM,
// which is what keeps them fast enough to run on every save.
export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
    globals: true,
  },
  define: {
    __AUTH_MODE__: JSON.stringify('fake'),
    __MOCK__: 'false',
  },
});

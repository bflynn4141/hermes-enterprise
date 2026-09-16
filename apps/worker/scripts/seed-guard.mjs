// Safety boundary for the development fixture seed.
//
// Local databases are safe by location. Remote databases are safe only when
// their database name explicitly says `test`; every other target needs the
// exceptional override. The display value deliberately omits credentials and
// query parameters so it can be printed before the first mutation.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const TEST_DATABASE = /(^|[_-])test($|[_-])/i;

export function inspectSeedTarget(connectionString) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('DATABASE_URL_OWNER must be a valid PostgreSQL URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL_OWNER must use postgres:// or postgresql://');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  if (!database) throw new Error('DATABASE_URL_OWNER must name a database');

  return {
    display: `${url.protocol}//${url.host}/${encodeURIComponent(database)}`,
    local: LOCAL_HOSTS.has(url.hostname),
    test: TEST_DATABASE.test(database),
  };
}

export function assertSeedTargetAllowed(connectionString, override) {
  const target = inspectSeedTarget(connectionString);
  const exceptionalOverride = override === '1';
  if (!target.local && !target.test && !exceptionalOverride) {
    throw new Error(
      `Refusing to seed non-local, non-test database ${target.display}. ` +
        'Set HERMES_SEED_ALLOW_NONLOCAL=1 only for an exceptional, intentional seed.',
    );
  }
  return { ...target, exceptionalOverride };
}

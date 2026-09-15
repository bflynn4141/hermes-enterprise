// One place that knows how to reach the local database.
//
// Three roles mean three connection strings. They are assembled from parts so
// that no credential is written as a literal URL anywhere in the repository,
// and every part can be overridden by an environment variable, which is how CI
// and a future staging branch point the same scripts somewhere else.
const host = process.env.PGHOST ?? '127.0.0.1';
const port = process.env.PGPORT ?? '5433';
const database = process.env.PGDATABASE ?? 'hermes';

// Superuser, used only to create the three roles and hand the schema to owner.
const superuser = process.env.PGSUPERUSER ?? 'postgres';
const superpass = process.env.PGSUPERPASSWORD ?? 'postgres';

// Local development credentials. Never used outside Docker: staging and
// production read DATABASE_URL_* from the environment.
const localSecret = process.env.PGLOCALPASSWORD ?? 'localdev';

export const ROLES = /** @type {const} */ (['owner', 'app', 'agent']);

const url = (user, password) =>
  `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;

export const SUPERUSER_URL = process.env.DATABASE_URL_SUPERUSER ?? url(superuser, superpass);
export const OWNER_URL = process.env.DATABASE_URL_OWNER ?? url('owner', localSecret);
export const APP_URL = process.env.DATABASE_URL_APP ?? url('app', localSecret);
export const AGENT_URL = process.env.DATABASE_URL_AGENT ?? url('agent', localSecret);

export const LOCAL_ROLE_PASSWORD = localSecret;
export const DATABASE_NAME = database;

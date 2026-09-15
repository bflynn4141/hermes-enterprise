// Types for db-config.mjs, which is plain JavaScript because the database
// scripts run under bare `node` with no build step: a migration runner that
// needs compiling is a migration runner that cannot be run during an incident.
export declare const ROLES: readonly ['owner', 'app', 'agent'];
export declare const SUPERUSER_URL: string;
export declare const OWNER_URL: string;
export declare const APP_URL: string;
export declare const AGENT_URL: string;
export declare const LOCAL_ROLE_PASSWORD: string;
export declare const DATABASE_NAME: string;

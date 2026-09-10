/**
 * Version utility - single source of truth for the backend application version.
 * Read from package.json at module load time so the value is always in sync with
 * the published package version without any manual duplication.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../../package.json') as { version: string; name: string };

export const APP_VERSION: string = pkg.version;
export const APP_NAME: string = pkg.name;
export const BUILD_DATE: string = new Date().toISOString();

export interface VersionInfo {
  name: string;
  version: string;
  buildDate: string;
  nodeVersion: string;
  env: string;
}

export function getVersionInfo(): VersionInfo {
  return {
    name: APP_NAME,
    version: APP_VERSION,
    buildDate: BUILD_DATE,
    nodeVersion: process.version,
    env: process.env.NODE_ENV ?? 'development',
  };
}

/**
 * The three test projects.
 *
 * Business rules run in `node`: the domain must not be able to reach a DOM, and a test
 * that passes only because a browser global happened to exist is not evidence. The web app
 * runs in `jsdom` because its tests assert what a person sees on the screen. The web
 * project keeps its own config so the React plugin stays a dependency of the package that
 * needs it, rather than leaking into the workspace root.
 *
 * `integration` is listed here so it shares the workspace, but it is deliberately excluded
 * from `pnpm test`: it needs a running database, and a unit suite that cannot run without
 * Docker is a unit suite people stop running.
 */
export default ['./vitest.config.ts', './apps/web/vitest.config.ts', './vitest.integration.ts'];

/**
 * Standalone Worker entry point.
 *
 * The Cloudflare Pages deployment (pages/_worker.js) and this standalone
 * deployment share exactly one implementation. Keeping two hand-edited copies
 * caused the standalone build to miss POST /api/private/repack and other
 * routes. Wrangler bundles this imported module into the Worker; R2 is bound as
 * ASSETS in worker/wrangler.toml, while Pages maps R2_ASSETS onto env.ASSETS.
 */
export {handle, __test} from "../pages/worker-api.js";
export {default} from "../pages/worker-api.js";

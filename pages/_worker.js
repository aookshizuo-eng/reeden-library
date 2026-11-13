import api from "./worker-api.js";

const API_PREFIXES = ["/healthz", "/api/"];

function isApiPath(pathname) {
  return API_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (isApiPath(url.pathname)) {
      // Pages reserves env.ASSETS for static files. The API uses R2_ASSETS.
      return api.fetch(request, { ...env, ASSETS: env.R2_ASSETS }, ctx);
    }
    return env.ASSETS.fetch(request);
  },
};

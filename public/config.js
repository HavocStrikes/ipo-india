/* Deployment config — IPO India
 *
 * apiBase: where the JSON API lives.
 *   ''            → same origin. Correct for `npm start`, `wrangler dev`, and
 *                   when the Worker itself serves this frontend.
 *   'https://…'   → the deployed Worker URL, when this frontend is hosted
 *                   elsewhere (e.g. GitHub Pages). The Worker already returns
 *                   Access-Control-Allow-Origin: * on every /api response, so
 *                   cross-origin calls work without further setup.
 * The GitHub Pages workflow rewrites this line from the repo variable
 * IPO_API_BASE at deploy time — no manual edit needed.
 */
window.IPO_CONFIG = { apiBase: '' };

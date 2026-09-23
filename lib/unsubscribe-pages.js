/**
 * Shared HTML for the one-click unsubscribe flow — served by server.js (Node)
 * and the Worker, which must render byte-identical pages.
 */
const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function invalidLinkPage() {
  return '<!doctype html><html><head><meta charset="utf-8"><title>IPO India</title></head><body style="font-family:Arial,sans-serif;background:#f4f6fd;color:#0e1428;display:grid;place-items:center;min-height:100vh;margin:0"><div style="text-align:center;padding:24px"><h1>Invalid link</h1><p style="color:#4a546e">This unsubscribe link is broken or incomplete.</p></div></body></html>';
}

function unsubscribedPage({ removed, email }) {
  const emailEsc = esc(email);
  return (
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribed — IPO India</title></head>` +
    `<body style="font-family:Arial,sans-serif;background:#f4f6fd;color:#0e1428;display:grid;place-items:center;min-height:100vh;margin:0">` +
    `<div style="text-align:center;padding:24px"><div style="font-size:40px">✓</div><h1 style="margin:8px 0">You&rsquo;re unsubscribed</h1>` +
    `<p style="color:#4a546e">${removed ? `<b>${emailEsc}</b> has been removed from the IPO India mailing list.` : 'This address was not on the mailing list.'}</p>` +
    `<p style="font-size:12px;color:#8a94ad">Sorry to see you go — you can always resubscribe on the site.</p></div></body></html>`
  );
}

module.exports = { invalidLinkPage, unsubscribedPage };
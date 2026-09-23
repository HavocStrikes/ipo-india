/**
 * Shared "wire" helpers used by BOTH server.js (Node) and the Worker.
 *
 *  - summarize(): project a full record OR an already-summarized list entry
 *    down to the /api/ipos row shape. Tolerant of both shapes so it can be
 *    applied idempotently (idempotent = safe for the KV-stored summaries).
 *  - countKnown(): how many "known" fields a record carries — used to pick
 *    the richer record when the same IPO id appears twice.
 *  - inWindow(): curated same-window filter (upcoming opens within the next
 *    N days, listed/closed within the last N days) shared by /api/ipos and
 *    the /api/meta counts.
 *
 * CommonJS so Node can require() it; wrangler/esbuild interops the named
 * imports on the Worker side exactly like it already does for lib/normalize.js.
 */
function countKnown(ipo) {
  let n = 0;
  if (ipo.closeDate) n++;
  if (ipo.listingDate) n++;
  if (ipo.subscriptionX !== null && ipo.subscriptionX !== undefined) n++;
  if (ipo.financials && ipo.financials.patCr !== null) n++;
  if (ipo.kpi && ipo.kpi.pePost !== null) n++;
  return n;
}

function summarize(ipo) {
  return {
    id: ipo.id,
    name: ipo.name,
    slug: ipo.slug ?? null,
    category: ipo.category ?? null,
    exchange: ipo.exchange ?? null,
    status: ipo.status,
    openDate: ipo.openDate ?? null,
    closeDate: ipo.closeDate ?? null,
    allotmentDate: ipo.allotmentDate ?? null,
    listingDate: ipo.listingDate ?? null,
    issuePrice: ipo.issuePrice ?? null,
    issueAmountCr: ipo.issueAmountCr ?? null,
    subscriptionX: ipo.subscriptionX ?? null,
    liveSub: ipo.liveSub ?? null,
    listingGainPct: ipo.listingGainPct ?? (ipo.listing && ipo.listing.gainPct) ?? null,
    listingOpenPrice: ipo.listingOpenPrice ?? (ipo.listing && ipo.listing.openPrice) ?? null,
    marketPrice: ipo.marketPrice ?? (ipo.market && ipo.market.price) ?? null,
    pePost: ipo.pePost ?? (ipo.kpi && ipo.kpi.pePost) ?? null,
    ronw: ipo.ronw ?? (ipo.kpi && (ipo.kpi.ronw ?? ipo.kpi.roe)) ?? null,
    score: ipo.score
      ? { score: ipo.score.score, tone: ipo.score.tone, confidence: ipo.score.confidence, pillars: ipo.score.pillars || null }
      : null,
    detailUrl: ipo.detailUrl ?? null,
    nseSymbol: ipo.nseSymbol ?? null,
    known: ipo.known ?? countKnown(ipo),
  };
}

/** True if the IPO's key date falls inside the curated window for its status. */
function inWindow(ipo, status, windowDays, now = new Date()) {
  const day = 86400000;
  const t = now.toISOString().slice(0, 10);
  const from = new Date(now.getTime() - windowDays * day).toISOString().slice(0, 10);
  const to = new Date(now.getTime() + windowDays * day).toISOString().slice(0, 10);
  if (status === 'upcoming') return !!ipo.openDate && ipo.openDate >= t && ipo.openDate <= to;
  if (status === 'listed') return !!ipo.listingDate && ipo.listingDate <= t && ipo.listingDate >= from;
  if (status === 'closed') return !!ipo.closeDate && ipo.closeDate < t && ipo.closeDate >= from;
  return true;
}

module.exports = { countKnown, summarize, inWindow };
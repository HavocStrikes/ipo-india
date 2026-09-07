/**
 * IPO Investability Score (0-100) — a transparent, rule-based model.
 *
 * Pillars:
 *  1. Demand        (25) — subscription depth (QIB/retail interest proxy)
 *  2. Fundamentals  (25) — RoNW/ROE, PAT margin, leverage
 *  3. Valuation     (20) — P/E post-issue, P/B vs profitability
 *  4. Performance   (15) — listed: listing gain + return since issue;
 *                          unlisted: anchor investor commitment
 *  5. Sentiment     (15) — analyst/community review votes (apply vs avoid)
 *
 * SME issues carry a risk haircut (SME platforms are thinner markets).
 * Every pillar degrades gracefully to a neutral score when data is missing,
 * so scores are always present but honest about low-confidence inputs
 * (see `confidence`).
 */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function demandScore(sub) {
  const x = sub && sub.total;
  if (x === null || x === undefined) return { pts: 12.5, note: 'no subscription data yet' };
  let pts;
  if (x >= 50) pts = 25;
  else if (x >= 20) pts = 22;
  else if (x >= 10) pts = 19;
  else if (x >= 5) pts = 16;
  else if (x >= 3) pts = 14;
  else if (x >= 1) pts = 10;
  else if (x >= 0.5) pts = 6;
  else pts = 3;
  return { pts, note: `${x}x subscribed` };
}

function fundamentalsScore(ipo) {
  const k = ipo.kpi || {};
  const f = ipo.financials || {};
  const parts = [];

  // Profitability (RoNW or ROE) -> 0-10
  const ronw = k.ronw ?? k.roe;
  if (ronw !== null && ronw !== undefined) {
    parts.push(ronw >= 25 ? 10 : ronw >= 18 ? 8.5 : ronw >= 12 ? 6.5 : ronw >= 8 ? 4.5 : ronw > 0 ? 2 : 0);
  }

  // PAT margin -> 0-7
  if (k.patMargin !== null && k.patMargin !== undefined) {
    parts.push(k.patMargin >= 15 ? 7 : k.patMargin >= 10 ? 5.5 : k.patMargin >= 5 ? 4 : k.patMargin > 0 ? 2 : 0);
  }

  // Leverage (Debt / Net Worth) -> 0-8
  if (f.borrowingsCr !== null && f.netWorthCr !== null && f.netWorthCr > 0) {
    const de = f.borrowingsCr / f.netWorthCr;
    parts.push(de <= 0.25 ? 8 : de <= 0.5 ? 6.5 : de <= 1 ? 4.5 : de <= 2 ? 2.5 : 0.5);
  }

  if (!parts.length) return { pts: 12.5, note: 'fundamentals unavailable' };
  const pts = parts.reduce((a, b) => a + b, 0);
  return { pts, note: `RoNW ${k.ronw ?? 'NA'}%, PAT margin ${k.patMargin ?? 'NA'}%` };
}

function valuationScore(ipo) {
  const k = ipo.kpi || {};
  const parts = [];

  // P/E post issue -> 0-12
  const pe = k.pePost ?? k.pePre;
  if (pe !== null && pe !== undefined && pe > 0) {
    parts.push(pe <= 15 ? 12 : pe <= 25 ? 9.5 : pe <= 40 ? 6 : pe <= 70 ? 3 : 1);
  }

  // P/B vs RoNW (cheap book vs quality book) -> 0-8
  if (k.priceToBook !== null && k.priceToBook !== undefined && k.priceToBook > 0) {
    const pb = k.priceToBook;
    const ronw = k.ronw ?? k.roe;
    const fairPb = ronw ? clamp(ronw / 8, 1, 6) : 2.5;
    const ratio = pb / fairPb;
    parts.push(ratio <= 0.8 ? 8 : ratio <= 1.2 ? 6.5 : ratio <= 1.8 ? 4.5 : ratio <= 2.6 ? 2.5 : 0.5);
  }

  if (!parts.length) return { pts: 10, note: 'valuation metrics unavailable' };
  return { pts: parts.reduce((a, b) => a + b, 0), note: `P/E ${pe ?? 'NA'}, P/B ${k.priceToBook ?? 'NA'}` };
}

function performanceScore(ipo) {
  const t = new Date().toISOString().slice(0, 10);
  const listed = ipo.listingDate && ipo.listingDate <= t;

  if (listed) {
    const gain = ipo.listing && ipo.listing.gainPct;
    const price = ipo.market && ipo.market.price;
    const issue = ipo.issuePrice;
    const parts = [];
    if (gain !== null && gain !== undefined) {
      parts.push(gain >= 40 ? 9 : gain >= 20 ? 7.5 : gain >= 5 ? 6 : gain >= 0 ? 4 : gain >= -10 ? 1.5 : 0);
    }
    if (price !== null && price !== undefined && issue) {
      const ret = ((price - issue) / issue) * 100;
      parts.push(ret >= 50 ? 6 : ret >= 20 ? 5 : ret >= 0 ? 3.5 : ret >= -20 ? 1.5 : 0);
    }
    if (!parts.length) return { pts: 7.5, note: 'no post-listing price data' };
    return { pts: parts.reduce((a, b) => a + b, 0), note: `listing gain ${gain ?? 'NA'}%` };
  }

  const a = ipo.anchors || {};
  if (a.amountCr !== null && a.amountCr !== undefined && a.amountCr > 0) {
    const pct = a.pctOfIssue;
    const pts = pct !== null && pct !== undefined ? clamp((pct / 40) * 15, 2, 15) : 10;
    return { pts, note: `anchors committed ₹${a.amountCr} Cr` };
  }
  return { pts: 7.5, note: 'no anchor book yet' };
}

function sentimentScore(reviews) {
  if (!reviews) return { pts: 7.5, note: 'no reviews' };
  const total = reviews.subscribe + reviews.neutral + reviews.avoid;
  if (!total) return { pts: 7.5, note: 'no reviews' };
  const pos = (reviews.subscribe + 0.5 * reviews.neutral) / total;
  return { pts: pos * 15, note: `${reviews.subscribe}/${total} reviews say apply` };
}

function verdictOf(score) {
  if (score >= 75) return { label: 'Strong Buy', tone: 'great' };
  if (score >= 60) return { label: 'Apply', tone: 'good' };
  if (score >= 45) return { label: 'Hold / Watch', tone: 'neutral' };
  if (score >= 30) return { label: 'Avoid', tone: 'weak' };
  return { label: 'Strong Avoid', tone: 'bad' };
}

function computeScore(ipo) {
  const pillars = {
    demand: demandScore({ total: ipo.subscriptionX }),
    fundamentals: fundamentalsScore(ipo),
    valuation: valuationScore(ipo),
    performance: performanceScore(ipo),
    sentiment: sentimentScore(ipo.reviews),
  };

  let score = Object.values(pillars).reduce((a, p) => a + p.pts, 0);

  const isSME = (ipo.category || '').toLowerCase() === 'sme';
  if (isSME) score *= 0.88; // SME risk haircut (illiquidity, higher failure rate)

  score = Math.round(clamp(score, 0, 100) * 10) / 10;

  const confidence = (() => {
    let known = 0;
    if (ipo.subscriptionX !== null && ipo.subscriptionX !== undefined) known++;
    if (ipo.kpi && (ipo.kpi.ronw !== null || ipo.kpi.pePost !== null)) known++;
    if (ipo.financials && ipo.financials.patCr !== null) known++;
    if (ipo.reviews && ipo.reviews.subscribe + ipo.reviews.neutral + ipo.reviews.avoid > 0) known++;
    return known >= 3 ? 'high' : known >= 2 ? 'medium' : 'low';
  })();

  const verdict = verdictOf(score);

  return { score, verdict: verdict.label, tone: verdict.tone, confidence, pillars, isSME };
}

module.exports = { computeScore };



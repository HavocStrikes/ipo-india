/**
 * Famous/Notable IPOs that people search for — deep history is kept for these.
 * Shared by server.js (buildNotableDataset) and the Worker (refreshData +
 * the Mainboard alert pipeline) so the watchlist can never drift apart.
 */
const NOTABLE_NAMES = [
  'zomato', 'swiggy', 'paytm', 'one97', 'lic', 'life insurance',
  'oyo', 'phonepe', 'flipkart', 'jio', 'reliance jio',
  'delhivery', 'nykaa', 'fsn e-ventures', 'idea',
  'sbi cards', 'policybazaar', 'pb fintech',
  'hdfc bank', 'hdfc life', 'icici lombard',
  'tata motors', 'tata technologies', 'hyundai',
  'coal india', 'rec limited', 'pfc',
];

const isNotableName = (name) => {
  const n = String(name || '').toLowerCase();
  return NOTABLE_NAMES.some((k) => n.includes(k));
};

module.exports = { NOTABLE_NAMES, isNotableName };

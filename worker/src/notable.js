/**
 * Famous/Notable IPOs that people search for — deep history is kept for these.
 * Shared by the dataset builder (index.js) and the alert pipeline (alerts.js,
 * which sends "deep dive" emails when one of these opens).
 */
export const NOTABLE_NAMES = [
  'zomato', 'swiggy', 'paytm', 'one97', 'lic', 'life insurance',
  'oyo', 'phonepe', 'flipkart', 'jio', 'reliance jio',
  'delhivery', 'nykaa', 'fsn e-ventures', 'idea',
  'sbi cards', 'policybazaar', 'pb fintech',
  'hdfc bank', 'hdfc life', 'icici lombard',
  'tata motors', 'tata technologies', 'hyundai',
  'coal india', 'rec limited', 'pfc',
];

export const isNotableName = (name) => {
  const n = String(name || '').toLowerCase();
  return NOTABLE_NAMES.some((k) => n.includes(k));
};

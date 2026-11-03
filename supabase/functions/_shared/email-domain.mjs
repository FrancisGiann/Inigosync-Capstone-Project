const DNS_JSON_URL = 'https://dns.google/resolve';
const DNS_TIMEOUT_MS = 3000;

async function queryDns(domain, type, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DNS_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${DNS_JSON_URL}?name=${encodeURIComponent(domain)}&type=${type}`, {
      headers: { Accept: 'application/dns-json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error('DNS lookup failed');
    const result = await response.json();
    if (!result || typeof result !== 'object') throw new Error('DNS lookup failed');
    if (result.Status === 3) return [];
    if (result.Status !== 0) throw new Error('DNS lookup failed');
    return Array.isArray(result.Answer) ? result.Answer : [];
  } finally {
    clearTimeout(timer);
  }
}

// A DNS mail route is a useful typo check, but cannot prove that a mailbox
// exists. Domains without MX records may still receive mail via their A/AAAA
// records, per SMTP fallback behavior. Null MX explicitly opts out of mail.
export async function emailDomainCanReceiveMail(email, fetchImpl = fetch) {
  const domain = email.slice(email.lastIndexOf('@') + 1);
  const mx = await queryDns(domain, 'MX', fetchImpl);
  const mxAnswers = mx.filter(answer => answer.type === 15 && typeof answer.data === 'string');
  if (mxAnswers.some(answer => /^\s*\d+\s+\.\s*$/.test(answer.data))) return false;
  if (mxAnswers.some(answer => /^\s*\d+\s+\S+\.?\s*$/.test(answer.data))) return true;
  const [a, aaaa] = await Promise.all([
    queryDns(domain, 'A', fetchImpl),
    queryDns(domain, 'AAAA', fetchImpl),
  ]);
  return [...a, ...aaaa].some(answer => (answer.type === 1 || answer.type === 28) && typeof answer.data === 'string' && answer.data.length > 0);
}

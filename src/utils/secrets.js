const KNOWN_SECRET_PATTERNS = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-or-[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bnvapi-[A-Za-z0-9_-]{8,}\b/g,
  /\bgsk_[A-Za-z0-9_-]{8,}\b/g,
  /\bxai-[A-Za-z0-9_-]{8,}\b/g,
  /\bpplx-[A-Za-z0-9_-]{8,}\b/g,
  /\bfw_[A-Za-z0-9_-]{8,}\b/g,
  /\bcsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bup-[A-Za-z0-9_-]{8,}\b/g,
  /\bAIza[ A-Za-z0-9_-]{20,}\b/g,
];

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function maskSecret(secret) {
  const s = String(secret || '');
  if (!s) return '';
  if (s.length <= 8) return '***';
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}

export function redactSecrets(value, extraSecrets = []) {
  if (value == null) return value;
  let text = String(value);

  for (const secret of extraSecrets) {
    const s = String(secret || '');
    if (s.length < 4) continue;
    text = text.replace(new RegExp(escapeRegExp(s), 'g'), maskSecret(s));
  }

  for (const pattern of KNOWN_SECRET_PATTERNS) {
    text = text.replace(pattern, (match) => maskSecret(match));
  }

  return text;
}

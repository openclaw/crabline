const WHATSAPP_USER_JID_RE = /^(\d{7,15})(?::(\d+))?@(c\.us|lid|s\.whatsapp\.net)$/iu;
const WHATSAPP_GROUP_JID_RE = /^(\d{5,20}(?:-\d{5,20})?)@g\.us$/iu;

export function canonicalizeWhatsAppUserJid(value: string): string | undefined {
  const match = WHATSAPP_USER_JID_RE.exec(value.trim());
  if (!match) {
    return undefined;
  }
  const user = match[1]!;
  const device = match[2];
  const rawServer = match[3]!.toLowerCase();
  const server = rawServer === "c.us" ? "s.whatsapp.net" : rawServer;
  return `${user}${device === undefined ? "" : `:${device}`}@${server}`;
}

export function canonicalizeWhatsAppUserCorrelationJid(value: string): string | undefined {
  const jid = canonicalizeWhatsAppUserJid(value);
  if (!jid) {
    return undefined;
  }
  const separator = jid.lastIndexOf("@");
  return `${jid.slice(0, separator).split(":", 1)[0]}@${jid.slice(separator + 1)}`;
}

export function canonicalizeWhatsAppGroupJid(value: string): string | undefined {
  const match = WHATSAPP_GROUP_JID_RE.exec(value.trim());
  return match ? `${match[1]}@g.us` : undefined;
}

export function canonicalizeWhatsAppChatJid(value: string): string | undefined {
  return canonicalizeWhatsAppUserJid(value) ?? canonicalizeWhatsAppGroupJid(value);
}

export function isWhatsAppGroupJid(value: string): boolean {
  return canonicalizeWhatsAppGroupJid(value) !== undefined;
}

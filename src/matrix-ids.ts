import { isIP } from "node:net";

const MAX_MATRIX_IDENTIFIER_BYTES = 255;

function isMatrixIpv4Address(value: string): boolean {
  const octets = value.split(".");
  return (
    octets.length === 4 && octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255)
  );
}

export function isMatrixServerName(value: string): boolean {
  const ipv6 = /^\[([^\]]+)\](?::(\d{1,5}))?$/u.exec(value);
  if (ipv6) {
    return isIP(ipv6[1]!) === 6;
  }
  const hostAndPort = /^([^:]+?)(?::(\d{1,5}))?$/u.exec(value);
  if (!hostAndPort) {
    return false;
  }
  const hostname = hostAndPort[1]!;
  if (isMatrixIpv4Address(hostname)) {
    return true;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/u.test(hostname)) {
    return false;
  }
  return hostname.length <= 255 && /^[A-Za-z0-9.-]+$/u.test(hostname);
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isMatrixScopedIdentifier(value: string, sigil: "!" | "$" | "@"): boolean {
  const separator = value.indexOf(":");
  const localpart = value.slice(1, separator);
  return (
    value.startsWith(sigil) &&
    Buffer.byteLength(value, "utf8") <= MAX_MATRIX_IDENTIFIER_BYTES &&
    separator >= (sigil === "@" ? 1 : 2) &&
    !localpart.includes("\0") &&
    !hasLoneSurrogate(localpart) &&
    isMatrixServerName(value.slice(separator + 1))
  );
}

function isMatrixHashIdentifier(
  value: string,
  sigil: "!" | "$",
  allowLegacyBase64: boolean,
): boolean {
  if (!value.startsWith(sigil) || Buffer.byteLength(value, "utf8") > MAX_MATRIX_IDENTIFIER_BYTES) {
    return false;
  }
  const opaqueId = value.slice(1);
  const encoding =
    allowLegacyBase64 && /^[A-Za-z0-9+/]{43}$/u.test(opaqueId)
      ? "base64"
      : /^[A-Za-z0-9_-]{43}$/u.test(opaqueId)
        ? "base64url"
        : undefined;
  if (!encoding) {
    return false;
  }
  const decoded = Buffer.from(opaqueId, encoding);
  return decoded.length === 32 && decoded.toString(encoding).replace(/=+$/u, "") === opaqueId;
}

export function isMatrixRoomId(value: string): boolean {
  return isMatrixScopedIdentifier(value, "!") || isMatrixHashIdentifier(value, "!", false);
}

export function isMatrixEventId(value: string): boolean {
  return isMatrixScopedIdentifier(value, "$") || isMatrixHashIdentifier(value, "$", true);
}

export function isMatrixUserId(value: string): boolean {
  return isMatrixScopedIdentifier(value, "@");
}

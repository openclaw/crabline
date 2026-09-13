import { isIP } from "node:net";

const MAX_MATRIX_IDENTIFIER_BYTES = 255;
// Unicode mode treats valid surrogate pairs as single code points outside this range.
const MATRIX_LONE_SURROGATE_PATTERN = /[\uD800-\uDFFF]/u;

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

function isMatrixScopedIdentifier(
  value: string,
  sigil: "!" | "$" | "@",
  allowEmptyLocalpart = false,
): boolean {
  const separator = value.indexOf(":");
  const localpart = value.slice(1, separator);
  return (
    value.startsWith(sigil) &&
    Buffer.byteLength(value, "utf8") <= MAX_MATRIX_IDENTIFIER_BYTES &&
    separator >= (allowEmptyLocalpart ? 1 : 2) &&
    !localpart.includes("\0") &&
    !MATRIX_LONE_SURROGATE_PATTERN.test(localpart) &&
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
  if (!isMatrixScopedIdentifier(value, "@")) {
    return false;
  }
  const localpart = value.slice(1, value.indexOf(":"));
  return /^[a-z0-9._=/+-]+$/u.test(localpart);
}

export function isHistoricalMatrixUserId(value: string): boolean {
  return isMatrixScopedIdentifier(value, "@", true);
}

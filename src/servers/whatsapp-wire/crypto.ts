import { Buffer } from "node:buffer";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

type Curve25519Module = {
  generateKeyPair(seed: Uint8Array): { private: Uint8Array; public: Uint8Array };
  sharedKey(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array;
  sign(privateKey: Uint8Array, message: Uint8Array): Uint8Array;
};

const curve25519 = require("curve25519-js") as Curve25519Module;

const AES_GCM_TAG_LENGTH = 16;
const PRIVATE_KEY_DER_PREFIX = Buffer.from([
  48, 46, 2, 1, 0, 48, 5, 6, 3, 43, 101, 110, 4, 34, 4, 32,
]);
const PUBLIC_KEY_DER_PREFIX = Buffer.from([48, 42, 48, 5, 6, 3, 43, 101, 110, 3, 33, 0]);

export const KEY_BUNDLE_TYPE = Buffer.from([5]);
export const NOISE_MODE = "Noise_XX_25519_AESGCM_SHA256\0\0\0\0";
export const NOISE_WA_HEADER = Buffer.from([87, 65, 6, 3]);

export type KeyPair = {
  private: Buffer;
  public: Buffer;
};

export type SignedKeyPair = {
  keyId: number;
  keyPair: KeyPair;
  signature: Buffer;
};

type NativeCurveBackend = {
  generateKeyPair(): KeyPair;
  sharedKey(privateKey: Uint8Array, publicKey: Uint8Array): Buffer;
};

type CurveApi = NativeCurveBackend & {
  sign(privateKey: Uint8Array, message: Uint8Array): Buffer;
};

const nativeCurveBackend: NativeCurveBackend = {
  generateKeyPair() {
    const { privateKey, publicKey } = generateKeyPairSync("x25519", {
      privateKeyEncoding: { format: "der", type: "pkcs8" },
      publicKeyEncoding: { format: "der", type: "spki" },
    });
    return {
      private: privateKey.subarray(
        PRIVATE_KEY_DER_PREFIX.length,
        PRIVATE_KEY_DER_PREFIX.length + 32,
      ),
      public: publicKey.subarray(PUBLIC_KEY_DER_PREFIX.length, PUBLIC_KEY_DER_PREFIX.length + 32),
    };
  },
  sharedKey(privateKey, publicKey) {
    const nodePrivateKey = createPrivateKey({
      format: "der",
      key: Buffer.concat([PRIVATE_KEY_DER_PREFIX, Buffer.from(privateKey)]),
      type: "pkcs8",
    });
    const nodePublicKey = createPublicKey({
      format: "der",
      key: Buffer.concat([PUBLIC_KEY_DER_PREFIX, Buffer.from(publicKey)]),
      type: "spki",
    });
    return diffieHellman({ privateKey: nodePrivateKey, publicKey: nodePublicKey });
  },
};

function isUnsupportedNativeCurveError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return (
    code === "ERR_OSSL_EVP_UNSUPPORTED" ||
    code === "ERR_CRYPTO_UNSUPPORTED_OPERATION" ||
    code === "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE"
  );
}

export function createCurve(nativeBackend: NativeCurveBackend = nativeCurveBackend): CurveApi {
  let nativeAvailable = true;
  return {
    generateKeyPair(): KeyPair {
      if (nativeAvailable) {
        try {
          return nativeBackend.generateKeyPair();
        } catch {
          nativeAvailable = false;
        }
      }
      const keyPair = curve25519.generateKeyPair(randomBytes(32));
      return {
        private: Buffer.from(keyPair.private),
        public: Buffer.from(keyPair.public),
      };
    },

    sharedKey(privateKey: Uint8Array, publicKey: Uint8Array): Buffer {
      if (privateKey.byteLength !== 32) {
        throw new Error(`Invalid Signal private key length: ${privateKey.byteLength}.`);
      }
      const rawPublicKey = scrubSignalPublicKey(publicKey);
      if (rawPublicKey.every((byte) => byte === 0)) {
        throw new Error("X25519 failed during derivation for an invalid peer key.");
      }
      if (nativeAvailable) {
        try {
          return requireValidX25519SharedKey(nativeBackend.sharedKey(privateKey, rawPublicKey));
        } catch (error) {
          if (!isUnsupportedNativeCurveError(error)) {
            throw error;
          }
          nativeAvailable = false;
        }
      }
      return requireValidX25519SharedKey(
        curve25519.sharedKey(Buffer.from(privateKey), rawPublicKey),
      );
    },

    sign(privateKey: Uint8Array, message: Uint8Array): Buffer {
      return Buffer.from(curve25519.sign(Buffer.from(privateKey), Buffer.from(message)));
    },
  };
}

function requireValidX25519SharedKey(sharedKey: Uint8Array): Buffer {
  const result = Buffer.from(sharedKey);
  if (result.every((byte) => byte === 0)) {
    throw new Error("X25519 failed during derivation for an invalid peer key.");
  }
  return result;
}

export const Curve = createCurve();

export function aesEncryptGCM(
  plaintext: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array,
  additionalData: Uint8Array,
): Buffer {
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(additionalData);
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

export function aesDecryptGCM(
  ciphertext: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array,
  additionalData: Uint8Array,
): Buffer {
  if (ciphertext.byteLength < AES_GCM_TAG_LENGTH) {
    throw new Error(
      `AES-GCM ciphertext must include a ${AES_GCM_TAG_LENGTH}-byte authentication tag.`,
    );
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv, {
    authTagLength: AES_GCM_TAG_LENGTH,
  });
  const encrypted = ciphertext.subarray(0, ciphertext.byteLength - AES_GCM_TAG_LENGTH);
  const tag = ciphertext.subarray(ciphertext.byteLength - AES_GCM_TAG_LENGTH);
  decipher.setAAD(additionalData);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

export function encodeBigEndian(value: number, length = 4): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Big-endian values must be non-negative safe integers.");
  }
  if (!Number.isSafeInteger(length) || length < 1 || length > 1024) {
    throw new Error("Big-endian lengths must be safe integers between 1 and 1024.");
  }
  let remaining = BigInt(value);
  if (remaining >= 1n << BigInt(length * 8)) {
    throw new Error(`Big-endian value ${value} does not fit in ${length} bytes.`);
  }
  const bytes = Buffer.alloc(length);
  for (let index = length - 1; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

export function hkdf(
  input: Uint8Array,
  length: number,
  params: { info: string; salt: Uint8Array },
) {
  return Buffer.from(hkdfSync("sha256", input, params.salt, params.info, length));
}

export function sha256(input: Uint8Array): Buffer {
  return createHash("sha256").update(input).digest();
}

export function signedKeyPair(identityKeyPair: KeyPair, keyId: number): SignedKeyPair {
  const keyPair = Curve.generateKeyPair();
  const publicKey = ensureSignalPublicKey(keyPair.public);
  return {
    keyId,
    keyPair,
    signature: Curve.sign(identityKeyPair.private, publicKey),
  };
}

function ensureSignalPublicKey(publicKey: Uint8Array): Buffer {
  const buffer = Buffer.from(publicKey);
  return buffer.length === 33 ? buffer : Buffer.concat([KEY_BUNDLE_TYPE, buffer]);
}

function scrubSignalPublicKey(publicKey: Uint8Array): Buffer {
  const buffer = Buffer.from(publicKey);
  if (buffer.length === 33 && buffer[0] === KEY_BUNDLE_TYPE[0]) {
    return buffer.subarray(1);
  }
  if (buffer.length === 32) {
    return buffer;
  }
  throw new Error(`Invalid Signal public key length: ${buffer.length}.`);
}

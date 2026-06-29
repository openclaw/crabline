import type { BinaryNode } from "./binary-node.js";
import { encodeBigEndian, KEY_BUNDLE_TYPE, type KeyPair, type SignedKeyPair } from "./crypto.js";

export function xmppPreKey(pair: KeyPair, id: number): BinaryNode {
  return {
    attrs: {},
    content: [
      { attrs: {}, content: encodeBigEndian(id, 3), tag: "id" },
      { attrs: {}, content: pair.public, tag: "value" },
    ],
    tag: "key",
  };
}

export function xmppSignedPreKey(key: SignedKeyPair): BinaryNode {
  return {
    attrs: {},
    content: [
      { attrs: {}, content: encodeBigEndian(key.keyId, 3), tag: "id" },
      { attrs: {}, content: key.keyPair.public, tag: "value" },
      { attrs: {}, content: key.signature, tag: "signature" },
    ],
    tag: "skey",
  };
}

export { KEY_BUNDLE_TYPE };

import { deflateSync } from "node:zlib";
import { Curve as BaileysCurve } from "baileys";
import { describe, expect, it } from "vitest";
import {
  decodeBinaryNode,
  encodeBinaryNode,
  WHATSAPP_BINARY_NODE_MAX_DEPTH,
  WHATSAPP_BINARY_NODE_MAX_DECOMPRESSED_BYTES,
  type BinaryNode,
} from "../src/servers/whatsapp-wire/binary-node.js";
import { aesDecryptGCM, aesEncryptGCM, Curve } from "../src/servers/whatsapp-wire/crypto.js";
import { decodeHandshakeMessage } from "../src/servers/whatsapp-wire/handshake.js";
import { createSerializedMessageHandler } from "../src/servers/whatsapp-baileys-websocket.js";

const RFC_7748_ALICE_PRIVATE = Buffer.from(
  "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a",
  "hex",
);
const RFC_7748_BOB_PUBLIC = Buffer.from(
  "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f",
  "hex",
);
const RFC_7748_SHARED_SECRET = Buffer.from(
  "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742",
  "hex",
);

describe("WhatsApp X25519 agreement", () => {
  it("matches the RFC 7748 vector and bundled Baileys Curve", () => {
    expect(Curve.sharedKey(RFC_7748_ALICE_PRIVATE, RFC_7748_BOB_PUBLIC)).toEqual(
      RFC_7748_SHARED_SECRET,
    );
    expect(BaileysCurve.sharedKey(RFC_7748_ALICE_PRIVATE, RFC_7748_BOB_PUBLIC)).toEqual(
      RFC_7748_SHARED_SECRET,
    );
  });

  it("rejects invalid peer key lengths", () => {
    expect(() => Curve.sharedKey(RFC_7748_ALICE_PRIVATE, Buffer.alloc(31))).toThrow(
      "Invalid Signal public key length: 31.",
    );
  });

  it("propagates Node rejection of an all-zero peer key", () => {
    expect(() => Curve.sharedKey(RFC_7748_ALICE_PRIVATE, Buffer.alloc(32))).toThrow(
      "failed during derivation",
    );
    expect(() => BaileysCurve.sharedKey(RFC_7748_ALICE_PRIVATE, Buffer.alloc(32))).toThrow(
      "failed during derivation",
    );
  });
});

describe("WhatsApp AES-GCM framing", () => {
  it("requires a complete authentication tag", () => {
    const key = Buffer.alloc(32, 1);
    const iv = Buffer.alloc(12, 2);
    const additionalData = Buffer.from("noise");
    const encrypted = aesEncryptGCM(Buffer.from("payload"), key, iv, additionalData);

    expect(aesDecryptGCM(encrypted, key, iv, additionalData)).toEqual(Buffer.from("payload"));
    expect(() => aesDecryptGCM(Buffer.alloc(15), key, iv, additionalData)).toThrow(
      "must include a 16-byte authentication tag",
    );
  });
});

describe("WhatsApp WebSocket message processing", () => {
  it("serializes concurrent frames within one session", async () => {
    const events: string[] = [];
    let activeHandlers = 0;
    let releaseFirstFrame: () => void = () => undefined;
    let markFirstFrameStarted: () => void = () => undefined;
    const firstFrameBlocked = new Promise<void>((resolve) => {
      releaseFirstFrame = resolve;
    });
    const firstFrameStarted = new Promise<void>((resolve) => {
      markFirstFrameStarted = resolve;
    });
    const handleMessage = createSerializedMessageHandler<Buffer>(
      async (frame) => {
        activeHandlers += 1;
        events.push(`start:${frame[0]}`);
        expect(activeHandlers).toBe(1);
        if (frame[0] === 1) {
          markFirstFrameStarted();
          await firstFrameBlocked;
        }
        events.push(`end:${frame[0]}`);
        activeHandlers -= 1;
      },
      (error) => {
        throw error;
      },
    );

    const first = handleMessage(Buffer.from([1]));
    const second = handleMessage(Buffer.from([2]));
    await firstFrameStarted;

    expect(events).toEqual(["start:1"]);
    releaseFirstFrame();
    await Promise.all([first, second]);

    expect(events).toEqual(["start:1", "end:1", "start:2", "end:2"]);
  });
});

describe("WhatsApp handshake protobufs", () => {
  it("skips unknown ten-byte uint64 varints", () => {
    const message = decodeHandshakeMessage(
      Buffer.from([
        0x28, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01, 0x12, 0x03, 0x0a, 0x01,
        0x2a,
      ]),
    );

    expect(message.clientHello?.ephemeral).toEqual(Buffer.from([0x2a]));
  });

  it("rejects known fields encoded with non-length-delimited wire types", () => {
    for (const message of [
      Buffer.from([0x10, 0x00]),
      Buffer.from([0x11, 0, 0, 0, 0, 0, 0, 0, 0]),
      Buffer.from([0x15, 0, 0, 0, 0]),
      Buffer.from([0x12, 0x02, 0x08, 0x00]),
      Buffer.from([0x22, 0x02, 0x10, 0x00]),
    ]) {
      expect(() => decodeHandshakeMessage(message)).toThrow("Invalid WhatsApp handshake wire type");
    }
  });

  it("keeps handshake tags and lengths bounded to uint32 varints", () => {
    const oversizedUint32s = [
      Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x00]),
      Buffer.from([0x92, 0x80, 0x80, 0x80, 0x10, 0x00]),
      Buffer.from([0x12, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00]),
    ];

    for (const message of oversizedUint32s) {
      expect(() => decodeHandshakeMessage(message)).toThrow("Invalid WhatsApp handshake varint.");
    }
  });
});

describe("WhatsApp binary nodes", () => {
  it("rejects BINARY_32 lengths that exceed the remaining frame", async () => {
    const malformed = Buffer.from([0, 248, 2, 252, 1, "x".charCodeAt(0), 254, 0x80, 0, 0, 0]);

    await expect(decodeBinaryNode(malformed)).rejects.toThrow(
      "Unexpected end of WhatsApp binary node.",
    );
  });

  it("rejects compressed nodes that expand past the frame limit", async () => {
    const compressed = deflateSync(Buffer.alloc(WHATSAPP_BINARY_NODE_MAX_DECOMPRESSED_BYTES + 1));

    await expect(decodeBinaryNode(Buffer.concat([Buffer.from([2]), compressed]))).rejects.toThrow(
      "WhatsApp binary node expands beyond",
    );
  });

  it("rejects trailing bytes after a compressed node stream", async () => {
    const compressed = deflateSync(encodeBinaryNode({ attrs: {}, tag: "message" }).subarray(1));

    await expect(
      decodeBinaryNode(Buffer.concat([Buffer.from([2]), compressed, Buffer.from([0xff])])),
    ).rejects.toThrow("Compressed WhatsApp binary node frame contains trailing data.");
  });

  it("rejects child lists that cannot be represented by LIST_16", () => {
    const child: BinaryNode = { attrs: {}, tag: "child" };
    const node: BinaryNode = {
      attrs: {},
      content: Array<BinaryNode>(0x10000).fill(child),
      tag: "root",
    };

    expect(() => encodeBinaryNode(node)).toThrow("WhatsApp binary node list is too large: 65536.");
  });

  it("decodes nodes at the nesting limit and rejects trailing bytes", async () => {
    const node = nestedNode(WHATSAPP_BINARY_NODE_MAX_DEPTH);

    await expect(decodeBinaryNode(encodeBinaryNode(node))).resolves.toEqual(node);
    await expect(
      decodeBinaryNode(Buffer.concat([encodeBinaryNode(node), Buffer.from([0xff])])),
    ).rejects.toThrow("frame contains trailing data");
    await expect(
      decodeBinaryNode(Buffer.concat([encodeBinaryNode(node), encodeBinaryNode(node)])),
    ).rejects.toThrow("frame contains trailing data");
  });

  it("rejects nodes beyond the nesting limit", async () => {
    const node = nestedNode(WHATSAPP_BINARY_NODE_MAX_DEPTH + 1);

    await expect(decodeBinaryNode(encodeBinaryNode(node))).rejects.toThrow(
      `WhatsApp binary node nesting exceeds ${WHATSAPP_BINARY_NODE_MAX_DEPTH}.`,
    );
  });
});

function nestedNode(depth: number): BinaryNode {
  let node: BinaryNode = { attrs: {}, tag: "leaf" };
  for (let level = 1; level < depth; level += 1) {
    node = { attrs: {}, content: [node], tag: "node" };
  }
  return node;
}

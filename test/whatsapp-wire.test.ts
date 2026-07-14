import { deflateSync } from "node:zlib";
import { Curve as BaileysCurve, proto } from "baileys";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  decodeBinaryNode,
  encodeBinaryNode,
  WHATSAPP_BINARY_NODE_MAX_DEPTH,
  WHATSAPP_BINARY_NODE_MAX_DECOMPRESSED_BYTES,
  WHATSAPP_BINARY_NODE_MAX_FRAME_BYTES,
  WHATSAPP_BINARY_NODE_MAX_LIST_ITEMS,
  WHATSAPP_BINARY_NODE_MAX_NODES,
  type BinaryNode,
} from "../src/servers/whatsapp-wire/binary-node.js";
import {
  aesDecryptGCM,
  aesEncryptGCM,
  createCurve,
  Curve,
  encodeBigEndian,
  generateSignalKeyPair,
  KEY_BUNDLE_TYPE,
  NOISE_WA_HEADER,
  signedKeyPair,
} from "../src/servers/whatsapp-wire/crypto.js";
import {
  decodeHandshakeMessage,
  encodeHandshakeMessage,
  type HandshakeMessage,
} from "../src/servers/whatsapp-wire/handshake.js";
import { xmppPreKey, xmppSignedPreKey } from "../src/servers/whatsapp-wire/signal.js";
import {
  createSerializedMessageHandler,
  MAX_WHATSAPP_NOISE_BUFFER_CHUNKS,
  MAX_WHATSAPP_NOISE_FRAME_BYTES,
  MAX_WHATSAPP_NOISE_FRAMES_PER_MESSAGE,
  MAX_WHATSAPP_WEBSOCKET_BUFFERED_BYTES,
  MAX_WHATSAPP_WEBSOCKET_CLOSE_REASON_BYTES,
  parseWhatsAppWebSocketUpgradeUrl,
  resolveWhatsAppWebSocketClose,
  sendWhatsAppWebSocketPayload,
  WHATSAPP_WEBSOCKET_SEND_TIMEOUT_MS,
  WhatsAppNoiseFrameDecoder,
  WhatsAppSignalBundleStore,
} from "../src/servers/whatsapp-baileys-websocket.js";

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
  it("generates provider-native Signal public keys without changing raw Noise keys", () => {
    const noiseKeyPair = Curve.generateKeyPair();
    const identityKeyPair = generateSignalKeyPair();
    const signedPreKey = signedKeyPair(identityKeyPair, 1);

    expect(noiseKeyPair.public).toHaveLength(32);
    expect(identityKeyPair.public).toHaveLength(33);
    expect(identityKeyPair.public[0]).toBe(KEY_BUNDLE_TYPE[0]);
    expect(signedPreKey.keyPair.public).toHaveLength(33);
    expect(signedPreKey.keyPair.public[0]).toBe(KEY_BUNDLE_TYPE[0]);
  });

  it("serializes Signal bundle public keys without the in-memory type prefix", () => {
    const identityKeyPair = generateSignalKeyPair();
    const preKeyNode = xmppPreKey(identityKeyPair, 1);
    const signedPreKeyNode = xmppSignedPreKey(signedKeyPair(identityKeyPair, 1));
    const preKeyValue = (preKeyNode.content as BinaryNode[])[1]!.content as Buffer;
    const signedPreKeyValue = (signedPreKeyNode.content as BinaryNode[])[1]!.content as Buffer;

    expect(preKeyValue).toHaveLength(32);
    expect(signedPreKeyValue).toHaveLength(32);
  });

  it("matches the RFC 7748 vector and bundled Baileys Curve", () => {
    expect(Curve.sharedKey(RFC_7748_ALICE_PRIVATE, RFC_7748_BOB_PUBLIC)).toEqual(
      RFC_7748_SHARED_SECRET,
    );
    expect(BaileysCurve.sharedKey(RFC_7748_ALICE_PRIVATE, RFC_7748_BOB_PUBLIC)).toEqual(
      RFC_7748_SHARED_SECRET,
    );
  });

  it("creates randomized XEdDSA signatures that retain the WhatsApp wire format", () => {
    const identityKeyPair = generateSignalKeyPair();
    const message = Buffer.from("signed pre-key");
    const firstSignature = Curve.sign(identityKeyPair.private, message);
    const secondSignature = Curve.sign(identityKeyPair.private, message);

    expect(firstSignature).toHaveLength(64);
    expect(secondSignature).toHaveLength(64);
    expect(firstSignature).not.toEqual(secondSignature);
    expect(BaileysCurve.verify(identityKeyPair.public, message, firstSignature)).toBe(true);
    expect(BaileysCurve.verify(identityKeyPair.public, message, secondSignature)).toBe(true);
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

  it("uses the JS backend coherently after native key generation fails", () => {
    let nativeSharedKeyCalls = 0;
    const curve = createCurve({
      generateKeyPair() {
        throw Object.assign(new Error("native X25519 unavailable"), {
          code: "ERR_OSSL_EVP_UNSUPPORTED",
        });
      },
      sharedKey() {
        nativeSharedKeyCalls += 1;
        throw new Error("native shared key should not run");
      },
    });
    const alice = curve.generateKeyPair();
    const bob = curve.generateKeyPair();

    expect(curve.sharedKey(alice.private, bob.public)).toEqual(
      curve.sharedKey(bob.private, alice.public),
    );
    expect(nativeSharedKeyCalls).toBe(0);
  });

  it("rejects low-order peers when the JS backend derives an all-zero secret", () => {
    const curve = createCurve({
      generateKeyPair() {
        throw Object.assign(new Error("native X25519 unavailable"), {
          code: "ERR_OSSL_EVP_UNSUPPORTED",
        });
      },
      sharedKey() {
        throw new Error("native shared key should not run");
      },
    });
    curve.generateKeyPair();
    const lowOrderPeer = Buffer.alloc(32);
    lowOrderPeer[0] = 1;

    expect(() => curve.sharedKey(RFC_7748_ALICE_PRIVATE, lowOrderPeer)).toThrow(
      "failed during derivation",
    );
    expect(() =>
      curve.sharedKey(RFC_7748_ALICE_PRIVATE, Buffer.concat([Buffer.from([5]), lowOrderPeer])),
    ).toThrow("failed during derivation");
  });

  it("does not hide unexpected native key generation failures", () => {
    const generateKeyPair = vi.fn(() => {
      throw new Error("native entropy source failed");
    });
    const curve = createCurve({
      generateKeyPair,
      sharedKey() {
        throw new Error("not reached");
      },
    });

    expect(() => curve.generateKeyPair()).toThrow("native entropy source failed");
    expect(() => curve.generateKeyPair()).toThrow("native entropy source failed");
    expect(generateKeyPair).toHaveBeenCalledTimes(2);
  });
});

describe("WhatsApp integer encoding", () => {
  it("encodes values wider than 32 bits", () => {
    expect(encodeBigEndian(2 ** 32, 5).toString("hex")).toBe("0100000000");
    expect(encodeBigEndian(Number.MAX_SAFE_INTEGER, 7).toString("hex")).toBe("1fffffffffffff");
  });

  it.each([
    [-1, 4],
    [1.5, 4],
    [Number.POSITIVE_INFINITY, 4],
    [256, 1],
    [1, 0],
  ])("rejects invalid value or length: %s, %s", (value, length) => {
    expect(() => encodeBigEndian(value, length)).toThrow(/Big-endian/u);
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

  it("closes a serialized handler when its bounded backlog is exceeded", async () => {
    let releaseFirstFrame: () => void = () => undefined;
    let markFirstFrameStarted: () => void = () => undefined;
    const firstFrameBlocked = new Promise<void>((resolve) => {
      releaseFirstFrame = resolve;
    });
    const firstFrameStarted = new Promise<void>((resolve) => {
      markFirstFrameStarted = resolve;
    });
    const errors: unknown[] = [];
    const processed: number[] = [];
    const handleMessage = createSerializedMessageHandler<Buffer>(
      async (frame) => {
        processed.push(frame[0]!);
        markFirstFrameStarted();
        await firstFrameBlocked;
      },
      (error) => errors.push(error),
      {
        maxPendingBytes: 2,
        maxPendingMessages: 2,
        sizeOf: (frame) => frame.byteLength,
      },
    );

    const first = handleMessage(Buffer.from([1]));
    await firstFrameStarted;
    const second = handleMessage(Buffer.from([2]));
    const overflow = handleMessage(Buffer.from([3]));

    expect(errors).toEqual([
      expect.objectContaining({ message: expect.stringContaining("backlog") }),
    ]);
    releaseFirstFrame();
    await Promise.all([first, second, overflow]);
    expect(processed).toEqual([1]);
  });

  it("decodes fragmented Noise frames without retaining concatenated input", () => {
    const decoder = new WhatsAppNoiseFrameDecoder();
    const frames = [Buffer.from([0, 0, 3, 1, 2, 3]), Buffer.from([0, 0, 2, 4, 5])];
    const input = Buffer.concat([NOISE_WA_HEADER, ...frames]);
    const decoded = [
      ...decoder.decodeFrames(input.subarray(0, 6)),
      ...decoder.decodeFrames(input.subarray(6, 10)),
      ...decoder.decodeFrames(input.subarray(10)),
    ];

    expect(decoded).toEqual([Buffer.from([1, 2, 3]), Buffer.from([4, 5])]);
    expect(decoder.bufferedBytes).toBe(0);
  });

  it("rejects Noise frames above the stable frame limit", () => {
    const decoder = new WhatsAppNoiseFrameDecoder();
    const size = MAX_WHATSAPP_NOISE_FRAME_BYTES + 1;
    const prefix = Buffer.from([(size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff]);

    expect(() => decoder.decodeFrames(Buffer.concat([NOISE_WA_HEADER, prefix]))).toThrow(
      `exceeds ${MAX_WHATSAPP_NOISE_FRAME_BYTES} bytes`,
    );
  });

  it("rejects excessive Noise frame counts in one message", () => {
    const decoder = new WhatsAppNoiseFrameDecoder();
    const emptyFrames = Buffer.alloc((MAX_WHATSAPP_NOISE_FRAMES_PER_MESSAGE + 1) * 3);

    expect(() => decoder.decodeFrames(Buffer.concat([NOISE_WA_HEADER, emptyFrames]))).toThrow(
      `exceeds ${MAX_WHATSAPP_NOISE_FRAMES_PER_MESSAGE} frames`,
    );
  });

  it("rejects excessive fragmented Noise buffering", () => {
    const decoder = new WhatsAppNoiseFrameDecoder();
    decoder.decodeFrames(Buffer.concat([NOISE_WA_HEADER, Buffer.from([0, 0x08, 0])]));
    for (let index = 1; index < MAX_WHATSAPP_NOISE_BUFFER_CHUNKS; index += 1) {
      decoder.decodeFrames(Buffer.from([index & 0xff]));
    }

    expect(() => decoder.decodeFrames(Buffer.from([0]))).toThrow(
      `exceeds ${MAX_WHATSAPP_NOISE_BUFFER_CHUNKS} chunks`,
    );
  });

  it("waits for WebSocket writes and rejects buffered payloads", async () => {
    let completeWrite: ((error?: Error) => void) | undefined;
    const send = vi.fn((_payload: unknown, callback: (error?: Error) => void) => {
      completeWrite = callback;
    });
    const terminate = vi.fn();
    const socket = {
      bufferedAmount: 0,
      readyState: WebSocket.OPEN,
      send,
      terminate,
    } as unknown as Parameters<typeof sendWhatsAppWebSocketPayload>[0];
    let completed = false;
    const write = sendWhatsAppWebSocketPayload(socket, Buffer.from("payload")).then(() => {
      completed = true;
    });

    await Promise.resolve();
    expect(completed).toBe(false);
    completeWrite?.();
    await write;
    expect(completed).toBe(true);

    const backedUpSocket = {
      ...socket,
      bufferedAmount: MAX_WHATSAPP_WEBSOCKET_BUFFERED_BYTES,
    };
    await expect(sendWhatsAppWebSocketPayload(backedUpSocket, Buffer.from([1]))).rejects.toThrow(
      "outbound buffer limit",
    );
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("terminates WebSocket writes that never complete", async () => {
    vi.useFakeTimers();
    try {
      const terminate = vi.fn();
      const socket = {
        bufferedAmount: 0,
        readyState: WebSocket.OPEN,
        send: vi.fn(),
        terminate,
      } as unknown as Parameters<typeof sendWhatsAppWebSocketPayload>[0];
      const write = sendWhatsAppWebSocketPayload(socket, Buffer.from("payload")).then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      );

      await vi.advanceTimersByTimeAsync(WHATSAPP_WEBSOCKET_SEND_TIMEOUT_MS);
      await expect(write).resolves.toEqual({
        error: expect.objectContaining({ message: "WhatsApp WebSocket send timed out." }),
      });
      expect(terminate).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects malformed absolute WebSocket request targets", () => {
    expect(parseWhatsAppWebSocketUpgradeUrl("http://[invalid")).toBeUndefined();
    expect(parseWhatsAppWebSocketUpgradeUrl("/ws/chat?access_token=fake")?.pathname).toBe(
      "/ws/chat",
    );
  });

  it("maps bounded close reasons to protocol, capacity, and internal status codes", () => {
    expect(resolveWhatsAppWebSocketClose(new Error("Invalid Baileys handshake"))).toMatchObject({
      code: 1002,
    });
    expect(
      resolveWhatsAppWebSocketClose(new Error("inbound backlog limit exceeded")),
    ).toMatchObject({ code: 1009 });
    expect(resolveWhatsAppWebSocketClose(new Error("recorder append failed"))).toMatchObject({
      code: 1011,
    });

    const bounded = resolveWhatsAppWebSocketClose(new Error("x".repeat(200) + "🦊".repeat(50)));
    expect(Buffer.byteLength(bounded.reason)).toBeLessThanOrEqual(
      MAX_WHATSAPP_WEBSOCKET_CLOSE_REASON_BYTES,
    );
  });
});

describe("WhatsApp handshake protobufs", () => {
  const variants: Array<{
    baileys: proto.IHandshakeMessage;
    message: HandshakeMessage;
    name: string;
  }> = [
    {
      baileys: {
        clientHello: {
          ephemeral: Buffer.from([1]),
          extendedCiphertext: Buffer.from([5]),
          payload: Buffer.alloc(0),
          static: Buffer.from([2]),
          useExtended: false,
        },
      },
      message: {
        clientHello: {
          ephemeral: Buffer.from([1]),
          extendedCiphertext: Buffer.from([5]),
          payload: Buffer.alloc(0),
          staticKey: Buffer.from([2]),
          useExtended: false,
        },
      },
      name: "client hello",
    },
    {
      baileys: {
        serverHello: {
          ephemeral: Buffer.from([1]),
          extendedStatic: Buffer.from([4]),
          payload: Buffer.from([3]),
          static: Buffer.from([2]),
        },
      },
      message: {
        serverHello: {
          ephemeral: Buffer.from([1]),
          extendedStatic: Buffer.from([4]),
          payload: Buffer.from([3]),
          staticKey: Buffer.from([2]),
        },
      },
      name: "server hello",
    },
    {
      baileys: {
        clientFinish: {
          extendedCiphertext: Buffer.from([3]),
          payload: Buffer.from([2]),
          static: Buffer.from([1]),
        },
      },
      message: {
        clientFinish: {
          extendedCiphertext: Buffer.from([3]),
          payload: Buffer.from([2]),
          staticKey: Buffer.from([1]),
        },
      },
      name: "client finish",
    },
  ];

  it.each(variants)("round trips the complete $name variant", ({ baileys, message }) => {
    const encoded = encodeHandshakeMessage(message);

    expect(encoded).toEqual(Buffer.from(proto.HandshakeMessage.encode(baileys).finish()));
    expect(decodeHandshakeMessage(encoded)).toEqual(message);
  });

  it.each([
    {
      expected: {
        clientHello: {
          ephemeral: Buffer.from([1]),
          staticKey: Buffer.from([2]),
        },
      },
      occurrences: [
        { clientHello: { ephemeral: Buffer.from([1]) } },
        { clientHello: { static: Buffer.from([2]) } },
      ],
      variant: "client hello",
    },
    {
      expected: {
        serverHello: {
          extendedStatic: Buffer.from([4]),
          payload: Buffer.from([3]),
        },
      },
      occurrences: [
        { serverHello: { payload: Buffer.from([3]) } },
        { serverHello: { extendedStatic: Buffer.from([4]) } },
      ],
      variant: "server hello",
    },
    {
      expected: {
        clientFinish: {
          extendedCiphertext: Buffer.from([3]),
          staticKey: Buffer.from([1]),
        },
      },
      occurrences: [
        { clientFinish: { static: Buffer.from([1]) } },
        { clientFinish: { extendedCiphertext: Buffer.from([3]) } },
      ],
      variant: "client finish",
    },
  ] satisfies Array<{
    expected: HandshakeMessage;
    occurrences: proto.IHandshakeMessage[];
    variant: string;
  }>)("merges repeated $variant occurrences", ({ expected, occurrences }) => {
    const encoded = Buffer.concat(
      occurrences.map((occurrence) =>
        Buffer.from(proto.HandshakeMessage.encode(occurrence).finish()),
      ),
    );

    expect(decodeHandshakeMessage(encoded)).toEqual(expected);
  });

  it("merges optional fields and ignores unknown-only repeated occurrences", () => {
    const first = Buffer.from(
      proto.HandshakeMessage.encode({
        clientHello: {
          ephemeral: Buffer.from([1]),
          useExtended: true,
        },
      }).finish(),
    );
    const second = Buffer.from(
      proto.HandshakeMessage.encode({
        clientHello: {
          useExtended: false,
        },
      }).finish(),
    );
    const unknownOnlyClientHello = Buffer.from([0x12, 0x02, 0x30, 0x01]);

    expect(decodeHandshakeMessage(Buffer.concat([first, second, unknownOnlyClientHello]))).toEqual({
      clientHello: {
        ephemeral: Buffer.from([1]),
        useExtended: false,
      },
    });
  });

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
      Buffer.from([0x12, 0x02, 0x22, 0x00]),
      Buffer.from([0x1a, 0x02, 0x08, 0x00]),
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

  it("rejects protobuf field number zero at every handshake level", () => {
    expect(() => decodeHandshakeMessage(Buffer.from([0x00]))).toThrow("field number 0");
    expect(() => decodeHandshakeMessage(Buffer.from([0x12, 0x01, 0x00]))).toThrow("field number 0");
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

  it("round trips the largest decodable frame and rejects one byte more", async () => {
    const payloadBytes = WHATSAPP_BINARY_NODE_MAX_DECOMPRESSED_BYTES - 16;
    const largest = {
      attrs: {},
      content: Buffer.alloc(payloadBytes),
      tag: "message",
    };
    const encoded = encodeBinaryNode(largest);

    expect(encoded).toHaveLength(WHATSAPP_BINARY_NODE_MAX_FRAME_BYTES);
    await expect(decodeBinaryNode(encoded)).resolves.toEqual(largest);
    expect(() => encodeBinaryNode({ ...largest, content: Buffer.alloc(payloadBytes + 1) })).toThrow(
      `exceeds ${WHATSAPP_BINARY_NODE_MAX_FRAME_BYTES} bytes`,
    );
  }, 60_000);

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

    expect(() => encodeBinaryNode(node)).toThrow(
      `WhatsApp binary node nesting exceeds ${WHATSAPP_BINARY_NODE_MAX_DEPTH}.`,
    );
  });

  it("rejects aggregate node counts beyond the structural budget", async () => {
    const child: BinaryNode = { attrs: {}, tag: "x" };
    const node: BinaryNode = {
      attrs: {},
      content: Array<BinaryNode>(WHATSAPP_BINARY_NODE_MAX_NODES).fill(child),
      tag: "root",
    };

    expect(() => encodeBinaryNode(node)).toThrow(
      `WhatsApp binary node count exceeds ${WHATSAPP_BINARY_NODE_MAX_NODES}.`,
    );
  });

  it("rejects aggregate list items beyond the decoder budget", () => {
    const attrs = Object.fromEntries(
      Array.from({ length: 32_766 }, (_, index) => [`key-${index}`, "value"]),
    );
    const leaf: BinaryNode = { attrs, tag: "leaf" };
    const child: BinaryNode = { attrs, content: [leaf], tag: "child" };
    const root: BinaryNode = { attrs, content: [child], tag: "root" };

    expect(() => encodeBinaryNode(root)).toThrow(
      `WhatsApp binary node list items exceed ${WHATSAPP_BINARY_NODE_MAX_LIST_ITEMS}.`,
    );
  });

  it("decodes attributes into a null-prototype record", async () => {
    const attrs = Object.fromEntries([["__proto__", "polluted"]]);
    const decoded = await decodeBinaryNode(encodeBinaryNode({ attrs, tag: "message" }));

    expect(Object.getPrototypeOf(decoded.attrs)).toBeNull();
    expect(decoded.attrs["__proto__"]).toBe("polluted");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("WhatsApp signal bundle store", () => {
  it("validates JIDs and bounds retained key material", () => {
    const store = new WhatsAppSignalBundleStore(1);
    const first = store.resolveMany(["15551234567@s.whatsapp.net"]);
    expect(first).toHaveLength(1);
    const second = store.resolveMany(["15551234567@s.whatsapp.net"])[0]!;
    const legacy = store.resolveMany(["15551234567@c.us"])[0]!;
    expect(second.identityKey).toBe(first[0]!.identityKey);
    expect(legacy.identityKey).toBe(first[0]!.identityKey);
    expect(new Set([first[0]!.preKeyId, second.preKeyId, legacy.preKeyId]).size).toBe(3);
    expect(first[0]!.identityKey.public).toHaveLength(33);
    expect(first[0]!.identityKey.public[0]).toBe(KEY_BUNDLE_TYPE[0]);
    expect(first[0]!.preKey.public).toHaveLength(33);
    expect(first[0]!.preKey.public[0]).toBe(KEY_BUNDLE_TYPE[0]);
    expect(first[0]!.signedPreKey.keyPair.public).toHaveLength(33);
    expect(first[0]!.signedPreKey.keyPair.public[0]).toBe(KEY_BUNDLE_TYPE[0]);
    expect(store.size).toBe(1);
    expect(() => store.resolveMany(["not-a-jid"])).toThrow(/Invalid WhatsApp signal bundle JID/u);
    expect(() => store.resolveMany(["15557654321@s.whatsapp.net"])).toThrow(
      /signal bundle limit exceeded/u,
    );
    expect(store.size).toBe(1);
    expect(
      () =>
        new WhatsAppSignalBundleStore(undefined, undefined, undefined, undefined, undefined, {
          maxPreKeysPerBundle: 0,
        }),
    ).toThrow(/maxSignalPreKeysPerBundle/u);
    expect(
      () =>
        new WhatsAppSignalBundleStore(undefined, undefined, undefined, undefined, undefined, {
          maxSessionsPerBundle: 0,
        }),
    ).toThrow(/maxSignalSessionsPerBundle/u);
    expect(
      () =>
        new WhatsAppSignalBundleStore(undefined, undefined, undefined, undefined, undefined, {
          messageAcceptanceTimeoutMs: 2_147_483_648,
        }),
    ).toThrow(/no greater than 2147483647/u);
    expect(
      () =>
        new WhatsAppSignalBundleStore(undefined, undefined, undefined, undefined, undefined, {
          preKeyReservationTtlMs: 0,
        }),
    ).toThrow(/preKeyReservationTtlMs/u);
  });

  it("bounds outstanding one-time prekey reservations per identity", () => {
    const atomicStore = new WhatsAppSignalBundleStore(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { maxPreKeysPerBundle: 2 },
    );
    expect(() =>
      atomicStore.resolveMany([
        "15551234567@c.us",
        "15551234567:2@s.whatsapp.net",
        "15551234567@s.whatsapp.net",
      ]),
    ).toThrow("prekey reservation limit exceeded (2)");
    expect(atomicStore.resolveMany(["15551234567@s.whatsapp.net"])[0]!.preKeyId).toBe(1);

    const failureAtomicStore = new WhatsAppSignalBundleStore(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { maxPreKeysPerBundle: 2 },
    );
    const originalGenerateKeyPair = Curve.generateKeyPair.bind(Curve);
    const generateKeyPair = vi.spyOn(Curve, "generateKeyPair");
    let keyPairCalls = 0;
    generateKeyPair.mockImplementation(() => {
      keyPairCalls += 1;
      if (keyPairCalls === 3) {
        throw new Error("simulated prekey generation failure");
      }
      return originalGenerateKeyPair();
    });
    expect(() =>
      failureAtomicStore.resolveMany([
        "15551234567@s.whatsapp.net",
        "15551234567:2@s.whatsapp.net",
      ]),
    ).toThrow("simulated prekey generation failure");
    generateKeyPair.mockRestore();
    expect(failureAtomicStore.resolveMany(["15551234567@s.whatsapp.net"])[0]!.preKeyId).toBe(1);

    const store = new WhatsAppSignalBundleStore(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { maxPreKeysPerBundle: 2 },
    );
    const first = store.resolveMany(["15551234567@s.whatsapp.net"])[0]!;
    const second = store.resolveMany(["15551234567@s.whatsapp.net"])[0]!;

    expect(first.preKeyId).not.toBe(second.preKeyId);
    expect(() => store.resolveMany(["15551234567@s.whatsapp.net"])).toThrow(
      "prekey reservation limit exceeded (2)",
    );

    let now = 0;
    const expiringStore = new WhatsAppSignalBundleStore(
      1,
      undefined,
      undefined,
      undefined,
      () => now,
      {
        maxPreKeysPerBundle: 2,
        preKeyReservationTtlMs: 100,
      },
    );
    const abandoned = expiringStore.resolveMany([
      "15551234567@s.whatsapp.net",
      "15551234567@s.whatsapp.net",
    ]);
    now = 100;
    const reclaimed = expiringStore.resolveMany(["15551234567@s.whatsapp.net"])[0]!;
    expect(abandoned.map((bundle) => bundle.preKeyId)).toEqual([1, 2]);
    expect(reclaimed.preKeyId).toBe(3);
    expect(reclaimed.preKey).not.toBe(abandoned[0]!.preKey);
  });

  it("bounds PN-to-LID associations and evicts the least recently associated entry", () => {
    const store = new WhatsAppSignalBundleStore(2);
    store.associateLid("15550000001@s.whatsapp.net", "15550000001@lid");
    store.associateLid("15550000002@s.whatsapp.net", "15550000002@lid");
    store.associateLid("15550000001@s.whatsapp.net", "15550000011@lid");
    store.associateLid("15550000003@s.whatsapp.net", "15550000003@lid");

    expect(store.lidMappingSize).toBe(2);
    expect(store.resolveAssociatedLid("15550000001:2@s.whatsapp.net")).toBe("15550000011@lid");
    expect(store.resolveAssociatedLid("15550000002@s.whatsapp.net")).toBeUndefined();
    expect(store.resolveAssociatedLid("15550000003@s.whatsapp.net")).toBe("15550000003@lid");
  });
});

function nestedNode(depth: number): BinaryNode {
  let node: BinaryNode = { attrs: {}, tag: "leaf" };
  for (let level = 1; level < depth; level += 1) {
    node = { attrs: {}, content: [node], tag: "node" };
  }
  return node;
}

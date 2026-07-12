import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  decodeBinaryNode,
  encodeBinaryNode,
  WHATSAPP_BINARY_NODE_MAX_DEPTH,
  WHATSAPP_BINARY_NODE_MAX_DECOMPRESSED_BYTES,
  type BinaryNode,
} from "../src/servers/whatsapp-wire/binary-node.js";
import { decodeHandshakeMessage } from "../src/servers/whatsapp-wire/handshake.js";

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

  it("keeps Baileys field-number dispatch for known fields", () => {
    expect(decodeHandshakeMessage(Buffer.from([0x10, 0x00]))).toEqual({
      clientHello: {},
    });
  });

  it("keeps handshake tags and lengths bounded to uint32 varints", () => {
    const oversizedUint32s = [
      Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x00]),
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

  it("rejects child lists that cannot be represented by LIST_16", () => {
    const child: BinaryNode = { attrs: {}, tag: "child" };
    const node: BinaryNode = {
      attrs: {},
      content: Array<BinaryNode>(0x10000).fill(child),
      tag: "root",
    };

    expect(() => encodeBinaryNode(node)).toThrow("WhatsApp binary node list is too large: 65536.");
  });

  it("decodes nodes at the nesting limit while ignoring trailing bytes", async () => {
    const node = nestedNode(WHATSAPP_BINARY_NODE_MAX_DEPTH);
    const frame = Buffer.concat([encodeBinaryNode(node), Buffer.from([0xff])]);

    await expect(decodeBinaryNode(frame)).resolves.toEqual(node);
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

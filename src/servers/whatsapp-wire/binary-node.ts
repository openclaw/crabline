import { Buffer } from "node:buffer";
import { inflate } from "node:zlib";

export type BinaryNode = {
  attrs: Record<string, string>;
  content?: BinaryNode[] | string | Uint8Array;
  tag: string;
};

export const WHATSAPP_BINARY_NODE_MAX_COMPRESSED_BYTES = 1024 * 1024;
export const WHATSAPP_BINARY_NODE_MAX_DECOMPRESSED_BYTES = 8 * 1024 * 1024;
export const WHATSAPP_BINARY_NODE_MAX_DEPTH = 128;
export const WHATSAPP_BINARY_NODE_MAX_NODES = 32_768;
export const WHATSAPP_BINARY_NODE_MAX_LIST_ITEMS = 131_072;

type DecodeBudget = {
  listItems: number;
  nodes: number;
};

function inflateWithInfo(
  buffer: Uint8Array,
): Promise<{ buffer: Buffer; engine: { bytesWritten: number } }> {
  return new Promise((resolve, reject) => {
    inflate(
      buffer,
      { info: true, maxOutputLength: WHATSAPP_BINARY_NODE_MAX_DECOMPRESSED_BYTES },
      (error, result) => {
        if (error) {
          reject(error);
        } else {
          resolve(result as unknown as { buffer: Buffer; engine: { bytesWritten: number } });
        }
      },
    );
  });
}

const TAGS = {
  AD_JID: 247,
  BINARY_8: 252,
  BINARY_20: 253,
  BINARY_32: 254,
  DICTIONARY_0: 236,
  DICTIONARY_1: 237,
  DICTIONARY_2: 238,
  DICTIONARY_3: 239,
  FB_JID: 246,
  HEX_8: 251,
  INTEROP_JID: 245,
  JID_PAIR: 250,
  LIST_8: 248,
  LIST_16: 249,
  LIST_EMPTY: 0,
  NIBBLE_8: 255,
  PACKED_MAX: 127,
} as const;

// Minimal WhatsApp binary token dictionary for the nodes this local server handles.
const SINGLE_BYTE_TOKENS: Readonly<Record<number, string>> = {
  3: "s.whatsapp.net",
  4: "type",
  5: "participant",
  6: "from",
  7: "receipt",
  8: "id",
  12: "jid",
  14: "user",
  15: "devices",
  17: "to",
  18: "offline",
  19: "message",
  20: "result",
  21: "class",
  22: "xmlns",
  25: "iq",
  26: "t",
  27: "ack",
  28: "g.us",
  29: "enc",
  31: "presence",
  41: "get",
  45: "0",
  48: "unavailable",
  56: "text",
  58: "media_conn",
  65: "count",
  69: "2",
  70: "hostname",
  76: "success",
  79: "prop",
  81: "v",
  83: "pkmsg",
  84: "version",
  90: "set",
  92: "props",
  95: "hash",
  97: "last",
  106: "mode",
  107: "participants",
  108: "value",
  109: "query",
  113: "list",
  114: "host",
  118: "lid",
  121: "usync",
  125: "context",
  137: "name",
  143: "index",
  155: "true",
  156: "identity",
  158: "key",
  160: "background",
  169: "auth",
  173: "registration",
  189: "ttl",
  194: "w:m",
  197: "token",
  198: "inactive",
  203: "encrypt",
  212: "signature",
  217: "trusted_contact",
  226: "privacy",
  230: "device-identity",
};

const DOUBLE_BYTE_TOKENS: Readonly<Record<number, Readonly<Record<number, string>>>> = {
  0: {
    1: "active",
    15: "false",
    24: "passive",
    45: "skey",
    46: "reason",
    68: "tokens",
    127: "subject",
    170: "group",
    217: "blocklist",
    238: "s_t",
  },
  1: {
    51: "w:g2",
  },
};

export const S_WHATSAPP_NET = "@s.whatsapp.net";

export async function decodeBinaryNode(frame: Buffer): Promise<BinaryNode> {
  const buffer = await decompressIfRequired(frame);
  const indexRef = { index: 0 };
  const node = decodeDecompressedBinaryNode(buffer, indexRef, 1, {
    listItems: 0,
    nodes: 0,
  });
  if (indexRef.index !== buffer.length) {
    throw new Error("WhatsApp binary node frame contains trailing data.");
  }
  return node;
}

export function encodeBinaryNode(node: BinaryNode): Buffer {
  return Buffer.from(encodeBinaryNodeInner(node, [0], 1));
}

async function decompressIfRequired(buffer: Buffer): Promise<Buffer> {
  if (buffer.length === 0) {
    throw new Error("Cannot decode an empty WhatsApp binary node.");
  }
  const flag = buffer.readUInt8();
  if ((flag & 2) !== 0) {
    if (buffer.length > WHATSAPP_BINARY_NODE_MAX_COMPRESSED_BYTES) {
      throw new Error(`Compressed WhatsApp binary node frame is too large: ${buffer.length}.`);
    }
    try {
      const compressed = buffer.subarray(1);
      const inflated = await inflateWithInfo(compressed);
      if (inflated.engine.bytesWritten !== compressed.length) {
        throw new Error("Compressed WhatsApp binary node frame contains trailing data.");
      }
      return inflated.buffer;
    } catch (error) {
      if (
        error instanceof RangeError ||
        (error instanceof Error && (error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE")
      ) {
        throw new Error(
          `WhatsApp binary node expands beyond ${WHATSAPP_BINARY_NODE_MAX_DECOMPRESSED_BYTES} bytes.`,
          { cause: error },
        );
      }
      throw error;
    }
  }
  const payload = buffer.subarray(1);
  if (payload.length > WHATSAPP_BINARY_NODE_MAX_DECOMPRESSED_BYTES) {
    throw new Error(`WhatsApp binary node payload is too large: ${payload.length}.`);
  }
  return payload;
}

function decodeDecompressedBinaryNode(
  buffer: Buffer,
  indexRef: { index: number },
  depth: number,
  budget: DecodeBudget,
): BinaryNode {
  if (depth > WHATSAPP_BINARY_NODE_MAX_DEPTH) {
    throw new Error(`WhatsApp binary node nesting exceeds ${WHATSAPP_BINARY_NODE_MAX_DEPTH}.`);
  }
  budget.nodes += 1;
  if (budget.nodes > WHATSAPP_BINARY_NODE_MAX_NODES) {
    throw new Error(`WhatsApp binary node count exceeds ${WHATSAPP_BINARY_NODE_MAX_NODES}.`);
  }
  const checkEOS = (length: number) => {
    if (!Number.isSafeInteger(length) || length < 0 || length > buffer.length - indexRef.index) {
      throw new Error("Unexpected end of WhatsApp binary node.");
    }
  };
  const next = () => {
    const value = buffer[indexRef.index];
    indexRef.index += 1;
    if (value === undefined) {
      throw new Error("Unexpected end of WhatsApp binary node.");
    }
    return value;
  };
  const readByte = () => {
    checkEOS(1);
    return next();
  };
  const readBytes = (length: number) => {
    checkEOS(length);
    const value = buffer.subarray(indexRef.index, indexRef.index + length);
    indexRef.index += length;
    return value;
  };
  const readInt = (length: number, littleEndian = false) => {
    checkEOS(length);
    let value = 0;
    for (let index = 0; index < length; index += 1) {
      const byte = next();
      value = littleEndian ? value + byte * 256 ** index : value * 256 + byte;
    }
    return value;
  };
  const readInt20 = () => {
    checkEOS(3);
    return ((next() & 15) << 16) + (next() << 8) + next();
  };
  const readStringFromChars = (length: number) => readBytes(length).toString("utf8");
  const unpackHex = (value: number) => {
    if (value >= 0 && value < 16) {
      return value < 10 ? "0".charCodeAt(0) + value : "A".charCodeAt(0) + value - 10;
    }
    throw new Error(`Invalid WhatsApp hex token: ${value}.`);
  };
  const unpackNibble = (value: number) => {
    if (value >= 0 && value <= 9) {
      return "0".charCodeAt(0) + value;
    }
    if (value === 10) {
      return "-".charCodeAt(0);
    }
    if (value === 11) {
      return ".".charCodeAt(0);
    }
    if (value === 15) {
      return "\0".charCodeAt(0);
    }
    throw new Error(`Invalid WhatsApp nibble token: ${value}.`);
  };
  const unpackByte = (tag: number, value: number) => {
    if (tag === TAGS.NIBBLE_8) {
      return unpackNibble(value);
    }
    if (tag === TAGS.HEX_8) {
      return unpackHex(value);
    }
    throw new Error(`Unknown WhatsApp packed string tag: ${tag}.`);
  };
  const readPacked8 = (tag: number) => {
    const startByte = readByte();
    let value = "";
    for (let index = 0; index < (startByte & 127); index += 1) {
      const current = readByte();
      value += String.fromCharCode(unpackByte(tag, (current & 0xf0) >> 4));
      value += String.fromCharCode(unpackByte(tag, current & 0x0f));
    }
    return startByte >> 7 !== 0 ? value.slice(0, -1) : value;
  };
  const readListSize = (tag: number) => {
    let size: number;
    if (tag === TAGS.LIST_EMPTY) {
      size = 0;
    } else if (tag === TAGS.LIST_8) {
      size = readByte();
    } else if (tag === TAGS.LIST_16) {
      size = readInt(2);
    } else {
      throw new Error(`Invalid WhatsApp list tag: ${tag}.`);
    }
    budget.listItems += size;
    if (budget.listItems > WHATSAPP_BINARY_NODE_MAX_LIST_ITEMS) {
      throw new Error(
        `WhatsApp binary node list items exceed ${WHATSAPP_BINARY_NODE_MAX_LIST_ITEMS}.`,
      );
    }
    return size;
  };
  const isListTag = (tag: number) =>
    tag === TAGS.LIST_EMPTY || tag === TAGS.LIST_8 || tag === TAGS.LIST_16;
  const readString = (tag: number): string => {
    const token = SINGLE_BYTE_TOKENS[tag];
    if (token !== undefined) {
      return token;
    }
    if (tag >= 1 && tag < 236) {
      throw new Error(`Unsupported WhatsApp single-byte token: ${tag}.`);
    }
    if (
      tag === TAGS.DICTIONARY_0 ||
      tag === TAGS.DICTIONARY_1 ||
      tag === TAGS.DICTIONARY_2 ||
      tag === TAGS.DICTIONARY_3
    ) {
      return readDoubleToken(tag - TAGS.DICTIONARY_0, readByte());
    }
    if (tag === TAGS.LIST_EMPTY) {
      return "";
    }
    if (tag === TAGS.BINARY_8) {
      return readStringFromChars(readByte());
    }
    if (tag === TAGS.BINARY_20) {
      return readStringFromChars(readInt20());
    }
    if (tag === TAGS.BINARY_32) {
      return readStringFromChars(readInt(4));
    }
    if (tag === TAGS.JID_PAIR) {
      return readJidPair();
    }
    if (tag === TAGS.FB_JID) {
      return readFbJid();
    }
    if (tag === TAGS.INTEROP_JID) {
      return readInteropJid();
    }
    if (tag === TAGS.AD_JID) {
      return readAdJid();
    }
    if (tag === TAGS.HEX_8 || tag === TAGS.NIBBLE_8) {
      return readPacked8(tag);
    }
    throw new Error(`Invalid WhatsApp string tag: ${tag}.`);
  };
  const readList = (tag: number) => {
    const items: BinaryNode[] = [];
    const size = readListSize(tag);
    for (let index = 0; index < size; index += 1) {
      items.push(decodeDecompressedBinaryNode(buffer, indexRef, depth + 1, budget));
    }
    return items;
  };
  const readJidPair = () => {
    const user = readString(readByte());
    const server = readString(readByte());
    if (!server) {
      throw new Error(`Invalid WhatsApp JID pair: ${user}, ${server}.`);
    }
    return `${user || ""}@${server}`;
  };
  const readAdJid = () => {
    const domainType = readByte();
    const device = readByte();
    const user = readString(readByte());
    const server =
      domainType === 1
        ? "lid"
        : domainType === 128
          ? "hosted"
          : domainType === 129
            ? "hosted.lid"
            : "s.whatsapp.net";
    return `${user}${device ? `:${device}` : ""}@${server}`;
  };
  const readFbJid = () => {
    const user = readString(readByte());
    const device = readInt(2);
    const server = readString(readByte());
    return `${user}:${device}@${server}`;
  };
  const readInteropJid = () => {
    const user = readString(readByte());
    const device = readInt(2);
    const integrator = readInt(2);
    const beforeServer = indexRef.index;
    let server = "interop";
    try {
      server = readString(readByte());
    } catch {
      indexRef.index = beforeServer;
    }
    return `${integrator}-${user}:${device}@${server}`;
  };
  const readDoubleToken = (dictionary: number, index: number) => {
    const value = DOUBLE_BYTE_TOKENS[dictionary]?.[index];
    if (value === undefined) {
      throw new Error(`Unsupported WhatsApp dictionary token: ${dictionary}:${index}.`);
    }
    return value;
  };

  const listSize = readListSize(readByte());
  const tag = readString(readByte());
  if (listSize === 0 || !tag) {
    throw new Error("Invalid WhatsApp binary node header.");
  }
  const attrs: Record<string, string> = {};
  for (let index = 0; index < (listSize - 1) >> 1; index += 1) {
    attrs[readString(readByte())] = readString(readByte());
  }
  let content: BinaryNode["content"];
  if (listSize % 2 === 0) {
    const contentTag = readByte();
    if (isListTag(contentTag)) {
      content = readList(contentTag);
    } else if (contentTag === TAGS.BINARY_8) {
      content = readBytes(readByte());
    } else if (contentTag === TAGS.BINARY_20) {
      content = readBytes(readInt20());
    } else if (contentTag === TAGS.BINARY_32) {
      content = readBytes(readInt(4));
    } else {
      content = readString(contentTag);
    }
  }
  return content === undefined ? { attrs, tag } : { attrs, content, tag };
}

function encodeBinaryNodeInner(node: BinaryNode, buffer: number[], depth: number): number[] {
  if (depth > WHATSAPP_BINARY_NODE_MAX_DEPTH) {
    throw new Error(`WhatsApp binary node nesting exceeds ${WHATSAPP_BINARY_NODE_MAX_DEPTH}.`);
  }
  if (!node.tag) {
    throw new Error("Invalid WhatsApp binary node: tag is required.");
  }
  const validAttributes = Object.keys(node.attrs ?? {}).filter((key) => {
    const value = node.attrs[key];
    return value !== undefined && value !== null;
  });
  writeListStart(buffer, 2 * validAttributes.length + 1 + (node.content !== undefined ? 1 : 0));
  writeString(buffer, node.tag);
  for (const key of validAttributes) {
    writeString(buffer, key);
    writeString(buffer, node.attrs[key] ?? "");
  }
  if (typeof node.content === "string") {
    writeString(buffer, node.content);
  } else if (node.content instanceof Uint8Array) {
    writeByteLength(buffer, node.content.length);
    pushBytes(buffer, node.content);
  } else if (Array.isArray(node.content)) {
    writeListStart(buffer, node.content.length);
    for (const child of node.content) {
      encodeBinaryNodeInner(child, buffer, depth + 1);
    }
  } else if (node.content !== undefined) {
    throw new Error(`Invalid WhatsApp binary node content for <${node.tag}>.`);
  }
  return buffer;
}

function pushByte(buffer: number[], value: number): void {
  buffer.push(value & 0xff);
}

function pushBytes(buffer: number[], bytes: Uint8Array): void {
  for (const byte of bytes) {
    pushByte(buffer, byte);
  }
}

function pushInt(buffer: number[], value: number, length: number): void {
  for (let index = 0; index < length; index += 1) {
    const shift = length - 1 - index;
    pushByte(buffer, value >> (shift * 8));
  }
}

function writeByteLength(buffer: number[], length: number): void {
  if (length >= 4294967296) {
    throw new Error(`WhatsApp binary node payload is too large: ${length}.`);
  }
  if (length >= 1 << 20) {
    pushByte(buffer, TAGS.BINARY_32);
    pushInt(buffer, length, 4);
    return;
  }
  if (length >= 256) {
    pushByte(buffer, TAGS.BINARY_20);
    pushByte(buffer, (length >> 16) & 0x0f);
    pushByte(buffer, length >> 8);
    pushByte(buffer, length);
    return;
  }
  pushByte(buffer, TAGS.BINARY_8);
  pushByte(buffer, length);
}

function writeString(buffer: number[], value: string): void {
  const bytes = Buffer.from(value, "utf8");
  writeByteLength(buffer, bytes.length);
  pushBytes(buffer, bytes);
}

function writeListStart(buffer: number[], size: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > 0xffff) {
    throw new Error(`WhatsApp binary node list is too large: ${size}.`);
  }
  if (size === 0) {
    pushByte(buffer, TAGS.LIST_EMPTY);
    return;
  }
  if (size < 256) {
    pushByte(buffer, TAGS.LIST_8);
    pushByte(buffer, size);
    return;
  }
  pushByte(buffer, TAGS.LIST_16);
  pushInt(buffer, size, 2);
}

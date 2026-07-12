import { Buffer } from "node:buffer";

type BytesField = Buffer | undefined;

export type HandshakeMessage = {
  clientFinish?: {
    payload?: Buffer;
    staticKey?: Buffer;
  };
  clientHello?: {
    ephemeral?: Buffer;
  };
  serverHello?: {
    ephemeral: Uint8Array;
    payload: Uint8Array;
    staticKey: Uint8Array;
  };
};

export function decodeHandshakeMessage(data: Uint8Array): HandshakeMessage {
  const reader = new ProtoReader(data);
  const message: HandshakeMessage = {};
  while (!reader.done()) {
    const tag = reader.uint32();
    const field = tag >>> 3;
    if (field === 2) {
      requireBytesWireType(tag, field);
      message.clientHello = decodeClientHello(reader.bytes());
    } else if (field === 4) {
      requireBytesWireType(tag, field);
      message.clientFinish = decodeClientFinish(reader.bytes());
    } else {
      reader.skip(tag & 7);
    }
  }
  return message;
}

export function encodeHandshakeMessage(message: HandshakeMessage): Buffer {
  const writer = new ProtoWriter();
  if (message.serverHello) {
    writer.bytesField(3, encodeServerHello(message.serverHello));
  }
  return writer.finish();
}

function decodeClientHello(data: Uint8Array): NonNullable<HandshakeMessage["clientHello"]> {
  const reader = new ProtoReader(data);
  let ephemeral: BytesField;
  while (!reader.done()) {
    const tag = reader.uint32();
    if (tag >>> 3 === 1) {
      requireBytesWireType(tag, 1);
      ephemeral = reader.bytes();
    } else {
      reader.skip(tag & 7);
    }
  }
  return ephemeral === undefined ? {} : { ephemeral };
}

function decodeClientFinish(data: Uint8Array): NonNullable<HandshakeMessage["clientFinish"]> {
  const reader = new ProtoReader(data);
  let payload: BytesField;
  let staticKey: BytesField;
  while (!reader.done()) {
    const tag = reader.uint32();
    const field = tag >>> 3;
    if (field === 1) {
      requireBytesWireType(tag, field);
      staticKey = reader.bytes();
    } else if (field === 2) {
      requireBytesWireType(tag, field);
      payload = reader.bytes();
    } else {
      reader.skip(tag & 7);
    }
  }
  return {
    ...(payload === undefined ? {} : { payload }),
    ...(staticKey === undefined ? {} : { staticKey }),
  };
}

function requireBytesWireType(tag: number, field: number): void {
  const wireType = tag & 7;
  if (wireType !== 2) {
    throw new Error(
      `Invalid WhatsApp handshake wire type ${wireType} for length-delimited field ${field}.`,
    );
  }
}

function encodeServerHello(serverHello: NonNullable<HandshakeMessage["serverHello"]>): Buffer {
  const writer = new ProtoWriter();
  writer.bytesField(1, serverHello.ephemeral);
  writer.bytesField(2, serverHello.staticKey);
  writer.bytesField(3, serverHello.payload);
  return writer.finish();
}

class ProtoReader {
  #offset = 0;
  readonly #buffer: Buffer;

  constructor(data: Uint8Array) {
    this.#buffer = Buffer.from(data);
  }

  done(): boolean {
    return this.#offset >= this.#buffer.length;
  }

  bytes(): Buffer {
    const length = this.uint32();
    this.#require(length);
    const value = this.#buffer.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return value;
  }

  skip(wireType: number): void {
    if (wireType === 0) {
      this.#skipVarint();
      return;
    }
    if (wireType === 1) {
      this.#require(8);
      this.#offset += 8;
      return;
    }
    if (wireType === 2) {
      const length = this.uint32();
      this.#require(length);
      this.#offset += length;
      return;
    }
    if (wireType === 5) {
      this.#require(4);
      this.#offset += 4;
      return;
    }
    throw new Error(`Unsupported WhatsApp handshake wire type: ${wireType}.`);
  }

  uint32(): number {
    let value = 0;
    let shift = 0;
    while (shift < 32) {
      this.#require(1);
      const byte = this.#buffer[this.#offset];
      this.#offset += 1;
      if (byte === undefined) {
        throw new Error("Unexpected end of WhatsApp handshake protobuf.");
      }
      if (shift === 28 && byte > 0x0f) {
        throw new Error("Invalid WhatsApp handshake varint.");
      }
      value |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        return value >>> 0;
      }
      shift += 7;
    }
    throw new Error("Invalid WhatsApp handshake varint.");
  }

  #skipVarint(): void {
    for (let index = 0; index < 10; index += 1) {
      this.#require(1);
      const byte = this.#buffer[this.#offset];
      this.#offset += 1;
      if (byte === undefined || (index === 9 && byte > 1)) {
        throw new Error("Invalid WhatsApp handshake varint.");
      }
      if ((byte & 0x80) === 0) {
        return;
      }
    }
    throw new Error("Invalid WhatsApp handshake varint.");
  }

  #require(length: number): void {
    if (this.#offset + length > this.#buffer.length) {
      throw new Error("Unexpected end of WhatsApp handshake protobuf.");
    }
  }
}

class ProtoWriter {
  readonly #parts: Buffer[] = [];

  bytesField(field: number, value: Uint8Array): void {
    this.uint32((field << 3) | 2);
    this.uint32(value.byteLength);
    this.#parts.push(Buffer.from(value));
  }

  finish(): Buffer {
    return Buffer.concat(this.#parts);
  }

  uint32(value: number): void {
    let remaining = value >>> 0;
    const bytes: number[] = [];
    while (remaining > 127) {
      bytes.push((remaining & 0x7f) | 0x80);
      remaining >>>= 7;
    }
    bytes.push(remaining);
    this.#parts.push(Buffer.from(bytes));
  }
}

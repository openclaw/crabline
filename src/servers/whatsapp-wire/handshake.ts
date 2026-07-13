import { Buffer } from "node:buffer";

type BytesField = Buffer | undefined;

export type HandshakeMessage = {
  clientFinish?: {
    extendedCiphertext?: Buffer;
    payload?: Buffer;
    staticKey?: Buffer;
  };
  clientHello?: {
    ephemeral?: Buffer;
    extendedCiphertext?: Buffer;
    payload?: Buffer;
    staticKey?: Buffer;
    useExtended?: boolean;
  };
  serverHello?: {
    ephemeral?: Uint8Array;
    extendedStatic?: Uint8Array;
    payload?: Uint8Array;
    staticKey?: Uint8Array;
  };
};

export function decodeHandshakeMessage(data: Uint8Array): HandshakeMessage {
  const reader = new ProtoReader(data);
  const message: HandshakeMessage = {};
  while (!reader.done()) {
    const tag = reader.tag();
    const field = tag >>> 3;
    if (field === 2) {
      requireBytesWireType(tag, field);
      message.clientHello = decodeClientHello(reader.bytes());
    } else if (field === 3) {
      requireBytesWireType(tag, field);
      message.serverHello = decodeServerHello(reader.bytes());
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
  if (message.clientHello) {
    writer.bytesField(2, encodeClientHello(message.clientHello));
  }
  if (message.serverHello) {
    writer.bytesField(3, encodeServerHello(message.serverHello));
  }
  if (message.clientFinish) {
    writer.bytesField(4, encodeClientFinish(message.clientFinish));
  }
  return writer.finish();
}

function decodeClientHello(data: Uint8Array): NonNullable<HandshakeMessage["clientHello"]> {
  const reader = new ProtoReader(data);
  let ephemeral: BytesField;
  let extendedCiphertext: BytesField;
  let payload: BytesField;
  let staticKey: BytesField;
  let useExtended: boolean | undefined;
  while (!reader.done()) {
    const tag = reader.tag();
    const field = tag >>> 3;
    if (field === 1) {
      requireBytesWireType(tag, field);
      ephemeral = reader.bytes();
    } else if (field === 2) {
      requireBytesWireType(tag, field);
      staticKey = reader.bytes();
    } else if (field === 3) {
      requireBytesWireType(tag, field);
      payload = reader.bytes();
    } else if (field === 4) {
      requireVarintWireType(tag, field);
      useExtended = reader.uint32() !== 0;
    } else if (field === 5) {
      requireBytesWireType(tag, field);
      extendedCiphertext = reader.bytes();
    } else {
      reader.skip(tag & 7);
    }
  }
  return {
    ...(ephemeral === undefined ? {} : { ephemeral }),
    ...(extendedCiphertext === undefined ? {} : { extendedCiphertext }),
    ...(payload === undefined ? {} : { payload }),
    ...(staticKey === undefined ? {} : { staticKey }),
    ...(useExtended === undefined ? {} : { useExtended }),
  };
}

function decodeServerHello(data: Uint8Array): NonNullable<HandshakeMessage["serverHello"]> {
  const reader = new ProtoReader(data);
  let ephemeral: BytesField;
  let extendedStatic: BytesField;
  let payload: BytesField;
  let staticKey: BytesField;
  while (!reader.done()) {
    const tag = reader.tag();
    const field = tag >>> 3;
    if (field === 1) {
      requireBytesWireType(tag, field);
      ephemeral = reader.bytes();
    } else if (field === 2) {
      requireBytesWireType(tag, field);
      staticKey = reader.bytes();
    } else if (field === 3) {
      requireBytesWireType(tag, field);
      payload = reader.bytes();
    } else if (field === 4) {
      requireBytesWireType(tag, field);
      extendedStatic = reader.bytes();
    } else {
      reader.skip(tag & 7);
    }
  }
  return {
    ...(ephemeral === undefined ? {} : { ephemeral }),
    ...(extendedStatic === undefined ? {} : { extendedStatic }),
    ...(payload === undefined ? {} : { payload }),
    ...(staticKey === undefined ? {} : { staticKey }),
  };
}

function decodeClientFinish(data: Uint8Array): NonNullable<HandshakeMessage["clientFinish"]> {
  const reader = new ProtoReader(data);
  let extendedCiphertext: BytesField;
  let payload: BytesField;
  let staticKey: BytesField;
  while (!reader.done()) {
    const tag = reader.tag();
    const field = tag >>> 3;
    if (field === 1) {
      requireBytesWireType(tag, field);
      staticKey = reader.bytes();
    } else if (field === 2) {
      requireBytesWireType(tag, field);
      payload = reader.bytes();
    } else if (field === 3) {
      requireBytesWireType(tag, field);
      extendedCiphertext = reader.bytes();
    } else {
      reader.skip(tag & 7);
    }
  }
  return {
    ...(extendedCiphertext === undefined ? {} : { extendedCiphertext }),
    ...(payload === undefined ? {} : { payload }),
    ...(staticKey === undefined ? {} : { staticKey }),
  };
}

function encodeClientHello(clientHello: NonNullable<HandshakeMessage["clientHello"]>): Buffer {
  const writer = new ProtoWriter();
  if (clientHello.ephemeral !== undefined) {
    writer.bytesField(1, clientHello.ephemeral);
  }
  if (clientHello.staticKey !== undefined) {
    writer.bytesField(2, clientHello.staticKey);
  }
  if (clientHello.payload !== undefined) {
    writer.bytesField(3, clientHello.payload);
  }
  if (clientHello.useExtended !== undefined) {
    writer.boolField(4, clientHello.useExtended);
  }
  if (clientHello.extendedCiphertext !== undefined) {
    writer.bytesField(5, clientHello.extendedCiphertext);
  }
  return writer.finish();
}

function encodeClientFinish(clientFinish: NonNullable<HandshakeMessage["clientFinish"]>): Buffer {
  const writer = new ProtoWriter();
  if (clientFinish.staticKey !== undefined) {
    writer.bytesField(1, clientFinish.staticKey);
  }
  if (clientFinish.payload !== undefined) {
    writer.bytesField(2, clientFinish.payload);
  }
  if (clientFinish.extendedCiphertext !== undefined) {
    writer.bytesField(3, clientFinish.extendedCiphertext);
  }
  return writer.finish();
}

function requireBytesWireType(tag: number, field: number): void {
  const wireType = tag & 7;
  if (wireType !== 2) {
    throw new Error(
      `Invalid WhatsApp handshake wire type ${wireType} for length-delimited field ${field}.`,
    );
  }
}

function requireVarintWireType(tag: number, field: number): void {
  const wireType = tag & 7;
  if (wireType !== 0) {
    throw new Error(`Invalid WhatsApp handshake wire type ${wireType} for varint field ${field}.`);
  }
}

function encodeServerHello(serverHello: NonNullable<HandshakeMessage["serverHello"]>): Buffer {
  const writer = new ProtoWriter();
  if (serverHello.ephemeral !== undefined) {
    writer.bytesField(1, serverHello.ephemeral);
  }
  if (serverHello.staticKey !== undefined) {
    writer.bytesField(2, serverHello.staticKey);
  }
  if (serverHello.payload !== undefined) {
    writer.bytesField(3, serverHello.payload);
  }
  if (serverHello.extendedStatic !== undefined) {
    writer.bytesField(4, serverHello.extendedStatic);
  }
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

  tag(): number {
    const tag = this.uint32();
    if (tag >>> 3 === 0) {
      throw new Error("Invalid WhatsApp handshake protobuf field number 0.");
    }
    return tag;
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

  boolField(field: number, value: boolean): void {
    this.uint32(field << 3);
    this.uint32(value ? 1 : 0);
  }

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

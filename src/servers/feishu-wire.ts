import protobuf from "protobufjs/light.js";

export type FeishuFrame = {
  SeqID: string;
  LogID: string;
  service: number;
  method: number;
  headers: Array<{ key: string; value: string }>;
  payloadEncoding?: string;
  payloadType?: string;
  payload?: Uint8Array;
  LogIDNew?: string;
};

// The official protocol is proto2. A private root avoids modifying protobuf's
// shared descriptor registry; SDK clients that reconfigure Long run separately.
const root = protobuf.Root.fromJSON({
  nested: {
    Header: {
      fields: {
        key: { type: "string", id: 1, rule: "required" },
        value: { type: "string", id: 2, rule: "required" },
      },
    },
    Frame: {
      fields: {
        SeqID: { type: "uint64", id: 1, rule: "required" },
        LogID: { type: "uint64", id: 2, rule: "required" },
        service: { type: "int32", id: 3, rule: "required" },
        method: { type: "int32", id: 4, rule: "required" },
        headers: { type: "Header", id: 5, rule: "repeated" },
        payloadEncoding: { type: "string", id: 6 },
        payloadType: { type: "string", id: 7 },
        payload: { type: "bytes", id: 8 },
        LogIDNew: { type: "string", id: 9 },
      },
    },
  },
}).resolveAll();
const frameType = root.lookupType("Frame");

export function encodeFeishuFrame(frame: FeishuFrame): Uint8Array {
  for (const value of [frame.SeqID, frame.LogID]) {
    if (!/^(0|[1-9][0-9]*)$/u.test(value) || BigInt(value) > 0xffff_ffff_ffff_ffffn) {
      throw new Error("Feishu frame IDs must be uint64 decimal strings.");
    }
  }
  const message = frameType.fromObject(frame);
  const error = frameType.verify(message);
  if (error) {
    throw new Error(error);
  }
  return frameType.encode(message).finish();
}

export function decodeFeishuFrame(bytes: Uint8Array): FeishuFrame {
  return frameType.toObject(frameType.decode(bytes), {
    longs: String,
    arrays: true,
  }) as FeishuFrame;
}

export function feishuHeader(frame: FeishuFrame, key: string): string | undefined {
  return frame.headers.find((header) => header.key === key)?.value;
}

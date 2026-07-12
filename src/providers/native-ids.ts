export type NativeIdRule = {
  example: string;
  name: string;
  pattern: RegExp;
};

export function numericNativeId(value: number | bigint): string | undefined {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    return undefined;
  }
  return value.toString();
}

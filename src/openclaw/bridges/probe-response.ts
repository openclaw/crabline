export async function throwProbeHttpError(response: Response, message: string): Promise<never> {
  void response.body?.cancel().catch(() => undefined);
  throw new Error(message);
}

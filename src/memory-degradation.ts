export function redactSecrets(value: string): string {
  const secret = process.env.MEM0_API_KEY;
  return secret ? value.split(secret).join("[REDACTED]") : value;
}

export function memoryWarning(feature: "load" | "health" | "recall" | "capture" | "dream", error: unknown, retrying = false): string {
  const message = error instanceof Error ? error.message : String(error);
  const scope = retrying ? "unavailable — will retry on a later turn" : "unavailable for this session";
  return `${feature === "health" ? "Startup Warning" : "Warning"}: Long-term Memory ${feature} ${scope}: ${redactSecrets(message)}`;
}

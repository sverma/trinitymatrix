export function AiProtocolVersion({ version }: { version?: string | undefined }) {
  if (typeof version !== "string" || !version) return null;
  const label = version.startsWith("trinity-agent-protocol/") ? `v${version.slice("trinity-agent-protocol/".length)}`
    : version === "trinity-v1" ? "v0" : version;
  return <small className="ai-protocol-version">AI protocol {label}</small>;
}

import type { Request } from "express";

/** The MCP gateway and its OAuth endpoints exist only when this is "true". */
export function mcpGatewayEnabled(): boolean {
  return process.env.MCP_GATEWAY_ENABLED === "true";
}

/**
 * The public origin of this backend: MCP_PUBLIC_URL when set, otherwise the
 * origin of the request (Railway's one trusted proxy hop gives the real
 * scheme). It is the OAuth issuer, and the MCP resource lives under it.
 */
export function mcpPublicBase(req: Request): string {
  const configured = process.env.MCP_PUBLIC_URL?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  return `${req.protocol}://${req.get("host")}`;
}

/** The MCP resource identifier: what access tokens are bound to. */
export function mcpResource(req: Request): string {
  return `${mcpPublicBase(req)}/mcp`;
}

export function protectedResourceMetadataUrl(req: Request): string {
  return `${mcpPublicBase(req)}/.well-known/oauth-protected-resource/mcp`;
}

/**
 * Acting through the gateway (step P3a): the tools that change something are
 * offered only when this is "true" as well, and only to a connection approved
 * with the secretary.act scope.
 */
export function mcpWriteEnabled(): boolean {
  return mcpGatewayEnabled() && process.env.MCP_WRITE_ENABLED === "true";
}

export const MCP_READ_SCOPE = "secretary.read";
export const MCP_ACT_SCOPE = "secretary.act";

/** The scopes a new connection may ask for right now. */
export function mcpSupportedScopes(): string[] {
  return mcpWriteEnabled() ? [MCP_READ_SCOPE, MCP_ACT_SCOPE] : [MCP_READ_SCOPE];
}

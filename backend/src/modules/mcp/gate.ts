import type { Request } from "express";

/**
 * Longest tool result handed back to an MCP client, in characters. A longer
 * read is cut; a preview awaiting approval never is (writeTools.ts refuses it).
 */
export const MCP_RESULT_CHARS = 50_000;

/** The MCP gateway and its OAuth endpoints exist only when this is "true". */
export function mcpGatewayEnabled(): boolean {
  return process.env.MCP_GATEWAY_ENABLED === "true";
}

/**
 * Writing through the gateway is a second, separate switch, off by default.
 * Only with both on does the authorization server offer secretary.write and
 * the gateway list or run a write tool. Switching it off again stops every
 * write at once, whatever tokens were issued meanwhile; reading carries on.
 */
export function mcpWriteEnabled(): boolean {
  return mcpGatewayEnabled() && process.env.MCP_WRITE_ENABLED === "true";
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

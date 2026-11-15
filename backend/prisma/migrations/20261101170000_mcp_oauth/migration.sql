-- OAuth 2.1 for the read-only MCP gateway (voice assistant master document
-- 1.1a, step P2b). Two new tables, nothing existing changes.
-- CreateTable
CREATE TABLE "mcp_oauth_clients" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "company_id" TEXT,
    "client_name" TEXT NOT NULL,
    "redirect_uris" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_oauth_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_oauth_grants" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "auth_version" INTEGER NOT NULL,
    "scope" TEXT NOT NULL,
    "redirect_uri" TEXT,
    "code_challenge" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_oauth_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mcp_oauth_clients_client_id_key" ON "mcp_oauth_clients"("client_id");

-- CreateIndex
CREATE INDEX "mcp_oauth_clients_company_id_idx" ON "mcp_oauth_clients"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_oauth_grants_token_hash_key" ON "mcp_oauth_grants"("token_hash");

-- CreateIndex
CREATE INDEX "mcp_oauth_grants_client_id_user_id_idx" ON "mcp_oauth_grants"("client_id", "user_id");

-- CreateIndex
CREATE INDEX "mcp_oauth_grants_expires_at_idx" ON "mcp_oauth_grants"("expires_at");

-- AddForeignKey
ALTER TABLE "mcp_oauth_clients" ADD CONSTRAINT "mcp_oauth_clients_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_oauth_grants" ADD CONSTRAINT "mcp_oauth_grants_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "mcp_oauth_clients"("client_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_oauth_grants" ADD CONSTRAINT "mcp_oauth_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_oauth_grants" ADD CONSTRAINT "mcp_oauth_grants_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;


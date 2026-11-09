"""Self-contained OAuth 2.1 authorization server for the relay.

Built on the MCP SDK auth scaffold (Dynamic Client Registration, PKCE,
authorization code, refresh). A single human gate protects /authorize:
the owner must enter PCP_LOGIN_PASSWORD before any code is issued, so no
token can be obtained without that secret. Tokens are kept in memory
(the service runs a single replica); a redeploy simply asks the owner to
authorise again. No secret is stored in the repository.
"""
import secrets
import time
import os
import sqlite3

from mcp.server.auth.provider import (
    AccessToken,
    AuthorizationCode,
    AuthorizationParams,
    OAuthAuthorizationServerProvider,
    RefreshToken,
    construct_redirect_uri,
)
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken

CODE_TTL = 300
ACCESS_TTL = 3600
REFRESH_TTL = 30 * 86400
PENDING_TTL = 600


class OwnerProvider(OAuthAuthorizationServerProvider):
    def __init__(self, issuer: str, login_path: str, scopes: list[str]):
        self.issuer = issuer.rstrip('/')
        self.login_path = login_path
        self.scopes = scopes
        self._clients: dict[str, OAuthClientInformationFull] = {}
        self._pending: dict[str, dict] = {}
        self._codes: dict[str, AuthorizationCode] = {}
        self._access: dict[str, AccessToken] = {}
        self._refresh: dict[str, RefreshToken] = {}
        self._db = sqlite3.connect(os.environ.get('PCP_OAUTH_DB', '/data/oauth.sqlite3'), check_same_thread=False)
        self._db.execute('CREATE TABLE IF NOT EXISTS records (kind TEXT, key TEXT, data TEXT, PRIMARY KEY(kind,key))')
        for kind, key, data in self._db.execute('SELECT kind,key,data FROM records'):
            cls, dest = {'client': (OAuthClientInformationFull, self._clients), 'code': (AuthorizationCode, self._codes), 'access': (AccessToken, self._access), 'refresh': (RefreshToken, self._refresh)}[kind]
            dest[key] = cls.model_validate_json(data)
        # Recover the original ChatGPT OAuth client registration lost before
        # persistent storage was enabled. This ID is a public OAuth identifier,
        # not a client secret or an access token.
        legacy_id = 'bc81f2c7-02d7-426b-aa46-4e99122ea75f'
        if legacy_id not in self._clients:
            self._clients[legacy_id] = OAuthClientInformationFull(
                client_id=legacy_id,
                redirect_uris=['https://chatgpt.com/connector_platform_oauth_redirect', 'https://chatgpt.com/connector/oauth/T9Xn_LzVgMep'],
                token_endpoint_auth_method='none',
                grant_types=['authorization_code', 'refresh_token'],
                response_types=['code'],
                scope='pc',
            )
        else:
            existing = self._clients[legacy_id]
            uri = 'https://chatgpt.com/connector/oauth/T9Xn_LzVgMep'
            if uri not in [str(u) for u in existing.redirect_uris]:
                self._clients[legacy_id] = existing.model_copy(update={'redirect_uris': list(existing.redirect_uris) + [uri]})
        self._gc()

    def close(self) -> None:
        """Close the record store (the process is ending, or a test removes its folder)."""
        self._db.close()

    def _persist(self):
        with self._db:
            self._db.execute('DELETE FROM records')
            for kind, store in [('client', self._clients), ('code', self._codes), ('access', self._access), ('refresh', self._refresh)]:
                self._db.executemany('INSERT INTO records VALUES (?,?,?)', [(kind,k,v.model_dump_json()) for k,v in store.items()])

    # Dynamic Client Registration
    async def get_client(self, client_id: str):
        return self._clients.get(client_id)

    async def register_client(self, client_info: OAuthClientInformationFull):
        self._clients[client_info.client_id] = client_info
        self._persist()

    # Authorization: hand the browser to the owner login page
    async def authorize(self, client: OAuthClientInformationFull, params: AuthorizationParams) -> str:
        self._gc()
        rid = secrets.token_urlsafe(24)
        self._pending[rid] = {'client_id': client.client_id, 'params': params, 'ts': time.time()}
        return f"{self.issuer}{self.login_path}?rid={rid}"

    # Called by the relay's /login POST once the password is correct
    def complete_login(self, rid: str) -> str | None:
        p = self._pending.pop(rid, None)
        if not p or time.time() - p['ts'] > PENDING_TTL:
            return None
        params: AuthorizationParams = p['params']
        code = secrets.token_urlsafe(32)
        self._codes[code] = AuthorizationCode(
            code=code,
            scopes=params.scopes or self.scopes,
            expires_at=int(time.time() + CODE_TTL),
            client_id=p['client_id'],
            code_challenge=params.code_challenge,
            redirect_uri=params.redirect_uri,
            redirect_uri_provided_explicitly=params.redirect_uri_provided_explicitly,
            resource=params.resource,
            subject='owner',
        )
        self._persist()
        extra = {'state': params.state} if params.state else {}
        return construct_redirect_uri(str(params.redirect_uri), code=code, **extra)

    async def load_authorization_code(self, client, authorization_code: str):
        c = self._codes.get(authorization_code)
        if c and c.client_id == client.client_id and c.expires_at > time.time():
            return c
        return None

    async def exchange_authorization_code(self, client, authorization_code) -> OAuthToken:
        self._codes.pop(authorization_code.code, None)
        return self._issue(client.client_id, authorization_code.scopes, authorization_code.resource)

    async def load_refresh_token(self, client, refresh_token: str):
        t = self._refresh.get(refresh_token)
        if t and t.client_id == client.client_id and t.expires_at > time.time():
            return t
        return None

    async def exchange_refresh_token(self, client, refresh_token, scopes) -> OAuthToken:
        self._refresh.pop(refresh_token.token, None)
        return self._issue(client.client_id, scopes or refresh_token.scopes, refresh_token.resource)

    async def load_access_token(self, token: str):
        t = self._access.get(token)
        if t and t.expires_at > time.time():
            return t
        self._access.pop(token, None)
        return None

    async def revoke_token(self, token):
        key = getattr(token, 'token', None)
        self._access.pop(key, None)
        self._refresh.pop(key, None)
        self._persist()

    def _issue(self, client_id: str, scopes: list[str], resource) -> OAuthToken:
        now = time.time()
        at = secrets.token_urlsafe(32)
        rt = secrets.token_urlsafe(32)
        self._access[at] = AccessToken(
            token=at, client_id=client_id, scopes=scopes,
            expires_at=int(now + ACCESS_TTL), resource=resource, subject='owner',
        )
        self._refresh[rt] = RefreshToken(
            token=rt, client_id=client_id, scopes=scopes,
            expires_at=int(now + REFRESH_TTL), resource=resource,
        )
        self._persist()
        return OAuthToken(access_token=at, token_type='Bearer', expires_in=ACCESS_TTL,
                          scope=' '.join(scopes), refresh_token=rt)

    def _gc(self):
        cut = time.time()
        for store in (self._codes, self._access, self._refresh):
            for k in [k for k, v in store.items() if v.expires_at <= cut]:
                store.pop(k, None)
        for k in [k for k, v in self._pending.items() if cut - v['ts'] > PENDING_TTL]:
            self._pending.pop(k, None)
        self._persist()


LOGIN_PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PC Control Plus sign-in</title>
<style>
:root{{color-scheme:light dark}}
body{{font-family:system-ui,sans-serif;max-width:22rem;margin:4rem auto;padding:0 1rem}}
h1{{font-size:1.15rem}} input{{width:100%;padding:.6rem;font-size:1rem;box-sizing:border-box}}
button{{margin-top:1rem;padding:.6rem 1rem;font-size:1rem;width:100%}}
.err{{color:#c00;margin-bottom:1rem}}
</style></head><body>
<h1>PC Control Plus</h1>
<p>Authorise this connector to access your computer.</p>
{error}
<form method="post" action="{login_path}">
<input type="hidden" name="rid" value="{rid}">
<input type="password" name="password" placeholder="Owner password" autofocus autocomplete="current-password">
<button type="submit">Authorise</button>
</form></body></html>"""

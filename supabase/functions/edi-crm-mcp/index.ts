import "jsr:@supabase/functions-js@2.112.3/edge-runtime.d.ts";

import { Server } from "npm:@modelcontextprotocol/sdk@1.25.3/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "npm:@modelcontextprotocol/sdk@1.25.3/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "npm:@modelcontextprotocol/sdk@1.25.3/types.js";
import {
  createRemoteJWKSet,
  errors as joseErrors,
  type JWTPayload,
  jwtVerify,
} from "npm:jose@6.2.8";
import { Hono } from "npm:hono@4.13.1";

import {
  ALL_SCOPES,
  type AuthContext,
  bearerChallenge,
  dispatchTool,
  MCP_RESOURCE,
  SERVER_INSTRUCTIONS,
  toolDefinitions,
} from "./tools.ts";

const FUNCTION_PATH = "/edi-crm-mcp";
const AUTH0_ISSUER = "https://dev-gx6ah8hplc28dtci.us.auth0.com/";
const DEFAULT_ALLOWED_SUBJECT = "github|264040869";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": [
    "authorization",
    "content-type",
    "last-event-id",
    "mcp-protocol-version",
    "mcp-session-id",
  ].join(", "),
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-expose-headers": "mcp-session-id, www-authenticate",
};

const protectedResourceMetadata = {
  resource: MCP_RESOURCE,
  authorization_servers: [AUTH0_ISSUER],
  scopes_supported: [...ALL_SCOPES],
  bearer_methods_supported: ["header"],
  resource_name: "EDI CRM Manager",
  resource_documentation: "https://scott17673.github.io/crm-web-/privacy.html",
};

const jwks = createRemoteJWKSet(
  new URL(".well-known/jwks.json", AUTH0_ISSUER),
  {
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
    timeoutDuration: 5_000,
  },
);

function jsonResponse(
  status: number,
  body: unknown,
  extraHeaders: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      ...Object.fromEntries(new Headers(extraHeaders)),
    },
  });
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    headers.set(name, value);
  }
  headers.set("cache-control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function unauthorizedResponse(description: string): Response {
  const challenge = bearerChallenge(ALL_SCOPES, "invalid_token", description);
  return jsonResponse(
    401,
    { ok: false, error: "unauthorized", error_description: description },
    { "www-authenticate": challenge },
  );
}

function extractBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1] ?? null;
}

function tokenScopes(payload: JWTPayload): string[] {
  return typeof payload.scope === "string"
    ? payload.scope.split(/\s+/).filter(Boolean)
    : [];
}

async function verifyAccessToken(token: string): Promise<AuthContext> {
  const { payload } = await jwtVerify(token, jwks, {
    algorithms: ["RS256"],
    issuer: AUTH0_ISSUER,
    audience: MCP_RESOURCE,
    clockTolerance: 5,
  });

  if (typeof payload.exp !== "number") {
    throw new Error("access token is missing exp");
  }
  if (payload.nbf !== undefined && typeof payload.nbf !== "number") {
    throw new Error("access token has an invalid nbf");
  }
  if (typeof payload.sub !== "string" || !payload.sub) {
    throw new Error("access token is missing sub");
  }

  const allowedSubject = Deno.env.get("AUTH0_ALLOWED_SUB")?.trim() ||
    DEFAULT_ALLOWED_SUBJECT;
  if (payload.sub !== allowedSubject) {
    throw new Error("OAuth principal is not authorized for this CRM");
  }

  const clientId = typeof payload.azp === "string"
    ? payload.azp
    : typeof payload.client_id === "string"
    ? payload.client_id
    : "unidentified-oauth-client";

  return {
    token,
    clientId,
    scopes: tokenScopes(payload),
    expiresAt: payload.exp,
    resource: new URL(MCP_RESOURCE),
    extra: { subject: payload.sub },
  };
}

function buildMcpServer(auth: AuthContext): Server {
  const server = new Server(
    { name: "edi-crm-manager", version: "1.1.0" },
    {
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  server.setRequestHandler(
    ListToolsRequestSchema,
    () => ({ tools: [...toolDefinitions] }),
  );
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return await dispatchTool(
      request.params.name,
      request.params.arguments ?? {},
      auth,
    );
  });
  return server;
}

const app = new Hono().basePath(FUNCTION_PATH);

app.options(
  "*",
  () => new Response(null, { status: 204, headers: CORS_HEADERS }),
);

app.get("/", (context) =>
  context.json({
    ok: true,
    service: "edi-crm-manager",
    mcp_endpoint: MCP_RESOURCE,
    authentication: "oauth2",
  }));

app.get("/.well-known/oauth-protected-resource", (context) => {
  return context.json(protectedResourceMetadata, 200, {
    "access-control-allow-origin": "*",
    "cache-control": "public, max-age=300",
  });
});

// This alias is useful to clients that append the well-known suffix to the
// full MCP endpoint before following the explicit resource_metadata challenge.
app.get("/mcp/.well-known/oauth-protected-resource", (context) => {
  return context.json(protectedResourceMetadata, 200, {
    "access-control-allow-origin": "*",
    "cache-control": "public, max-age=300",
  });
});

app.all("/mcp", async (context) => {
  const token = extractBearerToken(context.req.raw);
  if (!token) return unauthorizedResponse("A bearer access token is required");

  let auth: AuthContext;
  try {
    auth = await verifyAccessToken(token);
  } catch (error) {
    const reason = error instanceof joseErrors.JOSEError
      ? "The bearer access token is invalid or expired"
      : error instanceof Error && error.message.includes("principal")
      ? "This OAuth account is not authorized for EDI CRM"
      : "The bearer access token could not be verified";
    console.warn(JSON.stringify({
      event: "edi_crm_mcp_auth_rejected",
      reason: error instanceof Error ? error.name : "UnknownError",
    }));
    return unauthorizedResponse(reason);
  }

  const server = buildMcpServer(auth);
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
    sessionIdGenerator: undefined,
  });
  await server.connect(transport);
  const response = await transport.handleRequest(context.req.raw, {
    authInfo: auth,
  });
  return withCors(response);
});

Deno.serve(app.fetch);

import { Env } from "../types";

export async function hashPassword(password: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const salt = enc.encode("fonoster-cf-salt-2026");
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: 100000,
      hash: "SHA-256"
    },
    key,
    256
  );
  return Array.from(new Uint8Array(bits))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const computed = await hashPassword(password);
  return computed === hash;
}

export async function signJwt(
  payload: Record<string, any>,
  secret: string,
  expiresInSeconds = 86400
): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const fullPayload = { ...payload, exp };

  const enc = new TextEncoder();
  const b64Header = btoa(JSON.stringify(header)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const b64Payload = btoa(JSON.stringify(fullPayload)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const data = `${b64Header}.${b64Payload}`;

  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  const b64Sig = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return `${data}.${b64Sig}`;
}

export async function verifyJwt(token: string, secret: string): Promise<Record<string, any> | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [b64Header, b64Payload, b64Sig] = parts;
    const data = `${b64Header}.${b64Payload}`;
    const enc = new TextEncoder();

    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    // Reconstitute raw signature bytes
    const base64 = b64Sig.replace(/-/g, "+").replace(/_/g, "/");
    const binarySig = atob(base64);
    const sigBytes = new Uint8Array(binarySig.length);
    for (let i = 0; i < binarySig.length; i++) {
      sigBytes[i] = binarySig.charCodeAt(i);
    }

    const isValid = await crypto.subtle.verify("HMAC", key, sigBytes, enc.encode(data));
    if (!isValid) return null;

    const payloadJson = atob(b64Payload.replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(payloadJson);

    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return null; // Expired
    }

    return payload;
  } catch {
    return null;
  }
}

export async function authenticateRequest(
  request: Request,
  env: Env
): Promise<{ userRef?: string; workspaceRef?: string } | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) return null;

  const [type, token] = authHeader.split(" ");
  if (type !== "Bearer" || !token) return null;

  // Check API key in D1 or KV cache
  const cached = await env.FONOSTER_KV?.get(`apikey:${token}`, "json") as { workspaceRef: string } | null;
  if (cached) {
    return { workspaceRef: cached.workspaceRef };
  }

  // Check in D1
  const apiKeyRecord = await env.DB.prepare(
    "SELECT workspace_ref FROM api_keys WHERE access_key_secret = ? LIMIT 1"
  )
    .bind(token)
    .first<{ workspace_ref: string }>();

  if (apiKeyRecord) {
    await env.FONOSTER_KV?.put(
      `apikey:${token}`,
      JSON.stringify({ workspaceRef: apiKeyRecord.workspace_ref }),
      { expirationTtl: 300 }
    );
    return { workspaceRef: apiKeyRecord.workspace_ref };
  }

  // Verify as JWT
  const secret = env.JWT_SECRET || "default-fonoster-jwt-secret";
  const jwt = await verifyJwt(token, secret);
  if (jwt) {
    return { userRef: jwt.sub, workspaceRef: jwt.workspaceRef };
  }

  return null;
}

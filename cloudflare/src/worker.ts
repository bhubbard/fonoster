import { CallSessionDO } from "./durable-objects/CallSessionDO";
import { SipRegistrarDO } from "./durable-objects/SipRegistrarDO";
import { authenticateRequest, hashPassword, signJwt, verifyPassword } from "./lib/auth";
import { CloudflareCallsClient } from "./lib/calls";
import { CdrQueueMessage, Env } from "./types";

export { CallSessionDO, SipRegistrarDO };

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Fonoster-Access-Key-Id",
  "Access-Control-Max-Age": "86400"
};

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS
    }
  });
}

function errorJson(message: string, status = 400) {
  return json({ error: message, status }, status);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // --- Health Check ---
    if (path === "/healthz" || path === "/health") {
      return json({ status: "healthy", service: "fonoster-cf", timestamp: Date.now() });
    }

    // --- Auth Routes ---
    if (request.method === "POST" && path === "/v1/auth/register") {
      const body = (await request.json()) as any;
      if (!body.email || !body.password || !body.name) {
        return errorJson("Missing required fields: name, email, password");
      }

      const existing = await env.DB.prepare("SELECT ref FROM users WHERE email = ? LIMIT 1")
        .bind(body.email)
        .first();
      if (existing) {
        return errorJson("User already exists with this email", 409);
      }

      const userRef = `usr_${crypto.randomUUID()}`;
      const accessKeyId = `AK${crypto.randomUUID().replace(/-/g, "").slice(0, 30)}`;
      const passwordHash = await hashPassword(body.password);

      await env.DB.prepare(
        "INSERT INTO users (ref, access_key_id, name, email, password_hash) VALUES (?, ?, ?, ?, ?)"
      )
        .bind(userRef, accessKeyId, body.name, body.email, passwordHash)
        .run();

      // Create default workspace
      const workspaceRef = `ws_${crypto.randomUUID()}`;
      const wsKeyId = `WO${crypto.randomUUID().replace(/-/g, "").slice(0, 30)}`;
      await env.DB.prepare(
        "INSERT INTO workspaces (ref, access_key_id, name, owner_ref) VALUES (?, ?, ?, ?)"
      )
        .bind(workspaceRef, wsKeyId, `${body.name}'s Workspace`, userRef)
        .run();

      await env.DB.prepare(
        "INSERT INTO workspace_members (ref, user_ref, workspace_ref, role, status) VALUES (?, ?, ?, ?, ?)"
      )
        .bind(`wsm_${crypto.randomUUID()}`, userRef, workspaceRef, "WORKSPACE_OWNER", "ACTIVE")
        .run();

      const token = await signJwt(
        { sub: userRef, workspaceRef, email: body.email },
        env.JWT_SECRET || "default-fonoster-jwt-secret"
      );

      return json({
        user: { ref: userRef, accessKeyId, name: body.name, email: body.email },
        workspace: { ref: workspaceRef, name: `${body.name}'s Workspace` },
        token
      });
    }

    if (request.method === "POST" && path === "/v1/auth/login") {
      const body = (await request.json()) as any;
      const user = await env.DB.prepare(
        "SELECT ref, access_key_id, name, email, password_hash FROM users WHERE email = ? LIMIT 1"
      )
        .bind(body.email)
        .first<any>();

      if (!user || !(await verifyPassword(body.password, user.password_hash))) {
        return errorJson("Invalid email or password", 401);
      }

      const membership = await env.DB.prepare(
        "SELECT workspace_ref FROM workspace_members WHERE user_ref = ? LIMIT 1"
      )
        .bind(user.ref)
        .first<any>();

      const workspaceRef = membership?.workspace_ref || "";
      const token = await signJwt(
        { sub: user.ref, workspaceRef, email: user.email },
        env.JWT_SECRET || "default-fonoster-jwt-secret"
      );

      return json({
        user: { ref: user.ref, accessKeyId: user.access_key_id, name: user.name, email: user.email },
        workspaceRef,
        token
      });
    }

    // --- Media Stream & Signaling WebSocket Upgrade ---
    // Match /v1/calls/:id/media-stream or /v1/calls/:id/control
    const callStreamMatch = path.match(/^\/v1\/calls\/([^\/]+)\/(media-stream|control)$/);
    if (callStreamMatch) {
      const callId = callStreamMatch[1];
      const doId = env.CALL_SESSION_DO.idFromName(callId);
      const stub = env.CALL_SESSION_DO.get(doId);
      return stub.fetch(request);
    }

    // --- SIP Registrar Routes ---
    if (path.startsWith("/v1/sip/")) {
      const domain = url.searchParams.get("domain") || "default";
      const doId = env.SIP_REGISTRAR_DO.idFromName(domain);
      const stub = env.SIP_REGISTRAR_DO.get(doId);
      const subPath = path.replace("/v1/sip", "");
      const newUrl = new URL(request.url);
      newUrl.pathname = subPath;
      return stub.fetch(new Request(newUrl.toString(), request));
    }

    // Authenticate subsequent API routes
    const auth = await authenticateRequest(request, env);
    if (!auth?.workspaceRef && !path.startsWith("/v1/calls/webhook/")) {
      return errorJson("Unauthorized: Valid Bearer token or API key required", 401);
    }
    const workspaceRef = auth?.workspaceRef || "";

    // --- Applications ---
    if (path === "/v1/applications") {
      if (request.method === "GET") {
        const apps = await env.DB.prepare(
          "SELECT * FROM applications WHERE workspace_ref = ? ORDER BY created_at DESC"
        )
          .bind(workspaceRef)
          .all();
        return json(apps.results);
      }

      if (request.method === "POST") {
        const body = (await request.json()) as any;
        if (!body.name || !body.endpoint) {
          return errorJson("Missing required fields: name, endpoint");
        }
        const appRef = `app_${crypto.randomUUID()}`;
        const accessKeyId = `AK${crypto.randomUUID().replace(/-/g, "").slice(0, 30)}`;
        await env.DB.prepare(
          "INSERT INTO applications (ref, workspace_ref, access_key_id, name, type, endpoint) VALUES (?, ?, ?, ?, ?, ?)"
        )
          .bind(appRef, workspaceRef, accessKeyId, body.name, body.type || "EXTERNAL", body.endpoint)
          .run();
        return json({ ref: appRef, accessKeyId, name: body.name, endpoint: body.endpoint }, 201);
      }
    }

    // --- Phone Numbers ---
    if (path === "/v1/numbers") {
      if (request.method === "GET") {
        const numbers = await env.DB.prepare(
          "SELECT * FROM numbers WHERE workspace_ref = ? ORDER BY created_at DESC"
        )
          .bind(workspaceRef)
          .all();
        return json(numbers.results);
      }

      if (request.method === "POST") {
        const body = (await request.json()) as any;
        if (!body.e164Number) {
          return errorJson("Missing required field: e164Number");
        }
        const numRef = `num_${crypto.randomUUID()}`;
        await env.DB.prepare(
          "INSERT INTO numbers (ref, workspace_ref, e164_number, country_iso, aor, app_ref, trunk_ref) VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
          .bind(
            numRef,
            workspaceRef,
            body.e164Number,
            body.countryIso || "US",
            body.aor || null,
            body.appRef || null,
            body.trunkRef || null
          )
          .run();
        return json({ ref: numRef, e164Number: body.e164Number }, 201);
      }
    }

    // --- SIP Trunks ---
    if (path === "/v1/trunks") {
      if (request.method === "GET") {
        const trunks = await env.DB.prepare(
          "SELECT * FROM trunks WHERE workspace_ref = ? ORDER BY created_at DESC"
        )
          .bind(workspaceRef)
          .all();
        return json(trunks.results);
      }

      if (request.method === "POST") {
        const body = (await request.json()) as any;
        const trunkRef = `trk_${crypto.randomUUID()}`;
        await env.DB.prepare(
          "INSERT INTO trunks (ref, workspace_ref, name, host, port, transport, username, secret) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
          .bind(
            trunkRef,
            workspaceRef,
            body.name,
            body.host,
            body.port || 5060,
            body.transport || "UDP",
            body.username || null,
            body.secret || null
          )
          .run();
        return json({ ref: trunkRef, name: body.name, host: body.host }, 201);
      }
    }

    // --- Calls & Programmable Voice ---
    if (path === "/v1/calls") {
      if (request.method === "POST") {
        const body = (await request.json()) as any;
        if (!body.from || !body.to || !body.appRef) {
          return errorJson("Missing required fields: from, to, appRef");
        }

        const callId = `call_${crypto.randomUUID()}`;
        const doId = env.CALL_SESSION_DO.idFromName(callId);
        const stub = env.CALL_SESSION_DO.get(doId);

        // Initialize CallSession Durable Object
        await stub.fetch("https://do/init", {
          method: "POST",
          body: JSON.stringify({
            callId,
            workspaceRef,
            appRef: body.appRef,
            from: body.from,
            to: body.to,
            direction: "OUTBOUND"
          })
        });

        // Initialize WebRTC session via Cloudflare Calls if requested
        let webrtcSession: any = null;
        if (body.webrtc) {
          const callsClient = new CloudflareCallsClient(env);
          webrtcSession = await callsClient.createSession();
        }

        return json({
          callId,
          status: "INITIATING",
          direction: "OUTBOUND",
          from: body.from,
          to: body.to,
          mediaStreamUrl: `/v1/calls/${callId}/media-stream`,
          controlUrl: `/v1/calls/${callId}/control`,
          webrtcSession
        }, 201);
      }
    }

    // Call status and control
    const callDetailMatch = path.match(/^\/v1\/calls\/([^\/]+)$/);
    if (callDetailMatch) {
      const callId = callDetailMatch[1];
      const doId = env.CALL_SESSION_DO.idFromName(callId);
      const stub = env.CALL_SESSION_DO.get(doId);
      return stub.fetch("https://do/status");
    }

    const callVerbMatch = path.match(/^\/v1\/calls\/([^\/]+)\/verbs$/);
    if (callVerbMatch && request.method === "POST") {
      const callId = callVerbMatch[1];
      const doId = env.CALL_SESSION_DO.idFromName(callId);
      const stub = env.CALL_SESSION_DO.get(doId);
      return stub.fetch("https://do/verb", {
        method: "POST",
        body: await request.text(),
        headers: { "Content-Type": "application/json" }
      });
    }

    const callHangupMatch = path.match(/^\/v1\/calls\/([^\/]+)\/hangup$/);
    if (callHangupMatch && request.method === "POST") {
      const callId = callHangupMatch[1];
      const doId = env.CALL_SESSION_DO.idFromName(callId);
      const stub = env.CALL_SESSION_DO.get(doId);
      return stub.fetch("https://do/hangup", { method: "POST" });
    }

    // --- Workers AI: Speech-To-Text & Autopilot Voice Intelligence ---
    if (path === "/v1/ai/transcribe" && request.method === "POST") {
      const audioBytes = await request.arrayBuffer();
      if (!env.AI) {
        return errorJson("Workers AI binding not configured", 503);
      }
      const aiResponse = await env.AI.run("@cf/openai/whisper", {
        audio: [...new Uint8Array(audioBytes)]
      });
      return json(aiResponse);
    }

    if (path === "/v1/ai/chat" && request.method === "POST") {
      const body = (await request.json()) as any;
      if (!env.AI) {
        return errorJson("Workers AI binding not configured", 503);
      }
      const aiResponse = await env.AI.run("@cf/meta/llama-3.3-70b-instruct", {
        messages: body.messages || [
          { role: "system", content: "You are a helpful Fonoster voice assistant." },
          { role: "user", content: body.prompt || "Hello" }
        ]
      });
      return json(aiResponse);
    }

    // --- Call Detail Records (CDRs) ---
    if (path === "/v1/cdrs") {
      const cdrs = await env.DB.prepare(
        "SELECT * FROM call_detail_records WHERE workspace_ref = ? ORDER BY started_at DESC LIMIT 50"
      )
        .bind(workspaceRef)
        .all();
      return json(cdrs.results);
    }

    // --- Fallback to Static Assets (Dashboard) ---
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return errorJson(`Endpoint not found: ${path}`, 404);
  },

  // --- Cloudflare Queue Consumer for CDRs ---
  async queue(batch: MessageBatch<CdrQueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const cdr = message.body;
      try {
        await env.DB.prepare(
          `INSERT INTO call_detail_records (
            ref, workspace_ref, call_id, from_number, to_number, app_ref,
            direction, status, duration_seconds, recording_url, metadata, started_at, ended_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            `cdr_${crypto.randomUUID()}`,
            cdr.workspaceRef,
            cdr.callId,
            cdr.fromNumber,
            cdr.toNumber,
            cdr.appRef || null,
            cdr.direction,
            cdr.status,
            cdr.durationSeconds,
            cdr.recordingUrl || null,
            cdr.metadata ? JSON.stringify(cdr.metadata) : null,
            cdr.startedAt,
            cdr.endedAt
          )
          .run();
        message.ack();
      } catch (err) {
        console.error("Failed to write CDR to D1:", err);
        message.retry();
      }
    }
  }
};

import { Env } from "../types";

export interface SipRegistration {
  username: string;
  domain: string;
  aor: string;
  contactUri: string;
  userAgent?: string;
  expiresAt: number;
  registeredAt: number;
  ip?: string;
}

export class SipRegistrarDO {
  state: DurableObjectState;
  env: Env;
  registrations: Map<string, SipRegistration> = new Map();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<Record<string, SipRegistration>>("registrations");
      if (stored) {
        this.registrations = new Map(Object.entries(stored));
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Register / update an agent
    if (request.method === "POST" && url.pathname === "/register") {
      const body = (await request.json()) as Partial<SipRegistration>;
      if (!body.username || !body.domain) {
        return new Response("Missing username or domain", { status: 400 });
      }

      const aor = `sip:${body.username}@${body.domain}`;
      const reg: SipRegistration = {
        username: body.username,
        domain: body.domain,
        aor,
        contactUri: body.contactUri || aor,
        userAgent: body.userAgent,
        expiresAt: Date.now() + (body.expiresAt ? body.expiresAt * 1000 : 3600 * 1000),
        registeredAt: Date.now(),
        ip: request.headers.get("CF-Connecting-IP") || undefined
      };

      this.registrations.set(aor, reg);
      await this.save();
      return Response.json({ success: true, registration: reg });
    }

    // Lookup registration for routing an incoming call to an extension
    if (request.method === "GET" && url.pathname === "/lookup") {
      const aor = url.searchParams.get("aor");
      if (!aor) {
        return new Response("Missing aor parameter", { status: 400 });
      }

      const reg = this.registrations.get(aor);
      if (!reg || reg.expiresAt < Date.now()) {
        if (reg) {
          this.registrations.delete(aor);
          await this.save();
        }
        return Response.json({ registered: false }, { status: 404 });
      }

      return Response.json({ registered: true, registration: reg });
    }

    // List all active registrations in domain
    if (request.method === "GET" && url.pathname === "/list") {
      const now = Date.now();
      const active: SipRegistration[] = [];
      for (const [key, reg] of this.registrations.entries()) {
        if (reg.expiresAt >= now) {
          active.push(reg);
        } else {
          this.registrations.delete(key);
        }
      }
      await this.save();
      return Response.json(active);
    }

    return new Response("Not found", { status: 404 });
  }

  async save(): Promise<void> {
    const obj: Record<string, SipRegistration> = {};
    for (const [k, v] of this.registrations.entries()) {
      obj[k] = v;
    }
    await this.state.storage.put("registrations", obj);
  }
}

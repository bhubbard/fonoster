import { CallState, CdrQueueMessage, Env, VoiceVerb } from "../types";

export class CallSessionDO {
  state: DurableObjectState;
  env: Env;
  callState: CallState | null = null;
  activeSockets: Set<WebSocket> = new Set();
  recordingChunks: Uint8Array[] = [];

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;

    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<CallState>("callState");
      if (stored) {
        this.callState = stored;
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade for live media streaming or voice agent control
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      await this.handleWebSocket(server, url.searchParams);
      return new Response(null, {
        status: 101,
        webSocket: client
      });
    }

    if (request.method === "POST" && url.pathname === "/init") {
      const body = (await request.json()) as Partial<CallState>;
      this.callState = {
        callId: body.callId || crypto.randomUUID(),
        workspaceRef: body.workspaceRef || "",
        appRef: body.appRef,
        from: body.from || "",
        to: body.to || "",
        direction: body.direction || "INBOUND",
        status: "RINGING",
        startedAt: Date.now(),
        dtmfBuffer: [],
        isRecording: false
      };
      await this.state.storage.put("callState", this.callState);
      return Response.json(this.callState);
    }

    if (request.method === "GET" && url.pathname === "/status") {
      return Response.json(this.callState || { error: "Call not initialized" }, {
        status: this.callState ? 200 : 404
      });
    }

    if (request.method === "POST" && url.pathname === "/verb") {
      const verb = (await request.json()) as VoiceVerb;
      const result = await this.executeVerb(verb);
      return Response.json(result);
    }

    if (request.method === "POST" && url.pathname === "/hangup") {
      await this.terminateCall("NORMAL_CLEARING");
      return Response.json({ success: true, status: "COMPLETED" });
    }

    return new Response("Not found", { status: 404 });
  }

  async handleWebSocket(socket: WebSocket, params: URLSearchParams): Promise<void> {
    this.state.acceptWebSocket(socket);
    this.activeSockets.add(socket);

    const clientType = params.get("type") || "media"; // "media" | "control"

    socket.addEventListener("message", async (event: MessageEvent) => {
      try {
        if (typeof event.data === "string") {
          const msg = JSON.parse(event.data);
          if (msg.type === "dtmf") {
            const digit = String(msg.digit);
            if (this.callState) {
              this.callState.dtmfBuffer.push(digit);
              await this.state.storage.put("callState", this.callState);
            }
            this.broadcastControl({ type: "dtmf_received", digit });
          } else if (msg.type === "verb") {
            const result = await this.executeVerb(msg.verb);
            socket.send(JSON.stringify({ type: "verb_result", result }));
          }
        } else if (event.data instanceof ArrayBuffer) {
          // Binary audio packet (PCM or Opus frame)
          if (this.callState?.isRecording) {
            this.recordingChunks.push(new Uint8Array(event.data));
          }
          // Relay media to peer sockets
          for (const peer of this.activeSockets) {
            if (peer !== socket && peer.readyState === WebSocket.OPEN) {
              peer.send(event.data);
            }
          }
        }
      } catch (err: any) {
        console.error("Error processing socket message:", err);
      }
    });

    socket.addEventListener("close", () => {
      this.activeSockets.delete(socket);
    });
  }

  async executeVerb(verb: VoiceVerb): Promise<Record<string, any>> {
    if (!this.callState) {
      throw new Error("Call not initialized");
    }

    switch (verb.verb) {
      case "Answer":
        this.callState.status = "ANSWERED";
        this.callState.answeredAt = Date.now();
        await this.state.storage.put("callState", this.callState);
        this.broadcastControl({ type: "answered", callId: this.callState.callId });
        return { success: true, status: "ANSWERED" };

      case "Say": {
        const text = verb.params?.text || "";
        this.broadcastControl({
          type: "say",
          text,
          voice: verb.params?.voice || "default"
        });
        return { success: true, verb: "Say", text };
      }

      case "Play": {
        const url = verb.params?.url || "";
        this.broadcastControl({ type: "play", url });
        return { success: true, verb: "Play", url };
      }

      case "PlayDtmf": {
        const digits = verb.params?.digits || "";
        this.broadcastControl({ type: "play_dtmf", digits });
        return { success: true, verb: "PlayDtmf", digits };
      }

      case "Gather": {
        // Collect digits or speech
        const maxDigits = verb.params?.maxDigits || 1;
        const finishOnKey = verb.params?.finishOnKey || "#";
        const gatheredDigits = this.callState.dtmfBuffer.splice(0, maxDigits).join("");
        return {
          success: true,
          verb: "Gather",
          digits: gatheredDigits
        };
      }

      case "Record": {
        this.callState.isRecording = true;
        this.callState.recordingKey = `recordings/${this.callState.callId}.raw`;
        this.recordingChunks = [];
        await this.state.storage.put("callState", this.callState);
        return { success: true, verb: "Record", status: "RECORDING_STARTED" };
      }

      case "Dial": {
        const destination = verb.params?.destination;
        return { success: true, verb: "Dial", destination, status: "BRIDGING" };
      }

      case "Hangup":
        await this.terminateCall("CLIENT_HANGUP");
        return { success: true, verb: "Hangup", status: "COMPLETED" };

      default:
        return { success: false, error: `Unsupported verb: ${verb.verb}` };
    }
  }

  async terminateCall(reason: string): Promise<void> {
    if (!this.callState || this.callState.status === "COMPLETED") return;

    this.callState.status = "COMPLETED";
    this.callState.endedAt = Date.now();
    const duration = Math.round(
      (this.callState.endedAt - (this.callState.answeredAt || this.callState.startedAt)) / 1000
    );

    // Save recording to R2 if recorded
    let recordingUrl: string | undefined;
    if (this.callState.isRecording && this.recordingChunks.length > 0) {
      try {
        const totalLen = this.recordingChunks.reduce((acc, c) => acc + c.length, 0);
        const merged = new Uint8Array(totalLen);
        let offset = 0;
        for (const chunk of this.recordingChunks) {
          merged.set(chunk, offset);
          offset += chunk.length;
        }

        const r2Key = this.callState.recordingKey || `recordings/${this.callState.callId}.raw`;
        await this.env.RECORDINGS_BUCKET.put(r2Key, merged.buffer, {
          httpMetadata: { contentType: "audio/basic" }
        });
        recordingUrl = `/recordings/${this.callState.callId}`;
      } catch (e) {
        console.error("Failed to persist recording to R2:", e);
      }
    }

    // Push CDR to queue
    const cdrMessage: CdrQueueMessage = {
      callId: this.callState.callId,
      workspaceRef: this.callState.workspaceRef,
      fromNumber: this.callState.from,
      toNumber: this.callState.to,
      appRef: this.callState.appRef,
      direction: this.callState.direction,
      status: "COMPLETED",
      durationSeconds: Math.max(0, duration),
      recordingUrl,
      startedAt: new Date(this.callState.startedAt).toISOString(),
      endedAt: new Date(this.callState.endedAt).toISOString()
    };

    try {
      await this.env.CDRS_QUEUE.send(cdrMessage);
    } catch (e) {
      console.error("Failed to queue CDR:", e);
    }

    this.broadcastControl({ type: "call_ended", reason, duration });

    // Close all sockets
    for (const socket of this.activeSockets) {
      try {
        socket.close(1000, "Call ended");
      } catch {}
    }
    this.activeSockets.clear();
    await this.state.storage.put("callState", this.callState);
  }

  broadcastControl(msg: Record<string, any>): void {
    const payload = JSON.stringify(msg);
    for (const socket of this.activeSockets) {
      if (socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(payload);
        } catch {}
      }
    }
  }
}

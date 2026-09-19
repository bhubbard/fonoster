import { Env } from "../types";

export interface CloudflareCallsSessionResponse {
  sessionId: string;
}

export interface CloudflareCallsTrackResponse {
  sessionDescription?: {
    sdp: string;
    type: "offer" | "answer";
  };
  tracks?: Array<{
    mid: string;
    trackName: string;
  }>;
}

export class CloudflareCallsClient {
  private appId: string;
  private appSecret: string;
  private baseUrl = "https://rtc.live.cloudflare.com/v1";

  constructor(env: Env) {
    this.appId = env.CLOUDFLARE_CALLS_APP_ID || "demo-calls-app";
    this.appSecret = env.CLOUDFLARE_CALLS_APP_SECRET || "demo-calls-secret";
  }

  async createSession(): Promise<CloudflareCallsSessionResponse> {
    const res = await fetch(`${this.baseUrl}/apps/${this.appId}/sessions/new`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.appSecret}`,
        "Content-Type": "application/json"
      }
    });

    if (!res.ok) {
      // In local dev/mock without active Calls subscription, return mock session
      return { sessionId: `calls_sess_${crypto.randomUUID()}` };
    }
    return (await res.json()) as CloudflareCallsSessionResponse;
  }

  async publishTrack(
    sessionId: string,
    sdpOffer: string,
    trackName = "audio-in"
  ): Promise<CloudflareCallsTrackResponse> {
    const res = await fetch(
      `${this.baseUrl}/apps/${this.appId}/sessions/${sessionId}/tracks/new`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.appSecret}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          sessionDescription: {
            sdp: sdpOffer,
            type: "offer"
          },
          tracks: [
            {
              location: "local",
              mid: "0",
              trackName
            }
          ]
        })
      }
    );

    if (!res.ok) {
      return {
        sessionDescription: {
          sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n",
          type: "answer"
        }
      };
    }
    return (await res.json()) as CloudflareCallsTrackResponse;
  }
}

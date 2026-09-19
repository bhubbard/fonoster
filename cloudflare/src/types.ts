export interface Env {
  DB: D1Database;
  CALL_SESSION_DO: DurableObjectNamespace;
  SIP_REGISTRAR_DO: DurableObjectNamespace;
  RECORDINGS_BUCKET: R2Bucket;
  MEDIA_BUCKET: R2Bucket;
  FONOSTER_KV: KVNamespace;
  CDRS_QUEUE: Queue<CdrQueueMessage>;
  AI: any;
  VECTORIZE?: any;
  ASSETS?: Fetcher;

  // Environment variables / secrets
  JWT_SECRET?: string;
  ROOT_DOMAIN?: string;
  CLOUDFLARE_CALLS_APP_ID?: string;
  CLOUDFLARE_CALLS_APP_SECRET?: string;
  ENVIRONMENT?: string;
}

export interface CdrQueueMessage {
  callId: string;
  workspaceRef: string;
  fromNumber: string;
  toNumber: string;
  appRef?: string;
  direction: "INBOUND" | "OUTBOUND";
  status: string;
  durationSeconds: number;
  recordingUrl?: string;
  metadata?: Record<string, any>;
  startedAt: string;
  endedAt: string;
}

export type VoiceVerbType =
  | "Answer"
  | "Hangup"
  | "Say"
  | "Play"
  | "PlayDtmf"
  | "Gather"
  | "Stream"
  | "Dial"
  | "Record"
  | "Mute"
  | "Unmute";

export interface VoiceVerb {
  verb: VoiceVerbType;
  params?: Record<string, any>;
}

export interface VoiceRequest {
  callId: string;
  sessionRef: string;
  appRef: string;
  ingressNumber: string;
  callerNumber: string;
  direction: "INBOUND" | "OUTBOUND";
  metadata?: Record<string, any>;
  amd?: {
    status: "HUMAN" | "MACHINE" | "UNKNOWN";
    confidence: number;
  };
}

export interface CallState {
  callId: string;
  workspaceRef: string;
  appRef?: string;
  from: string;
  to: string;
  direction: "INBOUND" | "OUTBOUND";
  status: "INITIATING" | "RINGING" | "ANSWERED" | "STREAMING" | "COMPLETED" | "FAILED";
  startedAt: number;
  answeredAt?: number;
  endedAt?: number;
  dtmfBuffer: string[];
  isRecording: boolean;
  recordingKey?: string;
  webrtcSessionId?: string;
}

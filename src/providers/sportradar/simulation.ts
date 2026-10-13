import {
  CreateSessionResponseSchema,
  type Recording,
  RecordingResponseSchema,
  RecordingsResponseSchema,
} from './schemas/simulation.js';

/**
 * Client for the Sportradar simulation service (playback.sportradar.com).
 * No API key, never counts quota. Recordings replay at natural pacing from a
 * session created with `createSession`; push feeds need no session.
 */
export class SimulationClient {
  constructor(
    private readonly opts: { playbackUrl: string; fetchImpl?: typeof fetch; timeoutMs?: number },
  ) {}

  private async graphql(query: string, variables: Record<string, unknown> = {}): Promise<unknown> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const res = await fetchImpl(new URL('/graphql', this.opts.playbackUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
    });
    if (!res.ok) throw new Error(`playback graphql -> HTTP ${res.status}`);
    return res.json();
  }

  async listRecordings(league: string): Promise<Recording[]> {
    const json = await this.graphql(
      `query ($league: String) { recordings(league: $league) { id title league scheduled start end meta apis { name description formats apiType } } }`,
      { league },
    );
    return RecordingsResponseSchema.parse(json).data.recordings;
  }

  async getRecording(id: string): Promise<Recording | null> {
    const json = await this.graphql(
      `query ($id: String!) { recording(id: $id) { id title league scheduled start end meta apis { name description formats apiType } } }`,
      { id },
    );
    return RecordingResponseSchema.parse(json).data.recording;
  }

  async createSession(recordingId: string): Promise<string> {
    const json = await this.graphql(
      `mutation ($input: CreateSessionInput!) { createSession(input: $input) }`,
      { input: { recordingId } },
    );
    return CreateSessionResponseSchema.parse(json).data.createSession;
  }

  /** Push replay URL for a recording's push feed (`events`, `clock`, `statistics`). */
  pushUrl(feed: string, recordingId: string): string {
    const u = new URL(`/subscribe/${feed}`, this.opts.playbackUrl);
    u.searchParams.set('recording_id', recordingId);
    return u.toString();
  }
}

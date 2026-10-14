import { z } from 'zod';

/** playback.sportradar.com GraphQL responses. */
export const RecordingApiSchema = z
  .object({
    name: z.string(),
    description: z.string().nullable().optional(),
    formats: z.array(z.string()).nullable().optional(),
    apiType: z.string().nullable().optional(),
  })
  .loose();

export const RecordingSchema = z
  .object({
    id: z.string(),
    title: z.string().nullable().optional(),
    league: z.string().nullable().optional(),
    scheduled: z.string().nullable().optional(),
    start: z.number().nullable().optional(),
    end: z.number().nullable().optional(),
    meta: z
      .object({
        gameId: z.string().optional(),
        homeTeam: z.string().optional(),
        awayTeam: z.string().optional(),
        homeTeamName: z.string().optional(),
        awayTeamName: z.string().optional(),
        scheduled: z.string().optional(),
      })
      .loose()
      .nullable()
      .optional(),
    apis: z.array(RecordingApiSchema).default([]),
  })
  .loose();
export type Recording = z.infer<typeof RecordingSchema>;

export const RecordingsResponseSchema = z.object({
  data: z.object({ recordings: z.array(RecordingSchema) }),
});
export const RecordingResponseSchema = z.object({
  data: z.object({ recording: RecordingSchema.nullable() }),
});
export const CreateSessionResponseSchema = z.object({
  data: z.object({ createSession: z.string().min(1) }),
});

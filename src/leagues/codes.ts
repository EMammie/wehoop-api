import { z } from 'zod';

export const LeagueCodeSchema = z.enum(['wnba', 'ncaawb', 'unrivaled']);
export type LeagueCode = z.infer<typeof LeagueCodeSchema>;

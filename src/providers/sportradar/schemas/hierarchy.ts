import { z } from 'zod';
import { LeagueRefSchema, TeamColorSchema, VenueSchema } from './common.js';

/** A team as listed in the league hierarchy. Strict on what public.teams persists. */
export const HierarchyTeamSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    market: z.string().optional(),
    alias: z.string().optional(),
    founded: z.int().optional(),
    team_colors: z.array(TeamColorSchema).optional(),
    venue: VenueSchema.optional(),
  })
  .loose();
export type HierarchyTeam = z.infer<typeof HierarchyTeamSchema>;

export const HierarchyDivisionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    alias: z.string().optional(),
    teams: z.array(HierarchyTeamSchema).default([]),
  })
  .loose();

export const HierarchyConferenceSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    alias: z.string().optional(),
    teams: z.array(HierarchyTeamSchema).optional(),
    divisions: z.array(HierarchyDivisionSchema).optional(),
  })
  .loose();

/**
 * League hierarchy (`/league/hierarchy.json`). WNBA and Unrivaled list
 * `conferences[]` at the top; NCAAWB nests them under `divisions[]` (D1-W).
 */
export const LeagueHierarchyDocumentSchema = z
  .object({
    league: LeagueRefSchema,
    conferences: z.array(HierarchyConferenceSchema).optional(),
    divisions: z
      .array(
        z
          .object({
            id: z.string(),
            name: z.string(),
            alias: z.string().optional(),
            conferences: z.array(HierarchyConferenceSchema).default([]),
          })
          .loose(),
      )
      .optional(),
  })
  .loose();
export type LeagueHierarchyDocument = z.infer<typeof LeagueHierarchyDocumentSchema>;

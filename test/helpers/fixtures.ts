import { readFileSync } from 'node:fs';

/** Load a committed provider fixture by league and file name. */
export function fixture(name: string, league = 'wnba'): unknown {
  return JSON.parse(
    readFileSync(new URL(`../../fixtures/${league}/${name}`, import.meta.url), 'utf8'),
  );
}

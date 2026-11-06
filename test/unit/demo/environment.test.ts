import { describe, expect, it } from 'vitest';
import { environmentProblem } from '../../../src/ingest/environment.js';

/** Plan rev 4.15 (4): demo runs on the dev stack or a `demo` database; production refuses `demo`. */
describe('environment marker decision', () => {
  it('demo mode: dev stack (unmarked or dev) or a database marked demo, nothing else', () => {
    expect(environmentProblem('demo', true, null, 'db')).toBeNull();
    expect(environmentProblem('demo', true, 'dev', 'db')).toBeNull();
    expect(environmentProblem('demo', true, 'demo', 'db')).toBeNull();
    expect(environmentProblem('demo', false, 'demo', 'db')).toBeNull();
    expect(environmentProblem('demo', false, null, 'db.x:5432')).toMatch(
      /MODE=demo runs only on the dev stack or a database marked demo; db.x:5432 is unmarked/,
    );
    expect(environmentProblem('demo', false, 'production', 'db')).toMatch(/marked production/);
    expect(environmentProblem('demo', true, 'production', 'db')).toMatch(/marked production/);
    expect(environmentProblem('demo', false, 'dev', 'db')).toMatch(/marked dev/);
  });

  it('production mode refuses a database marked demo and nothing else', () => {
    expect(environmentProblem('production', false, 'demo', 'db')).toMatch(
      /MODE=production refuses db: it is marked demo/,
    );
    expect(environmentProblem('production', false, null, 'db')).toBeNull();
    expect(environmentProblem('production', false, 'production', 'db')).toBeNull();
    expect(environmentProblem('trial', false, 'demo', 'db')).toBeNull();
    expect(environmentProblem('sim', true, 'demo', 'db')).toBeNull();
  });
});

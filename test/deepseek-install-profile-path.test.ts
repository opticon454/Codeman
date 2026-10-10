import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { STOCK_CLIS } from '../src/config/cli-registry/stock.js';

const root = resolve(import.meta.dirname, '..');

describe('DeepSeek install', () => {
  it('installs pnpm with dsh, since `dsh plugin` spawns a literal pnpm', () => {
    const ds = STOCK_CLIS.find((c) => (c.id as string) === 'deepseek')!;
    expect(ds.discovery.install.command?.linux).toBe('npm install -g @deepseek-ai/dsh pnpm');
  });

  it("puts dsh's own directory first on the profile install's PATH", () => {
    const src = readFileSync(resolve(root, 'src/web/routes/system-routes.ts'), 'utf8');
    expect(src).toMatch(/env: \{ \.\.\.process\.env, PATH: \[dir, process\.env\.PATH\]/);
  });
});

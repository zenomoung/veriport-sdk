/**
 * server.json against the MCP registry's published limits (schema 2025-12-11:
 * name pattern, description and title at most 100 characters), and kept in step
 * with package.json (mcpName, versions), so `mcp-publisher publish` is not refused.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (f) => JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'));

test('server.json fits the registry limits and matches package.json', () => {
  const server = read('server.json');
  const pkg = read('package.json');
  assert.match(server.name, /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
  assert.ok(server.description.length >= 1 && server.description.length <= 100, `description is ${server.description.length} characters (max 100)`);
  assert.ok(server.title.length >= 1 && server.title.length <= 100, `title is ${server.title.length} characters (max 100)`);
  assert.equal(pkg.mcpName, server.name);
  assert.equal(server.version, pkg.version);
  const npm = server.packages.find((x) => x.registryType === 'npm');
  assert.equal(npm.identifier, pkg.name);
  assert.equal(npm.version, pkg.version);
});

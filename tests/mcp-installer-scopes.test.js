'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Pure in-memory CLI fixture: never executes Codex/Claude, starts an MCP,
// accesses user settings, or writes a configuration file.
const installer = process.argv[2] || path.resolve(__dirname, '../scripts/install-mcp.js');
const source = fs.readFileSync(installer, 'utf8');
const scopes = ['local', 'project', 'user'];
const name = 'scope-test';
const fakeServer = path.resolve('/inert/server.js');
const original = (scope) => ({ marker: `original-${scope}` });

function invoke(scope, uninstall, existingScopes) {
  const state = Object.fromEntries(scopes.map((s) => [s, {}]));
  existingScopes.forEach((s) => { state[s][name] = original(s); });
  const calls = [];
  const stdout = [];
  const stderr = [];
  const response = (status, text = '') => ({ status, stdout: status === 0 ? text : '', stderr: status ? text : '' });

  function spawnSync(command, args) {
    assert.equal(command, 'claude');
    calls.push(Array.from(args));
    if (args[0] === '--version') return response(0, 'inert-claude-fixture\n');
    assert.equal(args[0], 'mcp');
    const op = args[1];
    const index = args.findIndex((arg) => arg === '-s' || arg === '--scope');
    const requestedScope = index < 0 ? null : args[index + 1];
    const nameIndex = index === 2 ? 4 : 2;
    assert.equal(args[nameIndex], name);
    const present = scopes.filter((s) => state[s][name]);
    if (op === 'get') return response(present.length ? 0 : 1);
    if (op === 'remove') {
      if (!requestedScope && present.length > 1) return response(1, 'server exists in multiple scopes\n');
      const target = requestedScope || present[0];
      if (!target || !state[target][name]) return response(1, 'server not found in selected scope\n');
      delete state[target][name];
      return response(0);
    }
    if (op === 'add') {
      const target = requestedScope || 'local';
      if (state[target][name]) return response(1, 'server already exists in selected scope\n');
      const separator = args.indexOf('--');
      assert.ok(separator >= 0);
      state[target][name] = { command: args[separator + 1], args: Array.from(args).slice(separator + 2) };
      return response(0);
    }
    throw new Error(`Unexpected operation: ${op}`);
  }

  const module = { exports: {} };
  function requireFixture(id) {
    if (id === 'node:fs') return { existsSync: () => true };
    if (id === 'node:path') return path;
    if (id === 'node:child_process') return { spawnSync };
    throw new Error(`Unexpected import: ${id}`);
  }
  requireFixture.main = {};
  const argv = ['/inert/node', installer, '--claude-only', '--name', name, '--claude-scope', scope, '--server-script', fakeServer];
  if (uninstall) argv.push('--uninstall');
  const fakeProcess = {
    argv, execPath: '/inert/node', env: {}, cwd: () => '/inert',
    stdout: { write: (s) => stdout.push(String(s)) },
    stderr: { write: (s) => stderr.push(String(s)) }
  };
  vm.runInNewContext(`${source}\nmodule.exports = { main };`, {
    require: requireFixture, module, __dirname: path.dirname(installer), process: fakeProcess
  }, { filename: installer });
  let status = 0;
  try { module.exports.main(); }
  catch (error) { status = 1; stderr.push(error.message); }
  return { status, state, calls, stdout: stdout.join(''), stderr: stderr.join('') };
}

const results = [];
function test(title, fn) {
  try { fn(); results.push({ title, passed: true }); }
  catch (error) { results.push({ title, passed: false, message: error.message }); }
}
function preserveOtherScopes(result, target, existing) {
  for (const s of existing) {
    if (s !== target) assert.deepEqual(result.state[s][name], original(s), `preserve ${s} registration`);
  }
}

for (const scope of scopes) {
  test(`reinstall ${scope} with all three scopes populated`, () => {
    const result = invoke(scope, false, scopes);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.state[scope][name].args, [fakeServer]);
    preserveOtherScopes(result, scope, scopes);
  });
  test(`uninstall ${scope} with all three scopes populated`, () => {
    const result = invoke(scope, true, scopes);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.state[scope][name], undefined);
    preserveOtherScopes(result, scope, scopes);
  });
  const other = scopes.find((s) => s !== scope);
  test(`install ${scope} preserves a sole ${other} definition`, () => {
    const result = invoke(scope, false, [other]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.state[scope][name].args, [fakeServer]);
    preserveOtherScopes(result, scope, [other]);
  });
  test(`uninstall absent ${scope} preserves a sole ${other} definition`, () => {
    const result = invoke(scope, true, [other]);
    assert.equal(result.state[scope][name], undefined);
    preserveOtherScopes(result, scope, [other]);
    // A missing selected scope may be a no-op or a safe failure. Either way,
    // no definition from another scope is authorized for removal.
    assert.ok(result.status === 0 || result.status === 1);
  });
  test(`reinstall a sole ${scope} definition still succeeds`, () => {
    const result = invoke(scope, false, [scope]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.state[scope][name].args, [fakeServer]);
  });
}

console.log(JSON.stringify({ installer, passed: results.filter((r) => r.passed).length, failed: results.filter((r) => !r.passed).length, results }, null, 2));
if (results.some((r) => !r.passed)) process.exitCode = 1;

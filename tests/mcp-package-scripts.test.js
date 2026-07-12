'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function run() {
  const packageJsonCandidates = [
    path.join(__dirname, '..', 'package.json'),
    path.join(__dirname, '..', '..', 'package.json')
  ];
  const packageJsonPath = packageJsonCandidates.find((candidate) => fs.existsSync(candidate));
  if (!packageJsonPath) {
    throw new Error('Unable to locate package.json for script assertions');
  }
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const scripts = pkg.scripts || {};

  const expected = pkg.name === '@vdoninja/mcp'
    ? {
      'test': 'node tests/run-mcp-tests-minimal.js',
      'test:all': 'node tests/run-mcp-tests.js',
      'test:mcp': 'node tests/run-mcp-tests-minimal.js',
      'test:mcp:all': 'node tests/run-mcp-tests.js',
      'test:mcp:live': 'node tests/live-turn-smoke.js',
      'test:mcp:soak': 'node tests/live-turn-soak.js',
      'test:mcp:matrix': 'node tests/live-turn-matrix.js',
      'test:mcp:preset:matrix': 'node tests/live-turn-preset-matrix.js',
      'test:mcp:matrix:sweep': 'node tests/live-turn-matrix-sweep.js',
      'mcp:install': 'node scripts/install-mcp.js',
      'mcp:server': 'node scripts/vdo-mcp-server.js',
      'mcp:http': 'node scripts/vdo-mcp-streamable-http.js',
      'demo:message': 'node scripts/demo-message-workflow.js',
      'demo:file': 'node scripts/demo-file-workflow.js'
    }
    : {
      'test:mcp:preset:matrix': 'node MCP/tests/live-turn-preset-matrix.js',
      'mcp:install': 'node MCP/scripts/install-mcp.js',
      'mcp:install:full': 'node MCP/scripts/install-mcp.js --preset full',
      'mcp:install:core': 'node MCP/scripts/install-mcp.js --preset core',
      'mcp:install:file': 'node MCP/scripts/install-mcp.js --preset file',
      'mcp:install:state': 'node MCP/scripts/install-mcp.js --preset state',
      'mcp:install:secure-core': 'node MCP/scripts/install-mcp.js --preset secure-core',
      'mcp:install:secure-full': 'node MCP/scripts/install-mcp.js --preset secure-full',
      'mcp:uninstall': 'node MCP/scripts/install-mcp.js --uninstall'
    };

  for (const [name, command] of Object.entries(expected)) {
    assert.equal(scripts[name], command, `script mismatch: ${name}`);
  }

  console.log('mcp-package-scripts.test.js passed');
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exit(1);
}

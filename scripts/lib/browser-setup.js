// Copyright (c) 2026 Steve Seguin
// SPDX-License-Identifier: MIT
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline/promises');
const { validateRelayConfig, HttpRelayTransport } = require('./http-relay-transport');
const { BrowserRpcClient } = require('./browser-rpc');

function relaySettings(file) {
  const value = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  return {
    relayUrl: process.env.VDON_MCP_RELAY_URL || value.url,
    relayToken: process.env.VDON_MCP_RELAY_TOKEN || value.token,
    relayKey: process.env.VDON_MCP_RELAY_KEY || value.key
  };
}

function createSetup(directory, options = {}) {
  const ssapp = options.backend === 'ssapp';
  const transport = options.transport || 'webrtc';
  if (!['webrtc', 'http', 'auto'].includes(transport)) throw new Error('Choose webrtc, http, or auto');
  const connection = { room: `${ssapp ? 'ssapp' : 'browser'}_${crypto.randomBytes(12).toString('hex')}`, transport };
  if (transport !== 'webrtc') {
    const relay = relaySettings(options.relayConfig);
    // Each new browser group gets its own room key while reusing the relay service.
    relay.relayKey = crypto.randomBytes(32).toString('hex');
    validateRelayConfig(relay);
    Object.assign(connection, relay);
  }
  const worker = `${ssapp ? 'ssapp' : 'chrome'}_${crypto.randomBytes(6).toString('hex')}`;
  const clients = {};
  const files = [];
  for (const [client, role] of [['agent1', 'controller'], ['agent2', 'controller'], ['viewer', 'observer']]) {
    const key = crypto.randomBytes(32).toString('hex');
    clients[client] = { role, key };
    files.push([`${client}.json`, { worker, client, key, connection, ...(ssapp ? { backend: 'ssapp' } : {}) }]);
  }
  files.push(['worker.json', { worker, clients, connection, ...(ssapp ? { backend: 'ssapp', ssapp: options.ssapp } : {}), ...(options.media ? { media: { enabled: true } } : {}) }]);
  const script = path.resolve(__dirname, '..', ssapp ? 'vdo-mcp-ssapp.js' : 'vdo-mcp-browser.js');
  files.push(['mcp-client.json', { mcpServers: { [ssapp ? 'ninja-ssapp' : 'ninja-browser']: { command: process.execPath, args: [script, '--config', path.resolve(directory, 'agent1.json')] } } }]);
  for (const [name] of files) if (fs.existsSync(path.join(directory, name))) throw new Error(`${name} already exists; choose a new directory`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const [name, value] of files) fs.writeFileSync(path.join(directory, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { directory: path.resolve(directory), transport, worker };
}

async function guidedSetup(directory, options = {}) {
  if (!options.transport && process.stdin.isTTY) {
    const terminal = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      options.transport = (await terminal.question('Connection: webrtc, http, or auto [webrtc]: ')).trim() || 'webrtc';
      if (options.transport !== 'webrtc' && !options.relayConfig && !process.env.VDON_MCP_RELAY_URL) {
        options.relayConfig = (await terminal.question('Private relay JSON file (url, token, key): ')).trim();
      }
      options.media = /^y(es)?$/i.test((await terminal.question('Enable live browser-tab audio/video? [y/N]: ')).trim());
    } finally { terminal.close(); }
  }
  const result = createSetup(directory, options);
  process.stderr.write(`Created private browser configuration in ${result.directory}. Route: ${result.transport}.\n` +
    `Host: vdon-mcp-browser --worker --config "${path.join(result.directory, 'worker.json')}"\n` +
    `Check: vdon-mcp-browser --doctor --config "${path.join(result.directory, 'agent1.json')}"\n` +
    'Give each agent only its own JSON file. mcp-client.json contains the local MCP registration example.\n');
  return result;
}

async function doctor(config, makeSession) {
  const checks = [];
  const transport = config.connection.transport || 'webrtc';
  checks.push({ check: 'configuration', ok: true, worker: config.worker, role: config.clients ? 'host' : 'client', transport });
  if (config.clients) {
    const roots = [config.dependencies || process.cwd(), path.resolve(__dirname, '..', '..')];
    for (const [name, version] of [['chrome-devtools-mcp', '1.11.0'], ['puppeteer-core', '24.37.5']]) {
      try {
        const installed = require(require.resolve(`${name}/package.json`, { paths: roots })).version;
        checks.push({ check: name, ok: installed === version, version: installed, action: installed === version ? undefined : `Install ${name}@${version}` });
      } catch (_) { checks.push({ check: name, ok: false, action: `Install ${name}@${version} in the Ninja MCP folder` }); }
    }
    const [major, minor] = process.versions.node.split('.').map(Number);
    const supportedNode = major >= 23 || major === 22 && minor >= 12 || major === 20 && minor >= 19;
    checks.push({ check: 'host_node', ok: supportedNode,
      version: process.versions.node, action: supportedNode ? undefined : 'Use Node.js 22.12 or later for the Chrome worker' });
    try {
      const puppeteer = require(require.resolve('puppeteer-core', { paths: roots }));
      const executable = config.executable || puppeteer.executablePath('chrome');
      fs.accessSync(executable, fs.constants.X_OK);
      checks.push({ check: 'chrome_executable', ok: true });
    } catch (_) { checks.push({ check: 'chrome_executable', ok: false, action: 'Install Chrome, or set executable to its absolute path in worker.json' }); }
  }
  if (transport !== 'http') {
    try {
      require('./load-vdo-sdk').loadVDONinjaSDK();
      checks.push({ check: 'webrtc_runtime', ok: true });
    } catch (_) { checks.push({ check: 'webrtc_runtime', ok: transport === 'auto', available: false,
      action: transport === 'auto' ? 'HTTP remains available; install optional WebRTC dependencies to enable the direct route' : 'Install optional WebRTC dependencies, or configure HTTP/auto with a relay' }); }
  }
  if (transport !== 'webrtc') {
    let relay;
    try {
      relay = new HttpRelayTransport({ ...config.connection,
        relayUrl: process.env.VDON_MCP_RELAY_URL || config.connection.relayUrl,
        relayToken: process.env.VDON_MCP_RELAY_TOKEN || config.connection.relayToken,
        relayKey: process.env.VDON_MCP_RELAY_KEY || config.connection.relayKey });
      await relay.request('GET', '');
      checks.push({ check: 'relay_access', ok: true, origin: relay.url.origin });
    } catch (error) {
      checks.push({ check: 'relay_access', ok: false, action: error.status === 401 ? 'Check the relay access token' : 'Check relay configuration, HTTPS reachability and /v1/rooms/ proxy routing' });
    } finally { if (relay) relay.disconnect(); }
  }
  if (!config.clients) {
    let session, rpc;
    try {
      session = makeSession(config, false);
      rpc = new BrowserRpcClient(session, config);
      await session.start();
      const hello = await rpc.request('hello', {}, 12000);
      if (hello.error) throw new Error(hello.error);
      checks.push({ check: 'authenticated_worker', ok: true, role: hello.role, route: hello.route || transport });
      rpc.boot = hello.boot;
      const tabs = await rpc.request('tabs', {}, 12000);
      checks.push({ check: 'browser_tools', ok: !tabs.error && !tabs.result?.isError,
        action: tabs.error || tabs.result?.isError ? 'Restart the browser worker and inspect its host diagnostics' : undefined });
    } catch (_) {
      checks.push({ check: 'authenticated_worker', ok: false,
        action: 'Start the host with its matching worker.json. Check room, worker ID, per-agent key, and at least one shared route. Relay access alone does not prove worker access.' });
    } finally { if (rpc) rpc.close(); if (session) await session.stop(); }
  }
  return { ok: checks.every((check) => check.ok), checks };
}

module.exports = { relaySettings, createSetup, guidedSetup, doctor };

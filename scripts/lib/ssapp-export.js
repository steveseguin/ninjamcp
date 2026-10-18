// Copyright (c) 2026 Steve Seguin
// SPDX-License-Identifier: MIT
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Only reads opaque exports through the authenticated worker; never reads host paths.
async function saveSettingsExport(client, args) {
  if (!args || Object.keys(args).some(key => !['artifactId', 'destination'].includes(key))
    || !/^export_[a-f0-9]{32}$/.test(args.artifactId || '') || typeof args.destination !== 'string'
    || !path.isAbsolute(args.destination) || args.destination.includes('\0')) throw new Error('Provide artifactId and an absolute destination on the agent computer.');
  const read = async (offset, length) => {
    const response = await client.call('ssapp_read_settings_export', { artifactId: args.artifactId, offset, length });
    if (response.error || response.result?.isError) throw Object.assign(new Error('Settings export read failed.'), { code: response.error || response.result?.structuredContent?.error?.code });
    const payload = response.result?.structuredContent?.result?.payload;
    if (!payload || payload.artifactId !== args.artifactId) throw new Error('Invalid settings export response.');
    return payload;
  };
  const info = await read(0, 0);
  if (!Number.isInteger(info.size) || info.size < 1 || info.size > 8 * 1024 * 1024
    || !/^[a-f0-9]{64}$/.test(info.sha256)) throw new Error('Invalid settings export metadata.');
  const destination = path.resolve(args.destination);
  const temporary = path.join(path.dirname(destination), '.ssapp-export-' + crypto.randomBytes(16).toString('hex') + '.part');
  let file;
  try {
    // Finish and verify a private sibling file before publishing it. link() refuses
    // to replace an existing destination, including one created during transfer.
    file = await fs.promises.open(temporary, 'wx', 0o600);
    const hash = crypto.createHash('sha256');
    let offset = 0;
    while (offset < info.size) {
      const chunk = await read(offset, Math.min(256 * 1024, info.size - offset));
      if (typeof chunk.dataBase64 !== 'string' || chunk.dataBase64.length > 350000) throw new Error('Invalid export chunk.');
      const bytes = Buffer.from(chunk.dataBase64, 'base64');
      if (!bytes.length || bytes.toString('base64') !== chunk.dataBase64 || chunk.offset !== offset
        || chunk.nextOffset !== offset + bytes.length || chunk.nextOffset > info.size
        || chunk.size !== info.size || chunk.sha256 !== info.sha256 || chunk.eof !== (chunk.nextOffset === info.size)) throw new Error('Export changed or returned an invalid chunk.');
      await file.writeFile(bytes);
      hash.update(bytes);
      offset = chunk.nextOffset;
    }
    if (hash.digest('hex') !== info.sha256) throw new Error('Settings export checksum mismatch.');
    await file.sync();
    await file.close(); file = null;
    await fs.promises.link(temporary, destination);
    return { saved: true, destination, artifactId: info.artifactId, size: info.size, sha256: info.sha256 };
  } finally {
    if (file) await file.close().catch(() => {});
    await fs.promises.unlink(temporary).catch(() => {});
  }
}

module.exports = { saveSettingsExport };

// Copyright (c) 2026 Steve Seguin
// SPDX-License-Identifier: MIT
'use strict';

const crypto = require('node:crypto');
const http = require('node:http');

// Capture only the worker's initial tab. The publisher lives in another browser
// context and is excluded from remote tools; no desktop or microphone capture.
async function startBrowserMedia(browser, target, title, config = {}) {
  const token = crypto.randomBytes(24).toString('hex');
  const server = http.createServer((req, res) => {
    if (req.url !== `/${token}`) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end('<!doctype html><title>Ninja browser media publisher</title>');
  });
  let context, page, previousTitle;
  const credentials = {
    room: `media_${crypto.randomBytes(12).toString('hex')}`,
    streamID: `chrome_${crypto.randomBytes(12).toString('hex')}`,
    password: crypto.randomBytes(24).toString('hex')
  };
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    context = await browser.createBrowserContext();
    previousTitle = await target.title();
    await target.evaluate((value) => { document.title = value; }, title);
    page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/${token}`);
    // Close the bootstrap listener immediately. No web control endpoint remains.
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    await page.addScriptTag({ path: require.resolve('@vdoninja/sdk/browser') });
    await page.evaluate(async (settings) => {
      const stream = await Promise.race([
        navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15, width: { max: 1280 }, height: { max: 720 } }, audio: true, selfBrowserSurface: 'exclude' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Tab capture timed out')), 15000))
      ]);
      if (stream.getVideoTracks().some((track) => track.getSettings().displaySurface !== 'browser')) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error('Expected tab capture');
      }
      window.ninjaCapture = stream;
      window.ninjaMedia = new VDONinjaSDK({ password: settings.password, ...(settings.host ? { host: settings.host } : {}) });
      await Promise.race([
        (async () => {
          await window.ninjaMedia.connect();
          await window.ninjaMedia.publish(stream, { room: settings.room, streamID: settings.streamID, password: settings.password, label: 'Ninja browser', media: { video: { maxBitrate: 1500000 }, audio: { maxBitrate: 64000 } } });
        })(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Media signaling timed out')), 15000))
      ]);
    }, { ...credentials, host: config.host });
    await target.evaluate((value) => { document.title = value; }, previousTitle);
    const viewer = new URL('https://vdo.ninja/');
    viewer.searchParams.set('view', credentials.streamID);
    viewer.searchParams.set('room', credentials.room);
    viewer.searchParams.set('password', credentials.password);
    viewer.searchParams.set('cleanoutput', '');
    return {
      page,
      status: async () => ({ enabled: true, transport: 'webrtc', stream_id: credentials.streamID, room: credentials.room,
        password: credentials.password, ...(config.host ? { signaling_host: config.host } : { viewer_url: viewer.href }),
        ...await page.evaluate(() => ({ connected: !!window.ninjaMedia.state.connected,
          tracks: window.ninjaCapture.getTracks().map((track) => ({ kind: track.kind, state: track.readyState, muted: track.muted })) })) }),
      close: async () => {
        try { await page.evaluate(async () => { window.ninjaCapture.getTracks().forEach((track) => track.stop()); await window.ninjaMedia.disconnect(); }); } catch (_) { /* Browser may already be closed. */ }
        await context.close();
      }
    };
  } catch (error) {
    server.close();
    server.closeAllConnections();
    if (context) await context.close();
    throw error;
  } finally {
    if (previousTitle !== undefined) await target.evaluate((value) => { document.title = value; }, previousTitle).catch(() => {});
  }
}

module.exports = { startBrowserMedia };

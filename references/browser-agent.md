# Talk to an agent while sharing a browser

[Read this guide in HTML](https://steveseguin.github.io/ninjamcp/browser-agent.html)

The browser companion lets you speak or type to an OpenAI Realtime agent, share selected views of your remote Chrome tab, and let it use the browser tools. You can also watch and hear the tab through VDO.Ninja. The browser host can be on another computer; the companion runs locally beside your microphone and speakers.

## Start a conversation

First [start a browser worker](browser-worker.md) and copy one controller credential file to your computer. Use a separate credential for each agent or companion running at the same time.

Set `OPENAI_API_KEY` in the local companion process, then launch:

```sh
npx vdon-mcp-browser-agent --config /private/agent1.json
```

From a checkout, run `node scripts/vdo-mcp-browser-agent.js --config /private/agent1.json`. Open the private loopback URL printed in the terminal on that same computer. Keep the terminal running. The API key stays in the local server process; it is not sent to the remote browser host or the operator page.

1. Select **Check worker** to confirm authenticated access.
2. Select **Start agent**, then choose **Share my microphone** to speak. You can also type a message.
3. Enable **Share browser frames** when you want the agent to see the tab. Frames update about every three seconds; the agent can also read page snapshots.
4. Enable **Allow browser control** when you want the agent to navigate, click, or type. This also enables browser sharing. The worker's controller role and tab lease still apply.

The default model is `gpt-realtime-2.1`. Set `VDON_BROWSER_MODEL` to select another Realtime model that supports audio, images, and function calls. Model usage is billed to your OpenAI account. Each conversation ends after 15 minutes; start a new one to continue.

## Control what is shared

| Control | Effect |
| --- | --- |
| Share my microphone | Sends microphone audio to OpenAI while the agent session is connected. Turning it off stops microphone capture and clears pending input audio. |
| Share browser frames | Sends browser images and requested page content to OpenAI. Turning it off stops new image and tool requests and releases held control. Content already sent remains part of that model conversation. |
| Allow browser control | Allows the agent to claim the shared tab and use input tools. Turning it off releases held leases and prevents queued control requests from starting. |
| Interrupt | Stops queued speech and agent actions. An action already sent to the worker may finish; inspect its result before repeating it. |
| End session | Closes the model connection, stops microphone capture and frame sharing, and releases held control. |

The sharing indicator identifies the selected inputs and OpenAI as their recipient. The application does not record locally. OpenAI processes the microphone audio, selected browser images, typed messages, and tool results sent during the session. The voice you hear is AI generated.

Other authorized observers can still see the worker's tab. To revoke another controller, use `revoke 1` in the host terminal. Stop the worker to close the browser and end access for everyone.

## Watch the browser

Enable `"media": { "enabled": true }` in the host's `worker.json`, or add `--media` during setup. Select **Watch live browser** in the companion and **Hear browser audio** to unmute. This uses the SDK stream directly and does not require an OpenAI key. Watching alone does not share that stream with the model.

The model receives selected browser frames and your shared microphone; captured tab audio is for the human viewer. Live viewing requires WebRTC. With an HTTP connection, keep using text, microphone conversation, page snapshots, screenshots, and browser controls even when the live view cannot connect. The companion's connection to OpenAI uses an outbound secure WebSocket.

## Resolve connection problems

- If **Check worker** fails, run `vdon-mcp-browser --doctor --config /private/agent1.json`. Confirm that the host is running with matching credentials and a common route.
- If the model will not connect, set the API key in the companion process, check model access, and restart the companion. Viewing and worker diagnostics remain available without a key.
- If another agent holds the tab, let it release control or wait for its lease to expire. Sharing a browser does not bypass that ownership.
- If a tool reports an uncertain outcome, have the agent use `browser_result` and inspect the page before repeating an action. A returned tool result and completion of your requested task are separate outcomes.

The page accepts one local operator connection. Reopen the original private URL after a reload or disconnect; its access token is removed from the address bar after connection. Keep that URL and the agent credential file private.

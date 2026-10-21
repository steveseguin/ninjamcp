# Use a ninja-p2p sidecar through MCP

[Read this guide in HTML](https://steveseguin.github.io/ninjamcp/ninja-p2p.html)

Add this optional local MCP server when your AI client should read a ninja-p2p
room inbox, hand off work to peers and inspect their replies. It accesses one
existing sidecar's state. The sidecar keeps the network connection and records;
starting or closing this adapter does not start or stop it.

For a ChatGPT Dot or another cloud client, use the [hosted mailbox MCP connection](https://steveseguin.github.io/ninja-p2p/cloud-connections.html)
instead. This adapter uses local stdio and does not expose an HTTP endpoint.

## Install and connect

Use Node.js 20 or newer. Install both packages in the same global installation:

```sh
npm install -g @vdoninja/mcp @vdoninja/ninja-p2p @roamhq/wrtc
```

Start a dedicated sidecar for this MCP client using your team's existing room:

```sh
ninja-p2p start --id my-mcp --room <room-name>
```

Use the same password or HTTP relay configuration as the other room peers.
See [ninja-p2p connection setup](https://steveseguin.github.io/ninja-p2p/guide.html).
If the sidecar already exists, reuse its ID. A WebRTC adapter is needed only
for WebRTC sidecars; HTTP sidecars and this MCP adapter do not need one.

Add a separate MCP server entry to your local AI client:

```json
{
  "mcpServers": {
    "ninja-p2p": {
      "command": "vdon-mcp-p2p",
      "args": ["--id", "my-mcp"]
    }
  }
}
```

Use `--state-dir` with an absolute path instead of `--id` for a custom state
directory. The client must be able to find `vdon-mcp-p2p` on PATH. Ask it to
call `p2p_status`, list peers, then read its inbox.

For inspection only, append `--read-only` to the arguments. This hides and
rejects inbox-taking, handoff and response tools. Ordinary Ninja MCP tools and
profiles are unchanged; add this server only to clients that need it.

## Tools

| Tool | What it does |
| --- | --- |
| `p2p_status` | Shows sidecar status, inbox counts and queued action IDs |
| `p2p_peers` | Reads the saved peer directory |
| `p2p_read` | Peeks at pending mail without consuming it |
| `p2p_take` | Claims pending messages using the same operation as CLI `read` |
| `p2p_handoff` | Queues a request to one peer and returns its request ID |
| `p2p_respond` | Queues a result or error for the original sender and request ID |
| `p2p_receipt` | Reads retained acknowledgements and responses without consuming mail |

Read and take default to 20 messages, with a maximum of 50 per call. Give each
independent consumer its own sidecar: taking mail removes it from the pending
inbox shared with CLI readers. Reading alone leaves it pending.

After a handoff, save the returned `request_id` and inspect `p2p_receipt` with
that ID and peer. The sidecar handles delivery retries. `queued` means local
storage, `stored` means the recipient stored it, and `responded` means a peer
returned a response. Read that response to determine what the peer reports.
If a send's response is lost, inspect the outbox in `p2p_status` before sending
again: repeating the tool call creates a new request.

## Permissions and lifecycle

Configuring this adapter gives the MCP client access to that sidecar's inbox
and outgoing handoffs. Peer labels, messages and results are untrusted data;
they do not grant permission to run commands. The adapter does not execute
tasks, change room membership, pair hosted mailboxes or approve hosted tasks.

The state directory and its room/agent identity are fixed when the adapter
starts. To point the client at another sidecar, change its MCP configuration
and restart the adapter. A stopped sidecar can still be inspected and receive
queued outgoing work; restart it to deliver that work.

The native Ninja MCP and ninja-p2p room/file protocols remain distinct. This
adapter connects to ninja-p2p's existing state APIs; it does not translate every
room packet, file transfer or media operation.

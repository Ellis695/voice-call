# Voice Call

Two-person browser voice calling with:

- WebRTC peer-to-peer audio
- Cloudflare Durable Objects for real-time signaling
- Cloudflare managed STUN/TURN for connectivity across different networks
- Shareable call links
- Mute, hang up, timer, and microphone level
- No accounts, contacts, call history, profiles, or notification system

GitHub Pages hosts the frontend. The Cloudflare Worker supplies signaling and short-lived TURN credentials. GitHub Pages itself is static hosting and cannot run the signaling server.

## 1. Create the Cloudflare TURN key

Create a TURN key in the Cloudflare dashboard under Realtime → TURN.

The Worker must keep the long-lived TURN key secret and generate short-lived credentials for browsers. Cloudflare's TURN service generates short-lived ICE credentials for browsers.

## 2. Deploy the signaling Worker

On your computer:

```cmd
cd Desktop
git clone https://github.com/Ellis695/voice-call.git
cd voice-call\worker
npm install
npx wrangler login
```

Add the two Cloudflare secrets:

```cmd
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_KEY_API_TOKEN
```

Wrangler stores Worker secrets separately from the source code; do not put these values into `config.js`, GitHub, or any browser code.

Deploy:

```cmd
npm run deploy
```

Cloudflare will give you a Worker URL similar to:

```
https://voice-call-signal.example.workers.dev
```

The Worker contains:

- `/ws` — WebSocket signaling
- `/ice` — short-lived STUN/TURN credentials
- `/health` — health check

The signaling WebSocket uses a Durable Object room so each call has one coordination point for its two participants. Cloudflare recommends the hibernating WebSocket API for this kind of long-lived signaling connection.

## 3. Connect the GitHub Pages frontend

Open the repository's `config.js`:

```js
window.VOICE_CALL_CONFIG = {
  SIGNAL_BASE: "https://voice-call-signal.example.workers.dev"
};
```

Replace the example URL with the actual Worker URL you received.

Commit and push that change.

Your normal frontend remains:

```
https://ellis695.github.io/voice-call/
```

## 4. How calling works now

Caller:

1. Taps **Start a call**.
2. The app creates a random private room.
3. A shareable call link is generated.
4. The caller sends that link to the other person.
5. WebRTC offer/ICE candidates are exchanged automatically through the Worker.
6. The two browsers attempt a direct WebRTC connection.
7. If a direct path cannot be established, TURN relays the audio.

Joiner:

1. Opens the shared link.
2. Taps **Join call**.
3. Grants microphone access.
4. The answer and ICE candidates are exchanged automatically.
5. The call enters the live screen once WebRTC connects.

No manual invite/reply codes are needed.

## 5. Important

The repository now contains the complete application code, but the Cloudflare Worker cannot be deployed into another person's Cloudflare account automatically. The only account-specific pieces are:

- your Cloudflare Worker deployment
- your TURN key ID
- your TURN API token
- the resulting Worker URL in `config.js`

The TURN credentials are generated for short lifetimes rather than exposing the long-lived TURN key to browsers.

For small personal testing, Cloudflare currently documents a 1,000 GB monthly free allowance for Realtime TURN before usage charges; TURN usage beyond the included allowance is usage-based.

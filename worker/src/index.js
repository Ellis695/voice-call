import { DurableObject } from "cloudflare:workers";

const ALLOWED_ORIGIN = "*";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
          "Access-Control-Allow-Methods": "GET,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }

    if (url.pathname === "/health") {
      return json({ ok: true, service: "voice-call-signal" });
    }

    if (url.pathname === "/ice") {
      if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
        return json({
          error: "TURN is not configured on the signaling worker."
        }, 503);
      }

      const response = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.TURN_KEY_API_TOKEN}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ ttl: 3600 })
        }
      );

      if (!response.ok) {
        const detail = await response.text();
        return json({
          error: "TURN credential request failed.",
          detail
        }, 502);
      }

      const data = await response.json();
      return json(data);
    }

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("WebSocket upgrade required.", { status: 426 });
      }

      const room = url.searchParams.get("room")?.trim();
      const role = url.searchParams.get("role")?.trim();

      if (!room || !/^[A-Za-z0-9_-]{16,80}$/.test(room)) {
        return new Response("Invalid room.", { status: 400 });
      }

      if (role !== "caller" && role !== "joiner") {
        return new Response("Invalid role.", { status: 400 });
      }

      const id = env.CALL_ROOM.idFromName(room);
      return env.CALL_ROOM.get(id).fetch(request);
    }

    return json({
      ok: true,
      service: "voice-call-signal",
      endpoints: ["/health", "/ice", "/ws"]
    });
  }
};

export class CallRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sessions = new Map();

    for (const ws of this.ctx.getWebSockets()) {
      const state = ws.deserializeAttachment();
      if (state?.role) {
        this.sessions.set(ws, state);
      }
    }

    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong")
    );
  }

  async fetch(request) {
    const url = new URL(request.url);
    const role = url.searchParams.get("role");

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required.", { status: 426 });
    }

    if (role !== "caller" && role !== "joiner") {
      return new Response("Invalid role.", { status: 400 });
    }

    const existing = [...this.sessions.values()];
    if (existing.some(s => s.role === role)) {
      return new Response("That role is already connected to this call.", {
        status: 409
      });
    }

    if (existing.length >= 2) {
      return new Response("This call already has two participants.", {
        status: 409
      });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    const state = {
      role,
      connectedAt: Date.now()
    };
    server.serializeAttachment(state);
    this.sessions.set(server, state);

    const peerRole = role === "caller" ? "joiner" : "caller";

    server.send(JSON.stringify({
      type: "connected",
      role
    }));

    if (this.hasRole(peerRole)) {
      server.send(JSON.stringify({ type: "peer-present" }));
    }

    if (role === "joiner") {
      const offer = await this.ctx.storage.get("offer");
      if (offer) {
        server.send(JSON.stringify({
          type: "offer",
          offer
        }));
      }

      const callerCandidates =
        (await this.ctx.storage.get("callerCandidates")) || [];
      for (const candidate of callerCandidates) {
        server.send(JSON.stringify({
          type: "candidate",
          candidate
        }));
      }
    }

    if (role === "caller") {
      const answer = await this.ctx.storage.get("answer");
      if (answer) {
        server.send(JSON.stringify({
          type: "answer",
          answer
        }));
      }

      const joinerCandidates =
        (await this.ctx.storage.get("joinerCandidates")) || [];
      for (const candidate of joinerCandidates) {
        server.send(JSON.stringify({
          type: "candidate",
          candidate
        }));
      }
    }

    this.broadcast({
      type: "peer-state",
      connected: this.sessions.size === 2
    }, server);

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  hasRole(role) {
    for (const state of this.sessions.values()) {
      if (state.role === role) return true;
    }
    return false;
  }

  getPeer(ws) {
    const state = this.sessions.get(ws);
    if (!state) return null;

    for (const [other, otherState] of this.sessions) {
      if (other !== ws && otherState.role !== state.role) {
        return other;
      }
    }

    return null;
  }

  broadcast(message, except = null) {
    const encoded = JSON.stringify(message);

    for (const ws of this.sessions.keys()) {
      if (ws !== except && ws.readyState === WebSocket.OPEN) {
        ws.send(encoded);
      }
    }
  }

  async saveCandidate(role, candidate) {
    const key = role === "caller"
      ? "callerCandidates"
      : "joinerCandidates";

    const candidates = (await this.ctx.storage.get(key)) || [];

    if (candidates.length >= 100) return;

    candidates.push(candidate);
    await this.ctx.storage.put(key, candidates);
  }

  async webSocketMessage(ws, message) {
    let data;

    try {
      data = JSON.parse(
        typeof message === "string"
          ? message
          : new TextDecoder().decode(message)
      );
    } catch {
      return;
    }

    const state = this.sessions.get(ws);
    if (!state) return;

    if (data.type === "offer" && state.role === "caller" && data.offer) {
      await this.ctx.storage.put("offer", data.offer);
      const peer = this.getPeer(ws);
      if (peer?.readyState === WebSocket.OPEN) {
        peer.send(JSON.stringify({
          type: "offer",
          offer: data.offer
        }));
      }
      return;
    }

    if (data.type === "answer" && state.role === "joiner" && data.answer) {
      await this.ctx.storage.put("answer", data.answer);
      const peer = this.getPeer(ws);
      if (peer?.readyState === WebSocket.OPEN) {
        peer.send(JSON.stringify({
          type: "answer",
          answer: data.answer
        }));
      }
      return;
    }

    if (data.type === "candidate" && data.candidate) {
      await this.saveCandidate(state.role, data.candidate);

      const peer = this.getPeer(ws);
      if (peer?.readyState === WebSocket.OPEN) {
        peer.send(JSON.stringify({
          type: "candidate",
          candidate: data.candidate
        }));
      }
      return;
    }

    if (data.type === "hangup") {
      this.broadcast({ type: "hangup" }, ws);
      await this.ctx.storage.deleteAll();
      return;
    }
  }

  async webSocketClose(ws) {
    const state = this.sessions.get(ws);
    this.sessions.delete(ws);

    this.broadcast({
      type: "peer-left"
    }, ws);

    if (this.sessions.size === 0) {
      await this.ctx.storage.deleteAll();
    } else if (state) {
      await this.ctx.storage.deleteAll();
    }
  }

  async webSocketError(ws) {
    this.sessions.delete(ws);
  }
}

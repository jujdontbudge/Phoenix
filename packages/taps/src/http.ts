import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createSecureServer, type ServerOptions as TlsOptions } from "node:https";
import type { TLSSocket } from "node:tls";
import { HTTP_STREAM, decodeHttpHead, encodeJson, decodeJson, type HttpRequest } from "@phoenix/wire";
import { frame, writeBytes, type Backend } from "./ports.ts";

export interface HttpRoute { surface: "mcp" | "http"; connector: string; meta?: unknown }
export interface HttpTapOptions {
  backend: Backend;
  route(request: HttpRequest, mode: "reverse" | "forward" | "transparent"): HttpRoute;
  mode?: "reverse" | "forward" | "transparent";
  tls?: TlsOptions;
}

export function httpHandler(options: HttpTapOptions, authority?: string): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    void (async () => {
      const socket = request.socket as TLSSocket;
      const head: HttpRequest = { method: request.method!, url: request.url!, headers: request.rawHeaders, httpVersion: request.httpVersion, scheme: socket.encrypted ? "https" : "http", ...(authority ? { authority } : {}) };
      const route = options.route(head, options.mode ?? "reverse");
      const link = options.backend.open({ surface: route.surface, connector: route.connector, meta: { transport: "http", mode: options.mode ?? "reverse", request: head, details: route.meta } });
      const abort = (): void => { if (!response.writableFinished) link.abort("HTTP client disconnected"); };
      response.once("close", abort);
      const input = (async () => {
        for await (const bytes of request) await link.write(frame("out", HTTP_STREAM.requestBody, bytes, false));
        if (request.rawTrailers.length) await link.write(frame("out", HTTP_STREAM.requestTrailers, encodeJson(request.rawTrailers), true));
        await link.write(frame("out", HTTP_STREAM.requestBody, new Uint8Array(), true));
      })();
      const output = (async () => {
        let headed = false;
        for await (const f of link.frames()) {
          if (f.dir !== "back") throw new Error("Backend returned an outbound HTTP frame");
          if (f.stream === HTTP_STREAM.responseHead) {
            if (headed) throw new Error("Backend returned duplicate HTTP headers");
            const head = decodeHttpHead(f.bytes);
            if (head.status < 200) {
              if (head.status === 100) response.writeContinue();
              else if (head.status === 103) response.writeEarlyHints(Object.fromEntries(Array.from({ length: head.headers.length / 2 }, (_, i) => [head.headers[i * 2]!, head.headers[i * 2 + 1]!])));
              else response.writeProcessing();
              continue;
            }
            response.sendDate = false;
            response.writeHead(head.status, head.statusMessage, [...head.headers]);
            response.flushHeaders();
            headed = true;
          } else if (f.stream === HTTP_STREAM.responseBody) {
            if (!headed) throw new Error("Backend returned an HTTP body before its headers");
            if (f.bytes.length) await writeBytes(response, f.bytes);
            if (f.last) { response.end(); return; }
          } else if (f.stream === HTTP_STREAM.responseTrailers) {
            const decoded = decodeJson(f.bytes);
            if (!decoded.ok || !Array.isArray(decoded.value) || !decoded.value.every(h => typeof h === "string") || decoded.value.length % 2) throw new Error("Invalid HTTP trailers from Backend");
            const trailers = decoded.value as string[];
            response.addTrailers(Array.from({ length: trailers.length / 2 }, (_, i) => [trailers[i * 2]!, trailers[i * 2 + 1]!] as [string, string]));
          } else throw new Error("Backend returned an unknown HTTP stream");
        }
        throw new Error("HTTP Backend closed mid-response");
      })();
      try { await Promise.all([input, output]); }
      catch { link.abort("HTTP relay aborted"); response.destroy(); request.destroy(); }
      finally { response.off("close", abort); }
    })().catch(() => { response.destroy(); request.destroy(); });
  };
}

export function httpTap(options: HttpTapOptions): Server {
  const handler = httpHandler(options);
  const server = options.tls && options.mode !== "forward" ? createSecureServer(options.tls, handler) : createServer(handler);
  server.on("checkContinue", handler);
  server.on("checkExpectation", handler);
  if (options.mode === "forward" && options.tls) {
    server.on("connect", (request, socket, head) => {
      const tunnelHandler = httpHandler(options, request.url);
      const secure = createSecureServer(options.tls!, tunnelHandler);
      secure.on("checkContinue", tunnelHandler);
      secure.on("checkExpectation", tunnelHandler);
      secure.on("tlsClientError", (_error, socket) => socket.destroy());
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n", () => {
        if (head.length) socket.unshift(head);
        secure.emit("connection", socket);
      });
      socket.on("error", () => socket.destroy());
    });
  }
  return server;
}

export function mcpHttpTap(options: { backend: Backend; connector: string }): Server {
  return httpTap({ backend: options.backend, route: () => ({ surface: "mcp", connector: options.connector }) });
}

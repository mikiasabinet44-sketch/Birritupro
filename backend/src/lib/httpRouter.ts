// Minimal, dependency-free HTTP routing layer (stands in for Express) built
// on Node's built-in http module, so the whole backend needs zero npm
// installs. Supports :params in paths and an express-ish req/res surface
// for the route handlers (req.params, req.query, req.body, req.header();
// res.status().json(), res.end()).
import type { IncomingMessage, ServerResponse } from "node:http";

export interface AppRequest {
  method: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
  raw: IncomingMessage;
  header(name: string): string | undefined;
}

export interface AppResponse {
  status(code: number): AppResponse;
  json(body: unknown): void;
  end(): void;
  raw: ServerResponse;
}

export type Handler = (req: AppRequest, res: AppResponse) => void | Promise<void>;

/** Throw from any handler (even inside a DB transaction, which then rolls back) to return a specific HTTP status. */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

interface Route {
  method: string;
  segments: string[]; // path split by '/', ':x' = param
  handler: Handler;
}

export class Router {
  routes: Route[] = [];
  private add(method: string, path: string, handler: Handler) {
    const segments = path.split("/").filter(Boolean);
    this.routes.push({ method, segments, handler });
  }
  get(path: string, handler: Handler) { this.add("GET", path, handler); }
  post(path: string, handler: Handler) { this.add("POST", path, handler); }
  patch(path: string, handler: Handler) { this.add("PATCH", path, handler); }
  delete(path: string, handler: Handler) { this.add("DELETE", path, handler); }
}

export function createRouter() {
  return new Router();
}

export function matchRoute(router: Router, method: string, pathSegments: string[]): { handler: Handler; params: Record<string, string> } | null {
  for (const route of router.routes) {
    if (route.method !== method) continue;
    if (route.segments.length !== pathSegments.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < route.segments.length; i++) {
      const rs = route.segments[i];
      const ps = pathSegments[i];
      if (rs.startsWith(":")) {
        params[rs.slice(1)] = decodeURIComponent(ps);
      } else if (rs !== ps) {
        ok = false;
        break;
      }
    }
    if (ok) return { handler: route.handler, params };
  }
  return null;
}

export function makeResponse(res: ServerResponse): AppResponse {
  let statusCode = 200;
  const api: AppResponse = {
    status(code: number) {
      statusCode = code;
      return api;
    },
    json(body: unknown) {
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    },
    end() {
      res.writeHead(statusCode);
      res.end();
    },
    raw: res,
  };
  return api;
}

import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import { createCorsMiddleware } from "./cors.middleware";

const request = (origin: string, method = "OPTIONS", configuredOrigins?: string) => {
  const headers = new Map<string, string>();
  let ended = false;
  let continued = false;
  const response = {
    statusCode: 200,
    setHeader(name: string, value: string) { headers.set(name.toLowerCase(), value); },
    getHeader(name: string) { return headers.get(name.toLowerCase()); },
    end() { ended = true; },
  };
  createCorsMiddleware(configuredOrigins)({
    method,
    url: "/api/auth/login",
    headers: {
      origin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type,authorization",
    },
  } as Request, response as unknown as Response, (error?: unknown) => {
    assert.ifError(error);
    continued = true;
  });
  return { headers, response, ended, continued };
};

test("login preflight accepts the configured frontend with cookies and JSON headers", () => {
  const result = request("http://localhost:5173", "OPTIONS", "http://localhost:5173");
  assert.equal(result.response.statusCode, 204);
  assert.equal(result.headers.get("access-control-allow-origin"), "http://localhost:5173");
  assert.equal(result.headers.get("access-control-allow-credentials"), "true");
  assert.equal(result.headers.get("access-control-allow-headers"), "content-type,authorization");
  assert.ok(result.headers.get("access-control-allow-methods")?.includes("POST"));
  assert.ok(result.headers.get("vary")?.includes("Origin"));
  assert.equal(result.ended, true);
  assert.equal(result.continued, false);
});

test("actual login responses keep credentialed CORS headers before route handling", () => {
  const result = request("http://localhost:5173", "POST", "http://localhost:5173");
  assert.equal(result.headers.get("access-control-allow-origin"), "http://localhost:5173");
  assert.equal(result.headers.get("access-control-allow-credentials"), "true");
  assert.equal(result.continued, true);
});

test("configured origin lists trim whitespace and match origins exactly", () => {
  const origins = " http://localhost:5173 , https://app.example.com , ";
  assert.equal(request("https://app.example.com", "OPTIONS", origins).headers.get("access-control-allow-origin"), "https://app.example.com");
  assert.equal(request("http://localhost:5173.attacker.example", "OPTIONS", origins).headers.has("access-control-allow-origin"), false);
  assert.equal(request("http://localhost:5174", "OPTIONS", origins).headers.has("access-control-allow-origin"), false);
});

test("the development default accepts localhost:5173 when CORS_ORIGIN is absent", (t) => {
  const previous = process.env.CORS_ORIGIN;
  delete process.env.CORS_ORIGIN;
  t.after(() => {
    if (previous === undefined) delete process.env.CORS_ORIGIN;
    else process.env.CORS_ORIGIN = previous;
  });
  assert.equal(request("http://localhost:5173").headers.get("access-control-allow-origin"), "http://localhost:5173");
});

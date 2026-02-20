import { normalizeHeaderMap, verifyGuardianAuthorization } from "./auth";
import { resolveGuardianLogTail } from "./log-tail";
import { renderGuardianMobilePage } from "./mobile-page";
import type { GuardianStatusSnapshot } from "./status-snapshot";
import type { GuardianConfig, LogEntry } from "./types";

export async function handleGuardianControlRequest(input: {
  request: Request;
  config: GuardianConfig;
  nonceExpirations: Map<string, number>;
  logs: LogEntry[];
  statusSnapshot: () => GuardianStatusSnapshot;
  restartWorker: () => Promise<boolean>;
  stopWorker: () => Promise<void>;
  startWorker: () => Promise<boolean>;
}): Promise<Response> {
  const { request } = input;
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/healthz") {
    return Response.json({
      ok: true,
      service: "guardian",
      ts: Date.now(),
    });
  }

  const queryToken = url.searchParams.get("token") ?? url.searchParams.get("k");
  const body = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
  const headers = normalizeHeaderMap(request.headers);
  const auth = verifyGuardianAuthorization({
    method: request.method,
    path: url.pathname,
    body,
    headers,
    queryToken,
    secret: input.config.controlSecret,
    nowMs: Date.now(),
    nonceExpirations: input.nonceExpirations,
    maxSkewMs: input.config.signatureMaxSkewMs,
    nonceTtlMs: input.config.signatureNonceTtlMs,
  });
  if (!auth.ok) {
    return Response.json(
      {
        ok: false,
        error: auth.reason,
      },
      {
        status: 401,
      },
    );
  }
  if (request.method === "GET" && url.pathname === "/mobile") {
    return new Response(
      renderGuardianMobilePage({
        status: input.statusSnapshot(),
        token: input.config.controlSecret,
      }),
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
      },
    );
  }
  const isFormPost = request.headers.get("content-type")?.includes("application/x-www-form-urlencoded");
  const shouldRedirectToMobile = request.method === "POST" && isFormPost && Boolean(queryToken);
  const mobileLocation = `/mobile?token=${encodeURIComponent(queryToken ?? "")}`;

  if (request.method === "GET" && url.pathname === "/status") {
    return Response.json(input.statusSnapshot());
  }
  if (request.method === "POST" && url.pathname === "/restart") {
    const restarted = await input.restartWorker();
    if (shouldRedirectToMobile) {
      return Response.redirect(mobileLocation, 303);
    }
    return Response.json({
      ...input.statusSnapshot(),
      restarted,
    });
  }
  if (request.method === "POST" && url.pathname === "/stop") {
    await input.stopWorker();
    if (shouldRedirectToMobile) {
      return Response.redirect(mobileLocation, 303);
    }
    return Response.json(input.statusSnapshot());
  }
  if (request.method === "POST" && url.pathname === "/start") {
    const started = await input.startWorker();
    if (shouldRedirectToMobile) {
      return Response.redirect(mobileLocation, 303);
    }
    return Response.json({
      ...input.statusSnapshot(),
      started,
    });
  }
  if (request.method === "GET" && url.pathname === "/logs") {
    const safeTail = resolveGuardianLogTail({
      tailRaw: url.searchParams.get("tail"),
      maxTail: input.config.logTailLimit,
    });
    return Response.json({
      ok: true,
      logs: input.logs.slice(-safeTail),
    });
  }
  return Response.json(
    {
      ok: false,
      error: "Not found.",
    },
    {
      status: 404,
    },
  );
}

import { escapeHtml } from "./config";
import type { GuardianStatusSnapshot } from "./status-snapshot";

export function renderGuardianMobilePage(input: {
  status: GuardianStatusSnapshot;
  token: string;
}): string {
  const tokenParam = encodeURIComponent(input.token);
  const workerStatus = input.status.worker.running ? "Running" : "Stopped";
  const heartbeatAge =
    typeof input.status.worker.heartbeatAgeMs === "number"
      ? `${Math.round(input.status.worker.heartbeatAgeMs / 1000)}s`
      : "unknown";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Guardian Control</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; margin: 16px; line-height: 1.4; }
    h1 { margin: 0 0 12px; font-size: 1.2rem; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0; }
    button { font-size: 1rem; padding: 10px 14px; border-radius: 10px; border: 1px solid #333; background: #fff; }
    pre { white-space: pre-wrap; background: #f7f7f7; border-radius: 10px; padding: 12px; font-size: 0.85rem; }
    .meta { color: #444; font-size: 0.92rem; }
  </style>
</head>
<body>
  <h1>Claude on Discord Guardian</h1>
  <div class="meta">Worker: <strong>${escapeHtml(workerStatus)}</strong> | Heartbeat age: <strong>${escapeHtml(heartbeatAge)}</strong></div>
  <div class="row">
    <form method="post" action="/restart?token=${tokenParam}"><button type="submit">Restart</button></form>
    <form method="post" action="/stop?token=${tokenParam}"><button type="submit">Stop</button></form>
    <form method="post" action="/start?token=${tokenParam}"><button type="submit">Start</button></form>
  </div>
  <div class="row">
    <a href="/status?token=${tokenParam}">Status JSON</a>
    <a href="/logs?tail=200&token=${tokenParam}">Logs JSON</a>
    <a href="/mobile?token=${tokenParam}">Refresh</a>
  </div>
  <pre>${escapeHtml(JSON.stringify(input.status, null, 2))}</pre>
</body>
</html>`;
}

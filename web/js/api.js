"use strict";

const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
const devToken = new URLSearchParams(location.search).get("dev");

export const authMode = tg?.initData ? "telegram" : devToken ? "dev_token" : "none";
export const tgWebApp = tg;

function authHeaders() {
  const h = { "Content-Type": "application/json" };
  if (tg?.initData) h["X-Telegram-Init-Data"] = tg.initData;
  if (devToken) h["X-Dev-Bypass"] = devToken;
  return h;
}

export async function fetchJson(path) {
  const resp = await fetch(path, { headers: authHeaders() });
  if (resp.status === 401) throw new Error("unauthorized");
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

export async function postJson(path, body) {
  const resp = await fetch(path, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (resp.status === 401) throw new Error("unauthorized");
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}

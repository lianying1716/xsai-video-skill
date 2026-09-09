import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import crypto from "node:crypto";

function cleanBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function trustedBaseUrl(value, configured) {
  const candidate = cleanBaseUrl(value || configured);
  try {
    const candidateUrl = new URL(candidate);
    const configuredUrl = new URL(cleanBaseUrl(configured));
    if (!/^https?:$/.test(candidateUrl.protocol) || candidateUrl.origin !== configuredUrl.origin || candidateUrl.username || candidateUrl.password || candidateUrl.search || candidateUrl.hash || candidateUrl.pathname !== "/") throw new Error("untrusted base url");
    return candidateUrl.origin;
  } catch {
    throw Object.assign(new Error("授权服务地址不受信任"), { code: "invalid_request" });
  }
}

function endpoint(baseUrl, pathname) {
  const pathPart = String(pathname || "");
  if (!pathPart.startsWith("/") || pathPart.startsWith("//") || pathPart.includes("\\")) throw Object.assign(new Error("请求路径无效"), { code: "invalid_request" });
  return `${cleanBaseUrl(baseUrl)}${pathPart}`;
}

function stateRoot(envName, defaultName) {
  return path.resolve(process.env[envName] || process.env.XSAI_AUTH_STATE_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), defaultName));
}

function namespaceFor(authUrl, apiUrl) {
  return crypto.createHash("sha256").update(`${authUrl}\n${apiUrl}`).digest("hex").slice(0, 24);
}

export function createExternalSkillRuntime({
  clientId,
  consumerClientId = clientId,
  defaultBaseUrl,
  defaultAuthBaseUrl = defaultBaseUrl,
  stateEnv,
  stateName,
  defaultScopes = [],
  now = Date.now
}) {
  const configuredBaseUrl = trustedBaseUrl(defaultBaseUrl, defaultBaseUrl);
  const configuredAuthBaseUrl = trustedBaseUrl(defaultAuthBaseUrl, defaultAuthBaseUrl);
  const stateDir = () => {
    const configuredState = stateEnv && process.env[stateEnv];
    const sharedStateRoot = stateRoot(stateEnv, stateName);
    return configuredState ? path.resolve(configuredState) : path.join(sharedStateRoot, namespaceFor(configuredAuthBaseUrl, configuredBaseUrl));
  };
  const statePath = () => path.join(stateDir(), "auth.json");
  const lockPath = () => path.join(stateDir(), ".auth.lock");
  let cachedAccessToken = null;
  let cachedAccessExpiresAt = 0;

  async function readState() {
    try {
      const state = JSON.parse(await fs.readFile(statePath(), "utf8"));
      return state && typeof state === "object" ? state : null;
    } catch { return null; }
  }

  async function writeState(state) {
    await fs.mkdir(stateDir(), { recursive: true, mode: 0o700 });
    const temporary = `${statePath()}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    await fs.writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, statePath());
    await fs.chmod(statePath(), 0o600);
  }

  async function withAuthLock(fn, { wait = true } = {}) {
    await fs.mkdir(stateDir(), { recursive: true, mode: 0o700 });
    const started = Date.now();
    while (true) {
      try {
        const handle = await fs.open(lockPath(), "wx", 0o600);
        await handle.writeFile(`${process.pid} ${Date.now()}\n`);
        await handle.close();
        try { return await fn(); } finally { await fs.rm(lockPath(), { force: true }); }
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        let ownerAlive = null;
        try {
          const owner = String(await fs.readFile(lockPath(), "utf8")).trim().split(/\s+/)[0];
          const pid = Number(owner);
          if (!Number.isInteger(pid) || pid <= 0) ownerAlive = null;
          else { try { process.kill(pid, 0); ownerAlive = true; } catch (error) { ownerAlive = error.code === "ESRCH" ? false : null; } }
        } catch {}
        if (ownerAlive === false) { await fs.rm(lockPath(), { force: true }); continue; }
        if (!wait || Date.now() - started > 1_500) throw Object.assign(new Error("授权操作正在进行，请稍后重试"), { code: "auth_busy" });
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  async function removeState() {
    return withAuthLock(async () => {
      cachedAccessToken = null;
      cachedAccessExpiresAt = 0;
      await fs.rm(statePath(), { force: true });
    }, { wait: true });
  }

  async function fetchJson(url, options = {}, fetchImpl = globalThis.fetch) {
    let response;
    let text;
    try {
      response = await fetchImpl(url, {
        ...options,
        redirect: "error",
        signal: options.signal || AbortSignal.timeout(30_000)
      });
      text = await response.text();
    } catch (error) {
      throw Object.assign(new Error("网络请求失败"), { code: error.name === "TimeoutError" || error.name === "AbortError" ? "timeout" : "network_error" });
    }
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    if (!response.ok) {
      const source = typeof body?.error === "string"
        ? { code: body.error, error: body.error, error_description: body.error_description }
        : body?.error || body || {};
      throw Object.assign(new Error(String(source.message || source.error_description || "请求失败")), {
        code: String(source.code || source.error || `http_${response.status}`),
        status: response.status,
        retryAfterMs: Number(response.headers?.get?.("retry-after") || 0) * 1000 || undefined
      });
    }
    if (!body || typeof body !== "object") throw Object.assign(new Error("服务响应格式无效"), { code: "invalid_response" });
    return body;
  }

  async function tokenFromRefresh(state, fetchImpl = globalThis.fetch, signal) {
    if (!state?.refresh_token) {
      throw Object.assign(new Error("请先完成设备授权"), { code: "auth_required" });
    }
    trustedBaseUrl(state.auth_base_url, configuredAuthBaseUrl);
    return withAuthLock(async () => {
    const latest = await readState();
    if (!latest?.refresh_token) throw Object.assign(new Error("请先完成设备授权"), { code: "auth_required" });
    if (latest.auth_recovery_required) throw Object.assign(new Error("授权状态需要恢复，请重新登录"), { code: "auth_recovery_required" });
    await writeState({ ...latest, refresh_in_flight: { started_at: new Date().toISOString() } });
    const body = new URLSearchParams({
      client_id: clientId,
      consumer_client_id: consumerClientId,
      grant_type: "refresh_token",
      refresh_token: latest.refresh_token
    });
    let token;
    try { token = await fetchJson(
      endpoint(trustedBaseUrl(latest.auth_base_url, configuredAuthBaseUrl), "/api/external/v1/device/token"),
      {
        method: "POST",
        signal,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body
      },
      fetchImpl
    ); } catch (error) {
      if (error.code === "invalid_scope") await writeState({ ...latest, refresh_in_flight: undefined });
      else await writeState({ ...latest, auth_recovery_required: true });
      throw error;
    }
    if (!token?.access_token) {
      throw Object.assign(new Error("授权刷新失败"), { code: "auth_required" });
    }
    await writeState({
      ...latest,
      refresh_token: token.refresh_token || latest.refresh_token,
      scopes: token.scope || latest.scopes || [],
      grant_permissions: token.grant_permissions || latest.grant_permissions,
      grant_id: token.grant_id || latest.grant_id,
      refresh_in_flight: undefined,
      auth_recovery_required: undefined,
      access_expires_at: token.expires_in
        ? new Date(Date.now() + Number(token.expires_in) * 1000).toISOString()
        : state.access_expires_at,
      updated_at: new Date().toISOString()
    });
    cachedAccessToken = token.access_token;
    cachedAccessExpiresAt = token.expires_in ? now() + Number(token.expires_in) * 1000 : now() + 60_000;
    return token.access_token;
    }, { wait: true });
  }

  async function apiRequest(pathname, { method = "GET", token, body, headers = {}, signal, fetchImpl = globalThis.fetch } = {}) {
    const requestHeaders = { accept: "application/json", ...headers, authorization: `Bearer ${token}` };
    let payload = body;
    if (body && typeof body === "object" && !(typeof FormData !== "undefined" && body instanceof FormData)) {
      requestHeaders["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const state = await readState();
    return fetchJson(endpoint(trustedBaseUrl(state?.base_url, configuredBaseUrl), pathname), {
      method,
      signal,
      headers: requestHeaders,
      body: payload
    }, fetchImpl);
  }

  async function authorizedRequest(pathname, options = {}) {
    const token = cachedAccessToken && cachedAccessExpiresAt > now() + 30_000
      ? cachedAccessToken
      : await tokenFromRefresh(await readState(), options.fetchImpl || globalThis.fetch, options.signal);
    return apiRequest(pathname, { ...options, token });
  }

  async function downloadFile(url, output, { fetchImpl = globalThis.fetch } = {}) {
    let targetUrl;
    try {
      targetUrl = new URL(String(url));
      const allowedOrigins = new Set([new URL(configuredBaseUrl).origin]);
      if (allowedOrigins.has("https://api.xsai5.xyz")) {
        allowedOrigins.add("https://la.api.xsai5.xyz");
        allowedOrigins.add("https://api-hk.xsai5.xyz");
      }
      if (!allowedOrigins.has(targetUrl.origin) || !/^https:$/.test(targetUrl.protocol) || targetUrl.username || targetUrl.password || !targetUrl.pathname.startsWith("/v1/media/")) throw new Error("untrusted download url");
    } catch {
      throw Object.assign(new Error("下载地址不受信任"), { code: "invalid_request" });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300_000);
    let temporary;
    try {
    const response = await fetchImpl(targetUrl.href, { redirect: "error", signal: controller.signal });
    if (!response.ok || !response.body) throw Object.assign(new Error("结果下载失败"), { code: `http_${response.status}` });
    let target = path.resolve(output);
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
      await fs.access(target);
      const extension = path.extname(target);
      target = `${extension ? target.slice(0, -extension.length) : target}-${crypto.randomBytes(3).toString("hex")}${extension}`;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    temporary = `${target}.part-${crypto.randomBytes(6).toString("hex")}`;
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: "wx", mode: 0o600 }), { signal: controller.signal });
      await fs.link(temporary, target);
      return target;
    } finally {
      clearTimeout(timer);
      if (temporary) await fs.rm(temporary, { force: true });
    }
  }

  async function login(args = {}, fetchImpl = globalThis.fetch) {
    const requested = String(args.scope || defaultScopes.join(","))
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter(Boolean);
    const authBaseUrl = configuredAuthBaseUrl;
    const existing = await readState();
    const granted = Array.isArray(existing?.scopes) ? existing.scopes : String(existing?.scopes || "").split(/\s+/).filter(Boolean);
    if (existing?.refresh_token && requested.every((scope) => granted.includes(scope))) {
      try {
        await tokenFromRefresh(existing, fetchImpl);
        return { status: "authorized", reused: true, scopes: requested };
      } catch (error) {
        if (error.code !== "invalid_scope") throw error;
      }
    }
    return withAuthLock(async () => {
    const latest = await readState();
    const body = new URLSearchParams({
      client_id: clientId,
      consumer_client_id: consumerClientId,
      scope: requested.join(" ")
    });
    if (latest?.refresh_token) body.set("refresh_token", latest.refresh_token);
    const device = await fetchJson(endpoint(authBaseUrl, "/api/external/v1/device/authorize"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body
    }, fetchImpl);
    process.stdout.write(`${JSON.stringify({
      status: "awaiting_browser",
      verification_uri: device.verification_uri,
      user_code: device.user_code,
      expires_in: device.expires_in
    })}\n`);
    const expiresAt = Date.now() + Math.max(1, Number(device.expires_in) || 600) * 1000;
    let interval = Math.max(1, Number(device.interval) || 5);
    while (Date.now() < expiresAt) {
      await new Promise((resolve) => setTimeout(resolve, interval * 1000));
      try {
        const token = await fetchJson(endpoint(authBaseUrl, "/api/external/v1/device/token"), {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId,
            consumer_client_id: consumerClientId,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: device.device_code
          })
        }, fetchImpl);
        if (!token?.refresh_token) {
          throw Object.assign(new Error("授权响应缺少刷新令牌"), { code: "auth_required" });
        }
        await writeState({
          auth_base_url: authBaseUrl,
          base_url: configuredBaseUrl,
          client_id: clientId,
          consumer_client_id: consumerClientId,
          refresh_token: token.refresh_token,
          scopes: token.scope || requested,
          grant_permissions: token.grant_permissions || { [consumerClientId]: { scopes: token.scope || requested } },
          access_expires_at: token.expires_in
            ? new Date(Date.now() + Number(token.expires_in) * 1000).toISOString()
            : null,
          created_at: new Date().toISOString()
        });
        return { status: "authorized", scopes: token.scope || requested };
      } catch (error) {
        if (error.code === "authorization_pending") continue;
        if (error.code === "slow_down") { interval += 5; continue; }
        throw error;
      }
    }
    throw Object.assign(new Error("设备授权已过期"), { code: "timeout" });
    }, { wait: false });
  }

  return {
    stateDir,
    statePath,
    lockPath,
    readState,
    writeState,
    removeState,
    endpoint,
    fetchJson,
    tokenFromRefresh,
    apiRequest,
    authorizedRequest,
    downloadFile,
    login
  };
}

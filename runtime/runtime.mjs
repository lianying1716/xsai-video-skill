import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function cleanBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function trustedBaseUrl(value, configured) {
  const candidate = cleanBaseUrl(value || configured);
  try {
    const candidateUrl = new URL(candidate);
    const configuredUrl = new URL(cleanBaseUrl(configured));
    if (!/^https?:$/.test(candidateUrl.protocol) || candidateUrl.origin !== configuredUrl.origin) throw new Error("untrusted base url");
    return candidate;
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
  return path.resolve(
    process.env[envName]
      || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), defaultName)
  );
}

export function createExternalSkillRuntime({
  clientId,
  defaultBaseUrl,
  stateEnv,
  stateName,
  defaultScopes = []
}) {
  const configuredBaseUrl = trustedBaseUrl(defaultBaseUrl, defaultBaseUrl);
  const stateDir = () => stateRoot(stateEnv, stateName);
  const statePath = () => path.join(stateDir(), "auth.json");

  async function readState() {
    try {
      const state = JSON.parse(await fs.readFile(statePath(), "utf8"));
      return state && typeof state === "object" ? state : null;
    } catch {
      return null;
    }
  }

  async function writeState(state) {
    await fs.mkdir(stateDir(), { recursive: true, mode: 0o700 });
    await fs.writeFile(statePath(), `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await fs.chmod(statePath(), 0o600);
  }

  async function removeState() {
    await fs.rm(statePath(), { force: true });
  }

  async function fetchJson(url, options = {}, fetchImpl = globalThis.fetch) {
    const response = await fetchImpl(url, {
      ...options,
      signal: options.signal || AbortSignal.timeout(30_000)
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    if (!response.ok) {
      const source = typeof body?.error === "string"
        ? { code: body.error, error: body.error, error_description: body.error_description }
        : body?.error || body || {};
      throw Object.assign(new Error(String(source.message || source.error_description || "请求失败")), {
        code: String(source.code || source.error || `http_${response.status}`),
        status: response.status
      });
    }
    return body;
  }

  async function tokenFromRefresh(state, fetchImpl = globalThis.fetch) {
    if (!state?.refresh_token) {
      throw Object.assign(new Error("请先完成设备授权"), { code: "auth_required" });
    }
    const body = new URLSearchParams({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: state.refresh_token
    });
    const token = await fetchJson(
      endpoint(trustedBaseUrl(state.base_url, configuredBaseUrl), "/api/external/v1/device/token"),
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body
      },
      fetchImpl
    );
    if (!token?.access_token) {
      throw Object.assign(new Error("授权刷新失败"), { code: "auth_required" });
    }
    await writeState({
      ...state,
      refresh_token: token.refresh_token || state.refresh_token,
      scopes: token.scope || state.scopes || [],
      access_expires_at: token.expires_in
        ? new Date(Date.now() + Number(token.expires_in) * 1000).toISOString()
        : state.access_expires_at,
      updated_at: new Date().toISOString()
    });
    return token.access_token;
  }

  async function apiRequest(pathname, { method = "GET", token, body, headers = {}, fetchImpl = globalThis.fetch } = {}) {
    const requestHeaders = { accept: "application/json", ...headers, authorization: `Bearer ${token}` };
    let payload = body;
    if (body && typeof body === "object" && !(typeof FormData !== "undefined" && body instanceof FormData)) {
      requestHeaders["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const state = await readState();
    return fetchJson(endpoint(trustedBaseUrl(state?.base_url, configuredBaseUrl), pathname), {
      method,
      headers: requestHeaders,
      body: payload
    }, fetchImpl);
  }

  async function login(args = {}, fetchImpl = globalThis.fetch) {
    const requested = String(args.scope || defaultScopes.join(","))
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter(Boolean);
    const body = new URLSearchParams({
      client_id: clientId,
      scope: requested.join(" ")
    });
    const baseUrl = configuredBaseUrl;
    const device = await fetchJson(endpoint(baseUrl, "/api/external/v1/device/authorize"), {
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
        const token = await fetchJson(endpoint(baseUrl, "/api/external/v1/device/token"), {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: device.device_code
          })
        }, fetchImpl);
        if (!token?.refresh_token) {
          throw Object.assign(new Error("授权响应缺少刷新令牌"), { code: "auth_required" });
        }
        await writeState({
          base_url: baseUrl,
          client_id: clientId,
          refresh_token: token.refresh_token,
          scopes: token.scope || requested,
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
  }

  return {
    stateDir,
    statePath,
    readState,
    writeState,
    removeState,
    endpoint,
    fetchJson,
    tokenFromRefresh,
    apiRequest,
    login
  };
}

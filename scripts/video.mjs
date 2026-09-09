#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createExternalSkillRuntime } from "../runtime/runtime.mjs";

const CLIENT_ID = "xsai-video-skill";
const BASE_URL = process.env.XSAI_VIDEO_BASE_URL || "https://api.xsai5.xyz";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE_PATH = path.join(ROOT, "references", "model-profiles.json");
const DEFAULT_SCOPES = ["media.list_models", "media.read_capabilities"];
const runtime = createExternalSkillRuntime({
  clientId: CLIENT_ID,
  defaultBaseUrl: BASE_URL,
  stateEnv: "XSAI_VIDEO_STATE_DIR",
  stateName: "xsai-video-skill",
  defaultScopes: DEFAULT_SCOPES
});
const { readState, removeState, tokenFromRefresh, apiRequest, login } = runtime;
const MAX_REFERENCE_BYTES = Object.freeze({ image: 20 * 1024 * 1024, video: 200 * 1024 * 1024, audio: 50 * 1024 * 1024 });
const MIME_BY_EXTENSION = Object.freeze({
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
  ".aac": "audio/aac", ".m4a": "audio/x-m4a", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav"
});
function parseVideoArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i]);
    if (!token.startsWith("--")) { args._.push(token); continue; }
    const body = token.slice(2); const equal = body.indexOf("=");
    if (["confirm-spend", "wait"].includes(body)) args[body] = true;
    else if (equal >= 0) args[body.slice(0, equal)] = body.slice(equal + 1);
    else args[body] = argv[i + 1] && !String(argv[i + 1]).startsWith("--") ? argv[++i] : true;
  }
  args.command = args._[0] || "help"; args.subcommand = args._[1] || ""; return args;
}
function chooseVideoModel({ prompt = "", model = "" } = {}) {
  if (model) return { model: String(model), reason: "用户指定模型" };
  const text = String(prompt);
  if (/(首帧|尾帧|分镜|转场|storyboard|first.?frame|last.?frame)/i.test(text)) return { model: "seedance-2.0", reason: "任务强调分镜或首尾帧" };
  if (/(对白|台词|环境声|音效|dialogue|sound|voice)/i.test(text)) return { model: "minimax-h3", reason: "任务强调对白或声音" };
  return { model: "seedance2.5", reason: "任务适合时间线和镜头节奏控制" };
}
function profileFor(profiles, model) { return profiles.find((item) => item.model_id === model) || null; }
function buildVideoRequest(args, { profiles = [] } = {}) {
  const prompt = String(args.prompt || "").trim(); if (!prompt) throw Object.assign(new Error("缺少 --prompt"), { code: "invalid_request" });
  if (["api-key", "api_key", "provider-id", "channel-id", "group-id"].some((key) => Object.hasOwn(args, key))) throw Object.assign(new Error("外部 Skill 不接受内部凭据或路由参数"), { code: "unsupported_option" });
  const duration = Math.max(1, Number(args.duration || 8));
  if (duration > 8 && !args["confirm-spend"]) throw Object.assign(new Error("长视频需要明确费用确认"), { code: "spend_confirmation_required" });
  const choice = chooseVideoModel({ prompt, model: args.model }); const profile = profileFor(profiles, choice.model);
  const strategy = profile?.prompt_strategy ? `\n\n模型专用制作约束：${profile.prompt_strategy}` : "";
  const body = { model: choice.model, prompt: `${prompt}${strategy}`, duration };
  for (const key of ["aspect_ratio", "resolution", "audio", "first_frame_url", "last_frame_url", "images", "videos", "audios"]) if (args[key] !== undefined) body[key] = args[key];
  return { ...body, _meta: { choice, profile: profile ? { model_id: profile.model_id, prompt_strategy: profile.prompt_strategy } : null } };
}
function normalizeVideoError(error) {
  const code = String(error?.code || "video_request_failed").replace(/[^a-z0-9_\-]/gi, "_").slice(0, 64);
  const known = new Set(["auth_required", "authorization_pending", "invalid_request", "invalid_scope", "spend_confirmation_required", "unsupported_option", "model_unavailable", "not_found", "timeout"]);
  return { code, message: known.has(code) ? String(error.message || "请求失败") : "视频服务暂时不可用，请稍后重试。" };
}
async function readProfiles() { try { return Object.entries(JSON.parse(await fs.readFile(PROFILE_PATH, "utf8"))).map(([model_id, value]) => ({ model_id, ...value })); } catch { return []; } }
function listReferenceValues(value) {
  if (value === undefined || value === null || value === "") return [];
  if (Array.isArray(value)) return value.flatMap((item) => listReferenceValues(item));
  const raw = String(value).trim();
  if (raw.startsWith("[")) {
    try { return listReferenceValues(JSON.parse(raw)); } catch { throw Object.assign(new Error("素材参数必须是逗号分隔路径或 JSON 数组"), { code: "invalid_request" }); }
  }
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}
function isRelayFileId(value) { return /^file_[a-z0-9_-]{8,80}$/i.test(String(value || "")); }
async function uploadReference(value, family, token, fetchImpl = globalThis.fetch) {
  if (isRelayFileId(value)) return value;
  if (/^https?:\/\//i.test(String(value || ""))) throw Object.assign(new Error("素材只支持本地文件或 relay file_id"), { code: "invalid_request" });
  const filePath = path.resolve(String(value || ""));
  let stat;
  try { stat = await fs.stat(filePath); } catch { throw Object.assign(new Error("素材文件不可读取"), { code: "invalid_request" }); }
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_REFERENCE_BYTES[family]) throw Object.assign(new Error("素材类型或大小不符合要求"), { code: "invalid_request" });
  const extension = path.extname(filePath).toLowerCase(); const mimeType = MIME_BY_EXTENSION[extension];
  if (!mimeType || !mimeType.startsWith(`${family}/`)) throw Object.assign(new Error("素材类型或大小不符合要求"), { code: "invalid_request" });
  const form = new FormData(); form.set("purpose", "video_reference"); form.set("file", new Blob([await fs.readFile(filePath)], { type: mimeType }), path.basename(filePath));
  const response = await apiRequest("/v1/files", { method: "POST", token, body: form, fetchImpl });
  const fileId = String(response?.id || response?.file_id || "").trim();
  if (!isRelayFileId(fileId)) throw Object.assign(new Error("素材上传返回无效 file_id"), { code: "invalid_request" });
  return fileId;
}
async function prepareVideoReferences(args, token, fetchImpl = globalThis.fetch) {
  const request = {};
  const arrayFields = [["images", "image"], ["videos", "video"], ["audios", "audio"]];
  for (const [field, family] of arrayFields) {
    const values = listReferenceValues(args[field] ?? args[family]);
    if (values.length) request[field] = await Promise.all(values.map((value) => uploadReference(value, family, token, fetchImpl)));
  }
  for (const [argName, field] of [["first-frame", "first_image_url"], ["last-frame", "last_image_url"]]) {
    if (args[argName] !== undefined) request[field] = await uploadReference(args[argName], "image", token, fetchImpl);
  }
  return request;
}
async function watchStatuses({ fetchStatus, timeoutMs = 900_000, intervalMs = 8_000, maxPolls = 120 } = {}) {
  const started = Date.now(); let polls = 0;
  while (Date.now() - started <= timeoutMs && polls < maxPolls) {
    const status = await fetchStatus(); polls += 1;
    if (["succeeded", "failed", "cancelled", "timeout", "submission_unknown"].includes(String(status?.status || "").toLowerCase())) return status;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(1, timeoutMs - (Date.now() - started)))));
  }
  throw Object.assign(new Error("视频任务轮询超时"), { code: "timeout" });
}
async function downloadJob(jobId, output, fetchImpl = globalThis.fetch) {
  const token = await tokenFromRefresh(await readState(), fetchImpl); const job = await apiRequest(`/v1/videos/${encodeURIComponent(jobId)}`, { token, fetchImpl }); const item = job?.data?.[0];
  if (!item?.url) throw Object.assign(new Error("任务尚未产生可下载结果"), { code: "not_found" });
  const response = await fetchImpl(item.url, { signal: AbortSignal.timeout(60_000) }); if (!response.ok) throw Object.assign(new Error("结果下载失败"), { code: `http_${response.status}` });
  let target = path.resolve(output || `video-${jobId}.mp4`); await fs.mkdir(path.dirname(target), { recursive: true }); const bytes = Buffer.from(await response.arrayBuffer());
  try { await fs.writeFile(target, bytes, { flag: "wx" }); } catch (error) { if (error.code !== "EEXIST") throw error; const ext = path.extname(target); target = `${target.slice(0, -ext.length)}-${crypto.randomBytes(3).toString("hex")}${ext}`; await fs.writeFile(target, bytes, { flag: "wx" }); }
  return { job_id: jobId, output: target };
}
async function main(argv = process.argv.slice(2), fetchImpl = globalThis.fetch) {
  const args = parseVideoArgs(argv); if (args.command === "help") return { usage: "xsai-video auth|models|create|status|watch|cancel|download" };
  if (args.command === "auth" && args.subcommand === "login") return login(args, fetchImpl);
  if (args.command === "auth" && args.subcommand === "status") { const state = await readState(); return state ? { status: "configured", scopes: state.scopes || [], base_url: state.base_url || BASE_URL } : { status: "signed_out" }; }
  if (args.command === "auth" && args.subcommand === "logout") { await removeState(); return { status: "signed_out" }; }
  const token = await tokenFromRefresh(await readState(), fetchImpl); if (args.command === "models") return apiRequest("/v1/models", { token, fetchImpl });
  if (["status", "job"].includes(args.command)) return apiRequest(`/v1/videos/${encodeURIComponent(args._[1] || "")}`, { token, fetchImpl });
  if (args.command === "cancel") return apiRequest(`/v1/videos/${encodeURIComponent(args._[1] || "")}/cancel`, { method: "POST", token, body: {}, fetchImpl });
  if (args.command === "download") return downloadJob(args._[1], args.output, fetchImpl);
  const profiles = await readProfiles();
  if (args.command === "create") { const request = buildVideoRequest(args, { profiles }); delete request._meta; Object.assign(request, await prepareVideoReferences(args, token, fetchImpl)); const capability = await apiRequest(`/v1/videos/capabilities?model=${encodeURIComponent(request.model)}`, { token, fetchImpl }); if (!Array.isArray(capability?.data) || !capability.data.some((item) => String(item?.id || "") === request.model && item.available !== false)) throw Object.assign(new Error("当前授权下模型不可用"), { code: "model_unavailable" }); return apiRequest("/v1/videos", { method: "POST", token, body: request, fetchImpl }); }
  if (args.command === "watch") { const jobId = args._[1]; return watchStatuses({ timeoutMs: Math.max(1, Number(args.timeout || 900)) * 1000, fetchStatus: () => apiRequest(`/v1/videos/${encodeURIComponent(jobId)}`, { token, fetchImpl }) }); }
  throw Object.assign(new Error("未知命令"), { code: "invalid_request" });
}
export { buildVideoRequest, chooseVideoModel, main, normalizeVideoError, parseVideoArgs, prepareVideoReferences, uploadReference, watchStatuses };
if (import.meta.url === `file://${process.argv[1]}`) main().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => { process.stderr.write(`${JSON.stringify(normalizeVideoError(error))}\n`); process.exitCode = 1; });

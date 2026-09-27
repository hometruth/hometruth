/** Dependency-free ONVIF SOAP client for Bun. */

const SOAP_NAMESPACE = "http://www.w3.org/2003/05/soap-envelope";
const DEVICE_NAMESPACE = "http://www.onvif.org/ver10/device/wsdl";
const MEDIA_NAMESPACE = "http://www.onvif.org/ver10/media/wsdl";
const PTZ_NAMESPACE = "http://www.onvif.org/ver20/ptz/wsdl";
const IMAGING_NAMESPACE = "http://www.onvif.org/ver20/imaging/wsdl";
const SCHEMA_NAMESPACE = "http://www.onvif.org/ver10/schema";
const WSSE_NAMESPACE = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd";
const WSU_NAMESPACE = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd";
const PASSWORD_DIGEST_TYPE = `${WSSE_NAMESPACE}#PasswordDigest`;
const BASE64_BINARY_TYPE = `${WSSE_NAMESPACE}#Base64Binary`;
const MAX_TIMEOUT_MS = 30_000;

export type OnvifAuthMode = "auto" | "none" | "ws-security" | "http-basic" | "http-digest";
export type OnvifServiceKind = "device" | "media" | "ptz" | "imaging";

export interface OnvifServiceUrls {
  readonly device?: string;
  readonly media?: string;
  readonly ptz?: string;
  readonly imaging?: string;
}

export interface OnvifClientConfig {
  readonly deviceServiceUrl: string;
  readonly username?: string;
  readonly password?: string;
  readonly authMode?: OnvifAuthMode;
  readonly timeoutMs?: number;
  readonly serviceUrls?: OnvifServiceUrls;
}

export type OnvifFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface OnvifClientDependencies {
  readonly fetch?: OnvifFetch;
  readonly now?: () => Date;
  readonly nonce?: () => Uint8Array;
}

export interface OnvifDeviceInformation {
  readonly manufacturer: string;
  readonly model: string;
  readonly firmwareVersion: string;
  readonly serialNumber: string;
  readonly hardwareId: string;
}

export interface OnvifCapabilities {
  readonly device?: string;
  readonly media?: string;
  readonly events?: string;
  readonly imaging?: string;
  readonly ptz?: string;
  readonly extension?: string;
  readonly rawXml: string;
}

export interface OnvifService {
  readonly namespace: string;
  readonly xAddr: string;
  readonly version?: { readonly major: number; readonly minor: number };
  readonly capabilitiesXml?: string;
}

export interface OnvifVideoEncoderConfiguration {
  readonly token?: string;
  readonly name?: string;
  readonly encoding?: string;
  readonly resolution?: { readonly width: number; readonly height: number };
  readonly quality?: number;
  readonly frameRateLimit?: number;
  readonly bitrateLimit?: number;
}

export interface OnvifProfile {
  readonly token: string;
  readonly fixed?: boolean;
  readonly name?: string;
  readonly videoSourceConfigurationToken?: string;
  readonly videoEncoderConfiguration?: OnvifVideoEncoderConfiguration;
  readonly ptzConfigurationToken?: string;
  readonly rawXml: string;
}

export interface OnvifMediaUri {
  readonly uri: string;
  readonly invalidAfterConnect?: boolean;
  readonly invalidAfterReboot?: boolean;
  readonly timeout?: string;
}

export interface OnvifStreamOptions {
  readonly stream?: "RTP-Unicast" | "RTP-Multicast";
  readonly protocol?: "UDP" | "TCP" | "RTSP" | "HTTP";
}

export interface OnvifPanTiltVector {
  readonly x: number;
  readonly y: number;
  readonly space?: string;
}

export interface OnvifZoomVector {
  readonly x: number;
  readonly space?: string;
}

export interface OnvifPtzVector {
  readonly panTilt?: OnvifPanTiltVector;
  readonly zoom?: OnvifZoomVector;
}

export type OnvifPtzSpeed = OnvifPtzVector;

export interface OnvifPtzNode {
  readonly token: string;
  readonly name?: string;
  readonly homeSupported?: boolean;
  readonly maximumNumberOfPresets?: number;
  readonly auxiliaryCommands: readonly string[];
  readonly rawXml: string;
}

export interface OnvifPtzStatus {
  readonly position?: OnvifPtzVector;
  readonly moveStatus?: { readonly panTilt?: string; readonly zoom?: string };
  readonly error?: string;
  readonly utcTime?: string;
  readonly rawXml: string;
}

export interface OnvifPreset {
  readonly token: string;
  readonly name?: string;
  readonly position?: OnvifPtzVector;
  readonly rawXml: string;
}

export interface OnvifBacklightCompensation {
  readonly mode: string;
  readonly level?: number;
}

export interface OnvifExposureSettings {
  readonly mode: string;
  readonly priority?: string;
  readonly window?: { readonly bottom: number; readonly top: number; readonly right: number; readonly left: number };
  readonly minExposureTime?: number;
  readonly maxExposureTime?: number;
  readonly minGain?: number;
  readonly maxGain?: number;
  readonly minIris?: number;
  readonly maxIris?: number;
  readonly exposureTime?: number;
  readonly gain?: number;
  readonly iris?: number;
}

export interface OnvifFocusSettings {
  readonly autoFocusMode: string;
  readonly defaultSpeed?: number;
  readonly nearLimit?: number;
  readonly farLimit?: number;
}

export interface OnvifWideDynamicRange {
  readonly mode: string;
  readonly level?: number;
}

export interface OnvifWhiteBalance {
  readonly mode: string;
  readonly crGain?: number;
  readonly cbGain?: number;
}

export interface OnvifImagingSettings {
  readonly brightness?: number;
  readonly colorSaturation?: number;
  readonly contrast?: number;
  readonly sharpness?: number;
  readonly irCutFilter?: string;
  readonly backlightCompensation?: OnvifBacklightCompensation;
  readonly exposure?: OnvifExposureSettings;
  readonly focus?: OnvifFocusSettings;
  readonly wideDynamicRange?: OnvifWideDynamicRange;
  readonly whiteBalance?: OnvifWhiteBalance;
  readonly rawXml: string;
}

export type OnvifImagingSettingsPatch = Omit<OnvifImagingSettings, "rawXml">;

export interface OnvifImagingOptions {
  readonly brightness?: NumericRange;
  readonly colorSaturation?: NumericRange;
  readonly contrast?: NumericRange;
  readonly sharpness?: NumericRange;
  readonly rawXml: string;
}

export interface NumericRange {
  readonly min: number;
  readonly max: number;
}

export interface HttpAuthChallenge {
  readonly scheme: "Basic" | "Digest";
  readonly parameters: Readonly<Record<string, string>>;
}

export class OnvifError extends Error {
  readonly status?: number;
  readonly faultCode?: string;
  readonly faultReason?: string;
  readonly responseBody?: string;

  constructor(message: string, details: {
    readonly status?: number;
    readonly faultCode?: string;
    readonly faultReason?: string;
    readonly responseBody?: string;
  } = {}) {
    super(message);
    this.name = "OnvifError";
    if (details.status !== undefined) this.status = details.status;
    if (details.faultCode !== undefined) this.faultCode = details.faultCode;
    if (details.faultReason !== undefined) this.faultReason = details.faultReason;
    if (details.responseBody !== undefined) this.responseBody = details.responseBody;
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

interface XmlElement {
  readonly attributes: Readonly<Record<string, string>>;
  readonly inner: string;
  readonly outer: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of source.matchAll(/(?:^|\s)([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) {
    const name = match[1];
    if (name === undefined) continue;
    attributes[name] = decodeXml(match[2] ?? match[3] ?? "");
  }
  return attributes;
}

function findElements(xml: string, localName: string): XmlElement[] {
  const name = escapeRegExp(localName);
  const pairedExpression = new RegExp(
    `<((?:[A-Za-z_][\\w.-]*:)?${name})\\b([^>]*)>([\\s\\S]*?)<\\/\\1\\s*>`,
    "giu",
  );
  const selfClosingExpression = new RegExp(
    `<((?:[A-Za-z_][\\w.-]*:)?${name})\\b([^>]*)\\/\\s*>`,
    "giu",
  );
  const found: Array<XmlElement & { index: number }> = [];
  for (const match of xml.matchAll(pairedExpression)) {
    found.push({
      attributes: parseAttributes(match[2] ?? ""),
      inner: match[3] ?? "",
      outer: match[0],
      index: match.index,
    });
  }
  for (const match of xml.matchAll(selfClosingExpression)) {
    found.push({
      attributes: parseAttributes(match[2] ?? ""),
      inner: "",
      outer: match[0],
      index: match.index,
    });
  }
  return found.sort((left, right) => left.index - right.index).map(({ attributes, inner, outer }) => ({ attributes, inner, outer }));
}

function firstElement(xml: string, localName: string): XmlElement | undefined {
  return findElements(xml, localName)[0];
}

function textValue(xml: string, localName: string): string | undefined {
  const inner = firstElement(xml, localName)?.inner;
  if (inner === undefined) return undefined;
  const value = decodeXml(inner.replace(/<[^>]+>/gu, "").trim());
  return value || undefined;
}

function numberValue(xml: string, localName: string): number | undefined {
  const value = textValue(xml, localName);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function booleanValue(xml: string, localName: string): boolean | undefined {
  const value = textValue(xml, localName)?.toLowerCase();
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return undefined;
}

function attribute(element: XmlElement | undefined, localName: string): string | undefined {
  if (element === undefined) return undefined;
  for (const [key, value] of Object.entries(element.attributes)) {
    if (key === localName || key.endsWith(`:${localName}`)) return value;
  }
  return undefined;
}

function optionalNumber(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "";
  return String(value);
}

function cryptoHash(algorithm: "md5" | "sha1" | "sha256", input: string | Uint8Array, encoding: "hex" | "base64"): string {
  return new Bun.CryptoHasher(algorithm).update(input).digest(encoding);
}

function randomNonce(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(20));
}

export interface UsernameTokenParts {
  readonly username: string;
  readonly created: string;
  readonly nonce: string;
  readonly passwordDigest: string;
}

/** Build the ONVIF UsernameToken digest: Base64(SHA1(nonce + created + password)). */
export function createUsernameToken(
  username: string,
  password: string,
  date = new Date(),
  nonceBytes = randomNonce(),
): UsernameTokenParts {
  const created = date.toISOString();
  const createdBytes = new TextEncoder().encode(created);
  const passwordBytes = new TextEncoder().encode(password);
  const digestInput = new Uint8Array(nonceBytes.length + createdBytes.length + passwordBytes.length);
  digestInput.set(nonceBytes, 0);
  digestInput.set(createdBytes, nonceBytes.length);
  digestInput.set(passwordBytes, nonceBytes.length + createdBytes.length);
  return {
    username,
    created,
    nonce: Buffer.from(nonceBytes).toString("base64"),
    passwordDigest: cryptoHash("sha1", digestInput, "base64"),
  };
}

function usernameTokenXml(parts: UsernameTokenParts): string {
  return `<wsse:Security s:mustUnderstand="1"><wsse:UsernameToken>
<wsse:Username>${escapeXml(parts.username)}</wsse:Username>
<wsse:Password Type="${PASSWORD_DIGEST_TYPE}">${escapeXml(parts.passwordDigest)}</wsse:Password>
<wsse:Nonce EncodingType="${BASE64_BINARY_TYPE}">${escapeXml(parts.nonce)}</wsse:Nonce>
<wsu:Created>${escapeXml(parts.created)}</wsu:Created>
</wsse:UsernameToken></wsse:Security>`;
}

/** Parse Basic and Digest challenges, including a combined header. */
export function parseWwwAuthenticate(header: string): HttpAuthChallenge[] {
  const starts = [...header.matchAll(/(?:^|,)\s*(Basic|Digest)\s+/giu)];
  const challenges: HttpAuthChallenge[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const match = starts[index];
    const schemeText = match?.[1];
    if (match === undefined || (schemeText !== "Basic" && schemeText !== "basic" && schemeText !== "Digest" && schemeText !== "digest")) continue;
    const start = (match.index ?? 0) + match[0].length;
    const end = starts[index + 1]?.index ?? header.length;
    const parameters: Record<string, string> = {};
    const source = header.slice(start, end);
    for (const parameter of source.matchAll(/([A-Za-z][\w-]*)\s*=\s*(?:"((?:\\.|[^"])*)"|([^,\s]+))/gu)) {
      const name = parameter[1];
      if (name === undefined) continue;
      parameters[name.toLowerCase()] = (parameter[2] ?? parameter[3] ?? "").replace(/\\(["\\])/gu, "$1");
    }
    challenges.push({ scheme: schemeText.toLowerCase() === "basic" ? "Basic" : "Digest", parameters });
  }
  return challenges;
}

function quoteAuth(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function digestAlgorithmName(algorithm: string): "md5" | "sha256" {
  const normalized = algorithm.toLowerCase();
  if (normalized === "md5" || normalized === "md5-sess") return "md5";
  if (normalized === "sha-256" || normalized === "sha-256-sess") return "sha256";
  throw new OnvifError(`Unsupported HTTP Digest algorithm: ${algorithm}`);
}

export interface DigestAuthorizationInput {
  readonly username: string;
  readonly password: string;
  readonly method: string;
  readonly url: string;
  readonly challenge: HttpAuthChallenge;
  readonly nonceCount?: number;
  readonly clientNonce?: string;
}

export function createDigestAuthorization(input: DigestAuthorizationInput): string {
  if (input.challenge.scheme !== "Digest") throw new OnvifError("A Digest challenge is required");
  const realm = input.challenge.parameters.realm;
  const nonce = input.challenge.parameters.nonce;
  if (realm === undefined || nonce === undefined) throw new OnvifError("Malformed HTTP Digest challenge");
  const algorithm = input.challenge.parameters.algorithm ?? "MD5";
  const hashAlgorithm = digestAlgorithmName(algorithm);
  const qops = (input.challenge.parameters.qop ?? "").split(",").map((item) => item.trim().toLowerCase());
  const qop = qops.includes("auth") ? "auth" : undefined;
  if (qops.some(Boolean) && qop === undefined) throw new OnvifError("HTTP Digest auth-int is not supported");
  const uriObject = new URL(input.url);
  const uri = `${uriObject.pathname || "/"}${uriObject.search}`;
  const clientNonce = input.clientNonce ?? cryptoHash("sha256", randomNonce(), "hex").slice(0, 32);
  const nonceCount = Math.max(1, input.nonceCount ?? 1).toString(16).padStart(8, "0");
  const hash = (value: string): string => cryptoHash(hashAlgorithm, value, "hex");
  let ha1 = hash(`${input.username}:${realm}:${input.password}`);
  if (algorithm.toLowerCase().endsWith("-sess")) ha1 = hash(`${ha1}:${nonce}:${clientNonce}`);
  const ha2 = hash(`${input.method.toUpperCase()}:${uri}`);
  const response = qop === undefined
    ? hash(`${ha1}:${nonce}:${ha2}`)
    : hash(`${ha1}:${nonce}:${nonceCount}:${clientNonce}:${qop}:${ha2}`);
  const values = [
    `username=${quoteAuth(input.username)}`,
    `realm=${quoteAuth(realm)}`,
    `nonce=${quoteAuth(nonce)}`,
    `uri=${quoteAuth(uri)}`,
    `response=${quoteAuth(response)}`,
    `algorithm=${algorithm}`,
  ];
  if (input.challenge.parameters.opaque !== undefined) values.push(`opaque=${quoteAuth(input.challenge.parameters.opaque)}`);
  if (qop !== undefined) values.push(`qop=${qop}`, `nc=${nonceCount}`, `cnonce=${quoteAuth(clientNonce)}`);
  return `Digest ${values.join(", ")}`;
}

function soapEnvelope(body: string, securityHeader = ""): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="${SOAP_NAMESPACE}" xmlns:tds="${DEVICE_NAMESPACE}"
 xmlns:trt="${MEDIA_NAMESPACE}" xmlns:tptz="${PTZ_NAMESPACE}"
 xmlns:timg="${IMAGING_NAMESPACE}" xmlns:tt="${SCHEMA_NAMESPACE}"
 xmlns:wsse="${WSSE_NAMESPACE}" xmlns:wsu="${WSU_NAMESPACE}">
<s:Header>${securityHeader}</s:Header><s:Body>${body}</s:Body></s:Envelope>`;
}

function parseFault(xml: string): { code?: string; reason?: string } | undefined {
  const fault = firstElement(xml, "Fault");
  if (fault === undefined) return undefined;
  const code = textValue(firstElement(fault.inner, "Code")?.inner ?? fault.inner, "Value") ?? textValue(fault.inner, "faultcode");
  const reason = textValue(firstElement(fault.inner, "Reason")?.inner ?? fault.inner, "Text")
    ?? textValue(fault.inner, "faultstring")
    ?? textValue(fault.inner, "Text");
  return { ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) };
}

function isAuthorizationFault(fault: { code?: string; reason?: string } | undefined): boolean {
  if (fault === undefined) return false;
  return /not.?authorized|unauthori[sz]ed|ter:NotAuthorized/iu.test(`${fault.code ?? ""} ${fault.reason ?? ""}`);
}

function normalizedServiceKind(namespace: string): Exclude<OnvifServiceKind, "device"> | undefined {
  const lowered = namespace.toLowerCase();
  if (lowered.includes("/media/wsdl")) return "media";
  if (lowered.includes("/ptz/wsdl")) return "ptz";
  if (lowered.includes("/imaging/wsdl")) return "imaging";
  return undefined;
}

function conventionalServiceUrl(deviceServiceUrl: string, service: Exclude<OnvifServiceKind, "device">): string {
  const url = new URL(deviceServiceUrl);
  const conventionalNames: Record<Exclude<OnvifServiceKind, "device">, string> = {
    media: "media_service",
    ptz: "ptz_service",
    imaging: "imaging_service",
  };
  const marker = url.pathname.toLowerCase().lastIndexOf("/device_service");
  url.pathname = marker >= 0
    ? `${url.pathname.slice(0, marker)}/${conventionalNames[service]}`
    : `/onvif/${conventionalNames[service]}`;
  return url.toString();
}

function parseVector(xml: string): OnvifPtzVector | undefined {
  const panTiltElement = firstElement(xml, "PanTilt");
  const zoomElement = firstElement(xml, "Zoom");
  const panX = Number(attribute(panTiltElement, "x"));
  const panY = Number(attribute(panTiltElement, "y"));
  const zoomX = Number(attribute(zoomElement, "x"));
  const panSpace = attribute(panTiltElement, "space");
  const zoomSpace = attribute(zoomElement, "space");
  const panTilt = panTiltElement === undefined || !Number.isFinite(panX) || !Number.isFinite(panY)
    ? undefined
    : { x: panX, y: panY, ...(panSpace === undefined ? {} : { space: panSpace }) };
  const zoom = zoomElement === undefined || !Number.isFinite(zoomX)
    ? undefined
    : { x: zoomX, ...(zoomSpace === undefined ? {} : { space: zoomSpace }) };
  if (panTilt === undefined && zoom === undefined) return undefined;
  return { ...(panTilt === undefined ? {} : { panTilt }), ...(zoom === undefined ? {} : { zoom }) };
}

function vectorXml(prefix: string, vector: OnvifPtzVector): string {
  const panTilt = vector.panTilt === undefined
    ? ""
    : `<tt:PanTilt x="${optionalNumber(vector.panTilt.x)}" y="${optionalNumber(vector.panTilt.y)}"${vector.panTilt.space === undefined ? "" : ` space="${escapeXml(vector.panTilt.space)}"`}/>`;
  const zoom = vector.zoom === undefined
    ? ""
    : `<tt:Zoom x="${optionalNumber(vector.zoom.x)}"${vector.zoom.space === undefined ? "" : ` space="${escapeXml(vector.zoom.space)}"`}/>`;
  return `<${prefix}>${panTilt}${zoom}</${prefix}>`;
}

function assertFiniteVector(vector: OnvifPtzVector, label: string): void {
  if (vector.panTilt === undefined && vector.zoom === undefined) throw new OnvifError(`${label} must include panTilt or zoom`);
  if (vector.panTilt !== undefined && (!Number.isFinite(vector.panTilt.x) || !Number.isFinite(vector.panTilt.y))) {
    throw new OnvifError(`${label}.panTilt values must be finite`);
  }
  if (vector.zoom !== undefined && !Number.isFinite(vector.zoom.x)) throw new OnvifError(`${label}.zoom.x must be finite`);
}

function elementXml(name: string, value: string | number | undefined): string {
  if (value === undefined) return "";
  if (typeof value === "number" && !Number.isFinite(value)) throw new OnvifError(`${name} must be finite`);
  return `<tt:${name}>${escapeXml(String(value))}</tt:${name}>`;
}

function rangeFrom(xml: string, name: string): NumericRange | undefined {
  const block = firstElement(xml, name)?.inner;
  if (block === undefined) return undefined;
  const min = numberValue(block, "Min");
  const max = numberValue(block, "Max");
  return min === undefined || max === undefined ? undefined : { min, max };
}

function parseExposure(xml: string): OnvifExposureSettings | undefined {
  const block = firstElement(xml, "Exposure")?.inner;
  const mode = block === undefined ? undefined : textValue(block, "Mode");
  if (block === undefined || mode === undefined) return undefined;
  const priority = textValue(block, "Priority");
  const windowElement = firstElement(block, "Window");
  const readWindowValue = (name: string): number | undefined => {
    const raw = attribute(windowElement, name) ?? (windowElement === undefined ? undefined : textValue(windowElement.inner, name));
    if (raw === undefined) return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const bottom = readWindowValue("bottom") ?? readWindowValue("Bottom");
  const top = readWindowValue("top") ?? readWindowValue("Top");
  const right = readWindowValue("right") ?? readWindowValue("Right");
  const left = readWindowValue("left") ?? readWindowValue("Left");
  const window = bottom === undefined || top === undefined || right === undefined || left === undefined
    ? undefined
    : { bottom, top, right, left };
  const fields = {
    minExposureTime: numberValue(block, "MinExposureTime"),
    maxExposureTime: numberValue(block, "MaxExposureTime"),
    minGain: numberValue(block, "MinGain"),
    maxGain: numberValue(block, "MaxGain"),
    minIris: numberValue(block, "MinIris"),
    maxIris: numberValue(block, "MaxIris"),
    exposureTime: numberValue(block, "ExposureTime"),
    gain: numberValue(block, "Gain"),
    iris: numberValue(block, "Iris"),
  };
  return {
    mode,
    ...(priority === undefined ? {} : { priority }),
    ...(window === undefined ? {} : { window }),
    ...Object.fromEntries(Object.entries(fields).filter((entry): entry is [string, number] => entry[1] !== undefined)),
  } as OnvifExposureSettings;
}

function parseFocus(xml: string): OnvifFocusSettings | undefined {
  const block = firstElement(xml, "Focus")?.inner;
  const autoFocusMode = block === undefined ? undefined : textValue(block, "AutoFocusMode");
  if (block === undefined || autoFocusMode === undefined) return undefined;
  const defaultSpeed = numberValue(block, "DefaultSpeed");
  const nearLimit = numberValue(block, "NearLimit");
  const farLimit = numberValue(block, "FarLimit");
  return {
    autoFocusMode,
    ...(defaultSpeed === undefined ? {} : { defaultSpeed }),
    ...(nearLimit === undefined ? {} : { nearLimit }),
    ...(farLimit === undefined ? {} : { farLimit }),
  };
}

function parseModeLevel(xml: string, name: string): { mode: string; level?: number } | undefined {
  const block = firstElement(xml, name)?.inner;
  const mode = block === undefined ? undefined : textValue(block, "Mode");
  if (block === undefined || mode === undefined) return undefined;
  const level = numberValue(block, "Level");
  return { mode, ...(level === undefined ? {} : { level }) };
}

function parseWhiteBalance(xml: string): OnvifWhiteBalance | undefined {
  const block = firstElement(xml, "WhiteBalance")?.inner;
  const mode = block === undefined ? undefined : textValue(block, "Mode");
  if (block === undefined || mode === undefined) return undefined;
  const crGain = numberValue(block, "CrGain");
  const cbGain = numberValue(block, "CbGain");
  return { mode, ...(crGain === undefined ? {} : { crGain }), ...(cbGain === undefined ? {} : { cbGain }) };
}

function imagingSettingsXml(settings: OnvifImagingSettingsPatch): string {
  const backlight = settings.backlightCompensation === undefined ? "" : `<tt:BacklightCompensation>
${elementXml("Mode", settings.backlightCompensation.mode)}${elementXml("Level", settings.backlightCompensation.level)}</tt:BacklightCompensation>`;
  const exposure = settings.exposure === undefined ? "" : `<tt:Exposure>
${elementXml("Mode", settings.exposure.mode)}${elementXml("Priority", settings.exposure.priority)}
${settings.exposure.window === undefined ? "" : `<tt:Window bottom="${optionalNumber(settings.exposure.window.bottom)}" top="${optionalNumber(settings.exposure.window.top)}" right="${optionalNumber(settings.exposure.window.right)}" left="${optionalNumber(settings.exposure.window.left)}"/>`}
${elementXml("MinExposureTime", settings.exposure.minExposureTime)}${elementXml("MaxExposureTime", settings.exposure.maxExposureTime)}
${elementXml("MinGain", settings.exposure.minGain)}${elementXml("MaxGain", settings.exposure.maxGain)}
${elementXml("MinIris", settings.exposure.minIris)}${elementXml("MaxIris", settings.exposure.maxIris)}
${elementXml("ExposureTime", settings.exposure.exposureTime)}${elementXml("Gain", settings.exposure.gain)}${elementXml("Iris", settings.exposure.iris)}</tt:Exposure>`;
  const focus = settings.focus === undefined ? "" : `<tt:Focus>
${elementXml("AutoFocusMode", settings.focus.autoFocusMode)}${elementXml("DefaultSpeed", settings.focus.defaultSpeed)}
${elementXml("NearLimit", settings.focus.nearLimit)}${elementXml("FarLimit", settings.focus.farLimit)}</tt:Focus>`;
  const wideDynamicRange = settings.wideDynamicRange === undefined ? "" : `<tt:WideDynamicRange>
${elementXml("Mode", settings.wideDynamicRange.mode)}${elementXml("Level", settings.wideDynamicRange.level)}</tt:WideDynamicRange>`;
  const whiteBalance = settings.whiteBalance === undefined ? "" : `<tt:WhiteBalance>
${elementXml("Mode", settings.whiteBalance.mode)}${elementXml("CrGain", settings.whiteBalance.crGain)}${elementXml("CbGain", settings.whiteBalance.cbGain)}</tt:WhiteBalance>`;
  return `${backlight}${elementXml("Brightness", settings.brightness)}${elementXml("ColorSaturation", settings.colorSaturation)}
${elementXml("Contrast", settings.contrast)}${exposure}${focus}${elementXml("IrCutFilter", settings.irCutFilter)}
${elementXml("Sharpness", settings.sharpness)}${wideDynamicRange}${whiteBalance}`;
}

function parseImagingSettings(xml: string): OnvifImagingSettings {
  const settings = firstElement(xml, "ImagingSettings")?.inner ?? xml;
  const brightness = numberValue(settings, "Brightness");
  const colorSaturation = numberValue(settings, "ColorSaturation");
  const contrast = numberValue(settings, "Contrast");
  const sharpness = numberValue(settings, "Sharpness");
  const irCutFilter = textValue(settings, "IrCutFilter");
  const backlightCompensation = parseModeLevel(settings, "BacklightCompensation");
  const exposure = parseExposure(settings);
  const focus = parseFocus(settings);
  const wideDynamicRange = parseModeLevel(settings, "WideDynamicRange");
  const whiteBalance = parseWhiteBalance(settings);
  return {
    ...(brightness === undefined ? {} : { brightness }),
    ...(colorSaturation === undefined ? {} : { colorSaturation }),
    ...(contrast === undefined ? {} : { contrast }),
    ...(sharpness === undefined ? {} : { sharpness }),
    ...(irCutFilter === undefined ? {} : { irCutFilter }),
    ...(backlightCompensation === undefined ? {} : { backlightCompensation }),
    ...(exposure === undefined ? {} : { exposure }),
    ...(focus === undefined ? {} : { focus }),
    ...(wideDynamicRange === undefined ? {} : { wideDynamicRange }),
    ...(whiteBalance === undefined ? {} : { whiteBalance }),
    rawXml: settings,
  };
}

interface CachedHttpAuth {
  challenge: HttpAuthChallenge;
  nonceCount: number;
}

export class OnvifClient {
  readonly deviceServiceUrl: string;
  private readonly username: string | undefined;
  private readonly password: string | undefined;
  private readonly authMode: OnvifAuthMode;
  private readonly timeoutMs: number;
  private readonly fetchImplementation: OnvifFetch;
  private readonly now: () => Date;
  private readonly nonce: () => Uint8Array;
  private readonly endpoints: Partial<Record<OnvifServiceKind, string>>;
  private readonly httpAuth = new Map<string, CachedHttpAuth>();
  private readonly learnedAuth = new Map<string, Exclude<OnvifAuthMode, "auto" | "none">>();
  private endpointDiscovery: Promise<void> | undefined;

  constructor(config: OnvifClientConfig, dependencies: OnvifClientDependencies = {}) {
    const deviceUrl = new URL(config.deviceServiceUrl);
    if (deviceUrl.protocol !== "http:" && deviceUrl.protocol !== "https:") {
      throw new OnvifError("ONVIF device service URL must use HTTP or HTTPS");
    }
    if ((config.username === undefined) !== (config.password === undefined)) {
      throw new OnvifError("Both username and password are required when credentials are supplied");
    }
    this.deviceServiceUrl = deviceUrl.toString();
    this.username = config.username;
    this.password = config.password;
    this.authMode = config.authMode ?? "auto";
    this.timeoutMs = Math.max(100, Math.min(MAX_TIMEOUT_MS, Math.floor(config.timeoutMs ?? 5_000)));
    this.fetchImplementation = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = dependencies.now ?? (() => new Date());
    this.nonce = dependencies.nonce ?? randomNonce;
    this.endpoints = { ...config.serviceUrls, device: this.deviceServiceUrl };
  }

  get serviceUrls(): Readonly<Partial<Record<OnvifServiceKind, string>>> {
    return { ...this.endpoints };
  }

  private credentials(): { username: string; password: string } | undefined {
    return this.username === undefined || this.password === undefined
      ? undefined
      : { username: this.username, password: this.password };
  }

  private authHeader(mode: "http-basic" | "http-digest", url: string, method: string): string | undefined {
    const credentials = this.credentials();
    if (credentials === undefined) return undefined;
    if (mode === "http-basic") return `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`;
    const cached = this.httpAuth.get(new URL(url).origin);
    if (cached === undefined) return undefined;
    cached.nonceCount += 1;
    return createDigestAuthorization({
      ...credentials,
      method,
      url,
      challenge: cached.challenge,
      nonceCount: cached.nonceCount,
      clientNonce: cryptoHash("sha256", this.nonce(), "hex").slice(0, 32),
    });
  }

  private securityXml(mode: OnvifAuthMode): string {
    const credentials = this.credentials();
    if (mode !== "ws-security" || credentials === undefined) return "";
    return usernameTokenXml(createUsernameToken(credentials.username, credentials.password, this.now(), this.nonce()));
  }

  private async performRequest(url: string, action: string, body: string, mode: OnvifAuthMode): Promise<Response> {
    const headers = new Headers({
      "content-type": `application/soap+xml; charset=utf-8; action="${action}"`,
      "soapaction": `"${action}"`,
    });
    if (mode === "http-basic" || mode === "http-digest") {
      const authorization = this.authHeader(mode, url, "POST");
      if (authorization !== undefined) headers.set("authorization", authorization);
    }
    return await this.fetchImplementation(url, {
      method: "POST",
      headers,
      body: soapEnvelope(body, this.securityXml(mode)),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  private selectChallenge(response: Response, url: string): Exclude<OnvifAuthMode, "auto" | "none" | "ws-security"> | undefined {
    const header = response.headers.get("www-authenticate");
    if (header === null) return undefined;
    const challenges = parseWwwAuthenticate(header);
    const digest = challenges.find((challenge) => challenge.scheme === "Digest");
    if (digest !== undefined) {
      this.httpAuth.set(new URL(url).origin, { challenge: digest, nonceCount: 0 });
      return "http-digest";
    }
    return challenges.some((challenge) => challenge.scheme === "Basic") ? "http-basic" : undefined;
  }

  private async soapRequest(url: string, action: string, body: string): Promise<string> {
    const origin = new URL(url).origin;
    const learned = this.learnedAuth.get(origin);
    let mode: OnvifAuthMode = this.authMode === "auto" ? (learned ?? "none") : this.authMode;
    // Digest needs one unauthenticated exchange to obtain its nonce.
    if (mode === "http-digest" && !this.httpAuth.has(origin)) mode = "none";
    let response = await this.performRequest(url, action, body, mode);

    if (response.status === 401 && this.credentials() !== undefined && this.authMode !== "none" && this.authMode !== "ws-security") {
      const challengedMode = this.selectChallenge(response, url);
      const permitted = this.authMode === "auto"
        || (this.authMode === "http-digest" && challengedMode === "http-digest")
        || (this.authMode === "http-basic" && challengedMode === "http-basic");
      if (challengedMode !== undefined && permitted) {
        mode = challengedMode;
        this.learnedAuth.set(origin, challengedMode);
        response = await this.performRequest(url, action, body, challengedMode);
      }
    }

    let responseText = await response.text();
    let fault = parseFault(responseText);
    // A number of Meari/TKENPRO cameras return a valid SOAP NotAuthorized fault
    // with HTTP 400 instead of HTTP 200.  The SOAP fault, rather than the HTTP
    // status, is the authoritative signal that auto mode should retry with a
    // WS-Security UsernameToken.
    if (isAuthorizationFault(fault) && this.authMode === "auto" && this.credentials() !== undefined && mode !== "ws-security") {
      mode = "ws-security";
      this.learnedAuth.set(origin, mode);
      response = await this.performRequest(url, action, body, mode);
      responseText = await response.text();
      fault = parseFault(responseText);
    }

    if (!response.ok) {
      throw new OnvifError(`ONVIF request failed with HTTP ${response.status}`, {
        status: response.status,
        ...(fault?.code === undefined ? {} : { faultCode: fault.code }),
        ...(fault?.reason === undefined ? {} : { faultReason: fault.reason }),
        responseBody: responseText,
      });
    }
    if (fault !== undefined) {
      throw new OnvifError(fault.reason ?? fault.code ?? "ONVIF SOAP fault", {
        ...(fault.code === undefined ? {} : { faultCode: fault.code }),
        ...(fault.reason === undefined ? {} : { faultReason: fault.reason }),
        responseBody: responseText,
      });
    }
    return responseText;
  }

  private async resolveEndpoint(service: OnvifServiceKind): Promise<string> {
    const existing = this.endpoints[service];
    if (existing !== undefined) return existing;
    if (this.endpointDiscovery === undefined) {
      this.endpointDiscovery = (async () => {
        try {
          await this.getCapabilities("All");
        } catch {
          // Some inexpensive cameras implement GetServices but not All capabilities.
        }
        try {
          await this.getServices(false);
        } catch {
          // Conventional ONVIF paths remain a useful standards-compatible fallback.
        }
      })();
    }
    await this.endpointDiscovery;
    return this.endpoints[service] ?? conventionalServiceUrl(this.deviceServiceUrl, service as Exclude<OnvifServiceKind, "device">);
  }

  private async invoke(service: OnvifServiceKind, operation: string, body: string): Promise<string> {
    const endpoint = await this.resolveEndpoint(service);
    const namespace = service === "device"
      ? DEVICE_NAMESPACE
      : service === "media"
        ? MEDIA_NAMESPACE
        : service === "ptz"
          ? PTZ_NAMESPACE
          : IMAGING_NAMESPACE;
    return await this.soapRequest(endpoint, `${namespace}/${operation}`, body);
  }

  async getDeviceInformation(): Promise<OnvifDeviceInformation> {
    const xml = await this.invoke("device", "GetDeviceInformation", "<tds:GetDeviceInformation/>");
    return {
      manufacturer: textValue(xml, "Manufacturer") ?? "",
      model: textValue(xml, "Model") ?? "",
      firmwareVersion: textValue(xml, "FirmwareVersion") ?? "",
      serialNumber: textValue(xml, "SerialNumber") ?? "",
      hardwareId: textValue(xml, "HardwareId") ?? "",
    };
  }

  /**
   * Restart the camera. The Pet 3T answers "Rebooting" and drops off the
   * network a few seconds later; it is back on Wi-Fi about 30 s after that.
   */
  async systemReboot(): Promise<string> {
    const xml = await this.invoke("device", "SystemReboot", "<tds:SystemReboot/>");
    return textValue(xml, "Message") ?? "";
  }

  async getCapabilities(category: "All" | "Analytics" | "Device" | "Events" | "Imaging" | "Media" | "PTZ" = "All"): Promise<OnvifCapabilities> {
    const xml = await this.invoke("device", "GetCapabilities", `<tds:GetCapabilities><tds:Category>${category}</tds:Category></tds:GetCapabilities>`);
    const capabilities = firstElement(xml, "Capabilities")?.inner ?? xml;
    const xAddr = (name: string): string | undefined => {
      const block = firstElement(capabilities, name)?.inner;
      return block === undefined ? undefined : textValue(block, "XAddr");
    };
    const device = xAddr("Device");
    const media = xAddr("Media");
    const events = xAddr("Events");
    const imaging = xAddr("Imaging");
    const ptz = xAddr("PTZ");
    const extension = xAddr("Extension");
    const result: OnvifCapabilities = {
      ...(device === undefined ? {} : { device }),
      ...(media === undefined ? {} : { media }),
      ...(events === undefined ? {} : { events }),
      ...(imaging === undefined ? {} : { imaging }),
      ...(ptz === undefined ? {} : { ptz }),
      ...(extension === undefined ? {} : { extension }),
      rawXml: capabilities,
    };
    if (result.device !== undefined) this.endpoints.device = result.device;
    if (result.media !== undefined) this.endpoints.media = result.media;
    if (result.ptz !== undefined) this.endpoints.ptz = result.ptz;
    if (result.imaging !== undefined) this.endpoints.imaging = result.imaging;
    return result;
  }

  async getServices(includeCapability = false): Promise<OnvifService[]> {
    const xml = await this.invoke("device", "GetServices", `<tds:GetServices><tds:IncludeCapability>${includeCapability}</tds:IncludeCapability></tds:GetServices>`);
    const services = findElements(xml, "Service").flatMap((service): OnvifService[] => {
      const namespace = textValue(service.inner, "Namespace");
      const xAddr = textValue(service.inner, "XAddr");
      if (namespace === undefined || xAddr === undefined) return [];
      const versionBlock = firstElement(service.inner, "Version")?.inner;
      const major = versionBlock === undefined ? undefined : numberValue(versionBlock, "Major");
      const minor = versionBlock === undefined ? undefined : numberValue(versionBlock, "Minor");
      const version = major === undefined || minor === undefined ? undefined : { major, minor };
      const capabilitiesXml = firstElement(service.inner, "Capabilities")?.inner;
      return [{
        namespace,
        xAddr,
        ...(version === undefined ? {} : { version }),
        ...(capabilitiesXml === undefined ? {} : { capabilitiesXml }),
      }];
    });
    for (const service of services) {
      const kind = normalizedServiceKind(service.namespace);
      if (kind !== undefined) this.endpoints[kind] = service.xAddr;
      if (service.namespace.toLowerCase().includes("/device/wsdl")) this.endpoints.device = service.xAddr;
    }
    return services;
  }

  async getProfiles(): Promise<OnvifProfile[]> {
    const xml = await this.invoke("media", "GetProfiles", "<trt:GetProfiles/>");
    return findElements(xml, "Profiles").flatMap((profile): OnvifProfile[] => {
      const token = attribute(profile, "token");
      if (token === undefined) return [];
      const fixedText = attribute(profile, "fixed")?.toLowerCase();
      const fixed = fixedText === undefined ? undefined : fixedText === "true" || fixedText === "1";
      const name = textValue(profile.inner, "Name");
      const sourceConfiguration = firstElement(profile.inner, "VideoSourceConfiguration");
      const encoderConfiguration = firstElement(profile.inner, "VideoEncoderConfiguration");
      const ptzConfiguration = firstElement(profile.inner, "PTZConfiguration");
      let videoEncoderConfiguration: OnvifVideoEncoderConfiguration | undefined;
      if (encoderConfiguration !== undefined) {
        const encoderToken = attribute(encoderConfiguration, "token");
        const encoderName = textValue(encoderConfiguration.inner, "Name");
        const encoding = textValue(encoderConfiguration.inner, "Encoding");
        const resolutionBlock = firstElement(encoderConfiguration.inner, "Resolution")?.inner;
        const width = resolutionBlock === undefined ? undefined : numberValue(resolutionBlock, "Width");
        const height = resolutionBlock === undefined ? undefined : numberValue(resolutionBlock, "Height");
        const resolution = width === undefined || height === undefined ? undefined : { width, height };
        const quality = numberValue(encoderConfiguration.inner, "Quality");
        const rateControl = firstElement(encoderConfiguration.inner, "RateControl")?.inner;
        const frameRateLimit = rateControl === undefined ? undefined : numberValue(rateControl, "FrameRateLimit");
        const bitrateLimit = rateControl === undefined ? undefined : numberValue(rateControl, "BitrateLimit");
        videoEncoderConfiguration = {
          ...(encoderToken === undefined ? {} : { token: encoderToken }),
          ...(encoderName === undefined ? {} : { name: encoderName }),
          ...(encoding === undefined ? {} : { encoding }),
          ...(resolution === undefined ? {} : { resolution }),
          ...(quality === undefined ? {} : { quality }),
          ...(frameRateLimit === undefined ? {} : { frameRateLimit }),
          ...(bitrateLimit === undefined ? {} : { bitrateLimit }),
        };
      }
      const videoSourceConfigurationToken = attribute(sourceConfiguration, "token");
      const ptzConfigurationToken = attribute(ptzConfiguration, "token");
      return [{
        token,
        ...(fixed === undefined ? {} : { fixed }),
        ...(name === undefined ? {} : { name }),
        ...(videoSourceConfigurationToken === undefined ? {} : { videoSourceConfigurationToken }),
        ...(videoEncoderConfiguration === undefined ? {} : { videoEncoderConfiguration }),
        ...(ptzConfigurationToken === undefined ? {} : { ptzConfigurationToken }),
        rawXml: profile.outer,
      }];
    });
  }

  async getStreamUri(profileToken: string, options: OnvifStreamOptions = {}): Promise<OnvifMediaUri> {
    const stream = options.stream ?? "RTP-Unicast";
    const protocol = options.protocol ?? "RTSP";
    const xml = await this.invoke("media", "GetStreamUri", `<trt:GetStreamUri>
<trt:StreamSetup><tt:Stream>${stream}</tt:Stream><tt:Transport><tt:Protocol>${protocol}</tt:Protocol></tt:Transport></trt:StreamSetup>
<trt:ProfileToken>${escapeXml(profileToken)}</trt:ProfileToken></trt:GetStreamUri>`);
    return this.parseMediaUri(xml, "MediaUri");
  }

  async getSnapshotUri(profileToken: string): Promise<OnvifMediaUri> {
    const xml = await this.invoke("media", "GetSnapshotUri", `<trt:GetSnapshotUri><trt:ProfileToken>${escapeXml(profileToken)}</trt:ProfileToken></trt:GetSnapshotUri>`);
    return this.parseMediaUri(xml, "MediaUri");
  }

  private parseMediaUri(xml: string, container: string): OnvifMediaUri {
    const mediaUri = firstElement(xml, container)?.inner ?? xml;
    const uri = textValue(mediaUri, "Uri");
    if (uri === undefined) throw new OnvifError("ONVIF response did not include a media URI", { responseBody: xml });
    const invalidAfterConnect = booleanValue(mediaUri, "InvalidAfterConnect");
    const invalidAfterReboot = booleanValue(mediaUri, "InvalidAfterReboot");
    const timeout = textValue(mediaUri, "Timeout");
    return {
      uri,
      ...(invalidAfterConnect === undefined ? {} : { invalidAfterConnect }),
      ...(invalidAfterReboot === undefined ? {} : { invalidAfterReboot }),
      ...(timeout === undefined ? {} : { timeout }),
    };
  }

  async getPtzNodes(): Promise<OnvifPtzNode[]> {
    const xml = await this.invoke("ptz", "GetNodes", "<tptz:GetNodes/>");
    return findElements(xml, "PTZNode").flatMap((node): OnvifPtzNode[] => {
      const token = attribute(node, "token");
      if (token === undefined) return [];
      const name = textValue(node.inner, "Name");
      const homeSupported = booleanValue(node.inner, "HomeSupported");
      const maximumNumberOfPresets = numberValue(node.inner, "MaximumNumberOfPresets");
      const auxiliaryCommands = findElements(node.inner, "AuxiliaryCommands")
        .map((element) => decodeXml(element.inner.replace(/<[^>]+>/gu, "").trim()))
        .filter(Boolean);
      return [{
        token,
        ...(name === undefined ? {} : { name }),
        ...(homeSupported === undefined ? {} : { homeSupported }),
        ...(maximumNumberOfPresets === undefined ? {} : { maximumNumberOfPresets }),
        auxiliaryCommands,
        rawXml: node.outer,
      }];
    });
  }

  async getPtzStatus(profileToken: string): Promise<OnvifPtzStatus> {
    const xml = await this.invoke("ptz", "GetStatus", `<tptz:GetStatus><tptz:ProfileToken>${escapeXml(profileToken)}</tptz:ProfileToken></tptz:GetStatus>`);
    const status = firstElement(xml, "PTZStatus")?.inner ?? xml;
    const positionBlock = firstElement(status, "Position")?.inner;
    const position = positionBlock === undefined ? undefined : parseVector(positionBlock);
    const moveStatusBlock = firstElement(status, "MoveStatus")?.inner;
    const panTilt = moveStatusBlock === undefined ? undefined : textValue(moveStatusBlock, "PanTilt");
    const zoom = moveStatusBlock === undefined ? undefined : textValue(moveStatusBlock, "Zoom");
    const moveStatus = panTilt === undefined && zoom === undefined ? undefined : {
      ...(panTilt === undefined ? {} : { panTilt }),
      ...(zoom === undefined ? {} : { zoom }),
    };
    const error = textValue(status, "Error");
    const utcTime = textValue(status, "UtcTime");
    return {
      ...(position === undefined ? {} : { position }),
      ...(moveStatus === undefined ? {} : { moveStatus }),
      ...(error === undefined ? {} : { error }),
      ...(utcTime === undefined ? {} : { utcTime }),
      rawXml: status,
    };
  }

  async continuousMove(profileToken: string, velocity: OnvifPtzSpeed, timeout?: string): Promise<void> {
    assertFiniteVector(velocity, "velocity");
    await this.invoke("ptz", "ContinuousMove", `<tptz:ContinuousMove><tptz:ProfileToken>${escapeXml(profileToken)}</tptz:ProfileToken>
${vectorXml("tptz:Velocity", velocity)}${timeout === undefined ? "" : `<tptz:Timeout>${escapeXml(timeout)}</tptz:Timeout>`}</tptz:ContinuousMove>`);
  }

  async relativeMove(profileToken: string, translation: OnvifPtzVector, speed?: OnvifPtzSpeed): Promise<void> {
    assertFiniteVector(translation, "translation");
    if (speed !== undefined) assertFiniteVector(speed, "speed");
    await this.invoke("ptz", "RelativeMove", `<tptz:RelativeMove><tptz:ProfileToken>${escapeXml(profileToken)}</tptz:ProfileToken>
${vectorXml("tptz:Translation", translation)}${speed === undefined ? "" : vectorXml("tptz:Speed", speed)}</tptz:RelativeMove>`);
  }

  async absoluteMove(profileToken: string, position: OnvifPtzVector, speed?: OnvifPtzSpeed): Promise<void> {
    assertFiniteVector(position, "position");
    if (speed !== undefined) assertFiniteVector(speed, "speed");
    await this.invoke("ptz", "AbsoluteMove", `<tptz:AbsoluteMove><tptz:ProfileToken>${escapeXml(profileToken)}</tptz:ProfileToken>
${vectorXml("tptz:Position", position)}${speed === undefined ? "" : vectorXml("tptz:Speed", speed)}</tptz:AbsoluteMove>`);
  }

  async stop(profileToken: string, panTilt = true, zoom = true): Promise<void> {
    await this.invoke("ptz", "Stop", `<tptz:Stop><tptz:ProfileToken>${escapeXml(profileToken)}</tptz:ProfileToken>
<tptz:PanTilt>${panTilt}</tptz:PanTilt><tptz:Zoom>${zoom}</tptz:Zoom></tptz:Stop>`);
  }

  async gotoHomePosition(profileToken: string, speed?: OnvifPtzSpeed): Promise<void> {
    if (speed !== undefined) assertFiniteVector(speed, "speed");
    await this.invoke("ptz", "GotoHomePosition", `<tptz:GotoHomePosition><tptz:ProfileToken>${escapeXml(profileToken)}</tptz:ProfileToken>
${speed === undefined ? "" : vectorXml("tptz:Speed", speed)}</tptz:GotoHomePosition>`);
  }

  async setHomePosition(profileToken: string): Promise<void> {
    await this.invoke("ptz", "SetHomePosition", `<tptz:SetHomePosition><tptz:ProfileToken>${escapeXml(profileToken)}</tptz:ProfileToken></tptz:SetHomePosition>`);
  }

  async getPresets(profileToken: string): Promise<OnvifPreset[]> {
    const xml = await this.invoke("ptz", "GetPresets", `<tptz:GetPresets><tptz:ProfileToken>${escapeXml(profileToken)}</tptz:ProfileToken></tptz:GetPresets>`);
    return findElements(xml, "Preset").flatMap((preset): OnvifPreset[] => {
      const token = attribute(preset, "token");
      if (token === undefined) return [];
      const name = textValue(preset.inner, "Name");
      const positionBlock = firstElement(preset.inner, "PTZPosition")?.inner;
      const position = positionBlock === undefined ? undefined : parseVector(positionBlock);
      return [{
        token,
        ...(name === undefined ? {} : { name }),
        ...(position === undefined ? {} : { position }),
        rawXml: preset.outer,
      }];
    });
  }

  async setPreset(profileToken: string, presetName?: string, presetToken?: string): Promise<string> {
    const xml = await this.invoke("ptz", "SetPreset", `<tptz:SetPreset><tptz:ProfileToken>${escapeXml(profileToken)}</tptz:ProfileToken>
${presetName === undefined ? "" : `<tptz:PresetName>${escapeXml(presetName)}</tptz:PresetName>`}
${presetToken === undefined ? "" : `<tptz:PresetToken>${escapeXml(presetToken)}</tptz:PresetToken>`}</tptz:SetPreset>`);
    const token = textValue(xml, "PresetToken");
    if (token === undefined) throw new OnvifError("SetPreset response did not include a preset token", { responseBody: xml });
    return token;
  }

  async gotoPreset(profileToken: string, presetToken: string, speed?: OnvifPtzSpeed): Promise<void> {
    if (speed !== undefined) assertFiniteVector(speed, "speed");
    await this.invoke("ptz", "GotoPreset", `<tptz:GotoPreset><tptz:ProfileToken>${escapeXml(profileToken)}</tptz:ProfileToken>
<tptz:PresetToken>${escapeXml(presetToken)}</tptz:PresetToken>${speed === undefined ? "" : vectorXml("tptz:Speed", speed)}</tptz:GotoPreset>`);
  }

  async removePreset(profileToken: string, presetToken: string): Promise<void> {
    await this.invoke("ptz", "RemovePreset", `<tptz:RemovePreset><tptz:ProfileToken>${escapeXml(profileToken)}</tptz:ProfileToken>
<tptz:PresetToken>${escapeXml(presetToken)}</tptz:PresetToken></tptz:RemovePreset>`);
  }

  async getImagingSettings(videoSourceToken: string): Promise<OnvifImagingSettings> {
    const xml = await this.invoke("imaging", "GetImagingSettings", `<timg:GetImagingSettings><timg:VideoSourceToken>${escapeXml(videoSourceToken)}</timg:VideoSourceToken></timg:GetImagingSettings>`);
    return parseImagingSettings(xml);
  }

  async getImagingOptions(videoSourceToken: string): Promise<OnvifImagingOptions> {
    const xml = await this.invoke("imaging", "GetOptions", `<timg:GetOptions><timg:VideoSourceToken>${escapeXml(videoSourceToken)}</timg:VideoSourceToken></timg:GetOptions>`);
    const options = firstElement(xml, "ImagingOptions")?.inner ?? xml;
    const brightness = rangeFrom(options, "Brightness");
    const colorSaturation = rangeFrom(options, "ColorSaturation");
    const contrast = rangeFrom(options, "Contrast");
    const sharpness = rangeFrom(options, "Sharpness");
    return {
      ...(brightness === undefined ? {} : { brightness }),
      ...(colorSaturation === undefined ? {} : { colorSaturation }),
      ...(contrast === undefined ? {} : { contrast }),
      ...(sharpness === undefined ? {} : { sharpness }),
      rawXml: options,
    };
  }

  async setImagingSettings(videoSourceToken: string, settings: OnvifImagingSettingsPatch, forcePersistence = true): Promise<void> {
    await this.invoke("imaging", "SetImagingSettings", `<timg:SetImagingSettings>
<timg:VideoSourceToken>${escapeXml(videoSourceToken)}</timg:VideoSourceToken>
<timg:ImagingSettings>${imagingSettingsXml(settings)}</timg:ImagingSettings>
<timg:ForcePersistence>${forcePersistence}</timg:ForcePersistence></timg:SetImagingSettings>`);
  }
}

export const MEARI_RTSP_FALLBACKS = [
  { port: 8554, path: "/profile0", label: "main" },
  { port: 8554, path: "/profile1", label: "sub" },
  { port: 8554, path: "/live0.265", label: "main-h265" },
  { port: 8554, path: "/live1.265", label: "sub-h265" },
  { port: 8554, path: "/live2.265", label: "mobile-h265" },
] as const;

export interface RtspCandidate {
  readonly uri: string;
  readonly source: "onvif" | "meari-fallback";
  readonly label: string;
}

export interface RtspCandidateOptions {
  /** URI returned by GetStreamUri; always placed first and never rewritten. */
  readonly returnedUri?: string;
  /** Required for fallbacks when it cannot be derived from returnedUri. */
  readonly host?: string;
  readonly username?: string;
  readonly password?: string;
  /** Meari paths are guesses and therefore opt-in only. */
  readonly includeMeariFallbacks?: boolean;
}

/**
 * Build an ordered list of RTSP probe targets. The camera-reported URI wins;
 * model-family fallbacks are included only when explicitly requested.
 */
export function buildRtspCandidates(options: RtspCandidateOptions): RtspCandidate[] {
  const candidates: RtspCandidate[] = [];
  let derivedHost: string | undefined;
  if (options.returnedUri !== undefined) {
    const returned = new URL(options.returnedUri);
    if (returned.protocol !== "rtsp:" && returned.protocol !== "rtsps:") throw new OnvifError("Returned stream URI is not RTSP");
    derivedHost = returned.hostname;
    candidates.push({ uri: options.returnedUri, source: "onvif", label: "camera-reported" });
  }
  if (options.includeMeariFallbacks !== true) return candidates;
  const host = options.host ?? derivedHost;
  if (host === undefined || host.trim() === "") throw new OnvifError("A host is required for Meari RTSP fallback probes");
  if ((options.username === undefined) !== (options.password === undefined)) {
    throw new OnvifError("Both username and password are required when RTSP credentials are supplied");
  }
  for (const fallback of MEARI_RTSP_FALLBACKS) {
    const uri = new URL(`rtsp://${host}:${fallback.port}${fallback.path}`);
    if (options.username !== undefined && options.password !== undefined) {
      uri.username = options.username;
      uri.password = options.password;
    }
    const serialized = uri.toString();
    if (candidates.some((candidate) => candidate.uri === serialized)) continue;
    candidates.push({ uri: serialized, source: "meari-fallback", label: fallback.label });
  }
  return candidates;
}

export function redactRtspUri(uri: string): string {
  const parsed = new URL(uri);
  if (parsed.username || parsed.password) {
    parsed.username = "redacted";
    parsed.password = "redacted";
  }
  return parsed.toString();
}

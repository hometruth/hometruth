export {
  MeariClient,
  MeariCloudClient,
  TkenProClient,
  TkenProCloudClient,
  createMeariClient,
  formatSn,
  normalizeIotValues,
} from "./client.ts";
export {
  APP_PROFILES,
  CLOUD_EDGE_PROFILE,
  CLOUDEDGE_PROFILE,
  DEFAULT_REDIRECT_URL,
  TKENPRO_PROFILE,
  TKENPRO_APP_PROFILE,
  resolveAppProfile,
} from "./profiles.ts";
export {
  DESTRUCTIVE_IOT_CODES,
  IOT_CODES,
  MEARI_IOT_CODES,
  PET3T_CONTROL_BY_ID,
  PET3T_CONTROL_CATALOG,
  PET3T_CONTROLS,
  RECORD_DURATION_OPTIONS,
  assertIotCode,
  decodeRecordDurationValue,
  defineSafeExtensionControl,
  encodeControlValue,
  encodeRecordDurationSeconds,
  getAvailableControls,
  getDeviceCapabilities,
  getSupportedControls,
  isDestructiveCode,
  supportsControlDefinition,
  supportsFeature,
} from "../../devices/treat-dispensers/tkenpro-2k-pet-camera-treat-dispenser/controls.ts";
export {
  decodeMeariSchedule,
  encodeMeariSchedule,
} from "./schedule-codecs.ts";
export type {
  MeariScheduleCodec,
  MeariScheduleEntryView,
  MeariScheduleView,
  MeariWeekday,
} from "./schedule-codecs.ts";
export {
  MEARI_ROI_CELL_COUNT,
  MEARI_ROI_HEIGHT,
  MEARI_ROI_HEX_LENGTH,
  MEARI_ROI_WIDTH,
  decodeMeariGridRegion,
  encodeMeariGridRegion,
} from "./region-codecs.ts";
export type { MeariGridRegionView } from "./region-codecs.ts";
export {
  MEARI_POLYGON_MAX_REGIONS,
  MEARI_POLYGON_POINT_COUNT,
  decodeMeariPolygonRegions,
  encodeMeariPolygonRegions,
} from "./polygon-region-codecs.ts";
export type {
  MeariPolygonPoint,
  MeariPolygonRegion,
  MeariPolygonRegionView,
} from "./polygon-region-codecs.ts";
export {
  DestructiveControlError,
  DeviceOfflineError,
  MeariApiError,
  MeariAuthError,
  MeariError,
  MeariSessionError,
} from "./errors.ts";
export {
  aesDecrypt,
  aesEncrypt,
  encodeUserAccount,
  encryptPassword,
  hmacSha1Base64,
  md5Hex,
  padBase64,
} from "./crypto.ts";
export {
  decryptMeariMediaPayload,
  deriveMeariVideoKey,
  findMeariVideoEncryptionOffset,
} from "./media-crypto.ts";
export type {
  MeariMediaDecryptOptions,
  MeariVideoCodec,
} from "./media-crypto.ts";
export {
  buildMeariIotSettingsRequest,
  decodeMeariRoutedFragmentInfo,
  decodeMeariRoutedPayload,
  decodeMsgSvrFrame,
  encodeMeariLanConnectFrame,
  encodeMeariRoutedPayload,
  encodeMeariRoutedPayloads,
  encodeMsgSvrFrame,
  MSGSVR_COMMANDS,
  MSGSVR_DEFAULT_TYPE,
  MSGSVR_MAGIC,
  MSGSVR_METHODS,
  MSGSVR_NODES,
  MSGSVR_TAIL,
  MeariRoutedPayloadAssembler,
  msgSvrFrameByteLength,
  splitMsgSvrFrames,
} from "./msgsvr.ts";
export {
  MeariLocalCloudRuntime,
  localAddressForMeariCameras,
} from "./local-cloud-runtime.ts";
export type { MeariLocalCloudRuntimeOptions } from "./local-cloud-runtime.ts";
export {
  MeariLocalPeerClient,
  meariPeerCandidates,
  selectMeariPeerCandidate,
} from "./local-peer-client.ts";
export type {
  MeariLocalPeerClientOptions,
  MeariLocalPeerEvent,
  MeariLocalPeerRequestOptions,
} from "./local-peer-client.ts";
export { MeariLocalTalkbackClient } from "./local-talkback-client.ts";
export type {
  MeariLocalTalkbackClientOptions,
  MeariLocalTalkbackEvent,
  MeariLocalTalkbackStartOptions,
} from "./local-talkback-client.ts";
export { MeariLocalPlaybackClient } from "./local-playback-client.ts";
export type {
  MeariLocalPlaybackClientOptions,
  MeariLocalPlaybackEvent,
  MeariLocalPlaybackStartOptions,
} from "./local-playback-client.ts";
export {
  PPCS_ACK_MAGIC,
  PPCS_CHANNEL_COUNT,
  PPCS_FRAME_MAGIC,
  PPCS_FRAME_MARKER,
  PPCS_FRAME_PREFIX_SIZE,
  PPCS_MAX_ACK_ENTRIES,
  PPCS_MAX_PAYLOAD,
  decodePpcsChannelAckFrame,
  decodePpcsChannelFrame,
  encodePpcsChannelAckFrame,
  encodePpcsChannelFrame,
  PpcsChannelMux,
  PpcsChannelStreamFramer,
} from "./ppcs-channel.ts";
export type {
  ParsedPpcsChannelFrame,
  PpcsChannelFrameInput,
} from "./ppcs-channel.ts";
export {
  PpcsProtectedChannelCodec,
} from "./ppcs-protected-channel.ts";
export type { PpcsProtectedPacket } from "./ppcs-protected-channel.ts";
export {
  PPCS_KEY_BYTES,
  PPCS_OUTER_HEADER_SIZE,
  PPCS_OUTER_MARKER,
  decodePpcsHostProtectedPayload,
  decodePpcsOuterPacket,
  encodePpcsHostProtectedPayload,
  encodePpcsOuterPacket,
  ppcsChecksum,
} from "./ppcs-protection.ts";
export {
  decodePpcsConnectionMessage,
  encodePpcsConnectionMessage,
  protectPpcsConnectionMessage,
  unprotectPpcsConnectionMessage,
} from "./ppcs-connection.ts";
export type {
  ParsedPpcsConnectionMessage,
  PpcsConnectionMessage,
  PpcsConnectionMessage20,
  PpcsConnectionMessage53,
  PpcsConnectionMessage54,
  PpcsConnectionMessage56,
  PpcsConnectionMessage67,
  PpcsConnectionMessage6a,
  PpcsConnectionMessage80,
  PpcsConnectionMessageKind,
  PpcsConnectionProtection,
  PpcsConnectionTarget,
} from "./ppcs-connection.ts";
export {
  PPCS_DEFAULT_AUTH_MODE,
  PPCS_DEFAULT_DELAY_SECONDS,
  PPCS_DEFAULT_FACTORY,
  PPCS_DEFAULT_INIT_STRING,
  PPCS_DEFAULT_MODE,
  PPCS_DEFAULT_TRY_TIMES,
  PPCS_DEFAULT_UDP_PORT,
  buildPpcsLoginData,
  encodePpcsLoginData,
  parsePpcsTargetId,
  ppcsLicenceIdFromSerial,
  ppcsUuidFromSerial,
} from "./ppcs-login.ts";
export type {
  PpcsLoginData,
  PpcsLoginDataOptions,
  PpcsLoginValue,
  PpcsTargetId,
} from "./ppcs-login.ts";
export {
  buildMeariCommonHttpRequest,
  buildVvpCommandAuth,
  decodeVvpCommandFrame,
  encodeVvpCommandFrame,
  formatMeariLicenceId,
  parseMeariHttpResponse,
  VVP_COMMAND_HEADER_SIZE,
  VVP_COMMAND_REQUEST,
  VVP_COMMAND_RESPONSE,
  VVP_NATIVE_MAGIC,
  VVP_WIRE_MAGIC,
} from "./p2p-command.ts";
export type {
  BuildMeariHttpRequestOptions,
  MeariCommonRequest,
  ParsedMeariHttpResponse,
  ParsedVvpCommandFrame,
  VvpCommandAuth,
  VvpCommandFrameOptions,
} from "./p2p-command.ts";
export {
  buildVvpStreamAuth,
  decodeVvpStreamControlFrame,
  encodeVvpStreamControlFrame,
  VVP_STREAM_AUTO_ID,
  VVP_STREAM_CLOUDEDGE_FLAG,
  VVP_STREAM_HEADER_SIZE,
  VVP_STREAM_HEARTBEAT,
  VVP_STREAM_MAGIC,
  VVP_STREAM_PARAMETER,
  VVP_STREAM_START_LIVE,
  VVP_STREAM_START_VOICE,
  VVP_STREAM_STOP_LIVE,
  VVP_STREAM_STOP_VOICE,
  VVP_STREAM_VOICE_CHANNEL,
  VVP_STREAM_VERSION,
} from "./vvp-stream.ts";
export {
  decodeVvpVoicePacket,
  encodeMuLaw,
  encodeVvpVoicePacket,
  pcm16ToMuLaw,
  VVP_VOICE_FRAME_TYPE,
  VVP_VOICE_HEADER_SIZE,
  VVP_VOICE_LEGACY_HEADER_SIZE,
  VVP_VOICE_MAX_SAMPLES,
  VVP_VOICE_MEDIA_TYPE,
  VVP_VOICE_MODE,
  type ParsedVvpVoicePacket,
  type VvpVoicePacketOptions,
} from "./vvp-voice.ts";
export type {
  ParsedVvpStreamControlFrame,
  VvpStreamControlOptions,
} from "./vvp-stream.ts";
export {
  decodeVvpMediaFrame,
  decodeVvpMediaHeader,
  vvpMediaCodec,
  vvpMediaKind,
  VVP_FRAME_FORMAT_AAC,
  VVP_FRAME_FORMAT_G711_ALAW,
  VVP_FRAME_FORMAT_G711_MULAW,
  VVP_FRAME_FORMAT_H264,
  VVP_FRAME_FORMAT_H265,
  VVP_FRAME_FORMAT_PCM,
  VVP_MEDIA_HEADER_SIZE,
  VVP_MEDIA_LEGACY_HEADER_SIZE,
  VVP_MEDIA_MAX_PAYLOAD_SIZE,
  VVP_MEDIA_TYPE_AUDIO,
  VVP_MEDIA_TYPE_VIDEO_DELTA,
  VVP_MEDIA_TYPE_VIDEO_KEY,
  VvpMediaStreamFramer,
} from "./vvp-media.ts";
export type {
  ParsedVvpMediaFrame,
  ParsedVvpMediaHeader,
  VvpMediaCodec,
  VvpMediaHeaderOptions,
  VvpMediaKind,
} from "./vvp-media.ts";
export {
  decodeXtsMediaFrame,
  isXtsMediaMessage,
  XTS_MEDIA_TYPE_AUDIO,
  XTS_MEDIA_TYPE_INFO,
  XTS_MEDIA_TYPE_PHOTO,
  XTS_MEDIA_TYPE_VIDEO_DELTA,
  XTS_MEDIA_TYPE_VIDEO_KEY,
  xtsMediaEnvelopeHeaderSize,
  xtsMediaType,
} from "./xts-media.ts";
export type {
  ParsedXtsMediaFrame,
  XtsMediaType,
} from "./xts-media.ts";
export {
  decodeVvpPlaybackResponse,
  encodeVvpPlaybackPauseFrame,
  encodeVvpPlaybackResumeFrame,
  encodeVvpPlaybackSeekFrame,
  encodeVvpPlaybackStartFrame,
  encodeVvpPlaybackStopFrame,
  formatVvpPlaybackTimestamp,
  parseVvpPlaybackTimestamp,
  VVP_PLAYBACK_ACTION_PAUSE,
  VVP_PLAYBACK_ACTION_SEEK,
  VVP_PLAYBACK_ACTION_START,
  VVP_PLAYBACK_ACTION_STOP_OR_RESUME,
  VVP_PLAYBACK_COMMAND,
  VVP_PLAYBACK_PAYLOAD_SIZE,
  VVP_PLAYBACK_RESPONSE,
  VVP_PLAYBACK_RESPONSE_SIZE,
  type ParsedVvpPlaybackResponse,
  type VvpPlaybackFrameOptions,
  type VvpPlaybackTimestamp,
} from "./vvp-playback.ts";
export type {
  MeariIotSettingsRequest,
  MeariRouteContact,
  MeariRoutedFragmentInfo,
  MeariRoutedFragmentOptions,
  MeariRoutedMessage,
  MsgSvrFrame,
  MsgSvrFrameInput,
} from "./msgsvr.ts";
export { MeariLocalCloudEmulator } from "./cloud-emulator.ts";
export type {
  MeariCameraRegistration,
  MeariLocalCloudEmulatorOptions,
  MeariLocalCloudEvent,
  MeariLocalRoutedRequestOptions,
  MeariRegistrationAuthorizer,
} from "./cloud-emulator.ts";
export {
  MEARI_LOCAL_CAPABILITY_FLAG_NAMES,
  MeariLocalCloudAuthStore,
  createMeariRegistrationAuthorizer,
  sanitizeMeariLocalCapabilityFlags,
} from "./local-cloud-auth.ts";
export {
  MeariLocalCloudStateStore,
  persistableMeariIotState,
} from "./local-cloud-state.ts";
export type {
  MeariLocalCameraStateEntry,
  MeariLocalCameraStateFile,
} from "./local-cloud-state.ts";
export {
  MeariLocalRootDiscoveryServer,
  buildMeariLocalRootDiscoveryResponse,
} from "./root-emulator.ts";
export type {
  MeariLocalRootContact,
  MeariLocalRootDiscoveryServerOptions,
} from "./root-emulator.ts";
export type {
  MeariLocalCameraAuthorization,
  MeariLocalCloudAuthorizationFile,
  MeariLocalPeerAuthorization,
} from "./local-cloud-auth.ts";
export {
  MeariLocalWebRtcRelayServer,
  decodeMeariWebRtcRelayConnect,
  encodeMeariWebRtcRelayAccepted,
} from "./webrtc-relay.ts";
export type {
  MeariLocalWebRtcRelayServerOptions,
  MeariWebRtcRelayConnect,
} from "./webrtc-relay.ts";
export {
  decodeIvaFrame,
  decodeKcpSegments,
  encodeIvaData,
  encodeIvaFrame,
  encodeIvaHandshake,
  encodeKcpSegment,
  IVA_HEADER_SIZE,
  IVA_TYPE_DATA,
  IVA_TYPE_HANDSHAKE,
  KCP_COMMAND_ACK,
  KCP_COMMAND_PUSH,
  KCP_COMMAND_WINDOW_ASK,
  KCP_COMMAND_WINDOW_SIZE,
  KCP_HEADER_SIZE,
  MEARI_KCP_CONVERSATION,
  MEARI_KCP_MSS,
  MEARI_KCP_RECEIVE_WINDOW,
  MeariKcpTunnel,
} from "./kcp-tunnel.ts";
export type {
  IvaFrameInput,
  KcpSegmentInput,
  MeariKcpTunnelOptions,
  MeariTunnelEvent,
  ParsedIvaFrame,
  ParsedKcpSegment,
} from "./kcp-tunnel.ts";
export {
  decodeStunMessage,
  encodeIceBindingRequest,
  encodeIceBindingSuccess,
  encodeStunAttribute,
  encodeStunMessage,
  STUN_ATTRIBUTES,
  STUN_BINDING_REQUEST,
  STUN_BINDING_SUCCESS,
  STUN_HEADER_SIZE,
  STUN_MAGIC_COOKIE,
  verifyStunMessageIntegrity,
} from "./ice.ts";
export type {
  IceBindingRequestOptions,
  ParsedStunAttribute,
  ParsedStunMessage,
  StunAttributeInput,
} from "./ice.ts";
export { MeariPeerCommandSession } from "./peer-command-session.ts";
export type {
  MeariPeerCommandResponse,
  MeariPeerCommandSessionOptions,
  MeariPeerRequest,
  MeariPeerSessionEvent,
} from "./peer-command-session.ts";
export {
  buildMeariOffer,
  buildMeariLanOffer,
  decodeMeariRootDiscoveryResponse,
  discoverMeariSignaling,
  discoverMeariSignalingCandidates,
  encodeMeariRootDiscoveryQuery,
  formatMeariDeviceUuid,
  MEARI_DEFAULT_PLATFORM_DOMAINS,
  MEARI_ROOT_DISCOVERY_PORT,
  MEARI_ROOT_DISCOVERY_VERSION,
  meariClientUuid,
  MeariMsgSvrTcpTransport,
  MeariSignalingClient,
  parseMeariSdp,
} from "./signaling.ts";
export type {
  DiscoverMeariSignalingOptions,
  MeariIceCandidate,
  MeariLanOffer,
  MeariOfferOptions,
  MeariRootDiscoveryOptions,
  MeariRootDiscoveryResponse,
  MeariSignalContact,
  MeariSignalingClientOptions,
  MeariSignalingRegisterOptions,
  MeariSignalingTransport,
  MeariWebRtcServer,
  ParsedMeariSdp,
} from "./signaling.ts";
export {
  decodeTurnXorAddress,
  encodeTurnXorAddress,
  MeariTurnClient,
  TURN_ATTRIBUTES,
  TURN_MESSAGES,
} from "./turn.ts";
export type {
  MeariTurnAddress,
  MeariTurnAllocation,
  MeariTurnClientOptions,
  MeariTurnPacket,
} from "./turn.ts";
export { MeariLocalTurnServer } from "./turn-server.ts";
export type {
  MeariLocalTurnCredential,
  MeariLocalTurnServerOptions,
} from "./turn-server.ts";
export {
  BunDatagramTransport,
  CAMERA_PROBE_PORTS,
  bunPortProbe,
  createMeariLanSearch,
  createSsdpSearch,
  createWsDiscoveryProbe,
  dedupeDiscoveryObservations,
  discoverCameras,
  enumeratePrivateCidr,
  isLocalProbeHost,
  parseMeariLanResponse,
  parseSsdpResponse,
  parseWsDiscoveryResponse,
} from "./discovery.ts";
export {
  MEARI_RTSP_FALLBACKS,
  OnvifClient,
  OnvifError,
  buildRtspCandidates,
  createDigestAuthorization,
  createUsernameToken,
  parseWwwAuthenticate,
  redactRtspUri,
} from "../onvif/client.ts";

export type {
  CapabilityFeature,
  ControlAccess,
  ControlCategory,
  ControlDefinition,
  ControlKind,
  ControlOption,
  ControlSafety,
  IotCodeName,
  KnownIotCode,
  SafeExtensionControl,
} from "../../devices/treat-dispensers/tkenpro-2k-pet-camera-treat-dispenser/controls.ts";
export type {
  AppProfileName,
  DestructiveConfirmation,
  DeviceStatus,
  FeedPortions,
  FeedSchedule,
  FeedScheduleEntry,
  FetchLike,
  IotValue,
  IotValues,
  IotWriteOptions,
  JsonPrimitive,
  JsonValue,
  MeariAppProfile,
  MeariClientConfig,
  MeariClientDependencies,
  MeariClock,
  MeariCredentials,
  MeariDevice,
  MeariLoginResult,
  MeariRandomSource,
  MeariSession,
  OnvifConfiguration,
  PtzDirection,
  PtzMoveOptions,
  PtzPreset,
  SleepLike,
  StorageInfo,
  TimeRange,
  Weekday,
} from "./types.ts";
export type {
  CameraProbePort,
  DatagramExchange,
  DatagramReply,
  DatagramTransport,
  DiscoverCameraOptions,
  DiscoveredCamera,
  DiscoveryDependencies,
  DiscoveryObservation,
  DiscoveryReport,
  DiscoverySource,
  PortProbe,
} from "./discovery.ts";
export type {
  HttpAuthChallenge,
  NumericRange,
  OnvifAuthMode,
  OnvifBacklightCompensation,
  OnvifCapabilities,
  OnvifClientConfig,
  OnvifClientDependencies,
  OnvifDeviceInformation,
  OnvifExposureSettings,
  OnvifFetch,
  OnvifFocusSettings,
  OnvifImagingOptions,
  OnvifImagingSettings,
  OnvifImagingSettingsPatch,
  OnvifMediaUri,
  OnvifPanTiltVector,
  OnvifPreset,
  OnvifProfile,
  OnvifPtzNode,
  OnvifPtzSpeed,
  OnvifPtzStatus,
  OnvifPtzVector,
  OnvifService,
  OnvifServiceKind,
  OnvifServiceUrls,
  OnvifStreamOptions,
  OnvifVideoEncoderConfiguration,
  OnvifWhiteBalance,
  OnvifWideDynamicRange,
  OnvifZoomVector,
  RtspCandidate,
  RtspCandidateOptions,
} from "../onvif/client.ts";

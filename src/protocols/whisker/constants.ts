/**
 * Every Whisker (Litter-Robot) wire constant in one place, so a change on
 * Whisker's side is a one-file edit.
 *
 * None of these are published by Whisker. They are the values the
 * open-source `pylitterbot` library (used by Home Assistant's `litterrobot`
 * integration) sends, transcribed from memory of that library and NOT
 * verified against the live service by this code's tests. If login or a
 * query starts failing, compare this file against the current pylitterbot
 * source first.
 */

/** AWS region of Whisker's Cognito user pool. */
export const WHISKER_COGNITO_REGION = "us-east-1";

/** Whisker's Cognito user pool (pylitterbot ships it base64-encoded). Informational: InitiateAuth needs only the client id. */
export const WHISKER_COGNITO_USER_POOL_ID = "us-east-1_rjhNnZVAm";

/** The Whisker app's public Cognito app client id (no client secret). */
export const WHISKER_COGNITO_CLIENT_ID = "4552ujeu3aic90nf8qn53levmn";

/** Cognito's documented JSON endpoint for the region above. */
export const WHISKER_COGNITO_ENDPOINT = `https://cognito-idp.${WHISKER_COGNITO_REGION}.amazonaws.com/`;

/**
 * The ID-token claim that carries the Whisker user id the LR4 API is keyed
 * by. pylitterbot reads `mid`; `sub` is the Cognito subject and is only used
 * when `mid` is absent.
 */
export const WHISKER_USER_ID_CLAIM = "mid";

/** The Litter-Robot 4 GraphQL endpoint; `Authorization: Bearer <id token>`. */
export const LR4_GRAPHQL_ENDPOINT = "https://lr4.iothings.site/graphql";

/** What HomeTruth reports as the command source; pylitterbot sends its own name here. */
export const LR4_COMMAND_SOURCE = "hometruth";

/** `sendLitterRobot4Command` command names. */
export const LR4_COMMANDS = {
  cleanCycle: "cleanCycle",
  shortResetPress: "shortResetPress",
  nightLightModeOn: "nightLightModeOn",
  nightLightModeOff: "nightLightModeOff",
  nightLightModeAuto: "nightLightModeAuto",
  keyPadLockOutOn: "keyPadLockOutOn",
  keyPadLockOutOff: "keyPadLockOutOff",
  setClumpTime: "setClumpTime",
} as const;
export type Lr4Command = typeof LR4_COMMANDS[keyof typeof LR4_COMMANDS];

/**
 * The robot fields HomeTruth reads: a deliberately small subset of
 * pylitterbot's LR4 model fragment. GraphQL rejects the whole query when one
 * field is unknown, so add a field only when something reads it.
 */
export const LR4_ROBOT_FIELDS = [
  "unitId",
  "name",
  "serial",
  "espFirmware",
  "unitPowerType",
  "robotStatus",
  "catWeight",
  "cleanCycleWaitTime",
  "isKeypadLockout",
  "nightLightMode",
  "isNightLightLEDOn",
  "sleepStatus",
  "DFILevelPercent",
  "isDFIFull",
  "litterLevelPercentage",
  "litterLevelState",
  "isHopperRemoved",
  "isOnline",
  "lastSeen",
] as const;

export const LR4_ROBOTS_QUERY = `query GetLR4($userId: String!) {
  getLitterRobot4ByUser(userId: $userId) {
    ${LR4_ROBOT_FIELDS.join("\n    ")}
  }
}`;

export const LR4_COMMAND_MUTATION = `mutation sendCommand($serial: String!, $command: String!, $value: String, $commandSource: String) {
  sendLitterRobot4Command(input: {serial: $serial, command: $command, value: $value, commandSource: $commandSource})
}`;

/** `robotStatus` values and what each means, as pylitterbot maps them. */
export const LR4_ROBOT_STATUS = {
  ROBOT_IDLE: { code: "RDY", text: "Ready" },
  ROBOT_CLEAN: { code: "CCP", text: "Clean cycle in progress" },
  ROBOT_FIND_DUMP: { code: "CCP", text: "Clean cycle in progress" },
  ROBOT_CAT_DETECT: { code: "CD", text: "Cat detected" },
  ROBOT_CAT_DETECT_DELAY: { code: "CST", text: "Cat sensor timing" },
  ROBOT_BONNET: { code: "BR", text: "Bonnet removed" },
  ROBOT_POWER_UP: { code: "PWRU", text: "Powering up" },
  ROBOT_POWER_DOWN: { code: "PWRD", text: "Powering down" },
  ROBOT_POWER_OFF: { code: "OFF", text: "Off" },
} as const satisfies Record<string, { code: string; text: string }>;

/** Clean-cycle wait times the LR4 accepts, in minutes. */
export const LR4_CLEAN_CYCLE_WAIT_MINUTES = [3, 7, 15, 25, 30] as const;

/**
 * Synthetic IQ Gateway responses in the documented shapes, for tests. A
 * split-phase system with production and net-consumption CTs, 30
 * microinverters, 6 IQ Batteries and one IQ System Controller. Serials,
 * addresses and readings are invented.
 */

export const SERIAL = "202500000001";
export const HOST = "192.168.50.60";

export const INFO_XML = `<?xml version='1.0' encoding='UTF-8'?>
<envoy_info>
  <time>1761730000</time>
  <device>
    <sn>${SERIAL}</sn>
    <pn>800-00654-r08</pn>
    <software>D8.2.4499</software>
    <euaid>4c8675</euaid>
    <seqnum>0</seqnum>
    <apiver>1</apiver>
    <imeter>true</imeter>
  </device>
  <web-tokens>true</web-tokens>
  <package pkgname='app'><pn>500-00002-r01</pn><version>08.02.4499</version><build>2025-01-01</build></package>
</envoy_info>
`;

const READ_AT = 1761730000;

const line = (wNow: number, whToday: number, whLifetime: number) => ({
  wNow, whLifetime, varhLeadLifetime: 0, varhLagLifetime: 0, vahLifetime: whLifetime * 1.1,
  rmsCurrent: Math.abs(wNow) / 120, rmsVoltage: 121.3, reactPwr: 12.5, apprntPwr: Math.abs(wNow) * 1.02, pwrFactor: 0.98,
  whToday, whLastSevenDays: whToday * 7, vahToday: whToday * 1.1, varhLeadToday: 0, varhLagToday: 0,
});

export const PRODUCTION = {
  production: [
    { type: "inverters", activeCount: 30, readingTime: READ_AT - 120, wNow: 6012, whLifetime: 41_250_000 },
    {
      type: "eim", activeCount: 1, measurementType: "production", readingTime: READ_AT,
      wNow: 6123.4, whLifetime: 41_387_512.6, varhLeadLifetime: 0.1, varhLagLifetime: 4_100_000, vahLifetime: 46_000_000,
      rmsCurrent: 50.2, rmsVoltage: 242.6, reactPwr: 250.1, apprntPwr: 6200.3, pwrFactor: 0.99,
      whToday: 18_456.8, whLastSevenDays: 190_123, vahToday: 19_800, varhLeadToday: 0, varhLagToday: 1_200,
      lines: [line(3061.7, 9228.4, 20_693_756.3), line(3061.7, 9228.4, 20_693_756.3)],
    },
  ],
  consumption: [
    {
      type: "eim", activeCount: 1, measurementType: "total-consumption", readingTime: READ_AT,
      wNow: 3376.2, whLifetime: 30_123_456.7, varhLeadLifetime: 0, varhLagLifetime: 0, vahLifetime: 33_000_000,
      rmsCurrent: 15.4, rmsVoltage: 242.6, reactPwr: -300.2, apprntPwr: 1900.1, pwrFactor: 0.97,
      whToday: 12_034.5, whLastSevenDays: 80_000, vahToday: 13_000, varhLeadToday: 0, varhLagToday: 0,
      lines: [line(1688.1, 6017.2, 15_061_728.3), line(1688.1, 6017.3, 15_061_728.4)],
    },
    {
      type: "eim", activeCount: 1, measurementType: "net-consumption", readingTime: READ_AT,
      wNow: -2747.2, whLifetime: -11_264_055.9, varhLeadLifetime: 0, varhLagLifetime: 0, vahLifetime: 0,
      rmsCurrent: 35.1, rmsVoltage: 242.6, reactPwr: -550.3, apprntPwr: 4300.2, pwrFactor: -0.98,
      whToday: 0, whLastSevenDays: 0, vahToday: 0, varhLeadToday: 0, varhLagToday: 0,
      lines: [line(-1373.6, 0, -5_632_027.9), line(-1373.6, 0, -5_632_028)],
    },
  ],
  storage: [{ type: "acb", activeCount: 0, readingTime: 0, wNow: 0, whNow: 0, state: "idle" }],
};

/** A gateway with no CTs: production comes from the microinverters and there is no consumption. */
export const PRODUCTION_WITHOUT_METERS = {
  production: [
    { type: "inverters", activeCount: 30, readingTime: READ_AT - 120, wNow: 6012, whLifetime: 41_250_000 },
    { type: "eim", activeCount: 0, measurementType: "production", readingTime: READ_AT, wNow: 0, whLifetime: 0, whToday: 0 },
  ],
  consumption: [
    { type: "eim", activeCount: 0, measurementType: "total-consumption", readingTime: READ_AT, wNow: 0, whLifetime: 0, whToday: 0 },
    { type: "eim", activeCount: 0, measurementType: "net-consumption", readingTime: READ_AT, wNow: 0, whLifetime: 0, whToday: 0 },
  ],
  storage: [{ type: "acb", activeCount: 0, readingTime: 0, wNow: 0, whNow: 0, state: "idle" }],
};

export const inverterSerial = (index: number) => `1221${String(index + 1).padStart(8, "0")}`;

export const INVERTERS = Array.from({ length: 30 }, (_, index) => ({
  serialNumber: inverterSerial(index),
  lastReportDate: READ_AT - 60 - index,
  devType: 1,
  lastReportWatts: 200 + index,
  maxReportWatts: 295,
}));

export const batterySerial = (index: number) => `4822${String(index + 1).padStart(8, "0")}`;
export const CONTROLLER_SERIAL = "482300000001";

const encharge = (index: number, percentFull: number) => ({
  part_num: "836-00750-r27", installed: 1_700_000_000, serial_num: batterySerial(index),
  device_status: ["envoy.global.ok", "prop.done"], last_rpt_date: READ_AT - 30, admin_state: 6, admin_state_str: "ENCHG_STATE_IDLE",
  created_date: 1_700_000_000, img_load_date: 1_700_000_000, img_pnum_running: "2.6.5973_rel/22.11",
  zigbee_dongle_fw_version: "100F", bmu_fw_version: "2.1.34", operating: true, communicating: true, sleep_enabled: false,
  percentFull, temperature: 24, maxCellTemp: 25, comm_level_sub_ghz: 4, comm_level_2_4_ghz: 4, led_status: 17,
  dc_switch_off: false, encharge_rev: 2, encharge_capacity: 3360, phase: index % 2 ? "ph-b" : "ph-a", der_index: index + 1,
});

export const inventory = (mainsOperState: "closed" | "open" = "closed") => [
  { type: "ENCHARGE", devices: [80, 81, 82, 83, 84, 86].map((percent, index) => encharge(index, percent)) },
  {
    type: "ENPOWER", devices: [{
      part_num: "860-00276-r28", installed: 1_700_000_000, serial_num: CONTROLLER_SERIAL,
      device_status: ["envoy.global.ok", "prop.done"], last_rpt_date: READ_AT - 15, admin_state: 24, admin_state_str: "ENPWR_STATE_OPER_CLOSED",
      created_date: 1_700_000_000, img_load_date: 1_700_000_000, img_pnum_running: "1.2.2064_release/20.34",
      communicating: true, temperature: 30, comm_level_sub_ghz: 5, comm_level_2_4_ghz: 5,
      mains_admin_state: "closed", mains_oper_state: mainsOperState,
      Enpwr_grid_mode: mainsOperState === "closed" ? "multimode-ongrid" : "multimode-offgrid",
      Enchg_grid_mode: mainsOperState === "closed" ? "multimode-ongrid" : "multimode-offgrid",
      Enpwr_relay_state_bm: 496, Enpwr_curr_state_id: 16,
    }],
  },
  { type: "IQ_METER_COLLAR", devices: [] },
];

export const SECCTRL = {
  shutdown: false, freq_bias_hz: 0, voltage_bias_v: 0, freq_bias_hz_q8: 0, voltage_bias_v_q5: 0,
  configured_backup_soc: 20, adjusted_backup_soc: 20,
  agg_soc: 82, Max_energy: 20160, ENC_agg_soc: 82, ENC_agg_soh: 100, ENC_agg_backup_energy: 4032, ENC_agg_avail_energy: 16531,
  Enc_commissioned_capacity: 20160, Enc_max_available_capacity: 20160, ACB_agg_soc: 0, ACB_agg_energy: 0,
  VLS_Limit: 0, ENC_charge_rate: 0,
};

/** Note the firmware's own `devices:` key. Positive milliwatts: discharging. */
export const ENSEMBLE_POWER = {
  "devices:": Array.from({ length: 6 }, (_, index) => ({
    serial_num: batterySerial(index), real_power_mw: -250_000, apparent_power_mva: 260_000, soc: 82,
  })),
};

const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** A JWT-shaped owner token with an `exp`; the signature is filler. */
export function ownerToken(expSeconds = 1_893_456_000, jti = "00000000-0000-4000-8000-000000000001"): string {
  return [
    base64url({ kid: "synthetic", typ: "JWT", alg: "ES256" }),
    base64url({ aud: SERIAL, iss: "Entrez", enphaseUser: "owner", exp: expSeconds, iat: expSeconds - 31_536_000, jti, username: "owner@example.com" }),
    "c3ludGhldGljLXNpZ25hdHVyZQ",
  ].join(".");
}

import { BOSCH_NITP060UC, COOKTOP_CHILD_LOCK } from "./devices/appliances/bosch-nitp060uc";
import { GOVEE_H7021, GOVEE_H7021_BULB } from "./devices/string-lights/govee-h7021";
import { HUE_LIGHT } from "./devices/lights/hue-light";
import { HUE_MOTION_SENSOR, HUE_SWITCH } from "./devices/sensors/hue-accessory";
import { AQARA_HUB_M2 } from "./devices/hubs/aqara-hub-m2";
import { AIRGRADIENT_ONE } from "./devices/sensors/airgradient-one";
import { GOVEE_H5075 } from "./devices/sensors/govee-h5075";
import { ESP32_NRF24_BRIDGE } from "./devices/radio/esp32-nrf24-bridge";
import { AQARA_PRESENCE_SENSOR_FP2 } from "./devices/sensors/aqara-presence-sensor-fp2";
import { AQARA_DOOR_WINDOW_SENSOR } from "./devices/sensors/aqara-door-window-sensor";
import { RING_BRIDGE } from "./devices/hubs/ring-bridge";
import { RING_SMART_LIGHT } from "./devices/lights/ring-smart-light";
/**
 * Every device model HomeTruth can provision. Adding a product is adding one
 * folder under `src/devices/` and one line here; there is no discovery.
 */
import { BROADLINK_RM4_PRO } from "./devices/blasters/broadlink-rm4-pro";
import { ELGATO_KEY_LIGHT_AIR } from "./devices/lights/elgato-key-light-air";
import { HUE_ENTERTAINMENT_LIGHT } from "./devices/lights/hue-entertainment";
import { WYZE_CAM_V3 } from "./devices/cameras/wyze-cam-v3";
import { RTSP_CAMERA } from "./devices/cameras/rtsp-camera";
import { TACTACAM_REVEAL } from "./devices/cameras/tactacam-reveal";
import { SHELLY_PLUS_1 } from "./devices/switches/shelly-plus-1";
import { LUTRON_CASETA_DIMMER, LUTRON_CASETA_SWITCH } from "./devices/switches/lutron-caseta";
import { SAMSUNG_FRAME } from "./devices/televisions/samsung-frame";
import { SONOS } from "./devices/speakers/sonos";
import { SONOS_GROUP } from "./devices/speakers/sonos-group";
import { TKENPRO_2K_PET_CAMERA_TREAT_DISPENSER } from "./devices/treat-dispensers/tkenpro-2k-pet-camera-treat-dispenser";
import { LIGHT_GROUP } from "./devices/composites/light-group";
import { SYNTHETIC_SWITCH } from "./devices/composites/synthetic-switch";
import { ACTION_BUTTON } from "./devices/composites/action-button";
import { WORKFLOW_BUTTON } from "./devices/composites/workflow-button";
import { OPTIMISTIC_SWITCH } from "./devices/composites/optimistic-switch";
import type { DeviceModel } from "./models/device";

export const MODELS: readonly DeviceModel[] = [
  BOSCH_NITP060UC,
  COOKTOP_CHILD_LOCK,
  TKENPRO_2K_PET_CAMERA_TREAT_DISPENSER,
  SHELLY_PLUS_1,
  LUTRON_CASETA_SWITCH,
  LUTRON_CASETA_DIMMER,
  ELGATO_KEY_LIGHT_AIR,
  HUE_ENTERTAINMENT_LIGHT,
  HUE_LIGHT,
  HUE_MOTION_SENSOR,
  HUE_SWITCH,
  BROADLINK_RM4_PRO,
  ESP32_NRF24_BRIDGE,
  WYZE_CAM_V3,
  RTSP_CAMERA,
  TACTACAM_REVEAL,
  SONOS,
  SONOS_GROUP,
  SAMSUNG_FRAME,
  LIGHT_GROUP,
  SYNTHETIC_SWITCH,
  ACTION_BUTTON,
  WORKFLOW_BUTTON,
  OPTIMISTIC_SWITCH,
  AQARA_HUB_M2,
  AQARA_PRESENCE_SENSOR_FP2,
  AQARA_DOOR_WINDOW_SENSOR,
  RING_BRIDGE,
  RING_SMART_LIGHT,
  AIRGRADIENT_ONE,
  GOVEE_H5075,
  GOVEE_H7021,
  GOVEE_H7021_BULB,
];

export function modelById(id: string): DeviceModel | undefined {
  return MODELS.find((model) => model.id === id);
}

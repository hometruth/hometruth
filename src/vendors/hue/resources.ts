/** Fields used from CLIP v2 resources; resource ids identify services, owner ids physical devices. */
export interface HueResource {
  id: string;
  type: string;
  owner?: { rid: string; rtype: string };
  metadata?: { name?: string; control_id?: number };
  product_data?: { product_name?: string; model_id?: string };
  services?: { rid: string; rtype: string }[];
  children?: { rid: string; rtype: string }[];
  on?: { on: boolean };
  dimming?: { brightness: number };
  color?: { xy: { x: number; y: number } };
  color_temperature?: { mirek: number | null; mirek_valid: boolean; mirek_schema: { mirek_minimum: number; mirek_maximum: number } };
  status?: string;
  enabled?: boolean;
  motion?: { motion: boolean; motion_valid: boolean; motion_report?: { changed: string; motion: boolean } };
  temperature?: { temperature: number; temperature_valid: boolean };
  light?: { light_level: number; light_level_valid: boolean };
  power_state?: { battery_level: number; battery_state: string };
  button?: { last_event?: string; button_report?: { updated: string; event: string } };
  relative_rotary?: { rotary_report?: { updated: string; action: string; rotation: { direction: string; steps: number; duration: number } } };
}

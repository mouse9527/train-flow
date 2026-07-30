const SETTINGS_SCHEMA_VERSION = 1;

const DEFAULT_USER_SETTINGS = Object.freeze({
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  vibrationEnabled: true,
  soundEnabled: true,
  voiceEnabled: false,
  keepScreenOn: true,
  defaultStartLocalTime: '08:35',
  recommendedEndLocalTime: '09:10',
  defaultRestSeconds: 75,
  timezone: 'Asia/Shanghai',
  cloudSyncEnabled: false,
  revision: 1
});

const SAFETY_NOTICE_CODES = Object.freeze({
  NO_MEDICAL_DIAGNOSIS: 'NO_MEDICAL_DIAGNOSIS',
  STOP_ON_ALARM_SYMPTOMS: 'STOP_ON_ALARM_SYMPTOMS',
  STAY_HYDRATED: 'STAY_HYDRATED'
});

const MIN_REST_SECONDS = 0;
const MAX_REST_SECONDS = 600;

module.exports = {
  SETTINGS_SCHEMA_VERSION,
  DEFAULT_USER_SETTINGS,
  SAFETY_NOTICE_CODES,
  MIN_REST_SECONDS,
  MAX_REST_SECONDS
};

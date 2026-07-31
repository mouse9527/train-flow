const { createAudioService } = require('./audio-service');

function callWxApi(wxApi, methodName, options = {}) {
  if (!wxApi || typeof wxApi[methodName] !== 'function') {
    return Promise.resolve({ supported: false });
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    try {
      wxApi[methodName]({
        ...options,
        success(value) { settle(resolve, { supported: true, value }); },
        fail(error) {
          settle(reject, error instanceof Error ? error : new Error(
            error && error.errMsg ? error.errMsg : `${methodName} unavailable`
          ));
        }
      });
    } catch (error) {
      settle(reject, error);
    }
  });
}

function createWechatDeviceAdapter({ wxApi, audioService, settings = {} } = {}) {
  const audio = audioService || createAudioService({ wxApi });
  const deliveredOccurrences = new Set();

  async function bestEffort(effect, failures) {
    try {
      const result = await effect();
      if (result && result.supported === false) {
        failures.push('unsupported');
      }
    } catch (error) {
      failures.push('unavailable');
    }
  }

  return {
    async notify({ occurrenceId, visualMessage, voiceText }) {
      if (typeof occurrenceId !== 'string' || occurrenceId.length === 0) {
        throw new TypeError('notification occurrenceId must be a non-empty string');
      }
      if (deliveredOccurrences.has(occurrenceId)) {
        return { delivered: true, duplicate: true, degraded: false };
      }
      deliveredOccurrences.add(occurrenceId);
      const failures = [];
      if (settings.vibrationEnabled) {
        await bestEffort(() => callWxApi(wxApi, 'vibrateLong'), failures);
      }
      if (settings.soundEnabled) {
        await bestEffort(() => audio.play(), failures);
      }
      if (settings.voiceEnabled) {
        await bestEffort(() => audio.speak(voiceText || visualMessage), failures);
      }
      await bestEffort(() => callWxApi(wxApi, 'showToast', {
        title: visualMessage || '训练提醒',
        icon: 'none'
      }), failures);
      return {
        delivered: true,
        duplicate: false,
        degraded: failures.length > 0,
        unavailableEffectCount: failures.length
      };
    },

    async setKeepScreen(enabled) {
      if (!settings.keepScreenOn && enabled) {
        return { supported: true, skipped: true };
      }
      try {
        return await callWxApi(wxApi, 'setKeepScreenOn', { keepScreenOn: Boolean(enabled) });
      } catch (error) {
        return { supported: false, errorCode: 'KEEP_SCREEN_UNAVAILABLE' };
      }
    },

    destroy() {
      if (audio && typeof audio.destroy === 'function') {
        audio.destroy();
      }
    }
  };
}

module.exports = { callWxApi, createWechatDeviceAdapter };

function createAudioService({ wxApi, source = '/assets/workout-notification.mp3' } = {}) {
  let context = null;

  function ensureContext() {
    if (context) {
      return context;
    }
    if (!wxApi || typeof wxApi.createInnerAudioContext !== 'function') {
      return null;
    }
    context = wxApi.createInnerAudioContext();
    context.src = source;
    return context;
  }

  return {
    play() {
      const audio = ensureContext();
      if (!audio || typeof audio.play !== 'function') {
        return Promise.resolve({ supported: false });
      }
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          if (typeof audio.offPlay === 'function') audio.offPlay(onPlay);
          if (typeof audio.offError === 'function') audio.offError(onError);
        };
        const onPlay = () => {
          cleanup();
          resolve({ supported: true });
        };
        const onError = (error) => {
          cleanup();
          reject(error instanceof Error ? error : new Error('audio playback unavailable'));
        };
        if (typeof audio.onPlay === 'function') audio.onPlay(onPlay);
        if (typeof audio.onError === 'function') audio.onError(onError);
        try {
          audio.play();
          if (typeof audio.onPlay !== 'function') {
            resolve({ supported: true });
          }
        } catch (error) {
          onError(error);
        }
      });
    },

    speak() {
      return Promise.resolve({ supported: false });
    },

    destroy() {
      if (context && typeof context.destroy === 'function') {
        context.destroy();
      }
      context = null;
    }
  };
}

module.exports = { createAudioService };

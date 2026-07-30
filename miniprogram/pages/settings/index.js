const { createSettingsApplicationService } = require('../../application/settings-application-service');
const { createSettingsRepository } = require('../../domain/identity-settings/settings-repository');
const { createLocalDatabase } = require('../../services/local-database');

const settingsService = createSettingsApplicationService({
  repository: createSettingsRepository({ database: createLocalDatabase() })
});

Page({
  data: {
    section: 'preferences',
    settings: null
  },

  onLoad(query) {
    this.setData({
      section: query && query.section === 'about' ? 'about' : 'preferences',
      settings: settingsService.getSettings()
    });
  },

  onToggleField(event) {
    const field = event.currentTarget.dataset.field;
    const current = this.data.settings[field];
    const updated = settingsService.updateSettings(
      { [field]: !current },
      this.data.settings.revision
    );
    this.setData({ settings: updated });
  },

  onRestSecondsChange(event) {
    const value = Number(event.detail.value);
    const updated = settingsService.updateSettings(
      { defaultRestSeconds: value },
      this.data.settings.revision
    );
    this.setData({ settings: updated });
  },

  onTimeChange(event) {
    const field = event.currentTarget.dataset.field;
    const updated = settingsService.updateSettings(
      { [field]: event.detail.value },
      this.data.settings.revision
    );
    this.setData({ settings: updated });
  },

  onSwitchSection(event) {
    this.setData({ section: event.currentTarget.dataset.section });
  }
});

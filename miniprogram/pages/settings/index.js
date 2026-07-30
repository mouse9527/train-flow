const { createSettingsApplicationService } = require('../../application/settings-application-service');
const { createSettingsRepositoryStub } = require('../../domain/identity-settings/settings-repository-stub');

const settingsService = createSettingsApplicationService({
  repository: createSettingsRepositoryStub()
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
    const updated = settingsService.updateSettings({ [field]: !current });
    this.setData({ settings: updated });
  },

  onRestSecondsChange(event) {
    const value = Number(event.detail.value);
    const updated = settingsService.updateSettings({ defaultRestSeconds: value });
    this.setData({ settings: updated });
  },

  onTimeChange(event) {
    const field = event.currentTarget.dataset.field;
    const updated = settingsService.updateSettings({ [field]: event.detail.value });
    this.setData({ settings: updated });
  },

  onSwitchSection(event) {
    this.setData({ section: event.currentTarget.dataset.section });
  }
});

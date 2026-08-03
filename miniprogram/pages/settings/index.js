const { createSettingsApplicationService } = require('../../application/settings-application-service');
const { createSettingsRepository } = require('../../domain/identity-settings/settings-repository');
const { createLocalDatabase } = require('../../services/local-database');

const database = createLocalDatabase();
const settingsService = createSettingsApplicationService({
  repository: createSettingsRepository({ database }),
  database,
  wx: typeof wx === 'undefined' ? null : wx,
  clipboard: typeof wx === 'undefined' ? null : wx
});

function safeErrorCode(error) {
  return error && error.code ? error.code : 'DATA_OPERATION_FAILED';
}

function getWxApi() {
  return typeof wx === 'undefined' ? null : wx;
}

Page({
  data: {
    section: 'preferences',
    settings: null,
    exportSummary: null,
    exportReady: false,
    importBytes: 0,
    importPreview: null,
    clearPreview: null,
    dataError: '',
    dataNotice: ''
  },

  _exportConfirmationId: '',
  _importJsonText: '',
  _importConfirmationId: '',
  _clearConfirmationId: '',

  onLoad(query) {
    const requestedSection = query && query.section;
    this.setData({
      section: requestedSection === 'about' || requestedSection === 'data'
        ? requestedSection
        : 'preferences',
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
  },

  onGenerateBackup() {
    this.setData({ dataError: '', dataNotice: '' });
    return Promise.resolve(settingsService.createExportPreview()).then((preview) => {
      this._exportConfirmationId = preview.confirmationId;
      this.setData({
        exportSummary: preview.summary,
        exportReady: true,
        dataNotice: preview.privacyWarning
      });
      return preview;
    }, (error) => {
      this.setData({ dataError: safeErrorCode(error) });
      throw error;
    });
  },

  onCopyBackup() {
    const confirmationId = this._exportConfirmationId;
    return Promise.resolve(
      settingsService.copyExportToClipboard(confirmationId)
    ).then((result) => {
      this._exportConfirmationId = '';
      this.setData({ exportReady: false, dataNotice: '备份 JSON 已复制，请妥善保管。' });
      return result;
    }, (error) => {
      this.setData({ dataError: safeErrorCode(error) });
      throw error;
    });
  },

  onImportInput(event) {
    this._importJsonText = event && event.detail ? String(event.detail.value || '') : '';
    this._importConfirmationId = '';
    this.setData({
      importBytes: settingsService.measureJsonBytes
        ? settingsService.measureJsonBytes(this._importJsonText)
        : this._importJsonText.length,
      importPreview: null,
      dataError: '',
      dataNotice: ''
    });
  },

  onPreviewImport() {
    const jsonText = this._importJsonText;
    return Promise.resolve(settingsService.previewImport(jsonText)).then((preview) => {
      this._importConfirmationId = preview.confirmationId;
      this.setData({ importPreview: preview, dataError: '', dataNotice: '预览完成，尚未写入本机。' });
      return preview;
    }, (error) => {
      this.setData({ dataError: safeErrorCode(error), importPreview: null });
      throw error;
    });
  },

  onConfirmImport() {
    const jsonText = this._importJsonText;
    const confirmationId = this._importConfirmationId;
    return Promise.resolve(settingsService.confirmImport(jsonText, confirmationId)).then((result) => {
      this._importJsonText = '';
      this._importConfirmationId = '';
      this.setData({
        importBytes: 0,
        importPreview: null,
        dataError: '',
        dataNotice: result.applied === false ? '本机数据已是该备份版本。' : '备份已恢复到本机。',
        settings: settingsService.getSettings()
      });
      return result;
    }, (error) => {
      this.setData({ dataError: safeErrorCode(error) });
      throw error;
    });
  },

  onPrepareLocalClear() {
    return Promise.resolve(settingsService.prepareLocalClear()).then((preview) => {
      this._clearConfirmationId = preview.confirmationId;
      this.setData({ clearPreview: preview, dataError: '', dataNotice: '' });
      return preview;
    }, (error) => {
      this.setData({ dataError: safeErrorCode(error) });
      throw error;
    });
  },

  onConfirmLocalClear() {
    const confirmationId = this._clearConfirmationId;
    const apply = () => Promise.resolve(settingsService.confirmLocalClear(confirmationId)).then((result) => {
      this._clearConfirmationId = '';
      this._importJsonText = '';
      this.setData({
        clearPreview: null,
        importPreview: null,
        importBytes: 0,
        exportReady: false,
        settings: settingsService.getSettings(),
        dataError: '',
        dataNotice: result.cleanupPending
          ? '本机数据已清除，旧槽物理清理将在下次启动重试。'
          : '本机数据已清除；不会删除云端数据。'
      });
      return result;
    }, (error) => {
      this.setData({ dataError: safeErrorCode(error) });
      throw error;
    });
    const wxApi = getWxApi();
    if (!wxApi || typeof wxApi.showModal !== 'function') return apply();
    const pendingSyncWarning = this.data.clearPreview && this.data.clearPreview.hasPendingSync
      ? '未同步变更会从本机移除并丢失。'
      : '';
    return new Promise((resolve, reject) => {
      wxApi.showModal({
        title: '再次确认清除',
        content: `仅清除本机数据，不会删除云端数据。${pendingSyncWarning}此操作会移除本机计划、记录与设置。`,
        confirmText: '清除本机',
        confirmColor: '#B42318',
        success: ({ confirm }) => {
          if (!confirm) {
            resolve({ cancelled: true });
            return;
          }
          apply().then(resolve, reject);
        },
        fail: reject
      });
    });
  },

  onUnload() {
    this._exportConfirmationId = '';
    this._importJsonText = '';
    this._importConfirmationId = '';
    this._clearConfirmationId = '';
    if (typeof settingsService.clearSensitiveData === 'function') {
      settingsService.clearSensitiveData();
    }
  }
});

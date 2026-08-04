const { createSettingsApplicationService } = require('../../application/settings-application-service');
const { createSettingsRepository } = require('../../domain/identity-settings/settings-repository');
const { createLocalDatabase } = require('../../services/local-database');
const {
  createDeveloperSyncApplication,
  createProductionSyncApplication
} = require('../../application/sync-page-application');

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

function isActiveLifecycle(page, epoch) {
  return !page._isUnloaded && page._lifecycleEpoch === epoch;
}

function clearServiceSensitiveData(application) {
  if (typeof application.clearSensitiveData === 'function') {
    application.clearSensitiveData();
  }
}

function developerSyncFixturesEnabled(wxApi) {
  if (!wxApi || typeof wxApi.getAccountInfoSync !== 'function') return false;
  try {
    const info = wxApi.getAccountInfoSync();
    return Boolean(info && info.miniProgram && info.miniProgram.envVersion === 'develop');
  } catch (_error) {
    return false;
  }
}

function createSettingsPageDefinition({
  settingsApplication = settingsService,
  syncApplicationFactory = ({ wx: wxApi } = {}) => createProductionSyncApplication({ wx: wxApi }),
  fixtureSyncApplicationFactory = createDeveloperSyncApplication,
  getWx = getWxApi
} = {}) {
  return {
  data: {
    section: 'preferences',
    settings: null,
    exportSummary: null,
    exportReady: false,
    importBytes: 0,
    importPreview: null,
    clearPreview: null,
    dataError: '',
    dataNotice: '',
    syncState: null,
    syncEnablePreview: null,
    syncPurgePreview: null,
    cloudPurgeReceipt: null,
    syncError: '',
    syncNotice: ''
  },

  _exportConfirmationId: '',
  _importJsonText: '',
  _importConfirmationId: '',
  _clearConfirmationId: '',
  _syncEnableConfirmationId: '',
  _remotePurgeConfirmationToken: '',
  _syncApplication: null,
  _skipNextSyncShow: false,
  _isUnloaded: false,
  _lifecycleEpoch: 0,

  onLoad(query = {}) {
    this._isUnloaded = false;
    this._lifecycleEpoch += 1;
    const requestedSection = query.section;
    this.setData({
      section: ['about', 'data', 'cloud-sync'].includes(requestedSection)
        ? requestedSection
        : 'preferences',
      settings: settingsApplication.getSettings()
    });
    if (requestedSection === 'cloud-sync') {
      this._loadSyncApplication(query);
      this._skipNextSyncShow = true;
    }
  },

  onShow() {
    if (this._skipNextSyncShow) {
      this._skipNextSyncShow = false;
      return Promise.resolve({ skipped: 'initial-show' });
    }
    const state = this.data.syncState;
    if (
      !this._syncApplication || !state || !state.enabled ||
      !['waiting', 'failure'].includes(state.code)
    ) {
      return Promise.resolve({ skipped: 'not-recoverable' });
    }
    return this._runSyncRetry('automatic');
  },

  _loadSyncApplication(query = {}) {
    const wxApi = getWx();
    const fixtureName = ['waiting', 'denied', 'conflict', 'purge'].includes(query.fixture)
      ? query.fixture
      : 'waiting';
    const useFixture = developerSyncFixturesEnabled(wxApi) && query.fixture === fixtureName;
    this._syncApplication = useFixture
      ? fixtureSyncApplicationFactory(fixtureName)
      : syncApplicationFactory({ wx: wxApi });
    this.refreshSyncState();
    if (useFixture && fixtureName === 'purge') {
      return this.onPrepareCloudPurge();
    }
    return this.data.syncState;
  },

  refreshSyncState() {
    if (!this._syncApplication) return null;
    const state = this._syncApplication.getState();
    this.setData({ syncState: state });
    return state;
  },

  onToggleField(event) {
    const field = event.currentTarget.dataset.field;
    const current = this.data.settings[field];
    const updated = settingsApplication.updateSettings(
      { [field]: !current },
      this.data.settings.revision
    );
    this.setData({ settings: updated });
  },

  onRestSecondsChange(event) {
    const value = Number(event.detail.value);
    const updated = settingsApplication.updateSettings(
      { defaultRestSeconds: value },
      this.data.settings.revision
    );
    this.setData({ settings: updated });
  },

  onTimeChange(event) {
    const field = event.currentTarget.dataset.field;
    const updated = settingsApplication.updateSettings(
      { [field]: event.detail.value },
      this.data.settings.revision
    );
    this.setData({ settings: updated });
  },

  onSwitchSection(event) {
    const section = event.currentTarget.dataset.section;
    this.setData({ section });
    if (section === 'cloud-sync' && !this._syncApplication) {
      this._loadSyncApplication();
    }
  },

  onGenerateBackup() {
    if (this._isUnloaded) return Promise.resolve({ cancelled: true });
    const epoch = this._lifecycleEpoch;
    this.setData({ dataError: '', dataNotice: '' });
    return Promise.resolve(settingsApplication.createExportPreview()).then((preview) => {
      if (!isActiveLifecycle(this, epoch)) {
        clearServiceSensitiveData(settingsApplication);
        return { cancelled: true };
      }
      this._exportConfirmationId = preview.confirmationId;
      this.setData({
        exportSummary: preview.summary,
        exportReady: true,
        dataNotice: preview.privacyWarning
      });
      return preview;
    }, (error) => {
      if (!isActiveLifecycle(this, epoch)) return { cancelled: true };
      this.setData({ dataError: safeErrorCode(error) });
      throw error;
    });
  },

  onCopyBackup() {
    if (this._isUnloaded) return Promise.resolve({ cancelled: true });
    const epoch = this._lifecycleEpoch;
    const confirmationId = this._exportConfirmationId;
    return Promise.resolve(
      settingsApplication.copyExportToClipboard(confirmationId)
    ).then((result) => {
      if (!isActiveLifecycle(this, epoch)) return { cancelled: true };
      this._exportConfirmationId = '';
      this.setData({ exportReady: false, dataNotice: '备份 JSON 已复制，请妥善保管。' });
      return result;
    }, (error) => {
      if (!isActiveLifecycle(this, epoch)) return { cancelled: true };
      this.setData({ dataError: safeErrorCode(error) });
      throw error;
    });
  },

  onImportInput(event) {
    if (this._isUnloaded) return;
    this._importJsonText = event && event.detail ? String(event.detail.value || '') : '';
    this._importConfirmationId = '';
    this.setData({
      importBytes: settingsApplication.measureJsonBytes
        ? settingsApplication.measureJsonBytes(this._importJsonText)
        : this._importJsonText.length,
      importPreview: null,
      dataError: '',
      dataNotice: ''
    });
  },

  onPreviewImport() {
    if (this._isUnloaded) return Promise.resolve({ cancelled: true });
    const epoch = this._lifecycleEpoch;
    const jsonText = this._importJsonText;
    return Promise.resolve(settingsApplication.previewImport(jsonText)).then((preview) => {
      if (!isActiveLifecycle(this, epoch)) {
        clearServiceSensitiveData(settingsApplication);
        return { cancelled: true };
      }
      this._importConfirmationId = preview.confirmationId;
      this.setData({ importPreview: preview, dataError: '', dataNotice: '预览完成，尚未写入本机。' });
      return preview;
    }, (error) => {
      if (!isActiveLifecycle(this, epoch)) return { cancelled: true };
      this.setData({ dataError: safeErrorCode(error), importPreview: null });
      throw error;
    });
  },

  onConfirmImport() {
    if (this._isUnloaded) return Promise.resolve({ cancelled: true });
    const epoch = this._lifecycleEpoch;
    const jsonText = this._importJsonText;
    const confirmationId = this._importConfirmationId;
    return Promise.resolve(settingsApplication.confirmImport(jsonText, confirmationId)).then((result) => {
      if (!isActiveLifecycle(this, epoch)) return { cancelled: true };
      this._importJsonText = '';
      this._importConfirmationId = '';
      this.setData({
        importBytes: 0,
        importPreview: null,
        dataError: '',
        dataNotice: result.applied === false ? '本机数据已是该备份版本。' : '备份已恢复到本机。',
        settings: settingsApplication.getSettings()
      });
      return result;
    }, (error) => {
      if (!isActiveLifecycle(this, epoch)) return { cancelled: true };
      this.setData({ dataError: safeErrorCode(error) });
      throw error;
    });
  },

  onPrepareLocalClear() {
    if (this._isUnloaded) return Promise.resolve({ cancelled: true });
    const epoch = this._lifecycleEpoch;
    return Promise.resolve(settingsApplication.prepareLocalClear()).then((preview) => {
      if (!isActiveLifecycle(this, epoch)) return { cancelled: true };
      this._clearConfirmationId = preview.confirmationId;
      this.setData({ clearPreview: preview, dataError: '', dataNotice: '' });
      return preview;
    }, (error) => {
      if (!isActiveLifecycle(this, epoch)) return { cancelled: true };
      this.setData({ dataError: safeErrorCode(error) });
      throw error;
    });
  },

  onConfirmLocalClear() {
    if (this._isUnloaded) return Promise.resolve({ cancelled: true });
    const epoch = this._lifecycleEpoch;
    const confirmationId = this._clearConfirmationId;
    const apply = () => {
      if (!isActiveLifecycle(this, epoch)) return Promise.resolve({ cancelled: true });
      return Promise.resolve(settingsApplication.confirmLocalClear(confirmationId)).then((result) => {
        if (!isActiveLifecycle(this, epoch)) return { cancelled: true };
        this._clearConfirmationId = '';
        this._importJsonText = '';
        this.setData({
          clearPreview: null,
          importPreview: null,
          importBytes: 0,
          exportReady: false,
          settings: settingsApplication.getSettings(),
          dataError: '',
          dataNotice: result.cleanupPending
            ? '本机数据已清除，旧槽物理清理将在下次启动重试。'
            : '本机数据已清除；不会删除云端数据。'
        });
        return result;
      }, (error) => {
        if (!isActiveLifecycle(this, epoch)) return { cancelled: true };
        this.setData({ dataError: safeErrorCode(error) });
        throw error;
      });
    };
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
          if (!isActiveLifecycle(this, epoch)) {
            resolve({ cancelled: true });
            return;
          }
          if (!confirm) {
            resolve({ cancelled: true });
            return;
          }
          apply().then(resolve, reject);
        },
        fail: (error) => {
          if (!isActiveLifecycle(this, epoch)) {
            resolve({ cancelled: true });
            return;
          }
          reject(error);
        }
      });
    });
  },

  onPrepareSyncEnable() {
    if (!this._syncApplication || this._isUnloaded) return Promise.resolve({ cancelled: true });
    const epoch = this._lifecycleEpoch;
    this.setData({ syncError: '', syncNotice: '' });
    return Promise.resolve(this._syncApplication.prepareEnable({})).then((preview) => {
      if (!isActiveLifecycle(this, epoch)) return { cancelled: true };
      this._syncEnableConfirmationId = preview.confirmationId;
      this.setData({
        syncEnablePreview: { scope: preview.scope, warning: preview.warning }
      });
      return this.data.syncEnablePreview;
    }, (error) => {
      if (!isActiveLifecycle(this, epoch)) return { cancelled: true };
      this.setData({ syncError: safeErrorCode(error) });
      throw error;
    });
  },

  onConfirmSyncEnable() {
    if (!this._syncApplication || this._isUnloaded) return Promise.resolve({ cancelled: true });
    const epoch = this._lifecycleEpoch;
    const confirmationId = this._syncEnableConfirmationId;
    let pending;
    try {
      pending = this._syncApplication.confirmEnable({ confirmationId });
      this.setData({ syncState: this._syncApplication.getState() });
    } catch (error) {
      this.setData({ syncError: safeErrorCode(error) });
      return Promise.reject(error);
    }
    return Promise.resolve(pending).then((result) => {
      if (!isActiveLifecycle(this, epoch)) return { cancelled: true };
      this._syncEnableConfirmationId = '';
      this.setData({
        syncEnablePreview: null,
        syncState: result.state,
        syncError: '',
        syncNotice: result.ok ? '云同步已启用。' : '云端暂不可用，本机训练数据仍可正常使用。'
      });
      return result;
    }, (error) => {
      if (!isActiveLifecycle(this, epoch)) return { cancelled: true };
      this.setData({ syncError: safeErrorCode(error) });
      throw error;
    });
  },

  onDisableCloudSync() {
    if (!this._syncApplication || this._isUnloaded) return Promise.resolve({ cancelled: true });
    const epoch = this._lifecycleEpoch;
    return Promise.resolve(this._syncApplication.disable({})).then((result) => {
      if (!isActiveLifecycle(this, epoch)) return { cancelled: true };
      this._syncEnableConfirmationId = '';
      this.setData({
        syncEnablePreview: null,
        syncState: result.state,
        syncError: '',
        syncNotice: '云同步已关闭，本机数据未删除。'
      });
      return result;
    }, (error) => {
      if (!isActiveLifecycle(this, epoch)) return { cancelled: true };
      this.setData({ syncError: safeErrorCode(error) });
      throw error;
    });
  },

  _runSyncRetry(source) {
    if (!this._syncApplication || this._isUnloaded) return Promise.resolve({ cancelled: true });
    const epoch = this._lifecycleEpoch;
    this.setData({ syncError: '', syncNotice: '' });
    let pending;
    try {
      pending = this._syncApplication.retry({ source });
      this.setData({ syncState: this._syncApplication.getState() });
    } catch (error) {
      this.setData({ syncError: safeErrorCode(error) });
      return Promise.reject(error);
    }
    return Promise.resolve(pending).then((result) => {
      if (!isActiveLifecycle(this, epoch)) return { cancelled: true };
      this.setData({
        syncState: result.state,
        syncError: result.ok ? '' : (result.state.errorCode || 'CLOUD_SYNC_UNAVAILABLE'),
        syncNotice: result.ok ? '同步完成。' : '云端暂不可用，本机训练不受影响，可稍后重试。'
      });
      return result;
    }, (error) => {
      if (!isActiveLifecycle(this, epoch)) return { cancelled: true };
      this.setData({ syncError: safeErrorCode(error) });
      throw error;
    });
  },

  onRetrySync() {
    return this._runSyncRetry('manual');
  },

  onResolveSyncConflict(event) {
    if (!this._syncApplication || this._isUnloaded) return Promise.resolve({ cancelled: true });
    const epoch = this._lifecycleEpoch;
    const command = event && event.detail && event.detail.conflictId
      ? event.detail
      : event.currentTarget.dataset;
    const { conflictId, action } = command;
    return Promise.resolve(
      this._syncApplication.resolveConflict({ conflictId, action })
    ).then((result) => {
      if (!isActiveLifecycle(this, epoch)) return { cancelled: true };
      this.setData({
        syncState: this._syncApplication.getState(),
        syncError: '',
        syncNotice: '冲突已按所选方式处理。'
      });
      return result;
    }, (error) => {
      if (!isActiveLifecycle(this, epoch)) return { cancelled: true };
      this.setData({ syncError: safeErrorCode(error) });
      throw error;
    });
  },

  onPrepareCloudPurge() {
    if (!this._syncApplication || this._isUnloaded) return Promise.resolve({ cancelled: true });
    const epoch = this._lifecycleEpoch;
    return Promise.resolve(this._syncApplication.prepareRemotePurge({})).then((preview) => {
      if (!isActiveLifecycle(this, epoch)) return { cancelled: true };
      this._remotePurgeConfirmationToken = preview.confirmationToken;
      this.setData({
        syncPurgePreview: {
          expiresAt: preview.expiresAt,
          warning: '只删除当前云账号中的同步副本，不会删除本机计划、记录或设置。'
        },
        cloudPurgeReceipt: null,
        syncError: '',
        syncNotice: ''
      });
      return this.data.syncPurgePreview;
    }, (error) => {
      if (!isActiveLifecycle(this, epoch)) return { cancelled: true };
      this.setData({ syncError: safeErrorCode(error) });
      throw error;
    });
  },

  onConfirmCloudPurge() {
    if (!this._syncApplication || this._isUnloaded) return Promise.resolve({ cancelled: true });
    const epoch = this._lifecycleEpoch;
    const confirmationToken = this._remotePurgeConfirmationToken;
    const apply = () => Promise.resolve(
      this._syncApplication.purgeRemote({ confirmationToken })
    ).then((receipt) => {
      if (!isActiveLifecycle(this, epoch)) return { cancelled: true };
      this._remotePurgeConfirmationToken = '';
      this.setData({
        syncPurgePreview: null,
        cloudPurgeReceipt: { purgedAt: receipt.purgedAt },
        syncError: '',
        syncNotice: '云端同步副本已删除；本机数据保持不变。'
      });
      return receipt;
    }, (error) => {
      if (!isActiveLifecycle(this, epoch)) return { cancelled: true };
      this.setData({ syncError: safeErrorCode(error) });
      throw error;
    });
    const wxApi = getWx();
    if (!wxApi || typeof wxApi.showModal !== 'function') return apply();
    return new Promise((resolve, reject) => {
      wxApi.showModal({
        title: '删除云端同步副本',
        content: '此操作只删除云端同步副本，不会删除本机计划、训练记录或设置。确认信息由服务器签发并绑定当前设备。',
        confirmText: '删除云端',
        confirmColor: '#B42318',
        success: ({ confirm }) => {
          if (!isActiveLifecycle(this, epoch) || !confirm) {
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
    this._isUnloaded = true;
    this._lifecycleEpoch += 1;
    this._exportConfirmationId = '';
    this._importJsonText = '';
    this._importConfirmationId = '';
    this._clearConfirmationId = '';
    this._syncEnableConfirmationId = '';
    this._remotePurgeConfirmationToken = '';
    this._syncApplication = null;
    this.setData({
      exportSummary: null,
      exportReady: false,
      importBytes: 0,
      importPreview: null,
      clearPreview: null,
      dataError: '',
      dataNotice: '',
      syncState: null,
      syncEnablePreview: null,
      syncPurgePreview: null,
      cloudPurgeReceipt: null,
      syncError: '',
      syncNotice: ''
    });
    clearServiceSensitiveData(settingsApplication);
  }
  };
}

const definition = createSettingsPageDefinition();
if (typeof Page === 'function') Page(definition);

module.exports = {
  createSettingsPageDefinition,
  developerSyncFixturesEnabled
};

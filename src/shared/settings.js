"use strict";

globalThis.LinkTabsSettings = {
  async load() {
    const { settings } = await chrome.storage.local.get("settings");
    return LinkTabsRules.normalizeSettings(settings);
  },

  async save(settings) {
    await chrome.storage.local.set({
      settings: LinkTabsRules.normalizeSettings(settings)
    });
  }
};

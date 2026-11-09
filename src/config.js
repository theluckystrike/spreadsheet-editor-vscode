'use strict';
// Build-time switches for the paid tier. Plain constants so esbuild inlines them.

module.exports = Object.freeze({
  // false: this build shows no Pro label, no license command, and every limit is the setting's value.
  // Nothing is locked and the license code makes no network call. Set to true once the owner opens Zovo Pro.
  PRO_ENABLED: false,
  // Product id for the Zovo license facade (src/license). A "zovo-pro" key unlocks every Zovo viewer.
  SKU: 'spreadsheet-pro',
});

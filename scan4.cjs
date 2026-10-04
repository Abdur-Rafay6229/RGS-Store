const fs = require('fs');
const js = fs.readFileSync('C:/Users/DELL/Desktop/Bills Manager testing/test 1/src/js/app.js', 'utf8');

const features = {
  'FIREBASE AUTH': ['doLogin', 'doSignup', 'signOutCloud', 'handleCloud', 'friendlyAuthError', 'afterLogin'],
  'CLOUD SYNC': ['pushToCloud', 'pullFromCloud', 'syncNow', 'restoreFromCloud', 'bootstrapAccountData', 'scheduleAutoSync'],
  'PIN LOCK': ['startSetup', 'startLock', 'verifyPin', 'changePin', 'finishSetup', 'skipSetup', 'buildKeypad', 'startPinLockout'],
  'BIOMETRIC': ['registerBiometric', 'tryBiometric', 'toggleBiometric', 'bioCredBytesCached'],
  'CUSTOMER BILLS': ['newBill', 'saveBill', 'editBill', 'deleteBill', 'openDetail', 'renderDetail', 'renderList', 'addItemRow', 'calcTotal', 'addPayment', 'removePayment'],
  'SUPPLIER BILLS': ['newSupBill', 'saveSupBill', 'editSupBill', 'deleteSupBill', 'renderSupDetail', 'renderSupplierList', 'addProductRow', 'recalcProducts', 'supCalc', 'addSupPayment', 'removeSupPayment'],
  'OPENING BALANCES': ['openOpeningsManager', 'renderOpenings', 'editOpening', 'addNewOpening', 'setOpeningFor', 'getOpeningFor', 'supplierTotalDues'],
  'PHOTOS': ['attachBillPhoto', 'handlePhotoSelect', 'addPhotoThumb', 'removePhotoThumb', 'compressImage', 'collectPhotos'],
  'PHOTO VIEWER': ['openViewer', 'closeViewer', 'updateViewer', 'viewerNav', 'openViewerFromThumb'],
  'OCR': ['startOCR', 'handleOCRSelect', 'ocrParseItems', 'ocrParseAll', 'openOCRReview', 'applyOCR', 'applyOCRToCustomer', 'applyOCRToSupplier', 'getTessWorker', 'ocrGuessUnit'],
  'SHARE (bill image)': ['shareBill', 'shareSupBill', 'shareBuildCanvas', 'sharePaint', 'shareMeasure', 'shareToNativeSheet', 'shareSendBillImage'],
  'CLOUDINARY': ['uploadToCloudinary', 'deleteCloudinaryPhoto', 'saveCloudinaryCfg', 'cloudinarySignIn', 'cloudinarySignOut', 'testCloudinary', 'cloudinaryUploadError', 'cloudinaryPublicId'],
  'ADMIN': ['openAccounts', 'renderAccounts', 'openUserAccount', 'exitImpersonation', 'fetchAdminFlag', 'ensureProfile', 'refreshAdminStatus', 'applyUidVisibility'],
  'EXPORT/IMPORT': ['exportData', 'importData'],
  'SETTINGS/UI': ['openSettings', 'updateSettingsUI', 'showScreen', 'showList', 'showSupplierList', 'openSettings', 'setBusy', 'isBusy', 'showLoading', 'hideLoading'],
  'HELPERS': ['uid', 'today', 'readJSON', 'safeSet', 'escapeHtml', 'formatMoney', 'toNumber', 'isValidDateStr', 'validDate', 'isDataUrl', 'numVal', 'debounce', 'normalizeBills', 'normalizeSupBills', 'withTimeout']
};

let total = 0, missing = 0;
console.log('=== FEATURE-BY-FEATURE VERIFICATION ===\n');
for (const [feature, funcs] of Object.entries(features)) {
  const miss = funcs.filter(f => !new RegExp('function\\s+' + f + '\\s*\\(|(?:const|let)\\s+' + f + '\\s*=').test(js));
  total += funcs.length;
  if (miss.length) {
    missing += miss.length;
    console.log('❌ ' + feature + ' — MISSING: ' + miss.join(', '));
  } else {
    console.log('✅ ' + feature + ' (' + funcs.length + ' functions)');
  }
}
console.log('\n' + (total - missing) + '/' + total + ' functions present');
console.log(missing === 0 ? '✅ ALL FEATURES INTACT' : '❌ ' + missing + ' MISSING');

// Screens check
const html = fs.readFileSync('C:/Users/DELL/Desktop/Bills Manager testing/test 1/index.html', 'utf8');
const screens = ['listScreen','formScreen','detailScreen','supListScreen','supFormScreen','supDetailScreen','settingsScreen','lockScreen','setupScreen','loginScreen','openingsScreen','accountsScreen','photoViewer','ocrModal','adminBanner'];
const missingScreens = screens.filter(s => !html.includes('id="' + s + '"'));
console.log('\n=== SCREENS ===');
console.log(missingScreens.length === 0 ? '✅ All 15 screens present in HTML' : '❌ Missing: ' + missingScreens.join(', '));

const APP_VERSION = 'v1.4.0';

/* ============ ACCOUNT (login + per-user data + admin) ============
   Har account ka data poori tarah alag rehta hai:
   - localStorage keys account UID ke saath namespace hoti hain (acctKey)
   - Firestore me sirf stores/{uid} — rules owner ya Admin ko hi allow karte hain
   - Role (Admin) sirf Firestore admins/{uid} doc se aata hai, client kabhi nahi
*/
let activeDataUid = '';        // jis account ka data abhi loaded hai
let adminViewing = false;      // Admin kisi doosre user ke account me hai
let impersonatedUid = '';
let impersonatedEmail = '';
let adminFlag = false;         // display gate — asli check Firestore rules me
let sessionBooted = false;     // is app-session me account boot ho chuka
let deviceUnlocked = false;    // PIN/setup ke baad true
let suppressSync = false;      // data load karte waqt auto-push na chale

function acctKey(base) { return activeDataUid ? base + '::' + activeDataUid : base; }
function isAdmin() { return adminFlag === true; }
function ownerUidNow() { return activeDataUid || (fbAuth && fbAuth.currentUser ? fbAuth.currentUser.uid : ''); }

// Admin ka email — yehi list Firestore rules me bhi likhi hai. Sirf inhi emails ko
// rules apna admins/{uid} marker khud banane dete hain, isliye koi doosra user
// frontend/localStorage/params badal kar khud ko admin nahi bana sakta.
const ADMIN_EMAILS = ['abdurrafay6010@gmail.com'];
function isConfiguredAdminEmail(em) {
  const e = String(em || '').trim().toLowerCase();
  return ADMIN_EMAILS.indexOf(e) !== -1;
}

// Purana (single-user) data — pehle login karne wala account claim kar le,
// warna doosra user bhi wahi bills dekh leta. Sirf ek baar chalta hai.
function migrateLegacyData() {
  if (!activeDataUid) return;
  if (localStorage.getItem('rgs_legacy_migrated')) return;
  const keys = ['rgs_bills', 'rgs_suppliers', 'rgs_supplier_openings', 'rgs_cloudinary'];
  for (const k of keys) {
    const v = localStorage.getItem(k);
    if (v === null) continue;
    if (localStorage.getItem(acctKey(k)) !== null) { try { localStorage.removeItem(k); } catch (e) {} continue; }
    try { localStorage.setItem(acctKey(k), v); localStorage.removeItem(k); }
    catch (e) { console.warn('Legacy migration failed:', k, e); return; }   // agla session dobara try karega
  }
  try { localStorage.setItem('rgs_legacy_migrated', '1'); } catch (e) {}
}

function clearAccountMemory() {
  bills = []; supBills = []; supplierOpenings = [];
  cloudinaryCfg = null; clFieldsOpen = false;
  currentBillId = null; currentSupId = null;
  editingId = null; editingSupId = null;
  editExistingPaid = 0; supExistingPaid = 0; currentSupOpening = 0;
  pendingPhotoDeletes = [];
}

function loadLocalAccountData() {
  bills = loadBills();
  supBills = loadSupBills();
  supplierOpenings = loadOpenings();
  cloudinaryCfg = null;      // naya account → uski apni Cloudinary config load ho
  clFieldsOpen = false;
  loadCloudinaryCfg();
}

function localSavedAt() {
  const n = Number(localStorage.getItem(acctKey('rgs_saved_at')));
  return isFinite(n) ? n : 0;
}
function markLocalSaved() {
  if (!activeDataUid || suppressSync) return;
  try { localStorage.setItem(acctKey('rgs_saved_at'), String(Date.now())); } catch (e) {}
}
function hasAnyAccountData() {
  return bills.length > 0 || supBills.length > 0 || Object.keys(supplierOpenings).length > 0;
}

function applyCloudData(d) {
  bills = normalizeBills(d.bills);
  supBills = normalizeSupBills(d.supBills);
  supplierOpenings = normalizeOpenings(d.supplierOpenings);
  safeSet(acctKey('rgs_bills'), bills);
  safeSet(acctKey('rgs_suppliers'), supBills);
  safeSet(acctKey('rgs_supplier_openings'), supplierOpenings);
  if (d.cloudinary) {
    cloudinaryCfg = normalizeCloudinary(d.cloudinary);
    if (cloudinaryCfg) { try { localStorage.setItem(acctKey('rgs_cloudinary'), JSON.stringify(cloudinaryCfg)); } catch (e) {} }
  }
  const at = (d.updatedAt && typeof d.updatedAt.toMillis === 'function') ? d.updatedAt.toMillis() : 0;
  if (at) { try { localStorage.setItem(acctKey('rgs_saved_at'), String(at)); } catch (e) {} }
}

// App start / unlock par: local cache turant, phir cloud se taaza data (naye device ke liye)
async function bootstrapAccountData() {
  loadLocalAccountData();
  if (!firebaseReady || !activeDataUid) return;
  if (!navigator.onLine) { setSyncError('Offline — device ka local data dikh raha hai.'); return; }

  let cloudDoc = null;
  try {
    cloudDoc = await withTimeout(fbDb.collection('stores').doc(activeDataUid).get(), 15000, 'Cloud read timeout');
  } catch (e) {
    console.warn('Bootstrap read failed:', e);
    setSyncError('Restore failed: ' + cloudErrorText(e));
    return;
  }
  if (!cloudDoc.exists) {
    if (hasAnyAccountData() && !adminViewing) await pushToCloud();
    return;
  }
  const d = cloudDoc.data() || {};
  const cloudBills = normalizeBills(d.bills);
  const cloudSup = normalizeSupBills(d.supBills);
  const cloudOpenings = normalizeOpenings(d.supplierOpenings);
  const cloudHas = cloudBills.length > 0 || cloudSup.length > 0 || Object.keys(cloudOpenings).length > 0;
  const localHas = hasAnyAccountData();
  const cloudAt = (d.updatedAt && typeof d.updatedAt.toMillis === 'function') ? d.updatedAt.toMillis() : 0;

  if (!localHas || (cloudAt && cloudAt >= localSavedAt())) {
    applyCloudData(d);                       // cloud me data (aur wo naya hai) → wahi lo
    setSyncError('');
  } else if (cloudHas || !adminViewing) {
    suppressSync = true;
    await pushToCloud();                     // is device par naya data hai → cloud par bhejo
    suppressSync = false;
  }
  if (screenVisible('settingsScreen')) updateSettingsUI();
}

// Apna role (Admin hai ya nahi) — hamesha Firestore se, client storage se kabhi nahi
async function fetchAdminFlag(showMsg) {
  adminFlag = false;
  if (!firebaseReady || !fbAuth || !fbAuth.currentUser) { if (showMsg) alert('Sign in nahi hai.'); return false; }
  const user = fbAuth.currentUser;
  try {
    const ref = fbDb.collection('admins').doc(user.uid);
    const snap = await withTimeout(ref.get(), 15000, 'Admin check timeout');
    // Email gate client par bhi (rules me bhi hai) — chahe kisi doosre account ka
    // purana admins marker pada ho, UI me usse Admin kabhi nahi dikhega
    adminFlag = isConfiguredAdminEmail(user.email)
      && !!snap.exists && (snap.data() || {}).role !== 'user';

    // Sirf tab banao jab marker abhi NAHI hai — warna kisi ne jaan-boojh kar
    // role:'user' (demote) kiya ho to ye har login par overwrite kar deta.
    if (!snap.exists && isConfiguredAdminEmail(user.email)) {
      try {
        await withTimeout(ref.set({
          role: 'admin',
          email: user.email || '',
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        }), 15000, 'Admin claim timeout');
        adminFlag = true;
        if (showMsg) alert('✅ Aap admin ban gaye — Accounts section ab home screen par dikhne lagega.');
      } catch (ce) {
        console.warn('Admin auto-claim failed (purane rules?) — Console se manually banayein:', ce);
        if (showMsg) alert('❌ Admin auto-claim fail:\n\n' + cloudErrorText(ce) +
          '\n\nSettings → Account → Rules wala block dobara Console me Publish karo, phir yehi button dobara dabao.');
      }
    }
  } catch (e) {
    console.warn('Admin status check failed:', e);
    adminFlag = false;
    if (showMsg) alert('❌ Admin status check fail:\n\n' + cloudErrorText(e) + '\n\nRules publish kiye hain? (Settings → Account → Rules)');
  }
  refreshChrome();
  return adminFlag;
}

// Har naye/apne account ka profile doc (Admin ko accounts list chahiye)
async function ensureProfile() {
  if (!firebaseReady || !fbAuth || !fbAuth.currentUser) return false;
  if (adminViewing) return true;   // Admin kisi aur ke account me hai — uska profile wo khud banayega
  const uid = fbAuth.currentUser.uid;
  try {
    const ref = fbDb.collection('profiles').doc(uid);
    const snap = await withTimeout(ref.get(), 15000, 'Profile read timeout');
    const email = fbAuth.currentUser.email || '';
    const now = firebase.firestore.FieldValue.serverTimestamp();
    if (!snap.exists) await ref.set({ email, createdAt: now, updatedAt: now });
    else await ref.update({ email, updatedAt: now });
    return true;
  } catch (e) { console.warn('Profile save failed:', e); return false; }
}

/* ============ SECURITY (PIN + BIOMETRIC) ============ */
const PIN_KEY = 'rgs_pin_hash';
const PIN_SALT = 'rgs_v1_salt_2024';
const BIO_CRED_KEY = 'rgs_biometric_cred';
const BIO_ENABLED_KEY = 'rgs_biometric_enabled';

async function hashPin(pin) {
  const input = String(pin) + PIN_SALT;
  // crypto.subtle sirf secure context (https / localhost) par milta hai.
  // Fallback: synchronous FNV-1a based hash taaki app http / file:// par bhi chale.
  if (crypto && crypto.subtle && crypto.subtle.digest) {
    try {
      const buf = new TextEncoder().encode(input);
      const hash = await crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) { console.warn('subtle digest failed, using fallback hash', e); }
  }
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c + i, 0x85ebca6b) >>> 0;
  }
  return 'fb-' + h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}
function hasPIN() { return !!localStorage.getItem(PIN_KEY); }
function isBioEnabled() { return localStorage.getItem(BIO_ENABLED_KEY) === '1'; }
function hasBioCred() { return !!localStorage.getItem(BIO_CRED_KEY); }

function buildKeypad(containerId, onDigit, onBack) {
  const box = document.getElementById(containerId);
  box.innerHTML = '';
  ['1','2','3','4','5','6','7','8','9','bio','0','back'].forEach(k => {
    const b = document.createElement('button');
    if (k === 'bio') {
      b.textContent = '👆'; b.className = 'wide';
      b.onclick = () => tryBiometric();
      // hasPIN() zaroori — warna setup screen par bio button PIN banaaye bina app khol deta tha
      if (!isBioEnabled() || !hasBioCred() || !hasPIN()) b.style.visibility = 'hidden';
    } else if (k === 'back') {
      b.textContent = '⌫'; b.onclick = () => onBack();
    } else {
      b.textContent = k; b.onclick = () => onDigit(k);
    }
    box.appendChild(b);
  });
}
function updateDots(displayId, value) {
  document.querySelectorAll('#' + displayId + ' .pin-dot').forEach((d, i) => d.classList.toggle('filled', i < value.length));
}

let setupPin1 = '', setupPin2 = '', setupStage = 'first';

function setSetupStage(stage) {
  setupStage = stage;
  const title = document.getElementById('setupTitle');
  const sub = document.getElementById('setupSub');
  if (!title || !sub) return;
  if (stage === 'first') {
    title.textContent = 'Welcome to RGS Store';
    sub.textContent = 'Set a 4-digit PIN to protect your data';
  } else {
    title.textContent = 'Confirm PIN';
    sub.textContent = 'Same 4 digits ek baar aur enter karo';
  }
}

function startSetup() {
  setupPin1 = ''; setupPin2 = '';
  setSetupStage('first');
  updateDots('setupPinDisplay', '');
  document.getElementById('setupErr').textContent = '';
  buildKeypad('setupKeypad',
    (d) => {
      const errEl = document.getElementById('setupErr');
      if (setupStage === 'first') {
        if (setupPin1.length >= 4) return;
        setupPin1 += d;
        updateDots('setupPinDisplay', setupPin1);
        if (setupPin1.length === 4) {
          setTimeout(() => { setupPin2 = ''; setSetupStage('confirm'); updateDots('setupPinDisplay', ''); }, 200);
        }
      } else {
        errEl.textContent = '';
        if (setupPin2.length >= 4) return;
        setupPin2 += d;
        updateDots('setupPinDisplay', setupPin2);
        if (setupPin2.length === 4) setTimeout(() => finishSetup(), 200);
      }
    },
    () => {
      if (setupStage === 'confirm') {
        if (setupPin2.length === 0) {
          // Confirm step par empty backspace → step 1 dobara shuru.
          // (Purana PIN chhod diya tha to dots full reh kar digits ignore ho rahe the — dead keys)
          setupPin1 = '';
          setSetupStage('first');
          updateDots('setupPinDisplay', '');
          return;
        }
        setupPin2 = setupPin2.slice(0, -1);
        updateDots('setupPinDisplay', setupPin2);
      } else {
        setupPin1 = setupPin1.slice(0, -1);
        updateDots('setupPinDisplay', setupPin1);
      }
    }
  );
  showScreen('setupScreen');
}

async function finishSetup() {
  const pin1 = setupPin1, pin2 = setupPin2;
  if (!pin1 || !pin2 || pin1 !== pin2) {
    document.getElementById('setupErr').textContent = 'PINs did not match. Confirm step dobara karo.';
    if (navigator.vibrate) navigator.vibrate(200);
    setupPin2 = '';
    setSetupStage('confirm');
    updateDots('setupPinDisplay', '');
    return;
  }
  try {
    localStorage.setItem(PIN_KEY, await hashPin(pin1));
  } catch (e) { alert('PIN save nahi ho paya. Storage blocked hai.'); return; }
  setupPin1 = ''; setupPin2 = '';
  try {
    if (window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable?.()) {
      if (confirm('Enable fingerprint / face unlock?')) await registerBiometric();
    }
  } catch (e) { console.warn('Biometric prompt failed:', e); }
  unlockAndEnter();
}
function skipSetup() { if (confirm('Skip PIN? Your data will not be protected on this device.')) unlockAndEnter(); }

let lockPin = '';
let pinAttempts = 0;
let pinLockUntil = 0;   // brute-force cooldown (timestamp)
let lockTicker = null;
const PIN_LOCK_STEP_MS = 30000;
const PIN_LOCK_MAX_MS = 300000;

function pinLockLeft() { return Math.max(0, pinLockUntil - Date.now()); }
function showPinLockMsg() {
  const left = pinLockLeft();
  if (left <= 0) return false;
  document.getElementById('lockErr').textContent =
    'Too many wrong PINs. Wait ' + Math.ceil(left / 1000) + ' seconds.';
  return true;
}
// 5 galti ke baad 30s, har 5 galti par double (max 5 min) — PIN guessing rokne ke liye
function startPinLockout() {
  const stage = Math.floor(Math.max(0, pinAttempts - 5) / 5);
  pinLockUntil = Date.now() + Math.min(PIN_LOCK_STEP_MS * Math.pow(2, stage), PIN_LOCK_MAX_MS);
  startLockTicker();
}
function startLockTicker() {
  clearInterval(lockTicker);
  if (pinLockUntil === 0) return;   // koi lock hi nahi laga — attempts ko chhoona nahi
  lockTicker = setInterval(() => {
    if (!screenVisible('lockScreen') || pinLockUntil === 0) {
      clearInterval(lockTicker); lockTicker = null; return;
    }
    if (pinLockLeft() > 0) { showPinLockMsg(); return; }
    clearInterval(lockTicker); lockTicker = null;
    // Cooldown khatam → nayi chance (warna owner hamesha ke liye lock na ho jaye)
    pinAttempts = 0; pinLockUntil = 0;
    const el = document.getElementById('lockErr');
    if (el && el.textContent.indexOf('Too many wrong PINs') === 0) el.textContent = '';
  }, 1000);
}
function startLock() {
  lockPin = '';
  updateDots('lockPinDisplay', '');
  document.getElementById('lockErr').textContent = '';
  const bioBtn = document.getElementById('bioUnlockBtn');
  if (isBioEnabled() && hasBioCred()) bioBtn.classList.remove('hidden'); else bioBtn.classList.add('hidden');
  buildKeypad('lockKeypad',
    (d) => {
      if (pinLockLeft() > 0) { showPinLockMsg(); return; }   // cooldown me digits band
      if (lockPin.length >= 4) return;
      document.getElementById('lockErr').textContent = '';
      lockPin += d; updateDots('lockPinDisplay', lockPin);
      if (lockPin.length === 4) setTimeout(() => verifyPin(), 150);
    },
    () => {
      if (pinLockLeft() > 0) return;
      lockPin = lockPin.slice(0, -1); updateDots('lockPinDisplay', lockPin);
    }
  );
  showScreen('lockScreen');
  showPinLockMsg();
  startLockTicker();
  // Biometric foran — koi artificial delay nahi. Pehle user kuch type na kar ho,
  // PIN entry block na ho, aur lockout cooldown me na ho.
  if (isBioEnabled() && hasBioCred() && !bioInFlight && lockPin.length === 0 && pinLockLeft() === 0) {
    tryBiometric();
  }
}
async function verifyPin() {
  const entered = lockPin; lockPin = '';
  if (pinLockLeft() > 0) { showPinLockMsg(); return; }
  const stored = localStorage.getItem(PIN_KEY);
  const hash = await hashPin(entered);
  if (stored && hash === stored) {
    pinAttempts = 0; pinLockUntil = 0;
    updateDots('lockPinDisplay', ''); unlockAndEnter();
  } else {
    pinAttempts++;
    if (pinAttempts >= 5) { startPinLockout(); showPinLockMsg(); }
    else document.getElementById('lockErr').textContent = 'Wrong PIN. Try again. (' + pinAttempts + ')';
    updateDots('lockPinDisplay', '');
    if (navigator.vibrate) navigator.vibrate(200);
  }
}
// Credential ID bytes ek hi baar decode — har prompt par atob repeat karne ki zaroorat nahi
let bioCredBytes = null, bioCredBytesFor = '';
function bioCredBytesCached() {
  const b64 = localStorage.getItem(BIO_CRED_KEY) || '';
  if (!b64) return null;
  if (bioCredBytes && bioCredBytesFor === b64) return bioCredBytes;
  try { bioCredBytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); bioCredBytesFor = b64; }
  catch (e) { bioCredBytes = null; bioCredBytesFor = ''; return null; }
  return bioCredBytes;
}

async function registerBiometric() {
  if (!window.PublicKeyCredential) { alert('Biometric not supported.'); return false; }
  const btn = document.getElementById('bioToggleBtn');
  setBusy(btn, true);
  try {
    const challenge = new Uint8Array(32); crypto.getRandomValues(challenge);
    const userId = new Uint8Array(16); crypto.getRandomValues(userId);
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge, rp: { name: 'RGS Store' },
        user: { id: userId, name: 'rgs-user', displayName: 'RGS User' },
        pubKeyCredParams: [{ alg: -7, type: 'public-key' }, { alg: -257, type: 'public-key' }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
        timeout: 60000, attestation: 'none'
      }
    });
    if (cred) {
      const idB64 = btoa(String.fromCharCode(...new Uint8Array(cred.rawId)));
      localStorage.setItem(BIO_CRED_KEY, idB64);
      localStorage.setItem(BIO_ENABLED_KEY, '1');
      bioCredBytes = null; bioCredBytesFor = '';   // naya credential cache clear
      alert('✅ Biometric registered!'); return true;
    }
  } catch (e) { console.warn('Bio reg error:', e); alert('Biometric setup failed.'); }
  finally { setBusy(btn, false); }
  return false;
}

// Native/system biometric prompt (WebAuthn platform authenticator) — koi custom UI nahi.
// • bioInFlight guard: ek waqt me sirf EK prompt khula rahe (duplicate trigger nahi hoga)
// • Retry: fail hone par message + 👆 keypad / button se turant dobara try
// • PIN fallback: prompt cancel/fail ho to keypad normal chalta rehta hai
let bioInFlight = false;
async function tryBiometric() {
  if (bioInFlight) return;                        // duplicate prompt block
  if (!screenVisible('lockScreen')) return;       // sirf lock screen par hi
  if (pinLockLeft() > 0) { showPinLockMsg(); return; }
  const idBytes = bioCredBytesCached();
  if (!idBytes) { document.getElementById('lockErr').textContent = 'Biometric set up nahi hai. PIN daalein.'; return; }
  bioInFlight = true;
  const errEl = document.getElementById('lockErr');
  if (errEl) errEl.textContent = '';
  try {
    const challenge = new Uint8Array(32); crypto.getRandomValues(challenge);
    // Yahi native system prompt hai — device ka fingerprint/face, app ka UI nahi
    const assertion = await navigator.credentials.get({
      publicKey: { challenge, allowCredentials: [{ id: idBytes, type: 'public-key' }], timeout: 60000, userVerification: 'required' },
      mediation: 'required'                        // security: verification skip nahi ho sakta
    });
    if (assertion) { lockPin = ''; pinAttempts = 0; pinLockUntil = 0; unlockAndEnter(); }
  } catch (e) {
    console.warn('Biometric failed:', e && e.name);
    const el = document.getElementById('lockErr');
    if (el) el.textContent = 'Biometric fail. 👆 daba kar dobara try karein, ya PIN daalein.';
  } finally { bioInFlight = false; }
}

/* ============ HELPERS ============ */
function uid() { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
function today() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function readJSON(key) {
  try { const v = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(v) ? v : []; }
  catch (e) { return []; }
}
function safeSet(key, data) {
  try { localStorage.setItem(key, JSON.stringify(data)); return true; }
  catch (e) { alert('⚠️ Storage full.'); return false; }
}
function escapeHtml(v = '') {
  return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function formatMoney(v) { return Number(v || 0).toLocaleString('en-PK', { maximumFractionDigits: 2 }); }
function toNumber(v) { const n = Number(v); return isFinite(n) && n > 0 ? n : 0; }
// Sirf format nahi, asli calendar date bhi check karo (misal: 2026-99-99 galat hai,
// lekin regex ise theek maan leta tha — isse payment history me invalid dates chali jaati thin)
function isValidDateStr(v) {
  const s = String(v || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const p = s.split('-').map(Number);
  const dt = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  return dt.getUTCFullYear() === p[0] && dt.getUTCMonth() === p[1] - 1 && dt.getUTCDate() === p[2];
}
function validDate(v) { return isValidDateStr(v) ? String(v) : today(); }
function isDataUrl(s) { return typeof s === 'string' && s.startsWith('data:'); }
// Number input ke liye: sirf valid number ya khaali string (import/cloud data se injection rokne ke liye)
function numVal(v) {
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(v);
  return isFinite(n) ? String(n) : '';
}
// Native app detect: Capacitor WebView, PWA standalone, ya iOS standalone
function isNativeApp() {
  try { return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()); } catch (e) { return false; }
}
function isStandalone() { return isNativeApp() || window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; }

/* ============ STORAGE ============ */
const PTYPES = ['cash', 'online', 'credit'];
// Sirf safe badge class allow karo (stored/imported data se class injection rokne ke liye)
function ptypeClass(v) { return PTYPES.indexOf(v) >= 0 ? v : ''; }
// Safe badge markup: class + text hamesha whitelist se
function ptypeBadge(v, fallback) {
  const c = ptypeClass(v) || ptypeClass(fallback) || 'credit';
  return '<span class="badge ' + c + '">' + escapeHtml(c) + '</span>';
}
// id sirf URL/HTML-safe characters rakhe (inline onclick me use hota hai)
function safeId(v) { return (/^[A-Za-z0-9_-]+$/.test(String(v || '')) ? String(v) : ''); }

function normalizeBills(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(bill => {
    if (!bill || typeof bill !== 'object') return null;
    const id = safeId(bill.id);
    bill.id = id || uid();
    if (!Array.isArray(bill.items)) bill.items = [];
    if (!Array.isArray(bill.payments)) bill.payments = [];
    if (!Array.isArray(bill.photos)) bill.photos = [];
    if (typeof bill.name !== 'string') bill.name = '';
    if (typeof bill.date !== 'string') bill.date = '';
    if (PTYPES.indexOf(bill.ptype) < 0) bill.ptype = 'cash';
    // Import/cloud data me negative/NaN values aa sakti hain — totals bigad deti hain
    bill.items = bill.items.filter(it => it && typeof it === 'object').map(it => ({
      name: typeof it.name === 'string' ? it.name : '',
      qty: toNumber(it.qty),
      rate: toNumber(it.rate)
    }));
    bill.payments = bill.payments
      .filter(p => p && typeof p === 'object' && isFinite(Number(p.amount)) && toNumber(p.amount) > 0)
      .map(p => ({ amount: toNumber(p.amount), date: typeof p.date === 'string' ? p.date : '' }));
    return bill;
  }).filter(Boolean);
}

function normalizeSupBills(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(b => {
    if (!b || typeof b !== 'object') return null;
    const id = safeId(b.id);
    b.id = id || uid();
    if (!Array.isArray(b.payments)) b.payments = [];
    if (!Array.isArray(b.products)) b.products = [];
    if (!Array.isArray(b.photos)) b.photos = [];
    if (typeof b.name !== 'string') b.name = '';
    if (typeof b.date !== 'string') b.date = '';
    if (PTYPES.indexOf(b.ptype) < 0) b.ptype = 'credit';
    if (typeof b.deliveryDate !== 'string') b.deliveryDate = '';
    if (typeof b.orderNo !== 'string') b.orderNo = '';
    b.payments = b.payments
      .filter(p => p && typeof p === 'object' && isFinite(Number(p.amount)) && toNumber(p.amount) > 0)
      .map(p => ({ amount: toNumber(p.amount), date: typeof p.date === 'string' ? p.date : '' }));
    b.products = b.products.filter(p => p && typeof p === 'object').map(p => ({
      name: typeof p.name === 'string' ? p.name : '',
      qtyCartons: toNumber(p.qtyCartons),
      rateCartons: toNumber(p.rateCartons),
      qtyUnits: toNumber(p.qtyUnits),
      rateUnits: toNumber(p.rateUnits),
      unitType: typeof p.unitType === 'string' ? p.unitType : ''
    }));
    b.photos = b.photos.filter(s => typeof s === 'string' && (s.startsWith('data:') || s.startsWith('http') || s.startsWith('blob:')));
    return b;
  }).filter(Boolean);
}

// Account-scoped keys — activeDataUid ke bina kisi aur account ka data kabhi na padhe/jaaye
function loadBills() { return activeDataUid ? normalizeBills(readJSON(acctKey('rgs_bills'))) : []; }
function loadSupBills() { return activeDataUid ? normalizeSupBills(readJSON(acctKey('rgs_suppliers'))) : []; }
function normalizeOpenings(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  // Values sanitize: sirf non-negative finite numbers (string/negative imported values ke liye)
  const out = {};
  Object.keys(v).forEach(k => { if (typeof k === 'string' && k.trim()) out[k] = toNumber(v[k]); });
  return out;
}
function loadOpenings() {
  if (!activeDataUid) return {};
  try { return normalizeOpenings(JSON.parse(localStorage.getItem(acctKey('rgs_supplier_openings')) || '{}')); }
  catch { return {}; }
}

// Data tabhi load hota hai jab koi logged-in account ho (see onAuthUser → loadLocalAccountData)
let bills = [];
let supBills = [];
let supplierOpenings = [];

let currentBillId = null, currentSupId = null;
let editingId = null, editingSupId = null;
let editExistingPaid = 0, supExistingPaid = 0;
let currentSupOpening = 0;
let loginReturnTo = 'listScreen';
// Form se hatai gayi photos (Storage files) — sirf save hone ke baad delete hoti hain,
// warna user ne save cancel kar diya to bill me toot-i hui photo reh jaati.
let pendingPhotoDeletes = [];
function queuePhotoDelete(src) { if (typeof src === 'string' && src.startsWith('http')) pendingPhotoDeletes.push(src); }
function flushPhotoDeletes() {
  const list = pendingPhotoDeletes.slice();
  pendingPhotoDeletes = [];
  list.forEach(deleteRemotePhoto);
}

function saveToStorage() {
  if (!activeDataUid) return false;
  const ok = safeSet(acctKey('rgs_bills'), bills);
  if (ok) { markLocalSaved(); scheduleAutoSync(); }
  return ok;
}
function supSave() {
  if (!activeDataUid) return false;
  const ok = safeSet(acctKey('rgs_suppliers'), supBills);
  if (ok) { markLocalSaved(); scheduleAutoSync(); }
  return ok;
}
function saveOpenings() {
  if (!activeDataUid) return false;
  const ok = safeSet(acctKey('rgs_supplier_openings'), supplierOpenings);
  if (ok) { markLocalSaved(); scheduleAutoSync(); }
  return ok;
}
function getBill() { return bills.find(b => b.id === currentBillId) || null; }
function getSup() { return supBills.find(b => b.id === currentSupId) || null; }
function screenVisible(id) {
  const el = document.getElementById(id);
  return !!el && !el.classList.contains('hidden');
}

window.addEventListener('storage', (e) => {
  if (!activeDataUid) return;   // koi account load nahi hai (login screen) — kuch mat badlo
  const kb = acctKey('rgs_bills'), ks = acctKey('rgs_suppliers'), ko = acctKey('rgs_supplier_openings');
  // e.key === null ka matlab storage.clear() hua hai
  if (e.key === null || e.key === kb) {
    bills = loadBills();
    if (screenVisible('listScreen')) renderList();
    else if (screenVisible('detailScreen')) { if (getBill()) renderDetail(); else showList(); }
  }
  if (e.key === null || e.key === ks) {
    supBills = loadSupBills();
    if (screenVisible('supListScreen')) renderSupplierList();
    else if (screenVisible('supDetailScreen')) { if (getSup()) renderSupDetail(); else showSupplierList(); }
  }
  if (e.key === null || e.key === ko) {
    supplierOpenings = loadOpenings();
    if (screenVisible('openingsScreen')) renderOpenings();
    else if (screenVisible('supListScreen')) renderSupplierList();
  }
});

/* ============ SCREEN NAV ============ */
const ALL_SCREENS = ['listScreen','formScreen','detailScreen','supListScreen','supFormScreen','supDetailScreen','settingsScreen','lockScreen','setupScreen','loginScreen','openingsScreen','accountsScreen'];

// Search box par har keystroke par list dobara render hona unnecessary re-render thi
// (bade list me noticeable lag). Chhota debounce — typing turant feel hoti hai,
// par render ek hi baar hota hai.
function debounce(fn, ms) {
  let t = null;
  return function () { clearTimeout(t); const a = arguments, c = this; t = setTimeout(() => fn.apply(c, a), ms); };
}
const renderListSoon = debounce(renderList, 120);
const renderSupplierListSoon = debounce(renderSupplierList, 120);

function showScreen(screen) {
  // Form chhodne par queued photo deletes cancel — save nahi hua to file delete nahi honi chahiye
  if (screen !== 'formScreen' && screen !== 'supFormScreen') pendingPhotoDeletes = [];
  ALL_SCREENS.forEach(id => document.getElementById(id).classList.add('hidden'));
  document.getElementById(screen).classList.remove('hidden');
  window.scrollTo(0, 0);
}

/* ============ CUSTOMER: LIST ============ */
function showList() { currentBillId = null; showScreen('listScreen'); renderList(); }
function renderList() {
  const list = document.getElementById('billList');
  const q = (document.getElementById('billSearch').value || '').trim().toLowerCase();
  list.innerHTML = '';
  let totalPending = 0;
  bills.forEach((bill) => {
    const total = totalAmount(bill);
    const paid = totalPaid(bill);
    const pending = total - paid;
    totalPending += Math.max(pending, 0);
    if (q && !(String(bill.name || '').toLowerCase().includes(q)) && !(String(bill.date || '').toLowerCase().includes(q))) return;
    const card = document.createElement('div');
    card.className = 'card';
    card.onclick = () => openDetail(bill.id);
    const clearBadge = pending <= 0 ? '<span class="badge cash" style="margin-left:8px">Clear</span>' : '';
    const ptype = ptypeClass(bill.ptype);
    card.innerHTML =
      '<h3>' + escapeHtml(bill.name) + clearBadge + '</h3>' +
      '<div class="meta">' + escapeHtml(bill.date || '-') + '</div>' +
      '<div class="row"><span>Total: Rs. ' + formatMoney(total) + '</span>' +
      '<span class="badge ' + ptype + '">' + escapeHtml(ptype) + '</span></div>' +
      '<div class="row"><span>Pending: Rs. ' + formatMoney(Math.max(pending, 0)) + '</span></div>';
    list.appendChild(card);
  });
  document.getElementById('billCount').textContent = bills.length;
  document.getElementById('totalPending').textContent = formatMoney(totalPending);
}

function itemsTotal(bill) { return (bill.items || []).reduce((s, it) => s + Number(it.qty || 0) * Number(it.rate || 0), 0); }
function totalPaid(bill) { return (bill.payments || []).reduce((s, p) => s + Number(p.amount || 0), 0); }
function totalAmount(bill) { return itemsTotal(bill); }

/* ============ CUSTOMER: FORM ============ */
function newBill() {
  editingId = null; editExistingPaid = 0; pendingPhotoDeletes = [];
  document.getElementById('t-formtitle').textContent = 'New Bill';
  document.getElementById('f-name').value = '';
  document.getElementById('f-date').value = today();
  document.getElementById('f-ptype').value = 'cash';
  document.getElementById('f-paid').value = 0;
  document.getElementById('f-paiddate').value = today();
  document.getElementById('f-already').classList.add('hidden');
  document.getElementById('itemsBox').innerHTML = '';
  document.getElementById('customerPhotoRow').innerHTML = '';
  addItemRow(); calcTotal();
  showScreen('formScreen');
}
function editBill() {
  const bill = getBill(); if (!bill) return;
  editingId = bill.id; editExistingPaid = totalPaid(bill);
  pendingPhotoDeletes = [];   // naya form khula → purane queued deletes kisi aur bill par lagu nahi honge
  document.getElementById('t-formtitle').textContent = 'Edit Bill';
  document.getElementById('f-name').value = bill.name || '';
  document.getElementById('f-date').value = bill.date || today();
  document.getElementById('f-ptype').value = bill.ptype || 'cash';
  document.getElementById('f-paid').value = 0;
  document.getElementById('f-paiddate').value = today();
  const alreadyBox = document.getElementById('f-already');
  if (editExistingPaid > 0) { alreadyBox.classList.remove('hidden'); document.getElementById('f-epaid').textContent = formatMoney(editExistingPaid); }
  else alreadyBox.classList.add('hidden');
  const box = document.getElementById('itemsBox'); box.innerHTML = '';
  (bill.items || []).forEach(it => addItemRow(it));
  if (!box.children.length) addItemRow();

  const custPhotoRow = document.getElementById('customerPhotoRow');
  custPhotoRow.innerHTML = '';
  (bill.photos || []).forEach(src => addPhotoThumb(custPhotoRow, src, custPhotoRow.children.length));

  calcTotal(); showScreen('formScreen');
}
function addItemRow(item = null) {
  const it = item || { name: '', qty: '', rate: '' };
  const box = document.getElementById('itemsBox');
  const card = document.createElement('div');
  card.className = 'product-card';
  card.innerHTML =
    '<div class="prod-head"><h4>Item</h4>' +
    '<button type="button" class="btn red tiny" onclick="removeItemCard(this)">✕ Remove</button></div>' +
    '<div class="item-row">' +
      '<input type="text" class="i-name" placeholder="Item" value="' + escapeHtml(it.name) + '" oninput="calcTotal()">' +
      '<input type="number" class="i-qty" min="0" step="any" placeholder="Qty" value="' + escapeHtml(it.qty) + '" oninput="calcTotal()">' +
      '<input type="number" class="i-rate" min="0" step="any" placeholder="Rate" value="' + escapeHtml(it.rate) + '" oninput="calcTotal()">' +
    '</div>';
  box.appendChild(card);
  calcTotal();
}

function removeItemCard(btn) {
  if (!confirm('Remove this item?')) return;
  btn.closest('.product-card').remove();
  calcTotal();
}

function calcTotal() {
  let total = 0;
  document.querySelectorAll('#itemsBox .product-card').forEach(card => {
    const qty = toNumber(card.querySelector('.i-qty').value);
    const rate = toNumber(card.querySelector('.i-rate').value);
    total += qty * rate;
  });
  document.getElementById('f-total').textContent = formatMoney(total);
  const paid = toNumber(document.getElementById('f-paid').value);
  const pending = Math.max(total - editExistingPaid - paid, 0);
  document.getElementById('f-pending').textContent = formatMoney(pending);
}
// Bill photos collect + HAMESHA Cloudinary par upload (koi fallback nahi).
// Returns: null = Cloudinary sign-in nahi hai, ya user ne loading me Cancel dabaya —
//   Cancel par "Photo canceled" alert hota hai aur POORA save abort ho jata hai
//   (photo save nahi hoti, form jaisa tha waisa hi rehta hai).
// warna { photos, failed, cancelled, uploaded, failReason }
async function collectPhotos(rowSelector) {
  const raw = [];
  document.querySelectorAll(rowSelector + ' .photo-thumb').forEach(t => {
    if (t.dataset && t.dataset.src) raw.push(t.dataset.src);
  });
  const hasNew = raw.some(isDataUrl);

  if (!hasNew) return { photos: raw, failed: 0, cancelled: false, uploaded: [], failReason: '' };

  // Cloudinary sign-in nahi hai to upload FAIL — chup-chaap doosre storage par mat bhejo
  if (!isCloudinaryOn()) {
    const reason = cloudinaryNotSignedInReason();
    alert('❌ Photo upload fail.\n\n' + reason +
          '\n\nBina Cloudinary sign-in ke koi bhi photo save nahi hogi (Firebase Storage fallback nahi hai).');
    return null;
  }

  const out = [];
  const uploaded = [];
  let failed = 0;
  let failReason = '';
  // Overlay ka safety timer photo count ke hisaab se: har photo ko 100 sec (upload ka
  // max 90s + buffer), kam se kam 3 min. Pehle 35s/photo tha — compressed photo bhi
  // usme kabhi-kabhi kat jati thi, aur loader atka rehta tha.
  showLoading('Cloudinary par photos upload ho rahi hain...', Math.max(180000, raw.length * 100000), { cancelable: true, sub: '0 / ' + raw.length });
  // Cancel par chal raha upload turant ruk jaye (intezaar na karna pade)
  photoUploadController = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  const signal = photoUploadController ? photoUploadController.signal : undefined;
  try {
    for (const p of raw) {
      if (isDataUrl(p)) {
        if (loadingUserCancelled) break;                    // user ne Cancel dabaya — aage koi upload nahi
        if (loadingCancelled) { failed++; continue; }       // safety timer (auto-timeout) — purana behaviour
        try {
          // Pehle se compressed na ho wali (ya purani) badi photo — upload se pehle chhota kar lo
          const payload = (p.length > 700000) ? await compressImage(p, 1600, 0.8) : p;
          if (loadingUserCancelled) break;
          const url = await uploadPhoto(payload, signal);
          // Cancel dabne ke baad upload poora hua ho tab bhi wo photo save nahi honi chahiye
          if (loadingUserCancelled) { if (url) uploaded.push(url); break; }
          if (url) { out.push(url); uploaded.push(url); } else failed++;
        } catch (e) {
          if (loadingUserCancelled) break;                  // cancel ki wajah se ruka — fail count mat badhao
          console.warn('Photo upload fail:', e);
          failed++;
          // Pehli wajah yaad rakho — user ko batana padega ki photo kyun nahi chadhi
          if (!failReason) failReason = cloudErrorText(e);
        }
      } else {
        out.push(p);
      }
      setLoadingSub((out.length + failed) + ' / ' + raw.length);
    }
  } finally { hideLoading(); photoUploadController = null; }

  // User ne Cancel dabaya → poora save abort. Abhi tak upload ki gayi files bhi
  // delete, taaki orphan file na bache aur form dobara save karne par photo saf se chadhe.
  if (loadingUserCancelled) {
    uploaded.forEach(deleteRemotePhoto);
    alert('Photo canceled');
    return null;
  }
  // Note: user-cancel upar (loadingUserCancelled block) hi 'null' return kar
  // chuka hai. Yahan loadingCancelled true ka matlab sirf safety-timer
  // (auto-timeout) hai, user cancel NAHI — isliye 'cancelled' flag false
  // rakha (warna alert me "aapne upload cancel kiya" galat dikhata).
  return { photos: out, failed, cancelled: false, uploaded, failReason };
}

// Save Bill — button ke andar loading + double-tap protection.
// Photo upload ka full-screen loader collectPhotos() chalta hai; ye sirf
// button state ke liye hai (aur duplicate save rokne ke liye).
async function saveBill() {
  const btn = document.getElementById('saveBillBtn');
  if (!setBusy(btn, true, 'Saving...')) return;
  try { await saveBillInner(); }
  finally { setBusy(btn, false); }
}
async function saveBillInner() {
  const name = document.getElementById('f-name').value.trim();
  if (!name) { alert('Please write customer name'); return; }
  const items = [];
  let incomplete = 0;
  document.querySelectorAll('#itemsBox .product-card').forEach(card => {
    const iname = (card.querySelector('.i-name').value || '').trim();
    const qty = toNumber(card.querySelector('.i-qty').value);
    const rate = toNumber(card.querySelector('.i-rate').value);
    const hasData = !!iname || qty > 0 || rate > 0;
    if (iname && qty > 0) items.push({ name: iname, qty, rate });
    else if (hasData) incomplete++;   // data bhara hai par poora nahi — chup-chaap drop mat karo
  });
  if (incomplete) {
    alert(incomplete + ' item row adhoori hai (naam aur Qty dono zaroori hain).\nPehle use theek karo ya ✕ Remove se hata do.');
    return;
  }
  if (!items.length) { alert('Add at least 1 item'); return; }

  // Payment validation pehle — cancel hone par photo upload na ho
  let paid = toNumber(document.getElementById('f-paid').value);
  const total = itemsTotal({ items });
  const wasEditing = editingId !== null;
  if (editExistingPaid + paid > total) {
    if (!confirm('Amount paid is more than total. Extra will not be counted. Continue?')) return;
    paid = Math.max(total - editExistingPaid, 0);
  }

  // Bill photos (upload)
  const photoRes = await collectPhotos('#customerPhotoRow');
  if (!photoRes) return;
  const billPhotos = photoRes.photos;

  const billData = {
    name,
    date: validDate(document.getElementById('f-date').value),
    ptype: ptypeClass(document.getElementById('f-ptype').value) || 'cash',
    items, payments: [],
    photos: billPhotos
  };
  if (paid > 0) billData.payments.push({ amount: paid, date: validDate(document.getElementById('f-paiddate').value) });
  if (wasEditing) {
    billData.id = editingId;
    const idx = bills.findIndex(b => b.id === editingId);
    if (idx >= 0) billData.payments = (bills[idx].payments || []).concat(billData.payments);
    if (idx >= 0) bills[idx] = billData; else bills.push(billData);
  } else { billData.id = uid(); bills.push(billData); }
  editingId = null; editExistingPaid = 0;
  if (!saveToStorage()) {
    (photoRes.uploaded || []).forEach(deleteRemotePhoto);  // save fail → abhi upload ki gayi files bhi hata do
    return;
  }
  flushPhotoDeletes();   // ab bill me photo sach me nahi hai → Storage se delete safe hai
  if (photoRes.failed) alert(photoRes.failed + ' photo(s) save nahi hui' + (photoRes.cancelled ? ' (aapne upload cancel kiya)' : '') + ' — bill baaki data ke saath save ho gayi.' + (photoRes.failReason ? '\n\nReason: ' + photoRes.failReason : ''));
  if (wasEditing) openDetail(billData.id); else showList();
}
function openDetail(id) { currentBillId = id; renderDetail(); showScreen('detailScreen'); }
function renderDetail() {
  const bill = getBill(); if (!bill) { showList(); return; }
  document.getElementById('d-name').textContent = bill.name || '-';
  const paid = totalPaid(bill);
  const pending = totalAmount(bill) - paid;
  const ptype = ptypeClass(bill.ptype);
  let html = '<div class="meta">Date: ' + escapeHtml(bill.date || '-') + ' | Type: <span class="badge ' + ptype + '">' + escapeHtml(ptype) + '</span></div>';
  (bill.items || []).forEach(it => {
    html += '<div class="row"><span>' + escapeHtml(it.name) + ' × ' + escapeHtml(it.qty) + '</span><span>Rs. ' + formatMoney(Number(it.qty || 0) * Number(it.rate || 0)) + '</span></div>';
  });
  html += '<div class="row" style="font-weight:bold;margin-top:8px"><span>Total</span><span>Rs. ' + formatMoney(totalAmount(bill)) + '</span></div>';

  if (bill.photos && bill.photos.length) {
    html += '<h3 style="margin-top:10px">Bill Photos</h3>';
    html += '<div class="photo-row">' + bill.photos.map((src, i) =>
      '<div class="photo-thumb" onclick="openViewerForCustomerBill(\'' + bill.id + '\',' + i + ')">' +
      '<img src="' + escapeHtml(src) + '"></div>').join('') + '</div>';
  }

  if ((bill.payments || []).length) {
    html += '<h3 style="margin-top:10px">Payment History</h3>';
    bill.payments.forEach((p, idx) => {
      html += '<div class="pay-row"><span>Rs. ' + formatMoney(p.amount) + (p.date ? ' — ' + escapeHtml(p.date) : '') + '</span>' +
        '<button class="del-pay" onclick="removePayment(' + idx + ')">✕</button></div>';
    });
  }
  html += '<div class="row" style="font-weight:bold;margin-top:8px"><span class="' + (pending > 0 ? 'pending' : 'paid') + '">Pending</span><span class="' + (pending > 0 ? 'pending' : 'paid') + '">Rs. ' + formatMoney(Math.max(pending, 0)) + '</span></div>';
  document.getElementById('d-details').innerHTML = html;
}
function removePayment(idx) {
  if (!confirm('Delete this payment?')) return;
  const bill = getBill();
  if (!bill || !bill.payments[idx]) return;
  const removed = bill.payments.splice(idx, 1)[0];
  if (!saveToStorage()) { bill.payments.splice(idx, 0, removed); return; }  // save fail → wapas lao
  renderDetail();
}
function addPayment() {
  const bill = getBill(); if (!bill) return;
  const pending = totalAmount(bill) - totalPaid(bill);
  if (pending <= 0) { alert('No pending!'); return; }
  const input = prompt('Payment amount (Pending: Rs. ' + formatMoney(pending) + '):');
  if (input === null) return;
  const amount = toNumber(input); if (amount <= 0) return;
  let finalAmount = amount;
  if (amount > pending) { if (!confirm('Amount exceeds pending. Continue?')) return; finalAmount = pending; }
  const date = prompt('Payment date (YYYY-MM-DD):', today());
  if (date === null) return;
  if (!isValidDateStr(String(date).trim())) { alert('Date galat hai. YYYY-MM-DD likho (misal: 2026-09-26).'); return; }
  bill.payments.push({ amount: finalAmount, date: String(date).trim() });
  if (!saveToStorage()) { bill.payments.pop(); return; }   // save fail → payment wapas hata do (memory = disk)
  renderDetail();
}
function deleteBill() {
  const idx = bills.findIndex(b => b.id === currentBillId);
  if (idx < 0) return;
  const removed = bills[idx];
  let msg = 'Delete this bill permanently?';
  if ((removed.payments || []).length) msg += '\n\n⚠ Is bill ke ' + removed.payments.length + ' payment(s) bhi delete honge (pending wapas badh jayega).';
  if ((removed.photos || []).length) msg += '\nIs bill ki ' + removed.photos.length + ' photo(b) bhi Storage se delete hongi.';
  if (!confirm(msg)) return;
  bills.splice(idx, 1); currentBillId = null;
  if (!saveToStorage()) { bills.splice(idx, 0, removed); return; }  // save fail → delete wapas cancel
  (removed.photos || []).forEach(deleteRemotePhoto);   // bill gaya to Storage ki files bhi
  showList();
}

/* ============ SHARE (bill image → device native share sheet) ============ */
// Share button: bill ka data dekh kar ek saaf-suthra, professional bill-IMAGE
// banata hai aur wahi image seedha device ke native share sheet me daalta hai
// (WhatsApp, Messenger, Bluetooth, email, nearby share — jo bhi app mile).
// • Plain text share nahi hota.
// • Phone number dakhil karne ki zaroorat nahi.
// • Calculations bill ke maujooda functions se hi aate hain (koi naya formula nahi).

function normalizePhone(raw) {   // purana helper — jaisa tha waisa hi rakha
  let p = String(raw).replace(/\D/g, '');
  if (!p) return '';
  if (p.startsWith('00')) p = p.slice(2);
  if (p.startsWith('92') && p.length === 12) return p;
  if (p.length === 11 && p.startsWith('0')) return '92' + p.slice(1);
  if (p.length === 10 && p.startsWith('3')) return '92' + p;
  return p;
}

const SHARE_FONT = "'Segoe UI', Roboto, system-ui, -apple-system, Arial, sans-serif";

function shareStoreName() {
  const el = document.getElementById('t-store');
  const n = el && el.textContent ? String(el.textContent).trim() : '';
  return n || 'Rajpoot General Store';
}

/* ---- text helpers (canvas ke liye) ---- */
function shareFitText(ctx, text, maxWidth) {
  const s = String(text == null ? '' : text);
  if (!s) return '';
  if (ctx.measureText(s).width <= maxWidth) return s;
  let out = s;
  while (out.length > 1 && ctx.measureText(out + '…').width > maxWidth) out = out.slice(0, -1);
  return out + '…';
}
function shareWrapLines(ctx, text, maxWidth) {
  const src = String(text == null ? '' : text).trim();
  if (!src) return [];
  const lines = [];
  let line = '';
  src.split(/\s+/).forEach(word => {
    let w = word;
    while (ctx.measureText(w).width > maxWidth) {          // ek hi shabd lamba ho to kaat ke alag line
      if (line) { lines.push(line); line = ''; }
      let cut = w.length;
      while (cut > 1 && ctx.measureText(w.slice(0, cut)).width > maxWidth) cut--;
      lines.push(w.slice(0, cut));
      w = w.slice(cut);
    }
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width <= maxWidth) line = test;
    else { if (line) lines.push(line); line = w; }
  });
  if (line) lines.push(line);
  return lines;
}
function shareClampLines(ctx, lines, maxLines, maxWidth) {
  if (lines.length <= maxLines) return lines;
  const out = lines.slice(0, maxLines);
  let last = out[maxLines - 1];
  while (last.length > 1 && ctx.measureText(last + '…').width > maxWidth) last = last.slice(0, -1);
  out[maxLines - 1] = last + '…';
  return out;
}

/* ---- layout (measure pass) ---- */
function shareMeasure(spec) {
  const W = 900, PAD = 44;
  const CONTENT = W - PAD * 2;                                   // 812
  const COLS = { qty: 160, rate: 160, amt: 182 };
  const ITEM_W = CONTENT - COLS.qty - COLS.rate - COLS.amt;       // 310
  const TEXT_W = ITEM_W - 28;                                     // naam/QTY ke beech gap
  const ctx = document.createElement('canvas').getContext('2d');
  const nameFont = '600 24px ' + SHARE_FONT;
  const subFont = '20px ' + SHARE_FONT;
  const raw = (spec.rows && spec.rows.length) ? spec.rows : [{ name: spec.emptyNote || 'No items', empty: true }];
  const measured = raw.map(r => {
    ctx.font = nameFont;
    const nameLines = shareClampLines(ctx, shareWrapLines(ctx, r.name || '-', TEXT_W), 2, TEXT_W);
    let subLines = [];
    if (r.sub) { ctx.font = subFont; subLines = shareClampLines(ctx, shareWrapLines(ctx, r.sub, TEXT_W), 2, TEXT_W); }
    const h = Math.max(36, nameLines.length * 32) + (subLines.length ? subLines.length * 26 + 4 : 0) + 20;
    return { r, nameLines, subLines, h };
  });
  const metaLines = (spec.meta || []).filter(m => m);
  const totals = spec.totals || [];
  const rowsH = measured.reduce((s, x) => s + x.h, 0);
  const estimate = 116 + 62 + (metaLines.length ? metaLines.length * 28 + 16 : 0) + 46 + rowsH +
                   18 + (totals.length * 44 + 24) + 30 + 58 + 60;
  return { W, PAD, CONTENT, COLS, ITEM_W, TEXT_W, nameFont, subFont, measured, metaLines, totals, estimate };
}

/* ---- drawing (paint pass) ---- */
function sharePaint(ctx, spec, L) {
  const W = L.W, PAD = L.PAD, CONTENT = L.CONTENT, COLS = L.COLS, ITEM_W = L.ITEM_W;
  const brand = '#1a73e8', text = '#202124', sub = '#5f6368', line = '#e4e7eb',
        tint = '#e8f0fe', panel = '#f7f9fc', red = '#dc3545', green = '#28a745';
  const qtyRight = PAD + ITEM_W + COLS.qty - 12;
  const rateRight = qtyRight + COLS.rate;
  const amtRight = W - PAD - 12;

  ctx.textBaseline = 'alphabetic';

  // ---------- header ----------
  ctx.fillStyle = brand; ctx.fillRect(0, 0, W, 116);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#fff'; ctx.font = '700 36px ' + SHARE_FONT;
  ctx.fillText(shareFitText(ctx, spec.store || shareStoreName(), CONTENT - 230), PAD, 60);
  ctx.font = '20px ' + SHARE_FONT; ctx.fillStyle = 'rgba(255,255,255,.93)';
  ctx.fillText(spec.heading || '', PAD, 94);
  ctx.textAlign = 'right';
  ctx.font = '600 15px ' + SHARE_FONT; ctx.fillStyle = 'rgba(255,255,255,.8)';
  ctx.fillText('DATE', W - PAD, 50);
  ctx.font = '700 26px ' + SHARE_FONT; ctx.fillStyle = '#fff';
  ctx.fillText(spec.date || '-', W - PAD, 86);
  ctx.textAlign = 'left';

  // ---------- party (customer/supplier) ----------
  let y = 116;
  ctx.font = '700 26px ' + SHARE_FONT; ctx.fillStyle = text;
  ctx.fillText(shareFitText(ctx, (spec.partyLabel || '') + ': ' + (spec.partyName || '-'), CONTENT), PAD, y + 40);
  y += 40;
  ctx.font = '21px ' + SHARE_FONT; ctx.fillStyle = sub;
  L.metaLines.forEach(m => { y += 28; ctx.fillText(shareFitText(ctx, m, CONTENT), PAD, y); });
  y += 22;

  // ---------- table header ----------
  ctx.fillStyle = tint; ctx.fillRect(PAD, y, CONTENT, 44);
  ctx.font = '700 16px ' + SHARE_FONT; ctx.fillStyle = brand;
  ctx.textAlign = 'left';  ctx.fillText('ITEM', PAD + 14, y + 28);
  ctx.textAlign = 'right';
  ctx.fillText('QTY', qtyRight, y + 28);
  ctx.fillText('RATE (Rs.)', rateRight, y + 28);
  ctx.fillText('AMOUNT (Rs.)', amtRight, y + 28);
  ctx.textAlign = 'left';
  y += 44;

  // ---------- rows ----------
  L.measured.forEach(m => {
    const r = m.r, top = y;
    if (r.empty) {
      ctx.font = '20px ' + SHARE_FONT; ctx.fillStyle = sub;
      ctx.fillText(m.nameLines.join(' ') || 'No items', PAD + 14, top + 36);
    } else {
      let ty = top + 36;
      ctx.font = L.nameFont; ctx.fillStyle = text;
      m.nameLines.forEach(l => { ctx.fillText(l, PAD + 14, ty); ty += 32; });
      if (m.subLines.length) {
        ctx.font = L.subFont; ctx.fillStyle = sub;
        let sy = top + 36 + (m.nameLines.length - 1) * 32 + 28;
        m.subLines.forEach(l => { ctx.fillText(l, PAD + 14, sy); sy += 26; });
      }
      ctx.textAlign = 'right';
      ctx.font = '21px ' + SHARE_FONT; ctx.fillStyle = text;
      if (r.qty) ctx.fillText(String(r.qty), qtyRight, top + 36);
      ctx.fillStyle = sub;
      if (r.rate) ctx.fillText(String(r.rate), rateRight, top + 36);
      ctx.font = '600 23px ' + SHARE_FONT; ctx.fillStyle = text;
      if (r.amount) ctx.fillText(String(r.amount), amtRight, top + 36);
      ctx.textAlign = 'left';
    }
    ctx.fillStyle = line; ctx.fillRect(PAD, top + m.h - 1, CONTENT, 1);
    y = top + m.h;
  });

  // ---------- totals ----------
  y += 18;
  const BOX_W = 420, boxX = W - PAD - BOX_W;
  const boxH = Math.max(1, L.totals.length) * 44 + 24;
  ctx.fillStyle = panel; ctx.fillRect(boxX, y, BOX_W, boxH);
  ctx.strokeStyle = line; ctx.lineWidth = 1;
  if (ctx.strokeRect) ctx.strokeRect(boxX + 0.5, y + 0.5, BOX_W - 1, boxH - 1);
  let ty = y + 40;
  L.totals.forEach((t, i) => {
    const last = i === L.totals.length - 1;
    ctx.textAlign = 'left';
    ctx.font = (last ? '700 25px ' : (t.em ? '700 24px ' : '500 23px ')) + SHARE_FONT;
    ctx.fillStyle = text;
    ctx.fillText(t.label, boxX + 18, ty);
    ctx.textAlign = 'right';
    ctx.font = (last ? '700 25px ' : (t.em ? '700 24px ' : '500 23px ')) + SHARE_FONT;
    if (last) ctx.fillStyle = (Number(t.value) > 0) ? red : green;
    else ctx.fillStyle = (t.em || t.balance) ? text : sub;
    ctx.fillText('Rs. ' + formatMoney(t.value), boxX + BOX_W - 18, ty);
    ty += 44;
  });
  ctx.textAlign = 'left';
  y += boxH + 30;

  // ---------- footer ----------
  ctx.fillStyle = line; ctx.fillRect(PAD, y, CONTENT, 1);
  y += 32;
  ctx.font = '20px ' + SHARE_FONT; ctx.fillStyle = sub;
  ctx.fillText('Thank you — Shukriya!', PAD, y);
  ctx.textAlign = 'right';
  ctx.font = '18px ' + SHARE_FONT; ctx.fillStyle = sub;
  ctx.fillText(spec.heading || '', W - PAD, y);
  ctx.textAlign = 'left';
  y += 26;
  return y;                       // asli use ki gayi height
}

function shareBuildCanvas(spec) {
  const L = shareMeasure(spec);
  let H = Math.ceil(L.estimate);
  let canvas, ctx, used, guard = 0;
  const fresh = () => {
    const c = document.createElement('canvas');
    c.width = L.W; c.height = H;
    const x = c.getContext('2d');
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, L.W, H);
    return [c, x];
  };
  [canvas, ctx] = fresh();
  used = sharePaint(ctx, spec, L);
  while (used > H && guard++ < 3) {          // bahut lambi bill → bada canvas
    H = Math.ceil(used + 30);
    [canvas, ctx] = fresh();
    used = sharePaint(ctx, spec, L);
  }
  if (used < H) {                            // neeche ki faltu white jagah kaat do
    const out = document.createElement('canvas');
    out.width = L.W; out.height = Math.max(1, Math.ceil(used));
    const octx = out.getContext('2d');
    octx.fillStyle = '#ffffff'; octx.fillRect(0, 0, out.width, out.height);
    octx.drawImage(canvas, 0, 0);
    return out;
  }
  return canvas;
}

function shareDataUrlToBlob(dataUrl) {
  try {
    const bin = atob(String(dataUrl).slice(String(dataUrl).indexOf(',') + 1));
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: 'image/png' });
  } catch (e) { console.warn('Share image blob fail:', e); return null; }
}
function shareFileName(spec, nameHint) {
  const safe = v => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'bill';
  return 'bill-' + safe(nameHint) + '-' + safe(spec.date) + '.png';
}

/* ---- image ko device ke native share sheet me bhejo ---- */
function shareToNativeSheet(blob, filename, title) {
  const download = () => {
    if (!blob) { alert('❌ Bill image banayi nahi ja saki.'); return; }
    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} try { a.remove(); } catch (e) {} }, 3000);
      alert('ℹ️ Is device/browser me direct share sheet support nahi hai.\n\nBill image download ho gayi hai — use kisi bhi app (WhatsApp, email, Bluetooth) me bhej do.');
    } catch (e) { console.warn('Share fallback fail:', e); alert('❌ Bill image share nahi ho payi.'); }
  };

  let file = null;
  try {
    if (blob && typeof File !== 'undefined') file = new File([blob], filename, { type: 'image/png' });
  } catch (e) { file = null; }

  if (file && navigator.share && navigator.canShare) {
    try {
      if (navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: title }).catch(err => {
          if (err && err.name === 'AbortError') return;      // user ne cancel kiya — theek hai
          console.warn('Share fail:', err);
          download();
        });
        return;
      }
    } catch (e) { console.warn('Share sheet error:', e); }
  }
  download();
}

function shareSendBillImage(spec, nameHint) {
  let canvas = null, dataUrl = '';
  try { canvas = shareBuildCanvas(spec); }
  catch (e) { console.warn('Bill image nahi bani:', e); alert('❌ Bill image nahi ban payi.\n' + (e && e.message ? e.message : e)); return; }
  try { dataUrl = canvas.toDataURL('image/png'); }
  catch (e) { console.warn('toDataURL fail:', e); }
  const blob = dataUrl ? shareDataUrlToBlob(dataUrl) : null;
  shareToNativeSheet(blob, shareFileName(spec, nameHint), (spec.heading || 'Bill') + ' — ' + (spec.partyName || ''));
}

/* ---- CUSTOMER BILL → Share ---- */
function shareBill() {
  const bill = getBill(); if (!bill) return;
  const paid = totalPaid(bill);
  const pending = totalAmount(bill) - paid;          // (purane share ki wahi calculation)
  const spec = {
    heading: 'Customer Bill',
    partyLabel: 'Customer',
    partyName: bill.name || '-',
    date: bill.date || '-',
    emptyNote: 'No items in this bill',
    meta: ['Payment type: ' + String(bill.ptype || 'cash').toUpperCase()],
    rows: (bill.items || []).map(it => ({
      name: it.name || '-',
      qty: (it.qty === undefined || it.qty === null || it.qty === '') ? '-' : String(it.qty),
      rate: formatMoney(it.rate),
      amount: formatMoney(Number(it.qty || 0) * Number(it.rate || 0))
    })),
    totals: [
      { label: 'Total Bill', value: totalAmount(bill), em: true },
      { label: 'Amount Paid', value: paid },
      { label: 'Pending', value: Math.max(pending, 0), balance: true }
    ]
  };
  shareSendBillImage(spec, 'customer-bill ' + (bill.name || '') + ' ' + (bill.date || ''));
}

/* ============ SUPPLIER: HELPERS ============ */
function productTotal(p) {
  return (toNumber(p.qtyCartons) * toNumber(p.rateCartons)) + (toNumber(p.qtyUnits) * toNumber(p.rateUnits));
}
function supBillTotal(b) {
  return (b.products || []).reduce((s, p) => s + productTotal(p), 0);
}
function supPaid(b) { return (b.payments || []).reduce((s, p) => s + Number(p.amount || 0), 0); }

// Supplier ka naam type karte waqt alag-alag ho sakta hai ("Ram" vs "ram"). Exact-match
// par grouping karne se uska khata do hisso me toot jata tha — dues galat dikhte the.
// Isliye grouping hamesha case-insensitive key par hoti hai; display naam waisa hi rehta hai.
function supKey(name) { return String(name || '').trim().toLowerCase(); }
function findOpeningKey(name) {
  const k = supKey(name);
  if (!k) return '';
  if (Object.prototype.hasOwnProperty.call(supplierOpenings, k)) return k;
  return Object.keys(supplierOpenings).find(x => x.toLowerCase() === k) || '';
}
// Pehle se maujood supplier ka wahi spelling wapas do — naye bill usi me judenge
function supplierDisplayName(name) {
  const k = supKey(name);
  if (!k) return '';
  const existing = supBills.find(b => supKey(b.name) === k);
  if (existing) return existing.name;
  const okey = findOpeningKey(name);
  if (okey) return okey;
  return String(name).trim();
}
function getOpeningFor(name) {
  const key = findOpeningKey(name);
  return key ? Number(supplierOpenings[key] || 0) : 0;
}
function setOpeningFor(name, amount) {
  const display = supplierDisplayName(name);
  if (!display) return;
  const key = findOpeningKey(name) || display;
  if (amount > 0) supplierOpenings[key] = amount;
  else delete supplierOpenings[key];
  saveOpenings();
}
// Supplier-level total dues (opening + all their bills - all their payments)
function supplierTotalDues(name) {
  const k = supKey(name);
  const opening = getOpeningFor(name);
  let total = opening, paid = 0;
  supBills.forEach(b => {
    if (supKey(b.name) === k) {
      total += supBillTotal(b);
      paid += supPaid(b);
    }
  });
  return { total, paid, due: total - paid, opening };
}

/* ============ SUPPLIER: LIST ============ */
function showSupplierList() { currentSupId = null; showScreen('supListScreen'); renderSupplierList(); }

function onFilterChange() {
  const v = document.getElementById('supDateFilter').value;
  document.getElementById('customRangeBox').classList.toggle('hidden', v !== 'custom');
  renderSupplierList();
}

function inDateRange(dateStr, filter, from, to) {
  if (!dateStr) return filter === 'all' || filter === 'custom';
  const d = new Date(dateStr + 'T00:00:00');
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  if (filter === 'all') return true;
  if (filter === 'thisMonth') return d.getFullYear() === y && d.getMonth() === m;
  if (filter === 'lastMonth') {
    const lm = m === 0 ? 11 : m - 1;
    const ly = m === 0 ? y - 1 : y;
    return d.getFullYear() === ly && d.getMonth() === lm;
  }
  if (filter === 'thisYear') return d.getFullYear() === y;
  if (filter === 'last3') {
    const threeAgo = new Date(y, m - 2, 1);
    return d >= threeAgo;
  }
  if (filter === 'custom') {
    if (from && d < new Date(from + 'T00:00:00')) return false;
    if (to && d > new Date(to + 'T23:59:59')) return false;
    return true;
  }
  return true;
}

function renderSupplierList() {
  const list = document.getElementById('supList');
  const q = (document.getElementById('supSearch').value || '').trim().toLowerCase();
  const filter = document.getElementById('supDateFilter').value;
  const from = document.getElementById('customFrom').value;
  const to = document.getElementById('customTo').value;

  list.innerHTML = '';
  let shownCount = 0;

  // Har supplier ka stats ek hi baar nikalo (pehle har card par O(n) tha → O(n^2))
  // Key case-insensitive — "Ram" aur "ram" ka dues ek hi jagah jama ho
  const statsByName = new Map();
  let totalPurchased = 0;
  function statsFor(name) {
    const key = supKey(name);
    let s = statsByName.get(key);
    if (!s) { s = { opening: getOpeningFor(name), billsTotal: 0, paid: 0 }; statsByName.set(key, s); }
    return s;
  }
  supBills.forEach(b => {
    const s = statsFor(b.name || '');
    const t = supBillTotal(b);
    s.billsTotal += t;
    s.paid += supPaid(b);
    totalPurchased += t;                 // Total Purchases = har supplier bill (kabhi ka bhi)
  });
  Object.keys(supplierOpenings).forEach(n => statsFor(n)); // sirf opening wale suppliers bhi count ho

  // Opening balance har supplier ki sirf EK baar add hoti hai (case-insensitive duplicate keys ke saath bhi)
  let openingSum = 0;
  const openingSeen = new Set();
  Object.keys(supplierOpenings).forEach(k => {
    const key = supKey(k);
    if (!key || openingSeen.has(key)) return;
    openingSeen.add(key);
    openingSum += toNumber(supplierOpenings[k]);
  });
  function duesOf(name) {
    const s = statsFor(name);
    const total = s.opening + s.billsTotal;
    return { total, paid: s.paid, due: total - s.paid, opening: s.opening };
  }

  supBills.forEach((b) => {
    if (!inDateRange(b.date, filter, from, to)) return;

    const nameMatch = String(b.name || '').toLowerCase().includes(q);
    const dateMatch = String(b.date || '').toLowerCase().includes(q);
    const orderMatch = String(b.orderNo || '').toLowerCase().includes(q);
    const delMatch = String(b.deliveryDate || '').toLowerCase().includes(q);
    if (q && !nameMatch && !dateMatch && !orderMatch && !delMatch) return;

    shownCount++;
    const thisTotal = supBillTotal(b);
    // Supplier-level total due (sirf is bill ka nahi)
    const supStats = duesOf(b.name || '');

    // Determine badge for this bill
    let badgeClass = '', badgeText = '';
    if (supStats.due <= 0) { badgeClass = 'badge-paid'; badgeText = 'PAID'; }
    else if (supStats.paid > 0) { badgeClass = 'badge-partial'; badgeText = 'PARTIAL'; }
    else { badgeClass = 'badge-due'; badgeText = 'DUE'; }

    const card = document.createElement('div');
    card.className = 'card';
    card.onclick = () => { currentSupId = b.id; renderSupDetail(); showScreen('supDetailScreen'); };
    card.innerHTML =
      '<span class="card-badge ' + badgeClass + '">' + badgeText + '</span>' +
      '<h3>' + escapeHtml(b.name || '-') + '</h3>' +
      '<div class="meta">' + escapeHtml(b.date || '-') +
        (b.orderNo ? ' | Order: ' + escapeHtml(b.orderNo) : '') +
        (b.deliveryDate ? ' | Del: ' + escapeHtml(b.deliveryDate) : '') + '</div>' +
      '<div class="row"><span>Bill Total: Rs. ' + formatMoney(thisTotal) + '</span>' +
      ptypeBadge(b.ptype, 'credit') + '</div>' +
      '<div class="row"><span>Products: ' + (b.products || []).length + '</span></div>' +
      '<div class="row"><span class="' + (supStats.due > 0 ? 'pending' : 'paid') + '">' +
        'Total Dues: Rs. ' + formatMoney(Math.max(supStats.due, 0)) + '</span></div>';
    list.appendChild(card);
  });

  // Total dues + supplier count (filter se independent)
  let grandDue = 0, supplierCount = 0;
  statsByName.forEach((s, n) => {
    if (!n) return;
    supplierCount++;
    grandDue += Math.max(s.opening + s.billsTotal - s.paid, 0);
  });

  document.getElementById('supCount').textContent = supplierCount;
  document.getElementById('totalDue').textContent = formatMoney(grandDue);

  // Total Purchases block (filter/search se independent — "till now" wala hisaab)
  const setPurchase = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = formatMoney(v); };
  setPurchase('supPurchasesBills', totalPurchased);
  setPurchase('supPurchasesOpening', openingSum);
  setPurchase('supPurchasesGrand', totalPurchased + openingSum);

  const summary = document.getElementById('filterSummary');
  if (filter === 'all') summary.textContent = 'Showing all ' + shownCount + ' bills';
  else if (filter === 'custom') summary.textContent = shownCount + ' bills in range';
  else summary.textContent = shownCount + ' bills shown';
}

/* ============ OPENINGS MANAGER ============ */
function openOpeningsManager() {
  renderOpenings();
  showScreen('openingsScreen');
}
function renderOpenings() {
  const list = document.getElementById('openingsList');
  // supKey par group: "Ram" aur "ram" ek hi card par aaye
  const names = new Map();
  Object.keys(supplierOpenings).forEach(n => names.set(supKey(n), n));
  supBills.forEach(b => { const k = supKey(b.name); if (k && !names.has(k)) names.set(k, b.name); });
  list.innerHTML = '';
  if (!names.size) {
    list.innerHTML = '<div class="card" style="cursor:default">Koi supplier nahi. Pehle bill banao ya neeche button se opening add karo.</div>';
    return;
  }
  names.forEach(name => {
    const opening = getOpeningFor(name);
    const stats = supplierTotalDues(name);
    const card = document.createElement('div');
    card.className = 'card';
    card.style.cursor = 'default';
    card.innerHTML =
      '<h3>' + escapeHtml(name) + '</h3>' +
      '<div class="row"><span>Opening:</span><span>Rs. ' + formatMoney(opening) + '</span></div>' +
      '<div class="row"><span>Bills Total:</span><span>Rs. ' + formatMoney(stats.total - stats.opening) + '</span></div>' +
      '<div class="row"><span>Paid:</span><span>Rs. ' + formatMoney(stats.paid) + '</span></div>' +
      '<div class="row"><span class="' + (stats.due > 0 ? 'pending' : 'paid') + '">Dues:</span>' +
      '<span class="' + (stats.due > 0 ? 'pending' : 'paid') + '">Rs. ' + formatMoney(Math.max(stats.due, 0)) + '</span></div>';
    // Button DOM se banao (string-built onclick me apostrophe/quote wale naam par toot jata tha)
    const btn = document.createElement('button');
    btn.className = 'btn small';
    btn.type = 'button';
    btn.style.marginTop = '8px';
    btn.textContent = '✏️ Set / Edit Opening';
    btn.addEventListener('click', () => editOpening(name));
    card.appendChild(btn);
    list.appendChild(card);
  });
}
function editOpening(name) {
  const cur = getOpeningFor(name);
  const v = prompt('Opening balance for "' + name + '" (Rs.):', String(cur));
  if (v === null) return;
  const n = Number(v);
  if (!isFinite(n) || n < 0) { alert('Invalid amount.'); return; }
  setOpeningFor(name, n);
  renderOpenings();
}
function addNewOpening() {
  const name = prompt('Supplier name:');
  if (!name || !name.trim()) return;
  const v = prompt('Opening balance (Rs.):', '0');
  if (v === null) return;
  const n = Number(v);
  if (!isFinite(n) || n < 0) { alert('Invalid amount.'); return; }
  setOpeningFor(name.trim(), n);
  renderOpenings();
}

/* ============ SUPPLIER: FORM ============ */
function addProductRow(product = null) {
  const box = document.getElementById('productsBox');
  const idx = box.children.length;
  const p = product || { name: '', qtyCartons: 0, rateCartons: 0, qtyUnits: 0, rateUnits: 0, unitType: '' };
  const card = document.createElement('div');
  card.className = 'product-card';
  card.dataset.idx = idx;

  card.innerHTML =
    '<div class="prod-head"><h4>Product #' + (idx + 1) + '</h4>' +
    '<button type="button" class="btn red tiny" onclick="removeProductCard(this)">✕ Remove</button></div>' +

    '<label>Product Name</label>' +
    '<input type="text" class="p-name" placeholder="Product name" value="' + escapeHtml(p.name) + '">' +

    '<div class="grid2" style="margin-top:6px">' +
      '<div><label>Qty (Cartons)</label><input type="number" min="0" step="any" class="p-qc" value="' + numVal(p.qtyCartons) + '" oninput="recalcProducts()"></div>' +
      '<div><label>Rate per Carton</label><input type="number" min="0" step="any" class="p-rc" value="' + numVal(p.rateCartons) + '" oninput="recalcProducts()"></div>' +
    '</div>' +

    '<div class="grid3" style="margin-top:6px">' +
      '<div><label>Qty (Units)</label><input type="number" min="0" step="any" class="p-qu" value="' + numVal(p.qtyUnits) + '" oninput="recalcProducts()"></div>' +
      '<div><label>Unit Type</label><input list="unitTypes" class="p-ut" placeholder="kg/g/L" value="' + escapeHtml(p.unitType || '') + '"></div>' +
      '<div><label>Rate per Unit</label><input type="number" min="0" step="any" class="p-ru" value="' + numVal(p.rateUnits) + '" oninput="recalcProducts()"></div>' +
    '</div>' +

    '<div style="margin-top:6px;font-size:12px;color:#666">Product Total: Rs. <span class="p-total">0</span></div>';

  box.appendChild(card);
  updateProductNumbers();
  recalcProducts();
}

function removeProductCard(btn) {
  if (!confirm('Remove this product?')) return;
  btn.closest('.product-card').remove();
  updateProductNumbers();
  recalcProducts();
}

function updateProductNumbers() {
  document.querySelectorAll('#productsBox .product-card').forEach((c, i) => {
    c.querySelector('.prod-head h4').textContent = 'Product #' + (i + 1);
  });
}

// Returns { products, incomplete } — incomplete = aise rows jinme kuch data hai par
// naam ya qty/rate adhoora hai. Aise rows ko chup-chaap drop nahi kiya jaata (data loss hota tha).
function getProductsFromForm() {
  const products = [];
  let incomplete = 0;
  document.querySelectorAll('#productsBox .product-card').forEach(card => {
    const p = {
      name: (card.querySelector('.p-name').value || '').trim(),
      qtyCartons: toNumber(card.querySelector('.p-qc').value),
      rateCartons: toNumber(card.querySelector('.p-rc').value),
      qtyUnits: toNumber(card.querySelector('.p-qu').value),
      unitType: (card.querySelector('.p-ut').value || '').trim(),
      rateUnits: toNumber(card.querySelector('.p-ru').value)
    };
    const hasQty = p.qtyCartons > 0 || p.qtyUnits > 0;
    const hasAny = !!p.name || hasQty || p.rateCartons > 0 || p.rateUnits > 0 || !!p.unitType;
    // Valid = naam + qty maujood (rate 0 bhi chalta hai — muft/free maal)
    if (p.name && hasQty) products.push(p);
    else if (hasAny) incomplete++;
  });
  return { products, incomplete };
}

function recalcProducts() {
  let total = 0;
  document.querySelectorAll('#productsBox .product-card').forEach(card => {
    const p = {
      qtyCartons: toNumber(card.querySelector('.p-qc').value),
      rateCartons: toNumber(card.querySelector('.p-rc').value),
      qtyUnits: toNumber(card.querySelector('.p-qu').value),
      rateUnits: toNumber(card.querySelector('.p-ru').value)
    };
    const t = productTotal(p);
    card.querySelector('.p-total').textContent = formatMoney(t);
    total += t;
  });
  document.getElementById('s-total').textContent = formatMoney(total);
  supCalc();
}

function onSupplierNameChange() {
  const name = document.getElementById('s-name').value.trim();
  currentSupOpening = getOpeningFor(name);
  const box = document.getElementById('s-opening-box');
  if (name && currentSupOpening > 0) {
    box.classList.remove('hidden');
    document.getElementById('s-opening-val').textContent = formatMoney(currentSupOpening);
  } else {
    box.classList.add('hidden');
  }
  supCalc();
}

function editOpeningForCurrent() {
  const name = document.getElementById('s-name').value.trim();
  if (!name) { alert('Pehle supplier ka naam likho.'); return; }
  const cur = getOpeningFor(name);
  const v = prompt('Opening balance for "' + name + '" (Rs.):', String(cur));
  if (v === null) return;
  const n = Number(v);
  if (!isFinite(n) || n < 0) { alert('Invalid amount.'); return; }
  setOpeningFor(name, n);
  onSupplierNameChange();
}

function newSupBill() {
  editingSupId = null; supExistingPaid = 0; currentSupOpening = 0; pendingPhotoDeletes = [];
  document.getElementById('t-supformtitle').textContent = 'New Supplier Bill';
  document.getElementById('s-name').value = '';
  document.getElementById('s-date').value = today();
  document.getElementById('s-delivery').value = today();
  document.getElementById('s-orderno').value = '';
  document.getElementById('s-ptype').value = 'credit';
  document.getElementById('s-paid').value = 0;
  document.getElementById('s-paiddate').value = today();
  document.getElementById('s-already').classList.add('hidden');
  document.getElementById('s-opening-box').classList.add('hidden');
  document.getElementById('supplierPhotoRow').innerHTML = '';
  document.getElementById('productsBox').innerHTML = '';
  addProductRow();
  document.getElementById('s-total').textContent = '0';
  document.getElementById('s-prev-box').classList.add('hidden');
  document.getElementById('s-grand').textContent = '0';
  document.getElementById('s-pending').textContent = '0';
  showScreen('supFormScreen');
}

function editSupBill() {
  const b = getSup(); if (!b) return;
  editingSupId = b.id;
  supExistingPaid = supPaid(b);
  currentSupOpening = getOpeningFor(b.name || '');
  pendingPhotoDeletes = [];   // naya form khula → purane queued deletes idhar lagu nahi honge
  document.getElementById('t-supformtitle').textContent = 'Edit Supplier Bill';
  document.getElementById('s-name').value = b.name || '';
  document.getElementById('s-date').value = b.date || today();
  document.getElementById('s-delivery').value = b.deliveryDate || '';
  document.getElementById('s-orderno').value = b.orderNo || '';
  document.getElementById('s-ptype').value = b.ptype || 'credit';
  document.getElementById('s-paid').value = 0;
  document.getElementById('s-paiddate').value = today();

  const alreadyBox = document.getElementById('s-already');
  if (supExistingPaid > 0) { alreadyBox.classList.remove('hidden'); document.getElementById('s-epaid').textContent = formatMoney(supExistingPaid); }
  else alreadyBox.classList.add('hidden');

  document.getElementById('s-opening-box').classList.toggle('hidden', currentSupOpening <= 0);
  if (currentSupOpening > 0) document.getElementById('s-opening-val').textContent = formatMoney(currentSupOpening);

  const supPhotoRow = document.getElementById('supplierPhotoRow');
  supPhotoRow.innerHTML = '';
  (b.photos || []).forEach(src => addPhotoThumb(supPhotoRow, src, supPhotoRow.children.length));

  const box = document.getElementById('productsBox'); box.innerHTML = '';
  (b.products || []).forEach(p => addProductRow(p));
  if (!box.children.length) addProductRow();
  recalcProducts();
  showScreen('supFormScreen');
}

function supCalc() {
  const thisBill = Array.from(document.querySelectorAll('#productsBox .product-card')).reduce((s, card) => {
    const p = {
      qtyCartons: toNumber(card.querySelector('.p-qc').value),
      rateCartons: toNumber(card.querySelector('.p-rc').value),
      qtyUnits: toNumber(card.querySelector('.p-qu').value),
      rateUnits: toNumber(card.querySelector('.p-ru').value)
    };
    return s + productTotal(p);
  }, 0);
  const paid = toNumber(document.getElementById('s-paid').value);
  const prev = currentSupOpening;
  const grand = thisBill + prev;
  const remaining = Math.max(grand - supExistingPaid - paid, 0);

  document.getElementById('s-total').textContent = formatMoney(thisBill);
  const prevBox = document.getElementById('s-prev-box');
  if (prev > 0) { prevBox.classList.remove('hidden'); document.getElementById('s-prev').textContent = formatMoney(prev); }
  else prevBox.classList.add('hidden');
  document.getElementById('s-grand').textContent = formatMoney(grand);
  document.getElementById('s-pending').textContent = formatMoney(remaining);
}

// Camera photos aksar 3-8 MB ki hoti hain → slow upload / 30 sec timeout.
// Isliye upload se pehle max 1600px tak resize karke JPEG bana dete hain.
function compressImage(dataUrl, maxDim, quality) {
  maxDim = maxDim || 1600;
  quality = quality || 0.8;
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        try {
          const w = img.naturalWidth || img.width;
          const h = img.naturalHeight || img.height;
          if (!w || !h) { resolve(dataUrl); return; }
          const scale = Math.min(1, maxDim / Math.max(w, h));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(w * scale));
          canvas.height = Math.max(1, Math.round(h * scale));
          const ctx = canvas.getContext('2d');
          if (!ctx) { resolve(dataUrl); return; }
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          const out = canvas.toDataURL('image/jpeg', quality);
          resolve((out && out.length < dataUrl.length) ? out : dataUrl);
        } catch (e) { resolve(dataUrl); }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    } catch (e) { resolve(dataUrl); }
  });
}

/* ============ CLOUDINARY (photo storage) ============ */
// Photo upload HAMESHA Cloudinary par hota hai (Firebase Storage fallback bilkul nahi).
// Config account-specific hai: localStorage me activeDataUid ke saath, aur cloud backup
// (stores/{uid}.cloudinary) ke saath — doosra account aapki config nahi dekh/pata sakta.
const CLOUDINARY_KEY = 'rgs_cloudinary';

// Account ka Cloudinary state (memory). Naye account me loadLocalAccountData() ise
// null karke us account ki apni config load karwata hai.
let cloudinaryCfg = null;
let clFieldsOpen = false;   // Sign In dabane tak config fields band rehte hain

function normalizeCloudinary(c) {
  if (!c || typeof c !== 'object') return null;
  return {
    cloudName: String(c.cloudName || '').trim(),
    uploadPreset: String(c.uploadPreset || '').trim(),
    folder: String(c.folder || '').replace(/^\/+|\/+$/g, ''),
    apiKey: String(c.apiKey || '').trim(),
    apiSecret: String(c.apiSecret || '').trim(),
    enabled: c.enabled !== false,
    signedIn: c.signedIn === true
  };
}

function loadCloudinaryCfg() {
  if (cloudinaryCfg) return cloudinaryCfg;
  if (!activeDataUid) return null;
  try {
    const raw = localStorage.getItem(acctKey(CLOUDINARY_KEY));
    if (!raw) return null;
    cloudinaryCfg = normalizeCloudinary(JSON.parse(raw));
    return cloudinaryCfg;
  } catch (e) { return null; }
}
function writeCloudinaryCfg(cfg) {
  cloudinaryCfg = normalizeCloudinary(cfg);
  if (!activeDataUid) return false;
  try {
    if (cloudinaryCfg) localStorage.setItem(acctKey(CLOUDINARY_KEY), JSON.stringify(cloudinaryCfg));
    else localStorage.removeItem(acctKey(CLOUDINARY_KEY));
    scheduleAutoSync();   // doosre device par bhi wahi config aa jaye
    return true;
  } catch (e) { return false; }
}
// Sign-in = config saved + signedIn flag. Sirf yahi hone par upload chalta hai.
function isCloudinarySignedIn() {
  const c = loadCloudinaryCfg();
  return !!(c && c.signedIn && c.cloudName && c.uploadPreset);
}
function isCloudinaryOn() {
  const c = loadCloudinaryCfg();
  return !!(isCloudinarySignedIn() && c.enabled !== false);
}
// Har upload-failure path isi message ko dikhata hai — user ko pata chale ki kya karna hai
function cloudinaryNotSignedInReason() {
  const c = loadCloudinaryCfg();
  if (!c || !c.cloudName || !c.uploadPreset) {
    return 'Cloudinary sign-in nahi hai — Settings → Cloudinary → "Sign In to Cloudinary" daba kar Cloud Name aur Upload Preset save karo.';
  }
  if (c.signedIn !== true) {
    return 'Cloudinary sign out hai — photo upload se pehle Settings → Cloudinary me dobara Sign In karo (config already saved hai).';
  }
  return 'Cloudinary uploads Enable nahi hain — Settings → Cloudinary me "Enable" tick karke Save dabao.';
}
function isCloudinaryUrl(url) {
  return typeof url === 'string' && url.indexOf('res.cloudinary.com/') !== -1;
}
// URL se public_id nikalo (delete ke liye):
// .../image/upload/v1234/rgs-photos/abc.jpg -> rgs-photos/abc
function cloudinaryPublicId(url) {
  try {
    if (typeof url !== 'string') return '';
    const i = url.indexOf('/upload/');
    if (i === -1) return '';
    let rest = url.slice(i + 8).split('?')[0];
    rest = rest.replace(/^v\d+\//, '');          // version segment
    rest = rest.replace(/\.[a-zA-Z0-9]+$/, '');  // extension
    return decodeURIComponent(rest);
  } catch (e) { return ''; }
}

// Cloudinary signature = sha1(api_secret + sorted params)
// crypto.subtle sirf secure context (https/localhost) par milta hai —
// warna delete skip ho jayega (upload phir bhi chalta rahega).
async function cloudinarySignature(paramStr, secret) {
  try {
    if (crypto && crypto.subtle && crypto.subtle.digest) {
      const buf = new TextEncoder().encode(String(secret || '') + paramStr);
      const hash = await crypto.subtle.digest('SHA-1', buf);
      return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
    }
  } catch (e) { console.warn('Cloudinary sign failed:', e); }
  return '';
}

function cloudinaryUploadError(status, data) {
  const err = data && data.error ? data.error : null;
  const msg = err ? String(err.message || err.name || '') : '';
  const low = msg.toLowerCase();
  if (status === 404 || low.includes('unknown cloud name')) return 'Cloudinary: cloud name galat hai ya account nahi mila.';
  if (status === 401 || low.includes('unauthorized') || low.includes('signature')) return 'Cloudinary: upload preset galat hai (preset Unsigned hona chahiye).';
  if (low.includes('preset')) return 'Cloudinary: upload preset verify nahi hua — preset ko Unsigned karo.';
  if (status === 429) return 'Cloudinary: rate limit — thodi der baad dobara try karo.';
  if (status >= 500) return 'Cloudinary: server error (' + status + ') — baad me try karo.';
  if (msg) return 'Cloudinary: ' + msg;
  return 'Cloudinary: upload fail (HTTP ' + status + ').';
}

// Unsigned preset wala direct browser upload — sirf signed-in account ke liye
async function uploadToCloudinary(payload, signal) {
  const cfg = loadCloudinaryCfg();
  if (!cfg || !cfg.cloudName || !cfg.uploadPreset) {
    throw new Error('Cloudinary: Cloud Name ya Upload Preset missing (Settings → Cloudinary)');
  }
  if (!isCloudinaryOn()) throw new Error(cloudinaryNotSignedInReason());
  const fd = new FormData();
  fd.append('file', payload);                 // data-URL seedha chalta hai
  fd.append('upload_preset', cfg.uploadPreset);
  if (cfg.folder) fd.append('folder', cfg.folder);
  const endpoint = 'https://api.cloudinary.com/v1_1/' + encodeURIComponent(cfg.cloudName) + '/image/upload';

  // Timeout payload ke hisaab se (pehle fixed 45s tha — badi photo par wahi timeout
  // kha ja tha). 1600px compressed photo ≈ 0.3 MB → ~45s; badi file → 90s tak.
  const mb = Math.max(0.01, (payload ? payload.length : 0) / 1048576);
  const upMs = Math.min(90000, Math.max(45000, Math.round(30000 + mb * 30000)));
  const upMsg = 'Cloudinary upload timeout (' + Math.round(upMs / 1000) + ' second)';
  const abortedErr = () => { const ab = new Error('Upload canceled'); ab.name = 'AbortError'; return ab; };
  const isAbort = (e) => !!(e && (e.name === 'AbortError' || (signal && signal.aborted)));

  // Ek attempt. Timeout par fetch ko ROK bhi dete hain (purane code me sirf promise
  // reject hota tha — upload chup-chaap chalta rehta aur Cloudinary par bina URL wali
  // adhoori file ban kar reh jaati thi). User cancel kar to outer signal se bhi rukta hai.
  const post = () => {
    const ctrl = new AbortController();
    const onOuterAbort = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else if (signal.addEventListener) signal.addEventListener('abort', onOuterAbort, { once: true });
    }
    let timer = null;
    const timeout = new Promise((_, rej) => {
      // Reject pehle, abort baad me — taaki race me timeout ka message hi upar rahe
      timer = setTimeout(() => { rej(new Error(upMsg)); ctrl.abort(); }, upMs);
    });
    const req = fetch(endpoint, { method: 'POST', body: fd, signal: ctrl.signal });
    return Promise.race([req, timeout]).finally(() => {
      clearTimeout(timer);
      if (signal && signal.removeEventListener) signal.removeEventListener('abort', onOuterAbort);
    });
  };

  let res;
  try {
    res = await post();
  } catch (e) {
    if (isAbort(e)) throw abortedErr();      // user ne Cancel dabaya — fail mat dikhao
    // Ek baar dobara try — mobile network ka ek-time hiccup aam hai.
    // (Timeout par dobara nahi, warna user ko double intezaar karna padta.)
    if (!/timeout/i.test(String(e && e.message))) {
      try { res = await post(); }
      catch (e2) { throw isAbort(e2) ? abortedErr() : new Error('Cloudinary: ' + ((e2 && e2.message) ? e2.message : 'network error')); }
    } else {
      throw new Error('Cloudinary: ' + (e && e.message ? e.message : 'network error'));
    }
  }
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok || !data || !data.secure_url) {
    throw new Error(cloudinaryUploadError(res ? res.status : 0, data));
  }
  return data.secure_url;
}

// Best effort: creds nahi hain to sirf warn karke chhod do (crash nahi hona chahiye)
async function deleteCloudinaryPhoto(url) {
  try {
    const cfg = loadCloudinaryCfg();
    const pid = cloudinaryPublicId(url);
    if (!cfg || !cfg.apiKey || !cfg.apiSecret || !pid) {
      console.warn('Cloudinary delete skipped (API key/secret nahi diye):', pid || url);
      return false;
    }
    const ts = Math.floor(Date.now() / 1000);
    const sig = await cloudinarySignature('public_id=' + pid + '&timestamp=' + ts, cfg.apiSecret);
    if (!sig) { console.warn('Cloudinary delete skipped (sign nahi hua — https/localhost chahiye):', pid); return false; }

    const fd = new FormData();
    fd.append('public_id', pid);
    fd.append('timestamp', String(ts));
    fd.append('api_key', cfg.apiKey);
    fd.append('signature', sig);
    const endpoint = 'https://api.cloudinary.com/v1_1/' + encodeURIComponent(cfg.cloudName) + '/destroy';
    const res = await withTimeout(fetch(endpoint, { method: 'POST', body: fd }), 30000, 'Cloudinary delete timeout (30 second)');
    const data = await res.json().catch(() => null);
    if (!res.ok) { console.warn('Cloudinary delete failed:', res.status, data); return false; }
    return true;
  } catch (e) { console.warn('Cloudinary delete skipped:', e && e.message); return false; }
}

// Photo upload → SIRF Cloudinary. Sign-in nahi to seedha error (fallback bilkul nahi).
// signal = user ne Cancel dabaya to chal raha upload turant abort ho jaye.
async function uploadPhoto(dataUrl, signal) {
  if (!isCloudinaryOn()) throw new Error(cloudinaryNotSignedInReason());
  const payload = dataUrl;
  return uploadToCloudinary(payload, signal);
}

// Kisi bhi promise par simple timeout lagao
function withTimeout(promise, ms, msg) {
  let timer = null;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(msg)), ms); });
  return Promise.race([promise, timeout]).finally(() => { clearTimeout(timer); });
}

// Photo delete — best effort (sirf Cloudinary).
// Creds na ho ya file pehle se gayab ho, to sirf warn karo — app crash nahi hona chahiye.
function deleteRemotePhoto(url) {
  try {
    if (typeof url !== 'string' || !url.startsWith('http')) return;
    if (!isCloudinaryUrl(url)) {
      // Firebase Storage fallback nahi hai — purani (non-Cloudinary) photo hai
      console.warn('Photo delete skipped (Cloudinary URL nahi hai):', url);
      return;
    }
    const t = deleteCloudinaryPhoto(url);   // async — fire & forget
    if (t && typeof t.catch === 'function') t.catch(e => console.warn('Photo delete skipped:', e && e.message));
  } catch (e) { console.warn('Photo delete skipped:', e && e.message); }
}


// Save Supplier Bill — button ke andar loading + double-tap protection
async function saveSupBill() {
  const btn = document.getElementById('saveSupBillBtn');
  if (!setBusy(btn, true, 'Saving...')) return;
  try { await saveSupBillInner(); }
  finally { setBusy(btn, false); }
}
async function saveSupBillInner() {
  const rawName = document.getElementById('s-name').value.trim();
  if (!rawName) { alert('Supplier name likho.'); return; }
  // Naam ka pehle se maujood spelling use karo, warna "Ram" aur "ram" ke dues alag ho jayenge
  const name = supplierDisplayName(rawName) || rawName;
  const read = getProductsFromForm();
  const products = read.products;
  if (read.incomplete) {
    alert(read.incomplete + ' product row adhoora hai (naam aur Qty dono zaroori hain).\nPehle use theek karo ya ✕ Remove se hata do.');
    return;
  }
  if (!products.length) { alert('Kam se kam 1 product add karo.'); return; }

  // Payment validation pehle — cancel hone par photo upload na ho
  let paid = toNumber(document.getElementById('s-paid').value);
  const thisBill = products.reduce((s, p) => s + productTotal(p), 0);
  const grandTotal = thisBill + currentSupOpening;
  const wasEditing = editingSupId !== null;
  if (supExistingPaid + paid > grandTotal) {
    if (!confirm('Paid > Total. Extra count nahi hoga. Continue?')) return;
    paid = Math.max(grandTotal - supExistingPaid, 0);
  }

  // Bill photos (upload)
  const photoRes = await collectPhotos('#supplierPhotoRow');
  if (!photoRes) return;
  const billPhotos = photoRes.photos;

  const billData = {
    name,
    date: validDate(document.getElementById('s-date').value),
    deliveryDate: document.getElementById('s-delivery').value || '',
    orderNo: document.getElementById('s-orderno').value.trim(),
    ptype: ptypeClass(document.getElementById('s-ptype').value) || 'credit',
    products,
    payments: [],
    photos: billPhotos
  };
  if (paid > 0) billData.payments.push({ amount: paid, date: validDate(document.getElementById('s-paiddate').value) });

  if (wasEditing) {
    billData.id = editingSupId;
    const idx = supBills.findIndex(b => b.id === editingSupId);
    if (idx >= 0) billData.payments = (supBills[idx].payments || []).concat(billData.payments);
    if (idx >= 0) supBills[idx] = billData; else supBills.push(billData);
  } else {
    billData.id = uid();
    supBills.push(billData);
  }
  editingSupId = null; supExistingPaid = 0; currentSupOpening = 0;

  if (!supSave()) {
    (photoRes.uploaded || []).forEach(deleteRemotePhoto);
    return;
  }
  flushPhotoDeletes();
  if (photoRes.failed) alert(photoRes.failed + ' photo(s) save nahi hui' + (photoRes.cancelled ? ' (aapne upload cancel kiya)' : '') + ' — bill baaki data ke saath save ho gaya.' + (photoRes.failReason ? '\n\nReason: ' + photoRes.failReason : ''));
  if (wasEditing) { currentSupId = billData.id; renderSupDetail(); showScreen('supDetailScreen'); }
  else showSupplierList();
}

/* ============ SUPPLIER: DETAIL ============ */
function renderSupDetail() {
  const b = getSup(); if (!b) { showSupplierList(); return; }
  document.getElementById('sd-name').textContent = b.name || '-';

  const thisBill = supBillTotal(b);
  const stats = supplierTotalDues(b.name || '');

  const badge = document.getElementById('sd-badge');
  badge.classList.remove('hidden', 'badge-paid', 'badge-partial', 'badge-due');
  if (stats.due <= 0) { badge.classList.add('badge-paid'); badge.textContent = 'PAID'; }
  else if (stats.paid > 0) { badge.classList.add('badge-partial'); badge.textContent = 'PARTIAL'; }
  else { badge.classList.add('badge-due'); badge.textContent = 'DUE'; }

  let html = '';
  html += '<div class="meta">Bill: ' + escapeHtml(b.date || '-') +
    (b.deliveryDate ? ' | Delivery: ' + escapeHtml(b.deliveryDate) : '') +
    (b.orderNo ? ' | Order: ' + escapeHtml(b.orderNo) : '') +
    ' | ' + ptypeBadge(b.ptype, 'credit') + '</div>';

  html += '<h3 style="margin-top:10px">Products</h3>';
  (b.products || []).forEach(p => {
    const t = productTotal(p);
    let line = '';
    if (p.qtyCartons > 0) line += p.qtyCartons + ' ctn × Rs. ' + formatMoney(p.rateCartons) + ' ';
    if (p.qtyUnits > 0) line += (line ? '+ ' : '') + p.qtyUnits + ' ' + (p.unitType || 'units') + ' × Rs. ' + formatMoney(p.rateUnits);
    html += '<div style="padding:8px 0;border-bottom:1px solid #eee">' +
      '<div class="row"><span style="font-weight:bold">' + escapeHtml(p.name || '-') + '</span><span>Rs. ' + formatMoney(t) + '</span></div>' +
      (line ? '<div class="meta">' + escapeHtml(line) + '</div>' : '') +
      '</div>';
  });

  if (b.photos && b.photos.length) {
    html += '<h3 style="margin-top:10px">Bill Photos</h3>';
    html += '<div class="photo-row">' + b.photos.map((src, i) =>
      '<div class="photo-thumb" onclick="openViewerForSupplierBill(\'' + b.id + '\',' + i + ')">' +
      '<img src="' + escapeHtml(src) + '"></div>').join('') + '</div>';
  }

  html += '<div class="row" style="font-weight:bold;margin-top:10px"><span>This Bill Total</span><span>Rs. ' + formatMoney(thisBill) + '</span></div>';

  if ((b.payments || []).length) {
    html += '<h3 style="margin-top:10px">Payment History</h3>';
    b.payments.forEach((p, idx) => {
      html += '<div class="pay-row"><span>Rs. ' + formatMoney(p.amount) + (p.date ? ' — ' + escapeHtml(p.date) : '') + '</span>' +
        '<button class="del-pay" onclick="removeSupPayment(' + idx + ')">✕</button></div>';
    });
  }

  html += '<div style="background:#fff4e5;padding:10px;border-radius:8px;margin-top:10px">';
  html += '<div class="row"><span>Opening Balance</span><span>Rs. ' + formatMoney(stats.opening) + '</span></div>';
  html += '<div class="row"><span>All Bills Total</span><span>Rs. ' + formatMoney(stats.total - stats.opening) + '</span></div>';
  html += '<div class="row"><span>Opening + Bills</span><span>Rs. ' + formatMoney(stats.total) + '</span></div>';
  html += '<div class="row"><span>Total Paid</span><span>Rs. ' + formatMoney(stats.paid) + '</span></div>';
  html += '<div class="row" style="font-weight:bold"><span class="' + (stats.due > 0 ? 'pending' : 'paid') + '">Total Dues (Supplier)</span>' +
    '<span class="' + (stats.due > 0 ? 'pending' : 'paid') + '">Rs. ' + formatMoney(Math.max(stats.due, 0)) + '</span></div>';
  html += '</div>';

  document.getElementById('sd-details').innerHTML = html;
}
function removeSupPayment(idx) {
  if (!confirm('Delete this payment?')) return;
  const b = getSup();
  if (!b || !b.payments[idx]) return;
  const removed = b.payments.splice(idx, 1)[0];
  if (!supSave()) { b.payments.splice(idx, 0, removed); return; }  // save fail → wapas lao
  renderSupDetail();
}

function addSupPayment() {
  const b = getSup(); if (!b) return;
  const stats = supplierTotalDues(b.name || '');
  if (stats.due <= 0) { alert('No dues!'); return; }
  const input = prompt('Payment amount (Total Dues: Rs. ' + formatMoney(stats.due) + '):');
  if (input === null) return;
  const amount = toNumber(input); if (amount <= 0) return;
  let finalAmount = amount;
  if (amount > stats.due) { if (!confirm('Amount exceeds dues. Continue?')) return; finalAmount = stats.due; }
  const date = prompt('Payment date (YYYY-MM-DD):', today());
  if (date === null) return;
  if (!isValidDateStr(String(date).trim())) { alert('Date galat hai. YYYY-MM-DD likho (misal: 2026-09-26).'); return; }
  b.payments.push({ amount: finalAmount, date: String(date).trim() });
  if (!supSave()) { b.payments.pop(); return; }   // save fail → payment wapas hata do (memory = disk)
  renderSupDetail();
}

function deleteSupBill() {
  const idx = supBills.findIndex(b => b.id === currentSupId);
  if (idx < 0) return;
  const removed = supBills[idx];
  let msg = 'Delete this bill permanently?';
  if ((removed.payments || []).length) {
    msg += '\n\n⚠ Is bill ke ' + removed.payments.length + ' payment(s) supplier ke TOTAL DUES me count hote hain — delete karne par wo bhi hat jayengi (dues badh jayengi).';
  }
  if ((removed.photos || []).length) msg += '\nIs bill ki ' + removed.photos.length + ' photo(b) bhi Storage se delete hongi.';
  if (!confirm(msg)) return;
  supBills.splice(idx, 1); currentSupId = null;
  if (!supSave()) { supBills.splice(idx, 0, removed); return; }   // save fail → delete wapas cancel
  (removed.photos || []).forEach(deleteRemotePhoto);
  showSupplierList();
}

/* ---- SUPPLIER BILL → Share ---- */
function shareSupBill() {
  const b = getSup(); if (!b) return;
  const thisBill = supBillTotal(b);                  // (purane share ki wahi calculation)
  const stats = supplierTotalDues(b.name || '');
  const meta = [];
  if (b.deliveryDate) meta.push('Delivery: ' + b.deliveryDate);
  if (b.orderNo) meta.push('Order: ' + b.orderNo);
  meta.push('Payment type: ' + String(b.ptype || 'credit').toUpperCase());
  const spec = {
    heading: 'Supplier Bill',
    partyLabel: 'Supplier',
    partyName: b.name || '-',
    date: b.date || '-',
    emptyNote: 'No products in this bill',
    meta: meta,
    rows: (b.products || []).map(p => {
      const c = toNumber(p.qtyCartons), u = toNumber(p.qtyUnits);
      const qtyParts = [], rateParts = [];
      if (c > 0) { qtyParts.push(c + ' ctn'); rateParts.push(formatMoney(p.rateCartons)); }
      if (u > 0) { qtyParts.push(u + ' ' + (p.unitType || 'units')); rateParts.push(formatMoney(p.rateUnits)); }
      return {
        name: p.name || '-',
        qty: qtyParts.length ? qtyParts.join(' + ') : '-',
        rate: rateParts.length ? rateParts.join(' / ') : '-',
        amount: formatMoney(productTotal(p)),
        sub: (c > 0 && u > 0)
          ? c + ' ctn × Rs. ' + formatMoney(p.rateCartons) + '  +  ' + u + ' ' + (p.unitType || 'units') + ' × Rs. ' + formatMoney(p.rateUnits)
          : ''
      };
    }),
    totals: [
      { label: 'This Bill', value: thisBill, em: true },
      { label: 'Opening Balance', value: stats.opening },
      { label: 'Total Paid', value: stats.paid },
      { label: 'Total Dues', value: Math.max(stats.due, 0), balance: true }
    ]
  };
  shareSendBillImage(spec, 'supplier-bill ' + (b.name || '') + ' ' + (b.date || ''));
}

/* ============ PHOTOS: ATTACH / VIEW ============ */
let currentBillPhotoRow = null;
let currentPhotoBusyBtn = null;

/* Camera button → DEVICE KA NATIVE CAMERA APP.
   <input type="file" accept="image/*" capture="environment"> par click karne se
   Android par device ka default/system camera app (ya uska capture mode) khulta hai —
   isi liye 50/64/108MP, Night, Portrait, Video, Slow-Mo, Time-lapse, Pro/Manual, HDR,
   Panorama, Macro, Ultrawide/Wide/Tele, flash, zoom, aspect ratio, AI features —
   sab wahi milte hain jo device ka native camera officially support karta hai.
   Koi bhi camera feature yahan fake/simulate nahi kiya ja raha.
   Isliye getUserMedia se apna custom camera UI BILKUL nahi banaya — woh native
   camera se replace nahi kar pata. */
function attachBillPhoto(type, mode, btn) {
  // Photo = Cloudinary upload. Sign-in nahi hai to abhi ruk jao (clear error).
  if (!isCloudinaryOn()) {
    alert('❌ Photo add nahi hui.\n\n' + cloudinaryNotSignedInReason() +
          '\n\nPehle Settings → Cloudinary → Sign In dabao aur Cloud Name + Upload Preset save karo.');
    return;
  }
  const rowId = type === 'customer' ? 'customerPhotoRow' : 'supplierPhotoRow';
  const row = document.getElementById(rowId);
  if (!row) return;
  if (row.children.length >= 5) { alert('Max 5 photos.'); return; }
  if (isBusy(btn)) return;                  // duplicate click block
  currentBillPhotoRow = row;
  currentPhotoBusyBtn = btn || null;
  const inp = mode === 'camera' ? document.getElementById('camInput') : document.getElementById('galInput');
  inp.value = '';
  inp.onchange = (ev) => handlePhotoSelect(ev);
  // Rare: kuch embedded/old WebView me file-input click throw kar de —
  // crash ke bajaye clear message
  try {
    inp.click();   // ← native camera / gallery yahin se khulta hai
  } catch (e) {
    console.warn('Camera/gallery open failed:', e);
    currentBillPhotoRow = null;
    setBusy(currentPhotoBusyBtn, false);
    currentPhotoBusyBtn = null;
    alert('❌ Camera / Gallery open nahi ho paya.\n\nIs app ko browser me chala kar dobara try karein.');
  }
}

// Native camera se aayi photo PEHLE compress kar li jati hai (max 1600px, JPEG 0.8).
// Wajah: 12-100MP camera ki photo 5-15 MB ki hoti hai — wo bina resize Cloudinary par
// jaati thi to upload timeout ho jata tha (aur free plan par size limit bhi lagti hai).
// Compress karne se file ~10 guna chhoti ho jati hai (≈200-400 KB), upload 2-5 sec me
// ho jata hai. Preview/bill dono me 1600px kaafi hai (photo kabhi 100% zoom nahi hoti).
// Agar compress bhi fail ho jaye to original dataUrl hi chala jata hai (fallback).
function handlePhotoSelect(ev) {
  const btn = currentPhotoBusyBtn;
  currentPhotoBusyBtn = null;
  const f = ev.target.files && ev.target.files[0];
  if (!f) { setBusy(btn, false); return; }              // user ne cancel kiya
  if (f.type && !f.type.startsWith('image/')) { setBusy(btn, false); alert('Sirf image file select karo.'); return; }
  const row = currentBillPhotoRow;
  currentBillPhotoRow = null;
  if (!row) { setBusy(btn, false); return; }
  setBusy(btn, true, 'Photo load...');
  const reader = new FileReader();
  reader.onload = (e) => {
    Promise.resolve(e.target.result)
      .then(async (dataUrl) => {
        if (!row || row.children.length >= 5) return;
        // Upload se pehle resize/compress — warna badi photo par Cloudinary timeout
        const small = await compressImage(dataUrl, 1600, 0.8);
        if (!row || row.children.length >= 5) return;
        addPhotoThumb(row, small, row.children.length);
      })
      .finally(() => setBusy(btn, false));
  };
  reader.onerror = () => { setBusy(btn, false); alert('Photo padhne me dikkat aayi. Dobara try karo.'); };
  reader.readAsDataURL(f);
}

function addPhotoThumb(row, src, idx) {
  const wrap = document.createElement('div');
  wrap.className = 'photo-thumb';
  wrap.dataset.src = src;
  wrap.innerHTML =
    '<img src="' + escapeHtml(src) + '" onclick="openViewerFromThumb(this)">' +
    '<button type="button" class="photo-x" onclick="removePhotoThumb(this)">✕</button>';
  row.appendChild(wrap);
}

function removePhotoThumb(btn) {
  if (!confirm('Delete this photo?')) return;
  const thumb = btn.closest('.photo-thumb');
  if (!thumb) return;
  // Storage file sirf save hone ke baad delete — user ne cancel kar diya to photo wapas chahiye
  if (thumb.dataset) queuePhotoDelete(thumb.dataset.src);
  thumb.remove();
}

function openViewerFromThumb(img) {
  const row = img.closest('.photo-row');
  const thumbs = Array.from(row.querySelectorAll('.photo-thumb'));
  const srcs = thumbs.map(t => t.dataset.src);
  const start = thumbs.indexOf(img.closest('.photo-thumb'));
  openViewer(srcs, start);
}

function openViewerForSupplierBill(billId, photoIdx) {
  const b = supBills.find(x => x.id === billId);
  if (!b) return;
  openViewer(b.photos || [], photoIdx);
}
function openViewerForCustomerBill(billId, photoIdx) {
  const bill = bills.find(x => x.id === billId);
  if (!bill) return;
  openViewer(bill.photos || [], photoIdx);
}

/* ============ PHOTO VIEWER ============ */
let viewerSrcs = [], viewerIndex = 0, viewerScale = 1;

function openViewer(srcs, idx) {
  viewerSrcs = srcs.slice();
  viewerIndex = idx || 0;
  viewerScale = 1;
  const ov = document.getElementById('photoViewer');
  ov.classList.remove('hidden');
  document.getElementById('viewerImg').style.transform = 'scale(1)';
  updateViewer();
  document.body.style.overflow = 'hidden';
  ov.style.display = 'flex';
}
function closeViewer() {
  document.getElementById('photoViewer').classList.add('hidden');
  document.body.style.overflow = '';
  viewerSrcs = [];
  // Bade (data URL) images ko memory se hata do
  const img = document.getElementById('viewerImg');
  if (img) { try { img.removeAttribute('src'); } catch (e) { img.src = ''; } }
}
function updateViewer() {
  if (!viewerSrcs.length) { closeViewer(); return; }
  viewerIndex = Math.max(0, Math.min(viewerSrcs.length - 1, viewerIndex));
  document.getElementById('viewerImg').src = viewerSrcs[viewerIndex];
  document.getElementById('viewerCounter').textContent = (viewerIndex + 1) + ' / ' + viewerSrcs.length;
  document.getElementById('viewerPrev').style.visibility = viewerIndex > 0 ? 'visible' : 'hidden';
  document.getElementById('viewerNext').style.visibility = viewerIndex < viewerSrcs.length - 1 ? 'visible' : 'hidden';
 if (window.__viewerResetZoom) window.__viewerResetZoom();
}
function viewerNav(d) {
  viewerIndex += d;
  updateViewer();
}

(function setupViewerZoom(){
  const body = document.getElementById('viewerBody');
  const img = document.getElementById('viewerImg');
  if (!body || !img) return;

  let startX = 0, startY = 0;
  let startDist = 0, startScale = 1;
  let panX = 0, panY = 0;
  let startPanX = 0, startPanY = 0;
  let lastTap = 0;
  let isDragging = false;
  let hasMoved = false;

  function applyTransform() {
    img.style.transform = 'translate(' + panX + 'px, ' + panY + 'px) scale(' + viewerScale + ')';
  }

  function resetPan() {
    panX = 0; panY = 0;
  }

  // Clamp pan so image doesn't go too far
  function clampPan() {
    if (viewerScale <= 1) { panX = 0; panY = 0; return; }
    const maxX = (img.clientWidth * (viewerScale - 1)) / 2;
    const maxY = (img.clientHeight * (viewerScale - 1)) / 2;
    panX = Math.max(-maxX, Math.min(maxX, panX));
    panY = Math.max(-maxY, Math.min(maxY, panY));
  }

  // ---- TOUCH ----
  body.addEventListener('touchstart', (e) => {
    hasMoved = false;
    if (e.touches.length === 2) {
      // pinch start
      startDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      startScale = viewerScale;
      startPanX = panX; startPanY = panY;
    } else if (e.touches.length === 1) {
      // drag start
      isDragging = true;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      startPanX = panX;
      startPanY = panY;
    }
  }, { passive: true });

  body.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && startDist > 0) {
      // pinch zoom
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      let newScale = startScale * (dist / startDist);
      newScale = Math.max(1, Math.min(6, newScale));
      viewerScale = newScale;
      if (viewerScale <= 1) resetPan();
      clampPan();
      applyTransform();
      hasMoved = true;
      e.preventDefault();
    } else if (e.touches.length === 1 && isDragging && viewerScale > 1) {
      // drag pan (only when zoomed)
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved = true;
      panX = startPanX + dx;
      panY = startPanY + dy;
      clampPan();
      applyTransform();
      e.preventDefault();
    }
  }, { passive: false });

  body.addEventListener('touchend', (e) => {
    startDist = 0;
    isDragging = false;
  });

  // ---- MOUSE (desktop) ----
  let mouseDown = false, mx = 0, my = 0, mPanX = 0, mPanY = 0;

  body.addEventListener('mousedown', (e) => {
    mouseDown = true;
    hasMoved = false;
    mx = e.clientX; my = e.clientY;
    mPanX = panX; mPanY = panY;
    img.style.cursor = viewerScale > 1 ? 'grabbing' : 'grab';
  });

  window.addEventListener('mousemove', (e) => {
    if (!mouseDown) return;
    const dx = e.clientX - mx;
    const dy = e.clientY - my;
    // Drag ke baad click double-tap na samjhe
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved = true;
    panX = mPanX + dx;
    panY = mPanY + dy;
    clampPan();
    applyTransform();
  });

  window.addEventListener('mouseup', () => {
    mouseDown = false;
    img.style.cursor = 'grab';
  });

  // ---- WHEEL ZOOM ----
  body.addEventListener('wheel', (e) => {
    e.preventDefault();
    let s = viewerScale + (e.deltaY < 0 ? 0.25 : -0.25);
    s = Math.max(1, Math.min(6, s));
    viewerScale = s;
    if (viewerScale <= 1) resetPan();
    clampPan();
    applyTransform();
  }, { passive: false });

  // ---- DOUBLE TAP / DOUBLE CLICK ----
  body.addEventListener('click', (e) => {
    // Prev/Next buttons par click zoom toggle na kare
    if (e.target && e.target.closest && e.target.closest('button')) return;
    // Drag/pan ke baad aaya click double-tap count na ho
    if (hasMoved) { hasMoved = false; return; }
    const now = Date.now();
    if (now - lastTap < 300) {
      if (viewerScale > 1) {
        viewerScale = 1;
        resetPan();
      } else {
        viewerScale = 2.5;
        clampPan();
      }
      applyTransform();
      lastTap = 0;   // lagatar 3 click par zoom bar-bar flip na ho
      return;
    }
    lastTap = now;
  });

  // Reset helper — call this when opening a new photo
  window.__viewerResetZoom = function() {
    viewerScale = 1;
    panX = 0; panY = 0;
    applyTransform();
  };
})();

/* ============ SETTINGS ============ */
function openSettings() { refreshChrome(); updateSettingsUI(); fillCloudinaryForm(); showScreen('settingsScreen'); }

// Admin UI (Accounts button/card/banner) — role Firestore se aata hai, client se nahi
function refreshChrome() {
  const ab = document.getElementById('accountsBtn');
  if (ab) ab.classList.toggle('hidden', !isAdmin());
  const ac = document.getElementById('adminCard');
  if (ac) ac.classList.toggle('hidden', !isAdmin());
  const rc = document.getElementById('accountRole');
  if (rc) rc.textContent = isAdmin() ? 'Admin 👑' : 'User';
  const aac = document.getElementById('adminAccountCount');
  if (aac && typeof profilesCache !== 'undefined' && profilesCache.length) aac.textContent = profilesCache.length;
  applyUidVisibility();   // role change par UID block turant sahi ho (admin-only)
  updateAdminBanner();
  if (screenVisible('settingsScreen')) updateSettingsUI();
}

// Admin kisi doosre account me hai to hamesha banner dikhe — confusion nahi honi chahiye
function updateAdminBanner() {
  const el = document.getElementById('adminBanner');
  if (!el) return;
  const txt = document.getElementById('adminBannerText');
  if (adminViewing && activeDataUid) {
    el.classList.remove('hidden');
    txt.innerHTML = '👑 <b>ADMIN</b> — viewing <b>' +
      escapeHtml(impersonatedEmail || impersonatedUid || activeDataUid) +
      '</b> (ye user ka data hai; aapka apna data alag hai)';
  } else {
    el.classList.add('hidden');
  }
}

function updateSettingsUI() {
  document.getElementById('pinStatus').innerHTML = hasPIN() ? '<span class="status-dot on"></span>Set' : '<span class="status-dot off"></span>Not set';
  document.getElementById('bioStatus').innerHTML = isBioEnabled() && hasBioCred() ? '<span class="status-dot on"></span>Enabled' : '<span class="status-dot off"></span>Off';

  const u = (firebaseReady && fbAuth) ? fbAuth.currentUser : null;
  const cs = document.getElementById('cloudStatus');
  if (adminViewing) cs.textContent = (impersonatedEmail || impersonatedUid || activeDataUid) + ' — Admin viewing';
  else if (u) cs.textContent = u.email || u.uid;
  else if (firebaseReady) cs.textContent = 'Not signed in';
  else cs.textContent = 'Not configured';

  const cb = document.getElementById('cloudBtn');
  if (cb) cb.textContent = u ? (adminViewing ? 'Sign Out (Admin)' : 'Sign Out') : 'Sign In';
  document.getElementById('syncBtn').classList.toggle('hidden', !u);
  const rb = document.getElementById('restoreBtn');
  if (rb) rb.classList.toggle('hidden', !u);

  const ar = document.getElementById('accountRole');
  if (ar) ar.textContent = isAdmin() ? 'Admin 👑' : 'User';
  const rs = document.getElementById('adminRoleStatus');
  if (rs) rs.textContent = isAdmin() ? '✅ Admin' : '❌ Normal user';
  applyUidVisibility();

  const ls = localStorage.getItem(acctKey('rgs_last_sync'));
  document.getElementById('lastSync').textContent = ls ? new Date(ls).toLocaleString() : '—';
  // Auto-sync chup-chaap fail hoti rahi — user ko pata hi nahi chalta tha
  const errEl = document.getElementById('syncErr');
  if (errEl) {
    const err = localStorage.getItem(acctKey('rgs_sync_err')) || '';
    errEl.textContent = err || 'OK';
    errEl.style.color = err ? '#dc3545' : '#28a745';
  }
  // Cloudinary form mat bharo yahan (user ki adhuri typing udd jaye) — sirf status
  updateCloudinaryStatus();
}
function setSyncError(msg) {
  try {
    if (!activeDataUid) return;
    if (msg) localStorage.setItem(acctKey('rgs_sync_err'), String(msg));
    else localStorage.removeItem(acctKey('rgs_sync_err'));
  } catch (e) { /* storage blocked */ }
}
/* ---- UID: SIRF Admin account me ----
   Sirf CSS hide nahi karta — normal user ke liye UID ka value DOM me likha hi
   nahi jata, block render hi nahi hota, aur copyMyUid() bhi role check karta hai.
   Isliye URL/localStorage/devtools se bhi UID section access nahi ho sakta. */
function applyUidVisibility() {
  const block = document.getElementById('uidBlock');
  const mu = document.getElementById('myUid');
  if (!block) return;
  if (!isAdmin()) {
    if (mu) mu.textContent = '';          // DOM me UID ka koi trace na rahe
    block.classList.add('hidden');
    return;
  }
  const u = (fbAuth && fbAuth.currentUser) ? fbAuth.currentUser.uid : '';
  if (mu) mu.textContent = u || '—';
  block.classList.remove('hidden');
}
function copyMyUid() {
  // Authorization gate — UI hide hone par bhi call block
  if (!isAdmin()) { alert('UID sirf Admin account me dikhta hai.'); return; }
  const u = fbAuth && fbAuth.currentUser;
  if (!u) { alert('Sign in nahi hai.'); return; }
  try {
    navigator.clipboard.writeText(u.uid).then(() => alert('✅ UID copy ho gaya:\n' + u.uid),
      () => alert('UID: ' + u.uid));
  } catch (e) { alert('UID: ' + u.uid); }
}
async function refreshAdminStatus() {
  const btn = document.getElementById('adminRefreshBtn');
  if (!setBusy(btn, true, 'Checking...')) return;   // duplicate click block
  try {
    const ok = await fetchAdminFlag(true);   // fail hone par wahi alert fetchAdminFlag khud dikhata hai
    if (ok) alert('✅ Aap Admin ho — Accounts section ab home screen par dikhne lagega.');
  } finally { setBusy(btn, false); updateSettingsUI(); }
}

/* ============ CLOUDINARY SETTINGS (form + status) ============ */
function setVal(id, v) { const el = document.getElementById(id); if (el) el.value = v; }
function getVal(id) { const el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; }

function fillCloudinaryForm() {
  const c = loadCloudinaryCfg() || {};
  setVal('clCloudName', c.cloudName || '');
  setVal('clPreset', c.uploadPreset || '');
  setVal('clFolder', c.folder || '');
  setVal('clApiKey', c.apiKey || '');
  setVal('clApiSecret', c.apiSecret || '');
  const cb = document.getElementById('clEnabled');
  if (cb) cb.checked = !!(c.cloudName && c.uploadPreset && c.enabled !== false && c.signedIn !== false);
  // Sign-in hone par fields band the — wapas bharna na pade isliye abhi khol do
  if (isCloudinarySignedIn()) {
    clFieldsOpen = true;
    const f = document.getElementById('clFields');
    if (f) f.classList.remove('hidden');
  }
  updateCloudinaryStatus();
}

// Sign In button dabane par hi config fields khulti hain (signed-out state me).
function cloudinarySignIn() {
  fillCloudinaryForm();
  clFieldsOpen = true;
  const c = loadCloudinaryCfg();
  const cb = document.getElementById('clEnabled');
  // User ne sign in dabaya hai → Enable tick karke rakho, Save karte hi sign-in ho jayega
  if (cb && c && c.cloudName && c.uploadPreset) cb.checked = true;
  const hint = document.getElementById('clSignInHint');
  if (hint && c && c.cloudName) {
    hint.textContent = 'Saved config mil gaya — Save dabate hi sign-in ho jayega (chahein to fields badal sakte ho).';
  }
  cloudMsg('', false);
  updateCloudinaryStatus();
  const f = document.getElementById('clCloudName');
  if (f) setTimeout(() => { try { f.focus(); } catch (e) {} }, 60);
}

// Sign Out → photo upload turant band (config yaad rehti hai, isliye wapas sign-in aasan)
function cloudinarySignOut() {
  const c = loadCloudinaryCfg();
  if (!c) { clFieldsOpen = false; updateCloudinaryStatus(); return; }
  if (!confirm('Cloudinary se sign out karein?\n\nPhoto upload turant band ho jayega — jab tak dobara Sign In + Save na karo, koi photo upload nahi hogi (fallback nahi hai). Config saved rahegi.')) return;
  writeCloudinaryCfg(Object.assign({}, c, { signedIn: false }));
  clFieldsOpen = false;
  cloudMsg('🚪 Signed out of Cloudinary — photo upload ab band hai.', false);
  updateCloudinaryStatus();
  updateSettingsUI();
}

function updateCloudinaryStatus() {
  const row = document.getElementById('clStatusRow');
  const btn = document.getElementById('clSignInBtn');
  const hint = document.getElementById('clSignInHint');
  const fields = document.getElementById('clFields');
  if (!row || !btn || !hint || !fields) return;
  const c = loadCloudinaryCfg();
  const signedIn = isCloudinarySignedIn();

  if (signedIn) {
    clFieldsOpen = true;
    row.classList.remove('hidden');
    btn.classList.add('hidden');
    hint.classList.add('hidden');
    fields.classList.remove('hidden');
    const el = document.getElementById('clStatus');
    el.textContent = '✅ Signed in — ' + c.cloudName + (c.folder ? '/' + c.folder : '') +
                     (c.enabled === false ? ' (uploads OFF)' : '');
    el.style.color = c.enabled === false ? '#f9ab00' : '#28a745';
    return;
  }

  // Signed out → sirf Sign In button (config fields bilkul band)
  row.classList.add('hidden');
  btn.classList.remove('hidden');
  hint.classList.remove('hidden');
  hint.textContent = (c && c.cloudName)
    ? 'Sign out — photo upload band hai. Config saved hai: Sign In dabao, phir Save karo, wapas chalu ho jayega.'
    : 'Photo upload se pehle Cloudinary me sign in karna zaroori hai. Sign In dabaate hi Cloud Name / Upload Preset wali fields khul jayengi — details bhar kar Save karo.';
  fields.classList.toggle('hidden', !clFieldsOpen);
}

function cloudMsg(text, isErr) {
  const el = document.getElementById('clMsg');
  if (!el) return;
  el.textContent = text || '';
  el.style.color = isErr ? '#dc3545' : '#28a745';
}

function saveCloudinaryCfg() {
  const btn = document.getElementById('clSaveBtn');
  // Entry gate — duplicate Save/Connect clicks block
  if (!setBusy(btn, true, 'Saving...')) return;
  try { saveCloudinaryCfgInner(); }
  finally { setBusy(btn, false); }   // success aur error dono me loader hatao
}
function saveCloudinaryCfgInner() {
  const cloudName = getVal('clCloudName').toLowerCase();
  const uploadPreset = getVal('clPreset');
  const folder = getVal('clFolder').replace(/^\/+|\/+$/g, '');
  const apiKey = getVal('clApiKey');
  const apiSecret = getVal('clApiSecret');
  const enabledEl = document.getElementById('clEnabled');
  const enabled = !!(enabledEl && enabledEl.checked);

  if (!cloudName) { cloudMsg('Cloud Name bharo.', true); return; }
  if (!uploadPreset) { cloudMsg('Upload Preset bharo (unsigned preset).', true); return; }
  if (!/^[a-z0-9._-]+$/.test(cloudName)) {
    cloudMsg('Cloud Name me sirf a-z, 0-9, dot, dash aur underscore aata hai.', true); return;
  }
  // Save = config is account ki ho jati hai + Enable tick hone par sign-in bhi
  const cfg = { cloudName, uploadPreset, folder, apiKey, apiSecret, enabled, signedIn: enabled };
  if (!writeCloudinaryCfg(cfg)) { cloudMsg('Save nahi hua — browser storage blocked hai.', true); return; }
  clFieldsOpen = true;
  if (enabled) {
    cloudMsg('✅ Signed in — ab is account ki nayi photos Cloudinary par jayengi.', false);
  } else {
    cloudMsg('✅ Config save ho gaya, lekin Enable tick nahi hai — sign in nahi hua, photo upload band rahega.', true);
  }
  updateCloudinaryStatus();
}

function clearCloudinaryCfg() {
  if (!confirm('Cloudinary config is account se hata dein?\n\nPhoto upload tab tak band rahega jab tak dobara Sign In + Save na karo.')) return;
  writeCloudinaryCfg(null);
  ['clCloudName', 'clPreset', 'clFolder', 'clApiKey', 'clApiSecret'].forEach(id => setVal(id, ''));
  const cb = document.getElementById('clEnabled'); if (cb) cb.checked = false;
  clFieldsOpen = false;
  cloudMsg('Config hata diya gaya — photo upload ke liye dobara Sign In karna hoga.', false);
  updateCloudinaryStatus();
}

async function testCloudinary() {
  if (!isCloudinaryOn()) { cloudMsg('Pehle Cloud Name + Preset bharo, Enable tick karo aur Save dabao.', true); return; }
  const btn = document.getElementById('clTestBtn');
  if (!setBusy(btn, true, 'Testing...')) return;   // duplicate submit block
  cloudMsg('Test upload chal raha hai...', false);
  try {
    const url = await uploadToCloudinary(CLOUD_PROBE_JPEG);
    const cfg = loadCloudinaryCfg();
    if (cfg.apiKey && cfg.apiSecret) {
      const gone = await deleteCloudinaryPhoto(url);
      cloudMsg(gone ? '✅ Test upload + delete dono OK — ' + url
                    : '✅ Test upload OK, delete fail (key/secret check karo) — ' + url, !gone);
    } else {
      cloudMsg('✅ Test upload OK — ' + url, false);
    }
  } catch (e) {
    const m = cloudErrorText(e);
    cloudMsg('❌ ' + m, true);
    alert('Cloudinary test fail:\n\n' + m);
  } finally { setBusy(btn, false); }   // fail me bhi loader hatao
}

/* ---- Firebase error ko samajhne layak message me badlo ---- */
// "Missing or insufficient permissions" bol kar chup nahi hona chahiye —
// user ko batana chahiye ki exactly kya bigda hai aur kya karna hai.
function cloudErrorText(e) {
  const raw = (e && e.message) ? String(e.message) : 'unknown error';
  const code = (e && e.code) ? String(e.code) : '';
  const s = (code + ' ' + raw).toLowerCase();
  // Apna upload timeout — user ko kya karna hai wo saaf batao (Cloudinary ki raw
  // line se usse kuch samajh nahi aata)
  if (s.includes('upload timeout')) {
    return 'Cloudinary upload timeout — network slow tha. Photo compress ho chuki hai (chhoti file), isliye dobara Save dabao: is baar 5-10 second me chadh jayegi.';
  }
  // Cloudinary ke errors pehle se saaf bhasha me likhe hote hain (cloudinaryUploadError) —
  // unhe dobara mat badlo
  if (s.includes('cloudinary')) return raw;
  if (s.includes('permission') || s.includes('insufficient') || s.includes('unauthorized')) {
    return 'Firebase Rules ne block kiya (permission-denied). Firebase Console → Firestore → Rules me published rules check karo.';
  }
  if (s.includes('unauthenticated') || s.includes('user not authenticated') || s.includes('token') && s.includes('invalid')) {
    return 'Login session expire ho gaya — Sign Out karke dobara Sign In karo.';
  }
  if (s.includes('no-default-bucket') || s.includes('bucket')) {
    return 'Cloud Storage is project me set nahi hua — Firebase Console → Storage → Get Started chalao.';
  }
  if (s.includes('quota')) {
    return 'Firebase Storage quota khatam — Console → Usage me dekho ya plan upgrade karo.';
  }
  if (s.includes('retry-limit') || s.includes('storage/retry')) {
    return 'Storage par baar-baar retry fail hua — internet check karke dobara try karo.';
  }
  if (s.includes('app check') || s.includes('appcheck')) {
    return 'App Check enforcement chalu hai — Firebase Console → App Check → Enforcement band karo.';
  }
  if (s.includes('timeout') || s.includes('network') || s.includes('unavailable') || s.includes('offline')) {
    return 'Network/Firebase server se connect nahi ho raha — internet check karke dobara try karo.';
  }
  if (s.includes('storage/canceled')) {
    return 'Upload cancel ho gaya (time limit ya aapne roka).';
  }
  return raw;
}

// 1x1 ka chhota JPEG — Storage permission check ke liye kaafi
const CLOUD_PROBE_JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCn/9k=';

// Cloudinary ka apna probe — runCloudCheck me shamil hota hai
async function cloudinaryCheckLines() {
  const Y = '✅ ', N = '❌ ', W = '⚠️ ';
  const lines = [];
  const cfg = loadCloudinaryCfg();
  if (!cfg || !cfg.cloudName || !cfg.uploadPreset) {
    lines.push(N + 'Cloudinary sign-in nahi hai — photo upload FAIL hoga (fallback nahi hai).');
    lines.push('   Fix: Settings → Cloudinary → "Sign In to Cloudinary" → Cloud Name + Preset → Save.');
    return lines;
  }
  if (!isCloudinarySignedIn()) {
    lines.push(N + 'Cloudinary sign out hai — photo upload FAIL hoga.');
    lines.push('   Fix: Settings → Cloudinary → Sign In → Save dabao.');
    return lines;
  }
  if (cfg.enabled === false) {
    lines.push(N + 'Cloudinary sign-in hai par Enable OFF hai — photo upload FAIL hoga.');
    lines.push('   Fix: Settings → Cloudinary → Enable tick karke Save dabao.');
    return lines;
  }
  try {
    const url = await uploadToCloudinary(CLOUD_PROBE_JPEG);
    lines.push(Y + 'Cloudinary UPLOAD OK  (cloud: ' + cfg.cloudName + (cfg.folder ? ', folder: ' + cfg.folder : '') + ')');
    const gone = await deleteCloudinaryPhoto(url);
    lines.push(gone ? Y + 'Cloudinary DELETE OK'
                    : W + 'Cloudinary delete skip — API Key/Secret nahi diye (bill delete par photo Cloudinary me reh jayegi).');
  } catch (e) {
    lines.push(N + 'Cloudinary UPLOAD fail: ' + cloudErrorText(e));
  }
  return lines;
}

/* ---- Cloud ka access step-by-step check karo (Settings button) ---- */
// Har step ka result alert me dikhao, taki pata chale ki rules, login, ya
// Storage — kaunsa hissa fail ho raha hai.
async function runCloudCheck() {
  const Y = '✅ ', N = '❌ ', W = '⚠️ ';
  const lines = [];
  const step = (t) => { lines.push(t); };
  if (!firebaseReady) { alert('Cloud check:\n\n' + N + 'Firebase configured nahi hai.'); return; }
  const btn = document.getElementById('cloudCheckBtn');
  if (!setBusy(btn, true, 'Checking...')) return;   // duplicate check block
  try {
    step(Y + 'Firebase loaded — project: ' + firebaseConfig.projectId);
    if (!fbAuth || !fbAuth.currentUser) {
      step(N + 'Sign in nahi hai — pehle apne account me login karo.');
      (await cloudinaryCheckLines()).forEach(step);
      alert('CLOUD ACCESS CHECK\n\n' + lines.join('\n'));
      return;
    }
    const user = fbAuth.currentUser;
    step(Y + 'Signed in: ' + (user.email || user.uid));
    step('Account data path: stores/' + (activeDataUid || user.uid) + (adminViewing ? '  (Admin kisi user ke account me hai)' : ''));

    try {
      await withTimeout(user.getIdToken(), 20000, 'Auth token timeout');
      step(Y + 'Login token valid hai');
    } catch (e) { step(N + 'Login token fail: ' + cloudErrorText(e)); }

    // Profile doc — isi se Admin ko accounts list milti hai
    const profOk = await ensureProfile();
    if (profOk) step(Y + 'Profile save OK  (profiles/' + user.uid + ')');
    else step(N + 'Profile save fail (Accounts list ke liye profiles rule chahiye): permission-denied?');

    let firestoreOk = false;
    try {
      await withTimeout(fbDb.collection('stores').doc(activeDataUid || user.uid).get(), 25000, 'Firestore read timeout');
      firestoreOk = true;
      step(Y + 'Firestore READ OK  (path: stores/' + (activeDataUid || user.uid) + ')');
    } catch (e) {
      step(N + 'Firestore READ fail: ' + cloudErrorText(e));
    }

    // Role / Admin access — rules publish hone ke baad hi chalta hai
    const isAdminNow = await fetchAdminFlag(false);
    step(isAdminNow ? Y + 'Role: ADMIN — Accounts section available' : W + 'Role: normal user (Admin nahi)');
    if (isAdminNow) {
      try {
        const snap = await withTimeout(fbDb.collection('profiles').limit(50).get(), 20000, 'Profiles list timeout');
        step(Y + 'Accounts list OK — ' + snap.size + ' profile(s) milin');
      } catch (e) {
        step(N + 'Accounts list fail (Admin ke liye profiles par list rule chahiye): ' + cloudErrorText(e));
      }
    }

    (await cloudinaryCheckLines()).forEach(step);

    const failed = lines.some(l => l.startsWith(N));
    if (firestoreOk) setSyncError('');   // rules ab theek hain → purana stale error hata do
    step('');
    step(failed
      ? 'Fix: Firebase Console → Firestore → Rules me sahi rules Publish karo, phir yeh check dobara chalao.'
      : 'Sab theek hai. Ab "Sync Now" dabao aur photo wali bill save karke dekho.');
    alert('CLOUD ACCESS CHECK\n\n' + lines.join('\n'));
    updateSettingsUI();
  } finally { setBusy(btn, false); }   // har case (success/error) me loader hatao
}
async function changePin() {
  if (hasPIN()) {
    const old = prompt('Enter current PIN:'); if (old === null) return;
    if (await hashPin(old) !== localStorage.getItem(PIN_KEY)) { alert('Wrong PIN.'); return; }
  }
  const np1 = prompt('New 4-digit PIN:');
  if (np1 === null) return;
  if (!/^\d{4}$/.test(np1)) { alert('PIN must be exactly 4 digits.'); return; }
  const np2 = prompt('Confirm new PIN:');
  if (np2 === null) return;
  if (np1 !== np2) { alert('PINs do not match.'); return; }
  localStorage.setItem(PIN_KEY, await hashPin(np1)); alert('✅ PIN updated.'); updateSettingsUI();
}
async function toggleBiometric() {
  if (isBioEnabled() && hasBioCred()) {
    if (confirm('Disable biometric unlock?')) { localStorage.removeItem(BIO_CRED_KEY); localStorage.removeItem(BIO_ENABLED_KEY); alert('Biometric disabled.'); }
  } else { await registerBiometric(); }
  updateSettingsUI();
}

/* ============ AUTH (app ka apna login) ============ */
// Login screen — back button sirf tab jab session pehle se maujood ho (settings se aaye)
function showLoginScreen(canGoBack) {
  const b = document.getElementById('loginBackBtn');
  if (b) b.classList.toggle('hidden', !canGoBack);
  const le = document.getElementById('loginErr');
  if (le) le.textContent = '';
  const lp = document.getElementById('loginPass');
  if (lp) lp.value = '';
  showScreen('loginScreen');
}
function loginErr(msg) { const el = document.getElementById('loginErr'); if (el) el.textContent = msg || ''; }

// Firebase auth codes ko aam aadmi samajh sake aise message me badlo
function friendlyAuthError(e) {
  const code = (e && e.code) ? String(e.code) : '';
  const map = {
    'auth/invalid-email': 'Email address sahi nahi hai.',
    'auth/user-disabled': 'Yeh account band kar diya gaya hai.',
    'auth/user-not-found': 'Is email ka account nahi mila — "Create New Account" dabao.',
    'auth/wrong-password': 'Galat password. Dobara try karo.',
    'auth/invalid-credential': 'Email ya password galat hai.',
    'auth/invalid-login-credentials': 'Email ya password galat hai.',
    'auth/too-many-requests': 'Bahut zyada galtiyan — thodi der baad try karo.',
    'auth/network-request-failed': 'Internet check karo — server se connect nahi ho raha.',
    'auth/email-already-in-use': 'Yeh email pehle se registered hai — Sign In dabao.',
    'auth/weak-password': 'Password kam se kam 6 characters ka rakho.',
    'auth/operation-not-allowed': 'Firebase Console → Authentication → Sign-in method me "Email/Password" enable karo.'
  };
  return map[code] || (e && e.message) || 'Login failed';
}

// Login/signup ke baad usi screen par wapas jahan se aaye the
function afterLogin() {
  const target = loginReturnTo;
  loginReturnTo = 'listScreen';
  if (target === 'settingsScreen') openSettings(); else showList();
}
function goBackFromLogin() {
  document.getElementById('loginPass').value = '';   // password DOM me na rahe
  if (fbAuth && fbAuth.currentUser) afterLogin();
  else loginErr('Pehle sign in karna hoga.');
}

async function doLogin() {
  if (!firebaseReady) { loginErr('Firebase configured nahi hai.'); return; }
  const email = document.getElementById('loginEmail').value.trim();
  const pass = document.getElementById('loginPass').value;
  loginErr('');
  if (!email || !pass) { loginErr('Email aur password dono bharein'); return; }
  const btn = document.getElementById('loginBtn');
  if (!setBusy(btn, true, 'Signing in...')) return;   // duplicate click → Firebase request dobara nahi jayega
  try {
    await fbAuth.signInWithEmailAndPassword(email, pass);
    document.getElementById('loginPass').value = '';
    loginErr('Sign in ho gaya — data load ho raha hai...');
    // Data load + screen change → onAuthUser listener karega (session persistent)
  }
  catch (e) { loginErr(friendlyAuthError(e)); }
  finally { setBusy(btn, false); }   // success par bhi loader hatao, warna stuck rahega
}
async function doSignup() {
  if (!firebaseReady) { alert('Firebase not configured.'); return; }
  const email = document.getElementById('loginEmail').value.trim();
  const pass = document.getElementById('loginPass').value;
  document.getElementById('loginErr').textContent = '';
  if (!email) { document.getElementById('loginErr').textContent = 'Email bharein'; return; }
  if (pass.length < 6) { document.getElementById('loginErr').textContent = 'Password min 6 chars'; return; }
  const btn = document.getElementById('signupBtn');
  if (!setBusy(btn, true, 'Creating...')) return;
  try {
    await fbAuth.createUserWithEmailAndPassword(email, pass);
    document.getElementById('loginPass').value = '';
    loginErr('✅ Account created — data load ho raha hai...');
    // Aage ka (migration → PIN gate → data bootstrap) onAuthUser listener karega
  }
  catch (e) { document.getElementById('loginErr').textContent = friendlyAuthError(e); }
  finally { setBusy(btn, false); }
}
async function signOutCloud() {
  if (!firebaseReady) return;
  if (adminViewing) { alert('Aap kisi user ke account me hain.\nSign out se pehle upar banner ka "Exit Account" dabayein.'); return; }
  if (!confirm('Sign out karein?\n\nIs account ka data isi device par safe rehta hai, lekin app dobara email + password maangega.')) return;
  setSyncError('');
  try { updateSettingsUI(); } catch (e) {}
  // onAuthUser(null) baaki saaf kar ke login screen dikha dega
  await fbAuth.signOut();
}
function handleCloud() {
  if (!firebaseReady) { alert('Firebase config missing.'); return; }
  if (fbAuth && fbAuth.currentUser) { signOutCloud(); return; }
  loginReturnTo = 'settingsScreen';
  showLoginScreen(true);
}
async function pushToCloud() {
  if (!firebaseReady || !fbAuth || !fbAuth.currentUser || !activeDataUid) return false;
  try {
    // Hamesha usi account ke doc par — jiska data abhi loaded hai (activeDataUid)
    await fbDb.collection('stores').doc(activeDataUid).set({
      bills, supBills,
      supplierOpenings,
      cloudinary: cloudinaryCfg || null,          // config bhi usi account ki (A ki config B ko na mile)
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      ownerUid: activeDataUid,                   // rules isi se verify karte hain
      updatedBy: fbAuth.currentUser.uid,         // Admin edit kare to pata chale
      email: (adminViewing ? impersonatedEmail : (fbAuth.currentUser.email || ''))
    });
    try { localStorage.setItem(acctKey('rgs_last_sync'), new Date().toISOString()); } catch (e) {}
    setSyncError('');
    return true;
  } catch (e) {
    console.warn('Push failed:', e);
    setSyncError('Backup failed: ' + cloudErrorText(e));
    return false;
  }
}
// askFirst !== false hone par (manual restore) dono taraf data ho to poochhta hai
async function pullFromCloud(askFirst) {
  if (!firebaseReady || !fbAuth || !fbAuth.currentUser || !activeDataUid) return false;
  try {
    const doc = await withTimeout(fbDb.collection('stores').doc(activeDataUid).get(), 20000, 'Cloud read timeout');
    if (!doc.exists) return false;
    const d = doc.data() || {};

    // Bina poochhe local data delete mat karo (sirf manual restore par)
    if (askFirst !== false && hasAnyAccountData()) {
      const take = confirm('Cloud backup aur is device dono me data hai.\nOK = cloud data local par replace kar do\nCancel = local data waisa hi rehne do');
      if (!take) return false;
    }

    suppressSync = true;
    applyCloudData(d);
    suppressSync = false;
    try { localStorage.setItem(acctKey('rgs_last_sync'), new Date().toISOString()); } catch (e) {}
    setSyncError('');
    loadCloudinaryCfg();
    fillCloudinaryForm();
    if (screenVisible('listScreen')) renderList();
    if (screenVisible('settingsScreen')) updateSettingsUI();
    return true;
  } catch (e) {
    console.warn('Pull failed:', e);
    setSyncError('Restore failed: ' + cloudErrorText(e));
    return false;
  }
}
async function syncNow() {
  if (!firebaseReady || !fbAuth || !fbAuth.currentUser || !activeDataUid) { alert('Sign in nahi hai — Settings → Account me Sign In karein.'); return; }
  if (!confirm('Sync? Is device ka data cloud par chala jayega (usi account me).')) return;
  const btn = document.getElementById('syncBtn');
  if (!setBusy(btn, true, 'Syncing...')) return;
  try {
    const ok = await pushToCloud();
    if (ok) { alert('✅ Synced.'); updateSettingsUI(); }
    else alert('❌ Sync failed.\n' + (localStorage.getItem(acctKey('rgs_sync_err')) || ''));
  } finally { setBusy(btn, false); }
}
// Rules theek karne ke baad bina sign-out kiye cloud data dobara mehnga sakta hai
async function restoreFromCloud() {
  if (!firebaseReady || !fbAuth || !fbAuth.currentUser || !activeDataUid) { alert('Sign in nahi hai — Settings → Account me Sign In karein.'); return; }
  if (!confirm('Cloud backup is device par le aayein?')) return;
  const btn = document.getElementById('restoreBtn');
  if (!setBusy(btn, true, 'Restoring...')) return;
  try {
    const ok = await pullFromCloud(true);
    if (ok) alert('✅ Cloud data restore ho gaya.');
    else alert('❌ Restore nahi hua.\n' + (localStorage.getItem(acctKey('rgs_sync_err')) || 'Cloud me koi data nahi mila (ya aapne Cancel dabaya).'));
  } finally { setBusy(btn, false); updateSettingsUI(); }
}
let syncTimer = null;
function scheduleAutoSync() {
  if (!firebaseReady || !fbAuth || !fbAuth.currentUser) return;
  if (!activeDataUid || suppressSync) return;    // data load/hone ke waqt chup-chaap push na ho
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => pushToCloud(), 3000);
}

/* ============ SESSION (auth listener + PIN gate + admin accounts) ============
   Startup: Firebase session (login) → PIN/Setup gate → data bootstrap → list
*/
let bgProfileStartedFor = '';   // is uid ka background profile/role read ho chuka
function onAuthUser(user) {
  try { hideLoading(); } catch (e) {}

  // Admin kisi user ke account me hai — session tab tak uske control me hai.
  // Sirf tab jab admin ka apna session khatam ho jaye, tab hi wapas login.
  if (adminViewing && user) return;

  if (!user) {
    // Sign out / session khatam — kisi doosre account ka data kabhi na dikhe
    sessionBooted = false;
    deviceUnlocked = false;
    activeDataUid = '';
    adminFlag = false;
    adminViewing = false;
    impersonatedUid = ''; impersonatedEmail = '';
    bgProfileStartedFor = '';        // naye sign in me profile/role dobara padha jaye
    suppressSync = true;
    clearAccountMemory();
    suppressSync = false;
    clearTimeout(syncTimer);
    loginReturnTo = 'listScreen';
    refreshChrome();
    showLoginScreen(false);
    return;
  }

  const switched = (activeDataUid !== user.uid);
  activeDataUid = user.uid;
  if (switched) { sessionBooted = false; deviceUnlocked = false; }   // naya account → dobara lock gate

  if (!sessionBooted) {
    migrateLegacyData();      // purana single-user data pehle login karne wale account ko
    loadLocalAccountData();   // usi account ki localStorage data
  }
  updateAdminBanner();
  refreshChrome();
  gateToDevice();             // PIN/Setup/lock → unlock par unlockAndEnter bootstrap karega

  // Background: profile + role — ye rukawat na dale isliye alag chalate hain.
  // Har uid ke liye sirf ek hi baar (warm start par onAuthUser 2 baar chalta hai —
  // warna same Firestore read dobara ho jaati thi).
  if (bgProfileStartedFor !== user.uid) {
    bgProfileStartedFor = user.uid;
    (async () => {
      try { await ensureProfile(); } catch (e) {}
      if (adminViewing) return;
      if (fbAuth && fbAuth.currentUser && fbAuth.currentUser.uid === user.uid) await fetchAdminFlag(false);
    })();
  }
}

// Login ke baad device gate: pehle Setup/Lock, unlocked ho to seedha andar
function gateToDevice() {
  if (deviceUnlocked) { unlockAndEnter(); return; }
  // Token refresh waghera par gate dobara mat kholo (user already gate par khara hai)
  if (screenVisible('lockScreen') || screenVisible('setupScreen')) return;
  if (!hasPIN()) startSetup(); else startLock();
}

// PIN/Setup/Biometric ke baad — yahin data cloud se taaza hota hai
let bootPromise = null;
function unlockAndEnter() {
  if (!activeDataUid) { showLoginScreen(false); return; }
  deviceUnlocked = true;
  if (sessionBooted) { updateAdminBanner(); refreshChrome(); return; }   // pehle se boot — screen mat chedo
  sessionBooted = true;
  const uidAtBoot = activeDataUid;   // boot ke waqt account badal gaya to complete mat karo
  bootPromise = (async () => {
    showLoading('Loading your account data...', 25000);
    try { await bootstrapAccountData(); }
    catch (e) { console.warn('Bootstrap failed:', e); }
    if (activeDataUid !== uidAtBoot) return;   // bech me sign-out / account switch — naya flow screen sambhal lega
    hideLoading();
    refreshChrome();
    afterLogin();   // Settings se Sign In karne par wapas Settings par jaye (loginReturnTo)
  })();
}

/* ---- Admin: saare accounts dekhna (rules admin ko hi allow karti hain) ---- */
let profilesCache = [];

async function openAccounts() {
  if (!isAdmin()) { alert('Yeh section sirf Admin ke liye hai.'); return; }
  const ae = document.getElementById('accountsAdminEmail');
  if (ae) ae.textContent = (fbAuth && fbAuth.currentUser) ? (fbAuth.currentUser.email || fbAuth.currentUser.uid) : '—';
  showScreen('accountsScreen');
  const list = document.getElementById('accountsList');
  if (list) list.innerHTML = '<div class="card" style="cursor:default"><div class="inline-load">' +
    '<span class="spin dark" aria-hidden="true"></span> Accounts list load ho rahi hai...</div></div>';
  try {
    const snap = await withTimeout(
      fbDb.collection('profiles').orderBy('email').limit(500).get(),
      20000, 'Accounts list timeout');
    profilesCache = [];
    snap.forEach(d => {
      const v = d.data() || {};
      profilesCache.push({ uid: d.id, email: v.email || '(no email)' });
    });
    renderAccounts();
    const aac = document.getElementById('adminAccountCount');
    if (aac) aac.textContent = profilesCache.length;
  } catch (e) {
    if (list) list.innerHTML = '<div class="card" style="cursor:default;color:#dc3545">❌ Accounts list nahi mili:<br>' +
      escapeHtml(cloudErrorText(e)) + '</div>';
  }
}

function renderAccounts() {
  const list = document.getElementById('accountsList');
  if (!list) return;
  const me = (fbAuth && fbAuth.currentUser) ? fbAuth.currentUser.uid : '';
  if (!profilesCache.length) { list.innerHTML = '<div class="card" style="cursor:default">Koi account nahi mila (profiles collection khali hai).</div>'; return; }
  let html = '';
  profilesCache.forEach((p, i) => {
    const isMe = p.uid === me;
    const isOpen = adminViewing && activeDataUid === p.uid;
    html += '<div class="card" style="cursor:default">' +
      '<div class="meta" style="margin:0 0 6px"><b>' + escapeHtml(p.email) + '</b>' +
      (isMe ? ' <span class="role-pill admin">Aapka account</span>' : '') +
      (isOpen ? ' <span class="role-pill admin">Abhi khula hua</span>' : '') +
      '<br><span style="font-size:11px;opacity:.7;word-break:break-all">' + escapeHtml(p.uid) + '</span></div>';
    if (isMe) html += '<div class="meta" style="margin:0">👑 Admin ka apna account — isko khulne ki zaroorat nahi.</div>';
    else if (isOpen) html += '<button class="btn small" onclick="exitImpersonation()">⬅️ Exit Account (wapas apna data)</button>';
    else html += '<button class="btn small" onclick="openUserAccount(' + i + ')">📂 Open this account</button>';
    html += '</div>';
  });
  list.innerHTML = html;
}

// Admin bina password ke user ka account kholti hai (rules admins/{uid} dekh kar allow karti hain)
async function openUserAccount(idx) {
  const p = profilesCache[idx];
  if (!p) return;
  if (!isAdmin()) { alert('Sirf Admin kisi aur account khul sakta hai.'); return; }
  const me = (fbAuth && fbAuth.currentUser) ? fbAuth.currentUser.uid : '';
  if (p.uid === me) { showList(); return; }
  if (!confirm('Open "' + p.email + '" ka account?\n\nUska poora data (bills, suppliers, photos, Cloudinary) isi app me khulega — upar banner dikhega ki aap kis account me ho. Wapas aane ke liye "Exit Account" dabayein.\n\nAapka apna data us waqt alag rehta hai.')) return;

  // Pehle rules par check — galat role ho to yahin ruk jayega (UI bypass ka koi fayda nahi)
  try {
    await withTimeout(fbDb.collection('stores').doc(p.uid).get(), 20000, 'Account read timeout');
  } catch (e) {
    alert('❌ Account nahi khula:\n\n' + cloudErrorText(e));
    return;
  }

  sessionBooted = false;
  deviceUnlocked = true;         // Admin already device-unlocked hai
  adminViewing = true;
  impersonatedUid = p.uid;
  impersonatedEmail = p.email;
  activeDataUid = p.uid;
  clearTimeout(syncTimer);
  clearAccountMemory();
  suppressSync = true;
  loadLocalAccountData();        // us account ki apni localStorage (A ki config B ko na dikhe)
  suppressSync = false;
  updateAdminBanner();
  refreshChrome();

  const uidAtBoot = activeDataUid;   // p.uid — boot ke waqt change ho to abort
  showLoading('Loading ' + p.email + ' ...', 25000);
  try { await bootstrapAccountData(); } catch (e) { console.warn('Admin open failed:', e); }
  if (activeDataUid !== uidAtBoot || !adminViewing) return;   // bech me exit / sign-out hua — uska flow sambhal lega
  hideLoading();
  sessionBooted = true;
  updateAdminBanner();
  refreshChrome();
  showList();
}

function exitImpersonation() {
  if (!adminViewing) { showList(); return; }
  if (!confirm('Wapas apne account me jayein?\n\n' + (impersonatedEmail || 'Us account') + ' ka data is screen se hat jayega (uska cloud data safe hai).')) return;
  adminViewing = false;
  const me = (fbAuth && fbAuth.currentUser) ? fbAuth.currentUser.uid : '';
  impersonatedUid = ''; impersonatedEmail = '';
  sessionBooted = false;
  activeDataUid = me;
  clearTimeout(syncTimer);
  clearAccountMemory();
  suppressSync = true;
  if (me) { migrateLegacyData(); loadLocalAccountData(); }
  suppressSync = false;
  updateAdminBanner();
  refreshChrome();
  if (!me) { showLoginScreen(false); return; }
  sessionBooted = true;
  const uidAtBoot = activeDataUid;   // me — boot ke waqt change ho to abort
  showLoading('Loading your account...', 25000);
  Promise.resolve(bootstrapAccountData()).catch(e => console.warn(e)).then(() => {
    if (activeDataUid !== uidAtBoot) return;   // bech me sign-out / account switch
    hideLoading();
    refreshChrome();
    showList();
  });
}

/* ============ EXPORT / IMPORT ============ */
function exportData() {
  const data = { version: APP_VERSION, bills, supBills, supplierOpenings, exportedAt: new Date().toISOString() };
  try {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = 'rgs-backup-' + today() + '.json';
    a.style.display = 'none';
    document.body.appendChild(a);      // kuch browser anchor-less click ignore karte hain
    a.click();
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} try { a.remove(); } catch (e) {} }, 1000);
  } catch (e) { alert('Export failed: ' + (e && e.message)); }
}
function importData(ev) {
  const f = ev.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const d = JSON.parse(r.result);
      if (!d || typeof d !== 'object' || !Array.isArray(d.bills) || !Array.isArray(d.supBills)) throw new Error('Invalid');
      if (!confirm('Replace all current data with backup?')) return;
      bills = normalizeBills(d.bills);
      supBills = normalizeSupBills(d.supBills);
      supplierOpenings = normalizeOpenings(d.supplierOpenings);
      saveToStorage(); supSave(); saveOpenings();
      alert('✅ Imported.'); showList();
    } catch (e) { alert('Invalid backup file.'); }
  };
  r.onerror = () => alert('Backup file padhne me dikkat aayi.');
  r.readAsText(f);
  ev.target.value = '';
}

/* ============ LOADING (spinner + busy state) ============ */
let loadingAutoTimer = null;
let loadingCancelled = false;
// Sirf user ke Cancel button se true — safety timer (auto-timeout) ko "user cancel"
// na samjha jaaye, warna timeout par poora save abort ho jata.
let loadingUserCancelled = false;
// Photo upload ka AbortController — Cancel dabte hi chal raha upload ruk jaye,
// warna alert/save-abort ko in-flight upload ka intezaar karna padta.
let photoUploadController = null;
let ldEl = null, ldMsg = null, ldSub = null, ldCancel = null;

// Full-screen loader — sirf tab jahan operation poori screen cover karta hai
// (app boot, account data load, photo upload batch, admin account open).
function showLoading(msg, autoMs, opts) {
  opts = opts || {};
  loadingCancelled = false;
  loadingUserCancelled = false;
  if (!ldEl) {
    ldEl = document.createElement('div');
    ldEl.id = 'loadingOverlay';
    ldEl.className = 'ld-overlay';
    ldEl.innerHTML =
      '<div class="ld-card">' +
        '<span class="spin dark lg" aria-hidden="true"></span>' +
        '<div class="ld-msg"></div>' +
        '<div class="ld-sub"></div>' +
        '<button type="button" class="ld-cancel hidden">Cancel</button>' +
      '</div>';
    document.body.appendChild(ldEl);
    ldMsg   = ldEl.querySelector('.ld-msg');
    ldSub   = ldEl.querySelector('.ld-sub');
    ldCancel = ldEl.querySelector('.ld-cancel');
  }
  ldMsg.textContent = msg || 'Loading...';
  if (ldSub) ldSub.textContent = opts.sub || '';
  // Cancel sirf wahan dikhao jahan sach me aage ka kaam rok sakte hain (photo batch)
  if (ldCancel) {
    if (opts.cancelable) {
      ldCancel.classList.remove('hidden');
      ldCancel.onclick = () => {
        loadingCancelled = true;
        loadingUserCancelled = true;
        if (photoUploadController) { try { photoUploadController.abort(); } catch (e) {} }
        hideLoading();
      };
    } else {
      ldCancel.classList.add('hidden');
      ldCancel.onclick = null;
    }
  }
  ldEl.classList.remove('hidden');
  // Safety valve — loader kabhi atka na rahe
  clearTimeout(loadingAutoTimer);
  loadingAutoTimer = setTimeout(() => { loadingCancelled = true; hideLoading(); }, Number(autoMs) > 0 ? Number(autoMs) : 60000);
}
// Chhota progress note (e.g. "2 / 5 photos")
function setLoadingSub(txt) { if (ldSub) ldSub.textContent = txt || ''; }

function hideLoading() {
  clearTimeout(loadingAutoTimer);
  loadingAutoTimer = null;
  if (ldEl) ldEl.classList.add('hidden');
}

// --- Button ke andar loading state -------------------------------------------
// Operation jis button par chal raha hai, loading wahi button ke andar dikhta hai.
// Saath hi button disable ho jata hai → double click / duplicate request nahi.
function setBusy(btn, on, label) {
  if (!btn) return false;
  if (on) {
    if (btn.dataset.busy === '1') return false;      // already busy → doosra click ignore
    btn.dataset.busy = '1';
    btn.dataset.busyHtml = btn.innerHTML;
    const s = document.createElement('span');
    s.className = 'spin';
    s.setAttribute('aria-hidden', 'true');
    btn.insertBefore(s, btn.firstChild);
    if (label) btn.appendChild(document.createTextNode(label));
    btn.disabled = true;
    btn.classList.add('busy');
    return true;
  }
  if (btn.dataset.busy !== '1') return true;
  const h = btn.dataset.busyHtml;
  delete btn.dataset.busy;
  delete btn.dataset.busyHtml;
  if (h !== undefined) btn.innerHTML = h;             // original label wapas
  btn.disabled = false;
  btn.classList.remove('busy');
  return true;
}
function isBusy(btn) { return !!(btn && btn.dataset.busy === '1'); }
// Button ka apna default label yaad rakho (taaki busy hata sakte waqt wahi wapas aaye)
function rememberLabel(btn) { if (btn && btn.dataset.baseLabel === undefined) btn.dataset.baseLabel = btn.innerHTML; }

/* ============ OCR: BILL PHOTO → TEXT → ITEMS ============
   Tesseract.js (CDN) se lazy-load hota hai — sirf jab user pehli baar "Scan Bill"
   dabata hai. Pehli baar me engine + wasm + language data (~8 MB) download hota
   hai; uske baad Tesseract apna IndexedDB cache use karta hai, isliye dobara scan
   seconds me ho jata hai. Urdu chip on karne par +1 MB.
   Cloudinary ki zaroorat NAHI — scan sirf padhta hai, photo kahin save nahi hoti.
   Vendor bill items "2 150" ya "5 x 120 600" jaisi lines se nikaalte hain; total
   aur date/alag se. Sab kuch user ko review sheet me dikhta hai — kuch bhi
   bina check hue seedha bill me nahi jaata. */
const TESSERACT_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
const OCR_LANG_KEY = 'rgs_ocr_lang';
const OCR_MAX_ROWS = 60;

let tessScriptPromise = null;   // CDN script load (ek hi baar)
let tessWorker = null;          // Tesseract worker (language change par terminate hota hai)
let tessWorkerLang = '';
let ocrTarget = 'customer';     // 'customer' | 'supplier'
let ocrRows = [];               // [{ name, qty, rate, amount }]
let ocrDetectedTotal = 0;
let ocrDetected = { name: '', date: '', orderNo: '' };
let ocrBusyBtn = null;

// Tesseract status → user ko samajh aane wala message
const TESS_STATUS = {
  'loading tesseract core':   'OCR engine aa raha hai',
  'initializing tesseract':   'Engine set ho raha hai',
  'loading language traineddata': 'Language data aa raha hai',
  'loaded language traineddata':  'Language data load hua',
  'initializing api':         'Engine ready ho raha hai',
  'recognizing text':         'Photo padhi ja rahi hai'
};

function getOCRLang() {
  let v = '';
  try { v = localStorage.getItem(OCR_LANG_KEY) || ''; } catch (e) {}
  return v === 'eng+urd' ? 'eng+urd' : 'eng';
}
function setOCRLangPref(v) {
  try { localStorage.setItem(OCR_LANG_KEY, v); } catch (e) {}
}
// Worker ek hi language se banta hai — switch karne par purana terminate
function dropTessWorker() {
  if (!tessWorker) return;
  const w = tessWorker;
  tessWorker = null; tessWorkerLang = '';
  try { w.terminate(); } catch (e) {}
}
function setOCRLang(lang) {
  setOCRLangPref(lang);
  dropTessWorker();
  renderOCRChips();
  const msg = document.getElementById('ocrMsg');
  if (msg && ocrRows.length) msg.textContent = 'Language set: ' + (lang === 'eng+urd' ? 'English + Urdu' : 'English') + ' — agli scan par lagega.';
}
function renderOCRChips() {
  const lang = getOCRLang();
  const eng = document.getElementById('ocrChipEng');
  const urd = document.getElementById('ocrChipUrd');
  if (eng) eng.classList.toggle('active', lang === 'eng');
  if (urd) urd.classList.toggle('active', lang === 'eng+urd');
}
function toggleOCRRaw() {
  const b = document.getElementById('ocrRawBox');
  if (b) b.classList.toggle('hidden');
}

// ---- CDN script (ek hi baar load) ----
function loadTesseractScript() {
  if (window.Tesseract) return Promise.resolve(true);
  if (tessScriptPromise) return tessScriptPromise;
  tessScriptPromise = new Promise((resolve) => {
    try {
      const s = document.createElement('script');
      s.src = TESSERACT_CDN;
      s.async = true;
      s.onload = () => resolve(!!window.Tesseract);
      s.onerror = () => resolve(false);
      document.head.appendChild(s);
    } catch (e) { resolve(false); }
  }).then((ok) => { if (!ok) tessScriptPromise = null; return ok; });
  return tessScriptPromise;
}

async function getTessWorker(onProgress) {
  const lang = getOCRLang();
  if (tessWorker && tessWorkerLang === lang) return tessWorker;
  dropTessWorker();

  const ok = await loadTesseractScript();
  if (!ok || !window.Tesseract) {
    throw new Error('OCR engine load nahi hua. Internet connection check karo (pehli baar me ~8 MB download hota hai).');
  }
  tessWorker = await window.Tesseract.createWorker(lang, 1, {
    logger: (m) => {
      if (!onProgress || !m || !m.status) return;
      const label = TESS_STATUS[m.status] || m.status;
      const pct = typeof m.progress === 'number' ? ' ' + Math.round(m.progress * 100) + '%' : '';
      onProgress(label + pct);
    }
  });
  tessWorkerLang = lang;
  return tessWorker;
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Photo padhi nahi ja saki.'));
    r.readAsDataURL(file);
  });
}

/* ---- Bill photo ke liye camera/gallery kholo ---- */
function startOCR(type, mode, btn) {
  ocrTarget = type === 'supplier' ? 'supplier' : 'customer';
  if (isBusy(btn)) return;
  ocrBusyBtn = btn || null;
  const inp = mode === 'camera' ? document.getElementById('ocrCamInput') : document.getElementById('ocrGalInput');
  if (!inp) { ocrBusyBtn = null; return; }
  inp.value = '';
  inp.onchange = (ev) => handleOCRSelect(ev);
  try {
    inp.click();
  } catch (e) {
    ocrBusyBtn = null;
    alert('❌ Camera / Gallery open nahi ho paya.\n\nIs app ko browser me chala kar dobara try karein.');
  }
}

async function handleOCRSelect(ev) {
  const btn = ocrBusyBtn;
  ocrBusyBtn = null;
  const f = ev.target.files && ev.target.files[0];
  if (!f) { if (btn) setBusy(btn, false); return; }            // user ne picker cancel kiya
  if (f.type && !f.type.startsWith('image/')) { alert('Sirf image file select karo.'); return; }
  if (btn) setBusy(btn, true, 'Scan...');

  try {
    let dataUrl;
    try { dataUrl = await readFileAsDataURL(f); }
    catch (e) { alert('❌ ' + (e && e.message ? e.message : 'Photo padhne me dikkat aayi.')); return; }

    // OCR ke liye photo par resize — 1800px tak. Chhota/clean image = behtar accuracy,
    // aur Tesseract par halki photo jaldi process hoti hai.
    const img = await compressImage(dataUrl, 1800, 0.9);
    if (loadingUserCancelled) return;

    showLoading('OCR chal raha hai...', 180000, {
      cancelable: true,
      sub: 'Pehli baar me engine download hota hai (~8 MB)'
    });
    let text = null, failure = '';
    try {
      const worker = await getTessWorker((p) => setLoadingSub(p));
      if (loadingUserCancelled) { dropTessWorker(); return; }
      const res = await worker.recognize(img);
      // Cancel dabne ke baad chal raha scan — worker hata do taaki agli scan
      // uske peeche na ghoomti (queue bhi khud se saaf hoti hai)
      if (loadingUserCancelled) { dropTessWorker(); return; }
      text = (res && res.data && res.data.text) ? String(res.data.text) : '';
    } catch (e) {
      console.warn('OCR failed:', e);
      failure = (e && e.message) ? e.message : 'OCR fail ho gaya.';
    } finally { hideLoading(); }
    if (failure) { alert('❌ ' + failure); return; }

    openOCRReview(text);
  } catch (e) {
    console.warn('OCR scan error:', e);
    alert('❌ Scan nahi ho paya: ' + (e && e.message ? e.message : 'unknown error'));
  } finally {
    if (btn) setBusy(btn, false);
  }
}

/* ---------- PARSER: OCR text → { items, total, name, date, orderNo } ---------- */
// Total / discount / header lines — inme se item nahi banna chahiye
const OCR_SKIP_RE = /(sub\s*-?\s*total|grand\s*total|net\s*total|total|amount|discount|disc\b|tax\b|gst|vat|paid|due|balance|round\s*off|cash\s*memo|change|page|invoice|invoice\s*no|inv\s*no|bill\s*no|date\b|phone|tel\b|mobile|www\.|gstin|strn|ntn|stn|thank|welcome|received|customer\s*name|supplier\s*name|vendor|address|\bph\b|cashier|receipt|computer|printed|terms|condition|licen|weight)/i;
const OCR_NAME_SKIP_RE = /(invoice|total|qty|rate\b|amount|bill\b|date|phone|tel|mobile|www|gstin|strn|ntn|cashier|dear|welcome|thank|ph\b|address|ltd|store|mart|market|road|st\.|near|opposite|account)/i;
const OCR_NUM_RE = /(\d[\d,]*(?:\.\d{1,2})?)/g;

function ocrNum(raw) {
  const n = Number(String(raw).replace(/,/g, ''));
  return isFinite(n) ? n : 0;
}
// Item ka naam: number se pehle ka text, saaf-saaf
function ocrCleanName(s) {
  return String(s || '')
    .replace(/[|_~^°•·]+/g, ' ')
    .replace(/^[^A-Za-z\u0600-\u06FF]+/, '')
    .replace(/[^A-Za-z\u0600-\u06FF\s.\-\/&']+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function ocrHasLetters(s) { return /[A-Za-z\u0600-\u06FF]{2,}/.test(String(s || '')); }

function ocrParseItems(text) {
  const out = [];
  const seen = new Set();
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+/g, ' ').trim();
    if (line.length < 3) continue;
    if (OCR_SKIP_RE.test(line)) continue;

    const nums = [];
    let bad = false;
    OCR_NUM_RE.lastIndex = 0;
    let m;
    while ((m = OCR_NUM_RE.exec(line)) !== null) {
      const digits = m[1].replace(/[^\d]/g, '');
      if (digits.length > 7) { bad = true; break; }   // date / phone / invoice no → poori line chhodo
      nums.push({ v: ocrNum(m[1]), start: m.index });
    }
    if (bad) continue;
    if (nums.length < 2 || nums.length > 3) continue;   // 1 number = header, 4+ = column-heavy noise

    const name = ocrCleanName(line.slice(0, nums[0].start));
    if (!ocrHasLetters(name)) continue;
    // "Ph: 055-1234567" / "Address: House 22" — colon wala label line item nahi hai
    if (name.indexOf(':') >= 0) continue;

    // Qty ke baad likha unit ("Chini 5kg 150 750" → "kg") naam me se gir jata tha.
    // Use naam ke saath jodein taaki supplier form ka Unit Type bhar ja sake.
    let fullName = name;
    if (nums.length >= 2) {
      const between = line.slice(nums[0].start + String(nums[0].v).length, nums[1].start);
      const unit = ocrGuessUnit(between);
      if (unit && fullName.toLowerCase().indexOf(unit) === -1) fullName = name + ' ' + unit;
    }

    const qty = nums[0].v;
    const rate = nums[1].v;
    const amount = nums.length === 3 ? nums[2].v : Math.round(qty * rate * 100) / 100;
    if (!(qty > 0) || !(rate > 0) || !(amount > 0)) continue;
    if (qty > 100000 || rate > 100000000) continue;

    // "2 x 150" / "5@120" jaisa marker ho to amount qty*rate se match hona chahiye;
    // 3 numbers wale case me bhi tala lagana (galat columns na ghus aayein)
    if (nums.length === 3 && amount > 0) {
      const calc = Math.round(qty * rate * 100) / 100;
      if (calc > 0 && Math.abs(calc - amount) / amount > 0.35) continue;
    }
    const key = fullName.toLowerCase() + '|' + qty + '|' + rate;
    if (seen.has(key)) continue;    // OCR aksar same line do baar deta hai
    seen.add(key);
    out.push({ name: fullName, qty, rate, amount });
    if (out.length >= OCR_MAX_ROWS) break;
  }
  return out;
}

// Total: "Grand/Total Amount" wali line se. Amount wale number me se sabse bada.
function ocrFindTotal(text) {
  const lines = String(text || '').split(/\r?\n/);
  function scanFrom(re) {
    let best = 0;
    for (const l of lines) {
      if (!re.test(l)) continue;
      OCR_NUM_RE.lastIndex = 0;
      let m;
      while ((m = OCR_NUM_RE.exec(l)) !== null) {
        if (m[1].replace(/[^\d]/g, '').length > 7) continue;
        const v = ocrNum(m[1]);
        if (v > best) best = v;
      }
    }
    return best;
  }
  // "Grand/Net/Total Amount" wali line pehle — "Sub Total 500, Total Amount 480"
  // me 480 hi chahiye (sabse bada number total nahi, sahi line ka number total hai)
  const grand = scanFrom(/(grand\s*total|net\s*total|total\s*amount|total\s*payable|amount\s*(payable|due))/i);
  if (grand > 0) return grand;
  return scanFrom(/(sub\s*-?\s*total|total\s*amount|^total\b|total)/i);
}

function ocrMkDate(y, mo, d) {
  let yy = Number(y), mm = Number(mo), dd = Number(d);
  if (yy < 100) yy += 2000;
  if (!(yy >= 1970 && yy <= 2100)) return '';
  if (!(mm >= 1 && mm <= 12)) return '';
  if (!(dd >= 1 && dd <= 31)) return '';
  const s = yy + '-' + String(mm).padStart(2, '0') + '-' + String(dd).padStart(2, '0');
  return isValidDateStr(s) ? s : '';
}
function ocrFindDate(text) {
  const t = String(text || '');
  let m = t.match(/\b(20\d{2})[-\/.](\d{1,2})[-\/.](\d{1,2})\b/);
  if (m) { const d = ocrMkDate(m[1], m[2], m[3]); if (d) return d; }
  m = t.match(/\b(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})\b/);
  if (m) { const d = ocrMkDate(m[3], m[2], m[1]); if (d) return d; }   // dd/mm/yyyy (PK me yahi chalta hai)
  const mon = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12 };
  m = t.match(/\b(\d{1,2})[-\s](jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*[-\s](\d{2,4})\b/i);
  if (m) { const d = ocrMkDate(m[3], mon[m[2].toLowerCase()], m[1]); if (d) return d; }
  return '';
}
function ocrFindName(text) {
  const lines = String(text || '').split(/\r?\n/)
    .map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  for (const l of lines.slice(0, 8)) {          // sirf bill ke upar ka hissa
    if (l.length < 3 || l.length > 45) continue;
    if (OCR_NAME_SKIP_RE.test(l)) continue;
    // Koi bhi digit ho to title-line nahi hai — warna item line ("Sugar 5 120 600")
    // naam ban jati hai
    if (/\d/.test(l)) continue;
    const name = ocrCleanName(l);
    if (name.length < 3 || name.length > 40) continue;
    if (!ocrHasLetters(name)) continue;
    return name;
  }
  return '';
}
function ocrFindOrderNo(text) {
  // "#A-991" jaisa prefix bhi aa sakta hai — isliye # capture se pehle aur capture me
  const m = String(text || '').match(
    /\b(?:order|invoice|inv|bill|ref)\s*\.?\s*(?:no\.?|number|#)?\s*[:\-]?\s*#?\s*([A-Za-z0-9][A-Za-z0-9\/\-]{2,19})/i
  );
  if (!m) return '';
  const v = m[1].replace(/[^A-Za-z0-9\/\-]/g, '');
  // Order no me kam se kam 1 digit hona chahiye — warna "No"/"Number" jaisa label pakad liya
  return (v.length >= 3 && /\d/.test(v)) ? v : '';
}
function ocrParseAll(text) {
  return {
    items: ocrParseItems(text),
    total: ocrFindTotal(text),
    date: ocrFindDate(text),
    name: ocrFindName(text),
    orderNo: ocrFindOrderNo(text)
  };
}

/* ---------- REVIEW SHEET (user yahan check / theek karta hai) ---------- */
function openOCRReview(text) {
  const p = ocrParseAll(text);
  ocrRows = p.items;
  ocrDetectedTotal = p.total;
  ocrDetected = { name: p.name, date: p.date, orderNo: p.orderNo };

  const raw = document.getElementById('ocrRawText');
  if (raw) raw.textContent = (text && text.trim()) ? text : '(koi text nahi mila)';
  renderOCRChips();

  const bits = [];
  if (p.items.length) bits.push(p.items.length + ' item mila');
  if (p.total > 0) bits.push('total Rs. ' + formatMoney(p.total));
  if (p.date) bits.push('date ' + p.date);
  if (p.name) bits.push('naam "' + p.name + '"');
  const msg = document.getElementById('ocrMsg');
  if (msg) {
    msg.textContent = bits.length
      ? bits.join(' • ') + ' — check karo, phir Fill in Bill dabao.'
      : 'Kuch padha nahi ja paya. Photo clear, seedhi aur poori ho to dobara scan karo, ya "Add Row" se khud daalo.';
  }
  const dBox = document.getElementById('ocrTotalBox');
  if (dBox) dBox.classList.toggle('hidden', !(p.total > 0));
  const dEl = document.getElementById('ocrDetected');
  if (dEl) dEl.textContent = formatMoney(p.total);

  renderOCRRows();
  const ov = document.getElementById('ocrModal');
  if (ov) { ov.classList.remove('hidden'); document.body.style.overflow = 'hidden'; }
}
function closeOCR() {
  const ov = document.getElementById('ocrModal');
  if (ov) ov.classList.add('hidden');
  document.body.style.overflow = '';
  ocrRows = [];
  ocrDetectedTotal = 0;
  ocrDetected = { name: '', date: '', orderNo: '' };
}
function renderOCRRows() {
  const box = document.getElementById('ocrItems');
  if (!box) return;
  box.innerHTML = '';
  if (!ocrRows.length) {
    box.innerHTML = '<div class="card" style="cursor:default">Koi item nahi mila. Raw text dekh lo, ya "Add Row" se khud daalo.</div>';
    updateOCRSum();
    return;
  }
  ocrRows.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'ocr-row';
    row.innerHTML =
      '<input type="text" class="o-name" placeholder="Item" value="' + escapeHtml(r.name) + '" oninput="updateOCRSum()">' +
      '<input type="number" class="o-qty" min="0" step="any" placeholder="Qty" value="' + escapeHtml(r.qty) + '" oninput="updateOCRSum()">' +
      '<input type="number" class="o-rate" min="0" step="any" placeholder="Rate" value="' + escapeHtml(r.rate) + '" oninput="updateOCRSum()">' +
      '<span class="o-amt"></span>' +
      '<button type="button" class="btn red tiny" onclick="removeOCRRow(' + i + ')">✕</button>';
    box.appendChild(row);
  });
  updateOCRSum();
}
function updateOCRSum() {
  let sum = 0;
  const rows = document.querySelectorAll('#ocrItems .ocr-row');
  rows.forEach((row) => {
    const q = toNumber(row.querySelector('.o-qty').value);
    const r = toNumber(row.querySelector('.o-rate').value);
    const t = Math.round(q * r * 100) / 100;
    const el = row.querySelector('.o-amt');
    if (el) el.textContent = t > 0 ? formatMoney(t) : '—';
    sum += t;
  });
  const el = document.getElementById('ocrSum');
  if (el) el.textContent = formatMoney(Math.round(sum * 100) / 100);
}
// User ne input me kuch theek kiya ho to wo turant UI se wapas uthana zaroori hai —
// warna "Add Row" ya "Remove" par rows dobara render karne se uska kaam gum ho jata tha
function syncOCRRowsFromUI() {
  const uiRows = Array.from(document.querySelectorAll('#ocrItems .ocr-row'));
  if (!uiRows.length) return;                     // empty state — kuch nahi bana
  ocrRows = uiRows.map((row) => {
    const qty = row.querySelector('.o-qty').value;
    const rate = row.querySelector('.o-rate').value;
    return {
      name: (row.querySelector('.o-name').value || '').trim(),
      qty, rate,
      amount: Math.round(toNumber(qty) * toNumber(rate) * 100) / 100
    };
  });
}
function addOCRRow() {
  syncOCRRowsFromUI();
  ocrRows.push({ name: '', qty: '', rate: '', amount: 0 });
  renderOCRRows();
  const rows = document.querySelectorAll('#ocrItems .ocr-row');
  const last = rows[rows.length - 1];
  if (last) { const i = last.querySelector('.o-name'); if (i) i.focus(); }
}
function removeOCRRow(idx) {
  syncOCRRowsFromUI();
  ocrRows.splice(idx, 1);
  renderOCRRows();
}
function readOCRRowsFromUI() {
  const rows = [];
  document.querySelectorAll('#ocrItems .ocr-row').forEach((row) => {
    const name = (row.querySelector('.o-name').value || '').trim();
    const qty = toNumber(row.querySelector('.o-qty').value);
    const rate = toNumber(row.querySelector('.o-rate').value);
    if (name && qty > 0) rows.push({ name, qty, rate });
  });
  return rows;
}
// Item ke naam se unit type guess (supplier form cartons+units me chalta hai).
// Bare "l" ya "kg" ko dhoondne ke liye boundary check zaroori — warna "Oil" me
// 'l' aur "Salt" me 'l' se galat unit ban jayega.
function ocrGuessUnit(name) {
  const n = ' ' + String(name || '').toLowerCase() + ' ';
  if (/(^|\s|\d)kgs?(\s|$)/.test(n) || n.indexOf('kilo') >= 0) return 'kg';
  if (/(^|\s|\d)(l|ltr|lt|litre|liter)(\s|$)/.test(n)) return 'litre';
  if (/(^|\s|\d)ml(\s|$)/.test(n)) return 'ml';
  if (/(^|\s|\d)(g|gm|gms|gram|grams)(\s|$)/.test(n)) return 'gram';
  if (/(^|\s|\d)doz(en)?(\s|$)/.test(n)) return 'dozen';
  if (n.indexOf('bottle') >= 0) return 'bottle';
  if (n.indexOf('packet') >= 0 || /(^|\s|\d)pkt(\s|$)/.test(n)) return 'packet';
  if (/(^|\s|\d)box(es)?(\s|$)/.test(n)) return 'box';
  if (/(^|\s|\d)bag(s)?(\s|$)/.test(n)) return 'bag';
  return '';
}

/* ---------- APPLY: review sheet → form ---------- */
// Form me sirf khaali (khud khud khuli hui) rows hain to confirm mat pucho —
// naye bill par hamesha 1 khaali row hoti hai, prompt bekaar confuse karta hai
function ocrFormHasData(kind) {
  if (kind === 'supplier') {
    return Array.from(document.querySelectorAll('#productsBox .product-card')).some((c) => {
      return (c.querySelector('.p-name').value || '').trim() ||
             toNumber(c.querySelector('.p-qc').value) || toNumber(c.querySelector('.p-rc').value) ||
             toNumber(c.querySelector('.p-qu').value) || toNumber(c.querySelector('.p-ru').value) ||
             (c.querySelector('.p-ut').value || '').trim();
    });
  }
  return Array.from(document.querySelectorAll('#itemsBox .product-card')).some((c) => {
    return (c.querySelector('.i-name').value || '').trim() ||
           toNumber(c.querySelector('.i-qty').value) || toNumber(c.querySelector('.i-rate').value);
  });
}
function applyOCR() {
  const rows = readOCRRowsFromUI();
  if (!rows.length) { alert('Kam se kam 1 item chahiye — naam aur Qty dono bharo.'); return; }

  const btn = document.getElementById('ocrApplyBtn');
  if (btn && !setBusy(btn, true, 'Filling...')) return;   // duplicate click block
  let done = false;
  try {
    done = (ocrTarget === 'supplier') ? applyOCRToSupplier(rows) : applyOCRToCustomer(rows);
    if (done) {
      closeOCR();
      alert(rows.length + ' item(s) bill me daal diye gaye. Ab check kar ke Save dabao.');
    }
  } finally {
    if (btn) setBusy(btn, false);
  }
}

// Naam sirf SUPPLIER form me bharta hai — customer bill ke upar shop ka naam hota hai,
// customer ka nahi. Customer form me wo sirf review sheet ke message me dikhta hai.
function applyOCRToCustomer(rows) {
  const box = document.getElementById('itemsBox');
  if (ocrFormHasData('customer') &&
      !confirm('Form me jo items hain unhe hata kar OCR wale daal dein?')) return false;

  const dateEl = document.getElementById('f-date');
  if (ocrDetected.date && dateEl) dateEl.value = ocrDetected.date;

  box.innerHTML = '';
  rows.forEach(r => addItemRow(r));
  if (!box.children.length) addItemRow();
  calcTotal();
  return true;
}

function applyOCRToSupplier(rows) {
  if (ocrFormHasData('supplier') &&
      !confirm('Form me jo products hain unhe hata kar OCR wale daal dein?')) return false;

  const nameEl = document.getElementById('s-name');
  if (ocrDetected.name && nameEl && !nameEl.value.trim()) {
    nameEl.value = ocrDetected.name;
    onSupplierNameChange();
  }
  const dateEl = document.getElementById('s-date');
  if (ocrDetected.date && dateEl) dateEl.value = ocrDetected.date;
  const delEl = document.getElementById('s-delivery');
  if (ocrDetected.date && delEl && !delEl.value) delEl.value = ocrDetected.date;
  const ordEl = document.getElementById('s-orderno');
  if (ocrDetected.orderNo && ordEl && !ordEl.value.trim()) ordEl.value = ocrDetected.orderNo;

  const box = document.getElementById('productsBox');
  box.innerHTML = '';
  rows.forEach(r => addProductRow({
    name: r.name, qtyCartons: 0, rateCartons: 0,
    qtyUnits: r.qty, rateUnits: r.rate, unitType: ocrGuessUnit(r.name)
  }));
  if (!box.children.length) addProductRow();
  updateProductNumbers();
  recalcProducts();
  return true;
}

/* ============ PWA INSTALL ============ */
let deferredPrompt = null;
function showInstallBtn(show) {
  const b = document.getElementById('installBtn');
  if (b) b.classList.toggle('hidden', !show);
}
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; showInstallBtn(true); });
function installApp() {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(() => { deferredPrompt = null; showInstallBtn(!isStandalone()); });
    return;
  }
  alert('Install as app: Chrome menu (⋮) → "Install app".\nAgar "Install app" na dikhe to purana shortcut home screen se hatao, phir try karo.');
}
window.addEventListener('appinstalled', () => { deferredPrompt = null; showInstallBtn(isStandalone()); });

if ('serviceWorker' in navigator && location.protocol !== 'file:' && !isNativeApp()) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
}

/* ============ START ============ */
window.addEventListener('load', () => {
  try { if (!isStandalone()) setTimeout(() => showInstallBtn(true), 1500); }
  catch (e) { console.warn('install btn:', e); }   // install hint fail ho to session check na roke

  // Version dikhane wali lines
  const vEl = document.getElementById('appVersion');
  if (vEl) vEl.textContent = APP_VERSION;
  const vsEl = document.getElementById('appVersionSettings');
  if (vsEl) vsEl.textContent = APP_VERSION;

  // Back button guard — app band hone se rokne ke liye
  try {
    if (!history.state || !history.state.appGuard) {
      history.replaceState({ appGuard: true }, '');
      history.pushState({ appGuard: true }, '');
    }
  } catch(e) {}

  // 1) Firebase session (login) → 2) PIN/Setup gate → 3) data bootstrap → 4) list
  if (firebaseReady && fbAuth) {
    // Session pehle se pata hai (warm start) → loader/splash wait kiye bina
    // seedha PIN/lock gate kholo, jisse biometric bhi foran trigger ho.
    const warmUser = fbAuth.currentUser;
    if (warmUser) { try { onAuthUser(warmUser); } catch (e) { console.warn(e); } }
    else showLoading('Checking your session...', 20000, { sub: 'Login check ho raha hai' });
    fbAuth.onAuthStateChanged((user) => { try { hideLoading(); } catch (e) {} onAuthUser(user); });
  } else {
    showLoginScreen(false);
    loginErr('Firebase configured nahi hai — index.html me apna firebaseConfig bharo.');
  }
});

window.addEventListener('popstate', () => {
  const keepGuard = () => { try { history.pushState({ appGuard: true }, ''); } catch (err) {} };

  // 1) Agar photo viewer khula hai to pehle usko band karo
  const viewerEl = document.getElementById('photoViewer');
  if (viewerEl && !viewerEl.classList.contains('hidden')) {
    closeViewer();
    keepGuard();
    return;
  }

  // 2) OCR review sheet khuli hai → pehle usko band karo (form waise hi bana rahe)
  const ocrEl = document.getElementById('ocrModal');
  if (ocrEl && !ocrEl.classList.contains('hidden')) {
    closeOCR();
    keepGuard();
    return;
  }

  // 3) Login screen se back → sirf tab jab session pehle se ho (settings se aaye)
  if (screenVisible('loginScreen')) {
    keepGuard();
    if (fbAuth && fbAuth.currentUser) goBackFromLogin();
    return;
  }

  // 4) Accounts (Admin) screen → wapas list
  if (screenVisible('accountsScreen')) {
    showList();
    keepGuard();
    return;
  }

  // 5) Lock / Setup screen par back app ko band na kare
  if (screenVisible('lockScreen') || screenVisible('setupScreen')) {
    keepGuard();
    return;
  }

  const onSub = screenVisible('formScreen') || screenVisible('detailScreen') ||
                screenVisible('supFormScreen') || screenVisible('supDetailScreen') ||
                screenVisible('settingsScreen') || screenVisible('openingsScreen');

  if (onSub) {
    const isSup = screenVisible('supFormScreen') || screenVisible('supDetailScreen') || screenVisible('openingsScreen');
    if (isSup) {
      currentSupId = null;
      showScreen('supListScreen');
      renderSupplierList();
    } else {
      currentBillId = null;
      showScreen('listScreen');
      renderList();
    }
    keepGuard();
  }
});
  
 


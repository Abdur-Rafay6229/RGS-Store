const fs = require('fs');
const html = fs.readFileSync('C:/Users/DELL/Desktop/Bills Manager testing/test 1/index.html', 'utf8');
const js = fs.readFileSync('C:/Users/DELL/Desktop/Bills Manager testing/test 1/src/js/app.js', 'utf8');

// 1. All function declarations in app.js
const declared = new Set();
for (const m of js.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) declared.add(m[1]);
// Also arrow-function globals: const foo = (...) => ...
for (const m of js.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>/g)) declared.add(m[1]);

// 2. All function references in HTML (onclick, oninput, onchange, onkeydown, onblur, onload)
const used = new Set();
for (const m of html.matchAll(/on(?:click|input|change|keydown|keyup|blur|focus|load|error)\s*=\s*"([^"]*)"/gi)) {
  const body = m[1];
  // extract identifier before '('
  for (const f of body.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) used.add(f[1]);
}

// built-ins to ignore
const builtins = new Set(['if','for','while','switch','catch','function','return','alert','confirm','prompt','Number','String','Boolean','Array','Object','JSON','Math','Date','setTimeout','setInterval','clearTimeout','clearInterval','fetch','FileReader','Blob','URL','FormData','AbortController','Image','TextEncoder','Uint8Array','Promise','Error','Map','Set','console','navigator','document','window','history','location','localStorage','crypto','PublicKeyCredential','File','RegExp','encodeURIComponent','decodeURIComponent','isFinite','parseInt','parseFloat','Infinity','NaN','Intl','WeakMap','WeakSet','Symbol','BigInt','DataTransfer','CustomEvent','Event','KeyboardEvent','MouseEvent','TouchEvent','WheelEvent','PointerEvent','focus','blur','stopPropagation','preventDefault','toString','valueOf','hasOwnProperty','apply','call','bind','slice','splice','push','pop','shift','unshift','map','filter','reduce','forEach','find','findIndex','includes','indexOf','join','split','replace','trim','toLowerCase','toUpperCase','charAt','charCodeAt','concat','entries','keys','values','from','assign','freeze','entries','then','catch','finally','add','delete','open','close','match','test','exec','normalize','stringify','parse','min','max','abs','round','floor','ceil','sqrt','pow','random','hypot','log','log2','log10','sin','cos','tan','getElementById','querySelector','querySelectorAll','createElement','appendChild','removeChild','insertBefore','addEventListener','removeEventListener','setAttribute','removeAttribute','getBoundingClientRect','requestAnimationFrame','cancelAnimationFrame','createObjectURL','revokeObjectURL','writeText','readText','register','getItem','setItem','removeItem','clear','getRandomValues','digest','sign','verify','initializeApp','auth','firestore','collection','doc','get','set','update','delete','add','onAuthStateChanged','signInWithEmailAndPassword','createUserWithEmailAndPassword','signOut','getIdToken','serverTimestamp','FieldValue','start','terminate','recognize','readAsDataURL','readAsText','click','remove','measureText','fillText','fillRect','strokeRect','drawImage','toDataURL','getContext','match','send','open','watchPosition','vibrate','share','canShare','download','print','scrollTo','replaceState','pushState','back','forward','go','reload','toString']);

const missing = [...used].filter(f => !declared.has(f) && !builtins.has(f)).sort();

console.log('=== FUNCTIONS USED IN HTML ===');
console.log('Total unique functions referenced in HTML:', used.size);
console.log('Total functions declared in app.js:', declared.size);
console.log('');
if (missing.length) {
  console.log('!!! MISSING (referenced in HTML but not declared in app.js):');
  missing.forEach(f => console.log('  -', f));
} else {
  console.log('✅ All HTML-referenced functions exist in app.js');
}

// 3. Check all getElementById targets exist in HTML
const htmlIds = new Set();
for (const m of html.matchAll(/id="([^"]+)"/g)) htmlIds.add(m[1]);
const jsIds = new Set();
for (const m of js.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)) jsIds.add(m[1]);
const missingIds = [...jsIds].filter(id => !htmlIds.has(id));
console.log('');
console.log('=== DOM ID CHECK ===');
console.log('IDs in HTML:', htmlIds.size, '| IDs referenced in JS:', jsIds.size);
if (missingIds.length) {
  console.log('!!! MISSING IDS (JS references but not in HTML):');
  missingIds.forEach(id => console.log('  -', id));
} else {
  console.log('✅ All JS-referenced DOM ids exist in HTML');
}

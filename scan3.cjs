const fs = require('fs');
let js = fs.readFileSync('C:/Users/DELL/Desktop/Bills Manager testing/test 1/src/js/app.js', 'utf8');

// Strip comments and string literals (keep structure, remove noise)
let out = '';
let i = 0;
while (i < js.length) {
  const c = js[i], n = js[i + 1];
  if (c === '/' && n === '/') { while (i < js.length && js[i] !== '\n') i++; continue; }
  if (c === '/' && n === '*') { i += 2; while (i < js.length && !(js[i] === '*' && js[i + 1] === '/')) i++; i += 2; continue; }
  if (c === '"' || c === "'" || c === '`') {
    const q = c; i++;
    while (i < js.length && js[i] !== q) { if (js[i] === '\\') i++; i++; }
    i++; out += '""'; continue;
  }
  if (c === '/' && /[(\[=,:!&|?{};\n]/.test(js[i - 1] || ' ')) {
    // regex literal — skip to closing /
    i++; let inClass = false;
    while (i < js.length) {
      if (js[i] === '\\') { i += 2; continue; }
      if (js[i] === '[') inClass = true;
      if (js[i] === ']') inClass = false;
      if (js[i] === '/' && !inClass) { i++; break; }
      if (js[i] === '\n') break;
      i++;
    }
    out += '/re/'; continue;
  }
  out += c; i++;
}
js = out;

const declared = new Set();
for (const m of js.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
for (const m of js.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
for (const m of js.matchAll(/function\s+[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g)) {
  m[1].split(',').forEach(p => { p = p.trim().split('=')[0].trim(); if (p) declared.add(p); });
}
// catch clauses, arrow params
for (const m of js.matchAll(/\(([\w$,\s]+)\)\s*=>/g)) {
  m[1].split(',').forEach(p => { p = p.trim(); if (p && /^[A-Za-z_$][\w$]*$/.test(p)) declared.add(p); });
}

const builtins = new Set(('if,for,while,switch,catch,return,alert,confirm,prompt,Number,String,Boolean,Array,Object,JSON,Math,Date,setTimeout,setInterval,clearTimeout,clearInterval,fetch,FileReader,Blob,URL,FormData,AbortController,Image,TextEncoder,Uint8Array,Promise,Error,Map,Set,console,navigator,document,window,history,location,localStorage,crypto,PublicKeyCredential,File,RegExp,encodeURIComponent,decodeURIComponent,isFinite,parseInt,parseFloat,Infinity,NaN,Intl,WeakMap,WeakSet,Symbol,BigInt,DataTransfer,CustomEvent,Event,KeyboardEvent,MouseEvent,TouchEvent,WheelEvent,PointerEvent,focus,blur,stopPropagation,preventDefault,toString,valueOf,hasOwnProperty,apply,call,bind,slice,splice,push,pop,shift,unshift,map,filter,reduce,forEach,find,findIndex,includes,indexOf,join,split,replace,replaceAll,trim,toLowerCase,toUpperCase,charAt,charCodeAt,concat,entries,keys,values,from,assign,freeze,then,catch,finally,add,delete,open,close,match,test,exec,normalize,stringify,parse,min,max,abs,round,floor,ceil,sqrt,pow,random,hypot,log,log2,log10,sin,cos,tan,getElementById,querySelector,querySelectorAll,createElement,appendChild,removeChild,insertBefore,addEventListener,removeEventListener,setAttribute,removeAttribute,getBoundingClientRect,requestAnimationFrame,cancelAnimationFrame,createObjectURL,revokeObjectURL,writeText,readText,register,getItem,setItem,removeItem,clear,getRandomValues,digest,sign,verify,initializeApp,auth,firestore,collection,doc,get,set,update,onAuthStateChanged,signInWithEmailAndPassword,createUserWithEmailAndPassword,signOut,getIdToken,serverTimestamp,FieldValue,start,terminate,recognize,readAsDataURL,readAsText,click,remove,measureText,fillText,fillRect,strokeRect,drawImage,toDataURL,getContext,vibrate,share,canShare,download,print,scrollTo,replaceState,pushState,back,forward,go,reload,isNativePlatform,watch,btoa,atob,now,defineProperty').split(','));

const calls = new Set();
for (const m of js.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) calls.add(m[1]);

const missing = [...calls].filter(f => !declared.has(f) && !builtins.has(f) && !/^[A-Z]/.test(f)).sort();
console.log('=== CLEAN INTERNAL CALL SCAN (comments/strings/regex stripped) ===');
console.log('Unique calls:', calls.size);
if (missing.length) {
  console.log('!!! UNDEFINED:');
  missing.forEach(f => console.log('  -', f));
} else {
  console.log('✅ ALL internal function calls resolve correctly');
}

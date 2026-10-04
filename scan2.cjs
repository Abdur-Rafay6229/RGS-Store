const fs = require('fs');
const js = fs.readFileSync('C:/Users/DELL/Desktop/Bills Manager testing/test 1/src/js/app.js', 'utf8');

// All declared names (functions, const, let, var, params of top-level functions)
const declared = new Set();
for (const m of js.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
for (const m of js.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
// function params
for (const m of js.matchAll(/function\s+[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g)) {
  m[1].split(',').forEach(p => { p = p.trim().split('=')[0].trim(); if (p) declared.add(p); });
}
// object methods like shareMeasure etc are covered by function decl

const builtins = new Set(('if,for,while,switch,catch,return,alert,confirm,prompt,Number,String,Boolean,Array,Object,JSON,Math,Date,setTimeout,setInterval,clearTimeout,clearInterval,fetch,FileReader,Blob,URL,FormData,AbortController,Image,TextEncoder,Uint8Array,Promise,Error,Map,Set,console,navigator,document,window,history,location,localStorage,crypto,PublicKeyCredential,File,RegExp,encodeURIComponent,decodeURIComponent,isFinite,parseInt,parseFloat,Infinity,NaN,Intl,WeakMap,WeakSet,Symbol,BigInt,DataTransfer,CustomEvent,Event,KeyboardEvent,MouseEvent,TouchEvent,WheelEvent,PointerEvent,focus,blur,stopPropagation,preventDefault,toString,valueOf,hasOwnProperty,apply,call,bind,slice,splice,push,pop,shift,unshift,map,filter,reduce,forEach,find,findIndex,includes,indexOf,join,split,replace,replaceAll,trim,trimStart,trimEnd,toLowerCase,toUpperCase,charAt,charCodeAt,concat,entries,keys,values,from,assign,freeze,then,catch,finally,add,delete,open,close,match,test,exec,normalize,stringify,parse,min,max,abs,round,floor,ceil,sqrt,pow,random,hypot,log,log2,log10,sin,cos,tan,getElementById,querySelector,querySelectorAll,createElement,appendChild,removeChild,insertBefore,addEventListener,removeEventListener,setAttribute,removeAttribute,getBoundingClientRect,requestAnimationFrame,cancelAnimationFrame,createObjectURL,revokeObjectURL,writeText,readText,register,getItem,setItem,removeItem,clear,getRandomValues,digest,sign,verify,initializeApp,auth,firestore,collection,doc,get,set,update,onAuthStateChanged,signInWithEmailAndPassword,createUserWithEmailAndPassword,signOut,getIdToken,serverTimestamp,FieldValue,start,terminate,recognize,readAsDataURL,readAsText,click,remove,measureText,fillText,fillRect,strokeRect,drawImage,toDataURL,getContext,vibrate,share,canShare,download,print,scrollTo,replaceState,pushState,back,forward,go,reload,isNativePlatform,watch,postMessage,escape,unescape,btoa,atob,now,performance,defineProperty,getOwnPropertyDescriptor,prototype,constructor,length,index,name,message,code,status,ok,exists,data,text,src,href,value,type,id,classList,style,innerHTML,textContent,title,placeholder,checked,disabled,files,target,currentTarget,detail,key,code,button,buttons,clientX,clientY,pageX,pageY,screenX,screenY,touches,changedTouches,targetTouches,naturalWidth,naturalHeight,width,height,offsetWidth,offsetHeight,scrollTop,scrollLeft,origin,protocol,pathname,search,hash,hostname,port,host,uid,email,providerId,isAnonymous,metadata,refreshToken,tenantId,phoneNumber,photoURL,displayName,anonymous,apiKey,appName,authDomain,projectId,storageBucket,messagingSenderId,measurementId').split(','));

const calls = new Set();
for (const m of js.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) calls.add(m[1]);

const missing = [...calls].filter(f => !declared.has(f) && !builtins.has(f) && !/^[A-Z]/.test(f)).sort();
console.log('=== INTERNAL CALL SCAN (app.js) ===');
console.log('Unique function calls:', calls.size);
if (missing.length) {
  console.log('!!! POSSIBLY UNDEFINED:');
  missing.forEach(f => console.log('  -', f));
} else {
  console.log('✅ All internal function calls resolve to declared functions or builtins');
}

// CSS sanity
const css = fs.readFileSync('C:/Users/DELL/Desktop/Bills Manager testing/test 1/src/css/styles.css', 'utf8');
const openBraces = (css.match(/{/g) || []).length;
const closeBraces = (css.match(/}/g) || []).length;
console.log('');
console.log('=== CSS CHECK ===');
console.log('open { :', openBraces, '| close } :', closeBraces, openBraces === closeBraces ? '✅ balanced' : '!!! UNBALANCED');

// Check every class used in HTML has CSS (informational only)
const html = fs.readFileSync('C:/Users/DELL/Desktop/Bills Manager testing/test 1/index.html', 'utf8');
const usedClasses = new Set();
for (const m of html.matchAll(/class="([^"]+)"/g)) m[1].split(/\s+/).forEach(c => c && usedClasses.add(c));
const cssClasses = new Set();
for (const m of css.matchAll(/\.([A-Za-z_-][\w-]*)/g)) cssClasses.add(m[1]);
const noCss = [...usedClasses].filter(c => !cssClasses.has(c));
console.log('Classes used in HTML:', usedClasses.size, '| classes in CSS:', cssClasses.size);
if (noCss.length) console.log('Note: HTML classes without CSS rule (may be JS-only or fine):', noCss.join(', '));

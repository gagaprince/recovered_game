'use strict';
const vm = require('vm');
const parser = require('@babel/parser');

function _typeof(o) { return typeof o; }
function _regeneratorRuntime() {
  return {
    mark(fn) { return fn; },
    wrap(fn) { return function () { return { next: () => ({ value: undefined, done: true }) }; }; },
    await: v => v,
    async(fn) { return function () { try { return Promise.resolve(fn && fn.apply(this, arguments)); } catch (e) { return Promise.reject(e); } }; },
    isGeneratorFunction() { return false; },
    keys() { return {}; }
  };
}
const helpers = {
  typeof: _typeof,
  regeneratorRuntime: _regeneratorRuntime,
  defineProperty: (o, k, v) => { o[k] = v; return o; },
  createForOfIteratorHelper(o) {
    let i = 0; const arr = Array.from(o || []);
    return { s() { i = 0; }, n() { return { value: arr[i], done: i++ >= arr.length }; }, e() { }, f() { } };
  },
  unsupportedIterableToArray: () => [],
  toPrimitive: () => { },
  arrayLikeToArray(a, n) { if (n == null || n > a.length) n = a.length; const r = new Array(n); for (let i = 0; i < n; i++) r[i] = a[i]; return r; },
  Objectentries: e => Object.entries(e),
  Arrayincludes: Array.prototype.includes,
};
function customRequire(p) {
  for (const key of Object.keys(helpers)) if (p.includes(key)) return helpers[key];
  throw new Error('unexpected require ' + p);
}

function wxStub() {
  const noop = () => { };
  return {
    getSystemInfoSync() { return { platform: 'devtools', SDKVersion: '3.0.0', system: 'iOS 16', version: '8.0.0', pixelRatio: 3, screenWidth: 375, screenHeight: 812, windowWidth: 375, windowHeight: 812, safeArea: { top: 44, bottom: 778, left: 0, right: 375, width: 375, height: 734 }, brand: 'devtools', model: 'devtools' }; },
    getMenuButtonBoundingClientRect() { return { top: 44, left: 295, right: 365, bottom: 77, width: 70, height: 33 }; },
    onShow: noop, onHide: noop, onShareAppMessage: noop, onMemoryWarning: noop, onError: noop,
    onAudioInterruptionBegin: noop, onAudioInterruptionEnd: noop, onWindowResize: noop, offWindowResize: noop,
    getLaunchOptionsSync() { return { scene: 1001, query: {} }; },
    getUpdateManager() { return { onCheckForUpdate: noop, onUpdateReady: noop, onUpdateFailed: noop, applyUpdate: noop }; },
    createInnerAudioContext() { return { play: noop, pause: noop, stop: noop, destroy: noop, seek: noop, onCanplay: noop, onPlay: noop, onEnded: noop, onError: noop, offEnded: noop, volume: 1, loop: false, src: '', node: {} }; },
    getFileSystemManager() { return { readFileSync() { return ''; }, writeFileSync: noop, access: noop, mkdir: noop, unlink: noop, readdir() { return []; }, stat: noop, copyFileSync: noop, rmdir: noop }; },
    setStorage: noop, setStorageSync: noop, getStorageSync() { return ''; }, removeStorageSync: noop, getStorage: noop,
    login: noop, getUserInfo: noop,
    createCanvas() { return { getContext() { return {}; }, width: 0, height: 0 }; },
    createImage() { return {}; },
    env: { USER_DATA_PATH: '/tmp' },
    getOpenDataContext() { return { postMessage: noop, canvas: {} }; },
    request() { return { abort: noop }; },
    showShareMenu: noop, hideShareMenu: noop, showToast: noop, showModal: noop, vibrateShort: noop, vibrateLong: noop,
    setKeepScreenOn: noop, onShareTimelineMessage: noop, setUserCloudStorage: noop, getFriendCloudStorage: noop,
    createRewardedVideoAd() { return { load: noop, show: noop, onLoad: noop, onError: noop, onClose: noop, offClose: noop }; },
    createInterstitialAd() { return { load: noop, show: noop, onLoad: noop, onError: noop, onClose: noop }; },
    createBannerAd() { return { show: noop, destroy: noop, hide: noop, onError: noop, onLoad: noop, onResize: noop }; },
    navigateToMiniProgram: noop, setClipboardData: noop, getClipboardData: noop, triggerGC: noop,
    getPerformance() { return { now() { return Date.now(); } }; },
    base64ToArrayBuffer(s) { return Buffer.from(s, 'base64'); },
    arrayBufferToBase64(b) { return Buffer.from(b).toString('base64'); },
    reportEvent: noop, reportMonitor: noop, openCustomerServiceConversation: noop,
  };
}

// 收集混淆体外层 var 声明的变量名
function collectOuterVars(body) {
  try {
    const wrapped = 'function __wrap__(){' + body + '}';
    const ast = parser.parse(wrapped, { sourceType: 'script' });
    const fn = ast.program.body[0];
    const names = [];
    for (const stmt of fn.body.body) {
      if (stmt.type === 'VariableDeclaration' && stmt.kind === 'var') {
        for (const d of stmt.declarations) {
          if (d.id.type === 'Identifier') names.push(d.id.name);
        }
      }
    }
    return names;
  } catch (e) { return []; }
}

// 在 VM 中执行混淆体，hook System.register 拿到全部模块，并在末尾捕获运行时常量表
function runBody(body, { tableVar = 'to', valueVar = 'ro' } = {}) {
  const modules = [];
  const System = {
    register(name, deps, factory) {
      if (typeof name === 'string') modules.push({ name, deps, factory: factory && factory.toString() });
      return {};
    }
  };
  const sandbox = {
    require: customRequire, System, console,
    wx: wxStub(), setTimeout, setInterval, clearTimeout, clearInterval,
  };
  // 嵌套的 define（引擎 chunk）吞掉错误即可，业务模块靠 System.register 捕获
  sandbox.define = function (name, factory) {
    try { factory(customRequire, { exports: {} }, {}); } catch (e) { }
  };
  vm.createContext(sandbox);

  const outerVars = collectOuterVars(body);
  const capture = `
    ;(function(){
      var __caps = {};
      var __names = ${JSON.stringify(outerVars)};
      for (var __i = 0; __i < __names.length; __i++) {
        try {
          (function (v) {
            if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') __caps[this.__n] = v;
          }).call({__n: __names[__i]}, eval(__names[__i]));
        } catch (e) {}
      }
      this.__out = { caps: __caps };
      try { this.__out.table = typeof ${tableVar} !== 'undefined' ? ${tableVar} : null; } catch (e) {}
      try { this.__out.values = typeof ${valueVar} !== 'undefined' ? ${valueVar} : null; } catch (e) {}
    }).call(this);
  `;
  const runner = new Function(
    'require', 'System', 'define', 'wx', 'GameGlobal', 'window', 'global',
    'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'console',
    '"use strict";\n' + body + '\n' + capture
  );
  runner.call(sandbox,
    customRequire, System, sandbox.define, sandbox.wx,
    sandbox, sandbox, sandbox,
    setTimeout, setInterval, clearTimeout, clearInterval, console
  );
  const out = sandbox.__out || {};
  return { modules, caps: out.caps || {}, runtimeTable: out.table || null, runtimeValues: out.values || null };
}

module.exports = { runBody };

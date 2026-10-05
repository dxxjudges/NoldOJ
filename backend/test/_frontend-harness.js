/**
 * 前端纯逻辑模块的 Node 测试夹具（不属于测试文件，不注册进 scripts.test）
 *
 * 背景：frontend/js/*.js 是按 <script> 标签加载的传统脚本（顶层 function 声明 + 共享全局作用域），
 * 既非 ES module 也不能直接 require（顶层就访问 document/localStorage）。本夹具用
 * vm.runInContext 在沙箱里执行脚本源码，并提供**最小** DOM/localStorage 桩，
 * 从而在 Node 下直接调用 renderMarkdown / renderNav / showToast 等纯逻辑函数。
 *
 * 桩的边界（务必知悉，避免写出“测的是桩而非被测代码”的假测试）：
 *  - FakeElement 只实现被测函数真正触碰的成员（classList / textContent / innerHTML /
 *    style / 属性 / children），不做布局、不做 HTML 解析；
 *  - innerHTML 与 textContent 是两个独立字段，因此 showToast 用 textContent 落文本、
 *    renderPagination 用 innerHTML 落 HTML 的差异可被真实断言；
 *  - setTimeout / setInterval 为空实现（不派发回调），用于观察“已挂起但未触发”的中间态。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FRONTEND_JS = path.join(__dirname, '..', '..', 'frontend', 'js');

class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...names) { for (const n of names) if (n) this.set.add(n); }
  remove(...names) { for (const n of names) this.set.delete(n); }
  contains(name) { return this.set.has(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : Boolean(force);
    if (on) this.set.add(name); else this.set.delete(name);
    return on;
  }
  get length() { return this.set.size; }
  item(i) { return Array.from(this.set)[i] || null; }
  toString() { return Array.from(this.set).join(' '); }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.classList = new FakeClassList();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.dataset = {};
    this.attrs = {};
    this.listeners = {};
    this._textContent = '';
    this._innerHTML = '';
    this.className = '';
  }
  get id() { return this.attrs.id || ''; }
  set id(v) { this.attrs.id = String(v); }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; }
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name); }
  removeAttribute(name) { delete this.attrs[name]; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  removeEventListener() {}
  get textContent() { return this._textContent; }
  set textContent(v) { this._textContent = String(v); }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) { this._innerHTML = String(v); }
}

/** 递归收集元素（含自身）上所有文本节点内容，便于断言 showToast 之类的文本渲染 */
function textOf(node) {
  if (!node) return '';
  let s = node._textContent || '';
  for (const c of node.children) s += textOf(c);
  return s;
}

/** 深拷贝式查找 id（showToast 会新建元素并挂到 body 上，需要按 id 回查） */
function findById(root, id) {
  if (root.attrs && root.attrs.id === id) return root;
  for (const c of root.children) {
    const hit = findById(c, id);
    if (hit) return hit;
  }
  return null;
}

/**
 * 创建最小 DOM 桩。
 * @param {object} opts
 * @param {Record<string, FakeElement>} opts.elements 预先注册到 getElementById 的元素
 * @param {Record<string,string>} opts.storage      localStorage 初始内容
 * @param {boolean} opts.dark                      documentElement 是否带 dark 类
 */
function createFakeDom(opts = {}) {
  const byId = new Map();
  const storage = new Map(Object.entries(opts.storage || {}));
  const timers = { timeout: 0, interval: 0 };

  const documentElement = new FakeElement('html');
  if (opts.dark) documentElement.classList.add('dark');

  const head = new FakeElement('head');
  const body = new FakeElement('body');
  for (const el of Object.values(opts.elements || {})) {
    if (el.attrs.id) byId.set(el.attrs.id, el);
    body.appendChild(el);
  }

  const document = {
    documentElement,
    head,
    body,
    readyState: 'complete',
    createElement(tag) { return new FakeElement(tag); },
    createTextNode(t) { return { nodeType: 3, textContent: String(t) }; },
    getElementById(id) { return byId.get(id) || null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
  };

  const localStorage = {
    getItem(k) { return storage.has(String(k)) ? storage.get(String(k)) : null; },
    setItem(k, v) { storage.set(String(k), String(v)); },
    removeItem(k) { storage.delete(String(k)); },
    clear() { storage.clear(); },
    get length() { return storage.size; },
    key(i) { return Array.from(storage.keys())[i] ?? null; },
  };

  return { document, localStorage, timers, FakeElement, textOf, findById };
}

/**
 * 在 vm 沙箱里加载 frontend/js/<file>，返回该脚本声明的全部顶层符号。
 * 顶层会执行：api.js 的深色模式 IIFE（读 localStorage/document）、30s 轮询 setInterval、
 * 未读公告计数 localStorage 读取 —— 均由桩吸收。
 */
function loadScript(file, opts = {}) {
  const dom = createFakeDom(opts);
  const sandbox = {
    document: dom.document,
    localStorage: dom.localStorage,
    // 空实现：不真正调度定时器（api.js 顶层的 30s 轮询/showToast 的 4s 消失动画）
    setInterval: () => { dom.timers.interval++; return dom.timers.interval; },
    clearInterval: () => {},
    setTimeout: () => { dom.timers.timeout++; return dom.timers.timeout; },
    clearTimeout: () => {},
    console: { log() {}, warn() {}, error() {} },
    Event: function Event(type) { this.type = type; },
    MutationObserver: undefined,
    // window 不是 jsdom 全局，只提供 api.js 真正读写的成员：
    // location（requireAuth/clearToken 跳转、refreshUser 推导当前页）与 atob（isTokenExpired 解 JWT）
    window: Object.assign(
      { location: { pathname: '/pages/index.html', href: '' }, addEventListener() {}, removeEventListener() {} },
      opts.window || {}
    ),
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
  };
  Object.assign(sandbox, opts.globals || {});

  const src = fs.readFileSync(path.join(FRONTEND_JS, file), 'utf8');
  const ctx = vm.createContext(sandbox);
  vm.runInContext(src, ctx, { filename: file });
  return Object.assign(ctx, { __dom: dom, window: sandbox.window });
}

/**
 * 加载 markdown.js。文件末尾的 echarts/mermaid 增强器 IIFE 在 Node 下走
 * `typeof window === 'undefined' && typeof document === 'undefined'` 分支直接 return，
 * 因此无需 DOM 桩即可安全求值，只取顶层 renderMarkdown。
 * @param {object|null} domPurify 注入 DOMPurify；传 null 走“无 DOMPurify → fail-closed”分支
 */
function loadMarkdown(domPurify) {
  const sandbox = { console: { log() {}, warn() {}, error() {} } };
  if (domPurify) sandbox.DOMPurify = domPurify;
  const src = fs.readFileSync(path.join(FRONTEND_JS, 'markdown.js'), 'utf8');
  const ctx = vm.createContext(sandbox);
  vm.runInContext(src, ctx, { filename: 'markdown.js' });
  return ctx.renderMarkdown;
}

module.exports = {
  FRONTEND_JS,
  FakeClassList,
  FakeElement,
  createFakeDom,
  loadScript,
  loadMarkdown,
  textOf,
  findById,
};
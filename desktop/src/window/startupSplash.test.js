import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStartupSplashHtml,
  closeStartupSplashWindow,
  createStartupSplashWindow,
  focusStartupSplashWindow,
} from "./startupSplash.js";

class FakeWebContents {
  constructor(owner) {
    this.owner = owner;
    this.onceHandlers = new Map();
  }

  once(event, handler) {
    this.onceHandlers.set(event, handler);
  }

  emit(event) {
    this.onceHandlers.get(event)?.();
    this.onceHandlers.delete(event);
  }
}

class FakeBrowserWindow {
  static instances = [];

  constructor(options) {
    this.options = options;
    this.visible = false;
    this.destroyed = false;
    this.focusCount = 0;
    this.webContents = new FakeWebContents(this);
    this.onceHandlers = new Map();
    FakeBrowserWindow.instances.push(this);
  }

  once(event, handler) {
    this.onceHandlers.set(event, handler);
  }

  emit(event) {
    this.onceHandlers.get(event)?.();
    this.onceHandlers.delete(event);
  }

  loadURL(url) {
    this.url = url;
    return Promise.resolve();
  }

  isVisible() {
    return this.visible;
  }

  isDestroyed() {
    return this.destroyed;
  }

  show() {
    this.visible = true;
  }

  focus() {
    this.focusCount += 1;
  }

  close() {
    this.destroyed = true;
  }
}

test("startup splash is a small frameless no-console visual surface", () => {
  FakeBrowserWindow.instances.length = 0;
  const splash = createStartupSplashWindow({
    BrowserWindow: FakeBrowserWindow,
    title: "旺崽助手",
  });

  assert.equal(splash.options.frame, false);
  assert.equal(splash.options.show, false);
  assert.equal(splash.options.skipTaskbar, true);
  assert.equal(splash.options.width, 430);
  assert.match(splash.url, /^data:text\/html;charset=utf-8,/);

  splash.emit("ready-to-show");
  assert.equal(splash.isVisible(), true);
  assert.equal(splash.focusCount, 1);
});

test("repeat launch can focus the splash while the main runtime starts", () => {
  const splash = new FakeBrowserWindow({});
  assert.equal(focusStartupSplashWindow(splash), true);
  assert.equal(splash.isVisible(), true);
  assert.equal(splash.focusCount, 1);
  assert.equal(closeStartupSplashWindow(splash), true);
  assert.equal(splash.isDestroyed(), true);
  assert.equal(focusStartupSplashWindow(splash), false);
});

test("splash html exposes branded startup feedback without scripts", () => {
  const html = buildStartupSplashHtml({ title: "旺崽助手", message: "正在启动工作台" });
  assert.match(html, /旺崽助手/u);
  assert.match(html, /正在启动工作台/u);
  assert.match(html, /Content-Security-Policy/u);
  assert.doesNotMatch(html, /<script/iu);
});

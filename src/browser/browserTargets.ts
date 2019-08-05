// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Cdp from '../cdp/api';
import CdpConnection from '../cdp/connection';
import { debug } from 'debug';
import * as path from 'path';
import * as vscode from 'vscode';
import { URL } from 'url';
import { Thread, ThreadManager } from '../adapter/threads';
import { FrameModel } from './frames';
import { ServiceWorkerModel } from './serviceWorkers';
import { SourcePathResolver, InlineScriptOffset } from '../adapter/sources';
import { Target } from '../adapter/targets';

const debugTarget = debug('target');

export type PauseOnExceptionsState = 'none' | 'uncaught' | 'all';

export class BrowserTargetManager implements vscode.Disposable {
  private _connection: CdpConnection;
  private _targets: Map<Cdp.Target.TargetID, BrowserTarget> = new Map();
  private _browser: Cdp.Api;
  readonly frameModel = new FrameModel();
  readonly serviceWorkerModel = new ServiceWorkerModel(this.frameModel);
  _threadManager: ThreadManager;
  _sourcePathResolver: SourcePathResolver;

  private _onTargetAddedEmitter = new vscode.EventEmitter<BrowserTarget>();
  private _onTargetRemovedEmitter = new vscode.EventEmitter<BrowserTarget>();
  readonly onTargetAdded = this._onTargetAddedEmitter.event;
  readonly onTargetRemoved = this._onTargetRemovedEmitter.event;

  constructor(threadManager: ThreadManager, connection: CdpConnection, browserSession: Cdp.Api, sourcePathResolver: SourcePathResolver) {
    this._connection = connection;
    this._threadManager = threadManager;
    this._sourcePathResolver = sourcePathResolver;
    this._browser = browserSession;
    this._browser.Target.on('targetInfoChanged', event => {
      this._targetInfoChanged(event.targetInfo);
    });
  }

  dispose() {
    this.serviceWorkerModel.dispose();
  }

  targets(): BrowserTarget[] {
    return Array.from(this._targets.values());
  }

  targetForest(): Target[] {
    return Array.from(this._targets.values()).filter(t => !t.parentTarget);
  }

  waitForMainTarget(): Promise<BrowserTarget | undefined> {
    let callback: (result: BrowserTarget | undefined) => void;
    const promise = new Promise<BrowserTarget | undefined>(f => callback = f);
    this._browser.Target.setDiscoverTargets({ discover: true });
    this._browser.Target.on('targetCreated', async event => {
      if (this._targets.size)
        return;
      const targetInfo = event.targetInfo;
      if (targetInfo.type !== 'page')
        return;
      const response = await this._browser.Target.attachToTarget({ targetId: targetInfo.targetId, flatten: true });
      if (!response) {
        callback(undefined);
        return;
      }
      callback(this._attachedToTarget(targetInfo, response.sessionId, false));
    });
    this._browser.Target.on('detachedFromTarget', event => {
      this._detachedFromTarget(event.targetId!);
    });
    return promise;
  }

  _attachedToTarget(targetInfo: Cdp.Target.TargetInfo, sessionId: Cdp.Target.SessionID, waitingForDebugger: boolean, parentTarget?: BrowserTarget): BrowserTarget {
    debugTarget(`Attaching to target ${targetInfo.targetId}`);

    const cdp = this._connection.createSession(sessionId);
    const target = new BrowserTarget(this, targetInfo, cdp, parentTarget, target => {
      this._connection.disposeSession(sessionId);
    });
    this._targets.set(targetInfo.targetId, target);
    if (parentTarget)
      parentTarget._children.set(targetInfo.targetId, target);

    cdp.Target.on('attachedToTarget', async event => {
      this._attachedToTarget(event.targetInfo, event.sessionId, event.waitingForDebugger, target);
    });
    cdp.Target.on('detachedFromTarget', async event => {
      this._detachedFromTarget(event.targetId!);
    });
    cdp.Target.setAutoAttach({ autoAttach: true, waitForDebuggerOnStart: true, flatten: true });

    if (target._thread)
      target._thread.initialize();

    if (domDebuggerTypes.has(targetInfo.type))
      this.frameModel.attached(cdp, targetInfo.targetId);
    this.serviceWorkerModel.attached(cdp);

    if (waitingForDebugger)
      cdp.Runtime.runIfWaitingForDebugger({});
    this._onTargetAddedEmitter.fire(target);
    debugTarget(`Attached to target ${targetInfo.targetId}`);
    return target;
  }

  _detachedFromTarget(targetId: string) {
    const target = this._targets.get(targetId);
    if (!target)
      return;
    debugTarget(`Detaching from target ${targetId}`);

    for (const childTargetId of target._children.keys())
      this._detachedFromTarget(childTargetId);
    target._detached();

    this._targets.delete(targetId);
    if (target.parentTarget)
      target.parentTarget._children.delete(targetId);

    this._onTargetRemovedEmitter.fire(target);
    debugTarget(`Detached from target ${targetId}`);
    if (!this._targets.size)
      this._browser.Browser.close({});
  }

  _targetInfoChanged(targetInfo: Cdp.Target.TargetInfo) {
    const target = this._targets.get(targetInfo.targetId);
    if (!target)
      return;
    target._updateFromInfo(targetInfo);
  }
}

const jsTypes = new Set(['page', 'iframe', 'worker']);
const domDebuggerTypes = new Set(['page', 'iframe']);

export class BrowserTarget implements Target {
  readonly parentTarget?: BrowserTarget;

  private _manager: BrowserTargetManager;
  private _cdp: Cdp.Api;
  _thread: Thread | undefined;
  _targetInfo: Cdp.Target.TargetInfo;
  private _ondispose: (t: BrowserTarget) => void;

  _children: Map<Cdp.Target.TargetID, BrowserTarget> = new Map();

  constructor(targetManager: BrowserTargetManager, targetInfo: Cdp.Target.TargetInfo, cdp: Cdp.Api, parentTarget: BrowserTarget | undefined, ondispose: (t: BrowserTarget) => void) {
    this._cdp = cdp;
    this._manager = targetManager;
    this.parentTarget = parentTarget;
    if (jsTypes.has(targetInfo.type))
      this._thread = targetManager._threadManager.createThread(targetInfo.targetId, cdp, this);
    this._targetInfo = targetInfo;
    this._updateFromInfo(targetInfo);
    this._ondispose = ondispose;
  }

  id(): string {
      return this._targetInfo.targetId;
       }

  cdp(): Cdp.Api {
    return this._cdp;
  }

  thread(): Thread | undefined {
    return this._thread;
  }

  name(): string {
    return this._computeName();
  }

  fileName(): string | undefined {
    return this._targetInfo.url;
  }

  type(): string {
    return this._targetInfo.type;
  }

  children(): Target[] {
    const result: Target[] = [];
    for (const target of this._children.values()) {
      if (target.type() === 'service_worker')
        result.push(...target.children());
      else
        result.push(target);
    }
    return result;
  }

  canStop(): boolean {
    return this.isServiceWorkerWorker();
  }

  stop() {
    // Stop both dedicated and parent service worker scopes for present and future browsers.
    this._manager.serviceWorkerModel.stopWorker(this.id());
    if (!this.parentTarget)
      return;
    this._manager.serviceWorkerModel.stopWorker(this.parentTarget.id());
  }

  canRestart() {
    return this._targetInfo.type === 'page';
  }

  restart() {
    this._cdp.Page.reload({});
  }

  waitingForDebugger() {
    return true;
  }

  canAttach(): boolean {
    return jsTypes.has(this._targetInfo.type);
  }

  async attach(): Promise<Cdp.Api> {
    return Promise.resolve(this._cdp);
  }

  async detach(): Promise<void> {
  }

  executionContextName(description: Cdp.Runtime.ExecutionContextDescription): string {
    const auxData = description.auxData;
    const contextName = description.name;
    if (!auxData)
      return contextName;
    const frameId = auxData['frameId'];
    const frame = frameId ? this._manager.frameModel.frameForId(frameId) : undefined;
    if (frame && auxData['isDefault'] && !frame.parentFrame())
      return 'top';
    if (frame && auxData['isDefault'])
      return frame.displayName();
    if (frame)
      return `${contextName}`;
    return contextName;
  }

  supportsCustomBreakpoints(): boolean {
    return domDebuggerTypes.has(this._targetInfo.type);
  }

  sourcePathResolver(): SourcePathResolver {
    return this._manager._sourcePathResolver;
  }

  defaultScriptOffset(): InlineScriptOffset | undefined {
    return undefined;
  }

  isServiceWorkerWorker(): boolean {
    return this._targetInfo.type === 'worker' && !!this.parentTarget && this.parentTarget._targetInfo.type === 'service_worker';
  }

  _updateFromInfo(targetInfo: Cdp.Target.TargetInfo) {
    this._targetInfo = targetInfo;
    if (this._thread) {
      this._thread.setName(this._computeName());
      this._thread.setBaseUrl(this._targetInfo.url);
    }
  }

  _computeName(): string {
    if (this.isServiceWorkerWorker()) {
      const version = this._manager.serviceWorkerModel.version(this.parentTarget!.id());
      if (version)
        return version.label();
    }

    let threadName = '';
    try {
      const parsedURL = new URL(this._targetInfo.url);
      if (parsedURL.pathname === '/')
        threadName += parsedURL.host;
      else if (parsedURL.protocol === 'data:')
        threadName = '<data>';
      else
        threadName += parsedURL ? path.basename(parsedURL.pathname) + (parsedURL.hash ? parsedURL.hash : '') : this._targetInfo.title;
    } catch (e) {
      threadName += this._targetInfo.url;
    }
    return threadName;
  }

  _detached() {
    if (this._thread)
      this._thread.dispose();
    this._manager.serviceWorkerModel.detached(this._cdp);
    this._ondispose(this);
  }

  _dumpTarget(indent: string | undefined = '') {
    debugTarget(`${indent}${this._targetInfo.type} - ${this._targetInfo.url}`);
    for (const child of this._children.values())
      child._dumpTarget(indent + '  ');
  }
}

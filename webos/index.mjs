/** Trusted same-origin DeckCraft view. Account files remain owned by Storage. */
import {createFileSession} from './account-files.mjs';

const identity = value => typeof value === 'string' && /^[0-9]{1,20}$/.test(value);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no}); promise.catch(() => {}); return {promise, resolve, reject}; };

export function mount({instanceId, sessionId, resource = null, files, authority, authorize, displayName = '', url, signal: parentSignal}) {
  if (authority === undefined || authority === null) throw Error('The view requires explicit human authority.');
  const source = new URL(url, location.href);
  if (source.origin !== location.origin) throw Error('DeckCraft requires trusted same-origin hosting.');
  const initialResource = resource ? Object.freeze({path: resource.path, sha256: resource.sha256}) : null;
  source.searchParams.set('host', 'parent'); source.searchParams.set('blank', ''); source.searchParams.set('author', displayName);
  const element = document.createElement('div'), frame = document.createElement('iframe'), status = document.createElement('div');
  element.className = 'webos-deckcraft'; element.style.cssText = 'display:flex;flex-direction:column;width:100%;height:100%;min-height:0';
  frame.title = 'DeckCraft presentation'; frame.style.cssText = 'flex:1;width:100%;min-height:0;border:0'; frame.allow = 'clipboard-read; clipboard-write';
  // The native startup blank must not accept user input while an account file is loading.
  frame.inert = true;
  status.setAttribute('role', 'status'); element.append(frame, status);
  const abort = new AbortController(), fileSession = createFileSession({instanceId, sessionId, files, authorize, signal: abort.signal});
  const startupResult = deferred(), opens = new Map(), completions = new Map();
  let phase = 'loading', disposed = false, initializing = false, nextOpen = 1, dirty = false, closeDialog = null;
  const check = () => { if (disposed || abort.signal.aborted) throw new DOMException('DeckCraft view closed.', 'AbortError'); files.check(); };
  const api = () => { check(); const value = frame.contentWindow?.deckcraft; if (typeof value?.request !== 'function') throw Error('DeckCraft command interface unavailable.'); return value; };
  const post = (type, fields = {}, transfer = []) => { check(); frame.contentWindow.postMessage({type: 'deckcraft:' + type, ...fields}, location.origin, transfer); };
  const startup = setTimeout(() => failStartup(Error('DeckCraft startup timed out.')), 120000);
  function failStartup(error) {
    if (disposed || phase === 'failed') return;
    phase = 'failed'; status.textContent = error.message; clearTimeout(startup); startupResult.reject(error);
    for (const entry of opens.values()) { clearTimeout(entry.timer); entry.reject(error); } opens.clear();
    abort.abort(); fileSession.dispose(); frame.src = 'about:blank'; frame.remove();
  }
  async function inspectNative() {
    const state = await api().request('ui.inspect', {}); check();
    if (state?.documentTargeting !== 'active-precondition-v1' || !Array.isArray(state.documents) || !state.pendingSaves || typeof state.pendingSaves !== 'object') throw Error('DeckCraft document/save inspection contract unavailable.');
    dirty = state.documents.some(document => document.dirty === true);
    return state;
  }
  function adopt(name, bytes) {
    check();
    if (opens.size >= 8) throw Error('Too many file opens are pending.');
    const id = 'webos-open-' + nextOpen++, entry = deferred(), buffer = bytes.slice().buffer;
    entry.timer = setTimeout(() => { opens.delete(id); entry.reject(Error('File adoption result timed out; no account binding was installed.')); }, 120000);
    opens.set(id, entry);
    try { post('open', {id, name, bytes: buffer}, [buffer]); }
    catch (error) { opens.delete(id); clearTimeout(entry.timer); entry.reject(error); }
    return entry.promise;
  }
  async function initialize(data) {
    if (initializing || disposed || phase !== 'loading') return; initializing = true;
    try {
      if (data.openResult !== true) throw Error('DeckCraft does not advertise correlated file adoption.');
      post('host', {version: '1'});
      await inspectNative();
      if (initialResource) await fileSession.open(initialResource, authority, adopt);
      check();
      const native = await inspectNative();
      await api().request('engine.execute', {documentId: native.documentId, command: 'app.backstage', params: {on: false}}); check();
      phase = 'ready'; frame.inert = false; clearTimeout(startup); status.textContent = initialResource ? 'Opened account file: ' + initialResource.path : 'New presentation; not saved to your account.';
      startupResult.resolve();
    } catch (error) { failStartup(error); }
  }
  function completion(id) {
    if (!completions.has(id)) {
      // Settled receipts cover the event/command-reply race without growing for the view's lifetime.
      if (completions.size >= 64) for (const [key, item] of completions) { if (item.settled) {completions.delete(key); break;} }
      if (completions.size >= 64) throw Error('Too many save completions are pending.');
      completions.set(id, deferred());
    }
    return completions.get(id);
  }
  async function save(data) {
    if (typeof data.id !== 'string' || !/^deckcraft-save-[0-9]{1,20}-[0-9]+$/.test(data.id)) { status.textContent = 'Export is not connected to account storage; use an identified document save.'; return; }
    const done = completion(data.id); if (done.started) return; done.started = true;
    try {
      if (phase !== 'ready') throw Error('Wait for the account file to finish opening before saving.');
      const result = await fileSession.save(data, authority); check();
      post('saved', {id: result.id}); status.textContent = 'Saved to your account: ' + result.path;
      done.resolve(result);
    } catch (error) {
      const outcome = error.outcome === 'unknown' ? 'unknown' : error.status === 409 ? 'conflict' : error.name === 'AbortError' ? 'cancelled' : 'failed';
      if (!disposed && !abort.signal.aborted) {
        status.textContent = error.message + (outcome === 'unknown' ? ' Check the account file before retrying; the server outcome is unknown.' : '');
        try { post('save-failed', {id: data.id, outcome, error: status.textContent}); } catch { /* A detached view cannot receive an acknowledgement. */ }
      }
      done.reject(error);
    } finally { done.settled = true; }
  }
  function message(event) {
    if (disposed || abort.signal.aborted || event.origin !== location.origin || event.source !== frame.contentWindow || !event.data || typeof event.data !== 'object') return;
    const data = event.data;
    if (data.type === 'deckcraft:ready') { void initialize(data); return; }
    if (data.type === 'deckcraft:opened' || (data.type === 'deckcraft:failed' && opens.has(data.id))) {
      const entry = opens.get(data.id); if (!entry) return; opens.delete(data.id); clearTimeout(entry.timer);
      if (data.type === 'deckcraft:opened') entry.resolve({documentId: data.documentId, revision: data.revision, sourceRetained: data.sourceRetained});
      else entry.reject(Error(String(data.error || 'Presentation could not be opened.')));
      return;
    }
    if (data.type === 'deckcraft:save') { void save(data).catch(error => {status.textContent = error.message;}); return; }
    if (data.type === 'deckcraft:dirty') dirty = data.dirty === true;
    if (data.type === 'deckcraft:failed' && phase === 'loading') failStartup(Error(String(data.error || 'DeckCraft startup failed.')));
  }
  window.addEventListener('message', message, {signal: abort.signal});
  async function execute(request, caller) {
    check();
    if (caller === undefined || caller === null) throw Error('Explicit caller authorization required.');
    // Native callbacks currently identify documents but not invoking principals.
    // Do not let a delegated save inherit the human grant retained for native UI controls.
    if (caller !== authority) throw Error('Delegated command transport is not connected for this view.');
    const encoded = JSON.stringify(request);
    if (typeof encoded !== 'string' || encoded.length > 65536) throw Error('Invalid bounded command request.');
    const captured = JSON.parse(encoded);
    await startupResult.promise; check();
    if (!captured || captured.instanceId !== instanceId || captured.sessionId !== sessionId || !identity(captured.documentId) || typeof captured.command !== 'string') throw Error('Exact instance, session and native document target required.');
    const binding = fileSession.inspect().bindings.find(item => item.documentId === captured.documentId), resourceId = binding?.path || 'draft:' + captured.documentId;
    if (captured.resourceId !== resourceId || await authorize(caller, {instanceId, sessionId, documentId: captured.documentId, resourceId, operation: captured.command}) !== true) throw Error('Document operation denied.');
    check();
    if ((fileSession.inspect().bindings.find(item => item.documentId === captured.documentId)?.path || 'draft:' + captured.documentId) !== resourceId) throw Error('Account resource changed during authorization.');
    // File adoption is binary/correlated above. Path-based native saves bypass the host contract.
    if (captured.command.startsWith('file.') && !['file.save', 'file.new'].includes(captured.command)) throw Error('Use the native File controls for this operation.');
    if (captured.command === 'file.save' && captured.args && Object.keys(captured.args).length) throw Error('Hosted Save accepts no native path or serialization overrides.');
    const result = await api().request(captured.command === 'document.inspect' ? 'document.inspect' : 'engine.execute', {documentId: captured.documentId, command: captured.command, params: captured.args || {}}); check();
    if (result?.pending === 'save') return completion(result.id).promise;
    return result;
  }
  function askClose() {
    const dialog = document.createElement('dialog'); closeDialog = dialog;
    const heading = document.createElement('h2'); heading.textContent = 'Save changes before closing DeckCraft?'; dialog.append(heading);
    return new Promise(resolve => {
      const finish = choice => {if (closeDialog !== dialog) return; closeDialog = null; abort.signal.removeEventListener('abort', cancelled); dialog.close(); dialog.remove(); resolve(choice);};
      const cancelled = () => finish('cancel'); abort.signal.addEventListener('abort', cancelled, {once: true});
      for (const [choice, label] of [['save', 'Save'], ['discard', 'Discard changes'], ['cancel', 'Cancel']]) {const button = document.createElement('button'); button.textContent = label; button.addEventListener('click', () => finish(choice)); dialog.append(button);}
      dialog.addEventListener('cancel', event => {event.preventDefault(); finish('cancel');}); document.body.append(dialog); dialog.showModal(); dialog.lastElementChild.focus();
    });
  }
  async function requestClose() {
    if (disposed) return true;
    if (fileSession.inspect().pending.length) {status.textContent = 'Resolve the pending or uncertain account save before closing.'; return false;}
    if (phase !== 'ready') return true;
    const before = await inspectNative();
    if (Object.keys(before.pendingSaves).length) {status.textContent = 'Wait for the current save result before closing.'; return false;}
    if (!before.documents.some(item => item.dirty)) return true;
    const choice = await askClose(); check();
    if (choice === 'cancel') return false;
    const after = await inspectNative();
    if (JSON.stringify(after.documents) !== JSON.stringify(before.documents) || Object.keys(after.pendingSaves).length) {status.textContent = 'Presentations changed while confirming; review them before closing.'; return false;}
    if (choice === 'discard') return true;
    if (after.documents.some(item => item.dirty && item.documentId !== after.documentId)) {status.textContent = 'Save the other unsaved presentations in DeckCraft before closing this view.'; return false;}
    try {
      const documentId = after.documentId, binding = fileSession.inspect().bindings.find(item => item.documentId === documentId);
      await execute({instanceId, sessionId, documentId, resourceId: binding?.path || 'draft:' + documentId, command: 'file.save'}, authority);
      // The acknowledgement enters the native inbox; inspect only after its frame has applied it.
      await new Promise(resolve => frame.contentWindow.requestAnimationFrame(() => frame.contentWindow.requestAnimationFrame(resolve))); check();
      const saved = await inspectNative();
      return !saved.documents.some(item => item.dirty) && !Object.keys(saved.pendingSaves).length;
    } catch (error) {if (!disposed) status.textContent = 'The presentation stays open: ' + error.message; return false;}
  }
  function dispose() {
    if (disposed) return; disposed = true; phase = 'disposed'; clearTimeout(startup); parentSignal?.removeEventListener('abort', dispose);
    const error = new DOMException('DeckCraft view closed; verify pending account writes before retrying.', 'AbortError');
    startupResult.reject(error); for (const entry of opens.values()) {clearTimeout(entry.timer); entry.reject(error);} opens.clear();
    for (const entry of completions.values()) entry.reject(error);
    abort.abort(); fileSession.dispose(); frame.src = 'about:blank'; frame.remove(); element.remove();
  }
  if (parentSignal?.aborted) dispose(); else parentSignal?.addEventListener('abort', dispose, {once: true});
  if (!disposed) frame.src = source.href;
  return Object.freeze({element, dispose, ready: startupResult.promise, execute, requestClose,
    async inspect() { const native = phase === 'ready' && !disposed ? await inspectNative() : null; return {instanceId, sessionId, phase, disposed, dirty, native, accountFiles: fileSession.inspect()}; },
  });
}

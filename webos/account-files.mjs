/** Account resource bindings, not editor state. Callers supply authority on every operation. */
const SHA = /^[0-9a-f]{64}$/;
const MAX_FILE = 128 * 1024 * 1024; // UserFiles' per-file transport limit, not an app inventory limit.
const opaque = value => typeof value === 'string' && value.length > 0 && [...value].length <= 128 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const nameValid = value => typeof value === 'string' && value.length > 0 && value.length <= 255 && !value.startsWith('.') && !/[\/\\\u0000-\u001f\u007f]/u.test(value);
const pathValid = value => typeof value === 'string' && value.length <= 4096 && value.split('/').every(nameValid);
const requireThat = (value, message) => { if (!value) throw Error(message); };

export function createFileSession({instanceId, sessionId, files, authorize, signal, directory = 'Documents'}) {
  requireThat(opaque(instanceId) && opaque(sessionId) && files && typeof files.check === 'function' && typeof files.read === 'function' && typeof files.write === 'function' && typeof authorize === 'function', 'Explicit instance/session, Storage and authorization required.');
  requireThat(directory === '' || pathValid(directory), 'Invalid default directory.');
  const bindings = new Map(), pending = new Map();
  let disposed = false;
  const check = () => {
    if (disposed || signal?.aborted) throw new DOMException('Account file session closed.', 'AbortError');
    files.check();
  };
  const resourceOf = id => bindings.get(id)?.path || 'draft:' + id;
  async function allowed(authority, request) {
    check();
    requireThat(authority !== undefined && authority !== null, 'Explicit caller authorization required.');
    requireThat(await authorize(authority, Object.freeze({instanceId, sessionId, ...request})) === true, 'Account file operation denied.');
    check();
  }
  async function open(resource, authority, adopt) {
    // Capture caller-owned metadata before authorization/read can yield.
    const path = resource?.path, sha256 = resource?.sha256;
    requireThat(pathValid(path) && SHA.test(sha256 || '') && typeof adopt === 'function', 'Exact account resource and saved revision required.');
    await allowed(authority, {operation: 'file.open', resourceId: path, expectedRevision: sha256});
    const opened = await files.read(path); check();
    requireThat(opened?.sha256 === sha256 && opened.data instanceof Uint8Array && opened.data.byteLength <= MAX_FILE, 'Account file changed before opening; refresh Files.');
    // adopt must resolve the correlated native open result, never active-document inspection.
    const outcome = await adopt(path.split('/').at(-1), opened.data); check();
    requireThat(opaque(outcome?.documentId) && opaque(outcome?.revision) && typeof outcome.sourceRetained === 'boolean', 'Invalid native adoption result.');
    requireThat(!bindings.has(outcome.documentId), 'Native adoption reused an existing account binding.');
    if (outcome.sourceRetained) bindings.set(outcome.documentId, Object.freeze({path, sha256}));
    return Object.freeze({documentId: outcome.documentId, revision: outcome.revision, resourceId: resourceOf(outcome.documentId), sourceRetained: outcome.sourceRetained});
  }
  async function save(message, authority) {
    check();
    const {id, documentId, revision, name, operation, documentSave, saveAs} = message || {};
    requireThat(opaque(id) && opaque(documentId) && opaque(revision) && nameValid(name) && documentSave === true && typeof saveAs === 'boolean' && operation === (saveAs ? 'file.saveAs' : 'file.save'), 'An identified native document save is required; exports are separate.');
    requireThat(message.bytes instanceof ArrayBuffer && message.bytes.byteLength <= MAX_FILE, 'Invalid document bytes.');
    // Blob captures the mutable transferred buffer before any await.
    const snapshot = new Blob([message.bytes]), original = bindings.get(documentId);
    requireThat(!pending.has(documentId), 'A save is pending or its outcome is unknown; inspect before retrying.');
    requireThat(!original || saveAs || original.path.split('/').at(-1) === name, 'Save name differs from the account source; use Save As.');
    const sameSource = !saveAs && original && original.path.split('/').at(-1) === name;
    const parent = original ? original.path.split('/').slice(0, -1).join('/') : directory;
    const destination = sameSource ? original.path : (parent ? parent + '/' : '') + name;
    const expected = sameSource ? original.sha256 : null;
    const intent = {id, documentId, revision, path: destination, state: 'authorizing'};
    pending.set(documentId, intent);
    let dispatched = false, writeReturned = false;
    try {
      await allowed(authority, {documentId, operation, resourceId: destination, sourceResourceId: original?.path || 'draft:' + documentId, expectedRevision: expected});
      requireThat(bindings.get(documentId) === original, 'Account resource changed during authorization.');
      intent.state = 'pending'; dispatched = true;
      const saved = await files.write(destination, snapshot, expected, {signal});
      writeReturned = true;
      check();
      requireThat(SHA.test(saved?.sha256 || ''), 'Invalid durable server confirmation.');
      bindings.set(documentId, Object.freeze({path: destination, sha256: saved.sha256}));
      pending.delete(documentId);
      return Object.freeze({id, documentId, revision, path: destination, sha256: saved.sha256, committed: true});
    } catch (error) {
      // Storage identifies dispatch uncertainty. A late/invalid confirmation also cannot prove failure.
      const unknown = error.outcome === 'unknown' || (dispatched && (disposed || signal?.aborted || writeReturned));
      if (unknown) { intent.state = 'unknown'; error.outcome = 'unknown'; }
      else pending.delete(documentId);
      throw error;
    }
  }
  return Object.freeze({
    open, save,
    inspect() { return {instanceId, sessionId, disposed, bindings: [...bindings].map(([documentId, binding]) => ({documentId, ...binding})), pending: [...pending.values()].map(value => ({...value}))}; },
    dispose() { disposed = true; bindings.clear(); },
  });
}

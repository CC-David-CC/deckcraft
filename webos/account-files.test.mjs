import test from 'node:test';
import assert from 'node:assert/strict';
import {createFileSession} from './account-files.mjs';

const sha = 'a'.repeat(64), nextSha = 'b'.repeat(64), human = Object.freeze({}), agent = Object.freeze({});
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no}); return {promise, resolve, reject}; };
const request = (fields = {}) => ({id: 'save-1', documentId: 'doc-A', revision: '4', name: 'A.deckcraft', operation: 'file.save', documentSave: true, saveAs: false, bytes: Uint8Array.of(1, 2, 3).buffer, ...fields});
function fixture(options = {}) {
  const calls = [], auth = [];
  const files = {check() {}, async read(path) {calls.push(['read', path]); return {sha256: sha, data: Uint8Array.of(8, 9)};}, async write(path, blob, previous) {calls.push(['write', path, [...new Uint8Array(await blob.arrayBuffer())], previous]); return {sha256: nextSha};}, ...options.files};
  const session = createFileSession({instanceId: 'view-1', sessionId: 'session-1', files, async authorize(caller, operation) {auth.push({caller, operation}); return options.authorize ? options.authorize(caller, operation) : caller === human;}, signal: options.signal});
  return {session, calls, auth};
}
const open = (session, documentId = 'doc-A', path = 'Folder/A.deckcraft', retained = true) => session.open({path, sha256: sha}, human, async () => ({documentId, revision: '3', sourceRetained: retained}));

test('binds correlated adoption identity, not the last active document or mutable resource object', async () => {
  const {session, calls} = fixture(), a = deferred(), b = deferred();
  const resource = {path: 'Folder/A.deckcraft', sha256: sha};
  const first = session.open(resource, human, () => a.promise);
  resource.path = 'Other/Changed.deckcraft';
  const second = session.open({path: 'Folder/B.deckcraft', sha256: sha}, human, () => b.promise);
  b.resolve({documentId: 'doc-B', revision: '9', sourceRetained: true}); await second;
  a.resolve({documentId: 'doc-A', revision: '3', sourceRetained: true}); await first;
  await session.save(request(), human);
  assert.deepEqual(calls.at(-1), ['write', 'Folder/A.deckcraft', [1, 2, 3], sha]);
  assert.equal(session.inspect().bindings.find(x => x.documentId === 'doc-B').path, 'Folder/B.deckcraft');
});

test('converted input is a draft and ordinary save creates a new resource', async () => {
  const {session, calls} = fixture();
  const result = await open(session, 'doc-A', 'Folder/Outline.md', false);
  assert.equal(result.resourceId, 'draft:doc-A');
  await session.save(request(), human);
  assert.deepEqual(calls.at(-1), ['write', 'Documents/A.deckcraft', [1, 2, 3], null]);
});

test('captures bytes and metadata before authorization; rejects a second pending save', async () => {
  const gate = deferred();
  const {session, calls} = fixture({authorize: async (_, op) => op.operation === 'file.open' || gate.promise});
  await open(session);
  const message = request(), saving = session.save(message, human);
  new Uint8Array(message.bytes).fill(99); message.name = 'Wrong.deckcraft'; message.documentId = 'doc-B';
  await assert.rejects(session.save(request({id: 'save-2'}), human), /pending/);
  gate.resolve(true); const result = await saving;
  assert.equal(result.documentId, 'doc-A');
  assert.deepEqual(calls.at(-1), ['write', 'Folder/A.deckcraft', [1, 2, 3], sha]);
});

test('unknown outcome preserves old saved revision and blocks retries', async () => {
  let writes = 0;
  const {session} = fixture({files: {async write() {writes++; throw Object.assign(Error('Transport lost'), {outcome: 'unknown'});}}});
  await open(session);
  await assert.rejects(session.save(request(), human), error => error.outcome === 'unknown');
  assert.equal(session.inspect().bindings[0].sha256, sha);
  assert.equal(session.inspect().pending[0].state, 'unknown');
  await assert.rejects(session.save(request({id: 'save-2'}), human), /unknown/);
  assert.equal(writes, 1);
});

test('definitive conflict retains source binding; Save As uses create without replacing source', async () => {
  const {session, auth} = fixture({files: {async write() {throw Object.assign(Error('Conflict'), {status: 409});}}});
  await open(session);
  await assert.rejects(session.save(request(), human), /Conflict/);
  assert.deepEqual(session.inspect().pending, []);
  assert.equal(session.inspect().bindings[0].sha256, sha);
  await assert.rejects(session.save(request({operation: 'file.saveAs', saveAs: true, name: 'Copy.deckcraft'}), human), /Conflict/);
  const intent = auth.at(-1).operation;
  assert.equal(intent.resourceId, 'Folder/Copy.deckcraft'); assert.equal(intent.sourceResourceId, 'Folder/A.deckcraft'); assert.equal(intent.expectedRevision, null);
  assert.equal(session.inspect().bindings[0].path, 'Folder/A.deckcraft');
});

test('missing/denied callers and uncorrelated exports cannot borrow authority or write bytes', async () => {
  const {session, calls} = fixture(); await open(session);
  await assert.rejects(session.save(request()), /Explicit caller/);
  await assert.rejects(session.save(request(), agent), /denied/);
  await assert.rejects(session.save(request({documentSave: false}), human), /exports/);
  await assert.rejects(session.save(request({name: '../outside'}), human), /identified/);
  await assert.rejects(session.save(request({name: 'Other.deckcraft'}), human), /Save As/);
  assert.equal(calls.filter(x => x[0] === 'write').length, 0);
});

test('disposal after dispatch makes confirmation unknown and cannot install a stale binding', async () => {
  const write = deferred(), entered = deferred();
  const {session} = fixture({files: {write() {entered.resolve(); return write.promise;}}}); await open(session);
  const saving = session.save(request(), human); await entered.promise; session.dispose(); write.resolve({sha256: nextSha});
  await assert.rejects(saving, error => error.outcome === 'unknown');
  assert.deepEqual(session.inspect().bindings, []);
  assert.equal(session.inspect().pending[0].state, 'unknown');
});

test('stale read refuses adoption; invalid durable confirmation stays unknown', async () => {
  let adopted = false;
  const stale = fixture({files: {async read() {return {data: Uint8Array.of(1), sha256: nextSha};}}});
  await assert.rejects(stale.session.open({path: 'A.deckcraft', sha256: sha}, human, async () => {adopted = true;}), /changed/);
  assert.equal(adopted, false);
  const {session} = fixture({files: {async write() {return {sha256: 'invalid'};}}}); await open(session);
  await assert.rejects(session.save(request(), human), error => error.outcome === 'unknown');
  assert.equal(session.inspect().bindings[0].sha256, sha);
});

test('successful Save As installs only the confirmed destination and subsequent Save uses its server revision', async () => {
  const {session, calls} = fixture(); await open(session);
  const saved = await session.save(request({operation: 'file.saveAs', saveAs: true, name: 'Copy.deckcraft'}), human);
  assert.equal(saved.committed, true);
  assert.deepEqual(calls.at(-1), ['write', 'Folder/Copy.deckcraft', [1, 2, 3], null]);
  await session.save(request({id: 'save-2', name: 'Copy.deckcraft'}), human);
  assert.deepEqual(calls.at(-1), ['write', 'Folder/Copy.deckcraft', [1, 2, 3], nextSha]);
});

test('authority invalidation after a server reply cannot acknowledge a save to the obsolete session', async () => {
  let revoked = false;
  const {session} = fixture({files: {check() {if (revoked) throw Error('Session expired');}, async write() {revoked = true; return {sha256: nextSha};}}});
  await open(session);
  await assert.rejects(session.save(request(), human), error => error.outcome === 'unknown');
  assert.equal(session.inspect().bindings[0].sha256, sha);
  assert.equal(session.inspect().pending[0].state, 'unknown');
});

test('explicit Save As preserves a canonical nested destination and subsequent conditional writes', async () => {
  const {session,calls}=fixture();await open(session);
  const saved=await session.save(request({operation:'file.saveAs',saveAs:true,name:'New.pptx'}),human,'Talks/November/New.pptx');
  assert.equal(saved.path,'Talks/November/New.pptx');assert.deepEqual(calls.at(-1),['write','Talks/November/New.pptx',[1,2,3],null]);
  await session.save(request({id:'next',name:'New.pptx'}),human);assert.deepEqual(calls.at(-1),['write','Talks/November/New.pptx',[1,2,3],nextSha]);
});
test('explicit ordinary Save cannot be redirected while Save As collisions retain the old binding', async () => {
  const {session,calls}=fixture({files:{async write(){const error=Error('collision');error.status=409;throw error;}}});await open(session);
  await assert.rejects(session.save(request(),human,'Other/A.deckcraft'),/Save As/);
  await assert.rejects(session.save(request({saveAs:true,operation:'file.saveAs'}),human,'Other/A.deckcraft'),/collision/);
  assert.equal(session.inspect().bindings[0].path,'Folder/A.deckcraft');assert.equal(calls.filter(call=>call[0]==='write').length,0);
});

test('recovered binding requires explicit authorized authority and captures metadata before yielding', async () => {
  const {session}=fixture();await assert.rejects(session.bind('doc-A',{path:'Talks/A.pptx',sha256:sha},agent),/denied/);
  assert.equal(session.inspect().bindings.length,0);
  const resource={path:'Talks/A.pptx',sha256:sha},binding=session.bind('doc-A',resource,human);resource.path='Other/B.pptx';await binding;
  assert.equal(session.inspect().bindings[0].path,'Talks/A.pptx');
});

test('native adoption keeps the old binding and save guard until its exact server receipt is accepted',async()=>{
  const {session}=fixture(),gate=deferred(),entered=deferred();await open(session);
  const saving=session.save(request({saveAs:true,operation:'file.saveAs',name:'New.pptx'}),human,'Talks/New.pptx',async receipt=>{
    assert.equal(Object.isFrozen(receipt),true);assert.equal(receipt.path,'Talks/New.pptx');assert.equal(receipt.sha256,nextSha);entered.resolve();await gate.promise;
  });
  await entered.promise;assert.equal(session.inspect().bindings[0].path,'Folder/A.deckcraft');assert.equal(session.inspect().pending[0].state,'adopting');
  await assert.rejects(session.save(request({id:'other'}),human),/pending/);gate.resolve();await saving;
  assert.equal(session.inspect().bindings[0].path,'Talks/New.pptx');assert.equal(session.inspect().pending.length,0);
});

test('lost native adoption after server confirmation is unknown and retains the prior binding',async()=>{
  const {session}=fixture();await open(session);
  await assert.rejects(session.save(request(),human,null,async()=>{throw Error('Native acknowledgement unavailable');}),error=>error.outcome==='unknown');
  assert.equal(session.inspect().bindings[0].sha256,sha);assert.equal(session.inspect().pending[0].state,'unknown');
  await assert.rejects(session.save(request({id:'other'}),human),/unknown/);
});

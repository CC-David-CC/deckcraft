/** Adapter transport/authorization tests with a synthetic native endpoint.
 * Native presentation fidelity is covered by Rust and actual-browser qualification.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
if(process.env.WEBOS_RUNTIME_AUTOSAVE_MODULE)registerHooks({resolve(specifier,context,next){return specifier==='@webos/runtime/account-autosave'?{url:pathToFileURL(process.env.WEBOS_RUNTIME_AUTOSAVE_MODULE).href,shortCircuit:true}:next(specifier,context);}});
const {mount}=await import('./index.mjs');

const SHA='a'.repeat(64),NEXT='b'.repeat(64),human=Object.freeze({});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate){for(let i=0;i<600;i++){const value=predicate();if(value)return value;await sleep(5);}throw Error('Adapter did not reach expected state.');}
class Element extends EventTarget {
  constructor(tag){super();this.tagName=tag;this.children=[];this.style={};this.dataset={};this.value='';this.inert=false;this.hidden=false;this.textContent='';}
  append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node);}}
  replaceChildren(...nodes){this.children=[];this.append(...nodes);}
  setAttribute(name,value){this[name]=value;}
  querySelector(selector){const tags=selector.split(',');for(const child of this.children){if(tags.includes(child.tagName))return child;const result=child.querySelector?.(selector);if(result)return result;}return null;}
  focus(){this.focused=true;}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(node=>node!==this);}
  showModal(){this.open=true;}
  close(){this.open=false;}
  click(){this.dispatchEvent(new Event('click'));}
}
function fixture(options={}) {
  const listeners=new EventTarget(),document=new EventTarget(),calls=[],authorizations=[],server=new Map(),state={hostDocumentVersion:1,documentTargeting:'active-precondition-v1',documentId:'11',revision:'1',documents:[{documentId:'11',revision:'1',dirty:false,path:null,title:'Presentation'}],pendingSaves:{},pendingNotes:'',autosaveEligible:false,profile:{version:1,ui:{recent:[]},prefs:{author:''}}};
  let frame,sequence=1,savedRevision=0,adoptions=0;
  const dispatch=data=>{const event=new Event('message');Object.assign(event,{origin:'https://webos.test',source:frame.contentWindow,data});listeners.dispatchEvent(event);};
  const native={async request(method,p={}){calls.push(['native',method,p]);if(method==='ui.inspect')return structuredClone(state);if(method==='document.inspect')return {path:state.documents[0].path};
    if(method!=='engine.execute')throw Error('Unknown method');const args=p.params||{};
    if(p.command==='host.configure'||p.command==='app.backstage')return {};
    if(p.command==='host.applyProfile'){state.profile=structuredClone(args);return {};}
    if(p.command==='host.profile')return structuredClone(state.profile);
    if(p.command==='host.bind'){state.documents[0].path=args.path;return {path:args.path};}
    if(p.command==='host.prepareSave'||p.command==='host.autosave'){
      const path=args.path||state.documents[0].path||'Presentation.pptx',saveAs=p.command==='host.autosave'?false:!!args.path||!state.documents[0].path,id='deckcraft-save-11-'+sequence++;
      savedRevision=Number(state.revision);state.pendingSaves[id]={documentId:'11',revision:state.revision};
      // Emit before the command promise resolves to expose destination-correlation races.
      dispatch({type:'deckcraft:save',id,documentId:'11',revision:state.revision,name:path.split('/').at(-1),operation:saveAs?'file.saveAs':'file.save',saveAs,documentSave:true,bytes:Uint8Array.of(1,2,3).buffer});
      return {pending:'save',id,documentId:'11',revision:state.revision};
    }
    if(p.command==='host.acknowledgeSave'){assert.ok(state.pendingSaves[args.id]);delete state.pendingSaves[args.id];state.documents[0].path=args.path;state.documents[0].dirty=Number(state.revision)!==savedRevision;state.revision=String(Number(state.revision)+1);state.documents[0].revision=state.revision;return {path:args.path};}
    if(p.command==='host.pause'){state.paused=args.paused!==false;if(state.paused)state.autosaveEligible=false;return {paused:state.paused};}
    if(p.command==='host.finalizeClose'){state.finalized=true;return {closed:true};}
    if(p.command==='host.snapshot')return {version:1,revision:state.revision,data:'UEsDBAoAAAA='};
    state.revision=String(Number(state.revision)+1);state.documents[0].revision=state.revision;state.documents[0].dirty=true;return {};
  }};
  Object.assign(document,{hidden:false,body:new Element('body'),createElement(tag){const node=new Element(tag);if(tag==='iframe'){
      frame=node;const canvas=new Element('canvas');node.contentDocument={querySelector:()=>canvas};node.contentWindow={deckcraft:native,focus(){},postMessage(data){
        calls.push(['post',data.type]);if(data.type==='deckcraft:open'){adoptions++;queueMicrotask(()=>dispatch({type:'deckcraft:opened',id:data.id,documentId:'11',revision:state.revision,sourceRetained:true}));}
        if(data.type==='deckcraft:save-failed')delete state.pendingSaves[data.id];
      }};
      Object.defineProperty(node,'src',{set(value){if(value!=='about:blank')queueMicrotask(()=>dispatch({type:'deckcraft:ready',openResult:true}));}});
    }return node;}});
  globalThis.document=document;globalThis.window=listeners;globalThis.location={origin:'https://webos.test',href:'https://webos.test/'};
  const profiles=options.profiles??new Map();globalThis.localStorage={getItem:key=>profiles.get(key)??null,setItem:(key,value)=>profiles.set(key,value)};
  const files={check(){options.checkAccount?.();},async read(path){calls.push(['read',path]);if(options.readError)throw Error('Source unavailable');return {sha256:SHA,data:Uint8Array.of(9)};},async version(){return {sha256:SHA};},async write(path,blob,expected){calls.push(['write',path,expected]);if(options.write)await options.write(path,blob,expected);server.set(path,new Uint8Array(await blob.arrayBuffer()));return {sha256:NEXT};},async list(){return {entries:[]};}};
  const view=mount({instanceId:'view',sessionId:'session',files,authority:human,authorize:async(caller,target)=>{authorizations.push(target);if(options.authorize)return options.authorize(caller,target);return caller===human;},url:'https://webos.test/deckcraft/',profileId:'account-A',...options.mount});
  const target=()=>({instanceId:'view',sessionId:'session',documentId:'11',resourceId:state.documents[0].path||'draft:11'});
  return {view,state,calls,server,profiles,authorizations,dispatch,target,document,get adoptions(){return adoptions;}};
}
async function choose(view,kind,value){const dialog=await until(()=>view.element.children.find(node=>node.tagName==='dialog'&&node.dataset.kind===kind));const input=dialog.querySelector('input');if(input)input.value=value;const button=dialog.children.at(-1).children.find(node=>node.textContent===(input?'Save':value));assert.ok(button);button.click();}

test('account AutoSave choice persists per account without disabling browser recovery',async()=>{
  const profiles=new Map(),f=fixture({profiles});
  try {await f.view.ready;const toggle=f.view.element.children.flatMap(node=>[node,...node.children]).find(node=>node.textContent==='AutoSave: On');assert.ok(toggle);toggle.click();
    await until(()=>[...profiles.values()].some(text=>JSON.parse(text).accountAutosaveEnabled===false));
    assert.equal((await f.view.inspect()).autosaveEnabled,false);
  }finally{f.view.dispose();}
  const restored=fixture({profiles});try{await restored.view.ready;assert.equal((await restored.view.inspect()).autosaveEnabled,false);}finally{restored.view.dispose();}
  const other=fixture({profiles,mount:{profileId:'account-B'}});try{await other.view.ready;assert.equal((await other.view.inspect()).autosaveEnabled,true);}finally{other.view.dispose();}
});

test('unexpected iframe reload cancels dead native requests and close retains the recovery journal',async()=>{
  let clears=0;const f=fixture({mount:{recovery:{async load(){return null;},async write(){},async clear(){clears++;},close(){}}}});
  try{await f.view.ready;const frame=f.view.element.children.find(node=>node.tagName==='iframe'),original=frame.contentWindow.deckcraft.request;
    frame.contentWindow.deckcraft.request=(method,p)=>p?.command==='slide.new'?new Promise(()=>{}):original(method,p);
    const command=f.view.execute({...f.target(),command:'slide.new'},human),rejected=assert.rejects(command,/reloaded|unavailable/);
    await until(()=>f.calls.some(call=>call[0]==='native'&&call[1]==='ui.inspect'));
    await sleep(10);const previous=clears;frame.contentDocument={querySelector:()=>null};frame.dispatchEvent(new Event('load'));await rejected;
    assert.equal((await f.view.inspect()).phase,'unavailable');assert.equal(await f.view.requestClose(),true);
    await f.view.lifecycle.commitClose();assert.equal(clears,previous);
  }finally{f.view.dispose();}
});

test('a late server reply cannot acknowledge a replacement iframe with recycled native IDs',async()=>{
  let release;const f=fixture({mount:{resource:{path:'Talks/Original.pptx',sha256:SHA}},write:()=>new Promise(resolve=>release=resolve)});
  try{await f.view.ready;const frame=f.view.element.children.find(node=>node.tagName==='iframe');
    await f.view.execute({...f.target(),command:'slide.new'},human);
    const saving=f.view.execute({...f.target(),command:'file.save'},human),rejected=assert.rejects(saving,/reloaded|unavailable/);
    await until(()=>release);frame.contentDocument={querySelector:()=>null};frame.dispatchEvent(new Event('load'));await rejected;
    release();await sleep(25);assert.equal(f.calls.some(call=>call[0]==='native'&&call[2].command==='host.acknowledgeSave'),false);
    assert.equal((await f.view.inspect()).phase,'unavailable');
  }finally{release?.();f.view.dispose();}
});

test('pause eligibility changes preserve approved Discard while finalizing only this view',async()=>{
  const f=fixture();try{await f.view.ready;await f.view.execute({...f.target(),command:'slide.new'},human);
    f.state.autosaveEligible=true;await f.view.inspect();const closing=f.view.requestClose();closing.catch(()=>{});await choose(f.view,'close','Discard changes');
    assert.equal(await closing,true);await f.view.lifecycle.commitClose();assert.equal(f.state.finalized,true);
  }finally{f.view.dispose();}
});

test('manual conflicts pause AutoSave until a confirmed resolution and toggling cannot bypass it',async()=>{
  let writes=0;const f=fixture({mount:{resource:{path:'Talks/Original.pptx',sha256:SHA}},write:async()=>{if(writes++===0)throw Object.assign(Error('File changed'),{status:409});}});
  try{await f.view.ready;await f.view.execute({...f.target(),command:'slide.new'},human);
    await assert.rejects(f.view.execute({...f.target(),command:'file.save'},human),/changed/);
    assert.equal((await f.view.inspect()).autosave.state,'paused');
    const toggle=f.view.element.children.flatMap(node=>[node,...node.children]).find(node=>node.textContent==='AutoSave: On');toggle.click();toggle.click();
    assert.equal((await f.view.inspect()).autosave.state,'paused');
    await f.view.execute({...f.target(),command:'file.saveAs',args:{path:'Talks/Resolved.pptx'}},human);
    assert.equal(f.view.fileBinding.snapshot().path,'Talks/Resolved.pptx');assert.notEqual((await f.view.inspect()).autosave.state,'paused');
  }finally{f.view.dispose();}
});

test('server success with failed native adoption never publishes a new document binding',async()=>{
  const f=fixture({mount:{resource:{path:'Talks/Original.pptx',sha256:SHA}}});
  try{await f.view.ready;const frame=f.view.element.children.find(node=>node.tagName==='iframe'),request=frame.contentWindow.deckcraft.request;
    frame.contentWindow.deckcraft.request=(method,p)=>p?.command==='host.acknowledgeSave'?Promise.reject(Error('Native acknowledgement unavailable')):request(method,p);
    await assert.rejects(f.view.execute({...f.target(),command:'file.saveAs',args:{path:'Talks/Unadopted.pptx'}},human),/acknowledgement/);
    assert.equal(f.view.fileBinding.snapshot().path,'Talks/Original.pptx');assert.equal(f.view.fileBinding.snapshot().revision,SHA);
    const state=await f.view.inspect();assert.equal(state.accountFiles.pending[0].state,'unknown');assert.equal(state.autosave.state,'paused');
  }finally{f.view.dispose();}
});

test('public view exposes readiness, focus, exact binding and canonical Save As despite early native dispatch',async()=>{
  const f=fixture();try{await f.view.ready;assert.equal(f.view.focus(),true);const bindings=[];f.view.fileBinding.subscribe(value=>bindings.push(value));
    await f.view.execute({...f.target(),command:'file.saveAs',args:{path:'Talks/Canonical.pptx'}},human);
    assert.deepEqual(f.calls.find(call=>call[0]==='write'),['write','Talks/Canonical.pptx',null]);
    assert.equal(f.view.fileBinding.snapshot().path,'Talks/Canonical.pptx');assert.equal(f.view.fileBinding.snapshot().revision,NEXT);
    assert.ok(bindings.some(value=>value.path==='Talks/Canonical.pptx'));
    await f.view.execute({...f.target(),command:'file.save'},human);assert.deepEqual(f.calls.filter(call=>call[0]==='write').at(-1),['write','Talks/Canonical.pptx',NEXT]);
  }finally{f.view.dispose();}
});
test('stale instance/session/resource and private acknowledgements cannot execute',async()=>{
  const f=fixture();try{await f.view.ready;for(const changed of [{instanceId:'wrong'},{sessionId:'wrong'},{documentId:'12'},{resourceId:'Other.pptx'}])await assert.rejects(f.view.execute({...f.target(),command:'slide.new',...changed},human),/Exact/);
    await assert.rejects(f.view.execute({...f.target(),command:'host.acknowledgeSave',args:{id:'fake',path:'Other.pptx'}},human),/document host/);
    await assert.rejects(f.view.execute({...f.target(),command:'slide.new'},{}),/Delegated/);
    assert.equal(f.calls.some(call=>call[0]==='native'&&call[2].command==='slide.new'),false);
  }finally{f.view.dispose();}
});

test('delegated notes require an authorized native slide ID and leave file operations human-only', async () => {
  const agent = Object.freeze({});
  const f = fixture({authorize:(caller,target) => caller === human ||
    caller === agent && target.operation === 'slide.notes' && target.documentId === '11'});
  try {
    await f.view.ready;
    const request = {...f.target(),command:'slide.notes',args:{slideId:19,text:'Speaker notes'}};
    await assert.rejects(f.view.execute(request,{}), /denied/);
    await assert.rejects(f.view.execute({...request,args:{index:0,text:'Wrong target'}},agent), /command contract/);
    await assert.rejects(f.view.execute({...request,command:'file.saveAs',args:{path:'Talks/Other.pptx'}},agent), /command contract/);
    await f.view.execute(request,agent);
    const calls = f.calls.filter(call => call[0] === 'native' && call[2].command === 'slide.notes');
    assert.deepEqual(calls, [['native','engine.execute',{documentId:'11',command:'slide.notes',params:request.args}]]);
  } finally {
    f.view.dispose();
  }
});

test('both account Open routes activate the Desktop resource and preserve this native editor',async()=>{
  const activated=[],opened=[],f=fixture({mount:{activateFile:file=>{activated.push(file.path);return true;},openFile:file=>opened.push(file)}});try{await f.view.ready;
    await f.view.execute({...f.target(),command:'file.open',args:{path:'Talks/Existing.pptx'}},human);
    f.dispatch({type:'deckcraft:document-request',documentId:'11',revision:'1',command:'file.open',params:{path:'Talks/Existing.pptx'}});await until(()=>activated.length===2);
    assert.deepEqual(activated,['Talks/Existing.pptx','Talks/Existing.pptx']);assert.equal(opened.length,0);assert.equal(f.adoptions,0);assert.equal(f.view.fileBinding.snapshot().documentId,'11');
  }finally{f.view.dispose();}
});
test('unchanged blank closes quietly and native pause lease is held through finalization',async()=>{
  const f=fixture();try{await f.view.ready;assert.equal(await f.view.requestClose(),true);const lease=await f.view.lifecycle.quiesce();assert.equal(f.state.paused,true);
    await assert.rejects(f.view.execute({...f.target(),command:'slide.new'},human),/Exact/);lease.release();await until(()=>!f.state.paused);
    assert.equal(await f.view.lifecycle.commitClose(),true);assert.equal(f.state.paused,true);
  }finally{f.view.dispose();}
});
test('Discard approval expires after a later native edit',async()=>{
  const f=fixture();try{await f.view.ready;await f.view.execute({...f.target(),command:'slide.new'},human);const closing=f.view.requestClose();await choose(f.view,'close','Discard changes');assert.equal(await closing,true);
    f.state.revision='3';f.state.documents[0].revision='3';await f.view.inspect();await assert.rejects(f.view.lifecycle.commitClose(),/changed after close confirmation/);
  }finally{f.view.dispose();}
});
test('sign-out finalizes only the leased local view after the account session is revoked',async()=>{
  let signedOut=false;
  const f=fixture({checkAccount(){if(signedOut)throw new DOMException('Account session ended.','AbortError');}});
  try {
    await f.view.ready;
    assert.equal(await f.view.requestClose(),true);
    const lease=await f.view.lifecycle.quiesce();
    try {
      signedOut=true;
      const before=f.calls.length;
      await assert.rejects(f.view.execute({...f.target(),command:'file.save'},human),/Account session ended/);
      assert.equal(await f.view.lifecycle.commitClose(),true);
      assert.equal(f.state.finalized,true);
      assert.deepEqual(f.calls.slice(before).map(([operation,method,args])=>[operation,method,args.command]),[['native','engine.execute','host.finalizeClose']]);
    }finally{lease.release();}
  }finally{f.view.dispose();}
});
test('unavailable intended account file retains Retry and never becomes a ready blank',async()=>{
  const options={readError:true,mount:{resource:{path:'Talks/Missing.pptx',sha256:SHA}}},f=fixture(options);try{
    await assert.rejects(f.view.ready,/Source unavailable/);assert.equal((await f.view.inspect()).phase,'unavailable');assert.equal(f.view.fileBinding.snapshot().loaded,false);
    options.readError=false;await f.view.retry();assert.equal(f.view.fileBinding.snapshot().path,'Talks/Missing.pptx');assert.equal(f.adoptions,1);
  }finally{f.view.dispose();}
});
test('copy export adds its format to a bare name and preserves document identity',async()=>{
  const f=fixture();try{await f.view.ready;f.dispatch({type:'deckcraft:save',documentSave:false,name:'Presentation.pdf',bytes:Uint8Array.of(4,5).buffer});await choose(f.view,'path','Exports/Presentation');await until(()=>f.server.has('Exports/Presentation.pdf'));
    assert.deepEqual(f.calls.find(call=>call[0]==='write'),['write','Exports/Presentation.pdf',null]);assert.equal(f.view.fileBinding.snapshot().path,null);assert.equal(f.calls.some(call=>call[0]==='native'&&call[2].command==='host.acknowledgeSave'),false);
  }finally{f.view.dispose();}
});

test('unknown writes retain the pending account guard and block close instead of announcing success',async()=>{
  let count=0;const f=fixture({async write(){count++;const error=Error('Reply lost after dispatch');error.outcome='unknown';throw error;}});try{await f.view.ready;
    await assert.rejects(f.view.execute({...f.target(),command:'file.saveAs',args:{path:'Talks/Unknown.pptx'}},human),/Reply lost/);
    const state=await f.view.inspect();assert.equal(state.path,null);assert.equal(state.accountFiles.pending[0].state,'unknown');assert.equal(await f.view.requestClose(),false);
    await assert.rejects(f.view.execute({...f.target(),command:'file.saveAs',args:{path:'Talks/Unknown.pptx'}},human),/pending|unknown/);assert.equal(count,1);
  }finally{f.view.dispose();}
});
test('recovery checkpoint refusal preserves an earlier journal record and the live buffer',async()=>{
  const records=[],recovery={load:async()=>null,write:async value=>records.push(structuredClone(value)),clear:async()=>{},close(){}},f=fixture({mount:{recovery}});try{await f.view.ready;
    await f.view.execute({...f.target(),command:'slide.new'},human);const first=await f.view.checkpoint();assert.equal(records.length,1);assert.equal(first.snapshot.version,1);
    // Journal storage failure is independent of native capture and must retain
    // the last committed checkpoint, as Runtime's journal contract guarantees.
    recovery.write=async()=>{throw Error('Quota unavailable');};await f.view.execute({...f.target(),command:'slide.new'},human);
    await assert.rejects(f.view.checkpoint(),/Quota unavailable/);assert.equal(records.length,1);assert.equal((await f.view.inspect()).dirty,true);
  }finally{f.view.dispose();}
});

test('preference-only edits persist without a document revision and A→B→A profiles stay isolated',async()=>{
  const profiles=new Map(),first=fixture({profiles});try{await first.view.ready;
  first.state.profile={version:1,ui:{recent:['Talks/A.pptx']},prefs:{author:'Account A'}};
  await until(()=>[...profiles.values()].some(value=>JSON.parse(value).prefs.author==='Account A'));
  assert.equal(first.state.revision,'1');}finally{first.view.dispose();}
  const second=fixture({profiles,mount:{profileId:'account-B'}});try{await second.view.ready;assert.equal(second.state.profile.prefs.author,'');assert.deepEqual(second.state.profile.ui.recent,[]);
    second.state.profile.prefs.author='Account B';await second.view.checkpoint();
  }finally{second.view.dispose();}
  const returned=fixture({profiles});try{await returned.view.ready;assert.equal(returned.state.profile.prefs.author,'Account A');assert.deepEqual(returned.state.profile.ui.recent,['Talks/A.pptx']);}
  finally{returned.view.dispose();}
});

test('dirty edits remain checkpointable while a save result is unknown',async()=>{
  const records=[],recovery={load:async()=>null,write:async value=>records.push(value),clear:async()=>{},close(){}};
  const f=fixture({mount:{recovery},async write(){const error=Error('Save outcome unknown');error.outcome='unknown';throw error;}});try{await f.view.ready;
    await f.view.execute({...f.target(),command:'slide.new'},human);
    await assert.rejects(f.view.execute({...f.target(),command:'file.saveAs',args:{path:'Talks/Uncertain.pptx'}},human),/unknown/);
    const snapshot=await f.view.checkpoint();assert.equal(snapshot.path,null);assert.equal(records.length,1);assert.equal(records[0].snapshot.version,1);
    assert.equal((await f.view.inspect()).accountFiles.pending[0].state,'unknown');
  }finally{f.view.dispose();}
});

test('real Runtime AutoSave waits for finished native input, uses conditional Save and never delays manual Save',async()=>{
  const f=fixture({mount:{resource:{path:'Talks/Automatic.pptx',sha256:SHA}}});try{await f.view.ready;
    await f.view.execute({...f.target(),command:'slide.new'},human);f.state.autosaveEligible=false;await f.view.inspect();
    await sleep(10_100);assert.equal(f.calls.filter(call=>call[0]==='write').length,0);assert.equal((await f.view.inspect()).autosave.state,'waiting');
    f.state.autosaveEligible=true;await f.view.inspect();await until(()=>f.calls.some(call=>call[0]==='write'));
    await until(()=>!f.state.documents[0].dirty);assert.deepEqual(f.calls.find(call=>call[0]==='write'),['write','Talks/Automatic.pptx',SHA]);
    assert.ok(f.calls.some(call=>call[0]==='native'&&call[2].command==='host.autosave'));
    await f.view.execute({...f.target(),command:'slide.new'},human);const started=performance.now();await f.view.execute({...f.target(),command:'file.save'},human);
    assert.ok(performance.now()-started<1000,'Manual Save is not held for AutoSave debounce/cooldown');assert.equal(f.calls.filter(call=>call[0]==='write').length,2);
  }finally{f.view.dispose();}
});

test('automatic retry is restricted to verified no-write429 responses',async()=>{
  for(const [message,expected] of [['Too many pending account-file operations; wait for the current operations to finish','retrying'],['Unexplained upstream429','paused']]){
    const f=fixture({mount:{resource:{path:'Talks/Retry.pptx',sha256:SHA}},async write(){const error=Error(message);error.status=429;error.retryAfterMs=75_000;throw error;}});try{await f.view.ready;
      await f.view.execute({...f.target(),command:'slide.new'},human);f.state.autosaveEligible=true;await f.view.inspect();await sleep(10_100);
      await until(()=>f.calls.some(call=>call[0]==='write'));await until(()=>f.view.element.children[1].children[0].textContent.includes(expected==='retrying'?'retry':'paused'));
      const save=(await f.view.inspect()).autosave;
      assert.equal(save.state,expected);assert.equal(f.calls.filter(call=>call[0]==='write').length,1);
      if(expected==='retrying')assert(save.nextAt-performance.now()>70_000);
    }finally{f.view.dispose();}
  }
});

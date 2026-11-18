/** Trusted same-origin document host; native Rust owns all editable presentation state. */
import {accountAutosaveRetry,createAccountAutosave} from '@webos/runtime/account-autosave';
import {createFileSession} from './account-files.mjs';
import {createDialogs, canonicalPath} from './dialogs.mjs';

const identity = value => typeof value === 'string' && /^[0-9]{1,20}$/.test(value);
const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const deferred = () => { let resolve, reject; const promise = new Promise((yes,no)=>{resolve=yes;reject=no;});promise.catch(()=>{});return {promise,resolve,reject}; };
const MAX = 128*1024*1024;
const base64 = bytes => {const parts=[];for(let i=0;i<bytes.length;i+=24576){let text='';for(const b of bytes.subarray(i,i+24576))text+=String.fromCharCode(b);parts.push(btoa(text));}return parts.join('');};
export function mount({instanceId,sessionId,resource=null,imported=null,template=null,recovery=null,recoveryAsCopy=false,profileId='',files,authority,authorize,
  openFile,activateFile,newDocument,importDocument,closeView,displayName='',url,signal:parentSignal}) {
  if(authority==null||typeof authorize!=='function')throw Error('Explicit human authority required.');
  const source=new URL(url,location.href);if(source.origin!==location.origin)throw Error('DeckCraft requires trusted same-origin hosting.');
  resource=resource?structuredClone(resource):null;imported=imported?structuredClone(imported):null;template=template?structuredClone(template):null;
  source.searchParams.set('host','parent');source.searchParams.set('blank','');source.searchParams.set('author',displayName);
  const element=document.createElement('div'),frame=document.createElement('iframe'),status=document.createElement('div'),retryButton=document.createElement('button'),statusBar=document.createElement('footer'),autoToggle=document.createElement('button');
  element.className='webos-deckcraft';element.style.cssText='display:flex;flex-direction:column;width:100%;height:100%;min-height:0';
  frame.title='DeckCraft presentation';frame.style.cssText='flex:1;width:100%;min-height:0;border:0';frame.allow='clipboard-read; clipboard-write; fullscreen';frame.inert=true;
  status.setAttribute('role','status');status.style.cssText='flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';statusBar.style.cssText='display:flex;align-items:center;gap:8px;flex:none';autoToggle.type='button';autoToggle.textContent='AutoSave: On';autoToggle.setAttribute('aria-pressed','true');autoToggle.title='Save finished edits to the current account file after a debounce. Browser recovery stays on.';statusBar.append(status,autoToggle);retryButton.textContent='Retry';retryButton.hidden=true;element.append(frame,statusBar,retryButton);
  const abort=new AbortController(),fileSession=createFileSession({instanceId,sessionId,files,authorize,signal:abort.signal}),startup=deferred(),opens=new Map(),completions=new Map(),destinations=new Map(),listeners=new Set(),bindingListeners=new Set(),nativeWaiters=new Set();
  let phase='loading',disposed=false,initializing=false,nativeReady=false,configured=false,loaded=false,native=null,currentDocument=null,fingerprint='',lifecycleRevision=0,closeIntent=null,paused=false,lease=null,timer,poll,checkpointTail=Promise.resolve(),needsCopy=false,recoveryState=recovery?'ready':'unavailable',nextOpen=1,saveChoosing=false,commandPending=0,preparedDestination=null,lastProfileText=null,autoPending=false,autosaveBlock=null,autosave=null,lastAutosaveState='idle',pauseToken=null,autosaveEnabled=true,nativeDocument=null,nativeInvalidated=false;
  const check=()=>{if(disposed||abort.signal.aborted)throw new DOMException('DeckCraft view closed.','AbortError');files.check();
    if(nativeInvalidated||nativeDocument&&frame.contentDocument!==nativeDocument){if(!nativeInvalidated){nativeInvalidated=true;loaded=false;phase='unavailable';frame.inert=true;clearTimeout(timer);clearInterval(poll);retryButton.hidden=true;const error=Error('DeckCraft reloaded unexpectedly. Close and reopen this view to recover its last browser checkpoint.');status.textContent=error.message;status.title=error.message;autosave?.pause(error.message);startup.reject(error);for(const entry of opens.values()){clearTimeout(entry.timer);entry.reject(error);}opens.clear();for(const entry of completions.values())entry.reject(error);for(const reject of [...nativeWaiters])reject(error);changed();}throw Error('The original DeckCraft document instance is unavailable. Close and reopen this view.');}};
  function nativeRequest(value,method,params){
    check();return new Promise((resolve,reject)=>{
      let settled=false;
      const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timeout);abort.signal.removeEventListener('abort',cancel);nativeWaiters.delete(cancelNative);error?reject(error):resolve(result);};
      const cancelNative=error=>finish(error),cancel=()=>finish(new DOMException('DeckCraft view closed.','AbortError'));
      const timeout=setTimeout(()=>{const error=Error('Native DeckCraft request timed out. Verify pending account saves before retrying.');error.outcome='unknown';finish(error);},31000);
      nativeWaiters.add(cancelNative);abort.signal.addEventListener('abort',cancel,{once:true});
      try{Promise.resolve(value.request(method,params)).then(result=>{try{check();finish(null,result);}catch(error){finish(error);}},error=>finish(error));}catch(error){finish(error);}
    });
  }
  const api=()=>{check();const value=frame.contentWindow?.deckcraft;if(typeof value?.request!=='function')throw Error('DeckCraft command interface unavailable.');return {request:(method,params)=>nativeRequest(value,method,params)};};
  const post=(type,fields={},transfer=[])=>{check();frame.contentWindow.postMessage({type:'deckcraft:'+type,...fields},location.origin,transfer);};
  const notify=error=>{if(!disposed&&error.name!=='AbortError'){status.textContent=error.message;status.title=error.message;}};
  const dirty=()=>loaded&&!!native?.documents.some(d=>d.dirty);
  const pending=()=>initializing||saveChoosing||autoPending||commandPending>0||dialogs.active||fileSession.inspect().pending.length>0||!!native&&Object.keys(native.pendingSaves).length>0;
  const binding=()=>fileSession.inspect().bindings.find(d=>d.documentId===currentDocument);
  const bindingSnapshot=()=>Object.freeze({documentId:currentDocument,path:binding()?.path??null,revision:binding()?.sha256??null,loaded});
  const dialogs=createDialogs({element,signal:abort.signal,check,onChange:()=>changed(),onClose:()=>focus()});
  function autosaveIdentity(){const source=binding();return loaded&&source?JSON.stringify([location.origin,profileId,instanceId,sessionId,currentDocument,source.path]):null;}
  function observeAutosave(){if(!autosave||disposed||nativeInvalidated)return;const identity=autosaveIdentity(),uncertain=fileSession.inspect().pending.some(item=>item.state==='unknown');
    autosave.observe({identity,version:native?.revision||'0',dirty:dirty(),eligible:autosaveEnabled&&!!identity&&!needsCopy&&!paused&&!initializing&&!saveChoosing&&!dialogs.active&&!commandPending&&native?.autosaveEligible===true,
      blocked:!autosaveEnabled?'AutoSave is off by your choice. Browser recovery stays on.':uncertain?'The account save outcome is unknown. Verify the account file before retrying.':autosaveBlock?.identity===identity?autosaveBlock.reason:null});}
  async function automaticSave({identity,version,signal}){
    check();if(signal.aborted||paused||!loaded||!autosaveEnabled)return {status:'busy'};await inspectNative();check();
    if(identity!==autosaveIdentity())return {status:'paused',reason:'The account resource changed.'};
    if(native.revision!==version||!native.autosaveEligible||needsCopy||dialogs.active||commandPending||saveChoosing)return {status:'busy'};
    try{await checkpoint();}catch(error){notify(Error('Local recovery checkpoint failed: '+error.message+' Account AutoSave remains available.'));}check();await inspectNative();
    if(signal.aborted||!autosaveEnabled||identity!==autosaveIdentity()||native.revision!==version||!native.autosaveEligible||paused)return {status:'busy'};
    const original=binding();if(!original)return {status:'busy'};autoPending=true;changed();
    try{const result=await hostCommand('host.autosave',{path:original.path,revision:version});
      if(result?.status)return result;if(result?.pending!=='save')throw Error('AutoSave did not prepare an identified native save.');
      await completion(result.id).promise;await inspectNative();return {status:'saved'};
    }catch(error){const retry=accountAutosaveRetry(error);if(retry)return retry;
      autosaveBlock={identity,reason:error.message};return {status:'paused',reason:error.message};
    }finally{autoPending=false;if(!disposed){changed();observeAutosave();}}
  }
  autosave=createAccountAutosave({save:automaticSave,onState(value){if(disposed)return;
    if(value.state==='saving')status.textContent='AutoSaving to your account…';
    if(value.state==='scheduled')status.textContent='Unsaved changes; AutoSave scheduled.';
    if(value.state==='waiting'&&loaded)status.textContent=binding()?'AutoSave waits until the native edit finishes. Browser recovery continues.':'Use Save As to save this presentation to your account.';
    if(value.state==='idle'&&lastAutosaveState==='saving')status.textContent='No account changes are waiting.';
    if(value.state==='retrying')status.textContent='AutoSave will retry a known failed write. Browser recovery continues.';
    if(value.state==='paused')status.textContent='AutoSave paused: '+value.reason;
    status.title=status.textContent;lastAutosaveState=value.state;
  }});
  function changed(invalidate=true){if(disposed)return;lifecycleRevision++;if(invalidate)closeIntent=null;for(const listener of listeners){try{listener();}catch(error){console.error("DeckCraft lifecycle observer failed.",error);}}for(const listener of bindingListeners){try{listener(bindingSnapshot());}catch(error){console.error("DeckCraft binding observer failed.",error);}}}
  async function inspectNative(){const state=await api().request('ui.inspect',{});check();if(state?.hostDocumentVersion!==1||!Array.isArray(state.documents)||!state.pendingSaves)throw Error('DeckCraft document-host inspection unavailable.');
    // Eligibility changes when acquiring the native pause lease. It is not an
    // edit and must not invalidate an already approved Discard/close decision.
    native=state;currentDocument=state.documentId;const next=JSON.stringify([state.documents,state.pendingSaves,state.pendingNotes]);if(next!==fingerprint){fingerprint=next;changed();if(loaded&&!paused)schedule();}observeAutosave();return state;}
  async function hostCommand(command,params={},documentId=currentDocument){check();const result=await api().request('engine.execute',{documentId,command,params});check();return result;}
  function adopt(name,bytes){check();if(opens.size>=8)throw Error('Too many file opens pending.');const id='webos-open-'+nextOpen++,entry=deferred(),buffer=bytes.slice().buffer;
    entry.timer=setTimeout(()=>{opens.delete(id);entry.reject(Error('File adoption timed out; no account binding installed.'));},120000);opens.set(id,entry);post('open',{id,name,bytes:buffer},[buffer]);return entry.promise;}
  async function bindNative(documentId,path){await hostCommand('host.bind',{path},documentId);await inspectNative();}
  function completion(id){if(!completions.has(id)){if(completions.size>=64)for(const [key,item]of completions)if(item.settled){completions.delete(key);break;}if(completions.size>=64)throw Error('Too many save completions.');completions.set(id,deferred());}return completions.get(id);}
  async function save(message){
    if(!message.documentSave){await exportCopy(message).catch(notify);return;}
    if(typeof message.id!=='string'||!/^deckcraft-save-[0-9]{1,20}-[0-9]+$/.test(message.id))return notify(Error('Refused unidentified save.'));
    const done=completion(message.id);if(done.started)return;done.started=true;let durable=false;
    try{check();if(!loaded||message.documentId!==currentDocument||paused)throw Error('The originating document is unavailable.');
      const original=binding();let destination=destinations.get(message.id)??(preparedDestination?.documentId===message.documentId?preparedDestination.path:null);destinations.delete(message.id);
      if(!destination&&(message.saveAs||!original)){saveChoosing=true;changed();try{destination=await dialogs.path(original?.path||'Documents/'+message.name);}finally{saveChoosing=false;changed();}check();if(!destination)throw new DOMException('Save cancelled.','AbortError');}
      if(needsCopy&&(!destination||destination===original?.path))throw Error('The saved base changed or could not be verified. Use Save As to another path.');
      if(destination&&!/[.](pptx|potx|ppsx|deckcraft)$/i.test(destination))throw Error('Choose a presentation file extension.');
      const sourceExtension=message.name.split('.').at(-1).toLowerCase();if(destination&&destination.split('.').at(-1).toLowerCase()!==sourceExtension)throw Error('Choose the same format as the prepared presentation.');
      const result=await fileSession.save(message,authority,destination,receipt=>hostCommand('host.acknowledgeSave',{id:receipt.id,path:receipt.path},receipt.documentId));durable=true;check();
      await inspectNative();needsCopy=false;autosaveBlock=null;observeAutosave();autosave?.confirmed({identity:autosaveIdentity()});status.textContent='Saved to your account: '+result.path;changed();done.resolve(result);void checkpoint().catch(notify);
    }catch(error){if(durable)error.outcome='unknown';const outcome=error.outcome==='unknown'?'unknown':error.status===409?'conflict':error.name==='AbortError'?'cancelled':'failed';
      if(!disposed){if(outcome==='unknown'||outcome==='conflict'){autosaveBlock={identity:autosaveIdentity(),reason:error.message};observeAutosave();}notify(Error(error.message+(outcome==='unknown'?' The server outcome is unknown; check the account file before retrying.':'')));try{post('save-failed',{id:message.id,outcome,error:status.textContent});}catch{}}
      done.reject(error);
    }finally{done.settled=true;if(!disposed){await inspectNative().catch(notify);changed();}}
  }
  async function exportCopy(message){check();if(!loaded||paused||!(message.bytes instanceof ArrayBuffer)||message.bytes.byteLength>MAX||typeof message.name!=='string'||/[\\/\0]/.test(message.name))throw Error('Invalid export copy.');
    const documentId=currentDocument,resourceId=binding()?.path||'draft:'+documentId,path=await dialogs.path('Documents/'+message.name);check();if(!path)return;
    if(await authorize(authority,{instanceId,sessionId,documentId,resourceId,operation:'file.export',destination:path})!==true)throw Error('Export denied.');check();
    if(documentId!==currentDocument||(binding()?.path||'draft:'+documentId)!==resourceId)throw Error('Export target changed.');
    const saved=await files.write(path,new Blob([message.bytes]),null,{signal:abort.signal});check();if(!digest(saved?.sha256))throw Error('Invalid durable copy confirmation.');status.textContent='Exported account copy: '+path;
  }
  async function saveDocument(asCopy=false,path=null,format=null){check();await inspectNative();const original=binding();if(asCopy||!original||needsCopy){const suggested=original?.path||'Documents/Presentation.pptx';path=path??await dialogs.path(format&&['pptx','deckcraft'].includes(format)?suggested.replace(/[.][^./]+$/,'.'+format):suggested);check();if(!path)return false;canonicalPath(path);}
    preparedDestination={documentId:currentDocument,path};
    try{const result=await hostCommand('host.prepareSave',path?{path}:{});if(result?.pending!=='save')throw Error('DeckCraft did not prepare an identified save.');
      await completion(result.id).promise;await inspectNative();return !dirty();}finally{preparedDestination=null;}}
  async function openAccount(path){canonicalPath(path);check();if(activateFile?.({path}))return {status:'activated',path};if(typeof openFile!=='function')throw Error('Desktop account Open is unavailable.');const version=await files.version(path);check();if(!digest(version.sha256))throw Error('Invalid account revision.');return openFile({path,sha256:version.sha256});}
  async function hostAction(command,params={}){check();if(!loaded||paused)throw Error('The presentation is unavailable.');
    if(command==='file.new'){if(typeof newDocument!=='function')throw Error('Desktop New is unavailable.');return newDocument(params);}
    if(command==='file.close'){if(typeof closeView!=='function')throw Error('Desktop Close is unavailable.');return closeView();}
    if(command==='file.import'){if(typeof importDocument!=='function')throw Error('Desktop import is unavailable.');return importDocument(params);}
    if(command==='file.saveAs')return saveDocument(true,params.path??null,params.format??null);
    if(command==='file.open'){
      if(params.path)return openAccount(params.path);const original=binding()?.path,choice=await dialogs.open(files,original?.includes('/')?original.slice(0,original.lastIndexOf('/')):'');check();if(!choice)return {status:'cancelled'};
      if(choice.kind==='account')return openAccount(choice.path);if(typeof importDocument!=='function')throw Error('Desktop import is unavailable.');const bytes=new Uint8Array(await choice.file.arrayBuffer());check();return importDocument({name:choice.file.name,data:base64(bytes)});
    }throw Error('Unknown document request.');
  }
  const profileKey=profileId?'webos-deckcraft-profile-v1:'+location.origin+':'+profileId:null;
  async function loadProfile(){if(!profileKey)return;try{const text=localStorage.getItem(profileKey);if(text&&text.length<=4*1024*1024){const profile=JSON.parse(text);if(profile.version===1){autosaveEnabled=typeof profile.accountAutosaveEnabled==='boolean'?profile.accountAutosaveEnabled:true;autoToggle.textContent=autosaveEnabled?'AutoSave: On':'AutoSave: Off';autoToggle.setAttribute('aria-pressed',String(autosaveEnabled));await hostCommand('host.applyProfile',profile);lastProfileText=text;}}}catch(error){notify(Error('Account preferences unavailable: '+error.message));}}
  async function persistProfile(){if(!profileKey||!loaded||disposed)return;const value=await hostCommand('host.profile');check();value.accountAutosaveEnabled=autosaveEnabled;const text=JSON.stringify(value);if(text.length<=4*1024*1024&&text!==lastProfileText){localStorage.setItem(profileKey,text);lastProfileText=text;}}
  async function initialize(){check();if(initializing||loaded)return;initializing=true;phase='loading';retryButton.hidden=true;frame.inert=true;changed();
    try{await inspectNative();if(!configured){await hostCommand('host.configure');configured=true;await loadProfile();}
      let draft=null;if(recovery){try{draft=await recovery.load();check();}catch(error){recoveryState='failed';notify(error);}}
      if(draft){let changedBase=recoveryAsCopy;if(draft.path)try{changedBase||=(await files.version(draft.path)).sha256!==draft.revision;}catch{changedBase=true;}check();
        const choice=await dialogs.recover(draft.path,changedBase);check();if(!choice){phase='recovery';retryButton.hidden=false;retryButton.textContent='Recover draft';startup.resolve();return;}
        if(choice==='recover'){const outcome=await hostCommand('host.restore',{snapshot:draft.snapshot});currentDocument=outcome.documentId;
          if(draft.path&&!recoveryAsCopy){await fileSession.bind(currentDocument,{path:draft.path,sha256:draft.revision},authority);needsCopy=changedBase;await hostCommand('host.bindRecovered',{path:draft.path},currentDocument);}
          status.textContent='Recovered local presentation; changes are not saved to your account.';
        }else{await recovery.clear();check();draft=null;}
      }
      if(!draft){if(resource){canonicalPath(resource.path);let selected=resource;if(resource.restore){const version=await files.version(resource.path);check();selected={path:resource.path,sha256:version.sha256};}
          const opened=await fileSession.open(selected,authority,adopt);currentDocument=opened.documentId;if(opened.sourceRetained)await bindNative(currentDocument,resource.path);status.textContent='Opened account file: '+resource.path;
        }else if(imported){if(typeof imported.name!=='string'||typeof imported.data!=='string'||imported.data.length>Math.ceil(MAX/3)*4)throw Error('Invalid presentation import.');
          const text=atob(imported.data),bytes=Uint8Array.from(text,c=>c.charCodeAt(0));const result=await adopt(imported.name,bytes);currentDocument=result.documentId;await hostCommand('host.unbind');status.textContent='Imported presentation; use Save As to save it to your account.';
        }else{if(template&&Object.keys(template).length)await hostCommand('host.newInitial',template);status.textContent='New presentation; not saved to your account.';}}
      await inspectNative();await api().request('engine.execute',{documentId:currentDocument,command:'app.backstage',params:{on:false}});check();await inspectNative();
      loaded=true;phase='ready';frame.inert=false;observeAutosave();clearTimeout(startupTimer);startup.resolve();changed();schedule();imported=null;
    }catch(error){if(!disposed){phase='unavailable';notify(Error('Could not open '+(resource?.path||'this presentation')+': '+error.message));retryButton.textContent='Retry';retryButton.hidden=false;startup.reject(error);}throw error;
    }finally{initializing=false;if(!disposed)changed();}}
  function schedule(){clearTimeout(timer);if(disposed||!loaded||paused)return;timer=setTimeout(()=>void checkpoint().catch(notify),1200);}
  function checkpoint(){const work=async()=>{check();if(!loaded||paused||initializing)return null;await inspectNative();await persistProfile();if(!recovery)return null;
      if(!dirty()){if(!pending()){await recovery.clear();recoveryState='ready';}return null;}
      const capturedBinding=bindingSnapshot(),captured=await hostCommand('host.snapshot');check();
      if(capturedBinding.documentId!==currentDocument||capturedBinding.path!==bindingSnapshot().path||capturedBinding.revision!==bindingSnapshot().revision)throw Error('Document changed during recovery capture.');
      const record={path:capturedBinding.path,revision:capturedBinding.revision,snapshot:captured};await recovery.write(record);check();recoveryState='saved';return record;};
    checkpointTail=checkpointTail.catch(()=>{}).then(work).catch(error=>{recoveryState='failed';throw error;});return checkpointTail;}
  async function execute(request,caller){check();if(caller==null)throw Error('Explicit caller authorization required.');const text=JSON.stringify(request);if(!text||text.length>65536)throw Error('Invalid bounded command request.');const captured=JSON.parse(text);await startup.promise;check();await inspectNative();
    const resourceId=binding()?.path||'draft:'+currentDocument;
    if(!loaded||paused||captured.instanceId!==instanceId||captured.sessionId!==sessionId||captured.documentId!==currentDocument||!identity(captured.documentId)||captured.resourceId!==resourceId||typeof captured.command!=='string')throw Error('Exact instance, session, native document and account resource required.');
    if(captured.command.startsWith('host.')||['file.openBytes','file.adopt','file.recovery.open','file.recovery.save','file.recovery.list','file.import'].includes(captured.command))throw Error('This operation belongs to the document host.');
    if(caller!==authority)throw Error('Delegated native command transport is not connected for this view.');
    if(await authorize(caller,{instanceId,sessionId,documentId:currentDocument,resourceId,operation:captured.command})!==true)throw Error('Document operation denied.');check();await inspectNative();
    if(captured.documentId!==currentDocument||(binding()?.path||'draft:'+currentDocument)!==resourceId)throw Error('Document changed during authorization.');
    const args=captured.args||{};
    if(['file.new','file.open','file.close','file.saveAs'].includes(captured.command)){if(captured.command==='file.saveAs'&&!args.path)throw Error('Programmatic Save As requires an account path.');return hostAction(captured.command,args);}
    if(captured.command==='file.save'){if(Object.keys(args).length)throw Error('Use Save As for destination changes.');return saveDocument();}
    if(captured.command.startsWith('file.'))throw Error('Use the native File controls for this operation.');
    commandPending++;changed();try{const value=await api().request(captured.command==='document.inspect'?'document.inspect':'engine.execute',{documentId:currentDocument,command:captured.command,params:args});check();await inspectNative();return value;}finally{commandPending--;changed();schedule();}}
  async function requestClose(){if(disposed||nativeInvalidated)return true;closeIntent=null;if(!loaded)return !pending();await inspectNative();if(pending()){notify(Error('Resolve the pending or uncertain operation before closing.'));return false;}if(!dirty())return true;
    await checkpoint().catch(notify);await inspectNative();const before=fingerprint,choice=await dialogs.close();check();await inspectNative();if(choice==='discard'){if(before!==fingerprint){notify(Error('Presentation changed during confirmation. Review the newer edits.'));return false;}closeIntent=fingerprint;return true;}
    if(choice==='save')try{return await saveDocument();}catch(error){notify(error);}return false;}
  const lifecycle=Object.freeze({snapshot:()=>Object.freeze({revision:lifecycleRevision,dirty:dirty(),pending:pending()}),subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
    async quiesce({signal}={}){if(nativeInvalidated)return Object.freeze({release(){}});check();if(signal?.aborted||paused||lease||pending())throw Error('Finish the pending DeckCraft operation before ending the session.');if(!loaded)return Object.freeze({release(){}});
      await inspectNative();const token=crypto.randomUUID();frame.inert=true;try{await hostCommand('host.pause',{paused:true,lease:token,revision:native.revision,pendingNotes:native.pendingNotes});paused=true;pauseToken=token;}catch(error){frame.inert=false;throw error;}
      let active=true;const release=()=>{if(!active)return;active=false;signal?.removeEventListener('abort',release);if(lease===release)lease=null;if(disposed)return;void hostCommand('host.pause',{paused:false,lease:token}).then(()=>{paused=false;pauseToken=null;frame.inert=false;schedule();},notify);};
      lease=release;signal?.addEventListener('abort',release,{once:true});if(signal?.aborted){release();throw Error('DeckCraft pause cancelled.');}return Object.freeze({release});},
    async commitClose(){if(disposed||nativeInvalidated)return true;if(pending())throw Error('Wait for pending operations before closing.');clearTimeout(timer);await checkpointTail.catch(()=>{});let own;
      try{if(loaded&&!paused)own=await lifecycle.quiesce();await inspectNative();if(loaded&&dirty()&&closeIntent!==fingerprint)throw Error('DeckCraft changed after close confirmation.');if(loaded){await hostCommand('host.finalizeClose',{lease:pauseToken});await recovery?.clear();}recovery?.close();return true;}catch(error){own?.release();throw error;}}
  });
  function message(event){if(disposed||event.origin!==location.origin||event.source!==frame.contentWindow||!event.data||typeof event.data!=='object')return;const data=event.data;try{check();}catch(error){notify(error);return;}
    if(data.type==='deckcraft:ready'&&!nativeReady){nativeDocument=frame.contentDocument;nativeReady=true;if(data.openResult!==true){notify(Error('Correlated file adoption unavailable.'));startup.reject(Error('Correlated file adoption unavailable.'));return;}post('host',{version:'1'});void initialize().catch(notify);return;}
    if(data.type==='deckcraft:opened'||data.type==='deckcraft:failed'&&opens.has(data.id)){const entry=opens.get(data.id);if(!entry)return;opens.delete(data.id);clearTimeout(entry.timer);if(data.type==='deckcraft:opened')entry.resolve({documentId:data.documentId,revision:data.revision,sourceRetained:data.sourceRetained});else entry.reject(Error(String(data.error||'Presentation could not be opened.')));return;}
    if(data.type==='deckcraft:save'){void save(data).catch(notify);return;}
    if(data.type==='deckcraft:document-request'){void(async()=>{await inspectNative();if(!identity(data.revision)||data.documentId!==currentDocument)throw Error('Stale native document request.');await hostAction(data.command,structuredClone(data.params||{}));})().catch(notify);}
    if(data.type==='deckcraft:dirty')void inspectNative().catch(notify);
    if(data.type==='deckcraft:failed'&&phase==='loading'){phase='failed';notify(Error(String(data.error||'DeckCraft startup failed.')));startup.reject(Error(String(data.error)));}
  }
  window.addEventListener('message',message,{signal:abort.signal});frame.addEventListener('load',()=>{if(nativeReady&&!disposed)try{check();}catch(error){notify(error);}},{signal:abort.signal});
  autoToggle.addEventListener('click',()=>{try{check();if(!loaded||paused)return;autosaveEnabled=!autosaveEnabled;autoToggle.textContent=autosaveEnabled?'AutoSave: On':'AutoSave: Off';autoToggle.setAttribute('aria-pressed',String(autosaveEnabled));if(autosaveEnabled)autosave.resume();observeAutosave();void persistProfile().catch(notify);focus();}catch(error){notify(error);}},{signal:abort.signal});const startupTimer=setTimeout(()=>{if(!loaded&&!disposed){phase='failed';notify(Error('DeckCraft startup timed out.'));startup.reject(Error('DeckCraft startup timed out.'));}},120000);
  retryButton.addEventListener('click',()=>void initialize().catch(notify),{signal:abort.signal});
  const persist=()=>{if(loaded&&!disposed)void checkpoint().catch(notify);},visibility=()=>{if(document.hidden)persist();};document.addEventListener('visibilitychange',visibility);window.addEventListener('pagehide',persist);
  poll=setInterval(()=>{if(loaded&&!disposed&&!paused)void inspectNative().then(()=>persistProfile()).catch(notify);},1200);
  function focus(){check();if(!loaded||paused||dialogs.active)return false;frame.contentWindow?.focus();frame.contentDocument?.querySelector('canvas')?.focus();return true;}
  function dispose(){if(disposed)return;disposed=true;phase='disposed';clearTimeout(startupTimer);clearTimeout(timer);clearInterval(poll);parentSignal?.removeEventListener('abort',dispose);document.removeEventListener('visibilitychange',visibility);window.removeEventListener('pagehide',persist);
    const error=new DOMException('DeckCraft view closed; verify pending account writes before retrying.','AbortError');startup.reject(error);for(const entry of opens.values()){clearTimeout(entry.timer);entry.reject(error);}for(const entry of completions.values())entry.reject(error);autosave?.dispose();abort.abort();recovery?.close();fileSession.dispose();listeners.clear();bindingListeners.clear();frame.src='about:blank';frame.remove();element.remove();}
  if(parentSignal?.aborted)dispose();else parentSignal?.addEventListener('abort',dispose,{once:true});if(!disposed)frame.src=source.href;
  return Object.freeze({element,ready:startup.promise,dispose,focus,execute,requestClose,lifecycle,checkpoint,retry:initialize,
    fileBinding:Object.freeze({snapshot:bindingSnapshot,subscribe(listener){bindingListeners.add(listener);return()=>bindingListeners.delete(listener);}}),
    async inspect(){if(nativeReady&&!disposed&&!nativeInvalidated)await inspectNative();return {instanceId,sessionId,documentId:currentDocument,resourceId:binding()?.path||'draft:'+currentDocument,...bindingSnapshot(),requestedPath:loaded?null:resource?.path??null,phase,disposed,dirty:dirty(),pending:pending(),native,accountFiles:fileSession.inspect(),recovery:recoveryState,needsCopy,autosaveEnabled,autosave:autosave?.inspect()??null};}});
}

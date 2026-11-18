/** DeckCraft's versioned native presentation recovery schema, separate from account saves. */
import {createRecoveryStore, createRecoveryJournal} from '@webos/runtime/local-recovery';

export function captureDraft(value) {
  const path = value?.path, revision = value?.revision, snapshot = value?.snapshot;
  if (!(path === null || typeof path === 'string' && path.length > 0 && path.length <= 2048 &&
      !path.startsWith('/') && !path.endsWith('/') && !path.split('/').some(p => !p || p === '.' || p === '..' || /[\0\\]/.test(p))) ||
      !(revision === null || typeof revision === 'string' && /^[0-9a-f]{64}$/.test(revision)) ||
      (path === null) !== (revision === null) || snapshot?.version !== 1 ||
      typeof snapshot.data !== 'string' || snapshot.data.length > Math.ceil(128 * 1024 * 1024 / 3) * 4 || !snapshot.data.startsWith('UEs') ||
      typeof snapshot.revision !== 'string' || snapshot.revision.length>20 || !/^[0-9]+$/.test(snapshot.revision)) {
    throw Error('Invalid DeckCraft recovery snapshot.');
  }
  // Only these explicit fields enter storage. No capability, password, token,
  // key, native UI preference or caller-supplied extra metadata is retained.
  return {path, revision, snapshot:{version:1,data:snapshot.data,revision:snapshot.revision}};
}

export function createDraftStore(options) {
  return createRecoveryStore({...options,database:'webos-deckcraft-recovery-v1',capture:captureDraft});
}
export function createDraftJournal(options) {
  return createRecoveryJournal({...options,capture:captureDraft});
}

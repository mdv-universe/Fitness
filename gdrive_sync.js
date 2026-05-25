// ════════════════════════════════════════════════════════════════════════
// GOOGLE DRIVE SYNC - Shared engine
// Used by index.html (full UI) and tracker pages (status badge only)
// ════════════════════════════════════════════════════════════════════════
// CONFIG: Set GDRIVE_CLIENT_ID inline in each HTML BEFORE this script loads.
// Page should declare a global: window.GDRIVE_CLIENT_ID = '...'

const GDRIVE_FILE_NAME = 'fitness_tracker_backup.json';
const GDRIVE_SCOPES = 'https://www.googleapis.com/auth/drive.file';
const GDRIVE_KEYS = ['kb_tracker_v1','bw_tracker_v1','mf_tracker_v1','fitness_math_v1','body_log_v1','benchmarks_v1'];
const GDRIVE_TOKEN_STORAGE = 'gdrive_token_v1';
const GDRIVE_FILE_ID_STORAGE = 'gdrive_file_id_v1';
const GDRIVE_LASTSYNC_STORAGE = 'gdrive_lastsync_v1';
const GDRIVE_EMAIL_STORAGE = 'gdrive_email_v1';

let gdriveTokenClient = null;
let gdriveAccessToken = null;
let gdriveFileId = null;
let gdriveSaveTimer = null;
let gdriveInited = false;
let gdriveEmail = null;

window.gdriveOnStateChange = window.gdriveOnStateChange || function(state, text){};

function gdriveSetState(state, text){
  try { window.gdriveOnStateChange(state, text); } catch(e){ console.warn('UI callback failed', e); }
}

function gdriveInit(){
  if(gdriveInited) return;
  gdriveInited = true;

  if(!window.GDRIVE_CLIENT_ID || window.GDRIVE_CLIENT_ID.startsWith('PASTE')){
    gdriveSetState('error', 'Drive: not configured');
    return;
  }

  gdriveFileId = localStorage.getItem(GDRIVE_FILE_ID_STORAGE);
  gdriveEmail = localStorage.getItem(GDRIVE_EMAIL_STORAGE);

  const script = document.createElement('script');
  script.src = 'https://accounts.google.com/gsi/client';
  script.async = true;
  script.defer = true;
  script.onload = () => {
    try {
      gdriveTokenClient = google.accounts.oauth2.initTokenClient({
        client_id: window.GDRIVE_CLIENT_ID,
        scope: GDRIVE_SCOPES,
        callback: (resp) => {
          if(resp.error){ gdriveSetState('error', 'Drive: auth failed'); return; }
          gdriveAfterAuth(resp);
        }
      });
      gdriveTryStoredToken();
    } catch(e){
      gdriveSetState('error', 'GIS init failed');
    }
  };
  script.onerror = () => { gdriveSetState('error', 'Drive: offline'); };
  document.head.appendChild(script);
}

function gdriveTryStoredToken(){
  try {
    const stored = localStorage.getItem(GDRIVE_TOKEN_STORAGE);
    if(!stored) { gdriveSetState('off', 'Drive: sign in'); return; }
    const t = JSON.parse(stored);
    if(t.expires && t.expires > Date.now()){
      gdriveAccessToken = t.token;
      gdriveSetState('connected', gdriveLastSyncText() || 'Drive: connected');
      gdrivePull(true).catch(()=>{});
    } else {
      gdriveSilentRefresh();
    }
  } catch(e){ gdriveSetState('off', 'Drive: sign in'); }
}

function gdriveSilentRefresh(){
  if(!gdriveTokenClient) return;
  try { gdriveTokenClient.requestAccessToken({ prompt: '' }); }
  catch(e){ gdriveSetState('off', 'Drive: sign in'); }
}

function gdriveConnect(){
  if(!gdriveTokenClient){ gdriveSetState('error', 'Drive: not ready'); return; }
  gdriveTokenClient.requestAccessToken({ prompt: 'consent' });
}

function gdriveAfterAuth(resp){
  gdriveAccessToken = resp.access_token;
  try {
    localStorage.setItem(GDRIVE_TOKEN_STORAGE, JSON.stringify({
      token: resp.access_token,
      expires: Date.now() + ((resp.expires_in || 3600) * 1000)
    }));
  } catch(e){}
  gdriveFetchEmail().then(()=>{}).catch(()=>{});
  gdriveSetState('connected', 'Drive: connected');
  gdrivePull(true).then(() => { gdrivePush(false); }).catch(()=>{});
}

function gdriveFetchEmail(){
  if(!gdriveAccessToken) return Promise.resolve();
  return fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { 'Authorization': 'Bearer ' + gdriveAccessToken }
  }).then(r => r.json()).then(j => {
    if(j.email){
      gdriveEmail = j.email;
      localStorage.setItem(GDRIVE_EMAIL_STORAGE, j.email);
      gdriveSetState('connected', gdriveLastSyncText() || 'Drive: connected');
    }
  }).catch(()=>{});
}

function gdriveDisconnect(){
  if(gdriveAccessToken && window.google && google.accounts){
    try { google.accounts.oauth2.revoke(gdriveAccessToken, ()=>{}); } catch(e){}
  }
  localStorage.removeItem(GDRIVE_TOKEN_STORAGE);
  localStorage.removeItem(GDRIVE_FILE_ID_STORAGE);
  localStorage.removeItem(GDRIVE_LASTSYNC_STORAGE);
  localStorage.removeItem(GDRIVE_EMAIL_STORAGE);
  gdriveAccessToken = null;
  gdriveFileId = null;
  gdriveEmail = null;
  gdriveSetState('off', 'Drive: sign in');
}

function gdriveFindOrCreateFile(){
  if(gdriveFileId) return Promise.resolve(gdriveFileId);
  return fetch(`https://www.googleapis.com/drive/v3/files?q=name='${GDRIVE_FILE_NAME}'+and+trashed=false&spaces=drive&fields=files(id,name)`, {
    headers: { 'Authorization': 'Bearer ' + gdriveAccessToken }
  })
  .then(r => { if(r.status === 401) throw new Error('unauthorized'); return r.json(); })
  .then(j => {
    if(j.files && j.files.length){
      gdriveFileId = j.files[0].id;
      localStorage.setItem(GDRIVE_FILE_ID_STORAGE, gdriveFileId);
      return gdriveFileId;
    }
    return fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + gdriveAccessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: GDRIVE_FILE_NAME, mimeType: 'application/json' })
    })
    .then(r => r.json())
    .then(f => {
      gdriveFileId = f.id;
      localStorage.setItem(GDRIVE_FILE_ID_STORAGE, gdriveFileId);
      return gdriveFileId;
    });
  });
}

function gdrivePush(showStatus){
  if(!gdriveAccessToken){
    if(showStatus) gdriveSetState('off', 'Drive: not signed in');
    return Promise.reject('not authorized');
  }
  if(showStatus !== false) gdriveSetState('syncing', 'Syncing...');

  const bundle = { version: 1, exportedAt: new Date().toISOString(), data: {} };
  GDRIVE_KEYS.forEach(k => {
    const v = localStorage.getItem(k);
    if(v) { try { bundle.data[k] = JSON.parse(v); } catch(e){ bundle.data[k] = v; } }
  });

  return gdriveFindOrCreateFile()
    .then(fileId =>
      fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
        method: 'PATCH',
        headers: { 'Authorization': 'Bearer ' + gdriveAccessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify(bundle)
      })
    )
    .then(r => {
      if(r.status === 401){ gdriveSilentRefresh(); throw new Error('token expired'); }
      if(!r.ok) throw new Error('push failed ' + r.status);
      localStorage.setItem(GDRIVE_LASTSYNC_STORAGE, Date.now().toString());
      gdriveSetState('connected', gdriveLastSyncText());
    })
    .catch(e => {
      gdriveSetState('error', 'Drive: sync error');
      throw e;
    });
}

function gdrivePull(silent){
  if(!gdriveAccessToken){ return Promise.reject('not authorized'); }
  if(!silent) gdriveSetState('syncing', 'Pulling...');

  return gdriveFindOrCreateFile()
    .then(fileId =>
      fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
        headers: { 'Authorization': 'Bearer ' + gdriveAccessToken }
      })
    )
    .then(r => {
      if(r.status === 401){ gdriveSilentRefresh(); throw new Error('token expired'); }
      if(!r.ok) { if(r.status === 404) return null; throw new Error('pull failed ' + r.status); }
      return r.json();
    })
    .then(bundle => {
      if(bundle && bundle.data){
        GDRIVE_KEYS.forEach(k => {
          if(bundle.data[k]){
            try { localStorage.setItem(k, JSON.stringify(bundle.data[k])); } catch(e){}
          }
        });
        localStorage.setItem(GDRIVE_LASTSYNC_STORAGE, Date.now().toString());
        gdriveSetState('connected', gdriveLastSyncText());
        if(typeof window.gdriveOnDataPulled === 'function'){ window.gdriveOnDataPulled(); }
      } else {
        gdriveSetState('connected', gdriveLastSyncText() || 'Drive: connected');
      }
    })
    .catch(e => {
      if(!silent) gdriveSetState('error', 'Drive: pull failed');
      throw e;
    });
}

function gdriveOnSave(){
  if(!gdriveAccessToken) return;
  clearTimeout(gdriveSaveTimer);
  gdriveSaveTimer = setTimeout(() => { gdrivePush(true).catch(()=>{}); }, 3000);
}

function gdriveLastSyncText(){
  const t = localStorage.getItem(GDRIVE_LASTSYNC_STORAGE);
  if(!t) return null;
  const elapsed = Date.now() - parseInt(t);
  const mins = Math.floor(elapsed / 60000);
  if(mins < 1) return 'Synced just now';
  if(mins === 1) return 'Synced 1 min ago';
  if(mins < 60) return `Synced ${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if(hours === 1) return 'Synced 1 hour ago';
  if(hours < 24) return `Synced ${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if(days === 1) return 'Synced 1 day ago';
  return `Synced ${days} days ago`;
}

function gdriveGetEmail(){ return gdriveEmail; }
function gdriveIsConnected(){ return !!gdriveAccessToken; }
function gdriveGetLastSync(){ const t = localStorage.getItem(GDRIVE_LASTSYNC_STORAGE); return t ? parseInt(t) : null; }

if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', gdriveInit);
} else {
  gdriveInit();
}

const { invoke, on, pathOf } = window.api;
if (window.api.platform === 'linux') document.getElementById('discordOpt').hidden = true; // Discord presence is Windows-only
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const fmtSize = b => b == null ? 'folder' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB';
const fmtNum = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'K' : n;

const LOADER_NAMES = { vanilla: 'Vanilla', fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge', custom: 'Custom' };
const loaderLabel = i => i.loader === 'custom' ? `Custom (${i.customId})` : `${LOADER_NAMES[i.loader]}${i.loaderVersion ? ' ' + i.loaderVersion : ''}`;
const modded = i => ['fabric', 'quilt', 'forge', 'neoforge'].includes(i.loader);
const shaderHint = i => ['fabric', 'quilt', 'neoforge'].includes(i.loader) ? 'Shaders need the Iris mod.' : i.loader === 'forge' ? 'Shaders need the Oculus mod.' : '';

const state = { instances: [], current: null, tab: 'mods', versions: null, cfg: null, mr: { offset: 0, total: 0 }, running: new Set(), logs: {} };
const cur = () => state.instances.find(i => i.id === state.current);

let toastTimer;
function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), err ? 6000 : 3000);
}
// run an IPC call, surfacing errors as a toast
async function act(fn, ...a) {
  try { return await invoke(fn, ...a); }
  catch (e) { toast(String(e.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true); throw e; }
}

// ---------- instances ----------
async function loadInstances(select) {
  state.instances = await act('instances');
  if (select) state.current = select;
  if (!cur()) state.current = state.instances[0]?.id || null;
  $('#instances').innerHTML = state.instances.map(i =>
    `<li><button data-id="${esc(i.id)}" class="${i.id === state.current ? 'on' : ''}"><span class="n">${esc(i.name)}</span><span class="v">${esc(i.version)} · ${esc(i.loader)}</span></button></li>`).join('');
  renderInstance();
}
$('#instances').onclick = e => {
  const b = e.target.closest('button');
  if (!b || b.dataset.id === state.current) return;
  $('#mrList').innerHTML = ''; // results are filtered per game version
  loadInstances(b.dataset.id);
};

function renderInstance() {
  const i = cur();
  $('#empty').hidden = !!i; $('#view').hidden = !i;
  if (!i) return;
  $('#instName').textContent = i.name;
  $('#instMeta').textContent = `Minecraft ${i.version} · ${loaderLabel(i)}${i.modpack ? ' · ' + i.modpack.name : ''}`;
  $('#instVersion').hidden = i.loader !== 'custom';
  $('#launchBtn').disabled = state.running.has(i.id);
  $('#launchBtn').textContent = state.running.has(i.id) ? 'Running' : 'Launch →';
  $('#log').textContent = state.logs[i.id] || 'No output yet.';
  // show the Schematics tab only for instances that have a schematics folder (e.g. from Litematica)
  act('sch:has', i.id).then(has => {
    const tab = document.querySelector('#tabs [data-tab="schematics"]');
    tab.hidden = !has;
    if (!has && state.tab === 'schematics') showTab('mods');
  }).catch(() => {});
  showTab(state.tab);
}

function showTab(tab) {
  state.tab = tab;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  const local = ['mods', 'resourcepacks', 'shaderpacks'].includes(tab);
  $('#panelLocal').hidden = !local; $('#panelBrowse').hidden = tab !== 'browse';
  $('#panelWorlds').hidden = tab !== 'worlds'; $('#panelShots').hidden = tab !== 'screenshots';
  $('#panelSchem').hidden = tab !== 'schematics'; $('#panelLog').hidden = tab !== 'log';
  if (local) loadLocal();
  if (tab === 'browse') { if (!$('#mrList').children.length) search(); }
  if (tab === 'worlds') loadWorlds();
  if (tab === 'screenshots') loadShots();
  if (tab === 'schematics') loadSchematics();
  if (tab === 'log') $('#log').scrollTop = 1e9;
}
$('#tabs').onclick = e => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); };

// ---------- local content ----------
async function loadLocal() {
  const i = cur(), kind = state.tab;
  const items = await act('content:list', i.id, kind);
  if (state.tab !== kind || cur() !== i) return;
  const on = items.filter(x => x.enabled).length;
  $('#localCount').textContent = `${items.length} files · ${on} enabled`;
  $('#localHint').textContent = kind === 'mods' && i.loader === 'vanilla' ? 'Vanilla instances ignore mods. Use a modded instance.'
    : kind === 'shaderpacks' ? shaderHint(i) : '';
  $('#getMore').textContent = { mods: 'Download mods', resourcepacks: 'Download resource packs', shaderpacks: 'Download shaders' }[kind];
  $('#localList').innerHTML = items.length ? items.map(x =>
    `<li class="${x.enabled ? '' : 'off'}" data-file="${esc(x.file)}">
      <input type="checkbox" class="sw" ${x.enabled ? 'checked' : ''} aria-label="Enable ${esc(x.name)}">
      <span class="ico" data-icon></span>
      <span class="name">${esc(x.name)}</span><span class="size">${fmtSize(x.size)}</span>
      <button class="x" title="Delete" aria-label="Delete ${esc(x.name)}">×</button></li>`).join('')
    : `<li class="empty">Nothing here yet — add files, drop them in, or browse Modrinth.</li>`;
  loadIcons(i.id, kind);
}
// fetch each file's embedded icon lazily so the list renders instantly
async function loadIcons(id, kind) {
  for (const el of $('#localList').querySelectorAll('[data-icon]')) {
    const file = el.closest('li').dataset.file;
    el.removeAttribute('data-icon');
    act('content:icon', id, kind, file).then(url => {
      if (url && state.tab === kind && cur()?.id === id) el.style.backgroundImage = `url("${url}")`;
    }).catch(() => {});
  }
}
$('#localList').onclick = async e => {
  const li = e.target.closest('li[data-file]'); if (!li) return;
  const file = li.dataset.file;
  if (e.target.classList.contains('sw')) await act('content:toggle', state.current, state.tab, file);
  else if (e.target.classList.contains('x')) {
    if (!confirm(`Delete ${file}? This cannot be undone.`)) return;
    await act('content:remove', state.current, state.tab, file);
  } else return;
  loadLocal();
};
$('#updateAll').onclick = async () => {
  const b = $('#updateAll');
  b.disabled = true; b.textContent = 'Checking…';
  try {
    const up = await act('mr:updateAll', state.current);
    toast(up.length ? `Updated ${up.length}: ${up.slice(0, 4).join(', ')}${up.length > 4 ? '…' : ''}` : 'Everything is up to date');
    loadLocal();
  } catch {}
  b.disabled = false; b.textContent = 'Update all';
};
$('#addFiles').onclick = async () => { if (await act('content:add', state.current, state.tab)) loadLocal(); };
$('#openKind').onclick = () => act('open', state.current, state.tab);
// jump to Browse Mods for this content kind (keeps the Modrinth/CurseForge source choice)
$('#getMore').onclick = () => { state.browseKind = state.tab; $('#mrQuery').value = ''; showTab('browse'); search(); };

const panel = $('#panelLocal');
panel.ondragover = e => { e.preventDefault(); panel.classList.add('dragging'); };
panel.ondragleave = e => { if (!panel.contains(e.relatedTarget)) panel.classList.remove('dragging'); };
panel.ondrop = async e => {
  e.preventDefault(); panel.classList.remove('dragging');
  const paths = [...e.dataTransfer.files].map(pathOf).filter(Boolean);
  if (paths.length) { await act('content:add', state.current, state.tab, paths); toast(`Added ${paths.length} file(s)`); loadLocal(); }
};

// ---------- modrinth ----------
let searchTimer;
const KIND_NAMES = { mods: 'Mods', resourcepacks: 'Resource packs', shaderpacks: 'Shaders' };
async function search(more) {
  const i = cur(), kind = state.browseKind || 'mods', cf = $('#mrSource').value === 'curseforge';
  $('#mrKindLabel').textContent = KIND_NAMES[kind];
  if (!more) state.mr.offset = 0;
  $('#mrHint').textContent = kind === 'mods' && !modded(i) ? `${LOADER_NAMES[i.loader]} instance: results are not filtered by loader.`
    : kind === 'shaderpacks' ? shaderHint(i) : '';
  let res, installed;
  try {
    [res, installed] = await Promise.all([
      act(cf ? 'cf:search' : 'mr:search', { id: i.id, query: $('#mrQuery').value, kind, offset: state.mr.offset }),
      act(cf ? 'cf:installed' : 'mr:installed', i.id),
    ]);
  } catch { if (!more) $('#mrList').innerHTML = ''; return; }
  const have = new Set(installed);
  const html = res.hits.map(p => {
    const url = p.url || `https://modrinth.com/${p.project_type}/${p.slug}`;
    return `<li>${p.icon_url ? `<img src="${esc(p.icon_url)}" alt="">` : '<span class="ph"></span>'}
      <span class="t"><a href="${esc(url)}" target="_blank">${esc(p.title)}</a></span>
      <button class="link ${have.has(p.project_id) ? '' : 'launch'}" data-id="${esc(p.project_id)}" data-kind="${kind}">${have.has(p.project_id) ? 'Reinstall' : 'Install'}</button>
      <span class="by">by ${esc(p.author)} · ${fmtNum(p.downloads)} downloads</span>
      <span class="d">${esc(p.description)}</span></li>`;
  }).join('');
  if (more) $('#mrList').insertAdjacentHTML('beforeend', html); else { $('#mrList').innerHTML = html || '<li class="hint">No results for this version.</li>'; $('#mrList').scrollTop = 0; }
  state.mr.offset += res.hits.length; state.mr.total = res.total_hits;
  $('#mrMore').hidden = state.mr.offset >= state.mr.total;
}
$('#mrQuery').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => search(), 300); };
$('#mrSource').onchange = () => search();
$('#mrBack').onclick = () => showTab(state.browseKind || 'mods');
$('#mrMore').onclick = () => search(true);
$('#mrList').onclick = async e => {
  const b = e.target.closest('button[data-id]'); if (!b) return;
  const cf = $('#mrSource').value === 'curseforge';
  b.disabled = true; b.textContent = 'Installing…';
  try {
    await act(cf ? 'cf:install' : 'mr:install', state.current, b.dataset.kind, b.dataset.id);
    b.textContent = 'Installed'; b.classList.remove('launch');
    toast(`Installed into ${b.dataset.kind} (with required dependencies)`);
  } catch { b.textContent = 'Install'; }
  b.disabled = false;
};

// ---------- launch ----------
$('#launchBtn').onclick = async () => {
  const id = state.current;
  if (!state.cfg.selected) { toast('Add an account first', true); return openAccounts(); }
  state.running.add(id); state.logs[id] = ''; renderInstance();
  $('#progress').hidden = false;
  try { await act('launch', id); }
  catch { state.running.delete(id); $('#progress').hidden = true; renderInstance(); }
};
on('log', (id, line) => {
  state.logs[id] = ((state.logs[id] || '') + line + '\n').slice(-200000);
  if (id === state.current) { const l = $('#log'), atEnd = l.scrollHeight - l.scrollTop - l.clientHeight < 40; l.textContent = state.logs[id]; if (atEnd) l.scrollTop = 1e9; }
});
on('progress', (id, p) => {
  if (id !== state.current) return toast(`${p.label} ${p.done}/${p.total}`); // e.g. a modpack still importing
  $('#progress').hidden = false;
  $('#progress div').style.width = (p.total ? 100 * p.done / p.total : 0) + '%';
  $('#progressLabel').textContent = p.total > 1 ? `${p.label} ${p.done}/${p.total}` : p.label;
});
on('started', () => { $('#progress').hidden = true; toast('Game starting…'); });
on('closed', (id, code) => { state.running.delete(id); $('#progress').hidden = true; renderInstance(); toast(`Game closed (exit ${code})`, code !== 0); });

// ---------- instance actions ----------
$('#instVersion').onclick = () => act('open:version', state.current);
$('#instFolder').onclick = () => act('open', state.current);
$('#instDelete').onclick = async () => {
  const i = cur();
  if (!confirm(`Delete instance "${i.name}" and all its worlds, mods and packs? This cannot be undone.`)) return;
  await act('instance:delete', i.id);
  loadInstances();
};
$('#openData').onclick = () => act('open');

// ---------- new instance ----------
const fNew = $('#formNew');
let src = 'version', pack = null;
function fillVersions() {
  if (!state.versions) return;
  const loader = fNew.loader.value, snaps = fNew.snapshots.checked;
  const ok = loader === 'vanilla' ? null : new Set(state.versions.loaders[loader]);
  fNew.version.innerHTML = state.versions.versions
    .filter(v => (snaps || v.type === 'release') && (!ok || ok.has(v.id)))
    .map(v => `<option value="${esc(v.id)}" data-type="${esc(v.type)}">${esc(v.id)}${v.type === 'release' ? '' : ' (' + esc(v.type.replace('_', ' ')) + ')'}</option>`).join('')
    || '<option value="">No versions available</option>';
}
function showSrc(s) {
  src = s;
  document.querySelectorAll('#srcTabs button').forEach(b => b.classList.toggle('on', b.dataset.src === s));
  document.querySelectorAll('#formNew .src').forEach(d => (d.hidden = d.dataset.src !== s));
  fNew.name.placeholder = s === 'version' ? 'My Instance' : s === 'custom' ? 'Defaults to the version id' : 'Defaults to the pack name';
  $('#newErr').textContent = '';
  if (s === 'modpack' && !$('#mpList').children.length) searchPacks();
}
$('#srcTabs').onclick = e => { const b = e.target.closest('button'); if (b) showSrc(b.dataset.src); };

let packTimer;
async function searchPacks() {
  const res = await act('mr:search', { kind: 'modpack', query: $('#mpQuery').value });
  $('#mpList').innerHTML = res.hits.map(p =>
    `<li data-id="${esc(p.project_id)}" data-title="${esc(p.title)}">${p.icon_url ? `<img src="${esc(p.icon_url)}" alt="">` : ''}
      <span class="name">${esc(p.title)}</span><span class="size">${fmtNum(p.downloads)}</span></li>`).join('') || '<li class="empty">No modpacks found</li>';
}
$('#mpQuery').oninput = () => { clearTimeout(packTimer); packTimer = setTimeout(searchPacks, 300); };
$('#mpList').onclick = async e => {
  const li = e.target.closest('li[data-id]'); if (!li) return;
  $('#mpList').querySelectorAll('li').forEach(x => x.classList.toggle('on', x === li));
  pack = { id: li.dataset.id, title: li.dataset.title };
  $('#mpVersion').innerHTML = '<option value="">Loading…</option>';
  const vers = await act('mr:versions', pack.id);
  $('#mpVersion').innerHTML = vers.map(v =>
    `<option value="${esc(v.id)}">${esc(v.number)} · ${esc(v.games.slice(-1)[0] || '')} · ${esc(v.loaders.join('/'))}</option>`).join('');
};

$('#newInst').onclick = async () => {
  fNew.reset(); pack = null;
  $('#mpList').innerHTML = ''; $('#mpVersion').innerHTML = '';
  showSrc('version');
  $('#dlgNew').showModal();
  if (!state.versions) { fNew.version.innerHTML = '<option>Loading…</option>'; state.versions = await act('versions'); }
  fillVersions();
};
fNew.loader.onchange = fNew.snapshots.onchange = fillVersions;

// validate inside the dialog so errors stay visible; the slow work runs after it closes
fNew.onsubmit = e => {
  if (e.submitter?.value !== 'ok') return;
  const err = src === 'version' ? (!fNew.name.value.trim() ? 'Enter a name' : !fNew.version.value ? 'Pick a version' : '')
    : src === 'modpack' ? (!$('#mpVersion').value ? 'Pick a modpack and version' : '')
    : src === 'mrpack' ? (!$('#mrpackFile').files[0] ? 'Choose a .mrpack file' : '')
    : !$('#customJson').files[0] ? 'Choose a version JSON' : '';
  if (err) { e.preventDefault(); $('#newErr').textContent = err; }
};
$('#dlgNew').onclose = async () => {
  if ($('#dlgNew').returnValue !== 'ok') return;
  const name = fNew.name.value.trim();
  const opt = fNew.version.selectedOptions[0];
  let id;
  if (src === 'version') {
    toast('Creating instance…');
    id = await act('instance:create', { name, version: fNew.version.value, type: opt?.dataset.type, loader: fNew.loader.value });
  } else if (src === 'custom') {
    const jar = $('#customJar').files[0];
    id = await act('instance:custom', { name, json: pathOf($('#customJson').files[0]), jar: jar && pathOf(jar) });
  } else {
    toast('Importing modpack…');
    id = await act('instance:mrpack', src === 'modpack' ? { name: name || pack.title, versionId: $('#mpVersion').value } : { name, file: pathOf($('#mrpackFile').files[0]) });
  }
  state.tab = 'mods';
  $('#mrList').innerHTML = '';
  loadInstances(id);
  toast('Instance ready');
};

// ---------- settings ----------
const fSet = $('#formSettings');
$('#settingsBtn').onclick = () => { fSet.javaPath.value = state.cfg.javaPath || ''; fSet.memory.value = state.cfg.memory; fSet.discordRpc.checked = state.cfg.discordRpc !== false; $('#dlgSettings').showModal(); };
$('#dlgSettings').onclose = async () => {
  if ($('#dlgSettings').returnValue !== 'ok') return;
  state.cfg = await act('cfg:set', { javaPath: fSet.javaPath.value.trim(), memory: Math.max(1, +fSet.memory.value || 4), discordRpc: fSet.discordRpc.checked });
  toast('Settings saved');
};

// ---------- accounts ----------
function renderAccounts() {
  const c = state.cfg, sel = c.accounts.find(a => a.id === c.selected);
  $('#accountName').textContent = sel ? sel.name : 'Sign in';
  $('#accList').innerHTML = c.accounts.length ? c.accounts.map(a =>
    `<li class="${a.id === c.selected ? 'on' : ''}" data-id="${esc(a.id)}"><button type="button" class="name" style="text-align:left">${esc(a.name)}</button>
      <span class="size">${a.type === 'ms' ? 'Microsoft' : a.type === 'token' ? 'Token' : 'Offline'}</span><button type="button" class="x" aria-label="Remove ${esc(a.name)}">×</button></li>`).join('')
    : '<li class="empty">No accounts</li>';
}
const openAccounts = () => { renderAccounts(); $('#dlgAccounts').showModal(); };
$('#accountBtn').onclick = openAccounts;
$('#accList').onclick = async e => {
  const li = e.target.closest('li[data-id]'); if (!li) return;
  state.cfg = await act(e.target.classList.contains('x') ? 'acc:remove' : 'cfg:set', e.target.classList.contains('x') ? li.dataset.id : { selected: li.dataset.id });
  renderAccounts();
};
$('#msLogin').onclick = async () => {
  $('#msLogin').disabled = true;
  try { state.cfg = await act('acc:ms'); renderAccounts(); toast('Signed in'); } catch {}
  $('#msLogin').disabled = false;
};
$('#offAdd').onclick = async () => { state.cfg = await act('acc:offline', $('#offName').value); $('#offName').value = ''; renderAccounts(); };
$('#tokAdd').onclick = async () => {
  const b = $('#tokAdd');
  b.disabled = true;
  try {
    state.cfg = await act('acc:token', { token: $('#tokName').value, refresh: $('#tokRefresh').value });
    $('#tokName').value = ''; $('#tokRefresh').value = '';
    renderAccounts(); toast('Account added');
  } catch {}
  b.disabled = false;
};

// ---------- worlds ----------
const GAMEMODES = ['Survival', 'Creative', 'Adventure', 'Spectator'];
const DIFFICULTIES = ['Peaceful', 'Easy', 'Normal', 'Hard'];
async function loadWorlds() {
  const i = cur();
  const list = await act('worlds:list', i.id);
  if (state.tab !== 'worlds' || cur() !== i) return;
  $('#worldCount').textContent = `${list.length} world${list.length === 1 ? '' : 's'}`;
  $('#worldList').innerHTML = list.length ? list.map(w => `
    <li data-folder="${esc(w.folder)}">
      <span class="wicon" data-wicon></span>
      <span class="winfo">
        <span class="wname">${esc(w.name)}</span>
        <span class="wmeta">${w.error ? 'Unreadable: ' + esc(w.error) : `${esc(GAMEMODES[w.gameType] || '?')} · ${esc(DIFFICULTIES[w.difficulty] || '?')}${w.hardcore ? ' · Hardcore' : ''}${w.cheats ? ' · Cheats' : ''}${w.version ? ' · ' + esc(w.version) : ''}`}</span>
      </span>
      <span class="actions">
        <button class="link" data-act="edit"${w.error ? ' disabled' : ''}>Edit</button>
        <button class="link" data-act="folder">Folder</button>
        <button class="link danger" data-act="delete">Delete</button>
      </span>
    </li>`).join('') : '<li class="empty">No worlds yet. Play the instance to create one.</li>';
  for (const el of $('#worldList').querySelectorAll('[data-wicon]')) {
    const folder = el.closest('li').dataset.folder;
    el.removeAttribute('data-wicon');
    act('worlds:icon', i.id, folder).then(url => { if (url && cur()?.id === i.id) el.style.backgroundImage = `url("${url}")`; }).catch(() => {});
  }
}
$('#worldsFolder').onclick = () => act('worlds:open', state.current, '.'); // '.' resolves to the saves folder
$('#worldList').onclick = async e => {
  const li = e.target.closest('li[data-folder]'); if (!li) return;
  const folder = li.dataset.folder, a = e.target.dataset.act;
  if (a === 'folder') act('worlds:open', state.current, folder);
  else if (a === 'delete') { if (confirm(`Delete world "${folder}" and everything in it? This cannot be undone.`)) { await act('worlds:delete', state.current, folder); loadWorlds(); } }
  else if (a === 'edit') openWorld(folder);
};

let editingWorld = null;
const fWorld = $('#formWorld');
async function openWorld(folder) {
  editingWorld = folder;
  const w = (await act('worlds:list', state.current)).find(x => x.folder === folder);
  if (!w) return;
  fWorld.name.value = w.name; fWorld.gameType.value = w.gameType; fWorld.difficulty.value = w.difficulty;
  fWorld.cheats.checked = w.cheats; fWorld.hardcore.checked = w.hardcore;
  $('#worldErr').textContent = '';
  await loadDatapacks();
  $('#dlgWorld').showModal();
}
async function loadDatapacks() {
  const packs = await act('dp:list', state.current, editingWorld);
  $('#dpCount').textContent = packs.length ? `(${packs.filter(p => p.enabled).length}/${packs.length} on)` : '';
  $('#dpList').innerHTML = packs.length ? packs.map(p => `
    <li class="${p.enabled ? '' : 'off'}" data-file="${esc(p.file)}">
      <input type="checkbox" class="sw" ${p.enabled ? 'checked' : ''} aria-label="Enable ${esc(p.file)}">
      <span class="name">${esc(p.file)}</span>
      <button type="button" class="x" title="Remove">×</button></li>`).join('') : '<li class="empty">No datapacks</li>';
}
$('#dpList').onclick = async e => {
  const li = e.target.closest('li[data-file]'); if (!li) return;
  const file = li.dataset.file;
  if (e.target.classList.contains('sw')) await act('dp:toggle', state.current, editingWorld, file, e.target.checked);
  else if (e.target.classList.contains('x')) { if (!confirm(`Remove datapack ${file}?`)) return; await act('dp:remove', state.current, editingWorld, file); }
  else return;
  loadDatapacks();
};
$('#dpAdd').onclick = async () => { if (await act('dp:add', state.current, editingWorld)) { loadDatapacks(); toast('Datapack added'); } };
$('#dlgWorld').onclose = async () => {
  if ($('#dlgWorld').returnValue !== 'ok') return;
  try {
    await act('worlds:save', state.current, editingWorld, {
      name: fWorld.name.value.trim(), gameType: +fWorld.gameType.value, difficulty: +fWorld.difficulty.value,
      cheats: fWorld.cheats.checked, hardcore: fWorld.hardcore.checked,
    });
    toast('World saved'); loadWorlds();
  } catch {}
};

// ---------- schematics ----------
async function loadSchematics() {
  const i = cur();
  const items = await act('sch:list', i.id);
  if (state.tab !== 'schematics' || cur() !== i) return;
  $('#schemCount').textContent = `${items.length} schematic${items.length === 1 ? '' : 's'}`;
  $('#schemList').innerHTML = items.length ? items.map(x =>
    `<li data-file="${esc(x.file)}">
      <span class="name">${esc(x.file)}</span><span class="size">${fmtSize(x.size)}</span>
      <button class="link" data-act="open">Open</button>
      <button class="x" title="Delete" aria-label="Delete ${esc(x.file)}">×</button></li>`).join('')
    : '<li class="empty">No schematics yet — add .litematic, .schem, .schematic or .nbt files.</li>';
}
$('#schemList').onclick = async e => {
  const li = e.target.closest('li[data-file]'); if (!li) return;
  const file = li.dataset.file;
  if (e.target.dataset.act === 'open') act('sch:open', state.current, file);
  else if (e.target.classList.contains('x')) { if (confirm(`Delete ${file}?`)) { await act('sch:remove', state.current, file); loadSchematics(); } }
};
$('#schemAdd').onclick = async () => { if (await act('sch:add', state.current)) loadSchematics(); };
$('#schemFolder').onclick = () => act('sch:folder', state.current);
const schemPanel = $('#panelSchem');
schemPanel.ondragover = e => { e.preventDefault(); schemPanel.classList.add('dragging'); };
schemPanel.ondragleave = e => { if (!schemPanel.contains(e.relatedTarget)) schemPanel.classList.remove('dragging'); };
schemPanel.ondrop = async e => {
  e.preventDefault(); schemPanel.classList.remove('dragging');
  const paths = [...e.dataTransfer.files].map(pathOf).filter(Boolean);
  const n = paths.length ? await act('sch:add', state.current, paths) : 0;
  if (n) { toast(`Added ${n} schematic${n === 1 ? '' : 's'}`); loadSchematics(); }
  else if (paths.length) toast('Only .litematic, .schem, .schematic or .nbt files', true);
};

// ---------- raw NBT editor ----------
// Tag ids match nbt.js. Editor model: scalars keep their value; compound v = [{name, node}]; list v = {et, items:[node]}.
const NBT_NAME = { 1: 'byte', 2: 'short', 3: 'int', 4: 'long', 5: 'float', 6: 'double', 7: 'byteArray', 8: 'string', 9: 'list', 10: 'compound', 11: 'intArray', 12: 'longArray' };
const NBT_ADDABLE = [1, 2, 3, 4, 5, 6, 8, 11, 7, 12, 9, 10];
const NBT_INTLIMITS = { 1: [-128, 127], 2: [-32768, 32767], 3: [-2147483648, 2147483647] };
const nbtContainer = t => t === 9 || t === 10;
function nbtDefault(t) { return t === 4 ? 0n : t === 8 ? '' : t === 9 ? { et: 8, items: [] } : t === 10 ? [] : (t === 7 || t === 11 || t === 12) ? [] : 0; }
function toEditor(tag) {
  if (tag.t === 10) return { t: 10, v: [...tag.v].map(([name, ch]) => ({ name, node: toEditor(ch) })) };
  if (tag.t === 9) return { t: 9, v: { et: tag.v.et, items: tag.v.items.map(it => toEditor({ t: tag.v.et, v: it })) } };
  return { t: tag.t, v: tag.v };
}
function fromEditor(node) {
  if (node.t === 10) { const m = new Map(); for (const e of node.v) m.set(e.name, fromEditor(e.node)); return { t: 10, v: m }; }
  if (node.t === 9) return { t: 9, v: { et: node.v.et, items: node.v.items.map(ch => fromEditor(ch).v) } };
  return { t: node.t, v: node.v };
}
const nbtStr = (t, v) => t === 4 ? v.toString() : t === 12 ? v.map(x => x.toString()).join(', ') : (t === 7 || t === 11) ? v.join(', ') : String(v);
function nbtParse(t, cur, s) {
  if (NBT_INTLIMITS[t]) { const n = Math.trunc(Number(s)); if (!Number.isFinite(n)) return cur; const [lo, hi] = NBT_INTLIMITS[t]; return Math.max(lo, Math.min(hi, n)); }
  if (t === 4) { try { return BigInt(s.trim()); } catch { return cur; } }
  if (t === 5 || t === 6) { const n = Number(s); return Number.isFinite(n) ? n : cur; }
  if (t === 8) return s;
  const parts = s.split(',').map(x => x.trim()).filter(x => x !== '');
  if (t === 12) { try { return parts.map(x => BigInt(x)); } catch { return cur; } }
  return parts.map(x => Math.trunc(Number(x)) || 0); // byteArray / intArray
}
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

function nbtChildList(node) { // node is compound or list; returns a <ul>
  const ul = el('ul', 'nbtul');
  const render = () => {
    ul.innerHTML = '';
    const entries = node.t === 10 ? node.v : node.v.items;
    entries.forEach((entry, i) => ul.appendChild(nbtRow(node, entry, i, render)));
    ul.appendChild(nbtAddRow(node, render));
  };
  render();
  return ul;
}
function nbtRow(parent, entry, index, rerender) {
  const child = parent.t === 10 ? entry.node : entry;
  const name = parent.t === 10 ? entry.name : null;
  const li = el('li'), row = el('div', 'nbtrow');
  if (nbtContainer(child.t)) {
    const tog = el('button', 'nbttog', '▸'); tog.type = 'button';
    let sub = null;
    tog.onclick = () => { if (sub) { sub.remove(); sub = null; tog.textContent = '▸'; } else { sub = nbtChildList(child); li.appendChild(sub); tog.textContent = '▾'; } };
    row.appendChild(tog);
  } else row.appendChild(el('span', 'nbtsp'));
  if (name !== null) {
    const nin = el('input', 'nbtname'); nin.value = name;
    nin.onchange = () => { const v = nin.value.trim(); if (v && !parent.v.some((e, j) => j !== index && e.name === v)) parent.v[index].name = v; else nin.value = parent.v[index].name; };
    row.appendChild(nin);
  } else row.appendChild(el('span', 'nbtidx', '[' + index + ']'));
  row.appendChild(el('span', 'nbttype', NBT_NAME[child.t]));
  if (nbtContainer(child.t)) row.appendChild(el('span', 'nbtcount', child.t === 10 ? `{${child.v.length}}` : `[${child.v.items.length}]`));
  else {
    const vin = el('input', 'nbtval'); vin.value = nbtStr(child.t, child.v);
    vin.onchange = () => { child.v = nbtParse(child.t, child.v, vin.value); vin.value = nbtStr(child.t, child.v); };
    row.appendChild(vin);
  }
  const del = el('button', 'nbtdel', '×'); del.type = 'button';
  del.onclick = () => { (parent.t === 10 ? parent.v : parent.v.items).splice(index, 1); rerender(); };
  row.appendChild(del);
  li.appendChild(row);
  return li;
}
function nbtAddRow(node, rerender) {
  const li = el('li', 'nbtadd');
  const sel = el('select');
  // a list's elements must all share one type: pick it only while the list is empty
  const types = node.t === 10 ? NBT_ADDABLE : node.v.items.length ? [node.v.et] : NBT_ADDABLE;
  for (const t of types) { const o = el('option', null, NBT_NAME[t]); o.value = t; sel.appendChild(o); }
  sel.disabled = node.t === 9 && node.v.items.length > 0;
  let nameIn;
  if (node.t === 10) { nameIn = el('input', 'nbtname'); nameIn.placeholder = 'name'; li.appendChild(sel); li.appendChild(nameIn); }
  else { li.appendChild(el('span', 'nbtsp')); li.appendChild(sel); }
  const add = el('button', 'link', '+ add'); add.type = 'button';
  add.onclick = () => {
    const t = +sel.value, child = { t, v: nbtDefault(t) };
    if (node.t === 10) { const nm = nameIn.value.trim() || 'new'; if (node.v.some(e => e.name === nm)) return toast('A tag named ' + nm + ' already exists', true); node.v.push({ name: nm, node: child }); }
    else { if (!node.v.items.length) node.v.et = t; node.v.items.push({ t: node.v.et, v: nbtDefault(node.v.et) }); }
    rerender();
  };
  li.appendChild(add);
  return li;
}

let nbtRootNode = null, nbtFolder = null;
$('#nbtOpen').onclick = async () => {
  nbtFolder = editingWorld;
  try {
    const tree = await act('nbt:read', state.current, nbtFolder);
    nbtRootNode = toEditor(tree);
    $('#nbtWorld').textContent = editingWorld;
    $('#nbtTree').innerHTML = '';
    $('#nbtTree').appendChild(nbtChildList(nbtRootNode));
    $('#dlgNbt').showModal();
  } catch {}
};
$('#dlgNbt').onclose = async () => {
  if ($('#dlgNbt').returnValue !== 'ok') return;
  try { await act('nbt:write', state.current, nbtFolder, fromEditor(nbtRootNode)); toast('level.dat saved'); loadWorlds(); } catch {}
};

// ---------- screenshots ----------
async function loadShots() {
  const i = cur();
  const shots = await act('shots:list', i.id);
  if (state.tab !== 'screenshots' || cur() !== i) return;
  $('#shotCount').textContent = `${shots.length} screenshot${shots.length === 1 ? '' : 's'}`;
  $('#shotGrid').innerHTML = shots.length ? shots.map(s => `
    <figure class="shot" data-file="${esc(s.file)}">
      <span class="thumb" data-thumb></span>
      <figcaption><span class="sname">${esc(s.file)}</span><button class="x" title="Delete">×</button></figcaption>
    </figure>`).join('') : '<div class="empty">No screenshots yet. Press F2 in-game to take one.</div>';
  for (const el of $('#shotGrid').querySelectorAll('[data-thumb]')) {
    const file = el.closest('figure').dataset.file;
    el.removeAttribute('data-thumb');
    act('shots:thumb', i.id, file).then(url => { if (url && state.tab === 'screenshots' && cur()?.id === i.id) el.style.backgroundImage = `url("${url}")`; }).catch(() => {});
  }
}
$('#shotsFolder').onclick = () => act('shots:folder', state.current);
$('#shotGrid').onclick = async e => {
  const fig = e.target.closest('figure[data-file]'); if (!fig) return;
  const file = fig.dataset.file;
  if (e.target.classList.contains('x')) { if (confirm(`Delete ${file}?`)) { await act('shots:remove', state.current, file); loadShots(); } }
  else act('shots:open', state.current, file);
};

// ---------- boot ----------
(async () => {
  state.cfg = await act('cfg:get');
  renderAccounts();
  loadInstances();
})();

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
  $('#launchBtn').disabled = state.running.has(i.id);
  $('#launchBtn').textContent = state.running.has(i.id) ? 'Running' : 'Launch →';
  $('#log').textContent = state.logs[i.id] || 'No output yet.';
  showTab(state.tab);
}

function showTab(tab) {
  state.tab = tab;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  const local = ['mods', 'resourcepacks', 'shaderpacks'].includes(tab);
  $('#panelLocal').hidden = !local; $('#panelBrowse').hidden = tab !== 'browse'; $('#panelLog').hidden = tab !== 'log';
  if (local) loadLocal();
  if (tab === 'browse') { if (!$('#mrList').children.length) search(); }
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
  $('#localList').innerHTML = items.length ? items.map(x =>
    `<li class="${x.enabled ? '' : 'off'}" data-file="${esc(x.file)}">
      <input type="checkbox" class="sw" ${x.enabled ? 'checked' : ''} aria-label="Enable ${esc(x.name)}">
      <span class="name">${esc(x.name)}</span><span class="size">${fmtSize(x.size)}</span>
      <button class="x" title="Delete" aria-label="Delete ${esc(x.name)}">×</button></li>`).join('')
    : `<li class="empty">Nothing here yet — add files, drop them in, or browse Modrinth.</li>`;
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
async function search(more) {
  const i = cur(), kind = $('#mrKind').value;
  if (!more) state.mr.offset = 0;
  $('#mrHint').textContent = kind === 'mods' && !modded(i) ? `${LOADER_NAMES[i.loader]} instance: results are not filtered by loader.`
    : kind === 'shaderpacks' ? shaderHint(i) : '';
  const [res, installed] = await Promise.all([
    act('mr:search', { id: i.id, query: $('#mrQuery').value, kind, offset: state.mr.offset }),
    act('mr:installed', i.id),
  ]);
  const have = new Set(installed);
  const html = res.hits.map(p =>
    `<li>${p.icon_url ? `<img src="${esc(p.icon_url)}" alt="">` : '<span class="ph"></span>'}
      <span class="t"><a href="https://modrinth.com/${esc(p.project_type)}/${esc(p.slug)}" target="_blank">${esc(p.title)}</a></span>
      <button class="link ${have.has(p.project_id) ? '' : 'launch'}" data-id="${esc(p.project_id)}" data-kind="${kind}">${have.has(p.project_id) ? 'Reinstall' : 'Install'}</button>
      <span class="by">by ${esc(p.author)} · ${fmtNum(p.downloads)} downloads</span>
      <span class="d">${esc(p.description)}</span></li>`).join('');
  if (more) $('#mrList').insertAdjacentHTML('beforeend', html); else { $('#mrList').innerHTML = html || '<li class="hint">No results for this version.</li>'; $('#mrList').scrollTop = 0; }
  state.mr.offset += res.hits.length; state.mr.total = res.total_hits;
  $('#mrMore').hidden = state.mr.offset >= state.mr.total;
}
$('#mrQuery').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => search(), 300); };
$('#mrKind').onchange = () => search();
$('#mrMore').onclick = () => search(true);
$('#mrList').onclick = async e => {
  const b = e.target.closest('button[data-id]'); if (!b) return;
  b.disabled = true; b.textContent = 'Installing…';
  try {
    await act('mr:install', state.current, b.dataset.kind, b.dataset.id);
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
      <span class="size">${a.type === 'ms' ? 'Microsoft' : 'Offline'}</span><button type="button" class="x" aria-label="Remove ${esc(a.name)}">×</button></li>`).join('')
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

// ---------- boot ----------
(async () => {
  state.cfg = await act('cfg:get');
  renderAccounts();
  loadInstances();
})();
